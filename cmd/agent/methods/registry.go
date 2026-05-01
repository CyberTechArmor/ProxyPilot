// Package methods is the dispatch surface for proxypilot-agent: every
// RPC handler lives in this package, registered by name into a single
// Registry. The dispatcher in cmd/agent looks up an incoming
// request's "method" field in the registry and invokes the handler.
//
// Each handler is a Handler(params json.RawMessage) (any, *Error)
// — params is left raw so each method controls its own parsing
// schema, and an *Error return distinguishes a structured method
// failure (which becomes the on-wire error envelope) from a panic
// or transport failure (which the dispatcher treats as a closed
// connection).
package methods

import "encoding/json"

// Request is the on-wire JSON request envelope.
type Request struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response is the on-wire JSON response envelope. Exactly one of
// Result or Error is populated.
type Response struct {
	ID     int64  `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  *Error `json:"error,omitempty"`
}

// Error is a structured method failure. The Code field is a stable
// string identifier callers can switch on; Message is human-facing.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Handler is the signature every method registers. Returning a nil
// error means success — Result is sent back as-is. Returning an
// *Error means a structured failure — the dispatcher writes it as
// an error envelope.
type Handler func(params json.RawMessage) (any, *Error)

// Registry maps method names to their handlers. Not safe for
// concurrent registration after startup; the dispatcher only ever
// reads from it on the hot path.
type Registry struct {
	handlers map[string]Handler
}

// NewRegistry returns an empty registry. Tests can construct one
// independent of the global default.
func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]Handler)}
}

// Register associates a handler with a method name. Panics on
// duplicate registration so collisions surface at startup, not in
// production.
func (r *Registry) Register(name string, h Handler) {
	if _, exists := r.handlers[name]; exists {
		panic("methods: duplicate registration for " + name)
	}
	r.handlers[name] = h
}

// Lookup returns the handler for a method name and whether it was
// registered.
func (r *Registry) Lookup(name string) (Handler, bool) {
	h, ok := r.handlers[name]
	return h, ok
}

// DefaultRegistry returns a registry pre-populated with every method
// the agent ships with. Phase A wires only agent.ping; subsequent
// phases extend this constructor.
func DefaultRegistry() *Registry {
	r := NewRegistry()
	r.Register("agent.ping", AgentPing)
	r.Register("caddy.adapt", CaddyAdapt)
	return r
}
