package methods

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeStub creates a #!/bin/sh script in a fresh t.TempDir and
// returns its path. body is the script body run after the shebang.
// The stub stands in for /usr/bin/caddy via the caddyBinary
// package-level var so tests don't depend on caddy actually being
// installed on the runner.
func writeStub(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "caddy")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return path
}

// withCaddyBinary swaps caddyBinary for the duration of the test
// and restores it via t.Cleanup so concurrent tests don't bleed.
// Tests that mutate caddyBinary must NOT use t.Parallel.
func withCaddyBinary(t *testing.T, path string) {
	t.Helper()
	prev := caddyBinary
	caddyBinary = path
	t.Cleanup(func() { caddyBinary = prev })
}

func TestCaddyAdapt(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		withCaddyBinary(t, writeStub(t, `echo '{"adapted":true}'; exit 0`))
		raw := json.RawMessage(`{"config_text":":80 {\n}"}`)
		result, err := CaddyAdapt(raw)
		if err != nil {
			t.Fatalf("unexpected envelope error: %+v", err)
		}
		r := result.(caddyAdaptResult)
		if !r.OK {
			t.Errorf("expected ok=true, got %+v", r)
		}
		if !strings.Contains(r.AdaptedJSON, "adapted") {
			t.Errorf("expected adapted JSON in result, got %q", r.AdaptedJSON)
		}
	})

	t.Run("invalid Caddyfile → structured error", func(t *testing.T) {
		withCaddyBinary(t, writeStub(t, `echo "syntax error: unexpected token" >&2; exit 1`))
		raw := json.RawMessage(`{"config_text":"garbage"}`)
		result, err := CaddyAdapt(raw)
		if err != nil {
			t.Fatalf("expected structured result, got envelope error: %+v", err)
		}
		r := result.(caddyAdaptResult)
		if r.OK {
			t.Errorf("expected ok=false")
		}
		if !strings.Contains(r.Error, "syntax error") {
			t.Errorf("expected stderr in error field, got %q", r.Error)
		}
	})

	t.Run("missing binary → envelope error", func(t *testing.T) {
		withCaddyBinary(t, filepath.Join(t.TempDir(), "no-such-caddy"))
		raw := json.RawMessage(`{"config_text":"x"}`)
		_, err := CaddyAdapt(raw)
		if err == nil || err.Code != "caddy_exec_failed" {
			t.Errorf("expected caddy_exec_failed envelope, got %+v", err)
		}
	})

	cases := []struct {
		name     string
		params   string
		wantCode string
	}{
		{"oversized config_text", `{"config_text":"` + strings.Repeat("a", maxCaddyConfigBytes+1) + `"}`, "invalid_params"},
		{"empty config_text", `{}`, "invalid_params"},
		{"malformed JSON", `not json`, "invalid_params"},
		{"wrong type", `{"config_text":42}`, "invalid_params"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := CaddyAdapt(json.RawMessage(tc.params))
			if err == nil || err.Code != tc.wantCode {
				t.Errorf("expected %s, got %+v", tc.wantCode, err)
			}
		})
	}
}

func TestCaddyReload(t *testing.T) {
	t.Run("success with default path", func(t *testing.T) {
		withCaddyBinary(t, writeStub(t, `exit 0`))
		result, err := CaddyReload(json.RawMessage(`{}`))
		if err != nil {
			t.Fatalf("unexpected envelope error: %+v", err)
		}
		if !result.(caddyReloadResult).OK {
			t.Errorf("expected ok=true")
		}
	})

	t.Run("success with explicit path", func(t *testing.T) {
		withCaddyBinary(t, writeStub(t, `exit 0`))
		result, err := CaddyReload(json.RawMessage(`{"config_path":"/etc/caddy/sites/foo.caddy"}`))
		if err != nil {
			t.Fatalf("unexpected envelope error: %+v", err)
		}
		if !result.(caddyReloadResult).OK {
			t.Errorf("expected ok=true")
		}
	})

	t.Run("non-zero exit → structured error", func(t *testing.T) {
		withCaddyBinary(t, writeStub(t, `echo "reload failed: address in use" >&2; exit 1`))
		result, err := CaddyReload(json.RawMessage(`{}`))
		if err != nil {
			t.Fatalf("expected structured result, got envelope error: %+v", err)
		}
		r := result.(caddyReloadResult)
		if r.OK {
			t.Errorf("expected ok=false")
		}
		if !strings.Contains(r.Error, "address in use") {
			t.Errorf("expected stderr in error, got %q", r.Error)
		}
	})

	t.Run("missing binary → envelope error", func(t *testing.T) {
		withCaddyBinary(t, filepath.Join(t.TempDir(), "no-such-caddy"))
		_, err := CaddyReload(json.RawMessage(`{}`))
		if err == nil || err.Code != "caddy_exec_failed" {
			t.Errorf("expected caddy_exec_failed, got %+v", err)
		}
	})

	traversalCases := []string{
		"/etc/caddy/../passwd",
		"/etc/caddy/../../etc/passwd",
		"/etc/caddy/sub/../../../passwd",
		"/etc/passwd",
		"/var/lib/foo",
		"./etc/caddy/Caddyfile",
		"/etc/caddy",
		"/etc/caddy/",
		"/etc/caddy/with space",
		"/etc/caddy/$(reboot)",
		"/etc/caddy/file;rm",
	}
	for _, p := range traversalCases {
		t.Run("reject "+p, func(t *testing.T) {
			blob, _ := json.Marshal(map[string]string{"config_path": p})
			_, err := CaddyReload(blob)
			if err == nil || err.Code != "invalid_params" {
				t.Errorf("path %q should be rejected, got %+v", p, err)
			}
		})
	}
}

