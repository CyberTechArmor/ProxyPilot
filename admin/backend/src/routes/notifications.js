// Notifications API.
//
// All routes are admin-gated.  No sudo gate even on mutations —
// dismissing a bell entry is operator-driven housekeeping, not a
// destructive action against shared state.

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  listNotifications, unreadCount, markRead, markAllRead, dismiss,
} from '../lib/notifications.js';
import {
  listChannelsPublic, getChannelPublic, upsertChannel, deleteChannel,
} from '../lib/notification-channels.js';
import { testChannel } from '../lib/notification-dispatch.js';
import { CHANNEL_KINDS } from '../lib/notification-logic.js';
import { pushStatus, sendPushTo, buildPushPayload } from '../lib/web-push.js';
import {
  saveSubscription, deleteSubscription, listSubscriptions,
  publicSubscriptionShape, markDelivered, markFailed,
} from '../lib/push-subscriptions.js';
import { validatePushKeys } from '../lib/web-push-logic.js';

export const notificationsRouter = Router();

function publicShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    level: row.level,
    title: row.title,
    body: row.body || null,
    source: row.source,
    source_id: row.source_id || null,
    seen_count: row.seen_count,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    read_at: row.read_at || null,
    dismissed_at: row.dismissed_at || null,
  };
}

// GET /api/notifications — bell-dropdown payload.
//   ?include_dismissed=1 surfaces history for an audit view.
notificationsRouter.get('/', requireAdmin, (req, res) => {
  const includeDismissed = String(req.query?.include_dismissed || '') === '1';
  const rows = listNotifications({ limit: 100, includeDismissed });
  res.json({
    notifications: rows.map(publicShape),
    unread_count: unreadCount(),
  });
});

// GET /api/notifications/unread-count — small endpoint for the
// bell badge to poll without paying the full list query cost.
notificationsRouter.get('/unread-count', requireAdmin, (_req, res) => {
  res.json({ unread_count: unreadCount() });
});

notificationsRouter.post('/:id/read', requireAdmin, (req, res) => {
  const ok = markRead(req.params.id);
  if (!ok) return res.status(404).json({ error: 'notification not found or already read' });
  res.json({ ok: true });
});

notificationsRouter.post('/mark-all-read', requireAdmin, (_req, res) => {
  const updated = markAllRead();
  res.json({ ok: true, updated });
});

notificationsRouter.delete('/:id', requireAdmin, (req, res) => {
  const ok = dismiss(req.params.id);
  if (!ok) return res.status(404).json({ error: 'notification not found' });
  res.json({ ok: true });
});

// ---- Out-of-band notification channels (SMTP + SMS) ----
//
// The admin-configurable "standard connections" that fan build-complete alerts
// (and any future producer) beyond the in-app bell. All admin-gated. Secrets are
// never returned — the public shape only reports whether one is stored.

function assertKind(req, res) {
  const kind = String(req.params.kind || '');
  if (!CHANNEL_KINDS.includes(kind)) {
    res.status(404).json({ error: `unknown channel kind ${JSON.stringify(kind)}` });
    return null;
  }
  return kind;
}

notificationsRouter.get('/channels', requireAdmin, (_req, res) => {
  res.json({ channels: listChannelsPublic() });
});

// Create/replace a channel's config. Body: { enabled, config, secret? }. Omitting
// `secret` keeps the stored one; '' clears it. A save always clears the cached
// test verdict (the new config must be re-tested).
notificationsRouter.put('/channels/:kind', requireAdmin, (req, res) => {
  const kind = assertKind(req, res);
  if (!kind) return undefined;
  const { enabled = false, config = {}, secret } = req.body || {};
  const r = upsertChannel(kind, { enabled, config, secret });
  if (!r.ok) return res.status(400).json({ error: r.error });
  return res.json({ channel: r.channel });
});

notificationsRouter.delete('/channels/:kind', requireAdmin, (req, res) => {
  const kind = assertKind(req, res);
  if (!kind) return undefined;
  deleteChannel(kind);
  return res.json({ ok: true, channel: getChannelPublic(kind) });
});

