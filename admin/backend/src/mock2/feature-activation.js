// Mock2 feature-activation COLLECTOR — the per-build ledger's storage.
//
// In-memory and per cycle, the same shape and lifetime as screen-job.js: a
// build is a bounded thing that ends, and the ledger's only job is to survive
// until the note is written at the end of it. Nothing here is durable on
// purpose — a backend restart mid-build loses the ledger, which is correct,
// because the build it described did not finish either.
//
// Records are dropped on READ, not by a timer: a timer over a Map is a second
// thing to get wrong, and an entry nobody asks for costs a few hundred bytes.

import { mergeActivations, activationNote, activationSummary, normaliseActivation } from './feature-activation-logic.js';

const ledgers = new Map();
const MAX_ENTRIES = 60;          // a runaway loop must not grow this forever
const MAX_AGE_MS = 60 * 60 * 1000;
const MAX_LEDGERS = 200;

// Keyed by PROJECT, not by cycle. The clarifier and the pre-pass run BEFORE a
// cycle exists, and they are two of the features most worth accounting for; a
// cycle-keyed ledger would silently drop exactly those. One project builds one
// thing at a time (the build lock guarantees it), so a project key is
// unambiguous, and the ledger is cleared when the build that consumed it ends.
const key = (projectId) => String(Number(projectId) || 0);

function alive(rec, now) {
  return rec && now - rec.startedAt < MAX_AGE_MS;
}

// recordFeature — one entry. NEVER THROWS: this is instrumentation, and
// instrumentation that can break a build is worse than no instrumentation.
// An unknown feature key or a bad state is dropped by normaliseActivation.
export function recordFeature(projectId, feature, state, detail = '') {
  try {
    if (!normaliseActivation({ feature, state, detail })) return false;
    const k = key(projectId);
    const now = Date.now();
    let rec = ledgers.get(k);
    if (!alive(rec, now)) { rec = { startedAt: now, entries: [] }; ledgers.set(k, rec); }
    if (rec.entries.length >= MAX_ENTRIES) return false;
    rec.entries.push({ feature, state, detail });
    // Cheap bound on the map itself: evict the oldest when it grows past the
    // cap. A long-lived backend running many projects must not accumulate.
    if (ledgers.size > MAX_LEDGERS) {
      const oldest = [...ledgers.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
      if (oldest) ledgers.delete(oldest[0]);
    }
    return true;
  } catch { return false; }
}

// takeFeatureLedger — read AND clear. The note is written once, at the end of
// the build; leaving the entries behind would let a retried cycle inherit the
// previous attempt's ledger and report features that did not run this time.
export function takeFeatureLedger(projectId) {
  const k = key(projectId);
  const rec = ledgers.get(k);
  ledgers.delete(k);
  if (!alive(rec, Date.now())) return { entries: [], note: '', summary: activationSummary([]) };
  const entries = mergeActivations(rec.entries);
  return { entries, note: activationNote(rec.entries), summary: activationSummary(rec.entries) };
}

export function peekFeatureLedger(projectId) {
  const rec = ledgers.get(key(projectId));
  return alive(rec, Date.now()) ? mergeActivations(rec.entries) : [];
}

// Test seam.
export function _resetFeatureLedgers() { ledgers.clear(); }
