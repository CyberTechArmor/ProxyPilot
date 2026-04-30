import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { audit } from '../../db/audit.js';
import { atomicWrite } from '../vpn/server.js';
import { activeEntries, readState } from './state.js';

const MARKER_PREFIX = '# proxypilot:';

/**
 * Resolve a unix user to { uid, gid, home }. Tries os.userInfo(name)
 * first, falls back to `getent passwd <name>` so users that aren't the
 * current process owner still resolve. Throws with a clear error when
 * the user doesn't exist on the host (operator typo'd unix_user).
 */
function resolveUser(unixUser) {
  if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(unixUser)) {
    throw new Error(`invalid unix_user "${unixUser}"`);
  }
  try {
    const info = os.userInfo({ encoding: 'utf-8' });
    if (info.username === unixUser) {
      return { uid: info.uid, gid: info.gid, home: info.homedir };
    }
  } catch { /* fall through */ }
  const r = spawnSync('getent', ['passwd', unixUser], { encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`unix user "${unixUser}" not found on this host (getent passwd returned no row)`);
  }
  // passwd format: name:x:uid:gid:gecos:home:shell
  const parts = r.stdout.trim().split(':');
  if (parts.length < 7) {
    throw new Error(`malformed getent passwd output for "${unixUser}"`);
  }
  return { uid: Number(parts[2]), gid: Number(parts[3]), home: parts[5] };
}

/**
 * Split the existing authorized_keys into (operator-added lines,
 * proxypilot-managed lines). A line is "managed" if its trailing
 * comment matches `# proxypilot:<id>`. The strip MUST be conservative —
 * any other line (including blanks and operator comments) is preserved
 * verbatim so the operator's manual fallback key always survives a
 * reconcile.
 */
function partitionExisting(text) {
  const lines = text.split('\n');
  // Drop the trailing empty fragment from a trailing newline so the
  // re-render doesn't accumulate blank lines on every reconcile.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const operator = [];
  for (const line of lines) {
    if (isProxypilotManagedLine(line)) continue;
    operator.push(line);
  }
  return operator;
}

function isProxypilotManagedLine(line) {
  // Match a trailing `# proxypilot:<id>` comment (possibly preceded by
  // whitespace). Conservative: an operator who manually added the same
  // marker has already opted into the managed-line semantics.
  return /\s#\s*proxypilot:[A-Za-z0-9][A-Za-z0-9._-]*\s*$/.test(line);
}

/**
 * One pubkey is one line: `<key> # proxypilot:<id>`. The trailing marker
 * is the contract reconcile uses to find/replace this line on the next
 * run. public_key is stored normalized (no embedded newlines) at insert
 * time, so we just trim trailing whitespace before appending the marker.
 */
function renderManagedLine(entry) {
  const key = entry.public_key.replace(/\s+$/, '');
  return `${key} ${MARKER_PREFIX}${entry.id}`;
}

/**
 * Plan the rewrite for one unix user. Returns the new file body plus
 * before/after counts for the audit row. Pure function — no fs writes.
 */
function planUser(unixUser, entries, existingText) {
  const operatorLines = partitionExisting(existingText);
  const managed = entries
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(renderManagedLine);
  const beforeManagedCount = existingText
    .split('\n')
    .filter(isProxypilotManagedLine).length;
  const newLines = [...operatorLines, ...managed];
  const body = newLines.join('\n') + (newLines.length > 0 ? '\n' : '');
  return {
    unix_user: unixUser,
    body,
    before_managed_count: beforeManagedCount,
    after_managed_count: managed.length,
    operator_line_count: operatorLines.filter(l => l.trim() !== '' && !l.trim().startsWith('#')).length,
  };
}

