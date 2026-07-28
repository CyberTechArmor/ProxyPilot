// THE REQUEST CLARIFIER — and the two ways it can be wrong.
//
// It has one job: notice when a request has no outcome anyone could check, and
// offer one. It can fail in two directions and only one of them is visible:
//
//   MISSING a vague request costs one ordinary build. Annoying, recoverable.
//   INTERRUPTING a request that was already fine costs a decision every time,
//   and teaches the operator to dismiss the card without reading it. That is
//   the failure that kills the feature, so most of this file is about it.
//
// The definition being tested comes from two real projects built from a
// byte-identical starting instruction. The one that came out well had a median
// instruction of 174 characters and TWO builds that were literally "Please fix"
// and "Please update" — both of which succeeded, because the build before them
// was "Please complete the biometric login". The one that came out worse had a
// median of 865. Length is anti-correlated; a length heuristic would flag the
// good project and pass the bad one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldClarify, isContinuation, namesSomethingConcrete, pagesFromRequest,
  parseClarifyReply, composeWithGuesses, buildClarifyPrompt, buildClarifyTask,
  clarifyChatNote, normalizeClarifyMode, MIN_OPTIONS, MAX_OPTIONS,
} from '../mock2/clarify-logic.js';

const vaguePrepass = { specificity: 'vague', brief: { acceptance: [] } };
const clearPrepass = { specificity: 'clear', brief: { acceptance: ['the header is one row at 390px'] } };

/* ---------------------------- it must stay quiet --------------------------- */

test('A CONTINUATION IS NEVER CHALLENGED', () => {
  // The exact instructions from the project that came out best. Both are ten
  // and thirteen characters, both look maximally vague in isolation, and both
  // meant something exact because the previous turn said what.
  for (const q of ['Please fix', 'Please update', 'please fix', 'again']) {
    assert.equal(
      shouldClarify(q, { prepass: vaguePrepass, previousUserMessage: 'Please complete the biometric login' }).clarify,
      false,
      `"${q}" after a real request is a continuation, not a vague ask`,
    );
  }
  // A build that just failed is equally a referent, even with no prior message.
  assert.equal(shouldClarify('Please fix', { prepass: vaguePrepass, previousFailed: true }).clarify, false);
});

test('but a bare verb with NOTHING behind it is a fair question', () => {
  // First message on a project, nothing to continue from.
  assert.equal(shouldClarify('Please fix', { prepass: vaguePrepass }).clarify, true);
});

test('an image is specificity — they showed instead of telling', () => {
  assert.equal(shouldClarify('make this look better', { prepass: vaguePrepass, hasImages: true }).clarify, false);
});

test('a request that names a checkable outcome goes straight through', () => {
  const clear = [
    'put the cursor back where the server last saw it in the textbox',
    'make the header one row at 390px',
    'add a Forgot password? link below the submit button',
    'collapse the users table to cards below 640px',
    'change "Sign in" to "Welcome back"',
  ];
  for (const q of clear) {
    assert.equal(shouldClarify(q, { prepass: clearPrepass }).clarify, false, q);
  }
});

test('LENGTH IS NOT THE SIGNAL, in either direction', () => {
  // Short and specific: through. Long and vague: stopped. This is the pair that
  // a word-count heuristic gets exactly backwards.
  assert.equal(shouldClarify('put the to-dos on the right', { prepass: clearPrepass }).clarify, false);
  assert.equal(
    shouldClarify(
      'Please doublecheck the design and screens, fix any css issues you find, and please make '
      + 'recommendations for anything that would improve the overall look and feel of the application '
      + 'so that it feels more professional and modern to somebody seeing it for the first time',
      { prepass: vaguePrepass },
    ).clarify,
    true,
  );
});

