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
    const child = spawnHost(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ code: null, stdout, stderr: stderr + '\n[mock2] host command timed out', timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); finish({ code: null, stdout, stderr: stderr + err.message }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
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
