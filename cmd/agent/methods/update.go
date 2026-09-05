package methods

// Self-update methods: update.check, update.request, update.status.
//
// The agent is unprivileged (NoNewPrivileges, ProtectSystem=strict,
// ProtectHome=true), so it never runs update.sh and cannot even read a
// checkout that lives under /root. What it CAN do is write into
// /run/proxypilot-update — its second RuntimeDirectory — and read the
// world-readable state directory the root-owned runner
// (deploy/proxypilot-update.service ← scripts/update-runner.sh) writes to.
// So every method here is a file exchange:
//
//	update.request  writes nonce.<id> + request.json{action:"update"};
//	                the path unit starts the runner, which validates and runs
//	                `update.sh --yes <flags>` and records state.json + <id>.log.
//	update.check    reads installed.json (branch, sha, dirty…). When the facts
//	                are older than 30 s it drops a request{action:"check"} and
//	                waits briefly for the runner to refresh them — same
//	                privilege boundary, no timer, no git as the agent user.
//	update.status   returns state.json (or state.<id>.json) plus a bounded,
//	                ANSI-stripped tail of the run log.
//
// Nothing here is a network call, and no method takes a path from the caller.
// The request/state contract is documented in docs/features/self-update.md.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	// Package-level so update_test.go can point them at temp dirs.
	updateRunDir    = "/run/proxypilot-update"
	updateStateDir  = "/var/lib/proxypilot/update"
	updateCheckWait = 3 * time.Second
	updateCheckPoll = 100 * time.Millisecond
	updateNow       = time.Now

	// AgentVersion is stamped at build time by install.sh / update.sh:
	//   -ldflags "-X github.com/cybertecharmor/proxypilot/cmd/agent/methods.AgentVersion=<sha>"
	// "dev" means an unstamped local build.
	AgentVersion = "dev"
)

const (
	// installed.json younger than this is served without asking the runner.
	updateFreshWindow = 30 * time.Second
	// A state.json stuck in running/queued for longer than this is treated as
	// abandoned (the runner has TimeoutStartSec=3600, so nothing legit lasts
	// longer) and no longer blocks a new request.
	updateRunningStale = time.Hour
	// Log tail bounds. The wire is one 64 KiB JSON line (dispatcher.go), and
	// JSON escaping grows the text, so the tail is trimmed until the encoded
	// string fits updateWireBudget.
	updateLogTailDefault = 16 * 1024
	updateLogTailMax     = 48 * 1024
	updateWireBudget     = 56 * 1024
)

var (
	updateAllowedFlags  = []string{"--rebuild", "--enable-mock2"}
	updateRequestedByRe = regexp.MustCompile(`^[A-Za-z0-9._@:+-]{1,80}$`)
	updateIDRe          = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	updateLogNameRe     = regexp.MustCompile(`^[0-9a-f-]{36}\.log$`)
	ansiEscapeRe        = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")
)

// updateRequestFile is what lands in /run/proxypilot-update/request.json.
// Flags travel as one space-separated string so the bash runner can split
// and re-validate them token by token without a JSON parser.
type updateRequestFile struct {
	ID              string `json:"id"`
	Action          string `json:"action"`
	RequestedBy     string `json:"requested_by"`
	RequestedAt     string `json:"requested_at"`
	RequestedAtUnix int64  `json:"requested_at_unix"`
	Nonce           string `json:"nonce"`
	Flags           string `json:"flags"`
}

func updateRandomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// updateNewID returns a random RFC 4122 v4 UUID — the id the runner names
// state.<id>.json, <id>.log and done.<id> after.
func updateNewID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}

func updateRequestPath() string { return filepath.Join(updateRunDir, "request.json") }

func updateRequestPending() bool {
	_, err := os.Stat(updateRequestPath())
	return err == nil
}

