// The review of ad1a638 (A-17.8): seven reproductions, established through
// the actual handlers, store, executor and retry / reconcile paths, then
// asserted in their corrected form. Every symbol imported here exists at
// the reviewed head, so this file runs unchanged against it (where the
// seven fail as the reviewer found) and against the correction (where they
// pass). The fixture models the firewall CLI's real order: the desired
// configuration is SAVED before it is reconciled, and a rejected reconcile
// leaves the saved configuration in place.
//
//   1. a rejected egress application is not verified; a retry applies it
//   2. a saved rule under the expected id with the wrong port or protocol
//      never passes verification
//   3. a refused forward removal preserves its row and its host state
//   4. a retry of a partially failed addition never succeeds with host
//      resources and no authoritative row
//   5. an older forward retry preserves the reservations newer forwards need
//   6. a missing original snapshot after the first mutation prevents the
//      remaining mutations
//   7. a replaced original snapshot after the first mutation prevents them
//   +  the row-settlement path interrupted after its row and device: the
//      obligation survives, the resumed job settles once; a resumed job
//      whose remaining state already holds completes read-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownerIdentity, parseJson, retryPlan } from '../lib/setup-engine/logic.js';
import { ensureSetupEngineSchema, getJob, listEvents, readLock, acquireLock, releaseLock, createJob, claimNextJob, checkpoint, listJobs } from '../lib/setup-engine/store.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { submitRunnerJob, resultFromJob } from '../lib/setup-engine/orchestrator.js';
import { configureContainerLockStore } from '../mock2/container-lock.js';
import { runGuestConfig } from '../mock2/ops.js';
import { createExtendedHandlers } from '../routes/mcp-tools/index.js';
import { PROXYPILOT_BIN } from '../lib/setup-engine/config-logic.js';
import { reservedPortsBody } from '../lib/l4-reserved-ports.js';
import { scriptedGuest, LOGIN } from './helpers/scripted-guest.js';
import { scriptedConfigHost, forwardsSchema, forwardRows, mcpCtx, parse, AUTH } from './helpers/scripted-config-host.js';

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const DEAD = ownerIdentity({ kind: 'runner', host: 'pp', pid: 999, instance: 'dead' });
const OTHER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 301, instance: 'oooo' });
const UUID_A = '11111111-2222-3333-4444-555555555555';
const IDENTITY = { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' };

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); forwardsSchema(d); return d; }
function tmp() { return mkdtempSync(join(tmpdir(), 'pp-config-review-')); }
const inst = (over = {}) => ({
  name: 'pp-x', status: 'Running', created_at: '2026-09-01T10:00:00Z',
  config: { 'volatile.uuid': UUID_A, 'limits.cpu': '2', 'limits.memory': '2048MB' }, devices: {},
  expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' }, eth0: { type: 'nic', network: 'incusbr0' } },
  snapshots: [], state: { network: { eth0: { addresses: [{ family: 'inet', address: '10.10.10.5', scope: 'global' }] } } },
  ...over,
});
const exec = (h) => ({ guest: scriptedGuest({}).guest, host: h.host });
function clock(start = T0) { const c = { t: start }; c.nowMs = () => c.t; c.sleep = async (ms) => { c.t += ms; }; c.tick = (ms) => { c.t += ms; }; return c; }
const runAll = (d, ex, c, opts = {}) => runOnce({ db: d, owner: opts.owner || RUNNER, exec: ex, reviewLogin: async () => LOGIN, nowMs: c.nowMs, sleep: c.sleep, keepAliveMs: 60_000, reservedPortsPath: opts.reservedPortsPath || null, heartbeat: false, log: () => {} }, { reconcileFirst: false, ...opts });
const READS = (a) => (a[0] === 'incus' && a[1] === 'list') || (a[0] === PROXYPILOT_BIN && (a[3] === 'list' || a[3] === 'status' || (a[3] === 'reconcile' && a[4] === '--dry-run') || (a[3] === 'egress' && a[4] === 'list'))) || a[0] === 'cat' || (a[0] === 'sysctl' && a[1] === '-n');
const mutations = (h) => h.calls.filter((a) => !READS(a));
const submit = (d, kind, params, extra = {}) => submitRunnerJob(d, { kind, app: params.container, params, nowMs: T0, ...extra });
const storeFor = (d, h, extra = {}) => configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(h), hostExec: h.host, reviewLogin: async () => LOGIN, ...extra });
const applied = (r) => Object.fromEntries(Object.entries(r.applied || {}).map(([k, a]) => [k, a.state]));

