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

export const HARNESS_STEP_TUNING_KEY = 'harness_step_tuning';

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
  if (!entry) {
    const res = await callModelTurn(args);
    if (res && typeof res === 'object') res.modelUsed = args.model;
    return res;
  }
  const base = { model: args.model, effort: args.effort ?? null, thinking: args.thinking ?? null };
  const tuned = resolveStepTuning(stepId, base, overrides);
  let res = await callModelTurn({ ...args, model: tuned.model, effort: tuned.effort, thinking: tuned.thinking });
  const overrodeModel = tuned.model !== base.model;
  if (res && !res.ok && overrodeModel && /model/i.test(String(res.error || ''))) {
    console.warn(`[mock2] step override fallback: ${stepId} ${tuned.model} rejected — using default (${base.model})`);
    try { onFallback?.({ rejected: tuned.model, fallback: base.model }); } catch { /* advisory */ }
    res = await callModelTurn({ ...args, effort: tuned.effort, thinking: tuned.thinking });
    if (res && typeof res === 'object') res.modelUsed = base.model;
    return res;
  }
  if (res && typeof res === 'object') res.modelUsed = tuned.model;
  return res;
}
