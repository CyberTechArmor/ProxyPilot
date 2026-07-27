// Mock2 scaffold — WEB PUSH + APP INSTALL for the base app.
//
// Operator ask: "the install app shouldn't always be present, it should show up
// as a modal (either install/dismiss), and always be available in the profile/
// notifications area — update the base app; include the vapid keys/
// notifications feature just added to ProxyPilot."
//
// So every generated app now ships, out of the box:
//   • an install invitation that appears ONCE as a modal (Install / Not now)
//     instead of a pill welded to the corner of every screen, and a permanent
//     entry under Notifications for anyone who dismissed it or is on iOS;
//   • real Web Push — VAPID keys, per-device subscriptions, a test send.
//
// Why this is platform code rather than something a build writes: Web Push is
// three RFCs deep (8292 VAPID, 8291 payload encryption, 8188 framing) and every
// mistake in it is SILENT — the push service accepts the request and the
// browser discards the message. A build model producing this from scratch would
// produce something that looks right and never rings. The implementation here
// is a port of ProxyPilot's own (admin/backend/src/lib/web-push-logic.js),
// which is pinned against RFC 8291 §5's worked example.
//
// Keys live in the DATABASE, not the environment. A generated app has no
// operator editing .env between deploys — env keys would have to be minted by
// the provisioner and re-plumbed on every redeploy, and a lost pair silently
// breaks every existing subscription. One singleton row, generated on first
// use, survives redeploys by construction.
//
// Terminology (risk R7): nothing here is named "agent".

/* ---------------------------------------------------------------------------
   Drizzle schema (appended to src/platform/schema.ts).
   --------------------------------------------------------------------------- */
export function pushSchemaTs() {
  return `
// ---------------------------------------------------------------------------
// Web Push — per-DEVICE notification subscriptions, and this install's VAPID
// identity.
// ---------------------------------------------------------------------------

// A subscription's identity is its ENDPOINT, not the user who created it: the
// same browser re-subscribing must UPDATE its row, and two people sharing a
// device are two endpoints. Keying on user_id instead produces the classic
// "1 device subscribed" next to "this browser is not subscribed".
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: serial('id').primaryKey(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userId: integer('user_id'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  endpointKey: uniqueIndex('push_subscriptions_endpoint_key').on(t.endpoint),
  userIdx: index('push_subscriptions_user_idx').on(t.userId),
}));

// Singleton (id = 1). The VAPID pair identifies this SERVER to the push
// services; rotating it invalidates every existing subscription, which is why
// it is generated once and then left alone.
export const pushVapid = pgTable('push_vapid', {
  id: integer('id').primaryKey().default(1),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  subject: text('subject').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
`;
}

/* ---------------------------------------------------------------------------
   Migration SQL (appended to migrations/0100_platform.sql).
   --------------------------------------------------------------------------- */
export function pushMigrationSql() {
  return `
-- Web Push: per-device subscriptions + this install's VAPID identity.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           serial PRIMARY KEY,
  endpoint     text NOT NULL,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_id      integer,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
-- The endpoint is the identity: re-subscribing the same browser UPDATEs.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key ON push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS push_vapid (
  id          integer PRIMARY KEY DEFAULT 1,
  public_key  text NOT NULL,
  private_key text NOT NULL,
  subject     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_vapid_singleton CHECK (id = 1)
);
`;
}

/* ---------------------------------------------------------------------------
   src/platform/push.ts — the crypto, the store, the send, the routes.
   --------------------------------------------------------------------------- */
