'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.APP_DATA_DIR || path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');

function loadMasterKey() {
  if (process.env.APP_MASTER_KEY) {
    const k = Buffer.from(process.env.APP_MASTER_KEY, 'hex');
    if (k.length === 32) return k;
  }
  try {
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const k = Buffer.from(hex, 'hex');
    if (k.length === 32) return k;
  } catch (_) {}
  const k = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, k.toString('hex'), { mode: 0o600 });
  return k;
}

const MASTER_KEY = loadMasterKey();

// Password hashing with scrypt. Format: scrypt$N$r$p$saltHex$hashHex
function hashPassword(password) {
  const N = 16384, r = 8, p = 1, keylen = 64;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt$')) return false;
    const [, N, r, p, saltHex, hashHex] = stored.split('$');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length,
      { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}

// AES-256-GCM encryption for secrets at rest. Returns enc:v1:iv:tag:cipher (base64)
function encryptSecret(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptSecret(blob) {
  if (blob == null) return null;
  try {
    const [pfx, ver, ivB, tagB, dataB] = String(blob).split(':');
    if (pfx !== 'enc' || ver !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch (_) { return null; }
}

function isEncrypted(blob) { return typeof blob === 'string' && blob.startsWith('enc:v1:'); }

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

module.exports = { hashPassword, verifyPassword, encryptSecret, decryptSecret, isEncrypted, randomToken, sha256, MASTER_KEY };
