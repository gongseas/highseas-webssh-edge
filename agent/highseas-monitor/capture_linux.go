//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"syscall"
)

const (
	etherTypeAll   = 0x0003
	packetOutgoing = 4
)

func startPacketCapture(ctx context.Context, handler func(packetInfo, bool)) (<-chan error, error) {
	loopbacks := loopbackInterfaces()
	errorsChannel := make(chan error, 2)
	fds := make([]int, 0, 2)
	// ETH_P_ALL receives locally transmitted packets as well as incoming IP.
	for _, protocol := range []uint16{etherTypeAll} {
		fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_DGRAM, hostToNetworkShort(protocol))
		if err != nil {
			errorsChannel <- fmt.Errorf("open AF_PACKET 0x%x: %w", protocol, err)
			continue
		}
		timeout := syscall.Timeval{Sec: 1}
		_ = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 4*1024*1024)
		if err := syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &timeout); err != nil {
			syscall.Close(fd)
			errorsChannel <- fmt.Errorf("configure AF_PACKET 0x%x: %w", protocol, err)
			continue
		}
		fds = append(fds, fd)
		go captureSocket(ctx, fd, loopbacks, handler, errorsChannel)
	}
	if len(fds) == 0 {
		close(errorsChannel)
		return nil, fmt.Errorf("AF_PACKET capture is unavailable; CAP_NET_RAW is required")
	}
	go func() {
		<-ctx.Done()
		for _, fd := range fds {
			syscall.Close(fd)
		}
	}()
	return errorsChannel, nil
}

func captureSocket(ctx context.Context, fd int, loopbacks map[int]bool, handler func(packetInfo, bool), errorsChannel chan<- error) {
	buffer := make([]byte, 65535)
	for {
		length, address, err := syscall.Recvfrom(fd, buffer, 0)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EINTR) {
				continue
			}
			errorsChannel <- err
			return
		}
		link, ok := address.(*syscall.SockaddrLinklayer)
		if !ok || loopbacks[link.Ifindex] || link.Pkttype == 3 {
			continue
		}
		packet, ok := parseIPPacket(buffer[:length])
		if ok {
			handler(packet, link.Pkttype == packetOutgoing)
		}
	}
}

func loopbackInterfaces() map[int]bool {
	result := make(map[int]bool)
	interfaces, _ := net.Interfaces()
	for _, current := range interfaces {
		if current.Flags&net.FlagLoopback != 0 {
			result[current.Index] = true
		}
	}
	return result
}

func hostToNetworkShort(value uint16) int {
	return int(value<<8 | value>>8)
}
