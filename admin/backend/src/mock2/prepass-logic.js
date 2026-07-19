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
    "acceptance": ["concrete checks that would prove it works", ...]
  }
}
Scope rubric:
- "simple": one screen/element, one behavior — a button, a label, one endpoint tweak.
- "multi_part": several coordinated changes — a screen plus its API, or 2-4 related elements.
- "feature_scale": a whole page/feature/redesign — would take a person a session, not minutes.
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
  };
  const hasContent = Object.values(brief).some((l) => l.length);
  return { scope, brief: hasContent ? brief : null };
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
  ].filter(Boolean);
  if (!lines.length) return '';
  return `\n\nWorking brief (auto-generated sizing notes — the request above is authoritative; ignore any note that contradicts it):\n- ${lines.join('\n- ')}`;
}

// The chat note posted when a quick update reads feature-sized. Suggestion
// only — the build still runs.
export function featureScaleNotice() {
  return 'Heads-up: this request reads feature-sized, not like a small tweak. It will still run as a Quick update (at raised effort), but a whole page/feature usually comes out more complete via Build MVP (design-aware, more turns) or a Full build (audited). You can Interrupt this build and rerun it there if you prefer.';
}
