// Web Push crypto, checked against the RFCs' OWN published test vectors.
//
// Why that matters more than usual here: an encryption bug in Web Push does not
// throw. The push service accepts the request (it cannot read the body either),
// returns 201, and the browser silently discards the message it cannot decrypt.
// There is no error anywhere in the chain. "It looked right" is worthless — the
// only real check is byte-for-byte agreement with RFC 8291's worked example.
//
// Native-free (risk R9): node:crypto only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  hkdf, deriveKeys, encryptPayload, buildAes128GcmHeader,
  vapidClaims, signVapidJwt, derToJoseSignature, buildPushHeaders,
  classifyPushResponse, validateVapidConfig,
} from '../lib/web-push-logic.js';
import { generateVapidKeys } from '../../../../scripts/generate-vapid.mjs';

const b64 = (s) => Buffer.from(s, 'base64url');

// ---- RFC 8291 §5, "Push Message Encryption Example" ----
// Every value below is copied from the RFC. https://www.rfc-editor.org/rfc/rfc8291#section-5
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  // The complete aes128gcm body: header || ciphertext.
  expected: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 §5: key derivation matches the published intermediate values', () => {
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(b64(RFC.uaPrivate));
  const as = createECDH('prime256v1');
  as.setPrivateKey(b64(RFC.asPrivate));

  // The RFC's public keys must be the ones these private keys produce — if this
  // fails, the vector was transcribed wrong and nothing below means anything.
  assert.equal(ua.getPublicKey().toString('base64url'), RFC.uaPublic, 'UA public key');
  assert.equal(as.getPublicKey().toString('base64url'), RFC.asPublic, 'AS public key');

  const shared = as.computeSecret(b64(RFC.uaPublic));
  // ECDH is symmetric — both sides must reach the same secret.
  assert.deepEqual(shared, ua.computeSecret(b64(RFC.asPublic)), 'shared secret is symmetric');
  // RFC 8291 §5: ecdh_secret
  assert.equal(shared.toString('base64url'), 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs');

  const { ikm, cek, nonce } = deriveKeys({
    uaPublic: b64(RFC.uaPublic),
    authSecret: b64(RFC.authSecret),
    asPublic: b64(RFC.asPublic),
    sharedSecret: shared,
    salt: b64(RFC.salt),
  });
  // Each of these is printed in the RFC's example.
  assert.equal(ikm.toString('base64url'), 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg', 'IKM');
  assert.equal(cek.toString('base64url'), 'oIhVW04MRdy2XN9CiKLxTg', 'content encryption key');
  assert.equal(nonce.toString('base64url'), '4h_95klXJ5E_qnoN', 'nonce');
});

test('RFC 8291 §5: the encrypted body is byte-for-byte the published one', () => {
  const as = createECDH('prime256v1');
  as.setPrivateKey(b64(RFC.asPrivate));
  const body = encryptPayload({
    payload: RFC.plaintext,
    uaPublicKey: RFC.uaPublic,
    authSecret: RFC.authSecret,
    ephemeral: as,      // pinned ONLY for the vector
    salt: b64(RFC.salt),
  });
  assert.equal(body.toString('base64url'), RFC.expected);
});

test('a fresh salt and ephemeral key are used per message', () => {
  // Reusing either across messages leaks plaintext, so the production path must
  // never produce the same bytes twice for the same input.
  const opts = { payload: 'hello', uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret };
  const a = encryptPayload(opts).toString('base64url');
  const b = encryptPayload(opts).toString('base64url');
  assert.notEqual(a, b);
});

test('encryptPayload refuses malformed subscription keys instead of producing junk', () => {
  assert.throws(() => encryptPayload({ payload: 'x', uaPublicKey: 'AAAA', authSecret: RFC.authSecret }), /65-byte/);
  assert.throws(() => encryptPayload({ payload: 'x', uaPublicKey: RFC.uaPublic, authSecret: 'AAAA' }), /16 bytes/);
});