export function pushTs() {
  return `import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pushSubscriptions, pushVapid } from './schema.js';

// The signed-in user id, read DEFENSIVELY rather than through the auth
// module's own accessor. push.ts ships in every project — including one built
// with no accounts at all — so it must not import ../auth/*; a hard dependency
// there would make the base scaffold un-buildable without the auth component
// (there is a regression test for exactly this). user_id is nullable anyway:
// a subscription belongs to a BROWSER, and knowing who was signed in when it
// was made is a nicety, not the key.
function signedInUserId(req: Request): number | null {
  const auth = (req as unknown as { auth?: { authenticated?: boolean; userId?: number | null } }).auth;
  if (!auth || auth.authenticated !== true) return null;
  return typeof auth.userId === 'number' ? auth.userId : null;
}

/* ===========================================================================
   RFC 8292 (VAPID) + RFC 8291 (payload encryption) + RFC 8188 (aes128gcm).
   Node's crypto only — no dependency, nothing to keep patched.

   Every mistake in here is SILENT: the push service returns 201 and the browser
   drops the message. Do not "simplify" any of it without a test that decrypts
   the output.
   =========================================================================== */

const MAX_RECORD_SIZE = 4096;
const MAX_PAYLOAD_BYTES = MAX_RECORD_SIZE - 16 - 1 - 86;

const b64url = (buf: Buffer | string): string => Buffer.from(buf as Buffer).toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(String(s), 'base64url');

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const out: Buffer[] = [];
  let t = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    t = crypto.createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, length);
}

export function encryptPayload(payload: string, p256dh: string, authSecret: string): Buffer {
  const uaPublic = fromB64url(p256dh);
  const auth = fromB64url(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh must be a 65-byte uncompressed P-256 point');
  if (auth.length !== 16) throw new Error('auth secret must be 16 bytes');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);

  // The key info binds the secret to BOTH public keys, so it cannot be replayed
  // against a different subscription.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\\0', 'utf8'), uaPublic, asPublic]);
  const ikm = hkdf(auth, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\\0', 'utf8'), 12);

  const raw = Buffer.from(payload, 'utf8');
  if (raw.length > MAX_PAYLOAD_BYTES) throw new Error(\`push payload is \${raw.length} bytes; the limit is \${MAX_PAYLOAD_BYTES}\`);
  // RFC 8188 §2: the LAST record's delimiter is 0x02. One record is always last.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  // rs is the MAXIMUM record size (4096), not this record's length. Writing the
  // body length here yields a header the browser rejects without a word.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(MAX_RECORD_SIZE);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, body]);
}

// ES256 signatures are raw r||s (64 bytes); Node signs DER. This conversion is
// the step hand-rolled VAPID implementations most often get wrong.
export function derToJose(der: Buffer): Buffer {
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  const readInt = (): Buffer => {
    if (der[offset] !== 0x02) throw new Error('malformed DER signature');
    const len = der[offset + 1];
    const start = offset + 2;
    const end = start + len;
    let bytes = der.subarray(start, end);
    while (bytes.length > 32 && bytes[0] === 0x00) bytes = bytes.subarray(1);
    offset = end;
    return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

export function signVapidJwt(endpoint: string, subject: string, privateKey: string): string {
  // \`aud\` is the push service's ORIGIN, never the full endpoint — a mismatch
  // comes back as a 401 that reads exactly like a bad key.
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const bodyPart = b64url(JSON.stringify({ aud, exp, sub: subject }));
  const signingInput = \`\${header}.\${bodyPart}\`;

  const d = fromB64url(privateKey);
  if (d.length !== 32) throw new Error('VAPID private key must be a 32-byte base64url scalar');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) },
    format: 'jwk',
  });
  const der = crypto.createSign('SHA256').update(signingInput).sign(key);
  return \`\${signingInput}.\${b64url(derToJose(der))}\`;
}

/* ------------------------------ VAPID identity ---------------------------- */

export type VapidPair = { publicKey: string; privateKey: string; subject: string };

export function generateVapidPair(subject: string): VapidPair {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
    subject,
  };
}

// Read the pair, minting it on first use. \`origin\` supplies the RFC-required
// contact subject (it must be a mailto: or https: URL) when there is nothing
// stored yet — that is the app's own address, which is always true and always
// reachable, unlike a placeholder email nobody reads.
export async function getVapid(origin: string): Promise<VapidPair> {
  const rows = await db.select().from(pushVapid).where(eq(pushVapid.id, 1)).limit(1);
  if (rows[0]) return { publicKey: rows[0].publicKey, privateKey: rows[0].privateKey, subject: rows[0].subject };
  const subject = /^https?:/i.test(origin) ? origin : 'https://localhost';
  const pair = generateVapidPair(subject);
  // ON CONFLICT: two first requests racing must not mint two pairs — the loser
  // re-reads the winner's, or every subscription made in that window is dead.
  await db.insert(pushVapid).values({ id: 1, ...pair }).onConflictDoNothing();
  const after = await db.select().from(pushVapid).where(eq(pushVapid.id, 1)).limit(1);
  return after[0]
    ? { publicKey: after[0].publicKey, privateKey: after[0].privateKey, subject: after[0].subject }
    : pair;
}

/* --------------------------------- sending -------------------------------- */

export type PushResult = { ok: boolean; status: number; dropped: boolean; reason?: string };

// Send one notification. A 404/410 means the browser is GONE (uninstalled,
// permission revoked); the row is deleted rather than retried forever.
export async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body?: string; url?: string; tag?: string },
  origin: string,
): Promise<PushResult> {
  const vapid = await getVapid(origin);
  let body: Buffer;
  try {
    body = encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
  } catch (err) {
    return { ok: false, status: 0, dropped: false, reason: (err as Error).message };
  }
  const jwt = signVapidJwt(sub.endpoint, vapid.subject, vapid.privateKey);
  let status = 0;
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: \`vapid t=\${jwt}, k=\${vapid.publicKey}\`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '21600',
        Urgency: 'normal',
      },
      body: body as unknown as BodyInit,
    });
    status = res.status;
  } catch (err) {
    return { ok: false, status: 0, dropped: false, reason: (err as Error).message };
  }
  if (status >= 200 && status < 300) return { ok: true, status, dropped: false };
  if (status === 404 || status === 410) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint)).catch(() => undefined);
    return { ok: false, status, dropped: true, reason: 'this subscription has expired — turn notifications off and on again' };
  }
  if (status === 401 || status === 403) {
    return { ok: false, status, dropped: false, reason: 'the push service rejected our VAPID identity' };
  }
  if (status === 413) return { ok: false, status, dropped: false, reason: 'the payload is too large (keep it under 4KB)' };
  return { ok: false, status, dropped: false, reason: \`the push service returned \${status}\` };
}

// notifyAll / notifyUser — what FEATURE code calls. Deliberately fire-and-
// forget-safe: a notification that cannot be delivered must never fail the
// action that triggered it.
export async function notifyAll(payload: { title: string; body?: string; url?: string; tag?: string }, origin: string): Promise<number> {
  const rows = await db.select().from(pushSubscriptions);
  const results = await Promise.all(rows.map((r) => sendPush(r, payload, origin).catch(() => ({ ok: false } as PushResult))));
  return results.filter((r) => r.ok).length;
}

export async function notifyUser(userId: number, payload: { title: string; body?: string; url?: string; tag?: string }, origin: string): Promise<number> {
  const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  const results = await Promise.all(rows.map((r) => sendPush(r, payload, origin).catch(() => ({ ok: false } as PushResult))));
  return results.filter((r) => r.ok).length;
}

/* --------------------------------- routes --------------------------------- */

function originOf(req: Request): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return \`\${proto}://\${host}\`;
}

// PUBLIC: the browser needs the VAPID public key BEFORE it can subscribe, and
// the sign-in page is allowed to know whether push exists at all. Nothing here
// is a secret — the public key is handed to every push service anyway.
export const pushPublicRoutes = Router();

pushPublicRoutes.get('/api/push/config', async (req: Request, res: Response) => {
  try {
    const vapid = await getVapid(originOf(req));
    const [{ count }] = await db.select({ count: sql<number>\`count(*)::int\` }).from(pushSubscriptions);
    res.json({ configured: true, publicKey: vapid.publicKey, subscriptions: count ?? 0 });
  } catch (err) {
    res.json({ configured: false, reason: (err as Error).message, publicKey: null, subscriptions: 0 });
  }
});

// AUTHENTICATED: subscribing ties a device to this install.
export const pushRoutes = Router();

const SubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

// Validate the browser's keys BEFORE storing them: a malformed row otherwise
// fails on every notification forever, and the failure surfaces long after the
// subscribe that caused it.
function keysAreWellFormed(p256dh: string, auth: string): boolean {
  try {
    const pub = fromB64url(p256dh);
    const secret = fromB64url(auth);
    return pub.length === 65 && pub[0] === 0x04 && secret.length === 16;
  } catch {
    return false;
  }
}

pushRoutes.post('/api/push/subscribe', async (req: Request, res: Response) => {
  const parsed = SubscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ code: 'INVALID_SUBSCRIPTION' }); return; }
  const { endpoint, keys } = parsed.data;
  if (!keysAreWellFormed(keys.p256dh, keys.auth)) {
    res.status(400).json({ code: 'INVALID_KEYS', message: 'p256dh must be a 65-byte P-256 point and auth a 16-byte secret' });
    return;
  }
  const userId = signedInUserId(req);
  // Keyed on the ENDPOINT: the same browser re-subscribing updates its row
  // (including who is signed in now), it does not accumulate duplicates.
  await db.insert(pushSubscriptions)
    .values({
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userId,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        p256dh: keys.p256dh,
        auth: keys.auth,
        userId,
        lastSeenAt: new Date(),
      },
    });
  res.status(201).json({ ok: true });
});

pushRoutes.post('/api/push/unsubscribe', async (req: Request, res: Response) => {
  const endpoint = String(req.body?.endpoint || '');
  if (!endpoint) { res.status(400).json({ code: 'ENDPOINT_REQUIRED' }); return; }
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  res.json({ ok: true });
});

// A test send. Looked up by ENDPOINT, not by user: "send a test to THIS
// browser" is the question being asked, and answering it from the signed-in
// user's rows produces the contradiction where the test succeeds on a device
// that is not subscribed.
pushRoutes.post('/api/push/test', async (req: Request, res: Response) => {
  const endpoint = String(req.body?.endpoint || '');
  if (!endpoint) { res.status(400).json({ code: 'ENDPOINT_REQUIRED', message: 'This browser has no push subscription — turn notifications on first.' }); return; }
  const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).limit(1);
  if (!rows[0]) {
    res.status(404).json({ code: 'NOT_SUBSCRIBED', resubscribe: true, message: 'The server has no subscription for this browser — turn notifications off and on again.' });
    return;
  }
  const out = await sendPush(rows[0], {
    title: 'Notifications are working',
    body: 'This is a test from your app.',
    url: '/',
    tag: 'push-test',
  }, originOf(req));
  if (out.ok) { res.json({ ok: true }); return; }
  res.status(502).json({ code: 'PUSH_FAILED', resubscribe: out.dropped, message: out.reason || 'The push service did not accept the message.' });
});
`;
}

