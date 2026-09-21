package main

import (
	"fmt"
	"os"
)

const (
	version    = "0.3.0"
	socketPath = "/run/highseas-monitor/monitor.sock"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "daemon":
		err = runDaemon()
	case "snapshot":
		err = printSnapshot()
	case "version", "--version", "-v":
		fmt.Printf("highseas-monitor %s\n", version)
		return
	default:
		usage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "highseas-monitor: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: highseas-monitor daemon | snapshot --json | version")
}
