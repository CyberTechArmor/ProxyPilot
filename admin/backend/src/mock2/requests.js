// Mock2 request data access (mock2_requests, migration 515). The REQUEST is the
// umbrella "one build ask = one record": the operator submits an ask, and every
// resulting cycle (define → build → halted → resumed → consult → succeeded) is a
// SEGMENT of that request. Change-record numbering, UI history, and log export key on
// the request; cycles stay the internal execution/gate/checkpoint unit.
//
// Native (getMock2Db) — reached only on an enabled host. Additive/new-requests-only:
// pre-existing cycles carry NULL request_id and render as "legacy (pre-request)".
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

// Requests that are still accumulating segments — a cycle attaches to the project's
// latest open one (the build/resume of the same ask joins its define).
const OPEN_STATUSES = ['open'];

export function getRequest(id) {
  if (id == null) return null;
  return getMock2Db().prepare(`SELECT * FROM mock2_requests WHERE id = ?`).get(Number(id));
}

export function listRequestsForProject(projectId, { limit = 200 } = {}) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_requests WHERE project_id = ? ORDER BY id DESC LIMIT ?`)
    .all(Number(projectId), Number(limit));
}

// The project's most recent still-open request id, or null. A fresh build ask opens a
// new one (startBuild); the build + resumes of that ask attach to it.
export function latestOpenRequestId(projectId) {
  const row = getMock2Db()
    .prepare(`SELECT id FROM mock2_requests WHERE project_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
    .get(Number(projectId), ...OPEN_STATUSES);
  return row ? Number(row.id) : null;
}

export function insertRequest({ projectId, instruction, initiatedBy = null, actingAsAdmin = 0, attachments = null, buildMode = 'full' }) {
  const info = getMock2Db()
    .prepare(
      `INSERT INTO mock2_requests (project_id, instruction, status, initiated_by, acting_as_admin, created_at, attachments_json, build_mode)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
    )
    .run(Number(projectId), instruction == null ? null : String(instruction), initiatedBy ?? null, actingAsAdmin ? 1 : 0, nowIso(),
      Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : null,
      buildMode === 'mvp' ? 'mvp' : 'full');
  return getRequest(info.lastInsertRowid);
}

// Set a request's final status (succeeded / failed / abandoned) + stamp finished_at.
// Idempotent-safe: only an open request transitions to a terminal status here.
export function closeRequest(id, status) {
  const row = getRequest(id);
  if (!row) return null;
  getMock2Db()
    .prepare(`UPDATE mock2_requests SET status = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?`)
    .run(String(status), nowIso(), Number(id));
  return getRequest(id);
}

export function publicRequestShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    instruction: row.instruction || null,
    status: row.status,
    initiated_by: row.initiated_by ?? null,
    acting_as_admin: Number(row.acting_as_admin) === 1,
    build_mode: row.build_mode || 'full',
    created_at: row.created_at || null,
    finished_at: row.finished_at || null,
  };
}
