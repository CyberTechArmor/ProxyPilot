// Terminal PTY — the PURE argv decisions, kept out of lib/pty.js (which imports
// native node-pty and so cannot be unit-tested in the sandbox).

// The incus argv for a shell into an LXC instance.
//
// `cwd` is a path INSIDE the guest ("Open terminal here" on the Workspace tab),
// so it has to be applied in there: the pty's own cwd option is a HOST path,
// and handing it a guest directory made bash die on the host with
// `chdir(2) failed: No such file or directory` (the first thing the operator
// saw in the new Workspace terminal). A missing guest directory is not fatal —
// the shell just starts in the guest's default cwd. bash when the image has
// it, sh otherwise (Alpine).
export function guestShellArgv({ incusName, mode = 'exec', cwd = null } = {}) {
  if (mode === 'console') return ['console', incusName];
  const dir = typeof cwd === 'string' && cwd.startsWith('/') && !/[\0\n\r]/.test(cwd) ? cwd : null;
  if (!dir) return ['exec', '-t', incusName, '--', 'bash'];
  const script = 'cd "$1" 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';
  return ['exec', '-t', incusName, '--', 'sh', '-c', script, 'sh', dir];
}
