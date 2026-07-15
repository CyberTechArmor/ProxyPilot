// PATCH Part B/C — the resolution decision layer: class-matched options (B.1) +
// the B.1 invariant, waiver eligibility (B.2), and the loop breaker (B.4).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINDING_CLASSES, classifyFinding, waiverEligible,
  RESOLUTION_OPTIONS, resolvingOptionsForClass, resolvingOptionExistsForClass,
  invariantHolds, collectFindings, classesInRecord, resolutionOptionsFor,
  findingSetSignature, loopBreakerVerdict, resolutionIneffectiveSummary,
} from '../mock2/resolution-logic.js';

// A minimal decision-record builder for the tests.
const rec = (findings = [], extra = {}) => ({
  gate: { verdict: findings.length ? 'fail' : 'pass', findings },
  egress: { ok: true, findings: [] },
  screening: { blocking: false, candidates: [] },
  manifest: { ok: true },
  ...extra,
});

// ---- classification ----

test('classifyFinding maps every emittable kind to a class', () => {
  assert.equal(classifyFinding({ kind: 'undeclared_integration' }), 'undeclared');
  assert.equal(classifyFinding({ kind: 'fabricated_output' }), 'simulated');
  assert.equal(classifyFinding({ kind: 'execution_without_transport' }), 'simulated');
  assert.equal(classifyFinding({ kind: 'error_converted_to_success' }), 'simulated');
  assert.equal(classifyFinding({ kind: 'fixture_reachable_in_production' }), 'simulated');
  assert.equal(classifyFinding({ kind: 'provenance_not_established' }), 'provenance-not-established');
  assert.equal(classifyFinding({ kind: 'contract_test_missing' }), 'contract-missing');
  assert.equal(classifyFinding({ kind: 'fixture_tooling_missing' }), 'fixture-tooling-missing');
  assert.equal(classifyFinding({ kind: 'undeclared_private_egress' }), 'egress-missing');
  assert.equal(classifyFinding({ tier: 'high' }), 'simulated');
});

// ---- B.1 invariant: every finding class has a resolving option ----

test('B.1 invariant: every finding class the gate can emit has a resolving option', () => {
  const v = invariantHolds(FINDING_CLASSES);
  assert.equal(v.ok, true, `uncovered classes: ${v.uncovered.join(', ')}`);
  for (const cls of FINDING_CLASSES) {
    assert.ok(resolvingOptionExistsForClass(cls), `class "${cls}" has NO resolving option`);
    assert.ok(resolvingOptionsForClass(cls).length >= 1);
  }
});

test('B.1 invariant FAILS for a hypothetical class with no resolving option (red→green for the invariant itself)', () => {
  const v = invariantHolds([...FINDING_CLASSES, 'a-brand-new-class-with-no-option']);
  assert.equal(v.ok, false);
  assert.deepEqual(v.uncovered, ['a-brand-new-class-with-no-option']);
});

// ---- B.1: options match the classes present ----

test('undeclared findings now offer the backfill-manifest option', () => {
  const r = rec([{ kind: 'undeclared_integration', file: 'src/notify/service.ts' }]);
  const { options, classes } = resolutionOptionsFor(r);
  assert.deepEqual(classes, ['undeclared']);
  const backfill = options.find((o) => o.id === 'backfill_manifest');
  assert.ok(backfill, 'expected the backfill-manifest option');
  assert.ok(backfill.resolves.includes('undeclared'));
  // implement/approve/egress do NOT resolve undeclared, so they are not offered here.
  assert.ok(!options.some((o) => o.id === 'declare_egress'));
});

