// Mock2 per-phase model routing PURE decision layer (phase-routing@1).
// Native-free, unit-tested stub-first (risk R9): imports nothing that opens a
// DB, hits the network, or touches Incus.
//
// The build cycle splits into FIVE phases with independently selectable models:
//
//   1. recon      (cheap) — scoped subagent briefs into state/recon/, one per
//                  touched subsystem; the plan reads the briefs, not the tree
//   2. plan       (top)   — derives the work file AND classifies each task
//                  (complexity + touches) so no separate classifier stage runs
//   3a. implement (cheap) — mechanical tasks, made safe by the Tier-1 gates
//   3b. implement (mid)   — complex tasks and EVERYTHING on the touches list
//   4. summarize  (cheap) — the change-record narrative ONLY (never the ledger)
//   5. review     (top)   — Tier-2, reads the change record AND the full diff
//
// The map is resolved ONCE at cycle start from which providers actually hold a
// usable credential (the same connector rows the app-level provider selector
// uses — no second credential store), stamped on the cycle, and echoed into the
// change record so any cycle can be reproduced. Neither provider configured →
// the cycle fails AT START with an operator message and writes no state.
//
// Rollout is doubly gated, and both gates default to the safe side:
//   * the framework bundle must carry the PHASE_ROUTING_MARKER in its build
//     skill (a framework-version bump — projects pinned to older published
//     versions keep the single-model path untouched), and
//   * the operator toggle (phase_routing setting / MOCK2_PHASE_ROUTING env)
//     must be on — it defaults ON, and 'off' restores the single-model path.
//
// Terminology (risk R7): nothing here is named "agent" (the recon workers are
// "scoped recon briefs" in operator-facing copy).

import { MODEL_PRIMARY, MODEL_BALANCED, MODEL_CHEAP, MODEL_FRONTIER } from './models.js';

// ---- rollout gates (framework marker + operator toggle) ----

// The capability tag a framework bundle's build skill carries once it has been
// bumped to the phased pipeline. Projects pinned to a framework version whose
// skills_json lacks the marker build exactly as before — the gate that keeps
// existing projects unchanged (acceptance #8).
export const PHASE_ROUTING_MARKER = 'phase-routing@1';

export const PHASE_ROUTING_FLAG = 'MOCK2_PHASE_ROUTING';

