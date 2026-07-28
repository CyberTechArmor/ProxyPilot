// UI interaction checks (change-69 harness) — PURE logic tests, stub-first
// (risk R9). Imports only native-free modules: the ui-checks spec format, the
// path-glob triggering, the finish acceptance contract, and the smoke-trigger
// wiring. The Playwright executor is covered by mock2-ui-checks.e2e.test.js
// (skipped when playwright isn't installed) and the manual checklist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  UI_CHECKS_PATH, STEP_KINDS, parseUiChecks, checksForChangedFiles, stepShape, withPlatformLogin,
  uiCheckLogLines, uiCheckFailSummary,
  buildBaselineChecks, withBaselineChecks, isBaselineCheck, BASELINE_CHECK_PREFIX,
} from '../mock2/ui-check-logic.js';
import {
  RUNNER_TOOLS, classifyTurn, formatAcceptanceBlock, buildRunnerSystemPrompt,
} from '../mock2/runner-logic.js';

const VALID_SPEC = {
  login: {
    path: '/login', user_field: '#username', pass_field: '#password', submit: 'button[type=submit]',
    users: {
      admin: { username: 'smoke-admin', password: 'pw-a' },
      manager: { username: 'smoke-manager', password: 'pw-m' },
      viewer: { username: 'smoke-viewer', password: 'pw-v' },
    },
  },
  checks: [
    {
      id: 'adp-admin-credentials-editable',
      name: 'Admin can type ADP credentials and run Test connection',
      paths: ['public/settings*', 'src/routes/adp*'],
      role: 'admin',
      page: '/settings/connections',
      steps: [
        { expect_enabled: '#adp-client-id' },
        { fill: '#adp-client-id', value: 'smoke-cid', expect_value: true },
        { click: '#adp-replace' },
        { expect_enabled: '#adp-client-secret' },
        { fill: '#adp-client-secret', value: 'smoke-secret', expect_value: true },
        { expect_enabled: '#adp-test-connection' },
      ],
    },
    {
      id: 'viewer-read-only',
      paths: ['public/settings*'],
      role: 'viewer',
      page: '/settings/connections',
      steps: [
        { expect_disabled: '#adp-client-id' },
        { expect_visible: '#adp-status' },
      ],
    },
  ],
};

// ---- spec parsing / validation ----

test('parseUiChecks: accepts the canonical spec (roles, steps, paths)', () => {
  const r = parseUiChecks(JSON.stringify(VALID_SPEC));
  assert.equal(r.ok, true);
  assert.equal(r.spec.checks.length, 2);
  assert.equal(r.spec.checks[0].role, 'admin');
  assert.equal(r.spec.login.users.viewer.username, 'smoke-viewer');
});

test('parseUiChecks: rejects malformed specs with ONE clear error', () => {
  assert.equal(parseUiChecks('not json').ok, false);
  assert.equal(parseUiChecks('[]').ok, false);
  // a role with no login block
  assert.equal(parseUiChecks(JSON.stringify({ checks: [{ id: 'x', paths: ['a'], role: 'admin', page: '/p', steps: [{ click: '#b' }] }] })).ok, false);
  // a role with no fixture user
  const noUser = JSON.parse(JSON.stringify(VALID_SPEC));
  delete noUser.login.users.viewer;
  assert.match(parseUiChecks(JSON.stringify(noUser)).error, /viewer/);
  // a step asserting two things at once — one assertion per step, so a failure
  // names which one broke
  const badStep = JSON.parse(JSON.stringify(VALID_SPEC));
  badStep.checks[0].steps[0] = { expect_enabled: '#a', expect_disabled: '#a' };
  assert.match(parseUiChecks(JSON.stringify(badStep)).error, /more than one/);
  // a step asserting nothing at all
  const emptyStep = JSON.parse(JSON.stringify(VALID_SPEC));
  emptyStep.checks[0].steps[0] = { note: 'hello' };
  assert.match(parseUiChecks(JSON.stringify(emptyStep)).error, /exactly one/);
  // fill without value
  const noVal = JSON.parse(JSON.stringify(VALID_SPEC));
  noVal.checks[0].steps[1] = { fill: '#a' };
  assert.match(parseUiChecks(JSON.stringify(noVal)).error, /value/);
  // duplicate ids
  const dup = JSON.parse(JSON.stringify(VALID_SPEC));
  dup.checks[1].id = dup.checks[0].id;
  assert.match(parseUiChecks(JSON.stringify(dup)).error, /duplicate/);
  // no paths (a check nothing can trigger is a spec bug)
  const noPaths = JSON.parse(JSON.stringify(VALID_SPEC));
  noPaths.checks[0].paths = [];
  assert.match(parseUiChecks(JSON.stringify(noPaths)).error, /paths/);
});