test('a mixed record offers a resolving option for every class present, and reports none uncovered', () => {
  const r = rec(
    [{ kind: 'undeclared_integration', file: 'src/a/x.ts' }, { kind: 'fabricated_output', file: 'src/b/y.ts', function: 'sync' }, { kind: 'provenance_not_established', file: 'src/c/z.ts' }],
    { egress: { ok: false, findings: [{ kind: 'undeclared_private_egress', message: 'dials 10.0.0.5' }] } },
  );
  const { options, classes, uncovered } = resolutionOptionsFor(r);
  assert.deepEqual(uncovered, [], `every present class must have an option; uncovered: ${uncovered}`);
  for (const cls of classes) {
    assert.ok(options.some((o) => o.resolves.includes(cls)), `no option resolves class "${cls}"`);
  }
  assert.ok(options.some((o) => o.id === 'backfill_manifest'));
  assert.ok(options.some((o) => o.id === 'waive_provenance'));
  assert.ok(options.some((o) => o.id === 'declare_egress'));
});

// ---- B.2 waiver eligibility ----

test('B.2 waiver is eligible ONLY for provenance-not-established, refused for fabricated', () => {
  assert.equal(waiverEligible({ kind: 'provenance_not_established' }), true);
  assert.equal(waiverEligible({ kind: 'fabricated_output' }), false);
  assert.equal(waiverEligible({ kind: 'execution_without_transport' }), false);
  assert.equal(waiverEligible({ kind: 'fixture_reachable_in_production' }), false);
  assert.equal(waiverEligible({ kind: 'undeclared_integration' }), false);
  // The waiver option resolves ONLY provenance-not-established (never simulated).
  const waive = RESOLUTION_OPTIONS.find((o) => o.id === 'waive_provenance');
  assert.deepEqual(waive.resolves, ['provenance-not-established']);
  assert.equal(waive.adminOnly, true);
});

test('a positively-fabricated record does NOT offer the waiver', () => {
  const r = rec([{ kind: 'fabricated_output', file: 'src/a/x.ts', function: 'sync' }]);
  const { options } = resolutionOptionsFor(r);
  assert.ok(!options.some((o) => o.id === 'waive_provenance'), 'fabricated findings must not offer a waiver');
  assert.ok(options.some((o) => o.id === 'implement_real'));
  assert.ok(options.some((o) => o.id === 'approve_simulation'));
});

// ---- B.4 loop breaker ----

test('findingSetSignature is order-independent and stable', () => {
  const a = rec([{ kind: 'undeclared_integration', file: 'src/a/x.ts' }, { kind: 'fabricated_output', file: 'src/b/y.ts', function: 'sync' }]);
  const b = rec([{ kind: 'fabricated_output', file: 'src/b/y.ts', function: 'sync' }, { kind: 'undeclared_integration', file: 'src/a/x.ts' }]);
  assert.equal(findingSetSignature(a), findingSetSignature(b));
  const c = rec([{ kind: 'undeclared_integration', file: 'src/a/x.ts' }]);
  assert.notEqual(findingSetSignature(a), findingSetSignature(c));
});

test('loop breaker fires when an identical finding set survives N=2 consecutive blocks', () => {
  const sig = 'S';
  // First block: no priors → 1 consecutive → not ineffective.
  assert.equal(loopBreakerVerdict({ priorSignatures: [], currentSignature: sig }).ineffective, false);
  // Second consecutive identical block → ineffective.
  const v = loopBreakerVerdict({ priorSignatures: [sig], currentSignature: sig });
  assert.equal(v.ineffective, true);
  assert.equal(v.consecutive, 2);
  // A different finding set breaks the run (real progress).
  assert.equal(loopBreakerVerdict({ priorSignatures: ['OTHER'], currentSignature: sig }).ineffective, false);
  // Threshold is respected: 3 identical → still ineffective.
  assert.equal(loopBreakerVerdict({ priorSignatures: [sig, sig], currentSignature: sig }).consecutive, 3);
});

test('resolution-ineffective summary surfaces the FULL finding list inline, not a count', () => {
  const r = rec([{ kind: 'undeclared_integration', file: 'src/a/x.ts' }, { kind: 'undeclared_integration', file: 'src/b/y.ts' }]);
  const s = resolutionIneffectiveSummary(r, { consecutive: 2 });
  assert.equal(s.state, 'resolution-ineffective');
  assert.equal(s.findings.length, 2);
  assert.ok(s.findings[0].includes('src/a/x.ts'));
  assert.ok(/free-text|admin override/i.test(s.requires));
});
