// Mock2 lane tuning — the PURE decision layer for the operator's "thinking"
// settings (admin queue → Model thinking & effort). Native-free, unit-tested
// stub-first (risk R9): imports nothing that opens a DB or hits the network.
//
// Each model-calling LANE of the harness can be tuned independently:
//   - model:    override the model id (empty → the slot/routing choice stands)
//   - effort:   'default' keeps the lane's built-in effort; otherwise one of
//               the provider effort levels
//   - thinking: 'default' keeps the lane's built-in behavior (adaptive where
//               the model supports it); 'off' disables thinking entirely for
//               that lane (model-client omits the adaptive switch — the safe
//               cross-model off)
//
// Tuning is the operator's LAST word: it is applied after slots, routing, the
// fast-code-model default, and the MVP override.
//
// Terminology (risk R7): nothing here is named "agent".

import { ROUTING_EFFORTS } from './routing-logic.js';

export const TUNING_LANES = Object.freeze(['build', 'mvp', 'audit', 'chat', 'mockup', 'ask']);
export const TUNING_LANE_LABELS = Object.freeze({
  build: 'Full build',
  mvp: 'MVP build',
  audit: 'Build audit',
  chat: 'Design chat',
  mockup: 'Mockup render',
  ask: 'Ask lane',
});
export const TUNING_EFFORTS = Object.freeze(['default', ...ROUTING_EFFORTS]);
export const TUNING_THINKING = Object.freeze(['default', 'off']);

const EMPTY_ENTRY = Object.freeze({ model: null, effort: 'default', thinking: 'default' });

export function normalizeTuningEntry(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ENTRY };
  const model = String(raw.model ?? '').trim().slice(0, 200) || null;
  const effort = TUNING_EFFORTS.includes(raw.effort) ? raw.effort : 'default';
  const thinking = TUNING_THINKING.includes(raw.thinking) ? raw.thinking : 'default';
  return { model, effort, thinking };
}

// normalizeLaneTuning — the whole stored doc (mock2_settings.lane_tuning JSON)
// into a complete, defaulted map. Unknown lanes are dropped; missing lanes get
// the empty entry, so callers can index without guards.
export function normalizeLaneTuning(doc) {
  let parsed = doc;
  if (typeof doc === 'string') {
    try { parsed = JSON.parse(doc); } catch { parsed = null; }
  }
  const out = {};
  for (const lane of TUNING_LANES) {
    out[lane] = normalizeTuningEntry(parsed && typeof parsed === 'object' ? parsed[lane] : null);
  }
  return out;
}

// applyLaneTuning — merge the operator's tuning over a lane's computed call
// parameters. `base` is what the lane would use anyway ({model, effort,
// thinking}); the returned object is what the model call should actually send.
export function applyLaneTuning(base = {}, entry = null) {
  const t = normalizeTuningEntry(entry);
  return {
    model: t.model || base.model || '',
    effort: t.effort !== 'default' ? t.effort : (base.effort ?? null),
    thinking: t.thinking === 'off' ? 'off' : (base.thinking ?? null),
  };
}
