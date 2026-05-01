package methods

import (
	"bytes"
	"os/exec"
)

// caddyBinary is the absolute path to the caddy executable. It's a
// package-level var rather than a const so caddy_test.go can point
// it at a stub binary (or a nonexistent path, to exercise the
// missing-binary error envelope) without mutating $PATH.
var caddyBinary = "/usr/bin/caddy"

// maxCaddyConfigBytes is the cap on caller-supplied Caddyfile bodies
// (caddy.adapt, caddy.fmt). 5 MB is far beyond any real Caddyfile;
// the cap exists so a misbehaving or hostile caller can't force the
// agent to allocate or write multi-megabyte tmpfiles.
const maxCaddyConfigBytes = 5 * 1024 * 1024

// runCaddy executes the caddy binary with the supplied argv (no
// shell, no $PATH lookup) and captures stdout/stderr separately.
//
// On non-zero exit it returns whatever the binary printed plus an
// *exec.ExitError so callers can distinguish "caddy ran and rejected
// the input" (structured method result) from "we couldn't run caddy
// at all" (envelope-level error). Tests substitute caddyBinary to
// drive each branch.
func runCaddy(args ...string) (stdout, stderr []byte, err error) {
	cmd := exec.Command(caddyBinary, args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err = cmd.Run()
	return outBuf.Bytes(), errBuf.Bytes(), err
}
