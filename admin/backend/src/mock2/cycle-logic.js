// Mock2 cycle-runner PURE decision layer (Phase M6, ADR-003/004; brief's
// Build/interrupt/escalation sections). Native-free, unit-tested stub-first
// (risk R9). The cycle STATE MACHINE, the interrupt policy, the gate-battery
// verdict, the cost ENVELOPE (R5), and the mid-cycle buffer stop all live here so
// runner.js (the native/host half) and the tests both drive one implementation.
//
// R5 stands: the estimate is an ENVELOPE, not a prediction — per-step p90 × a
// safety factor, refused against the remaining budget by canStartCycle
// (quota-logic.js). The real guard is the mid-cycle buffer stop below, checked
// against the ledger after every model call.
//
// Terminology (risk R7): the AI build component is the RUNNER; the slot that
// drives it is build_runner. Nothing here is named "agent".

// The mock2_cycles.status vocabulary (migration 502 CHECK), split into the sets
// the runner branches on. refused_quota / abandoned / failed / succeeded are
// terminal; awaiting_admin is terminal-until-an-admin-acts (retries exhausted).
export const CYCLE_STATUSES = Object.freeze([
  'queued', 'estimating', 'refused_quota', 'running', 'awaiting_user',
  'awaiting_admin', 'interrupted', 'abandoned', 'failed', 'succeeded',
]);

// Statuses that mean "this cycle is still consuming the lock / a worker" — the
// boot sweep fails the first two; canStartCycle counts these toward concurrency.
export const ACTIVE_STATUSES = Object.freeze(['queued', 'estimating', 'running']);

// Statuses no further work advances on its own. awaiting_admin is included: only
// an admin re-queues or abandons it (retries-exhausted handoff).
export const TERMINAL_STATUSES = Object.freeze([
  'refused_quota', 'abandoned', 'failed', 'succeeded', 'awaiting_admin', 'interrupted',
]);

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

// The interrupt vocabulary an editor/admin can set on a running cycle
// (mock2_cycles.interrupt_request CHECK). Honored at STEP BOUNDARIES only.
export const INTERRUPTS = Object.freeze(['queue_after_step', 'stop_after_step', 'abandon']);

export function isValidInterrupt(v) {
  return v == null || INTERRUPTS.includes(v);
}

// interruptDecision — what the runner does with a pending interrupt when it
// reaches a step boundary. 'abandon' is honored immediately (even mid-step is
// acceptable, but the runner calls this at the boundary); 'stop_after_step' and
// 'queue_after_step' both stop the loop after the current step is checkpointed,
// differing only in the terminal status the runner records.
//
// Returns { stop, checkpointFirst, terminalStatus, queued }.
export function interruptDecision(interruptRequest) {
  switch (interruptRequest) {
    case 'abandon':
      // Abandon: stop now; the current partial step is NOT checkpointed as a
      // success (the runner still commits a WIP checkpoint so the branch is
      // recoverable, but the cycle ends abandoned).
      return { stop: true, checkpointFirst: true, terminalStatus: 'abandoned', queued: false };
    case 'stop_after_step':
      return { stop: true, checkpointFirst: true, terminalStatus: 'interrupted', queued: false };
    case 'queue_after_step':
      // Queue-after-step: stop this cycle cleanly (checkpointed) and leave a
      // queue item so the change is re-driven later.
      return { stop: true, checkpointFirst: true, terminalStatus: 'interrupted', queued: true };
    default:
      return { stop: false, checkpointFirst: false, terminalStatus: null, queued: false };
  }
}

// ---- cost envelope (R5) ----

// The default per-model-turn token envelope (p90-ish) the estimate multiplies by
// the expected turn count and the safety factor. Deliberately generous: the
// envelope only has to be a credible reservation, not an accurate prediction —
// the mid-cycle buffer stop is the real guard.
export const DEFAULT_TURN_INPUT_TOKENS = 12000;
export const DEFAULT_TURN_OUTPUT_TOKENS = 3000;
// Recalibrated up (~2.3×, was 8): observed real builds — especially anything
// non-trivial like an auth module — run many more than 8 turns, so the old
// reservation ran well under actual usage. A production-grade feature commonly
// takes ~18 turns; the safety factor still pads on top.
export const DEFAULT_ESTIMATE_TURNS = 18;
export const DEFAULT_SAFETY_FACTOR = 1.5;

// estimateCycleTokens — the buffered token envelope for a cycle. Pure so the
// cost side (costCentsForUsage in quota-logic) can price it in the native layer.
// Returns { inputTokens, outputTokens } already multiplied by turns × safety.
export function estimateCycleTokens({
  turns = DEFAULT_ESTIMATE_TURNS,
  turnInputTokens = DEFAULT_TURN_INPUT_TOKENS,
  turnOutputTokens = DEFAULT_TURN_OUTPUT_TOKENS,
  safetyFactor = DEFAULT_SAFETY_FACTOR,
} = {}) {
  const t = Math.max(1, Number(turns) || DEFAULT_ESTIMATE_TURNS);
  const sf = Math.max(1, Number(safetyFactor) || DEFAULT_SAFETY_FACTOR);
  return {
    inputTokens: Math.ceil(t * Number(turnInputTokens) * sf),
    outputTokens: Math.ceil(t * Number(turnOutputTokens) * sf),
  };
}

