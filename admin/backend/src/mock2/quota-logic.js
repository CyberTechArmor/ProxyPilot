// Mock2 quota PURE decision layer (Phase M5, ADR-003 / risk R5). Native-free,
// unit-tested stub-first (risk R9). The M6 cycle runner enforces canStartCycle
// before taking the lock; M5 builds and tests it now so it's proven before
// anything depends on it.
//
// R5: cost estimation for an agentic loop has no reliable oracle. Treat the
// reservation as an ENVELOPE — a buffered estimate refused against the remaining
// budget — and rely on the mid-cycle buffer stop (M6/M9) as the real guard.
// Everything here is deterministic arithmetic so the ledger can be trusted.
//
// Terminology (risk R7): nothing here is named "agent".

// Prompt-caching price multipliers on the base INPUT rate: a cache read is
// billed at 0.1×, a cache write (creation) at 1.25× — the same shape on both
// Anthropic and OpenAI. These are the FALLBACK multipliers for price rows that
// carry no per-model override (hand-entered DB rows, older callers); the
// built-in sheet below can override per model (gpt-5.5-pro has NO cached-input
// rate — its reads bill at full input price). Providers that don't cache pass
// 0 for these token counts, so the math is a no-op there.
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;

// Cents for a token spend against an effective-dated price row. Prices are cents
// per million tokens (mtok). Self-hosted / unpriced models price at 0. Cache-aware:
// fresh input at 1×, cache reads at the row's cached-input rate (else 0.1× input),
// cache writes at the row's write multiplier (else 1.25×). Anthropic returns cache
// traffic as SEPARATE token counts — input_tokens excludes them — so ignoring them,
// as the old cost calc did, under-reports the real bill once caching is on.
//
// Long-context surcharge: OpenAI bills input AND output at 2× above ~270K tokens
// of context (real telemetry: 23% of a build day's input crossed the breakpoint
// and accounted for 29% of the bill — an estimator without this term understates
// OpenAI cost by roughly a sixth). The usage record may carry the share of each
// side that billed over the threshold (longContextInputShare /
// longContextOutputShare, 0..1); rows with long_context_multiplier 1 (Anthropic,
// which publishes no such multiplier) are unaffected, as are callers that don't
// pass the shares.
//
// Returns FRACTIONAL cents on purpose: a single build turn is often a fraction of
// a cent, so rounding here (and again on every accumulation) used to floor each
// call to 0 and lose the whole cost — the accumulated total is rounded only for
// display.
export function costCentsForUsage(
  {
    inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0,
    longContextInputShare = 0, longContextOutputShare = 0,
  }, price,
) {
  if (!price) return 0;
  const inRate = Number(price.input_cents_per_mtok || 0);
  const outRate = Number(price.output_cents_per_mtok || 0);
  const readRate = price.cached_input_cents_per_mtok != null
    ? Number(price.cached_input_cents_per_mtok)
    : inRate * CACHE_READ_MULT;
  const writeMult = price.cache_write_mult != null ? Number(price.cache_write_mult) : CACHE_WRITE_MULT;
  const inC = (Number(inputTokens) / 1_000_000) * inRate;
  const outC = (Number(outputTokens) / 1_000_000) * outRate;
  const readC = (Number(cacheReadTokens) / 1_000_000) * readRate;
  const writeC = (Number(cacheWriteTokens) / 1_000_000) * inRate * writeMult;
  let total = inC + outC + readC + writeC;
  const lcMult = Number(price.long_context_multiplier || 1);
  if (lcMult > 1) {
    const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    total += (lcMult - 1) * (
      clamp01(longContextInputShare) * (inC + readC + writeC)
      + clamp01(longContextOutputShare) * outC
    );
  }
  return total;
}

