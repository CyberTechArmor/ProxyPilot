import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Render a WireGuard client config as a QR code via `qrencode`. We never
 * pass the config on the command line — it would land in /proc/<pid>/cmdline
 * and shell history. Always pipe via stdin.
 *
 * Two outputs:
 *   - PNG file at <pngPath> (mode 0600), for the operator to scan from
 *     a phone screen if the terminal QR is too small.
 *   - ANSI string returned for printing to the operator's terminal.
 *
 * `qrencode` is part of the `qrencode` apt package and is installed by
 * scripts/install-vpn.sh. If it's missing we throw a clear error pointing
 * at the installer rather than failing inside spawnSync.
 */
function ensureQrencode() {
  const probe = spawnSync('qrencode', ['--version'], { encoding: 'utf-8' });
  if (probe.error && probe.error.code === 'ENOENT') {
    throw new Error(
      '`qrencode` not found in PATH. Re-run scripts/install-vpn.sh (or `apt-get install qrencode`).',
    );
  }
  if (probe.status !== 0 && probe.error) {
    throw new Error(`qrencode probe failed: ${probe.error.message}`);
  }
}

export function renderQrPng(content, pngPath) {
  ensureQrencode();
  const dir = path.dirname(pngPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const r = spawnSync(
    'qrencode',
    ['-t', 'PNG', '-o', pngPath, '-l', 'M'],
    { input: content, encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    const stderr = (r.stderr ?? '').trim();
    throw new Error(`qrencode PNG render failed${stderr ? `: ${stderr}` : ''}`);
  }
  fs.chmodSync(pngPath, 0o600);
}

export function renderQrAnsi(content) {
  ensureQrencode();
  // ANSIUTF8 produces a half-block QR that fits in roughly 25-30 lines for
  // a typical WireGuard config — small enough that mobile cameras can lock
  // on it from a normal terminal window.
  const r = spawnSync(
    'qrencode',
    ['-t', 'ANSIUTF8', '-l', 'M'],
    { input: content, encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    const stderr = (r.stderr ?? '').trim();
    throw new Error(`qrencode ANSI render failed${stderr ? `: ${stderr}` : ''}`);
  }
  return r.stdout ?? '';
}
