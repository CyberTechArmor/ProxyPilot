package methods

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// caddyFmtParams mirrors caddy.adapt: a Caddyfile body that the
// agent runs through `caddy fmt`, returning the canonicalised text.
type caddyFmtParams struct {
	ConfigText string `json:"config_text"`
}

type caddyFmtResult struct {
	Formatted string `json:"formatted"`
	Error     string `json:"error,omitempty"`
}

// CaddyFmt is the caddy.fmt RPC handler.
//
// caddy fmt without --overwrite prints the formatted Caddyfile to
// stdout and exits 1 when the input differed from the formatted
// output. That non-zero exit is informational, not a failure — we
// still want to return the formatted string. So an ExitError here
// is a structured success path; only exec/IO failures become
// envelope-level errors.
func CaddyFmt(params json.RawMessage) (any, *Error) {
	var p caddyFmtParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &Error{Code: "invalid_params", Message: "caddy.fmt params must be {config_text:string}: " + err.Error()}
	}
	if p.ConfigText == "" {
		return nil, &Error{Code: "invalid_params", Message: "config_text is required"}
	}
	if len(p.ConfigText) > maxCaddyConfigBytes {
		return nil, &Error{Code: "invalid_params", Message: fmt.Sprintf("config_text exceeds %d bytes", maxCaddyConfigBytes)}
	}

	f, err := os.CreateTemp("", "proxypilot-caddy-fmt-*.Caddyfile")
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

	stdout, stderr, runErr := runCaddy("fmt", f.Name())
	if runErr != nil {
		if _, ok := runErr.(*exec.ExitError); ok {
			// "Formatting differed" — stdout still carries the formatted
			// text. If stdout is somehow empty, surface stderr so the
			// caller has something actionable.
			if len(stdout) == 0 {
				return caddyFmtResult{Error: strings.TrimSpace(string(stderr))}, nil
			}
			return caddyFmtResult{Formatted: string(stdout)}, nil
		}
		return nil, &Error{Code: "caddy_exec_failed", Message: runErr.Error()}
	}
	return caddyFmtResult{Formatted: string(stdout)}, nil
}

type caddyListModulesResult struct {
	Modules []string `json:"modules"`
}

// CaddyListModules is the caddy.list_modules RPC handler. It runs
// `caddy list-modules` and splits stdout on newlines into a slice.
// Caddy's output is one module name per line; blank lines and
// trailing whitespace are stripped.
func CaddyListModules(_ json.RawMessage) (any, *Error) {
	stdout, stderr, runErr := runCaddy("list-modules")
	if runErr != nil {
		msg := runErr.Error()
		if s := strings.TrimSpace(string(stderr)); s != "" {
			msg = s
		}
		return nil, &Error{Code: "caddy_exec_failed", Message: msg}
	}
	lines := strings.Split(string(stdout), "\n")
	modules := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		modules = append(modules, line)
	}
	return caddyListModulesResult{Modules: modules}, nil
}

type caddyVersionResult struct {
	Version string `json:"version"`
}

// CaddyVersion is the caddy.version RPC handler. Returns the
// trimmed stdout of `caddy version` verbatim — the format is
// `vX.Y.Z hSHA` and callers shouldn't try to parse it further than
// "show this string to the operator".
func CaddyVersion(_ json.RawMessage) (any, *Error) {
	stdout, stderr, runErr := runCaddy("version")
	if runErr != nil {
		msg := runErr.Error()
		if s := strings.TrimSpace(string(stderr)); s != "" {
			msg = s
		}
		return nil, &Error{Code: "caddy_exec_failed", Message: msg}
	}
	return caddyVersionResult{Version: strings.TrimSpace(string(stdout))}, nil
}
