// DESIGN OPTIONS — "it doesn't look right" must produce a choice, not a build.
//
// Project 44 spent three builds and two annotation rounds on "there is so much
// unused space above the text field". Every build satisfied the words; none of
// them fixed the problem, because nobody had said what the fix was. The feature
// under test replaces the guess with two or three named layouts.
//
// What matters here is the shape of that guarantee: a complaint routes to
// options, an INSTRUCTION does not, and three gradations of the same idea can
// never be presented as a choice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDesignOptionsIntent, parseDesignOptions, buildDesignOptionsPrompt,
  buildDesignOptionsTask, diagnosisMessage, optionMessage, optionsFailureMessage,
  pageFromComplaint, screensLabel, parseScreenViews, MIN_OPTIONS, MAX_OPTIONS, OPTION_STRATEGIES,
} from '../mock2/design-options-logic.js';

test('a complaint routes to options', () => {
  for (const q of [
    'this does not look right',
    "the dashboard doesn't feel professional",
    'the header looks cramped',
    'there is so much unused space above the text field',
    'too much wasted space at the top',
    'show me options for this screen',
    'what would look better here?',
    'this is poorly designed',
  ]) {
    assert.ok(detectDesignOptionsIntent(q), `should route: ${q}`);
  }
});

test('an INSTRUCTION does not — they have already decided', () => {
  // The whole feature is for people who know something is wrong and cannot name
  // the fix. Interviewing someone who just named it is the worse failure: it
  // costs a model call and returns options for a question nobody asked.
  for (const q of [
    'make it one row instead of two',
    'change it to a bottom bar',
    'move the search field above the list',
    'remove the subtitle',
    'add a back button to the header',
    'set the header height to 48px',
  ]) {
    assert.equal(detectDesignOptionsIntent(q), null, `should NOT route: ${q}`);
  }
});

test('an ordinary question is not a complaint', () => {
  for (const q of [
    'what does the smoke gate check?',
    'why did the build fail?',
    'how much did that cycle cost?',
    '',
    'x'.repeat(700),
  ]) {
    assert.equal(detectDesignOptionsIntent(q), null, `should NOT route: ${q}`);
  }
});

test('an explicit ask for options beats the instruction guard', () => {
  // "make it better — show me options" contains an instruction verb AND an
  // explicit request. The request wins: they asked for the thing by name.
  assert.ok(detectDesignOptionsIntent('make it nicer — show me options'));
});

test('the complained-about SCREEN is taken from the complaint', () => {
  // The capture is the expensive half. Options for the home page when they were
  // looking at /notes cost a browser run as well as a model call, and answer a
  // question nobody asked.
  assert.equal(pageFromComplaint('/notes does not look right'), '/notes');
  assert.equal(pageFromComplaint('the header on /admin/users feels cramped'), '/admin/users');
  assert.equal(pageFromComplaint('this looks wrong on /notes.'), '/notes', 'the full stop belongs to the sentence');
  assert.equal(detectDesignOptionsIntent('design options for /settings').page, '/settings');
});

test('and a slash that is not a route falls back', () => {
  for (const q of ['make it 1/2 width', 'the and/or row looks bad', 'this looks wrong', 'a / on its own']) {
    assert.equal(pageFromComplaint(q), '/', q);
  }
  assert.equal(pageFromComplaint('nothing here', '/notes'), '/notes', 'the caller\'s default wins when nothing is named');
});

const OPTS = (n) => JSON.stringify({
  diagnosis: 'Five stacked bands take 45% of the screen before the first line of the note.',
  recommended: 'Collapse the chrome',
  options: OPTION_STRATEGIES.slice(0, n).map((strategy, i) => ({
    name: `Option ${i}`,
    strategy,
    rationale: 'trades a little clarity for a lot of room',
    changes: ['drop the subtitle band', 'wrap the actions onto the title row'],
    gain: '~70px back',
    brief: 'Remove the subtitle band and move the two actions onto the title row.',
  })),
});

test('a well-formed reply parses', () => {
  const p = parseDesignOptions(OPTS(3));
  assert.equal(p.options.length, 3);
  assert.match(p.diagnosis, /45%/);
  assert.equal(p.recommended, 'Collapse the chrome');
  assert.equal(p.options[0].brief, 'Remove the subtitle band and move the two actions onto the title row.');
});

test('fences and surrounding prose are tolerated', () => {
  const p = parseDesignOptions(`Sure — here you go:\n\n\`\`\`json\n${OPTS(2)}\n\`\`\`\n\nHope that helps.`);
  assert.equal(p.options.length, 2);
});

