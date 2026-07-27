// Mock2 Phase M6 tests — the cycle-runner pure decision layer (ADR-003/004).
//
// Stub-first (risk R9): imports ONLY cycle-logic.js + runner-logic.js
// (native-free). The state machine, interrupt policy, gate-battery verdict, cost
// envelope, and buffer stop are safety-critical, so they're unit-tested here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isActiveStatus, isTerminalStatus, isValidInterrupt, interruptDecision,
  estimateCycleTokens, gateBatteryVerdict, allGatesGreen, parseGateScripts, gateStatusFromOutput,
  initialGateReports, shouldStopForBudget, retriesExhausted, MAX_CYCLE_RETRIES,
  publicCycleShape,
} from '../mock2/cycle-logic.js';
import {
  RUNNER_TOOLS, RUNNER_TOOL_NAMES, truncateToolResult, parseFrameworkSkills,
  buildRunnerSystemPrompt, buildRunnerTask, classifyTurn, MAX_TOOL_RESULT_CHARS,
} from '../mock2/runner-logic.js';

// ---- status sets ----

test('active vs terminal statuses', () => {
  assert.equal(isActiveStatus('running'), true);
  assert.equal(isActiveStatus('estimating'), true);
  assert.equal(isActiveStatus('succeeded'), false);
  assert.equal(isTerminalStatus('refused_quota'), true);
  assert.equal(isTerminalStatus('awaiting_admin'), true);
  assert.equal(isTerminalStatus('running'), false);
});

// ---- interrupts ----

test('isValidInterrupt', () => {
  assert.equal(isValidInterrupt(null), true);
  assert.equal(isValidInterrupt('abandon'), true);
  assert.equal(isValidInterrupt('nope'), false);
});

test('interruptDecision: each interrupt maps to a stop + terminal status', () => {
  assert.deepEqual(interruptDecision(null), { stop: false, checkpointFirst: false, terminalStatus: null, queued: false });
  assert.equal(interruptDecision('abandon').terminalStatus, 'abandoned');
  assert.equal(interruptDecision('stop_after_step').terminalStatus, 'interrupted');
  const q = interruptDecision('queue_after_step');
  assert.equal(q.terminalStatus, 'interrupted');
  assert.equal(q.queued, true);
  // all three checkpoint first (branch stays recoverable)
  for (const i of ['abandon', 'stop_after_step', 'queue_after_step']) {
    assert.equal(interruptDecision(i).checkpointFirst, true);
    assert.equal(interruptDecision(i).stop, true);
  }
});

// ---- estimate (R5 envelope) ----

test('estimateCycleTokens: turns × per-turn × safety, ceil', () => {
  const e = estimateCycleTokens({ turns: 4, turnInputTokens: 1000, turnOutputTokens: 500, safetyFactor: 2 });
  assert.equal(e.inputTokens, 8000); // 4 * 1000 * 2
  assert.equal(e.outputTokens, 4000);
  // defaults are non-zero
  const d = estimateCycleTokens();
  assert.ok(d.inputTokens > 0 && d.outputTokens > 0);
  // nonsensical inputs (0 turns / 0 safety) fall back to the sane defaults, so
  // the envelope is always a positive reservation.
  const clamped = estimateCycleTokens({ turns: 0, safetyFactor: 0, turnInputTokens: 100, turnOutputTokens: 100 });
  assert.ok(clamped.inputTokens > 0 && clamped.outputTokens > 0);
});

// ---- gate battery ----

test('gateBatteryVerdict / allGatesGreen', () => {
  assert.equal(gateBatteryVerdict([]), 'pending');
  assert.equal(gateBatteryVerdict([{ status: 'passed' }, { status: 'pending' }]), 'pending');
  assert.equal(gateBatteryVerdict([{ status: 'passed' }, { status: 'failed' }]), 'red');
  assert.equal(gateBatteryVerdict([{ status: 'passed' }, { status: 'passed' }]), 'green');
  assert.equal(allGatesGreen([{ status: 'passed' }]), true);
  assert.equal(allGatesGreen([{ status: 'passed' }, { status: 'failed' }]), false);
  // A skipped gate RESOLVES green — it is the same exit 0 it always returned,
  // and blocking a checkpoint on a missing browser binary would be a
  // regression. The status exists so the report can stop calling it "passed".
  assert.equal(gateBatteryVerdict([{ status: 'passed' }, { status: 'skipped' }]), 'green');
  assert.equal(allGatesGreen([{ status: 'skipped' }, { status: 'passed' }]), true);
  assert.equal(gateBatteryVerdict([{ status: 'skipped' }, { status: 'failed' }]), 'red');
  assert.equal(gateBatteryVerdict([{ status: 'skipped' }, { status: 'running' }]), 'pending');
});

