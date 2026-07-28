// REMOVAL CLAIMS — "I took it out" has to be checkable.
//
// THE BUILD THAT CAUSED THIS, verbatim from project 44's history:
//
//   summary:        "…removed the To-dos inner scrollbar…"
//   acceptance:     "…and no scrollbar beside the Note/To-dos content"
//   acceptance_ids: ["note-create-and-edit", "notes-list-loads"]
//
// Neither check asserts anything about a scrollbar. The scrollbar is still on
// the screen. Nothing contradicted the claim because nothing could.
//
// This detector runs on EVERY finish, and its danger is the opposite of its
// purpose: a false demand costs a finish round-trip, and repeated rejection
// auto-halts a cycle (LEARNINGS 107). So the corpus below is real — 86 finish
// payloads from six build histories — and most of these cases are about
// STAYING QUIET.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractRemovalClaims, removalCoverage, checkCanFalsifyRemoval, claimWords,
  removalRejectionMessage, removalWarningMessage, removalCoverageNote, FALSIFYING_STEPS,
} from '../mock2/removal-claims-logic.js';

const kinds = (s) => extractRemovalClaims(s).map((c) => `${c.kind}:${c.object}`);
const uiClaims = (s) => extractRemovalClaims(s).filter((c) => c.kind === 'ui');

/* ------------------------- it must stay quiet ---------------------------- */

test('A DELETE FEATURE IS NOT A REMOVAL CLAIM', () => {
  // "delete" appears 18 times across the 86 real summaries and almost every one
  // is the NOUN — a Delete button being added, a delete flow being wired.
  // Matching the word rather than the verb would fire on a third of all
  // finishes and be ignored within a week.
  for (const s of [
    'added a Delete note button with a confirmation modal',
    'moved confirm-guarded Delete onto each list card',
    'wired the delete flow to pp.confirm',
    'the Delete button now asks before deleting',
  ]) {
    assert.deepEqual(uiClaims(s), [], s);
  }
});

test('CODE-ONLY REMOVALS ARE SILENT', () => {
  // Real: "deleted the dead unwrapped-atob public/webauthn.js". There is
  // nothing for a browser to check, and demanding one teaches the build that
  // this detector is noise.
  for (const s of [
    'deleted the dead unwrapped-atob public/webauthn.js',
    'removed the unused import',
    'removed the dead helper function',
    'dropped the obsolete migration',
    'removed the #save-txt assertion from e2e/notes.spec.ts',
    'stripped out the debug logging',
  ]) {
    assert.deepEqual(uiClaims(s), [], s);
  }
});

test('A STYLE TWEAK IS NOT A THING THAT VANISHED', () => {
  // Real: "dropped the page's large bottom padding". No element disappeared,
  // so there is no honest check — and demanding one would push a build to
  // invent a check that cannot fail, which is worse than not asking.
  for (const s of [
    "dropped the page's large bottom padding",
    'removed the extra margin above the toolbar',
    'removed the drop shadow',
    'dropped the transition on the card',
  ]) {
    assert.deepEqual(uiClaims(s), [], s);
  }
});

test('THE HEAD NOUN DECIDES, NOT THE FIRST WORD THAT MATCHES', () => {
  // "the page's large bottom padding" contains "page" (a UI noun) and is about
  // padding. In English the head of a noun phrase is its LAST word; testing the
  // whole string let whichever list matched first win, which is grammar by
  // accident.
  assert.deepEqual(kinds("dropped the page's large bottom padding"), ["style:the page's large bottom padding"]);
  assert.deepEqual(kinds('removed the legal footer'), ['ui:the legal footer']);
});

test('a summary with no removal at all is silent', () => {
  for (const s of [
    'added a stats card to the dashboard',
    'fixed the mobile nav so it fits on one line',
    'N8 note detail: made the editable title the header with a back-arrow',
    '',
  ]) {
    assert.deepEqual(uiClaims(s), [], s);
  }
});

/* -------------------------- it must fire --------------------------------- */

test('THE CLAIM THAT SHIPPED A SCROLLBAR IS CAUGHT', () => {
  const claims = uiClaims('removed the To-dos inner scrollbar, and condensed the mobile header nav to one line');
  assert.equal(claims.length, 1);
  assert.match(claims[0].object, /scrollbar/);
});

