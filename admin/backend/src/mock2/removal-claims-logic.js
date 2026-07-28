// Mock2 REMOVAL CLAIMS — "I took it out" has to be checkable.
//
// THE BUILD THAT CAUSED THIS. Project 44 finished with:
//
//   summary:    "…removed the To-dos inner scrollbar…"
//   acceptance: "…and no scrollbar beside the Note/To-dos content"
//   acceptance_ids: ["note-create-and-edit", "notes-list-loads"]
//
// Neither of those checks asserts anything about a scrollbar. The build had set
// `#panel-todos { overflow: visible }`, reasoned that this was the scrollbar in
// question, and shipped. The scrollbar is still on the screen. Nothing in the
// platform contradicted it, because nothing could: the gates catch horizontal
// overflow, dead controls and design drift, and none of them catch "the thing
// you said you removed is still there".
//
// WHAT THE REAL DATA SAYS. Across 86 finish payloads in six build histories,
// 12 summaries carry a verb-shaped removal claim, and EIGHT OF THE TWELVE
// declared no acceptance ids at all:
//
//   "hid the legal footer and dropped the page's large bottom padding"   ids=[]
//   "removed the double-tap helper paragraph"                            ids=[]
//   "removed the duplicate title row"                    ids=[note-create-and-edit]
//
// So this is not a rare shape. It is one finish in seven, and two thirds of
// those are unverifiable by construction.
//
// THE TWO WAYS THIS COULD GO WRONG, and both are guarded below.
//
//   1. FIRING ON CODE-ONLY REMOVALS. "deleted the dead unwrapped-atob
//      public/webauthn.js" is a real claim from this data and there is nothing
//      to check in a browser. A detector that demands a UI check for it is pure
//      noise, and noise is how a rejection loop starts costing builds.
//   2. DEMANDING A CHECK THE LANGUAGE CANNOT EXPRESS. A scrollbar is not an
//      element, so `expect_absent` cannot reach it — which is exactly why the
//      motivating build had no honest option. `expect_no_scroll` was added to
//      ui-check-logic.js for this, and it is why a rejection here is fair.
//
// AND IT REJECTS AT MOST ONCE. Repeated rejection auto-halts a cycle
// (LEARNINGS 107 — a punctuation bug in the over-claim extractor nearly killed
// builds that way), so the second finish is accepted and the OPERATOR is told
// instead. The build ships; the claim is marked unverified where a person sees
// it.
//
// PURE (stub-first, risk R9). Terminology (risk R7): nothing here is an "agent".

// The verbs, taken from the corpus rather than imagined. Deliberately
// VERB-shaped: "delete" appears 18 times in those 86 summaries and almost all
// are the noun — a Delete BUTTON being added, a delete flow being wired. Only
// the past-tense act of removing is a claim.
const REMOVAL_VERB = new RegExp(
  '\\b(removed|deleted|dropped|hid|eliminated|stripped(?: out)?|took out|got rid of'
  + '|no longer (?:shows?|displays?|renders?|appears?|has|includes?))\\b',
  'gi',
);

// Where a claim's object ends. A summary is one long sentence with semicolons
// and parentheses; the object is what sits between the verb and the next break.
//
// KNOWN AND ACCEPTED LIMITATION: this takes the FIRST object of a list. In
// "removed the My notes link, the Saved pill and the detail Delete button" it
// extracts the link and stops. Deliberate — extending the object across commas
// and "and" is how a parser starts swallowing the rest of a sentence, and the
// under-extraction is harmless in practice: one uncovered claim rejects the
// finish just as firmly as three, and a build adding an `expect_absent` for the
// one named almost always adds them for its siblings in the same check.
const CLAUSE_END = /[;.,)]|\band\b|\bthen\b|\bwhile\b|\bmoved\b|\bmade\b|\badded\b/i;

// Nouns that mean the removal was in the CODE, not on a screen. A build that
// deletes a dead helper has nothing to prove in a browser, and asking it to
// would teach it that this check is noise.
const CODE_NOUN = new RegExp(
  '\\b(import|imports|helper|helpers|function|functions|method|variable|const|dead code|dead'
  + '|unused|assertion|assertions|test|tests|spec|specs|comment|comments|logging|log line'
  + '|dependency|dependencies|package|script|shim|polyfill|wrapper|type|types|interface'
  + '|migration|endpoint|route|handler|listener|export|exports)\\b',
  'i',
);

// A path-shaped object is a file, and a file is code. Cheap and exact — the one
// code-only claim in the corpus ("deleted the dead unwrapped-atob
// public/webauthn.js") is caught by this alone.
const LOOKS_LIKE_PATH = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|\.(?:ts|tsx|js|jsx|mjs|cjs|sql|css|scss|json|ya?ml|md)\b/;

