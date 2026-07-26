// Web Push — the crypto and header construction, PURE (no network, no DB), so
// every step can be checked against the RFCs' own published test vectors.
//
// THREE SPECS, and it matters which key does what:
//
//   RFC 8292 (VAPID)  — identifies THIS SERVER to the push service. A JWT
//                       signed with the VAPID private key; the service checks
//                       it against the public key the browser gave it at
//                       subscribe time. Sender identity only.
//
//   RFC 8291 (encryption) — hides the payload from the push service. Uses keys
//                       the BROWSER generated for this subscription (p256dh +
//                       auth), which the server never chose and cannot derive.
//                       This is why a stolen VAPID key still decrypts nothing,
//                       and why the server cannot re-read a notification it
//                       already sent.
//
//   RFC 8188 (aes128gcm) — the content-encoding those bytes are wrapped in.
//
// Getting encryption subtly wrong yields a push the service accepts and the
// browser silently discards — no error anywhere. That is precisely why this is
// a pure module: web-push-logic.test.js runs RFC 8291 §5's worked example and
// asserts the exact ciphertext, so "it looks right" is never the standard.

import { createHmac, createECDH, randomBytes, createCipheriv, createSign, createPrivateKey } from 'node:crypto';

// RFC 8188 record size. Also the payload ceiling the push services enforce,
// so a single record always covers a legal message.
export const MAX_RECORD_SIZE = 4096;
// The largest plaintext that fits: 4096 minus the 16-byte auth tag, the 1-byte
// record delimiter, and the 86-byte aes128gcm header.
export const MAX_PAYLOAD_BYTES = MAX_RECORD_SIZE - 16 - 1 - 86;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s), 'base64url');

// ---- HKDF (RFC 5869), SHA-256 ----
export function hkdfExtract(salt, ikm) {
  return createHmac('sha256', salt).update(ikm).digest();
}
export function hkdfExpand(prk, info, length) {
  // Only ever one block here (all outputs are ≤ 32 bytes), but the loop keeps
  // the function honest against the RFC rather than assuming.
  const out = [];
  let t = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    t = createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, length);
}
export function hkdf(salt, ikm, info, length) {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length);
}

// ---- RFC 8291 §3.3: derive the content encryption key and nonce ----
//
// Exported and taking every input explicitly so the RFC's example values can be
// fed straight in. `asPrivate` is an ECDH instance already holding the server's
// ephemeral key — the caller owns generating it so a test can pin it.
export function deriveKeys({ uaPublic, authSecret, asPublic, sharedSecret, salt }) {
  // The "key info" ties the derived secret to BOTH parties' public keys, which
  // is what stops a shared secret being replayed against another subscription.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
  return { ikm, cek, nonce };
}

// ---- RFC 8188 §2.1: the aes128gcm header ----
// salt(16) || recordSize(4, big-endian) || idlen(1) || keyid(idlen)
export function buildAes128GcmHeader(salt, recordSize, keyid) {
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(recordSize);
  return Buffer.concat([salt, rs, Buffer.from([keyid.length]), keyid]);
}

// encryptPayload — the whole RFC 8291 body.
//
// `ephemeral` (an ECDH) and `salt` are injectable ONLY so the RFC test vector
// can pin them; production always generates both fresh, and reusing either
// across messages would leak plaintext.
export function encryptPayload({ payload, uaPublicKey, authSecret, ephemeral = null, salt = null }) {
  const uaPublic = Buffer.isBuffer(uaPublicKey) ? uaPublicKey : fromB64url(uaPublicKey);
  const auth = Buffer.isBuffer(authSecret) ? authSecret : fromB64url(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('p256dh must be a 65-byte uncompressed P-256 point');
  }
  if (auth.length !== 16) throw new Error('auth secret must be 16 bytes');

  const ecdh = ephemeral || createECDH('prime256v1');
  if (!ephemeral) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const useSalt = salt || randomBytes(16);

  const { cek, nonce } = deriveKeys({ uaPublic, authSecret: auth, asPublic, sharedSecret, salt: useSalt });

  // RFC 8188 §2: the record is plaintext || delimiter, and the LAST record's
  // delimiter is 0x02. A single record is always the last one.
  const raw = Buffer.from(payload, 'utf8');
  if (raw.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`push payload is ${raw.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }
  const plaintext = Buffer.concat([raw, Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // rs is the MAXIMUM record size, not this record's length — RFC 8188 §2.1.
  // Web Push fixes it at 4096, which is also the payload ceiling every push
  // service enforces, so one record always suffices. (Computing it from the
  // body length produces a header the browser rejects.) The keyid IS the
  // server's ephemeral public key: that is how the browser knows which key to
  // run ECDH against.
  const header = buildAes128GcmHeader(useSalt, MAX_RECORD_SIZE, asPublic);
  return Buffer.concat([header, body]);
}

// ---- RFC 8292: the VAPID Authorization header ----

// The JWT is ES256 over {aud, exp, sub}. `aud` is the push service's ORIGIN —
// not the full endpoint — and a mismatch is rejected with a 401 that reads like
// a key problem, which is a classic hour lost.
export function vapidClaims({ endpoint, subject, expirySeconds = 12 * 3600, nowSeconds }) {
  const url = new URL(endpoint);
  const sub = String(subject || '');
  if (!/^mailto:|^https?:/i.test(sub)) {
    throw new Error('VAPID subject must be a mailto: or https: URL — the push service uses it to contact you');
  }
  // The spec caps expiry at 24h; a long-lived token is a standing credential
  // for anyone who captures a request.
  const exp = Math.floor(nowSeconds) + Math.min(Math.max(60, expirySeconds), 24 * 3600);
  return { aud: url.origin, exp, sub };
}

// ES256 signatures are raw r||s (64 bytes), but Node signs DER. Converting is
// the step most hand-rolled implementations get wrong.
export function derToJoseSignature(der) {
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f; // long-form length
  const readInt = () => {
    if (der[offset] !== 0x02) throw new Error('malformed DER signature');
    const len = der[offset + 1];
    let start = offset + 2;
    let end = start + len;
    // Strip the leading zero a positive integer may carry, left-pad to 32.
    let bytes = der.subarray(start, end);
    while (bytes.length > 32 && bytes[0] === 0x00) bytes = bytes.subarray(1);
    offset = end;
    return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

export function signVapidJwt({ claims, privateKey }) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${body}`;
  const d = fromB64url(privateKey);
  if (d.length !== 32) throw new Error('VAPID private key must be a 32-byte base64url scalar');
  // Rebuild the key object from the raw scalar. The public coordinates are
  // recovered by Node from d.
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(d),
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33)),
    },
    format: 'jwk',
  });
  const der = createSign('SHA256').update(signingInput).sign(key);
  return `${signingInput}.${b64url(derToJoseSignature(der))}`;
}

