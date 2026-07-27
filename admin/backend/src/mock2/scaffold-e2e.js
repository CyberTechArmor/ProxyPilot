// Mock2 scaffold — PLAYWRIGHT in the base app.
//
// Operator ask: "please add playwright to the base app / integrate ProxyPilot /
// harness."
//
// WHAT WAS MISSING. ProxyPilot already drove a browser, but only from the HOST:
// `state/ui-checks.json` is a declarative JSON spec (click this, expect that)
// executed by the platform's own playwright-core against the DEPLOYED app after
// a build. That is a good post-deploy smoke check and a bad test suite — the
// build model cannot write a real test in it, cannot run one while working, and
// cannot see a failure until after the deploy. So every "does the UI actually
// work" question was answered either by a JSON spec written to satisfy a
// coverage gate, or by nothing at all. The operator's word for the result was
// "junior".
//
// WHAT THIS ADDS. The generated project now owns a real Playwright suite:
// `playwright.config.ts`, an `e2e/` directory with a first spec that already
// tests something true, and `npm run test:e2e`. The config's `webServer` builds
// and starts the app itself against a scratch database, so the suite is
// self-contained — it runs in the gate battery, in the project terminal, and on
// the operator's own machine, with no ambient state.
//
// HOW THE TWO RELATE (they are not redundant):
//   e2e/*.spec.ts       — the build's OWN tests. Run BEFORE deploy, against a
//                         server the suite starts. Red here blocks the build.
//   state/ui-checks.json — the platform's post-deploy smoke pass against the
//                         LIVE app, per role, plus the design review's capture.
//                         Red here means the thing that shipped is broken.
// A build writes the first; the platform owns the second.
//
// THE BROWSER BINARY is the one non-obvious cost: Playwright needs a Chromium
// (~170MB) inside the container. It is installed once, best-effort, at
// provision — and when it is absent the gate SKIPS with the exact command
// rather than reddening a build over a missing download. A test tool that can
// fail a build for reasons unrelated to the code is worse than no test tool.
//
// Terminology (risk R7): nothing here is named "agent".

// The port the e2e webServer binds. Deliberately NOT the app's own port: the
// suite must be runnable while the real app is serving (during a build, the
// systemd unit is up), and two servers on one port is a confusing failure.
export const E2E_PORT = 3999;

// The scratch database the suite migrates and runs against. Separate from the
// app's, so a test that deletes everything cannot delete the operator's data.
export const E2E_DB = 'app_e2e';

export const PLAYWRIGHT_VERSION = '^1.47.0';

/* ---------------------------------------------------------------------------
   playwright.config.ts
   --------------------------------------------------------------------------- */
export function playwrightConfigTs() {
  return `import { defineConfig, devices } from '@playwright/test';

// Playwright — the app's own browser tests.
//
// SELF-CONTAINED BY CONSTRUCTION. \`webServer\` builds and starts the app on
// port ${E2E_PORT} against the scratch database \`${E2E_DB}\`, so \`npx playwright test\`
// works with nothing else running: in ProxyPilot's gate battery, in the project
// terminal, and on a laptop. It does NOT reuse the deployed app — a suite that
// silently tests whatever happened to be on the port is a suite that passes for
// the wrong reasons.
//
// TWO PROJECTS, because the mobile one is where the defects have actually been:
// layouts that overflow at 390px, controls under the fold, dialogs that cannot
// be completed on a phone. Desktop-only browser tests would have missed every
// one of them.
const PORT = Number(process.env.E2E_PORT || ${E2E_PORT});
// Concatenation rather than a template literal: this file is itself emitted
// from a template literal, and counting backslashes through two layers is how
// you ship a config that does not parse.
export const BASE_URL = process.env.E2E_BASE_URL || ('http://127.0.0.1:' + PORT);

export default defineConfig({
  testDir: './e2e',
  // A build runs this in a container with modest CPU; serial is slower but its
  // failures are readable, and a flaky parallel suite gets disabled by the
  // first person it inconveniences.
  workers: 1,
  fullyParallel: false,
  // Never let a lone \`test.only\` silently shrink the suite to one case in CI.
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['list'], ['json', { outputFile: 'state/e2e-results.json' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    // Evidence on failure only: a trace per passing test fills the container's
    // disk for nothing.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    // Build, migrate the scratch DB, then serve it. \`sh -c\` because this is a
    // pipeline, not a single binary.
    command: 'npm run e2e:server',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
`;
}

