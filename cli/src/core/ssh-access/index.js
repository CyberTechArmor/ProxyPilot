import { spawnSync } from 'node:child_process';
import { getDb } from '../../db/index.js';
import { audit } from '../../db/audit.js';
import { writeStateFromDb } from './state.js';
import { reconcile, inspectFallbacks } from './reconcile.js';
import { renderBootstrapScript } from './bootstrap.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}\$?$/;

function nowIso() {
  return new Date().toISOString();
}

function validateId(id) {
  if (!ID_RE.test(id ?? '')) {
    throw new Error(
      `invalid id "${id}": must match ${ID_RE} ` +
      `(letters/digits/dot/underscore/hyphen, max 63 chars, no leading punctuation)`,
    );
  }
}

function validateUnixUser(u) {
  if (!USER_RE.test(u ?? '')) {
    throw new Error(`invalid unix_user "${u}"`);
  }
}

/**
 * Validate an SSH public key by piping it through `ssh-keygen -l -f -`
 * and returning the parsed fingerprint. Rejects on parse failure (so a
 * mangled paste, a private key, or a multi-line file all fail loudly
 * before they ever reach SQLite or authorized_keys). The fingerprint
 * is the SHA256 line ssh-keygen emits, e.g.:
 *   `256 SHA256:abcd... user@host (ED25519)`
 * We keep just the SHA256:... token.
 */
export function validatePubkey(pubkey) {
  if (typeof pubkey !== 'string' || pubkey.length === 0) {
    throw new Error('public key is empty');
  }
  // Reject obvious private-key paste — sshd would skip it but we want a
  // clearer error message at the CLI than "ssh-keygen: parse error".
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(pubkey)) {
    throw new Error('refusing to register a PRIVATE key — paste the public key (the .pub file)');
  }
  // Strip a trailing newline only — the public_key column stores the
  // single-line form authorized_keys expects.
  const normalized = pubkey.replace(/\r/g, '').replace(/\n+$/, '');
  if (normalized.includes('\n')) {
    throw new Error('public key spans multiple lines — only single-line ssh pubkeys are supported');
  }
  const r = spawnSync('ssh-keygen', ['-l', '-f', '-'], {
    encoding: 'utf-8',
    input: normalized + '\n',
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim() || 'ssh-keygen rejected the key';
    throw new Error(`invalid public key: ${err}`);
  }
  const m = (r.stdout || '').match(/\b(SHA256:[A-Za-z0-9+/=]+)\b/);
  if (!m) {
    throw new Error(`could not extract fingerprint from ssh-keygen output: ${r.stdout.trim()}`);
  }
  return { publicKey: normalized, fingerprint: m[1] };
}

function findById(id) {
  return getDb().prepare(`
    SELECT id, unix_user, public_key, fingerprint, device_label,
           added_at, added_by, revoked_at, revoked_by, revoked_reason,
           last_seen_at
    FROM ssh_access WHERE id = ?
  `).get(id);
}

function findByFingerprint(fp) {
  return getDb().prepare('SELECT id, revoked_at FROM ssh_access WHERE fingerprint = ?').get(fp);
}

/**
 * Add a device entry. Validates the pubkey, rejects duplicate id /
 * fingerprint (active or revoked — re-adding a known-bad key forces
 * the operator to mint a fresh keypair), inserts the row, mirrors to
 * JSON, then reconciles. The reconcile rewrite is the single mutation
 * point for authorized_keys.
 */
