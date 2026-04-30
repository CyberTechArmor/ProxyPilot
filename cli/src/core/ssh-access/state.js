import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db/index.js';
import { atomicWrite } from '../vpn/server.js';

export const STATE_DIR = '/var/lib/proxypilot';
export const STATE_FILE = path.join(STATE_DIR, 'ssh-access.json');
export const STATE_VERSION = 1;

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

export function defaultState() {
  return { version: STATE_VERSION, entries: [] };
}

/**
 * SQLite is the source of truth. The JSON file is a human-readable mirror
 * (same dual-write rationale as firewall.json) so the operator can grep
 * /var/lib/proxypilot/ssh-access.json or restore it from git. A
 * read-from-DB shape keeps the JSON byte-stable against identical state.
 */
export function readState() {
  ensureStateDir();
  return rebuildStateFromDb();
}

function rebuildStateFromDb() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, unix_user, public_key, fingerprint, device_label,
           added_at, added_by, revoked_at, revoked_by, revoked_reason,
           last_seen_at
    FROM ssh_access
    ORDER BY unix_user, id
  `).all();
  return {
    version: STATE_VERSION,
    entries: rows.map(r => ({
      id: r.id,
      unix_user: r.unix_user,
      public_key: r.public_key,
      fingerprint: r.fingerprint,
      device_label: r.device_label,
      added_at: r.added_at,
      added_by: r.added_by,
      revoked_at: r.revoked_at,
      revoked_by: r.revoked_by,
      revoked_reason: r.revoked_reason,
      last_seen_at: r.last_seen_at,
    })),
  };
}

/**
 * Re-render ssh-access.json from the current SQLite state. Mode 0600 —
 * pubkeys aren't secret, but the file lives next to firewall.json which
 * IS, so the consistent strict perms make audit scans easier. Atomic
 * write via the shared helper from cli/src/core/vpn/server.js.
 */
export function writeStateFromDb() {
  ensureStateDir();
  const state = rebuildStateFromDb();
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 0o600);
  return state;
}

/**
 * Active rows are the subset reconcile uses to render authorized_keys.
 * Revoked rows stay in the DB / JSON for audit.
 */
export function activeEntries() {
  const db = getDb();
  return db.prepare(`
    SELECT id, unix_user, public_key, fingerprint, device_label,
           added_at, added_by, last_seen_at
    FROM ssh_access
    WHERE revoked_at IS NULL
    ORDER BY unix_user, id
  `).all();
}
