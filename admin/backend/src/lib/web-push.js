// Web Push — the network half. The crypto and header construction are in
// web-push-logic.js (pure, checked against the RFCs' own test vectors); this
// module owns config, the HTTP request, and what to do with the answer.
//
// Best-effort by construction, like every other notification channel: a build
// finishing must never be derailed by a push service having a bad afternoon.

import {
  encryptPayload, vapidClaims, signVapidJwt, buildPushHeaders,
  classifyPushResponse, validateVapidConfig, MAX_PAYLOAD_BYTES,
} from './web-push-logic.js';
// The subscription STORE is imported lazily inside the functions that need it.
// sendPushTo and pushStatus's validation are pure of the database, and a
// module-level import would drag better-sqlite3 in and make the whole module
// untestable on a host without it (risk R9) — which is exactly the module you
// most want a test to exercise against a real HTTP server.
async function store() {
  return import('./push-subscriptions.js');
}

// A push service that has not answered in 10s is not going to. The caller is
// usually a build finishing, so a hung request must not hold the worker.
const REQUEST_TIMEOUT_MS = 10_000;

export function vapidConfig() {
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || '',
  };
}

// pushStatus — what the admin UI shows. Deliberately explains WHY it is off
// rather than just reporting a boolean; "push is disabled" with no reason sends
// people to the wrong file.
export async function pushStatus() {
  const cfg = vapidConfig();
  const v = validateVapidConfig(cfg);
  let subscriptions = 0;
  if (v.ok) {
    try { subscriptions = (await store()).countSubscriptions(); } catch { subscriptions = 0; }
  }
  return {
    configured: v.ok,
    reason: v.ok ? null : v.reason,
    public_key: v.ok ? cfg.publicKey : null,
    subject: cfg.subject || null,
    subscriptions,
  };
}

export function pushConfigured() {
  return validateVapidConfig(vapidConfig()).ok;
}

// sendPushTo — one subscription, one message. Returns { ok, drop, reason }.
// `drop` means the browser is gone and the row should be deleted; the caller
// does the deleting so a test send can report without destroying anything.
export async function sendPushTo(subscription, payload, { ttlSeconds = 6 * 3600, urgency = 'normal' } = {}) {
  const cfg = vapidConfig();
  const valid = validateVapidConfig(cfg);
  if (!valid.ok) return { ok: false, drop: false, reason: valid.reason };

  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
    return { ok: false, drop: false, reason: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
  }

  let body;
  let headers;
  try {
    body = encryptPayload({
      payload: text,
      uaPublicKey: subscription.p256dh,
      authSecret: subscription.auth,
    });
    const jwt = signVapidJwt({
      claims: vapidClaims({
        endpoint: subscription.endpoint,
        subject: cfg.subject,
        nowSeconds: Date.now() / 1000,
      }),
      privateKey: cfg.privateKey,
    });
    headers = buildPushHeaders({ jwt, publicKey: cfg.publicKey, bodyLength: body.length, ttlSeconds, urgency });
  } catch (err) {
    // A malformed subscription is permanently useless — drop it rather than
    // retry a row that can never succeed.
    return { ok: false, drop: true, reason: err?.message || 'could not build the push request' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST', headers, body, signal: controller.signal,
    });
    return { ...classifyPushResponse(res.status), status: res.status };
  } catch (err) {
    // A network error is transient by assumption — never drop a subscription
    // because this host briefly lost DNS.
    return { ok: false, drop: false, retry: true, reason: err?.name === 'AbortError' ? 'push service timed out' : (err?.message || 'network error') };
  } finally {
    clearTimeout(timer);
  }
}

// buildPushPayload — what the service worker receives. Kept small on purpose:
// the ceiling is ~3993 bytes and a truncated payload is an undecryptable one.
export function buildPushPayload({ title, body, url = '/', level = 'info', tag = null }) {
  const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
  return {
    title: clip(title, 120),
    body: clip(body, 300),
    url,
    level,
    // Tagging lets a re-notification REPLACE the previous one rather than stack
    // — three failed builds for one project should be one line, not three.
    tag: tag || `pp-${level}`,
  };
}

// sendPushToAll — fan a notification out to every subscribed browser.
//
// Dead subscriptions (404/410) are deleted as they are discovered: a browser
// that was uninstalled would otherwise be retried on every notification
// forever. Everything else is recorded and kept.
export async function sendPushToAll(message, { userId = null } = {}) {
  if (!pushConfigured()) return { sent: 0, failed: 0, dropped: 0, skipped: 'not configured' };
  const { listSubscriptions, deleteSubscription, markDelivered, markFailed } = await store();
  const subs = listSubscriptions(userId == null ? {} : { userId });
  if (!subs.length) return { sent: 0, failed: 0, dropped: 0 };

  const payload = buildPushPayload(message);
  let sent = 0;
  let failed = 0;
  let dropped = 0;

  // Sequential rather than parallel: a handful of subscriptions is normal and
  // a burst of concurrent requests to one push service invites a 429.
  for (const sub of subs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await sendPushTo(sub, payload);
    if (r.ok) { sent += 1; markDelivered(sub.endpoint); continue; }
    if (r.drop) {
      dropped += 1;
      deleteSubscription(sub.endpoint);
      console.log(`[push] dropped a dead subscription (${r.reason})`);
      continue;
    }
    failed += 1;
    markFailed(sub.endpoint, r.reason);
    console.warn(`[push] delivery failed: ${r.reason}`);
  }
  return { sent, failed, dropped };
}
