// Mock2 canonical usage PURE decision layer (cost-truth work; see
// docs/agent-sdk-migration.md § "Cost-truth"). Native-free, unit-tested.
//
// The problem this fixes: `used_tokens` counted only input+output, but cache traffic
// is the bulk of the bill (a $1.78 cycle moved 2.01M tokens, 82% of them cache), and
// the token basis drifted between framework versions so history mixed incomparable
// numbers. The fix: ONE canonical usage record with all four token classes always
// present, dollars as the primary metric, and a schema version so pre-v3 rows are
// flagged non-comparable.
//
// Cost computation itself is NOT changed here — usageCostCents delegates to the
// penny-accurate costCentsForUsage in quota-logic.js. This module only standardizes
// the SHAPE, the DISPLAY, and the DOLLAR budget conversion.
//
// Terminology (risk R7): nothing here is named "agent".

import { costCentsForUsage, defaultModelPrice } from './quota-logic.js';

// Bump when the usage basis changes. v3 is "all four token classes, cache included".
// A row stamped < 3 (or unstamped, i.e. pre-cost-truth) counted input+output only and
// so is NOT comparable to a v3 row — it's excluded from history mixing + estimator
// training (isComparable). Change #30 (1,031,216 tokens on the old mixed basis) is a
// legacy-basis row under this rule.
export const USAGE_SCHEMA_VERSION = 3;

// The four token classes, in display order. "billable in+out" (input+output) is the
// only pair the OLD single number showed; cache_read is cheap (0.1×) but voluminous,
// cache_write is 1.25×.
export const TOKEN_CLASSES = Object.freeze(['input', 'output', 'cache_read', 'cache_write']);

// canonicalUsage — coerce any usage-ish object into the ONE canonical shape:
// { input, output, cache_read, cache_write, cost_cents, schema_version }. Tolerant of
// the several field spellings in play (the model client returns cacheReadInputTokens;
// the ledger stores input_tokens; the SDK returns cache_read_input_tokens). cost_cents,
// when not supplied, is computed via the untouched cost function against `price`.
export function canonicalUsage(raw = {}, { price = null, schemaVersion = USAGE_SCHEMA_VERSION } = {}) {
  // A publicCycleShape row nests the canonical record under `usage` (its top
  // level only carries the legacy used_tokens figure) — unwrap it, or a
  // request-log roll-up over SHAPED cycles reads zeros while the ledger and
  // the per-turn events show the real spend (the "$0.00 in the exported log"
  // bug). Only unwrap when the top level has no token fields of its own.
  if (
    raw && typeof raw === 'object' && raw.usage && typeof raw.usage === 'object'
    && raw.input == null && raw.inputTokens == null && raw.input_tokens == null
  ) {
    return canonicalUsage(raw.usage, { price, schemaVersion: raw.usage.schema_version ?? schemaVersion });
  }
  const n = (...keys) => {
    for (const k of keys) {
      const v = raw?.[k];
      if (v != null && v !== '') return Number(v) || 0;
    }
    return 0;
  };
  const input = n('input', 'inputTokens', 'input_tokens');
  const output = n('output', 'outputTokens', 'output_tokens');
  const cache_read = n('cache_read', 'cacheReadTokens', 'cacheReadInputTokens', 'cache_read_tokens', 'cache_read_input_tokens');
  const cache_write = n('cache_write', 'cacheWriteTokens', 'cacheCreationInputTokens', 'cache_write_tokens', 'cache_creation_input_tokens');
  // Cost preference: an explicit cost_cents, else the cycle row's accumulated
  // used_cost_cents (the ledger-accurate figure), else compute from tokens.
  let cost_cents = raw?.cost_cents != null ? Number(raw.cost_cents) || 0
    : raw?.used_cost_cents != null ? Number(raw.used_cost_cents) || 0
      : null;
  if (cost_cents == null) {
    cost_cents = usageCostCents({ input, output, cache_read, cache_write }, price);
  }
  return { input, output, cache_read, cache_write, cost_cents, schema_version: schemaVersion };
}