// The operator toggle. Default ON; only an explicit off/0/false disables.
export function phaseRoutingMode(env = {}) {
  const v = String(env?.[PHASE_ROUTING_FLAG] ?? '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' ? 'off' : 'on';
}

// Does this framework bundle declare the phased pipeline? skills_json may be
// the raw string or the parsed array — search the build skill's body for the
// marker (content-addressed, so an imported/reverted bundle answers honestly).
export function frameworkSupportsPhaseRouting(skillsJson) {
  let skills = skillsJson;
  if (typeof skills === 'string') {
    try { skills = JSON.parse(skills); } catch { return skills.includes(PHASE_ROUTING_MARKER); }
  }
  if (!Array.isArray(skills)) return false;
  return skills.some((s) => String(s?.body || '').includes(PHASE_ROUTING_MARKER));
}

// The one question the runner asks at cycle start: does the phased pipeline
// govern THIS cycle? Both gates must pass; either failing means the untouched
// single-model path (never an error).
export function phaseRoutingApplies({ skillsJson = null, env = {} } = {}) {
  return phaseRoutingMode(env) === 'on' && frameworkSupportsPhaseRouting(skillsJson);
}

// ---- the five phases and their tiers ----

export const BUILD_PHASES = Object.freeze([
  'recon', 'plan', 'implement_mechanical', 'implement_complex', 'summarize', 'review',
]);

export const PHASE_TIER = Object.freeze({
  recon: 'cheap',
  plan: 'top',
  implement_mechanical: 'cheap',
  implement_complex: 'mid',
  summarize: 'cheap',
  review: 'top',
});

// ---- providers and the tier → model maps ----

// The two providers the phase map routes across. Detection reuses the platform
// connector rows (ADR-003) — a provider counts as configured when an ENABLED
// connector for it holds a usable (decryptable) credential.
export const PHASE_PROVIDERS = Object.freeze(['anthropic', 'openai']);

const OPENAI_CHEAP = 'gpt-5.6-luna';
const OPENAI_MID = 'gpt-5.6-terra';
const OPENAI_TOP = 'gpt-5.6-sol';

// tier → { model, provider } per configuration scenario. Both present → the
// mixed map (cheap/mid on OpenAI, top on Anthropic); one present → that
// provider's single-vendor column. The pipeline shape is identical in all
// three — only the model ids change.
export const TIER_MODELS = Object.freeze({
  both: Object.freeze({
    cheap: Object.freeze({ model: OPENAI_CHEAP, provider: 'openai' }),
    mid: Object.freeze({ model: OPENAI_MID, provider: 'openai' }),
    top: Object.freeze({ model: MODEL_PRIMARY, provider: 'anthropic' }),
  }),
  openai: Object.freeze({
    cheap: Object.freeze({ model: OPENAI_CHEAP, provider: 'openai' }),
    mid: Object.freeze({ model: OPENAI_MID, provider: 'openai' }),
    top: Object.freeze({ model: OPENAI_TOP, provider: 'openai' }),
  }),
  anthropic: Object.freeze({
    cheap: Object.freeze({ model: MODEL_CHEAP, provider: 'anthropic' }),
    mid: Object.freeze({ model: MODEL_BALANCED, provider: 'anthropic' }),
    top: Object.freeze({ model: MODEL_PRIMARY, provider: 'anthropic' }),
  }),
});

// Pro/frontier tiers exist but are NEVER routed by default: OpenAI's pro tier
// is legacy and uncached, and Anthropic prices Fable above Opus. The only
// sanctioned use is an explicit operator opt-in on the PLAN phase (see
// resolvePhaseModelMap's planModelOverride) — a guard test asserts no default
// map contains either id.
export const PRO_TIER_MODELS = Object.freeze({
  openai: 'gpt-5.5-pro',
  anthropic: MODEL_FRONTIER,
});

// The operator-facing failure when no provider holds a usable credential. The
// caller must return this BEFORE inserting any cycle state (acceptance #3).
export const NO_PROVIDER_ERROR =
  'Per-phase model routing needs a usable Anthropic or OpenAI credential, and neither is configured. '
  + 'Add an enabled Anthropic or OpenAI model connector with a working API key (Admin → Model connectors), '
  + 'or turn per-phase routing off (phase_routing setting). The cycle was not started and no state was written.';

// detectPhaseProviders — which of the two routable providers are configured,
// from connector rows shaped { provider, enabled, keyUsable }. Pure: the
// native caller computes keyUsable via isSecretDecryptable (the SAME signal
// the app-level provider selector exposes as secret_decryptable — one
// credential store, reused). Order-stable: anthropic before openai.
export function detectPhaseProviders(connectors = []) {
  const found = new Set();
  for (const c of connectors || []) {
    if (!c || !c.enabled || !c.keyUsable) continue;
    const p = String(c.provider || '').trim().toLowerCase();
    if (PHASE_PROVIDERS.includes(p)) found.add(p);
  }
  return PHASE_PROVIDERS.filter((p) => found.has(p));
}

// resolvePhaseModelMap — the phase → { model, provider, tier } map for this
// cycle. Resolved once at cycle start; the result is stamped on the cycle and
// echoed into the change record (reproducibility).
//
//   providers          — output of detectPhaseProviders
//   planModelOverride  — the ONLY sanctioned pro-tier opt-in: an explicit
//                        model id applied to the plan phase alone. It never
//                        touches any other phase.
//
// Returns { ok:true, scenario, providers, map } or { ok:false, error }.
export function resolvePhaseModelMap({ providers = [], planModelOverride = null } = {}) {
  const p = PHASE_PROVIDERS.filter((x) => (providers || []).includes(x));
  const scenario = p.length === 2 ? 'both' : p[0] || null;
  if (!scenario) return { ok: false, error: NO_PROVIDER_ERROR };
  const tiers = TIER_MODELS[scenario];
  const map = {};
  for (const phase of BUILD_PHASES) {
    const tier = PHASE_TIER[phase];
    map[phase] = { ...tiers[tier], tier };
  }
  const override = String(planModelOverride || '').trim();
  if (override) {
    map.plan = { ...map.plan, model: override, tier: 'override' };
  }
  return { ok: true, scenario, providers: p, map };
}

// ---- the 3a/3b router (extends the existing size router with a MODEL axis) ----

// The hard carve-out list. This is not a new policy — it is the union of the
// change-record template's Surface triggers (authentication/authorization/
// session; data deletion/retention/migration; money/billing/external payment)
// and the constitution's human-sovereign escalation list (security-sensitive,
// first-time integrations, compliance-touching), reused as the routing floor:
// the list that already governs human surfacing also governs which model may
// implement. A task touching ANY of these is never `mechanical`, regardless
// of size (the cycle-690 lesson: a 60-line RBAC rename carried a cross-file
// invariant no size heuristic can see).
export const IMPLEMENT_TOUCHES = Object.freeze([
  'auth', 'rbac', 'crypto', 'migration', 'external-integration', 'money',
]);

// Normalize a work-file `touches` list: keep known surfaces, drop 'none' and
// junk, dedupe. Unknown NON-EMPTY strings are kept conservatively — a surface
// the plan flagged that this list hasn't heard of should still block the
// cheap tier, not silently pass it.
export function normalizeTouches(list = []) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const v = String(t || '').trim().toLowerCase();
    if (!v || v === 'none') continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export const COMPLEXITIES = Object.freeze(['mechanical', 'complex']);

// implementLaneForTask — 3a or 3b for one work-file task. The PLAN phase emits
// { complexity, touches } (it already holds the recon briefs + instruction, so
// no extra classifier stage runs); this function is the enforcement:
//   * touches non-empty → implement_complex, ALWAYS (the carve-out)
//   * complexity 'mechanical' → implement_mechanical
//   * anything else (complex / missing / junk) → implement_complex (safe side)
export function implementLaneForTask({ complexity = null, touches = [] } = {}) {
  const t = normalizeTouches(touches);
  if (t.length > 0) {
    return { lane: 'implement_complex', reason: `touches:${t.join(',')}` };
  }
  const c = String(complexity || '').trim().toLowerCase();
  if (c === 'mechanical') return { lane: 'implement_mechanical', reason: 'complexity:mechanical' };
  return { lane: 'implement_complex', reason: c === 'complex' ? 'complexity:complex' : 'unclassified (safe default)' };
}

// A mechanical task that fails the Tier-1 gate battery twice escalates to the
// 3b model — never a third attempt on the cheap tier. The escalation is
// recorded in the change record (the caller stamps `record`).
export const MECHANICAL_TIER1_FAILURE_LIMIT = 2;

export function mechanicalEscalation({ lane = null, tier1Failures = 0 } = {}) {
  const escalate = lane === 'implement_mechanical'
    && Number(tier1Failures) >= MECHANICAL_TIER1_FAILURE_LIMIT;
  return {
    escalate,
    lane: escalate ? 'implement_complex' : lane,
    record: escalate
      ? `escalated: mechanical task moved to the complex-tier model after ${Number(tier1Failures)} Tier-1 gate failures`
      : null,
  };
}

// ---- recon briefs (phase 1 — the only genuinely new phase) ----

// state/recon/NNN-<subsystem>.md — one compressed brief per touched subsystem,
// committed so phase 2 reads briefs instead of the raw tree (and so a resumed
// or reproduced cycle sees exactly what the plan saw).
export function reconBriefPath(seq, subsystem) {
  const n = String(Math.max(0, Number(seq) || 0)).padStart(3, '0');
  const slug = String(subsystem || 'subsystem')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'subsystem';
  return `state/recon/${n}-${slug}.md`;
}

// ---- Correction A: the assumption ledger stays with the implementer ----

// The only source a change-record assumption ledger may declare. The ledger is
// an epistemic claim about the IMPLEMENTER'S own process (what it read vs.
// what it took on faith) — a summarizer reading the finished diff cannot know
// it, and would fill it in fluently and wrongly.
export const LEDGER_SOURCE_IMPLEMENT = 'implement';

// The provenance marker phase 3 stamps into a markdown change record's ledger
// section, and the template section formalising the ledger (it was an emergent
// practice with no template field).
export const LEDGER_MD_MARKER = '<!-- ledger-source: implement -->';

export const LEDGER_TEMPLATE_SECTION = `## Assumption ledger (authored by the implement phase — verbatim, never summarized)
${LEDGER_MD_MARKER}

### Assumptions verified
<!-- Checked by reading source THIS cycle — cite the file read. -->
- …  (verified against: \`path/to/file\`)

### Assumptions assumed
<!-- Taken on faith — say why it could not be verified this cycle. -->
- …  (why unverified: …)
`;

// parseAssumptionLedger — find the ledger in a change record, in EITHER
// serialization (the reference project's state/changes/N.json and the skill
// template's NNN-change-record.md both exist in the wild; break neither):
//   * object: record.assumption_ledger (or legacy record.assumptions) with
//     { source, verified: [], assumed: [] }
//   * string (markdown): the "Assumptions verified"/"Assumptions assumed"
//     headings, with the LEDGER_MD_MARKER as the provenance stamp.
// Returns { present, source, verified, assumed }.
export function parseAssumptionLedger(record) {
  if (record && typeof record === 'object') {
    const ledger = record.assumption_ledger || record.assumptions || null;
    if (!ledger || typeof ledger !== 'object') return { present: false, source: null, verified: [], assumed: [] };
    return {
      present: Array.isArray(ledger.verified) || Array.isArray(ledger.assumed),
      source: ledger.source != null ? String(ledger.source) : null,
      verified: Array.isArray(ledger.verified) ? ledger.verified : [],
      assumed: Array.isArray(ledger.assumed) ? ledger.assumed : [],
    };
  }
  const text = String(record || '');
  const hasVerified = /^#{2,3}\s+Assumptions?\s+verified/im.test(text);
  const hasAssumed = /^#{2,3}\s+Assumptions?\s+assumed/im.test(text);
  const m = /<!--\s*ledger-source:\s*([a-z0-9_-]+)\s*-->/i.exec(text);
  return {
    present: hasVerified && hasAssumed,
    source: m ? m[1].toLowerCase() : null,
    verified: [],
    assumed: [],
  };
}

// closeOutLedgerVerdict — the close-out assertion (acceptance #6): when the
// phased pipeline governed the cycle, a change record whose ledger is missing
// or did not come from the implement phase FAILS the cycle — the record is
// never shipped with an invented ledger. When phase routing did not apply,
// legacy records pass untouched.
export function closeOutLedgerVerdict({ record = null, phaseRoutingApplied = false } = {}) {
  if (!phaseRoutingApplied) return { ok: true, error: null };
  const ledger = parseAssumptionLedger(record);
  if (!ledger.present) {
    return {
      ok: false,
      error: 'close-out failed: the change record carries no assumption ledger from the implement phase. '
        + 'Phase 4 (summarize) must not author, edit, infer, or "improve" the ledger — the cycle fails rather '
        + 'than shipping a record with an invented one.',
    };
  }
  if (ledger.source !== LEDGER_SOURCE_IMPLEMENT) {
    return {
      ok: false,
      error: `close-out failed: the change record's assumption ledger declares source "${ledger.source || '(none)'}" `
        + `— only "${LEDGER_SOURCE_IMPLEMENT}" (phase 3, emitted while it still held the context) is acceptable.`,
    };
  }
  return { ok: true, error: null };
}

// ---- Correction B: the reviewer reads the diff, not the summary ----

// The explicit line added to every Tier-2 dispatch prompt.
export const REVIEW_DIFF_INSTRUCTION =
  'The change record is an orientation aid. Every finding must cite file:line from the diff. '
  + 'Do not report a finding you could only have learned from the summary.';

// buildReviewDispatchInputs — assemble what phase 5 receives: the change
// record (orientation) AND the full diff (ground truth), plus the context it
// receives today. Refuses to dispatch without the diff — passing only phase
// 4's output would be a REGRESSION against what the harness guarantees
// ("review the diff", "trace at least the deny paths", findings with
// file:line — none of it possible from a summary).
export function buildReviewDispatchInputs({
  changeRecord = '', diff = '', claudeMd = '', inventory = '', rules = '', workFile = '',
} = {}) {
  if (!String(diff || '').trim()) {
    return {
      ok: false,
      error: 'Tier-2 review dispatch requires the full diff — the change record alone is not reviewable ground truth.',
    };
  }
  const sections = [
    REVIEW_DIFF_INSTRUCTION,
    claudeMd ? `# Constitution (CLAUDE.md)\n${claudeMd}` : null,
    inventory ? `# Inventory\n${inventory}` : null,
    rules ? `# Confirmed rules\n${rules}` : null,
    workFile ? `# Work file\n${workFile}` : null,
    changeRecord ? `# Change record (orientation aid — not ground truth)\n${changeRecord}` : null,
    `# The diff (ground truth)\n${diff}`,
  ].filter(Boolean);
  return { ok: true, prompt: sections.join('\n\n'), error: null };
}

// ---- cost posture (the five selectable spend/quality presets) ----

// How the resolved phase map is shaped before it runs. Applied AFTER provider
// resolution, so every posture stays provider-aware (an Anthropic-only
// install's "ultra cheap" is Haiku; with OpenAI configured it is Luna).
//
//   default     — the manually set configuration: the resolved map exactly as
//                 configured (including any plan-phase override). Ships as
//                 the default posture, so behavior is unchanged until an
//                 operator picks something else.
//   suggested   — the platform's recommended tier map at every phase
//                 (drops manual overrides; pure cheap/mid/top routing).
//   ultra_cheap — the lowest-cost model from the available providers for
//                 EVERYTHING (Luna, else Haiku). The Tier-1 gates still run;
//                 the touches carve-out becomes moot because 3a and 3b share
//                 one model.
//   balanced    — the mid tier (Terra / Sonnet level) for everything.
//   max_quality — "take my money": the best available flagship across the
//                 configured providers for everything (Fable 5 when Anthropic
//                 is configured, else Sol). This is the one sanctioned way a
//                 frontier tier runs outside the plan phase — an explicit
//                 operator opt-in, never a default. gpt-5.5-pro stays
//                 excluded even here (legacy, uncached, off the active sheet).
export const PHASE_POSTURES = Object.freeze(['default', 'suggested', 'ultra_cheap', 'balanced', 'max_quality']);

export const PHASE_POSTURE_FLAG = 'MOCK2_PHASE_POSTURE';

export function normalizePhasePosture(value) {
  const v = String(value || '').trim().toLowerCase();
  return PHASE_POSTURES.includes(v) ? v : 'default';
}

export function phasePosture(env = {}) {
  return normalizePhasePosture(env?.[PHASE_POSTURE_FLAG]);
}

// The single { model, provider } each uniform posture pins per scenario.
const POSTURE_UNIFORM_MODELS = Object.freeze({
  ultra_cheap: Object.freeze({
    both: Object.freeze({ model: OPENAI_CHEAP, provider: 'openai' }),
    openai: Object.freeze({ model: OPENAI_CHEAP, provider: 'openai' }),
    anthropic: Object.freeze({ model: MODEL_CHEAP, provider: 'anthropic' }),
  }),
  balanced: Object.freeze({
    both: Object.freeze({ model: OPENAI_MID, provider: 'openai' }),
    openai: Object.freeze({ model: OPENAI_MID, provider: 'openai' }),
    anthropic: Object.freeze({ model: MODEL_BALANCED, provider: 'anthropic' }),
  }),
  max_quality: Object.freeze({
    both: Object.freeze({ model: MODEL_FRONTIER, provider: 'anthropic' }),
    openai: Object.freeze({ model: OPENAI_TOP, provider: 'openai' }),
    anthropic: Object.freeze({ model: MODEL_FRONTIER, provider: 'anthropic' }),
  }),
});

// applyPhasePosture — shape a resolvePhaseModelMap result by the chosen
// posture. Pure; returns a NEW result carrying `posture`. A failed resolution
// passes through untouched (the no-provider refusal outranks any posture).
export function applyPhasePosture(resolved, posture = 'default') {
  if (!resolved?.ok) return resolved;
  const p = normalizePhasePosture(posture);
  if (p === 'default') return { ...resolved, posture: p };
  if (p === 'suggested') {
    // The recommended tier map, with any manual override dropped.
    const fresh = resolvePhaseModelMap({ providers: resolved.providers });
    return { ...fresh, posture: p };
  }
  const pick = POSTURE_UNIFORM_MODELS[p][resolved.scenario];
  const map = {};
  for (const phase of BUILD_PHASES) {
    map[phase] = { ...pick, tier: p };
  }
  return { ...resolved, map, posture: p };
}

// ---- the change-record echo (reproducibility) ----

// One compact line for the change-record summary naming the resolved map, so
// any cycle can be reproduced from its record. Reads the shape stamped into
// routing_json ({ phase_scenario, phase_map }) or a resolvePhaseModelMap
// result ({ scenario, map }). Null when the cycle wasn't phase-routed.
export function phaseMapRecordLine(doc) {
  const map = doc?.phase_map || doc?.map || null;
  const scenario = doc?.phase_scenario || doc?.scenario || null;
  const posture = doc?.phase_posture || doc?.posture || null;
  if (!map || typeof map !== 'object') return null;
  const parts = BUILD_PHASES
    .filter((ph) => map[ph]?.model)
    .map((ph) => `${ph}=${map[ph].model} (${map[ph].provider || '?'})`);
  if (!parts.length) return null;
  const head = posture && posture !== 'default'
    ? `${scenario || 'unknown'}, posture: ${posture}`
    : (scenario || 'unknown');
  return `Phase model map [${head}]: ${parts.join(', ')}`;
}