test('the project can turn it off', () => {
  assert.equal(shouldClarify('make it nicer', { prepass: vaguePrepass, mode: 'off' }).clarify, false);
  assert.equal(normalizeClarifyMode('off'), 'off');
  assert.equal(normalizeClarifyMode('auto'), 'ask', 'there is no auto mode — silently rewriting a request is the one forbidden thing');
  assert.equal(normalizeClarifyMode(undefined), 'ask');
});

test('no pre-pass means FAIL QUIET, not fail loud', () => {
  // The pre-pass is disabled, timed out, or failed. Interrupting on no evidence
  // is the expensive mistake, so only a bare judgement with nothing named gets
  // stopped; everything else builds.
  assert.equal(shouldClarify('make it look better', { prepass: null }).clarify, true);
  assert.equal(shouldClarify('make the footer links readable', { prepass: null }).clarify, false,
    'it names an element — build it');
  assert.equal(shouldClarify('add a search box to /notes', { prepass: null }).clarify, false);
});

test('the pre-pass writing a concrete acceptance check settles it', () => {
  // The signal that was already being computed and thrown away: a model that
  // can say what would prove the change worked has been told a checkable thing.
  const r = shouldClarify('tighten the header', { prepass: { brief: { acceptance: ['the header is 56px tall'] } } });
  assert.equal(r.clarify, false);
  assert.match(r.reason, /acceptance/);
});

/* ------------------------------ it must fire ------------------------------ */

test('the requests that produced the WORSE app are stopped', () => {
  // Verbatim from that project's build history.
  const real = [
    'Please fix the spacing issue above the text box, as it looks bad (not designed well)',
    'Please doublecheck the design/screens (fix any css issues)',
    'make it more professional and modern',
    'the dashboard feels off',
  ];
  for (const q of real) {
    assert.equal(shouldClarify(q, { prepass: vaguePrepass }).clarify, true, q);
  }
});

test('every verdict carries a reason a person could read', () => {
  for (const [q, opts] of [
    ['make it nicer', { prepass: vaguePrepass }],
    ['Please fix', { prepass: vaguePrepass, previousUserMessage: 'x' }],
    ['make it nicer', { prepass: vaguePrepass, mode: 'off' }],
    ['add a /notes search box', { prepass: clearPrepass }],
  ]) {
    const r = shouldClarify(q, opts);
    assert.ok(r.reason && r.reason.length > 8, `no readable reason for: ${q}`);
  }
});

/* --------------------------- the targeted look ---------------------------- */

test('ONLY the pages the request refers to', () => {
  // "yes, but only the pages being referred to" — a question about /admin must
  // not cost a capture of /login, /profile and the home page.
  assert.deepEqual(pagesFromRequest('the /admin table looks wrong on mobile'), ['/admin']);
  assert.deepEqual(pagesFromRequest('/login and /profile are both cramped'), ['/login', '/profile']);
  assert.deepEqual(pagesFromRequest('make it nicer'), [], 'no page named, nothing captured');
  // At most three, so a request listing every route does not become a review.
  assert.equal(pagesFromRequest('/a /b /c /d /e').length, 3);
});

test('a slash that is not a route is not a page', () => {
  for (const q of ['make it 1/2 width', 'the and/or row', 'a / on its own']) {
    assert.deepEqual(pagesFromRequest(q), [], q);
  }
});

test('the pre-pass may add pages, and duplicates collapse', () => {
  assert.deepEqual(pagesFromRequest('fix /admin', ['/admin', '/profile']), ['/admin', '/profile']);
});

test('trailing punctuation belongs to the sentence, not the route', () => {
  assert.deepEqual(pagesFromRequest('something is wrong on /admin.'), ['/admin']);
});

/* ------------------------------- the output ------------------------------- */

const reply = (n) => JSON.stringify({
  diagnosis: 'The request names a feeling about the header but no element and no number.',
  question: 'Is the empty band the nav wrapping onto two rows, or the title block above it?',
  options: Array.from({ length: n }, (_, i) => ({
    label: `Option ${i}`,
    instruction: `Do the concrete thing number ${i}, naming an element and a number.`,
    checkable: `The thing is ${i}px tall at 390px.`,
  })),
});

