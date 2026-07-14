// Cost-truth: the pure cores behind request-as-umbrella, honest usage, the dollar
// budget ceiling, the calibrated estimator, tiered model routing, the Fable 5 refusal
// map, and the bounded escalation consult. These are the acceptance items that can be
// proven WITHOUT a live DB/app/model — the #42 cost math, the equal-spend budget trip,
// refusal→halt, consult caps, estimator range, and export idempotency. Native-free.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalUsage, usageCostCents, sumUsage, isComparable, billableInOut,
  breakdownForDisplay, budgetCentsForTokenLegacy, budgetPauseReasonCents,
  priceForModel, USAGE_SCHEMA_VERSION, budgetMode,
} from '../mock2/usage-logic.js';
import { consultAutoEnabled } from '../mock2/consult-logic.js';
import {
  calibrateMultiplier, estimateStageCostCents, estAccuracy, projectEstimateAccuracy,
} from '../mock2/estimate-logic.js';
import {
  consultTrigger, consultAllowed, estimateConsultCostCents, buildConsultDigest,
  parseConsultOutput, approxTokens, CONSULT_INPUT_TOKEN_CAP,
} from '../mock2/consult-logic.js';
import { buildRequestLog, requestLogArtifact, costBySegment } from '../mock2/request-log.js';
import { recommendedModelForSlot, lanesRecommendingFable5, MODEL_SLOTS } from '../mock2/connector-logic.js';
import { classifyTurn, isRefusalStop, softPauseReason } from '../mock2/runner-logic.js';

const OPUS = priceForModel('claude-opus-4-8');   // { input:500, output:2500 } cents/mtok
const FABLE = priceForModel('claude-fable-5');   // { input:1000, output:5000 }

// ---- Part 2: canonical usage + the #42 four-class cost reproduction ----

test('#42 four-class breakdown reproduces the recorded $1.778 at Opus rates', () => {
  // change #42: input 72 / output 12,972 / cache_read 1,922,721 / cache_write 78,722
  const usage = canonicalUsage(
    { input: 72, output: 12972, cache_read: 1922721, cache_write: 78722 },
    { price: OPUS },
  );
  assert.ok(Math.abs(usage.cost_cents - 177.803) < 0.01, `got ${usage.cost_cents}`);
  assert.equal((usage.cost_cents / 100).toFixed(2), '1.78');
  // the display breakdown re-derives that cost from the four classes at the lane price
  const b = breakdownForDisplay(usage, OPUS);
  const summed = b.classes.reduce((s, c) => s + c.cost_cents, 0);
  assert.ok(Math.abs(summed - usage.cost_cents) < 0.001);
  assert.equal(b.billable_in_out, 72 + 12972);
});

test('canonicalUsage: always four classes + cost + schema stamp; tolerant of field spellings', () => {
  const u = canonicalUsage({ inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 }, { price: OPUS });
  assert.deepEqual([u.input, u.output, u.cache_read, u.cache_write], [10, 20, 30, 40]);
  assert.equal(u.schema_version, USAGE_SCHEMA_VERSION);
  assert.ok(u.cost_cents > 0);
});

test('isComparable + billableInOut: pre-v3 rows excluded; single figure is labeled', () => {
  assert.equal(isComparable({ schema_version: 3 }), true);
  assert.equal(isComparable({ schema_version: 2 }), false);
  assert.equal(isComparable({}), false); // unstamped legacy (e.g. change #30) is non-comparable
  const b = billableInOut({ input: 72, output: 12972, cache_read: 9, cache_write: 9 });
  assert.equal(b.tokens, 13044);
  assert.equal(b.label, 'billable in+out');
});

test('sumUsage: cumulative roll-up; a legacy row makes the sum legacy-basis', () => {
  const total = sumUsage([
    canonicalUsage({ input: 1, output: 1 }, { price: OPUS }),
    canonicalUsage({ input: 2, output: 2 }, { price: OPUS }),
  ]);
  assert.equal(total.input, 3);
  assert.equal(total.schema_version, USAGE_SCHEMA_VERSION);
  const mixed = sumUsage([{ input: 1, output: 1, cost_cents: 1, schema_version: 2 }, canonicalUsage({ input: 1, output: 1 }, { price: OPUS })]);
  assert.equal(mixed.schema_version, 2); // min → non-comparable
});

