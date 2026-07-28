// THE SHELL CONTRACT — why "hide the nav" was impossible, and what replaced it.
//
// Reported as: "I was able to get some changes done in the top nav bar but it
// seemed to be blocked during larger changes (say if asking to hide it or move
// it to the side)."
//
// Nothing refused the edit. `public/app-shell.html` is app-owned and a build may
// rewrite it. What blocked it was the platform's OWN baseline check:
//
//     expect_visible: 'header'
//     expect_visible: '.theme-toggle'
//     expect_visible: '[data-legal-footer]'
//
// A padding tweak leaves the header visible and passes. Hiding it, moving it to
// a sidebar, or folding its controls into a menu fails — the build goes red for
// doing exactly what it was asked. Small changes worked, large ones did not,
// and the reason was a check asserting SHAPE where it meant to assert a
// GUARANTEE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SHELL, NAV_LAYOUTS, SHELL_CONTRACT_PATH,
  parseShellContract, shellShellSteps, shellAdminSteps,
  shellContractInstructions, shellContractNote,
} from '../mock2/shell-contract-logic.js';
import { buildBaselineChecks, withBaselineChecks } from '../mock2/ui-check-logic.js';

const parse = (o) => parseShellContract(JSON.stringify(o));
const selectors = (steps) => steps.map((s) => s.expect_visible || `click:${s.click}`);

test('AN APP THAT SAYS NOTHING IS CHECKED EXACTLY AS BEFORE', () => {
  // The whole change must be invisible to every existing project. If the
  // default drifts, this stops being a fix and becomes a migration.
  assert.deepEqual(shellShellSteps(), [
    { expect_visible: 'header' },
    { expect_visible: '.theme-toggle' },
    { expect_visible: '[data-legal-footer]' },
  ]);
  assert.deepEqual(shellShellSteps(null), shellShellSteps());
  // THE ADMIN ROUTE IS THE ONE DELIBERATE EXCEPTION, and it is a fix rather
  // than a drift: it no longer asserts a header at all. `header` matched the
  // platform console by coincidence — both it and the default app shell have a
  // bare <header> — which is exactly why applying the app's OWN selector there
  // stayed invisible until a build declared `header.topbar` and lost three
  // cycles to it. See the admin-route test below.
  assert.deepEqual(shellAdminSteps(), [{ expect_visible: '#add-role' }]);
});

test('A SIDEBAR IS A LAYOUT, NOT A FAILURE', () => {
  const steps = shellShellSteps(parse({ nav: 'side', navSelector: 'aside.app-nav' }));
  assert.deepEqual(selectors(steps), ['aside.app-nav', '.theme-toggle', '[data-legal-footer]']);
  assert.ok(!selectors(steps).includes('header'), 'it must stop demanding the element the app removed');
});

test('A HIDDEN NAV ASSERTS NO CONTAINER — AND STILL PROVES EVERYTHING ELSE', () => {
  const steps = shellShellSteps(parse({ nav: 'hidden' }));
  assert.deepEqual(selectors(steps), ['.theme-toggle', '[data-legal-footer]']);
  // The guarantees are what the check exists for; only the shape was negotiable.
  assert.ok(selectors(steps).includes('.theme-toggle'));
  assert.ok(selectors(steps).includes('[data-legal-footer]'));
});

test('A CONTROL BEHIND A MENU IS REACHABLE, SO THE CHECK OPENS IT', () => {
  // A check that cannot open a menu is a check that has banned menus — which is
  // most of what "move it to the side" means on a phone.
  const steps = shellShellSteps(parse({ nav: 'side', navSelector: 'aside.nav', menuOpener: '#nav-toggle' }));
  assert.deepEqual(selectors(steps), ['aside.nav', 'click:#nav-toggle', '.theme-toggle', '[data-legal-footer]']);
  assert.equal(steps[1].click, '#nav-toggle');
  assert.ok(steps.indexOf(steps.find((s) => s.click)) < steps.findIndex((s) => s.expect_visible === '.theme-toggle'),
    'the menu must be opened BEFORE the control inside it is asserted');
});

test('the guarantees can never be declared away', () => {
  // Every layout, however exotic, still proves the theme control and the legal
  // footer. A contract that could drop them would be an off switch for the
  // checks rather than a description of the app.
  for (const nav of NAV_LAYOUTS) {
    const sel = selectors(shellShellSteps(parse({ nav })));
    assert.ok(sel.includes('.theme-toggle'), nav);
    assert.ok(sel.includes('[data-legal-footer]'), nav);
  }
  // Even an app that tries to blank them out gets the defaults back.
  const blanked = parse({ themeSelector: '', legalSelector: '' });
  assert.equal(blanked.themeSelector, DEFAULT_SHELL.themeSelector);
  assert.equal(blanked.legalSelector, DEFAULT_SHELL.legalSelector);
});

test('a selector that would break the check spec is refused', () => {
  // These get spliced into a JSON check document; a quote or a newline in one
  // yields a broken battery rather than a passing app.
  for (const bad of ['aside["x"]', "aside['x']", 'aside\nnav', 'a'.repeat(200)]) {
    assert.equal(parse({ navSelector: bad }).navSelector, DEFAULT_SHELL.navSelector, bad.slice(0, 20));
  }
});