// ---- path-based triggering ----

test('checksForChangedFiles: a diff picks exactly the checks whose globs match', () => {
  const { spec } = parseUiChecks(JSON.stringify(VALID_SPEC));
  // settings page touched → both checks (both declare public/settings*)
  assert.deepEqual(checksForChangedFiles(spec, ['public/settings.html']).map((c) => c.id),
    ['adp-admin-credentials-editable', 'viewer-read-only']);
  // only the ADP route touched → only the admin check
  assert.deepEqual(checksForChangedFiles(spec, ['src/routes/adp-connection.ts']).map((c) => c.id),
    ['adp-admin-credentials-editable']);
  // backend-only diff → no checks
  assert.deepEqual(checksForChangedFiles(spec, ['src/service/billing.ts']), []);
  assert.deepEqual(checksForChangedFiles(spec, []), []);
});

test('stepShape: normalizes each step kind for the executor', () => {
  assert.deepEqual(stepShape({ expect_enabled: '#a' }), { kind: 'expect_enabled', selector: '#a' });
  assert.deepEqual(stepShape({ fill: '#a', value: 'v', expect_value: true }), { kind: 'fill', selector: '#a', value: 'v', expectValue: true });
  assert.equal(stepShape({ fill: '#a', value: 'v' }).expectValue, true); // persist-assert is the default
  assert.deepEqual(stepShape({ expect_text: '#a', contains: 'ok' }), { kind: 'expect_text', selector: '#a', contains: 'ok' });
  assert.equal(STEP_KINDS.includes('expect_disabled'), true);
  assert.equal(UI_CHECKS_PATH, 'state/ui-checks.json');
});