// writeUpdateRequest drops the nonce file first, then the request file via
// temp + rename so the runner never reads a half-written request. Refuses
// when a request is already waiting: request.json is a single slot and a
// rename would silently discard whatever is there.
func writeUpdateRequest(action, requestedBy, flags string) (string, time.Time, error) {
	if updateRequestPending() {
		return "", time.Time{}, fmt.Errorf("a request is already pending at %s", updateRequestPath())
	}
	id, err := updateNewID()
	if err != nil {
		return "", time.Time{}, err
	}
	nonce, err := updateRandomHex(16)
	if err != nil {
		return "", time.Time{}, err
	}
	at := updateNow().UTC()
	noncePath := filepath.Join(updateRunDir, "nonce."+id)
	if err := os.WriteFile(noncePath, []byte(nonce+"\n"), 0o600); err != nil {
		return "", time.Time{}, fmt.Errorf("write nonce: %w", err)
	}
	req := updateRequestFile{
		ID:              id,
		Action:          action,
		RequestedBy:     requestedBy,
		RequestedAt:     at.Format(time.RFC3339),
		RequestedAtUnix: at.Unix(),
		Nonce:           nonce,
		Flags:           flags,
	}
	buf, err := json.Marshal(req)
	if err != nil {
		_ = os.Remove(noncePath)
		return "", time.Time{}, err
	}
	tmp := filepath.Join(updateRunDir, ".request.json.tmp")
	if err := os.WriteFile(tmp, append(buf, '\n'), 0o640); err != nil {
		_ = os.Remove(noncePath)
		return "", time.Time{}, fmt.Errorf("write request: %w", err)
	}
	if err := os.Rename(tmp, updateRequestPath()); err != nil {
		_ = os.Remove(tmp)
		_ = os.Remove(noncePath)
		return "", time.Time{}, fmt.Errorf("publish request: %w", err)
	}
	return id, at, nil
}

