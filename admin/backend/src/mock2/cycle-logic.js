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

import { USAGE_SCHEMA_VERSION } from './usage-logic.js';
import { parseRoutingJson } from './routing-logic.js';

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

// ---- build modes (full vs MVP) ----
//
// 'full' is the everything path: audit interview, whole gate battery,
// acceptance discipline. 'mvp' is the speed path from an approved design to a
// TESTABLE first version — closer to a one-shot scaffold: the rule interview is
// skipped, NO gate battery runs, and finish does not demand a
// state/acceptance.json. The deploy pipeline is the backstop (tsc runs as the
// deploy's build step; the health check refuses an app that doesn't serve).
// A later full Build adds the discipline and the whole battery.

export const BUILD_MODE_FULL = 'full';
export const BUILD_MODE_MVP = 'mvp';
// 'quick' is the ITERATION path — the VS-Code-like "small guided change,
// seconds-to-minutes" loop on an app that already exists: rule interview
// skipped (like MVP), NO gate battery (pre-existing gate debt must never
// block a one-line edit — the full Build / Production check own correctness),
// and a tight minimal-diff prompt. Deploy + health-check still run: quick
// means a live update, not an unserved one.
export const BUILD_MODE_QUICK = 'quick';
export const BUILD_MODES = Object.freeze([BUILD_MODE_FULL, BUILD_MODE_MVP, BUILD_MODE_QUICK]);

export function normalizeBuildMode(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === BUILD_MODE_MVP) return BUILD_MODE_MVP;
  if (v === BUILD_MODE_QUICK) return BUILD_MODE_QUICK;
  return BUILD_MODE_FULL;
}

// The fast modes share the skip-the-interview / relaxed-acceptance path.
export function isFastBuildMode(mode) {
  const m = normalizeBuildMode(mode);
  return m === BUILD_MODE_MVP || m === BUILD_MODE_QUICK;
}

// Fast modes (MVP, quick) run NO gate battery at all — operator decision:
// pre-existing gate failures (an npm-audit finding in a transitive dev dep,
// an inherited lint debt) were blocking one-line quick edits, and the deploy
// pipeline is the real backstop for these modes anyway (tsc runs as the
// deploy's build step, and the health check refuses an app that doesn't
// serve). The FULL Build and the Production check run the entire battery —
// that is where correctness is enforced.
export function filterGatesForBuildMode(gates = [], mode = BUILD_MODE_FULL) {
  const m = normalizeBuildMode(mode);
  if (m === BUILD_MODE_FULL) return gates;
  return [];
}

// ---- baseline gate: design adherence ----
//
// WHY A BASELINE GATE. The framework's gates_json is operator-owned, so nothing
// there is guaranteed. This one is owned by the backend and appended to every
// FULL build, because the failure it catches was invisible and expensive: a
// build read the approved mockup, then wrote its own ~18KB stylesheet with its
// own 32 variables and referenced NONE of the approved ones. Every gate passed,
// the deploy was healthy, and the shipped app simply did not look like the
// design that had been signed off.
//
// It is deliberately blunt. It does not judge taste, spacing or hierarchy — the
// design review does that. It only fires on the two unambiguous signatures of
// "the approved design was ignored":
//   * the app's own CSS references ZERO approved variables, and
//   * the app declares a dozen-plus variables of its own while using almost
//     none of the approved set (a parallel palette that will drift).
// Plus the one case where ignoring the design breaks a shipped FEATURE: the
// approved design has a dark theme, the app's own tokens have no dark variant,
// so the theme toggle flips an attribute nothing responds to.
//
// A red gate does not kill the build — the runner feeds the verdict back and
// the model fixes it (the no-progress breaker stops a loop). No approved
// design.css, or no app CSS yet, exits 0: there is nothing to adhere to.
export const DESIGN_ADHERENCE_GATE_NAME = 'design-adherence';

