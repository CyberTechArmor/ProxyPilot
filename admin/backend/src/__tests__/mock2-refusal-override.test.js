// SHARED REFUSAL-OVERRIDE WINDOW (run-taxonomy fix #6/D2.3). The symptom-chase
// cap (B2), the Define-stage enforcement (C2), and the duplicate-work check
// (D2) each let an operator override a refusal by repeating the action within
// a short window — this is the ONE place the window arithmetic lives, so
// audit.js's symptomCapOverrideActive/ruleGateOverrideActive/
// duplicateOverrideActive are thin per-project-Map wrappers around it, not
// three independent copies.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  refusalOverrideActive, DEFAULT_OVERRIDE_WINDOW_MINUTES, preBuildGatesApply, mayConsumeOverride,
} from '../mock2/refusal-override-logic.js';

test('DEFAULT_OVERRIDE_WINDOW_MINUTES is 10 (matches B2/C2 already-shipped behaviour)', () => {
  assert.equal(DEFAULT_OVERRIDE_WINDOW_MINUTES, 10);
});

test('refusalOverrideActive: true just inside the window, false just outside it', () => {
  const now = 1_000_000_000_000;
  const refusedAt = now - 9 * 60 * 1000; // 9 minutes ago
  assert.equal(refusalOverrideActive({ refusedAt, now }), true);
  const tooLongAgo = now - 11 * 60 * 1000; // 11 minutes ago
  assert.equal(refusalOverrideActive({ refusedAt: tooLongAgo, now }), false);
});

test('refusalOverrideActive: exactly at the boundary is still active (inclusive)', () => {
  const now = 1_000_000_000_000;
  const refusedAt = now - 10 * 60 * 1000;
  assert.equal(refusalOverrideActive({ refusedAt, now }), true);
});

test('refusalOverrideActive: no prior refusal (refusedAt null/undefined) is never active', () => {
  assert.equal(refusalOverrideActive({ refusedAt: null, now: Date.now() }), false);
  assert.equal(refusalOverrideActive({ refusedAt: undefined, now: Date.now() }), false);
  assert.equal(refusalOverrideActive({}), false);
});

test('refusalOverrideActive: withinMinutes is overridable per call site', () => {
  const now = 1_000_000_000_000;
  const refusedAt = now - 4 * 60 * 1000;
  assert.equal(refusalOverrideActive({ refusedAt, now, withinMinutes: 3 }), false);
  assert.equal(refusalOverrideActive({ refusedAt, now, withinMinutes: 5 }), true);
});

test('refusalOverrideActive: defaults now to the real clock when omitted', () => {
  // Not a fake-timer test — just proves the "no now passed" path doesn't throw
  // and reads as "just refused" (recent enough to be within the default window).
  assert.equal(refusalOverrideActive({ refusedAt: Date.now() - 1000 }), true);
});

/* ================= WHO THE GUARDRAIL IS TALKING TO (project 55) ============ */
//
// The escape hatch on all three refusals is "press Build again within 10
// minutes" — which presumes a person is reading it. The harness queues builds
// of its own, and project 55's context handoff hit that gap: a half-finished
// build checkpointed, queued its continuation, and the rules gate refused it
// with "no confirmed rules — run Define first". Nothing can press Build for a
// queue, so the row was marked failed and the work abandoned mid-flight —
// while the refusal armed the ten-minute window for whatever drained next.

test('preBuildGatesApply: a harness-queued build is never interrogated', () => {
  assert.equal(preBuildGatesApply('system'), false, 'a continuation is authorized work being carried on');
  assert.equal(preBuildGatesApply('operator'), true);
  assert.equal(preBuildGatesApply('queued'), true, 'an operator ask that waited in line is still a new ask');
  // Anything unrecognised is treated as a person's ask — the gates stay on.
  assert.equal(preBuildGatesApply(undefined), true);
  assert.equal(preBuildGatesApply(''), true);
  assert.equal(preBuildGatesApply('nonsense'), true);
});

test('mayConsumeOverride: only an actual press can spend the ten-minute window', () => {
  assert.equal(mayConsumeOverride('operator'), true);
  // Draining a queue is not "pressing Build again": a queued row must not
  // inherit an override someone else's press armed.
  assert.equal(mayConsumeOverride('queued'), false);
  assert.equal(mayConsumeOverride('system'), false);
  assert.equal(mayConsumeOverride(undefined), true, 'the default IS the interactive press');
});

test('the two questions are independent — a queued ask is gated but cannot override', () => {
  assert.equal(preBuildGatesApply('queued') && !mayConsumeOverride('queued'), true);
  // …and a system build is neither gated nor able to override, so it can
  // never arm the window for the next row either.
  assert.equal(preBuildGatesApply('system') || mayConsumeOverride('system'), false);
});
