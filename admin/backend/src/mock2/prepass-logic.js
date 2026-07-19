// Mock2 QUICK-LANE PRE-PASS pure decision layer — one cheap classifier +
// enrichment call before a quick update runs. Native-free, unit-tested
// stub-first (risk R9).
//
// The problem: the quick lane TRUSTS the operator that a request is small.
// "Make a whole reporting page" typed into Quick update gets one fixed-effort
// pass with a one-line brief — while the same ask in Claude Code would get a
// long, self-directed session. The pre-pass closes that gap for ~a cent:
//
//   - CLASSIFY the request's real scope: simple | multi_part | feature_scale
//     (classify to ROUTE, never to block — the build always proceeds)
//   - ENRICH the one-liner into a short working brief (touches / states /
//     edge cases / acceptance) that rides WITH the verbatim instruction —
//     never replacing it; the instruction stays authoritative
//   - feature_scale additionally posts a chat suggestion to run Build MVP
//
// Fail-open everywhere: any parse/model failure = no pre-pass, unchanged
// behavior. MOCK2_PREPASS=off disables; MOCK2_PREPASS_MODEL overrides the
// default cheap model.
//
// Terminology (risk R7): nothing here is named "agent".

import { ROUTING_EFFORTS } from './routing-logic.js';

export const PREPASS_SCOPES = Object.freeze(['simple', 'multi_part', 'feature_scale']);
export const PREPASS_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const PREPASS_MAX_TOKENS = 900;
const LIST_MAX = 6;
const ITEM_MAX_CHARS = 140;

export function prepassEnabled(env = {}) {
  return String(env?.MOCK2_PREPASS ?? '').trim().toLowerCase() !== 'off';
}

export function prepassModel(env = {}) {
  return String(env?.MOCK2_PREPASS_MODEL ?? '').trim() || PREPASS_DEFAULT_MODEL;
}

// The classifier/enricher prompt: STRICT JSON out, nothing else. The model
// sees only the instruction — no project context needed at this altitude.
export function buildPrepassPrompt() {
  return `You size and brief incoming build requests for a web-app build system.
Reply with STRICT JSON only — no prose, no code fences. Schema:
{
  "scope": "simple" | "multi_part" | "feature_scale",
  "brief": {
    "touches": ["screens/areas/files likely affected", ...],
    "states": ["UI/data states worth handling (empty, loading, error, edge sizes)", ...],
    "edge_cases": ["specific pitfalls for THIS request", ...],
    "acceptance": ["concrete checks that would prove it works", ...],
    "domain_expectations": ["what a domain expert would assume is included", ...]
  },
  "split": { "parts": [{ "title": "...", "items": ["deliverable", ...] }, ...] }
}
Scope rubric:
- "simple": one screen/element, one behavior — a button, a label, one endpoint tweak.
- "multi_part": several coordinated changes — a screen plus its API, or 2-4 related elements.
- "feature_scale": a whole page/feature/redesign — would take a person a session, not minutes.
"split" ONLY when scope is "feature_scale" AND the request naturally decomposes into
2-4 sequential parts that are EACH independently buildable, deployable, and
checkable by a human (part 1 must be useful before part 2 exists). Order parts by
dependency. Omit "split" entirely when a decomposition would be artificial.
"domain_expectations" is where you think like a DOMAIN EXPERT, not a coder: what
would a professional in this domain assume the feature obviously includes even
though the request doesn't spell it out? (A timesheet records and shows EVERY
clock-in/out pair per day, not one line; a payment flow shows a receipt; an
approval queue flags items stuck too long.) Include derived signals worth
surfacing (anomalies, missing entries, overages). Skip it for trivial tweaks.
Keep every list to at most ${LIST_MAX} short items; omit empty lists. Be concrete, never generic.`;
}

// Tolerant reply parser: strips code fences, finds the outermost JSON object,
// validates scope, clamps list sizes/lengths. null on anything unusable.
export function parsePrepassReply(text) {
  let s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let doc;
  try { doc = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  const scope = PREPASS_SCOPES.includes(doc.scope) ? doc.scope : null;
  if (!scope) return null;
  const clampList = (v) => (Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, LIST_MAX).map((x) => x.trim().slice(0, ITEM_MAX_CHARS))
    : []);
  const rawBrief = doc.brief && typeof doc.brief === 'object' ? doc.brief : {};
  const brief = {
    touches: clampList(rawBrief.touches),
    states: clampList(rawBrief.states),
    edge_cases: clampList(rawBrief.edge_cases),
    acceptance: clampList(rawBrief.acceptance),
    domain_expectations: clampList(rawBrief.domain_expectations),
  };
  const hasContent = Object.values(brief).some((l) => l.length);
  // The optional split proposal (feature_scale only): 2-4 titled parts, each
  // with its deliverable items — the "build half, check it, rest follows" plan.
  let split = null;
  const rawParts = doc.split && Array.isArray(doc.split.parts) ? doc.split.parts : [];
  if (scope === 'feature_scale' && rawParts.length >= 2) {
    const parts = rawParts.slice(0, 4).map((p) => ({
      title: String(p?.title ?? '').trim().slice(0, 80),
      items: clampList(p?.items),
    })).filter((p) => p.title && p.items.length);
    if (parts.length >= 2) split = { parts };
  }
  return { scope, brief: hasContent ? brief : null, split };
}

