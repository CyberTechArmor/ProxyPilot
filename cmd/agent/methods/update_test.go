package methods

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// withUpdateDirs points the update methods at fresh temp directories and
// shortens the check wait so a test that expects no runner answer does not
// sit for the production 3 s. Tests mutate package vars — no t.Parallel.
func withUpdateDirs(t *testing.T) (string, string) {
	t.Helper()
	runDir, stateDir := t.TempDir(), t.TempDir()
	prevRun, prevState, prevWait := updateRunDir, updateStateDir, updateCheckWait
	updateRunDir, updateStateDir, updateCheckWait = runDir, stateDir, 1500*time.Millisecond
	t.Cleanup(func() { updateRunDir, updateStateDir, updateCheckWait = prevRun, prevState, prevWait })
	return runDir, stateDir
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	buf, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readRequest(t *testing.T, runDir string) updateRequestFile {
	t.Helper()
	buf, err := os.ReadFile(filepath.Join(runDir, "request.json"))
	if err != nil {
		t.Fatalf("request.json: %v", err)
	}
	var req updateRequestFile
	if err := json.Unmarshal(buf, &req); err != nil {
		t.Fatalf("request.json parse: %v", err)
	}
	return req
}

// fakeRunner stands in for scripts/update-runner.sh's `check` mode: it waits
// for a request, checks the nonce contract the runner enforces, consumes the
// files and writes installed.json.
func fakeRunner(t *testing.T, runDir, stateDir string, facts map[string]any) chan updateRequestFile {
	t.Helper()
	got := make(chan updateRequestFile, 1)
	go func() {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			buf, err := os.ReadFile(filepath.Join(runDir, "request.json"))
			if err != nil {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			var req updateRequestFile
			if err := json.Unmarshal(buf, &req); err != nil {
				got <- updateRequestFile{}
				return
			}
			nonce, err := os.ReadFile(filepath.Join(runDir, "nonce."+req.ID))
			if err != nil || strings.TrimSpace(string(nonce)) != req.Nonce {
				got <- updateRequestFile{}
				return
			}
			_ = os.Remove(filepath.Join(runDir, "request.json"))
			_ = os.Remove(filepath.Join(runDir, "nonce."+req.ID))
			out := map[string]any{"configured": true, "checked_at_unix": time.Now().Unix()}
			for k, v := range facts {
				out[k] = v
			}
			writeJSON(t, filepath.Join(stateDir, "installed.json"), out)
			got <- req
			return
		}
		got <- updateRequestFile{}
	}()
	return got
}

func TestUpdateRequest(t *testing.T) {
	cases := []struct {
		name     string
		params   string
		wantCode string
	}{
		{"missing requested_by", `{}`, "invalid_params"},
		{"requested_by with shell chars", `{"requested_by":"admin; rm -rf /"}`, "invalid_params"},
		{"requested_by too long", `{"requested_by":"` + strings.Repeat("a", 81) + `"}`, "invalid_params"},
		{"flag outside allowlist", `{"requested_by":"admin","flags":["--discard-local"]}`, "invalid_params"},
		{"flag that is not a flag", `{"requested_by":"admin","flags":["--rebuild; reboot"]}`, "invalid_params"},
		{"malformed json", `{"requested_by":`, "invalid_params"},
		{"ok no flags", `{"requested_by":"admin"}`, ""},
		{"ok both flags, deduplicated", `{"requested_by":"user:42","flags":["--rebuild","--enable-mock2","--rebuild"]}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runDir, _ := withUpdateDirs(t)
			res, err := UpdateRequest(json.RawMessage(tc.params))
			if tc.wantCode != "" {
				if err == nil || err.Code != tc.wantCode {
					t.Fatalf("expected %s, got err=%+v res=%+v", tc.wantCode, err, res)
				}
				if updateRequestPending() {
					t.Errorf("a refused request must not leave request.json behind")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %+v", err)
			}
			r := res.(updateRequestResult)
			if !updateIDRe.MatchString(r.ID) {
				t.Errorf("id is not a uuid: %q", r.ID)
			}
			req := readRequest(t, runDir)
			if req.ID != r.ID || req.Action != "update" || req.RequestedBy == "" {
				t.Errorf("request shape: %+v", req)
			}
			if req.RequestedAtUnix == 0 || req.RequestedAt == "" {
				t.Errorf("request must carry both timestamps: %+v", req)
			}
			nonce, nerr := os.ReadFile(filepath.Join(runDir, "nonce."+r.ID))
			if nerr != nil || strings.TrimSpace(string(nonce)) != req.Nonce || len(req.Nonce) != 32 {
				t.Errorf("nonce file must exist and match the request: err=%v file=%q req=%q", nerr, nonce, req.Nonce)
			}
			if strings.Contains(tc.name, "both flags") && req.Flags != "--rebuild --enable-mock2" {
				t.Errorf("flags must be deduplicated and space-joined, got %q", req.Flags)
			}
			if !strings.HasSuffix(r.LogPath, r.ID+".log") || !strings.HasSuffix(r.StatePath, "state."+r.ID+".json") {
				t.Errorf("result paths: %+v", r)
			}
		})
	}
}

func TestUpdateRequestRefusesWhileLiveOrPending(t *testing.T) {
	t.Run("running and fresh", func(t *testing.T) {
		_, stateDir := withUpdateDirs(t)
		writeJSON(t, filepath.Join(stateDir, "state.json"), map[string]any{
			"id": "11111111-2222-4333-8444-555555555555", "status": "running", "phase": "Pulling latest code",
			"started_at_unix": time.Now().Add(-5 * time.Minute).Unix(),
		})
		_, err := UpdateRequest(json.RawMessage(`{"requested_by":"admin"}`))
		if err == nil || err.Code != "update_in_progress" {
			t.Fatalf("expected update_in_progress, got %+v", err)
		}
		if !strings.Contains(err.Message, "Pulling latest code") {
			t.Errorf("message should name the phase: %q", err.Message)
		}
	})
	t.Run("running but stale (> 1h) no longer blocks", func(t *testing.T) {
		_, stateDir := withUpdateDirs(t)
		writeJSON(t, filepath.Join(stateDir, "state.json"), map[string]any{
			"id": "11111111-2222-4333-8444-555555555555", "status": "running",
			"started_at_unix": time.Now().Add(-2 * time.Hour).Unix(),
		})
		if _, err := UpdateRequest(json.RawMessage(`{"requested_by":"admin"}`)); err != nil {
			t.Fatalf("stale run must not block: %+v", err)
		}
	})
	t.Run("finished run does not block", func(t *testing.T) {
		_, stateDir := withUpdateDirs(t)
		writeJSON(t, filepath.Join(stateDir, "state.json"), map[string]any{"id": "x", "status": "success", "started_at_unix": time.Now().Unix()})
		if _, err := UpdateRequest(json.RawMessage(`{"requested_by":"admin"}`)); err != nil {
			t.Fatalf("finished run must not block: %+v", err)
		}
	})
	t.Run("pending request", func(t *testing.T) {
		runDir, _ := withUpdateDirs(t)
		if err := os.WriteFile(filepath.Join(runDir, "request.json"), []byte("{}\n"), 0o640); err != nil {
			t.Fatal(err)
		}
		_, err := UpdateRequest(json.RawMessage(`{"requested_by":"admin"}`))
		if err == nil || err.Code != "update_pending" {
			t.Fatalf("expected update_pending, got %+v", err)
		}
	})
}

func TestUpdateCheck(t *testing.T) {
	t.Run("nothing recorded, nobody answers", func(t *testing.T) {
		runDir, _ := withUpdateDirs(t)
		res, err := UpdateCheck(nil)
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		m := res.(map[string]any)
		if m["configured"] != false || m["fresh"] != false {
			t.Errorf("expected configured=false fresh=false, got %+v", m)
		}
		if _, ok := m["error"].(string); !ok {
			t.Errorf("expected an error string explaining what is missing: %+v", m)
		}
		// The check request was dropped for the runner and is still waiting.
		req := readRequest(t, runDir)
		if req.Action != "check" || req.RequestedBy != "agent" {
			t.Errorf("expected a check request, got %+v", req)
		}
		if m["pending"] != true {
			t.Errorf("pending must report the unanswered request")
		}
	})

	t.Run("fresh facts are served without a request", func(t *testing.T) {
		runDir, stateDir := withUpdateDirs(t)
		writeJSON(t, filepath.Join(stateDir, "installed.json"), map[string]any{
			"configured": true, "checked_at_unix": time.Now().Unix(), "head_sha": "abc", "dirty": true,
		})
		res, err := UpdateCheck(nil)
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		m := res.(map[string]any)
		if m["fresh"] != true || m["head_sha"] != "abc" || m["dirty"] != true {
			t.Errorf("expected the recorded facts, got %+v", m)
		}
		if _, statErr := os.Stat(filepath.Join(runDir, "request.json")); statErr == nil {
			t.Errorf("fresh facts must not trigger a check request")
		}
		if m["agent_version"] != AgentVersion {
			t.Errorf("agent_version missing")
		}
	})

	t.Run("stale facts: the runner answers the check request", func(t *testing.T) {
		runDir, stateDir := withUpdateDirs(t)
		if err := os.WriteFile(filepath.Join(stateDir, "source-dir"), []byte("/srv/ProxyPilot\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		writeJSON(t, filepath.Join(stateDir, "installed.json"), map[string]any{
			"configured": true, "checked_at_unix": time.Now().Add(-10 * time.Minute).Unix(), "head_sha": "old",
		})
		got := fakeRunner(t, runDir, stateDir, map[string]any{"head_sha": "new", "branch": "main", "dirty": false, "source_dir": "/srv/ProxyPilot"})
		res, err := UpdateCheck(nil)
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		req := <-got
		if req.Action != "check" {
			t.Fatalf("runner saw a bad request: %+v", req)
		}
		m := res.(map[string]any)
		if m["fresh"] != true || m["head_sha"] != "new" || m["branch"] != "main" || m["source_dir"] != "/srv/ProxyPilot" {
			t.Errorf("expected refreshed facts, got %+v", m)
		}
		if m["pending"] != false {
			t.Errorf("the answered request must be consumed")
		}
		if _, hasErr := m["error"]; hasErr {
			t.Errorf("no error expected once facts exist: %+v", m)
		}
	})

	t.Run("a pending request is not replaced", func(t *testing.T) {
		runDir, stateDir := withUpdateDirs(t)
		if err := os.WriteFile(filepath.Join(runDir, "request.json"), []byte(`{"id":"keep"}`+"\n"), 0o640); err != nil {
			t.Fatal(err)
		}
		writeJSON(t, filepath.Join(stateDir, "installed.json"), map[string]any{"configured": true, "checked_at_unix": 1, "head_sha": "old"})
		res, err := UpdateCheck(nil)
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		m := res.(map[string]any)
		if m["fresh"] != false || m["head_sha"] != "old" || m["pending"] != true {
			t.Errorf("expected stale facts + pending, got %+v", m)
		}
		buf, _ := os.ReadFile(filepath.Join(runDir, "request.json"))
		if !strings.Contains(string(buf), `"keep"`) {
			t.Errorf("the pending request was clobbered: %s", buf)
		}
	})
}

func TestUpdateStatus(t *testing.T) {
	t.Run("idle", func(t *testing.T) {
		withUpdateDirs(t)
		res, err := UpdateStatus(nil)
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		m := res.(map[string]any)
		if m["status"] != "idle" || m["pending"] != false {
			t.Errorf("expected idle, got %+v", m)
		}
	})

	t.Run("invalid id", func(t *testing.T) {
		withUpdateDirs(t)
		_, err := UpdateStatus(json.RawMessage(`{"id":"../state"}`))
		if err == nil || err.Code != "invalid_params" {
			t.Fatalf("expected invalid_params, got %+v", err)
		}
	})

	t.Run("latest state with log tail, ANSI stripped, per-id file preferred", func(t *testing.T) {
		_, stateDir := withUpdateDirs(t)
		id := "11111111-2222-4333-8444-555555555555"
		other := "11111111-2222-4333-8444-555555555556"
		logPath := filepath.Join(stateDir, id+".log")
		if err := os.WriteFile(logPath, []byte("\x1b[0;34m[1/7] Fetching\x1b[0m\nline two\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		writeJSON(t, filepath.Join(stateDir, "state."+id+".json"), map[string]any{"id": id, "status": "success", "phase": "Update complete", "log": logPath})
		writeJSON(t, filepath.Join(stateDir, "state.json"), map[string]any{"id": other, "status": "running", "phase": "Queued"})

		res, err := UpdateStatus(nil)
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		if m := res.(map[string]any); m["id"] != other || m["status"] != "running" {
			t.Errorf("no id → latest state.json, got %+v", m)
		}

		res, err = UpdateStatus(json.RawMessage(`{"id":"` + id + `"}`))
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		m := res.(map[string]any)
		if m["id"] != id || m["status"] != "success" || m["id_match"] != true {
			t.Errorf("id → per-id state, got %+v", m)
		}
		tail, _ := m["log_tail"].(string)
		if strings.Contains(tail, "\x1b") || !strings.Contains(tail, "[1/7] Fetching\nline two") {
			t.Errorf("log tail must be ANSI-stripped, got %q", tail)
		}
		if m["log_truncated"] != false {
			t.Errorf("short log must not be marked truncated")
		}

		res, _ = UpdateStatus(json.RawMessage(`{"id":"` + "11111111-2222-4333-8444-555555555557" + `"}`))
		if m := res.(map[string]any); m["id_match"] != false {
			t.Errorf("unknown id must report id_match=false, got %+v", m)
		}
	})

	t.Run("log tail is capped and fits the wire budget", func(t *testing.T) {
		_, stateDir := withUpdateDirs(t)
		id := "11111111-2222-4333-8444-555555555555"
		logPath := filepath.Join(stateDir, id+".log")
		var sb strings.Builder
		for i := 0; sb.Len() < 200*1024; i++ {
			sb.WriteString("\x1b[0;32mline \x1b[0m\"quoted\" \\ text with tab\t")
			sb.WriteString(strings.Repeat("x", i%40))
			sb.WriteByte('\n')
		}
		if err := os.WriteFile(logPath, []byte(sb.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		writeJSON(t, filepath.Join(stateDir, "state.json"), map[string]any{"id": id, "status": "running", "log": logPath})
		res, err := UpdateStatus(json.RawMessage(`{"log_tail_bytes":1048576}`))
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		m := res.(map[string]any)
		tail := m["log_tail"].(string)
		if len(tail) > updateLogTailMax {
			t.Errorf("tail %d bytes exceeds cap %d", len(tail), updateLogTailMax)
		}
		if m["log_truncated"] != true {
			t.Errorf("a cut tail must say so")
		}
		if strings.HasPrefix(tail, "ine") || !strings.HasPrefix(tail, "line") {
			t.Errorf("tail must start on a line boundary, got %q", tail[:20])
		}
		wire, _ := json.Marshal(m)
		if len(wire) > 64*1024 {
			t.Errorf("full status envelope is %d bytes, over the 64 KiB line limit", len(wire))
		}
		if strings.Contains(tail, "\x1b") {
			t.Errorf("ANSI codes must be stripped")
		}
	})

	t.Run("log path outside the state dir is refused", func(t *testing.T) {
		_, stateDir := withUpdateDirs(t)
		writeJSON(t, filepath.Join(stateDir, "state.json"), map[string]any{"id": "x", "status": "failed", "log": "/etc/passwd"})
		res, err := UpdateStatus(nil)
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		m := res.(map[string]any)
		if _, has := m["log_tail"]; has {
			t.Errorf("must not read a log outside the state dir: %+v", m)
		}
		if m["log_error"] == nil {
			t.Errorf("expected log_error")
		}
		writeJSON(t, filepath.Join(stateDir, "state.json"), map[string]any{"id": "x", "status": "failed", "log": filepath.Join(stateDir, "..", "evil.log")})
		res, _ = UpdateStatus(nil)
		if m := res.(map[string]any); m["log_error"] == nil {
			t.Errorf("traversal via .. must be refused: %+v", m)
		}
	})
}

func TestDefaultRegistryHasUpdateMethods(t *testing.T) {
	r := DefaultRegistry()
	for _, name := range []string{"update.check", "update.request", "update.status"} {
		if _, ok := r.Lookup(name); !ok {
			t.Errorf("DefaultRegistry missing method %q", name)
		}
	}
}
