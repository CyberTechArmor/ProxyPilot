import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetentionScheduler, schedulerSelection, enabledPeriodicRules, DEFAULT_CRON } from '../lib/app-storage/retention-scheduler.js';
import { nodusCheck, nodusTarget, ids } from './helpers/app-storage-world.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const on = (over = {}) => ({ enabled: true, ...over });
const off = (over = {}) => ({ enabled: false, ...over });
const policy = rules => ({ version: 1, rules: {
  releases: on({ keepReleases: 2 }), snapshots: on({ keep: 3 }), // never the scheduler's
  workspaces: off({ abandonedAfterHours: 1 }), caches: off({ maxAgeDays: 14 }), tempFiles: off({ maxAgeDays: 2 }),
  testArtifacts: off({ maxAgeDays: 14 }), logs: off({ rotatedMaxAgeDays: 14, journalMaxMB: 256 }), history: off({ keepNewest: 2, maxAgeDays: 30 }),
  ...rules,
}, alerts: { enabled: true } });

test('rule ages decide: old enough items of enabled rules only; unknown age is never selected', () => {
  const check = nodusCheck();
  assert.deepEqual(schedulerSelection(check, policy({ caches: on({ maxAgeDays: 14 }) }), { now: NOW }), [ids.cache], 'the cache was last changed on 1 September');
  assert.deepEqual(schedulerSelection(check, policy({ caches: on({ maxAgeDays: 60 }) }), { now: NOW }), [], 'too recent for a 60-day rule');
  assert.deepEqual(schedulerSelection(check, policy({ tempFiles: on({ maxAgeDays: 2 }) }), { now: NOW }), [ids.group]);
  assert.deepEqual(schedulerSelection(check, policy({ tempFiles: on({ maxAgeDays: 7 }) }), { now: NOW }), [], 'five days old is not seven');
  assert.deepEqual(schedulerSelection(check, policy({ workspaces: on({ abandonedAfterHours: 1 }) }), { now: NOW }), [ids.staging, ids.hostBundle]);
  assert.deepEqual(schedulerSelection(check, policy({ logs: on({ rotatedMaxAgeDays: 14 }) }), { now: NOW }), [ids.journal], 'the journal vacuum has a size limit, not an age');
  assert.deepEqual(schedulerSelection(check, policy({ history: on({ maxAgeDays: 30 }) }), { now: NOW }), [ids.dump]);
  assert.deepEqual(schedulerSelection(check, policy({ caches: on({ maxAgeDays: 0 }) }), { now: NOW }), [], 'an invalid limit selects nothing');
  const noAge = nodusCheck(); noAge.items.find(i => i.id === ids.cache).newestMtimeMs = undefined; noAge.items.find(i => i.id === ids.cache).identity = {};
  assert.deepEqual(schedulerSelection(noAge, policy({ caches: on({ maxAgeDays: 14 }) }), { now: NOW }), []);
});

test('never snapshots, exports or releases, whatever the policy says', () => {
  const all = policy({ workspaces: on({ abandonedAfterHours: 1 }), caches: on({ maxAgeDays: 1 }), tempFiles: on({ maxAgeDays: 1 }), testArtifacts: on({ maxAgeDays: 1 }), logs: on({ rotatedMaxAgeDays: 1 }), history: on({ maxAgeDays: 1 }) });
  const picked = schedulerSelection(nodusCheck(), all, { now: NOW });
  for (const never of [ids.release, ids.snap1, ids.snap2, ids.export1, ids.live, ids.other]) assert.ok(!picked.includes(never), never);
  assert.deepEqual(enabledPeriodicRules(policy({})), [], 'releases and snapshots rules are not periodic rules');
});

test("the policy's own selection must agree", () => {
  const p = policy({ caches: on({ maxAgeDays: 14 }), history: on({ maxAgeDays: 30 }) });
  assert.deepEqual(schedulerSelection(nodusCheck(), p, { now: NOW, policySelection: () => [{ id: ids.dump }, { id: ids.release }] }), [ids.dump]);
});

