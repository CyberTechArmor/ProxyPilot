'use strict';
const crypto = require('crypto');

function uuid() { return crypto.randomUUID(); }

function parseCookies(req) {
  const out = {};
  const raw = req.headers['cookie'];
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readBody(req, limit = 1_000_000) {
  // The server drains the body once, up front (see server.js), and caches the
  // promise here. Routes call readBody() normally and get that same value —
  // which also makes a second call in one request safe instead of hanging
  // forever on an already-consumed stream.
  if (req._bodyPromise) return req._bodyPromise;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(buf.toString('utf8'))); }
      catch (e) { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, headers = {}) {
  // Buffer first so Content-Length is the BYTE length (JSON with non-ASCII —
  // names, notes — is longer in bytes than in JS characters). Without an
  // explicit length Node falls back to chunked transfer-encoding for every
  // reply, which is wasted framing on small JSON and leaves the connection's
  // message boundaries harder to reason about on keep-alive sockets.
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, headers));
  res.end(body);
}

// SECURITY (fix): only honour X-Forwarded-For when the operator has declared
// that the app sits behind a trusted proxy (TRUSTED_PROXY=1). Trusting it
// unconditionally let anyone connecting directly spoof the header to mint a new
// identity per request — which silently defeats every rate limit keyed on IP
// (login, register, forgot, OTP) and poisons the audit trail. Default off: the
// socket address is always truthful, a header never is.
function clientIp(req) {
  if (String(process.env.TRUSTED_PROXY || '') === '1') {
    const xf = req.headers['x-forwarded-for'];
    // Left-most entry is the originating client; the rest are proxies.
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function cookie(name, value, opts = {}) {
  const p = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) p.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  p.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) p.push('HttpOnly');
  p.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) p.push('Secure');
  return p.join('; ');
}

function timingSafeEqStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { uuid, parseCookies, readBody, sendJson, clientIp, cookie, timingSafeEqStr };