// Built-in list prices for the common cloud models, in cents per mtok, from the
// providers' published rates — ALL rows verified against the vendors' own pricing
// pages on 2026-08-01 (each row carries its effective date + source URL; surface
// "prices last verified on <date>" wherever an estimate is shown — two OpenAI
// cuts landed inside one month, so anything presented as authoritative must show
// its age). This is the FALLBACK used when an admin hasn't entered an explicit
// price row for a connector+model — without it every cost shows $0 until someone
// hand-enters prices. An explicit price row always wins (effectivePrice checks
// the DB first). Matched in order, most specific first, on a lower-cased model
// id, so a date suffix (…-20260101) or an alias still resolves.
//
// Row fields beyond match/input/output:
//   cached      — cached-input (cache-hit) rate, cents/mtok. Absent → 0.1× input.
//   writeMult   — cache-write multiplier on input (5m TTL). Absent → 1.25.
//   write1hMult — Anthropic's 1h-TTL cache-write multiplier (data only; the
//                 platform sends 5m breakpoints, so billing uses writeMult).
//   lcThreshold/lcMult — long-context breakpoint (tokens) and multiplier.
//                 Anthropic publishes no equivalent — per-model 1.0 there (a
//                 field, not a vendor constant, so it can be corrected later).
//   from/to     — effective window (ISO date; from inclusive, to exclusive) for
//                 dated transitions. The Sonnet 5 promotional rate expires
//                 2026-08-31: estimates dated on/after 2026-09-01 get the
//                 post-promo row.
//   date/src    — effective_date (when the row's figures took effect / were
//                 verified) and source_url.
//   batch       — Batch API discount on input+output (0.5 = 50% off; Anthropic:
//                 not combinable with Fast mode). Metadata — the platform does
//                 not batch.
//   legacy      — off the active sheet (gpt-5.5-pro: kept only so old ledger
//                 rows still price; NO cached-input rate — reads bill at full
//                 input price — and uncached pro-tier context).
const ANTHROPIC_SRC = 'https://docs.anthropic.com/en/docs/about-claude/pricing';
const OPENAI_SRC = 'https://platform.openai.com/docs/pricing';
const OPENAI_LC = { lcThreshold: 270_000, lcMult: 2 };

