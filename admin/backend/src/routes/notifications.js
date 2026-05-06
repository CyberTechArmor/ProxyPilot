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
