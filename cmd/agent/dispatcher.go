package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"github.com/cybertecharmor/proxypilot/cmd/agent/methods"
	"io"
	"log"
	"net"
	"sync"
	"time"
)

const (
	maxLineBytes     = 64 * 1024
	maxResponseBytes = 4 * 1024 * 1024
	readDeadline     = 30 * time.Second
	writeDeadline    = 5 * time.Second
	maxConnections   = 32
	maxMethodCalls   = 4
)

type peerIdentity struct {
	UID uint32
	PID int32
}
type server struct {
	registry    *methods.Registry
	allowedUIDs map[uint32]bool
	connections chan struct{}
	mu          sync.Mutex
	methods     map[string]chan struct{}
	audit       func(peerIdentity, string, string, time.Duration)
}

func newServer(registry *methods.Registry, allowed map[uint32]bool) *server {
	return &server{registry: registry, allowedUIDs: allowed, connections: make(chan struct{}, maxConnections), methods: make(map[string]chan struct{}), audit: func(peer peerIdentity, method, outcome string, elapsed time.Duration) {
		// Only registered names and fixed outcomes. Never log request bodies, caller-
		// supplied method names, results, errors, credentials or terminal contents.
		log.Printf("rpc uid=%d pid=%d method=%s outcome=%s duration_ms=%d", peer.UID, peer.PID, method, outcome, elapsed.Milliseconds())
	}}
}

func (s *server) accept(conn net.Conn) {
	peer, err := socketPeer(conn)
	if err != nil || !s.allowedUIDs[peer.UID] {
		conn.Close()
		return
	}
	select {
	case s.connections <- struct{}{}:
		go func() { defer func() { <-s.connections }(); s.handle(conn, peer) }()
	default:
		conn.Close()
	}
}

func (s *server) methodSlot(method string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	// These methods share a root-runner request file; serialize across aliases.
	if method == "update.request" || method == "update.check" || method == "storage.install_request" {
		method = "update-writer"
	}
	slot := s.methods[method]
	if slot == nil {
		limit := maxMethodCalls
		if method == "update-writer" || method == "security.cve_2026_31431.patch" {
			limit = 1
		}
		slot = make(chan struct{}, limit)
		s.methods[method] = slot
	}
	return slot
}

func (s *server) handle(conn net.Conn, peer peerIdentity) {
	defer conn.Close()
	started := time.Now()
	method, outcome := "unparsed", "invalid_request"
	defer func() {
		if recover() != nil {
			outcome = "internal"
			writeErr(conn, 0, "internal", "method failed")
		}
		s.audit(peer, method, outcome, time.Since(started))
	}()
	if err := conn.SetReadDeadline(time.Now().Add(readDeadline)); err != nil {
		return
	}
	// ReadSlice returns ErrBufferFull without allocating an unbounded line.
	line, err := bufio.NewReaderSize(conn, maxLineBytes).ReadSlice('\n')
	if err == bufio.ErrBufferFull {
		outcome = "request_too_large"
		writeErr(conn, 0, outcome, "request exceeds 64 KiB line limit")
		return
	}
	if err != nil && err != io.EOF {
		return
	}
	if len(line) == 0 {
		return
	}
	var req methods.Request
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil {
		writeErr(conn, 0, "parse_error", "invalid JSON request")
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		writeErr(conn, 0, "parse_error", "one request is required")
		return
	}
	handler, ok := s.registry.Lookup(req.Method)
	if !ok {
		outcome = "method_not_found"
		writeErr(conn, req.ID, outcome, "method is not available")
		return
	}
	method = req.Method
	slot := s.methodSlot(method)
	select {
	case slot <- struct{}{}:
		defer func() { <-slot }()
	default:
		outcome = "busy"
		writeErr(conn, req.ID, outcome, "method concurrency limit reached")
		return
	}
	result, methodErr := handler(req.Params)
	if methodErr != nil {
		outcome = "method_error"
		writeErr(conn, req.ID, methodErr.Code, methodErr.Message)
		return
	}
	outcome = "ok"
	writeOK(conn, req.ID, result)
}

func writeOK(w io.Writer, id int64, result any) {
	encodeAndWrite(w, methods.Response{ID: id, Result: result})
}
func writeErr(w io.Writer, id int64, code, message string) {
	encodeAndWrite(w, methods.Response{ID: id, Error: &methods.Error{Code: code, Message: message}})
}
func encodeAndWrite(w io.Writer, resp methods.Response) {
	if conn, ok := w.(net.Conn); ok {
		if conn.SetWriteDeadline(time.Now().Add(writeDeadline)) != nil {
			return
		}
	}
	buf, err := json.Marshal(resp)
	if err != nil || len(buf) > maxResponseBytes {
		buf, _ = json.Marshal(methods.Response{ID: resp.ID, Error: &methods.Error{Code: "response_limit", Message: "response cannot be delivered within limits"}})
	}
	_, _ = w.Write(append(buf, '\n'))
}