export const DEFAULT_MODEL_PRICES = Object.freeze([
  // Anthropic (verified 2026-08-01, unchanged). Opus 5 and Opus 4.5–4.8 share a rate; 4/4.1 are pricier.
  { match: /opus-5\b/, input: 500, output: 2500, cached: 50, write1hMult: 2, date: '2026-08-01', src: ANTHROPIC_SRC, batch: 0.5 },
  { match: /opus-4-(5|6|7|8)\b/, input: 500, output: 2500, cached: 50, write1hMult: 2, date: '2026-08-01', src: ANTHROPIC_SRC, batch: 0.5 },
  { match: /opus-4(-1)?\b/, input: 1500, output: 7500, cached: 150, write1hMult: 2, date: '2026-08-01', src: ANTHROPIC_SRC, batch: 0.5 },
  // Sonnet 5 promotional rate — a DATED transition, not a hardcoded number: the
  // promo row expires 2026-08-31; any estimate dated on/after 2026-09-01
  // resolves to the post-promo row.
  { match: /sonnet-5\b/, to: '2026-09-01', input: 200, output: 1000, cached: 20, write1hMult: 2, date: '2026-08-01', src: ANTHROPIC_SRC, batch: 0.5 },
  { match: /sonnet-5\b/, from: '2026-09-01', input: 300, output: 1500, cached: 30, write1hMult: 2, date: '2026-09-01', src: ANTHROPIC_SRC, batch: 0.5 },
  { match: /sonnet-(4-6|4-5|4)\b/, input: 300, output: 1500, cached: 30, write1hMult: 2, date: '2026-08-01', src: ANTHROPIC_SRC, batch: 0.5 },
  { match: /haiku-(4-5|4-6|4)\b/, input: 100, output: 500, cached: 10, write1hMult: 2, date: '2026-08-01', src: ANTHROPIC_SRC, batch: 0.5 },
  { match: /haiku-3-5\b/, input: 80, output: 400, cached: 8, write1hMult: 2, date: '2026-08-01', src: ANTHROPIC_SRC, batch: 0.5 },
  { match: /(fable|mythos)-5\b/, input: 1000, output: 5000, cached: 100, write1hMult: 2, date: '2026-08-01', src: ANTHROPIC_SRC, batch: 0.5 },
  // OpenAI (verified 2026-08-01). On 2026-07-30 OpenAI cut gpt-5.6-luna ~80% and
  // gpt-5.6-terra ~20%; sol was not cut. Dots in the id are matched with `[.-]`
  // so "gpt-5.6-sol" and a "gpt-5-6-sol" alias both resolve; the tier suffix
  // keeps each match unique, so ordering among them doesn't matter.
  // gpt-5.4-mini/nano sit BELOW Anthropic's Haiku floor (the cheap-utility tier
  // with no Claude equivalent).
  { match: /gpt-5[.-]6-sol\b/, input: 500, output: 3000, cached: 50, ...OPENAI_LC, date: '2026-07-30', src: OPENAI_SRC, batch: 0.5 },
  { match: /gpt-5[.-]6-terra\b/, input: 200, output: 1200, cached: 20, ...OPENAI_LC, date: '2026-07-30', src: OPENAI_SRC, batch: 0.5 },
  { match: /gpt-5[.-]6-luna\b/, input: 20, output: 120, cached: 2, ...OPENAI_LC, date: '2026-07-30', src: OPENAI_SRC, batch: 0.5 },
  // Legacy pro tier: off the active sheet, no cached-input rate (cached: full
  // input price), kept only so historical ledger rows still price.
  { match: /gpt-5[.-]5-pro\b/, input: 3000, output: 18000, cached: 3000, ...OPENAI_LC, date: '2026-07-30', src: OPENAI_SRC, batch: 0.5, legacy: true },
  { match: /gpt-5[.-]3-codex\b/, input: 175, output: 1400, ...OPENAI_LC, date: '2026-07-30', src: OPENAI_SRC, batch: 0.5 },
  { match: /gpt-5[.-]4-mini\b/, input: 75, output: 450, ...OPENAI_LC, date: '2026-07-30', src: OPENAI_SRC, batch: 0.5 },
  { match: /gpt-5[.-]4-nano\b/, input: 20, output: 125, ...OPENAI_LC, date: '2026-07-30', src: OPENAI_SRC, batch: 0.5 },
]);

// The fallback price row for a model id at a given date (default: now), or null
// if we don't know it (then cost stays 0 until an admin enters an explicit
// price). Dated rows (from/to windows) make promo transitions automatic: the
// sheet returns the post-promo rate for any estimate dated on/after the switch
// day. Pure + unit-tested.
export function defaultModelPrice(model, { date = null } = {}) {
  const id = String(model || '').toLowerCase();
  if (!id) return null;
  const at = String(date || new Date().toISOString()).slice(0, 10);
  for (const p of DEFAULT_MODEL_PRICES) {
    if (!p.match.test(id)) continue;
    if (p.from && at < p.from) continue;
    if (p.to && at >= p.to) continue;
    return {
      input_cents_per_mtok: p.input,
      output_cents_per_mtok: p.output,
      cached_input_cents_per_mtok: p.cached != null ? p.cached : p.input * CACHE_READ_MULT,
      cache_write_mult: p.writeMult != null ? p.writeMult : CACHE_WRITE_MULT,
      cache_write_1h_mult: p.write1hMult ?? null,
      long_context_threshold: p.lcThreshold ?? null,
      long_context_multiplier: p.lcMult ?? 1,
      effective_date: p.date || null,
      source_url: p.src || null,
      batch_discount: p.batch ?? null,
      legacy: !!p.legacy,
    };
  }
  return null;
}

