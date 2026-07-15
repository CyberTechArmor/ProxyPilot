// Mock2 "Explain this" PURE decision layer (native-free, unit-tested). The blocker /
// authorization / deviation / rule-question cards carry text the BUILD MODEL wrote for
// engineers (timestamps, hashes, §-references, SQL). An operator needs the meaning at a
// glance, so a small/fast model (the `summary` slot — the summary lane) rewrites the
// card in plain language. Everything about that rewrite that can be decided without the
// network or a model API lives here: the fixed prompt, the user-message assembly, and
// the tolerant parse of the model's JSON back into five sections + a risk level.
//
// Read-only by construction: nothing here mutates state or the audit record.
//
// Terminology (risk R7): nothing here is named "agent".

// Bound the card text handed to the explainer (a runaway transcript can't blow the
// summary lane's context or cost). The route validates a slightly larger ceiling.
export const EXPLAIN_MAX_INPUT_CHARS = 8000;

// The risk vocabulary the badge renders. Ordered low→high.
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);

// The FIXED explainer prompt (task item 1). Plain, non-technical, five named things,
// a risk level with one reason, JSON out so the five sections render deterministically.
export const EXPLAIN_SYSTEM_PROMPT = `You translate a software build assistant's TECHNICAL status message into plain language for a NON-TECHNICAL operator who has to decide what to do about it. The operator has no programming or database knowledge.

Write in plain, everyday words. Do NOT use jargon or technical terms. Do NOT mention section numbers, rule references, file paths, code, SQL, database tables, timestamps, hashes, or IDs. If the original mentions any of those, translate the MEANING into ordinary language instead of repeating it. Keep sentences short and calm.

Explain EXACTLY these five things, and nothing else:
1. What happened — 2 to 3 sentences, in plain terms.
2. Why the build stopped itself and is asking a person.
3. What it is asking permission to do (or to confirm) — concretely and narrowly; say what it will and will NOT touch.
4. What happens if you approve/allow it.
5. What happens if you decline/deny it.
Then judge the risk: low, medium, or high, with ONE sentence saying why.

Output ONLY a JSON object (no markdown fences, no text before or after) with these exact string keys:
{
  "what_happened": "...",
  "why_stopped": "...",
  "what_asking": "...",
  "if_approve": "...",
  "if_decline": "...",
  "risk_level": "low" | "medium" | "high",
  "risk_why": "..."
}
Use short paragraphs and plain words. Never include anything except that JSON object.`;

// Assemble the single user turn: minimal cycle context (task title, status) + the card
// text to explain, clipped to the input ceiling. Pure so the wire shape is testable.
export function buildExplainTranscript({ text = '', title = '', status = '', kind = '' } = {}) {
  const clipped = String(text || '').slice(0, EXPLAIN_MAX_INPUT_CHARS);
  const ctx = [];
  if (title) ctx.push(`What the operator asked the build to do: ${String(title).trim()}`);
  if (status) ctx.push(`Current build status: ${String(status).trim()}`);
  if (kind) ctx.push(`This message is a: ${kindLabel(kind)}`);
  const header = ctx.length ? `${ctx.join('\n')}\n\n` : '';
  return [{
    role: 'user',
    text: `${header}Here is the technical message to explain in plain language:\n"""\n${clipped}\n"""`,
  }];
}

// ---- follow-up questions ----

// Bound the operator's follow-up question and the prior-explanation context we hand
// back to the model (both are client-supplied; the route validates the same limits).
export const FOLLOWUP_MAX_QUESTION_CHARS = 1000;
export const FOLLOWUP_MAX_PRIOR_CHARS = 6000;

// The fixed follow-up prompt: same plain-language rules as the explainer, but the
// output is a short direct answer (plain text, no JSON) to the operator's question.
export const EXPLAIN_FOLLOWUP_SYSTEM_PROMPT = `You are answering a follow-up question from a NON-TECHNICAL operator about a software build assistant's status message that was already explained to them in plain language. The operator has no programming or database knowledge.

Write in plain, everyday words. Do NOT use jargon or technical terms. Do NOT mention section numbers, rule references, file paths, code, SQL, database tables, timestamps, hashes, or IDs — translate the MEANING into ordinary language instead. Keep sentences short and calm.

Answer ONLY the operator's question, directly, in one to three short paragraphs of plain text. Do not repeat the whole explanation. If the original message does not contain enough information to answer, say so honestly instead of guessing. Output plain text only — no JSON, no markdown headings, no code.`;

