// Mock2 cycle data access (mock2_cycles, in mock2.db) — Phase M6. The cycle is
// the unit of build work: one targeted change, the pinned gate battery, a
// checkpoint. The STATE MACHINE + the gate-battery verdict + the estimate are the
// pure cycle-logic.js; this module is the thin better-sqlite3 half.
//
// Native (getMock2Db) — reached only on an enabled host through the gated router.
//
// Terminology (risk R7): the AI build component is the RUNNER; this module stores
// its cycles. Nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

export function getCycle(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_cycles WHERE id = ?`).get(Number(id));
}

export function listCyclesForProject(projectId, { limit = 50 } = {}) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_cycles WHERE project_id = ? ORDER BY id DESC LIMIT ?`)
    .all(Number(projectId), Number(limit));
}

// The most recent cycle for a project (the poll target for the "gates going
// green" view). Includes terminal ones so the UI can show the last result.
export function latestCycle(projectId) {
  return getMock2Db().prepare(`SELECT * FROM mock2_cycles WHERE project_id = ? ORDER BY id DESC LIMIT 1`).get(Number(projectId));
}

// Count a project's live cycles (queued/estimating/running) — the concurrency
// input canStartCycle uses. The lock already forecloses concurrent cycles per
// project, but the count feeds the self-hosted GPU concurrency cap too.
export function countRunningCycles(projectId = null) {
  const db = getMock2Db();
  if (projectId == null) {
    return db.prepare(`SELECT COUNT(*) AS n FROM mock2_cycles WHERE status IN ('queued','estimating','running')`).get().n;
  }
  return db.prepare(`SELECT COUNT(*) AS n FROM mock2_cycles WHERE project_id = ? AND status IN ('queued','estimating','running')`).get(Number(projectId)).n;
}

// Insert a new cycle. Starts at 'estimating' (the route flips it to running or
// refused_quota after the quota check). framework_version_id is THE PIN (ADR-003),
// stamped here and never changed.
export function insertCycle({
  projectId, frameworkVersionId, stage = 'build', instruction,
  initiatedBy, actingAsAdmin = 0, estTokens = null, estCostCents = null, status = 'estimating',
}) {
  const info = getMock2Db()
    .prepare(
      `INSERT INTO mock2_cycles
         (project_id, framework_version_id, stage, status, instruction, initiated_by, acting_as_admin,
          est_tokens, est_cost_cents, used_tokens, used_cost_cents, retries, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
    )
    .run(Number(projectId), Number(frameworkVersionId), stage, status, instruction ?? null, Number(initiatedBy),
      actingAsAdmin ? 1 : 0, estTokens, estCostCents, nowIso());
  return getCycle(info.lastInsertRowid);
}

const WRITABLE = new Set([
  'status', 'current_gate', 'gates_json', 'est_tokens', 'est_cost_cents',
  'used_tokens', 'used_cost_cents', 'retries', 'interrupt_request', 'error',
  'started_at', 'finished_at', 'classifier_outcome', 'trigger_message_id',
]);

export function updateCycle(id, patch = {}) {
  const cols = Object.keys(patch).filter((k) => WRITABLE.has(k));
  if (cols.length === 0) return getCycle(id);
  const set = cols.map((c) => `${c} = ?`).join(', ');
  const vals = cols.map((c) => patch[c]);
  getMock2Db().prepare(`UPDATE mock2_cycles SET ${set} WHERE id = ?`).run(...vals, Number(id));
  return getCycle(id);
}

// Accumulate spend onto a cycle (after each model call, alongside the ledger
// write). Kept a dedicated increment so concurrent-safe += stays a single
// statement (risk R4 — short transactions).
export function addCycleUsage(id, { tokens = 0, costCents = 0 }) {
  getMock2Db()
    .prepare(`UPDATE mock2_cycles SET used_tokens = used_tokens + ?, used_cost_cents = used_cost_cents + ? WHERE id = ?`)
    .run(Math.round(tokens), Math.round(costCents), Number(id));
  return getCycle(id);
}

// Set the interrupt request on a running cycle (honored at the next step
// boundary by the runner). Idempotent.
export function setInterrupt(id, interruptRequest) {
  getMock2Db().prepare(`UPDATE mock2_cycles SET interrupt_request = ? WHERE id = ?`).run(interruptRequest, Number(id));
  return getCycle(id);
}

// Mark a cycle terminal with a status + optional error, stamping finished_at.
export function finishCycle(id, { status, error = null } = {}) {
  getMock2Db()
    .prepare(`UPDATE mock2_cycles SET status = ?, error = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?`)
    .run(status, error, nowIso(), Number(id));
  return getCycle(id);
}
