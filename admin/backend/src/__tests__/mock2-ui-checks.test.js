// UI interaction checks (change-69 harness) — PURE logic tests, stub-first
// (risk R9). Imports only native-free modules: the ui-checks spec format, the
// path-glob triggering, the finish acceptance contract, and the smoke-trigger
// wiring. The Playwright executor is covered by mock2-ui-checks.e2e.test.js
// (skipped when playwright isn't installed) and the manual checklist.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UI_CHECKS_PATH, STEP_KINDS, parseUiChecks, checksForChangedFiles, stepShape, withPlatformLogin,
  uiCheckLogLines, uiCheckFailSummary,
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
