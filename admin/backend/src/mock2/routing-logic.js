// Mock2 model-ROUTING pure decision layer. Native-free, unit-tested stub-first
// (risk R9): imports nothing that opens a DB, hits the network, or touches Incus.
//
// Routing turns "which model, at which effort, for this task" from a fixed
// per-slot setting into a REVIEWABLE, TUNABLE decision:
//
//   * The define audit classifies every build task (kind + difficulty 1–5) as
//     part of the JSON it already returns — zero extra model calls.
//   * A curated KNOWLEDGE BASE (mock2_routing_rules — the reference dictionary,
//     admin-editable) maps task kind → model override / escalation model /
//     effort. Absent overrides, the slot's model and the lane default apply,
//     so a fresh install behaves exactly as before.
//   * Deterministic ESCALATION: when a prior attempt of the same request
//     failed/halted (the ground-truth signals — never a model's self-report),
//     the next attempt steps up to the rule's escalation model. A difficulty-5
//     task goes straight to the escalation model (don't waste a cheap attempt
//     on a task the audit already called very hard).
//   * Every decision is stamped on the cycle (routing_json), logged as a cycle
//     event (reviewable in the request log), and every terminal outcome is
//     recorded append-only (mock2_routing_outcomes) with model/effort/cost —
//     the evidence an operator uses to fine-tune the dictionary.
//
// Terminology (risk R7): nothing here is named "agent".

// ---- task kinds (the dictionary keys) ----

export const ROUTING_TASK_KINDS = Object.freeze([
  'chore', 'bugfix', 'feature', 'refactor', 'question', 'default',
]);

export const ROUTING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// Seed rules for a fresh install: no model overrides (slot model applies), no
// escalation models (escalation disabled until an admin configures it), lane
// defaults for effort. The dictionary starts as "current behavior, now
// documented" — tuning it is the operator's move, informed by the outcomes.
export const DEFAULT_ROUTING_RULES = Object.freeze([
  { task_kind: 'chore',    label: 'Chores / config / copy edits', effort: 'medium' },
  { task_kind: 'bugfix',   label: 'Bug fixes',                    effort: 'high' },
  { task_kind: 'feature',  label: 'New features',                 effort: 'high' },
  { task_kind: 'refactor', label: 'Refactors / migrations',       effort: 'xhigh' },
  { task_kind: 'question', label: 'Questions / analysis',         effort: 'medium' },
  { task_kind: 'default',  label: 'Anything unclassified',        effort: 'high' },
]);

export function normalizeTaskKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return ROUTING_TASK_KINDS.includes(k) ? k : 'default';
}

export function normalizeDifficulty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

// ---- Anthropic request tuning (adaptive thinking + effort) ----
//
// model-client.js sends NO thinking parameter today — on Opus 4.7/4.8 that
// means the model runs WITHOUT thinking. These gates decide, per model id,
// what tuning is safe to send. Conservative allowlists: an unrecognized model
// gets nothing (current behavior), never a parameter that could 400.

// Models where thinking {type:"adaptive"} is the correct on-switch.
const ADAPTIVE_THINKING_RE = /(opus-4-[678]|sonnet-4-6|sonnet-5|fable-5|mythos)/;
// Models that accept output_config.effort at all (Opus 4.5 has low/med/high only).
const EFFORT_RE = /(opus-4-[5678]|sonnet-4-6|sonnet-5|fable-5|mythos)/;
// Models that accept the xhigh level (4.7+, Sonnet 5, Fable/Mythos).
const XHIGH_RE = /(opus-4-[78]|sonnet-5|fable-5|mythos)/;

// anthropicTuning — the extra body fields for an Anthropic request, or {} when
// the model isn't recognized (send nothing — never risk a 400 on an unknown or
// older model). Effort is clamped down where a level isn't supported.
export function anthropicTuning({ model, effort = null } = {}) {
  const id = String(model || '');
  const out = {};
  if (ADAPTIVE_THINKING_RE.test(id)) out.thinking = { type: 'adaptive' };
  let e = effort && ROUTING_EFFORTS.includes(effort) ? effort : null;
  if (e && EFFORT_RE.test(id)) {
    if (e === 'xhigh' && !XHIGH_RE.test(id)) e = 'high';
    if ((e === 'max' || e === 'xhigh') && /opus-4-5/.test(id)) e = 'high';
    out.output_config = { effort: e };
  }
  return out;
}

// ---- escalation signals (ground truth, never a model claim) ----

// Statuses that count as "the prior attempt did not succeed" for escalation.
const FAILED_ATTEMPT_STATUSES = new Set(['failed', 'awaiting_admin', 'interrupted', 'abandoned']);

// escalationAttempts — how many prior BUILD attempts of this same request (or,
// for legacy request-less cycles, this same instruction) ended without success.
// This is the rung index: 0 = first attempt, >=1 = a resume after failure.
export function escalationAttempts({ priorCycles = [], requestId = null, instruction = '' } = {}) {
  let n = 0;
  for (const c of priorCycles || []) {
    if (!c || c.stage !== 'build') continue;
    const sameRequest = requestId != null && c.request_id != null
      ? Number(c.request_id) === Number(requestId)
      : String(c.instruction || '') === String(instruction || '');
    if (!sameRequest) continue;
    if (FAILED_ATTEMPT_STATUSES.has(c.status)) n += 1;
  }
  return n;
}