// Send a live test through a channel and report the verdict (also cached on the
// channel row so the list reflects it).
notificationsRouter.post('/channels/:kind/test', requireAdmin, async (req, res) => {
  const kind = assertKind(req, res);
  if (!kind) return undefined;
  const r = await testChannel(kind);
  return res.json({ ok: !!r.ok, error: r.ok ? null : (r.error || 'test failed'), channel: getChannelPublic(kind) });
});

// ---- Web Push (VAPID) ----
//
// Push is per-BROWSER, not per-install: there is no shared account to
// configure, so unlike SMTP/SMS these routes are about the caller's OWN device.
// They are still admin-gated because everything on this router is — ProxyPilot
// notifications are operator information (a failed backup, a drifted port), and
// there is no non-admin audience for them.

// The public key a browser needs to subscribe. Safe to hand out — that is its
// entire purpose (it is baked into every subscription and travels to the push
// service). `configured:false` carries the reason so a misconfiguration is
// diagnosable from the UI instead of presenting as silence.
notificationsRouter.get('/push/config', requireAdmin, async (_req, res) => {
  res.json(await pushStatus());
});

// Record this browser's subscription. The three fields come straight from
// PushSubscription.toJSON(); the endpoint is the identity, so re-subscribing
// updates in place rather than adding a duplicate that double-delivers.
notificationsRouter.post('/push/subscribe', requireAdmin, (req, res) => {
  const { endpoint, keys } = req.body || {};
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'endpoint and keys.p256dh / keys.auth are required' });
  }
  let url;
  try { url = new URL(String(endpoint)); } catch { return res.status(400).json({ error: 'endpoint must be a URL' }); }
  if (url.protocol !== 'https:') {
    return res.status(400).json({ error: 'push endpoints are always https' });
  }
  // Validate the key shapes HERE rather than discovering them at send time —
  // a malformed subscription otherwise sits in the table failing forever.
  const check = validatePushKeys({ p256dh, auth });
  if (!check.ok) return res.status(400).json({ error: check.error });

  const row = saveSubscription({
    userId: req.user?.id ?? null,
    endpoint: String(endpoint),
    p256dh: String(p256dh),
    auth: String(auth),
    userAgent: String(req.get('user-agent') || '').slice(0, 300),
  });
  return res.json({ ok: true, subscription: publicSubscriptionShape(row) });
});

// Forget this browser. Idempotent: unsubscribing twice is not an error, and the
// browser may already have discarded its side.
notificationsRouter.post('/push/unsubscribe', requireAdmin, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  const removed = deleteSubscription(String(endpoint));
  return res.json({ ok: true, removed });
});

// Push a test notification to this browser only, so an operator can confirm the
// whole chain — keys, subscription, service worker, OS permission — without
// waiting for a build to fail.
notificationsRouter.post('/push/test', requireAdmin, async (req, res) => {
  const endpoint = req.body?.endpoint;
  const subs = listSubscriptions({ userId: req.user?.id ?? null });
  const target = endpoint ? subs.find((s) => s.endpoint === String(endpoint)) : subs[0];
  if (!target) return res.status(404).json({ error: 'this browser is not subscribed' });

  const r = await sendPushTo(target, buildPushPayload({
    title: 'ProxyPilot notifications are working',
    body: 'This is a test. Build results and alerts will arrive like this.',
    url: '/notifications',
    level: 'info',
    tag: 'pp-test',
  }));
  if (r.ok) { markDelivered(target.endpoint); return res.json({ ok: true }); }
  // A dead subscription discovered by a TEST is still dead — clean it up so the
  // operator can simply subscribe again.
  if (r.drop) deleteSubscription(target.endpoint);
  else markFailed(target.endpoint, r.reason);
  return res.status(502).json({ ok: false, error: r.reason || 'push failed', resubscribe: !!r.drop });
});
