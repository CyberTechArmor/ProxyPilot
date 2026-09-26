// A-17.2 … A-17.6: the Incus lifecycle verbs (create / start / stop /
// restart / delete) and the snapshot create / delete as durable runner jobs.
// What is proved here, and how:
//   * the pure layer (lifecycle-logic): the kind registry, strict parameter
//     validation (no command, argv or option string; an allowlisted launch
//     config), the FIXED argv each kind renders, identity binding, the state
//     verdicts and the operation-specific replay policy;
//   * every kind through the real executor over a scripted host executor
//     (setup-engine store on node:sqlite): the command issued, the state read
//     back, refusals before anything is issued (missing target, changed
//     identity, create over an existing name), a success claim refused when
//     the state does not read as promised, cleanup of a half-created guest,
//     lock contention at submission and at claim, duplicates, interruption
//     around the command for the idempotent kinds (resumed by re-reading, the
//     same identity, nothing blindly replayed) and for restart / create
//     (recovery_required, nothing replayed, the lease released), the boot
//     sweep, runner-required refusing rather than queueing, a live runner
//     taking the job, the in-process executor running the same code;
//   * the actual callers: mock2/ops.js runLifecycle (the REST and MCP
//     surfaces call it) with its HTTP mapping, and the MCP tools
//     delete_lxc_container / delete_snapshot over a fake ctx with the
//     confirmation bound to the guest's identity;
//   * the runner's host channel handed a rendered argv verbatim (real spawn
//     capture): no shell between the plan and the process.
// The REST routes themselves import the native database module and are
// covered by source ratchets in immediate-repairs.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// lifecycle-logic first: it and logic.js import each other, and both orders
// must load (the runner imports logic.js first, the ops layer this one).
import {
  LIFECYCLE_JOB_KINDS as KINDS_FROM_LIFECYCLE, LIFECYCLE_PROFILE, LAUNCH_CONFIG_ALLOWLIST, validateLifecycleParams, lifecycleArgv, instanceListArgv,
  identityMatches, instanceIdentity, snapshotIdentity, stateVerdict, alreadyDone, lifecycleVerification,
} from '../lib/setup-engine/lifecycle-logic.js';
import { ownerIdentity, parseJson, validateRunnerJob, reconcileDecision, RUNNER_JOB_KINDS, MUTATING_JOB_KINDS, EXCLUSIVE_JOB_KINDS, LIFECYCLE_JOB_KINDS } from '../lib/setup-engine/logic.js';
import { ensureSetupEngineSchema, getJob, listEvents, readLock, acquireLock, createJob, claimNextJob, checkpoint, runnerHeartbeat, listJobs } from '../lib/setup-engine/store.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { submitRunnerJob, runSubmittedJob, resultFromJob } from '../lib/setup-engine/orchestrator.js';
import { sweepSetupEngineOnBoot, acknowledgeUncertainJob } from '../lib/setup-engine/backend.js';
import { runLifecycleOperation, CheckpointNotPersistedError } from '../lib/setup-engine/lifecycle-op.js';
import { configureContainerLockStore } from '../mock2/container-lock.js';
import { runLifecycle, resolveLifecyclePlan, lifecycleHttpStatus, LIFECYCLE_ACTIONS, planDigest } from '../mock2/ops.js';
import { createExtendedHandlers } from '../routes/mcp-tools/index.js';
import { createConfirmationStore } from '../lib/mcp-ext/logic.js';
import { lxcContainerDetail, MCP_TOOLS } from '../lib/mcp-logic.js';
import { hostGuestExec } from '../../../../cli/src/commands/setup-runner.js';
import { scriptedGuest, LOGIN, GUARD } from './helpers/scripted-guest.js';

