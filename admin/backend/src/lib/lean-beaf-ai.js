// Lean BEAF Pro — AI brief writer.
//
// The dashboard's grounded brief (lean-beaf-logic.buildBrief) is deterministic
// and record-cited (R07): every number is followed by a citation like
// [activity #12] / [report #3], so grounding holds by construction. This
// module OPTIONALLY restyles that grounded text with a real model (the cheap
// fast Claude — Haiku 4.5 by default), turning the terse fact list into a
// readable brief WITHOUT letting it invent figures:
//
//   • The model is given ONLY the grounded facts and told to rewrite them,
//     preserving every citation token and never stating an uncited number.
//   • After generation we verify the output introduces no citation that
//     wasn't in the source; if it does (a sign it invented a record), we drop
//     the AI text and fall back to the deterministic brief. So R07 still holds
//     even when the model is used — the deterministic text is the source of
//     truth and the safety net.
//
// The model + API key are admin-configurable (app_settings, key encrypted at
// rest via secrets.js; falls back to process.env.ANTHROPIC_API_KEY). Every run
// is recorded in lbp_brief_runs (who ran it, tokens, cost) for the audit log.
//
// The Anthropic call reuses the vetted provider client in mock2/model-client
// (raw Messages API over the agent proxy, streaming + transient-retry) — the
// same one cve-research.js reuses; it is not gated by the mock2 module.

import { getSetting, setSetting } from '../db.js';
import { encryptSecret, decryptSecret } from './secrets.js';
import { callModelTurn, isTransientModelError } from '../mock2/model-client.js';
import * as store from './lean-beaf-store.js';
import {
  DEFAULT_BRIEF_MODEL, LBP_MODEL_PRICING, estimateBriefCost,
  citationsGroundedIn, briefSystemPrompt, briefUserPrompt,
  askSystemPrompt, askUserPrompt,
} from './lean-beaf-logic.js';

const SETTING_KEYS = Object.freeze({
  model: 'lbp_brief_model',
  api_key_enc: 'lbp_brief_api_key_enc',
  base_url: 'lbp_brief_base_url',
});

