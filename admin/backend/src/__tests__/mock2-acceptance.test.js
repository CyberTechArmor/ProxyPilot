// Acceptance discipline (cycle-94 hardening) — PURE logic tests, stub-first
// (risk R9). The worked example throughout is the real failure: cycle 94 /
// change-record 77 (project ADP) — a bug-fix cycle that "succeeded" with green
// gates while the mTLS false-rejection defect was never reproduced, spending
// ~19.8k of a 405k estimate, whose only change reworded string literals to
// dodge the secret-scan regex, and whose summary bundled prior cycles' work.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCEPTANCE_PATH, TASK_KINDS, classifyTaskKind, parseAcceptance,
  batteryHasRedTestGate, acceptanceVerdict, extractSummaryPathClaims,
  summaryOverclaims, anomalySignals, acceptanceRecord, ANOMALY_TOKEN_FRACTION,
} from '../mock2/acceptance-logic.js';

const ADP_INSTRUCTION = 'Fix three issues in the ADP connection screen. The ADP mTLS connection fails ("private key does not match the stored certificate"; SSL alert 40) even though the cert/key pair is valid.';

// ---- task classification ----

test('classifyTaskKind: the ADP instruction is a bugfix; a feature ask is not', () => {
  assert.equal(classifyTaskKind(ADP_INSTRUCTION), 'bugfix');
  assert.equal(classifyTaskKind('The Test connection button is broken and reports an error'), 'bugfix');
  assert.equal(classifyTaskKind('Please add a CSV export to the reports screen'), 'feature');
  assert.equal(classifyTaskKind(''), 'feature');
  assert.deepEqual([...TASK_KINDS], ['bugfix', 'feature', 'chore']);
  assert.equal(ACCEPTANCE_PATH, 'state/acceptance.json');
});

// ---- acceptance spec ----

const ADP_SPEC = {
  task: 'ADP mTLS connection works: Test connection turns all three checks green',
  kind: 'bugfix',
  defect_tag: 'defect-adp-mtls-mismatch',
  tests: ['src/adp/connection.repro.test.ts'],
  integration: { paths: ['src/adp/tls*'], contract_test: 'src/adp/tls.contract.test.ts' },
  ui: ['adp-test-connection-three-green'],
};

test('parseAcceptance: accepts the ADP bugfix spec; rejects the opt-outs', () => {
  const ok = parseAcceptance(JSON.stringify(ADP_SPEC));
  assert.equal(ok.ok, true);
  assert.equal(ok.spec.defect_tag, 'defect-adp-mtls-mismatch');
  assert.deepEqual(ok.spec.ui, ['adp-test-connection-three-green']);

  assert.equal(parseAcceptance('').ok, false);
  assert.equal(parseAcceptance('[]').ok, false);
  assert.equal(parseAcceptance(JSON.stringify({ task: 'x' })).ok, false); // no kind
  // a bugfix cannot skip the defect tag or the regression test
  assert.match(parseAcceptance(JSON.stringify({ task: 'x', kind: 'bugfix' })).error, /defect_tag/);
  assert.match(parseAcceptance(JSON.stringify({ task: 'x', kind: 'bugfix', defect_tag: 'defect-x-y' })).error, /regression test/);
  // integration declared without a contract test
  assert.match(parseAcceptance(JSON.stringify({ task: 'x', kind: 'feature', integration: {} })).error, /contract_test/);
});

// ---- reproduce-first (red→green) ----

test('batteryHasRedTestGate: only a red TEST gate counts as a reproduction', () => {
  assert.equal(batteryHasRedTestGate([{ name: 'test', status: 'failed' }]), true);
  assert.equal(batteryHasRedTestGate([{ name: 'typecheck', status: 'failed' }, { name: 'test', status: 'passed' }]), false);
  assert.equal(batteryHasRedTestGate([]), false);
});

test('acceptanceVerdict: the EXACT cycle-94 shape is rejected — bugfix, green gates, no red ever observed', () => {
  const parsed = parseAcceptance(JSON.stringify(ADP_SPEC));
  const v = acceptanceVerdict({ parsed, instructionKind: 'bugfix', redTestObserved: false });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /Reproduce-first not demonstrated/);
  assert.match(v.reasons.join(' '), /not acceptance/);
  // red observed → accepted
  assert.equal(acceptanceVerdict({ parsed, instructionKind: 'bugfix', redTestObserved: true }).ok, true);
});

test('acceptanceVerdict: a missing spec is rejected; a spec cannot reclassify a bugfix away', () => {
  const missing = acceptanceVerdict({ parsed: { ok: false, error: 'not found' }, instructionKind: 'bugfix', redTestObserved: true });
  assert.equal(missing.ok, false);
  assert.match(missing.reasons.join(' '), /acceptance\.json is missing/);
  // instruction says bugfix, spec claims feature → still held to reproduce-first
  const sneaky = parseAcceptance(JSON.stringify({ task: 'x', kind: 'feature' }));
  const v = acceptanceVerdict({ parsed: sneaky, instructionKind: 'bugfix', redTestObserved: false });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /reclassify|Reproduce-first/);
  // a genuine feature with a valid spec passes without a red test
  assert.equal(acceptanceVerdict({ parsed: sneaky, instructionKind: 'feature', redTestObserved: false }).ok, true);
});

// ---- change-record accountability (over-claiming) ----