test('an unknown nav value falls back rather than disabling the container check', () => {
  assert.equal(parse({ nav: 'floating' }).nav, 'top');
  assert.equal(parse({ nav: null }).nav, 'top');
});

test('malformed JSON is the default, not a crash', () => {
  for (const s of ['', 'not json', '[]', 'null', undefined]) {
    assert.deepEqual(parseShellContract(s), { ...DEFAULT_SHELL });
  }
});

test('THE ADMIN ROUTE IS NOT THE APP\'S SHELL', () => {
  // /admin is the PLATFORM's console, reached by a link. The contract at
  // state/shell.json describes the app's OWN screens, and applying its
  // navSelector here demanded the app's chrome on a page the app is
  // explicitly encouraged not to rebuild.
  //
  // Project 47 lost three cycles and $10.28 to it: the build declared
  // `header.topbar` for its own screens, reasoned correctly that the console
  // "already exists at /admin … so I correctly link rather than rebuild", and
  // then failed platform-baseline-admin-reachable on `header.topbar`.
  //
  // Invisible until an app declared something specific, because the default
  // (`header`) happens to match the platform console too — so this asserts the
  // property for EVERY layout, not just the one that broke.
  for (const shell of [
    parse({ nav: 'top', navSelector: 'header.topbar' }),
    parse({ nav: 'side', navSelector: 'aside.app-nav' }),
    parse({ nav: 'hidden' }),
    parse({}),
    null,
  ]) {
    assert.deepEqual(selectors(shellAdminSteps(shell)), ['#add-role'],
      'the console proves itself by its own content, never by the app\'s chrome');
  }
  assert.deepEqual(selectors(shellAdminSteps(parse({ nav: 'top' }), '#other')), ['#other']);
});

/* --------------------- it reaches the checks that ran --------------------- */

test('the baseline battery uses the contract', () => {
  const checks = buildBaselineChecks({
    reviewerRole: 'platform', viewerRole: 'platform_viewer',
    shell: parse({ nav: 'hidden' }),
  });
  const shellCheck = checks.find((c) => c.id.endsWith('app-shell'));
  assert.ok(shellCheck);
  assert.ok(!selectors(shellCheck.steps).includes('header'),
    'the check that blocked "hide the nav" must follow the declaration');
});

test('and withBaselineChecks passes it through', () => {
  const spec = { login: null, checks: [] };
  const out = withBaselineChecks(spec, {
    reviewLogin: { email: 'a@fixture.invalid', password: 'p'.repeat(12) },
    shell: parse({ nav: 'side', navSelector: 'aside.app-nav' }),
  });
  const shellCheck = out.checks.find((c) => c.id.endsWith('app-shell'));
  assert.ok(selectors(shellCheck.steps).includes('aside.app-nav'));
});

test('with no contract, withBaselineChecks is byte-identical to before', () => {
  const spec = { login: null, checks: [] };
  const login = { email: 'a@fixture.invalid', password: 'p'.repeat(12) };
  const before = withBaselineChecks(spec, { reviewLogin: login });
  const shellCheck = before.checks.find((c) => c.id.endsWith('app-shell'));
  assert.deepEqual(shellCheck.steps, [
    { expect_visible: 'header' },
    { expect_visible: '.theme-toggle' },
    { expect_visible: '[data-legal-footer]' },
  ]);
});

/* ------------------------- the build has to be told ----------------------- */

test('THE BUILD IS TOLD THE PATH EXISTS', () => {
  // The other half of the bug: a build told "never edit platform-owned files"
  // and then failed by a check it could not see had no legitimate route at all,
  // so it either fought the gate or gave up. Both happened.
  const i = shellContractInstructions();
  assert.match(i, /You MAY change the shell's layout/);
  assert.match(i, /hide the top nav/);
  assert.match(i, /sidebar/);
  assert.ok(i.includes(SHELL_CONTRACT_PATH), 'it must name the file to write');
  assert.match(i, /in the same change/i, 'declaring it later is declaring it too late');
  assert.match(i, /at most one interaction/, 'the guarantee that is not negotiable');
});

test('RATCHET: the runner prompt carries the shell rule', async () => {
  // The instructions above are worthless if the build never sees them.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/runner-logic.js', import.meta.url), 'utf8');
  assert.match(src, /Restructuring the app shell \(binding\)/);
  assert.match(src, /state\/shell\.json/);
  assert.match(src, /"nav": "side"/);
});

test('RATCHET: the smoke gate actually reads the file', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/smoke.js', import.meta.url), 'utf8');
  assert.match(src, /parseShellContract/);
  assert.match(src, /withBaselineChecks\(parsed\.spec, \{ reviewLogin, viewerLogin, shell \}\)/,
    'reading the contract and not passing it is the same bug with more code');
});

test('the note explains a changed battery, and stays quiet otherwise', () => {
  assert.equal(shellContractNote(DEFAULT_SHELL), '', 'the default is not worth a line');
  assert.equal(shellContractNote(null), '');
  const n = shellContractNote(parse({ nav: 'side', navSelector: 'aside.nav', menuOpener: '#m' }));
  assert.match(n, /nav: side/);
  assert.match(n, /aside\.nav/);
  assert.match(n, /#m/);
});
