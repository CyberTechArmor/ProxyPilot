// Mock2 model routing — data access (migration 525). The thin better-sqlite3
// half; every decision (rule shapes, escalation predicate, tuning gates,
// aggregation) is pure in routing-logic.js and unit-tested stub-first (R9).
//
// Two tables:
//   * mock2_routing_rules — the KNOWLEDGE BASE / reference dictionary: one row
//     per task kind, admin-editable (model override, escalation model, effort,
//     notes). Seeded with lane defaults on first use; editing it is how an
//     operator fine-tunes which model handles which kind of work.
//   * mock2_routing_outcomes — append-only evidence: one row per terminal build
//     cycle that carried a routing decision (model/effort/rung/status/cost).
//     The stats derived from it are what the operator reviews before tuning.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { DEFAULT_ROUTING_RULES, parseRoutingJson } from './routing-logic.js';

const nowIso = () => new Date().toISOString();

// Seed the dictionary once (idempotent — INSERT OR IGNORE keyed on task_kind).
export function ensureRoutingRules() {
  const db = getMock2Db();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO mock2_routing_rules (task_kind, label, effort, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  );
  for (const r of DEFAULT_ROUTING_RULES) stmt.run(r.task_kind, r.label, r.effort, nowIso(), nowIso());
}

export function listRoutingRules() {
  ensureRoutingRules();
  return getMock2Db().prepare(`SELECT * FROM mock2_routing_rules ORDER BY task_kind`).all();
}

export function getRoutingRule(taskKind) {
  ensureRoutingRules();
  const db = getMock2Db();
  const row = taskKind
    ? db.prepare(`SELECT * FROM mock2_routing_rules WHERE task_kind = ? AND enabled = 1`).get(String(taskKind))
    : null;
  return row || db.prepare(`SELECT * FROM mock2_routing_rules WHERE task_kind = 'default'`).get() || null;
}

export function updateRoutingRule(taskKind, { model, escalate_model, effort, enabled, notes, updatedBy = null } = {}) {
  ensureRoutingRules();
  const db = getMock2Db();
  const sets = [];
  const vals = [];
  if (model !== undefined) { sets.push('model = ?'); vals.push(model || null); }
  if (escalate_model !== undefined) { sets.push('escalate_model = ?'); vals.push(escalate_model || null); }
  if (effort !== undefined) { sets.push('effort = ?'); vals.push(effort || null); }
  if (enabled !== undefined) { sets.push('enabled = ?'); vals.push(enabled ? 1 : 0); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes || null); }
  if (!sets.length) return getRoutingRule(taskKind);
  sets.push('updated_by = ?'); vals.push(updatedBy);
  sets.push('updated_at = ?'); vals.push(nowIso());
  vals.push(String(taskKind));
  db.prepare(`UPDATE mock2_routing_rules SET ${sets.join(', ')} WHERE task_kind = ?`).run(...vals);
  return db.prepare(`SELECT * FROM mock2_routing_rules WHERE task_kind = ?`).get(String(taskKind));
}

// ---- outcomes (append-only evidence) ----

// One row per cycle (UNIQUE on cycle_id): a re-finish (e.g. a deploy retry
// flipping failed → awaiting_user) updates the row so the FINAL word wins.
export function insertRoutingOutcome({
  projectId, cycleId, requestId = null, taskKind = 'default', difficulty = null,
  model = null, effort = null, rung = 0, status, costCents = 0, tokens = 0,
}) {
  getMock2Db()
    .prepare(
      `INSERT INTO mock2_routing_outcomes
         (project_id, cycle_id, request_id, task_kind, difficulty, model, effort, rung, status, cost_cents, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (cycle_id) DO UPDATE SET
         status = excluded.status, cost_cents = excluded.cost_cents, tokens = excluded.tokens`,
    )
    .run(Number(projectId), Number(cycleId), requestId, taskKind, difficulty, model, effort,
      Number(rung) || 0, String(status), Math.round(Number(costCents) || 0), Math.round(Number(tokens) || 0), nowIso());
}

// recordRoutingOutcomeForCycle — called from finishCycle for every terminal
// build cycle that carries a routing stamp. Records what ACTUALLY ran
// (applied_model; effort/rung only when the decision was applied, i.e. mode
// 'on') so shadow-mode rows measure current behavior, not the unapplied plan.
export function recordRoutingOutcomeForCycle(cycle) {
  if (!cycle || cycle.stage !== 'build' || !cycle.routing_json || !cycle.status) return;
  const routing = parseRoutingJson(cycle.routing_json);
  if (!routing) return;
  const applied = routing.mode === 'on';
  insertRoutingOutcome({
    projectId: cycle.project_id,
    cycleId: cycle.id,
    requestId: cycle.request_id ?? null,
    taskKind: routing.task_kind || 'default',
    difficulty: routing.difficulty ?? null,
    model: routing.applied_model || routing.model || null,
    effort: applied ? routing.effort || null : null,
    rung: applied ? Number(routing.rung) || 0 : 0,
    status: cycle.status,
    costCents: cycle.used_cost_cents || 0,
    tokens: cycle.used_tokens || 0,
  });
}

export function listRoutingOutcomes({ taskKind = null, limit = 500 } = {}) {
  const db = getMock2Db();
  return taskKind
    ? db.prepare(`SELECT * FROM mock2_routing_outcomes WHERE task_kind = ? ORDER BY id DESC LIMIT ?`).all(String(taskKind), Number(limit))
    : db.prepare(`SELECT * FROM mock2_routing_outcomes ORDER BY id DESC LIMIT ?`).all(Number(limit));
}
