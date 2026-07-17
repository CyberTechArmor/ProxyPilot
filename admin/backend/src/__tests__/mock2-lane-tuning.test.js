// Lane tuning — the operator's per-lane thinking settings (model override,
// effort override, thinking off). Exercises the PURE decision layer
// (lane-tuning-logic.js): normalization of the stored doc and the merge over a
// lane's computed call parameters. No DB/container (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUNING_LANES, TUNING_EFFORTS, TUNING_THINKING, GLOBAL_THINKING_MODES,
  normalizeTuningEntry, normalizeLaneTuning, applyLaneTuning, normalizeGlobalThinking,
} from '../mock2/lane-tuning-logic.js';

test('lane/effort/thinking option sets are what the UI expects', () => {
  assert.deepEqual([...TUNING_LANES], ['build', 'mvp', 'audit', 'chat', 'mockup', 'ask']);
  assert.deepEqual([...TUNING_EFFORTS], ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...TUNING_THINKING], ['default', 'off']);
});

test('normalizeTuningEntry: trims/caps model, rejects unknown effort/thinking', () => {
  assert.deepEqual(normalizeTuningEntry(null), { model: null, effort: 'default', thinking: 'default' });
  assert.deepEqual(
    normalizeTuningEntry({ model: '  claude-opus-4-8  ', effort: 'xhigh', thinking: 'off' }),
    { model: 'claude-opus-4-8', effort: 'xhigh', thinking: 'off' },
  );
  const bad = normalizeTuningEntry({ model: '', effort: 'ultra', thinking: 'sometimes' });
  assert.deepEqual(bad, { model: null, effort: 'default', thinking: 'default' });
  assert.equal(normalizeTuningEntry({ model: 'x'.repeat(500) }).model.length, 200);
});

test('normalizeLaneTuning: tolerant of bad JSON, fills every lane, drops unknown lanes', () => {
  const fromBad = normalizeLaneTuning('{not json');
  assert.deepEqual(Object.keys(fromBad).sort(), [...TUNING_LANES].sort());
  const doc = normalizeLaneTuning(JSON.stringify({
    build: { effort: 'max' }, bogusLane: { effort: 'low' },
  }));
  assert.equal(doc.build.effort, 'max');
  assert.equal(doc.mvp.effort, 'default');
  assert.ok(!('bogusLane' in doc));
});

test('applyLaneTuning: default entry leaves the lane call untouched', () => {
  const base = { model: 'claude-sonnet-5', effort: 'low', thinking: 'off' };
  assert.deepEqual(applyLaneTuning(base, null), { model: 'claude-sonnet-5', effort: 'low', thinking: 'off' });
});

test('applyLaneTuning: overrides win — model, effort, and thinking-off', () => {
  const base = { model: 'claude-sonnet-5', effort: 'low', thinking: null };
  const out = applyLaneTuning(base, { model: 'claude-opus-4-8', effort: 'high', thinking: 'off' });
  assert.deepEqual(out, { model: 'claude-opus-4-8', effort: 'high', thinking: 'off' });
});

test('applyLaneTuning: thinking "default" keeps the lane baseline (mockup stays off)', () => {
  const out = applyLaneTuning({ model: 'm', effort: 'low', thinking: 'off' }, { thinking: 'default' });
  assert.equal(out.thinking, 'off');
});

test('applyLaneTuning: empty base fields fall through cleanly', () => {
  const out = applyLaneTuning({}, { effort: 'medium' });
  assert.equal(out.model, '');
  assert.equal(out.effort, 'medium');
  assert.equal(out.thinking, null);
});

test('normalizeGlobalThinking: only "off" disables; everything else is default', () => {
  assert.deepEqual([...GLOBAL_THINKING_MODES], ['default', 'off']);
  assert.equal(normalizeGlobalThinking('off'), 'off');
  assert.equal(normalizeGlobalThinking('  OFF  '), 'off');
  assert.equal(normalizeGlobalThinking('default'), 'default');
  assert.equal(normalizeGlobalThinking('on'), 'default');
  assert.equal(normalizeGlobalThinking(''), 'default');
  assert.equal(normalizeGlobalThinking(null), 'default');
  assert.equal(normalizeGlobalThinking(undefined), 'default');
});

test('global thinking off overlays a lane entry into thinking-off (settings.getLaneTuning contract)', () => {
  // The native settings reader applies this overlay: entry stays intact except
  // thinking is forced 'off'. Modeled here at the pure layer.
  const entry = normalizeTuningEntry({ model: 'claude-opus-4-8', effort: 'high', thinking: 'default' });
  const overlaid = normalizeGlobalThinking('off') === 'off' ? { ...entry, thinking: 'off' } : entry;
  assert.deepEqual(overlaid, { model: 'claude-opus-4-8', effort: 'high', thinking: 'off' });
  const call = applyLaneTuning({ model: 'claude-sonnet-5', effort: 'low', thinking: null }, overlaid);
  assert.equal(call.thinking, 'off');
});