// ── 1. saved is not applied ────────────────────────────────────────────────

test('review 1: an egress allow the CLI saves but cannot apply (reconcile rejected) is NOT verified — the job fails naming the policy step with the saved entry on the record; a retry after the lockout is fixed issues no second allow, reconciles once, and only then reports verified', async (t) => {
  const d = db(); const c = clock(); const st = { instances: [inst()], rejectReconcile: 'lockout: the SSH source would be blocked' }; const h = scriptedConfigHost(st);
  storeFor(d, h); t.after(() => configureContainerLockStore(null));
  const first = await runGuestConfig({ kind: 'egress_set', containerName: 'pp-x', action: 'allow', service: 'smtp', reason: 'relay' });
  assert.equal(first.ok, false, `saved-but-rejected must not verify: ${JSON.stringify(first)}`);
  assert.deepEqual(st.egress, [{ container: 'x', allow: ['smtp'], reason: 'relay' }], 'the CLI saved the entry');
  assert.equal(getJob(d, first.jobId).status, 'failed'); assert.notEqual(getJob(d, first.jobId).outcome, 'egress_set');
  assert.match(getJob(d, first.jobId).reason, /lockout/, 'the rejection is on the record');
  // The repeat while still rejected: nothing verified either, no "already done".
  const again = await runGuestConfig({ kind: 'egress_set', containerName: 'pp-x', action: 'allow', service: 'smtp' });
  assert.equal(again.ok, false, 'a repeated request must not skip application'); assert.equal(again.alreadyInState, undefined);
  // The lockout is fixed: the retry applies through the reconcile, without a second allow.
  st.rejectReconcile = null; h.calls.length = 0;
  const retry = createJob(d, { kind: 'egress_set', app: 'pp-x', plan: retryPlan(getJob(d, first.jobId)), retryOf: first.jobId, nowMs: c.nowMs() });
  await runAll(d, exec(h), c);
  const rr = getJob(d, retry.id); assert.equal(rr.status, 'succeeded', rr.reason);
  const m = mutations(h);
  assert.ok(!m.some((a) => a[0] === PROXYPILOT_BIN && a[3] === 'egress' && a[4] === 'allow'), `no second allow: ${JSON.stringify(m)}`);
  assert.deepEqual(m.filter((a) => a[0] === PROXYPILOT_BIN && a[3] === 'reconcile' && a[4] !== '--dry-run'), [[PROXYPILOT_BIN, '--json', 'firewall', 'reconcile']], 'one reconcile');
  assert.equal(st.reconciles[st.reconciles.length - 1].applied, 1); assert.equal(st.appliedChecksum, h.checksum());
});