// readJSONObject returns nil, nil when the file does not exist.
func readJSONObject(path string) (map[string]any, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(buf, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return m, nil
}

func numberField(m map[string]any, key string) (float64, bool) {
	if m == nil {
		return 0, false
	}
	switch v := m[key].(type) {
	case float64:
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	}
	return 0, false
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

func readSourceDir() string {
	buf, err := os.ReadFile(filepath.Join(updateStateDir, "source-dir"))
	if err != nil {
		return ""
	}
	line := strings.SplitN(string(buf), "\n", 2)[0]
	return strings.TrimSpace(line)
}

func installedFresh(installed map[string]any, now time.Time) bool {
	at, ok := numberField(installed, "checked_at_unix")
	if !ok {
		return false
	}
	age := now.Unix() - int64(at)
	return age >= 0 && time.Duration(age)*time.Second <= updateFreshWindow
}

// updateRunLive reports whether state.json describes a run that is still
// going (queued/running and started within the stale window).
func updateRunLive(st map[string]any, now time.Time) bool {
	switch stringField(st, "status") {
	case "queued", "running":
	default:
		return false
	}
	started, ok := numberField(st, "started_at_unix")
	if !ok {
		return true
	}
	return now.Sub(time.Unix(int64(started), 0)) < updateRunningStale
}

func validateUpdateFlags(flags []string) ([]string, string) {
	out := make([]string, 0, len(flags))
	seen := map[string]bool{}
	for _, f := range flags {
		ok := false
		for _, a := range updateAllowedFlags {
			if f == a {
				ok = true
				break
			}
		}
		if !ok {
			return nil, fmt.Sprintf("flag %q is not allowed (allowed: %s)", f, strings.Join(updateAllowedFlags, " "))
		}
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out, ""
}

// UpdateCheck is the update.check RPC handler: the recorded checkout facts
// (source_dir, branch, head_sha, head_short, head_date, remote_url, dirty,
// dirty_files, installed_version, checked_at…) plus configured / fresh /
// pending / agent_version. Read-only from the agent's point of view — the
// refresh it may ask for is the runner's `check` mode, which is git
// rev-parse / status as root and nothing else.
func UpdateCheck(_ json.RawMessage) (any, *Error) {
	installedPath := filepath.Join(updateStateDir, "installed.json")
	sourceDir := readSourceDir()
	installed, readErr := readJSONObject(installedPath)
	now := updateNow()
	fresh := installedFresh(installed, now)

	if !fresh && !updateRequestPending() {
		if _, at, err := writeUpdateRequest("check", "agent", ""); err == nil {
			deadline := now.Add(updateCheckWait)
			for updateNow().Before(deadline) {
				time.Sleep(updateCheckPoll)
				cur, err := readJSONObject(installedPath)
				if err != nil || cur == nil {
					continue
				}
				if got, ok := numberField(cur, "checked_at_unix"); ok && int64(got) >= at.Unix() {
					installed, readErr, fresh = cur, nil, true
					break
				}
			}
		}
	}

	out := map[string]any{}
	for k, v := range installed {
		out[k] = v
	}
	if _, ok := out["configured"]; !ok {
		out["configured"] = sourceDir != ""
	}
	if stringField(out, "source_dir") == "" && sourceDir != "" {
		out["source_dir"] = sourceDir
	}
	out["fresh"] = fresh
	out["pending"] = updateRequestPending()
	out["agent_version"] = AgentVersion
	switch {
	case readErr != nil:
		out["error"] = "installed.json unreadable: " + readErr.Error()
	case installed == nil && sourceDir == "":
		out["error"] = "no checkout recorded: run install.sh or update.sh once on the host (it records the git checkout for the self-update runner)"
	case installed == nil:
		out["error"] = "checkout facts not recorded yet: the self-update runner did not answer a check request (is proxypilot-update.path enabled?)"
	}
	return out, nil
}

type updateRequestParams struct {
	RequestedBy string   `json:"requested_by"`
	Flags       []string `json:"flags"`
}

type updateRequestResult struct {
	ID          string `json:"id"`
	RequestedAt string `json:"requested_at"`
	Flags       string `json:"flags"`
	RequestPath string `json:"request_path"`
	StatePath   string `json:"state_path"`
	LogPath     string `json:"log_path"`
}

// UpdateRequest is the update.request RPC handler. It validates the caller's
// input against the allowlist, refuses while a run is live or a request is
// already waiting, and drops the request file. Everything after that is the
// root runner's.
func UpdateRequest(params json.RawMessage) (any, *Error) {
	var p updateRequestParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &Error{Code: "invalid_params", Message: "update.request params must be {requested_by:string, flags?:string[]}: " + err.Error()}
		}
	}
	if !updateRequestedByRe.MatchString(p.RequestedBy) {
		return nil, &Error{Code: "invalid_params", Message: "requested_by is required and must match ^[A-Za-z0-9._@:+-]{1,80}$"}
	}
	flags, bad := validateUpdateFlags(p.Flags)
	if bad != "" {
		return nil, &Error{Code: "invalid_params", Message: bad}
	}
	st, err := readJSONObject(filepath.Join(updateStateDir, "state.json"))
	if err != nil {
		return nil, &Error{Code: "state_unreadable", Message: err.Error()}
	}
	if updateRunLive(st, updateNow()) {
		return nil, &Error{
			Code:    "update_in_progress",
			Message: fmt.Sprintf("update %s is %s (%s); wait for it to finish", stringField(st, "id"), stringField(st, "status"), stringField(st, "phase")),
		}
	}
	if updateRequestPending() {
		return nil, &Error{Code: "update_pending", Message: "a request is already waiting for the update runner"}
	}
	id, at, werr := writeUpdateRequest("update", p.RequestedBy, strings.Join(flags, " "))
	if werr != nil {
		return nil, &Error{Code: "request_write_failed", Message: werr.Error()}
	}
	return updateRequestResult{
		ID:          id,
		RequestedAt: at.Format(time.RFC3339),
		Flags:       strings.Join(flags, " "),
		RequestPath: updateRequestPath(),
		StatePath:   filepath.Join(updateStateDir, "state."+id+".json"),
		LogPath:     filepath.Join(updateStateDir, id+".log"),
	}, nil
}

type updateStatusParams struct {
	ID           string `json:"id"`
	LogTailBytes int    `json:"log_tail_bytes"`
}

// logPathAllowed accepts only <stateDir>/<uuid>.log — the runner is the only
// writer of state files, but the path still never leaves the state dir.
func logPathAllowed(p string) bool {
	if p == "" {
		return false
	}
	clean := filepath.Clean(p)
	dir := filepath.Clean(updateStateDir)
	if filepath.Dir(clean) != dir {
		return false
	}
	return updateLogNameRe.MatchString(filepath.Base(clean))
}

// tailFile returns up to n bytes from the end of the file, starting at a
// line boundary when the cut landed mid-line.
func tailFile(path string, n int) (string, int64, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", 0, false, err
	}
	size := info.Size()
	truncated := false
	if size > int64(n) {
		if _, err := f.Seek(size-int64(n), io.SeekStart); err != nil {
			return "", size, false, err
		}
		truncated = true
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return "", size, truncated, err
	}
	s := string(buf)
	if truncated {
		if i := strings.IndexByte(s, '\n'); i >= 0 && i+1 < len(s) {
			s = s[i+1:]
		}
	}
	return s, size, truncated, nil
}

