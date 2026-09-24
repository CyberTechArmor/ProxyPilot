package methods

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBoundedCommandOutputAndTimeout(t *testing.T) {
	out, _, err := runBounded(time.Second, "/usr/bin/head", "-c", "3145728", "/dev/zero")
	if !errors.Is(err, errOutputLimit) || len(out) != maxCommandOutput {
		t.Fatalf("output cap failed: len=%d err=%v", len(out), err)
	}
	started := time.Now()
	_, _, err = runBounded(50*time.Millisecond, "/bin/sh", "-c", "exec sleep 5")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > 2*time.Second {
		t.Fatalf("timeout failed: %v", err)
	}
	literal := "$(touch /should-never-exist); newline\n--option"
	out, _, err = runBounded(time.Second, "/usr/bin/printf", "%s", literal)
	if err != nil || string(out) != literal {
		t.Fatal("argv was not literal")
	}
}

func TestTimeoutStopsDescendants(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "must-not-be-created")
	_, _, err := runBounded(50*time.Millisecond, "/bin/sh", "-c", `(sleep 0.3; touch "$1") & wait`, "sh", marker)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	time.Sleep(350 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("descendant survived cancellation")
	}
}

func TestUpdateStateAndTailBounds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte(`{"value":"`+strings.Repeat("x", 2*1024*1024)+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readJSONObject(path); err == nil {
		t.Fatal("oversized state accepted")
	}
	tail, _, truncated, err := tailFile(path, 1024)
	if err != nil || len(tail) > 1024 || !truncated {
		t.Fatal("unbounded log tail")
	}
}

func TestMethodSchemasRejectUnknownAuthority(t *testing.T) {
	registry := DefaultRegistry()
	for _, method := range []string{"agent.ping", "caddy.adapt", "caddy.fmt", "caddy.reload", "caddy.version", "caddy.list_modules", "storage.list_disks", "storage.zpool_status", "storage.zfs_list", "storage.install_request", "update.request", "update.check", "update.status", "security.cve_2026_31431.check", "security.cve_2026_31431.patch"} {
		handler, ok := registry.Lookup(method)
		if !ok {
			t.Fatal(method)
		}
		_, err := handler(json.RawMessage(`{"command":"SECRET","path":"/etc/shadow"}`))
		if err == nil || err.Code != "invalid_params" || strings.Contains(err.Message, "SECRET") {
			t.Fatalf("%s accepted undeclared inputs or leaked them: %v", method, err)
		}
	}
	for _, raw := range []string{`[]`, `{"name":"a"} {}`, `true`} {
		if decodeParams(json.RawMessage(raw), &struct{}{}) == nil {
			t.Fatal("invalid params accepted")
		}
	}
}
