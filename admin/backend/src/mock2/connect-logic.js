// Mock2 QUICK CONNECT pure decision layer — VS Code / git access to a
// project's repository over smart HTTP. Native-free (risk R9): no DB, no
// child processes, no Express; connect.js (the host half) drives these.
//
// The model: the project's bare repo (ADR-006 — the durable source of truth
// the container's working tree clones from) is served over git smart HTTP at
// /api/mock2/git/<projectId>. Auth is a per-user, per-project CONNECT TOKEN
// sent as HTTP Basic (git's native credential mechanism — no cookies, no
// CSRF surface). Fetch/clone needs the viewer role; push needs editor.
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash, randomBytes } from 'node:crypto';

export const CONNECT_TOKEN_PREFIX = 'ppc_';
export const CONNECT_TOKEN_TTL_DAYS = 30;

export const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

// A new plaintext token: recognizable prefix + 160 bits of entropy. Shown to
// the user ONCE; only the sha256 is stored.
export function newConnectToken() {
  return `${CONNECT_TOKEN_PREFIX}${randomBytes(20).toString('hex')}`;
}

// Parse an HTTP Basic Authorization header → { username, password } or null.
// git sends the token as the password (username is informational).
export function parseBasicAuth(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(header || '').trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i === -1) return { username: decoded, password: '' };
  return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

export function isTokenExpired(row, nowMs = 0) {
  if (!row) return true;
  if (row.revoked_at) return true;
  if (row.expires_at && nowMs && Date.parse(row.expires_at) < nowMs) return true;
  return false;
}

// The list/UI shape — NEVER includes the hash.
export function shapeConnectToken(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    label: row.label || null,
    created_at: row.created_at,
    expires_at: row.expires_at || null,
    last_used_at: row.last_used_at || null,
    revoked: !!row.revoked_at,
  };
}

// The clone URL for a project repo (no credentials embedded).
export function cloneUrlFor(origin, projectId) {
  return `${String(origin).replace(/\/+$/, '')}/api/mock2/git/${Number(projectId)}`;
}

// The same URL with Basic credentials embedded — what the one-click VS Code
// deep link uses so the clone starts without a credential prompt.
export function cloneUrlWithCreds(origin, projectId, username, token) {
  const u = new URL(cloneUrlFor(origin, projectId));
  u.username = String(username);
  u.password = String(token);
  return u.toString();
}

// The vscode:// deep link that opens VS Code's clone flow on the URL.
export function vscodeCloneLink(cloneUrl) {
  return `vscode://vscode.git/clone?url=${encodeURIComponent(cloneUrl)}`;
}

// Which git service a smart-HTTP request names, and the role it requires.
// Returns null for anything that isn't one of the two smart-HTTP services.
export function gitServiceFor(service) {
  if (service === 'git-upload-pack') return { service, requiredRole: 'viewer' };
  if (service === 'git-receive-pack') return { service, requiredRole: 'editor' };
  return null;
}

// pkt-line framing for the advertisement header (git's smart-HTTP handshake:
// "001e# service=git-upload-pack\n0000" before the refs).
export function pktLine(s) {
  const len = Buffer.byteLength(s, 'utf8') + 4;
  return `${len.toString(16).padStart(4, '0')}${s}`;
}

// Summarize a pushed range for the chat/change record: "3 commit(s): subject1;
// subject2; …" from `git log --oneline old..new` output.
export function summarizePush(shortlog) {
  const lines = String(shortlog || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'no new commits (refs updated)';
  const subjects = lines.slice(0, 6).map((l) => l.replace(/^[0-9a-f]+\s+/i, ''));
  const more = lines.length > 6 ? ` (+${lines.length - 6} more)` : '';
  return `${lines.length} commit(s): ${subjects.join('; ')}${more}`;
}