/* ---------------------------------------------------------------------------
   scripts/e2e-server.mjs — build + migrate + serve, against the scratch DB.
   --------------------------------------------------------------------------- */
export function e2eServerMjs() {
  return `#!/usr/bin/env node
// The server Playwright's \`webServer\` starts.
//
// Three things in order, because each depends on the last:
//   1. create the scratch database if it does not exist (idempotent),
//   2. run the migrations against it,
//   3. start the built app pointed at it, on the e2e port.
//
// Uses only the pg driver + child_process, mirroring scripts/migrate.mjs, so it
// needs no build step of its own and can run before tsc has produced dist/.
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';

const PORT = Number(process.env.E2E_PORT || ${E2E_PORT});
const DB = process.env.E2E_DB_NAME || '${E2E_DB}';
const appUrl = process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/app';

// Swap the database name, keep the credentials/host — the e2e DB lives on the
// same in-container Postgres as the app's.
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = '/' + name;
  return u.toString();
}
const e2eUrl = withDatabase(appUrl, DB);

async function ensureDatabase() {
  // CREATE DATABASE cannot run inside a transaction or against the target
  // itself, so connect to the maintenance DB.
  const admin = new pg.Client({ connectionString: withDatabase(appUrl, 'postgres') });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
    if (!rows.length) await admin.query('CREATE DATABASE ' + JSON.stringify(DB).replace(/"/g, '"'));
  } finally {
    await admin.end().catch(() => {});
  }
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error('[e2e] ' + cmd + ' ' + args.join(' ') + ' failed (' + r.status + ')');
    process.exit(r.status || 1);
  }
}

await ensureDatabase();
// Build only when dist is stale/absent — \`npm run build\` is the slowest step
// here and the gate has usually just run it.
run('npm', ['run', 'build']);
run('node', ['scripts/migrate.mjs'], { DATABASE_URL: e2eUrl });

const child = spawn('node', ['dist/server.js'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: e2eUrl, PORT: String(PORT), NODE_ENV: 'test' },
});
// Playwright kills this process group when the run ends; forward it so the
// server does not outlive the suite and hold the port.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0); });
child.on('exit', (code) => process.exit(code ?? 0));
`;
}

/* ---------------------------------------------------------------------------
   e2e/platform.spec.ts — the first spec, and the pattern to copy.
   --------------------------------------------------------------------------- */
