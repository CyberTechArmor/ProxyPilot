// Migration tokens — the only credential a source host ever holds. Pure:
// minting, parsing and the verification RULES live here; the row they are
// checked against comes from lib/migration/service.js.
//
// Shape:  pmig_<id>_<secret>     id = 12 hex, secret = 32 random bytes b64url
//
// Only sha256(secret) is stored, the way MCP keys and passkeys are, so a
// database copy cannot be replayed against a source host. The token is:
//
//   scoped     — it names ONE migration and authorizes only that migration's
//                agent endpoints (inventory, event, artifact, finish).
//   single-use — the first call CLAIMS it, binding it to that caller. A
//                second claimant is refused even with the right secret, so a
//                token read off a terminal cannot be taken over.
//   ended by USE, not by a clock — it dies when the migration reaches a
//                terminal state, and an operator can revoke it at any moment.
//                A wall-clock TTL is optional (`ttl_seconds`) and off by
//                default: a migration is planned work, and a token that
//                expires while the operator is still reading the inventory
//                buys nothing — the claim binding and the revoke button are
//                what actually limit it.
//
// The agent also pins TLS to the certificate fingerprint carried in the
// bootstrap script, so a token presented to the wrong endpoint never leaves
// the source host.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'pmig';
/** No wall-clock expiry by default: the token ends when the migration does. */
export const DEFAULT_TTL_SECONDS = null;
export const MAX_TTL_SECONDS = 30 * 24 * 3600;
export const MIN_TTL_SECONDS = 300;

const TOKEN_RE = /^pmig_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/**
 * A fresh token. The plaintext is returned ONCE; only the hash is storable.
 * `ttlSeconds` null / 0 / absent → no wall-clock expiry (the default): the
 * token lives until the migration finishes or someone revokes it.
 */
export function mintMigrationToken({ ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now() } = {}) {
  const asked = Number(ttlSeconds);
  const ttl = Number.isFinite(asked) && asked > 0
    ? Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, asked))
    : null;
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}_${id}_${secret}`;
  return {
    token, token_id: id, token_hash: sha256(secret),
    expires_at: ttl ? new Date(now + ttl * 1000).toISOString() : null, ttl_seconds: ttl,
  };
}

/** Split a presented token without touching the database. */
export function parseToken(presented) {
  const m = TOKEN_RE.exec(String(presented || ''));
  return m ? { token_id: m[1], secret: m[2] } : null;
}

function secretMatches(secret, storedHash) {
  const a = Buffer.from(sha256(secret), 'utf8');
  const b = Buffer.from(String(storedHash || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * verifyToken(row, presented, { now, claimant })
 *   row       the migration row: { token_id, token_hash, token_expires_at,
 *             token_claimed_by, token_used_at, status }
 *   claimant  a stable identity for this agent run (the agent's run id; the
 *             source IP alone is not stable behind NAT and not unique in a lab)
 *
 * → { ok: true, first_use } | { error, code }
 */
export function verifyToken(row, presented, { now = Date.now(), claimant = null } = {}) {
  const parsed = parseToken(presented);
  if (!parsed) return { error: 'malformed migration token', code: 'bad_token' };
  if (!row) return { error: 'unknown migration token', code: 'bad_token' };
  if (parsed.token_id !== row.token_id) return { error: 'unknown migration token', code: 'bad_token' };
  if (!secretMatches(parsed.secret, row.token_hash)) return { error: 'unknown migration token', code: 'bad_token' };
  if (row.token_revoked_at) return { error: 'this migration token was revoked', code: 'revoked' };
  if (TERMINAL_STATUSES.includes(row.status)) return { error: `this migration is ${row.status}; its token no longer works`, code: 'finished' };
  // An expiry is optional. No date (or an unparseable one) means the token
  // lives until the migration ends or someone revokes it.
  const exp = Date.parse(row.token_expires_at || '');
  if (Number.isFinite(exp) && now > exp) return { error: 'this migration token has expired — create a new migration to get a fresh command', code: 'expired' };
  const already = row.token_claimed_by || null;
  if (already && claimant && already !== claimant) {
    return { error: 'this migration token has already been claimed by another agent run — tokens are single-use', code: 'claimed' };
  }
  return { ok: true, first_use: !already };
}

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

/**
 * What a token is doing right now, for the operator's list. One of:
 *
 *   unclaimed  minted, never used — this is the one still on someone's
 *              clipboard, and the one worth revoking if it should not be
 *   active     claimed by an agent run, migration still going
 *   spent      the migration reached a terminal state, so the token is dead
 *   revoked    an operator killed it
 *   expired    an optional TTL was set and has passed
 *
 * `usable` is the single question the agent router asks; the rest is for the
 * person reading the table.
 */
export function tokenState(row, { now = Date.now() } = {}) {
  if (!row) return { state: 'unknown', usable: false, reason: 'no such token' };
  const exp = Date.parse(row.token_expires_at || '');
  const expires = Number.isFinite(exp) ? new Date(exp).toISOString() : null;
  const base = {
    token_id: row.token_id,
    claimed: !!row.token_claimed_by,
    claimed_at: row.token_claimed_at || null,
    last_seen_at: row.token_last_seen_at || null,
    source_ip: row.token_source_ip || null,
    expires_at: expires,
    revoked_at: row.token_revoked_at || null,
    revoked_by: row.token_revoked_by || null,
  };
  if (row.token_revoked_at) return { ...base, state: 'revoked', usable: false, reason: `revoked${row.token_revoked_by ? ` by ${row.token_revoked_by}` : ''}` };
  if (TERMINAL_STATUSES.includes(row.status)) return { ...base, state: 'spent', usable: false, reason: `the migration is ${row.status}` };
  if (expires && now > exp) return { ...base, state: 'expired', usable: false, reason: 'the TTL set at creation has passed' };
  if (row.token_claimed_by) return { ...base, state: 'active', usable: true, reason: 'claimed by the agent run that is doing this migration' };
  return { ...base, state: 'unclaimed', usable: true, reason: expires ? `usable until ${expires}, or until the migration ends` : 'usable until the migration ends or it is revoked' };
}

/**
 * The payload the bootstrap script bakes into the source host's command.
 * Everything the agent needs to reach exactly one ProxyPilot and nothing
 * else: where, who, until when, and the certificate it must see.
 */
export function tokenPayload({ baseUrl, token, migrationId, pin, expiresAt }) {
  return {
    url: String(baseUrl || '').replace(/\/+$/, ''),
    token: String(token || ''),
    migration_id: Number(migrationId),
    tls_pin: pin ? String(pin) : null,
    expires_at: expiresAt || null,
  };
}

/** `sha256:<64 hex>` — the form the agent compares a leaf certificate against. */
export function formatPin(hex) {
  const h = String(hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return h.length === 64 ? `sha256:${h}` : null;
}

export function parsePin(pin) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(pin || '').trim());
  return m ? m[1].toLowerCase() : null;
}