func TestCaddyFmt(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		withCaddyBinary(t, writeStub(t, `echo "formatted output"; exit 0`))
		result, err := CaddyFmt(json.RawMessage(`{"config_text":":80 {}"}`))
		if err != nil {
			t.Fatalf("unexpected envelope error: %+v", err)
		}
		r := result.(caddyFmtResult)
		if !strings.Contains(r.Formatted, "formatted") {
			t.Errorf("expected formatted output, got %q", r.Formatted)
		}
	})

	t.Run("formatting differed (exit 1) still returns text", func(t *testing.T) {
		// caddy fmt without --overwrite exits 1 when formatting differs;
		// stdout still carries the canonicalised Caddyfile.
		withCaddyBinary(t, writeStub(t, `echo "reformatted body"; exit 1`))
		result, err := CaddyFmt(json.RawMessage(`{"config_text":":80 {}"}`))
		if err != nil {
			t.Fatalf("expected structured result, got envelope error: %+v", err)
		}
		r := result.(caddyFmtResult)
		if !strings.Contains(r.Formatted, "reformatted body") {
			t.Errorf("expected formatted text on exit 1, got %q", r.Formatted)
		}
	})

	t.Run("missing binary → envelope error", func(t *testing.T) {
		withCaddyBinary(t, filepath.Join(t.TempDir(), "no-such-caddy"))
		_, err := CaddyFmt(json.RawMessage(`{"config_text":"x"}`))
		if err == nil || err.Code != "caddy_exec_failed" {
			t.Errorf("expected caddy_exec_failed, got %+v", err)
		}
	})

	t.Run("oversized config_text", func(t *testing.T) {
		blob := `{"config_text":"` + strings.Repeat("a", maxCaddyConfigBytes+1) + `"}`
		_, err := CaddyFmt(json.RawMessage(blob))
		if err == nil || err.Code != "invalid_params" {
			t.Errorf("expected invalid_params, got %+v", err)
		}
	})
}

func TestCaddyListModules(t *testing.T) {
	t.Run("success splits stdout on newlines", func(t *testing.T) {
		withCaddyBinary(t, writeStub(t, `printf "http.handlers.file_server\nhttp.handlers.reverse_proxy\n\ntls.stek.distributed\n"; exit 0`))
		result, err := CaddyListModules(nil)
		if err != nil {
			t.Fatalf("unexpected envelope error: %+v", err)
		}
		got := result.(caddyListModulesResult).Modules
		want := []string{"http.handlers.file_server", "http.handlers.reverse_proxy", "tls.stek.distributed"}
		if len(got) != len(want) {
			t.Fatalf("got %d modules (%v), want %d (%v)", len(got), got, len(want), want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("modules[%d] = %q, want %q", i, got[i], want[i])
			}
		}
	})

	t.Run("missing binary → envelope error", func(t *testing.T) {
		withCaddyBinary(t, filepath.Join(t.TempDir(), "no-such-caddy"))
		_, err := CaddyListModules(nil)
		if err == nil || err.Code != "caddy_exec_failed" {
			t.Errorf("expected caddy_exec_failed, got %+v", err)
		}
	})
}

func TestCaddyVersion(t *testing.T) {
	t.Run("success returns trimmed stdout", func(t *testing.T) {
		withCaddyBinary(t, writeStub(t, `printf "v2.7.5 h1:abcdef\n"; exit 0`))
		result, err := CaddyVersion(nil)
		if err != nil {
			t.Fatalf("unexpected envelope error: %+v", err)
		}
		got := result.(caddyVersionResult).Version
		if got != "v2.7.5 h1:abcdef" {
			t.Errorf("version = %q, want v2.7.5 h1:abcdef", got)
		}
	})

	t.Run("missing binary → envelope error", func(t *testing.T) {
		withCaddyBinary(t, filepath.Join(t.TempDir(), "no-such-caddy"))
		_, err := CaddyVersion(nil)
		if err == nil || err.Code != "caddy_exec_failed" {
			t.Errorf("expected caddy_exec_failed, got %+v", err)
		}
	})
}

func TestDefaultRegistryHasAllCaddyMethods(t *testing.T) {
	r := DefaultRegistry()
	for _, name := range []string{"agent.ping", "caddy.adapt", "caddy.reload", "caddy.fmt", "caddy.list_modules", "caddy.version"} {
		if _, ok := r.Lookup(name); !ok {
			t.Errorf("DefaultRegistry missing method %q", name)
		}
	}
}