test('RFC 8188: the aes128gcm header is salt || rs || idlen || keyid', () => {
  const salt = Buffer.alloc(16, 7);
  const keyid = Buffer.alloc(65, 4);
  const h = buildAes128GcmHeader(salt, 4096, keyid);
  assert.equal(h.length, 16 + 4 + 1 + 65);
  assert.deepEqual(h.subarray(0, 16), salt);
  assert.equal(h.readUInt32BE(16), 4096);
  assert.equal(h[20], 65);
  assert.deepEqual(h.subarray(21), keyid);
});

test('RFC 5869: HKDF matches the spec test case 1', () => {
  const out = hkdf(
    Buffer.from('000102030405060708090a0b0c', 'hex'),
    Buffer.from('0b'.repeat(22), 'hex'),
    Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
    42,
  );
  assert.equal(
    out.toString('hex'),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  );
});

// ---- RFC 8292: VAPID ----

test('the JWT audience is the push service ORIGIN, not the endpoint', () => {
  // A full-endpoint `aud` is rejected with a 401 that reads like a key problem.
  const c = vapidClaims({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123?x=1',
    subject: 'mailto:ops@example.com',
    nowSeconds: 1_700_000_000,
  });
  assert.equal(c.aud, 'https://fcm.googleapis.com');
  assert.equal(c.sub, 'mailto:ops@example.com');
  assert.equal(c.exp, 1_700_000_000 + 12 * 3600);
});

test('the JWT expiry is clamped to the 24h the spec allows', () => {
  const now = 1_700_000_000;
  const long = vapidClaims({ endpoint: 'https://push.example/x', subject: 'https://example.com', expirySeconds: 99999999, nowSeconds: now });
  assert.equal(long.exp, now + 24 * 3600, 'a long-lived token is a standing credential');
  const short = vapidClaims({ endpoint: 'https://push.example/x', subject: 'https://example.com', expirySeconds: 1, nowSeconds: now });
  assert.equal(short.exp, now + 60, 'and a floor, so clock skew does not pre-expire it');
});

test('the subject must be contactable — the push service uses it to reach you', () => {
  assert.throws(
    () => vapidClaims({ endpoint: 'https://push.example/x', subject: 'ops@example.com', nowSeconds: 1 }),
    /mailto: or https:/,
  );
});

test('the signed JWT verifies against the matching public key', async () => {
  const { publicKey, privateKey } = generateVapidKeys();
  const claims = vapidClaims({ endpoint: 'https://push.example/x', subject: 'mailto:a@b.c', nowSeconds: 1_700_000_000 });
  const jwt = signVapidJwt({ claims, privateKey });
  const [h, b, sig] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'ES256');
  assert.deepEqual(JSON.parse(Buffer.from(b, 'base64url')), claims);
  // ES256 is raw r||s — 64 bytes. A DER signature here is the classic bug and
  // every push would 401.
  assert.equal(Buffer.from(sig, 'base64url').length, 64, 'JOSE signature, not DER');

  const { createVerify, createPublicKey } = await import('node:crypto');
  const pub = Buffer.from(publicKey, 'base64url');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  // Re-encode r||s back to DER to verify with Node.
  const raw = Buffer.from(sig, 'base64url');
  const trim = (x) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; const t = x.subarray(i); return t[0] & 0x80 ? Buffer.concat([Buffer.from([0]), t]) : t; };
  const r = trim(raw.subarray(0, 32));
  const s = trim(raw.subarray(32));
  const der = Buffer.concat([
    Buffer.from([0x30, r.length + s.length + 4, 0x02, r.length]), r, Buffer.from([0x02, s.length]), s,
  ]);
  assert.ok(createVerify('SHA256').update(`${h}.${b}`).verify(key, der), 'the push service will accept this signature');
});

