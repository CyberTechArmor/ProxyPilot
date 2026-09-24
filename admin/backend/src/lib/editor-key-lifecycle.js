import { utcTimestamp } from './utc-time.js';

export const EDITOR_KEY_DAYS = 30;
export const EDITOR_KEY_MAX_DAYS = 90;
export function editorAuthorityError(key, owner, now = Date.now()) {
  if (!owner || owner.role !== 'admin') return 'The issuing administrator is no longer active. Ask an administrator to issue a new key.';
  if (!(utcTimestamp(key?.expires_at) > now)) return 'This delegated editing key has expired. Ask an administrator to issue a new key.';
  return null;
}

export function migrateEditorKeyLifecycle(db) {
  db.exec('ALTER TABLE lxc_editor_keys ADD COLUMN expires_at TEXT');
  // Keep existing attributable credentials working for a finite rotation
  // window. Unattributed/disabled-owner keys fail closed at authentication.
  db.exec("UPDATE lxc_editor_keys SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days') WHERE expires_at IS NULL");
  db.exec('CREATE INDEX IF NOT EXISTS idx_editor_keys_owner ON lxc_editor_keys(created_by)');
}
