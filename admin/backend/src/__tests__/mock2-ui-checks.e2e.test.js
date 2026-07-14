// PERMANENT regression test for change 69: "admin can type into #adp-client-id
// and #adp-client-secret (after Replace) and run Test connection". The original
// bug shipped disabled admin credential inputs through five green gates because
// nothing exercised the rendered DOM. This test drives the REAL ui-checks
// executor (ui-checks.js, Playwright/Chromium) against two in-test fixtures:
//   - BROKEN: the exact regression (credential inputs disabled for admin) —
//     the check must FAIL;
//   - FIXED: inputs enabled, write-only secret enables after Replace, Test
//     connection clickable — the check must PASS, and the viewer read-only
//     check must also hold.
// Skipped (visibly, not silently green) when playwright isn't installed —
// mock2-ui-checks.test.js covers the pure layer everywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { parseUiChecks, checksForChangedFiles } from '../mock2/ui-check-logic.js';
import { runUiChecks } from '../mock2/ui-checks.js';

let hasPlaywright = true;
try { await import('playwright'); } catch { hasPlaywright = false; }

const LOGIN_HTML = `<!doctype html><html><body>
<form method="GET" action="/do-login">
  <input id="username" name="u"><input id="password" name="p" type="password">
  <button type="submit">Sign in</button>
</form></body></html>`;

// The exact change-69 regression: admin credential inputs rendered DISABLED.
const SETTINGS_BROKEN = `<!doctype html><html><body>
<h1>Connection Settings</h1><div id="adp-status">Not connected</div>
<input id="adp-client-id" disabled>
<input id="adp-client-secret" type="password" disabled>
<button id="adp-replace" type="button">Replace</button>
<button id="adp-test-connection" type="button" disabled>Test connection</button>
</body></html>`;

// The fixed page: Client ID enabled; the write-only secret enables after
// "Replace"; Test connection clickable.
const SETTINGS_FIXED = `<!doctype html><html><body>
<h1>Connection Settings</h1><div id="adp-status">Not connected</div>
<input id="adp-client-id">
<input id="adp-client-secret" type="password" disabled>
<button id="adp-replace" type="button">Replace</button>
<button id="adp-test-connection" type="button">Test connection</button>
<script>
  document.getElementById('adp-replace').addEventListener('click', () => {
    document.getElementById('adp-client-secret').disabled = false;
  });
</script>
</body></html>`;

// Viewer variant of the fixed app (server-rendered per role in a real app):
// edit controls disabled, status still readable.
const SETTINGS_VIEWER = `<!doctype html><html><body>
<h1>Connection Settings</h1><div id="adp-status">Not connected</div>
<input id="adp-client-id" disabled>
<input id="adp-client-secret" type="password" disabled>
<button id="adp-test-connection" type="button" disabled>Test connection</button>
</body></html>`;

