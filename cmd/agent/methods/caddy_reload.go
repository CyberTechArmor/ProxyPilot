package methods

import (
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"
)

// defaultCaddyConfigPath is the on-host path the agent reloads when
// the caller passes no config_path. Matches what install.sh lays
// down and what services.js's existing nsenter callers reference.
const defaultCaddyConfigPath = "/etc/caddy/Caddyfile"

// caddyConfigPathRe constrains config_path to the /etc/caddy tree.
// The character class deliberately excludes "..", spaces, $, ;, and
// any other shell metacharacter — even though we exec without a
// shell, defence-in-depth keeps a future contributor from grafting
// this onto a shell call without re-validating. The regex rejects
// `..` because `.` may only appear next to alphanumerics, never
// twice in a row at a path boundary; we also reject bare `..` runs
// explicitly below to keep the intent obvious to readers.
var caddyConfigPathRe = regexp.MustCompile(`^/etc/caddy/[A-Za-z0-9_/.-]+$`)

type caddyReloadParams struct {
	ConfigPath string `json:"config_path,omitempty"`
}

type caddyReloadResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// CaddyReload is the caddy.reload RPC handler. It runs
// `caddy reload --config <path> --force` against either the default
// Caddyfile or a caller-supplied path inside /etc/caddy.
//
// Path validation is strict by design — the agent must not trust
// config_path verbatim because Phase B's backend driver may forward
// operator-influenced inputs here in future commits. The regex pins
// the path to /etc/caddy, the explicit `..` check rejects traversal
// segments the regex would otherwise accept (e.g. `/etc/caddy/a..b`
// is fine, `/etc/caddy/../passwd` is not), and we never expand or
// resolve symlinks before passing to caddy.
func CaddyReload(params json.RawMessage) (any, *Error) {
	var p caddyReloadParams
	if len(params) > 0 && string(params) != "null" {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &Error{Code: "invalid_params", Message: "caddy.reload params must be {config_path?:string}: " + err.Error()}
		}
	}

	path := p.ConfigPath
	if path == "" {
		path = defaultCaddyConfigPath
	}
	if !caddyConfigPathRe.MatchString(path) {
		return nil, &Error{Code: "invalid_params", Message: "config_path must match ^/etc/caddy/[A-Za-z0-9_/.-]+$"}
	}
	if strings.Contains(path, "..") {
		return nil, &Error{Code: "invalid_params", Message: "config_path must not contain .."}
	}

	stdout, stderr, runErr := runCaddy("reload", "--config", path, "--force")
	if runErr != nil {
		if _, ok := runErr.(*exec.ExitError); ok {
			msg := strings.TrimSpace(string(stderr))
			if msg == "" {
				msg = strings.TrimSpace(string(stdout))
			}
			return caddyReloadResult{OK: false, Error: msg}, nil
		}
		return nil, &Error{Code: "caddy_exec_failed", Message: runErr.Error()}
	}
	return caddyReloadResult{OK: true}, nil
}