test('a well-formed reply parses', () => {
  const p = parseClarifyReply(reply(3));
  assert.equal(p.options.length, 3);
  assert.match(p.diagnosis, /no element and no number/);
  assert.match(p.question, /wrapping onto two rows/);
});

test('fences and prose are tolerated', () => {
  assert.equal(parseClarifyReply(`Sure:\n\n\`\`\`json\n${reply(2)}\n\`\`\`\n`).options.length, 2);
});

test('an option with no instruction is dropped — the instruction IS the button', () => {
  const doc = JSON.stringify({
    diagnosis: 'd',
    options: [
      { label: 'A', instruction: 'do a' },
      { label: 'B' },
      { label: 'C', instruction: 'do c' },
    ],
  });
  assert.deepEqual(parseClarifyReply(doc).options.map((o) => o.label), ['A', 'C']);
});

test('two options that are the same option are one', () => {
  const doc = JSON.stringify({
    diagnosis: 'd',
    options: [
      { label: 'A', instruction: 'Tighten the header padding to 8px on every screen' },
      { label: 'B', instruction: 'Tighten the header padding to 8px on every screen' },
    ],
  });
  assert.equal(parseClarifyReply(doc), null, 'one surviving option is not a choice — build instead of asking');
});

test('fewer than two options is no card at all', () => {
  assert.equal(parseClarifyReply(reply(1)), null);
  assert.equal(MIN_OPTIONS, 2);
  assert.equal(parseClarifyReply(reply(5)).options.length, MAX_OPTIONS);
});

test('garbage parses to null rather than throwing', () => {
  for (const s of ['', 'no json', '{bad}', '{"options":"nope"}', null, undefined]) {
    assert.equal(parseClarifyReply(s), null);
  }
});

/* ---------------------- "Build it anyway" keeps the guesses ---------------- */

test('THE DECLINED OPTIONS RIDE ALONG AS GUESSES, NEVER AS SCOPE', () => {
  const parsed = parseClarifyReply(reply(2));
  const out = composeWithGuesses('make the header nicer', parsed);
  assert.match(out, /^make the header nicer/, 'the request is sent exactly as written, first');
  assert.match(out, /authoritative and was sent as written/);
  assert.match(out, /GUESSES/);
  assert.match(out, /not chosen by them/,
    'a guess presented as scope would be the clarifier overruling the person who just overruled it');
  assert.ok(out.includes('Do the concrete thing number 0'));
});

test('no guesses means the instruction is untouched', () => {
  assert.equal(composeWithGuesses('build the thing', null), 'build the thing');
  assert.equal(composeWithGuesses('build the thing', { options: [] }), 'build the thing');
});

/* ------------------------------- the prompt ------------------------------- */

test('the prompt carries both lenses and forbids the interview', () => {
  const p = buildClarifyPrompt();
  assert.match(p, /FRONT-END CRAFT/);
  assert.match(p, /DOMAIN/);
  assert.match(p, /not to interview them/, 'the 8-question interview this replaces was removed for exactly that');
  assert.match(p, /wrapping onto a second row/, 'the craft lens must know what usually causes what they describe');
  assert.match(p, /smallest change first/);
  assert.match(p, /Never invent a feature/);
  assert.match(p, /platform-owned/);
});

test('the task names the pages and says when it could not see them', () => {
  const withShots = buildClarifyTask({
    instruction: 'the /admin table is wrong', pages: ['/admin'],
    shots: [{ path: '/admin', width: 390 }],
  });
  assert.match(withShots, /\/admin@390px/);
  assert.match(withShots, /Read them/);

  const blind = buildClarifyTask({ instruction: 'x', pages: ['/admin'], shots: [] });
  assert.match(blind, /could not be screenshotted/, 'a blind read must say it is blind');

  const noPages = buildClarifyTask({ instruction: 'make it nicer', pages: [], shots: [] });
  assert.doesNotMatch(noPages, /could not be screenshotted/, 'no page named is not a capture failure');
});

