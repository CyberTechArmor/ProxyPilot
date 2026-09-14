// LXC workspace (the Flightdeck file/editor/preview/terminal surface on a
// container's dialog) — PURE decision layer. Native-free and unit-tested
// stub-first: nothing here opens a DB, touches Incus or the network. The route
// layer (routes/lxc-workspace.js) does the container I/O.
//
// Flightdeck's file API is rooted at one fixed directory (/srv/app in a project
// container). An operator's LXC has no such convention — the app may live in
// /opt/app, /var/www, /srv/whatever — so the workspace carries an explicit,
// operator-chosen ABSOLUTE root, and every file path is relative to it. The
// tree/parse/language helpers are shared with Flightdeck (mock2/flightdeck-logic);
// this module owns what is LXC-specific: the root, and the root+relative join.

import { safeRelPath } from '../mock2/flightdeck-logic.js';

// Candidate roots, in order, when the operator has not chosen one and no
// startup unit names a working directory. /opt/app is where apply_lxc_zip and
// the zip upload extract by default; /srv/app is the Mock2 convention; /root
// always exists, so the tree is never empty on a fresh container.
export const DEFAULT_ROOT_CANDIDATES = Object.freeze(['/opt/app', '/srv/app', '/var/www', '/root']);
export const FALLBACK_ROOT = '/root';

// An absolute directory path inside the guest, or null. Executed via argv (never
// interpolated into a shell string), so spaces are fine — only control chars,
// traversal dots and a relative spelling are refused. Trailing slashes are
// stripped; "/" stays "/".
export function validAbsDir(p) {
  const s = String(p ?? '').trim();
  if (!s.startsWith('/') || s.split('/').includes('..') || /[\u0000-\u001f\u007f]/.test(s)) return null;
  const out = s.replace(/\/+$/, '');
  return out || '/';
}

// root + relative → absolute path inside the guest, or null when either part is
// unsafe. The relative part goes through Flightdeck's ONE traversal guard.
// rel '.' (the root itself) is only meaningful for the tree, so callers that
// need a file pass allowRoot=false (the default) and get null for it.
export function joinWorkspacePath(root, rel, { allowRoot = false } = {}) {
  const base = validAbsDir(root);
  if (!base) return null;
  const clean = safeRelPath(rel);
  if (!clean) return null;
  if (clean === '.') return allowRoot ? base : null;
  return base === '/' ? `/${clean}` : `${base}/${clean}`;
}

// Which root to open when the operator has not picked one. The registered
// startup unit's working directory wins (that is where the app lives, by the
// operator's own declaration); otherwise the first candidate that exists in the
// guest; otherwise /root. `existing` is the set of candidate paths the guest
// reported as directories.
export function pickDefaultRoot({ startupWorkingDir = null, existing = [] } = {}) {
  const fromStartup = startupWorkingDir ? validAbsDir(startupWorkingDir) : null;
  if (fromStartup) return fromStartup;
  const have = new Set((existing || []).map((p) => validAbsDir(p)).filter(Boolean));
  for (const c of DEFAULT_ROOT_CANDIDATES) if (have.has(c)) return c;
  return FALLBACK_ROOT;
}

// The one-line probe that tells us which candidates exist: prints each
// candidate that is a directory, one per line. Pure string; the route runs it.
export function buildRootProbeScript(candidates = DEFAULT_ROOT_CANDIDATES) {
  return candidates.map((c) => `[ -d '${c}' ] && echo '${c}'`).join('; ') + '; true';
}

// Parse the probe's stdout back into the list of existing directories.
export function parseRootProbeOutput(stdout) {
  return String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
}