test('and the other real unverified claims from the corpus', () => {
  const real = [
    'hid the legal footer and dropped the large bottom padding',
    'removed the double-tap helper paragraph, made the card default to edit mode',
    'removed the duplicate title row',
    'removed the "My notes" link',
    'the note screen no longer shows the Saved pill',
  ];
  for (const s of real) assert.ok(uiClaims(s).length >= 1, s);
});

test('a "helper paragraph" is a paragraph, not a helper', () => {
  // The one miscategorisation the corpus caught: "helper" is a code noun and
  // "helper paragraph" is a thing on a screen. It appeared five times.
  assert.deepEqual(kinds('removed the double-tap helper paragraph'), ['ui:the double-tap helper paragraph']);
});

/* ------------------------ what satisfies a claim ------------------------- */

const SPEC = {
  checks: [
    { id: 'passes-either-way', steps: [{ expect_visible: '#note-title' }, { fill: '#note-title', value: 'x' }] },
    { id: 'catches-it', steps: [{ expect_absent: '#delete-note' }, { expect_no_scroll: '#panel-todos' }] },
  ],
};

test('ONLY A STEP THAT COULD FAIL COUNTS', () => {
  // A removal "verified" by expect_visible is a check that passes whether or
  // not the thing is still there — the exact shape of the original defect,
  // reproduced with more ceremony.
  assert.equal(checkCanFalsifyRemoval(SPEC.checks[0]), false);
  assert.equal(checkCanFalsifyRemoval(SPEC.checks[1]), true);
  assert.deepEqual([...FALSIFYING_STEPS].sort(), ['expect_absent', 'expect_no_scroll', 'expect_text']);
});

test('a declaration naming a check that cannot fail is REJECTED, not accepted', () => {
  const v = removalCoverage({
    summary: 'removed the To-dos inner scrollbar',
    removals: [{ what: 'the To-dos inner scrollbar', check_id: 'passes-either-way' }],
    spec: SPEC,
  });
  assert.equal(v.ok, false);
  assert.match(v.badRefs[0].why, /no step that could fail/);
});

test('a declaration naming a check that does not exist is rejected', () => {
  const v = removalCoverage({
    summary: 'removed the To-dos inner scrollbar',
    removals: [{ what: 'the scrollbar', check_id: 'no-such-check' }],
    spec: SPEC,
  });
  assert.equal(v.ok, false);
  assert.match(v.badRefs[0].why, /no check with id/);
});

test('a proper declaration passes', () => {
  const v = removalCoverage({
    summary: 'removed the To-dos inner scrollbar',
    removals: [{ what: 'the To-dos inner scrollbar', check_id: 'catches-it' }],
    spec: SPEC,
  });
  assert.equal(v.ok, true);
  assert.equal(v.uncovered.length, 0);
});

test('matching tolerates rewording, the way action parity does', () => {
  // A build should not lose a finish because it wrote "the Saved pill" in the
  // summary and "Saved pill on the detail screen" in the declaration.
  const v = removalCoverage({
    summary: 'removed the Saved pill',
    removals: [{ what: 'the Saved pill on the note detail screen', check_id: 'catches-it' }],
    spec: SPEC,
  });
  assert.equal(v.ok, true);
});

test('but an unrelated declaration does not cover a claim', () => {
  const v = removalCoverage({
    summary: 'removed the To-dos inner scrollbar',
    removals: [{ what: 'the admin users table', check_id: 'catches-it' }],
    spec: SPEC,
  });
  assert.equal(v.ok, false);
  assert.equal(v.uncovered.length, 1);
});

test('no claims means nothing to satisfy', () => {
  const v = removalCoverage({ summary: 'added a stats card', removals: [], spec: SPEC });
  assert.equal(v.ok, true);
  assert.deepEqual(v.claims, []);
  assert.equal(removalCoverageNote(v), '', 'and nothing to log');
});

test('a missing or unparseable spec does not crash the verdict', () => {
  for (const spec of [null, undefined, {}, { checks: null }]) {
    const v = removalCoverage({ summary: 'removed the legal footer', removals: [], spec });
    assert.equal(v.ok, false, 'the claim is still uncovered');
    assert.equal(v.uncovered.length, 1);
  }
});

