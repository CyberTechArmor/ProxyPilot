// Package main is the entry point for proxypilot-agent, the host-side
// RPC bridge that replaces nsenter as the dashboard container's path
// to host operations.
//
// Phase A scope: scaffold + agent.ping only. The Node backend is NOT
// using this binary in any production path yet — every existing
// nsenter call site stays untouched. Phases B-E migrate Caddy /
// Incus / Docker / misc methods onto the agent behind feature flags;
// Phase F drops `privileged: true` on the container once those flags
// have flipped and burned in.
//
// Wire protocol — JSON-over-newline, one request/response per
// connection (pooling is a later concern):
//
//	Request:  {"id":<int>,"method":"<name>","params":{...}}\n
//	Response: {"id":<int>,"result":<any>}\n
//	          {"id":<int>,"error":{"code":"<code>","message":"<msg>"}}\n
//
// Bounds: 64 KiB max line, 30s read deadline. Anything larger or
// slower trips a protocol error and the connection closes.
package main

import (
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/cybertecharmor/proxypilot/cmd/agent/methods"
)

const (
	defaultSocket = "/run/proxypilot-agent.sock"
)

func main() {
	socketPath := flag.String("socket", defaultSocket, "Unix socket path to listen on")
	flag.Parse()

	// Methods register themselves with the global registry on import.
	// agent.ping is the only one wired in Phase A; the rest of the
	// dispatcher matrix lights up in Phases B-E.
	registry := methods.DefaultRegistry()

	// Best-effort cleanup of a stale socket from a prior run that
	// crashed without unlinking. systemd RuntimeDirectory would handle
	// this for us if the unit declared one, but we keep the binary
	// independent of unit-file conveniences so it can be exercised
	// by hand on a dev machine.
	_ = os.Remove(*socketPath)

	listener, err := net.Listen("unix", *socketPath)
	if err != nil {
		log.Fatalf("listen %s: %v", *socketPath, err)
	}
	// 0660 + group ownership lets the proxypilot-agent group read+write
	// without the socket being world-accessible. The Docker container
	// joins that group via docker-compose group_add (Phase A.4).
	if err := os.Chmod(*socketPath, 0o660); err != nil {
		log.Fatalf("chmod %s: %v", *socketPath, err)
	}

	log.Printf("proxypilot-agent listening on %s", *socketPath)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		log.Printf("received signal, shutting down")
		_ = listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			// Listener.Close() during shutdown surfaces here as
			// "use of closed network connection"; treat it as a clean
			// exit rather than a fatal so systemd records success.
			if isClosedErr(err) {
				return
			}
			log.Printf("accept: %v", err)
			continue
		}
		go handleConn(conn, registry)
	}
}

func isClosedErr(err error) bool {
	if err == nil {
		return false
	}
	// Avoid pulling in net.ErrClosed via build-tag gymnastics — match
	// on the well-known string the runtime emits on a closed unix
	// listener. Fragile by Go-stdlib convention but stable since 1.16.
	return errStringContains(err, "use of closed network connection")
}

func errStringContains(err error, sub string) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
