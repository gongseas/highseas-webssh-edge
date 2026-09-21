package main

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type socketRecord struct {
	Inode     string
	LocalIP   string
	LocalPort uint16
}

type ownerIndex map[uint16][]owner

func (index ownerIndex) lookup(localIP string, localPort uint16) owner {
	candidates := index[localPort]
	if len(candidates) == 0 {
		return owner{}
	}
	for _, candidate := range candidates {
		if candidate.LocalIP == localIP {
			return candidate
		}
	}
	for _, candidate := range candidates {
		if candidate.LocalIP == "0.0.0.0" || candidate.LocalIP == "::" {
			return candidate
		}
	}
	return candidates[0]
}

func scanUDPOwners() ownerIndex {
	sockets := append(readUDPTable("/proc/net/udp", false), readUDPTable("/proc/net/udp6", true)...)
	byInode := make(map[string][]socketRecord)
	for _, socket := range sockets {
		if socket.Inode != "0" {
			byInode[socket.Inode] = append(byInode[socket.Inode], socket)
		}
	}
	result := make(ownerIndex)
	if len(byInode) == 0 {
		return result
	}

	processes, err := os.ReadDir("/proc")
	if err != nil {
		return result
	}
	for _, process := range processes {
		pid, err := strconv.Atoi(process.Name())
		if err != nil || !process.IsDir() {
			continue
		}
		fdPath := filepath.Join("/proc", process.Name(), "fd")
		descriptors, err := os.ReadDir(fdPath)
		if err != nil {
			continue
		}
		nameBytes, _ := os.ReadFile(filepath.Join("/proc", process.Name(), "comm"))
		name := strings.TrimSpace(string(nameBytes))
		if name == "" {
			name = "udp"
		}
		for _, descriptor := range descriptors {
			target, err := os.Readlink(filepath.Join(fdPath, descriptor.Name()))
			if err != nil || !strings.HasPrefix(target, "socket:[") || !strings.HasSuffix(target, "]") {
				continue
			}
			inode := strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")
			for _, socket := range byInode[inode] {
				candidate := owner{PID: pid, Name: name, LocalIP: socket.LocalIP, LocalPort: socket.LocalPort}
				if !containsOwner(result[socket.LocalPort], candidate) {
					result[socket.LocalPort] = append(result[socket.LocalPort], candidate)
				}
			}
		}
	}
	return result
}

func containsOwner(owners []owner, candidate owner) bool {
	for _, existing := range owners {
		if existing.PID == candidate.PID && existing.LocalIP == candidate.LocalIP {
			return true
		}
	}
	return false
}

func readUDPTable(path string, ipv6 bool) []socketRecord {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	return parseUDPTable(file, ipv6)
}

func parseUDPTable(file interface{ Read([]byte) (int, error) }, ipv6 bool) []socketRecord {
	result := make([]socketRecord, 0)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 || !strings.Contains(fields[1], ":") {
			continue
		}
		parts := strings.SplitN(fields[1], ":", 2)
		portValue, err := strconv.ParseUint(parts[1], 16, 16)
		if err != nil || portValue == 0 {
			continue
		}
		address := decodeProcAddress(parts[0], ipv6)
		if address == "" {
			continue
		}
		result = append(result, socketRecord{Inode: fields[9], LocalIP: address, LocalPort: uint16(portValue)})
	}
	return result
}

func decodeProcAddress(value string, ipv6 bool) string {
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return ""
	}
	if !ipv6 {
		if len(decoded) != 4 {
			return ""
		}
		reverse(decoded)
		return net.IP(decoded).String()
	}
	if len(decoded) != 16 {
		return ""
	}
	for offset := 0; offset < len(decoded); offset += 4 {
		reverse(decoded[offset : offset+4])
	}
	return net.IP(decoded).String()
}

func reverse(value []byte) {
	for left, right := 0, len(value)-1; left < right; left, right = left+1, right-1 {
		value[left], value[right] = value[right], value[left]
	}
}

func debugOwnerIndex(index ownerIndex) string {
	return fmt.Sprintf("%d UDP ports mapped", len(index))
}
