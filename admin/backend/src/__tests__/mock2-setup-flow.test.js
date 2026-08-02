// GUIDED SETUP — the first-run path.
//
// Creating a project dropped you on a page with fifteen cards and no order, so
// the common first move was to type one sentence into the prompt box and hope.
// That sentence is what the mockup is generated from, what the inventory is
// extracted from, what the first build's instruction is composed from, and what
// both the adherence gate and the design review measure the app against.
//
// Two properties matter more than the questions: nothing may BLOCK (skipping
// every step must reproduce the previous behaviour exactly), and every step's
// done-state must be DERIVED (a progress counter that can desync from reality
// is worse than no panel).
//
// Native-free (risk R9): the step logic is pure; the container reads and the
// app-context push are asserted by reading the source, like the other lanes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SETUP_STEPS, SETUP_STEP_IDS, INTAKE_FIELDS, INTAKE_KEYS,
  parseSetupIntake, renderSetupIntake, hasIntakeAnswers,
  setupStepStates, currentSetupStep, setupComplete, setupProgress, shouldShowSetup,
  composeAppContext, intakeBriefPreamble, intakeBuildSection, intakeDesignHint,
} from '../mock2/setup-flow-logic.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

const FULL = { audience: 'Shift supervisors at 4 care homes', summary: 'Tracks who is covering which shift', problem: 'Uncovered shifts are found at handover' };

test('the intake asks three things, and "copy" is not one of them', () => {
  // Copy was in the original sketch and came out: before there are screens
  // there is nothing for copy to attach to. It lives in the asset library and
  // becomes useful the moment there is a screen to write it for.
  assert.deepEqual(INTAKE_KEYS, ['audience', 'summary', 'problem']);
  for (const f of INTAKE_FIELDS) {
    // A placeholder in the SHAPE of an answer, not a description of one:
    // "e.g. a description of your users" gets you a description of the users.
    assert.ok(f.placeholder.length > 20, `${f.key} needs a real example`);
    assert.ok(!/^e\.g\.|^describe|^enter /i.test(f.placeholder), `${f.key}'s placeholder must be an answer, not an instruction`);
    assert.ok(f.hint.length > 20, `${f.key} must say why it is asked`);
  }
  assert.deepEqual(SETUP_STEP_IDS, ['project', 'account', 'brand', 'about', 'design', 'approve']);
  assert.equal(SETUP_STEPS.length, 6);
});

test('every step derives its own done-state — there is no counter to desync', () => {
  const nothing = setupStepStates({});
  assert.equal(setupProgress(nothing).done, 0);
  assert.equal(setupComplete(nothing), false);

  const done = setupStepStates({
    provisioned: true, appReachable: true, hasRealAdmin: true,
    hasLogo: true, intake: FULL, hasMockup: true, designApproved: true,
  });
  assert.equal(setupComplete(done), true);
  assert.equal(currentSetupStep(done), null, 'nothing left to show');
  assert.deepEqual(setupProgress(done), { done: 6, total: 6 });

  // Each fact moves exactly its own step, which is what makes the panel safe
  // to compute from data other features already maintain.
  const only = (facts) => setupStepStates({ provisioned: true, appReachable: true, ...facts })
    .filter((s) => s.done).map((s) => s.id);
  assert.deepEqual(only({}), ['project']);
  assert.deepEqual(only({ hasLogo: true }), ['project', 'brand']);
  assert.deepEqual(only({ intake: FULL }), ['project', 'about']);
  assert.deepEqual(only({ hasRealAdmin: true }), ['project', 'account']);
});

test('a provisioning container is WAITING, never failed', () => {
  // The account step needs the app serving, and provisioning takes a minute.
  // "Blocked" has to read as "not yet" or a slow deploy looks like a broken
  // product on the operator's very first screen.
  // Still provisioning: step one is itself unfinished, and it says so rather
  // than showing an inert page.
  const early = setupStepStates({ provisioned: false });
  assert.equal(currentSetupStep(early).id, 'project');
  assert.match(early[0].detail, /about a minute/);

  // Container up, app still booting — the case that actually strands people.
  const booting = setupStepStates({ provisioned: true, appReachable: false });
  const account = booting.find((x) => x.id === 'account');
  assert.equal(account.done, false);
  assert.equal(account.blocked, true);
  assert.match(account.detail, /carry on and do this later/);
  // The panel moves PAST it rather than parking there — nothing between here
  // and the first build needs that account.
  assert.equal(currentSetupStep(booting).id, 'brand');

  // "About" is answerable IMMEDIATELY in both states, because the answers land
  // on the project row rather than in the app. That is why they live there.
  for (const s of [early, booting]) {
    assert.equal(s.find((x) => x.id === 'about').blocked, false);
  }
});

