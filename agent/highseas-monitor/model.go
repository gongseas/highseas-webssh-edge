package main

import (
	"net"
	"sort"
	"sync"
	"time"
)

const (
	knownFlowLifetime      = 60 * time.Second
	unresolvedFlowLifetime = 12 * time.Second
	ownerRefreshCooldown   = 500 * time.Millisecond
	rateBucketCount        = 3
)

type packetInfo struct {
	sourceIP        net.IP
	destinationIP   net.IP
	sourcePort      uint16
	destinationPort uint16
	bytes           uint64
}

type owner struct {
	PID       int
	Name      string
	LocalIP   string
	LocalPort uint16
}

type flowKey struct {
	PID       int
	LocalIP   string
	LocalPort uint16
	PeerIP    string
	PeerPort  uint16
}

type connection struct {
	Protocol               string  `json:"protocol"`
	PID                    int     `json:"pid"`
	ProcessName            string  `json:"processName"`
	LocalIP                string  `json:"localIp"`
	LocalPort              uint16  `json:"localPort"`
	PeerIP                 string  `json:"peerIp"`
	PeerPort               uint16  `json:"peerPort"`
	SentBytes              uint64  `json:"sentBytes"`
	ReceivedBytes          uint64  `json:"receivedBytes"`
	TransmitBytesPerSecond float64 `json:"transmitBytesPerSecond"`
	ReceiveBytesPerSecond  float64 `json:"receiveBytesPerSecond"`
	FirstSeen              int64   `json:"firstSeen"`
	LastSeen               int64   `json:"lastSeen"`
	buckets                [rateBucketCount]byteBucket
}

type byteBucket struct {
	second   int64
	sent     uint64
	received uint64
}

type snapshot struct {
	Version     string       `json:"version"`
	UpdatedAt   int64        `json:"updatedAt"`
	Connections []connection `json:"connections"`
}

type monitorState struct {
	mu               sync.Mutex
	flows            map[flowKey]*connection
	owners           ownerIndex
	lastOwnerRefresh time.Time
}

func newMonitorState() *monitorState {
	return &monitorState{
		flows:  make(map[flowKey]*connection),
		owners: make(ownerIndex),
	}
}

func (state *monitorState) setOwners(owners ownerIndex) {
	state.mu.Lock()
	state.owners = owners
	for key, flow := range state.flows {
		if key.PID != 0 {
			continue
		}
		process := owners.lookup(key.LocalIP, key.LocalPort)
		if process.PID <= 0 {
			continue
		}
		ownedKey := flowKey{PID: process.PID, LocalIP: key.LocalIP, LocalPort: key.LocalPort, PeerIP: key.PeerIP, PeerPort: key.PeerPort}
		if current := state.flows[ownedKey]; current != nil {
			mergeFlow(current, flow)
		} else {
			flow.PID = process.PID
			flow.ProcessName = process.Name
			state.flows[ownedKey] = flow
		}
		delete(state.flows, key)
	}
	state.mu.Unlock()
}