export const DESIGN_ADHERENCE_GATE_SCRIPT = `# Baseline gate (ProxyPilot): the approved design must actually be consumed.
set -u
DESIGN=state/design.css
if [ ! -f "$DESIGN" ]; then
  echo "design-adherence: no state/design.css — nothing approved to adhere to. Skipped."
  exit 0
fi

APP=/tmp/pp-app.css
: > "$APP"
for f in public/*.css; do
  [ -f "$f" ] || continue
  case "$f" in */base.css|*/design.css|*/platform.css) continue ;; esac
  cat "$f" >> "$APP"
done
APPBYTES=$(wc -c < "$APP" | tr -d ' ')

# Declared variables on each side, and the approved ones the app actually reads.
grep -o -- '--[A-Za-z0-9_-]*[[:space:]]*:' "$DESIGN" | sed 's/[[:space:]]*:$//' | sort -u > /tmp/pp-approved
grep -o -- '--[A-Za-z0-9_-]*[[:space:]]*:' "$APP"    | sed 's/[[:space:]]*:$//' | sort -u > /tmp/pp-appdef
grep -o -- 'var([[:space:]]*--[A-Za-z0-9_-]*' "$APP" | sed 's/.*--/--/'         | sort -u > /tmp/pp-appuse

APPROVED=$(wc -l < /tmp/pp-approved | tr -d ' ')
USED=$(comm -12 /tmp/pp-appuse /tmp/pp-approved | wc -l | tr -d ' ')
OWN=$(comm -23 /tmp/pp-appdef /tmp/pp-approved | wc -l | tr -d ' ')

echo "design-adherence: \${APPROVED} approved variable(s); the app uses \${USED} of them, declares \${OWN} of its own, in \${APPBYTES} bytes of its own CSS."

# Too little approved design to judge against (a preset-only project).
if [ "$APPROVED" -lt 8 ]; then
  echo "design-adherence: fewer than 8 approved variables — not enough of a design system to enforce. Passed."
  exit 0
fi
# The app has not written stylesheets of its own yet.
if [ "$APPBYTES" -lt 2000 ]; then
  echo "design-adherence: the app has not written substantial CSS of its own. Passed."
  exit 0
fi

FAIL=0
if [ "$USED" -eq 0 ]; then
  echo "FAIL: the app's stylesheets reference NONE of the \${APPROVED} approved design variables."
  echo "      state/design.css is loaded and ignored. Restyle the screens on var(--...) from state/design.css"
  echo "      instead of a parallel palette; state/mockups/current.html is the visual contract."
  FAIL=1
elif [ "$OWN" -ge 12 ] && [ $((USED * 4)) -lt "$APPROVED" ]; then
  echo "FAIL: the app declares \${OWN} design variables of its own while using only \${USED} of \${APPROVED} approved ones."
  echo "      That is a second palette; the two will drift. Delete the parallel tokens and consume state/design.css."
  FAIL=1
fi

# A dropped dark theme is a broken shipped feature, not a style opinion.
if grep -q 'data-theme' "$DESIGN" && [ "$OWN" -ge 8 ] && ! grep -q 'data-theme' "$APP"; then
  echo "FAIL: the approved design defines a dark theme; the app's own \${OWN} variables have no dark variant,"
  echo "      so the theme toggle changes nothing for them. Add the [data-theme=\\"dark\\"] values or use the approved ones."
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "design-adherence: the app builds on the approved design. Passed."
exit 0
`;

