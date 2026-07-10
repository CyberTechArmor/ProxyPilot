// Mock2 Phase M5 tests — the quota pure decision layer (ADR-003 / risk R5).
//
// Stub-first (risk R9): imports ONLY quota-logic.js (native-free). canStartCycle
// is the gate M6 enforces; the ledger arithmetic must be trustworthy, so it's
// unit-tested here now.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  costCentsForUsage,
  sumLedger,
  remainingBudgetCents,
  bufferedReservationCents,
  canStartCycle,
  publicQuotaShape,
} from '../mock2/quota-logic.js';

// ---- ledger arithmetic ----

test('costCentsForUsage: cents per mtok, rounded', () => {
  // 1M input @ 500¢/mtok + 0.5M output @ 1500¢/mtok = 500 + 750 = 1250¢
  const price = { input_cents_per_mtok: 500, output_cents_per_mtok: 1500 };
  assert.equal(costCentsForUsage({ inputTokens: 1_000_000, outputTokens: 500_000 }, price), 1250);
  assert.equal(costCentsForUsage({ inputTokens: 0, outputTokens: 0 }, price), 0);
  assert.equal(costCentsForUsage({ inputTokens: 100, outputTokens: 100 }, null), 0); // self-hosted: no price → 0
});

test('sumLedger: totals across rows', () => {
  const rows = [
    { input_tokens: 100, output_tokens: 50, cost_cents: 10, wall_clock_ms: 1000 },
    { input_tokens: 200, output_tokens: 25, cost_cents: 5, wall_clock_ms: 2000 },
    null, // tolerated
  ];
  assert.deepEqual(sumLedger(rows), { inputTokens: 300, outputTokens: 75, costCents: 15, wallClockMs: 3000, count: 2 });
  assert.deepEqual(sumLedger([]), { inputTokens: 0, outputTokens: 0, costCents: 0, wallClockMs: 0, count: 0 });
});

test('remainingBudgetCents: null budget → null (unlimited)', () => {
  assert.equal(remainingBudgetCents(1000, 300), 700);
  assert.equal(remainingBudgetCents(1000, 1500), -500); // true overage, not clamped
  assert.equal(remainingBudgetCents(null, 999), null);
});

test('bufferedReservationCents: estimate × (1+buffer%), ceil', () => {
  assert.equal(bufferedReservationCents(100, 15), 115);
  assert.equal(bufferedReservationCents(101, 15), 117); // 116.15 → ceil 117
  assert.equal(bufferedReservationCents(100, 0), 100);
  assert.equal(bufferedReservationCents(0, 15), 0);
});

// ---- canStartCycle: the M6 gate ----

test('canStartCycle: no budget configured → always ok (cost gate)', () => {
  const r = canStartCycle({ estCostCents: 999999 }, { budgetCents: null, bufferPct: 15 }, { spentCents: 0 });
  assert.equal(r.ok, true);
});

test('canStartCycle: refuses when buffered estimate exceeds remaining', () => {
  const quota = { budgetCents: 1000, bufferPct: 15 };
  // remaining 700; estimate 650 × 1.15 = 748 > 700 → refuse
  const refused = canStartCycle({ estCostCents: 650 }, quota, { spentCents: 300 });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /exceeds/);
  // estimate 500 × 1.15 = 575 ≤ 700 → ok
  const ok = canStartCycle({ estCostCents: 500 }, quota, { spentCents: 300 });
  assert.equal(ok.ok, true);
});

test('canStartCycle: refuses when budget already exhausted', () => {
  const r = canStartCycle({ estCostCents: 1 }, { budgetCents: 1000, bufferPct: 15 }, { spentCents: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /exhausted/);
});

test('canStartCycle: concurrency cap checked first', () => {
  const r = canStartCycle({ estCostCents: 1 }, { budgetCents: null, maxConcurrentCycles: 2 }, { runningCycles: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /concurrency limit/);
  const ok = canStartCycle({ estCostCents: 1 }, { budgetCents: null, maxConcurrentCycles: 2 }, { runningCycles: 1 });
  assert.equal(ok.ok, true);
});

// ---- publicQuotaShape ----

test('publicQuotaShape: computes remaining from live spend', () => {
  const row = { id: 1, scope: 'project', project_id: 4, period: 'monthly', budget_cents: 5000, buffer_pct: 20, budget_wall_clock_min: null, max_concurrent_cycles: 3 };
  const shaped = publicQuotaShape(row, { spentCents: 1200 });
  assert.equal(shaped.spent_cents, 1200);
  assert.equal(shaped.remaining_cents, 3800);
  assert.equal(shaped.buffer_pct, 20);
  assert.equal(shaped.max_concurrent_cycles, 3);
});