/* ---------------------------- what it says ------------------------------- */

test('the rejection names the claims, the step kinds, AND the way out', () => {
  const v = removalCoverage({ summary: 'removed the To-dos inner scrollbar', removals: [], spec: SPEC });
  const m = removalRejectionMessage(v);
  assert.match(m, /To-dos inner scrollbar/);
  assert.match(m, /expect_no_scroll/, 'a scrollbar is not an element — the message must say what CAN assert it');
  assert.match(m, /expect_absent/);
  // The worst outcome would be a build that just rewords the sentence to slip
  // past the detector, and a vague message invites exactly that.
  assert.match(m, /withdrawing the claim is a correct\s*\n?answer/,
    'saying what you actually did must be an explicitly allowed answer');
});

test('the operator warning is written for a person, not a log', () => {
  const v = removalCoverage({ summary: 'removed the To-dos inner scrollbar', removals: [], spec: SPEC });
  const w = removalWarningMessage(v);
  assert.match(w, /scrollbar/);
  assert.match(w, /It shipped anyway/);
  assert.match(w, /still on the screen/);
  assert.equal(removalWarningMessage({ uncovered: [], badRefs: [] }), '', 'nothing to warn about says nothing');
});

test('the log line distinguishes verified from unverified', () => {
  const good = removalCoverage({
    summary: 'removed the To-dos inner scrollbar',
    removals: [{ what: 'the To-dos inner scrollbar', check_id: 'catches-it' }],
    spec: SPEC,
  });
  assert.match(removalCoverageNote(good), /each asserted by a check that could fail/);
  const bad = removalCoverage({ summary: 'removed the To-dos inner scrollbar', removals: [], spec: SPEC });
  assert.match(removalCoverageNote(bad), /1 unverified/);
});

/* ------------------------------ the ratchets ------------------------------ */