// THINGS YOU CAN POINT AT ON A SCREEN. This list is what makes a claim
// demandable, and requiring a hit here — rather than defaulting to "UI unless
// proven code" — is the deliberate conservative choice.
//
// The cost is asymmetric. Missing a claim costs one ordinary build, the state
// the product is in today. Demanding a check for something the build cannot
// name costs a finish round-trip every time, and repeated rejection auto-halts
// a cycle. So this only fires on removals it can actually name.
//
// `scrollbar` is here on purpose even though it is arguably a style artefact
// rather than a thing: it is the claim that caused this whole feature, and
// `expect_no_scroll` makes it genuinely assertable.
const UI_NOUN = new RegExp(
  '\\b(button|link|field|input|label|text|paragraph|heading|title|header|footer|nav|navbar'
  + '|menu|modal|dialog|popup|table|row|rows|column|card|cards|list|item|items|toggle|checkbox'
  + '|dropdown|select|tab|tabs|badge|pill|chip|icon|avatar|tooltip|banner|sidebar|drawer|toast'
  + '|form|search|filter|scrollbar|scroll bar|spinner|divider|separator|section|panel|placeholder'
  + '|helper text|hint|caption|breadcrumb|control|controls|screen|page|view|widget|counter|indicator)\\b',
  'i',
);

// Removals of a CSS PROPERTY rather than of a thing. "dropped the page's large
// bottom padding" is a real claim from the corpus and there is no honest check
// for it — no element vanished. Demanding one would push a build to invent a
// check that cannot fail, which is worse than not asking.
const STYLE_NOUN = new RegExp(
  '\\b(padding|margin|gap|spacing|whitespace|white space|shadow|border|outline|radius'
  + '|transition|animation|background|colou?r|font[- ]size|line[- ]height|opacity|z-index)\\b',
  'i',
);

const STOP = new Set([
  'the', 'a', 'an', 'its', 'it', 'their', 'this', 'that', 'these', 'those', 'and', 'or',
  'of', 'from', 'on', 'in', 'to', 'for', 'with', 'at', 'by', 'as', 'was', 'were', 'is',
  'are', 'be', 'been', 'now', 'old', 'former', 'entire', 'whole', 'all', 'both', 'each',
]);