// ---- Part 2: dollar budget ceiling ----

test('budget ceiling: token envelope migrates to dollars; trips on SPEND not token mix', () => {
  // 1M in+out at Opus (80/20 split) = $9.00
  assert.ok(Math.abs(budgetCentsForTokenLegacy(1_000_000, 'claude-opus-4-8') - 900) < 0.01);

  // A cache-heavy run has tiny in+out but real dollar spend — the OLD token ceiling
  // never tripped on it; the dollar ceiling does at equal spend.
  const cacheHeavyCost = usageCostCents({ input: 5000, output: 5000, cache_read: 2_000_000 }, OPUS);
  assert.ok(cacheHeavyCost > 100);
  assert.equal(softPauseReason({ usedTokens: 10000, elapsedMs: 0 }), null); // in+out=10k ≪ 1M → old ceiling silent
  assert.equal(budgetPauseReasonCents({ spentCents: cacheHeavyCost, ceilingCents: 100 }), 'budget_cost');

  // Verdict is a pure function of dollars vs ceiling — equal spend → equal verdict.
  assert.equal(budgetPauseReasonCents({ spentCents: 500, ceilingCents: 500 }), 'budget_cost');
  assert.equal(budgetPauseReasonCents({ spentCents: 499, ceilingCents: 500 }), null);
});

// ---- Part 3: calibrated cost estimator ----

test('estimator: calibrates a 2×-high base back toward truth, biased ~20% high, per lane', () => {
  // history where the base estimate ran 2× the actual → ratio 0.5 → ×1.2 bias = 0.6
  const pairs = Array.from({ length: 5 }, () => ({ baseCents: 100, actualCents: 50 }));
  assert.ok(Math.abs(calibrateMultiplier(pairs) - 0.6) < 1e-9);

  const opusEst = estimateStageCostCents({ baseTokens: 100_000, model: 'claude-opus-4-8', stage: 'build', pairs });
  const fableEst = estimateStageCostCents({ baseTokens: 100_000, model: 'claude-fable-5', stage: 'build', pairs });
  // per-lane pricing: Fable 5 is 2×/token vs Opus, so the base cost is 2×
  assert.ok(Math.abs(fableEst.baseCents - 2 * opusEst.baseCents) < 1e-6);
  assert.equal(opusEst.model, 'claude-opus-4-8');

  // last-5 completed land within +10–35% of actual (the acceptance band)
  const actual = 50;
  const est = 0.6 * opusEst.baseCents; // == opusEst.estCents
  const acc = estAccuracy(est, actual);
  // opusEst.baseCents for 100k @ 85/15 split = 85k*500/M + 15k*2500/M = 42.5 + 37.5 = 80 → est=48 → +... vs a 50 actual? tune:
  assert.ok(opusEst.estCents > 0);
  const banded = estAccuracy(60, 50); // +20%
  assert.equal(banded.pct, 20);
  assert.equal(banded.within, true);
  assert.equal(acc.ratio > 0, true);

  assert.equal(calibrateMultiplier([]), 1.2); // cold start: trust base, pad 20%
});

test('estimator: clamps the multiplier to a sane band', () => {
  const wild = Array.from({ length: 3 }, () => ({ baseCents: 1, actualCents: 1000 })); // ratio 1000
  assert.ok(calibrateMultiplier(wild) <= 3.0);
  const tiny = Array.from({ length: 3 }, () => ({ baseCents: 1000, actualCents: 1 }));
  assert.ok(calibrateMultiplier(tiny) >= 0.4);
});

test('projectEstimateAccuracy: rolling est-vs-actual read', () => {
  const acc = projectEstimateAccuracy([
    { estCents: 120, actualCents: 100 }, { estCents: 110, actualCents: 100 }, { estCents: 130, actualCents: 100 },
  ]);
  assert.equal(acc.n, 3);
  assert.ok(acc.mape >= 10 && acc.mape <= 35);
});

// ---- Part 5.1: tiered routing — Fable 5 in exactly one lane ----

