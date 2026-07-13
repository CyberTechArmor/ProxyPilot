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