// Assemble the follow-up turn: context header + the original technical message + the
// plain-language explanation already shown + the operator's question. Pure/testable.
export function buildFollowupTranscript({
  text = '', title = '', status = '', kind = '', prior = '', question = '',
} = {}) {
  const clippedText = String(text || '').slice(0, EXPLAIN_MAX_INPUT_CHARS);
  const clippedPrior = String(prior || '').slice(0, FOLLOWUP_MAX_PRIOR_CHARS);
  const clippedQuestion = String(question || '').slice(0, FOLLOWUP_MAX_QUESTION_CHARS);
  const ctx = [];
  if (title) ctx.push(`What the operator asked the build to do: ${String(title).trim()}`);
  if (status) ctx.push(`Current build status: ${String(status).trim()}`);
  if (kind) ctx.push(`The message is a: ${kindLabel(kind)}`);
  const header = ctx.length ? `${ctx.join('\n')}\n\n` : '';
  const priorBlock = clippedPrior
    ? `The plain-language explanation the operator has already read:\n"""\n${clippedPrior}\n"""\n\n`
    : '';
  return [{
    role: 'user',
    text: `${header}The original technical message:\n"""\n${clippedText}\n"""\n\n${priorBlock}The operator's follow-up question:\n"""\n${clippedQuestion}\n"""`,
  }];
}

// Parse the follow-up model reply: it's plain text, so just trim it (dropping any stray
// code fences). Empty ⇒ failure so the UI can say the answer isn't available.
export function parseFollowupAnswer(modelText) {
  const answer = String(modelText || '')
    .replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
    .trim();
  if (!answer) return { ok: false, error: 'the explainer returned nothing' };
  return { ok: true, answer };
}

// A human word for the card kind (fed to the model as context only).
function kindLabel(kind) {
  switch (String(kind || '')) {
    case 'authorization': return 'request for one-time permission';
    case 'deviation': return 'request to bend a project rule';
    case 'rule_question': return 'question about a project rule';
    case 'blocker':
    default: return 'blocked build that needs attention';
  }
}

// Coerce the model's risk word onto one of RISK_LEVELS. Unknown/unclear defaults to
// 'medium' (never silently claim "low" when the model didn't say so).
export function normalizeRiskLevel(v) {
  const s = String(v || '').trim().toLowerCase();
  if (RISK_LEVELS.includes(s)) return s;
  if (/\b(high|severe|danger|critical)\b/.test(s)) return 'high';
  if (/\b(med|moderate)\b/.test(s)) return 'medium';
  if (/\b(low|minimal|safe|none)\b/.test(s)) return 'low';
  return 'medium';
}

// Parse the explainer model's reply into { ok, explanation } or { ok:false, error }.
// Tolerant of ```json fences and stray prose around the object. Requires at least the
// "what happened" section — a reply with no content is treated as a failure so the UI
// falls back to the original text (task item 3), never showing a blank explanation.
export function parseExplanation(modelText) {
  const raw = String(modelText || '').trim();
  if (!raw) return { ok: false, error: 'the explainer returned nothing' };
  // Strip code fences, then narrow to the outermost {...} so leading/trailing prose
  // (a stray "Here's the explanation:") doesn't break JSON.parse.
  let body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first !== -1 && last > first) body = body.slice(first, last + 1);
  let obj;
  try { obj = JSON.parse(body); } catch { return { ok: false, error: 'the explanation was not readable' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'the explanation was not readable' };
  }
  const s = (k) => String(obj[k] ?? '').trim();
  const explanation = {
    what_happened: s('what_happened'),
    why_stopped: s('why_stopped'),
    what_asking: s('what_asking'),
    if_approve: s('if_approve'),
    if_decline: s('if_decline'),
    risk_level: normalizeRiskLevel(obj.risk_level),
    risk_why: s('risk_why'),
  };
  if (!explanation.what_happened && !explanation.what_asking) {
    return { ok: false, error: 'the explanation had no content' };
  }
  return { ok: true, explanation };
}