const T0 = Date.parse('2026-09-22T12:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const DEAD = ownerIdentity({ kind: 'runner', host: 'pp', pid: 999, instance: 'dead' });
const DEAD_BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 998, instance: 'gone' });
const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '99999999-8888-7777-6666-555555555555';

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); return d; }
const inst = (over = {}) => ({ name: 'pp-x', status: 'Running', created_at: '2026-09-01T10:00:00Z', config: { 'volatile.uuid': UUID_A }, snapshots: [{ name: 'snap-1', created_at: '2026-09-20T10:00:00Z' }], expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' } }, ...over });

// The scripted host: `incus …` as argv arrays over a map of instances.
function scriptedHost(state) {
  const calls = [];
  const byName = (n) => state.instances.find((i) => i.name === n) || null;
  return {
    calls,
    host: async (argv) => {
      calls.push(argv);
      assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === 'string'), 'argv arrays only');
      if (argv[0] !== 'incus') return { code: 127, stdout: '', stderr: 'not incus' };
      const verb = argv[1];
      if (verb === 'list') { const i = byName(argv[2]); return { code: 0, stdout: JSON.stringify(i ? [i] : []), stderr: '' }; }
      if (verb === 'start') { const i = byName(argv[2]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' }; if (state.startFails) return { code: 1, stdout: '', stderr: 'Error: Failed to run: /sbin/init: no such file' }; if (!state.startNoop) i.status = 'Running'; return { code: 0, stdout: '', stderr: '' }; }
      if (verb === 'stop') { const i = byName(argv[2]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' }; if (state.stopFails && !argv.includes('--force')) return { code: 1, stdout: '', stderr: 'Error: The instance is busy' }; i.status = 'Stopped'; return { code: 0, stdout: '', stderr: '' }; }
      if (verb === 'restart') { const i = byName(argv[2]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' }; i.status = 'Running'; state.restarts = (state.restarts || 0) + 1; return { code: 0, stdout: '', stderr: '' }; }
      if (verb === 'delete') { const i = byName(argv[2]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' }; if (state.deleteFails && !argv.includes('--force')) return { code: 1, stdout: '', stderr: 'Error: Instance is protected' }; state.instances = state.instances.filter((x) => x !== i); return { code: 0, stdout: '', stderr: '' }; }
      if (verb === 'launch') {
        const name = argv[3];
        if (byName(name)) return { code: 1, stdout: '', stderr: `Error: Instance "${name}" already exists` };
        if (state.rootFails && argv.includes('--device')) {
          if (state.launchLeavesHalf) state.instances.push({ name, status: 'Stopped', created_at: '2026-09-22T12:00:05Z', config: {}, snapshots: [] });
          return { code: 1, stdout: '', stderr: 'Error: Block volumes cannot be shrunk' };
        }
        if (state.launchFails) { if (state.launchLeavesHalf) state.instances.push({ name, status: 'Stopped', created_at: '2026-09-22T12:00:05Z', config: {}, snapshots: [] }); return { code: 1, stdout: '', stderr: 'Error: Failed instance creation: image not found' }; }
        state.launched = argv;
        state.instances.push({ name, status: 'Running', created_at: '2026-09-22T12:00:05Z', config: { 'volatile.uuid': UUID_B, ...Object.fromEntries(argv.filter((a, i) => argv[i - 1] === '--config').map((kv) => kv.split('='))) }, snapshots: [] });
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'config' && argv[2] === 'device' && argv[3] === 'override') { state.rootSize = argv[6]; return state.rootFails ? { code: 1, stdout: '', stderr: "Error: device 'root' doesn't exist" } : { code: 0, stdout: '', stderr: '' }; }
      if (verb === 'config' && argv[2] === 'set') { state.notes = { ...(state.notes || {}), [argv[3]]: argv[4] }; return { code: 0, stdout: '', stderr: '' }; }
      if (verb === 'snapshot' && argv[2] === 'create') {
        if (state.cliForm === 'legacy') return { code: 1, stdout: '', stderr: 'Error: unknown command "create" for "incus snapshot"' };
        const i = byName(argv[3]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' };
        if (i.snapshots.some((s) => s.name === argv[4])) return { code: 1, stdout: '', stderr: 'Error: Snapshot already exists' };
        i.snapshots.push({ name: argv[4], created_at: `2026-09-22T12:0${i.snapshots.length}:00Z` }); return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'snapshot' && argv.length === 4 && state.cliForm === 'legacy') { const i = byName(argv[2]); i.snapshots.push({ name: argv[3], created_at: `2026-09-22T12:0${i.snapshots.length}:00Z` }); return { code: 0, stdout: '', stderr: '' }; }
      if (verb === 'snapshot' && argv[2] === 'delete') { const i = byName(argv[3]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' }; const n = i.snapshots.length; i.snapshots = i.snapshots.filter((s) => s.name !== argv[4]); return n === i.snapshots.length ? { code: 1, stdout: '', stderr: 'Error: Snapshot not found' } : { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
    },
  };
}
const exec = (h, g = scriptedGuest({})) => ({ guest: g.guest, host: h.host });
const runAll = (d, ex, nowMs, opts = {}) => runOnce({ db: d, owner: RUNNER, exec: ex, reviewLogin: async () => LOGIN, nowMs: () => nowMs }, { reconcileFirst: false, ...opts });
const mutations = (h) => h.calls.filter((a) => a[1] !== 'list');
const submit = (d, kind, params, extra = {}) => submitRunnerJob(d, { kind, app: params.container, params, nowMs: T0, ...extra });

// A job whose owner died at a given checkpoint: created, claimed by DEAD,
// checkpointed, lease long expired.
function deadJob(d, { kind, params, cp, id = 'dead-1' }) {
  createJob(d, { id, kind, app: params.container, plan: { steps: [], params }, nowMs: T0 - 100_000 });
  const c = claimNextJob(d, { owner: DEAD, kinds: [kind], nowMs: T0 - 99_000 });
  checkpoint(d, { id, owner: DEAD, epoch: c.epoch, phase: cp.phase, checkpoint: cp, nowMs: T0 - 98_000 });
  return getJob(d, id);
}

// ── 1. the pure layer ─────────────────────────────────────────────────────

test('registry: the seven lifecycle kinds are runner jobs, mutating and exclusive, and the two modules agree', () => {
  assert.deepEqual([...KINDS_FROM_LIFECYCLE], ['instance_create', 'instance_start', 'instance_stop', 'instance_restart', 'instance_delete', 'snapshot_create', 'snapshot_delete']);
  assert.deepEqual([...LIFECYCLE_JOB_KINDS], [...KINDS_FROM_LIFECYCLE], 'logic.js carries its own copy (the import cycle forbids a spread); it must match');
  for (const k of KINDS_FROM_LIFECYCLE) { assert.ok(RUNNER_JOB_KINDS.includes(k)); assert.ok(MUTATING_JOB_KINDS.includes(k)); assert.ok(EXCLUSIVE_JOB_KINDS.includes(k), `${k} is refused, never queued behind`); }
  assert.equal(LIFECYCLE_PROFILE.instance_restart.replay, 'never'); assert.equal(LIFECYCLE_PROFILE.instance_create.replay, 'never');
  for (const k of ['instance_start', 'instance_stop', 'instance_delete', 'snapshot_create', 'snapshot_delete']) assert.equal(LIFECYCLE_PROFILE[k].replay, 'idempotent');
  assert.deepEqual(LIFECYCLE_ACTIONS, { start: 'instance_start', stop: 'instance_stop', restart: 'instance_restart', delete: 'instance_delete' });
});

test('validation is strict: names, flags and an allowlisted launch config; never a command, argv, option or a value that looks like a secret', () => {
  const ok = (k, p) => assert.deepEqual(validateLifecycleParams(k, p), { ok: true }, `${k} ${JSON.stringify(p)}`);
  const bad = (k, p, re) => assert.match(validateLifecycleParams(k, p).reason, re, `${k} ${JSON.stringify(p)}`);
  ok('instance_start', { container: 'pp-x' });
  ok('instance_stop', { container: 'pp-x', force: true });
  ok('instance_delete', { container: 'pp-x', force: true, expect: { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' } });
  ok('snapshot_create', { container: 'pp-x', snapshot: 'before-upgrade.1', note: 'before the 2.0 upgrade' });
  ok('snapshot_delete', { container: 'pp-x', snapshot: 'snap-1', expect: { created_at: '2026-09-20T10:00:00Z' } });
  ok('instance_create', { container: 'pp-new', image: 'images:debian/12', profile: 'default', vm: true, rootSize: '20GiB', network: 'm2br7', config: { 'limits.cpu': '2', 'limits.memory': '4096MiB', 'security.nesting': 'true', 'raw.lxc': 'lxc.apparmor.profile=unconfined' } });
  bad('instance_start', { container: '../x' }, /guest name/);
  bad('instance_start', { container: 'pp-x', argv: ['incus', 'start', 'pp-x'] }, /never carries a command/);
  bad('instance_start', { container: 'pp-x', command: 'incus start pp-x' }, /never carries a command/);
  bad('instance_start', { container: 'pp-x', options: ['--force'] }, /never carries a command/);
  bad('instance_start', { container: 'pp-x', force: true }, /force applies to stop, restart and delete/);
  bad('instance_start', { container: 'pp-x', snapshot: 's' }, /carries no snapshot/);
  bad('instance_stop', { container: 'pp-x', force: 'yes' }, /force must be a boolean/);
  bad('snapshot_create', { container: 'pp-x', snapshot: 'bad name' }, /snapshot name/);
  bad('snapshot_create', { container: 'pp-x', snapshot: 's', note: 'x'.repeat(501) }, /note must be text/);
  bad('snapshot_create', { container: 'pp-x', snapshot: 's', note: 'a\u0007b' }, /note must be text/);
  bad('snapshot_delete', { container: 'pp-x', snapshot: 's', note: 'n' }, /carries no note/);
  bad('instance_delete', { container: 'pp-x', expect: { name: 'pp-x' } }, /not an identity field/);
  bad('instance_delete', { container: 'pp-x', expect: { created_at: 'yesterday' } }, /timestamp/);
  bad('instance_create', { container: 'pp-new', image: '-rf' }, /image alias/);
  bad('instance_create', { container: 'pp-new', image: 'images:debian/12', profile: 'a b' }, /profile name/);
  bad('instance_create', { container: 'pp-new', image: 'images:debian/12', config: { 'user.script': 'curl x | sh' } }, /not on the launch allowlist/);
  bad('instance_create', { container: 'pp-new', image: 'images:debian/12', config: { 'limits.memory': '4 GB; rm -rf /' } }, /not an accepted value/);
  bad('instance_create', { container: 'pp-new', image: 'images:debian/12', config: { 'raw.lxc': 'lxc.mount.entry=/ host none bind' } }, /not an accepted value/);
  ok('instance_create', { container: 'pp-vm-safe', image: 'images:debian/12', vm: true, config: { 'security.guestapi': 'false', 'security.nesting': 'false', 'limits.memory': '512MiB' } });
  bad('instance_create', { container: 'pp-vm-unsafe', image: 'images:debian/12', vm: true, config: { 'security.guestapi': 'true' } }, /not an accepted value/);
  bad('instance_create', { container: 'pp-new', image: 'images:debian/12', rootSize: '20' }, /rootSize/);
  bad('instance_start', { container: 'pp-x', image: 'images:debian/12' }, /carries no image/);
  bad('snapshot_create', { container: 'pp-x', snapshot: 's', note: 'AUTH_MASTER_SECRET=abcdefghijklmnop' }, /looks like a secret/);
  assert.deepEqual(Object.keys(LAUNCH_CONFIG_ALLOWLIST).sort(), ['boot.autostart', 'limits.cpu', 'limits.memory', 'raw.lxc', 'security.guestapi', 'security.nesting', 'security.privileged', 'security.syscalls.intercept.bpf', 'security.syscalls.intercept.bpf.devices', 'security.syscalls.intercept.mknod', 'security.syscalls.intercept.setxattr']);
  // validateRunnerJob delegates: a lifecycle job with argv never becomes a queued job.
  assert.match(validateRunnerJob({ kind: 'instance_start', app: 'pp-x', plan: { params: { container: 'pp-x', argv: ['x'] } } }).reason, /never carries a command/);
  assert.equal(validateRunnerJob({ kind: 'snapshot_create', app: 'pp-x', plan: { params: { container: 'pp-x', snapshot: 's' } } }).ok, true);
  assert.match(submitRunnerJob(db(), { kind: 'instance_stop', app: 'pp-x', params: { container: 'pp-x', force: 'yes' }, nowMs: T0 }).error, /force must be a boolean/);
});

test('the fixed commands: one argv per kind, rendered from the plan alone; an invalid plan renders nothing', () => {
  assert.deepEqual(lifecycleArgv('instance_start', { container: 'pp-x' }), ['incus', 'start', 'pp-x']);
  assert.deepEqual(lifecycleArgv('instance_stop', { container: 'pp-x' }), ['incus', 'stop', 'pp-x']);
  assert.deepEqual(lifecycleArgv('instance_stop', { container: 'pp-x', force: true }), ['incus', 'stop', 'pp-x', '--force']);
  assert.deepEqual(lifecycleArgv('instance_restart', { container: 'pp-x', force: true }), ['incus', 'restart', 'pp-x', '--force']);
  assert.deepEqual(lifecycleArgv('instance_delete', { container: 'pp-x', force: true }), ['incus', 'delete', 'pp-x'], 'force applies to the stop that precedes the delete, never to the delete itself');
  assert.deepEqual(lifecycleArgv('instance_create', { container: 'pp-new', image: 'images:debian/12', config: { 'limits.memory': '2GiB', 'security.nesting': 'true' }, vm: true, network: 'm2br7' }),
    ['incus', 'launch', 'images:debian/12', 'pp-new', '--profile', 'default', '--config', 'security.nesting=true', '--config', 'limits.memory=2GiB', '--network', 'm2br7', '--vm'], 'config flags in allowlist order');
  assert.deepEqual(lifecycleArgv('instance_create', { container: 'pp-vm-safe', image: 'images:debian/12', vm: true, config: { 'security.guestapi': 'false', 'limits.memory': '512MiB' } }),
    ['incus', 'launch', 'images:debian/12', 'pp-vm-safe', '--profile', 'default', '--config', 'security.guestapi=false', '--config', 'limits.memory=512MiB', '--vm']);
  assert.deepEqual(lifecycleArgv('snapshot_create', { container: 'pp-x', snapshot: 's1' }), ['incus', 'snapshot', 'create', 'pp-x', 's1']);
  assert.deepEqual(lifecycleArgv('snapshot_create', { container: 'pp-x', snapshot: 's1' }, { snapshotForm: 'legacy' }), ['incus', 'snapshot', 'pp-x', 's1']);
  assert.deepEqual(lifecycleArgv('snapshot_delete', { container: 'pp-x', snapshot: 's1' }), ['incus', 'snapshot', 'delete', 'pp-x', 's1']);
  assert.deepEqual(instanceListArgv('pp-x'), ['incus', 'list', 'pp-x', '--format', 'json']);
  assert.throws(() => lifecycleArgv('instance_start', { container: 'pp-x; rm -rf /' }), /refusing to render/);
  assert.throws(() => lifecycleArgv('instance_create', { container: 'pp-new', image: 'images:debian/12', config: { 'user.x': 'y' } }), /allowlist/);
});

test('identity, state verdicts and the idempotent short-circuit', () => {
  const i = inst();
  assert.deepEqual(instanceIdentity(i), { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z', status: 'Running' });
  assert.deepEqual(snapshotIdentity(i, 'snap-1'), { created_at: '2026-09-20T10:00:00Z' }); assert.equal(snapshotIdentity(i, 'nope'), null);
  assert.equal(identityMatches({ uuid: UUID_A }, instanceIdentity(i)).ok, true);
  assert.match(identityMatches({ uuid: UUID_B }, instanceIdentity(i)).why, /differs from the confirmed/);
  assert.match(identityMatches({ created_at: '2026-09-02T00:00:00Z' }, instanceIdentity(i)).why, /created .* not/);
  assert.deepEqual(identityMatches(null, instanceIdentity(i)), { ok: true, bound: false, why: 'no identity to compare' });
  assert.equal(identityMatches({ uuid: UUID_A }, null).ok, false);
  assert.deepEqual(stateVerdict('instance_start', { instance: i }), { ok: true, observed: 'Running', expected: 'Running' });
  assert.deepEqual(stateVerdict('instance_stop', { instance: i }), { ok: false, observed: 'Running', expected: 'Stopped' });
  assert.deepEqual(stateVerdict('instance_delete', { instance: null }), { ok: true, observed: 'absent', expected: 'absent' });
  assert.deepEqual(stateVerdict('snapshot_create', { instance: i, snapshot: 'snap-1' }), { ok: true, observed: 'present', expected: 'present' });
  assert.deepEqual(stateVerdict('snapshot_delete', { instance: i, snapshot: 'snap-1' }), { ok: false, observed: 'present', expected: 'absent' });
  assert.equal(alreadyDone('instance_start', { instance: i }), true);
  assert.equal(alreadyDone('instance_delete', { instance: null, issued: false }), false, 'an absent delete target before any command is somebody else\'s doing');
  assert.equal(alreadyDone('instance_delete', { instance: null, issued: true }), true);
  assert.equal(alreadyDone('snapshot_create', { instance: i, snapshot: 'snap-1', issued: false }), false);
  assert.equal(alreadyDone('snapshot_create', { instance: i, snapshot: 'snap-1', issued: true }), true);
  assert.equal(alreadyDone('instance_restart', { instance: i }), false, 'a restart always issues');
  const v = lifecycleVerification('instance_stop', { ok: false, observed: 'Running', expected: 'Stopped' }, { container: 'pp-x' });
  assert.equal(v.state, 'recovery_required'); assert.equal(v.failedAt, 'resource_state');
  assert.equal(lifecycleVerification('instance_start', { ok: true, observed: 'Running', expected: 'Running' }, { container: 'pp-x' }).state, 'not_applicable');
});

// ── 2. every kind through the executor ────────────────────────────────────

test('instance_start: the fixed argv is issued, the guest is read back Running, the record says so and the lease is released; a guest already Running issues nothing', async () => {
  const d = db();
  const st = { instances: [inst({ status: 'Stopped' })] }; const h = scriptedHost(st);
  const sub = submit(d, 'instance_start', { container: 'pp-x' });
  assert.ok(sub.job);
  const out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'succeeded', getJob(d, sub.job.id).reason);
  assert.deepEqual(mutations(h), [['incus', 'start', 'pp-x']]);
  assert.deepEqual(h.calls[0], ['incus', 'list', 'pp-x', '--format', 'json'], 'read before');
  assert.equal(h.calls.filter((a) => a[1] === 'list').length, 2, 'read after');
  const row = getJob(d, sub.job.id);
  assert.equal(row.outcome, 'started'); assert.match(row.reason, /pp-x: instance start → Running; verification not_applicable/);
  const ver = parseJson(row.verification_json);
  assert.equal(ver.state, 'not_applicable'); assert.equal(ver.outcome, 'resource_state_verified'); assert.match(ver.label, /Incus reports pp-x Running \(expected Running\)/);
  const r = resultFromJob(row);
  assert.equal(r.ok, true); assert.equal(r.step, 'started'); assert.equal(r.instanceState, 'Running'); assert.equal(r.status, 'succeeded', 'the job status and the guest state are separate fields');
  assert.equal(readLock(d, 'pp-x'), null, 'lease released');
  const cps = listEvents(d, sub.job.id).filter((e) => e.kind === 'checkpoint').map((e) => e.phase);
  assert.deepEqual(cps, ['validated', 'issuing', 'verified']);
  // Already running: nothing issued, said so.
  h.calls.length = 0;
  const again = submit(d, 'instance_start', { container: 'pp-x' }, { nowMs: T0 + 5 });
  await runAll(d, exec(h), T0 + 6);
  const row2 = getJob(d, again.job.id);
  assert.equal(row2.status, 'succeeded'); assert.deepEqual(mutations(h), []); assert.match(row2.reason, /already in that state; nothing issued/);
  assert.equal(resultFromJob(row2).alreadyInState, true);
});

test('instance_stop with force, instance_restart with and without force: the exact argv; a command that returns 0 but leaves the guest elsewhere is a failure, never a success', async () => {
  const d = db();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  submit(d, 'instance_stop', { container: 'pp-x', force: true });
  await runAll(d, exec(h), T0 + 1);
  assert.deepEqual(mutations(h), [['incus', 'stop', 'pp-x', '--force']]); assert.equal(st.instances[0].status, 'Stopped');
  h.calls.length = 0;
  const r1 = submit(d, 'instance_restart', { container: 'pp-x', force: true }, { nowMs: T0 + 2 });
  await runAll(d, exec(h), T0 + 3);
  assert.deepEqual(mutations(h), [['incus', 'restart', 'pp-x', '--force']]); assert.equal(getJob(d, r1.job.id).outcome, 'restarted');
  h.calls.length = 0;
  submit(d, 'instance_restart', { container: 'pp-x' }, { nowMs: T0 + 4 });
  await runAll(d, exec(h), T0 + 5);
  assert.deepEqual(mutations(h), [['incus', 'restart', 'pp-x']]);
  // A start whose exit is 0 while the guest stays Stopped.
  st.instances[0].status = 'Stopped'; st.startNoop = true; h.calls.length = 0;
  const s2 = submit(d, 'instance_start', { container: 'pp-x' }, { nowMs: T0 + 6 });
  const out = await runAll(d, exec(h), T0 + 7);
  assert.equal(out.ran[0].status, 'failed');
  const row = getJob(d, s2.job.id);
  assert.match(row.reason, /exited 0 but pp-x reads Stopped, not Running; not claiming success/);
  assert.equal(parseJson(row.progress_json).failed_step, 'verify');
  assert.equal(parseJson(row.verification_json).state, 'recovery_required');
});

test('instance_delete: bound to the confirmed identity; a running guest is stopped first; the record outlives the guest; a changed identity or a missing guest is refused with nothing issued', async () => {
  const d = db();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  // Confirmed for another uuid: refused before anything.
  const wrong = submit(d, 'instance_delete', { container: 'pp-x', expect: { uuid: UUID_B } });
  const o1 = await runAll(d, exec(h), T0 + 1);
  assert.equal(o1.ran[0].status, 'refused');
  assert.match(getJob(d, wrong.job.id).reason, /not the resource this request was confirmed for \(uuid 11111111… differs from the confirmed 99999999…\); refusing — nothing was done/);
  assert.deepEqual(mutations(h), []); assert.equal(st.instances.length, 1);
  // The right identity: stop (force) then delete, verified absent.
  h.calls.length = 0;
  const del = submit(d, 'instance_delete', { container: 'pp-x', force: true, expect: { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' } }, { nowMs: T0 + 2 });
  const o2 = await runAll(d, exec(h), T0 + 3);
  assert.equal(o2.ran[0].status, 'succeeded', getJob(d, del.job.id).reason);
  assert.deepEqual(mutations(h), [['incus', 'stop', 'pp-x', '--force'], ['incus', 'delete', 'pp-x']]);
  assert.equal(st.instances.length, 0);
  const row = getJob(d, del.job.id);
  assert.equal(row.outcome, 'deleted'); assert.equal(resultFromJob(row).instanceState, 'absent');
  assert.deepEqual(resultFromJob(row).identity, { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z', status: 'Running' }, 'the identity of what was deleted stays on the record');
  assert.equal(readLock(d, 'pp-x'), null);
  assert.ok(listEvents(d, del.job.id).length >= 4, 'the evidence lives in the engine database, not in the guest');
  // Gone: refused at query, nothing issued.
  h.calls.length = 0;
  const gone = submit(d, 'instance_delete', { container: 'pp-x' }, { nowMs: T0 + 4 });
  await runAll(d, exec(h), T0 + 5);
  assert.match(getJob(d, gone.job.id).reason, /pp-x does not exist; nothing was done/); assert.deepEqual(mutations(h), []);
  assert.equal(resultFromJob(getJob(d, gone.job.id)).notFound, true);
  // A guest that will not stop cleanly is not deleted.
  st.instances = [inst()]; st.stopFails = true; h.calls.length = 0;
  const busy = submit(d, 'instance_delete', { container: 'pp-x' }, { nowMs: T0 + 6 });
  await runAll(d, exec(h), T0 + 7);
  assert.match(getJob(d, busy.job.id).reason, /could not stop pp-x cleanly .*; the guest was NOT deleted — pass force/);
  assert.deepEqual(mutations(h), [['incus', 'stop', 'pp-x']]); assert.equal(st.instances.length, 1);
});

test('instance_create: explicit root size is applied at launch or fails closed; an existing name is refused and a failed launch removes a half-created guest', async () => {
  const d = db();
  const st = { instances: [] }; const h = scriptedHost(st);
  const c = submit(d, 'instance_create', { container: 'pp-new', image: 'images:debian/12', profile: 'default', vm: true, rootSize: '20GiB', config: { 'limits.cpu': '2', 'limits.memory': '2GiB', 'security.nesting': 'true' } });
  const out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'succeeded', getJob(d, c.job.id).reason);
  assert.deepEqual(st.launched, ['incus', 'launch', 'images:debian/12', 'pp-new', '--profile', 'default', '--config', 'security.nesting=true', '--config', 'limits.cpu=2', '--config', 'limits.memory=2GiB', '--device', 'root,size=20GiB', '--vm']);
  const row = getJob(d, c.job.id);
  assert.equal(row.outcome, 'created'); assert.equal(resultFromJob(row).instanceState, 'Running');
  assert.deepEqual(parseJson(row.progress_json).generated.map((g) => ({ kind: g.kind, name: g.name })), [{ kind: 'instance', name: 'pp-new' }]);
  assert.equal(readLock(d, 'pp-new'), null, 'a lock on a guest that did not exist before the job is released after it');
  // Existing name: refused at query, no launch.
  h.calls.length = 0; st.launched = null;
  const dup = submit(d, 'instance_create', { container: 'pp-new', image: 'images:debian/12' }, { nowMs: T0 + 2 });
  const o2 = await runAll(d, exec(h), T0 + 3);
  assert.equal(o2.ran[0].status, 'refused'); assert.match(getJob(d, dup.job.id).reason, /pp-new already exists \(status Running\); a create never replaces/); assert.deepEqual(mutations(h), []);
  // Root size refused by Incus: no larger profile-default guest is reported
  // as a successful create. The launch's half-created guest is removed.
  st.rootFails = true; h.calls.length = 0;
  st.launchLeavesHalf = true;
  const w = submit(d, 'instance_create', { container: 'pp-vm2', image: 'images:debian/12', vm: true, rootSize: '20GiB' }, { nowMs: T0 + 4 });
  await runAll(d, exec(h), T0 + 5);
  assert.equal(getJob(d, w.job.id).status, 'failed');
  assert.match(getJob(d, w.job.id).reason, /Block volumes cannot be shrunk/);
  assert.equal(st.instances.some((instance) => instance.name === 'pp-vm2'), false);
  st.rootFails = false;
  st.launchLeavesHalf = false;
  // A failed launch that left a half-created guest: cleaned up, reported failed at issue.
  st.launchFails = true; st.launchLeavesHalf = true; h.calls.length = 0;
  const f = submit(d, 'instance_create', { container: 'pp-half', image: 'images:nope' }, { nowMs: T0 + 6 });
  const o3 = await runAll(d, exec(h), T0 + 7);
  assert.equal(o3.ran[0].status, 'failed');
  assert.deepEqual(mutations(h).map((a) => a.slice(0, 2)), [['incus', 'launch'], ['incus', 'delete']]);
  assert.deepEqual(mutations(h)[1], ['incus', 'delete', 'pp-half', '--force']);
  assert.ok(!st.instances.some((i) => i.name === 'pp-half'));
  const fr = resultFromJob(getJob(d, f.job.id));
  assert.equal(fr.step, 'issue'); assert.deepEqual(fr.cleanup, { attempted: true, removed: true, detail: null }); assert.match(fr.error, /image not found/);
});

test('snapshot_create and snapshot_delete: the argv, the note recorded on the snapshot, the legacy CLI form discovered, an existing snapshot refused, the delete bound to the snapshot\'s timestamp', async () => {
  const d = db();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  const c = submit(d, 'snapshot_create', { container: 'pp-x', snapshot: 'pre-upgrade', note: 'before 2.0' });
  await runAll(d, exec(h), T0 + 1);
  assert.equal(getJob(d, c.job.id).status, 'succeeded', getJob(d, c.job.id).reason);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pre-upgrade'], ['incus', 'config', 'set', 'pp-x/snapshots/pre-upgrade', 'user.note=before 2.0']]);
  assert.deepEqual(parseJson(getJob(d, c.job.id).progress_json).generated.map((g) => [g.kind, g.name, g.where]), [['snapshot', 'pre-upgrade', 'pp-x']]);
  assert.equal(resultFromJob(getJob(d, c.job.id)).identity.created_at, '2026-09-22T12:01:00Z');
  // The same name again: refused, nothing issued.
  h.calls.length = 0;
  const dup = submit(d, 'snapshot_create', { container: 'pp-x', snapshot: 'pre-upgrade' }, { nowMs: T0 + 2 });
  const o = await runAll(d, exec(h), T0 + 3);
  assert.equal(o.ran[0].status, 'refused'); assert.match(getJob(d, dup.job.id).reason, /snapshot pre-upgrade of pp-x already exists; a create never replaces/); assert.deepEqual(mutations(h), []);
  // The legacy client.
  st.cliForm = 'legacy'; h.calls.length = 0;
  const leg = submit(d, 'snapshot_create', { container: 'pp-x', snapshot: 'legacy-1' }, { nowMs: T0 + 4 });
  await runAll(d, exec(h), T0 + 5);
  assert.equal(getJob(d, leg.job.id).status, 'succeeded');
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'legacy-1'], ['incus', 'snapshot', 'pp-x', 'legacy-1']]);
  st.cliForm = null;
  // Delete bound to a timestamp that changed: refused.
  h.calls.length = 0;
  const wrong = submit(d, 'snapshot_delete', { container: 'pp-x', snapshot: 'snap-1', expect: { created_at: '2026-09-21T00:00:00Z' } }, { nowMs: T0 + 6 });
  await runAll(d, exec(h), T0 + 7);
  assert.equal(getJob(d, wrong.job.id).status, 'refused'); assert.match(getJob(d, wrong.job.id).reason, /snapshot snap-1 of pp-x is not the resource this request was confirmed for/); assert.deepEqual(mutations(h), []);
  // The right one: deleted and read back as gone.
  const del = submit(d, 'snapshot_delete', { container: 'pp-x', snapshot: 'snap-1', expect: { created_at: '2026-09-20T10:00:00Z' } }, { nowMs: T0 + 8 });
  await runAll(d, exec(h), T0 + 9);
  assert.equal(getJob(d, del.job.id).status, 'succeeded'); assert.deepEqual(mutations(h), [['incus', 'snapshot', 'delete', 'pp-x', 'snap-1']]);
  assert.ok(!st.instances[0].snapshots.some((s) => s.name === 'snap-1'));
  assert.equal(resultFromJob(getJob(d, del.job.id)).instanceState, 'absent');
  // Missing snapshot: not found, nothing issued.
  h.calls.length = 0;
  const miss = submit(d, 'snapshot_delete', { container: 'pp-x', snapshot: 'nope' }, { nowMs: T0 + 10 });
  await runAll(d, exec(h), T0 + 11);
  assert.equal(resultFromJob(getJob(d, miss.job.id)).notFound, true); assert.deepEqual(mutations(h), []);
});

test('a start or restart of a MANAGED application queues the verification ladder as a follow-up that lands on the record; any other guest gets an explicit not_applicable', async () => {
  const d = db();
  const st = { instances: [inst({ status: 'Stopped' })] }; const h = scriptedHost(st); const g = scriptedGuest({ ldaps: 'current' });
  const s = submit(d, 'instance_start', { container: 'pp-x', managed: true, webPort: 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment', guard: GUARD });
  const out = await runAll(d, exec(h, g), T0 + 1, { max: 3 });
  assert.equal(out.ran[0].status, 'succeeded');
  const row = getJob(d, s.job.id);
  const followId = parseJson(row.progress_json).verification_job_id;
  assert.ok(followId, 'the follow-up is queued before the job reports done');
  assert.equal(getJob(d, followId).kind, 'verify_app'); assert.equal(getJob(d, followId).status, 'succeeded');
  assert.match(getJob(d, followId).reason, /credential/);
  assert.ok(listEvents(d, s.job.id).some((e) => e.kind === 'recovery_result'), 'the follow-up notes its origin');
  // Not managed: no follow-up, said so.
  const plain = submit(d, 'instance_stop', { container: 'pp-x' }, { nowMs: T0 + 5 });
  await runAll(d, exec(h, g), T0 + 6);
  assert.equal(parseJson(getJob(d, plain.job.id).progress_json).verification_job_id, null);
  assert.match(parseJson(getJob(d, plain.job.id).verification_json).label, /the application ladder does not apply/);
});

// ── 3. contention, duplicates, interruption ───────────────────────────────

test('lock contention: refused at submission on a live or stale lease and on any open mutating job; refused at claim when a lease appeared meanwhile; a duplicate request is refused, never queued behind', () => {
  const d = db();
  acquireLock(d, { app: 'pp-x', owner: BACKEND, operation: 'deploy', jobId: 'dep-1', nowMs: T0 });
  const live = submit(d, 'instance_stop', { container: 'pp-x' });
  assert.equal(live.code, 'CONTAINER_BUSY'); assert.match(live.error, /deploy \(backend@pp#100:aaaa\) is in progress for pp-x — the instance stop was refused before any change/);
  const stale = submitRunnerJob(d, { kind: 'snapshot_delete', app: 'pp-x', params: { container: 'pp-x', snapshot: 's' }, nowMs: T0 + 60_000 });
  assert.equal(stale.code, 'CONTAINER_LOCK_STALE'); assert.match(stale.error, /recovery is required before the snapshot delete/);
  const d2 = db();
  createJob(d2, { kind: 'restore_snapshot', app: 'pp-x', plan: { params: { container: 'pp-x', snapshot: 's' } }, nowMs: T0 });
  const open = submit(d2, 'instance_start', { container: 'pp-x' });
  assert.equal(open.code, 'CONTAINER_BUSY'); assert.match(open.error, /restore_snapshot job .* is queued for pp-x — the instance start was refused/);
  const d3 = db();
  const first = submit(d3, 'instance_restart', { container: 'pp-x' });
  assert.ok(first.job);
  const second = submit(d3, 'instance_restart', { container: 'pp-x' }, { nowMs: T0 + 1 });
  assert.equal(second.code, 'CONTAINER_BUSY'); assert.match(second.error, /instance_restart job .* is queued for pp-x/);
  assert.equal(listJobs(d3, { app: 'pp-x' }).length, 1, 'no second row');
});

test('at claim time a lease taken meanwhile refuses the job (lock_held) with nothing issued', async () => {
  const d = db();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  const s = submit(d, 'instance_stop', { container: 'pp-x' });
  acquireLock(d, { app: 'pp-x', owner: BACKEND, operation: 'deploy', jobId: 'dep-2', nowMs: T0 + 1 });
  const out = await runAll(d, exec(h), T0 + 2);
  assert.equal(out.ran[0].status, 'refused'); assert.equal(out.ran[0].outcome, 'lock_held');
  assert.match(getJob(d, s.job.id).reason, /the instance_stop was refused before any change/);
  assert.deepEqual(h.calls, []);
});

test('interruption, idempotent kinds: a dead owner\'s start / delete is resumed by re-reading — finished when the state already holds, re-issued against the same identity otherwise, refused when the identity changed; nothing is blindly replayed', async () => {
  // (a) start issued, owner died, guest Running: verified, nothing re-issued.
  let d = db(); let st = { instances: [inst()] }; let h = scriptedHost(st);
  deadJob(d, { kind: 'instance_start', params: { container: 'pp-x' }, cp: { phase: 'issuing', lifecycle: true, replay: 'idempotent', resumable: true, disruptive: false, issued: true, target: { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z', status: 'Stopped' }, container: 'pp-x' } });
  let r = reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  assert.deepEqual(r.requeued, ['dead-1']);
  let out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'succeeded'); assert.deepEqual(mutations(h), []);
  assert.match(getJob(d, 'dead-1').reason, /resumed after an interrupted attempt/);
  // (b) start issued, owner died, guest still Stopped: the same command once more.
  d = db(); st = { instances: [inst({ status: 'Stopped' })] }; h = scriptedHost(st);
  deadJob(d, { kind: 'instance_start', params: { container: 'pp-x' }, cp: { phase: 'issuing', lifecycle: true, replay: 'idempotent', resumable: true, disruptive: false, issued: true, target: { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' }, container: 'pp-x' } });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'succeeded'); assert.deepEqual(mutations(h), [['incus', 'start', 'pp-x']]);
  // (c) delete issued, owner died, guest gone: verified absent, no delete re-issued.
  d = db(); st = { instances: [] }; h = scriptedHost(st);
  deadJob(d, { kind: 'instance_delete', params: { container: 'pp-x', expect: { uuid: UUID_A } }, cp: { phase: 'issuing', lifecycle: true, replay: 'idempotent', resumable: true, disruptive: false, issued: true, target: { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' }, container: 'pp-x' } });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'succeeded'); assert.deepEqual(mutations(h), []);
  assert.equal(resultFromJob(getJob(d, 'dead-1')).resumedAfterIssue, true); assert.equal(getJob(d, 'dead-1').outcome, 'deleted');
  // (d) delete issued, owner died, a guest with the SAME NAME but another identity exists: refused, nothing issued.
  d = db(); st = { instances: [inst({ config: { 'volatile.uuid': UUID_B }, created_at: '2026-09-22T11:59:00Z' })] }; h = scriptedHost(st);
  deadJob(d, { kind: 'instance_delete', params: { container: 'pp-x' }, cp: { phase: 'issuing', lifecycle: true, replay: 'idempotent', resumable: true, disruptive: false, issued: true, target: { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' }, container: 'pp-x' } });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'refused'); assert.deepEqual(mutations(h), []);
  assert.match(getJob(d, 'dead-1').reason, /changed since this job's interrupted attempt bound it .*; refusing to continue — nothing further was issued/);
  assert.equal(st.instances.length, 1, 'the other guest is untouched');
  // (e) delete issued, owner died, the SAME guest still there (the delete never took): re-issued once.
  d = db(); st = { instances: [inst({ status: 'Stopped' })] }; h = scriptedHost(st);
  deadJob(d, { kind: 'instance_delete', params: { container: 'pp-x' }, cp: { phase: 'issuing', lifecycle: true, replay: 'idempotent', resumable: true, disruptive: false, issued: true, target: { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' }, container: 'pp-x' } });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'succeeded'); assert.deepEqual(mutations(h), [['incus', 'delete', 'pp-x']]);
  // (f) snapshot create issued, owner died, snapshot present: verified, nothing re-issued.
  d = db(); st = { instances: [inst()] }; h = scriptedHost(st);
  deadJob(d, { kind: 'snapshot_create', params: { container: 'pp-x', snapshot: 'snap-1' }, cp: { phase: 'issuing', lifecycle: true, replay: 'idempotent', resumable: true, disruptive: false, issued: true, target: null, container: 'pp-x' } });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'succeeded'); assert.deepEqual(mutations(h), []);
  // (g) before any command (validated only): plainly resumed and run.
  d = db(); st = { instances: [inst({ status: 'Stopped' })] }; h = scriptedHost(st);
  deadJob(d, { kind: 'instance_start', params: { container: 'pp-x' }, cp: { phase: 'validated', lifecycle: true, replay: 'idempotent', resumable: true, disruptive: false, issued: false, target: { uuid: UUID_A }, container: 'pp-x' } });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'succeeded'); assert.deepEqual(mutations(h), [['incus', 'start', 'pp-x']]);
});

test('interruption, never-replayed kinds (R-023): a restart or create whose command was issued ends recovery_required naming the check; nothing is re-issued, no recovery job is queued, the lease is KEPT stale so every operation on the guest is refused — at submission and at the executor, however the row got there — until an operator acknowledges; the boot sweep records the same', async () => {
  for (const [kind, params] of [['instance_restart', { container: 'pp-x' }], ['instance_create', { container: 'pp-x', image: 'images:debian/12' }]]) {
    const d = db(); const st = { instances: [inst()] }; const h = scriptedHost(st);
    const job = deadJob(d, { kind, params, cp: { phase: 'issuing', lifecycle: true, replay: 'never', resumable: false, disruptive: true, issued: true, target: null, container: 'pp-x' } });
    acquireLock(d, { app: 'pp-x', owner: DEAD, operation: kind, jobId: job.id, nowMs: T0 - 99_000 });
    const decision = reconcileDecision({ job: getJob(d, 'dead-1'), lock: readLock(d, 'pp-x'), nowMs: T0 });
    assert.equal(decision.action, 'record_uncertain', kind); assert.match(decision.reason, /command issued and its result unread; it is not replayed/); assert.equal(decision.releaseLock, false);
    const r = reconcile({ db: d, owner: RUNNER, nowMs: T0 });
    assert.deepEqual(r.interrupted, ['dead-1']); assert.deepEqual(r.recoveryQueued, [], 'no recover_app for a generic guest');
    const row = getJob(d, 'dead-1');
    assert.equal(row.status, 'recovery_required'); assert.equal(row.outcome, 'interrupted_uncertain');
    assert.match(row.reason, /may or may not have taken effect — read 'incus list pp-x --format json' and decide; the guest's lease is kept stale and every operation on it is refused until this job is acknowledged \(POST \/api\/setup\/jobs\/dead-1\/acknowledge\); nothing is replayed automatically/);
    assert.equal(parseJson(row.verification_json).failedAt, 'resource_state');
    // The durable exclusion: the dead owner's lease stays, stale, pointing at this record.
    const lock = readLock(d, 'pp-x');
    assert.ok(lock, 'the lease is kept'); assert.equal(lock.owner, DEAD); assert.ok(lock.stale_since); assert.equal(lock.recovery_job_id, 'dead-1');
    // A conflicting operation is refused at submission …
    const del = submit(d, 'instance_delete', { container: 'pp-x' }, { nowMs: T0 + 1 });
    assert.equal(del.code, 'CONTAINER_LOCK_STALE'); assert.match(del.error, /did not finish \(holder runner@pp#999:dead\); recovery is required before the instance delete/);
    // … and at the executor, for a row that bypassed the orchestrator (a retry, a direct insert): refused, nothing issued.
    createJob(d, { id: 'direct-del', kind: 'instance_delete', app: 'pp-x', plan: { steps: [], params: { container: 'pp-x', force: true } }, nowMs: T0 + 2 });
    const out = await runAll(d, exec(h), T0 + 3);
    assert.equal(out.ran.length, 1); assert.equal(out.ran[0].status, 'refused'); assert.equal(out.ran[0].outcome, 'lock_stale');
    assert.match(getJob(d, 'direct-del').reason, /a previous .* for pp-x did not finish \(holder runner@pp#999:dead, recorded by job dead-1\); recovery or acknowledgement is required before instance_delete — nothing was done/);
    assert.deepEqual(h.calls, [], 'nothing runs'); assert.equal(st.instances.length, 1, 'the guest is untouched');
    assert.ok(readLock(d, 'pp-x')?.stale_since, 'the stale lease is still there');
    // No OTHER kind takes the hold over either (R-027): a verification for the app is a follow-up that waits (requeued, 5 min), a probe defers, and neither releases the lease — a diagnostic check clears nothing.
    createJob(d, { id: 'verify-1', kind: 'verify_app', app: 'pp-x', plan: { steps: ['unit_status', 'probe_port'], params: { container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service', origin: { jobId: 'dead-1', kind: 'instance_restart', rung: 'post_failure' } } }, nowMs: T0 + 3 });
    createJob(d, { id: 'probe-1', kind: 'probe', app: 'pp-x', plan: { steps: ['unit_status'], params: { container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service' } }, nowMs: T0 + 3 });
    const g = scriptedGuest({});
    const out3 = await runAll(d, { guest: g.guest, host: h.host }, T0 + 4, { max: 5 });
    const byId = Object.fromEntries(out3.ran.map((r) => [r.id, r]));
    assert.equal(byId['verify-1'].status, 'requeued'); assert.equal(byId['verify-1'].outcome, 'lock_held');
    assert.equal(byId['probe-1'].status, 'deferred'); assert.equal(byId['probe-1'].outcome, 'lock_held');
    assert.equal(getJob(d, 'verify-1').status, 'queued'); assert.ok(Date.parse(parseJson(getJob(d, 'verify-1').progress_json).not_before) >= T0 + 4 + 5 * 60_000 - 1, 'a follow-up waits five minutes on a hold');
    assert.ok(listEvents(d, 'verify-1').some((e) => e.kind === 'hold' && /unresolved instance_(restart|create) \(job dead-1\)/.test(e.message)));
    assert.deepEqual(g.calls, [], 'no probe ran in the guest'); assert.deepEqual(h.calls, []);
    const still = readLock(d, 'pp-x');
    assert.ok(still && still.stale_since && still.recovery_job_id === 'dead-1' && still.owner === DEAD, 'the hold survives every job kind');
    assert.equal(submit(d, 'instance_delete', { container: 'pp-x' }, { nowMs: T0 + 5 }).code, 'CONTAINER_LOCK_STALE', 'a delete after the verification is still refused');
    d.prepare(`DELETE FROM setup_jobs WHERE id IN ('verify-1', 'probe-1')`).run();
    // The operator looks, then acknowledges: the lease goes, the record says who and when, and the next request runs.
    const bad = acknowledgeUncertainJob(d, { id: 'direct-del', by: 'admin', nowMs: T0 + 4 });
    assert.equal(bad.ok, false); assert.match(bad.error, /only an unresolved lifecycle verb/); assert.ok(readLock(d, 'pp-x'), 'acknowledging the wrong job releases nothing');
    const ack = acknowledgeUncertainJob(d, { id: 'dead-1', by: 'admin', via: 'ui', note: 'incus list shows it Running', nowMs: T0 + 5 });
    assert.equal(ack.ok, true); assert.equal(ack.released, 1); assert.equal(readLock(d, 'pp-x'), null);
    assert.equal(getJob(d, 'dead-1').outcome, 'interrupted_uncertain_acknowledged'); assert.match(getJob(d, 'dead-1').reason, /acknowledged by admin at .*: the guest was inspected and the lease released/);
    assert.ok(listEvents(d, 'dead-1').some((e) => e.kind === 'acknowledged' && /incus list shows it Running/.test(e.message)));
    const again = acknowledgeUncertainJob(d, { id: 'dead-1', by: 'admin', nowMs: T0 + 6 });
    assert.equal(again.ok, true); assert.equal(again.already, true); assert.equal(again.released, 0);
    const del2 = submit(d, 'instance_delete', { container: 'pp-x', force: true }, { nowMs: T0 + 7 });
    assert.ok(del2.job, del2.error);
    const out2 = await runAll(d, exec(h), T0 + 8);
    assert.equal(out2.ran[0].status, 'succeeded'); assert.equal(st.instances.length, 0);
    assert.equal(listJobs(d, { app: 'pp-x' }).length, 3);
  }
  // The backend's boot sweep on its predecessor's job: the same record and the same kept lease.
  const d = db(); const job = deadJob(d, { kind: 'instance_restart', params: { container: 'pp-x' }, cp: { phase: 'issuing', lifecycle: true, replay: 'never', resumable: false, disruptive: true, issued: true, container: 'pp-x' } });
  d.prepare(`UPDATE setup_jobs SET owner = ? WHERE id = ?`).run(DEAD_BACKEND, job.id);
  acquireLock(d, { app: 'pp-x', owner: DEAD_BACKEND, operation: 'instance_restart', jobId: job.id, nowMs: T0 - 99_000 });
  const sw = sweepSetupEngineOnBoot(d, { owner: BACKEND, nowMs: T0 });
  assert.deepEqual(sw.interrupted, ['dead-1']); assert.deepEqual(sw.recoveryQueued, []);
  assert.equal(getJob(d, 'dead-1').outcome, 'interrupted_uncertain'); assert.equal(readLock(d, 'pp-x')?.recovery_job_id, 'dead-1');
  // No lease row left at all (it had been removed): the condition still excludes — a stale row is written in the dead owner's name.
  const d2 = db(); deadJob(d2, { kind: 'instance_create', params: { container: 'pp-n', image: 'images:debian/12' }, cp: { phase: 'issuing', lifecycle: true, replay: 'never', resumable: false, disruptive: true, issued: true, container: 'pp-n' } });
  assert.equal(readLock(d2, 'pp-n'), null);
  reconcile({ db: d2, owner: RUNNER, nowMs: T0 });
  const held = readLock(d2, 'pp-n');
  assert.ok(held && held.stale_since && held.recovery_job_id === 'dead-1' && held.owner === DEAD, JSON.stringify(held));
  assert.equal(submit(d2, 'instance_start', { container: 'pp-n' }, { nowMs: T0 + 1 }).code, 'CONTAINER_LOCK_STALE');
});

test('the acknowledgement is one transaction (R-028): a failure recording it leaves the hold in place; nothing is released without the record', async () => {
  const d = db(); const st = { instances: [inst()] }; const h = scriptedHost(st);
  deadJob(d, { kind: 'instance_restart', params: { container: 'pp-x' }, cp: { phase: 'issuing', lifecycle: true, replay: 'never', resumable: false, disruptive: true, issued: true, container: 'pp-x' } });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  assert.ok(readLock(d, 'pp-x')?.stale_since);
  // The event write fails (a full disk, a lock): the request fails, and the hold, the outcome and the queue are exactly as before.
  const failing = { exec: (sql) => d.exec(sql), prepare: (sql) => { const stmt = d.prepare(sql); return { run: (...a) => { if (/INSERT INTO setup_job_events/.test(sql) && a[2] === 'acknowledged') throw new Error('SQLITE_FULL: database or disk is full'); return stmt.run(...a); }, get: (...a) => stmt.get(...a), all: (...a) => stmt.all(...a) }; } };
  const r = acknowledgeUncertainJob(failing, { id: 'dead-1', by: 'admin', nowMs: T0 + 1 });
  assert.equal(r.ok, false); assert.equal(r.code, 'NOT_RECORDED'); assert.match(r.error, /not recorded \(SQLITE_FULL: database or disk is full\); the lease is still held/);
  assert.ok(readLock(d, 'pp-x')?.stale_since, 'the hold is still there'); assert.equal(getJob(d, 'dead-1').outcome, 'interrupted_uncertain');
  assert.ok(!listEvents(d, 'dead-1').some((e) => e.kind === 'acknowledged'));
  assert.equal(submit(d, 'instance_delete', { container: 'pp-x' }, { nowMs: T0 + 2 }).code, 'CONTAINER_LOCK_STALE', 'a delete is still refused');
  const out = await runAll(d, exec(h), T0 + 3); assert.deepEqual(out.ran, []); assert.equal(st.instances.length, 1);
  // The outcome write failing the same way: nothing released either.
  const failing2 = { exec: (sql) => d.exec(sql), prepare: (sql) => { const stmt = d.prepare(sql); return { run: (...a) => { if (/UPDATE setup_jobs SET outcome = \?, reason = \?/.test(sql)) throw new Error('SQLITE_BUSY'); return stmt.run(...a); }, get: (...a) => stmt.get(...a), all: (...a) => stmt.all(...a) }; } };
  assert.equal(acknowledgeUncertainJob(failing2, { id: 'dead-1', by: 'admin', nowMs: T0 + 4 }).code, 'NOT_RECORDED');
  assert.ok(readLock(d, 'pp-x')?.stale_since);
  // A sound store: all three land together, and a second lifecycle request runs.
  const ok = acknowledgeUncertainJob(d, { id: 'dead-1', by: 'admin', nowMs: T0 + 5 });
  assert.equal(ok.ok, true); assert.equal(ok.released, 1); assert.equal(readLock(d, 'pp-x'), null); assert.equal(getJob(d, 'dead-1').outcome, 'interrupted_uncertain_acknowledged');
  assert.ok(listEvents(d, 'dead-1').some((e) => e.kind === 'acknowledged'));
  assert.ok(submit(d, 'instance_stop', { container: 'pp-x', force: true }, { nowMs: T0 + 6 }).job);
});

test('mandatory checkpoints (R-024): a checkpoint that cannot be persisted — the store rejects the write, or the job is no longer this owner\'s — stops the operation before any command is issued, through the real store and executor', async () => {
  // (a) the real store, with SQLite rejecting the `issuing` checkpoint write.
  const d = db(); const st = { instances: [inst()] }; const h = scriptedHost(st);
  const failing = {
    exec: (sql) => d.exec(sql),
    prepare: (sql) => {
      const stmt = d.prepare(sql);
      return {
        run: (...a) => { if (/SET phase = \?, checkpoint_json = \?/.test(sql) && a[0] === 'issuing') throw new Error('SQLITE_IOERR: disk I/O error'); return stmt.run(...a); },
        get: (...a) => stmt.get(...a), all: (...a) => stmt.all(...a),
      };
    },
  };
  const s = submit(d, 'instance_restart', { container: 'pp-x' });
  const out = await runOnce({ db: failing, owner: RUNNER, exec: exec(h), nowMs: () => T0 + 1 }, { reconcileFirst: false });
  assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'failed at checkpoint');
  const row = getJob(d, s.job.id);
  assert.match(row.reason, /the 'issuing' checkpoint could not be persisted \(SQLITE_IOERR: disk I\/O error\); refusing to issue a command whose record would not say so; nothing was issued/);
  assert.deepEqual(mutations(h), [], 'no restart was issued'); assert.equal(st.restarts, undefined);
  assert.equal(parseJson(row.checkpoint_json).issued, false, 'the record and the world agree: nothing issued');
  assert.equal(resultFromJob(row).notIssued, true); assert.equal(readLock(d, 'pp-x'), null);
  // (b) the write changes no row because the job was fenced (another owner took it): stopped before the command.
  const d2 = db(); const st2 = { instances: [inst({ status: 'Stopped' })] }; const h2 = scriptedHost(st2);
  const s2 = submit(d2, 'instance_start', { container: 'pp-x' });
  const claimed = claimNextJob(d2, { owner: RUNNER, kinds: ['instance_start'], nowMs: T0 + 1 });
  // Fence the job under RUNNER's feet at the validated → issuing boundary: the host list call is the hook.
  let fenced = false;
  const hostFencing = { host: async (argv) => { const r = await h2.host(argv); if (!fenced && argv[1] === 'list') { fenced = true; d2.prepare(`UPDATE setup_jobs SET epoch = epoch + 1, owner = ? WHERE id = ?`).run(DEAD, s2.job.id); } return r; } };
  const { executeJob } = await import('../lib/setup-engine/executor.js');
  const r2 = await executeJob(claimed, { db: d2, owner: RUNNER, exec: { guest: async () => ({ code: 0, stdout: '' }), host: hostFencing.host }, nowMs: () => T0 + 2 });
  assert.equal(r2.status, 'fenced', JSON.stringify(r2)); assert.deepEqual(mutations(h2), [], 'nothing issued by a fenced worker');
  // (c) the operation alone, with a handle whose checkpoint reports no row changed.
  const st3 = { instances: [inst()] }; const h3 = scriptedHost(st3);
  const handle = { id: 'j1', fence: () => {}, checkpoint: (phase) => (phase === 'issuing' ? 0 : 1), generated: () => 1, event: () => {}, onStep: null };
  const r3 = await runLifecycleOperation({ kind: 'instance_restart', params: { container: 'pp-x' }, exec: exec(h3), job: handle });
  assert.equal(r3.ok, false); assert.equal(r3.step, 'checkpoint'); assert.equal(r3.notIssued, true); assert.match(r3.error, /changed no row/); assert.deepEqual(mutations(h3), []);
  assert.equal(new CheckpointNotPersistedError('issuing', 'x').code, 'CHECKPOINT_NOT_PERSISTED');
});

test('a nonzero exit is a failure whatever the guest reads afterwards (R-026): a restart that exits 1 or times out with the guest still Running is not "restarted"', async () => {
  const d = db(); const st = { instances: [inst()] }; const h = scriptedHost(st);
  const base = h.host;
  h.host = async (argv) => { const r = await base(argv); if (argv[1] === 'restart') return { code: 1, stdout: '', stderr: 'Error: The instance is busy' }; return r; };
  const s = submit(d, 'instance_restart', { container: 'pp-x' });
  const out = await runAll(d, exec(h), T0 + 1);
  assert.equal(out.ran[0].status, 'failed', getJob(d, s.job.id).reason);
  const r = resultFromJob(getJob(d, s.job.id));
  assert.equal(r.step, 'issue'); assert.equal(r.instanceState, 'Running'); assert.match(r.error, /incus instance restart exited 1: Error: The instance is busy; pp-x reads Running afterwards — not claiming restarted/);
  assert.equal(parseJson(getJob(d, s.job.id).verification_json).state, 'recovery_required');
  // A timeout (124) the same way, and a start that exits nonzero while the guest reads Running.
  h.host = async (argv) => { const r = await base(argv); if (argv[1] === 'restart') return { code: 124, stdout: '', stderr: '[timeout after 180000ms]' }; if (argv[1] === 'start') return { code: 1, stdout: '', stderr: 'Error: The instance is already running' }; return r; };
  const s2 = submit(d, 'instance_restart', { container: 'pp-x' }, { nowMs: T0 + 2 });
  await runAll(d, exec(h), T0 + 3);
  assert.match(getJob(d, s2.job.id).reason, /exited 124 \(timed out\)/); assert.equal(getJob(d, s2.job.id).status, 'failed');
  st.instances[0].status = 'Stopped';
  h.host = async (argv) => { const r = await base(argv); if (argv[1] === 'start') { st.instances[0].status = 'Running'; return { code: 1, stdout: '', stderr: 'Error: The instance is already running' }; } return r; };
  const s3 = submit(d, 'instance_start', { container: 'pp-x' }, { nowMs: T0 + 4 });
  await runAll(d, exec(h), T0 + 5);
  assert.equal(getJob(d, s3.job.id).status, 'failed'); assert.match(getJob(d, s3.job.id).reason, /exited 1: .*already running; pp-x reads Running afterwards — not claiming started/);
});

test('cancel: honoured before the command, declined after it (the job finishes and reads the state back)', async () => {
  const d = db(); const st = { instances: [inst({ status: 'Stopped' })] }; const h = scriptedHost(st);
  const s = submit(d, 'instance_start', { container: 'pp-x' });
  const { requestCancel } = await import('../lib/setup-engine/store.js');
  requestCancel(d, { id: s.job.id, by: 'admin', nowMs: T0 + 1 });
  const out = await runAll(d, exec(h), T0 + 2);
  assert.deepEqual(out.ran, [], 'a queued job is cancelled outright, never claimed'); assert.equal(getJob(d, s.job.id).status, 'cancelled'); assert.deepEqual(h.calls, []);
  // Requested after the claim: honoured at the first fence (before the query), nothing issued.
  const s2 = submit(d, 'instance_start', { container: 'pp-x' }, { nowMs: T0 + 3 });
  const claimed = claimNextJob(d, { owner: RUNNER, kinds: ['instance_start'], nowMs: T0 + 4 });
  assert.equal(claimed.id, s2.job.id);
  requestCancel(d, { id: s2.job.id, by: 'admin', nowMs: T0 + 5 });
  const { executeJob } = await import('../lib/setup-engine/executor.js');
  const r = await executeJob(claimed, { db: d, owner: RUNNER, exec: exec(h), nowMs: () => T0 + 6 });
  assert.equal(r.status, 'cancelled'); assert.deepEqual(mutations(h), []); assert.equal(st.instances[0].status, 'Stopped');
});

// ── 4. who executes ───────────────────────────────────────────────────────

test('runner-required with no live runner: refused (cancelled / runner_unavailable), never queued, no host call; a live runner takes the job; backend-allowed runs the same executor in-process', async (t) => {
  const d = db(); const st = { instances: [inst({ status: 'Stopped' })] }; const h = scriptedHost(st);
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'runner-required' }, guestExec: exec(h), hostExec: h.host, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const refused = await runLifecycle({ kind: 'instance_start', containerName: 'pp-x', via: 'ui' });
  assert.equal(refused.ok, false); assert.equal(refused.step, 'runner_unavailable'); assert.equal(refused.refused, true);
  assert.match(refused.error, /the instance start was refused before any change — start proxypilot-setup-runner.service/);
  assert.equal(getJob(d, refused.jobId).status, 'cancelled'); assert.equal(getJob(d, refused.jobId).outcome, 'runner_unavailable');
  assert.deepEqual(h.calls, []); assert.equal(st.instances[0].status, 'Stopped');
  assert.equal(lifecycleHttpStatus(refused), 503);
  // A runner heartbeats: the submission is handed to it (detached) and stays queued for it.
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() });
  const handed = await runLifecycle({ kind: 'instance_start', containerName: 'pp-x', via: 'ui', detach: true });
  assert.equal(handed.ok, true); assert.equal(handed.executor, 'runner'); assert.equal(getJob(d, handed.jobId).status, 'queued');
  assert.deepEqual(h.calls, [], 'the backend ran nothing');
  const out = await runAll(d, exec(h), Date.now());
  assert.equal(out.ran[0].id, handed.jobId); assert.equal(out.ran[0].status, 'succeeded'); assert.equal(getJob(d, handed.jobId).owner, RUNNER);
  // backend-allowed, no runner: in-process, owner backend@…
  const d2 = db(); const st2 = { instances: [inst({ status: 'Stopped' })] }; const h2 = scriptedHost(st2);
  configureContainerLockStore({ getDb: () => d2, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(h2), hostExec: h2.host, reviewLogin: async () => LOGIN });
  const ran = await runLifecycle({ kind: 'instance_start', containerName: 'pp-x', via: 'mcp', requestedBy: 'key-1' });
  assert.equal(ran.ok, true, JSON.stringify(ran)); assert.equal(ran.executor, 'backend'); assert.equal(ran.instanceState, 'Running');
  assert.equal(getJob(d2, ran.jobId).owner, BACKEND); assert.equal(getJob(d2, ran.jobId).via, 'mcp'); assert.equal(getJob(d2, ran.jobId).requested_by, 'key-1');
  assert.deepEqual(mutations(h2), [['incus', 'start', 'pp-x']]);
  // A detached snapshot under the in-process executor is kicked, not left for the interval drain.
  const snap = await runLifecycle({ kind: 'snapshot_create', containerName: 'pp-x', snapshot: 'ui-1', note: 'from the dashboard', via: 'ui', detach: true, awaitKick: true });
  assert.equal(snap.ok, true); assert.equal(snap.submitted, true);
  assert.equal(getJob(d2, snap.jobId).status, 'succeeded'); assert.ok(st2.instances[0].snapshots.some((s) => s.name === 'ui-1'));
  assert.equal(st2.notes['pp-x/snapshots/ui-1'], 'user.note=from the dashboard');
});

test('the ops layer: the plan and its digest (a different force flag or identity is a different plan), refusals mapped to HTTP, an invalid request never reaches the store', async (t) => {
  const p1 = resolveLifecyclePlan(null, { kind: 'instance_delete', containerName: 'pp-x', force: false, expect: { uuid: UUID_A } });
  const p2 = resolveLifecyclePlan(null, { kind: 'instance_delete', containerName: 'pp-x', force: true, expect: { uuid: UUID_A } });
  const p3 = resolveLifecyclePlan(null, { kind: 'instance_delete', containerName: 'pp-x', force: false, expect: { uuid: UUID_B } });
  assert.ok(p1.ok && p2.ok && p3.ok); assert.notEqual(p1.digest, p2.digest); assert.notEqual(p1.digest, p3.digest);
  assert.equal(p1.digest, planDigest(p1.plan));
  assert.equal(resolveLifecyclePlan(null, { kind: 'instance_start', containerName: 'pp-x', force: true }).plan.force, false, 'force is a stop/restart/delete flag; a start never carries it');
  assert.match(resolveLifecyclePlan(null, { kind: 'reboot', containerName: 'pp-x' }).error, /unknown lifecycle operation/);
  assert.equal(resolveLifecyclePlan(null, { kind: 'instance_create', containerName: 'pp-n', image: 'images:debian/12', config: { 'limits.cpu': 2, 'limits.memory': null } }).params.config['limits.cpu'], '2');
  assert.equal(lifecycleHttpStatus({ ok: false, code: 'CONTAINER_BUSY' }), 409);
  assert.equal(lifecycleHttpStatus({ ok: false, code: 'CONTAINER_LOCK_STALE' }), 409);
  assert.equal(lifecycleHttpStatus({ ok: false, code: 'INVALID' }), 400);
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'runner_unavailable' }), 503);
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'query', notFound: true }), 404);
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'target', refused: true }), 409);
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'query', refused: true }), 409);
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'issue' }), 500);
  const d = db();
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: { guest: async () => ({ code: 0, stdout: '' }) }, hostExec: async () => ({ code: 0, stdout: '[]', stderr: '' }) });
  t.after(() => configureContainerLockStore(null));
  const bad = await runLifecycle({ kind: 'instance_create', containerName: 'pp-n', image: 'images:debian/12', config: { 'user.x': 'y' } });
  assert.equal(bad.code, 'INVALID'); assert.match(bad.error, /allowlist/); assert.equal(listJobs(d).length, 0, 'no job row for an invalid plan');
});

// ── 5. the MCP callers over a fake ctx, real store and executor ────────────

const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
const LXC_POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/lxc-command-allowlist.json', import.meta.url), 'utf8'));
const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return { error: r.content[0].text, isError: !!r.isError }; } };
const AUTH = { id: 7, created_by: 'admin-1', name: 'test key', scope_json: null };

function mcpCtx(state) {
  const ledger = [];
  const fdb = { prepare(sql) { return { run: (...a) => { if (/INSERT INTO mcp_ledger/.test(sql)) ledger.push(a); return { changes: 1 }; }, get: () => undefined, all: () => [] }; }, exec() {}, pragma() { return 1; } };
  const confirmations = createConfirmationStore();
  const hostCalls = [];
  const ctx = {
    getDb: () => fdb, logAudit: () => {}, getSetting: () => null, setSetting: () => {}, toolResult, uuidv4: () => 'uuid', policy: POLICY, confirmations,
    runHostCapture: async (bin, args) => { hostCalls.push([bin, ...args]); return { status: 0, stdout: '', stderr: '' }; },
    runInContainer: async () => ({ status: 0, stdout: '', stderr: '' }), readContainerStartup: async () => null, agentCall: async () => { throw new Error('no agent'); }, publicBaseUrl: () => 'https://pp.test',
    LXC_PREFIX: 'pp-', LXC_NAME_REGEX: /^[a-zA-Z0-9][a-zA-Z0-9-]*$/, LXC_CMD_POLICY: LXC_POLICY, LXC_LIST_CAPTURE_CAP: 1 << 24,
    validLxcFilePath: (p) => p, validTargetDir: (p) => p,
    takeLxcSnapshot: async (n, s) => ({ name: s }), fetchLxcInstance: async (n) => { const i = state.instances.find((x) => x.name === n); return i ? { instance: i } : { notFound: true }; },
    lxcContainerDetail, lxcReachableAddress: () => null,
    defaultSnapshotName: (d, p = 'pp-mcp') => `${p}-x`, validSnapshotName: (s) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(s || '')) ? String(s) : null), snapshotArgv: (v, i, s) => ['snapshot', v, i, s], resolveSnapshotCliForm: async () => 'subcommand',
    verifiedContainerWrite: async () => ({}), takeUploadTicket: async () => { throw new Error('no ticket'); },
    findOrCreateLxcService: () => ({ id: 's' }), syncLxcServiceUpstream: async () => ({}), regenerateDomainCaddyConfig: async () => {}, ensureCaddyStructure: async () => {},
    assertRoutesShareSslStance: () => {}, caddyAdapt: async () => {}, caddyReload: async () => {}, normalizePathPrefix: (v) => v || '/',
    validDomainName: (s) => s, normalizePort: (p) => Number(p) || null, validIpv4: (s) => s, ROUTE_SELECT: 'SELECT 1', routeView: (r) => r, certInfoForDomain: async () => ({}), recentErrorsForDomain: async () => null,
    caddyAccessLogPath: (d) => d, summarizeAccessLog: () => ({}), getStaticSite: () => null, staticSiteDomains: () => [], SERVICES_DATA_DIR: '/data/services', walkDocroot: async () => ({ files: [] }),
    mock2Enabled: () => true, mock2Modules: async () => ({}), projectContainerName: () => 'pp-x', requireActiveProject: () => ({ project: { id: 1, name: 'demo' } }),
    liveBuildGuard: () => null, commitProjectPaths: async () => ({}), readProjectText: async () => ({ error: 'x' }), M2_APP_DIR: '/srv/app', projectUrl: () => null, projectSummary: (p) => p,
    appendProjectChangeRecord: async () => ({ appended: true, seq: 1 }),
    selfUpdateInstalled: async () => ({ reachable: false }), selfUpdateStart: async () => { throw new Error('off'); }, selfUpdateStatus: async () => ({ status: 'idle' }), SELF_UPDATE_POLICY: { enabled: true },
    mintMcpToken: () => 'ppmcp_' + 'a'.repeat(64), hashMcpToken: (t) => `h:${t}`, MCP_TOOL_NAMES: () => MCP_TOOLS.map((t) => t.name), dbPath: '/tmp/pp.db', listBackupsRunning: null,
  };
  return { ctx, ledger, confirmations, hostCalls };
}

test('MCP delete_lxc_container: the token is bound to the guest\'s identity (a guest recreated under the same name cannot be deleted with it); the delete runs as a job through the executor with no incus stop/delete in the tool; the ledger row names the job', async (t) => {
  const d = db();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(h), hostExec: h.host, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const { ctx, ledger, hostCalls } = mcpCtx(st);
  const tools = createExtendedHandlers(ctx).handlers;
  const dry = parse(await tools.delete_lxc_container({ container: 'x', export: false, dry_run: true }, AUTH));
  assert.equal(dry.dry_run, true); assert.deepEqual(dry.would.identity, { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' }); assert.match(dry.would.then, /setup-engine job/);
  const first = parse(await tools.delete_lxc_container({ container: 'x', export: false }, AUTH));
  assert.equal(first.needs_confirmation, true); assert.ok(first.confirmation_token);
  // The guest is recreated under the same name before the confirmation arrives.
  st.instances = [inst({ config: { 'volatile.uuid': UUID_B }, created_at: '2026-09-22T11:59:00Z' })];
  const wrong = parse(await tools.delete_lxc_container({ container: 'x', export: false, confirmation_token: first.confirmation_token }, AUTH));
  assert.match(wrong.error, /issued for a different target/);
  assert.equal(listJobs(d).length, 0, 'nothing was submitted'); assert.deepEqual(mutations(h), []);
  // Confirmed against the guest as it is now.
  const again = parse(await tools.delete_lxc_container({ container: 'x', export: false }, AUTH));
  const done = parse(await tools.delete_lxc_container({ container: 'x', export: false, confirmation_token: again.confirmation_token }, AUTH));
  assert.equal(done.deleted, true, JSON.stringify(done)); assert.ok(done.job_id);
  assert.deepEqual(mutations(h), [['incus', 'stop', 'pp-x'], ['incus', 'delete', 'pp-x']]);
  assert.equal(st.instances.length, 0);
  const job = getJob(d, done.job_id);
  assert.equal(job.kind, 'instance_delete'); assert.equal(job.status, 'succeeded'); assert.equal(job.via, 'mcp');
  assert.deepEqual(parseJson(job.plan_json).params.expect, { uuid: UUID_B, created_at: '2026-09-22T11:59:00Z' });
  assert.ok(!hostCalls.some((a) => a[0] === 'incus' && ['stop', 'delete'].includes(a[1])), 'the tool itself issues no incus stop/delete');
  const row = ledger.find((r) => r[3] === 'delete_lxc_container' && r[8] === 'ok');
  assert.ok(row); assert.equal(JSON.parse(row[13]).job_id, done.job_id);
});

test('MCP delete_snapshot: confirm: true, the job bound to the snapshot\'s timestamp; a snapshot replaced under the same name is refused by the job; busy is refused before any change', async (t) => {
  const d = db();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(h), hostExec: h.host, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const tools = createExtendedHandlers(mcpCtx(st).ctx).handlers;
  const dry = parse(await tools.delete_snapshot({ container: 'x', snapshot: 'snap-1', dry_run: true }, AUTH));
  assert.equal(dry.would.created_at, '2026-09-20T10:00:00Z');
  assert.match(parse(await tools.delete_snapshot({ container: 'x', snapshot: 'snap-1' }, AUTH)).error, /confirm: true/);
  // The MCP listing saw one snapshot; the runner reads a different one under that name.
  const listing = mcpCtx({ instances: [inst({ snapshots: [{ name: 'snap-1', created_at: '2026-09-19T00:00:00Z' }] })] });
  const stale = parse(await createExtendedHandlers(listing.ctx).handlers.delete_snapshot({ container: 'x', snapshot: 'snap-1', confirm: true }, AUTH));
  assert.match(stale.error, /not the resource this request was confirmed for/); assert.equal(stale.refused, true); assert.deepEqual(mutations(h), []);
  const done = parse(await tools.delete_snapshot({ container: 'x', snapshot: 'snap-1', confirm: true }, AUTH));
  assert.equal(done.deleted, true, JSON.stringify(done)); assert.deepEqual(done.remaining, []); assert.ok(done.job_id);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'delete', 'pp-x', 'snap-1']]);
  st.instances[0].snapshots.push({ name: 'snap-2', created_at: '2026-09-21T00:00:00Z' });
  acquireLock(d, { app: 'pp-x', owner: RUNNER, operation: 'deploy', jobId: 'dep', nowMs: Date.now() });
  const busy = parse(await tools.delete_snapshot({ container: 'x', snapshot: 'snap-2', confirm: true }, AUTH));
  assert.match(busy.error, /deploy .* is in progress for pp-x — the snapshot delete was refused before any change/);
  assert.equal(st.instances[0].snapshots.length, 1);
});

// ── 6. the rendered argv reaches the real host channel verbatim ───────────

test('the runner\'s host channel receives the rendered argv as one spawn — no shell between the plan and the process', async () => {
  const spawned = [];
  const spawnImpl = (bin, args, opts) => {
    spawned.push([bin, ...args]);
    return spawn(process.execPath, ['-e', 'process.exit(0)'], opts);
  };
  const ex = hostGuestExec({ spawnImpl });
  for (const [kind, p] of [['instance_stop', { container: 'pp-x', force: true }], ['snapshot_delete', { container: 'pp-x', snapshot: 'a.b' }], ['instance_create', { container: 'pp-n', image: 'images:debian/12', config: { 'security.nesting': 'true' } }]]) {
    const argv = lifecycleArgv(kind, p);
    const r = await ex.host(argv, { timeoutMs: 5000 });
    assert.equal(r.code, 0);
    assert.deepEqual(spawned.at(-1), argv);
  }
  assert.ok(spawned.every((a) => a[0] === 'incus' && !a.includes('sh') && !a.includes('-c')));
});