/* ---------------------------------------------------------------------------
   public/install.js — the install invitation.
   --------------------------------------------------------------------------- */
//
// This REPLACES the floating "Install app" pill that used to be welded to the
// bottom-right of every screen (operator: "the install app shouldn't always be
// present"). A permanent button is a permanent ask; an invitation is asked once
// and then respected.
//
// The rules:
//   • ask once, as a modal, a few seconds after the app is usable — never
//     during first paint, where it reads as a popup ad;
//   • "Not now" is remembered for 30 days, then the invitation may return once
//     (installing is genuinely better on a phone, and people change their mind);
//   • the answer is always reachable from Notifications, so dismissing costs
//     nothing;
//   • iOS has no beforeinstallprompt at all — Safari installs only through
//     Share → Add to Home Screen — so there the modal is never shown and the
//     Notifications entry carries the instructions instead.
export function pwaInstallJs() {
  return `'use strict';
/* App install — invitation, not furniture. See scaffold-push.js for why. */
(function () {
  var DISMISS_KEY = 'pp-install-dismissed-at';
  var ASK_AFTER_MS = 4000;          // let the app finish becoming usable first
  var REASK_AFTER_MS = 30 * 86400000;
  var deferred = null;
  var asked = false;

  function standalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
    } catch (e) { return false; }
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function dismissedRecently() {
    try {
      var at = Number(localStorage.getItem(DISMISS_KEY) || 0);
      return at > 0 && (Date.now() - at) < REASK_AFTER_MS;
    } catch (e) { return false; }
  }

  function remember() { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {} }

  // Ask. Uses the platform's styled modal (pp.confirm) — never window.confirm,
  // which looks like the browser is warning you about the site.
  async function invite() {
    if (asked || !deferred || standalone()) return;
    asked = true;
    var yes = false;
    if (window.pp && typeof window.pp.confirm === 'function') {
      yes = await window.pp.confirm(
        'Install this app on your device? It opens in its own window, starts faster, and can send you notifications.',
        { title: 'Install app', okText: 'Install', cancelText: 'Not now' }
      );
    } else {
      // platform.js not loaded (a page that opted out) — do nothing rather than
      // fall back to a browser dialog.
      asked = false;
      return;
    }
    if (yes) { await promptInstall(); } else { remember(); }
  }

  async function promptInstall() {
    if (!deferred) return { ok: false, reason: 'not_available' };
    deferred.prompt();
    var choice = null;
    try { choice = await deferred.userChoice; } catch (e) {}
    deferred = null;
    if (!choice || choice.outcome !== 'accepted') remember();
    notify();
    return { ok: !!choice && choice.outcome === 'accepted' };
  }

  var listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(state()); } catch (e) {} }); }
  function state() {
    return {
      installed: standalone(),
      available: !!deferred,
      ios: isIos(),
      // On iOS there is nothing to click — the only path is Safari's own Share
      // menu, so the UI has to say so instead of offering a dead button.
      manualOnly: isIos() && !standalone(),
    };
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    notify();
    if (!dismissedRecently()) setTimeout(invite, ASK_AFTER_MS);
  });
  window.addEventListener('appinstalled', function () { deferred = null; notify(); });

  window.pp = window.pp || {};
  window.pp.install = {
    state: state,
    prompt: promptInstall,   // the Notifications entry calls this
    invite: invite,
    onChange: function (fn) { listeners.push(fn); return state(); },
  };
})();
`;
}