test('three gradations of one idea are ONE option, not three', () => {
  // The failure the whole feature exists to avoid: "tighter", "much tighter" and
  // "very tight" presented as a choice. Same strategy → same option.
  const doc = JSON.stringify({
    diagnosis: 'd',
    options: ['compact', 'compact', 'compact'].map((strategy, i) => ({
      name: `Tighter ${i}`, strategy, rationale: 'r', changes: ['c'], gain: 'g', brief: 'b',
    })),
  });
  assert.equal(parseDesignOptions(doc), null, 'one surviving option is below the minimum, so there is no choice to post');
});

test('two distinct strategies survive, duplicates do not', () => {
  const doc = JSON.stringify({
    diagnosis: 'd',
    options: [
      { name: 'A', strategy: 'compact', rationale: 'r', changes: ['c'], gain: 'g', brief: 'b1' },
      { name: 'B', strategy: 'compact', rationale: 'r', changes: ['c'], gain: 'g', brief: 'b2' },
      { name: 'C', strategy: 'relocate', rationale: 'r', changes: ['c'], gain: 'g', brief: 'b3' },
    ],
  });
  const p = parseDesignOptions(doc);
  assert.deepEqual(p.options.map((o) => o.name), ['A', 'C']);
});

test('an option with no brief is DROPPED, not repaired', () => {
  // The brief is what the operator presses a button to run. A half-written one
  // is worse than one fewer option.
  const doc = JSON.stringify({
    diagnosis: 'd',
    options: [
      { name: 'A', strategy: 'compact', rationale: 'r', changes: ['c'], gain: 'g', brief: 'do the thing' },
      { name: 'B', strategy: 'relocate', rationale: 'r', changes: ['c'], gain: 'g' },
      { name: 'C', strategy: 'restructure', rationale: 'r', changes: ['c'], gain: 'g', brief: 'do the other thing' },
    ],
  });
  assert.deepEqual(parseDesignOptions(doc).options.map((o) => o.name), ['A', 'C']);
});

test('fewer than the minimum is no answer at all', () => {
  const doc = JSON.stringify({
    diagnosis: 'd',
    options: [{ name: 'A', strategy: 'compact', rationale: 'r', changes: ['c'], gain: 'g', brief: 'b' }],
  });
  assert.equal(parseDesignOptions(doc), null);
  assert.equal(MIN_OPTIONS, 2);
});

test('more than the maximum is capped', () => {
  const p = parseDesignOptions(OPTS(4));
  assert.equal(p.options.length, MAX_OPTIONS);
});

test('garbage parses to null rather than throwing', () => {
  for (const s of ['', 'no json here', '{not json}', '{"options": "nope"}', null, undefined]) {
    assert.equal(parseDesignOptions(s), null);
  }
});

test('an unknown strategy does not disqualify an option', () => {
  // The strategy list is how duplicates are detected, not a validation gate — an
  // option with a real brief and a strategy nobody anticipated is still useful.
  const doc = JSON.stringify({
    diagnosis: 'd',
    options: [
      { name: 'A', strategy: 'invented', rationale: 'r', changes: ['c'], gain: 'g', brief: 'b1' },
      { name: 'B', strategy: 'also-invented', rationale: 'r', changes: ['c'], gain: 'g', brief: 'b2' },
    ],
  });
  const p = parseDesignOptions(doc);
  assert.equal(p.options.length, 2);
  assert.equal(p.options[0].strategy, '', 'an unrecognised strategy is cleared, not kept');
});

test('each option is its own message, so each gets a Build button', () => {
  // An assistant message with no cycle_id already renders the "Build this as a
  // Quick update" chip. Posting one message per option is what gives every
  // option a working button with no new UI — and the brief must be the LAST
  // section, because that is what the distiller reads.
  const p = parseDesignOptions(OPTS(2));
  const m = optionMessage(p.options[0], 0, 2);
  assert.match(m, /Option 1 of 2/);
  assert.match(m, /compact/);
  assert.ok(m.trimEnd().endsWith(p.options[0].brief), 'the brief closes the message');
});

test('the diagnosis message says nothing has changed', () => {
  const p = parseDesignOptions(OPTS(2));
  const m = diagnosisMessage(p, { page: '/notes' });
  assert.match(m, /\/notes/);
  assert.match(m, /Nothing has changed yet/i);
  assert.match(m, /Build this as a Quick update/);
  assert.match(m, /I would pick/);
});

test('the failure messages distinguish which half failed', () => {
  // "try again" and "say more" are different actions; so is "the app is down".
  assert.match(optionsFailureMessage('unparseable'), /Ask again/);
  assert.match(optionsFailureMessage('no-shots'), /online/);
  assert.match(optionsFailureMessage('rate limited'), /rate limited/);
  for (const r of ['unparseable', 'no-shots', 'anything']) {
    assert.match(optionsFailureMessage(r), /[Nn]othing was changed/);
  }
});