test('gateStatusFromOutput: a gate that exits 0 saying it did not run is skipped, not passed', () => {
  // The exact line project 42 shipped behind, inside eight green gates.
  assert.equal(gateStatusFromOutput(0, 'e2e: no browser installed; skipped. Run: npm run e2e:install'), 'skipped');
  assert.equal(gateStatusFromOutput(0, 'ui-interaction: no user-facing paths in this change; skipped.'), 'skipped');
  assert.equal(gateStatusFromOutput(0, 'design-adherence: no state/design.css - nothing approved to adhere to. Skipped.'), 'skipped');
  // A gate that really ran prints a verdict, and that is what separates the two.
  assert.equal(gateStatusFromOutput(0, 'ui-interaction: OK - 7 file(s) covered by 6 check(s).'), 'passed');
  assert.equal(gateStatusFromOutput(0, 'platform-intact: the platform module is present. Passed.'), 'passed');
  // A gate that skips ONE sub-check and then passes is passed, not skipped —
  // which is why both halves of the rule are load-bearing.
  assert.equal(gateStatusFromOutput(0, 'test: 3 suites skipped\ntest: 41 passed. Passed.'), 'passed');
  // Nothing about a non-zero exit changes.
  assert.equal(gateStatusFromOutput(1, 'e2e: FAIL - 2 specs failed'), 'failed');
  assert.equal(gateStatusFromOutput(1, 'anything; skipped.'), 'failed');
  assert.equal(gateStatusFromOutput(0, ''), 'passed');
});

test('parseGateScripts: sorts by order, drops malformed, tolerates bad json', () => {
  const gates = parseGateScripts(JSON.stringify([
    { name: 'b', script: 'echo b', order: 2 },
    { name: 'a', script: 'echo a', order: 1 },
    { name: 'bad' }, // no script — dropped
  ]));
  assert.deepEqual(gates.map((g) => g.name), ['a', 'b']);
  assert.deepEqual(parseGateScripts('not json'), []);
  assert.deepEqual(parseGateScripts(null), []);
});

test('initialGateReports: all pending', () => {
  const reports = initialGateReports([{ name: 'x', script: '' }]);
  assert.deepEqual(reports, [{ name: 'x', status: 'pending', started_at: null, report: null }]);
});

// ---- buffer stop (R5 guard) + retries ----

test('shouldStopForBudget: only when metered and spent >= budget', () => {
  assert.equal(shouldStopForBudget({ budgetCents: null, spentCents: 9999 }), false);
  assert.equal(shouldStopForBudget({ budgetCents: 1000, spentCents: 999 }), false);
  assert.equal(shouldStopForBudget({ budgetCents: 1000, spentCents: 1000 }), true);
  assert.equal(shouldStopForBudget({ budgetCents: 1000, spentCents: 1200 }), true);
});

test('retriesExhausted: escalates only after MAX_CYCLE_RETRIES retries are used', () => {
  assert.equal(MAX_CYCLE_RETRIES, 2);
  assert.equal(retriesExhausted(1), false); // failure 1 → retry
  assert.equal(retriesExhausted(2), false); // failure 2 → retry (2 retries used)
  assert.equal(retriesExhausted(3), true);  // failure 3 → escalate
});

// ---- publicCycleShape ----

test('publicCycleShape: parses gates_json, coerces booleans', () => {
  const shaped = publicCycleShape({
    id: 5, project_id: 2, framework_version_id: 1, stage: 'build', status: 'running',
    gates_json: '[{"name":"g","status":"passed"}]', instruction: 'add /health', initiated_by: 3,
    acting_as_admin: 1, used_tokens: 100, used_cost_cents: 4, retries: 0,
  });
  assert.equal(shaped.status, 'running');
  assert.equal(shaped.acting_as_admin, true);
  assert.deepEqual(shaped.gates, [{ name: 'g', status: 'passed' }]);
  assert.equal(shaped.instruction, 'add /health');
  assert.equal(publicCycleShape(null), null);
});