// The selectable models in the admin picker (label + id). Kept small and
// current — Haiku first (the default cheap/fast pick).
export const LBP_BRIEF_MODEL_CHOICES = Object.freeze([
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — cheap & fast (recommended)' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
  { id: 'claude-opus-5', label: 'Opus 5 — most capable' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable (previous)' },
]);

// ---- settings (admin-configurable) ----

// Non-secret view of the config for the UI. Never returns the key itself.
export function getBriefAiSettings() {
  const model = getSetting(SETTING_KEYS.model) || DEFAULT_BRIEF_MODEL;
  const has_stored_key = !!getSetting(SETTING_KEYS.api_key_enc);
  const has_env_key = !!process.env.ANTHROPIC_API_KEY;
  return {
    model,
    base_url: getSetting(SETTING_KEYS.base_url) || null,
    has_api_key: has_stored_key || has_env_key,
    key_source: has_stored_key ? 'stored' : (has_env_key ? 'env' : null),
    configured: !!(model && (has_stored_key || has_env_key)),
    default_model: DEFAULT_BRIEF_MODEL,
    choices: LBP_BRIEF_MODEL_CHOICES,
    pricing: LBP_MODEL_PRICING,
  };
}

// Save model + (optionally) a new API key. A blank/omitted key leaves the
// stored one untouched — the admin isn't forced to re-paste it on every edit.
export function saveBriefAiSettings({ model, api_key, base_url } = {}) {
  if (model) setSetting(SETTING_KEYS.model, String(model));
  if (base_url !== undefined) setSetting(SETTING_KEYS.base_url, base_url || '');
  if (api_key) setSetting(SETTING_KEYS.api_key_enc, encryptSecret(String(api_key)));
  return getBriefAiSettings();
}

function getBriefApiKey() {
  const enc = getSetting(SETTING_KEYS.api_key_enc);
  if (enc) {
    try { return decryptSecret(enc); } catch { /* fall through to env */ }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

// ---- model call (shared, with a transient retry) ----

// One turn against the configured Anthropic model. Retries ONCE more on a
// transient failure (dropped connection, provider overload, or a first-call
// timeout) on top of the model client's own single retry — operators saw the
// first "Generate with AI" click fail and the second succeed (a cold first
// request through the agent proxy), so a brief/question no longer needs a
// manual re-click to recover.
async function callBriefModel({ apiKey, model, baseUrl, system, userText, maxTokens = 1200 }) {
  const connector = { provider: 'anthropic', base_url: baseUrl || null };
  const args = {
    connector, apiKey, model, system,
    transcript: [{ role: 'user', text: userText }],
    maxTokens,
    // Pure output work (restyle / grounded answer) — no thinking budget.
    thinking: 'off',
  };
  let res = await callModelTurn(args);
  // callModelTurn already retried once on transient errors; add one more for a
  // transient error OR a timeout (which the client returns immediately without
  // retrying) — exactly the "worked the second time" case.
  if (!res.ok && (res.timedOut || isTransientModelError(res.error))) {
    await new Promise((r) => setTimeout(r, 1200));
    res = await callModelTurn(args);
  }
  return res;
}

// ---- generate ----

// Restyle a grounded brief with the model and record the run.
//   grounded — the object from buildBrief ({ mode, text, citations, ... }).
//   userId / username — who triggered it (for the audit).
// Returns { ok, text, model, input_tokens, output_tokens, cost_usd, priced,
//   fell_back, error, run_id }. On any failure the deterministic grounded text
// is returned as `text` (fell_back:true) so the brief is never empty.
export async function generateAiBrief({ grounded, userId = null, username = null }) {
  const mode = grounded?.mode || 'daily';
  const groundedText = grounded?.text || '';
  const settings = getBriefAiSettings();
  const model = settings.model;
  const apiKey = getBriefApiKey();

  if (!apiKey) {
    // Not configured — do not record a run (no spend happened). The UI prompts
    // an admin to set a key; the deterministic brief is shown meanwhile.
    return {
      ok: false, error: 'not_configured', text: groundedText, model,
      fell_back: true, input_tokens: 0, output_tokens: 0, cost_usd: 0, run_id: null,
    };
  }

  const res = await callBriefModel({
    apiKey, model, baseUrl: settings.base_url,
    system: briefSystemPrompt(),
    userText: briefUserPrompt({ mode, groundedText }),
    maxTokens: 1200,
  });

  const input_tokens = res.usage?.inputTokens || 0;
  const output_tokens = res.usage?.outputTokens || 0;
  const { cost_usd, priced } = estimateBriefCost({ model, inputTokens: input_tokens, outputTokens: output_tokens });

  // R07 safety net: reject an AI rewrite that introduces a citation not in the
  // grounded source (a sign it invented a record), and fall back to the
  // deterministic text.
  let text = groundedText;
  let fell_back = true;
  let error = null;
  if (!res.ok) {
    error = res.error || 'model call failed';
  } else if (!String(res.text || '').trim()) {
    error = 'model returned no text';
  } else if (!citationsGroundedIn(res.text, groundedText)) {
    error = 'ungrounded_output';
  } else {
    text = res.text.trim();
    fell_back = false;
  }

  const run = store.recordBriefRun({
    userId, username, mode, model,
    inputTokens: input_tokens, outputTokens: output_tokens,
    costUsd: cost_usd, ok: res.ok && !fell_back, error,
    // Persist what was actually shown (the accepted AI rewrite, or the grounded
    // fallback) so the run can be re-read later on the Briefs page.
    outputText: text,
  });

  return {
    ok: res.ok && !fell_back,
    text, model, input_tokens, output_tokens, cost_usd, priced,
    fell_back, error, run_id: run?.id ?? null,
  };
}

// ---- ask (grounded Q&A over the portfolio) ----

// Answer a question about the projects using ONLY the grounded context
// (assembled server-side in the route from stored records, every fact cited).
// Same R07 posture as the brief: reject an answer that cites a record not in
// the context. Records a run (mode 'question') storing "Q + A" for the review
// area. `context` is the cited facts document; `question` is the user's text.
export async function answerBriefQuestion({ question, context, userId = null, username = null }) {
  const q = String(question || '').trim();
  const settings = getBriefAiSettings();
  const model = settings.model;
  const apiKey = getBriefApiKey();

  if (!q) return { ok: false, error: 'empty_question', text: '', model, cost_usd: 0, run_id: null };
  if (!apiKey) {
    return { ok: false, error: 'not_configured', text: '', model, fell_back: true, input_tokens: 0, output_tokens: 0, cost_usd: 0, run_id: null };
  }

  const res = await callBriefModel({
    apiKey, model, baseUrl: settings.base_url,
    system: askSystemPrompt(),
    userText: askUserPrompt({ question: q, context }),
    maxTokens: 900,
  });

  const input_tokens = res.usage?.inputTokens || 0;
  const output_tokens = res.usage?.outputTokens || 0;
  const { cost_usd, priced } = estimateBriefCost({ model, inputTokens: input_tokens, outputTokens: output_tokens });

  let answer = '';
  let ok = false;
  let error = null;
  if (!res.ok) {
    error = res.error || 'model call failed';
  } else if (!String(res.text || '').trim()) {
    error = 'model returned no text';
  } else if (!citationsGroundedIn(res.text, context)) {
    // The answer referenced a record id not in the grounded context — reject it
    // rather than surface a possibly-invented figure (R07).
    error = 'ungrounded_output';
  } else {
    answer = res.text.trim();
    ok = true;
  }

  const run = store.recordBriefRun({
    userId, username, mode: 'question', model,
    inputTokens: input_tokens, outputTokens: output_tokens,
    costUsd: cost_usd, ok, error,
    // Store the exchange so it's reviewable in the AI generation log.
    outputText: ok ? `**Q:** ${q}\n\n**A:** ${answer}` : null,
  });

  return {
    ok, question: q, text: answer, model,
    input_tokens, output_tokens, cost_usd, priced,
    error, run_id: run?.id ?? null,
  };
}