export async function addEntry({ id, unixUser, pubkey, label = null, actor } = {}) {
  validateId(id);
  validateUnixUser(unixUser);
  const { publicKey, fingerprint } = validatePubkey(pubkey);

  if (findById(id)) {
    throw new Error(`ssh-access id "${id}" already exists — pick a different id`);
  }
  const dupFp = findByFingerprint(fingerprint);
  if (dupFp) {
    const state = dupFp.revoked_at ? 'revoked' : 'active';
    throw new Error(
      `fingerprint ${fingerprint} already registered as id "${dupFp.id}" (${state}). ` +
      `Pick a fresh keypair (running the bootstrap script on the device generates one).`,
    );
  }

  const ts = nowIso();
  getDb().prepare(`
    INSERT INTO ssh_access (id, unix_user, public_key, fingerprint, device_label, added_at, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, unixUser, publicKey, fingerprint, label, ts, actor ?? null);

  writeStateFromDb();

  audit({
    subsystem: 'ssh-access',
    action: 'ssh-access.add',
    resource: id,
    actor,
    after: {
      id, unix_user: unixUser, fingerprint,
      device_label: label, added_at: ts,
    },
  });

  const r = await reconcile({ actor });
  return {
    id,
    unix_user: unixUser,
    fingerprint,
    device_label: label,
    added_at: ts,
    reconcile: r,
  };
}

/**
 * Revoke an entry: stamp revoked_at/by/reason and re-render
 * authorized_keys (which drops the line). Existing SSH sessions stay
 * alive — sshd consults authorized_keys at connect time only.
 *
 * Lockout gate: the CLI / backend layer is responsible for inspecting
 * fallbacks via inspectFallbacks() and either warning or refusing. The
 * core mutation does the SQLite write unconditionally once called, so
 * it can be invoked with `force: true` from a confirmed gate.
 */
export async function revokeEntry({ id, reason = null, actor } = {}) {
  validateId(id);
  const row = findById(id);
  if (!row) throw new Error(`ssh-access id "${id}" not found`);
  if (row.revoked_at) {
    return {
      ok: true,
      alreadyRevoked: true,
      id,
      unix_user: row.unix_user,
      fingerprint: row.fingerprint,
    };
  }

  const ts = nowIso();
  getDb().prepare(`
    UPDATE ssh_access
    SET revoked_at = ?, revoked_by = ?, revoked_reason = ?
    WHERE id = ?
  `).run(ts, actor ?? null, reason, id);

  writeStateFromDb();

  audit({
    subsystem: 'ssh-access',
    action: 'ssh-access.revoke',
    resource: id,
    actor,
    before: { id, unix_user: row.unix_user, fingerprint: row.fingerprint },
    after: { revoked_at: ts, revoked_reason: reason },
  });

  const r = await reconcile({ actor });
  return {
    ok: true,
    id,
    unix_user: row.unix_user,
    fingerprint: row.fingerprint,
    revoked_at: ts,
    revoked_reason: reason,
    reconcile: r,
  };
}

/**
 * Hard-delete an entry. Used when a row was added by accident; revoke
 * is the normal path for a working entry. The audit trail captures the
 * deleted fingerprint in `before` so the row is recoverable from logs.
 */
export async function removeEntry({ id, actor } = {}) {
  validateId(id);
  const row = findById(id);
  if (!row) throw new Error(`ssh-access id "${id}" not found`);

  getDb().prepare('DELETE FROM ssh_access WHERE id = ?').run(id);
  writeStateFromDb();

  audit({
    subsystem: 'ssh-access',
    action: 'ssh-access.remove',
    resource: id,
    actor,
    before: {
      id, unix_user: row.unix_user, fingerprint: row.fingerprint,
      device_label: row.device_label, added_at: row.added_at,
      revoked_at: row.revoked_at, revoked_reason: row.revoked_reason,
    },
  });

  const r = await reconcile({ actor });
  return {
    ok: true,
    id,
    unix_user: row.unix_user,
    fingerprint: row.fingerprint,
    reconcile: r,
  };
}

/**
 * List entries. filter is one of 'all' | 'active' | 'revoked'. Sorted
 * by unix_user then id for deterministic output (matches reconcile's
 * sort order).
 */
export function listEntries({ filter = 'active' } = {}) {
  const where = {
    all: '',
    active: 'WHERE revoked_at IS NULL',
    revoked: 'WHERE revoked_at IS NOT NULL',
  }[filter];
  if (where === undefined) {
    throw new Error(`invalid filter "${filter}": expected all|active|revoked`);
  }
  return getDb().prepare(`
    SELECT id, unix_user, public_key, fingerprint, device_label,
           added_at, added_by, revoked_at, revoked_by, revoked_reason,
           last_seen_at
    FROM ssh_access
    ${where}
    ORDER BY unix_user, id
  `).all();
}

export function showEntry(id) {
  validateId(id);
  const row = findById(id);
  if (!row) throw new Error(`ssh-access id "${id}" not found`);
  return row;
}

export {
  reconcile,
  inspectFallbacks,
  renderBootstrapScript,
};