test('summaryOverclaims: the cycle-94 summary (bundling prior work) is rejected against its literal-only diff', () => {
  // What cycle 94 actually changed: string literals in one source file.
  const actualDiff = ['src/adp/scan-strings.ts'];
  // What its summary claimed: persistence + mTLS work from prior cycles.
  const summary = 'Implemented ADP connection persistence (src/adp/store.ts), mTLS agent wiring in src/adp/tls.ts, and hardened the secret scan handling in src/adp/scan-strings.ts';
  const oc = summaryOverclaims(summary, actualDiff);
  assert.equal(oc.ok, false);
  assert.deepEqual(oc.unmatched.sort(), ['src/adp/store.ts', 'src/adp/tls.ts']);
  // a summary scoped to the real diff passes
  assert.equal(summaryOverclaims('Reworded scanner-matching literals in src/adp/scan-strings.ts', actualDiff).ok, true);
});

test('extractSummaryPathClaims + matching tolerances (basename, suffix)', () => {
  assert.deepEqual(extractSummaryPathClaims('touched src/a/b.ts and `public/app.js`, plus config.yaml'), ['src/a/b.ts', 'public/app.js', 'config.yaml']);
  // shortened path claims match their suffix; bare basenames match too
  assert.equal(summaryOverclaims('fixed adp/tls.ts', ['src/adp/tls.ts']).ok, true);
  assert.equal(summaryOverclaims('fixed tls.ts', ['src/adp/tls.ts']).ok, true);
  // prose without path-like tokens never over-claims
  assert.equal(summaryOverclaims('Fixed the false rejection so Test connection goes green', []).ok, true);
});

// ---- anomaly tripwire ----

test('anomalySignals: the cycle-94 signature flags — 19.8k of 405k, no red test, no test file', () => {
  const a = anomalySignals({
    kind: 'bugfix', usedTokens: 19800, estTokens: 405000,
    changedFiles: ['src/adp/scan-strings.ts'], redTestObserved: false,
  });
  assert.equal(a.flag, true);
  assert.match(a.reasons.join(' '), /5% of its token estimate/);
  assert.match(a.reasons.join(' '), /never have been reproduced/);
  assert.match(a.reasons.join(' '), /no test file/);
});

test('anomalySignals: an honest bug fix (red observed, test touched) does not flag; features never flag', () => {
  assert.equal(anomalySignals({
    kind: 'bugfix', usedTokens: 19800, estTokens: 405000,
    changedFiles: ['src/adp/tls.ts', 'src/adp/connection.repro.test.ts'], redTestObserved: true,
  }).flag, false);
  assert.equal(anomalySignals({ kind: 'feature', usedTokens: 1, estTokens: 100000, changedFiles: [], redTestObserved: false }).flag, false);
  assert.ok(ANOMALY_TOKEN_FRACTION > 0 && ANOMALY_TOKEN_FRACTION < 1);
});

// ---- the distinguishable record ----

test('acceptanceRecord: "gates green" and "acceptance demonstrated" are distinct states', () => {
  const spec = parseAcceptance(JSON.stringify(ADP_SPEC)).spec;
  const notDemonstrated = acceptanceRecord({ spec, instructionKind: 'bugfix', redTestObserved: false, uiRequired: spec.ui });
  assert.equal(notDemonstrated.demonstrated, false);
  const demonstrated = acceptanceRecord({ spec, instructionKind: 'bugfix', redTestObserved: true, uiRequired: spec.ui });
  assert.equal(demonstrated.demonstrated, true);
  assert.equal(demonstrated.defect_tag, 'defect-adp-mtls-mismatch');
  assert.deepEqual(demonstrated.ui_required, ['adp-test-connection-three-green']);
  // a feature demonstrates via its declared checks, not red→green
  assert.equal(acceptanceRecord({ spec: null, instructionKind: 'feature' }).demonstrated, true);
});

test('REGRESSION: a summary that ENDS a sentence with a filename is not an over-claim', () => {
  // Project 46's build lost two of its five finish attempts to this, and both
  // times the model diagnosed it correctly as a false positive. The token class
  // includes '.', so the sentence's full stop was captured into the path and
  // matched no changed file. Repeated over-claiming AUTO-HALTS a cycle — this
  // could kill a build over punctuation.
  const changed = ['public/login.html', 'public/theme.js', 'public/design.css', 'src/platform/branding.ts'];
  for (const summary of [
    'restyled login head to load theme.js/design.css.',
    'fixed a literal-comparison type error in src/platform/branding.ts.',
    'Rewrote public/login.html!',
    'Which file changed? public/theme.js;',
  ]) {
    const oc = summaryOverclaims(summary, changed);
    assert.equal(oc.ok, true, `${JSON.stringify(summary)} should pass, got ${JSON.stringify(oc.unmatched)}`);
  }
  // Mid-sentence claims were always fine and must stay fine.
  assert.equal(summaryOverclaims('touched src/platform/branding.ts and stopped', changed).ok, true);

  // And a real over-claim is still caught, WITH the punctuation stripped so the
  // rejection names the file rather than the file-plus-full-stop.
  const bad = summaryOverclaims('also rewrote src/nope/missing.ts.', changed);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unmatched, ['src/nope/missing.ts']);

  // The extractor itself: punctuation never survives into a claim.
  assert.deepEqual(extractSummaryPathClaims('see src/a/b.ts.'), ['src/a/b.ts']);
  assert.deepEqual(extractSummaryPathClaims('a.ts, b.ts; c.ts!'), ['a.ts', 'b.ts', 'c.ts']);
});