// fitWireBudget strips ANSI colour codes and shortens the tail (from the
// front, on line boundaries) until its JSON encoding fits the wire budget.
func fitWireBudget(s string, budget int) (string, bool) {
	s = ansiEscapeRe.ReplaceAllString(s, "")
	cut := false
	for {
		enc, err := json.Marshal(s)
		if err == nil && len(enc) <= budget {
			return s, cut
		}
		if len(s) < 64 {
			return "", true
		}
		drop := len(s) / 4
		rest := s[drop:]
		if i := strings.IndexByte(rest, '\n'); i >= 0 && i+1 < len(rest) {
			rest = rest[i+1:]
		}
		s = rest
		cut = true
	}
}

// UpdateStatus is the update.status RPC handler: the latest state.json (or
// state.<id>.json when id names a recorded run) with the run log's tail.
// {status:"idle"} when nothing has ever run.
func UpdateStatus(params json.RawMessage) (any, *Error) {
	var p updateStatusParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &Error{Code: "invalid_params", Message: "update.status params must be {id?:string, log_tail_bytes?:int}: " + err.Error()}
		}
	}
	if p.ID != "" && !updateIDRe.MatchString(p.ID) {
		return nil, &Error{Code: "invalid_params", Message: "id must be a uuid"}
	}
	tailBytes := updateLogTailDefault
	if p.LogTailBytes > 0 {
		tailBytes = p.LogTailBytes
		if tailBytes > updateLogTailMax {
			tailBytes = updateLogTailMax
		}
	}

	statePath := filepath.Join(updateStateDir, "state.json")
	if p.ID != "" {
		per := filepath.Join(updateStateDir, "state."+p.ID+".json")
		if _, err := os.Stat(per); err == nil {
			statePath = per
		}
	}
	st, err := readJSONObject(statePath)
	if err != nil {
		return nil, &Error{Code: "state_unreadable", Message: err.Error()}
	}

	out := map[string]any{}
	if st == nil {
		out["status"] = "idle"
	} else {
		for k, v := range st {
			out[k] = v
		}
	}
	if p.ID != "" {
		out["id_match"] = st != nil && stringField(st, "id") == p.ID
	}
	out["pending"] = updateRequestPending()
	out["agent_version"] = AgentVersion

	if logPath := stringField(st, "log"); logPath != "" {
		if !logPathAllowed(logPath) {
			out["log_error"] = "log path is outside the update state directory"
		} else if text, total, truncated, terr := tailFile(logPath, tailBytes); terr != nil {
			if !os.IsNotExist(terr) {
				out["log_error"] = terr.Error()
			}
		} else {
			fitted, cut := fitWireBudget(text, updateWireBudget)
			out["log_tail"] = fitted
			out["log_tail_bytes"] = len(fitted)
			out["log_total_bytes"] = total
			out["log_truncated"] = truncated || cut
		}
	}
	return out, nil
}
