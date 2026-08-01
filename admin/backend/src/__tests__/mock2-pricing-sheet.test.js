// The refreshed model pricing sheet (verified against the vendors' pricing
// pages 2026-08-01) — dated transitions, per-model cache rates, the OpenAI
// long-context multiplier, and the known-good billed-day reproduction.
//
// Stub-first (risk R9): imports ONLY quota-logic.js / usage-logic.js /
// estimate-logic.js (native-free).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  costCentsForUsage,
  defaultModelPrice,
  CACHE_READ_MULT,
  CACHE_WRITE_MULT,
} from '../mock2/quota-logic.js';
import { breakdownForDisplay } from '../mock2/usage-logic.js';
import { estimateStageCostCents } from '../mock2/estimate-logic.js';

// ---- the known-good case: a real billed day on gpt-5.6-luna ----
//
// 77.29M input tokens (98.14% cache reads, 1.74% cache writes, 0.12% uncached,
// 23.2% of input over the long-context threshold), 319,801 output → $2.68.
// The estimator must land within a cent or two.

test('known-good billed day: gpt-5.6-luna 77.29M in / 319,801 out → $2.68 ± $0.02', () => {
  const price = defaultModelPrice('gpt-5.6-luna');
  const totalInput = 77_290_000;
  const cents = costCentsForUsage({
    inputTokens: totalInput * 0.0012,
    cacheReadTokens: totalInput * 0.9814,
    cacheWriteTokens: totalInput * 0.0174,
    outputTokens: 319_801,
    longContextInputShare: 0.232,
  }, price);
  assert.ok(Math.abs(cents - 268) <= 2, `expected ≈268¢ ($2.68), got ${cents.toFixed(2)}¢`);
});

// ---- OpenAI: the 2026-07-30 cuts ----

test('luna cut ~80% and terra ~20% on 2026-07-30; sol unchanged; caches at 0.1×', () => {
  const luna = defaultModelPrice('gpt-5.6-luna');
  assert.equal(luna.input_cents_per_mtok, 20);      // $0.20
  assert.equal(luna.cached_input_cents_per_mtok, 2); // $0.02
  assert.equal(luna.output_cents_per_mtok, 120);    // $1.20
  const terra = defaultModelPrice('gpt-5.6-terra');
  assert.equal(terra.input_cents_per_mtok, 200);
  assert.equal(terra.cached_input_cents_per_mtok, 20);
  assert.equal(terra.output_cents_per_mtok, 1200);
  const sol = defaultModelPrice('gpt-5.6-sol');
  assert.equal(sol.input_cents_per_mtok, 500);
  assert.equal(sol.cached_input_cents_per_mtok, 50);
  assert.equal(sol.output_cents_per_mtok, 3000);
  // Cache writes bill at ×1.25 of uncached input — same shape as Anthropic.
  assert.equal(luna.cache_write_mult ?? CACHE_WRITE_MULT, 1.25);
});

test('gpt-5.5-pro is legacy: no cached-input rate — reads bill at FULL input price', () => {
  const pro = defaultModelPrice('gpt-5.5-pro');
  assert.equal(pro.legacy, true);
  assert.equal(pro.input_cents_per_mtok, 3000);   // $30
  assert.equal(pro.output_cents_per_mtok, 18000); // $180
  assert.equal(pro.cached_input_cents_per_mtok, 3000); // full price — no cached rate
  // 1M cache reads cost the same as 1M fresh input on the pro tier.
  const reads = costCentsForUsage({ cacheReadTokens: 1_000_000 }, pro);
  const fresh = costCentsForUsage({ inputTokens: 1_000_000 }, pro);
  assert.equal(reads, fresh);
});

// ---- long-context multiplier (per-model field, not a vendor constant) ----

test('OpenAI rows carry threshold ~270K and 2×; Anthropic rows stay at 1.0', () => {
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5-pro']) {
    const p = defaultModelPrice(id);
    assert.equal(p.long_context_threshold, 270_000, id);
    assert.equal(p.long_context_multiplier, 2, id);
  }
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5']) {
    const p = defaultModelPrice(id);
    assert.equal(p.long_context_multiplier, 1, id);
  }
});

