package main

import (
	"encoding/binary"
	"net"
)

func parseIPPacket(data []byte) (packetInfo, bool) {
	if len(data) < 1 {
		return packetInfo{}, false
	}
	switch data[0] >> 4 {
	case 4:
		return parseIPv4Packet(data)
	case 6:
		return parseIPv6Packet(data)
	default:
		return packetInfo{}, false
	}
}

func parseIPv4Packet(data []byte) (packetInfo, bool) {
	if len(data) < 20 || data[9] != 17 {
		return packetInfo{}, false
	}
	headerLength := int(data[0]&0x0f) * 4
	if headerLength < 20 || len(data) < headerLength+8 {
		return packetInfo{}, false
	}
	fragment := binary.BigEndian.Uint16(data[6:8]) & 0x1fff
	if fragment != 0 {
		return packetInfo{}, false
	}
	totalLength := int(binary.BigEndian.Uint16(data[2:4]))
	if totalLength <= 0 || totalLength > len(data) {
		totalLength = len(data)
	}
	return udpPacket(data, headerLength, net.IPv4(data[12], data[13], data[14], data[15]), net.IPv4(data[16], data[17], data[18], data[19]), totalLength)
}

func parseIPv6Packet(data []byte) (packetInfo, bool) {
	if len(data) < 48 {
		return packetInfo{}, false
	}
	nextHeader := data[6]
	offset := 40
	for nextHeader != 17 {
		if offset+2 > len(data) {
			return packetInfo{}, false
		}
		switch nextHeader {
		case 0, 43, 60:
			nextHeader = data[offset]
			offset += (int(data[offset+1]) + 1) * 8
		case 44:
			if offset+8 > len(data) || binary.BigEndian.Uint16(data[offset+2:offset+4])&0xfff8 != 0 {
				return packetInfo{}, false
			}
			nextHeader = data[offset]
			offset += 8
		case 51:
			nextHeader = data[offset]
			offset += (int(data[offset+1]) + 2) * 4
		default:
			return packetInfo{}, false
		}
		if offset+8 > len(data) {
			return packetInfo{}, false
		}
	}
	totalLength := 40 + int(binary.BigEndian.Uint16(data[4:6]))
	if totalLength <= 40 || totalLength > len(data) {
		totalLength = len(data)
	}
	source := append(net.IP(nil), data[8:24]...)
	destination := append(net.IP(nil), data[24:40]...)
	return udpPacket(data, offset, source, destination, totalLength)
}

func udpPacket(data []byte, offset int, source, destination net.IP, totalLength int) (packetInfo, bool) {
	if offset+8 > len(data) {
		return packetInfo{}, false
	}
	sourcePort := binary.BigEndian.Uint16(data[offset : offset+2])
	destinationPort := binary.BigEndian.Uint16(data[offset+2 : offset+4])
	if sourcePort == 0 || destinationPort == 0 {
		return packetInfo{}, false
	}
	return packetInfo{
		sourceIP: source, destinationIP: destination,
		sourcePort: sourcePort, destinationPort: destinationPort,
		bytes: uint64(totalLength),
	}, true
}
