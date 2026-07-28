// Harness step registry — the machine-readable map of every model-bearing
// step in the Mock2 pipeline, plus the pure resolution logic for the
// PER-STEP override layer (the topmost layer of the tuning precedence:
// step override → lane tuning → env override → slot/shipped default).
//
// Pure and native-free on purpose (risk R9): no db.js, no settings.js — the
// stored override doc is passed IN. The runtime side (reading/storing the
// doc, the guarded call wrapper) lives in harness-steps.js.
//
// The registry ids are stable and go on ledger rows (spend attribution), so
// they are part of the data contract: never rename one.
//
// Terminology (risk R7): nothing here is named "agent".

import { ROUTING_EFFORTS } from './routing-logic.js';

export const HARNESS_STAGES = Object.freeze(['Concept', 'Define', 'Build', 'Post-build']);

// One entry per model-bearing step (19 call sites through callModelTurn).
// defaults.model null = the step runs on its slot's assigned model;
// defaults.effort/thinking describe the shipped behavior before any
// override layer. budgetNote is display-only — output budgets are shown
// read-only (a mis-set budget causes truncation failures that don't look
// like a settings mistake).
export const HARNESS_STEPS = Object.freeze([
  {
    id: 'concept-chat', stage: 'Concept', title: 'Concept chat turn',
    description: 'Design-partner conversation; expands asks into domain-expert briefs; picks tweak/screen/full scope via the generate_mockup tool.',
    intendedOutcome: 'A brief that is the design’s ceiling; the cheapest scope that truly fits.',
    slotKey: 'concept_chat', laneKey: 'chat', envModelVar: null, envEffortVar: null,
    defaults: { model: 'claude-opus-5', effort: 'high', thinking: 'adaptive', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'mockup-render', stage: 'Concept', title: 'Mockup render — full',
    description: 'One self-contained multi-screen HTML mockup. Deep renders (first/explore/restyle) run high effort + thinking; on-theme iterations run low/off.',
    intendedOutcome: 'The visual contract every build inherits — worth the strongest model once.',
    slotKey: 'mockup', laneKey: 'mockup', envModelVar: 'MOCK2_MOCKUP_MODEL', envEffortVar: null,
    defaults: { model: 'claude-fable-5', effort: 'high (deep) / low (iteration)', thinking: 'adaptive (deep) / off', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'mockup-tweak', stage: 'Concept', title: 'Mockup tweak',
    description: 'Surgical search/replace edit blocks against the current HTML (whitespace-tolerant matching). A miss gets ONE corrective retry, then escalates to a single-screen re-render when the edits localize to one screen; the full renderer is the last resort.',
    intendedOutcome: 'A one-line change costs cents and seconds — never a surprise whole-document rebuild.',
    slotKey: 'mockup', laneKey: null, envModelVar: 'MOCK2_MOCKUP_MODEL', envEffortVar: null,
    defaults: { model: 'claude-fable-5', effort: 'high', thinking: 'off', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'mockup-screen', stage: 'Concept', title: 'Mockup screen re-render',
    description: 'Re-renders ONE <section data-screen> and swaps it in; falls back to the full renderer on any miss.',
    intendedOutcome: 'Screen-scale change without whole-document cost.',
    slotKey: 'mockup', laneKey: null, envModelVar: 'MOCK2_MOCKUP_MODEL', envEffortVar: null,
    defaults: { model: 'claude-fable-5', effort: 'high', thinking: 'adaptive', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'mockup-continuation', stage: 'Concept', title: 'Render continuation',
    description: 'Continues a render that stopped at max_tokens from the cut point, with defensive stitching.',
    intendedOutcome: 'Paid partial output is finished, never discarded.',
    slotKey: 'mockup', laneKey: null, envModelVar: 'MOCK2_MOCKUP_MODEL', envEffortVar: null,
    defaults: { model: null, effort: 'high', thinking: 'off', budgetNote: 'uncapped (model max) × ≤2 hops' }, tunable: true,
  },
  {
    id: 'design-doc-adjust', stage: 'Concept', title: 'Design-doc AI adjust',
    description: 'Proposes a sanitized design-token JSON for a preset adjustment; strict grammar re-validation means it cannot inject CSS.',
    intendedOutcome: 'A valid proxypilot-design@1 proposal for operator review.',
    slotKey: 'concept_chat', laneKey: 'chat', envModelVar: null, envEffortVar: null,
    defaults: { model: 'claude-opus-5', effort: 'high', thinking: 'adaptive', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'inventory-extraction', stage: 'Concept', title: 'Inventory extraction',
    description: 'Mockup HTML → structured inventory (screens, fields, actions incl. mutation coverage, states + default_state, journeys); deterministic CRUD completion and lint follow.',
    intendedOutcome: 'The build contract: complete CRUD, variants folded, defaults explicit.',
    slotKey: 'concept_chat', laneKey: null, envModelVar: null, envEffortVar: null,
    defaults: { model: 'claude-opus-5', effort: 'medium', thinking: 'off', budgetNote: 'uncapped (model max), 1 retry' }, tunable: true,
  },
  {
    id: 'design-token-extraction', stage: 'Concept', title: 'Design-token extraction',
    description: 'Mockup → state/design-tokens.json + rendered design.css; parser never fails (invalid values fall back to defaults).',
    intendedOutcome: 'The approved LOOK carried into the build.',
    slotKey: 'concept_chat', laneKey: null, envModelVar: null, envEffortVar: null,
    defaults: { model: 'claude-opus-5', effort: 'high', thinking: 'off', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'rule-audit', stage: 'Define', title: 'Rule audit / interview',
    description: 'Audits the build request against inventory + rules + constitution; produces tappable rule questions; the same reply classifies the task (kind + difficulty).',
    intendedOutcome: 'Confirmed, testable rules before code — and the routing classification for free.',
    slotKey: 'audit', laneKey: 'audit', envModelVar: null, envEffortVar: null,
    defaults: { model: null, effort: 'high', thinking: 'adaptive', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'split-probe', stage: 'Build', title: 'Route-time split probe',
    description: 'Sizes a quick update before it starts (9s race); feature-scale requests get a split proposal card.',
    intendedOutcome: 'Big asks decompose BEFORE they burn a big cycle.',
    slotKey: null, laneKey: null, envModelVar: 'MOCK2_PREPASS_MODEL', envEffortVar: null,
    defaults: { model: 'claude-haiku-4-5-20251001', effort: 'high', thinking: 'off', budgetNote: 'uncapped (model max), 9s race' }, tunable: true,
  },
  {
    id: 'quick-prepass', stage: 'Build', title: 'Quick-lane pre-pass',
    description: 'Classifies scope (simple/multi_part/feature_scale), writes the working brief, may bump effort one notch. Fail-open.',
    intendedOutcome: 'The cheap model does the thinking scaffold; the big model builds.',
    slotKey: null, laneKey: null, envModelVar: 'MOCK2_PREPASS_MODEL', envEffortVar: null,
    defaults: { model: 'claude-haiku-4-5-20251001', effort: 'high', thinking: 'off', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'chat-distill', stage: 'Build', title: 'Chat → prompt distill',
    description: 'Converts a chat message into one well-formed quick-update instruction (preserve every deliverable, invent nothing).',
    intendedOutcome: 'One tap from conversation to build.',
    slotKey: null, laneKey: null, envModelVar: null, envEffortVar: null,
    defaults: { model: 'claude-opus-5', effort: 'high', thinking: 'off', budgetNote: 'uncapped (model max), 60s race' }, tunable: true,
  },
  {
    id: 'build-runner', stage: 'Build', title: 'Build runner loop',
    description: 'THE builder: edits code in the fenced container via tools, runs gates, finishes. Full builds route via the knowledge base; MVP/quick use the fast model.',
    intendedOutcome: 'Working, contract-complete code. 80–90% of a request’s cost lives here — cost scales with TURNS.',
    slotKey: 'build_runner', laneKey: 'build', envModelVar: 'MOCK2_FAST_MODEL', envEffortVar: 'MOCK2_MVP_EFFORT / MOCK2_QUICK_EFFORT',
    defaults: { model: null, effort: 'high (routed)', thinking: 'adaptive', budgetNote: 'uncapped/turn — model max (MOCK2_RUNNER_MAX_TOKENS is an explicit operator cap)' }, tunable: true,
  },
  {
    id: 'consult', stage: 'Build', title: 'Consult (second opinion)',
    description: 'Single tool-free advisory diagnosis of a stuck cycle over a compiled digest. Deliberately pinned to claude-fable-5.',
    intendedOutcome: 'Senior eyes unblock a halt; advisory only.',
    slotKey: 'audit', laneKey: null, envModelVar: null, envEffortVar: null,
    defaults: { model: 'claude-fable-5', effort: null, thinking: 'adaptive', budgetNote: 'uncapped (model max)' }, tunable: false,
  },
  {
    id: 'explain-card', stage: 'Post-build', title: 'Explain card',
    description: 'Plain-language rewrite of a halt/authorization card for a non-technical operator (five fixed questions + a risk judgment).',
    intendedOutcome: 'The operator understands the decision without jargon.',
    slotKey: 'summary', laneKey: null, envModelVar: null, envEffortVar: null,
    defaults: { model: null, effort: 'high', thinking: 'adaptive', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'explain-followup', stage: 'Post-build', title: 'Explain follow-up',
    description: 'Answers the operator’s follow-up question about an explained card; plain text, honest about missing information.',
    intendedOutcome: 'A direct answer, not a re-explanation.',
    slotKey: 'summary', laneKey: null, envModelVar: null, envEffortVar: null,
    defaults: { model: null, effort: 'high', thinking: 'adaptive', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'checklist-postpass', stage: 'Post-build', title: 'Checklist post-pass',
    description: 'One cheap call per finished build keeps the screens/features checklist truthful (conservative; empty lists are the normal answer).',
    intendedOutcome: 'The checklist reflects what the build ACTUALLY did.',
    slotKey: 'build_runner', laneKey: null, envModelVar: 'MOCK2_PREPASS_MODEL', envEffortVar: null,
    defaults: { model: 'claude-haiku-4-5-20251001', effort: 'high', thinking: 'off', budgetNote: 'uncapped (model max)' }, tunable: true,
  },
  {
    id: 'demo-content', stage: 'Post-build', title: 'Demo content',
    description: 'Fills the app with realistic content through its OWN API, signed in as the screen-capture account only. An empty app can only be critiqued for its chrome — which is every finding the review has produced so far.',
    intendedOutcome: 'The design review sees the screens with twelve items on them, so "what does this look like full?" becomes a question it can answer.',
    slotKey: 'build_runner', laneKey: null, envModelVar: 'MOCK2_DEMO_CONTENT_MODEL', envEffortVar: null,
    defaults: { model: '(build_runner slot model)', effort: 'high', thinking: 'off', budgetNote: 'once per project' }, tunable: true,
  },
  {
    id: 'clarify', stage: 'Build', title: 'Request clarifier',
    description: 'Runs when a request has no checkable outcome. Looks ONLY at the pages the request names, then offers 2-3 pressable rewrites through a front-end-craft and domain lens. Never blocks — "Build it anyway" always sends the request as written.',
    intendedOutcome: 'A vague report becomes a request with an outcome the operator can check, before a build spends money interpreting it.',
    slotKey: 'build_runner', laneKey: null, envModelVar: 'MOCK2_CLARIFY_MODEL', envEffortVar: null,
    defaults: { model: '(build_runner slot model)', effort: 'high', thinking: 'off', budgetNote: 'one read, at most two screenshots' }, tunable: true,
  },
  {
    id: 'design-options', stage: 'Post-build', title: 'Design options',
    description: 'A design COMPLAINT ("this does not look right") answered with 2-3 named layouts to choose between, read off screenshots of the live app plus the deterministic density measurements. Proposes only — nothing is applied until the operator presses Build on one.',
    intendedOutcome: 'The operator picks a layout instead of paying a build to find out what they asked for.',
    slotKey: 'build_runner', laneKey: null, envModelVar: 'MOCK2_DESIGN_OPTIONS_MODEL', envEffortVar: null,
    defaults: { model: '(build_runner slot model)', effort: 'high', thinking: 'off', budgetNote: 'one read, no tools' }, tunable: true,
  },
  {
    id: 'design-review', stage: 'Post-build', title: 'Design review / Polish pass',
    description: 'Screenshot-based vision critique of the LIVE app against the approved mockup + tokens, with deterministic overflow/axe/rogue-color riders. Never a gate.',
    intendedOutcome: 'Design defects surfaced (and optionally auto-fixed) after builds ship.',
    slotKey: 'build_runner', laneKey: null, envModelVar: 'MOCK2_REVIEW_MODEL', envEffortVar: null,
    defaults: { model: null, effort: 'high', thinking: 'adaptive', budgetNote: 'uncapped (model max), 240s timeout' }, tunable: true,
  },
  {
    id: 'ask', stage: 'Post-build', title: 'Ask',
    description: 'Bounded tool loop over the build container (read/exec/web-search, destructive commands refused); answers questions and runs operational tasks — never code changes.',
    intendedOutcome: 'Answers and bounded actions with conversation context.',
    slotKey: 'build_runner', laneKey: 'ask', envModelVar: null, envEffortVar: null,
    defaults: { model: null, effort: 'high', thinking: 'adaptive', budgetNote: 'uncapped/turn × ≤15 turns' }, tunable: true,
  },
]);

// The free half — deterministic, zero-model steps, listed read-only for
// completeness (docs/core/harness-steps.md §4).
export const DETERMINISTIC_STEPS = Object.freeze([
  { id: 'acceptance-verdict', stage: 'Verify', title: 'Acceptance verdict', description: 'state/acceptance.json discipline; red→green demonstrated for bugfixes; stale specs never feed classification.' },
  { id: 'summary-overclaim', stage: 'Verify', title: 'Summary over-claim check', description: 'The finish summary may only name files this cycle changed.' },
  { id: 'action-parity', stage: 'Verify', title: 'Action-parity gate', description: 'Inventory mutation actions must appear in UI source (implemented or badged "Not built yet").' },
  { id: 'gate-battery', stage: 'Verify', title: 'Gate battery', description: 'Pinned deterministic scripts run in-container; any red gate rejects the finish.' },
  { id: 'anomaly-tripwire', stage: 'Verify', title: 'Anomaly tripwire', description: 'Under-verified bugfix signature → deploy HELD until the operator releases it.' },
  { id: 'deploy-stage', stage: 'Deploy', title: 'Deploy stage', description: 'deps → migrate → build → systemd swap → health check.' },
  { id: 'smoke-gate', stage: 'Deploy', title: 'Smoke gate', description: 'HTTP layer always; browser/db connectors by diff triggers; acceptance_ids hard-execute named ui-checks.' },
  { id: 'mockup-checks', stage: 'Concept', title: 'Mockup checks battery', description: 'Palette, token-only colors, themes + toggle, data-bound bars, canonical rows, detail bands, computed AA — on every saved render.' },
]);

const STEP_BY_ID = new Map(HARNESS_STEPS.map((s) => [s.id, s]));

export function getHarnessStep(stepId) {
  return STEP_BY_ID.get(stepId) || null;
}

export const STEP_TUNING_EFFORTS = ROUTING_EFFORTS; // low..max — 'default' is expressed by clearing the override

// Normalize one stored override entry. Junk-tolerant: unknown effort values
// and anything but 'off' for thinking are dropped, model is a trimmed string
// or null. An entry with nothing left normalizes to null (no override).
export function normalizeStepOverride(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = String(raw.model ?? '').trim().slice(0, 200) || null;
  const effort = STEP_TUNING_EFFORTS.includes(raw.effort) ? raw.effort : null;
  const thinking = raw.thinking === 'off' ? 'off' : null;
  if (model == null && effort == null && thinking == null) return null;
  return { model, effort, thinking };
}

// Normalize the whole stored doc ({ [stepId]: {model?, effort?, thinking?} }).
// Unknown step ids and non-tunable steps are dropped so a stale or hand-edited
// doc can never steer a step that must not be steered.
export function normalizeStepTuning(raw) {
  let doc = raw;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch { doc = null; }
  }
  if (!doc || typeof doc !== 'object') return {};
  const out = {};
  for (const [id, entry] of Object.entries(doc)) {
    const step = STEP_BY_ID.get(id);
    if (!step || !step.tunable) continue;
    const norm = normalizeStepOverride(entry);
    if (norm) out[id] = norm;
  }
  return out;
}

// The step-override layer: apply a stored {model?, effort?, thinking?} on top
// of an already-lane-tuned baseline. Pure. Unknown stepId, a non-tunable step,
// or no stored override returns the baseline UNCHANGED (same reference — the
// back-compat contract: with nothing stored, behavior is byte-identical).
export function resolveStepTuning(stepId, baseline, overrides) {
  const step = STEP_BY_ID.get(stepId);
  if (!step || !step.tunable) return baseline;
  const entry = overrides ? normalizeStepOverride(overrides[stepId]) : null;
  if (!entry) return baseline;
  const base = baseline || {};
  return {
    ...base,
    model: entry.model ?? base.model,
    effort: entry.effort ?? base.effort,
    thinking: entry.thinking ?? base.thinking,
  };
}

// Display-side resolution for the Harness page: what value each control shows
// and WHERE it came from (step | lane | env | slot | default). Pure — the
// route injects { slotModel, laneEntry, env, override }. This mirrors the
// main-path precedence; steps with mode-dependent behavior (deep vs iteration
// renders, routed build efforts) show their primary path and say so in
// defaults.effort/thinking.
export function resolveStepDisplay(step, { slotModel = null, laneEntry = null, env = {}, override = null } = {}) {
  const o = normalizeStepOverride(override);
  const envModelRaw = step.envModelVar && !step.envModelVar.includes('/')
    ? String(env[step.envModelVar] ?? '').trim() : '';
  const envModel = envModelRaw && envModelRaw !== 'off' && envModelRaw !== 'slot' ? envModelRaw : null;

  let model;
  if (o?.model) model = { value: o.model, source: 'step' };
  else if (laneEntry?.model) model = { value: laneEntry.model, source: 'lane' };
  else if (envModel) model = { value: envModel, source: 'env' };
  else if (step.defaults.model) model = { value: step.defaults.model, source: 'default' };
  else if (slotModel) model = { value: slotModel, source: 'slot' };
  else model = { value: null, source: 'default' };

  let effort;
  if (o?.effort) effort = { value: o.effort, source: 'step' };
  else if (laneEntry && laneEntry.effort && laneEntry.effort !== 'default') effort = { value: laneEntry.effort, source: 'lane' };
  else effort = { value: step.defaults.effort ?? 'default', source: 'default' };

  let thinking;
  if (o?.thinking === 'off') thinking = { value: 'off', source: 'step' };
  else if (laneEntry && laneEntry.thinking === 'off') thinking = { value: 'off', source: 'lane' };
  else thinking = { value: step.defaults.thinking ?? 'adaptive', source: 'default' };

  return { model, effort, thinking };
}
