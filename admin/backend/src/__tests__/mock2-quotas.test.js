// Mock2 Phase M5 tests — the quota pure decision layer (ADR-003 / risk R5).
//
// Stub-first (risk R9): imports ONLY quota-logic.js (native-free). canStartCycle
// is the gate M6 enforces; the ledger arithmetic must be trustworthy, so it's
// unit-tested here now.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  costCentsForUsage,
  defaultModelPrice,
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

// A partial-shape matcher: the sheet rows now carry cache/long-context/provenance
// fields too (asserted in mock2-pricing-sheet.test.js); here we pin the base rates.
const baseRate = (model, opts) => {
  const p = defaultModelPrice(model, opts);
  return p && { input_cents_per_mtok: p.input_cents_per_mtok, output_cents_per_mtok: p.output_cents_per_mtok };
};

test('defaultModelPrice: known Claude models resolve to their documented rate', () => {
  assert.deepEqual(baseRate('claude-opus-4-8'), { input_cents_per_mtok: 500, output_cents_per_mtok: 2500 });
  assert.deepEqual(baseRate('claude-sonnet-4-6'), { input_cents_per_mtok: 300, output_cents_per_mtok: 1500 });
  assert.deepEqual(baseRate('claude-haiku-4-6'), { input_cents_per_mtok: 100, output_cents_per_mtok: 500 });
  // Older / pricier Opus tiers and a date-suffixed id still resolve.
  assert.deepEqual(baseRate('claude-opus-4-1'), { input_cents_per_mtok: 1500, output_cents_per_mtok: 7500 });
  assert.deepEqual(baseRate('claude-opus-4-8-20260101'), { input_cents_per_mtok: 500, output_cents_per_mtok: 2500 });
});

test('defaultModelPrice: OpenAI frontier + utility models resolve to their documented rate', () => {
  // Verified against the vendor sheet 2026-08-01 — luna cut ~80% and terra ~20%
  // on 2026-07-30; sol was not cut.
  assert.deepEqual(baseRate('gpt-5.6-sol'), { input_cents_per_mtok: 500, output_cents_per_mtok: 3000 });
  assert.deepEqual(baseRate('gpt-5.6-terra'), { input_cents_per_mtok: 200, output_cents_per_mtok: 1200 });
  assert.deepEqual(baseRate('gpt-5.6-luna'), { input_cents_per_mtok: 20, output_cents_per_mtok: 120 });
  assert.deepEqual(baseRate('gpt-5.3-codex'), { input_cents_per_mtok: 175, output_cents_per_mtok: 1400 });
  assert.deepEqual(baseRate('gpt-5.4-mini'), { input_cents_per_mtok: 75, output_cents_per_mtok: 450 });
  assert.deepEqual(baseRate('gpt-5.4-nano'), { input_cents_per_mtok: 20, output_cents_per_mtok: 125 });
  // A dashed alias and a date suffix still resolve (dots folded to dashes).
  assert.deepEqual(baseRate('gpt-5-6-terra'), { input_cents_per_mtok: 200, output_cents_per_mtok: 1200 });
  assert.deepEqual(baseRate('gpt-5.6-sol-20260701'), { input_cents_per_mtok: 500, output_cents_per_mtok: 3000 });
});

test('defaultModelPrice: unknown / self-hosted models have no default (cost stays 0)', () => {
  assert.equal(defaultModelPrice('llama-3-70b'), null);
  assert.equal(defaultModelPrice(''), null);
  assert.equal(defaultModelPrice(null), null);
});

test('costCentsForUsage with the default price gives a real cost (not $0)', () => {
  const p = defaultModelPrice('claude-opus-4-8');
  // 20k input + 5k output on Opus = 20000/1e6*500 + 5000/1e6*2500 = 10 + 12.5 = 22.5¢
  assert.ok(Math.abs(costCentsForUsage({ inputTokens: 20_000, outputTokens: 5_000 }, p) - 22.5) < 1e-9);
});

test('costCentsForUsage prices cache reads at 0.1x and cache writes at 1.25x input', () => {
  const p = { input_cents_per_mtok: 500, output_cents_per_mtok: 2500 }; // Opus
  // 100k cache read = 100000/1e6*500*0.1 = 5¢; 100k cache write = *1.25 = 62.5¢.
  const c = costCentsForUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 100_000 }, p);
  assert.ok(Math.abs(c - (5 + 62.5)) < 1e-9);
  // Ignoring cache tokens (the old behavior) would have reported $0 here.
  assert.equal(costCentsForUsage({ inputTokens: 0, outputTokens: 0 }, p), 0);
});

test('costCentsForUsage: sub-cent per-call costs are NOT floored to 0 (they accumulate)', () => {
  // A single build turn is a fraction of a cent — it must survive as a fraction so
  // 40 of them add up to a real cost instead of rounding to 0 each time.
  const price = { input_cents_per_mtok: 300, output_cents_per_mtok: 1500 };
  const perTurn = costCentsForUsage({ inputTokens: 800, outputTokens: 200 }, price); // 0.24 + 0.30 = 0.54¢
  assert.ok(perTurn > 0 && perTurn < 1, `expected a sub-cent fraction, got ${perTurn}`);
  assert.ok(Math.abs(perTurn - 0.54) < 1e-9);
  // 40 such turns ≈ 21.6¢ — a real cost, not $0.
  assert.ok(Math.abs(perTurn * 40 - 21.6) < 1e-6);
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