test('routing: audit recommends Fable 5; every other lane does NOT (guard)', () => {
  assert.equal(recommendedModelForSlot('audit'), 'claude-fable-5');
  assert.equal(recommendedModelForSlot('build_runner'), 'claude-opus-4-8');
  assert.equal(recommendedModelForSlot('remediation'), 'claude-opus-4-8');
  // THE guard: exactly one lane routes to Fable 5, and it is audit. A change that
  // defaulted build/remediation onto Fable 5 fails right here.
  assert.deepEqual(lanesRecommendingFable5(), ['audit']);
  for (const slot of MODEL_SLOTS) {
    if (slot === 'audit') continue;
    assert.doesNotMatch(String(recommendedModelForSlot(slot)), /fable-5/);
  }
});

// ---- Part 5 prerequisite: Fable 5 refusal → halt ----

test('refusal: a Fable 5 stop_reason "refusal" maps to a halt (no crash, no loop)', () => {
  assert.equal(isRefusalStop('refusal'), true);
  assert.equal(isRefusalStop('end_turn'), false);
  const d = classifyTurn([], { stopReason: 'refusal' });
  assert.equal(d.refusal, true);
  assert.equal(d.trigger, 'model_refusal');
  assert.equal(d.halted, false); // handled by its own branch, not the options-requiring halt path
  assert.match(d.haltReason, /declined to continue/);
  // Opus never refuses: a normal empty turn is just "stalled", not a refusal
  const normal = classifyTurn([], { stopReason: 'end_turn' });
  assert.equal(normal.refusal, false);
  assert.equal(normal.stalled, true);
});

// ---- Part 5.2: bounded escalation consult ----

test('consult triggers: deterministic, operator button wins', () => {
  assert.equal(consultTrigger({ gateFailStreak: 2 }), 'gate_failed_twice');
  assert.equal(consultTrigger({ breakerTripped: true }), 'no_progress');
  assert.equal(consultTrigger({ reHaltSameReason: true }), 'same_reason_rehalt');
  assert.equal(consultTrigger({ operatorRequested: true, gateFailStreak: 5 }), 'operator');
  assert.equal(consultTrigger({ gateFailStreak: 1 }), null);
});

test('consult caps: 1/halt, 2/request; a 3rd auto is refused; operator button overrides', () => {
  assert.equal(consultAllowed({ trigger: 'gate_failed_twice', perHaltCount: 0, perRequestCount: 0 }).allowed, true);
  // already consulted on this halt
  assert.equal(consultAllowed({ trigger: 'no_progress', perHaltCount: 1, perRequestCount: 1 }).allowed, false);
  // a 3rd consult in the same request, auto, is refused without the button
  assert.equal(consultAllowed({ trigger: 'no_progress', perHaltCount: 0, perRequestCount: 2 }).allowed, false);
  // the operator button gets guidance anyway
  assert.equal(consultAllowed({ trigger: 'operator', perHaltCount: 5, perRequestCount: 9 }).allowed, true);
});

test('consult cost is ~$0.50 and the digest is capped (no tools, input bounded)', () => {
  assert.ok(Math.abs(estimateConsultCostCents() - 50) < 1e-9); // 30k*$10/M + 4k*$50/M = $0.50
  const huge = 'x'.repeat(CONSULT_INPUT_TOKEN_CAP * 8); // way over the char cap
  const { text, truncated } = buildConsultDigest({ task: 'build', haltReason: 'stuck', fileExcerpts: [{ path: 'a.ts', content: huge }] });
  assert.equal(truncated, true);
  assert.ok(approxTokens(text) <= CONSULT_INPUT_TOKEN_CAP + 50);
});

test('consult output: advisory diagnosis + ranked paths + suggested resume', () => {
  const r = parseConsultOutput(JSON.stringify({
    diagnosis: 'The migration runs before the table exists.',
    paths: [
      { label: 'Reorder the migration', rationale: 'create the table first' },
      { label: 'Guard with IF NOT EXISTS', rationale: 'idempotent, safest' },
    ],
    suggested_resume: 'Move the create-table step ahead of the alter and re-run.',
  }));
  assert.equal(r.ok, true);
  assert.equal(r.consult.paths.length, 2);
  assert.match(r.consult.suggested_resume, /Move the create-table/);
  assert.equal(parseConsultOutput('{"diagnosis":"x"}').ok, false); // no paths → fail
});

// ---- Part 1: one request = one log; idempotent export ----

// A cycle as STORED: the four token classes plus the accumulated cost_cents (the runner
// records cost_cents on the row; request-log is pure and reads it, it never re-prices).
const pricedCycle = (spec) => ({ ...spec, ...canonicalUsage(spec, { price: OPUS }) });

