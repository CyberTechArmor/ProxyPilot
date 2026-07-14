// Mock2 request-log PURE builder (cost-truth Part 1). Native-free (crypto is a Node
// builtin), unit-tested. One build request = one log: the merged, ORDERED, DEDUPLICATED
// record of every cycle-segment (define → build → halted → resumed → consult → succeeded)
// under a request, with ONE cumulative cost roll-up and ONE final status.
//
// The duplicate-export bug (#40/#41 were byte-identical exports) is fixed by making the
// artifact IDEMPOTENT per request + content: requestLogArtifact hashes the deterministic
// content (excluding volatile fields like generated_at), so identical inputs always
// produce one identical artifact + hash.
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'crypto';
import { canonicalUsage, sumUsage, dollars, USAGE_SCHEMA_VERSION } from './usage-logic.js';

// The segment vocabulary a cycle can represent within a request. 'consult' is the
// advisory Fable 5 second opinion (Part 5), logged as its own segment.
export const REQUEST_SEGMENTS = Object.freeze([
  'define', 'build', 'halted', 'resumed', 'budget_paused', 'retry', 'consult', 'succeeded', 'failed', 'abandoned',
]);

// Stable stringify (sorted keys) so a content hash is order-independent and reproducible
// across processes. Arrays keep their order (order is meaningful for the log).
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// Dedupe a row list by a stable identity: prefer `id`, else a hash of the row's content.
// Preserves first-seen order. This is what collapses byte-identical duplicate rows.
function dedupeRows(rows = []) {
  const seen = new Set();
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r == null) continue;
    const key = r.id != null ? `id:${r.id}` : `c:${createHash('sha256').update(stableStringify(r)).digest('hex')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Chronological sort with a stable tiebreak on id/seq (ISO timestamps compare lexically).
function byTime(a, b) {
  const ta = String(a?.created_at || a?.at || '');
  const tb = String(b?.created_at || b?.at || '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  return Number(a?.id ?? a?.seq ?? 0) - Number(b?.id ?? b?.seq ?? 0);
}

// One segment row per cycle, ordered by time: what stage it was + its own cost.
function segmentsFromCycles(cycles = []) {
  return (Array.isArray(cycles) ? cycles : [])
    .slice()
    .sort(byTime)
    .map((c) => {
      const usage = canonicalUsage(c);
      return {
        cycle_id: c.id ?? null,
        segment: c.segment || inferSegment(c),
        status: c.status || null,
        cost_cents: usage.cost_cents,
        schema_version: usage.schema_version,
        created_at: c.created_at || null,
      };
    });
}

// Best-effort segment label when a legacy cycle carries none (backfill/new-only path).
function inferSegment(cycle) {
  if (cycle?.stage === 'define' || cycle?.stage === 'audit') return 'define';
  if (cycle?.status === 'succeeded') return 'succeeded';
  if (cycle?.status === 'abandoned') return 'abandoned';
  if (cycle?.halt_reason) return 'halted';
  return 'build';
}

// Cost per segment TYPE (define vs build vs resume vs consult …) — the Part 4 per-request
// breakdown. Cents, keyed by segment.
export function costBySegment(cycles = []) {
  const out = {};
  for (const s of segmentsFromCycles(cycles)) {
    out[s.segment] = (out[s.segment] || 0) + Number(s.cost_cents || 0);
  }
  return out;
}

// buildRequestLog — the merged request record. Deterministic (no timestamps of its own);
// requestLogArtifact adds the volatile envelope. `consults` are folded in as their own
// segments and into the roll-up.
export function buildRequestLog({ request = null, cycles = [], changeRecords = [], messages = [], events = [], consults = [] } = {}) {
  const cycleList = Array.isArray(cycles) ? cycles : [];
  const consultList = Array.isArray(consults) ? consults : [];

  const segments = segmentsFromCycles(cycleList);
  // Consults are their own segments in the roll-up (Parts 1/4).
  for (const k of consultList) {
    segments.push({
      cycle_id: k.cycle_id ?? null, segment: 'consult', status: 'advisory',
      cost_cents: Number(k.cost_cents || 0), schema_version: USAGE_SCHEMA_VERSION, created_at: k.created_at || null,
    });
  }
  segments.sort(byTime);

  const rollup = sumUsage([
    ...cycleList.map((c) => canonicalUsage(c)),
    ...consultList.map((k) => canonicalUsage(k)),
  ]);
  const bySegment = costBySegment(cycleList);
  if (consultList.length) bySegment.consult = consultList.reduce((s, k) => s + Number(k.cost_cents || 0), 0);

  return {
    request: request
      ? { id: request.id, project_id: request.project_id, instruction: request.instruction || null, status: request.status || null, created_at: request.created_at || null, finished_at: request.finished_at || null }
      : null,
    segments,
    cost: {
      cents: rollup.cost_cents,
      dollars: dollars(rollup.cost_cents),
      by_segment: bySegment,
      comparable: rollup.schema_version >= USAGE_SCHEMA_VERSION,
      schema_version: rollup.schema_version,
    },
    final_status: request?.status || (segments.length ? segments[segments.length - 1].status : null),
    change_records: dedupeRows(changeRecords).slice().sort(byTime),
    messages: dedupeRows(messages).slice().sort(byTime),
    events: dedupeRows(events).slice().sort(byTime),
    usage_schema_version: USAGE_SCHEMA_VERSION,
  };
}

// requestLogArtifact — the downloadable artifact + its content hash. IDEMPOTENT: the
// hash is over the deterministic log content only (volatile fields excluded), so the
// same request exported twice yields one identical artifact (fixes #40/#41). `at` is the
// only volatile field and is NOT hashed.
export function requestLogArtifact(log, { at = null } = {}) {
  const content = stableStringify(log);
  const contentHash = createHash('sha256').update(content).digest('hex');
  return {
    content_hash: contentHash,
    // A stable, dedupe-friendly filename: the request id + a short content fingerprint.
    filename: `request-${log?.request?.id ?? 'log'}-${contentHash.slice(0, 12)}.json`,
    generated_at: at,
    log,
  };
}
