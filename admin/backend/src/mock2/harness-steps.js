// Harness step overrides — runtime side. Storage of the per-step tuning doc
// (mock2_settings.harness_step_tuning), and callStepTurn: the one wrapper
// every model-bearing call site goes through so the operator's per-step
// {model, effort, thinking} override is applied as the topmost tuning layer,
// with a fallback guard so a bad override can never dead-end a build.
//
// Back-compat contract: with no override stored for a step, callStepTurn
// forwards the caller's args to callModelTurn UNTOUCHED — byte-identical
// behavior to the pre-override pipeline.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { getMock2Setting, setMock2Setting } from './settings.js';
import { callModelTurn } from './model-client.js';
import { normalizeStepTuning, normalizeStepOverride, resolveStepTuning, getHarnessStep } from './harness-steps-logic.js';
import { STEP_PROMPT_SPECS, STEP_PROMPT_MAX_LENGTH, promptOwnerStepId, normalizeStepPrompts, substitutePromptPlaceholders } from './harness-prompts-logic.js';
import { modelMaxOutputTokens } from './routing-logic.js';

export const HARNESS_STEP_TUNING_KEY = 'harness_step_tuning';
export const HARNESS_STEP_PROMPTS_KEY = 'harness_step_prompts';

// The whole stored doc, normalized ({ [stepId]: {model, effort, thinking} }).
// Parse-safe like its lane-tuning neighbor; no caching (a prepared SELECT per
// read, matching getLaneTuning).
export function getHarnessStepTuning() {
  return normalizeStepTuning(getMock2Setting(HARNESS_STEP_TUNING_KEY, null));
}

// Store one step's override. A patch that normalizes to nothing (all fields
// empty/absent) CLEARS the step's override. Returns the updated doc.
export function setHarnessStepOverride(stepId, patch, updatedBy = null) {
  const step = getHarnessStep(stepId);
  if (!step || !step.tunable) throw new Error(`unknown or non-tunable step: ${stepId}`);
  const doc = getHarnessStepTuning();
  const norm = normalizeStepOverride(patch);
  if (norm) doc[stepId] = norm;
  else delete doc[stepId];
  setMock2Setting(HARNESS_STEP_TUNING_KEY, JSON.stringify(doc), updatedBy);
  return doc;
}

// ---- per-step system prompt overrides ----

// The stored prompt-override doc ({ [stepId]: text }), normalized: unknown
// ids, shared ids (edits belong on the owning step), and empty strings drop.
export function getHarnessStepPrompts() {
  return normalizeStepPrompts(getMock2Setting(HARNESS_STEP_PROMPTS_KEY, null));
}

// Store one step's prompt override; empty/whitespace content clears it and
// the step falls back to the shipped prompt. Shared-prompt steps are edited
// through their owner (mockup-continuation → mockup-render).
export function setHarnessStepPrompt(stepId, content, updatedBy = null) {
  const spec = STEP_PROMPT_SPECS[stepId];
  if (!spec) throw new Error(`unknown step: ${stepId}`);
  if (spec.sharesPromptOf) throw new Error(`step ${stepId} shares its prompt with ${spec.sharesPromptOf} — edit that step`);
  const doc = getHarnessStepPrompts();
  const text = String(content ?? '');
  if (text.trim() === '') delete doc[stepId];
  else doc[stepId] = text.slice(0, STEP_PROMPT_MAX_LENGTH);
  setMock2Setting(HARNESS_STEP_PROMPTS_KEY, JSON.stringify(doc), updatedBy);
  return doc;
}

// Call-time application: the shipped prompt (already fully built by the call
// site) unless the operator stored an override for the step, in which case
// the override is used with {{PLACEHOLDER}} markers substituted from the
// SAME values the shipped prompt embeds. Back-compat: no override → the
// default text is returned untouched.
export function stepSystemPrompt(stepId, defaultText, params = {}) {
  try {
    const owner = promptOwnerStepId(stepId) || stepId;
    const doc = getHarnessStepPrompts();
    const override = doc[owner];
    if (!override) return defaultText;
    return substitutePromptPlaceholders(override, params);
  } catch (e) {
    console.warn(`[mock2] step prompt override read failed (${stepId}):`, e?.message);
    return defaultText;
  }
}

// 7-day per-step spend rollup for the Harness page ({ [stepId]: { cents,
// calls } }). Grouped on the ledger's step column (migration 541, indexed on
// (step, created_at)); pre-541 rows have step null and are simply not
// attributed. Best-effort: a query failure returns {} so the page renders.
export function harnessStepSpend7d() {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const rows = getMock2Db()
      .prepare(
        `SELECT step, SUM(cost_cents) AS cents, COUNT(*) AS calls
           FROM mock2_quota_ledger
          WHERE step IS NOT NULL AND created_at >= ?
          GROUP BY step`,
      )
      .all(since);
    const out = {};
    for (const r of rows) out[r.step] = { cents: Number(r.cents) || 0, calls: Number(r.calls) || 0 };
    return out;
  } catch (e) {
    console.warn('[mock2] harness spend rollup failed:', e?.message);
    return {};
  }
}

// The guarded call. Call sites pass their fully lane-tuned args exactly as
// they would to callModelTurn; the step override (if any) is applied on top.
// If the OVERRIDDEN model is rejected by the connector (error matching
// /model/i, mirroring the preferred-mockup fallback in concept.js), the call
// retries once on the caller's own model and logs loudly — a bad setting
// must never dead-end a build. The result carries modelUsed so spend
// recording can price the model that actually served.
//
// Overrides are read per call, so a change on the Harness page takes effect
// on the very next call — including mid-cycle for the runner loop, where a
// mid-transcript model switch can cost one recoverable retry (the cycle
// retry machinery owns that, same as any transient failure).
export async function callStepTurn(stepId, args, { onFallback } = {}) {
  const overrides = getHarnessStepTuning();
  const entry = overrides[stepId];
  // Per-step output budgets are gone (operator decision): a turn runs free
  // within the serving model's own ability. Callers may still pin maxTokens
  // (the runner honors MOCK2_RUNNER_MAX_TOKENS); otherwise the cap is the
  // model's ceiling. Spend stays governed by the platform/project/people
  // quotas, never per-call budgets.
  if (!entry) {
    const res = await callModelTurn({ ...args, maxTokens: args.maxTokens ?? modelMaxOutputTokens(args.model) });
    if (res && typeof res === 'object') res.modelUsed = args.model;
    return res;
  }
  const base = { model: args.model, effort: args.effort ?? null, thinking: args.thinking ?? null };
  const tuned = resolveStepTuning(stepId, base, overrides);
  let res = await callModelTurn({ ...args, model: tuned.model, effort: tuned.effort, thinking: tuned.thinking, maxTokens: args.maxTokens ?? modelMaxOutputTokens(tuned.model) });
  const overrodeModel = tuned.model !== base.model;
  if (res && !res.ok && overrodeModel && /model/i.test(String(res.error || ''))) {
    console.warn(`[mock2] step override fallback: ${stepId} ${tuned.model} rejected — using default (${base.model})`);
    try { onFallback?.({ rejected: tuned.model, fallback: base.model }); } catch { /* advisory */ }
    res = await callModelTurn({ ...args, effort: tuned.effort, thinking: tuned.thinking, maxTokens: args.maxTokens ?? modelMaxOutputTokens(base.model) });
    if (res && typeof res === 'object') res.modelUsed = base.model;
    return res;
  }
  if (res && typeof res === 'object') res.modelUsed = tuned.model;
  return res;
}
