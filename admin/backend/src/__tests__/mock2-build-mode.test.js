// Build modes (full vs MVP) + the fast code model — the speed levers. Exercises
// the PURE decision layers (cycle-logic.js, routing-logic.js): mode
// normalization, the reduced MVP gate battery, the fast-model routing for
// routine tasks, and the fixed MVP routing decision. No DB/container, so it
// runs at the module boundary (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeBuildMode, filterGatesForBuildMode, isFastBuildMode,
  BUILD_MODE_FULL, BUILD_MODE_MVP, BUILD_MODE_QUICK, BUILD_MODES,
  buildGateBattery, touchesUserFacing, USER_FACING_RE, UI_INFRA_EXEMPT_RE,
  gatesForProfile, withBaselineGates,
} from '../mock2/cycle-logic.js';
import {
  fastCodeModel, mvpRoutingDecision, quickRoutingDecision, decideRouting, DEFAULT_FAST_MODEL,
} from '../mock2/routing-logic.js';

// ---- build-mode normalization ----

test('normalizeBuildMode: mvp/quick in any casing, everything else full', () => {
  assert.equal(normalizeBuildMode('mvp'), BUILD_MODE_MVP);
  assert.equal(normalizeBuildMode(' MVP '), BUILD_MODE_MVP);
  assert.equal(normalizeBuildMode('quick'), BUILD_MODE_QUICK);
  assert.equal(normalizeBuildMode(' QUICK '), BUILD_MODE_QUICK);
  for (const v of ['full', '', null, undefined, 'fast', 'banana']) {
    assert.equal(normalizeBuildMode(v), BUILD_MODE_FULL, `"${v}" should be full`);
  }
  assert.deepEqual([...BUILD_MODES], ['full', 'mvp', 'quick']);
  assert.equal(isFastBuildMode('mvp'), true);
  assert.equal(isFastBuildMode('quick'), true);
  assert.equal(isFastBuildMode('full'), false);
});

// ---- quick mode: gates + routing ----

// CHANGED DELIBERATELY. quick used to run NO gates. That, plus mvp also
// running none, meant the whole default path out of design approval — an MVP
// build then quick updates — shipped an app without a single gate executing.
// quick now runs only what costs seconds and cannot be pre-existing debt.
test('quick mode: runs the cheap gates only — never the slow or debt-prone ones', () => {
  const gates = ['typecheck', 'constitution-lint', 'security-scan', 'test', 'component-reuse', 'rule-coverage', 'ui-interaction', 'acceptance']
    .map((name, i) => ({ name, script: '#', order: i }));
  const names = filterGatesForBuildMode(gates, 'quick').map((g) => g.name);
  assert.deepEqual(names, ['typecheck'], 'typecheck is seconds; everything else waits for mvp/full');
  for (const slow of ['security-scan', 'rule-coverage', 'acceptance', 'test']) {
    assert.ok(!names.includes(slow), `${slow} must not block a one-line edit`);
  }
});

