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

// Cents for a token spend against an effective-dated price row. Prices are cents
// per million tokens (mtok). Self-hosted / unpriced models price at 0. Returns
// FRACTIONAL cents on purpose: a single build turn is often a fraction of a cent,
// so rounding here (and again on every accumulation) used to floor each call to
// 0 and lose the whole cost — the accumulated total is rounded only for display.
export function costCentsForUsage({ inputTokens = 0, outputTokens = 0 }, price) {
  if (!price) return 0;
  const inC = (Number(inputTokens) / 1_000_000) * Number(price.input_cents_per_mtok || 0);
  const outC = (Number(outputTokens) / 1_000_000) * Number(price.output_cents_per_mtok || 0);
  return inC + outC;
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
