'use strict';
const crypto = require('crypto');
const store = require('./store');
const { MASTER_KEY, randomToken, sha256 } = require('./crypto');
const { uuid } = require('./util');

const ACCESS_TTL_MS   = +(process.env.ACCESS_TTL_MS   || 10 * 60 * 1000);   // 10 min
const IDLE_TTL_MS     = +(process.env.IDLE_TTL_MS     || 30 * 60 * 1000);   // 30 min idle
const ABSOLUTE_TTL_MS = +(process.env.ABSOLUTE_TTL_MS || 12 * 60 * 60 * 1000); // 12 h absolute

const ACCESS_COOKIE = 'cp_at';
const REFRESH_COOKIE = 'cp_rt';

function hmac(data) {
  return crypto.createHmac('sha256', MASTER_KEY).update(data).digest('base64url');
}

function signAccess(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function verifyAccess(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(body);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (_) { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function newAccessFor(sid, uid) {
  return signAccess({ sid, uid, iat: Date.now(), exp: Date.now() + ACCESS_TTL_MS });
}

// Create a fresh refresh session (family root).
// SECURITY / housekeeping (fix): sessions were never pruned. Revoked and
// expired rows accumulated forever, and because every mutation rewrites the
// WHOLE JSON database (store.save), that dead weight turned into steady write
// amplification on the request path — the file only ever grew. Resets already
// had a prune(); sessions now do too.
//
// Retention keeps recently-revoked rows briefly so reuse-detection can still
// recognise a stolen token's family instead of treating it as unknown.
const PRUNE_GRACE_MS = +(process.env.SESSION_PRUNE_GRACE_MS || 24 * 60 * 60 * 1000);

function prune(db) {
  const now = Date.now();
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => {
    const dead = s.revoked || now > s.absoluteExpiry || now > s.idleExpiry;
    if (!dead) return true;
    // Keep a dead row only while it is still useful for reuse detection.
    const settledAt = s.revokedAt || s.absoluteExpiry || s.idleExpiry || s.createdAt || 0;
    return now - settledAt < PRUNE_GRACE_MS;
  });
  return before - db.sessions.length;
}

function createSession(user, req) {
  const db = store.get();
  // Prune on creation and on rotation — the two moments a session table
  // naturally changes — so no timer is needed and the cost is amortised.
  prune(db);
  const sid = uuid();
  const familyId = uuid();
  const secret = randomToken(32);
  const now = Date.now();
  db.sessions.push({
    id: sid,
    familyId,
    userId: user.id,
    refreshHash: sha256(secret),
    createdAt: now,
    lastUsedAt: now,
    absoluteExpiry: now + ABSOLUTE_TTL_MS,
    idleExpiry: now + IDLE_TTL_MS,
    userAgent: (req && req.headers['user-agent'] || '').slice(0, 256),
    revoked: false,
    rotatedTo: null
  });
  store.save();
  return {
    sid,
    accessToken: newAccessFor(sid, user.id),
    refreshToken: `${sid}.${secret}`
  };
}

function getSession(sid) { return store.get().sessions.find(s => s.id === sid) || null; }

function revokeSession(sid, reason = 'revoked') {
  const s = getSession(sid);
  if (s && !s.revoked) { s.revoked = true; s.revokedReason = reason; s.revokedAt = Date.now(); store.save(); }
}

function revokeAllForUser(userId, reason = 'user_revoke') {
  const db = store.get();
  let n = 0;
  for (const s of db.sessions) if (s.userId === userId && !s.revoked) { s.revoked = true; s.revokedReason = reason; s.revokedAt = Date.now(); n++; }
  if (n) store.save();
  return n;
}

// Concurrency-safe rotation locks keyed by sid.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.finally(() => { if (locks.get(key) === next) locks.delete(key); }));
  return next;
}

// Rotate a refresh token. Returns {ok, accessToken, refreshToken} or {error}.
function rotate(refreshCookie, req) {
  // Amortised pruning: rotation is the other moment the session table changes.
  try { const d = store.get(); if (d && Array.isArray(d.sessions)) prune(d); } catch (_) {}
  if (!refreshCookie || typeof refreshCookie !== 'string' || refreshCookie.indexOf('.') < 0)
    return Promise.resolve({ error: 'NO_REFRESH' });
  const dot = refreshCookie.indexOf('.');
  const sid = refreshCookie.slice(0, dot);
  const secret = refreshCookie.slice(dot + 1);
  return withLock(sid, () => {
    const s = getSession(sid);
    const now = Date.now();
    if (!s) return { error: 'INVALID_REFRESH' };
    if (s.revoked) return { error: 'REVOKED' };
    if (now > s.absoluteExpiry) { revokeSession(sid, 'absolute_expiry'); return { error: 'EXPIRED_ABSOLUTE' }; }
    if (now > s.idleExpiry) { revokeSession(sid, 'idle_expiry'); return { error: 'EXPIRED_IDLE' }; }
    if (sha256(secret) !== s.refreshHash) {
      // Token reuse / theft: revoke whole family.
      const db = store.get();
      for (const other of db.sessions) if (other.familyId === s.familyId && !other.revoked) { other.revoked = true; other.revokedReason = 'reuse_detected'; other.revokedAt = Date.now(); }
      store.save();
      return { error: 'REUSE_DETECTED' };
    }
    // rotate secret in place, extend idle window, keep absolute expiry.
    const newSecret = randomToken(32);
    s.refreshHash = sha256(newSecret);
    s.lastUsedAt = now;
    s.idleExpiry = now + IDLE_TTL_MS;
    store.save();
    return {
      ok: true,
      userId: s.userId,
      accessToken: newAccessFor(sid, s.userId),
      refreshToken: `${sid}.${newSecret}`
    };
  });
}

module.exports = {
  ACCESS_COOKIE, REFRESH_COOKIE, ACCESS_TTL_MS, IDLE_TTL_MS, ABSOLUTE_TTL_MS,
  createSession, getSession, revokeSession, revokeAllForUser, rotate,
  verifyAccess, newAccessFor, prune
};
