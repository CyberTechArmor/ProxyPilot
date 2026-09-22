// The review of e97a66a (A-17.8, the second review): four reproductions,
// established through the actual store, executor, retry and reconcile
// paths, then asserted in their corrected form. Every symbol imported here
// exists at the reviewed head, so this file runs unchanged against it
// (where the four fail as the reviewer found) and against the correction
// (where they pass).
//
//    8. a fenced rollback preserves the next owner's state: the worker whose
//       claim the runner's reconcile expired and requeued (another owner
//       completing the job meanwhile) returns fenced and deletes nothing
//    9. a failed retry preserves a pre-existing working forward: rollback
//       removes only what this operation created; a fresh partial forward
//       still removes its own row and device, also after an interruption
//   10. a retry of a retry keeps the original snapshot's protection: no
//       replacement snapshot and no remaining write at any depth of the
//       chain, nor on a resume of a retry; a new request stays distinct
//   11. a recorded snapshot without a timestamp certifies nothing: the
//       remaining write is refused, before and after the first write

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { ownerIdentity, retryPlan } from '../lib/setup-engine/logic.js';
import { ensureSetupEngineSchema, getJob, listEvents, readLock, createJob, claimNextJob, checkpoint, recordGenerated } from '../lib/setup-engine/store.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { submitRunnerJob, resultFromJob } from '../lib/setup-engine/orchestrator.js';
import { PROXYPILOT_BIN } from '../lib/setup-engine/config-logic.js';
import { scriptedGuest, LOGIN } from './helpers/scripted-guest.js';
import { scriptedConfigHost, forwardsSchema, forwardRows } from './helpers/scripted-config-host.js';

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const LEASE_MS = 30_000;
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const OTHER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 301, instance: 'oooo' });
const DEAD = ownerIdentity({ kind: 'runner', host: 'pp', pid: 999, instance: 'dead' });
const UUID_A = '11111111-2222-3333-4444-555555555555';
const IDENTITY = { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' };

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); forwardsSchema(d); return d; }
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
const mutations = (calls) => calls.filter((a) => !READS(a));
const submit = (d, kind, params, extra = {}) => submitRunnerJob(d, { kind, app: params.container, params, nowMs: T0, ...extra });
const applied = (r) => Object.fromEntries(Object.entries(r.applied || {}).filter(([k]) => k !== 'rollback').map(([k, a]) => [k, a.state]));
const FWD = { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 7881, connect: 7881 }, bridgeIp: '10.10.10.5', serviceId: 'svc-x', serviceTag: 'x', expect: IDENTITY };
const CFG = { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MB' }], snapshot: { name: 'pp-mcp-pre-resources-2' }, expect: IDENTITY };
// A job of a dead owner, interrupted after its first write with the state the
// real job would have recorded: the checkpoint (issued, the snapshot's
// identity, the applied step) and the generated record of its snapshot.
function deadConfigJob(d, id, { snapshot, generated = true, issued = true, appliedSteps = { 'config:limits.cpu': { state: 'done', issued: true } } }) {
  createJob(d, { id, kind: 'config_set', app: 'pp-x', plan: { steps: [], params: CFG }, nowMs: T0 - 100_000 });
  const claimed = claimNextJob(d, { owner: DEAD, kinds: ['config_set'], nowMs: T0 - 99_000 });
  if (generated && snapshot) recordGenerated(d, { id, owner: DEAD, epoch: claimed.epoch, resource: { kind: 'snapshot', name: snapshot.name, where: 'pp-x', created_at: snapshot.created_at }, nowMs: T0 - 98_500 });
  checkpoint(d, { id, owner: DEAD, epoch: claimed.epoch, phase: issued ? 'applied' : 'protect', checkpoint: { config: true, resumable: true, disruptive: false, issued, target: IDENTITY, container: 'pp-x', kind: 'config_set', previous: { config: { 'limits.cpu': '2', 'limits.memory': '2048MB' } }, snapshot: { ...snapshot, reused: false, verified: true }, applied: issued ? appliedSteps : null }, nowMs: T0 - 98_000 });
  return claimed;
}

// ── 8. ownership at the database boundary and the rollback ───────────────

test('review 8: a forward job whose device command fails, expired and requeued by the runner\'s reconcile during the following read and completed by another owner meanwhile — the old worker returns fenced, issues nothing further and preserves the new owner\'s row, the job record and the host state', async () => {
  const d = db(); const c = clock(); const st = { instances: [inst()], deviceAddFails: true }; const h = scriptedConfigHost(st);
  const sub = submit(d, 'forward_apply', FWD); const id = sub.job.id;
  let nested = null; let fired = false;
  st.hook = async (argv) => {
    // The read-back after the failed `device add`: the claim and the leases
    // expire under it, the reconcile requeues the job, another runner claims
    // it and completes it, and only then does the old worker's read return.
    if (fired || argv[0] !== 'incus' || argv[1] !== 'list' || !h.calls.some((a) => a[0] === 'incus' && a[1] === 'config' && a[3] === 'add')) return null;
    fired = true; st.hook = null; st.deviceAddFails = false;
    assert.deepEqual(forwardRows(d).map((r) => r.id), ['f1'], 'the old worker wrote its row before the device');
    c.tick(LEASE_MS + 1_000);
    const rec = reconcile({ db: d, owner: OTHER, nowMs: c.nowMs() });
    assert.deepEqual(rec.requeued, [id], 'the runner\'s reconcile requeues the expired job');
    const from = h.calls.length;
    const out = await runAll(d, exec(h), c, { owner: OTHER });
    nested = { out, calls: h.calls.slice(from), after: h.calls.length };
    return null;
  };
  const first = await runAll(d, exec(h), c);
  assert.ok(fired, 'the interleaving happened');
  assert.equal(nested.out.ran[0].status, 'succeeded', JSON.stringify(nested.out.ran[0]));
  const row = getJob(d, id);
  assert.equal(row.status, 'succeeded', row.reason); assert.equal(row.owner, OTHER, 'the job record is the new owner\'s');
  assert.deepEqual(forwardRows(d).map((r) => [r.id, r.proto, r.listen_port]), [['f1', 'tcp', 7881]], 'the new owner\'s row is preserved');
  assert.equal(st.instances[0].devices['ppl4-f1']?.type, 'proxy', 'the device the new owner added is preserved');
  assert.deepEqual(st.rules.map((r) => r.id), ['service-l4-f1'], 'the rule the new owner saved is preserved');
  assert.equal(first.ran[0].status, 'fenced', `the old worker is fenced, not failed: ${JSON.stringify(first.ran[0])}`);
  assert.deepEqual(mutations(h.calls.slice(nested.after)), [], 'the old worker issued nothing after its read returned');
  assert.ok(!listEvents(d, id).some((e) => e.phase === 'rollback' || /rolled back/.test(e.message || '')), 'no rollback was recorded by anyone');
  assert.equal(readLock(d, 'pp-x'), null); assert.equal(readLock(d, '@host/firewall'), null);
});

// ── 9. rollback limited to what this operation created ──────────────────

test('review 9: a retry of a completed forward that fails at the reconcile because an unrelated saved policy is rejected keeps the working forward — the row, the device and the rule survive, and the result reports the policy as unresolved', async () => {
  const d = db(); const c = clock(); const st = { instances: [inst()] }; const h = scriptedConfigHost(st);
  const first = submit(d, 'forward_apply', FWD); await runAll(d, exec(h), c);
  assert.equal(getJob(d, first.job.id).status, 'succeeded', getJob(d, first.job.id).reason);
  assert.deepEqual(forwardRows(d).map((r) => r.id), ['f1']); assert.equal(st.instances[0].devices['ppl4-f1']?.type, 'proxy'); assert.deepEqual(st.rules.map((r) => r.id), ['service-l4-f1']);
  // An unrelated policy change saved by the operator, and the firewall
  // rejecting every reconcile since.
  st.rules.push({ id: 'operator-ssh', source: 'manual', port_start: 2222, port_end: null, proto: 'tcp', scope: 'public', enabled: true });
  st.rejectReconcile = 'lockout: the SSH source would be blocked'; h.calls.length = 0;
  const retry = createJob(d, { kind: 'forward_apply', app: 'pp-x', plan: retryPlan(getJob(d, first.job.id)), retryOf: first.job.id, nowMs: c.nowMs() });
  await runAll(d, exec(h), c);
  const rr = getJob(d, retry.id);
  assert.equal(rr.status, 'failed', rr.reason); assert.equal(rr.outcome, 'failed at reconcile'); assert.match(rr.reason, /lockout/);
  assert.deepEqual(forwardRows(d).map((r) => r.id), ['f1'], 'the working forward\'s row survives the failed retry');
  assert.equal(st.instances[0].devices['ppl4-f1']?.type, 'proxy', 'its device survives'); assert.ok(st.rules.some((r) => r.id === 'service-l4-f1'), 'its rule survives');
  const m = mutations(h.calls).map((a) => (a[0] === 'incus' ? `incus ${a[3]}` : a[3]));
  assert.deepEqual(m, ['reconcile'], `only the reconcile was issued, no removal: ${m}`);
  const r = resultFromJob(rr);
  assert.deepEqual(applied(r), { row: 'already', device: 'already', rule: 'already', reconcile: 'failed' });
  assert.equal(r.row.state, 'already', 'the row is not reported rolled back'); assert.equal(r.firewallPolicy.state, 'failed');
  assert.match(rr.reason, /unresolved/, 'the unresolved policy is named');
  assert.equal(r.applied.rollback?.state, 'none', JSON.stringify(r.rollback));
  assert.deepEqual([r.rollback.row, r.rollback.device, r.rollback.rule], Array(3).fill('kept (not created by this operation)'), 'each kept change names why');
  assert.match(r.rollback.unresolved, /lockout/); assert.equal(r.applied.row.owned, false); assert.equal(r.row.owned, false);
});

test('review 9b: a fresh forward that fails after its row and device were created removes both — and a forward interrupted between its device and its rule, resumed by the reconcile, still settles its own creations', async () => {
  // Fresh: the row and the device are this job's; the rule refuses.
  {
    const d = db(); const c = clock(); const st = { instances: [inst()], fwAddFails: true }; const h = scriptedConfigHost(st);
    const sub = submit(d, 'forward_apply', FWD); await runAll(d, exec(h), c);
    const row = getJob(d, sub.job.id); assert.equal(row.status, 'failed', row.reason);
    assert.deepEqual(forwardRows(d), [], 'its own row removed'); assert.deepEqual(st.instances[0].devices, {}, 'its own device removed');
    assert.match(row.reason, /rolled back: row removed, device removed, rule absent/);
  }
  // Interrupted after the row and the device (recorded as this job's), the
  // rule refusing on the resume: the resumed job removes what it created.
  {
    const d = db(); const c = clock(); const st = { instances: [inst({ devices: { 'ppl4-f1': { type: 'proxy', listen: 'tcp:0.0.0.0:7881', connect: 'tcp:10.10.10.5:7881' } } })], fwAddFails: true }; const h = scriptedConfigHost(st);
    d.prepare(`INSERT INTO service_l4_forwards (id, service_id, proto, listen_port, connect_port, enabled) VALUES ('f1', 'svc-x', 'tcp', 7881, 7881, 1)`).run();
    createJob(d, { id: 'dead-fwd', kind: 'forward_apply', app: 'pp-x', plan: { steps: [], params: FWD }, nowMs: T0 - 100_000 });
    const claimed = claimNextJob(d, { owner: DEAD, kinds: ['forward_apply'], nowMs: T0 - 99_000 });
    recordGenerated(d, { id: 'dead-fwd', owner: DEAD, epoch: claimed.epoch, resource: { kind: 'forward_row', name: 'f1', where: 'pp-x' }, nowMs: T0 - 98_600 });
    recordGenerated(d, { id: 'dead-fwd', owner: DEAD, epoch: claimed.epoch, resource: { kind: 'proxy_device', name: 'ppl4-f1', where: 'pp-x' }, nowMs: T0 - 98_500 });
    checkpoint(d, { id: 'dead-fwd', owner: DEAD, epoch: claimed.epoch, phase: 'applied', checkpoint: { config: true, resumable: true, disruptive: false, issued: true, target: IDENTITY, container: 'pp-x', kind: 'forward_apply', applied: { row: { state: 'done', issued: true }, device: { state: 'done', issued: true } } }, nowMs: T0 - 98_000 });
    assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: T0 }).requeued, ['dead-fwd']);
    await runAll(d, exec(h), c);
    const row = getJob(d, 'dead-fwd'); assert.equal(row.status, 'failed', row.reason); assert.equal(row.outcome, 'failed at rule');
    assert.deepEqual(forwardRows(d), [], 'the interrupted attempt\'s row removed by the resumed job'); assert.deepEqual(st.instances[0].devices, {}, 'and its device');
  }
});

