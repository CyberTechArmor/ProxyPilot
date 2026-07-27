// Playwright in the base app, and the harness gate that runs it.
//
// The gate's behaviour is the part worth testing hardest, because it has two
// jobs that pull against each other: it must NEVER red a build for a missing
// download (a test tool that can fail a build for environmental reasons gets
// disabled by the first person it blocks), and it must ALWAYS red a build for a
// failing test. Every state is executed here under a real `sh`, against a real
// materialised scaffold, with a stub `playwright` binary standing in for the
// 170MB browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Script, createContext } from 'node:vm';

import {
  playwrightConfigTs, e2eServerMjs, platformSpecTs, e2eGateScript, installBrowserScript,
  E2E_SCRIPTS, E2E_DEV_DEPENDENCIES, E2E_PORT, E2E_DB,
} from '../mock2/scaffold-e2e.js';
import { buildScaffoldFiles } from '../mock2/scaffold.js';
import { buildAuthWiredFiles } from '../mock2/scaffold-auth.js';
import { buildPlatformFiles } from '../mock2/scaffold-platform.js';
import { BASELINE_GATES, E2E_GATE_NAME, baselineGatesForProfile } from '../mock2/baseline-gates.js';
import { mergeE2ePackageJson, PLATFORM_OWNED_ALWAYS } from '../mock2/base-app-upgrade-logic.js';

/* ---------------------------- what gets shipped --------------------------- */

test('the scaffold ships a runner, a self-starting server and a real first spec', () => {
  const files = buildScaffoldFiles({ id: 1, name: 'Demo' });
  const paths = files.map((f) => f.path);
  for (const p of ['playwright.config.ts', 'scripts/e2e-server.mjs', 'e2e/platform.spec.ts']) {
    assert.ok(paths.includes(p), `${p} is not emitted`);
  }
  const pkg = JSON.parse(files.find((f) => f.path === 'package.json').content);
  assert.equal(pkg.devDependencies['@playwright/test'], E2E_DEV_DEPENDENCIES['@playwright/test']);
  for (const script of Object.keys(E2E_SCRIPTS)) {
    assert.ok(pkg.scripts[script], `package.json is missing the "${script}" script`);
  }
});

test('vitest does not try to run the Playwright specs', () => {
  // Vitest's default include matches any *.spec.ts. Without the exclusion,
  // `npm test` runs the browser specs in a node environment and fails with a
  // confusing error, for a suite that is not broken.
  const cfg = buildScaffoldFiles({ id: 1, name: 'Demo' }).find((f) => f.path === 'vitest.config.ts').content;
  assert.match(cfg, /exclude:[\s\S]*'e2e\/\*\*'/);
});

test('the suite starts its own server, on its own port, against its own database', () => {
  const cfg = playwrightConfigTs();
  // reuseExistingServer:false is load-bearing — a suite that silently tests
  // whatever happened to be on the port passes for the wrong reasons.
  assert.match(cfg, /reuseExistingServer:\s*false/);
  assert.match(cfg, /command:\s*'npm run e2e:server'/);
  assert.ok(cfg.includes(String(E2E_PORT)), 'the config does not name the e2e port');
  // Not the app's port: the suite must be runnable while the app is serving.
  assert.notEqual(E2E_PORT, 3000);

  const server = e2eServerMjs();
  assert.ok(server.includes(E2E_DB), 'the server script does not name the scratch database');
  // A scratch DB, so a destructive test cannot delete the operator's data.
  assert.match(server, /CREATE DATABASE/);
  assert.match(server, /scripts\/migrate\.mjs/);
});

test('both a desktop and a mobile project run', () => {
  const cfg = playwrightConfigTs();
  assert.match(cfg, /name: 'desktop'/);
  assert.match(cfg, /name: 'mobile'/);
});

test('the first spec tests things that are actually true of every app', () => {
  const spec = platformSpecTs();
  // Three of these are defect classes an operator has reported by hand.
  assert.match(spec, /scrollWidth - document\.documentElement\.clientWidth/, 'no horizontal-overflow assertion');
  assert.match(spec, /data-theme/, 'no theme-persistence assertion');
  assert.match(spec, /pageerror/, 'console errors are not collected');
  assert.match(spec, /\/api\/health/);
});

/* -------------------------------- the gate -------------------------------- */

test('the e2e gate is registered at the mvp tier and is blocking', () => {
  const gate = BASELINE_GATES.find((g) => g.name === E2E_GATE_NAME);
  assert.ok(gate, 'the e2e gate is not registered');
  assert.equal(gate.tier, 'mvp');
  assert.deepEqual(gate.advisoryIn, [], 'a failing browser test must block, not advise');
  // Cumulative profiles: absent from quick, present in mvp and full.
  const names = (p) => baselineGatesForProfile(p).map((g) => g.name);
  assert.ok(!names('quick').includes(E2E_GATE_NAME));
  assert.ok(names('mvp').includes(E2E_GATE_NAME));
  assert.ok(names('full').includes(E2E_GATE_NAME));
});