test('review 2: a saved firewall rule under the expected id with the wrong port, or the wrong protocol, never passes verification — the forward is not reported applied and the job rolls its row back', async (t) => {
  for (const flag of ['fwSaveWrongPort', 'fwSaveWrongProto']) {
    const d = db(); const st = { instances: [inst()], [flag]: true }; const h = scriptedConfigHost(st);
    storeFor(d, h);
    try {
      const tools = createExtendedHandlers(mcpCtx(d, st).ctx).handlers;
      const out = parse(await tools.set_port_forward({ container: 'x', protocol: 'tcp', listen_port: 7881, connect_port: 7881, confirm: true }, AUTH));
      assert.equal(out.added, undefined, `${flag}: a rule saved with other properties must not verify: ${JSON.stringify(out)}`);
      assert.match(out.error, /rule.*present with other properties \((port_start|proto)=/, `${flag}: the mismatch is named`);
      assert.deepEqual(forwardRows(d), [], `${flag}: no authoritative row for a forward that did not verify`);
      assert.deepEqual(st.instances[0].devices, {}, `${flag}: the device this attempt added is rolled back`);
      assert.deepEqual(st.rules, [], `${flag}: the mismatching rule this attempt saved is rolled back`);
    } finally { configureContainerLockStore(null); }
  }
});

// ── 2. the row is the job's ─────────────────────────────────────────────

test('review 3: a forward removal refused at submission (the guest busy) leaves the row and the host state exactly as they were, with no removal job', async (t) => {
  const d = db(); const st = { instances: [inst({ devices: { 'ppl4-f1': { type: 'proxy', listen: 'tcp:0.0.0.0:7881', connect: 'tcp:10.10.10.5:7881' } } })], rules: [{ id: 'service-l4-f1', source: 'service-l4', port_start: 7881, port_end: null, proto: 'tcp', scope: 'public', enabled: true }] }; const h = scriptedConfigHost(st);
  d.prepare(`INSERT INTO service_l4_forwards (id, service_id, proto, listen_port, connect_port, enabled) VALUES ('f1', 'svc-x', 'tcp', 7881, 7881, 1)`).run();
  storeFor(d, h); t.after(() => configureContainerLockStore(null));
  const tools = createExtendedHandlers(mcpCtx(d, st).ctx).handlers;
  acquireLock(d, { app: 'pp-x', owner: OTHER, operation: 'deploy', jobId: 'dep', leaseMs: 120_000, nowMs: Date.now() });
  const out = parse(await tools.set_port_forward({ container: 'x', action: 'remove', forward_id: 'f1', confirm: true }, AUTH));
  assert.equal(out.removed, false, JSON.stringify(out)); assert.match(out.error, /deploy .* is in progress for pp-x/); assert.equal(out.job_id, null, 'no job was created');
  assert.deepEqual(forwardRows(d).map((r) => r.id), ['f1'], 'the row is preserved');
  assert.deepEqual(Object.keys(st.instances[0].devices), ['ppl4-f1']); assert.deepEqual(st.rules.map((r) => r.id), ['service-l4-f1']);
  assert.deepEqual(mutations(h), []); assert.ok(listJobs(d).every((j) => j.status !== 'queued' && j.status !== 'running'), 'nothing left queued to remove it later');
});

test('review 4: a partially failed addition (the firewall refuses after the device was added) is rolled back by the job — row, device and rule; a retry re-records the row before it touches the host and ends with row AND host; a retry whose port was taken meanwhile is refused with this id\'s orphans removed, never a success without a row', async (t) => {
  const d = db(); const c = clock(); const st = { instances: [inst()], fwAddFails: true }; const h = scriptedConfigHost(st);
  storeFor(d, h); t.after(() => configureContainerLockStore(null));
  const tools = createExtendedHandlers(mcpCtx(d, st).ctx).handlers;
  const first = parse(await tools.set_port_forward({ container: 'x', protocol: 'tcp', listen_port: 7881, connect_port: 7881, confirm: true }, AUTH));
  assert.equal(first.added, undefined); assert.match(first.error, /panic mode/); assert.ok(first.job_id);
  assert.deepEqual(forwardRows(d), [], 'the row is rolled back'); assert.deepEqual(st.instances[0].devices, {}, 'the device this attempt added is rolled back');
  assert.match(getJob(d, first.job_id).reason, /rolled back: row removed, device removed, rule absent/);
  // The retry: the row is written first, then the host; success has both.
  st.fwAddFails = false; h.calls.length = 0;
  const retry = createJob(d, { kind: 'forward_apply', app: 'pp-x', plan: retryPlan(getJob(d, first.job_id)), retryOf: first.job_id, nowMs: c.nowMs() });
  await runAll(d, exec(h), c);
  const rr = getJob(d, retry.id); assert.equal(rr.status, 'succeeded', rr.reason);
  assert.deepEqual(forwardRows(d).map((r) => [r.id, r.proto, r.listen_port]), [['fwd-1', 'tcp', 7881]], 'the authoritative row');
  assert.equal(st.instances[0].devices['ppl4-fwd-1'].type, 'proxy'); assert.equal(st.rules[0].id, 'service-l4-fwd-1');
  const order = mutations(h).map((a) => (a[0] === 'incus' ? `incus ${a[3]} ${a[5]}` : `${a[3]}`));
  assert.deepEqual(order.slice(0, 2), ['incus add ppl4-fwd-1', 'add-service-l4'], `the row precedes the host: ${order}`);
  assert.ok(listEvents(d, retry.id).some((e) => /record forward fwd-1 in service_l4_forwards/.test(e.message || '')), 'the row step is on the record before the device');
  // Superseded: the port is taken by another forward before a retry of a rolled-back attempt.
  st.fwAddFails = true;
  const second = parse(await tools.set_port_forward({ container: 'x', protocol: 'udp', listen_port: 5000, connect_port: 5000, confirm: true }, AUTH));
  assert.equal(second.added, undefined); assert.deepEqual(forwardRows(d).map((r) => r.id), ['fwd-1']);
  st.fwAddFails = false;
  d.prepare(`INSERT INTO service_l4_forwards (id, service_id, proto, listen_port, connect_port, enabled) VALUES ('newer', 'svc-x', 'udp', 5000, 5000, 1)`).run();
  st.instances[0].devices['ppl4-fwd-2'] = { type: 'proxy', listen: 'udp:0.0.0.0:5000', connect: 'udp:10.10.10.5:5000' };
  h.calls.length = 0;
  const retry2 = createJob(d, { kind: 'forward_apply', app: 'pp-x', plan: retryPlan(getJob(d, second.job_id)), retryOf: second.job_id, nowMs: c.nowMs() });
  await runAll(d, exec(h), c);
  const r2 = getJob(d, retry2.id); assert.equal(r2.status, 'refused', r2.reason); assert.match(r2.reason, /superseded: another forward \(newer\) binds udp\/5000/);
  assert.deepEqual(forwardRows(d).map((r) => r.id).sort(), ['fwd-1', 'newer'], 'no row for the superseded forward');
  assert.equal(st.instances[0].devices['ppl4-fwd-2'], undefined, 'the orphan device of the superseded id is removed');
  assert.ok(!st.rules.some((r) => r.id === 'service-l4-fwd-2'));
  assert.equal(resultFromJob(r2).superseded, true);
});

test('review 5: an older retry recomputes the reserved UDP ranges from the rows under the lease — a newer forward\'s range survives it', async (t) => {
  const d = db(); const c = clock(); const dir = tmp(); const path = join(dir, '99-l4.conf');
  const st = { instances: [inst()], fwAddFails: true }; const h = scriptedConfigHost(st);
  storeFor(d, h, { reservedPortsPath: path }); t.after(() => { configureContainerLockStore(null); rmSync(dir, { recursive: true, force: true }); });
  const tools = createExtendedHandlers(mcpCtx(d, st).ctx).handlers;
  const older = parse(await tools.set_port_forward({ container: 'x', protocol: 'udp', listen_port: 50000, listen_port_end: 50100, connect_port: 50000, confirm: true }, AUTH));
  assert.equal(older.added, undefined); assert.ok(older.job_id);
  st.fwAddFails = false;
  const newer = parse(await tools.set_port_forward({ container: 'x', protocol: 'udp', listen_port: 60000, listen_port_end: 60100, connect_port: 60000, confirm: true }, AUTH));
  assert.equal(newer.added, true, JSON.stringify(newer)); assert.equal(readFileSync(path, 'utf8'), reservedPortsBody('60000-60100'));
  const retry = createJob(d, { kind: 'forward_apply', app: 'pp-x', plan: retryPlan(getJob(d, older.job_id)), retryOf: older.job_id, nowMs: c.nowMs() });
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  assert.equal(getJob(d, retry.id).status, 'succeeded', getJob(d, retry.id).reason);
  assert.equal(readFileSync(path, 'utf8'), reservedPortsBody('50000-50100,60000-60100'), 'the newer range is kept'); assert.equal(st.sysctl, '50000-50100,60000-60100');
});

// ── 3. the original snapshot through a partial resume ──────────────────────

for (const [label, snaps] of [['missing', []], ['replaced under its name', [{ name: 'pp-mcp-pre-resources-2', created_at: '2026-09-26T11:59:00Z' }]]]) {
  test(`review ${label === 'missing' ? 6 : 7}: a config_set resumed after its first write with the original snapshot ${label} reads the applied key back and does NOT issue the remaining one; the record is partial with the prior values and recovery guidance; no replacement snapshot is taken`, async () => {
    const d = db(); const c = clock();
    const st = { instances: [inst({ config: { 'volatile.uuid': UUID_A, 'limits.cpu': '4', 'limits.memory': '2048MB' }, snapshots: snaps })] }; const h = scriptedConfigHost(st);
    const params = { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MB' }], snapshot: { name: 'pp-mcp-pre-resources-2' }, expect: IDENTITY };
    createJob(d, { id: 'dead-1', kind: 'config_set', app: 'pp-x', plan: { steps: [], params }, nowMs: T0 - 100_000 });
    const claimed = claimNextJob(d, { owner: DEAD, kinds: ['config_set'], nowMs: T0 - 99_000 });
    checkpoint(d, { id: 'dead-1', owner: DEAD, epoch: claimed.epoch, phase: 'applied', checkpoint: { config: true, resumable: true, disruptive: false, issued: true, target: IDENTITY, container: 'pp-x', kind: 'config_set', previous: { config: { 'limits.cpu': '2', 'limits.memory': '2048MB' } }, snapshot: { name: 'pp-mcp-pre-resources-2', created_at: '2026-09-26T11:00:00Z', reused: false }, applied: { 'config:limits.cpu': { state: 'done', issued: true } } }, nowMs: T0 - 98_000 });
    assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: T0 }).requeued, ['dead-1']);
    await runAll(d, exec(h), c);
    const row = getJob(d, 'dead-1');
    assert.equal(st.instances[0].config['limits.memory'], '2048MB', 'the remaining change was NOT issued');
    assert.deepEqual(mutations(h), [], 'nothing issued: no config set, no snapshot');
    assert.equal(row.status, 'failed', row.reason); assert.equal(row.outcome, 'failed at protect');
    const r = resultFromJob(row);
    assert.deepEqual(applied(r), { 'config:limits.cpu': 'done', 'config:limits.memory': 'not_run' });
    assert.equal(r.partial, true); assert.equal(r.protection.state, label === 'missing' ? 'missing' : 'replaced'); assert.equal(r.snapshot.verified, false);
    assert.deepEqual(r.previous, { config: { 'limits.cpu': '2', 'limits.memory': '2048MB' } }, 'the prior values for reversal');
    assert.match(row.reason, /the remaining change \(config:limits\.memory\) was NOT issued/); assert.match(row.reason, /revert them from those values, or submit a new request deliberately/);
    assert.equal(st.instances[0].snapshots.length, snaps.length, 'no replacement snapshot');
  });
}