// ── 10. the original snapshot's protection across the retry chain ─────────

test('review 10: after a partial change with the original snapshot lost, the retry, the retry of the retry and a resume of that retry each refuse the remaining write and take no replacement snapshot; a deliberately new request afterwards is distinct — its own snapshot, the change applied', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst({ config: { 'volatile.uuid': UUID_A, 'limits.cpu': '4', 'limits.memory': '2048MB' } })] }; const h = scriptedConfigHost(st);
  deadConfigJob(d, 'dead-1', { snapshot: { name: 'pp-mcp-pre-resources-2', created_at: '2026-09-26T11:00:00Z' } });
  assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: T0 }).requeued, ['dead-1']);
  await runAll(d, exec(h), c);
  const refusedAtProtect = (id, label) => {
    const row = getJob(d, id);
    assert.equal(row.status, 'failed', `${label}: ${row.reason}`); assert.equal(row.outcome, 'failed at protect', label);
    assert.equal(st.instances[0].config['limits.memory'], '2048MB', `${label}: the remaining change was NOT issued`);
    assert.deepEqual(st.instances[0].snapshots, [], `${label}: no replacement snapshot`);
    assert.deepEqual(mutations(h.calls), [], `${label}: nothing issued`);
    const r = resultFromJob(row); assert.equal(r.snapshot.verified, false, label); assert.equal(r.protection?.state, 'missing', `${label}: the original identity is carried along the chain`);
    h.calls.length = 0;
  };
  refusedAtProtect('dead-1', 'the resumed origin');
  const r1 = createJob(d, { kind: 'config_set', app: 'pp-x', plan: retryPlan(getJob(d, 'dead-1')), retryOf: 'dead-1', nowMs: c.nowMs() });
  await runAll(d, exec(h), c); refusedAtProtect(r1.id, 'the retry');
  const r2 = createJob(d, { kind: 'config_set', app: 'pp-x', plan: retryPlan(getJob(d, r1.id)), retryOf: r1.id, nowMs: c.nowMs() });
  await runAll(d, exec(h), c); refusedAtProtect(r2.id, 'the retry of the retry');
  // A retry of that retry claimed by an owner that died right after it bound
  // the guest (nothing issued by that attempt): resumed by the reconcile.
  const r3 = createJob(d, { kind: 'config_set', app: 'pp-x', plan: retryPlan(getJob(d, r2.id)), retryOf: r2.id, nowMs: c.nowMs() });
  const cl = claimNextJob(d, { owner: DEAD, kinds: ['config_set'], nowMs: c.nowMs() });
  assert.equal(cl.id, r3.id);
  checkpoint(d, { id: r3.id, owner: DEAD, epoch: cl.epoch, phase: 'validated', checkpoint: { config: true, resumable: true, disruptive: false, issued: false, target: IDENTITY, container: 'pp-x', kind: 'config_set', snapshot: null, applied: null }, nowMs: c.nowMs() });
  c.tick(LEASE_MS + 1_000);
  assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: c.nowMs() }).requeued, [r3.id]);
  await runAll(d, exec(h), c); refusedAtProtect(r3.id, 'the resumed retry');
  // The deliberately new request: no retryOf, its own snapshot name.
  const fresh = submit(d, 'config_set', { ...CFG, snapshot: { name: 'pp-mcp-pre-resources-9' } }, { nowMs: c.nowMs() });
  await runAll(d, exec(h), c);
  const fr = getJob(d, fresh.job.id); assert.equal(fr.status, 'succeeded', fr.reason);
  assert.equal(st.instances[0].config['limits.memory'], '4096MB'); assert.deepEqual(st.instances[0].snapshots.map((s) => s.name), ['pp-mcp-pre-resources-9'], 'its own snapshot, not a replacement of the original');
  assert.equal(resultFromJob(fr).snapshot.reused, false);
});

