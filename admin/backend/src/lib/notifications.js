// Notifications helper.
//
// Backend code that wants to surface something durable to the
// operator (e.g. 'last night's scheduled backup failed', 'S3
// destination unreachable for 12h') calls postNotification() and
// the row lands in the bell dropdown next time the frontend polls.
//
// Dedupe semantics (operator quality of life): a probe that fails
// daily should NOT spawn 30 unread bell entries by the end of the
// month.  Callers that fire periodically pass a stable dedupe_key
// (typically `${source}:${source_id}`) and we UPSERT instead of
// INSERT — same row's last_seen_at + seen_count update, body
// refreshes, but the unread state stays as-is so the operator
// doesn't get spammed for the same underlying issue.

import { v4 as uuid } from 'uuid';
import { getDb } from '../db.js';

const VALID_LEVELS = new Set(['info', 'warning', 'error']);

// postNotification({ level, title, body, source, source_id, dedupe_key })
//
// Returns the row's id (whether newly inserted or UPSERTed onto
// an existing dedupe_key).  Throws on schema-shape errors so a
// typo in `level` fails loudly during development; callers in
// background paths (the cron worker) wrap in try/catch so a
// notification failure doesn't kill the underlying job.
export function postNotification({
  level = 'info',
  title,
  body = null,
  source,
  source_id = null,
  dedupe_key = null,
} = {}) {
  if (!VALID_LEVELS.has(level)) {
    throw new Error(`postNotification: invalid level ${JSON.stringify(level)}`);
  }
  if (typeof title !== 'string' || title.length === 0 || title.length > 256) {
    throw new Error('postNotification: title is required (1-256 chars)');
  }
  if (typeof source !== 'string' || source.length === 0 || source.length > 64) {
    throw new Error('postNotification: source is required (1-64 chars)');
  }

  const db = getDb();
  if (dedupe_key) {
    // UPSERT path: existing row keeps its read state but its
    // body / last_seen_at / seen_count get refreshed.  Surface
    // 'last seen 5m ago, count: 30' on the same row instead of
    // 30 distinct unread entries.
    const existing = db.prepare(
      `SELECT id, read_at, level FROM notifications WHERE dedupe_key = ?`
    ).get(dedupe_key);
    if (existing) {
      db.prepare(`
        UPDATE notifications
        SET level = ?, title = ?, body = ?, source = ?, source_id = ?,
            seen_count = seen_count + 1,
            last_seen_at = CURRENT_TIMESTAMP,
            -- A repeat un-reads the row only when it escalates
            -- to a worse level (e.g. info → error).  An info-
            -- level repeat of an already-read warning shouldn't
            -- re-flag the bell.
            read_at = CASE
              WHEN read_at IS NULL THEN NULL
              WHEN ? = 'error' AND level <> 'error' THEN NULL
              ELSE read_at
            END,
            -- Recovering from dismissed: re-emerges the row.
            -- An operator who dismissed an old failure deserves
            -- to see a fresh occurrence.
            dismissed_at = NULL
        WHERE dedupe_key = ?
      `).run(level, title, body, source, source_id, level, dedupe_key);
      return existing.id;
    }
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO notifications (id, level, title, body, source, source_id, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, level, title, body, source, source_id, dedupe_key);
  return id;
}

// resolveNotification(dedupe_key) — clears a notification when the
// underlying condition recovers.  e.g. the daily S3 probe that
// passed today after failing for a week calls this on success
// and the row is dismissed.  No-op when the key isn't present.
export function resolveNotification(dedupe_key, { reason = 'recovered' } = {}) {
  if (!dedupe_key) return false;
  const r = getDb().prepare(`
    UPDATE notifications
    SET dismissed_at = CURRENT_TIMESTAMP, body = ?
    WHERE dedupe_key = ? AND dismissed_at IS NULL
  `).run(`auto-resolved: ${reason}`, dedupe_key);
  return r.changes > 0;
}

export function listNotifications({ limit = 50, includeDismissed = false } = {}) {
  const where = includeDismissed ? '1=1' : 'dismissed_at IS NULL';
  return getDb().prepare(`
    SELECT * FROM notifications
    WHERE ${where}
    ORDER BY last_seen_at DESC
    LIMIT ?
  `).all(limit);
}

export function unreadCount() {
  return getDb().prepare(
    `SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL`
  ).get().c;
}

export function markRead(id) {
  return getDb().prepare(
    `UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND read_at IS NULL`
  ).run(id).changes > 0;
}

export function markAllRead() {
  return getDb().prepare(
    `UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE read_at IS NULL AND dismissed_at IS NULL`
  ).run().changes;
}

export function dismiss(id) {
  return getDb().prepare(
    `UPDATE notifications SET dismissed_at = CURRENT_TIMESTAMP WHERE id = ? AND dismissed_at IS NULL`
  ).run(id).changes > 0;
}
