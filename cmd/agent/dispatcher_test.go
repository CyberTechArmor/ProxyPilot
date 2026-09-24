package main

import (
	"bytes"
	"encoding/json"
	"github.com/cybertecharmor/proxypilot/cmd/agent/methods"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type memoryConn struct {
	input   *bytes.Reader
	output  bytes.Buffer
	read    int
	closed  bool
	writeBy time.Time
}

func newMemoryConn(s string) *memoryConn                 { return &memoryConn{input: bytes.NewReader([]byte(s))} }
func (c *memoryConn) Read(p []byte) (int, error)         { n, e := c.input.Read(p); c.read += n; return n, e }
func (c *memoryConn) Write(p []byte) (int, error)        { return c.output.Write(p) }
func (c *memoryConn) Close() error                       { c.closed = true; return nil }
func (c *memoryConn) LocalAddr() net.Addr                { return &net.UnixAddr{} }
func (c *memoryConn) RemoteAddr() net.Addr               { return &net.UnixAddr{} }
func (c *memoryConn) SetDeadline(time.Time) error        { return nil }
func (c *memoryConn) SetReadDeadline(time.Time) error    { return nil }
func (c *memoryConn) SetWriteDeadline(t time.Time) error { c.writeBy = t; return nil }

func TestDispatcherBoundsAndRedactedAudit(t *testing.T) {
	registry := methods.NewRegistry()
	calls := 0
	registry.Register("test.valid", func(json.RawMessage) (any, *methods.Error) { calls++; return "pong", nil })
	s := newServer(registry, map[uint32]bool{0: true})
	var audit []string
	s.audit = func(_ peerIdentity, method, outcome string, _ time.Duration) {
		audit = append(audit, method+":"+outcome)
	}
	cases := []struct{ request, code string }{
		{strings.Repeat("x", maxLineBytes*4), "request_too_large"},
		{`{"id":1,"method":"test.valid","extra":"SECRET"}` + "\n", "parse_error"},
		{`{"id":1,"method":"SECRET"}` + "\n", "method_not_found"},
		{`{"id":1,"method":"test.valid"} {"id":2}` + "\n", "parse_error"},
		{`{"id":"SECRET","method":"test.valid"}` + "\n", "parse_error"},
	}
	for _, tc := range cases {
		c := newMemoryConn(tc.request)
		s.handle(c, peerIdentity{})
		if !strings.Contains(c.output.String(), `"code":"`+tc.code+`"`) {
			t.Fatalf("unexpected response %s", c.output.String())
		}
		if c.read > maxLineBytes {
			t.Fatal("unbounded request read")
		}
		if !c.closed || c.writeBy.IsZero() {
			t.Fatal("connection lifecycle not bounded")
		}
	}
	if calls != 0 {
		t.Fatal("invalid request reached handler")
	}
	c := newMemoryConn(`{"id":7,"method":"test.valid","params":{"secret":"SECRET"}}` + "\n")
	s.handle(c, peerIdentity{})
	if calls != 1 || !strings.Contains(c.output.String(), `"result":"pong"`) {
		t.Fatal("authorized dispatch failed")
	}
	if strings.Contains(strings.Join(audit, "\n"), "SECRET") {
		t.Fatal("audit leaked request data")
	}
}

func TestDispatcherConcurrencyAndOutput(t *testing.T) {
	registry := methods.NewRegistry()
	var calls atomic.Int32
	registry.Register("test.valid", func(json.RawMessage) (any, *methods.Error) {
		calls.Add(1)
		return strings.Repeat("x", maxResponseBytes+1), nil
	})
	s := newServer(registry, nil)
	slot := s.methodSlot("test.valid")
	for i := 0; i < maxMethodCalls; i++ {
		slot <- struct{}{}
	}
	c := newMemoryConn(`{"id":1,"method":"test.valid"}` + "\n")
	s.handle(c, peerIdentity{})
	if calls.Load() != 0 || !strings.Contains(c.output.String(), `"code":"busy"`) {
		t.Fatal("method cap failed")
	}
	<-slot
	c = newMemoryConn(`{"id":2,"method":"test.valid"}` + "\n")
	s.handle(c, peerIdentity{})
	if calls.Load() != 1 || !strings.Contains(c.output.String(), `"code":"response_limit"`) {
		t.Fatal("response cap failed")
	}
	registry.Register("test.panic", func(json.RawMessage) (any, *methods.Error) { panic("SECRET") })
	c = newMemoryConn(`{"id":3,"method":"test.panic"}` + "\n")
	s.handle(c, peerIdentity{})
	if strings.Contains(c.output.String(), "SECRET") || !strings.Contains(c.output.String(), `"code":"internal"`) {
		t.Fatal("panic handling failed")
	}
}

func TestUnixPeerAuthorization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var calls atomic.Int32
	registry := methods.NewRegistry()
	registry.Register("test.valid", func(json.RawMessage) (any, *methods.Error) { calls.Add(1); return "pong", nil })
	s := newServer(registry, map[uint32]bool{})
	exchange := func(authorized bool, full bool) {
		t.Helper()
		client, err := net.Dial("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		conn, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		peer, err := socketPeer(conn)
		if err != nil || peer.UID != uint32(os.Getuid()) || peer.PID != int32(os.Getpid()) {
			t.Fatalf("kernel identity mismatch: %v %v", peer, err)
		}
		s.allowedUIDs[peer.UID] = authorized
		s.accept(conn)
		client.SetDeadline(time.Now().Add(time.Second))
		_, _ = io.WriteString(client, `{"id":1,"method":"test.valid"}`+"\n")
		body, _ := io.ReadAll(client)
		if authorized && !full && !strings.Contains(string(body), `"result":"pong"`) {
			t.Fatalf("allowed peer failed: %s", body)
		}
		if (!authorized || full) && len(body) != 0 {
			t.Fatal("denied peer received handler response")
		}
	}
	exchange(false, false)
	if calls.Load() != 0 {
		t.Fatal("untrusted peer reached handler")
	}
	exchange(true, false)
	if calls.Load() != 1 {
		t.Fatal("trusted peer failed")
	}
	// Wait for the successful call's slot to be released, then fill the global cap.
	deadline := time.Now().Add(time.Second)
	for len(s.connections) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for i := 0; i < maxConnections; i++ {
		s.connections <- struct{}{}
	}
	exchange(true, true)
	if calls.Load() != 1 {
		t.Fatal("global cap failed")
	}
}

func TestUIDPolicy(t *testing.T) {
	for _, value := range []string{"", "-1", "0,", "root", "1 2", "4294967296"} {
		if _, err := parseUIDs(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	policy, err := parseUIDs("0,1000")
	if err != nil || !policy[0] || !policy[1000] || policy[1001] {
		t.Fatal("UID policy mismatch")
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if _, err := socketPeer(a); err == nil {
		t.Fatal("non-Unix identity accepted")
	}
}