test('review +: the row-settlement path interrupted after the row and the device (the owner dead): the runner\'s reconcile requeues it, the resumed job reads the row and the device as done, issues the rule and the reconcile once and settles once — a second pass changes nothing; a resumed config_set whose remaining state already holds completes read-only under a missing snapshot', async (t) => {
  const d = db(); const c = clock(); const dir = tmp(); const path = join(dir, '99-l4.conf'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const st = { instances: [inst({ devices: { 'ppl4-f1': { type: 'proxy', listen: 'tcp:0.0.0.0:7881', connect: 'tcp:10.10.10.5:7881' } } })] }; const h = scriptedConfigHost(st);
  d.prepare(`INSERT INTO service_l4_forwards (id, service_id, proto, listen_port, connect_port, enabled) VALUES ('f1', 'svc-x', 'tcp', 7881, 7881, 1)`).run();
  const params = { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 7881, connect: 7881 }, bridgeIp: '10.10.10.5', serviceId: 'svc-x', serviceTag: 'x', expect: IDENTITY };
  createJob(d, { id: 'dead-fwd', kind: 'forward_apply', app: 'pp-x', plan: { steps: [], params }, nowMs: T0 - 100_000 });
  const claimed = claimNextJob(d, { owner: DEAD, kinds: ['forward_apply'], nowMs: T0 - 99_000 });
  checkpoint(d, { id: 'dead-fwd', owner: DEAD, epoch: claimed.epoch, phase: 'applied', checkpoint: { config: true, resumable: true, disruptive: false, issued: true, target: IDENTITY, container: 'pp-x', kind: 'forward_apply', applied: { row: { state: 'done', issued: true }, device: { state: 'done', issued: true } } }, nowMs: T0 - 98_000 });
  assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: T0 }).requeued, ['dead-fwd']);
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  const row = getJob(d, 'dead-fwd'); assert.equal(row.status, 'succeeded', row.reason); assert.match(row.reason, /resumed after an interrupted attempt/);
  const r = resultFromJob(row);
  assert.deepEqual(applied(r), { row: 'done', device: 'done', rule: 'done', reconcile: 'already', reserved: 'already' }, 'the rule\'s own reconcile applied the policy; the reconcile step reads that evidence and issues nothing');
  assert.deepEqual(mutations(h).map((a) => a[3] || a[1]), ['add-service-l4'], 'the rule saved once, no second reconcile');
  assert.deepEqual(forwardRows(d).map((x) => x.id), ['f1']);
  h.calls.length = 0;
  const again = submit(d, 'forward_apply', params, { nowMs: c.nowMs() + 1 });
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  assert.equal(resultFromJob(getJob(d, again.job.id)).alreadyInState, true); assert.deepEqual(mutations(h), [], 'settled once');
  // Read-only completion under a missing snapshot.
  st.instances = [inst({ config: { 'volatile.uuid': UUID_A, 'limits.cpu': '4', 'limits.memory': '4096MB' } })]; h.calls.length = 0;
  const cfg = { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MB' }], snapshot: { name: 'pp-mcp-pre-resources-3' }, expect: IDENTITY };
  createJob(d, { id: 'dead-cfg', kind: 'config_set', app: 'pp-x', plan: { steps: [], params: cfg }, nowMs: T0 - 100_000 });
  const cl = claimNextJob(d, { owner: DEAD, kinds: ['config_set'], nowMs: T0 - 99_000 });
  checkpoint(d, { id: 'dead-cfg', owner: DEAD, epoch: cl.epoch, phase: 'applied', checkpoint: { config: true, resumable: true, disruptive: false, issued: true, target: IDENTITY, container: 'pp-x', kind: 'config_set', snapshot: { name: 'pp-mcp-pre-resources-3', created_at: '2026-09-26T11:00:00Z' }, applied: { 'config:limits.cpu': { state: 'done', issued: true }, 'config:limits.memory': { state: 'done', issued: true } } }, nowMs: T0 - 98_000 });
  reconcile({ db: d, owner: RUNNER, nowMs: c.nowMs() });
  await runAll(d, exec(h), c);
  const cr = getJob(d, 'dead-cfg'); assert.equal(cr.status, 'succeeded', cr.reason);
  const cres = resultFromJob(cr); assert.deepEqual(applied(cres), { 'config:limits.cpu': 'done', 'config:limits.memory': 'done' }); assert.equal(cres.snapshot.verified, false); assert.equal(cres.snapshot.missing, true);
  assert.match((cres.warnings || []).join(' '), /no longer on pp-x.*no further change was needed/); assert.deepEqual(mutations(h), []);
  assert.equal(readLock(d, 'pp-x'), null); void releaseLock; void parseJson;
});
