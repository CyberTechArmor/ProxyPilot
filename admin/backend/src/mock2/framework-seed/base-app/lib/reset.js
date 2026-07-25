'use strict';
// Single-use emailed tokens. Only a SHA-256 hash is stored; raw tokens are
// delivered by email or shown once to an administrator and never persisted.
const store = require('./store');
const { randomToken, sha256 } = require('./crypto');

const TTL_MS = 60 * 60 * 1000; // 1 hour
const LOGIN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function purposeOf(rec) { return rec.purpose || 'reset'; }

function prune() {
  const db = store.get();
  const now = Date.now();
  const before = db.passwordResets.length;
  db.passwordResets = db.passwordResets.filter(r => !r.usedAt && new Date(r.expiresAt).getTime() > now);
  if (db.passwordResets.length !== before) store.save();
}

function createToken(userId, purpose, ttlMs, meta) {
  const db = store.get();
  db.passwordResets = db.passwordResets.filter(r => !(r.userId === userId && purposeOf(r) === purpose));
  const token = randomToken(32);
  db.passwordResets.push({
    tokenHash: sha256(token),
    userId,
    purpose,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    usedAt: null,
    meta: meta || null,
  });
  store.save();
  return token;
}

// Create a single-use reset token for a user. Any prior reset tokens are invalidated.
function createReset(userId, meta) { return createToken(userId, 'reset', TTL_MS, meta); }

// Create a single-use email login token. Any prior login tokens are invalidated.
function createLogin(userId, meta) { return createToken(userId, 'login', LOGIN_TTL_MS, meta); }

// Returns the userId for a valid, unused, unexpired token of the requested purpose.
function verifyToken(token, purpose) {
  if (!token) return null;
  prune();
  const rec = store.get().passwordResets.find(r => r.tokenHash === sha256(token) && !r.usedAt && purposeOf(r) === purpose);
  if (!rec) return null;
  if (new Date(rec.expiresAt).getTime() <= Date.now()) return null;
  return rec.userId;
}

function verifyReset(token) { return verifyToken(token, 'reset'); }
function verifyLogin(token) { return verifyToken(token, 'login'); }

// Marks the token as used so it cannot be replayed.
function consumeToken(token, purpose) {
  const db = store.get();
  const rec = db.passwordResets.find(r => r.tokenHash === sha256(token) && !r.usedAt && purposeOf(r) === purpose);
  if (rec) { rec.usedAt = new Date().toISOString(); store.save(); }
  return !!rec;
}

function consumeReset(token) { return consumeToken(token, 'reset'); }
function consumeLogin(token) { return consumeToken(token, 'login'); }

module.exports = { createReset, createLogin, verifyReset, verifyLogin, consumeReset, consumeLogin, prune, TTL_MS, LOGIN_TTL_MS };
