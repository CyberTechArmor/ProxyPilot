// The smoke-gate relevance triggers: the deterministic decision that keeps the
// browser + DB connectors a RELEVANCE-GATED escalation, never a standing step.
// These gate real cost (starting a browser / DB session), so pin the trigger logic,
// the escalation-needs-a-reason rule, and the no-silent-skip run/skip resolution.
// Native-free (pure). Includes the three ADP replay cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SMOKE_CONFIG, smokeConfigFromEnv, matchGlob,
  evaluateSmokeTriggers, applyEscalations, resolveConnectorRun,
  resolveSmokeConnectors, smokeLogLines, smokeGateOk,
} from '../mock2/smoke-triggers.js';

test('matchGlob: * stays within a segment, ** spans segments', () => {
  assert.ok(matchGlob('public/index.html', 'public/**'));
  assert.ok(matchGlob('public/a/b/c.css', 'public/**'));
  assert.ok(matchGlob('index.html', '**/*.html'));
  assert.ok(matchGlob('src/views/login.html', '**/*.html'));
  assert.ok(matchGlob('migrations/003_users.sql', 'migrations/**'));
  assert.ok(matchGlob('db/migrations/001.sql', '**/migrations/**'));
  assert.ok(matchGlob('schema.sql', '**/*.sql'));
  assert.ok(!matchGlob('src/service/auth.ts', 'public/**'));
  assert.ok(!matchGlob('src/routes/users.ts', '**/*.html'));
});

// ---- ADP replay 1: pure backend/config change → BOTH connectors skip ----

test('ADP replay: pure backend/config change fires NEITHER connector', () => {
  const changedFiles = ['src/service/rateLimit.ts', 'src/config/env.ts', 'package.json'];
  const changeMeta = { summary: 'tighten the rate-limit window and validate config at boot' };
  const d = evaluateSmokeTriggers({ changedFiles, changeMeta, config: DEFAULT_SMOKE_CONFIG });
  assert.equal(d.browser.fire, false);
  assert.equal(d.db.fire, false);
  const resolved = resolveSmokeConnectors({ decision: d, config: DEFAULT_SMOKE_CONFIG });
  assert.equal(resolved.browser.disposition, 'skipped');
  assert.equal(resolved.db.disposition, 'skipped');
  // The run log shows explicit skips with reasons — no silent skip.
  assert.deepEqual(smokeLogLines(resolved), [
    'browser: skipped — no user-facing paths in diff',
    'db: skipped — no data/state paths in diff',
  ]);
});

// ---- ADP replay 2: the CSS/login-render fix → BROWSER fires, DB skips ----

test('ADP replay: a public/** login-render fix fires the BROWSER connector only', () => {
  const changedFiles = ['public/login.html', 'public/styles/login.css'];
  // A pure render fix — the summary is about layout/rendering. (The "superadmin"
  // detail is what the BROWSER assertion checks, not the change summary; keeping
  // data-state vocabulary out of a render summary is exactly why DB stays skipped.)
  const changeMeta = { summary: 'fix the login render so only one signup form is visible, not three' };
  const d = evaluateSmokeTriggers({ changedFiles, changeMeta, config: DEFAULT_SMOKE_CONFIG });
  assert.equal(d.browser.fire, true);
  assert.match(d.browser.reason, /user-facing paths/);
  assert.ok(d.browser.matched.includes('public/login.html'));
  assert.equal(d.db.fire, false);
  // With the browser connector enabled it RUNS; DB is a visible skip.
  const cfg = { ...DEFAULT_SMOKE_CONFIG, browserEnabled: true };
  const resolved = resolveSmokeConnectors({ decision: d, config: cfg });
  assert.equal(resolved.browser.disposition, 'ran');
  assert.equal(resolved.db.disposition, 'skipped');
});

// ---- ADP replay 3: the usersExist bootstrap fix → DB fires, browser skips ----

test('ADP replay: a migrations/bootstrap fix fires the DB connector only', () => {
  const changedFiles = ['migrations/004_seed_guard.sql', 'src/auth/bootstrap.ts'];
  const changeMeta = { summary: 'fix usersExist so canCreateSuperadmin is true on a fresh install', ruleUnderTest: 'first-run bootstrap allows creating the superadmin' };
  const d = evaluateSmokeTriggers({ changedFiles, changeMeta, config: DEFAULT_SMOKE_CONFIG });
  assert.equal(d.db.fire, true);
  assert.match(d.db.reason, /data\/state paths/);
  assert.ok(d.db.matched.includes('migrations/004_seed_guard.sql'));
  assert.equal(d.browser.fire, false);
  const cfg = { ...DEFAULT_SMOKE_CONFIG, dbEnabled: true };
  const resolved = resolveSmokeConnectors({ decision: d, config: cfg });
  assert.equal(resolved.db.disposition, 'ran');
  assert.equal(resolved.browser.disposition, 'skipped');
});

test('metadata-only trigger: a screen change with no matching path still fires browser', () => {
  const d = evaluateSmokeTriggers({
    changedFiles: ['src/routes/dashboard.ts'],
    changeMeta: { summary: 'add the new billing screen to the user journey' },
    config: DEFAULT_SMOKE_CONFIG,
  });
  assert.equal(d.browser.fire, true);
  assert.match(d.browser.reason, /screen \/ user-journey/);
});

test('metadata-only trigger: a data-state rule with no matching path still fires db', () => {
  const d = evaluateSmokeTriggers({
    changedFiles: ['src/service/report.ts'],
    changeMeta: { ruleUnderTest: 'the first user to sign up becomes superadmin (user existence)' },
    config: DEFAULT_SMOKE_CONFIG,
  });
  assert.equal(d.db.fire, true);
});

