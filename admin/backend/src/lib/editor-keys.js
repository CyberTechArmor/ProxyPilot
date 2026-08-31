// Delegated editing — the store.
//
// Everything here touches the SQLite database (better-sqlite3), which is why
// it is separate from lib/editor-keys-logic.js: the containment rules that
// actually keep a delegated session inside its docroot are pure and are tested
// without a database behind them.
//
// Two records, deliberately:
//
//   ACTIVATION (one per container) — the admin's switch and the single
//   editable root. Turning it off suspends every key for that container at
//   once, and is reversible. Changing the docroot applies to the next request
//   on every key, because the endpoint reads it per request and caches nothing.
//
//   KEY (many per container) — a bearer secret pinned to one container at
//   creation. Only the sha256 hash is stored. Revocation sets a timestamp and
//   nothing ever clears it: a revoked key stays in the list as the record that
//   it existed.
//
// There is deliberately no cache anywhere in this file. Every lookup goes to
// the database, so revoking a key or flipping the toggle takes effect on the
// very next request rather than whenever something expires.

import { getDb, logAudit } from '../db.js';
import {
  mintEditorToken, hashEditorToken, editorTokenDisplayPrefix, validDocroot,
} from './editor-keys-logic.js';

const nowIso = () => new Date().toISOString();

// ---- activations ----

export function getActivation(containerName) {
  try {
    return getDb()
      .prepare(`SELECT * FROM lxc_editor_activations WHERE container_name = ?`)
      .get(String(containerName)) || null;
  } catch { return null; }        // pre-migration
}

export function listActivations() {
  try {
    return getDb().prepare(`SELECT * FROM lxc_editor_activations ORDER BY container_name`).all();
  } catch { return []; }
}

/**
 * Turn delegated editing on (or off) for a container.
 *
 * A docroot is mandatory to activate — there is no "on with no root yet"
 * state, because that state would either mean the whole filesystem or mean
 * nothing, and both are worse than refusing.
 */
export function setActivation({ containerName, docroot, active, createdBy }) {
  const name = String(containerName);
  const existing = getActivation(name);
  const root = docroot === undefined ? existing?.docroot : validDocroot(docroot);
  if (active && !root) {
    return { error: 'An editable directory is required to activate delegated editing (an absolute path at least one level deep, e.g. /var/www/html).' };
  }
  if (docroot !== undefined && !root) {
    return { error: 'The editable directory must be an absolute path at least one level deep — "/" itself is not allowed.' };
  }
  const t = nowIso();
  const db = getDb();
  if (existing) {
    db.prepare(`UPDATE lxc_editor_activations SET docroot = ?, active = ?, updated_at = ? WHERE container_name = ?`)
      .run(root, active ? 1 : 0, t, name);
  } else {
    db.prepare(`
      INSERT INTO lxc_editor_activations (container_name, docroot, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, root, active ? 1 : 0, createdBy ? String(createdBy) : null, t, t);
  }
  return { activation: getActivation(name) };
}

// ---- keys ----

/**
 * Mint a key for one container. The plaintext token is returned here and
 * nowhere else, ever — the caller shows it once and forgets it.
 *
 * The container's existence is checked by the CALLER against the live host
 * (this module cannot run incus), which is why containerName arrives already
 * verified.
 */
export function createEditorKey({ containerName, label, createdBy }) {
  const token = mintEditorToken();
  const t = nowIso();
  const r = getDb().prepare(`
    INSERT INTO lxc_editor_keys
      (scope_type, container_name, label, token_hash, token_prefix, created_by, created_at)
    VALUES ('lxc', ?, ?, ?, ?, ?, ?)
  `).run(
    String(containerName),
    String(label || '').trim().slice(0, 120) || 'Delegated editor',
    hashEditorToken(token),
    editorTokenDisplayPrefix(token),
    createdBy ? String(createdBy) : null,
    t,
  );
  return { token, row: getEditorKey(Number(r.lastInsertRowid)) };
}

export function getEditorKey(id) {
  try {
    return getDb().prepare(`SELECT * FROM lxc_editor_keys WHERE id = ?`).get(Number(id)) || null;
  } catch { return null; }
}

export function listEditorKeys(containerName) {
  try {
    return getDb()
      .prepare(`SELECT * FROM lxc_editor_keys WHERE container_name = ? ORDER BY id DESC`)
      .all(String(containerName));
  } catch { return []; }
}

export function listAllEditorKeys() {
  try {
    return getDb().prepare(`SELECT * FROM lxc_editor_keys ORDER BY id DESC`).all();
  } catch { return []; }
}

/**
 * Look a presented token up by hash.
 *
 * Revoked rows are returned rather than filtered out, so the endpoint can say
 * "revoked" instead of "unknown" — the holder already proved they have the
 * secret, and telling them it was revoked is both truthful and useful. The
 * endpoint is what refuses.
 */
export function findEditorKeyByToken(rawToken) {
  if (!rawToken) return null;
  try {
    return getDb()
      .prepare(`SELECT * FROM lxc_editor_keys WHERE token_hash = ?`)
      .get(hashEditorToken(rawToken)) || null;
  } catch { return null; }        // pre-migration
}

export function touchEditorKey(id) {
  try {
    getDb().prepare(`UPDATE lxc_editor_keys SET last_used_at = ? WHERE id = ?`).run(nowIso(), Number(id));
  } catch { /* advisory */ }
}

/** Revocation is permanent: there is no un-revoke, by design. */
export function revokeEditorKey(id) {
  const r = getDb()
    .prepare(`UPDATE lxc_editor_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(nowIso(), Number(id));
  return r.changes > 0;
}

// ---- audit ----
//
// Every delegated call lands in the same audit_log the rest of ProxyPilot
// writes to, so an admin reviewing "what happened to this container" sees
// delegated edits next to their own. user_id is null — there is no ProxyPilot
// user behind a delegated key — and the key id carries the identity instead.
//
// The token never appears here in any form. Only its row id and display prefix.

export function logEditorCall({ key, tool, path, outcome, ip, extra = {} }) {
  try {
    logAudit(null, 'LXC_EDITOR_CALL', 'lxc', String(key.container_name), {
      key_id: key.id,
      key_label: key.label,
      key_prefix: key.token_prefix,
      tool,
      ...(path != null ? { path } : {}),
      outcome,
      ...extra,
    }, ip || null);
  } catch { /* the call itself must not fail because the log did */ }
}

export function logEditorAuthFailure({ reason, prefix, ip }) {
  try {
    logAudit(null, 'LXC_EDITOR_AUTH_FAILED', 'lxc', prefix || 'unknown', { reason }, ip || null);
  } catch { /* advisory */ }
}
