package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net"
	"time"

	"github.com/cybertecharmor/proxypilot/cmd/agent/methods"
)

const (
	// One request line, one response line, then close. 64 KiB is a
	// generous ceiling for params payloads — larger inputs (e.g.
	// arbitrary file uploads) will land on a streaming method in a
	// later phase, not on this JSON-line wire.
	maxLineBytes = 64 * 1024
	// Read deadline. A client that connects but never writes a request
	// is probably hung — kill the conn so we don't leak a goroutine
	// per stuck client.
	readDeadline = 30 * time.Second
)

// handleConn reads exactly one request line, dispatches to the
// registered method handler, writes exactly one response line, and
// closes. Errors during read/dispatch produce an error envelope on
// the wire when the request was syntactically valid enough that we
// could echo back its id; otherwise the connection is closed without
// a response (the client will see EOF).
func handleConn(conn net.Conn, registry *methods.Registry) {
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(readDeadline)); err != nil {
		return
	}

	br := bufio.NewReaderSize(conn, maxLineBytes)
	line, err := br.ReadBytes('\n')
	if err != nil && err != io.EOF {
		log.Printf("read: %v", err)
		return
	}
	if len(line) == 0 {
		return
	}
	// ReadBytes returns a slice that includes the trailing newline; we
	// also defensively cap on length so a malicious client can't drive
	// the agent into reading beyond the buffer (bufio will return
	// bufio.ErrBufferFull before that, but be explicit).
	if len(line) > maxLineBytes {
		writeErr(conn, 0, "request_too_large", "request exceeds 64 KiB line limit")
		return
	}

	var req methods.Request
	if err := json.Unmarshal(line, &req); err != nil {
		writeErr(conn, 0, "parse_error", "invalid JSON request: "+err.Error())
		return
	}
	if req.Method == "" {
		writeErr(conn, req.ID, "invalid_request", "method is required")
		return
	}

	handler, ok := registry.Lookup(req.Method)
	if !ok {
		writeErr(conn, req.ID, "method_not_found", "unknown method: "+req.Method)
		return
	}

	result, methodErr := handler(req.Params)
	if methodErr != nil {
		writeErr(conn, req.ID, methodErr.Code, methodErr.Message)
		return
	}
	writeOK(conn, req.ID, result)
}

func writeOK(w io.Writer, id int64, result any) {
	resp := methods.Response{ID: id, Result: result}
	encodeAndWrite(w, resp)
}

func writeErr(w io.Writer, id int64, code, message string) {
	resp := methods.Response{
		ID: id,
		Error: &methods.Error{
			Code:    code,
			Message: message,
		},
	}
	encodeAndWrite(w, resp)
}

func encodeAndWrite(w io.Writer, resp methods.Response) {
	buf, err := json.Marshal(resp)
	if err != nil {
		// Fallback: a hand-rolled minimal error envelope. This path
		// only fires if the result struct is non-encodable, which is a
		// programming bug in a method, not an operator-input issue.
		log.Printf("encode response: %v", err)
		_, _ = w.Write([]byte(`{"id":0,"error":{"code":"internal","message":"response encoding failed"}}` + "\n"))
		return
	}
	buf = append(buf, '\n')
	if _, err := w.Write(buf); err != nil {
		log.Printf("write: %v", err)
	}
}