// ---- escalation: allowed only with a stated reason ----

test('applyEscalations: a reason-less escalation is REJECTED (flagged), not honored', () => {
  const base = evaluateSmokeTriggers({ changedFiles: ['src/x.ts'], changeMeta: {}, config: DEFAULT_SMOKE_CONFIG });
  const { decision, rejected } = applyEscalations(base, [{ connector: 'browser' }]);
  assert.equal(decision.browser.fire, false); // not honored
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].why, /without a stated reason/);
});

test('applyEscalations: a justified escalation fires the connector with a logged reason', () => {
  const base = evaluateSmokeTriggers({ changedFiles: ['src/x.ts'], changeMeta: {}, config: DEFAULT_SMOKE_CONFIG });
  const { decision, rejected } = applyEscalations(base, [{ connector: 'db', reason: 'this refactor changes the seeding order' }]);
  assert.equal(rejected.length, 0);
  assert.equal(decision.db.fire, true);
  assert.equal(decision.db.escalated, true);
  assert.match(decision.db.reason, /escalated: this refactor changes the seeding order/);
});

test('applyEscalations: unknown connector is rejected', () => {
  const base = evaluateSmokeTriggers({ changedFiles: [], changeMeta: {}, config: DEFAULT_SMOKE_CONFIG });
  const { rejected } = applyEscalations(base, [{ connector: 'gpu', reason: 'why not' }]);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].why, /unknown connector/);
});

// ---- toggle off = ship for live testing: a triggered-but-toggled-off connector is
//      a VISIBLE 'disabled' disposition (logged, never a silent skip) that the gate
//      ACCEPTS, so the deployed build ships for a person to test live ----

test('resolveConnectorRun: fired but toggled off → disabled (visible), ships for live testing', () => {
  const r = resolveConnectorRun({ fire: true, reason: 'public/** touched' }, false);
  assert.equal(r.disposition, 'disabled');
  assert.match(r.reason, /turned off|live/i);
  // Still logged loudly — no silent skip.
  assert.equal(smokeLogLines({ browser: r, db: { disposition: 'skipped', reason: 'x' } })[0].startsWith('browser: disabled'), true);
});

test('resolveConnectorRun: fired and enabled → ran; not fired → skipped', () => {
  assert.equal(resolveConnectorRun({ fire: true, reason: 'x' }, true).disposition, 'ran');
  assert.equal(resolveConnectorRun({ fire: false, reason: 'x' }, true).disposition, 'skipped');
});

// ---- gate verdict: a toggled-off connector SHIPS; an enabled-but-unrunnable one fails ----

test('smokeGateOk: a warranted connector TURNED OFF ships the build (gate passes)', () => {
  // Operator turned the browser connector off for a user-facing change. It is
  // 'disabled' upstream and never started, so `report` carries no browser entry —
  // the gate accepts the build for live human testing even under requireTriggered.
  const http = { ok: true };
  const report = { http, browser: null, db: null };
  assert.equal(smokeGateOk({ http, report, config: DEFAULT_SMOKE_CONFIG }), true);
});

test('smokeGateOk: an ENABLED connector that could not run fails under requireTriggered', () => {
  // Browser connector left ON, fired, but playwright is missing → unavailable at
  // run time. That is the change-69 fail-visibly case: it must NOT read as success.
  const http = { ok: true };
  const report = { http, browser: { ok: false, unavailable: true, detail: 'playwright not installed' }, db: null };
  assert.equal(smokeGateOk({ http, report, config: DEFAULT_SMOKE_CONFIG }), false);
  // ...but an install that opted out of requireTriggered still ships it.
  assert.equal(smokeGateOk({ http, report, config: { ...DEFAULT_SMOKE_CONFIG, requireTriggered: false } }), true);
});

test('smokeGateOk: an invoked connector whose ASSERTION failed always fails the gate', () => {
  const http = { ok: true };
  const report = { http, browser: { ok: false, detail: 'a control rendered disabled' }, db: null };
  assert.equal(smokeGateOk({ http, report, config: DEFAULT_SMOKE_CONFIG }), false);
  // requireTriggered=false does NOT rescue a real assertion failure.
  assert.equal(smokeGateOk({ http, report, config: { ...DEFAULT_SMOKE_CONFIG, requireTriggered: false } }), false);
});

// ---- config from env ----

test('smokeConfigFromEnv: connectors default ON + required (change-69 lesson); flags + globs parse', () => {
  // A UI regression shipped through five green gates because nothing exercised
  // the rendered DOM — the browser/db connectors and requireTriggered are now
  // default-ON so a warranted-but-unrunnable connector can never silently pass.
  assert.equal(smokeConfigFromEnv({}).browserEnabled, true);
  assert.equal(smokeConfigFromEnv({}).dbEnabled, true);
  assert.equal(smokeConfigFromEnv({}).requireTriggered, true);
  // Operators can still opt out per install.
  const off = smokeConfigFromEnv({ SMOKE_BROWSER_ENABLED: '0', SMOKE_DB_ENABLED: 'false', SMOKE_REQUIRE_TRIGGERED: '0' });
  assert.equal(off.browserEnabled, false);
  assert.equal(off.dbEnabled, false);
  assert.equal(off.requireTriggered, false);
  const cfg = smokeConfigFromEnv({ SMOKE_BROWSER_ENABLED: '1', SMOKE_DB_GLOBS: 'db/**, **/*.sql' });
  assert.equal(cfg.browserEnabled, true);
  assert.deepEqual(cfg.dbGlobs, ['db/**', '**/*.sql']);
});
