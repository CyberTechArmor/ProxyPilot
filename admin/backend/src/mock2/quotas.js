// Mock2 quotas — data access (Phase M5, ADR-003 / risk R5). Tables:
// mock2_quotas (budgets: $ / wall-clock / concurrency, per scope+period) and
// mock2_quota_ledger (append-only spend events; remaining = budget − Σ period).
//
// The arithmetic and the canStartCycle gate are PURE (quota-logic.js,
// unit-tested stub-first, risk R9). This module is the thin better-sqlite3 half
// plus the period-window math that decides which ledger rows count as "this
// period". Native (getMock2Db) — reached only on an enabled host.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { sumLedger, publicQuotaShape } from './quota-logic.js';

const nowIso = () => new Date().toISOString();

// ---- quota rows ----

export function listQuotas() {
  return getMock2Db().prepare(`SELECT * FROM mock2_quotas ORDER BY scope, project_id, period`).all();
}

export function getQuota(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_quotas WHERE id = ?`).get(Number(id));
}

// The quota that governs a project for a period: the project-scoped row if one
// exists, else the global row. M6 calls this to pick the envelope.
export function getApplicableQuota(projectId, period = 'monthly') {
  const db = getMock2Db();
  const proj = db
    .prepare(`SELECT * FROM mock2_quotas WHERE scope = 'project' AND project_id = ? AND period = ?`)
    .get(Number(projectId), period);
  if (proj) return proj;
  return db.prepare(`SELECT * FROM mock2_quotas WHERE scope = 'global' AND period = ?`).get(period) || null;
}

// Upsert on the (scope, project_id, period) unique key. project_id is NULL for
// global. Any of the budget fields may be null (that dimension unlimited).
export function upsertQuota({ scope, projectId = null, period, budgetCents = null, budgetWallClockMin = null, maxConcurrentCycles = null, bufferPct = 15 }) {
  const db = getMock2Db();
  const pid = scope === 'global' ? null : (projectId == null ? null : Number(projectId));
  db.prepare(
    `INSERT INTO mock2_quotas
       (scope, project_id, period, budget_cents, budget_wall_clock_min, max_concurrent_cycles, buffer_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, project_id, period) DO UPDATE SET
       budget_cents = excluded.budget_cents,
       budget_wall_clock_min = excluded.budget_wall_clock_min,
       max_concurrent_cycles = excluded.max_concurrent_cycles,
       buffer_pct = excluded.buffer_pct`,
  ).run(
    scope,
    pid,
    period,
    budgetCents == null ? null : Math.round(budgetCents),
    budgetWallClockMin == null ? null : Math.round(budgetWallClockMin),
    maxConcurrentCycles == null ? null : Math.round(maxConcurrentCycles),
    Math.round(bufferPct),
  );
  return db
    .prepare(`SELECT * FROM mock2_quotas WHERE scope = ? AND project_id IS ? AND period = ?`)
    .get(scope, pid, period);
}

export function deleteQuota(id) {
  const r = getMock2Db().prepare(`DELETE FROM mock2_quotas WHERE id = ?`).run(Number(id));
  return { deleted: r.changes > 0 };
}

// ---- ledger ----

// Append a spend event. M6 writes one per model call; M5 provides the writer so
// the ledger arithmetic is exercisable end to end.
export function insertLedgerEntry({ projectId, cycleId = null, connectorId = null, model = null, inputTokens = 0, outputTokens = 0, costCents = 0, wallClockMs = 0, step = null, userId = null }) {
  const info = getMock2Db()
    .prepare(
      `INSERT INTO mock2_quota_ledger
         (project_id, cycle_id, connector_id, model, input_tokens, output_tokens, cost_cents, wall_clock_ms, created_at, step, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(Number(projectId), cycleId, connectorId, model, Math.round(inputTokens), Math.round(outputTokens), Number(costCents) || 0, Math.round(wallClockMs), nowIso(), step || null, userId == null ? null : String(userId));
  return getMock2Db().prepare(`SELECT * FROM mock2_quota_ledger WHERE id = ?`).get(info.lastInsertRowid);
}

// The ISO start of the current period window. monthly = first of this month;
// weekly = most recent Monday. UTC, matching the created_at ISO stamps.
export function periodStartIso(period, ref = new Date()) {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  if (period === 'weekly') {
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    const backToMonday = (dow + 6) % 7;
    d.setUTCDate(d.getUTCDate() - backToMonday);
  } else {
    // monthly (default)
    d.setUTCDate(1);
  }
  return d.toISOString();
}

// Ledger rows for a project since the period start.
export function ledgerSince(projectId, sinceIso, scope = 'project') {
  const db = getMock2Db();
  if (scope === 'global') {
    return db.prepare(`SELECT * FROM mock2_quota_ledger WHERE created_at >= ?`).all(sinceIso);
  }
  return db.prepare(`SELECT * FROM mock2_quota_ledger WHERE project_id = ? AND created_at >= ?`).all(Number(projectId), sinceIso);
}

// Totals spent by a project (or globally) in the current period.
// Cycle-less spend for a project — the ASK lane's ledger entries (questions in
// the build chat spend real tokens but run no cycle, so the per-cycle usage
// rollups never see them). The Details-page cost card adds these as their own
// line item.
export function cyclelessLedger(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_quota_ledger WHERE project_id = ? AND cycle_id IS NULL`)
    .all(Number(projectId));
}

export function periodUsage({ scope = 'project', projectId = null, period = 'monthly' }) {
  const since = periodStartIso(period);
  const rows = ledgerSince(projectId, since, scope);
  return sumLedger(rows);
}

// Shape a quota row with its live usage for the UI.
export function shapeQuota(row) {
  if (!row) return null;
  const usage = periodUsage({ scope: row.scope, projectId: row.project_id, period: row.period });
  return publicQuotaShape(row, { spentCents: usage.costCents });
}
