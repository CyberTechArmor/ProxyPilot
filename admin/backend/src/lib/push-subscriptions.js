// Push subscription store (migration 302). One row per BROWSER that opted in.
//
// A person on a phone and a laptop is two rows with two different sets of
// encryption keys, which is why the endpoint — not the user — is the identity
// here. The same browser re-subscribing (which happens whenever the push
// service rotates its endpoint) must UPDATE its row rather than add a second
// one, or every notification arrives twice.

import { getDb } from '../db.js';

const nowIso = () => new Date().toISOString();

export function publicSubscriptionShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    // The endpoint is a capability URL — anyone holding it can push to that
    // browser (subject to VAPID). Never return it; a truncated hint is enough
    // for an operator to tell two devices apart.
    endpoint_hint: `${String(row.endpoint).slice(0, 40)}…`,
    user_agent: row.user_agent || null,
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
    last_error: row.last_error || null,
    fail_count: row.fail_count ?? 0,
  };
}

export function saveSubscription({ userId, endpoint, p256dh, auth, userAgent = null }) {
  const db = getDb();
  // ON CONFLICT keeps the row's id (and therefore any history) while taking the
  // fresh keys — a re-subscribe can rotate p256dh/auth for the same endpoint.
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = excluded.user_agent,
      last_error = NULL,
      fail_count = 0
  `).run(userId ?? null, String(endpoint), String(p256dh), String(auth), userAgent, nowIso());
  return db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(String(endpoint));
}

export function deleteSubscription(endpoint) {
  return getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint)).changes > 0;
}

export function listSubscriptions({ userId = null } = {}) {
  const db = getDb();
  return userId == null
    ? db.prepare('SELECT * FROM push_subscriptions ORDER BY id').all()
    : db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(Number(userId));
}

export function countSubscriptions() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()?.n ?? 0;
}

export function markDelivered(endpoint) {
  getDb().prepare('UPDATE push_subscriptions SET last_used_at = ?, last_error = NULL, fail_count = 0 WHERE endpoint = ?')
    .run(nowIso(), String(endpoint));
}

// A transient failure is recorded but the row is kept — the push service being
// busy says nothing about whether the browser still exists.
export function markFailed(endpoint, error) {
  getDb().prepare('UPDATE push_subscriptions SET last_error = ?, fail_count = fail_count + 1 WHERE endpoint = ?')
    .run(String(error || '').slice(0, 300), String(endpoint));
}