test('the surcharge doubles ONLY the over-threshold share; 1.0-multiplier rows unaffected', () => {
  const luna = defaultModelPrice('gpt-5.6-luna');
  const base = costCentsForUsage({ inputTokens: 1_000_000 }, luna);
  const all = costCentsForUsage({ inputTokens: 1_000_000, longContextInputShare: 1 }, luna);
  const half = costCentsForUsage({ inputTokens: 1_000_000, longContextInputShare: 0.5 }, luna);
  assert.ok(Math.abs(all - base * 2) < 1e-9);
  assert.ok(Math.abs(half - base * 1.5) < 1e-9);
  // Output over the threshold bills at 2× too (1M output tokens = 1 mtok).
  const out = costCentsForUsage({ outputTokens: 1_000_000, longContextOutputShare: 1 }, luna);
  assert.ok(Math.abs(out - luna.output_cents_per_mtok * 2) < 1e-9);
  // Anthropic (multiplier 1.0): the share fields are inert.
  const opus = defaultModelPrice('claude-opus-5');
  assert.equal(
    costCentsForUsage({ inputTokens: 1_000_000, longContextInputShare: 1 }, opus),
    costCentsForUsage({ inputTokens: 1_000_000 }, opus),
  );
});

// ---- Anthropic: unchanged rates, cache multipliers, the Sonnet 5 dated promo ----

test('Anthropic rates match the 2026-08-01 sheet (input / cache hit / output)', () => {
  const rows = {
    'claude-fable-5': [1000, 100, 5000],
    'claude-opus-5': [500, 50, 2500],
    'claude-haiku-4-5': [100, 10, 500],
  };
  for (const [id, [input, cached, output]] of Object.entries(rows)) {
    const p = defaultModelPrice(id);
    assert.equal(p.input_cents_per_mtok, input, id);
    assert.equal(p.cached_input_cents_per_mtok, cached, id);
    assert.equal(p.output_cents_per_mtok, output, id);
    // 5m cache write ×1.25, 1h ×2, hit ×0.1 of base input.
    assert.equal(p.cache_write_mult, CACHE_WRITE_MULT);
    assert.equal(p.cache_write_1h_mult, 2);
    assert.equal(p.cached_input_cents_per_mtok, p.input_cents_per_mtok * CACHE_READ_MULT, id);
  }
});

test('Sonnet 5 promo is a DATED transition: $2/$10 through 2026-08-31, $3/$15 from 2026-09-01', () => {
  const promo = defaultModelPrice('claude-sonnet-5', { date: '2026-08-01' });
  assert.equal(promo.input_cents_per_mtok, 200);
  assert.equal(promo.output_cents_per_mtok, 1000);
  const lastDay = defaultModelPrice('claude-sonnet-5', { date: '2026-08-31' });
  assert.equal(lastDay.input_cents_per_mtok, 200);
  const post = defaultModelPrice('claude-sonnet-5', { date: '2026-09-01' });
  assert.equal(post.input_cents_per_mtok, 300);
  assert.equal(post.output_cents_per_mtok, 1500);
  assert.equal(post.cached_input_cents_per_mtok, 30);
  // A full ISO timestamp resolves the same as a bare date.
  assert.equal(defaultModelPrice('claude-sonnet-5', { date: '2026-09-15T08:00:00Z' }).input_cents_per_mtok, 300);
});

// ---- sheet hygiene: provenance on every row, surfaced with estimates ----

test('every sheet row carries effective_date + source_url; batch discount is 50%', () => {
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5-pro']) {
    const p = defaultModelPrice(id);
    assert.match(String(p.effective_date), /^\d{4}-\d{2}-\d{2}$/, id);
    assert.match(String(p.source_url), /^https:\/\//, id);
    assert.equal(p.batch_discount, 0.5, id);
  }
});

test('estimates and cost breakdowns surface "prices last verified on <date>"', () => {
  const est = estimateStageCostCents({ baseTokens: 100_000, model: 'gpt-5.6-luna', stage: 'build' });
  assert.match(String(est.prices_verified_on), /^\d{4}-\d{2}-\d{2}$/);
  const bd = breakdownForDisplay(
    { input: 1000, output: 100, cache_read: 0, cache_write: 0, cost_cents: 1, schema_version: 3 },
    defaultModelPrice('gpt-5.6-luna'),
  );
  assert.match(String(bd.prices_verified_on), /^\d{4}-\d{2}-\d{2}$/);
});

// ---- back-compat: hand-entered DB rows (base rates only) keep pricing as before ----

test('a bare {input,output} price row still bills caches at the 0.1×/1.25× defaults', () => {
  const bare = { input_cents_per_mtok: 500, output_cents_per_mtok: 2500 };
  const c = costCentsForUsage({ cacheReadTokens: 100_000, cacheWriteTokens: 100_000 }, bare);
  assert.ok(Math.abs(c - (500 * 0.1 * 0.1 + 500 * 1.25 * 0.1)) < 1e-9); // 5 + 62.5 cents
  assert.equal(CACHE_READ_MULT, 0.1);
  assert.equal(CACHE_WRITE_MULT, 1.25);
});
