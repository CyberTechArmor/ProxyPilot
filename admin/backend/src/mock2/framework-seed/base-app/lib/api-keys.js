'use strict';
/* ---------------------------------------------------------------------------
   API keys — machine credentials for other applications.

   The whole app is reachable over HTTP already; what was missing was a way for
   a NON-BROWSER caller to authenticate. Sessions are cookie-based, rotate, and
   are bound to a human sign-in — none of which a service integration can use.

   Design decisions worth knowing:

   1. **Keys carry PERMISSIONS from the same RBAC catalog as people.** There is
      no parallel "scope" vocabulary to drift out of sync: a key that may read
      users holds `users.view`, exactly as a role does. Every existing
      requirePerm() check therefore covers key callers for free — a route
      cannot accidentally be open to machines but closed to humans.

   2. **A key can never exceed its issuer.** Permissions are intersected with
      what the issuing user actually had at creation time. Otherwise any
      account able to mint keys could mint itself an admin one.

   3. **The secret is shown exactly once.** Only a SHA-256 hash is stored, so a
      database dump does not yield working credentials. A lost key is rotated,
      not recovered.

   4. **The prefix is public, the secret is not.** `ud_live_<prefix>.<secret>` —
      the prefix identifies the row for a fast, indexed lookup, and the secret
      is compared in constant time. Without a prefix, verifying a key means
      hashing the candidate against every row.
   --------------------------------------------------------------------------- */
const crypto = require('crypto');
const store = require('./store');
const rbac = require('./rbac');
const users = require('./users');
const { uuid, timingSafeEqStr } = require('./util');

const TOKEN_PREFIX = 'ud';
const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;
const MAX_KEYS = 100;

function index() {
  const db = store.get();
  if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
  return db.apiKeys;
}

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }

// ud_live_<prefix>.<secret> — prefix indexes the row, secret authenticates it.
function mint() {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { prefix, secret, token: `${TOKEN_PREFIX}_live_${prefix}.${secret}` };
}

function parseToken(token) {
  const s = String(token || '');
  const m = s.match(/^([a-z]+)_live_([0-9a-f]+)\.([A-Za-z0-9_-]+)$/);
  if (!m || m[1] !== TOKEN_PREFIX) return null;
  return { prefix: m[2], secret: m[3] };
}

// The public shape. NEVER includes token_hash, and never the secret — the only
// time a caller sees the secret is the create response.
function publicShape(k) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    permissions: (k.permissions || []).slice(),
    userId: k.userId || null,
    active: k.active !== false,
    expiresAt: k.expiresAt || null,
    lastUsedAt: k.lastUsedAt || null,
    createdBy: k.createdBy || null,
    createdAt: k.createdAt || null,
    revokedAt: k.revokedAt || null,
  };
}

function list() { return index().map(publicShape); }
function get(id) { const k = index().find((x) => x.id === id); return k ? publicShape(k) : null; }

/* --------------------------------- create -------------------------------- */

// issuer is the acting USER. The key's permissions are intersected with theirs,
// so an issuer can only ever delegate a subset of what they already hold.
function create({ name, permissions, expiresAt = null, issuer }) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) { const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'A name is required.'; throw e; }
  if (index().filter((k) => k.active !== false).length >= MAX_KEYS) {
    const e = new Error('TOO_MANY'); e.code = 'TOO_MANY'; e.detail = `At most ${MAX_KEYS} active keys.`; throw e;
  }

  const requested = Array.isArray(permissions) ? permissions.map(String) : [];
  const known = new Set(rbac.ALL);
  const unknown = requested.filter((p) => !known.has(p));
  if (unknown.length) {
    const e = new Error('VALIDATION'); e.code = 'VALIDATION';
    e.detail = `Unknown permission${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`;
    throw e;
  }

  // PRIVILEGE CEILING. Without this, anyone who may create a key could create
  // one carrying permissions they do not have and then use it — a complete
  // bypass of the permission model.
  const issuerPerms = new Set(rbac.effectivePermissions(issuer?.roles || []));
  const granted = requested.filter((p) => issuerPerms.has(p));
  const refused = requested.filter((p) => !issuerPerms.has(p));
  if (refused.length) {
    const e = new Error('FORBIDDEN'); e.code = 'FORBIDDEN';
    e.detail = `You cannot grant a key permissions you do not hold: ${refused.join(', ')}.`;
    throw e;
  }
  if (!granted.length) {
    const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'A key needs at least one permission.'; throw e;
  }

  let expiry = null;
  if (expiresAt) {
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) { const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'expiresAt must be a date.'; throw e; }
    if (t.getTime() <= Date.now()) { const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'expiresAt must be in the future.'; throw e; }
    expiry = t.toISOString();
  }

  const { prefix, secret, token } = mint();
  const rec = {
    id: uuid(),
    name: clean,
    prefix,
    tokenHash: sha256(secret),
    // The key ACTS AS its issuer for ownership questions (whose documents are
    // "mine"), but is still limited by its own permission list.
    userId: issuer?.id || null,
    permissions: granted,
    active: true,
    expiresAt: expiry,
    lastUsedAt: null,
    createdBy: issuer?.username || null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  index().push(rec);
  store.save('apiKeys');
  // The ONLY time the token exists outside the caller's hands.
  return { key: publicShape(rec), token };
}

