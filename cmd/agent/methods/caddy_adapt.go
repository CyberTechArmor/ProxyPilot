package methods

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// caddyAdaptParams is the on-wire param shape for caddy.adapt: a
// single string carrying an arbitrary Caddyfile body. The agent
// writes it to a tmpfile under the unit's PrivateTmp namespace,
// runs `caddy adapt --config <tmpfile>`, and returns the JSON
// stdout on success.
type caddyAdaptParams struct {
	ConfigText string `json:"config_text"`
}

// caddyAdaptResult is the success result shape. On a non-zero caddy
// exit (operator-supplied Caddyfile is invalid) we still return a
// structured result with ok=false and Error populated — that way the
// dashboard can surface caddy's diagnostic without unwinding through
// an envelope-level error meant for transport failures.
type caddyAdaptResult struct {
	OK          bool   `json:"ok"`
	AdaptedJSON string `json:"adapted_json,omitempty"`
	Error       string `json:"error,omitempty"`
}

// CaddyAdapt is the caddy.adapt RPC handler.
func CaddyAdapt(params json.RawMessage) (any, *Error) {
	var p caddyAdaptParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &Error{Code: "invalid_params", Message: "caddy.adapt params must be {config_text:string}: " + err.Error()}
	}
	if p.ConfigText == "" {
		return nil, &Error{Code: "invalid_params", Message: "config_text is required"}
	}
	if len(p.ConfigText) > maxCaddyConfigBytes {
		return nil, &Error{Code: "invalid_params", Message: fmt.Sprintf("config_text exceeds %d bytes", maxCaddyConfigBytes)}
	}

	f, err := os.CreateTemp("", "proxypilot-caddy-adapt-*.Caddyfile")
	if err != nil {
		return nil, &Error{Code: "tmpfile_failed", Message: err.Error()}
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(p.ConfigText); err != nil {
		f.Close()
		return nil, &Error{Code: "tmpfile_failed", Message: err.Error()}
	}
	if err := f.Close(); err != nil {
		return nil, &Error{Code: "tmpfile_failed", Message: err.Error()}
	}

	stdout, stderr, runErr := runCaddy("adapt", "--config", f.Name())
	if runErr != nil {
		// ExitError ⇒ caddy ran and refused the input. That's a
		// structured method result, not a transport failure: callers
		// want to see the diagnostic, not a stack trace.
		if _, ok := runErr.(*exec.ExitError); ok {
			return caddyAdaptResult{OK: false, Error: strings.TrimSpace(string(stderr))}, nil
		}
		return nil, &Error{Code: "caddy_exec_failed", Message: runErr.Error()}
	}
	return caddyAdaptResult{OK: true, AdaptedJSON: string(stdout)}, nil
}