test('approval is a step, not a wall', () => {
  // build_unlocked is false until the design is approved. Shown as a step you
  // complete rather than discovered as a barrier.
  const s = setupStepStates({ provisioned: true, appReachable: true, hasMockup: false });
  const approve = s.find((x) => x.id === 'approve');
  assert.equal(approve.blocked, true, 'nothing to approve before there is a mockup');
  assert.match(approve.blurb, /unlocks Build/);
  const withMockup = setupStepStates({ provisioned: true, appReachable: true, hasMockup: true });
  assert.equal(withMockup.find((x) => x.id === 'approve').blocked, false);
});

test('the panel hides itself on classic, on dismiss, and when it is finished', () => {
  const mid = setupStepStates({ provisioned: true });
  assert.equal(shouldShowSetup({ mode: 'guided', intake: parseSetupIntake(null), states: mid }), true);
  // The admin toggle.
  assert.equal(shouldShowSetup({ mode: 'classic', intake: parseSetupIntake(null), states: mid }), false);
  // Dismissed is NOT the same as finished — an operator who skipped everything
  // has dismissed it, and calling that "done" would be a lie about their app.
  assert.equal(shouldShowSetup({ mode: 'guided', intake: { dismissed: true }, states: mid }), false);
  const all = setupStepStates({
    provisioned: true, appReachable: true, hasRealAdmin: true, hasLogo: true,
    intake: FULL, hasMockup: true, designApproved: true,
  });
  assert.equal(shouldShowSetup({ mode: 'guided', intake: parseSetupIntake(null), states: all }), false);
});

test('the answers survive a hand-edited or missing column', () => {
  for (const bad of [null, undefined, '', 'not json', '[]', '{"audience":']) {
    const p = parseSetupIntake(bad);
    assert.equal(hasIntakeAnswers(p), false, `${JSON.stringify(bad)} parses to empty`);
    assert.equal(p.dismissed, false);
  }
  const round = parseSetupIntake(renderSetupIntake({ ...FULL, dismissed: true, pushedAt: '2026-07-28T00:00:00.000Z' }));
  assert.equal(round.audience, FULL.audience);
  assert.equal(round.dismissed, true);
  assert.equal(round.pushedAt, '2026-07-28T00:00:00.000Z');
  // Junk types are coerced, never trusted.
  assert.equal(parseSetupIntake({ audience: { nope: 1 }, dismissed: 'yes' }).dismissed, false);
});

test('the answers have TWO destinations, which is the point of asking', () => {
  // (1) the app's own self-description, rendered on its sign-in screen.
  const ctx = composeAppContext(FULL);
  assert.match(ctx.summary, /Tracks who is covering which shift\./);
  assert.match(ctx.summary, /It exists because uncovered shifts are found at handover\./,
    'the problem folds into the summary — AppContext has no field for it, and forking that contract would break every app that implements it');
  assert.equal(ctx.audience, FULL.audience);
  assert.equal(composeAppContext({}), null, 'nothing answered → nothing pushed');

  // (2) the mockup brief, as context ahead of the operator's own prompt.
  const pre = intakeBriefPreamble(FULL);
  assert.match(pre, /WHO THIS IS FOR/);
  assert.match(pre, /THE PROBLEM IT SOLVES/);
  assert.match(pre, /biggest, densest and first/);
  assert.match(pre, /Do not restate any of this back as body copy/, 'or the audience ends up printed on the screen');
  assert.equal(intakeBriefPreamble({}), '', 'a project that answered nothing pays nothing');
});

