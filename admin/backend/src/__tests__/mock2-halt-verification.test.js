// HALT VERIFICATION (run-taxonomy fix #5/D1). haltCycle previously recorded a
// halt with whatever gateReports happened to have run before it — usually
// nothing — so a resume's checkpoint said "gates_run: []" regardless of how
// much real work had just landed. This cost noted/551 four follow-on cycles:
// +190 lines landed then halted un-gated, so nothing told the resume it was
// already there, and 588 spent a whole cycle re-verifying what 551 had
// already done.
//
// Stub-first (risk R9): haltSummaryWithLandedWork lives in runner-logic.js
// (native-free — no db.js, no better-sqlite3, no Incus), so it's unit-tested
// directly. haltCycle itself (runner.js) is native orchestration — it wires
// this pure function to a real runGateBattery/checkpointAndRecord call
// against a container — and is exercised by the manual verification
// checklist, matching the codebase's stub-first convention (see
// mock2-symptom-cap.test.js for the same split on audit.js's orchestration).

import test from 'node:test';
import assert from 'node:assert/strict';

import { haltSummaryWithLandedWork, haltReasonLabel } from '../mock2/runner-logic.js';

test('haltSummaryWithLandedWork: no gates run states verification was unavailable', () => {
  const s = haltSummaryWithLandedWork({ trigger: 'model_halt', reason: 'blocked on missing env var', gateReports: [] });
  assert.match(s, /^halt: the build reported it was blocked/);
  assert.match(s, /no gate battery ran against the checkpointed tree \(verification unavailable at halt time\)/);
  assert.match(s, /Reason: blocked on missing env var/);
});

test('haltSummaryWithLandedWork: names the failing gates when some fail', () => {
  const s = haltSummaryWithLandedWork({
    trigger: 'no_tool_calls',
    reason: 'no progress',
    gateReports: [
      { name: 'typecheck', status: 'passed' },
      { name: 'rule-coverage', status: 'failed' },
      { name: 'ui-interaction', status: 'failed' },
    ],
  });
  assert.match(s, /1\/3 gates passed on the checkpointed tree — failing: rule-coverage, ui-interaction/);
});

test('haltSummaryWithLandedWork: reports N/M passed when all pass', () => {
  const s = haltSummaryWithLandedWork({
    trigger: 'max_turns',
    reason: null,
    gateReports: [{ name: 'typecheck', status: 'passed' }, { name: 'security-scan', status: 'passed' }],
  });
  assert.match(s, /2\/2 gates passed on the checkpointed tree/);
  assert.doesNotMatch(s, /failing:/);
  // No reason given → no "Reason:" line at all.
  assert.doesNotMatch(s, /Reason:/);
});

test('haltSummaryWithLandedWork truncates a very long reason', () => {
  const reason = 'x'.repeat(2000);
  const s = haltSummaryWithLandedWork({ trigger: 'model_halt', reason, gateReports: [] });
  const reasonLine = s.split('Reason: ')[1];
  assert.ok(reasonLine.length <= 500);
});

test('haltSummaryWithLandedWork: a skipped gate does not count as passed or failed', () => {
  const s = haltSummaryWithLandedWork({
    trigger: 'model_halt', reason: null,
    gateReports: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'skipped' }],
  });
  // 1 passed out of 2 total; the skipped gate is neither in "passed" nor "failing".
  assert.match(s, /1\/2 gates passed on the checkpointed tree/);
  assert.doesNotMatch(s, /failing:/);
});

test('haltSummaryWithLandedWork: always leads with the human-readable trigger label', () => {
  for (const trigger of ['model_halt', 'model_refusal', 'no_tool_calls', 'repeated_output', 'no_state_change', 'max_turns', 'something_new']) {
    const s = haltSummaryWithLandedWork({ trigger, reason: null, gateReports: [] });
    assert.ok(s.startsWith(`halt: ${haltReasonLabel(trigger)}`));
  }
});