test('RATCHET: it rejects at most ONCE', () => {
  // Repeated rejection auto-halts a cycle. A detector that can kill a build is
  // worse than the defect it catches — that is LEARNINGS 107, and this is the
  // same failure mode one feature later.
  const src = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  assert.match(src, /let removalRejected = false;/);
  assert.match(src, /!verdict\.ok && !removalRejected/);
  const block = src.slice(src.indexOf('const claimed = decision.finishRemovals'), src.indexOf('ACTION PARITY'));
  assert.match(block, /insertMessage/, 'the second pass must tell the OPERATOR, not just the log');
  assert.match(block, /catch \(e\) \{ console\.warn\('\[mock2\] removal-claim check failed open/,
    'a detector that can break a finish by throwing is worse than no detector');
});

test('RATCHET: a declared check is FORCED to run against the deployed app', () => {
  // Verifying the check EXISTS and never running it would only move the
  // unverified claim one step later — the smoke gate is where the claim is
  // actually falsified.
  const src = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  assert.match(src, /decision\.finishAcceptanceIds = \[\.\.\.new Set\(\[\.\.\.\(decision\.finishAcceptanceIds \|\| \[\]\), \.\.\.ids\]\)\]/);
});

test('RATCHET: finish accepts removals, and the build is told the rule', () => {
  const src = readFileSync(new URL('../mock2/runner-logic.js', import.meta.url), 'utf8');
  assert.match(src, /removals: \{/, 'the finish tool must accept the declaration');
  assert.match(src, /Claiming a removal \(binding\)/, 'and the build must be told before it is judged');
  assert.match(src, /expect_no_scroll/);
});

test('RATCHET: expect_no_scroll exists, or the motivating claim is unassertable', () => {
  // The whole feature demands a check for "I removed the scrollbar". A
  // scrollbar is not an element, so without this step kind the demand would be
  // impossible to satisfy honestly.
  const logic = readFileSync(new URL('../mock2/ui-check-logic.js', import.meta.url), 'utf8');
  assert.match(logic, /'expect_no_scroll'/);
  const exec = readFileSync(new URL('../mock2/ui-checks.js', import.meta.url), 'utf8');
  assert.match(exec, /case 'expect_no_scroll'/);
  assert.match(exec, /scrollHeight - el\.clientHeight/, 'measured, not eyeballed');
});

test('RATCHET: expect_no_scroll cannot be satisfied vacuously by naming the page', () => {
  // FOUND BY MEASUREMENT, NOT BY READING. The root element's overflow
  // propagates to the VIEWPORT, so on `body`/`html`/`:root` the element's own
  // computed value describes nothing: a page with 3000px of content reports
  // `overflow-y: visible` on all three while window.scrollTo(0, 500) really
  // moves it 500px. Under the plain element rule that read as "does not
  // scroll".
  //
  // That is not a cosmetic miss. `expect_no_scroll` is in FALSIFYING_STEPS, so
  // `{ "expect_no_scroll": "body" }` would have been accepted as proof that a
  // removal happened while being incapable of ever failing — the precise thing
  // badRefs exists to reject, smuggled in through this feature's own new step.
  const exec = readFileSync(new URL('../mock2/ui-checks.js', import.meta.url), 'utf8');
  const block = exec.slice(exec.indexOf("case 'expect_no_scroll'"), exec.indexOf("case 'expect_text'"));
  assert.ok(block.includes('doc.documentElement') && block.includes('doc.body'),
    'the page case must be recognised');
  assert.ok(block.includes('scrollingElement'),
    'and measured on what actually scrolls, not on the element named');
  assert.ok(/=== 'visible'/.test(block),
    "on the viewport `visible` scrolls — treating it as unscrollable is the vacuous pass");
  assert.ok(FALSIFYING_STEPS.includes('expect_no_scroll'),
    'if this ever stops counting as falsifying evidence, the ratchet above is moot');
});

test('a declared removal survives normalisation exactly once', () => {
  // The verdict carries the NORMALISED declarations because the runner has to
  // force those ids into the smoke run. Re-deriving them from the raw input
  // there was a second normaliser: this one trims, caps and accepts `checkId`,
  // so `" note-detail "` cleared the gate and then went to smoke untrimmed —
  // and an id matching no check is a HARD smoke failure, i.e. a stray space
  // could kill the build. The camelCase spelling failed the other way, clearing
  // the gate and silently never running.
  const spec = { checks: [{ id: 'note-detail', steps: [{ expect_absent: '#del' }] }] };
  const v = removalCoverage({
    summary: 'removed the detail Delete button',
    removals: [{ what: 'the detail Delete button', checkId: '  note-detail  ' }],
    spec,
  });
  assert.equal(v.ok, true, 'the alias and the padding are both tolerated at the gate');
  assert.deepEqual(v.declared.map((d) => d.checkId), ['note-detail'],
    'and what comes back out is what smoke can actually resolve');
});

test('RATCHET: the runner forces the NORMALISED ids, not the raw ones', () => {
  const src = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  assert.match(src, /\(verdict\.declared \|\| \[\]\)\.map\(\(r\) => r\.checkId\)/,
    'reading r.check_id off the raw payload reintroduces both failure modes');
});

test('the operator warning names badRef-only verdicts too', () => {
  // A verdict can be not-ok purely because every declaration pointed at a check
  // that cannot fail. Logging only `uncovered` there prints an empty list and
  // reads as though nothing was wrong.
  const src = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('accepted with warning'), src.indexOf('accepted with warning') + 200);
  assert.ok(src.includes('...verdict.badRefs.map((b) => `${b.what || \'(unnamed)\'} — ${b.why}`)'),
    'the badRefs half must reach the log line');
  assert.ok(block.includes('unverified'), 'and it must be the value logged');
  // The operator-facing message already covered both halves; keep it that way.
  const msg = removalWarningMessage({ uncovered: [], badRefs: [{ what: 'the pill', why: 'no check named' }] });
  assert.match(msg, /the pill/);
});

test('claimWords drops noise and keeps the nouns', () => {
  assert.deepEqual(claimWords('the To-dos inner scrollbar'), ['to-dos', 'inner', 'scrollbar']);
  assert.deepEqual(claimWords('the "Saved" pill'), ['saved', 'pill']);
  assert.deepEqual(claimWords(''), []);
});