// usageCostCents — dollars-in-cents for a canonical usage record at a given price.
// DELEGATES to the penny-accurate quota-logic cost function (constraint: don't alter
// cost computation) after mapping the canonical class names onto its argument names.
export function usageCostCents({ input = 0, output = 0, cache_read = 0, cache_write = 0 } = {}, price = null) {
  return costCentsForUsage(
    { inputTokens: input, outputTokens: output, cacheReadTokens: cache_read, cacheWriteTokens: cache_write },
    price,
  );
}

// A price row for a model id from the built-in list (fallback when no explicit price
// row exists). Pure passthrough so callers here don't reach the DB. Used so a display
// or estimate can price the LANE'S OWN model (audit on Fable 5 costs 2×/token).
export function priceForModel(model) {
  return defaultModelPrice(model);
}

// sumUsage — fold many canonical (or canonicalizable) usage records into one total.
// Everything stays in the canonical shape; cost_cents accumulates as fractional cents
// (rounded only for display, like the ledger). schema_version of the sum is the MINIMUM
// present (a sum that includes a legacy row is itself legacy-basis).
export function sumUsage(records = []) {
  const acc = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_cents: 0, schema_version: USAGE_SCHEMA_VERSION };
  let sawAny = false;
  for (const r of records) {
    if (!r) continue;
    const u = r.input != null || r.output != null || r.cache_read != null ? r : canonicalUsage(r);
    acc.input += Number(u.input || 0);
    acc.output += Number(u.output || 0);
    acc.cache_read += Number(u.cache_read || 0);
    acc.cache_write += Number(u.cache_write || 0);
    acc.cost_cents += Number(u.cost_cents || 0);
    if (u.schema_version != null) acc.schema_version = Math.min(acc.schema_version, Number(u.schema_version));
    sawAny = true;
  }
  if (!sawAny) acc.schema_version = USAGE_SCHEMA_VERSION;
  return acc;
}

// Is this usage record comparable to the current basis? A row must be stamped at the
// current schema version (all four classes) to mix into history or train the estimator.
export function isComparable(record) {
  return Number(record?.schema_version || 0) >= USAGE_SCHEMA_VERSION;
}

// The ONLY single-token figure the UI may show, and its mandatory label. Everything
// else must be dollars-first with the expandable four-class breakdown.
export function billableInOut(record) {
  const u = record?.input != null ? record : canonicalUsage(record || {});
  return { tokens: Number(u.input || 0) + Number(u.output || 0), label: 'billable in+out' };
}

// breakdownForDisplay — the primary dollar figure + the expandable four-class rows the
// UI renders (each class's tokens and its own dollar contribution at `price`). This is
// what makes the recorded cost reproducible from the four classes (acceptance: #42).
export function breakdownForDisplay(record, price = null) {
  const u = record?.input != null && record?.cost_cents != null ? record : canonicalUsage(record || {}, { price });
  const p = price || null;
  const classCost = (cls) => usageCostCents({ [cls]: u[cls] }, p);
  return {
    dollars: (Number(u.cost_cents || 0) / 100),
    cost_cents: Number(u.cost_cents || 0),
    comparable: isComparable(u),
    schema_version: u.schema_version,
    classes: TOKEN_CLASSES.map((cls) => ({
      key: cls,
      tokens: Number(u[cls] || 0),
      cost_cents: p ? classCost(cls) : null,
    })),
    billable_in_out: Number(u.input || 0) + Number(u.output || 0),
  };
}

// ---- Dollar budget ceiling (was a token ceiling) ----
//
// The soft-pause ceiling used to be SOFT_PAUSE_TOKENS = 1,000,000 counting input+output
// only — so a cache-heavy run (which spends the same dollars) never tripped, and an
// output-heavy run tripped at a different spend than an input-heavy one. The ceiling is
// now DOLLARS. To migrate without a behavior jump, convert the old 1M-token envelope to
// its dollar equivalent AT THE LANE'S MODEL RATE (so the same "about this much work"
// still pauses), then thereafter the ceiling is a flat cents figure.

