// Mock2 escalation-consult PURE decision layer (cost-truth Part 5.2). Native-free,
// unit-tested. The "second opinion": ONE bounded, advisory-only Fable 5 call that fires
// only when Opus 4.8 is demonstrably stuck. It never takes over the build, never
// switches the build lane, has NO tool access (a compiled context digest only), and is
// hard-capped so it can't run away in cost.
//
// Terminology (risk R7): nothing here is named "agent".

// The model the consult runs on — Fable 5, everywhere the consult is invoked. This is
// the ONLY build-time code path (besides the audit lane) that names Fable 5.
import { MODEL_FRONTIER } from './models.js';
// Reused, not reimplemented: the same token-Jaccard similarity finish-guard-logic
// uses to catch an identical-retry finish payload catches a re-reported symptom
// here — both are "is this text substantially the same thing again".
import { payloadSimilarity } from './finish-guard-logic.js';

export const CONSULT_MODEL = MODEL_FRONTIER;

// Feature flag for AUTO consults (triggers a–c fire from the runner mid-halt). Default
// OFF so the runner is byte-identical until an operator opts in on the live install. The
// operator "Get guidance" button (trigger d) is NOT gated by this — it's an explicit,
// on-demand request through its own route, never touching the runner loop.
export const CONSULT_FLAG = 'MOCK2_CONSULT';