// The headers a push request carries. TTL is how long the service holds an
// undelivered message — a phone that is off should still get a build-failed
// notice when it wakes, but not one from last week.
export function buildPushHeaders({ jwt, publicKey, bodyLength, ttlSeconds = 6 * 3600, urgency = 'normal' }) {
  return {
    // RFC 8292 §3: the modern single-header form. `k` is the VAPID PUBLIC key,
    // which is what lets the service match this request to the subscription.
    Authorization: `vapid t=${jwt}, k=${publicKey}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(bodyLength),
    TTL: String(Math.max(0, Math.floor(ttlSeconds))),
    Urgency: urgency,
  };
}

// A push service's answer, in terms the caller can act on. 404/410 mean the
// subscription is DEAD and must be deleted — keeping it means retrying forever
// against a browser that has been uninstalled.
export function classifyPushResponse(status) {
  if (status >= 200 && status < 300) return { ok: true, drop: false, retry: false };
  if (status === 404 || status === 410) return { ok: false, drop: true, retry: false, reason: 'subscription expired' };
  if (status === 429 || status === 503 || status === 502) return { ok: false, drop: false, retry: true, reason: 'push service busy' };
  if (status === 401 || status === 403) {
    return { ok: false, drop: false, retry: false, reason: 'VAPID rejected — the key pair does not match the subscription, or the subject is not a mailto:/https: URL' };
  }
  if (status === 413) return { ok: false, drop: false, retry: false, reason: 'payload too large (keep it under 4KB)' };
  return { ok: false, drop: false, retry: false, reason: `push service returned ${status}` };
}

// Are the configured keys usable? Checked at boot and before every send so a
// half-configured install says so instead of failing per-subscription.
export function validateVapidConfig({ publicKey, privateKey, subject } = {}) {
  if (!publicKey || !privateKey) return { ok: false, reason: 'VAPID keys are not configured' };
  let pub;
  let priv;
  try { pub = fromB64url(publicKey); priv = fromB64url(privateKey); } catch {
    return { ok: false, reason: 'VAPID keys are not valid base64url' };
  }
  if (pub.length !== 65 || pub[0] !== 0x04) return { ok: false, reason: 'VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point' };
  if (priv.length !== 32) return { ok: false, reason: 'VAPID_PRIVATE_KEY must be a 32-byte scalar' };
  // A mismatched pair is the failure that presents as "push silently does
  // nothing", so it is checked here rather than discovered at the push service.
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) {
      return { ok: false, reason: 'VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY — regenerate the pair (every existing subscription must re-subscribe)' };
    }
  } catch {
    return { ok: false, reason: 'VAPID_PRIVATE_KEY is not a valid P-256 scalar' };
  }
  if (!/^mailto:|^https?:/i.test(String(subject || ''))) {
    return { ok: false, reason: 'VAPID_SUBJECT must be a mailto: or https: URL' };
  }
  return { ok: true };
}

// validatePushKeys — check a browser-supplied subscription BEFORE storing it.
//
// Done at subscribe time rather than at send time on purpose: a malformed row
// otherwise sits in the table failing on every notification forever, and the
// failure surfaces as "push doesn't work" long after the subscribe that caused
// it. The shapes are fixed by the spec — an uncompressed P-256 point and a
// 16-byte secret — so this is cheap and total.
export function validatePushKeys({ p256dh, auth } = {}) {
  let pub;
  let secret;
  try {
    pub = fromB64url(p256dh);
    secret = fromB64url(auth);
  } catch {
    return { ok: false, error: 'p256dh and auth must be base64url' };
  }
  if (pub.length !== 65 || pub[0] !== 0x04) {
    return { ok: false, error: 'p256dh must be a 65-byte uncompressed P-256 point' };
  }
  if (secret.length !== 16) return { ok: false, error: 'auth must be a 16-byte secret' };
  return { ok: true };
}