// How a project handles the pre-pass's domain expectations:
//   'ask'  — show the additions card, the user picks what to include (default)
//   'auto' — fold every surfaced expectation into the build, no card
//   'off'  — build exactly what was asked; expectations are dropped entirely
export const SUGGEST_MODES = Object.freeze(['off', 'ask', 'auto']);

export function normalizeSuggestMode(v) {
  return SUGGEST_MODES.includes(v) ? v : 'ask';
}

// Fold confirmed (or auto-included) additions into the instruction as BINDING
// deliverables — unlike the working brief, these were surfaced to the user (or
// covered by their 'auto' setting), so they are scope, not advice.
export function composeWithAdditions(instruction, extras = [], { auto = false } = {}) {
  const items = (Array.isArray(extras) ? extras : [])
    .map((s) => String(s || '').trim()).filter(Boolean)
    .slice(0, LIST_MAX).map((s) => s.slice(0, ITEM_MAX_CHARS * 2));
  const base = String(instruction || '');
  if (!items.length) return base;
  const label = auto
    ? 'Also deliver these domain-expected additions (auto-included by this project\'s suggestion setting; binding):'
    : 'Also deliver these additions the user confirmed (binding):';
  return `${base}\n\n${label}\n${items.map((i) => `- ${i}`).join('\n')}`;
}

// The scoped instruction for ONE group of a split request. Binding scope; the
// remaining groups are named so interconnection points get honest "Not built
// yet" markers instead of dead elements.
export function buildGroupInstruction({ title, items = [], index = 1, total = 1, original = '' }) {
  const later = total > index ? ` Later groups of this same request handle the rest — where this group's UI touches
their territory, leave a visibly disabled control with a "Not built yet" badge, never a dead element.` : '';
  return `Part ${index} of ${total} of a split request — ${title}. Deliver exactly: ${items.join('; ')}. ` +
    `The ORIGINAL full request, for context only (do NOT build beyond this part's deliverables): "${String(original).slice(0, 800)}". ` +
    'Scope is BINDING to this part. Match the approved mockup (state/mockups/current.html) and load /design.css. ' +
    'STATE items are conditions to handle when they genuinely occur — never fabricate artificial ones.' + later;
}

// One effort notch up for requests that turned out bigger than the lane
// assumes. Bounded by the scale — 'max' stays 'max'.
export function bumpEffort(effort) {
  const i = ROUTING_EFFORTS.indexOf(effort);
  if (i === -1) return effort || 'high';
  return ROUTING_EFFORTS[Math.min(i + 1, ROUTING_EFFORTS.length - 1)];
}

// The effort a pre-passed quick cycle should run at: simple keeps the lane
// effort; anything bigger gets one notch more.
export function prepassEffort(scope, baseEffort) {
  if (scope === 'multi_part' || scope === 'feature_scale') return bumpEffort(baseEffort);
  return baseEffort;
}

// The brief as a task-turn block. Explicitly subordinate to the instruction —
// the model must treat the verbatim request as authoritative.
export function formatBriefForTask(prepass) {
  const b = prepass?.brief;
  if (!b) return '';
  const section = (label, items) => (items?.length ? `${label}: ${items.join('; ')}` : null);
  const lines = [
    section('Likely touches', b.touches),
    section('States to handle', b.states),
    section('Edge cases', b.edge_cases),
    section('Acceptance checks', b.acceptance),
    section('Domain expectations (what an expert user assumes is included)', b.domain_expectations),
  ].filter(Boolean);
  if (!lines.length) return '';
  return `\n\nWorking brief (auto-generated sizing notes — the request above is authoritative; ignore any note that contradicts it):\n- ${lines.join('\n- ')}`;
}

// The chat note posted when a quick update reads feature-sized. Suggestion
// only — the build still runs.
export function featureScaleNotice() {
  return 'Heads-up: this request reads feature-sized, not like a small tweak. It will still run as a Quick update (at raised effort), but a whole page/feature usually comes out more complete via Build MVP (design-aware, more turns) or a Full build (audited). You can Interrupt this build and rerun it there if you prefer.';
}
