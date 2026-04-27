// Symmetric encryption for sensitive DB columns (TOTP secrets today,
// other values in future phases). AES-256-GCM with a key derived from
// the TOTP_ENCRYPTION_KEY env var (32 bytes hex).
//
// Wire format: `enc:v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>`
// Anything not starting with `enc:v1:` is treated as plaintext for
// backwards compatibility with installs that pre-date this module —
// migrateUnencryptedTotpSecrets() upgrades them on the next boot.
//
// Key rotation is out of scope for this version. If the key is lost,
// every encrypted secret is unrecoverable; document this loudly in the
// .env.example.

import crypto from 'crypto';

const ALG = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw || raw === 'CHANGE_ME_64_HEX_CHARS') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TOTP_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` and add it to .env. ' +
          'Refusing to boot in production without an at-rest key.'
      );
    }
    // In dev, fall back to a deterministic dev-only key so the server
    // can boot without configuration. Logged loudly so it cannot
    // accidentally ship — production guards above prevent that.
    console.warn(
      '[secrets] TOTP_ENCRYPTION_KEY not set — using DEV-ONLY fallback. NEVER use this in production.'
    );
    cachedKey = crypto.createHash('sha256').update('proxypilot-dev-only').digest();
    return cachedKey;
  }
  if (raw.length !== KEY_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      `TOTP_ENCRYPTION_KEY must be exactly ${KEY_BYTES * 2} hex characters (got ${raw.length}).`
    );
  }
  cachedKey = Buffer.from(raw, 'hex');
  return cachedKey;
}

// Eager startup guard. initDatabase() calls this so the server crashes
// loud at boot in production if TOTP_ENCRYPTION_KEY is missing rather
// than continuing until the next TOTP write tries to use it.
export function assertEncryptionKey() {
  loadKey();
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext) {
  if (plaintext == null) return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // double-encrypt guard
  const key = loadKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptSecret(value) {
  if (value == null) return value;
  if (!isEncrypted(value)) return value; // legacy plaintext
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret');
  }
  const [ivHex, tagHex, ctHex] = parts;
  const key = loadKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// One-shot migration: re-write every plaintext totp_secret to encrypted
// form. Idempotent (already-encrypted rows are skipped). Logs the
// number of rows it touched. Intended to be called as a versioned
// migration via runMigration().
export function migrateUnencryptedTotpSecrets(db) {
  const rows = db
    .prepare(`SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL`)
    .all();
  let migrated = 0;
  const update = db.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`);
  for (const row of rows) {
    if (isEncrypted(row.totp_secret)) continue;
    if (!row.totp_secret) continue;
    update.run(encryptSecret(row.totp_secret), row.id);
    migrated += 1;
  }
  if (migrated > 0) {
    console.log(`Encrypted ${migrated} legacy plaintext TOTP secret(s) at rest`);
  }
}