//
// It tests things that are TRUE OF EVERY generated app, so it is a real suite
// from the first commit rather than a placeholder the model is expected to
// replace. Three of the four assertions here are defect classes an operator has
// actually reported: a layout that scrolls sideways on a phone, a theme toggle
// that does nothing, and a page that throws in the console while looking fine.
export function platformSpecTs() {
  return `import { test, expect, type Page } from '@playwright/test';

// The base app's own guarantees. These hold for EVERY project as it grows, so
// this file should keep passing. Add your feature's specs beside it in other
// files under e2e/; do not edit these to make a change pass.
//
// A DELIBERATE RULE HERE: assert only what is true of every generated app, and
// SKIP explicitly (with a reason) for anything optional — the sign-in gate
// exists only once the app has accounts, the legal footer only on pages that
// mount it, the theme control only where a screen renders one. A first spec
// that reds a legitimate app teaches everyone to ignore the suite.

// A page that scrolls sideways on a phone is a defect, not a preference. This
// has been reported by hand more than once, which is exactly the kind of thing
// a machine should be checking instead. The mobile project is where it bites.
async function expectNoHorizontalScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, where + ' scrolls horizontally by ' + overflow + 'px').toBeLessThanOrEqual(1);
}

// Page problems, collected per test rather than asserted inline: a page can
// render perfectly and still be throwing on every interaction.
//
// PRECISE ON PURPOSE. The blunt version ("no console errors at all") reds on a
// 404 for an OPTIONAL endpoint — Chrome logs every non-2xx response as a
// console error even when the page handles it, and platform.js deliberately
// falls back when /api/branding is not mounted. A check that cries wolf gets
// switched off. So this asserts the three things that are always defects:
//   • a script that THREW (pageerror) — the page is broken and looks fine,
//   • a console.error the app itself wrote,
//   • a script or stylesheet that failed to load, or any 5xx.
// A 404 on an optional API is none of those and is left alone.
function collectPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push('uncaught: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Chrome's own wording for a non-2xx response. The response/requestfailed
    // handlers below judge those on their merits instead.
    if (/Failed to load resource/i.test(msg.text())) return;
    problems.push('console.error: ' + msg.text());
  });
  page.on('requestfailed', (req) => {
    const type = req.resourceType();
    if (type === 'script' || type === 'stylesheet' || type === 'document') {
      problems.push(type + ' failed to load: ' + req.url());
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 500) problems.push(res.status() + ' from ' + res.url());
    const type = res.request().resourceType();
    if (res.status() >= 400 && (type === 'script' || type === 'stylesheet')) {
      problems.push(res.status() + ' for ' + type + ' ' + res.url());
    }
  });
  return problems;
}

// Does this app have a sign-in gate? Only apps with accounts do.
//
// WAITS for the field rather than counting immediately: the sign-in page
// decides between the sign-in form and the first-run create-administrator form
// after asking the server, so a bare count right after navigation races that
// fetch and reports "no sign-in gate" on an app that plainly has one. Either
// form is a pass — a password field on /login is the thing being asserted.
async function hasSignIn(page: Page): Promise<boolean> {
  const res = await page.goto('/login').catch(() => null);
  if (!res || res.status() >= 400) return false;
  return page.locator('input[type="password"]').first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true, () => false);
}

test('the health endpoint answers', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok(), 'GET /api/health did not answer 2xx').toBeTruthy();
});

test('the front door renders without errors and without scrolling sideways', async ({ page }) => {
  const problems = collectPageProblems(page);
  const res = await page.goto('/');
  // Either the app renders, or the auth gate redirects to sign in. What must
  // not happen is a 5xx, or a shell that renders empty because its data 401'd.
  expect(res?.status() ?? 0, 'GET / returned a server error').toBeLessThan(500);
  await expect(page.locator('body')).not.toBeEmpty();
  await expectNoHorizontalScroll(page, 'the front door');
  expect(problems, 'the front door has page problems').toEqual([]);
});

test('the sign-in page renders cleanly', async ({ page }) => {
  const problems = collectPageProblems(page);
  test.skip(!(await hasSignIn(page)), 'this app has no sign-in gate');
  // .first(): the page carries several forms (sign in, first-run create
  // administrator, set a password) and shows one — a bare locator matches all
  // three and Playwright's strict mode rejects it.
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(page.locator('form').first()).toBeVisible();
  await expectNoHorizontalScroll(page, '/login');
  expect(problems, 'the sign-in page has page problems').toEqual([]);
});

// Present, or genuinely absent?
//
// theme.js and platform.js are DEFERRED and platform.js fetches before it
// renders, so a bare count right after navigation reports "absent" for things
// that appear 50ms later — and a skip that fires for a timing reason is a test
// that quietly stops testing. Wait, then decide.
async function appears(page: Page, selector: string, timeout = 4000): Promise<boolean> {
  return page.locator(selector).first().waitFor({ state: 'attached', timeout }).then(() => true, () => false);
}

test('the legal footer carries the current year', async ({ page }) => {
  await page.goto('/');
  test.skip(!(await appears(page, '.legal-footer')), 'no page here mounts the legal footer');
  // platform.js recomputes the year rather than trusting a cached projection —
  // a tab left open across New Year must not claim the wrong one.
  await expect(page.locator('.legal-footer').first()).toContainText(String(new Date().getFullYear()));
});

test('the theme toggle changes the theme and survives a reload', async ({ page }) => {
  await page.goto('/');
  test.skip(!(await appears(page, '.theme-toggle')), 'no screen here renders a theme control');
  // By accessible name rather than an id, so a redesign that keeps the
  // behaviour keeps the test. theme.js fills the label in on refresh().
  const toggle = page.getByRole('button', { name: /theme|dark|light/i }).first();
  test.skip(await toggle.count() === 0, 'the theme control has no accessible name');

  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await toggle.click();
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(after, 'clicking the theme control did not change data-theme').not.toBe(before);

  // The choice is persisted, or the toggle is decorative.
  await page.reload();
  const persisted = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(persisted, 'the theme did not survive a reload').toBe(after);
});
`;
}

/* ---------------------------------------------------------------------------
   The npm scripts Playwright needs.
   --------------------------------------------------------------------------- */