test('the prompt forbids the two things that made project 44 expensive', () => {
  const p = buildDesignOptionsPrompt();
  assert.match(p, /NOT writing code/, 'nothing is applied');
  assert.match(p, /Reclaimed space must go somewhere that MATTERS/,
    'giving the space to an empty box is the same defect renamed — build 2 did exactly that');
  assert.match(p, /smallest change first/);
  assert.match(p, /platform-owned/, 'the platform files are never edited');
  for (const s of OPTION_STRATEGIES) assert.ok(p.includes(s), `the prompt names ${s}`);
});

test('the task carries the measurements and the operator\'s own words', () => {
  const t = buildDesignOptionsTask({
    projectName: 'N10',
    complaint: 'so much unused space above the text field',
    page: '/notes',
    measurements: '- /notes at 390px: 3 fact(s) visible before scrolling.',
    designNote: 'The approved design defines these component classes — prefer them: card, chip.',
    shots: [{ path: '/notes', width: 390 }, { path: '/notes', width: 1280 }],
  });
  assert.match(t, /N10/);
  assert.match(t, /so much unused space/);
  assert.match(t, /3 fact\(s\)/);
  assert.match(t, /card, chip/);
  assert.match(t, /\/notes@390px, \/notes@1280px/);
});

test('the design-options step is registered with its own model override', async () => {
  const { HARNESS_STEPS } = await import('../mock2/harness-steps-logic.js');
  const step = HARNESS_STEPS.find((s) => s.id === 'design-options');
  assert.ok(step, 'the step must exist or callStepTurn cannot dispatch it');
  assert.equal(step.envModelVar, 'MOCK2_DESIGN_OPTIONS_MODEL');
  assert.equal(step.tunable, true, 'the operator can tune every other step; this one is no different');
});

test('the design-options prompt is renderable from the prompt registry', async () => {
  const { STEP_PROMPT_SPECS } = await import('../mock2/harness-prompts-logic.js');
  const entry = STEP_PROMPT_SPECS['design-options'];
  assert.ok(entry, 'the operator must be able to read and tune this prompt like every other');
  assert.deepEqual(entry.placeholders, []);
  assert.match(entry.render(), /senior product designer/);
});

// ---- the screen picker (all screens / chosen screens) ----

test('screensLabel: all screens, a single route, and a chosen set', () => {
  assert.equal(screensLabel([], true), 'all screens');
  assert.equal(screensLabel(['/admin'], false), '/admin');
  assert.equal(screensLabel(['/admin', '/notes'], false), '/admin, /notes');
  assert.equal(screensLabel([], false), '/'); // nothing chosen falls back to home
});

test('buildDesignOptionsTask: multi-screen runs tell the model to name the screen per option', () => {
  const t = buildDesignOptionsTask({ page: '/admin, /notes', multi: true, complaint: 'everything feels cramped' });
  assert.match(t, /Screens: \/admin, \/notes/);
  assert.match(t, /start each option's name with the screen/i);
  // Single-screen stays as before — no per-screen naming demand.
  const single = buildDesignOptionsTask({ page: '/admin', complaint: 'cramped' });
  assert.match(single, /Screen: \/admin/);
  assert.doesNotMatch(single, /start each option's name with the screen/i);
});

test('buildDesignOptionsTask: operator-attached images are announced with their count', () => {
  const t = buildDesignOptionsTask({ page: '/', complaint: 'see pins', attachedCount: 2 });
  assert.match(t, /attached 2 image\(s\) of their own/);
  assert.match(t, /numbered red pins/);
  assert.doesNotMatch(buildDesignOptionsTask({ page: '/' }), /image\(s\) of their own/);
});

test('parseScreenViews: container grep output becomes selectable /#panel entries, deduped, file mapped to route', () => {
  const out = [
    '/srv/app/public/app-shell.html|data-screen="notes"|data-screen="note-detail"|',
    '/srv/app/public/admin.html|data-screen="users"|',
    '/srv/app/public/login.html|',
    '/srv/app/public/app-shell.html|data-screen="notes"|', // duplicate line
    '',
  ].join('\n');
  const views = parseScreenViews(out);
  assert.deepEqual(views.map((v) => v.key), ['/#notes', '/#note-detail', '/admin#users']);
  assert.equal(views[0].page, '/');
  assert.equal(views[2].panel, 'users');
  assert.deepEqual(parseScreenViews(''), []);
});