export function claimWords(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

// extractRemovalClaims(summary) → [{ verb, object, raw, kind }]
//
// `kind` is 'ui' (a screen thing, and therefore checkable) or 'code' (nothing a
// browser can see). Only 'ui' claims ever demand anything.
export function extractRemovalClaims(summary) {
  const s = String(summary || '');
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(REMOVAL_VERB)) {
    const after = s.slice(m.index + m[0].length);
    const endM = CLAUSE_END.exec(after);
    const object = after.slice(0, endM ? endM.index : after.length).trim().slice(0, 160);
    if (!object) continue;
    const key = object.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Precedence, most specific first: a nameable screen thing wins over
    // everything (a "helper paragraph" is a paragraph, not a helper function);
    // then a file path or a code noun; then a bare style property; then
    // silence, because a claim this cannot name is a claim it should not
    // demand a check for.
    // The HEAD of an English noun phrase is its last word, and that is what
    // decides the kind. "the page's large bottom padding" contains "page" and
    // is nonetheless about padding; "the legal footer" contains neither and is
    // about a footer. Testing the whole string let the first list to match win,
    // which is grammar by accident.
    // A trailing prepositional phrase is not the head. "the transition on the
    // card" is about the transition; taking the last two words made it about
    // the card, and a style tweak started demanding a UI check.
    const core = object
      .replace(/[^A-Za-z0-9\s'-]/g, ' ')
      .split(/\s+(?:on|in|from|of|at|for|above|below|beside|under|over|within|inside|next to|beneath)\s+/i)[0];
    const head = core.trim().split(/\s+/).slice(-2).join(' ');
    let kind = 'code';
    if (STYLE_NOUN.test(head)) kind = 'style';
    else if (LOOKS_LIKE_PATH.test(object)) kind = 'code';
    else if (UI_NOUN.test(object)) kind = 'ui';
    else if (CODE_NOUN.test(object)) kind = 'code';
    out.push({
      verb: m[0].toLowerCase(),
      object,
      raw: `${m[0]} ${object}`.trim(),
      kind,
      words: claimWords(object),
    });
  }
  return out;
}

// The step kinds that could FAIL if the removed thing were still there. A
// removal "verified" by `expect_visible` is a check that passes either way.
export const FALSIFYING_STEPS = Object.freeze(['expect_absent', 'expect_no_scroll', 'expect_text']);

export function checkCanFalsifyRemoval(check) {
  return (check?.steps || []).some((st) => FALSIFYING_STEPS.some((k) => st && st[k] !== undefined));
}

// removalCoverage — the verdict.
//
// `removals` is what the build DECLARED at finish: [{ what, check_id }]. Making
// it structured rather than parsed out of prose is deliberate — the platform
// should not be guessing which sentence maps to which check, and a build that
// has to name the check has to have written one.
//
// A claim is covered when a declared removal both (a) plausibly refers to it
// and (b) names a check that exists and could fail. Matching is by significant
// WORD overlap, the same tolerance action-parity uses: a build should not lose
// a finish because it wrote "the Saved pill" in one place and "save pill" in
// the other.
export function removalCoverage({ summary = '', removals = [], spec = null } = {}) {
  const claims = extractRemovalClaims(summary).filter((c) => c.kind === 'ui');
  if (!claims.length) return { ok: true, claims: [], uncovered: [], badRefs: [], declared: [] };

  const checks = new Map((spec?.checks || []).map((c) => [c.id, c]));
  const declared = (Array.isArray(removals) ? removals : [])
    .map((r) => ({
      what: String(r?.what ?? '').trim().slice(0, 200),
      checkId: String(r?.check_id ?? r?.checkId ?? '').trim().slice(0, 120),
    }))
    .filter((r) => r.what || r.checkId);

  // A declaration pointing at a check that does not exist, or at one that
  // cannot fail, is worse than no declaration: it reads as verified.
  const badRefs = [];
  for (const d of declared) {
    if (!d.checkId) { badRefs.push({ ...d, why: 'no check named' }); continue; }
    const check = checks.get(d.checkId);
    if (!check) { badRefs.push({ ...d, why: `no check with id "${d.checkId}" in the spec` }); continue; }
    if (!checkCanFalsifyRemoval(check)) {
      badRefs.push({ ...d, why: `check "${d.checkId}" has no step that could fail if the thing were still there (needs one of: ${FALSIFYING_STEPS.join(', ')})` });
    }
  }

  const good = declared.filter((d) => !badRefs.some((b) => b.checkId === d.checkId && b.what === d.what));
  const uncovered = claims.filter((c) => !good.some((d) => {
    const dw = new Set(claimWords(d.what));
    if (!dw.size || !c.words.length) return false;
    const hits = c.words.filter((w) => dw.has(w)).length;
    // Half the claim's significant words, or two of them — whichever is easier.
    return hits >= Math.min(2, c.words.length) || hits / c.words.length >= 0.5;
  }));

  // `declared` goes back out NORMALIZED. The caller has to force these check ids
  // into the smoke run, and re-reading `r.check_id` off the raw input there would
  // be a second, subtly different normalizer: this one trims, caps, and accepts
  // the camelCase spelling, so a declaration could clear the gate here and then
  // silently never run. One normalizer, one answer.
  return { ok: !uncovered.length && !badRefs.length, claims, uncovered, badRefs, declared };
}

// What the model is told, once. Names the claims, names the step kinds, and
// says explicitly that withdrawing the claim is a legitimate answer — a build
// that merely reworded a sentence to slip past this would be the worst
// outcome, and it is the outcome a vague message invites.
export function removalRejectionMessage({ uncovered = [], badRefs = [] } = {}) {
  const lines = ['Not finished — this summary claims something was removed, and nothing would catch it if it were still there.'];
  if (uncovered.length) {
    lines.push('', 'Unverified removal claim(s):');
    for (const c of uncovered.slice(0, 6)) lines.push(`- "${c.raw}"`);
  }
  if (badRefs.length) {
    lines.push('', 'Declared removal(s) that do not verify anything:');
    for (const b of badRefs.slice(0, 6)) lines.push(`- "${b.what || '(unnamed)'}" → ${b.why}`);
  }
  lines.push(
    '',
    'For each one, add a step to state/ui-checks.json that FAILS while the thing is still present, then declare it:',
    '',
    '  finish(removals: [{ "what": "the detail Delete button", "check_id": "note-detail-controls" }])',
    '',
    'Use the step that fits what you removed:',
    '  - an element or control gone → { "expect_absent": "#delete-note" }',
    '  - a scrollbar gone          → { "expect_no_scroll": "#panel-todos" }',
    '  - wording gone from a label → { "expect_text": "#title-row", "contains": "…" }',
    '',
    'The named check must already exist in the spec (add it in this same change). Those',
    'checks are then RUN against the deployed app, so a claim that is not true comes back red.',
    '',
    'If a claim was about code rather than the screen, or you did not actually remove it,',
    'reword the summary to say what you really did — withdrawing the claim is a correct',
    'answer here, and a better one than a check that cannot fail.',
  );
  return lines.join('\n');
}

// The second pass. The build ships; the operator is told, because a claim
// nobody verified is exactly the thing they would otherwise discover by
// looking at the screen a day later.
export function removalWarningMessage({ uncovered = [], badRefs = [] } = {}) {
  const all = [...uncovered.map((c) => c.raw), ...badRefs.map((b) => b.what || '(unnamed)')].filter(Boolean);
  if (!all.length) return '';
  const n = all.length;
  return `Heads-up — this build says it removed ${n === 1 ? 'something' : `${n} things`} that nothing checks: `
    + `${all.slice(0, 5).map((x) => `"${x}"`).join(', ')}. `
    + 'It shipped anyway, but no automated check would notice if it is still on the screen — worth a look. '
    + 'A future build can add a check for it (`expect_absent`, or `expect_no_scroll` for a scrollbar).';
}

// The one-line log entry, so a green build still records that the check ran.
export function removalCoverageNote(verdict) {
  const ui = (verdict?.claims || []).length;
  if (!ui) return '';
  if (verdict.ok) return `Removal claims: ${ui} claim(s), each asserted by a check that could fail.`;
  return `Removal claims: ${verdict.uncovered.length} unverified, ${verdict.badRefs.length} declared-but-unfalsifiable.`;
}
