// Mock2 shared host-command runner.
//
// Every Mock2 host mutation pivots through lib/host-exec.js spawnHost (risk R3:
// nsenter when the backend runs inside Docker). provision.js grew its own
// runHost/sh/b64 wrappers in M2; M4 adds three more host-touching modules
// (network.js, firewall.js, egress.js) that need the identical pivot, so the
// wrapper is factored here and imported by all of them — one pivot, one place.
//
// runHost never rejects on a non-zero exit: it resolves { code, stdout, stderr }
// so each caller decides what a non-zero code means (a missing artifact is
// usually success for teardown, a failure for provisioning).
//
// Terminology (risk R7): nothing here is named "agent".

import { spawnHost } from '../lib/host-exec.js';

export function runHost(bin, args, { input = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    // stdin is 'pipe' only when we actually feed input; otherwise 'ignore' so
    // the child gets an EOF stdin from the start. Leaving stdin as an open,
    // never-closed pipe (the previous default) makes some host commands block
    // FOREVER: `incus network create` reads its non-EOF stdin and never returns,
    // so neither 'exit' nor 'close' ever fires and the call dies at the timeout.
    // The equivalent `docker exec` (no -i) works precisely because its stdin is
    // EOF — this matches that. (Confirmed by reproduction: ['pipe',…] hangs,
    // ['ignore',…] returns in ~0.5s.)
    const stdinMode = input != null ? 'pipe' : 'ignore';
    const child = spawnHost(bin, args, { stdio: [stdinMode, 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      // Release the pipe fds. A helper the command spawned may still hold the
      // write end open (see the 'exit' note below), so destroy our read end
      // rather than leak it across many provisions.
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      try { child.stderr?.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ code: null, stdout, stderr: stderr + '\n[mock2] host command timed out', timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    // Destroying the pipes in finish() can emit 'error' on the stream; swallow it.
    child.stdout?.on('error', () => { /* ignore */ });
    child.stderr?.on('error', () => { /* ignore */ });
    child.on('error', (err) => { clearTimeout(timer); finish({ code: null, stdout, stderr: stderr + err.message }); });
    // Resolve when the command PROCESS exits — NOT only when its stdio streams
    // 'close'. Safeguard for a command that leaves a helper alive holding our
    // stdout/stderr pipes (e.g. Incus's dnsmasq for a managed bridge): 'close'
    // would never fire, but 'exit' does. By 'exit' we have the exit code and the
    // command's output; setImmediate lets queued 'data' callbacks flush first.
    child.on('exit', (code) => {
      clearTimeout(timer);
      setImmediate(() => finish({ code, stdout, stderr }));
    });
    if (input != null) {
      try { child.stdin.write(input); child.stdin.end(); } catch { /* ignore */ }
    }
  });
}

// Run a shell one-liner on the host (nsenter-pivoted inside Docker).
export function sh(script, opts) {
  return runHost('sh', ['-c', script], opts);
}

export const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