test('quickRoutingDecision: fast model at MEDIUM effort (cost default — a quick update is one small change), env-overridable', () => {
  const d = quickRoutingDecision({}, 'claude-opus-4-8');
  assert.equal(d.model, DEFAULT_FAST_MODEL);
  assert.equal(d.effort, 'medium');
  assert.equal(d.build_mode, 'quick');
  assert.equal(quickRoutingDecision({ MOCK2_QUICK_EFFORT: 'high' }, '').effort, 'high');
  assert.equal(quickRoutingDecision({ MOCK2_FAST_MODEL: 'off' }, 'slot-model').model, 'slot-model');
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

test('filterGatesForBuildMode: full mode keeps every operator gate', () => {
  assert.deepEqual(filterGatesForBuildMode(battery, 'full').map((g) => g.name), battery.map((g) => g.name));
});

// CHANGED DELIBERATELY (see above): mvp is now "does the app look and act
// right" — the visual/behavioural gates run, the slow correctness half does not.
test('filterGatesForBuildMode: mvp runs the look-and-act gates, not the slow ones', () => {
  const names = filterGatesForBuildMode(battery, 'mvp').map((g) => g.name);
  assert.ok(names.includes('typecheck'), 'typecheck rides every profile');
  assert.ok(names.includes('ui-interaction'), 'does it ACT right');
  for (const slow of ['security-scan', 'rule-coverage', 'acceptance', 'test', 'component-reuse']) {
    assert.ok(!names.includes(slow), `${slow} belongs to the full build, not the MVP`);
  }
});

test('filterGatesForBuildMode: tolerant of empty/absent batteries', () => {
  assert.deepEqual(filterGatesForBuildMode([], 'mvp'), []);
  assert.deepEqual(filterGatesForBuildMode(undefined, 'mvp'), []);
});

// ---- quick-lane escalation (run-taxonomy fix #4/C1) ----
//
// A quick update's regression gates ran only on greenfield/full builds — never
// on the lane that produces most changes. buildGateBattery escalates a quick
// request to the mvp battery when its diff touches a user-facing file, so the
// gates that catch a visible regression (mobile-overflow, no-dead-controls,
// no-native-dialogs, e2e) actually see the change that could break them.
const ESCALATION_ONLY_GATES = ['mobile-overflow', 'no-dead-controls', 'no-native-dialogs', 'e2e'];

test('quick + a diff touching public/ escalates to the mvp battery', () => {
  const result = buildGateBattery(battery, 'quick', { changedFiles: ['public/index.html', 'src/server.js'] });
  assert.equal(result.profile, 'mvp');
  assert.equal(result.requestedProfile, 'quick');
  assert.equal(result.escalated, true);
  const names = result.gates.map((g) => g.name);
  for (const g of ESCALATION_ONLY_GATES) assert.ok(names.includes(g), `${g} must run once escalated`);
});

test('quick + a docs-only diff stays quick', () => {
  const result = buildGateBattery(battery, 'quick', { changedFiles: ['README.md', 'docs/notes.md'] });
  assert.equal(result.profile, 'quick');
  assert.equal(result.requestedProfile, 'quick');
  assert.equal(result.escalated, false);
  const names = result.gates.map((g) => g.name);
  for (const g of ESCALATION_ONLY_GATES) assert.ok(!names.includes(g), `${g} must not run on an unescalated quick update`);
});

test('quick + only sw.js and build-id.js does NOT escalate (infrastructure exempt)', () => {
  const result = buildGateBattery(battery, 'quick', { changedFiles: ['public/sw.js', 'public/build-id.js', 'public/manifest.json'] });
  assert.equal(result.escalated, false);
  assert.equal(result.profile, 'quick');
});

test('quick with no changedFiles supplied is byte-identical to today', () => {
  const withNull = buildGateBattery(battery, 'quick');
  const withEmptyOpts = buildGateBattery(battery, 'quick', {});
  assert.equal(withNull.escalated, false);
  assert.equal(withNull.profile, 'quick');
  const legacy = withBaselineGates(gatesForProfile(battery, 'quick'), 'quick').map((g) => g.name);
  assert.deepEqual(withNull.gates.map((g) => g.name), legacy);
  assert.deepEqual(withEmptyOpts.gates.map((g) => g.name), legacy);
});

test('mvp and full batteries are unchanged by the escalation parameter (only quick escalates)', () => {
  const mvpNoFiles = buildGateBattery(battery, 'mvp');
  const mvpWithFiles = buildGateBattery(battery, 'mvp', { changedFiles: ['public/index.html'] });
  assert.equal(mvpNoFiles.escalated, false);
  assert.equal(mvpWithFiles.escalated, false);
  assert.deepEqual(mvpNoFiles.gates.map((g) => g.name), mvpWithFiles.gates.map((g) => g.name));

  const fullNoFiles = buildGateBattery(battery, 'full');
  const fullWithFiles = buildGateBattery(battery, 'full', { changedFiles: ['public/index.html'] });
  assert.equal(fullWithFiles.escalated, false);
  assert.deepEqual(fullNoFiles.gates.map((g) => g.name), fullWithFiles.gates.map((g) => g.name));
});

test('touchesUserFacing: matches screens, ignores infra files and non-UI code', () => {
  assert.equal(touchesUserFacing(['public/app.html']), true);
  assert.equal(touchesUserFacing(['src/views/profile.jsx']), true);
  assert.equal(touchesUserFacing(['public/sw.js']), false);
  assert.equal(touchesUserFacing(['public/build-id.json']), false);
  assert.equal(touchesUserFacing(['src/routes/api.js']), false);
  assert.equal(touchesUserFacing([]), false);
  assert.equal(touchesUserFacing(undefined), false);
});

// DRIFT GUARD: the ui-interaction gate script (framework-seed/gates.json) runs
// as shell inside the container and cannot import cycle-logic.js, so it keeps
// its own hand-maintained copy of these two regex lists. If someone edits one
// copy and not the other, this test catches it — comparing against the gate
// script's OWN regex literals, not against smoke-triggers.js's browser globs
// (a broader, unrelated set that only looks like a sibling copy).
test('USER_FACING_RE / UI_INFRA_EXEMPT_RE match the literal uiRe/infraRe embedded in the ui-interaction gate script', () => {
  const seed = JSON.parse(readFileSync(new URL('../mock2/framework-seed/gates.json', import.meta.url), 'utf8'));
  const gates = Array.isArray(seed) ? seed : seed.gates;
  const uiGate = gates.find((g) => g.name === 'ui-interaction');
  assert.ok(uiGate, 'ui-interaction gate must exist in the seed');
  const uiReMatch = uiGate.script.match(/const uiRe = (\[[^\]]*\]);/);
  const infraReMatch = uiGate.script.match(/const infraRe = (\[[^\]]*\]);/);
  assert.ok(uiReMatch, 'gate script must declare uiRe literally (drift guard broke on a script shape change)');
  assert.ok(infraReMatch, 'gate script must declare infraRe literally (drift guard broke on a script shape change)');
  const normalize = (s) => s.replace(/\s+/g, '');
  assert.equal(normalize(uiReMatch[1]), normalize(`[${USER_FACING_RE.map((r) => r.toString()).join(', ')}]`));
  assert.equal(normalize(infraReMatch[1]), normalize(`[${UI_INFRA_EXEMPT_RE.map((r) => r.toString()).join(', ')}]`));
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

test('mvpRoutingDecision: fast model at HIGH effort (quality default), stamped as mvp', () => {
  const d = mvpRoutingDecision({}, 'claude-opus-4-8');
  assert.equal(d.model, DEFAULT_FAST_MODEL);
  assert.equal(d.effort, 'high');
  assert.equal(d.rung, 0);
  assert.equal(d.build_mode, 'mvp');
});

test('mvpRoutingDecision: env overrides for model + effort; off falls back to the slot model', () => {
  const d = mvpRoutingDecision({ MOCK2_MVP_EFFORT: 'low', MOCK2_FAST_MODEL: 'claude-haiku-4-5-20251001' }, 'slot');
  assert.equal(d.model, 'claude-haiku-4-5-20251001');
  assert.equal(d.effort, 'low');
  const off = mvpRoutingDecision({ MOCK2_FAST_MODEL: 'off' }, 'claude-opus-4-8');
  assert.equal(off.model, 'claude-opus-4-8');
  const bad = mvpRoutingDecision({ MOCK2_MVP_EFFORT: 'ultra' }, 'slot');
  assert.equal(bad.effort, 'high'); // invalid override → the quality default
});