function revoke(id) {
  const k = index().find((x) => x.id === id);
  if (!k) return null;
  k.active = false;
  k.revokedAt = new Date().toISOString();
  // The hash is cleared too: a revoked row should not carry material that could
  // ever be re-activated by editing a boolean.
  k.tokenHash = null;
  store.save('apiKeys');
  return publicShape(k);
}

function remove(id) {
  const list_ = index();
  const i = list_.findIndex((x) => x.id === id);
  if (i === -1) return null;
  const [gone] = list_.splice(i, 1);
  store.save('apiKeys');
  return publicShape(gone);
}

/* -------------------------------- verify --------------------------------- */

// verify(token) → { ok, key, user, permissions } | { ok:false, code }
// Deliberately vague on failure: a caller learns "this did not work", never
// which part of it was wrong.
function verify(token) {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, code: 'INVALID_KEY' };
  const k = index().find((x) => x.prefix === parsed.prefix);
  if (!k || k.active === false || !k.tokenHash) return { ok: false, code: 'INVALID_KEY' };
  if (!timingSafeEqStr(sha256(parsed.secret), k.tokenHash)) return { ok: false, code: 'INVALID_KEY' };
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return { ok: false, code: 'KEY_EXPIRED' };

  // The key's permissions are re-intersected with its OWNER's CURRENT
  // permissions on every request. Deactivating a person, or removing a role,
  // must take their keys down with them — otherwise revoking access to someone
  // who has left leaves their integrations running.
  const user = k.userId ? users.findById(k.userId) : null;
  if (k.userId) {
    if (!user || !user.active || user.deleted) return { ok: false, code: 'KEY_OWNER_INACTIVE' };
    const live = new Set(rbac.effectivePermissions(user.roles || []));
    const effective = (k.permissions || []).filter((p) => live.has(p));
    if (!effective.length) return { ok: false, code: 'KEY_NO_PERMISSIONS' };
    return { ok: true, key: k, user, permissions: effective };
  }
  return { ok: true, key: k, user: null, permissions: (k.permissions || []).slice() };
}

// Touch last-used. Throttled to a minute: a busy integration would otherwise
// turn every read into a database write.
const TOUCH_MS = 60000;
function touch(k) {
  const now = Date.now();
  const last = k.lastUsedAt ? new Date(k.lastUsedAt).getTime() : 0;
  if (now - last < TOUCH_MS) return;
  k.lastUsedAt = new Date(now).toISOString();
  store.save('apiKeys');
}

// Extract a bearer token from a request. Authorization is the standard; the
// X-API-Key header is accepted because a lot of BI/automation tooling can set a
// custom header but not an Authorization one.
function tokenFromRequest(req) {
  const auth = req.headers['authorization'];
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const x = req.headers['x-api-key'];
  if (x) return String(x).trim();
  return null;
}

module.exports = {
  create, revoke, remove, list, get, verify, touch, tokenFromRequest,
  publicShape, parseToken, MAX_KEYS, TOKEN_PREFIX,
};