// ---- the routing decision ----

export const ROUTING_MODES = Object.freeze(['on', 'shadow', 'off']);

export function routingMode(env = {}) {
  const v = String(env?.MOCK2_ROUTING ?? '').trim().toLowerCase();
  return ROUTING_MODES.includes(v) ? v : 'on';
}

// decideRouting — pick { model, effort, rung, reason } for a build cycle.
//
//   rung 0: the rule's model override, else the slot model.
//   rung 1: the rule's escalation model (else MOCK2_ESCALATE_MODEL), used when
//           a prior attempt of the same request failed/halted, or when the
//           audit scored the task difficulty 5. No escalation model configured
//           → stay on rung 0 (never invent a model id).
//
// Effort: the rule's effort, else the audit difficulty mapped onto the scale,
// else the lane default. Model overrides only make sense within one connector
// (the API key serves any of that provider's models) — the caller applies the
// decision to the slot connector as-is.
export function decideRouting({
  rule = null, slotModel = '', difficulty = null, priorAttempts = 0,
  env = {}, laneDefaultEffort = 'high',
} = {}) {
  const escalateModel = String(rule?.escalate_model || env?.MOCK2_ESCALATE_MODEL || '').trim() || null;
  const baseModel = String(rule?.model || '').trim() || String(slotModel || '');
  const wantsEscalation = priorAttempts >= 1 || difficulty === 5;
  const escalated = wantsEscalation && !!escalateModel && escalateModel !== baseModel;

  let effort = rule?.effort && ROUTING_EFFORTS.includes(rule.effort) ? rule.effort : null;
  if (!effort && difficulty != null) {
    effort = difficulty <= 2 ? 'medium' : difficulty === 3 ? 'high' : 'xhigh';
  }
  if (!effort) effort = laneDefaultEffort;

  const reasonBits = [];
  if (rule?.task_kind) reasonBits.push(`rule:${rule.task_kind}`);
  if (difficulty != null) reasonBits.push(`difficulty:${difficulty}`);
  if (priorAttempts >= 1) reasonBits.push(`prior_failed_attempts:${priorAttempts}`);
  if (escalated) reasonBits.push('escalated');

  return {
    model: escalated ? escalateModel : baseModel,
    effort,
    rung: escalated ? 1 : 0,
    task_kind: rule?.task_kind || 'default',
    difficulty: difficulty ?? null,
    reason: reasonBits.join(' '),
  };
}

export function parseRoutingJson(routingJson) {
  try {
    const doc = JSON.parse(routingJson || 'null');
    return doc && typeof doc === 'object' ? doc : null;
  } catch { return null; }
}

// ---- knowledge-base shapes + aggregation (the reviewable dictionary) ----

export function publicRoutingRuleShape(row) {
  if (!row) return null;
  return {
    task_kind: row.task_kind,
    label: row.label || row.task_kind,
    model: row.model || null,               // null → the slot model
    escalate_model: row.escalate_model || null, // null → env default / no escalation
    effort: row.effort || null,             // null → lane default
    enabled: Number(row.enabled ?? 1) === 1,
    notes: row.notes || null,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at || null,
  };
}

// aggregateRoutingOutcomes — the per-kind scoreboard the operator tunes the
// dictionary against: attempts, success rate, escalation rate, avg cost/tokens,
// split by the MODEL that actually ran. 'succeeded' and 'awaiting_user'
// (deployed, pending live verification) both count as success; failed /
// awaiting_admin (halt) count as failure; interrupted/abandoned are neutral.
export function aggregateRoutingOutcomes(rows = []) {
  const byKey = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const key = `${r.task_kind || 'default'}|${r.model || '?'}`;
    const cur = byKey.get(key) || {
      task_kind: r.task_kind || 'default', model: r.model || '?',
      runs: 0, succeeded: 0, failed: 0, escalated: 0, cost_cents: 0, tokens: 0,
    };
    cur.runs += 1;
    if (r.status === 'succeeded' || r.status === 'awaiting_user') cur.succeeded += 1;
    else if (r.status === 'failed' || r.status === 'awaiting_admin') cur.failed += 1;
    if (Number(r.rung) > 0) cur.escalated += 1;
    cur.cost_cents += Number(r.cost_cents) || 0;
    cur.tokens += Number(r.tokens) || 0;
    byKey.set(key, cur);
  }
  return [...byKey.values()]
    .map((s) => ({
      ...s,
      success_rate: s.runs ? Math.round((s.succeeded / s.runs) * 100) : null,
      avg_cost_cents: s.runs ? Math.round(s.cost_cents / s.runs) : null,
      avg_tokens: s.runs ? Math.round(s.tokens / s.runs) : null,
    }))
    .sort((a, b) => a.task_kind.localeCompare(b.task_kind) || a.model.localeCompare(b.model));
}
