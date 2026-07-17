// Build modes (full vs MVP) + the fast code model — the speed levers. Exercises
// the PURE decision layers (cycle-logic.js, routing-logic.js): mode
// normalization, the reduced MVP gate battery, the fast-model routing for
// routine tasks, and the fixed MVP routing decision. No DB/container, so it
// runs at the module boundary (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBuildMode, filterGatesForBuildMode, MVP_SKIPPED_GATES,
  BUILD_MODE_FULL, BUILD_MODE_MVP, BUILD_MODES,
} from '../mock2/cycle-logic.js';
import {
  fastCodeModel, mvpRoutingDecision, decideRouting, DEFAULT_FAST_MODEL,
} from '../mock2/routing-logic.js';

// ---- build-mode normalization ----

test('normalizeBuildMode: mvp in any casing, everything else full', () => {
  assert.equal(normalizeBuildMode('mvp'), BUILD_MODE_MVP);
  assert.equal(normalizeBuildMode(' MVP '), BUILD_MODE_MVP);
  for (const v of ['full', '', null, undefined, 'fast', 'banana']) {
    assert.equal(normalizeBuildMode(v), BUILD_MODE_FULL, `"${v}" should be full`);
  }
  assert.deepEqual([...BUILD_MODES], ['full', 'mvp']);
});

// ---- MVP gate filtering ----

const battery = [
  { name: 'typecheck', script: '#', order: 1 },
  { name: 'constitution-lint', script: '#', order: 2 },
  { name: 'rule-coverage', script: '#', order: 3 },
  { name: 'security-scan', script: '#', order: 4 },
  { name: 'test', script: '#', order: 5 },
  { name: 'ui-interaction', script: '#', order: 6 },
  { name: 'acceptance', script: '#', order: 7 },
  { name: 'component-reuse', script: '#', order: 8 },
];

test('filterGatesForBuildMode: full mode returns the battery untouched (same reference)', () => {
  assert.equal(filterGatesForBuildMode(battery, 'full'), battery);
});

test('filterGatesForBuildMode: mvp drops exactly the authoring-discipline gates', () => {
  const out = filterGatesForBuildMode(battery, 'mvp');
  assert.deepEqual(out.map((g) => g.name), ['typecheck', 'constitution-lint', 'security-scan', 'test', 'component-reuse']);
  for (const skipped of MVP_SKIPPED_GATES) {
    assert.ok(!out.some((g) => g.name === skipped), `${skipped} must be skipped in mvp`);
  }
});

test('filterGatesForBuildMode: tolerant of empty/absent batteries', () => {
  assert.deepEqual(filterGatesForBuildMode([], 'mvp'), []);
  assert.deepEqual(filterGatesForBuildMode(undefined, 'mvp'), []);
});

// ---- fast code model ----

test('fastCodeModel: default id, env override, and off switch', () => {
  assert.equal(fastCodeModel({}), DEFAULT_FAST_MODEL);
  assert.equal(fastCodeModel({ MOCK2_FAST_MODEL: 'claude-haiku-4-5-20251001' }), 'claude-haiku-4-5-20251001');
  assert.equal(fastCodeModel({ MOCK2_FAST_MODEL: 'off' }), null);
  assert.equal(fastCodeModel({ MOCK2_FAST_MODEL: ' OFF ' }), null);
});

test('decideRouting: routine difficulty (<=3) with no rule override routes to the fast model', () => {
  const d = decideRouting({ slotModel: 'claude-opus-4-8', difficulty: 2 });
  assert.equal(d.model, DEFAULT_FAST_MODEL);
  assert.match(d.reason, /fast-model/);
});

test('decideRouting: hard tasks (difficulty 4-5) and unclassified tasks stay on the slot model', () => {
  assert.equal(decideRouting({ slotModel: 'claude-opus-4-8', difficulty: 4 }).model, 'claude-opus-4-8');
  assert.equal(decideRouting({ slotModel: 'claude-opus-4-8', difficulty: 5 }).model, 'claude-opus-4-8');
  assert.equal(decideRouting({ slotModel: 'claude-opus-4-8' }).model, 'claude-opus-4-8');
});

test('decideRouting: an explicit rule model override beats the fast model', () => {
  const rule = { task_kind: 'chore', model: 'claude-opus-4-8' };
  assert.equal(decideRouting({ rule, slotModel: 's', difficulty: 1 }).model, 'claude-opus-4-8');
});

test('decideRouting: MOCK2_FAST_MODEL=off restores slot-model behavior', () => {
  const d = decideRouting({ slotModel: 'claude-opus-4-8', difficulty: 1, env: { MOCK2_FAST_MODEL: 'off' } });
  assert.equal(d.model, 'claude-opus-4-8');
  assert.ok(!/fast-model/.test(d.reason));
});

test('decideRouting: escalation still wins over the fast model', () => {
  const d = decideRouting({
    slotModel: 'claude-opus-4-8', difficulty: 2, priorAttempts: 1,
    env: { MOCK2_ESCALATE_MODEL: 'claude-opus-4-8-escalate' },
  });
  assert.equal(d.model, 'claude-opus-4-8-escalate');
  assert.equal(d.rung, 1);
});

// ---- MVP routing decision ----

test('mvpRoutingDecision: fast model at medium effort, stamped as mvp', () => {
  const d = mvpRoutingDecision({}, 'claude-opus-4-8');
  assert.equal(d.model, DEFAULT_FAST_MODEL);
  assert.equal(d.effort, 'medium');
  assert.equal(d.rung, 0);
  assert.equal(d.build_mode, 'mvp');
});

test('mvpRoutingDecision: env overrides for model + effort; off falls back to the slot model', () => {
  const d = mvpRoutingDecision({ MOCK2_MVP_EFFORT: 'high', MOCK2_FAST_MODEL: 'claude-haiku-4-5-20251001' }, 'slot');
  assert.equal(d.model, 'claude-haiku-4-5-20251001');
  assert.equal(d.effort, 'high');
  const off = mvpRoutingDecision({ MOCK2_FAST_MODEL: 'off' }, 'claude-opus-4-8');
  assert.equal(off.model, 'claude-opus-4-8');
  const bad = mvpRoutingDecision({ MOCK2_MVP_EFFORT: 'ultra' }, 'slot');
  assert.equal(bad.effort, 'medium');
});