function scheduler({ policyFor, activity = () => ({ openJobs: [], buildActive: false, reasons: [] }), cleanup = null, check = nodusCheck() } = {}) {
  const calls = { checks: [], cleanups: [], alerts: [] };
  const s = createRetentionScheduler({
    listTargets: () => [{ key: 'application:1', name: 'Nodus' }],
    resolveTarget: () => nodusTarget(),
    policyFor,
    runCheck: async key => { calls.checks.push(key); return check; },
    activityFor: activity,
    requestCleanup: async spec => { calls.cleanups.push(spec); if (cleanup) return cleanup(spec); return { changed: true, cleanupId: 'cln_x', jobId: 'j' }; },
    monitor: { postCleanupAlert: e => calls.alerts.push(e) },
    now: () => NOW,
  });
  return { s, calls };
}

test('proposed rules never run: no check, no cleanup', async () => {
  const { s, calls } = scheduler({ policyFor: () => policy({}) });
  const out = await s.runOnce();
  assert.equal(out.targets[0].skipped, 'no periodic rule is turned on');
  assert.equal(calls.checks.length, 0); assert.equal(calls.cleanups.length, 0);
  const none = scheduler({ policyFor: () => null });
  await none.s.runOnce();
  assert.equal(none.calls.checks.length, 0, 'no stored policy means nothing is enabled');
});

test('an enabled rule runs a policy check and requests a policy cleanup of exactly its items', async () => {
  const { s, calls } = scheduler({ policyFor: () => policy({ caches: on({ maxAgeDays: 14 }), tempFiles: on({ maxAgeDays: 2 }) }) });
  const out = await s.runOnce();
  assert.deepEqual(calls.checks, ['application:1']);
  assert.deepEqual(calls.cleanups, [{ targetKey: 'application:1', checkId: 'chk-1', items: [ids.group, ids.cache], snapshots: [], exports: [], acknowledgeSnapshotLoss: false, scope: 'categories', origin: 'policy', userId: null }]);
  assert.equal(out.targets[0].selected, 2);
});

test('a busy application is skipped without an alert; a failure is alerted', async () => {
  const busy = scheduler({ policyFor: () => policy({ caches: on() }), activity: () => ({ buildActive: true }) });
  assert.match((await busy.s.runOnce()).targets[0].skipped, /^busy/);
  assert.equal(busy.calls.checks.length, 0); assert.equal(busy.calls.alerts.length, 0);
  const raced = scheduler({ policyFor: () => policy({ caches: on({ maxAgeDays: 14 }) }), cleanup: () => { throw Object.assign(new Error('busy'), { code: 'GUEST_BUSY' }); } });
  assert.match((await raced.s.runOnce()).targets[0].skipped, /busy/);
  assert.equal(raced.calls.alerts.length, 0);
  const broken = scheduler({ policyFor: () => policy({ caches: on({ maxAgeDays: 14 }) }), cleanup: () => { throw Object.assign(new Error('db'), { code: 'SQLITE_BUSY' }); } });
  const out = await broken.s.runOnce();
  assert.equal(out.targets[0].error, 'SQLITE_BUSY');
  assert.equal(broken.calls.alerts.length, 1); assert.equal(broken.calls.alerts[0].kind, 'cleanup'); assert.equal(broken.calls.alerts[0].ok, false);
});

test('the schedule: every six hours by default, overridable, off with PROXYPILOT_DISABLE_CRONS', async () => {
  const registered = [];
  const make = env => createRetentionScheduler({ listTargets: () => [], policyFor: () => null, runCheck: () => null, activityFor: () => ({}), requestCleanup: () => null, env, scheduleCron: (expr, fn, opts) => { registered.push({ expr, opts }); return { destroy() {} }; } });
  assert.equal(await make({ PROXYPILOT_DISABLE_CRONS: '1' }).start(), false);
  assert.equal(registered.length, 0);
  const a = make({}); assert.equal(await a.start(), true); a.stop();
  const b = make({ PROXYPILOT_APP_STORAGE_RETENTION_CRON: '5 3 * * *' }); await b.start(); b.stop();
  assert.deepEqual(registered.map(r => r.expr), [DEFAULT_CRON, '5 3 * * *']);
  assert.equal(DEFAULT_CRON, '23 */6 * * *');
});

test('one round at a time', async () => {
  let release;
  const s = createRetentionScheduler({ listTargets: () => new Promise(r => { release = () => r([]); }), policyFor: () => null, runCheck: () => null, activityFor: () => ({}), requestCleanup: () => null });
  const first = s.runOnce();
  assert.deepEqual(await s.runOnce(), { skipped: 'already running', targets: [] });
  release(); await first;
});