test('the first build is told who the app is for', () => {
  // The initial build instruction is a template — "implement every screen,
  // field and action the inventory defines" — which took 110 turns and $9.65 on
  // project 46 against 39 turns and $2.53 for a brief that said what to build.
  // The template cannot be made specific in general; it CAN carry the audience.
  const sec = intakeBuildSection(FULL);
  assert.match(sec, /It is for Shift supervisors at 4 care homes\./);
  assert.match(sec, /it does not add scope/, 'a build must not read this as permission to build more');
  assert.equal(intakeBuildSection({}), '');
  assert.equal(intakeBuildSection(null), '');

  // And the operator can see what the render is working from before spending a
  // mockup on it.
  assert.match(intakeDesignHint(FULL), /Designing for Shift supervisors at 4 care homes — Uncovered/);
  assert.equal(intakeDesignHint({}), '');
  assert.match(intakeDesignHint({ audience: 'nurses' }), /^Designing for nurses$/);
});

test('skipping everything reproduces the previous behaviour exactly', () => {
  // The promise the whole feature rests on: an operator who answers nothing
  // must get today's pipeline, byte for byte. Every downstream contribution is
  // an empty string when the intake is empty.
  const empty = parseSetupIntake(null);
  assert.equal(intakeBriefPreamble(empty), '');
  assert.equal(intakeBuildSection(empty), '');
  assert.equal(intakeDesignHint(empty), '');
  assert.equal(composeAppContext(empty), null);
});

test('setup is wired: routes, the concept brief, the build instruction, the panel', () => {
  const routes = read('mock2/routes.js');
  assert.match(routes, /projects\/:id\/setup'/);
  assert.match(routes, /setup\/intake/);
  assert.match(routes, /settings\/setup-flow/);

  // The two destinations, in the code that actually sends them.
  const concept = read('mock2/concept.js');
  assert.match(concept, /intakeBriefPreamble\(setupIntake\)/, 'the mockup must receive the audience');
  assert.match(concept, /intakeBuildSection\(projectIntake\(fresh\)\)/, 'and so must the first build');

  // The push goes through the app's OWN endpoint with the platform's existing
  // admin fixture — not a direct table write, and not a second credential.
  const flow = read('mock2/setup-flow.js');
  assert.match(flow, /api\/admin\/branding/);
  assert.match(flow, /ensureReviewAccount/);
  assert.match(flow, /--data-binary @"\$BODY"/, 'the payload goes in through a file, never an argv');
  assert.match(flow, /--data-binary @"\$CRED"/, 'and so do the credentials');
  assert.match(flow, /trap 'rm -f "\$BODY" "\$CRED" "\$JAR"' EXIT INT TERM/);
  // Retried on later reads, so answers given while the app was down are not lost.
  assert.match(flow, /if \(!code \|\| !\/\^2\/\.test\(code\)\) return false;/);

  const panel = readFileSync(path.join(here, '..', '..', '..', 'frontend', 'src', 'components', 'mock2', 'ProjectSetup.jsx'), 'utf8');
  // The classic setting is still a real off-switch for the checklist card.
  assert.match(panel, /state\.mode && state\.mode !== 'guided'/, 'the card obeys the server classic setting');
  const detail = readFileSync(path.join(here, '..', '..', '..', 'frontend', 'src', 'pages', 'ProjectDetail.jsx'), 'utf8');
  assert.match(detail, /<ProjectSetup/);
  // ONE home, inside the Details tab (operator request: only under Details →
  // Overview, never also above the tab strip) — so it renders after the tab
  // strip, not before it, and exactly once.
  assert.ok(detail.indexOf('<ProjectSetup') > detail.indexOf('<TabsList'), 'setup lives inside the Details tab, not above the tab strip');
  assert.equal(detail.match(/<ProjectSetup/g).length, 1, 'the checklist renders in exactly one place');
});

test('the default is guided, and classic is a real off-switch', () => {
  const settings = read('mock2/settings.js');
  assert.match(settings, /export const SETUP_FLOW_KEY = 'setup_flow';/);
  // Default-on: anything that is not the literal 'classic' resolves to guided,
  // including an unset key, so no migration or backfill is needed.
  assert.match(settings, /v === SETUP_FLOW_CLASSIC \? SETUP_FLOW_CLASSIC : SETUP_FLOW_GUIDED/);
  const admin = readFileSync(path.join(here, '..', '..', '..', 'frontend', 'src', 'pages', 'AdminQueue.jsx'), 'utf8');
  assert.match(admin, /First-run setup flow/);
  assert.match(admin, /Guided \(default\)/);
  assert.match(admin, /Classic — straight to the project page/);
});