// ── 11. a recorded snapshot without a timestamp certifies nothing ─────────

test('review 11: a job resumed after its first write whose recorded snapshot has no timestamp — with a snapshot of that name on the guest — refuses the remaining write as unverifiable; a job that has not written yet refuses to proceed behind such a record', async () => {
  const d = db(); const c = clock();
  const onGuest = [{ name: 'pp-mcp-pre-resources-2', created_at: '2026-09-26T11:00:00Z' }];
  const st = { instances: [inst({ config: { 'volatile.uuid': UUID_A, 'limits.cpu': '4', 'limits.memory': '2048MB' }, snapshots: onGuest.map((s) => ({ ...s })) })] }; const h = scriptedConfigHost(st);
  deadConfigJob(d, 'dead-nots', { snapshot: { name: 'pp-mcp-pre-resources-2', created_at: null } });
  assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: T0 }).requeued, ['dead-nots']);
  await runAll(d, exec(h), c);
  const row = getJob(d, 'dead-nots');
  assert.equal(st.instances[0].config['limits.memory'], '2048MB', 'the remaining change was NOT issued behind an uncertifiable snapshot');
  assert.deepEqual(mutations(h.calls), [], 'nothing issued');
  assert.equal(row.status, 'failed', row.reason); assert.equal(row.outcome, 'failed at protect');
  const r = resultFromJob(row); assert.equal(r.protection?.state, 'unverifiable'); assert.equal(r.snapshot.verified, false); assert.equal(r.snapshot.reused, false);
  assert.deepEqual(applied(r), { 'config:limits.cpu': 'done', 'config:limits.memory': 'not_run' });
  assert.deepEqual(st.instances[0].snapshots, onGuest, 'the snapshot on the guest is neither replaced nor claimed');
  // Not written yet: the record names the snapshot without a timestamp and
  // one of that name is on the guest — refused, nothing issued.
  h.calls.length = 0;
  deadConfigJob(d, 'dead-nots-2', { snapshot: { name: 'pp-mcp-pre-resources-2', created_at: null }, issued: false });
  c.tick(1_000);
  assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: c.nowMs() }).requeued, ['dead-nots-2']);
  await runAll(d, exec(h), c);
  const row2 = getJob(d, 'dead-nots-2');
  assert.equal(row2.status, 'refused', row2.reason); assert.match(row2.reason, /without a timestamp|cannot be certified/);
  assert.equal(st.instances[0].config['limits.memory'], '2048MB'); assert.deepEqual(mutations(h.calls), [], 'nothing issued, no snapshot');
  assert.deepEqual(st.instances[0].snapshots, onGuest);
});
