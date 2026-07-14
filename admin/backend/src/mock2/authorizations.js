// Mock2 scoped one-time operational authorizations (migration 514). Distinct from
// constitutional deviations (framework_deviation questions): a deviation changes what
// the app IS allowed to be; an authorization is a single-use, tightly-scoped
// permission to perform ONE operational act (e.g. delete a specific test-artifact
// row) that the build otherwise must not do. The model requests one from inside a
// cycle; an admin grants/denies (optionally appending conditions); it is single-use
// (→ 'used' when injected on resume) and expires with the cycle. Every state change
// is audit-logged by the route + recorded here.
//
// Native (getMock2Db) — reached only on an enabled host through the gated router.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

export function getAuthorization(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_authorizations WHERE id = ?`).get(Number(id));
}

// Open (undecided) authorization requests for a project — what an admin must act on.
export function listOpenAuthorizations(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_authorizations WHERE project_id = ? AND status = 'open' ORDER BY id ASC`)
    .all(Number(projectId));
}

// Granted-but-unused authorizations for a project — what a resume injects (then
// marks 'used'). Single-use is enforced by the 'used' transition.
export function listGrantedUnusedAuthorizations(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_authorizations WHERE project_id = ? AND status = 'granted' ORDER BY id ASC`)
    .all(Number(projectId));
}

export function listAuthorizationsForCycle(cycleId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_authorizations WHERE cycle_id = ? ORDER BY id ASC`)
    .all(Number(cycleId));
}

// The model requested an authorization from inside a cycle. Stored 'open'.
export function insertAuthorization({ projectId, cycleId, scope, reason = null }) {
  const info = getMock2Db()
    .prepare(
      `INSERT INTO mock2_authorizations (project_id, cycle_id, scope, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
    )
    .run(Number(projectId), Number(cycleId), String(scope || ''), reason == null ? null : String(reason), nowIso());
  return getAuthorization(info.lastInsertRowid);
}

// Admin decision. approved → 'granted' (with optional appended conditions); else
// 'denied'. Only an OPEN request can be decided (idempotent-safe).
export function decideAuthorization(id, { approved, conditions = null, by = null } = {}) {
  const row = getAuthorization(id);
  if (!row || row.status !== 'open') return row || null;
  getMock2Db()
    .prepare(
      `UPDATE mock2_authorizations
         SET status = ?, conditions = ?, granted_by = ?, granted_at = ?
       WHERE id = ? AND status = 'open'`,
    )
    .run(approved ? 'granted' : 'denied', conditions == null ? null : String(conditions), by == null ? null : Number(by), nowIso(), Number(id));
  return getAuthorization(id);
}

// Consume a granted authorization (single-use) as it is injected into a resume.
export function markAuthorizationUsed(id) {
  getMock2Db()
    .prepare(`UPDATE mock2_authorizations SET status = 'used', used_at = ? WHERE id = ? AND status = 'granted'`)
    .run(nowIso(), Number(id));
  return getAuthorization(id);
}

// Expire any still-open/granted authorizations for a project that were NOT consumed
// (e.g. superseded by a new blocker). Keeps "expires with the cycle" honest: a stale
// grant can't silently apply to an unrelated later resume.
export function expireStaleAuthorizations(projectId, { keepIds = [] } = {}) {
  const keep = new Set((keepIds || []).map(Number));
  const rows = getMock2Db()
    .prepare(`SELECT id FROM mock2_authorizations WHERE project_id = ? AND status IN ('open','granted')`)
    .all(Number(projectId));
  const db = getMock2Db();
  let n = 0;
  for (const r of rows) {
    if (keep.has(Number(r.id))) continue;
    db.prepare(`UPDATE mock2_authorizations SET status = 'expired' WHERE id = ? AND status IN ('open','granted')`).run(Number(r.id));
    n += 1;
  }
  return n;
}

// Client-safe view for the UI / audit surfaces.
export function publicAuthorizationShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    cycle_id: row.cycle_id,
    scope: row.scope,
    reason: row.reason || null,
    status: row.status,
    conditions: row.conditions || null,
    granted_by: row.granted_by ?? null,
    granted_at: row.granted_at || null,
    used_at: row.used_at || null,
    created_at: row.created_at || null,
  };
}
