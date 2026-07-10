// Mock2 admin-queue helpers (mock2_queue_items, in mock2.db).
//
// The queue is the durable "an admin needs to look at this" store; a bell
// notification (lib/notifications, main DB) is only the attention-getter that
// points at it. Phase M1 uses exactly one kind — `renewal_failed` — raised
// when a parent domain's verification/probe-cert issuance fails, so Let's
// Encrypt rate limits and DNS misconfig surface instead of silently 502ing
// (ADR-009 watch-item). The full queue UI arrives in M8; until then these rows
// sit behind the notifications bell.
//
// Native import (better-sqlite3 via getMock2Db) — reached only on an enabled
// host through the gated router, never from tests.

import { getMock2Db } from './db.js';
import { AWAITING_ADMIN_QUEUE_KINDS } from './audit-logic.js';

// mock2_queue_items.project_id is NOT NULL, but a parent-domain failure has no
// project (none exist until M2). Foreign keys are OFF on the mock2 handle, so a
// 0 sentinel is a safe "no project" marker; ref_table/ref_id carry the real
// target.
const NO_PROJECT = 0;

// raiseQueueItem — UPSERT on dedupe_key so a domain that keeps failing occupies
// one row, mirroring the notification dedupe. Re-opens a previously resolved
// row (a fresh failure deserves attention again).
export function raiseQueueItem({ kind, dedupe_key, ref_table = null, ref_id = null, detail = null, project_id = NO_PROJECT }) {
  const db = getMock2Db();
  const existing = dedupe_key
    ? db.prepare(`SELECT id FROM mock2_queue_items WHERE dedupe_key = ?`).get(dedupe_key)
    : null;
  if (existing) {
    db.prepare(`
      UPDATE mock2_queue_items
         SET detail = ?, status = 'open', ref_table = ?, ref_id = ?,
             raised_at = datetime('now'),
             resolved_by = NULL, resolved_at = NULL, resolution = NULL
       WHERE id = ?
    `).run(detail, ref_table, ref_id, existing.id);
    return existing.id;
  }
  const r = db.prepare(`
    INSERT INTO mock2_queue_items (project_id, kind, ref_table, ref_id, detail, status, dedupe_key, raised_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, datetime('now'))
  `).run(project_id, kind, ref_table, ref_id, detail, dedupe_key);
  return r.lastInsertRowid;
}

// resolveQueueItem — mark the deduped row resolved when the condition clears
// (e.g. the domain verifies on retry). No-op when absent.
export function resolveQueueItem(dedupe_key, { resolution = 'recovered', resolvedBy = null } = {}) {
  if (!dedupe_key) return false;
  const r = getMock2Db().prepare(`
    UPDATE mock2_queue_items
       SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?, resolution = ?
     WHERE dedupe_key = ? AND status <> 'resolved'
  `).run(resolvedBy, resolution, dedupe_key);
  return r.changes > 0;
}

export function listOpenQueueItems({ kind = null } = {}) {
  const db = getMock2Db();
  if (kind) {
    return db.prepare(`SELECT * FROM mock2_queue_items WHERE status = 'open' AND kind = ? ORDER BY raised_at DESC`).all(kind);
  }
  return db.prepare(`SELECT * FROM mock2_queue_items WHERE status = 'open' ORDER BY raised_at DESC`).all();
}

// ---- M8: the admin queue page (the queue-of-items view) ----
//
// The admin's real object (03-data-model.md / brief §admin view). Until M8 these
// rows sat behind the notifications bell; the queue PAGE reads them here with
// project/kind/status filters. NO_PROJECT (0) rows are host-level (a parent-domain
// renewal failure) — a project filter of 0 finds them.

export function getQueueItem(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_queue_items WHERE id = ?`).get(Number(id));
}

// List queue items with optional filters. Newest first; open items float above
// resolved ones so the page shows actionable work first regardless of raised_at.
export function listQueueItems({ projectId = null, kind = null, status = null, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (projectId != null) { where.push('project_id = ?'); args.push(Number(projectId)); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (status) { where.push('status = ?'); args.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getMock2Db()
    .prepare(
      `SELECT * FROM mock2_queue_items ${clause}
         ORDER BY (status = 'open') DESC, (status = 'in_progress') DESC, raised_at DESC
         LIMIT ?`,
    )
    .all(...args, Number(limit));
}

// Open-item counts by kind across the whole module — the queue page's summary
// tiles + the notifications-bell badge share this.
export function queueCounts() {
  const rows = getMock2Db()
    .prepare(`SELECT kind, COUNT(*) AS n FROM mock2_queue_items WHERE status IN ('open','in_progress') GROUP BY kind`)
    .all();
  const byKind = {};
  let total = 0;
  for (const r of rows) { byKind[r.kind] = r.n; total += r.n; }
  return { total, byKind };
}

// The number of open ADMIN-attention queue items for a project — the queue half
// of the derived "awaiting admin" status (03-data-model.md). Excludes `drift`
// (its own status) and `flag` (the `!` overlay).
export function countAwaitingAdminItems(projectId) {
  const placeholders = AWAITING_ADMIN_QUEUE_KINDS.map(() => '?').join(',');
  return getMock2Db()
    .prepare(
      `SELECT COUNT(*) AS n FROM mock2_queue_items
        WHERE project_id = ? AND status IN ('open','in_progress')
          AND kind IN (${placeholders})`,
    )
    .get(Number(projectId), ...AWAITING_ADMIN_QUEUE_KINDS).n;
}

// Is there an OPEN drift item for a project? Drives the `drift` derived status +
// the "update available" banner (ADR-003).
export function hasOpenDrift(projectId) {
  const r = getMock2Db()
    .prepare(`SELECT 1 FROM mock2_queue_items WHERE project_id = ? AND kind = 'drift' AND status IN ('open','in_progress') LIMIT 1`)
    .get(Number(projectId));
  return !!r;
}

// Set a queue item's status by id (admin action on the page). resolved/dismissed
// stamp who + when + a note; reopening clears them.
export function setQueueItemStatus(id, status, { resolvedBy = null, resolution = null } = {}) {
  const db = getMock2Db();
  if (status === 'resolved' || status === 'dismissed') {
    db.prepare(
      `UPDATE mock2_queue_items
         SET status = ?, resolved_by = ?, resolved_at = datetime('now'), resolution = ?
       WHERE id = ?`,
    ).run(status, resolvedBy == null ? null : Number(resolvedBy), resolution, Number(id));
  } else {
    db.prepare(
      `UPDATE mock2_queue_items
         SET status = ?, resolved_by = NULL, resolved_at = NULL, resolution = NULL
       WHERE id = ?`,
    ).run(status, Number(id));
  }
  return getQueueItem(id);
}