func (state *monitorState) record(packet packetInfo, outgoing bool, now time.Time) bool {
	localIP := packet.destinationIP.String()
	localPort := packet.destinationPort
	peerIP := packet.sourceIP.String()
	peerPort := packet.sourcePort
	if outgoing {
		localIP = packet.sourceIP.String()
		localPort = packet.sourcePort
		peerIP = packet.destinationIP.String()
		peerPort = packet.destinationPort
	}
	if localPort == 0 || peerPort == 0 || net.ParseIP(peerIP) == nil {
		return false
	}

	state.mu.Lock()
	process := state.owners.lookup(localIP, localPort)
	key := flowKey{PID: process.PID, LocalIP: localIP, LocalPort: localPort, PeerIP: peerIP, PeerPort: peerPort}
	if process.PID > 0 {
		delete(state.flows, flowKey{PID: 0, LocalIP: localIP, LocalPort: localPort, PeerIP: peerIP, PeerPort: peerPort})
	} else {
		for existingKey, existing := range state.flows {
			if existingKey.LocalIP == localIP && existingKey.LocalPort == localPort && existingKey.PeerIP == peerIP && existingKey.PeerPort == peerPort && existing.PID > 0 {
				key = existingKey
				process = owner{PID: existing.PID, Name: existing.ProcessName}
				break
			}
		}
	}

	flow := state.flows[key]
	if flow == nil {
		name := process.Name
		if name == "" {
			name = "udp"
		}
		flow = &connection{
			Protocol: "udp", PID: process.PID, ProcessName: name,
			LocalIP: localIP, LocalPort: localPort, PeerIP: peerIP, PeerPort: peerPort,
			FirstSeen: now.UnixMilli(),
		}
		state.flows[key] = flow
	}
	bucket := &flow.buckets[int(now.Unix()%rateBucketCount)]
	if bucket.second != now.Unix() {
		*bucket = byteBucket{second: now.Unix()}
	}
	if outgoing {
		flow.SentBytes += packet.bytes
		bucket.sent += packet.bytes
	} else {
		flow.ReceivedBytes += packet.bytes
		bucket.received += packet.bytes
	}
	flow.LastSeen = now.UnixMilli()
	needsOwnerRefresh := process.PID <= 0 && (state.lastOwnerRefresh.IsZero() || now.Sub(state.lastOwnerRefresh) >= ownerRefreshCooldown)
	if needsOwnerRefresh {
		state.lastOwnerRefresh = now
	}
	state.mu.Unlock()
	return needsOwnerRefresh
}

func (state *monitorState) snapshot(now time.Time) snapshot {
	state.mu.Lock()
	defer state.mu.Unlock()

	connections := make([]connection, 0, len(state.flows))
	for key, flow := range state.flows {
		lifetime := knownFlowLifetime
		if flow.PID <= 0 {
			lifetime = unresolvedFlowLifetime
		}
		cutoff := now.Add(-lifetime).UnixMilli()
		if flow.LastSeen < cutoff {
			delete(state.flows, key)
			continue
		}
		current := *flow
		current.TransmitBytesPerSecond, current.ReceiveBytesPerSecond = flow.rates(now)
		connections = append(connections, current)
	}
	sort.Slice(connections, func(left, right int) bool {
		if connections[left].PID != connections[right].PID {
			return connections[left].PID < connections[right].PID
		}
		if connections[left].LocalPort != connections[right].LocalPort {
			return connections[left].LocalPort < connections[right].LocalPort
		}
		if connections[left].PeerIP != connections[right].PeerIP {
			return connections[left].PeerIP < connections[right].PeerIP
		}
		return connections[left].PeerPort < connections[right].PeerPort
	})
	return snapshot{Version: version, UpdatedAt: now.UnixMilli(), Connections: connections}
}

func (flow *connection) rates(now time.Time) (float64, float64) {
	oldestSecond := now.Unix() - rateBucketCount + 1
	var sent, received uint64
	for _, bucket := range flow.buckets {
		if bucket.second >= oldestSecond && bucket.second <= now.Unix() {
			sent += bucket.sent
			received += bucket.received
		}
	}
	windowStart := time.Unix(oldestSecond, 0)
	if first := time.UnixMilli(flow.FirstSeen); first.After(windowStart) {
		windowStart = first
	}
	duration := now.Sub(windowStart).Seconds()
	if duration < 1 {
		duration = 1
	}
	if duration > rateBucketCount {
		duration = rateBucketCount
	}
	return float64(sent) / duration, float64(received) / duration
}

func mergeFlow(target, source *connection) {
	target.SentBytes += source.SentBytes
	target.ReceivedBytes += source.ReceivedBytes
	if target.FirstSeen == 0 || (source.FirstSeen > 0 && source.FirstSeen < target.FirstSeen) {
		target.FirstSeen = source.FirstSeen
	}
	if source.LastSeen > target.LastSeen {
		target.LastSeen = source.LastSeen
	}
	for _, sourceBucket := range source.buckets {
		if sourceBucket.second == 0 {
			continue
		}
		targetBucket := &target.buckets[int(sourceBucket.second%rateBucketCount)]
		if targetBucket.second != sourceBucket.second {
			*targetBucket = byteBucket{second: sourceBucket.second}
		}
		targetBucket.sent += sourceBucket.sent
		targetBucket.received += sourceBucket.received
	}
}
