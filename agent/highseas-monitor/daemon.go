package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func runDaemon() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("daemon must run as root to capture UDP metadata and map process owners")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	state := newMonitorState()
	state.setOwners(scanUDPOwners())
	if err := os.MkdirAll(filepath.Dir(socketPath), 0750); err != nil {
		return err
	}
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}
	defer func() {
		listener.Close()
		os.Remove(socketPath)
	}()
	if err := setSocketPermissions(socketPath); err != nil {
		return err
	}

	ownerRequests := make(chan struct{}, 1)
	captureErrors, err := startPacketCapture(ctx, func(packet packetInfo, outgoing bool) {
		if state.record(packet, outgoing, time.Now()) {
			select {
			case ownerRequests <- struct{}{}:
			default:
			}
		}
	})
	if err != nil {
		return err
	}

	go func() {
		<-ctx.Done()
		listener.Close()
	}()
	go refreshOwners(ctx, state, ownerRequests)
	go func() {
		for captureErr := range captureErrors {
			log.Printf("capture warning: %v", captureErr)
		}
	}()

	log.Printf("highseas-monitor %s ready on %s", version, socketPath)
	for {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			return acceptErr
		}
		go serveSnapshot(connection, state)
	}
}

func refreshOwners(ctx context.Context, state *monitorState, requests <-chan struct{}) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			state.setOwners(scanUDPOwners())
		case <-requests:
			state.setOwners(scanUDPOwners())
		}
	}
}

func serveSnapshot(connection net.Conn, state *monitorState) {
	defer connection.Close()
	_ = connection.SetWriteDeadline(time.Now().Add(3 * time.Second))
	encoder := json.NewEncoder(connection)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(state.snapshot(time.Now())); err != nil {
		log.Printf("snapshot write failed: %v", err)
	}
}

func setSocketPermissions(path string) error {
	if group, err := user.LookupGroup("highseas-monitor"); err == nil {
		if gid, conversionErr := strconv.Atoi(group.Gid); conversionErr == nil {
			if err := os.Chown(path, 0, gid); err != nil {
				return err
			}
		}
	}
	return os.Chmod(path, 0660)
}

func printSnapshot() error {
	connection, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		return fmt.Errorf("cannot reach monitor service: %w", err)
	}
	defer connection.Close()
	_, err = io.Copy(os.Stdout, connection)
	return err
}
