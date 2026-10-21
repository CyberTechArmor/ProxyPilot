// Per-application storage and growth alerts: dedupe (out-of-band dispatch
// only when an alert is new), resolution with hysteresis, the growth window,
// the cleanup and health alerts the cleanup job posts, and the active set
// rebuilt from the bell rows after a restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createAppStorageMonitor, evaluateUsage, evaluateGrowth, postCleanupAlert, parseGuestList, createGuestLister, alertKey, parseAlertKey, usageAlert,
} from '../lib/app-storage/monitor.js';
import { createStorageStore, APP_STORAGE_SCHEMA } from '../lib/app-storage/store.js';
import { defaultPolicyFor } from '../lib/app-storage/policy.js';

const HOUR = 3_600_000;
function bell() {
  const rows = new Map(); const dispatched = []; const posts = [];
  return {
    rows, dispatched, posts,
    post(n) { posts.push(n); rows.set(n.dedupe_key, { ...rows.get(n.dedupe_key), ...n, dismissed: false }); },
    resolve(key, { reason } = {}) { const r = rows.get(key); if (r && !r.dismissed) { r.dismissed = true; r.reason = reason; return true; } return false; },
    list() { return [...rows.values()].filter((r) => !r.dismissed).map((r) => ({ dedupe_key: r.dedupe_key, level: r.level, title: r.title })); },
    async dispatch(m) { dispatched.push(m); },
  };
}
function world({ alerts = null } = {}) {
  const db = new DatabaseSync(':memory:'); db.exec(APP_STORAGE_SCHEMA);
  let now = Date.parse('2026-10-20T00:00:00Z');
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const store = createStorageStore(db, { now: clock.now });
  const target = { key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus', targetId: 'nodus' };
  const guests = new Map([['pp-nodus', { status: 'running', usedBytes: 1e9 }]]);
  const policy = defaultPolicyFor(target, {}).policy;
  if (alerts) policy.alerts = { ...policy.alerts, ...alerts };
  const b = bell();
  const monitor = createAppStorageMonitor({ store, listTargets: () => [target], listGuests: async () => guests, policyFor: () => ({ policy }), notifications: b, now: clock.now, logger: null });
  return { db, store, clock, guests, policy, bell: b, monitor, target, set: (bytes) => guests.set('pp-nodus', { status: 'running', usedBytes: bytes }) };
}

test('usage and growth decisions', () => {
  assert.deepEqual(evaluateUsage({ usedBytes: 10.4e9, warnBytes: 10e9 }), { action: 'raise', level: 'warning' });
  assert.deepEqual(evaluateUsage({ usedBytes: 15e9, warnBytes: 10e9 }), { action: 'raise', level: 'error' });
  assert.deepEqual(evaluateUsage({ usedBytes: 9.6e9, warnBytes: 10e9, active: true }), { action: 'keep' });
  assert.deepEqual(evaluateUsage({ usedBytes: 9.4e9, warnBytes: 10e9, active: true }), { action: 'resolve' });
  assert.deepEqual(evaluateUsage({ usedBytes: 9.6e9, warnBytes: 10e9, active: false }), { action: 'none' });
  assert.deepEqual(evaluateGrowth({ samples: [{ usedBytes: 1e9 }, { usedBytes: 2e9 }], usedBytes: 3.3e9, growthBytes: 2e9 }), { growth: 2.3e9, raise: true });
  assert.deepEqual(evaluateGrowth({ samples: [], usedBytes: 3e9, growthBytes: 2e9 }), { growth: 0, raise: false });
  assert.equal(usageAlert({ name: 'Nodus', guest: 'pp-nodus', targetKey: 'application:1', usedBytes: 10.4e9, warnBytes: 10e9, level: 'warning' }).title, 'Nodus uses 10.4 GB of storage (warning level 10 GB)');
  assert.deepEqual(parseAlertKey(alertKey('usage', 'application:1')), { kind: 'usage', targetKey: 'application:1' });
  assert.equal(parseAlertKey('storage:capacity:tank'), null);
});

test('a usage alert is posted once to the channels, refreshed in the bell, kept in the hysteresis band and resolved below 95 %', async () => {
  const w = world();
  w.set(10.4e9);
  await w.monitor.runOnce();
  const key = 'appstorage:usage:application:1';
  assert.equal(w.bell.rows.get(key).title, 'Nodus uses 10.4 GB of storage (warning level 10 GB)');
  assert.equal(w.bell.rows.get(key).level, 'warning');
  assert.equal(w.bell.rows.get(key).source, 'app-storage');
  assert.equal(w.bell.dispatched.length, 1);
  assert.deepEqual([w.bell.dispatched[0].event, w.bell.dispatched[0].link], ['appstorage.usage', '/storage/applications?target=application%3A1']);
  w.clock.advance(15 * 60_000);
  w.set(15.5e9);
  await w.monitor.runOnce();
  assert.equal(w.bell.rows.get(key).level, 'error', 'escalates at 1.5× the warning level');
  assert.equal(w.bell.dispatched.filter((d) => d.event === 'appstorage.usage').length, 1, 'the channels hear about a condition once');
  assert.equal(w.bell.dispatched.filter((d) => d.event === 'appstorage.growth').length, 1, 'the 5.1 GB jump is also growth');
  w.clock.advance(15 * 60_000); w.set(9.7e9);
  await w.monitor.runOnce();
  assert.equal(w.bell.rows.get(key).dismissed, false, 'within 95 % of the level it stays');
  w.clock.advance(15 * 60_000); w.set(9.4e9);
  const r = await w.monitor.runOnce();
  assert.equal(w.bell.rows.get(key).dismissed, true);
  assert.ok(r.resolved.includes(key));
  assert.equal(w.store.samplesSince('application:1', 0).length, 4, 'one sample per run');
});

test('a growth alert compares now with the lowest sample in the window and resolves when the window has moved on', async () => {
  const w = world();
  const key = 'appstorage:growth:application:1';
  w.set(1e9); await w.monitor.runOnce();
  w.clock.advance(6 * HOUR); w.set(2e9); await w.monitor.runOnce();
  assert.equal(w.bell.rows.has(key), false);
  w.clock.advance(6 * HOUR); w.set(3.3e9); await w.monitor.runOnce();
  assert.equal(w.bell.rows.get(key).title, 'Nodus grew by 2.3 GB in the last 24 hours');
  assert.equal(w.bell.dispatched.filter((d) => d.event === 'appstorage.growth').length, 1);
  w.clock.advance(20 * HOUR); await w.monitor.runOnce();
  assert.equal(w.bell.rows.get(key).dismissed, true, 'the 1 GB sample left the window');
});

test('alerts turned off: no samples, and open alerts are resolved', async () => {
  const w = world();
  w.set(30e9); await w.monitor.runOnce();
  assert.equal(w.bell.rows.get('appstorage:usage:application:1').dismissed, false);
  w.policy.alerts.enabled = false;
  w.clock.advance(HOUR);
  await w.monitor.runOnce();
  assert.equal(w.bell.rows.get('appstorage:usage:application:1').dismissed, true);
  assert.equal(w.store.samplesSince('application:1', 0).length, 1);
  w.guests.clear();
  w.policy.alerts.enabled = true;
  assert.equal((await w.monitor.runOnce()).sampled, 0, 'a guest without usage is not sampled');
});

test('after a restart the active set comes back from the bell rows, so a recovered condition still resolves', async () => {
  const w = world();
  w.bell.post({ level: 'warning', title: 'old', source: 'app-storage', dedupe_key: 'appstorage:usage:application:1' });
  w.bell.post({ level: 'error', title: 'pool', source: 'storage', dedupe_key: 'storage:capacity:tank' });
  assert.equal(await w.monitor.hydrate(), 1, 'only appstorage: rows are taken');
  w.set(1e9);
  await w.monitor.runOnce();
  assert.equal(w.bell.rows.get('appstorage:usage:application:1').dismissed, true);
  assert.equal(w.bell.rows.get('storage:capacity:tank').dismissed, false, 'the pool monitor\'s rows are not touched');
  assert.equal(w.bell.dispatched.length, 0);
});

test('the cleanup job posts the cleanup and health alerts; a later success resolves them', async () => {
  const b = bell();
  const failed = await postCleanupAlert('application:1', { ok: true, failedCount: 2, healthFailed: false }, { name: 'Nodus', notifications: b });
  assert.deepEqual(failed.posted, ['appstorage:cleanup:application:1']);
  const row = b.rows.get('appstorage:cleanup:application:1');
  assert.deepEqual([row.level, row.title], ['error', 'Storage cleanup for Nodus did not finish: 2 items failed']);
  assert.equal(b.dispatched.length, 1);
  assert.equal(b.dispatched[0].event, 'appstorage.cleanup');
  await postCleanupAlert('application:1', { ok: false, failedCount: 0 }, { name: 'Nodus', notifications: b });
  assert.equal(b.rows.get('appstorage:cleanup:application:1').title, 'Storage cleanup for Nodus did not finish: it stopped with an error');
  assert.equal(b.dispatched.length, 1, 'still the same open alert: no second dispatch');
  await postCleanupAlert('application:1', { ok: true, failedCount: 0, healthFailed: true }, { name: 'Nodus', notifications: b });
  assert.equal(b.rows.get('appstorage:cleanup:application:1').dismissed, true, 'a successful cleanup resolves it');
  assert.equal(b.rows.get('appstorage:health:application:1').title, 'Nodus failed its health check after a storage cleanup');
  assert.equal(b.dispatched.at(-1).event, 'appstorage.health');
  await postCleanupAlert('application:1', { ok: true }, { name: 'Nodus', notifications: b });
  assert.equal(b.rows.get('appstorage:health:application:1').dismissed, false, 'health untouched when it was not checked');
  const done = await postCleanupAlert('application:1', { ok: true, healthFailed: false }, { name: 'Nodus', notifications: b });
  assert.deepEqual(done.resolved, ['appstorage:health:application:1']);
});

test('the monitor exposes the open alerts per target and keeps its set in step with posted cleanup alerts', async () => {
  const w = world();
  await w.monitor.postCleanupAlert('application:1', { ok: true, failedCount: 1 }, { name: 'Nodus' });
  assert.ok(w.monitor.active.has('appstorage:cleanup:application:1'));
  assert.deepEqual(w.monitor.alertsFor('application:1').map((a) => [a.kind, a.level]), [['cleanup', 'error']]);
  assert.deepEqual(w.monitor.alertsFor('project:9'), []);
  await w.monitor.postCleanupAlert('application:1', { ok: true, failedCount: 0 }, { name: 'Nodus' });
  assert.equal(w.monitor.active.has('appstorage:cleanup:application:1'), false);
});

test('guest list parsing and the cached lister', async () => {
  const list = [
    { name: 'pp-nodus', project: 'other', status: 'Stopped', state: { disk: { root: { usage: 5 } } } },
    { name: 'pp-nodus', project: 'default', status: 'Running', state: { disk: { root: { usage: 2956918784 } } } },
    { name: 'm2-4', status: 'Running', state: null },
  ];
  const m = parseGuestList(JSON.stringify(list));
  assert.deepEqual(m.get('pp-nodus'), { status: 'Running', usedBytes: 2956918784, project: 'default' }, 'the status is kept as Incus says it');
  assert.equal(m.get('m2-4').usedBytes, null);
  assert.equal(parseGuestList('nope').size, 0);
  let calls = 0; let t = 0;
  const exec = { host: async (argv) => { calls += 1; return argv.includes('--all-projects') ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify(list) }; } };
  const lister = createGuestLister(exec, { ttlMs: 1000, now: () => t });
  assert.equal((await lister()).get('pp-nodus').status, 'Running');
  assert.equal(calls, 2, 'falls back to the plain list');
  await lister();
  assert.equal(calls, 2, 'cached');
  t = 5000; await lister();
  assert.equal(calls, 4);
});