/* ---------------------------------------------------------------------------
   public/push.js — the client half of notifications + the install entry.
   --------------------------------------------------------------------------- */
//
// Renders into any element with id "pp-notifications" (the platform console's
// Notifications card injects one). Deliberately three independent lines rather
// than one opaque "push is off", because the three preconditions fail in three
// different places: the browser can't do it, the OS refused, or the server has
// no subscription for this browser.
export function pushClientJs() {
  return `'use strict';
/* Notifications + install — the per-DEVICE settings panel. */
(function () {
  var MOUNT_ID = 'pp-notifications';

  function b64ToU8(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function currentSubscription() {
    if (!supported()) return null;
    var reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  async function subscribe(publicKey) {
    var reg = await navigator.serviceWorker.ready;
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed for this site.');
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
  }

  async function api(path, body) {
    var res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.message) || ('Request failed (' + res.status + ')'));
      err.resubscribe = !!(data && data.resubscribe);
      throw err;
    }
    return data;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function render(mount) {
    mount.innerHTML = '';
    var cfg = null;
    try { cfg = await api('/api/push/config'); } catch (e) { cfg = null; }
    var sub = null;
    try { sub = await currentSubscription(); } catch (e) {}
    var inst = (window.pp && window.pp.install) ? window.pp.install.state() : { installed: false, available: false, manualOnly: false };

    // --- install ---------------------------------------------------------
    // Always here, whether or not the one-time modal was dismissed: this is the
    // "always available in the profile/notifications area" half of the ask.
    var installRow = el('div', 'pp-row');
    if (inst.installed) {
      installRow.appendChild(el('p', 'pp-muted', 'Running as an installed app.'));
    } else if (inst.manualOnly) {
      installRow.appendChild(el('p', 'pp-muted',
        'On iPhone and iPad, install with Share → Add to Home Screen. Notifications work only once it is installed (iOS 16.4 or newer).'));
    } else if (inst.available) {
      var b = el('button', 'btn', 'Install app');
      b.type = 'button';
      b.addEventListener('click', function () { window.pp.install.prompt().then(function () { render(mount); }); });
      installRow.appendChild(b);
      installRow.appendChild(el('p', 'pp-muted', 'Opens in its own window and starts faster.'));
    } else {
      installRow.appendChild(el('p', 'pp-muted', 'This browser has not offered an install for this app. Chrome, Edge and Android offer it once the app has been used a little.'));
    }
    mount.appendChild(installRow);

    // --- notifications ---------------------------------------------------
    var row = el('div', 'pp-row');
    if (!supported()) {
      row.appendChild(el('p', 'pp-muted', 'This browser cannot receive push notifications.'));
      mount.appendChild(row);
      return;
    }
    if (Notification.permission === 'denied') {
      row.appendChild(el('p', 'pp-muted', 'Notifications are blocked for this site. Allow them in your browser\\'s site settings, then reload.'));
      mount.appendChild(row);
      return;
    }
    if (!cfg || !cfg.configured || !cfg.publicKey) {
      row.appendChild(el('p', 'pp-muted', 'The server cannot send notifications yet' + (cfg && cfg.reason ? ': ' + cfg.reason : '.')));
      mount.appendChild(row);
      return;
    }

    // Self-heal: "on for this device" was read from the BROWSER, so it could
    // say yes while the server had no row. Re-registering is an idempotent
    // upsert keyed on the endpoint, so the disagreement is unrepresentable
    // rather than merely unlikely.
    if (sub) { api('/api/push/subscribe', sub.toJSON()).catch(function () {}); }

    if (sub) {
      var off = el('button', 'btn subtle', 'Turn off for this device');
      off.type = 'button';
      off.addEventListener('click', async function () {
        off.disabled = true;
        try {
          var endpoint = sub.endpoint;
          await sub.unsubscribe();
          await api('/api/push/unsubscribe', { endpoint: endpoint });
        } catch (e) {
          window.pp.alert('Could not turn notifications off: ' + e.message);
        }
        render(mount);
      });
      var test = el('button', 'btn subtle', 'Send a test');
      test.type = 'button';
      test.addEventListener('click', async function () {
        test.disabled = true;
        try {
          await api('/api/push/test', { endpoint: sub.endpoint });
          window.pp.alert('Test sent — it should arrive on this device within a few seconds.', { title: 'Test sent' });
        } catch (e) {
          window.pp.alert(e.resubscribe
            ? 'This device\\'s subscription is no longer valid — turn notifications off, then on again.'
            : ('The test did not go through: ' + e.message), { title: 'Test failed' });
        }
        test.disabled = false;
        render(mount);
      });
      row.appendChild(off);
      row.appendChild(test);
    } else {
      var on = el('button', 'btn', 'Turn on for this device');
      on.type = 'button';
      on.addEventListener('click', async function () {
        on.disabled = true;
        try {
          var s = await subscribe(cfg.publicKey);
          await api('/api/push/subscribe', s.toJSON());
        } catch (e) {
          window.pp.alert('Could not turn on notifications: ' + e.message);
        }
        render(mount);
      });
      row.appendChild(on);
    }
    mount.appendChild(row);

    var note = el('p', 'pp-muted',
      (sub ? 'On for this device. ' : '')
      + cfg.subscriptions + ' device' + (cfg.subscriptions === 1 ? '' : 's') + ' subscribed in total. '
      + 'This is a per-device setting — turn it on separately on your phone and your computer.');
    mount.appendChild(note);
  }

  function mountNow() {
    var mount = document.getElementById(MOUNT_ID);
    if (mount) render(mount);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountNow);
  else mountNow();

  window.pp = window.pp || {};
  window.pp.notifications = { refresh: mountNow };
})();
`;
}