// ---- gate battery verdict ----

// A gate report row shape: { name, status:'pending'|'running'|'passed'|'failed',
// started_at, report }. gateBatteryVerdict rolls the whole battery up for the
// "gates going green" view and the checkpoint gate: 'green' iff every gate
// passed, 'red' if any failed, else 'pending'.
export function gateBatteryVerdict(gates = []) {
  if (!Array.isArray(gates) || gates.length === 0) return 'pending';
  if (gates.some((g) => g && g.status === 'failed')) return 'red';
  if (gates.every((g) => g && g.status === 'passed')) return 'green';
  return 'pending';
}

export function allGatesGreen(gates = []) {
  return gateBatteryVerdict(gates) === 'green';
}

// Parse a pinned framework version's gates_json ([{name, script, order}]) into
// an ordered list. Tolerant: bad JSON or a non-array yields [] (the runner then
// runs no gates — a placeholder-content project, risk R8). Pure so the ordering
// is unit-testable without the DB.
export function parseGateScripts(gatesJson) {
  let arr;
  try { arr = JSON.parse(gatesJson || '[]'); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((g) => g && typeof g.name === 'string' && typeof g.script === 'string')
    .map((g, i) => ({ name: g.name, script: g.script, order: Number.isFinite(g.order) ? g.order : i }))
    .sort((a, b) => a.order - b.order);
}

// The initial gates_json the runner stamps on a cycle from the pinned gate
// scripts — every gate 'pending' before the battery runs.
export function initialGateReports(gateScripts = []) {
  return gateScripts.map((g) => ({ name: g.name, status: 'pending', started_at: null, report: null }));
}

// ---- mid-cycle buffer stop (R5 — the real guard) ----

// shouldStopForBudget — checked against the LEDGER after each model call. When a
// project is metered and the period spend has reached (or crossed) the budget,
// the runner finishes the current step, checkpoints, and stops (04-phased-plan
// §M6: "Buffer-crossed mid-cycle: finish current step, checkpoint, stop, say
// so"). budgetCents null ⇒ not metered ⇒ never stops on budget.
export function shouldStopForBudget({ budgetCents = null, spentCents = 0 } = {}) {
  if (budgetCents == null) return false;
  return Number(spentCents || 0) >= Number(budgetCents);
}

// The runner's retry ceiling before it escalates to awaiting_admin + a
// retries_exhausted queue item (04-phased-plan §M6). Pure constant so the escalate
// decision is testable.
export const MAX_CYCLE_RETRIES = 2;

// Exhausted once we've USED all MAX_CYCLE_RETRIES retries — i.e. on the
// (MAX+1)-th failure. The retries counter is incremented before this check, so
// the comparison is strictly-greater: failure 1 → retries 1 (retry), failure 2 →
// retries 2 (retry), failure 3 → retries 3 > 2 (escalate) = up to 2 retries.
export function retriesExhausted(retries) {
  return Number(retries || 0) > MAX_CYCLE_RETRIES;
}

// ---- API response shape ----

// Client-safe view of a cycle row for the poll endpoint + the "gates going
// green" view. gates_json is parsed back for the UI.
export function publicCycleShape(row) {
  if (!row) return null;
  let gates = [];
  if (row.gates_json) {
    try { gates = JSON.parse(row.gates_json); } catch { gates = []; }
  }
  return {
    id: row.id,
    project_id: row.project_id,
    framework_version_id: row.framework_version_id,
    stage: row.stage,
    status: row.status,
    current_gate: row.current_gate || null,
    gates,
    instruction: row.instruction || null,
    initiated_by: row.initiated_by,
    acting_as_admin: Number(row.acting_as_admin) === 1,
    est_tokens: row.est_tokens ?? null,
    est_cost_cents: row.est_cost_cents ?? null,
    used_tokens: row.used_tokens ?? 0,
    used_cost_cents: row.used_cost_cents ?? 0,
    retries: row.retries ?? 0,
    interrupt_request: row.interrupt_request || null,
    error: row.error || null,
    // Run phase — whether the built app was deployed and is serving on the live
    // URL: null | 'deploying' | 'serving' | 'deploy_failed'.
    deploy_status: row.deploy_status || null,
    // Why an 'interrupted' cycle soft-paused on a budget: 'budget_tokens' |
    // 'budget_time' | null. Set → the cycle is a resumable Pause, not a stop.
    pause_reason: row.pause_reason || null,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    created_at: row.created_at || null,
  };
}
