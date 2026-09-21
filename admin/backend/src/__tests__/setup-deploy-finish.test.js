// The four corrections that finish the runner-owned deployment slice:
//   1. durable application-owned verification (a follow-up job, distinct
//      outcomes, an API restart that loses nothing, never a password in a row)
//   2. migration-aware checkpoints (the boundary sits before the migration,
//      protected copies are retained versions, a migration in flight is
//      recorded with its retry class)
//   3. containment of every writer of a stale deployment on the record
//      (survivors keep the lease and flag it; the real-process proof is in
//      setup-deploy-closeout.test.js)
//   4. the explicit executor policy (runner-required queues and reports;
//      backend-allowed runs the same executor in-process; never a request
//      parameter)

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ensureSetupEngineSchema, getJob, listEvents, readLock, runnerHeartbeat, acquireLock, claimNextJob, checkpoint } from '../lib/setup-engine/store.js';
import { ownerIdentity, executorPolicy, parseJson, CREDENTIAL_USE_OUTCOMES } from '../lib/setup-engine/logic.js';
import { submitDeployJob, sweepSetupEngineOnBoot, executionMode, drainRunnerJobsInProcess } from '../lib/setup-engine/backend.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { runDeployOperation } from '../lib/setup-engine/deploy-op.js';
import { classifyMigrateScript, interpretCredentialUse, credentialUseScript, parseProtectedCopies, protectedCopiesScript } from '../lib/setup-engine/guest-probes.js';
import { deployProject, drainInProcessNow } from '../mock2/deploy.js';
import { configureContainerLockStore, withContainerLock, ContainerLockStaleError } from '../mock2/container-lock.js';
import { scriptedGuest as guestFor, noSecretIn, PARAMS, LOGIN, GUARD } from './helpers/scripted-guest.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const T0 = Date.parse('2026-09-21T16:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const RUNNER2 = ownerIdentity({ kind: 'runner', host: 'pp', pid: 301, instance: 'ssss' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const BACKEND2 = ownerIdentity({ kind: 'backend', host: 'pp', pid: 101, instance: 'bbbb' });

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); return d; }

// ── 1. durable application-owned verification ──────────────────────────

