package main

import (
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func TestParseIPv4UDP(t *testing.T) {
	packet := make([]byte, 32)
	packet[0] = 0x45
	binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
	packet[9] = 17
	copy(packet[12:16], net.ParseIP("10.0.0.2").To4())
	copy(packet[16:20], net.ParseIP("104.18.32.47").To4())
	binary.BigEndian.PutUint16(packet[20:22], 45000)
	binary.BigEndian.PutUint16(packet[22:24], 443)

	parsed, ok := parseIPPacket(packet)
	if !ok {
		t.Fatal("IPv4 UDP packet was not parsed")
	}
	if parsed.sourceIP.String() != "10.0.0.2" || parsed.destinationIP.String() != "104.18.32.47" {
		t.Fatalf("unexpected endpoints: %s -> %s", parsed.sourceIP, parsed.destinationIP)
	}
	if parsed.sourcePort != 45000 || parsed.destinationPort != 443 || parsed.bytes != 32 {
		t.Fatalf("unexpected UDP metadata: %+v", parsed)
	}
}

func TestParseIPv6UDP(t *testing.T) {
	packet := make([]byte, 52)
	packet[0] = 0x60
	binary.BigEndian.PutUint16(packet[4:6], 12)
	packet[6] = 17
	copy(packet[8:24], net.ParseIP("2001:db8::1").To16())
	copy(packet[24:40], net.ParseIP("2606:4700::1111").To16())
	binary.BigEndian.PutUint16(packet[40:42], 2087)
	binary.BigEndian.PutUint16(packet[42:44], 443)

	parsed, ok := parseIPPacket(packet)
	if !ok || parsed.sourceIP.String() != "2001:db8::1" || parsed.destinationPort != 443 {
		t.Fatalf("unexpected IPv6 UDP metadata: %+v, ok=%v", parsed, ok)
	}
}

func TestStateAggregatesBothDirectionsAndOwner(t *testing.T) {
	state := newMonitorState()
	state.setOwners(ownerIndex{2087: {{PID: 49939, Name: "V2bX", LocalIP: "0.0.0.0", LocalPort: 2087}}})
	now := time.Unix(100, 0)
	outgoing := packetInfo{sourceIP: net.ParseIP("10.0.0.2"), destinationIP: net.ParseIP("104.18.32.47"), sourcePort: 2087, destinationPort: 443, bytes: 120}
	incoming := packetInfo{sourceIP: net.ParseIP("104.18.32.47"), destinationIP: net.ParseIP("10.0.0.2"), sourcePort: 443, destinationPort: 2087, bytes: 90}
	state.record(outgoing, true, now)
	state.record(incoming, false, now.Add(time.Second))

	result := state.snapshot(now.Add(time.Second))
	if len(result.Connections) != 1 {
		t.Fatalf("expected one connection, got %d", len(result.Connections))
	}
	connection := result.Connections[0]
	if connection.PID != 49939 || connection.ProcessName != "V2bX" || connection.SentBytes != 120 || connection.ReceivedBytes != 90 {
		t.Fatalf("unexpected connection: %+v", connection)
	}
	if connection.TransmitBytesPerSecond != 120 || connection.ReceiveBytesPerSecond != 90 {
		t.Fatalf("unexpected sliding rates: %+v", connection)
	}
}

func TestStateMigratesAnUnresolvedFlowWhenOwnerAppears(t *testing.T) {
	state := newMonitorState()
	now := time.Unix(200, 0)
	packet := packetInfo{sourceIP: net.ParseIP("10.0.0.2"), destinationIP: net.ParseIP("104.18.32.47"), sourcePort: 45000, destinationPort: 443, bytes: 300}
	if !state.record(packet, true, now) {
		t.Fatal("first unknown port should request an owner refresh")
	}
	state.setOwners(ownerIndex{45000: {{PID: 49939, Name: "V2bX", LocalIP: "10.0.0.2", LocalPort: 45000}}})

	result := state.snapshot(now.Add(time.Second))
	if len(result.Connections) != 1 || result.Connections[0].PID != 49939 || result.Connections[0].ProcessName != "V2bX" {
		t.Fatalf("unresolved flow was not migrated: %+v", result.Connections)
	}
	if result.Connections[0].SentBytes != 300 {
		t.Fatalf("flow counters were not preserved: %+v", result.Connections[0])
	}
}

func TestDecodeProcAddresses(t *testing.T) {
	if got := decodeProcAddress("0100007F", false); got != "127.0.0.1" {
		t.Fatalf("unexpected IPv4 address: %s", got)
	}
	if got := decodeProcAddress("00000000000000000000000001000000", true); got != "::1" {
		t.Fatalf("unexpected IPv6 address: %s", got)
	}
}

func TestRatesUseActualBucketWindow(t *testing.T) {
	flow := connection{FirstSeen: time.Unix(90, 0).UnixMilli()}
	flow.buckets[1] = byteBucket{second: 100, sent: 1000}
	flow.buckets[2] = byteBucket{second: 101, sent: 1000}
	sent, _ := flow.rates(time.Unix(102, 0))
	if sent != 1000 {
		t.Fatalf("two complete seconds must not be divided by three: %f", sent)
	}
	sent, _ = flow.rates(time.Unix(105, 0))
	if sent != 0 {
		t.Fatalf("idle flow retained stale throughput: %f", sent)
	}
}
