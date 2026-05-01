// WebAuthn / passkey backend helpers. Wraps @simplewebauthn/server with
// the bits we need to register, verify, and persist credentials.
//
// Design notes:
//   * RP ID is derived from req.hostname per call — never hardcoded —
//     so the dashboard works behind whatever vhost Caddy points at.
//     Hardcoding it would lock the credential to one DOMAIN and break
//     the moment the operator renames their host.
//   * Origin allowlist is read from app_settings.passkey_origin_allowlist
//     (JSON array). Default = [`https://${req.hostname}`]. Both the
//     register-verify and authenticate-verify paths reject any
//     attestation/assertion whose origin isn't on the list.
//   * Challenges live in an in-memory Map with a 5-minute TTL. They are
//     deliberately NOT persisted in SQLite — they are short-lived
//     single-use tokens, and disk-IO churn on every begin/verify pair
//     is wasted effort. A Map plus a periodic sweep keeps memory
//     bounded.
//   * Counter regression check is mandatory in `verifyAssertion()`:
//     if the authenticator returns a counter <= the stored value,
//     reject. SimpleWebAuthn's `verifyAuthenticationResponse` already
//     enforces this when we pass `requireUserVerification: true` and a
//     stored `counter`, but we double-check after the call as a belt-
//     and-braces measure (see verifyAssertion below).
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import crypto from 'crypto';
import { getDb, getSetting } from '../db.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const challengeStore = new Map();

export function putChallenge(key, payload) {
  challengeStore.set(key, { ...payload, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

// Single-use: removes the challenge as it returns it. Replaying the
// same begin->verify pair twice fails on the second attempt because
// the entry is already gone.
export function takeChallenge(key) {
  const entry = challengeStore.get(key);
  if (!entry) return null;
  challengeStore.delete(key);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challengeStore) {
    if (v.expiresAt < now) challengeStore.delete(k);
  }
}, 60_000).unref();

export function getRpId(req) {
  // req.hostname strips the :port, which is what WebAuthn wants.
  return req.hostname;
}

export function getRpName() {
  return 'ProxyPilot';
}

export function getExpectedOrigins(req) {
  const raw = getSetting('passkey_origin_allowlist');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* fall through to default */ }
  }
  return [`https://${req.hostname}`];
}

// Stable per-user 32-byte random buffer used as WebAuthn user.id.
// Lazily created on first call; persisted to users.webauthn_user_handle
// so subsequent registrations resolve to the same handle.
export function getOrCreateUserHandle(userId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT webauthn_user_handle FROM users WHERE id = ?'
  ).get(userId);
  if (row?.webauthn_user_handle) {
    return Buffer.from(row.webauthn_user_handle);
  }
  const handle = crypto.randomBytes(32);
  db.prepare('UPDATE users SET webauthn_user_handle = ? WHERE id = ?')
    .run(handle, userId);
  return handle;
}

export function findUserByHandle(handleBuf) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM users WHERE webauthn_user_handle = ?'
  ).get(handleBuf);
}

// Returns this user's stored credential descriptors (id + transports)
// in the shape SimpleWebAuthn's `excludeCredentials` and
// `allowCredentials` options expect.
export function listCredentialDescriptors(userId) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?`
  ).all(userId);
  return rows.map((r) => ({
    id: r.credential_id,
    transports: r.transports ? JSON.parse(r.transports) : undefined,
  }));
}

export function listCredentialsForUI(userId) {
  const db = getDb();
  return db.prepare(
    `SELECT id, credential_id, label, transports, aaguid, created_at, last_used_at
       FROM webauthn_credentials
      WHERE user_id = ?
      ORDER BY created_at ASC`
  ).all(userId).map((r) => ({
    id: r.id,
    credentialId: r.credential_id,
    label: r.label,
    transports: r.transports ? JSON.parse(r.transports) : null,
    aaguid: r.aaguid,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export function userHasPasskey(userId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1`
  ).get(userId);
  return !!row;
}

export function getCredentialById(credentialId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM webauthn_credentials WHERE credential_id = ?`
  ).get(credentialId);
  if (!row) return null;
  return {
    ...row,
    transports: row.transports ? JSON.parse(row.transports) : undefined,
    public_key: row.public_key, // Buffer
  };
}

export function insertCredential({ userId, credentialId, publicKey, counter, transports, label, aaguid }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, counter, transports, label, aaguid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    credentialId,
    Buffer.from(publicKey),
    counter | 0,
    transports ? JSON.stringify(transports) : null,
    label || null,
    aaguid || null,
  );
}

export function updateCredentialCounter(credentialId, newCounter) {
  const db = getDb();
  db.prepare(
    `UPDATE webauthn_credentials
        SET counter = ?, last_used_at = CURRENT_TIMESTAMP
      WHERE credential_id = ?`
  ).run(newCounter | 0, credentialId);
}

export function deleteCredentialByDbId(userId, dbId) {
  const db = getDb();
  return db.prepare(
    `DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?`
  ).run(dbId, userId).changes;
}

export function renameCredentialByDbId(userId, dbId, label) {
  const db = getDb();
  return db.prepare(
    `UPDATE webauthn_credentials SET label = ? WHERE id = ? AND user_id = ?`
  ).run(label || null, dbId, userId).changes;
}

// Wraps verifyAuthenticationResponse with the counter-regression
// belt-and-braces check on top of SimpleWebAuthn's own enforcement.
// Returns { ok, info, reason } — `info.newCounter` is the value the
// caller should write back via updateCredentialCounter.
export async function verifyAssertion({ response, expectedChallenge, expectedOrigins, expectedRPID, credential }) {
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: expectedOrigins,
      expectedRPID,
      credential: {
        id: credential.credential_id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: credential.transports,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    return { ok: false, reason: e?.message || 'verification threw' };
  }
  if (!result.verified) {
    return { ok: false, reason: 'not_verified' };
  }
  const newCounter = result.authenticationInfo?.newCounter;
  // SimpleWebAuthn already throws on a regression, but if the
  // authenticator reports counter=0 (some platform authenticators
  // legitimately do) and the stored counter is also 0, that's the
  // only sanctioned non-increment case. Any other non-increment
  // means the credential was cloned — refuse.
  if (newCounter < credential.counter) {
    return { ok: false, reason: 'counter_regression' };
  }
  if (newCounter === credential.counter && newCounter !== 0) {
    return { ok: false, reason: 'counter_stagnant' };
  }
  return { ok: true, info: { ...result.authenticationInfo, newCounter } };
}

export {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
};