// Append the backend-owned baseline gates to a framework's battery. Skipped
// when the framework already defines a gate of the same name (an operator who
// wrote their own stricter version keeps it — theirs wins, ours doesn't stack).
export function withBaselineGates(gates = []) {
  const list = Array.isArray(gates) ? [...gates] : [];
  if (list.some((g) => g && g.name === DESIGN_ADHERENCE_GATE_NAME)) return list;
  list.push({
    name: DESIGN_ADHERENCE_GATE_NAME,
    script: DESIGN_ADHERENCE_GATE_SCRIPT,
    order: (list.reduce((m, g) => Math.max(m, Number(g?.order) || 0), 0)) + 1,
  });
  return list;
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

// ---- no-op loop termination (the "no work remaining" backstop) ----

// A cycle counts as a completed NO-OP when it reached a success-family terminal
// ('succeeded', or 'awaiting_user' with a pending/verified live checklist — the
// calm pending-operator-verification completion) AND its stamped acceptance
// state says the verified code diff was empty. Both facts are orchestrator-
// written (acceptance_json is stamped from the runner's own diff reading), so a
// model claim can never mint a no-op.
export function cycleWasNoop(cycle = {}) {
  const successFamily = cycle.status === 'succeeded'
    || (cycle.status === 'awaiting_user' && ['pending', 'verified'].includes(cycle.verification_state));
  if (!successFamily) return false;
  try {
    const acc = JSON.parse(cycle.acceptance_json || 'null');
    return !!acc && acc.no_op === true;
  } catch { return false; }
}

// How many consecutive completed no-op cycles may run for the SAME instruction
// before the orchestrator declares the work done and refuses to open another.
// Two is enough to prove idempotence (the first no-op already finished cleanly;
// the second confirms nothing regressed); a third adds no information.
export const NOOP_CYCLE_LIMIT = 2;

// consecutiveNoopCycles(cycles, instruction) — the trailing run of completed
// no-op BUILD cycles for this exact instruction. `cycles` is most-recent-first
// (the listCyclesForProject order). Same-instruction pipeline stages (the
// 'define' audit cycle that precedes every build) are transparent — they are
// bookkeeping for the same request, not work outcomes. Any different-
// instruction cycle or non-no-op build outcome breaks the run — new work
// always resets the counter.
export function consecutiveNoopCycles(cycles = [], instruction = '') {
  const want = String(instruction || '').trim();
  let run = 0;
  for (const c of Array.isArray(cycles) ? cycles : []) {
    if (String(c?.instruction || '').trim() !== want) break;
    if (c?.stage && c.stage !== 'build') continue; // define/audit stages are transparent
    if (!cycleWasNoop(c)) break;
    run += 1;
  }
  return run;
}

// noopStartRefusal({ priorCycles, instruction, limit }) — the start-time gate:
// when the last `limit` cycles for this instruction all completed as verified
// no-ops, there is no work remaining — opening another empty cycle is the loop,
// not progress. Returns { refuse, reason } with a calm, terminal message (this
// is a completion, not an error).
export function noopStartRefusal({ priorCycles = [], instruction = '', limit = NOOP_CYCLE_LIMIT } = {}) {
  const run = consecutiveNoopCycles(priorCycles, instruction);
  if (run < limit) return { refuse: false, reason: null, consecutive: run };
  return {
    refuse: true,
    consecutive: run,
    reason: `No work remaining: the last ${run} build cycle${run === 1 ? '' : 's'} for this exact instruction completed with no code changes — the work is already done and verified. Not starting another empty cycle. If you want something different, describe the new change; if a live verification is outstanding, confirm it from the Build panel.`,
  };
}

// ---- API response shape ----

// Client-safe view of a cycle row for the poll endpoint + the "gates going
// green" view. gates_json is parsed back for the UI.
function safeJsonArray(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

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
    // Why a cycle HALTED without success (needs attention): 'model_halt' |
    // 'no_tool_calls' | 'repeated_output' | 'no_state_change' |
    // 'authorization_request' | null. Set on an 'awaiting_admin' cycle → "Blocked —
    // needs attention", distinct from a retries-exhausted awaiting_admin (halt_reason
    // null) and from a user stop.
    halt_reason: row.halt_reason || null,
    // Resolution options the model PROPOSED when it halted, so the operator can pick
    // one (rendered as a single rule-question-style choice card) and have it injected
    // on resume. Each is { id, label, kind, risk/detail, injectOnResume, recommended,
    // authorization:{scope,expectedRows}|null } — kind is one of grant_authorization |
    // expand_scope | run_dependency_first | override_rule | abandon. [] when none.
    halt_options: safeJsonArray(row.halt_options_json),
    // Cost-truth (migration 515): the umbrella request this cycle is a segment of, and
    // the canonical four-class usage. used_tokens above is the legacy single figure
    // (label it "billable in+out"); `usage` is the honest basis. cost_cents mirrors
    // used_cost_cents (cost computation unchanged). schema_version < 3 (or null) ⇒ a
    // legacy-basis row, flagged non-comparable and excluded from history/estimator.
    request_id: row.request_id ?? null,
    segment: row.segment || null,
    usage: {
      input: row.input_tokens ?? null,
      output: row.output_tokens ?? null,
      cache_read: row.cache_read_tokens ?? null,
      cache_write: row.cache_write_tokens ?? null,
      cost_cents: row.used_cost_cents ?? 0,
      schema_version: row.usage_schema_version ?? null,
      comparable: Number(row.usage_schema_version || 0) >= USAGE_SCHEMA_VERSION,
    },
    // Model routing (migration 525): the decision stamped at start — which
    // model/effort ran and WHY ({ model, applied_model, effort, rung, task_kind,
    // difficulty, reason, mode }). null on pre-routing cycles or MOCK2_ROUTING=off.
    routing: parseRoutingJson(row.routing_json),
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    created_at: row.created_at || null,
  };
}

// ---- typical build duration (the "you can leave the page" ETA) ----

// typicalDurationMs — the p50/p80 wall-clock band of this project's recent
// SUCCEEDED cycles, optionally narrowed to the same build mode (quick builds
// predict quick builds, not full ones). Feeds the Build panel's "typically
// ~4–7m" line next to the live elapsed clock. Needs ≥2 samples, else null —
// a single data point is an anecdote, not an estimate. Rows are expected
// newest-first (listCyclesForProject order).
export function typicalDurationMs(rows = [], { buildMode = null, limit = 12 } = {}) {
  const durs = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r?.status !== 'succeeded') continue;
    if (buildMode) {
      const mode = parseRoutingJson(r.routing_json)?.build_mode || null;
      if (mode !== buildMode) continue;
    }
    const s = Date.parse(r.started_at || r.created_at || '');
    const f = Date.parse(r.finished_at || '');
    if (!Number.isFinite(s) || !Number.isFinite(f) || f <= s) continue;
    durs.push(f - s);
    if (durs.length >= limit) break;
  }
  if (durs.length < 2) return null;
  durs.sort((a, b) => a - b);
  const pct = (p) => durs[Math.max(0, Math.min(durs.length - 1, Math.round(p * (durs.length - 1))))];
  return { p50: pct(0.5), p80: pct(0.8), n: durs.length };
}
