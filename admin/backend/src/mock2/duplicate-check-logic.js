// "Is this already done?" pre-build check (run-taxonomy fix #6/D2). Two tiers:
// exact-after-normalisation (an operator resends literally the same request —
// the report's Encapsoul 650/652 case) and fuzzy overlap against recent
// SUCCESSFUL change-record summaries (a re-request of already-shipped work —
// the report's Docs 740-vs-738 case, where the same ask came back reworded
// after it had already landed). Reuses finish-guard-logic's token-Jaccard
// similarity (payloadSimilarity) rather than a second implementation.
//
// NOT reused: finish-guard-logic's normalizePayload. That function normalizes
// a JSON OBJECT shape (a finish call's { summary, acceptance, assumptions }) —
// handed a plain string, `typeof input === 'object'` is false and it silently
// collapses to '{}' for every input, which would make every instruction look
// identical. A free-text instruction needs its own normalizer (below); only
// payloadSimilarity (already generic over any two strings) is shared.

import { payloadSimilarity } from './finish-guard-logic.js';

// DUPLICATE_FUZZY_THRESHOLD is 0.70, not the 0.55 an initial pass at this
// spec suggested. Measured directly against this repo's own payloadSimilarity
// (same calibration method as consult-logic.js's SYMPTOM_SIMILARITY_THRESHOLD,
// which hit the identical problem): at 0.55, "add a cancel button to the
// profile page" vs "fix the cancel button's color on the profile page" — two
// OPPOSITE requests that merely share a noun phrase — scores 0.625, clearing
// a 0.55 floor and becoming a false "already done" refusal for work that was
// never done. Real paraphrases of the SAME ask ("re-run the folder export so
// nested subfolders keep their structure" vs "reorganized the folder export —
// nested subfolders now keep their structure") score 0.727, comfortably above
// 0.70 with room to spare below the false-positive pair. 0.70 also excludes
// another near-miss: "fix the login page CSS" vs "fix the signup page CSS"
// (different pages, 0.667) — a same-tokens-different-target pair the lower
// floor would have wrongly matched too.
export const DUPLICATE_EXACT_THRESHOLD = 0.95;
export const DUPLICATE_FUZZY_THRESHOLD = 0.70;

// Free-text normalizer for an instruction (lowercase, whitespace-collapsed,
// trimmed) — distinct from finish-guard-logic's object-shaped normalizePayload
// (see module comment above).
function normalizeInstruction(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// findLikelyDuplicate — does this instruction ask for something a recent,
// SUCCESSFUL cycle already did? `recentRecords` must be pre-scoped to this
// project, most-recent-first, and pre-filtered to successful cycles by the
// caller (native — needs the DB): [{ cycleId, seq, summary, createdAt }].
// Returns the FIRST (most recent) record scoring at or above the fuzzy floor,
// tagged 'exact' or 'fuzzy' by threshold — recency wins over a higher score
// further back, because the operator's mental model of "did I just ask for
// this" is about the last thing that shipped, not a global best match.
// Returns null when nothing clears the floor, when the instruction is empty,
// or when recentRecords is empty.
export function findLikelyDuplicate({ instruction, recentRecords = [] } = {}) {
  const norm = normalizeInstruction(instruction);
  if (!norm) return null;
  for (const rec of (Array.isArray(recentRecords) ? recentRecords : [])) {
    if (!rec) continue;
    const summaryNorm = normalizeInstruction(rec.summary);
    if (!summaryNorm) continue;
    const score = norm === summaryNorm ? 1 : payloadSimilarity(norm, summaryNorm);
    if (score < DUPLICATE_FUZZY_THRESHOLD) continue;
    return { match: rec, kind: score >= DUPLICATE_EXACT_THRESHOLD ? 'exact' : 'fuzzy', score };
  }
  return null;
}

// duplicateRefusalMessage — names the specific prior change record and offers
// the explicit override, so a refusal that's actually wrong (genuinely new
// work that happens to read like something already shipped) costs one extra
// press, not a dead end.
export function duplicateRefusalMessage(dup) {
  const seq = dup?.match?.seq != null ? `change record ${dup.match.seq}` : 'a recent change';
  const excerpt = String(dup?.match?.summary || '').trim().slice(0, 300);
  const verb = dup?.kind === 'exact' ? 'looks identical to' : 'looks like it may already be covered by';
  return [
    `Build not started — this request ${verb} ${seq}, already shipped:`,
    excerpt ? `"${excerpt}${excerpt.length >= 300 ? '…' : ''}"` : null,
    'If this is genuinely new work, send it again to build anyway.',
  ].filter(Boolean).join('\n\n');
}