/* ---------------------------------------------------------------------------
   The service-worker half: receive and open.
   --------------------------------------------------------------------------- */
//
// Appended to the generated sw.js. Two handlers, both short, both load-bearing:
// without `push` the message is discarded, and without `notificationclick` a
// tap opens nothing (or a second copy of the app).
export function pushServiceWorkerJs() {
  return `
/* ---- Web Push ---------------------------------------------------------- */
// userVisibleOnly is enforced by the browser: a push that shows no notification
// costs the site its permission. So this ALWAYS shows something, even when the
// payload is missing or unparseable.
self.addEventListener('push', function (event) {
  var data = { title: 'Notification', body: '', url: '/' };
  try { if (event.data) data = Object.assign(data, event.data.json()); } catch (e) {
    try { data.body = event.data ? event.data.text() : ''; } catch (e2) {}
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Notification', {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  }));
});

// Focus an EXISTING window when there is one — opening a new tab every time is
// how a notification tap ends up with nine copies of the app.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if ('focus' in c) { c.navigate ? c.navigate(target) : null; return c.focus(); }
    }
    return clients.openWindow ? clients.openWindow(target) : undefined;
  }));
});
`;
}

/* ---------------------------------------------------------------------------
   The Notifications card, injected into the platform console page.
   --------------------------------------------------------------------------- */
export function pushAdminMarkup() {
  return `
  <div class="card sect">
    <div class="card-h"><h3>Notifications &amp; install</h3></div>
    <div class="card-b">
      <p class="note">Install this app on the device you are using, and choose whether it may send you
      notifications. Both are <strong>per device</strong> — your phone and your computer are configured
      separately, so turning notifications on here does not turn them on anywhere else.</p>
      <div id="pp-notifications"></div>
    </div>
  </div>`;
}

export const PUSH_CSS = `
/* Notifications / install panel — plain rows, wraps at 360px. */
#pp-notifications .pp-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
#pp-notifications .pp-row .btn { min-height: 44px; }
#pp-notifications .pp-muted { color: var(--slate, #5a6b81); font-size: .875rem; margin: 0; flex: 1 1 16rem; min-width: 0; }
`;