test('uiCheckLogLines + uiCheckFailSummary: no silent results', () => {
  const results = [
    { id: 'a', role: 'admin', page: '/p', ok: true, steps: [{ ok: true, detail: 'x' }], consoleErrors: [] },
    { id: 'b', role: 'viewer', page: '/p', ok: false, steps: [{ ok: false, detail: '#adp-client-id is disabled — expected an enabled control' }], consoleErrors: [] },
    { id: 'c', role: null, page: '/q', ok: false, steps: [{ ok: true, detail: 'x' }], consoleErrors: ['TypeError: boom'] },
  ];
  const lines = uiCheckLogLines(results);
  assert.match(lines[0], /a \[admin \/p\]: PASS/);
  assert.match(lines[1], /FAIL — #adp-client-id is disabled/);
  assert.match(lines[2], /1 console error/);
  assert.match(uiCheckFailSummary(results), /b: #adp-client-id is disabled/);
});

// ---- finish acceptance contract ----

test('finish tool: acceptance + assumptions are REQUIRED in the schema', () => {
  const finish = RUNNER_TOOLS.find((t) => t.name === 'finish');
  assert.deepEqual(finish.input_schema.required, ['summary', 'acceptance', 'assumptions']);
  assert.equal(finish.input_schema.properties.acceptance.minItems, 1);
  assert.deepEqual(finish.input_schema.properties.assumptions.required, ['verified', 'assumed']);
});

test('classifyTurn: finish carries acceptance + assumptions; missing → empty/null for the runner to reject', () => {
  const full = classifyTurn([{ name: 'finish', input: {
    summary: 's',
    acceptance: ['as admin, type into Client ID — the value persists'],
    assumptions: { verified: ['src/routes/profile.ts: lowercase role slugs'], assumed: [] },
  } }]);
  assert.equal(full.done, true);
  assert.equal(full.finishAcceptance.length, 1);
  assert.deepEqual(full.finishAssumptions.assumed, []);

  const bare = classifyTurn([{ name: 'finish', input: { summary: 's' } }]);
  assert.equal(bare.done, true);
  assert.deepEqual(bare.finishAcceptance, []);
  assert.equal(bare.finishAssumptions, null);
});

test('formatAcceptanceBlock: renders the change-record evidence block', () => {
  const block = formatAcceptanceBlock(
    ['as admin, open Connection Settings, type into Client ID — value persists'],
    { verified: ['src/routes/profile.ts read this cycle'], assumed: [] },
  );
  assert.match(block, /^Acceptance:\n- as admin/);
  assert.match(block, /Assumptions verified:\n- src\/routes\/profile\.ts/);
  assert.match(block, /Assumptions assumed: \(none\)/);
});

test('buildRunnerSystemPrompt: instructs acceptance checks + verified-vs-assumed on finish', () => {
  const p = buildRunnerSystemPrompt({ constitution: 'C' });
  assert.match(p, /acceptance check/i);
  assert.match(p, /verified/i);
  assert.match(p, /assumed/i);
});

// The EXACT state/ui-checks.json project 38 wrote. The app deployed, served and
// worked; the build went red because every step used the conventional
// {action, selector, text} spelling instead of the canonical {expect_visible: …}
// one, and the login roster was a users[] array instead of a login block. Both
// forms say the same thing, so both parse.
test('project 38: the conventional step + roster spelling parses', () => {
  const spec = {
    schema_version: 1,
    users: [{ role: 'admin', email: 'ui-admin@fixture.invalid', password: 'Correct-Horse-9!' }],
    checks: [
      {
        id: 'notes-list-loads',
        description: 'Signed-in user lands on the Notes shelf with the New note action available.',
        page: '/',
        paths: ['public/app-shell.html', 'public/notes.css'],
        login: 'ui-admin@fixture.invalid',
        steps: [
          { action: 'expect_visible', selector: '#nav-new' },
          { action: 'expect_enabled', selector: '#nav-new' },
          { action: 'expect_text', selector: 'h1.n3-title', text: 'Notes' },
        ],
      },
      {
        id: 'note-create-and-edit',
        page: '/',
        paths: ['public/notes.js'],
        login: 'ui-admin@fixture.invalid',
        steps: [
          { action: 'click', selector: '#nav-new' },
          { action: 'fill', selector: '#note-title-input', text: 'Groceries' },
          { action: 'expect_value', selector: '#note-title-input', text: 'Groceries' },
        ],
      },
    ],
  };
  const r = parseUiChecks(JSON.stringify(spec));
  assert.equal(r.ok, true, r.error);

  // The roster becomes a login block using the base app's own sign-in form,
  // which the PLATFORM ships and therefore knows.
  assert.equal(r.spec.login.path, '/login');
  assert.match(r.spec.login.pass_field, /password/);
  assert.deepEqual(r.spec.login.users.admin, { username: 'ui-admin@fixture.invalid', password: 'Correct-Horse-9!' });

  // Per-check "login: <email>" resolves back to the role.
  assert.equal(r.spec.checks[0].role, 'admin');

  // Steps normalize to the canonical form the executor consumes.
  assert.deepEqual(r.spec.checks[0].steps, [
    { expect_visible: '#nav-new' },
    { expect_enabled: '#nav-new' },
    { expect_text: 'h1.n3-title', contains: 'Notes' },
  ]);
  // expect_value folds onto the fill it verifies — the canonical form's own flag.
  assert.deepEqual(r.spec.checks[1].steps, [
    { click: '#nav-new' },
    { fill: '#note-title-input', value: 'Groceries', expect_value: true },
  ]);
  // And the normalized steps drive the executor unchanged.
  assert.deepEqual(stepShape(r.spec.checks[1].steps[1]), {
    kind: 'fill', selector: '#note-title-input', value: 'Groceries', expectValue: true,
  });
});

test('expect_value must follow the fill it verifies', () => {
  const mk = (steps) => JSON.stringify({
    users: [{ role: 'admin', email: 'a@fixture.invalid', password: 'x'.repeat(12) }],
    checks: [{ id: 'c', page: '/', paths: ['a'], login: 'a@fixture.invalid', steps }],
  });
  // No preceding fill at all.
  assert.match(parseUiChecks(mk([{ action: 'expect_value', selector: '#a', text: 'v' }])).error, /must follow a fill/);
  // A fill of a DIFFERENT control — silently asserting the wrong field is worse
  // than refusing.
  assert.match(parseUiChecks(mk([
    { action: 'fill', selector: '#a', text: 'v' },
    { action: 'expect_value', selector: '#b', text: 'v' },
  ])).error, /previous fill targeted/);
});

test('an unknown action is named, not swallowed', () => {
  const spec = JSON.stringify({
    users: [{ role: 'admin', email: 'a@fixture.invalid', password: 'x'.repeat(12) }],
    checks: [{ id: 'c', page: '/', paths: ['a'], login: 'a@fixture.invalid', steps: [{ action: 'hover', selector: '#a' }] }],
  });
  assert.match(parseUiChecks(spec).error, /unknown action "hover"/);
});

/* -------------- signing the checks in when the spec did not say how --------- */
//
// Project 40's smoke run: `ui-check notes-list-loads [anonymous /]: FAIL —
// expect_visible #search: Timeout`, three times over. The spec declared no
// login block, so every check ran signed OUT, was bounced to /login by the auth
// gate, and timed out on elements that only exist behind it. Three checks that
// could never have passed, and a red build on top of a working app.

test('a spec with no login block runs as the platform reviewer', () => {
  const spec = parseUiChecks(JSON.stringify({
    checks: [
      { id: 'a', page: '/', paths: ['public/*.html'], steps: [{ expect_visible: '#search' }] },
      { id: 'b', page: '/notes', paths: ['public/*.js'], steps: [{ click: '#new' }] },
    ],
  })).spec;
  assert.equal(spec.login, null, 'the fixture starts with no login block');

  const signed = withPlatformLogin(spec, { email: 'design-review@fixture.invalid', password: 'x'.repeat(20) });
  assert.ok(signed.login, 'a login block is synthesised');
  assert.equal(signed.login.path, '/login');
  assert.equal(signed.login.users.platform.username, 'design-review@fixture.invalid');
  for (const c of signed.checks) assert.equal(c.role, 'platform', `${c.id} still runs anonymous`);
  // The PLATFORM's own account signs in through the API, not the sign-in page.
  // Driving the form means guessing which of its three states is showing, and
  // a build is free to restyle every control on it; neither is under test when
  // all we need is a session.
  assert.equal(signed.login.via, 'api');
});

test('a spec that DOES declare a login is left exactly alone', () => {
  // A check with no role there is an explicit choice to test the signed-out
  // state; overriding it would silently change what the build asked for.
  const spec = parseUiChecks(JSON.stringify({
    users: [{ role: 'admin', email: 'a@fixture.invalid', password: 'x'.repeat(12) }],
    checks: [
      { id: 'signed-in', page: '/', paths: ['a'], login: 'a@fixture.invalid', steps: [{ click: '#x' }] },
      { id: 'signed-out', page: '/login', paths: ['b'], steps: [{ expect_visible: '#email' }] },
    ],
  })).spec;
  const after = withPlatformLogin(spec, { email: 'design-review@fixture.invalid', password: 'x'.repeat(20) });
  assert.deepEqual(after, spec);
  assert.equal(after.checks.find((c) => c.id === 'signed-out').role, null);
});

test('with no reviewer account there is nothing to sign in as, and nothing changes', () => {
  const spec = parseUiChecks(JSON.stringify({
    checks: [{ id: 'a', page: '/', paths: ['x'], steps: [{ click: '#x' }] }],
  })).spec;
  assert.deepEqual(withPlatformLogin(spec, null), spec);
  assert.deepEqual(withPlatformLogin(spec, { email: 'a@b.c' }), spec);
});

/* --------------- the PLATFORM's own baseline checks ------------------------ */
//
// state/ui-checks.json is written by the build MODEL, and two builds in a row
// shipped one that passed the coverage gate and then failed the strict parser
// after deploy — so on those cycles NOTHING exercised the rendered app. These
// are derived from what the platform SHIPS, so they cannot be written wrong.

const REVIEWER = { email: 'design-review@fixture.invalid', password: 'x'.repeat(20) };
const VIEWER = { email: 'design-review-viewer@fixture.invalid', password: 'x'.repeat(20) };

test('"must not be offered" is expressible at all', () => {
  // Until expect_absent existed, the most common real defect in a generated app
  // — a route guarded in the UI for one role and not another — could not be
  // written as a check, so nothing ever checked it.
  assert.ok(STEP_KINDS.includes('expect_absent'));
  const parsed = parseUiChecks(JSON.stringify({
    users: [{ role: 'viewer', email: 'v@fixture.invalid', password: 'x'.repeat(12) }],
    checks: [{
      id: 'viewer-no-admin', page: '/', paths: ['public/**'], login: 'v@fixture.invalid',
      steps: [{ action: 'expect_absent', selector: '#admin-link' }],
    }],
  }));
  assert.ok(parsed.ok, parsed.error);
  // The conventional {action, selector} spelling must work for it too, or the
  // model writes it the way it writes everything else and the spec is rejected.
  assert.deepEqual(parsed.spec.checks[0].steps[0], { expect_absent: '#admin-link' });
  assert.equal(stepShape(parsed.spec.checks[0].steps[0]).kind, 'expect_absent');
});

test('the baseline asks the question a single admin fixture never could', () => {
  const checks = buildBaselineChecks({ reviewerRole: 'platform', viewerRole: 'platform_viewer' });
  const ids = checks.map((c) => c.id);
  assert.ok(ids.every((i) => i.startsWith(BASELINE_CHECK_PREFIX)));
  // The viewer must be denied the admin page by the SERVER, not merely have the
  // link hidden — so there is a check that types the URL.
  const denied = checks.find((c) => c.id.endsWith('viewer-denied-admin'));
  assert.ok(denied, 'a viewer-denied-admin check must exist');
  assert.equal(denied.page, '/admin');
  assert.equal(denied.role, 'platform_viewer');
  assert.deepEqual(denied.steps, [{ expect_absent: '#add-role' }]);
  // And a separate one for the nav, because hiding the link is a real (weaker)
  // requirement of its own.
  const notOffered = checks.find((c) => c.id.endsWith('viewer-not-offered-admin'));
  assert.deepEqual(notOffered.steps.at(-1), { expect_absent: '#admin-link' });
  // Baselines run on EVERY cycle: one that only fires when a given file changed
  // is one that is usually not checked.
  for (const c of checks) assert.deepEqual(c.paths, ['**/*']);
});

test('no viewer fixture means no viewer checks — never a check that cannot sign in', () => {
  // A viewer that fell back to an admin role would make every permission check
  // pass; the platform declines to ask rather than ask uselessly.
  const withoutViewer = buildBaselineChecks({ reviewerRole: 'platform', viewerRole: null });
  assert.ok(withoutViewer.length > 0);
  assert.ok(withoutViewer.filter((c) => c.role).every((c) => c.role === 'platform'));
  // The signed-out check needs no fixture at all, so it survives having none.
  // It used to be true that every baseline was a signed-in one, which is why
  // the signed-out screen — the only one a visitor sees — was never checked.
  assert.deepEqual(buildBaselineChecks({}).map((c) => c.role), [null]);
});

test('the baseline opens a legal page on the signed-out sign-in screen', () => {
  // The sign-in screen does not link base.css, so the platform's own chrome
  // rendered there unstyled — the Privacy / Terms links as raw browser buttons,
  // and the pages they opened as unstyled text. Asserting the footer SLOT
  // exists never caught it: the slot was there the whole time. Only opening a
  // page does.
  const signin = buildBaselineChecks({ reviewerRole: 'platform' }).find((c) => c.id.endsWith('signin-legal'));
  assert.ok(signin, 'a signed-out sign-in-screen check must exist');
  assert.equal(signin.role, null, 'it must run signed OUT — that is the state under test');
  assert.equal(signin.page, '/login');
  assert.deepEqual(signin.paths, ['**/*']);
  assert.ok(signin.steps.some((s) => s.click === '[data-legal="privacy"]'), 'it must actually open a legal page');
  assert.ok(signin.steps.some((s) => s.expect_visible === '.legal-overlay .legal-inner h1'));
  // Back closes the overlay and leaves the screen underneath standing.
  assert.ok(signin.steps.some((s) => s.click === '.legal-overlay .legal-back'));
  assert.ok(signin.steps.some((s) => s.expect_absent === '.legal-overlay'));
  assert.deepEqual(signin.steps.at(-1), { expect_visible: '[data-legal-footer] .legal-link' });
});

test('the baseline is added to whatever the model wrote, and signs itself in', () => {
  const spec = parseUiChecks(JSON.stringify({
    users: [{ role: 'admin', email: 'a@fixture.invalid', password: 'x'.repeat(12) }],
    checks: [{ id: 'mine', page: '/', paths: ['a'], login: 'a@fixture.invalid', steps: [{ click: '#x' }] }],
  })).spec;
  const out = withBaselineChecks(spec, { reviewLogin: REVIEWER, viewerLogin: VIEWER });
  // The model's own check survives untouched.
  assert.ok(out.checks.some((c) => c.id === 'mine'));
  assert.ok(out.checks.filter(isBaselineCheck).length >= 4);
  // Both fixture roles are signed in, without disturbing the model's users.
  assert.equal(out.login.users.platform.username, REVIEWER.email);
  assert.equal(out.login.users.platform_viewer.username, VIEWER.email);
  assert.ok(out.login.users.admin, 'the spec\'s own users must survive');
  assert.equal(out.login.via, 'api');
});

test('an empty spec still gets the baseline — that is the cycle it matters most on', () => {
  // Project 39/40 shape: the model wrote no usable spec, so nothing at all
  // exercised the rendered app on exactly the build most likely to be broken.
  const out = withBaselineChecks({ login: null, checks: [] }, { reviewLogin: REVIEWER, viewerLogin: VIEWER });
  assert.ok(out.checks.length >= 4);
  assert.ok(out.checks.every(isBaselineCheck));
  // And with no reviewer there is nothing to sign in as, so nothing is added.
  assert.deepEqual(withBaselineChecks({ login: null, checks: [] }, {}).checks, []);
});

test('a model check with a baseline id wins on its own ground', () => {
  const mine = { id: `${BASELINE_CHECK_PREFIX}app-shell`, page: '/', paths: ['a'], role: null, steps: [{ click: '#x' }] };
  const out = withBaselineChecks({ login: null, checks: [mine] }, { reviewLogin: REVIEWER });
  assert.equal(out.checks.filter((c) => c.id === mine.id).length, 1);
  assert.deepEqual(out.checks.find((c) => c.id === mine.id).steps, [{ click: '#x' }]);
});

/* ------------------------------------------------------------------------- *
 * The format is the PLATFORM's. It must hand it over, not make each build
 * derive it.
 *
 * Project 42's ui-interaction gate failed on a missing state/ui-checks.json,
 * and the build's next move was to read `/srv/gates/01-ui-interaction.sh` and
 * grep the filesystem for the schema — because the failure said "add
 * interaction checks covering the touched screens" and stopped. Five turns at
 * the fattest end of the context, for a file shape the platform owns.
 *
 * The loop this closes: what the gate PRINTS must be valid JSON, must satisfy
 * the gate itself, and must survive the strict post-deploy parser. Two builds
 * in a row (38, 42) shipped a spec that cleared the gate and then failed that
 * parser after deploy, so "the gate accepts it" is not enough on its own.
 * ------------------------------------------------------------------------- */

test('the ui-interaction gate hands over a template that is valid JSON, passes itself, and parses', async () => {
  const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');

  if (spawnSync('git', ['--version']).status !== 0) return; // the gate stands down without git anyway

  const seed = JSON.parse(readFileSync(fileURLToPath(new URL('../mock2/framework-seed/gates.json', import.meta.url)), 'utf8'));
  const gate = seed.find((g) => g.name === 'ui-interaction');
  assert.ok(gate, 'the seed battery must still carry ui-interaction');

  const dir = mkdtempSync(path.join(tmpdir(), 'pp-uicheck-'));
  const sh = (args, opts = {}) => spawnSync(args[0], args.slice(1), { cwd: dir, encoding: 'utf8', ...opts });
  const runGate = () => {
    try { return { code: 0, out: execFileSync('sh', ['.gate.sh'], { cwd: dir, encoding: 'utf8' }) }; }
    catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  };
  try {
    writeFileSync(path.join(dir, '.gate.sh'), gate.script);
    mkdirSync(path.join(dir, 'public'), { recursive: true });
    mkdirSync(path.join(dir, 'state'), { recursive: true });
    sh(['git', 'init', '-q']);
    writeFileSync(path.join(dir, 'public', 'app.html'), '<p>before</p>\n');
    sh(['git', 'add', '-A']);
    sh(['git', '-c', 'user.email=t@fixture.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    // A user-facing change with no spec — the exact state project 42 was in.
    writeFileSync(path.join(dir, 'public', 'app.html'), '<p>after</p>\n');

    const failed = runGate();
    assert.equal(failed.code, 1, 'a user-facing change with no spec must still fail');
    assert.match(failed.out, /state\/ui-checks\.json is missing or invalid/);

    // The template it printed, taken exactly as a build would take it.
    const lines = failed.out.split('\n');
    const first = lines.findIndex((l) => l.trim() === '{');
    const last = lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim() === '}');
    assert.ok(first > -1 && last > first, 'the failure must print a complete JSON object, not prose about one');
    const template = lines.slice(first, last + 1).join('\n');

    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(template); },
      'the printed template must be valid JSON — a // comment in it is a trap, not documentation');
    assert.ok(Array.isArray(parsed.checks) && parsed.checks.length, 'it must show a real check');
    assert.ok(parsed.checks[0].steps.length >= 3, 'and enough steps to show the vocabulary');

    // It satisfies the gate that printed it.
    writeFileSync(path.join(dir, 'state', 'ui-checks.json'), template);
    const passed = runGate();
    assert.equal(passed.code, 0, `the gate must accept its own template, got: ${passed.out}`);
    assert.match(passed.out, /ui-interaction: OK/);

    // And the STRICT post-deploy parser, which is the one that reds a build
    // after a successful deploy.
    const strict = parseUiChecks(template);
    assert.equal(strict.ok, true, `the post-deploy parser must accept it: ${strict.error}`);
    assert.equal(strict.spec.checks.length, parsed.checks.length);
    assert.ok(strict.spec.checks[0].steps.length >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner prompt hands over the ui-checks format and the post-deploy contract', () => {
  const prompt = buildRunnerSystemPrompt({ constitution: 'C', skills: [], buildMode: 'mvp' });

  // The same template, in the prompt, so a build never has to reach the gate
  // failure to learn the shape.
  assert.match(prompt, /"checks":\s*\[\{/);
  assert.match(prompt, /"expect_text":\s*"#note-grid",\s*"contains"/);
  assert.match(prompt, /omit it to\s+run the check SIGNED OUT/);

  // What the platform runs after finish — the section that exists because one
  // build spent 34 of 73 turns and 41% of its cost rebuilding it by hand.
  assert.match(prompt, /What ProxyPilot runs FOR you after you finish/);
  for (const dontRebuild of ['scratch database', 'boot the server', 'mint your own auth tokens']) {
    assert.ok(prompt.includes(dontRebuild), `the prompt must name "${dontRebuild}" as something not to hand-roll`);
  }
  // And the bar it replaces, stated so "verify" cannot be read as "boot it".
  assert.match(prompt, /It does not mean you booted the app/);
});

test('the runner prompt says the build\'s routers go LAST, not merely below /login', () => {
  // Two failures on the same project, one after the other. First a router
  // mounted above the sign-in route: every page and stylesheet 401'd. Then the
  // half-fix — the sign-in page moved up, the router left above the platform's
  // auth API — so /api/auth/bootstrap/status 401'd, login.js read that as "a
  // user already exists", and the create-the-first-administrator link vanished.
  const prompt = buildRunnerSystemPrompt({ constitution: 'C', skills: [], buildMode: 'mvp' });
  assert.match(prompt, /YOUR ROUTERS GO LAST/);
  assert.match(prompt, /BELOW every platform\s*mount/i);
  // The prefix was the ORIGINAL advice, and it is what produced the half-fix.
  assert.match(prompt, /A PATH PREFIX DOES NOT SAVE YOU/);
  assert.match(prompt, /bootstrap\/status/, 'it must name the endpoint whose 401 hides the signup form');
  assert.match(prompt, /HIDES the\s*create-the-first-administrator link/s);
  assert.match(prompt, /signin-reachable/, 'and the gate that catches it');
  // Naming the escape hatches it must NOT take.
  assert.match(prompt, /move YOURS down/);
});

/* ------------------- BASELINE-ONLY FAILURE (project 47) ------------------- */
//
// Three cycles, $10.28, identical each time. Cycles 2 and 3 both concluded "no
// product-code change was needed", shipped an empty diff, and failed on the
// same two platform baselines. The build was not being lazy — it had finished
// the app, its own checks passed, and one of the two failures (`header.topbar`
// asserted against the platform's /admin console) was not fixable from inside
// the app at all. Nothing in the report said so, so "run it again" was always
// the obvious next move.

test('baseline-only is only claimed when EVERY failure is a baseline', async () => {
  const { baselineOnlyFailure } = await import('../mock2/ui-check-logic.js');
  const base = (id) => ({ id: `platform-baseline-${id}`, ok: false, detail: 'x' });
  const mine = (id) => ({ id, ok: false, detail: 'x' });

  assert.equal(baselineOnlyFailure([base('a'), base('b')]).ids.length, 2);
  assert.equal(baselineOnlyFailure([base('a'), mine('notes-todo-add')]), null,
    'one failure of the app\'s own means the build has something to fix');
  assert.equal(baselineOnlyFailure([{ id: 'x', ok: true }]), null, 'nothing failed');
  assert.equal(baselineOnlyFailure([]), null);
});

test('a not-yet-possible check is not counted as a failure here', async () => {
  // Otherwise the two features collide: a first-run app would report
  // "baseline-only failure" for checks that did not run at all.
  const { baselineOnlyFailure } = await import('../mock2/ui-check-logic.js');
  const r = baselineOnlyFailure([
    { id: 'platform-baseline-a', ok: false, detail: 'real' },
    { id: 'signin', ok: false, notPossible: true, detail: 'no admin yet' },
  ]);
  assert.deepEqual(r.ids, ['platform-baseline-a']);
});

test('THE MESSAGE SAYS A RETRY IS FUTILE, and carries the diagnosis', async () => {
  const { baselineBlockedMessage } = await import('../mock2/ui-check-logic.js');
  const failed = [{
    id: 'platform-baseline-signin-legal',
    ok: false,
    detail: '[data-legal-footer] .legal-link: Timeout — "[data-legal-footer]" IS present',
  }];
  const empty = baselineBlockedMessage({ failed }, { emptyDiff: true });
  assert.match(empty, /running it again will produce this same report/i);
  assert.match(empty, /base app or the platform contract has to change/);
  // The detail is what makes it a one-line fix rather than another $2 cycle.
  assert.match(empty, /"\[data-legal-footer\]" IS present/);

  const withDiff = baselineBlockedMessage({ failed }, { emptyDiff: false });
  assert.ok(!/same report/i.test(withDiff), 'a build that DID change code gets the weaker claim');
  assert.match(withDiff, /will not clear these on its own/);
  assert.equal(baselineBlockedMessage({ failed: [] }), '');
});

test('RATCHET: the runner reports it, and build-id stamps are not product code', () => {
  // Cycles 2 and 3 touched only public/sw.js + build-id + state/. Counting
  // those as product changes would make the futility claim never fire on the
  // exact shape that motivated it.
  const src = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  assert.match(src, /smoke\.baselineOnly/);
  assert.match(src, /baselineBlockedMessage/);
  assert.match(src, /build-id\\\.\(js\|txt\)\|sw\\\.js/, 'the stamps must not count as product code');
  assert.match(src, /\^state\\\//, 'nor state/');
  const block = src.slice(src.indexOf('let baselineLine'));
  assert.match(block.slice(0, 1600), /catch \(e\) \{ console\.warn\('\[mock2\] baseline-only report failed/,
    'this only decides what the cycle fails SAYING — it must never throw');
});