// One materialised scaffold, mutated through each state, so the gate is
// exercised against a real tree rather than a hand-written fixture.
test('the gate skips on missing tooling and fails on a red suite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-e2e-gate-'));
  try {
    for (const f of buildScaffoldFiles({ id: 1, name: 'Demo' })) {
      mkdirSync(join(dir, dirname(f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    const gate = join(dir, 'gate.sh');
    writeFileSync(gate, e2eGateScript());
    assert.equal(spawnSync('sh', ['-n', gate], { encoding: 'utf8' }).status, 0, 'the gate script is not valid sh');

    // HOME is redirected into the temp dir so the browser-cache probe sees the
    // fixture's state, not the machine's.
    const run = () => spawnSync('sh', [gate], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir } });
    const stubPlaywright = (exit, out) => {
      mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/.bin/playwright'), `#!/bin/sh\necho "${out}"\nexit ${exit}\n`, { mode: 0o755 });
    };

    // 1. Nothing installed → skip, and say what to run.
    let r = run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /npm install/);

    // 2. Playwright present, no browser → skip, and name the install command.
    stubPlaywright(0, 'should not have run');
    r = run();
    assert.equal(r.status, 0, 'a missing browser binary must never red a build');
    assert.match(r.stdout, /npm run e2e:install/);
    assert.doesNotMatch(r.stdout, /should not have run/, 'the suite ran without a browser');

    // 3. Browser present, suite green → pass, and the suite really ran.
    mkdirSync(join(dir, '.cache/ms-playwright/chromium-1194'), { recursive: true });
    stubPlaywright(0, 'all good');
    r = run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /all good/);

    // 4. Browser present, suite RED → fail. This is the case that must never
    //    be swallowed by the skip logic.
    stubPlaywright(1, '1 failed');
    r = run();
    assert.equal(r.status, 1, 'a failing browser suite did not red the gate');
    assert.match(r.stdout, /e2e: FAIL/);
    assert.match(r.stdout, /npm run test:e2e/);

    // 5. A project seeded before e2e existed → skip, not fail.
    rmSync(join(dir, 'playwright.config.ts'));
    r = run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no Playwright config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the browser install script is valid sh and is a no-op once installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-e2e-inst-'));
  try {
    const script = join(dir, 'install.sh');
    writeFileSync(script, installBrowserScript(dir));
    assert.equal(spawnSync('sh', ['-n', script], { encoding: 'utf8' }).status, 0);
    writeFileSync(join(dir, 'package.json'), '{}');
    mkdirSync(join(dir, '.cache/ms-playwright/chromium-1194'), { recursive: true });
    const r = spawnSync('sh', [script], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already installed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ the upgrade ------------------------------- */

test('an existing project gets the runner through the base-app upgrade', () => {
  for (const p of ['playwright.config.ts', 'scripts/e2e-server.mjs', 'e2e/platform.spec.ts']) {
    assert.ok(PLATFORM_OWNED_ALWAYS.includes(p), `${p} is not carried by the upgrade`);
  }
});

test('the package.json merge is additive, order-preserving and never destructive', () => {
  const before = `${JSON.stringify({
    name: 'app', private: true, type: 'module',
    scripts: { dev: 'tsx watch src/server.ts', test: 'vitest run' },
    dependencies: { express: '^4.19.2' },
    devDependencies: { typescript: '^5.5.4' },
  }, null, 2)}\n`;

  const out = mergeE2ePackageJson(before, { scripts: E2E_SCRIPTS, devDependencies: E2E_DEV_DEPENDENCIES });
  assert.equal(out.changed, true);
  const pkg = JSON.parse(out.content);
  assert.equal(pkg.scripts.dev, 'tsx watch src/server.ts', 'an existing script was overwritten');
  assert.equal(pkg.scripts['test:e2e'], E2E_SCRIPTS['test:e2e']);
  assert.equal(pkg.devDependencies.typescript, '^5.5.4');
  assert.equal(pkg.devDependencies['@playwright/test'], E2E_DEV_DEPENDENCIES['@playwright/test']);
  assert.deepEqual(pkg.dependencies, { express: '^4.19.2' }, 'dependencies were touched');
  // Key order preserved, so the diff is two lines rather than the whole file.
  assert.deepEqual(Object.keys(pkg), ['name', 'private', 'type', 'scripts', 'dependencies', 'devDependencies']);

  // Idempotent: a second run reports nothing to do, so the upgrade shows no diff.
  assert.equal(mergeE2ePackageJson(out.content, { scripts: E2E_SCRIPTS, devDependencies: E2E_DEV_DEPENDENCIES }).changed, false);

  // A project that pinned its own version keeps it.
  const pinned = JSON.stringify({ devDependencies: { '@playwright/test': '1.40.0' } });
  const kept = mergeE2ePackageJson(pinned, { scripts: {}, devDependencies: E2E_DEV_DEPENDENCIES });
  assert.equal(kept.changed, false);

  // Unparseable input is DECLINED, never rewritten — that is how an upgrade
  // destroys a project.
  const broken = mergeE2ePackageJson('{ not json', { scripts: E2E_SCRIPTS, devDependencies: {} });
  assert.equal(broken.changed, false);
  assert.equal(broken.content, null);
});

/* ------------------------- the model-facing contract ---------------------- */

test('the build is told about the suite, and told not to confuse it with ui-checks', async () => {
  const { PLATFORM_SECTION } = await import('../mock2/runner-logic.js');
  assert.match(PLATFORM_SECTION, /## Browser tests \(binding\)/);
  assert.match(PLATFORM_SECTION, /npm run test:e2e/);
  assert.match(PLATFORM_SECTION, /NOT the same thing as .?state\/ui-checks\.json/);
  assert.match(PLATFORM_SECTION, /Never edit it to make your change pass/);
});

/* ------------------ what running the suite actually found ------------------ */
//
// Four defects in the base app, each surfaced by running e2e/platform.spec.ts
// against a real server in a real browser. These are the regression cases.

test('liveness answers before the auth and bootstrap gates', () => {
  // It returned 503 BOOTSTRAP_REQUIRED until a human created the first admin,
  // conflating "is this process serving?" with "has someone set it up?". A
  // fresh deploy read as unhealthy to any load balancer or uptime monitor.
  const app = buildAuthWiredFiles().find((f) => f.path === 'src/app.ts').content;
  const health = app.indexOf("app.use('/api', healthRoutes)");
  const gate = app.indexOf('app.use(bootstrapGate())');
  assert.ok(health > 0, 'health routes are not mounted');
  assert.ok(gate > 0, 'the bootstrap gate is not mounted');
  assert.ok(health < gate, 'health must be mounted BEFORE the bootstrap gate');
  assert.ok(health < app.indexOf('app.use(withAuth)'), 'health must be mounted BEFORE the auth gate');
});

test('the sign-in page mounts the legal footer and a theme control', () => {
  // platform.js works with no session precisely so the copyright notice and
  // the Privacy/Terms links can render HERE — and no page mounted them, so
  // every generated app's sign-in screen had neither.
  const login = buildAuthWiredFiles().find((f) => f.path === 'public/login.html').content;
  assert.match(login, /data-legal-footer/);
  assert.match(login, /class="theme-toggle/);
  assert.match(login, /min-height: 44px/, 'the theme control must be a 44px touch target');
});

test('platform.js mounts the footer itself rather than exposing it and hoping', () => {
  const js = buildPlatformFiles().find((f) => f.path === 'public/platform.js').content;
  assert.match(js, /function mountFooters/);
  assert.match(js, /querySelectorAll\('\[data-legal-footer\]'\)/);
  // Twice: once immediately (the fallback keeps the screen legally complete
  // while the fetch is in flight) and again once branding has landed.
  assert.match(js, /load\(\)\.then\(mountFooters\)/);
});

test('the first click on the theme toggle always changes what you see', () => {
  // The old fixed order was system → light → dark, so on a light device the
  // first click changed nothing visible and it took two to see anything.
  const js = buildPlatformFiles().find((f) => f.path === 'public/theme.js').content;
  assert.doesNotMatch(js, /order = \['system', 'light', 'dark'\]/);
  assert.match(js, /var flipped = deviceIsDark \? 'light' : 'dark'/);

  // Execute the real cycle logic against a stubbed browser, both ways round,
  // and assert the SCREEN changes on every click — the property that matters.
  for (const deviceDark of [false, true]) {
    const seen = runThemeCycle(js, deviceDark, 3);
    assert.notEqual(seen[0], seen[1], `device ${deviceDark ? 'dark' : 'light'}: the first click did not change the theme`);
    assert.notEqual(seen[1], seen[2], `device ${deviceDark ? 'dark' : 'light'}: the second click did not change the theme`);
    // All three preferences stay reachable.
    assert.deepEqual([...new Set(seen)].sort(), ['dark', 'light']);
  }
});

// Run theme.js in a stub DOM and click the toggle `clicks` times, returning the
// applied data-theme after each step (index 0 is before any click).
function runThemeCycle(themeJs, deviceIsDark, clicks) {
  const store = new Map();
  let attr = null;
  const listeners = {};
  const sandbox = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    matchMedia: (q) => ({ matches: deviceIsDark && /dark/.test(q), addEventListener() {} }),
    document: {
      documentElement: { setAttribute: (k, v) => { if (k === 'data-theme') attr = v; }, getAttribute: () => attr },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
    },
  };
  sandbox.window = sandbox;
  const ctx = createContext(sandbox);
  new Script(themeJs).runInContext(ctx);
  const out = [attr];
  for (let i = 0; i < clicks - 1; i++) { sandbox.Theme.cycle(); out.push(attr); }
  return out;
}