export function consultAutoEnabled(env = {}) {
  const v = String(env?.[CONSULT_FLAG] ?? '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

// Deterministic triggers (spec Part 5.2). Auto triggers (a–c) fire from runner signals;
// 'operator' is the "Get guidance" button on a halt card and bypasses the auto caps.
export const CONSULT_TRIGGERS = Object.freeze([
  'gate_failed_twice',   // (a) same gate fails ≥2 consecutive attempts within a cycle
  'no_progress',         // (b) the no-progress circuit breaker trips
  'same_reason_rehalt',  // (c) a resumed request halts AGAIN for the same reason
  'operator',            // (d) operator clicked "Get guidance"
]);

// Hard cost containment: no tools, input ~30k tokens, output ~4k tokens ⇒ ≈ $0.50 at
// Fable 5 rates ($10/$50 per M): 30k×$10/M + 4k×$50/M = $0.30 + $0.20 = $0.50.
export const CONSULT_INPUT_TOKEN_CAP = 200_000;
export const CONSULT_OUTPUT_TOKEN_CAP = 16_000;

// Caps: at most 1 consult per halt, 2 per request; beyond that the operator button is
// required (an auto trigger is refused, the operator may still ask).
export const CONSULT_MAX_PER_HALT = 1;
export const CONSULT_MAX_PER_REQUEST = 2;

// A conservative chars-per-token for clipping the digest to the input cap (English
// prose + code ≈ 4 chars/token; erring small keeps us safely under the cap).
const CHARS_PER_TOKEN = 4;

// consultTrigger — the deterministic trigger for a set of runner signals, or null when
// none applies. Checked in priority order; the operator button is handled separately
// (it always fires, subject only to being an explicit request).
export function consultTrigger({ gateFailStreak = 0, breakerTripped = false, reHaltSameReason = false, operatorRequested = false } = {}) {
  if (operatorRequested) return 'operator';
  if (Number(gateFailStreak) >= 2) return 'gate_failed_twice';
  if (breakerTripped) return 'no_progress';
  if (reHaltSameReason) return 'same_reason_rehalt';
  return null;
}

// consultAllowed — may a consult fire now? Auto triggers respect BOTH caps (1/halt,
// 2/request); the operator button ('operator') bypasses the auto caps (the operator is
// explicitly choosing to spend). Returns { allowed, reason }.
export function consultAllowed({ trigger = null, perHaltCount = 0, perRequestCount = 0 } = {}) {
  if (!trigger) return { allowed: false, reason: 'no trigger' };
  if (trigger === 'operator') return { allowed: true, reason: 'operator requested' };
  if (Number(perHaltCount) >= CONSULT_MAX_PER_HALT) {
    return { allowed: false, reason: `already consulted on this halt (max ${CONSULT_MAX_PER_HALT}); use "Get guidance" to ask again` };
  }
  if (Number(perRequestCount) >= CONSULT_MAX_PER_REQUEST) {
    return { allowed: false, reason: `consult limit reached for this request (max ${CONSULT_MAX_PER_REQUEST}); use "Get guidance" to ask again` };
  }
  return { allowed: true, reason: `auto: ${trigger}` };
}

// ---- symptom-chase cap (run-taxonomy fix #7/B2) ----
//
// The problem, measured: docs2's export-menu saga ran five cycles guessing at
// the same symptom before the answer (one CSS rule) surfaced. The apparatus to
// stop this already existed — consultTrigger's 'same_reason_rehalt' case, the
// diagnose-logic root-cause pass — but reHaltSameReason was never fed a real
// value (every haltCycle call site passed only { gateFailStreak }), so the
// trigger has never fired in production. These two functions are what actually
// fill that in, plus a build-time cap that stops a THIRD attempt at the same
// symptom from ever reaching the runner at all.

// normalizeHaltReason — a halt reason reduced to its stable shape. Quoted
// spans, path-like tokens, and digit runs carry the incidental detail (a line
// number, a specific file); what remains is the SHAPE of the blocker, so
// "blocked: cannot read foo.ts at line 42" and "blocked: cannot read foo.ts at
// line 88" normalise to the same wall. Deliberately aggressive — a false match
// costs a diagnosis instead of a third guess, which is a strictly better
// outcome; a false miss just means the cap never trips.
export function normalizeHaltReason(reason) {
  let s = String(reason || '').toLowerCase().trim();
  s = s.replace(/`[^`]*`/g, '<code>');
  s = s.replace(/"[^"]*"/g, '<str>');
  s = s.replace(/'[^']*'/g, '<str>');
  s = s.replace(/\S*\/\S+\.\S+/g, '<path>'); // any slash-containing, dotted token
  s = s.replace(/\d+/g, '#');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
}

// reHaltSameReason — did this request already halt for the same (normalised)
// reason? Feeds consultTrigger's 'same_reason_rehalt' case directly.
export function reHaltSameReason({ reason, priorReasons = [] } = {}) {
  const norm = normalizeHaltReason(reason);
  if (!norm) return false;
  return (priorReasons || []).some((r) => normalizeHaltReason(r) === norm);
}

// The similarity floor for "this instruction is asking about the same
// symptom". Calibrated empirically against payloadSimilarity's plain token
// overlap, which turns out to be a BLUNT signal on short instructions — two
// requests that share a feature's nouns but ask for opposite things ("add a
// cancel button" vs "fix the cancel button's color") can score HIGHER than
// two genuine paraphrases of the same complaint ("the export menu doesn't
// open" vs "export menu click does nothing", 0.43), because short sentences
// are dominated by shared function words. A high floor (0.7, close to
// finish-guard-logic's own NEAR_IDENTICAL_SIMILARITY=0.9) catches the
// realistic case — an operator re-sending the same or near-the-same bug
// report — while erring toward MISSING a loosely-paraphrased repeat rather
// than wrongly blocking a genuinely different request: a missed match costs
// nothing beyond today's behavior; a false match blocks real work.
export const SYMPTOM_SIMILARITY_THRESHOLD = 0.7;
export const SYMPTOM_CAP = 2;

// symptomAttemptCount — how many PRIOR instructions (cycles already run on
// this project) were substantially the same ask as this one. The caller
// refuses to build when this reaches SYMPTOM_CAP (2 prior attempts + this one
// = the 3rd guess) and routes to diagnosis instead.
export function symptomAttemptCount({ instruction, priorInstructions = [] } = {}) {
  const a = String(instruction || '').trim();
  if (!a) return 0;
  return (priorInstructions || [])
    .filter((p) => payloadSimilarity(a, String(p || '')) >= SYMPTOM_SIMILARITY_THRESHOLD)
    .length;
}

export const MOCK2_SYMPTOM_CAP_FLAG = 'MOCK2_SYMPTOM_CAP';

// Default ON (unlike MOCK2_CONSULT): the diagnosis this cap routes to is
// cheap (review-tier, ~$0.10-0.25 — the same call diagnose-logic already
// makes on a smoke failure) and strictly cheaper than the build it replaces,
// so defaulting it on is cost-reducing, not cost-adding. Only an explicit
// "off" disables it.
export function symptomCapEnabled(env = {}) {
  const v = String(env?.[MOCK2_SYMPTOM_CAP_FLAG] ?? '').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

// estimateConsultCostCents — the fixed ceiling cost of one consult (input+output caps at
// Fable 5 rates). ~50 cents. Used for the request roll-up estimate + the pre-flight
// "this will cost about $0.50" note.
export function estimateConsultCostCents() {
  // Fable 5 list: $10/M input, $50/M output.
  const inputCents = (CONSULT_INPUT_TOKEN_CAP / 1_000_000) * 1000;
  const outputCents = (CONSULT_OUTPUT_TOKEN_CAP / 1_000_000) * 5000;
  return inputCents + outputCents;
}

// buildConsultDigest — the compiled, TOOL-FREE context the consult receives: the task,
// the halt/failure reason, the last errors / gate output, and relevant file excerpts.
// Clipped to the input token cap (approximated by chars). Returns { text, truncated }.
// This is the ONLY thing the consult sees — it has no container, no tools, no repo.
export function buildConsultDigest({ task = '', haltReason = '', lastErrors = '', gateOutput = '', fileExcerpts = [] } = {}, { inputCap = CONSULT_INPUT_TOKEN_CAP } = {}) {
  const parts = [];
  if (task) parts.push(`# The build task\n${String(task).trim()}`);
  if (haltReason) parts.push(`# Why it stopped (halt/failure reason)\n${String(haltReason).trim()}`);
  if (gateOutput) parts.push(`# Latest gate output\n${String(gateOutput).trim()}`);
  if (lastErrors) parts.push(`# Recent errors\n${String(lastErrors).trim()}`);
  const excerpts = (Array.isArray(fileExcerpts) ? fileExcerpts : []).filter(Boolean);
  for (const ex of excerpts) {
    const path = ex?.path ? String(ex.path) : 'file';
    const body = ex?.content != null ? String(ex.content) : String(ex);
    parts.push(`# Excerpt: ${path}\n${body}`);
  }
  let text = parts.join('\n\n');
  const charCap = inputCap * CHARS_PER_TOKEN;
  let truncated = false;
  if (text.length > charCap) {
    text = `${text.slice(0, charCap)}\n\n…[digest truncated to fit the consult input cap]`;
    truncated = true;
  }
  return { text, truncated };
}

// approxTokens — the chars→tokens approximation used to enforce the caps. Pure.
export function approxTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

// The fixed consult system prompt: advisory-only, diagnosis + 2–4 ranked paths + a
// suggested resume line. JSON out so the halt card renders it deterministically.
export const CONSULT_SYSTEM_PROMPT = `You are a senior engineer giving a SECOND OPINION on a build that is stuck. You have NO tools and NO access to the code beyond the digest provided — you advise, you do not act, and you never take over the build.

Read the digest (the task, why it stopped, the errors/gate output, and file excerpts) and produce a short, concrete diagnosis and a ranked set of ways forward.

Output ONLY a JSON object (no markdown fences, no prose around it):
{
  "diagnosis": "1–3 sentences: the most likely root cause.",
  "paths": [ { "label": "short action", "rationale": "one line why / the tradeoff" } ],   // 2 to 4, best first
  "suggested_resume": "a single paragraph the operator could paste as resume guidance to the build."
}`;

// parseConsultOutput — tolerant parse of the consult reply into { ok, consult } or
// { ok:false }. Mirrors explain-logic's fence/prose tolerance. Requires a diagnosis and
// at least one path.
export function parseConsultOutput(modelText) {
  const raw = String(modelText || '').trim();
  if (!raw) return { ok: false, error: 'the consult returned nothing' };
  let body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first !== -1 && last > first) body = body.slice(first, last + 1);
  let obj;
  try { obj = JSON.parse(body); } catch { return { ok: false, error: 'the consult reply was not readable' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'the consult reply was not readable' };
  const diagnosis = String(obj.diagnosis ?? '').trim();
  const rawPaths = Array.isArray(obj.paths) ? obj.paths : [];
  const paths = rawPaths.slice(0, 4).map((p) => ({
    label: String(p?.label ?? p?.title ?? '').trim(),
    rationale: String(p?.rationale ?? p?.detail ?? p?.why ?? '').trim(),
  })).filter((p) => p.label);
  const suggested_resume = String(obj.suggested_resume ?? obj.resume ?? '').trim();
  if (!diagnosis || paths.length === 0) return { ok: false, error: 'the consult reply had no diagnosis or paths' };
  return { ok: true, consult: { diagnosis, paths, suggested_resume } };
}