export const E2E_SCRIPTS = Object.freeze({
  'test:e2e': 'playwright test',
  'test:e2e:ui': 'playwright test --ui',
  'e2e:server': 'node scripts/e2e-server.mjs',
  // Installing the browser is explicit and idempotent, so a developer (or the
  // gate's skip message) has one command to name.
  'e2e:install': 'playwright install chromium',
});

export const E2E_DEV_DEPENDENCIES = Object.freeze({
  '@playwright/test': PLAYWRIGHT_VERSION,
});

/* ---------------------------------------------------------------------------
   The in-container browser install (best effort, once per project).
   --------------------------------------------------------------------------- */
//
// Run at provision, after npm install, on the same egress path a build uses.
// NEVER fatal: no browser means the e2e gate skips with instructions, which is
// strictly better than a project that cannot be provisioned because a CDN was
// slow. `--with-deps` pulls the shared libraries Chromium needs on Debian; it
// requires root, which we have inside the container.
export function installBrowserScript(appDir) {
  return [
    `cd '${appDir}' || exit 0`,
    '[ -f package.json ] || exit 0',
    // Already installed? The browsers directory is the cheap check.
    'if [ -d "$HOME/.cache/ms-playwright" ] && [ -n "$(ls -A "$HOME/.cache/ms-playwright" 2>/dev/null)" ]; then',
    '  echo "e2e-browser: already installed"; exit 0',
    'fi',
    '[ -x node_modules/.bin/playwright ] || { echo "e2e-browser: playwright is not installed in this project; skipping"; exit 0; }',
    'echo "e2e-browser: installing chromium (one time, ~170MB)"',
    'node_modules/.bin/playwright install --with-deps chromium >/tmp/pw-install.log 2>&1 || {',
    '  echo "e2e-browser: install failed — the e2e gate will skip until it succeeds:"',
    '  tail -20 /tmp/pw-install.log',
    '  exit 0',
    '}',
    'echo "e2e-browser: chromium installed"',
    'exit 0',
    '',
  ].join('\n');
}

/* ---------------------------------------------------------------------------
   The harness gate.
   --------------------------------------------------------------------------- */
//
// Tier: mvp. This is a "does the website look and act right" check, which is
// exactly what the operator asked MVP to cover — and it is the only gate that
// exercises the rendered DOM before a deploy.
//
// Two deliberate escape hatches, because a browser suite that can red a build
// for environmental reasons gets disabled by the first person it blocks:
//   • no Playwright in the project (an older scaffold)  → skip,
//   • no browser binary installed                       → skip, with the command.
// A FAILING test is never skipped. Only an absent tool is.
export function e2eGateScript() {
  return `#!/bin/sh
# e2e — the project's OWN Playwright suite, run against a server the suite
# starts (playwright.config.ts webServer), so it needs nothing deployed.
#
# Skips green when the tooling is absent; never when a test fails.
if [ ! -f playwright.config.ts ] && [ ! -f playwright.config.js ]; then
  echo "e2e: this project has no Playwright config (seeded before e2e existed); skipped."
  exit 0
fi
if [ ! -x node_modules/.bin/playwright ]; then
  echo "e2e: @playwright/test is not installed; skipped. Run: npm install"
  exit 0
fi
# The browser binary. Absent means the one-time download has not succeeded yet
# (no egress at provision, or a slow CDN) — that is an environment problem, not
# a code problem, so it must not red the build.
if [ -z "$(ls -A "$HOME/.cache/ms-playwright" 2>/dev/null)" ]; then
  echo "e2e: no browser installed; skipped. Run: npm run e2e:install"
  exit 0
fi
SPECS=$(find e2e -name '*.spec.ts' -o -name '*.spec.js' 2>/dev/null | head -1)
if [ -z "$SPECS" ]; then
  echo "e2e: no specs in e2e/; skipped."
  exit 0
fi
CI=1 node_modules/.bin/playwright test
rc=$?
if [ "$rc" -ne 0 ]; then
  echo ""
  echo "e2e: FAIL — the browser suite is red. These run against a real server with a real"
  echo "     database, so a failure here is a user-visible defect, not a flaky unit test."
  echo "     Reproduce locally:  npm run test:e2e"
  echo "     Watch it happen:    npm run test:e2e:ui"
fi
exit $rc
`;
}
