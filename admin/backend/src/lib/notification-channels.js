// Notification-channel store (DB + secret handling).
//
// One row per kind ('smtp' | 'sms') in the notification_channels table. The
// non-secret config is JSON; the secret (SMTP password / SMS auth token) is
// encrypted at rest with lib/secrets.js. Pure shaping/validation lives in
// notification-logic.js so this module stays a thin persistence layer.

import { getDb } from '../db.js';
import { encryptSecret, decryptSecret } from './secrets.js';
import { CHANNEL_KINDS, validateChannelConfig, publicChannelShape } from './notification-logic.js';

export function getChannelRow(kind) {
  return getDb().prepare('SELECT * FROM notification_channels WHERE kind = ?').get(kind) || null;
}

// The admin-facing list — every kind, always present (unconfigured kinds shape
// as { configured:false }), secret never returned.
export function listChannelsPublic() {
  return CHANNEL_KINDS.map((kind) => publicChannelShape(kind, getChannelRow(kind)));
}

export function getChannelPublic(kind) {
  return publicChannelShape(kind, getChannelRow(kind));
}

// Upsert a channel. `config` is validated + normalised. `secret` semantics:
//   - a non-empty string replaces the stored secret,
//   - null/undefined keeps whatever is stored (so the admin needn't re-enter it),
//   - an empty string clears it.
// Any change nulls the cached test verdict — a new config must be re-tested.
export function upsertChannel(kind, { enabled, config, secret } = {}) {
  if (!CHANNEL_KINDS.includes(kind)) throw new Error(`unknown channel kind ${JSON.stringify(kind)}`);
  const v = validateChannelConfig(kind, config);
  if (!v.ok) return { ok: false, error: v.error };

  const existing = getChannelRow(kind);
  let secretEnc = existing?.secret_enc || null;
  if (secret === '') secretEnc = null;
  else if (typeof secret === 'string' && secret.length > 0) secretEnc = encryptSecret(secret);

  getDb().prepare(`
    INSERT INTO notification_channels (kind, enabled, config_json, secret_enc, test_status, test_error, test_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(kind) DO UPDATE SET
      enabled = excluded.enabled,
      config_json = excluded.config_json,
      secret_enc = excluded.secret_enc,
      test_status = NULL,
      test_error = NULL,
      test_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run(kind, enabled ? 1 : 0, JSON.stringify(v.config), secretEnc);

  return { ok: true, channel: getChannelPublic(kind) };
}

export function deleteChannel(kind) {
  return getDb().prepare('DELETE FROM notification_channels WHERE kind = ?').run(kind).changes > 0;
}

export function recordChannelTest(kind, { ok, error = null } = {}) {
  getDb().prepare(`
    UPDATE notification_channels
    SET test_status = ?, test_error = ?, test_at = CURRENT_TIMESTAMP
    WHERE kind = ?
  `).run(ok ? 'ok' : 'fail', ok ? null : String(error || 'failed').slice(0, 500), kind);
}

// The resolved, ready-to-send view used by the dispatcher: parsed config +
// decrypted secret. Returns null when the kind isn't configured. Only call this
// on the send path — it decrypts the secret.
export function resolveChannel(kind) {
  const row = getChannelRow(kind);
  if (!row) return null;
  let config = {};
  try { config = JSON.parse(row.config_json || '{}'); } catch { config = {}; }
  return {
    kind,
    enabled: Number(row.enabled) === 1,
    config,
    secret: row.secret_enc ? decryptSecret(row.secret_enc) : null,
  };
}

export function enabledChannels() {
  return CHANNEL_KINDS
    .map((kind) => resolveChannel(kind))
    .filter((c) => c && c.enabled);
}