// Sum a set of ledger rows into totals. Pure over plain objects, so the DB layer
// can hand it rows and the tests can hand it literals.
export function sumLedger(rows = []) {
  const acc = { inputTokens: 0, outputTokens: 0, costCents: 0, wallClockMs: 0, count: 0 };
  for (const r of rows) {
    if (!r) continue;
    acc.inputTokens += Number(r.input_tokens || 0);
    acc.outputTokens += Number(r.output_tokens || 0);
    acc.costCents += Number(r.cost_cents || 0);
    acc.wallClockMs += Number(r.wall_clock_ms || 0);
    acc.count += 1;
  }
  return acc;
}

// Remaining budget in cents (never negative-clamped — callers may want the true
// overage). null budget ⇒ null (unlimited / not configured).
export function remainingBudgetCents(budgetCents, spentCents) {
  if (budgetCents == null) return null;
  return Number(budgetCents) - Number(spentCents || 0);
}

// The buffered reservation an estimate needs to fit under: estimate × (1 +
// buffer%). Ceil so the envelope is never rounded down under the estimate.
export function bufferedReservationCents(estCostCents, bufferPct = 15) {
  const est = Math.max(0, Number(estCostCents || 0));
  const pct = Math.max(0, Number(bufferPct || 0));
  return Math.ceil(est * (1 + pct / 100));
}

// canStartCycle(estimate, quota, usage) → { ok, reason }.
//
//   estimate = { estCostCents }            — the cycle's cost envelope (R5)
//   quota    = { budgetCents, bufferPct,   — the applicable mock2_quotas row
//                maxConcurrentCycles }        (null / missing fields tolerated)
//   usage    = { spentCents, runningCycles } — current period spend + live cycles
//
// A missing budget means "not metered" and always passes the cost gate; a
// concurrency cap of null means "no cap". This is the gate M6 calls at cycle
// start; refused_quota is a real terminal cycle status (migration 502).
export function canStartCycle(estimate = {}, quota = {}, usage = {}) {
  const budgetCents = quota.budgetCents ?? null;
  const bufferPct = quota.bufferPct ?? 15;
  const maxConcurrent = quota.maxConcurrentCycles ?? null;
  const spentCents = Number(usage.spentCents || 0);
  const runningCycles = Number(usage.runningCycles || 0);

  // Concurrency cap (self-hosted GPU contention) — checked first: it's a hard
  // structural limit, not a spend estimate.
  if (maxConcurrent != null && runningCycles >= Number(maxConcurrent)) {
    return { ok: false, reason: `concurrency limit reached (${runningCycles}/${maxConcurrent} cycles running)` };
  }

  // Cost gate (only when metered).
  if (budgetCents != null) {
    const remaining = remainingBudgetCents(budgetCents, spentCents);
    if (remaining <= 0) {
      return { ok: false, reason: `budget exhausted (${fmt(spentCents)} of ${fmt(budgetCents)} spent this period)` };
    }
    const need = bufferedReservationCents(estimate.estCostCents, bufferPct);
    if (need > remaining) {
      return {
        ok: false,
        reason: `estimated ${fmt(need)} (incl. ${bufferPct}% buffer) exceeds ${fmt(remaining)} remaining this period`,
      };
    }
  }

  return { ok: true, reason: 'within budget' };
}

// Cents → "$1.23" for human-readable refusal messages.
function fmt(cents) {
  const n = Number(cents || 0);
  return `$${(n / 100).toFixed(2)}`;
}

// Client-safe view of a quota row + its live usage, for the quotas UI.
export function publicQuotaShape(row, usage = {}) {
  if (!row) return null;
  const spentCents = Number(usage.spentCents || 0);
  return {
    id: row.id,
    scope: row.scope,
    project_id: row.project_id ?? null,
    period: row.period,
    budget_cents: row.budget_cents ?? null,
    budget_wall_clock_min: row.budget_wall_clock_min ?? null,
    max_concurrent_cycles: row.max_concurrent_cycles ?? null,
    buffer_pct: row.buffer_pct ?? 15,
    spent_cents: spentCents,
    remaining_cents: remainingBudgetCents(row.budget_cents ?? null, spentCents),
  };
}
