// Mock2 adaptive-summary PURE decision layer (Phase M9; the brief's adaptive-
// summary section; 03-data-model.md mock2_summaries). Native-free, unit-tested
// stub-first (risk R9): imports NOTHING that opens a DB, hits the network, or
// touches Incus.
//
// The adaptive summary is a versioned, diffable plain-language description of the
// project, regenerated on QUALIFYING cycles only and derived from CHANGE RECORDS
// + state/rules.md ONLY — never the chat (03-data-model.md: derived_from_change_seq
// is the change-record high-water mark, NOT chat). The determinism lives here:
//
//   * the QUALIFYING-change predicate (a cycle that touched rules.md /
//     inventory.json / screens±actions) — so a pure-chat turn or a no-op never
//     regenerates the summary;
//   * the trigger (regenerate iff a NEW qualifying record has appeared since the
//     last summary's derived_from_change_seq high-water mark);
//   * the version bump, the change-record digest fed to the model, the "did the
//     body actually change" guard (so an identical regeneration is skipped), and
//     a clean line diff between two versions for the UI.
//
// summary.js (the host/model half) drives the summary slot through callModelTurn
// and writes mock2_summaries; the tests import ONLY this module.
//
// Terminology (risk R7): nothing here is named "agent".

// isQualifyingRecord — does this change record represent a MATERIAL change that
// should refresh the summary? Deterministic over the record's own fields:
//   * rules_touched non-empty  → state/rules.md changed (a rule confirmation);
//   * gates_run non-empty      → a build cycle checkpoint (screens±actions moved);
//   * the summary text names the inventory / a design approval (sign-off #1, the
//     concept exit that writes state/inventory.json).
// A pure-chat/no-op record (none of the above) does NOT qualify.
export function isQualifyingRecord(record) {
  if (!record) return false;
  if (nonEmptyJsonArray(record.rules_touched)) return true;
  if (nonEmptyJsonArray(record.gates_run)) return true;
  const summary = String(record.summary || '');
  if (/\binventory\b|design approved|design inventory/i.test(summary)) return true;
  return false;
}

// A DB column may store a JSON array as a string, or the caller may hand a real
// array (tests). Empty / null / "[]" / non-array all count as "no".
function nonEmptyJsonArray(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  const s = String(v).trim();
  if (!s || s === '[]' || s === 'null') return false;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.length > 0 : !!parsed;
  } catch {
    return s.length > 0; // a non-JSON non-empty string still counts as "touched"
  }
}

// The change-record high-water mark (max seq) across a project's records — the
// value mock2_summaries.derived_from_change_seq stores at generation. 0 when the
// project has no records yet.
export function changeSeqHighWater(records = []) {
  let hi = 0;
  for (const r of records || []) {
    const seq = Number(r?.seq);
    if (Number.isFinite(seq) && seq > hi) hi = seq;
  }
  return hi;
}

// The highest seq among QUALIFYING records — the newest material change. null
// when nothing has qualified yet.
export function latestQualifyingSeq(records = []) {
  let hi = null;
  for (const r of records || []) {
    if (!isQualifyingRecord(r)) continue;
    const seq = Number(r?.seq);
    if (Number.isFinite(seq) && (hi == null || seq > hi)) hi = seq;
  }
  return hi;
}

// summaryTrigger — the deterministic regenerate decision. Regenerate iff a
// qualifying record exists whose seq is BEYOND the last summary's high-water mark
// (so non-qualifying churn after a summary never re-triggers, and the same
// qualifying record never triggers twice). Because records are append-only and a
// new qualifying record is always the newest seq, this fires exactly once per new
// material change.
//
//   records     : the project's change records (any order)
//   lastSummary : the newest mock2_summaries row, or null
//
// Returns { shouldRegen, derivedFromSeq, qualifyingSeq, lastSeq }.
export function summaryTrigger(records = [], lastSummary = null) {
  const derivedFromSeq = changeSeqHighWater(records);
  const qualifyingSeq = latestQualifyingSeq(records);
  const lastSeq = lastSummary ? Number(lastSummary.derived_from_change_seq || 0) : 0;
  const shouldRegen = qualifyingSeq != null && qualifyingSeq > lastSeq;
  return { shouldRegen, derivedFromSeq, qualifyingSeq, lastSeq };
}

