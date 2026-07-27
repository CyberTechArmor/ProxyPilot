// The base app's Web Push + install feature (F5).
//
// The structural assertions below are cheap and catch the regressions that have
// actually happened. The crypto assertion is the important one: every mistake in
// RFC 8291 is SILENT — the push service returns 201 and the browser drops the
// message — so "it looks right" cannot be the standard. That test transpiles the
// GENERATED push.ts with Node's own type stripping, encrypts a message, and then
// DECRYPTS it the way a browser would. If the header, the record size, the
// delimiter or the key derivation is wrong, it fails here instead of in a
// container where the only symptom is silence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';

import {
  pushTs, pushSchemaTs, pushMigrationSql, pushClientJs, pushServiceWorkerJs,
  pushAdminMarkup, pwaInstallJs, PUSH_CSS,
} from '../mock2/scaffold-push.js';
import { buildPlatformFiles } from '../mock2/scaffold-platform.js';
import { scaffoldPwaFiles } from '../mock2/scaffold.js';

/* ------------------------------ structure -------------------------------- */

test('push.ts ships in every project, so it must not import the auth component', () => {
  // A project can be built with no accounts at all. A hard dependency on
  // ../auth/* would make the base scaffold un-buildable there.
  assert.doesNotMatch(pushTs(), /from '\.\.\/auth\//);
});

test('the platform emits push.ts and push.js', () => {
  const paths = buildPlatformFiles().map((f) => f.path);
  assert.ok(paths.includes('src/platform/push.ts'));
  assert.ok(paths.includes('public/push.js'));
});

test('a subscription is keyed on its ENDPOINT, never on the user', () => {
  const ts = pushTs();
  // The bug this prevents: "1 device subscribed" next to "this browser is not
  // subscribed", because a re-subscribe inserted a second row.
  assert.match(ts, /onConflictDoUpdate\(\{\s*target: pushSubscriptions\.endpoint/);
  assert.match(pushMigrationSql(), /CREATE UNIQUE INDEX[^\n]*push_subscriptions_endpoint_key ON push_subscriptions \(endpoint\)/);
  // And the test send looks the device up by endpoint, not by whoever is
  // signed in — otherwise the test "succeeds" on an unsubscribed browser.
  assert.match(ts, /pushRoutes\.post\('\/api\/push\/test'[\s\S]*?eq\(pushSubscriptions\.endpoint, endpoint\)/);
});

test('rs is the 4096 MAXIMUM record size, not this record\'s length', () => {
  // Writing the body length here produces a header the browser rejects in
  // silence. RFC 8188 §2.1.
  const ts = pushTs();
  assert.match(ts, /rs\.writeUInt32BE\(MAX_RECORD_SIZE\)/);
  assert.doesNotMatch(ts, /rs\.writeUInt32BE\(body\.length\)/);
});

test('an expired subscription is deleted, not retried forever', () => {
  assert.match(pushTs(), /status === 404 \|\| status === 410[\s\S]{0,300}db\.delete\(pushSubscriptions\)/);
});

test('the service worker both receives and opens a notification', () => {
  const sw = pushServiceWorkerJs();
  // Without `push` the message is discarded; without `notificationclick` a tap
  // does nothing. userVisibleOnly means a push that shows nothing costs the
  // site its permission, so the handler must ALWAYS show something.
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  assert.match(sw, /showNotification\(data\.title \|\| 'Notification'/);
  // Focus an existing window rather than opening a tab per tap.
  assert.match(sw, /clients\.matchAll/);
});

test('the generated sw.js carries the push handlers', () => {
  const { swJs } = scaffoldPwaFiles();
  assert.match(swJs, /addEventListener\('push'/);
  assert.match(swJs, /addEventListener\('notificationclick'/);
});

// The comments in these files legitimately NAME window.confirm while explaining
// why they do not call it, so the dialog assertions look at code only.
const codeOnly = (src) => String(src).replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

test('the install prompt is a one-time modal, not furniture', () => {
  const js = codeOnly(pwaInstallJs());
  // The floating pill is gone (operator: "the install app shouldn't always be
  // present"), and nothing falls back to a browser dialog.
  assert.doesNotMatch(js, /pwa-install-btn/);
  assert.doesNotMatch(js, /position:fixed/);
  assert.match(js, /pp\.confirm\(/);
  assert.doesNotMatch(js, /window\.confirm|[^.]\bconfirm\(/);
  // Install / Not now, and "not now" is remembered.
  assert.match(js, /okText: 'Install'/);
  assert.match(js, /cancelText: 'Not now'/);
  assert.match(js, /localStorage\.setItem\(DISMISS_KEY/);
  // And it is reachable forever after, from the Notifications panel.
  assert.match(js, /window\.pp\.install = \{/);
});

test('the generated install.js is the modal version and parses', () => {
  const { installJs } = scaffoldPwaFiles();
  assert.doesNotMatch(installJs, /pwa-install-btn/);
  assert.match(installJs, /window\.pp\.install/);
  // It still registers the service worker — the install rewrite must not have
  // taken the update machinery with it.
  assert.match(installJs, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
  new Script(installJs);  // throws on a syntax error
});

test('the notifications panel is always available, and never uses a native dialog', () => {
  const js = codeOnly(pushClientJs());
  assert.match(js, /pp-notifications/);
  assert.match(js, /window\.pp\.alert\(/);
  assert.doesNotMatch(js, /window\.(confirm|prompt)\(|[^.\w]alert\(/);
  // The install entry lives here too, in all three of its states.
  assert.match(js, /Install app/);
  assert.match(js, /Add to Home Screen/);
  // Self-heal: the browser saying "subscribed" while the server has no row is
  // the disagreement that produced a user-visible contradiction before.
  assert.match(js, /api\('\/api\/push\/subscribe', sub\.toJSON\(\)\)/);
  assert.match(pushAdminMarkup(), /id="pp-notifications"/);
  assert.match(PUSH_CSS, /min-height: 44px/);
});

test('the client script parses', () => {
  new Script(pushClientJs());  // throws on a syntax error
});

test('the schema and the migration agree on the tables', () => {
  const schema = pushSchemaTs();
  const sql = pushMigrationSql();
  for (const table of ['push_subscriptions', 'push_vapid']) {
    assert.match(schema, new RegExp(`pgTable\\('${table}'`), `${table} missing from the Drizzle schema`);
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} missing from the migration`);
  }
});

/* -------------------------------- crypto --------------------------------- */

test('the generated push.ts encrypts what a browser can decrypt, and signs a valid VAPID JWT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-push-'));
  try {
    mkdirSync(join(dir, 'db'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    // Stubs for everything push.ts imports that needs a database or a server.
    writeFileSync(join(dir, 'db', 'index.js'), 'export const db = {};\n');
    writeFileSync(join(dir, 'schema.js'), 'export const pushSubscriptions = {};\nexport const pushVapid = {};\n');
    writeFileSync(join(dir, 'express.js'), 'export const Router = () => ({ use() {}, get() {}, post() {} });\n');
    writeFileSync(join(dir, 'drizzle.js'), 'export const eq = () => {};\nexport const sql = () => {};\n');
    writeFileSync(join(dir, 'zod.js'),
      'const any = () => ({ safeParse: () => ({ success: false }), max() { return this; }, min() { return this; }, url() { return this; }, optional() { return this; } });\n'
      + 'export const z = { object: any, string: any, number: any };\n');
    writeFileSync(join(dir, 'push.ts'), pushTs()
      .replace("from '../db/index.js'", "from './db/index.js'")
      .replace("from './schema.js'", "from './schema.js'")
      .replace("from 'express'", "from './express.js'")
      .replace("from 'zod'", "from './zod.js'")
      .replace("from 'drizzle-orm'", "from './drizzle.js'"));
    writeFileSync(join(dir, 'verify.mjs'), VERIFY_SCRIPT);
    // Node's own type stripping — no toolchain, no dependency. Throws (failing
    // the test) on a non-zero exit, and the child's message is the assertion.
    const out = execFileSync(process.execPath, ['--experimental-strip-types', join(dir, 'verify.mjs')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(out, /ROUNDTRIP OK/);
    assert.match(out, /VAPID OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The browser half of RFC 8291, written out longhand so it shares no code with
// the implementation under test.
const VERIFY_SCRIPT = `
import crypto from 'node:crypto';
import { encryptPayload, signVapidJwt, generateVapidPair } from './push.ts';

const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const authSecret = crypto.randomBytes(16).toString('base64url');
const message = JSON.stringify({ title: 'Notifications are working', body: 'hello', url: '/' });

const body = encryptPayload(message, ua.getPublicKey().toString('base64url'), authSecret);

// RFC 8188 §2.1 header: salt(16) || rs(4) || idlen(1) || keyid(idlen)
const salt = body.subarray(0, 16);
const rs = body.readUInt32BE(16);
const idlen = body[20];
const asPublic = body.subarray(21, 21 + idlen);
const ct = body.subarray(21 + idlen);
if (rs !== 4096) throw new Error('rs is ' + rs + ', must be the 4096 MAXIMUM');
if (idlen !== 65) throw new Error('keyid must be the 65-byte server ephemeral key, got ' + idlen);

const hkdf = (s, ikm, info, len) => {
  const prk = crypto.createHmac('sha256', s).update(ikm).digest();
  let t = Buffer.alloc(0);
  const acc = [];
  for (let i = 1; Buffer.concat(acc).length < len; i++) {
    t = crypto.createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    acc.push(t);
  }
  return Buffer.concat(acc).subarray(0, len);
};
const shared = ua.computeSecret(asPublic);
const keyInfo = Buffer.concat([Buffer.from('WebPush: info\\0', 'utf8'), ua.getPublicKey(), asPublic]);
const ikm = hkdf(Buffer.from(authSecret, 'base64url'), shared, keyInfo, 32);
const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\\0', 'utf8'), 16);
const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\\0', 'utf8'), 12);
const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
d.setAuthTag(ct.subarray(ct.length - 16));
const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
if (plain[plain.length - 1] !== 0x02) throw new Error('the last record delimiter must be 0x02');
const recovered = plain.subarray(0, plain.length - 1).toString('utf8');
if (recovered !== message) throw new Error('plaintext mismatch: ' + recovered);
console.log('ROUNDTRIP OK');

const pair = generateVapidPair('https://app.example.com');
const jwt = signVapidJwt('https://fcm.googleapis.com/fcm/send/abc123', pair.subject, pair.privateKey);
const [h, b, sig] = jwt.split('.');
const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
if (claims.aud !== 'https://fcm.googleapis.com') throw new Error('aud must be the push service ORIGIN, got ' + claims.aud);
if (claims.sub !== 'https://app.example.com') throw new Error('sub is ' + claims.sub);
if (claims.exp - Math.floor(Date.now() / 1000) > 24 * 3600) throw new Error('exp exceeds the 24h cap');
const raw = Buffer.from(sig, 'base64url');
if (raw.length !== 64) throw new Error('an ES256 signature is raw r||s (64 bytes), got ' + raw.length);
const pub = Buffer.from(pair.publicKey, 'base64url');
const key = crypto.createPublicKey({
  key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
  format: 'jwk',
});
if (!crypto.createVerify('SHA256').update(h + '.' + b).verify({ key, dsaEncoding: 'ieee-p1363' }, raw)) {
  throw new Error('the VAPID JWT does not verify against its own public key');
}
console.log('VAPID OK');
`;
