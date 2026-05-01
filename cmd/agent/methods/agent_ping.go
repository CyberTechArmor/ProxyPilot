package methods

import "encoding/json"

// AgentPing is the proof-of-life RPC. Returns the literal string
// "pong" — the Node client uses this round trip to verify the
// socket bind-mount + group_add are wired correctly before any
// real method is called against it.
//
// Params are ignored; future phases may add a {"echo": "..."}
// payload that the agent echoes back, but that's not in scope for
// the Phase A scaffold.
func AgentPing(_ json.RawMessage) (any, *Error) {
	return "pong", nil
}