// The next monotonic summary version for a project.
export function nextSummaryVersion(lastSummary) {
  return (lastSummary ? Number(lastSummary.version || 0) : 0) + 1;
}

// ---- the summary system prompt + task (change records + rules.md ONLY) ----

export function buildSummarySystemPrompt({ projectName = 'this project' } = {}) {
  return `You maintain the living SUMMARY of "${projectName}" — a short, plain-language
description of what the app is and the domain rules it follows, written for a
non-technical reader who wants to understand the project at a glance.

You are given the project's confirmed rules (state/rules.md) and its change
history (the append-only record of every checkpoint). You are NOT given the chat —
work only from the confirmed rules and the recorded changes.

Write the summary in Markdown:
  - one or two sentences on what the app is and does;
  - a short "Rules" section listing the confirmed domain rules in plain language;
  - a short "Recent changes" section (the few most recent material changes).

Keep it concise (well under a page), factual, and free of implementation jargon.
Output ONLY the Markdown summary — no preamble, no code fences.`;
}

// A compact, deterministic digest of the change records for the prompt (newest
// last, so the model reads them in order). Only the human-facing fields.
export function summarizeChangeRecords(records = [], { max = 40 } = {}) {
  const ordered = [...(records || [])]
    .filter(Boolean)
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .slice(-max);
  return ordered
    .map((r) => `#${r.seq} — ${String(r.summary || '(no summary)').trim()}`)
    .join('\n');
}

export function buildSummaryTask({ rulesMd = '', records = [], projectName = 'the app' } = {}) {
  const rules = String(rulesMd || '').trim();
  return [
    `Project: ${projectName}`,
    `Confirmed rules (state/rules.md):\n${rules || '(rules.md is empty — no rules confirmed yet)'}`,
    `Change history (oldest first):\n${summarizeChangeRecords(records) || '(no change records yet)'}`,
    'Write the current summary as Markdown, per your instructions.',
  ].join('\n\n');
}

// ---- version guards + diff ----

// Normalize a summary body for comparison (trim, collapse trailing whitespace per
// line, strip a trailing newline) so a cosmetically-identical regeneration is
// recognized as unchanged and NOT written as a new version.
export function normalizeSummaryBody(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Has the summary body actually changed vs the previous version? Used to skip
// writing an identical new version (keeps the version history meaningful and the
// diff clean).
export function summaryBodyChanged(prevBody, nextBody) {
  return normalizeSummaryBody(prevBody) !== normalizeSummaryBody(nextBody);
}

// A clean line-level diff between two summary versions for the UI's side-by-side
// view. Returns { added, removed, changed } line arrays (set semantics — order-
// insensitive, deduped), so the frontend can render "what changed" without a diff
// library. Deterministic.
export function diffSummaries(prevBody, nextBody) {
  const prev = normalizeSummaryBody(prevBody).split('\n').filter((l) => l.trim());
  const next = normalizeSummaryBody(nextBody).split('\n').filter((l) => l.trim());
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const added = next.filter((l) => !prevSet.has(l));
  const removed = prev.filter((l) => !nextSet.has(l));
  return { added: dedupe(added), removed: dedupe(removed), changed: added.length > 0 || removed.length > 0 };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

// ---- API response shape ----

export function publicSummaryShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    version: row.version,
    body_md: row.body_md || '',
    derived_from_change_seq: row.derived_from_change_seq ?? null,
    created_at: row.created_at || null,
  };
}

// ---- cost envelope (R5 — the summary spends on its slot) ----

export function estimateSummaryTokens() {
  return { inputTokens: 10000, outputTokens: 2500 };
}