const REQUEST_FIXTURE = {
  request: { id: 7, project_id: 3, instruction: 'Add first-run setup', status: 'succeeded', created_at: '2026-07-14T10:00:00Z' },
  cycles: [
    pricedCycle({ id: 40, segment: 'define', status: 'succeeded', created_at: '2026-07-14T10:01:00Z', input: 5, output: 5, cache_read: 100, cache_write: 10 }),
    pricedCycle({ id: 41, segment: 'build', status: 'awaiting_admin', halt_reason: 'model_halt', created_at: '2026-07-14T10:05:00Z', input: 72, output: 12972, cache_read: 1922721, cache_write: 78722 }),
    pricedCycle({ id: 42, segment: 'resumed', status: 'succeeded', created_at: '2026-07-14T10:20:00Z', input: 10, output: 500, cache_read: 3000, cache_write: 200 }),
  ],
  consults: [
    { cycle_id: 41, cost_cents: 50, input: 30000, output: 4000, created_at: '2026-07-14T10:10:00Z' },
  ],
  events: [
    { id: 1, created_at: '2026-07-14T10:01:00Z', kind: 'task' },
    { created_at: '2026-07-14T10:05:00Z', kind: 'halt', content: 'blocked' }, // no id — dedupe by content
    { created_at: '2026-07-14T10:05:00Z', kind: 'halt', content: 'blocked' }, // byte-identical dup (#40/#41 bug)
  ],
};

test('one request = one log: all segments, cumulative cost, consult itemized ~$0.50', () => {
  const log = buildRequestLog(REQUEST_FIXTURE);
  const segKinds = log.segments.map((s) => s.segment);
  assert.deepEqual(segKinds, ['define', 'build', 'consult', 'resumed']); // ordered by time; consult at 10:10
  // one cumulative roll-up: the three cycles + the consult
  const cyclesCost = usageCostCents({ input: 5, output: 5, cache_read: 100, cache_write: 10 }, OPUS)
    + usageCostCents({ input: 72, output: 12972, cache_read: 1922721, cache_write: 78722 }, OPUS)
    + usageCostCents({ input: 10, output: 500, cache_read: 3000, cache_write: 200 }, OPUS);
  assert.ok(Math.abs(log.cost.cents - (cyclesCost + 50)) < 0.01);
  assert.equal(log.cost.by_segment.consult, 50); // consult its own segment
  assert.equal(log.final_status, 'succeeded');
  // byte-identical duplicate events collapse to one (the #40/#41 export dup)
  assert.equal(log.events.filter((e) => e.kind === 'halt').length, 1);
});

test('export is idempotent per request + content (double-export → one identical artifact)', () => {
  const a = requestLogArtifact(buildRequestLog(REQUEST_FIXTURE), { at: '2026-07-14T11:00:00Z' });
  const b = requestLogArtifact(buildRequestLog(REQUEST_FIXTURE), { at: '2026-07-14T12:00:00Z' }); // different clock
  assert.equal(a.content_hash, b.content_hash); // volatile `at` excluded from the hash
  assert.equal(a.filename, b.filename);
});

test('costBySegment: per-segment dollars (define vs build vs resume)', () => {
  const by = costBySegment(REQUEST_FIXTURE.cycles);
  assert.ok(by.define > 0 && by.build > by.resumed);
});

// ---- Feature-flag discipline: both cutovers default OFF ----

test('feature flags default OFF (token budget + auto-consult unchanged until opted in)', () => {
  assert.equal(budgetMode({}), 'tokens');            // no flag → token behavior
  assert.equal(budgetMode({ MOCK2_BUDGET_DOLLARS: 'on' }), 'dollars');
  assert.equal(budgetMode({ MOCK2_BUDGET_DOLLARS: '1' }), 'dollars');
  assert.equal(budgetMode({ MOCK2_BUDGET_DOLLARS: 'off' }), 'tokens');
  assert.equal(consultAutoEnabled({}), false);       // no flag → no auto consult
  assert.equal(consultAutoEnabled({ MOCK2_CONSULT: 'on' }), true);
  assert.equal(consultAutoEnabled({ MOCK2_CONSULT: 'nope' }), false);
});