function readExisting(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Rewrite ~/.ssh/authorized_keys for every distinct unix_user that
 * appears in the active ssh_access set, OR that previously had a
 * managed line and now has none (so revokes converge to an empty
 * managed section even though the user has zero active rows).
 *
 * Strategy per user:
 *   1. Read existing authorized_keys.
 *   2. Drop every line ending `# proxypilot:<id>`.
 *   3. Append one managed line per active entry, sorted by id.
 *   4. Atomic-write (.tmp + chmod 0600 + rename) and chown to uid:gid.
 *
 * Operator-added lines (no marker) survive untouched. Determinism:
 * identical state ⇒ byte-identical authorized_keys (sort by id;
 * empty trailing newline normalized).
 *
 * `dryRun: true` plans but never touches disk; used by
 * `proxypilot ssh access reconcile --dry-run`.
 *
 * Audit: one ssh-access.reconcile row per user actually rewritten.
 * dryRun does not audit.
 */
export async function reconcile({ dryRun = false, actor } = {}) {
  // Build the unix_user → entries grouping from the SQLite source.
  const active = activeEntries();
  const byUser = new Map();
  for (const e of active) {
    if (!byUser.has(e.unix_user)) byUser.set(e.unix_user, []);
    byUser.get(e.unix_user).push(e);
  }

  // Also pick up users that have NO active rows but previously had a
  // managed line — those need a rewrite to drop the now-revoked line.
  // We discover them by scanning the JSON state's entries (revoked rows
  // included) for users absent from `byUser`.
  const fullState = readState();
  const allUsers = new Set(fullState.entries.map(e => e.unix_user));
  for (const u of allUsers) {
    if (!byUser.has(u)) byUser.set(u, []);
  }

  const users = [];
  const warnings = [];
  for (const [unixUser, entries] of byUser) {
    let resolved;
    try {
      resolved = resolveUser(unixUser);
    } catch (e) {
      warnings.push({ unix_user: unixUser, message: e.message });
      continue;
    }
    const sshDir = path.join(resolved.home, '.ssh');
    const akPath = path.join(sshDir, 'authorized_keys');
    const existing = readExisting(akPath);
    const plan = planUser(unixUser, entries, existing);

    // Skip a no-op rewrite: identical bytes means no chmod / chown
    // churn and no audit row.
    if (existing === plan.body) {
      users.push({
        user: unixUser,
        before_count: plan.before_managed_count,
        after_count: plan.after_managed_count,
        changed: false,
      });
      continue;
    }

    if (dryRun) {
      users.push({
        user: unixUser,
        before_count: plan.before_managed_count,
        after_count: plan.after_managed_count,
        changed: true,
        path: akPath,
      });
      continue;
    }

    // Ensure ~/.ssh exists with the right perms before atomicWrite.
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
      try { fs.chownSync(sshDir, resolved.uid, resolved.gid); } catch { /* best-effort */ }
    }
    atomicWrite(akPath, plan.body, 0o600);
    // chown after rename so the post-rename file lands owned by the
    // unix user, not by root (which would silently break sshd's
    // strict-mode permission check).
    try {
      fs.chownSync(akPath, resolved.uid, resolved.gid);
    } catch (e) {
      warnings.push({
        unix_user: unixUser,
        message: `chown ${akPath} to ${resolved.uid}:${resolved.gid} failed: ${e.message}`,
      });
    }

    audit({
      subsystem: 'ssh-access',
      action: 'ssh-access.reconcile',
      resource: unixUser,
      actor,
      before: { managed_count: plan.before_managed_count },
      after: { managed_count: plan.after_managed_count, operator_lines: plan.operator_line_count },
    });

    users.push({
      user: unixUser,
      before_count: plan.before_managed_count,
      after_count: plan.after_managed_count,
      changed: true,
      path: akPath,
    });
  }

  return { applied: !dryRun, users, warnings };
}

/**
 * Lockout-safety check for the revoke / remove paths. Inspects the
 * authorized_keys file the operator-added (non-managed) line would
 * survive after this revoke takes effect. Returns:
 *   - { fallbacks: [<line preview>], remainingManaged: <n> }
 *
 * The CLI uses `fallbacks.length === 0 && remainingManaged === 0` to
 * decide whether to refuse without --force + typed phrase. A non-empty
 * fallback list means the operator has another way in (e.g. a sealed
 * recovery key pasted in directly), so a warning is enough.
 */
export function inspectFallbacks({ unixUser, idBeingRevoked }) {
  const resolved = resolveUser(unixUser);
  const akPath = path.join(resolved.home, '.ssh', 'authorized_keys');
  const text = readExisting(akPath);
  const fallbacks = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (isProxypilotManagedLine(line)) continue;
    fallbacks.push(line.length > 80 ? line.slice(0, 77) + '...' : line);
  }
  // After this revoke lands, every managed line whose id !== idBeingRevoked
  // continues to grant access. Count those.
  const remainingManaged = activeEntries()
    .filter(e => e.unix_user === unixUser && e.id !== idBeingRevoked)
    .length;
  return { fallbacks, remainingManaged };
}
