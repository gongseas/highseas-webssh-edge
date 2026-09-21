//go:build !linux

package main

import (
	"context"
	"fmt"
)

func startPacketCapture(_ context.Context, _ func(packetInfo, bool)) (<-chan error, error) {
	return nil, fmt.Errorf("packet capture is supported on Linux only")
}