test('the chat note records that nothing was built, and why', () => {
  const note = clarifyChatNote(parseClarifyReply(reply(2)), { pages: ['/admin'] });
  assert.match(note, /did not start a build/);
  assert.match(note, /\/admin/);
  assert.match(note, /Build it anyway/);
});

/* ------------------------------- the ratchets ----------------------------- */

test('namesSomethingConcrete recognises the four shapes that make a request actionable', () => {
  assert.ok(namesSomethingConcrete('fix /admin'), 'a route');
  assert.ok(namesSomethingConcrete('style the .filter-menu summary'), 'a selector');
  assert.ok(namesSomethingConcrete('make it 44px tall'), 'a measurement');
  assert.ok(namesSomethingConcrete('change it to "Welcome back"'), 'a quoted string');
  assert.ok(namesSomethingConcrete('the footer links are invisible'), 'a UI noun');
  assert.ok(!namesSomethingConcrete('make it look more professional'));
  assert.ok(!namesSomethingConcrete('it feels off'));
});

test('isContinuation needs BOTH a bare request and something to continue', () => {
  assert.ok(isContinuation('Please fix', { previousUserMessage: 'the login is broken' }));
  assert.ok(!isContinuation('Please fix', {}), 'nothing to continue from');
  assert.ok(!isContinuation('Please fix the admin table', { previousUserMessage: 'x' }),
    'it names an element, so it stands on its own and is not a continuation');
  assert.ok(!isContinuation('a'.repeat(200), { previousUserMessage: 'x' }), 'a long request is not a bare one');
});

test('RATCHET: the clarifier runs BEFORE the split and suggestion cards', async () => {
  // Decomposing a request nobody can check yet, or suggesting additions to it,
  // is answering a question before it has been asked — and it would make the
  // clarifier the second interruption in a row rather than the first.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  const clarify = src.indexOf('clarify_proposal');
  const split = src.indexOf('split_proposal:');
  const suggest = src.indexOf('suggest_proposal:');
  assert.ok(clarify > 0 && split > 0 && suggest > 0);
  assert.ok(clarify < split && clarify < suggest, 'the clarifier must be the first card, not the third');
});

test('RATCHET: it can never fail a build', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('if (!parsed.data.skip_clarify)'), src.indexOf('clarify_proposal') + 600);
  assert.match(block, /catch \{ \/\* fail-open/,
    'a clarifier that can break a build by failing is a gate wearing a helper\'s clothes');
});

test('RATCHET: it asks at most once per request', async () => {
  const { readFileSync } = await import('node:fs');
  const routes = readFileSync(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  assert.match(routes, /skip_clarify: z\.boolean\(\)\.optional\(\)/);
  const chat = readFileSync(new URL('../../../frontend/src/components/mock2/BuildChat.jsx', import.meta.url), 'utf8');
  // Both exits from the card must set it, or the card returns on the resend.
  assert.match(chat, /takeClarifyOption[\s\S]{0,400}skipClarify: true/);
  assert.match(chat, /buildAnyway[\s\S]{0,500}skipClarify: true/);
});

test('RATCHET: the step is registered and its prompt is tunable', async () => {
  const { HARNESS_STEPS } = await import('../mock2/harness-steps-logic.js');
  const step = HARNESS_STEPS.find((s) => s.id === 'clarify');
  assert.ok(step, 'callStepTurn cannot dispatch an unregistered step');
  assert.equal(step.envModelVar, 'MOCK2_CLARIFY_MODEL');
  assert.equal(step.tunable, true);
  const { STEP_PROMPT_SPECS } = await import('../mock2/harness-prompts-logic.js');
  assert.match(STEP_PROMPT_SPECS.clarify.render(), /FRONT-END CRAFT/);
});
