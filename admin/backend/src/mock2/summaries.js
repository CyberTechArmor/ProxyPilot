// Mock2 adaptive-summary data access (mock2_summaries, in mock2.db) — Phase M9.
// The summary is versioned + diffable (03-data-model.md): one row per version,
// UNIQUE (project_id, version), each stamping the change-record high-water mark it
// was derived from (derived_from_change_seq — NOT chat). M9 is the first phase to
// WRITE this table (it already existed from migration 503).
//
// The pure decisions (the qualifying-change trigger, the version bump, the diff)
// live in summary-logic.js so they unit-test without better-sqlite3 (stub-first,
// risk R9); this module is the thin native half. Native (getMock2Db) — reached
// only on an enabled host through the gated router.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

// The newest summary version for a project, or undefined when none exists yet.
export function getLatestSummary(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_summaries WHERE project_id = ? ORDER BY version DESC LIMIT 1`)
    .get(Number(projectId));
}

// All summary versions for a project, newest first (the diffable history).
export function listSummaries(projectId, { limit = 100 } = {}) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_summaries WHERE project_id = ? ORDER BY version DESC LIMIT ?`)
    .all(Number(projectId), Number(limit));
}

export function getSummaryVersion(projectId, version) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_summaries WHERE project_id = ? AND version = ?`)
    .get(Number(projectId), Number(version));
}

// Insert a new summary version. The version + derived_from_change_seq are computed
// by the caller (summary.js) through the pure summary-logic; this is the append.
// Wrapped so a concurrent double-insert on the same (project, version) collapses
// rather than throwing on the UNIQUE index.
export function insertSummary({ projectId, version, bodyMd, derivedFromChangeSeq }) {
  const db = getMock2Db();
  const info = db
    .prepare(
      `INSERT INTO mock2_summaries (project_id, version, body_md, derived_from_change_seq, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(Number(projectId), Number(version), String(bodyMd || ''), Number(derivedFromChangeSeq || 0), nowIso());
  return db.prepare(`SELECT * FROM mock2_summaries WHERE id = ?`).get(info.lastInsertRowid);
}
