// Harness step registry + per-step override resolution. Pure module —
// native-free, runs in the fresh-checkout sandbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_STEPS,
  HARNESS_STAGES,
  DETERMINISTIC_STEPS,
  getHarnessStep,
  normalizeStepOverride,
  normalizeStepTuning,
  resolveStepTuning,
  resolveStepDisplay,
} from '../mock2/harness-steps-logic.js';

test('registry: one entry per model-bearing call site, ids unique and stable', () => {
  assert.equal(HARNESS_STEPS.length, 19);
  const ids = HARNESS_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate step id');
  // The ids go on ledger rows — this list is the data contract.
  assert.deepEqual(ids.sort(), [
    'ask', 'build-runner', 'chat-distill', 'checklist-postpass', 'concept-chat',
    'consult', 'design-doc-adjust', 'design-review', 'design-token-extraction',
    'explain-card', 'explain-followup', 'inventory-extraction', 'mockup-continuation',
    'mockup-render', 'mockup-screen', 'mockup-tweak', 'quick-prepass',
    'rule-audit', 'split-probe',
  ].sort());
});

test('registry: every entry is complete', () => {
  for (const s of HARNESS_STEPS) {
    assert.ok(HARNESS_STAGES.includes(s.stage), `${s.id}: unknown stage ${s.stage}`);
    assert.ok(s.title && s.description && s.intendedOutcome, `${s.id}: missing display text`);
    assert.ok(s.defaults && typeof s.defaults === 'object', `${s.id}: missing defaults`);
    assert.ok(typeof s.tunable === 'boolean', `${s.id}: missing tunable flag`);
    assert.ok(/^[a-z0-9-]+$/.test(s.id), `${s.id}: id not kebab-case`);
  }
  // The consult is deliberately pinned to Fable 5 — it must stay read-only.
  assert.equal(getHarnessStep('consult').tunable, false);
});

test('deterministic steps listed for the read-only section', () => {
  assert.ok(DETERMINISTIC_STEPS.length >= 8);
  const ids = DETERMINISTIC_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of DETERMINISTIC_STEPS) assert.ok(s.title && s.description);
});

test('resolveStepTuning: no override returns the baseline unchanged (same reference)', () => {
  const base = { model: 'claude-opus-4-8', effort: 'high', thinking: null };
  assert.equal(resolveStepTuning('build-runner', base, {}), base);
  assert.equal(resolveStepTuning('build-runner', base, null), base);
  assert.equal(resolveStepTuning('build-runner', base, undefined), base);
});

test('resolveStepTuning: override wins field-by-field over the baseline', () => {
  const base = { model: 'claude-opus-4-8', effort: 'high', thinking: null };
  const out = resolveStepTuning('build-runner', base, {
    'build-runner': { model: 'claude-sonnet-5', effort: 'low', thinking: 'off' },
  });
  assert.deepEqual(out, { model: 'claude-sonnet-5', effort: 'low', thinking: 'off' });
  // Partial override leaves the other fields at baseline.
  const partial = resolveStepTuning('build-runner', base, { 'build-runner': { effort: 'medium' } });
  assert.deepEqual(partial, { model: 'claude-opus-4-8', effort: 'medium', thinking: null });
});

test('resolveStepTuning: unknown step, non-tunable step, and junk are inert', () => {
  const base = { model: 'm', effort: 'low', thinking: 'off' };
  assert.equal(resolveStepTuning('no-such-step', base, { 'no-such-step': { model: 'x' } }), base);
  // consult is tunable:false — an override stored for it must not apply.
  assert.equal(resolveStepTuning('consult', base, { consult: { model: 'x' } }), base);
  // Junk values are dropped, and an all-junk entry is no override at all.
  assert.equal(resolveStepTuning('ask', base, { ask: { effort: 'ludicrous', thinking: 'sideways' } }), base);
  const out = resolveStepTuning('ask', base, { ask: { model: '  spaced-model  ', effort: 'nope' } });
  assert.deepEqual(out, { model: 'spaced-model', effort: 'low', thinking: 'off' });
});

test('normalizeStepTuning: parse-safe, drops unknown/non-tunable/empty entries', () => {
  assert.deepEqual(normalizeStepTuning('not json'), {});
  assert.deepEqual(normalizeStepTuning(null), {});
  const doc = normalizeStepTuning(JSON.stringify({
    'build-runner': { model: 'claude-sonnet-5' },
    consult: { model: 'x' },              // non-tunable → dropped
    'no-such-step': { model: 'y' },       // unknown → dropped
    ask: { effort: 'bogus' },             // all-junk → dropped
  }));
  assert.deepEqual(Object.keys(doc), ['build-runner']);
  assert.deepEqual(doc['build-runner'], { model: 'claude-sonnet-5', effort: null, thinking: null });
});

test('normalizeStepOverride edge cases', () => {
  assert.equal(normalizeStepOverride(null), null);
  assert.equal(normalizeStepOverride({}), null);
  assert.equal(normalizeStepOverride({ model: '   ' }), null);
  assert.deepEqual(normalizeStepOverride({ thinking: 'off' }), { model: null, effort: null, thinking: 'off' });
});

test('resolveStepDisplay: source badges follow the precedence', () => {
  const step = getHarnessStep('build-runner');
  // Slot-resolved default.
  let d = resolveStepDisplay(step, { slotModel: 'claude-opus-4-8', env: {} });
  assert.deepEqual(d.model, { value: 'claude-opus-4-8', source: 'slot' });
  assert.equal(d.effort.source, 'default');
  // Env override beats slot.
  d = resolveStepDisplay(step, { slotModel: 'claude-opus-4-8', env: { MOCK2_FAST_MODEL: 'claude-sonnet-5' } });
  assert.deepEqual(d.model, { value: 'claude-sonnet-5', source: 'env' });
  // 'off' env value is not a model.
  d = resolveStepDisplay(step, { slotModel: 'claude-opus-4-8', env: { MOCK2_FAST_MODEL: 'off' } });
  assert.equal(d.model.source, 'slot');
  // Lane beats env; step beats lane.
  d = resolveStepDisplay(step, {
    slotModel: 'claude-opus-4-8', env: { MOCK2_FAST_MODEL: 'claude-sonnet-5' },
    laneEntry: { model: 'claude-sonnet-4-6', effort: 'xhigh', thinking: 'off' },
  });
  assert.deepEqual(d.model, { value: 'claude-sonnet-4-6', source: 'lane' });
  assert.deepEqual(d.effort, { value: 'xhigh', source: 'lane' });
  assert.deepEqual(d.thinking, { value: 'off', source: 'lane' });
  d = resolveStepDisplay(step, {
    slotModel: 'claude-opus-4-8',
    laneEntry: { model: 'claude-sonnet-4-6', effort: 'xhigh', thinking: 'off' },
    override: { model: 'claude-haiku-4-6', effort: 'low' },
  });
  assert.deepEqual(d.model, { value: 'claude-haiku-4-6', source: 'step' });
  assert.deepEqual(d.effort, { value: 'low', source: 'step' });
  // Fixed-model steps (mockup-render) show the shipped default when no env set.
  const render = getHarnessStep('mockup-render');
  d = resolveStepDisplay(render, { slotModel: 'claude-opus-4-8', env: {} });
  assert.deepEqual(d.model, { value: 'claude-fable-5', source: 'default' });
});