// ---- runner-logic ----

test('RUNNER_TOOLS: the fixed tool set, all named, finish present', () => {
  assert.ok(RUNNER_TOOL_NAMES.includes('exec_in_container'));
  assert.ok(RUNNER_TOOL_NAMES.includes('run_gates'));
  assert.ok(RUNNER_TOOL_NAMES.includes('finish'));
  for (const t of RUNNER_TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.equal(t.input_schema.type, 'object');
  }
});

test('truncateToolResult: caps at MAX_TOOL_RESULT_CHARS', () => {
  const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
  const out = truncateToolResult(big);
  assert.ok(out.length < big.length);
  assert.match(out, /truncated/);
  assert.equal(truncateToolResult('short'), 'short');
});

test('parseFrameworkSkills: object-of-skills and array-of-skills', () => {
  const obj = parseFrameworkSkills(JSON.stringify({ concept: { name: 'Concept', description: 'x' } }));
  assert.equal(obj[0].name, 'Concept');
  const arr = parseFrameworkSkills(JSON.stringify([{ name: 'Build', description: 'y' }]));
  assert.equal(arr[0].name, 'Build');
  assert.deepEqual(parseFrameworkSkills('bad'), []);
  assert.deepEqual(parseFrameworkSkills(null), []);
});

test('buildRunnerSystemPrompt: embeds pinned constitution + skills + guidance', () => {
  const p = buildRunnerSystemPrompt({ constitution: 'STACK: TypeScript', skills: [{ name: 'Build', description: 'gen code' }], appDir: '/srv/app', webPort: 3000 });
  assert.match(p, /STACK: TypeScript/);
  assert.match(p, /Build: gen code/);
  assert.match(p, /run_gates/);
  assert.match(p, /never approve your own/);
  // placeholder note when no constitution
  assert.match(buildRunnerSystemPrompt({}), /placeholder constitution/);
});

test('buildRunnerTask + classifyTurn', () => {
  assert.equal(buildRunnerTask('  add /health  '), 'Task: add /health');
  // finish → done
  const done = classifyTurn([{ name: 'finish', input: { summary: 'added /health' } }]);
  assert.equal(done.done, true);
  assert.equal(done.finishSummary, 'added /health');
  // other tool calls → not done, not stalled
  const work = classifyTurn([{ name: 'write_file', input: {} }]);
  assert.equal(work.done, false);
  assert.equal(work.stalled, false);
  // no tools → stalled
  const stalled = classifyTurn([]);
  assert.equal(stalled.stalled, true);
});

test('classifyTurn: halt returns enriched, typed resolution options (ADP replay shape)', () => {
  const halted = classifyTurn([{
    name: 'halt',
    input: {
      reason: 'a stale seed row blocks the data-cleanup change',
      options: [
        { label: 'Grant the one-row DELETE', kind: 'grant_authorization', recommended: true, risk: 'removes 1 stale test row', injectOnResume: 'Run the DELETE, once.', authorization: { scope: "DELETE FROM users WHERE email = 'seed@test'", expectedRows: 1 } },
        { label: 'Run the framework isolation cycle first, then resume', kind: 'run_dependency_first', risk: 'slower' },
        { label: 'Abandon this change', kind: 'abandon' },
      ],
    },
  }]);
  assert.equal(halted.halted, true);
  assert.equal(halted.haltOptions.length, 3);
  assert.equal(halted.haltOptions[0].kind, 'grant_authorization');
  assert.equal(halted.haltOptions[0].recommended, true);
  assert.equal(halted.haltOptions[0].authorization.scope, "DELETE FROM users WHERE email = 'seed@test'");
  assert.equal(halted.haltOptions[2].kind, 'abandon');
});

test('RUNNER_TOOLS: halt requires reason + options (2–4 typed resolutions)', () => {
  const halt = RUNNER_TOOLS.find((t) => t.name === 'halt');
  assert.ok(halt.input_schema.required.includes('reason'));
  assert.ok(halt.input_schema.required.includes('options'));
  const opts = halt.input_schema.properties.options;
  assert.equal(opts.minItems, 2);
  assert.equal(opts.maxItems, 4);
  assert.ok(opts.items.required.includes('kind'));
  assert.deepEqual(opts.items.properties.kind.enum, ['grant_authorization', 'expand_scope', 'run_dependency_first', 'override_rule', 'abandon']);
});