test('derToJoseSignature left-pads short components', () => {
  // A short r or s is legal DER and must become a 32-byte field, not a 31-byte
  // one — a signature that is 63 bytes long is rejected outright.
  const r = Buffer.from([0x01, 0x02]);
  const s = Buffer.from([0x03]);
  const der = Buffer.concat([
    Buffer.from([0x30, r.length + s.length + 4, 0x02, r.length]), r, Buffer.from([0x02, s.length]), s,
  ]);
  const jose = derToJoseSignature(der);
  assert.equal(jose.length, 64);
  assert.deepEqual(jose.subarray(30, 32), r);
  assert.deepEqual(jose.subarray(63, 64), s);
});

test('push headers carry the VAPID public key so the service can match the subscription', () => {
  const h = buildPushHeaders({ jwt: 'JWT', publicKey: 'PUB', bodyLength: 120 });
  assert.equal(h.Authorization, 'vapid t=JWT, k=PUB');
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.equal(h['Content-Length'], '120');
  assert.ok(Number(h.TTL) > 0);
});

test('a dead subscription is dropped, a busy service is retried, a bad key is neither', () => {
  assert.deepEqual(classifyPushResponse(201), { ok: true, drop: false, retry: false });
  for (const s of [404, 410]) assert.equal(classifyPushResponse(s).drop, true, `${s} means the browser is gone`);
  for (const s of [429, 503]) assert.equal(classifyPushResponse(s).retry, true, `${s} is transient`);
  const unauthorized = classifyPushResponse(401);
  assert.equal(unauthorized.drop, false, 'a key problem must not delete good subscriptions');
  assert.match(unauthorized.reason, /VAPID/);
  assert.match(classifyPushResponse(413).reason, /4KB/);
});

// ---- configuration ----

test('validateVapidConfig catches the failure that presents as silence', () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  const subject = 'mailto:ops@example.com';

  assert.equal(validateVapidConfig({ ...a, subject }).ok, true);

  // A MISMATCHED pair is the one that costs an afternoon: every push 401s and
  // nothing in the UI explains why.
  const mixed = validateVapidConfig({ publicKey: a.publicKey, privateKey: b.privateKey, subject });
  assert.equal(mixed.ok, false);
  assert.match(mixed.reason, /does not match/);

  assert.match(validateVapidConfig({ subject }).reason, /not configured/);
  assert.match(validateVapidConfig({ publicKey: 'AAAA', privateKey: a.privateKey, subject }).reason, /65-byte/);
  assert.match(validateVapidConfig({ ...a, subject: 'ops@example.com' }).reason, /mailto:/);
});

test('generated keys are the exact shape the Push API requires', () => {
  const { publicKey, privateKey } = generateVapidKeys();
  const pub = Buffer.from(publicKey, 'base64url');
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04, 'uncompressed point');
  assert.equal(Buffer.from(privateKey, 'base64url').length, 32);
  // base64url, so it survives a URL, an env file and a JSON body untouched.
  for (const k of [publicKey, privateKey]) assert.ok(!/[+/=]/.test(k), 'base64url, not base64');
  // Two runs must never agree.
  assert.notEqual(generateVapidKeys().privateKey, privateKey);
});

// ---- the install/update key lifecycle ----
//
// These assert the SHELL contract, because the bug they guard against was found
// here and not by reading: install.sh and update.sh each called the generator
// TWICE (once for --public, once for --private), which produced two unrelated
// key pairs. validateVapidConfig catches it; nothing else would have, and the
// symptom in production is every push 401ing with nothing in the UI to say why.