// Convert the legacy input+output token envelope to cents at a model's list price,
// splitting the envelope the same 80/20 the old estimate implied (input-heavy build
// turns). Returns cents. When the model is unpriced, falls back to DEFAULT_PAUSE_CENTS.
export function budgetCentsForTokenLegacy(tokenEnvelope, model, { inputShare = 0.8 } = {}) {
  const price = defaultModelPrice(model);
  if (!price) return DEFAULT_PAUSE_CENTS;
  const inTok = Number(tokenEnvelope) * inputShare;
  const outTok = Number(tokenEnvelope) * (1 - inputShare);
  return usageCostCents({ input: inTok, output: outTok }, price);
}

// A flat fallback ceiling (cents) for an unpriced lane: ~$6, roughly the old 1M-token
// envelope at Opus 4.8 list rate under an 80/20 in/out split (see the test).
export const DEFAULT_PAUSE_CENTS = 600;

// budgetPauseReasonCents — the dollar analogue of softPauseReason's token check. Given
// the cents spent THIS RUN and the cents ceiling, returns 'budget_cost' when the run has
// reached/crossed the ceiling, else null. Cache-heavy and output-heavy runs trip at
// EQUAL spend because the input is dollars, not a token subset.
export function budgetPauseReasonCents({ spentCents = 0, ceilingCents = DEFAULT_PAUSE_CENTS } = {}) {
  if (!(Number(ceilingCents) > 0)) return null;
  return Number(spentCents || 0) >= Number(ceilingCents) ? 'budget_cost' : null;
}

// A dollars string for a cents figure (display + pause messages). Two decimals.
export function dollars(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

// ---- Feature flag: dollar-budget cutover (default OFF) ----
//
// The soft-pause ceiling stays TOKEN-based until an operator flips this on the live
// install, so behavior is byte-identical by default. Set MOCK2_BUDGET_DOLLARS=on (or 1)
// to switch the runner's soft-pause ceiling to DOLLARS (budgetPauseReasonCents against
// the migrated dollar equivalent of the token envelope). Pure so both runners read it
// one way and it's unit-testable.
export const BUDGET_DOLLARS_FLAG = 'MOCK2_BUDGET_DOLLARS';

export function budgetMode(env = {}) {
  const v = String(env?.[BUDGET_DOLLARS_FLAG] ?? '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true' ? 'dollars' : 'tokens';
}

// ---- Cache health (silent-invalidator detector) ----
//
// A lane that resends a large stable prefix every call (build runner,
// concept chat) should show cache_read > 0 from the second call on. When
// it doesn't, one of two silent failure modes is burning full-price input
// and NOTHING in the totals says so:
//   'cache_never_engaged' — no reads AND no writes despite big inputs
//     (breakpoint not being sent, or prefix below the model's cacheable
//     minimum on every call);
//   'cache_never_read'    — writes every call but never a read (a byte
//     changes at the front of the prefix each call: a timestamp,
//     unstable ordering, per-request id — each write is orphaned).
// Pure: feed it the last few canonical usage records for ONE lane, in
// call order. Small prefixes are ignored (nothing worth caching).
export const CACHE_HEALTH_MIN_CALLS = 3;
export const CACHE_HEALTH_MIN_INPUT_TOKENS = 20_000;

export function cacheHealth(records = [], {
  minCalls = CACHE_HEALTH_MIN_CALLS,
  minInputTokens = CACHE_HEALTH_MIN_INPUT_TOKENS,
} = {}) {
  const rows = (Array.isArray(records) ? records : [])
    .filter(Boolean)
    .map((r) => (r.input != null ? r : canonicalUsage(r)));
  // Only calls that actually paid for a big uncached prefix are evidence.
  const big = rows.filter((r) => Number(r.input || 0) >= minInputTokens);
  if (big.length < minCalls) return { healthy: true, reason: null, suspectCalls: big.length };
  const anyRead = big.some((r) => Number(r.cache_read || 0) > 0);
  if (anyRead) return { healthy: true, reason: null, suspectCalls: 0 };
  const anyWrite = big.some((r) => Number(r.cache_write || 0) > 0);
  return {
    healthy: false,
    reason: anyWrite ? 'cache_never_read' : 'cache_never_engaged',
    suspectCalls: big.length,
  };
}