test('the application rung is a persisted follow-up: queued before the deploy reports done, survives an API restart, runs exactly once, lands on both records', async () => {
  const d = db();
  const g = guestFor({ ldaps: 'current' });
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), requestedBy: 'alice', via: 'ui', nowMs: T0 });
  // The runner executes the deploy and ONLY the deploy (max 1).
  const first = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  assert.equal(first.ran.length, 1);
  const deploy = getJob(d, sub.job.id);
  assert.equal(deploy.status, 'succeeded');
  assert.equal(deploy.outcome, 'serving', 'execution status');
  const ver = parseJson(deploy.verification_json);
  assert.equal(ver.state, 'credential_decryptable');
  assert.deepEqual(ver.pending, ['credential_use_verified'], 'verification status: not final');
  const followId = parseJson(deploy.progress_json).verification_job_id;
  const follow = getJob(d, followId);
  assert.equal(follow.kind, 'verify_app');
  assert.equal(follow.status, 'queued');
  assert.deepEqual(parseJson(follow.plan_json).steps, ['verify_credential_use']);
  assert.ok(Date.parse(follow.created_at) <= Date.parse(deploy.finished_at), 'the obligation exists before the deploy is finished');
  // The requesting API process exits and a new one boots: nothing is lost or duplicated.
  const swept = sweepSetupEngineOnBoot(d, { owner: BACKEND2, nowMs: T0 + 60_000 });
  assert.deepEqual(swept, { interrupted: [], recoveryQueued: [], skipped: [] });
  assert.equal(getJob(d, followId).status, 'queued');
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM setup_jobs WHERE kind = 'verify_app'`).get().n, 1);
  // The runner (a later tick, or a restarted runner) runs the verification once.
  const second = await runOnce({ db: d, owner: RUNNER2, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 61_000 }, { reconcileFirst: true });
  assert.equal(second.ran.length, 1);
  assert.equal(second.ran[0].id, followId);
  assert.equal(second.ran[0].status, 'succeeded');
  assert.equal(second.ran[0].verification.state, 'credential_use_verified');
  const after = getJob(d, sub.job.id);
  const rungs = parseJson(after.verification_json).rungs;
  assert.equal(rungs.credential_use_verified.value, true);
  assert.equal(rungs.credential_use_verified.by, RUNNER2);
  assert.equal(parseJson(after.verification_json).state, 'credential_use_verified');
  assert.equal(after.status, 'succeeded');
  assert.ok(listEvents(d, sub.job.id).some((e) => e.kind === 'recovery_result' && /verify_app/.test(e.message)));
  // Nothing more to run; the login is nowhere in the records.
  const third = await runOnce({ db: d, owner: RUNNER2, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 62_000 }, { reconcileFirst: false });
  assert.equal(third.ran.length, 0);
  noSecretIn(d, [sub.job.id, followId]);
  assert.equal(g.calls.filter((c) => c.phase === 'credential_use').length, 1);
});

test('the application rung has distinct outcomes: verified, failed (legacy or unreadable rows behind a 200), no protected credentials, no verification credentials, unreachable, superseded', async () => {
  const cases = [
    ['current', LOGIN, true, 'verified', 'credential_use_verified'],
    ['legacy', LOGIN, false, 'failed', 'recovery_required'],
    ['unreadable', LOGIN, false, 'failed', 'recovery_required'],
    ['none', LOGIN, null, 'no_protected_credentials', 'credential_decryptable'],
    ['current', null, null, 'no_verification_credentials', 'credential_decryptable'],
    ['down', LOGIN, null, 'unreachable', 'credential_decryptable'],
    ['nosettings', LOGIN, null, 'unreachable', 'credential_decryptable'],
  ];
  for (const [ldaps, login, value, outcome, finalState] of cases) {
    const d = db();
    const g = guestFor({ ldaps });
    const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
    await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => login, nowMs: () => T0 + 1 }, { reconcileFirst: false });
    const deploy = getJob(d, sub.job.id);
    assert.equal(deploy.status, 'succeeded', `${outcome}: execution is a separate fact`);
    const v = parseJson(deploy.verification_json);
    assert.equal(v.rungs.credential_use_verified.value, value, outcome);
    assert.match(v.rungs.credential_use_verified.detail, new RegExp(`^${outcome}:`));
    assert.equal(v.state, finalState, outcome);
    const follow = getJob(d, parseJson(deploy.progress_json).verification_job_id);
    assert.equal(follow.outcome, outcome);
    assert.equal(follow.status, value === false ? 'recovery_required' : 'succeeded');
    if (value === false) assert.match(follow.reason, /cannot use its credential as stored|refused/);
    noSecretIn(d, [sub.job.id, follow.id]);
  }
  assert.deepEqual(Object.keys(CREDENTIAL_USE_OUTCOMES).sort(), ['failed', 'no_protected_credentials', 'no_verification_credentials', 'not_applicable', 'superseded', 'unreachable', 'verified']);
  assert.equal(interpretCredentialUse('SIGNIN:200\n{"configured":true,"masterKey":"current","masterKeyInventory":{"total":2,"current":1,"legacy":0,"unreadable":1,"complete":false}}\nLDAPS:200\n').outcome, 'failed', 'a 200 with an unreadable row is not verified');
  assert.throws(() => credentialUseScript(3000, null), /needs a login/);
});

// ── 2. migration-aware checkpoints ─────────────────────────────────────

test('the maintenance boundary sits before the migration; protected copies are retained versions; a migration in flight or failed is recorded with its retry class and never rolled back on its own', async () => {
  const d = db();
  const g = guestFor({});
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  const phases = g.calls.map((c) => c.phase);
  assert.ok(phases.indexOf('stop') < phases.indexOf('migrate'), 'stopped before migrating');
  assert.ok(phases.indexOf('protect') < phases.indexOf('stop'), 'copies before the stop');
  assert.ok(phases.indexOf('build') < phases.indexOf('protect'));
  const cp = parseJson(getJob(d, sub.job.id).checkpoint_json);
  assert.deepEqual(cp.recovery.completed, ['install', 'build', 'migrate']);
  assert.equal(cp.recovery.migration.retry, 'resume');
  assert.equal(cp.recovery.protected.dbDump.path, `/var/backups/proxypilot-db/app-pre-deploy-${sub.job.id}.sql`);
  assert.equal(cp.recovery.protected.unitCopy, `/etc/systemd/system/mock2-dev.service.pre-${sub.job.id}`);
  assert.equal(cp.recovery.protected.envCopy, `/etc/environment.pre-${sub.job.id}`);
  assert.equal(cp.recovery.protected.sourceCommit, 'd'.repeat(40));
  // A later deploy takes its OWN copies; the first record still names its own.
  const sub2 = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 100 });
  await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 101 }, { reconcileFirst: false });
  assert.deepEqual(g.calls.filter((c) => c.phase === 'protect').map((c) => c.id), [sub.job.id, sub2.job.id]);
  assert.equal(parseJson(getJob(d, sub.job.id).checkpoint_json).recovery.protected.envCopy, `/etc/environment.pre-${sub.job.id}`, 'unchanged by the later deploy');
  assert.notEqual(parseJson(getJob(d, sub2.job.id).checkpoint_json).recovery.protected.envCopy, `/etc/environment.pre-${sub.job.id}`);

  // Interrupted mid-migration: recover, with the migration's retry class on the record and the copies carried to the recovery job.
  const d2 = db();
  const g2 = guestFor({});
  const sub3 = submitDeployJob(d2, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  const c3 = claimNextJob(d2, { owner: RUNNER2, kinds: ['deploy'], leaseMs: 1000, nowMs: T0 });
  acquireLock(d2, { app: 'pp-x', owner: RUNNER2, operation: 'deploy', jobId: c3.id, leaseMs: 1000, nowMs: T0 });
  checkpoint(d2, { id: c3.id, owner: RUNNER2, epoch: c3.epoch, phase: 'migrating', checkpoint: { app_stopped: true, disruptive: true, migration_in_progress: true, container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service', recovery: { migration: { retry: 'unknown', ledger: null }, protected: { dbDump: { path: '/var/backups/proxypilot-db/app-pre-deploy-x.sql' } }, guard: GUARD } }, nowMs: T0 });
  const s = reconcile({ db: d2, owner: RUNNER, nowMs: T0 + 60_000 });
  assert.equal(s.recoveryQueued.length, 1);
  const dead = getJob(d2, c3.id);
  assert.equal(dead.status, 'recovery_required');
  assert.match(dead.reason, /A migration was in flight \(retry class: unknown\)/);
  const rec = getJob(d2, s.recoveryQueued[0].recovery);
  assert.equal(parseJson(rec.config_refs_json).recovery.protected.dbDump.path, '/var/backups/proxypilot-db/app-pre-deploy-x.sql', 'the protected copy travels with the recovery job');
  assert.equal(readLock(d2, 'pp-x').stale_since != null, true);

  // A failed migration: distinct step, the ledger and the dump named, the old process restarted on the new dist — never a rollback.
  const g3 = guestFor({ fail: 'migrate' });
  const r = await runDeployOperation({ params: PARAMS(), exec: g3, job: { id: 'j-fail', fence: () => {}, checkpoint: () => 0, generated: () => 0, event: () => {} } });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'migrate');
  assert.match(r.error, /Database migration failed/);
  assert.match(r.error, /Restart attempted/i);
  assert.match(r.error, /ledger \(_migrations\)/);
  assert.match(r.error, /app-pre-deploy-j-fail\.sql is the protected copy/);
  assert.ok(g3.calls.some((c) => c.phase === 'restart'));
  assert.equal(g3.calls.some((c) => c.phase === 'env_write' || c.phase === 'unit_swap'), false, 'nothing after the failed migration');

  assert.equal(classifyMigrateScript('MIGRATE_SCRIPT:"migrate": "node scripts/migrate.mjs"\nMIGRATIONS_DIR:yes\n').retry, 'resume');
  assert.equal(classifyMigrateScript('MIGRATE_SCRIPT:"migrate": "./my-migrate.sh"\n').retry, 'unknown');
  assert.equal(classifyMigrateScript('', 'npx drizzle-kit migrate').retry, 'resume');
  assert.equal(classifyMigrateScript('', null).retry, 'none');
  const copies = parseProtectedCopies('DBDUMP:none:no pg_dump\nUNITCOPY:none:no unit yet\nENVCOPY:/etc/environment.pre-1\nCOMMIT:abc\n');
  assert.equal(copies.dbDump, null); assert.equal(copies.dbDumpNote, 'none:no pg_dump'); assert.equal(copies.unitCopy, null); assert.equal(copies.envCopy, '/etc/environment.pre-1'); assert.equal(copies.commit, null);
  assert.match(protectedCopiesScript('j1', { withDatabase: false }), /DBDUMP:skipped/);
});

// ── 3. containment of every writer ─────────────────────────────────────

// The real-process regression (a setsid() child that outlives its parent
// and keeps writing; cleanup by cgroup; the application service and the
// current job's holder untouched) lives in setup-deploy-closeout.test.js.

test('containment on the record: a survivor after the reap ends the job as recovery_required with the lease KEPT and flagged, and conflicting operations are refused with that reason', async (t) => {
  const d = db();
  configureContainerLockStore({ getDb: () => d, owner: BACKEND });
  t.after(() => configureContainerLockStore(null));
  const g = guestFor({ survivors: 1 });
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 1 }, { reconcileFirst: false });
  assert.equal(out.ran[0].status, 'recovery_required');
  assert.equal(out.ran[0].outcome, 'previous_writer_alive');
  assert.deepEqual(g.calls.map((c) => c.phase), ['reap', 'reap'], 'two attempts, nothing else touched the guest');
  const lock = readLock(d, 'pp-x');
  assert.equal(lock.owner, RUNNER, 'the lease is kept');
  assert.ok(lock.stale_since, 'and flagged');
  assert.equal(lock.recovery_job_id, sub.job.id);
  assert.match(getJob(d, sub.job.id).reason, /lease is kept and flagged stale/);
  // A restore through the shared lock is refused with the recorded condition (stale after the lease lapses, busy before).
  let ran = false;
  await assert.rejects(withContainerLock('pp-x', 'restore_snapshot', async () => { ran = true; }, { wait: false, job: { kind: 'restore_snapshot' } }), (e) => e.code === 'CONTAINER_BUSY' || e instanceof ContainerLockStaleError);
  assert.equal(ran, false);
  // The next deploy attempt (a later runner) takes the stale lease over and reaps again; still a survivor → the same recorded state, never a silent clear.
  const sub2 = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 120_000 });
  const out2 = await runOnce({ db: d, owner: RUNNER2, exec: g, nowMs: () => T0 + 120_001 }, { reconcileFirst: false });
  assert.equal(out2.ran[0].status, 'recovery_required');
  assert.equal(readLock(d, 'pp-x').owner, RUNNER2);
  assert.ok(readLock(d, 'pp-x').stale_since);
  // Once the survivors are gone, the app deploys again.
  g.calls.length = 0; const g2 = guestFor({ survivors: 0 });
  const sub3 = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 240_000 });
  const out3 = await runOnce({ db: d, owner: RUNNER, exec: g2, reviewLogin: async () => LOGIN, nowMs: () => T0 + 240_001 }, { reconcileFirst: false });
  assert.equal(out3.ran[0].status, 'succeeded');
  assert.equal(readLock(d, 'pp-x'), null);
  assert.ok(sub2.job.id !== sub3.job.id);
});

// ── 4. the executor policy ─────────────────────────────────────────────

test('executorPolicy: explicit values, the safe reading of an unknown value, the documented default', () => {
  assert.deepEqual(executorPolicy({ SETUP_EXECUTOR_POLICY: 'runner-required' }), { mode: 'runner-required', source: 'env' });
  assert.deepEqual(executorPolicy({ SETUP_EXECUTOR_POLICY: 'Backend-Allowed ' }), { mode: 'backend-allowed', source: 'env' });
  assert.equal(executorPolicy({ SETUP_EXECUTOR_POLICY: 'yolo' }).mode, 'runner-required');
  assert.deepEqual(executorPolicy({}), { mode: 'backend-allowed', source: 'default' });
  const example = readFileSync(`${REPO}.env.example`, 'utf8');
  assert.match(example, /^SETUP_EXECUTOR_POLICY=runner-required$/m);
  // install.sh writes the safe default and promotes it to runner-required only
  // on host evidence (the closeout suite ratchets the gate itself).
  assert.match(readFileSync(`${REPO}install.sh`, 'utf8'), /^SETUP_EXECUTOR_POLICY=backend-allowed$/m);
  assert.match(readFileSync(`${REPO}install.sh`, 'utf8'), /sed -i 's\/\^SETUP_EXECUTOR_POLICY=\.\*\/SETUP_EXECUTOR_POLICY=runner-required\/'/);
  assert.match(readFileSync(`${REPO}update.sh`, 'utf8'), /grep -q '\^SETUP_EXECUTOR_POLICY=' "\$env_file"/);
});

test('runner-required: with no runner or a stale heartbeat the deploy is QUEUED and reported unavailable; no guest command runs in the backend; a fresh heartbeat hands it to the runner', async (t) => {
  const d = db();
  const g = guestFor({});
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'runner-required' }, guestExec: g, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  let out = await deployProject({ containerName: 'pp-x', webPort: 3000, requestedBy: 'alice', via: 'ui' });
  assert.equal(out.ok, false);
  assert.equal(out.step, 'runner_unavailable');
  assert.equal(out.queued, true);
  assert.match(out.error, /policy runner-required/);
  assert.equal(getJob(d, out.jobId).status, 'queued');
  assert.equal(g.calls.length, 0, 'nothing ran in the backend');
  // A stale heartbeat is no runner either.
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() - 120_000 });
  out = await deployProject({ containerName: 'pp-x', webPort: 3000, detach: true });
  assert.equal(out.step, 'runner_unavailable');
  assert.equal(out.created, false, 'the same queued job is observed, not duplicated');
  assert.equal(g.calls.length, 0);
  assert.deepEqual((await drainInProcessNow()).ran, []);
  assert.equal((await drainInProcessNow()).skipped, 'none');
  // The runner comes back: the queued job is its to run.
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() });
  assert.equal(executionMode(d, { env: { SETUP_EXECUTOR_POLICY: 'runner-required' } }).executor, 'runner');
  out = await deployProject({ containerName: 'pp-x', webPort: 3000, detach: true });
  assert.equal(out.submitted, true);
  assert.equal(out.executor, 'runner');
  const ran = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => Date.now() }, { reconcileFirst: false });
  assert.equal(ran.ran[0].status, 'succeeded');
  assert.equal(getJob(d, out.jobId).owner, RUNNER);
  // No request parameter enables the backend: the policy is the store's env.
  out = await deployProject({ containerName: 'pp-y', webPort: 3000, detach: true, policy: 'backend-allowed', SETUP_EXECUTOR_POLICY: 'backend-allowed', allowBackend: true });
  assert.equal(out.submitted, true, 'submitted to the (live) runner regardless of the parameters');
});

test('backend-allowed (legacy / development): with no runner the backend runs the SAME executor in-process — deploy, then the follow-up verification — with its own owner, and defers to a live runner', async (t) => {
  const d = db();
  const g = guestFor({ ldaps: 'current' });
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: g, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const steps = [];
  const out = await deployProject({ containerName: 'pp-x', webPort: 3000, requestedBy: 'alice', via: 'ui', guard: GUARD, onStep: (k, l) => steps.push(k) });
  assert.equal(out.ok, true);
  assert.equal(out.step, 'serving');
  const job = getJob(d, out.jobId);
  assert.equal(job.owner, BACKEND);
  assert.equal(job.status, 'succeeded');
  const follow = getJob(d, parseJson(job.progress_json).verification_job_id);
  assert.equal(follow.status, 'succeeded', 'the follow-up verification ran in-process too');
  assert.equal(follow.owner, BACKEND);
  assert.equal(parseJson(getJob(d, out.jobId).verification_json).rungs.credential_use_verified.value, true);
  assert.ok(steps.includes('install') || steps.includes('health'), `step labels replayed: ${steps.join(',')}`);
  assert.equal(readLock(d, 'pp-x'), null);
  noSecretIn(d, [out.jobId, follow.id]);
  // A live runner takes precedence even under backend-allowed.
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() });
  assert.equal((await drainInProcessNow()).skipped, 'runner');
  const det = await deployProject({ containerName: 'pp-x', webPort: 3000, detach: true });
  assert.equal(det.executor, 'runner');
  assert.equal(getJob(d, det.jobId).status, 'queued');
  // And under runner-required the drain never runs, whatever is queued.
  assert.equal((await drainRunnerJobsInProcess(d, { exec: g, env: { SETUP_EXECUTOR_POLICY: 'runner-required' }, nowMs: () => Date.now() + 600_000 })).skipped, 'none');
});

test('index.js drains in-process only under backend-allowed, and the runner is the shared executor', () => {
  const index = readFileSync(`${REPO}admin/backend/src/index.js`, 'utf8');
  assert.match(index, /if \(policy\.mode === 'backend-allowed'\) \{\s*setTimeout\(drain, 15_000\)/);
  assert.match(index, /const policy = executorPolicy\(\);/);
  const runner = readFileSync(`${REPO}cli/src/setup-runner/runner.js`, 'utf8');
  assert.doesNotMatch(runner, /acquireLock|runDeployOperation/, 'the CLI carries no executor of its own');
  const cmd = readFileSync(`${REPO}cli/src/commands/setup-runner.js`, 'utf8');
  assert.match(cmd, /hostReviewLogin\(\{ dbPath: o\.install\.dbPath, envPath: o\.install\.envPath/);
  const login = readFileSync(`${REPO}cli/src/setup-runner/review-login.js`, 'utf8');
  assert.match(login, /readonly: true/);
  assert.match(login, /decryptSecret\(row\.review_login_password_enc\)/);
});