// One fixture server with a real (cookie-based) session, so the executor's
// login-then-navigate flow works like a real app: /do-login sets the session
// cookie and redirects; /settings/connections renders per role from the cookie
// (smoke-viewer gets the viewer page, everyone else the variant under test).
function serveFixture(settingsHtml) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/do-login') {
      res.statusCode = 302;
      res.setHeader('Set-Cookie', `u=${url.searchParams.get('u') || ''}; Path=/`);
      res.setHeader('Location', '/settings/connections');
      return res.end();
    }
    res.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/login') return res.end(LOGIN_HTML);
    if (url.pathname === '/settings/connections') {
      const viewer = /(^|;\s*)u=smoke-viewer(;|$)/.test(req.headers.cookie || '');
      return res.end(viewer ? SETTINGS_VIEWER : settingsHtml);
    }
    res.statusCode = 404;
    res.end('<html><body>not found</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// The permanent spec for the regression — the same document a project carries
// in state/ui-checks.json.
const SPEC_JSON = JSON.stringify({
  login: {
    path: '/login', user_field: '#username', pass_field: '#password', submit: 'button[type=submit]',
    users: {
      admin: { username: 'smoke-admin', password: 'pw-a' },
      viewer: { username: 'smoke-viewer', password: 'pw-v' },
    },
  },
  checks: [
    {
      id: 'change-69-adp-admin-credentials-editable',
      name: 'Admin can type into ADP Client ID + Secret (after Replace) and run Test connection',
      paths: ['public/settings*', '**/settings/connections*'],
      role: 'admin',
      page: '/settings/connections',
      steps: [
        { expect_enabled: '#adp-client-id' },
        { fill: '#adp-client-id', value: 'smoke-client-id', expect_value: true },
        { click: '#adp-replace' },
        { expect_enabled: '#adp-client-secret' },
        { fill: '#adp-client-secret', value: 'smoke-secret', expect_value: true },
        { expect_enabled: '#adp-test-connection' },
        { click: '#adp-test-connection' },
      ],
    },
    {
      id: 'change-69-viewer-read-only',
      name: 'Viewer sees status but cannot edit ADP credentials',
      paths: ['public/settings*', '**/settings/connections*'],
      role: 'viewer',
      page: '/settings/connections',
      steps: [
        { expect_visible: '#adp-status' },
        { expect_disabled: '#adp-client-id' },
        { expect_disabled: '#adp-test-connection' },
      ],
    },
  ],
});

test('change-69 regression: executor FAILS on the broken fixture (disabled admin inputs)', { skip: !hasPlaywright && 'playwright not installed' }, async () => {
  const parsed = parseUiChecks(SPEC_JSON);
  assert.equal(parsed.ok, true);
  const checks = checksForChangedFiles(parsed.spec, ['public/settings.html']);
  assert.equal(checks.length, 2, 'the settings diff must trigger both role checks');

  const { server, url } = await serveFixture(SETTINGS_BROKEN);
  try {
    const run = await runUiChecks({ baseUrl: url, spec: parsed.spec, checks });
    assert.equal(run.ok, false, 'the broken fixture must FAIL the gate');
    const admin = run.results.find((r) => r.id === 'change-69-adp-admin-credentials-editable');
    assert.equal(admin.ok, false);
    const firstBad = admin.steps.find((s) => !s.ok);
    assert.match(firstBad.detail, /#adp-client-id is disabled/, 'the failure names the exact disabled control');
    // The viewer read-only expectations hold even on the broken page (everything
    // is disabled there) — the ADMIN check is what catches this regression class.
    const viewer = run.results.find((r) => r.id === 'change-69-viewer-read-only');
    assert.equal(viewer.ok, true);
  } finally {
    server.close();
  }
});

test('change-69 regression: executor PASSES on the fixed fixture (typed input persists, Replace enables secret)', { skip: !hasPlaywright && 'playwright not installed' }, async () => {
  const parsed = parseUiChecks(SPEC_JSON);
  const checks = checksForChangedFiles(parsed.spec, ['public/settings.html']);
  const { server, url } = await serveFixture(SETTINGS_FIXED);
  try {
    const run = await runUiChecks({ baseUrl: url, spec: parsed.spec, checks });
    const admin = run.results.find((r) => r.id === 'change-69-adp-admin-credentials-editable');
    assert.equal(admin.ok, true, `admin check failed: ${JSON.stringify(admin.steps.filter((s) => !s.ok))}`);
    assert.equal(admin.steps.length, 7, 'every step ran');
    const viewer = run.results.find((r) => r.id === 'change-69-viewer-read-only');
    assert.equal(viewer.ok, true, `viewer check failed: ${JSON.stringify(viewer.steps.filter((s) => !s.ok))}`);
    assert.equal(run.ok, true);
  } finally {
    server.close();
  }
});

// ---- cycle-94 live ACCEPTANCE demo: "Test connection turns all three checks
// green" as an executed check. The broken fixture reproduces the shipped
// defect: the cert/key false rejection leaves the key check red (SSL alert 40
// class). Under the hardened harness this check is listed in
// state/acceptance.json `ui` — the browser connector force-runs it post-deploy
// and the cycle CANNOT reach "succeeded" while it fails.

function adpSettingsFixture({ keyCheckPasses }) {
  return `<!doctype html><html><body>
<h1>Connection Settings</h1>
<button id="adp-test-connection" type="button">Test connection</button>
<div id="check-cert">pending</div><div id="check-key">pending</div><div id="check-token">pending</div>
<script>
  document.getElementById('adp-test-connection').addEventListener('click', () => {
    document.getElementById('check-cert').textContent = 'green';
    document.getElementById('check-key').textContent = ${keyCheckPasses ? "'green'" : "'red: private key does not match the stored certificate'"};
    document.getElementById('check-token').textContent = ${keyCheckPasses ? "'green'" : "'pending'"};
  });
</script></body></html>`;
}

const ADP_ACCEPTANCE_SPEC = JSON.stringify({
  checks: [{
    id: 'adp-test-connection-three-green',
    name: 'Test connection turns all three checks green',
    paths: ['src/adp/**', 'public/settings*'],
    page: '/settings/connections',
    steps: [
      { click: '#adp-test-connection' },
      { expect_text: '#check-cert', contains: 'green' },
      { expect_text: '#check-key', contains: 'green' },
      { expect_text: '#check-token', contains: 'green' },
    ],
  }],
});

test('cycle-94 acceptance: the LIVE defect fails the Test-connection check (cannot certify "succeeded")', { skip: !hasPlaywright && 'playwright not installed' }, async () => {
  const parsed = parseUiChecks(ADP_ACCEPTANCE_SPEC);
  assert.equal(parsed.ok, true);
  const { server, url } = await serveFixture(adpSettingsFixture({ keyCheckPasses: false }));
  try {
    const run = await runUiChecks({ baseUrl: url, spec: parsed.spec, checks: parsed.spec.checks });
    assert.equal(run.ok, false, 'the live false rejection must fail the acceptance check');
    const bad = run.results[0].steps.find((s) => !s.ok);
    assert.match(bad.detail, /#check-key/, 'the failure names the red check');
  } finally {
    server.close();
  }
});

test('cycle-94 acceptance: with the defect actually fixed, the same check passes', { skip: !hasPlaywright && 'playwright not installed' }, async () => {
  const parsed = parseUiChecks(ADP_ACCEPTANCE_SPEC);
  const { server, url } = await serveFixture(adpSettingsFixture({ keyCheckPasses: true }));
  try {
    const run = await runUiChecks({ baseUrl: url, spec: parsed.spec, checks: parsed.spec.checks });
    assert.equal(run.ok, true, `expected pass, got: ${JSON.stringify(run.results[0].steps.filter((s) => !s.ok))}`);
  } finally {
    server.close();
  }
});

test('console errors fail a check even when every step passes', { skip: !hasPlaywright && 'playwright not installed' }, async () => {
  const noisy = `<!doctype html><html><body><div id="adp-status">ok</div>
<script>console.error('TypeError: perms is undefined');</script></body></html>`;
  const spec = parseUiChecks(JSON.stringify({
    checks: [{ id: 'console-clean', paths: ['public/**'], page: '/settings/connections', steps: [{ expect_visible: '#adp-status' }] }],
  }));
  assert.equal(spec.ok, true);
  const { server, url } = await serveFixture(noisy);
  try {
    const run = await runUiChecks({ baseUrl: url, spec: spec.spec, checks: spec.spec.checks });
    const r = run.results[0];
    assert.equal(r.steps.every((s) => s.ok), true, 'the visible step itself passes');
    assert.equal(r.ok, false, 'the console error must fail the check');
    assert.match(r.consoleErrors[0], /TypeError/);
  } finally {
    server.close();
  }
});
