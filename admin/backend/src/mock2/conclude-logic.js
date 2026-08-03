// conclude-logic.js — pure decision layer for concludeCycle (runner.js). Split
// out so the recording strategy and the summary text are testable without a
// container or a database: what concludeCycle DOES is decided here, not in
// runner.js.
//
// The problem this closes: finishCycle (cycles.js) only flips cycle status — it
// never wrote a change record. Twelve terminal paths in runner.js called it
// directly, so those cycles left a cycle row and no ledger entry (the
// "unlogged cycle IDs" in the run-taxonomy report, and the reason every waste
// figure there is a floor). concludeCycle is the one terminal exit that always
// leaves a record; this module decides HOW.

const SUMMARY_CAP = 500;

function cap(s) {
  const str = String(s || '').trim();
  if (str.length <= SUMMARY_CAP) return str;
  return `${str.slice(0, SUMMARY_CAP - 1)}…`;
}

// terminalSummary — what a terminal record says when nothing more specific was
// given. Caller summary always wins; otherwise fall back to the status/error
// pair, and failing that, an explicit "no detail" rather than an empty string.
export function terminalSummary({ summary = null, status, error = null } = {}) {
  const s = typeof summary === 'string' ? summary.trim() : '';
  if (s) return cap(s);
  const base = error ? `${status}: ${String(error).trim()}` : `${status}: no detail`;
  return cap(base);
}

// terminalRecordPlan — which recording strategy a terminal path gets. A full
// checkpoint needs BOTH a live container and the cycle's lock holder; either
// missing means there is nothing to commit against, so the minimal (no-commit)
// path is the only honest option — not a downgrade, just what is possible.
export function terminalRecordPlan({ containerName = null, holder = null, summary = null, status, error = null } = {}) {
  const strategy = containerName && holder ? 'checkpoint' : 'minimal';
  return { strategy, summary: terminalSummary({ summary, status, error }) };
}
