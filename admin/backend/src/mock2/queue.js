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