test('the install and update scripts generate a pair in ONE invocation', () => {
  const install = readFileSync(new URL('../../../../install.sh', import.meta.url), 'utf8');
  const update = readFileSync(new URL('../../../../update.sh', import.meta.url), 'utf8');
  for (const [name, src] of [['install.sh', install], ['update.sh', update]]) {
    // Two separate calls would each mint their own pair.
    const publicOnly = (src.match(/generate-vapid\.mjs["']?\s+--public/g) || []).length;
    const privateOnly = (src.match(/generate-vapid\.mjs["']?\s+--private/g) || []).length;
    assert.equal(publicOnly + privateOnly, 0,
      `${name} must not call the generator once per key — that yields a mismatched pair`);
    assert.match(src, /VAPID_PUBLIC_KEY=' \| cut -d= -f2-/, `${name} parses both keys from one run`);
  }
});

test('an existing pair is never regenerated, and half a pair is never kept', () => {
  const install = readFileSync(new URL('../../../../install.sh', import.meta.url), 'utf8');
  // Both present → reuse verbatim. The public key is baked into every browser
  // subscription, so replacing it silently invalidates all of them.
  assert.match(install, /if \[ -n "\$existing_pub" \] && \[ -n "\$existing_priv" \]; then[\s\S]{0,200}return 0/);
  // Exactly one present → regenerate BOTH, loudly. A surviving half would pair
  // with a fresh other half and match nothing.
  assert.match(install, /Only half of the VAPID key pair was present — regenerating both/);
});

test('.env.example lists the VAPID keys UNCOMMENTED, or update.sh never backfills them', () => {
  // sync_env_keys skips comment lines, so a commented entry here means an
  // existing install silently never receives the keys.
  const example = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
  for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
    assert.match(example, new RegExp(`^${k}=`, 'm'), `${k} is uncommented`);
  }
});

test('update.sh handles VAPID as a pair, outside the per-key loop', () => {
  const update = readFileSync(new URL('../../../../update.sh', import.meta.url), 'utf8');
  // The generic loop appends one key at a time; VAPID must be excluded from it.
  assert.match(update, /case "\$key" in VAPID_PUBLIC_KEY\|VAPID_PRIVATE_KEY\|VAPID_SUBJECT\) continue ;; esac/);
  // And skipped entirely when a working pair is already deployed.
  assert.match(update, /vapid_needed=0\s+# both already there/);
});

// ---- the real send path, against a live HTTP server ----
//
// sendPushTo is the function that actually ships. These run it against a stub
// push service and DECRYPT what arrives exactly as a browser would — the only
// check that proves the whole server-side chain, not just its pieces.

import { createServer } from 'node:http';
import { createDecipheriv } from 'node:crypto';
import { sendPushTo, buildPushPayload, pushConfigured, vapidConfig } from '../lib/web-push.js';
import { hkdf as hkdf2 } from '../lib/web-push-logic.js';

// Stand up a push service that answers with `status` and records the request.
function stubPushService(status = 201) {
  return new Promise((resolve) => {
    const captured = [];
    const srv = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        captured.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(status).end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/push/abc`,
      captured,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

// Decrypt an aes128gcm push body the way a browser does.
function browserDecrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaEcdh.getPublicKey(), asPublic]);
  const ikm = hkdf2(authSecret, shared, keyInfo, 32);
  const cek = hkdf2(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf2(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.length - 1).toString('utf8'); // drop the 0x02 delimiter
}

function withVapid(fn) {
  const keys = generateVapidKeys();
  const prev = { ...process.env };
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:ops@example.com';
  return Promise.resolve(fn(keys)).finally(() => {
    process.env.VAPID_PUBLIC_KEY = prev.VAPID_PUBLIC_KEY ?? '';
    process.env.VAPID_PRIVATE_KEY = prev.VAPID_PRIVATE_KEY ?? '';
    process.env.VAPID_SUBJECT = prev.VAPID_SUBJECT ?? '';
  });
}

test('END TO END: a real push round-trips and the browser can decrypt it', async () => {
  await withVapid(async (keys) => {
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const authSecret = Buffer.alloc(16, 9);
    const svc = await stubPushService(201);
    try {
      assert.equal(pushConfigured(), true);
      const payload = buildPushPayload({
        title: 'Build failed', body: 'Notes · deploy_failed', url: '/projects/42', level: 'error',
      });
      const r = await sendPushTo({
        endpoint: svc.url,
        p256dh: ua.getPublicKey().toString('base64url'),
        auth: authSecret.toString('base64url'),
      }, payload);
      assert.equal(r.ok, true, r.reason);

      const [req] = svc.captured;
      assert.equal(req.headers['content-encoding'], 'aes128gcm');
      assert.match(req.headers.authorization, new RegExp(`k=${keys.publicKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      assert.ok(Number(req.headers.ttl) > 0);
      // The payload the service worker will receive, recovered from the wire.
      assert.deepEqual(JSON.parse(browserDecrypt(req.body, ua, authSecret)), payload);
    } finally { await svc.close(); }
  });
});

test('END TO END: a 410 tells the caller to DROP the subscription', async () => {
  await withVapid(async () => {
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const svc = await stubPushService(410);
    try {
      const r = await sendPushTo({
        endpoint: svc.url,
        p256dh: ua.getPublicKey().toString('base64url'),
        auth: Buffer.alloc(16).toString('base64url'),
      }, { title: 'x' });
      assert.equal(r.ok, false);
      assert.equal(r.drop, true, 'the browser is gone — the row must not be retried forever');
    } finally { await svc.close(); }
  });
});

test('END TO END: a 429 is retried, not dropped', async () => {
  await withVapid(async () => {
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const svc = await stubPushService(429);
    try {
      const r = await sendPushTo({
        endpoint: svc.url,
        p256dh: ua.getPublicKey().toString('base64url'),
        auth: Buffer.alloc(16).toString('base64url'),
      }, { title: 'x' });
      assert.equal(r.drop, false, 'a busy service says nothing about the browser');
      assert.equal(r.retry, true);
    } finally { await svc.close(); }
  });
});

test('a malformed subscription is dropped at build time, not retried forever', async () => {
  await withVapid(async () => {
    const r = await sendPushTo({ endpoint: 'https://push.example/x', p256dh: 'AAAA', auth: 'AAAA' }, { title: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.drop, true);
  });
});

test('with no VAPID keys, sending reports the reason instead of throwing', async () => {
  const prev = process.env.VAPID_PUBLIC_KEY;
  process.env.VAPID_PUBLIC_KEY = '';
  try {
    assert.equal(pushConfigured(), false);
    const r = await sendPushTo({ endpoint: 'https://push.example/x', p256dh: 'x', auth: 'y' }, { title: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not configured/);
  } finally { process.env.VAPID_PUBLIC_KEY = prev ?? ''; }
});

test('buildPushPayload clips to what fits, and tags so alerts replace rather than stack', () => {
  const p = buildPushPayload({ title: 'x'.repeat(400), body: 'y'.repeat(900), level: 'error' });
  assert.ok(p.title.length <= 120);
  assert.ok(p.body.length <= 300);
  assert.equal(p.tag, 'pp-error');
  assert.equal(buildPushPayload({ title: 't', tag: 'build:42' }).tag, 'build:42');
  assert.equal(buildPushPayload({ title: 't' }).url, '/');
});

test('validatePushKeys rejects a bad subscription at SUBSCRIBE time', async () => {
  const { validatePushKeys } = await import('../lib/web-push-logic.js');
  const ua = createECDH('prime256v1'); ua.generateKeys();
  assert.equal(validatePushKeys({
    p256dh: ua.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16).toString('base64url'),
  }).ok, true);
  // Stored unchecked, these would fail on every notification forever and the
  // failure would surface long after the subscribe that caused it.
  assert.match(validatePushKeys({ p256dh: 'AAAA', auth: Buffer.alloc(16).toString('base64url') }).error, /65-byte/);
  assert.match(validatePushKeys({ p256dh: ua.getPublicKey().toString('base64url'), auth: 'AA' }).error, /16-byte/);
});
