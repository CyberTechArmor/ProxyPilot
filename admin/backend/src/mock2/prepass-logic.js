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
import { MODEL_CHEAP_PINNED } from './models.js';

export const PREPASS_SCOPES = Object.freeze(['simple', 'multi_part', 'feature_scale']);
// Whether the request has an outcome anyone could check afterwards. See
// clarify-logic.js for why this is the test and why length is not.
export const PREPASS_SPECIFICITY = Object.freeze(['clear', 'vague']);
export const PREPASS_DEFAULT_MODEL = MODEL_CHEAP_PINNED;
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
  "specificity": "clear" | "vague",
  "pages": ["/route the request refers to", ...],
  "brief": {
    "touches": ["screens/areas/files likely affected", ...],
    "states": ["UI/data states worth handling (empty, loading, error, edge sizes)", ...],
    "edge_cases": ["specific pitfalls for THIS request", ...],
    "acceptance": ["concrete checks that would prove it works", ...],
    "domain_expectations": ["what a domain expert would assume is included", ...]
  },
  "split": { "parts": [{ "title": "...", "items": ["deliverable", ...] }, ...] }
}
"specificity" answers ONE question: after this build, could anyone tell whether
it was done? "clear" = yes, there is an outcome to look at. "vague" = it names a
judgement with no object ("make it look better", "fix the css issues", "it feels
off") and you could not write a single concrete acceptance check for it. Judge
the REQUEST, not its length — "put the cursor back where the server last saw it"
is clear at 50 characters, "please doublecheck the design and fix any css
issues" is vague at 50 words.
"pages" lists only routes the request actually refers to (e.g. "/admin"), for
screenshotting. Omit it when the request names none — do not guess.
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
  // Absent is neither: an older model output, or one that skipped the field,
  // must not read as a verdict either way — the clarifier falls back to its own
  // deterministic read rather than interrupting on no evidence.
  const specificity = PREPASS_SPECIFICITY.includes(doc.specificity) ? doc.specificity : null;
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
  const pages = (Array.isArray(doc.pages) ? doc.pages : [])
    .filter((p) => typeof p === 'string' && /^\/[a-z]/i.test(p.trim()))
    .slice(0, 4).map((p) => p.trim().slice(0, 120));
  return { scope, specificity, pages, brief: hasContent ? brief : null, split };
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

// ---- chat message → build prompt distillation ----
// The "Build this as a Quick update" button on a chat bubble: an Ask answer
// listing improvements (or a review's findings) becomes ONE well-formed
// quick-update instruction — the step the operator was doing by hand with
// "please write the prompt for all of that".

export function buildDistillSystemPrompt() {
  return `You turn a message from a build chat into ONE well-formed build instruction
for an AI app builder's quick-update lane. The message is usually an assistant
answer — a list of suggested improvements, a review's findings, or a plan.
Write the instruction a skilled operator would send to get ALL of its concrete,
definite items built.
Rules:
- Imperative voice, addressed to the builder ("Add …", "Record …", "Show …").
- Preserve EVERY concrete deliverable the message contains; merge duplicates.
- Keep specific details: field names, endpoints, states, edge cases, acceptance
  criteria. Number the deliverables when there are several.
- Skip pure questions, rejected alternatives, and meta-commentary.
- Do NOT invent anything the message does not contain.
- Output ONLY the instruction text — no preamble, no quotes, no code fences,
  never "Here's the prompt".`;
}

export function buildDistillUserTurn({ body = '', precedingUser = '' } = {}) {
  const ctx = String(precedingUser || '').trim()
    ? `For context, the user message that prompted it:\n"""\n${String(precedingUser).trim().slice(0, 2000)}\n"""\n\n`
    : '';
  return `${ctx}The chat message to convert into a build instruction:\n"""\n${String(body).trim().slice(0, 24000)}\n"""`;
}

// Strip fences/preambles the model might add anyway; null when unusable.
export function cleanDistilledInstruction(text) {
  let s = String(text || '').trim();
  const fence = /```(?:\w+)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  s = s.replace(/^(?:here(?:'|’)s[^\n:]*|the (?:build )?instruction[^\n:]*|prompt)\s*:\s*/i, '').trim();
  if (s.length < 10) return null;
  return s.slice(0, 6000);
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

// The specificity directive (harness redesign, Phase 2 point 3). The pre-pass
// already classifies every request clear/vague and by scope; until now that
// classification never reached the BUILD, so a vague request got a literal
// build of its vagueness and a specific one got adjacent "improvements". One
// block, injected into the task turn right after the instruction: vague →
// think like the domain expert and expand deliberately (P34's quality came
// from cheap iterations on exactly such expansions); specific → literal and
// complete, never contorted toward what a checker might match on.
export function formatSpecificityForTask(prepass) {
  if (!prepass) return '';
  const spec = String(prepass.specificity || '').toLowerCase();
  const scope = String(prepass.scope || 'simple').toLowerCase();
  if (spec === 'vague') {
    return `\n\nThis request was classified VAGUE (scope: ${scope}) — no single checkable outcome. You are the domain expert for this kind of app. BEFORE building, state in 3-6 lines what an app in this domain typically needs that the request does not mention, choose the additions a thoughtful expert would include at this stage, and integrate them properly (a reminder has a date/time and recurrence; a search has an empty state; a table collapses on mobile). Expand the idea; do not gold-plate — every addition must serve the stated purpose.`;
  }
  if (spec === 'clear') {
    return `\n\nThis request was classified SPECIFIC (scope: ${scope}). Follow the instruction literally and completely: do not substitute, do not add adjacent features, and never modify the UI to satisfy what you guess a checker matches on. If the instruction conflicts with a gate, satisfy the instruction and state the conflict in your finish summary rather than contorting the UI.`;
  }
  return '';
}

// The chat note posted when a quick update reads feature-sized. Suggestion
// only — the build still runs.
export function featureScaleNotice() {
  return 'Heads-up: this request reads feature-sized, not like a small tweak. It will still run as a Quick update (at raised effort), but a whole page/feature usually comes out more complete via Build MVP (design-aware, more turns) or a Full build (audited). You can Interrupt this build and rerun it there if you prefer.';
}
