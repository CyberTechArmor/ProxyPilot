// Setup engine (lib/setup-engine/*, mock2/container-lock.js persistent
// backing): leases that survive a restart, a stale lease that is a RECORDED
// condition rather than a free lock, fencing that stops a stale worker,
// redaction of everything that could be a secret, the verification ladder,
// the boot sweep's reconciliation, and retries that reuse what was generated.
// Driven against a real SQLite database (node:sqlite).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  ownerIdentity, parseOwner, lockVerdict, takeoverVerdict, leaseExpired, redact, redactText, sanitizeReason,
  verificationState, reconcileDecision, recoveryJobFrom, retryPlan, validateRunnerJob, RUNNER_JOB_KINDS,
} from '../lib/setup-engine/logic.js';
import {
  ensureSetupEngineSchema, acquireLock, renewLock, releaseLock, takeoverLock, readLock, listLocks, markLockStale,
  createJob, startJob, claimNextJob, heartbeat, checkpoint, recordGenerated, finishJob, recordJobOutcome, staleRunningJobs,
  listEvents, getJob, jobView, SETUP_ENGINE_SCHEMA,
} from '../lib/setup-engine/store.js';
import { sweepSetupEngineOnBoot, requestAppRecovery, engineOverview, jobDetail } from '../lib/setup-engine/backend.js';
import { withContainerLock, configureContainerLockStore, ContainerBusyError, ContainerLockStaleError, containerLockStoreConfigured } from '../mock2/container-lock.js';

const T0 = Date.parse('2026-09-21T12:00:00.000Z');
const BACKEND_A = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const BACKEND_B = ownerIdentity({ kind: 'backend', host: 'pp', pid: 200, instance: 'bbbb' });
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });

function db() {
  const d = new DatabaseSync(':memory:');
  ensureSetupEngineSchema(d);
  return d;
}

// ── identity + leases ───────────────────────────────────────────────────

test('owner identity round-trips and a fresh instance is a different owner', () => {
  assert.equal(BACKEND_A, 'backend@pp#100:aaaa');
  assert.deepEqual(parseOwner(BACKEND_A), { kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
  assert.notEqual(BACKEND_A, BACKEND_B);
  assert.equal(parseOwner('nonsense'), null);
  assert.throws(() => ownerIdentity({ kind: 'browser' }), /unknown holder kind/);
});

test('lockVerdict: free, reasserted by the same owner, held by a live one, STALE when the lease lapsed — and stale is not free', () => {
  assert.deepEqual(lockVerdict({ lock: null, owner: BACKEND_A, nowMs: T0 }), { ok: true, reason: 'free' });
  const live = { app: 'pp-x', owner: BACKEND_A, operation: 'deploy', acquired_at: 'a', lease_expires_at: new Date(T0 + 10_000).toISOString(), epoch: 1, job_id: 'j1' };
  assert.equal(lockVerdict({ lock: live, owner: BACKEND_A, nowMs: T0 }).reason, 'reasserted');
  const held = lockVerdict({ lock: live, owner: BACKEND_B, nowMs: T0 });
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'held');
  assert.equal(held.holder, BACKEND_A);
  const stale = lockVerdict({ lock: live, owner: BACKEND_B, nowMs: T0 + 11_000 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.jobId, 'j1');
  assert.equal(takeoverVerdict({ lock: live, nowMs: T0 }).ok, false, 'a live lease is never taken over');
  assert.equal(takeoverVerdict({ lock: live, nowMs: T0 + 11_000 }).ok, true);
  assert.equal(leaseExpired({ lease_expires_at: 'garbage' }, T0), true);
});

test('store: acquire, renew, release are fenced by owner and epoch; a stale lease refuses an ordinary acquirer', () => {
  const d = db();
  const a = acquireLock(d, { app: 'pp-x', owner: BACKEND_A, operation: 'deploy', jobId: 'j1', leaseMs: 5000, nowMs: T0 });
  assert.equal(a.ok, true);
  assert.equal(a.lock.epoch, 1);
  assert.equal(acquireLock(d, { app: 'pp-x', owner: BACKEND_B, operation: 'restore_snapshot', nowMs: T0 + 1000 }).reason, 'held');
  assert.equal(renewLock(d, { app: 'pp-x', owner: BACKEND_A, epoch: 1, leaseMs: 5000, nowMs: T0 + 4000 }), 1);
  assert.equal(renewLock(d, { app: 'pp-x', owner: BACKEND_B, epoch: 1, nowMs: T0 + 4000 }), 0, 'another owner cannot renew');
  assert.equal(renewLock(d, { app: 'pp-x', owner: BACKEND_A, epoch: 2, nowMs: T0 + 4000 }), 0, 'a wrong epoch cannot renew');
  // The lease lapses: still not free.
  const stale = acquireLock(d, { app: 'pp-x', owner: BACKEND_B, operation: 'deploy', nowMs: T0 + 60_000 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(readLock(d, 'pp-x').owner, BACKEND_A, 'the row is untouched');
  assert.equal(releaseLock(d, { app: 'pp-x', owner: BACKEND_B, epoch: 1 }), 0, 'someone else cannot release it');
  assert.equal(releaseLock(d, { app: 'pp-x', owner: BACKEND_A, epoch: 1 }), 1);
  assert.equal(readLock(d, 'pp-x'), null);
});

test('store: a takeover bumps the epoch, fences the dead holder, and is recorded on the job', () => {
  const d = db();
  const job = createJob(d, { kind: 'deploy', app: 'pp-x', nowMs: T0 });
  startJob(d, { id: job.id, owner: BACKEND_A, leaseMs: 5000, nowMs: T0 });
  acquireLock(d, { app: 'pp-x', owner: BACKEND_A, operation: 'deploy', jobId: job.id, leaseMs: 5000, nowMs: T0 });
  assert.equal(takeoverLock(d, { app: 'pp-x', by: RUNNER, operation: 'recover_app', jobId: job.id, reason: 'x', nowMs: T0 + 1000 }).ok, false, 'not while live');
  const t = takeoverLock(d, { app: 'pp-x', by: RUNNER, operation: 'recover_app', jobId: job.id, reason: 'backend died with the app stopped', nowMs: T0 + 60_000 });
  assert.equal(t.ok, true);
  assert.equal(t.lock.owner, RUNNER);
  assert.equal(t.lock.epoch, 2);
  assert.equal(t.previous.owner, BACKEND_A);
  // The dead holder's writes now change nothing.
  assert.equal(renewLock(d, { app: 'pp-x', owner: BACKEND_A, epoch: 1, nowMs: T0 + 61_000 }), 0);
  assert.equal(releaseLock(d, { app: 'pp-x', owner: BACKEND_A, epoch: 1 }), 0);
  assert.equal(checkpoint(d, { id: job.id, owner: BACKEND_A, epoch: 1, phase: 'late', nowMs: T0 + 61_000 }), 1, 'the JOB is still the dead holder\'s at epoch 1 until a reconciler records it');
  const ev = listEvents(d, job.id).map((e) => e.kind);
  assert.ok(ev.includes('lock_takeover'));
  assert.equal(JSON.parse(listEvents(d, job.id).find((e) => e.kind === 'lock_takeover').data_json).previous_owner, BACKEND_A);
  assert.equal(takeoverLock(d, { app: 'nope', by: RUNNER, operation: 'x', nowMs: T0 }).reason, 'no_lock');
});

// ── jobs ────────────────────────────────────────────────────────────────

test('store: claimNextJob is compare-and-swap — two claimants, one winner; only listed kinds; the epoch moves', () => {
  const d = db();
  const j = createJob(d, { kind: 'recover_app', app: 'pp-x', plan: { steps: ['start_unit'], params: { container: 'pp-x', webPort: 3000 } }, nowMs: T0 });
  createJob(d, { kind: 'deploy', app: 'pp-y', nowMs: T0 + 1 });
  assert.equal(claimNextJob(d, { owner: RUNNER, kinds: ['verify_app'], nowMs: T0 }), null, 'only the listed kinds are claimed');
  const won = claimNextJob(d, { owner: RUNNER, kinds: [...RUNNER_JOB_KINDS], nowMs: T0 + 2 });
  assert.equal(RUNNER_JOB_KINDS.includes('deploy'), true, 'the deploy is a runner job since the runner-owned deployment slice');
  assert.equal(RUNNER_JOB_KINDS.includes('credential_migration'), false, 'a backend-executed kind is never in the runner list');
  assert.equal(RUNNER_JOB_KINDS.includes('restore_snapshot'), true, 'the snapshot restore is a runner job since A-14');
  assert.equal(getJob(d, d.prepare(`SELECT id FROM setup_jobs WHERE kind = 'deploy'`).get().id).status, 'queued', 'one claim takes one job, in submission order');
  const second = claimNextJob(d, { owner: 'runner@pp#301:ssss', kinds: [...RUNNER_JOB_KINDS], nowMs: T0 + 3 });
  assert.equal(second.kind, 'deploy');
  assert.equal(claimNextJob(d, { owner: 'runner@pp#301:ssss', kinds: [...RUNNER_JOB_KINDS], nowMs: T0 + 4 }), null, 'nothing left to claim');
  assert.equal(heartbeat(d, { id: j.id, owner: RUNNER, epoch: 1, nowMs: T0 + 4 }), 1);
  assert.equal(heartbeat(d, { id: j.id, owner: 'runner@pp#301:ssss', epoch: 1, nowMs: T0 + 4 }), 0);
  assert.equal(claimNextJob(d, { owner: RUNNER, kinds: [] }), null);
});

test('store: checkpoint, generated resources, finish — fenced; a finished job takes no more writes', () => {
  const d = db();
  const j = createJob(d, { kind: 'deploy', app: 'pp-x', nowMs: T0 });
  startJob(d, { id: j.id, owner: BACKEND_A, nowMs: T0 });
  assert.equal(checkpoint(d, { id: j.id, owner: BACKEND_A, epoch: 1, phase: 'stopping_app', checkpoint: { app_stopped: true, container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service' }, message: 'stopping', nowMs: T0 + 1 }), 1);
  assert.equal(checkpoint(d, { id: j.id, owner: BACKEND_B, epoch: 1, phase: 'bogus', nowMs: T0 + 2 }), 0, 'another owner writes nothing');
  assert.equal(recordGenerated(d, { id: j.id, owner: BACKEND_A, epoch: 1, resource: { kind: 'secret', name: 'AUTH_JWT_SECRET', where: '/etc/environment' }, nowMs: T0 + 3 }), 1);
  let row = getJob(d, j.id);
  assert.equal(row.phase, 'stopping_app');
  assert.deepEqual(JSON.parse(row.checkpoint_json), { app_stopped: true, container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service', phase: 'stopping_app' });
  assert.equal(JSON.parse(row.progress_json).generated[0].name, 'AUTH_JWT_SECRET');
  assert.throws(() => finishJob(d, { id: j.id, owner: BACKEND_A, epoch: 1, status: 'running' }), /terminal/);
  assert.equal(finishJob(d, { id: j.id, owner: BACKEND_A, epoch: 1, status: 'succeeded', outcome: 'completed', nowMs: T0 + 4 }), 1);
  assert.equal(finishJob(d, { id: j.id, owner: BACKEND_A, epoch: 1, status: 'failed', nowMs: T0 + 5 }), 0, 'already finished');
  assert.equal(checkpoint(d, { id: j.id, owner: BACKEND_A, epoch: 1, phase: 'late', nowMs: T0 + 6 }), 0);
  row = getJob(d, j.id);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.lease_expires_at, null);
  assert.deepEqual(listEvents(d, j.id).map((e) => e.kind), ['created', 'started', 'checkpoint', 'finished']);
  const view = jobView(row);
  assert.equal(view.checkpoint.app_stopped, true);
  assert.equal('plan_json' in view && view.plan_json !== undefined, false);
});

// ── redaction ───────────────────────────────────────────────────────────

test('redaction: secret-looking keys and values never land in a job row or an event', () => {
  const d = db();
  const plan = {
    steps: ['mint'],
    params: { container: 'pp-x', password: 'hunter2-hunter2', AUTH_MASTER_SECRET: 'abc', secret_names: ['AUTH_JWT_SECRET'], has_password: true, key_path: '/etc/environment', guard: { table: 'auth_connections', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce' } },
    notes: 'DATABASE_URL=postgres://app:s3cr3t@127.0.0.1/app and hash $2a$12$abcdefghijklmnopqrstuuXQ1qYbzE8oJ/4dQpM0R6Vg9Yq1YZg1a and enc:v1:00:11:22 and AUTH_JWT_SECRET=deadbeefdeadbeef',
  };
  const j = createJob(d, { kind: 'deploy', app: 'pp-x', plan, configRefs: { token: 'tok', unit: 'mock2-dev.service' }, nowMs: T0 });
  const raw = `${j.plan_json} ${j.config_refs_json}`;
  for (const leak of ['hunter2', '"abc"', 's3cr3t', '$2a$12$', 'enc:v1:00', 'deadbeefdeadbeef', '"tok"']) assert.equal(raw.includes(leak), false, `leaked ${leak}`);
  const stored = JSON.parse(j.plan_json);
  assert.equal(stored.params.password, '[redacted]');
  assert.equal(stored.params.AUTH_MASTER_SECRET, '[redacted]');
  assert.deepEqual(stored.params.secret_names, ['AUTH_JWT_SECRET'], 'a NAME list is a reference and stays');
  assert.equal(stored.params.has_password, true, 'a presence flag stays');
  assert.equal(stored.params.key_path, '/etc/environment', 'a path stays');
  assert.deepEqual(stored.params.guard, { table: 'auth_connections', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce' }, 'a data guard names columns; it is a reference');
  assert.match(stored.notes, /postgres:\/\/app:\[redacted\]@127\.0\.0\.1\/app/);
  assert.match(stored.notes, /AUTH_JWT_SECRET=\[redacted\]/);
  startJob(d, { id: j.id, owner: BACKEND_A, nowMs: T0 });
  checkpoint(d, { id: j.id, owner: BACKEND_A, epoch: 1, phase: 'x', checkpoint: { api_token: 'zzz', file: '/srv/app/.env' }, message: 'PGPASSWORD=nope AUTH_MASTER_SECRET=verysecretvalue', nowMs: T0 + 1 });
  const ev = listEvents(d, j.id).at(-1);
  assert.equal(ev.data_json.includes('zzz'), false);
  assert.equal(ev.message.includes('verysecretvalue'), false);
  assert.equal(redactText('nothing here'), 'nothing here');
  assert.equal(sanitizeReason('word '.repeat(200)).length, 600);
  assert.equal(sanitizeReason('a'.repeat(700)), '[redacted]', 'a 700-character hex-looking run is treated as key material');
  assert.deepEqual(redact(null), null);
  assert.deepEqual(redact(['x', { nonce: 'n' }]), ['x', { nonce: '[redacted]' }]);
});

// ── verification ladder (R4) ────────────────────────────────────────────

test('verification ladder: states are distinct, a port answering is never "healthy", an unchecked rung caps the state, a failed rung is recovery required', () => {
  assert.equal(verificationState({}).state, 'unconfigured');
  assert.equal(verificationState({ unitConfigured: true }).state, 'configured');
  const port = verificationState({ unitConfigured: true, unitActive: true, portResponding: true });
  assert.equal(port.state, 'port_responding');
  assert.match(port.label, /not verified healthy/);
  assert.match(port.next, /health check/);
  const healthy = verificationState({ unitConfigured: true, unitActive: true, portResponding: true, appHealthy: true });
  assert.equal(healthy.state, 'app_healthy');
  assert.match(healthy.label, /stored credential not checked/);
  const verified = verificationState({ unitConfigured: true, unitActive: true, portResponding: true, appHealthy: true, credentialVerified: true });
  assert.equal(verified.state, 'credential_decryptable', 'the classifier rung is not the application rung');
  const used = verificationState({ unitConfigured: true, unitActive: true, portResponding: true, appHealthy: true, credentialDecryptable: true, credentialUseVerified: true });
  assert.equal(used.state, 'credential_use_verified');
  const notUsed = verificationState({ unitConfigured: true, unitActive: true, portResponding: true, appHealthy: true, credentialDecryptable: true, credentialUseVerified: false });
  assert.equal(notUsed.state, 'recovery_required');
  assert.equal(notUsed.failedAt, 'credential_use_verified');
  assert.match(notUsed.next, /did not load that key/);
  const down = verificationState({ unitConfigured: true, unitActive: false, portResponding: null });
  assert.equal(down.state, 'recovery_required');
  assert.equal(down.failedAt, 'port_responding');
  assert.match(down.next, /journalctl/);
  const badKey = verificationState({ unitConfigured: true, unitActive: true, portResponding: true, appHealthy: true, credentialVerified: false });
  assert.equal(badKey.state, 'recovery_required');
  assert.equal(badKey.failedAt, 'credential_decryptable');
  assert.match(badKey.next, /recovery set/);
  const deferred = verificationState({ unitConfigured: true, unitActive: true, portResponding: true, appHealthy: true, credentialVerified: null, deferredReason: 'no data guard recorded' });
  assert.equal(deferred.state, 'app_healthy');
  assert.match(deferred.next, /credential decryptable was not checked: no data guard recorded/);
});

// ── reconciliation (R2) ─────────────────────────────────────────────────

function deadDeploy(d, { stopped, nowMs = T0 }) {
  const j = createJob(d, { kind: 'deploy', app: 'pp-x', configRefs: { webPort: 4000, unit: 'mock2-dev.service', environmentFile: '/etc/environment', guard: { table: 'auth_connections', schema: 'public' } }, nowMs });
  startJob(d, { id: j.id, owner: BACKEND_A, leaseMs: 5000, nowMs });
  acquireLock(d, { app: 'pp-x', owner: BACKEND_A, operation: 'deploy', jobId: j.id, leaseMs: 5000, nowMs });
  checkpoint(d, { id: j.id, owner: BACKEND_A, epoch: 1, phase: stopped ? 'stopping_app' : 'build_done', checkpoint: { app_stopped: stopped, container: 'pp-x', webPort: 4000, unit: 'mock2-dev.service', disruptive: stopped }, nowMs: nowMs + 1 });
  return j;
}

test('reconcileDecision: live lease → nothing; dead before the stop → record interrupted; dead after the stop → recover (or record recovery required when nothing can act)', () => {
  const d = db();
  const j = deadDeploy(d, { stopped: true });
  assert.equal(reconcileDecision({ job: getJob(d, j.id), nowMs: T0 + 1000 }).action, 'nothing');
  const late = getJob(d, j.id);
  assert.equal(reconcileDecision({ job: late, nowMs: T0 + 60_000 }).action, 'recover');
  assert.equal(reconcileDecision({ job: late, nowMs: T0 + 60_000, canAct: false }).action, 'record_recovery_required');
  const d2 = db();
  const j2 = deadDeploy(d2, { stopped: false });
  const dec = reconcileDecision({ job: getJob(d2, j2.id), lock: readLock(d2, 'pp-x'), nowMs: T0 + 60_000 });
  assert.equal(dec.action, 'record_interrupted');
  assert.equal(dec.releaseLock, true);
  const resumable = { status: 'running', kind: 'recover_app', owner: RUNNER, lease_expires_at: new Date(T0).toISOString(), checkpoint_json: JSON.stringify({ resumable: true, phase: 'probe_port' }) };
  assert.equal(reconcileDecision({ job: resumable, nowMs: T0 + 1 }).action, 'resume');
  assert.equal(reconcileDecision({ job: { ...resumable, status: 'succeeded' }, nowMs: T0 + 1 }).action, 'nothing');
});

test('recoveryJobFrom carries references only, from the checkpoint and the config refs', () => {
  const d = db();
  const j = deadDeploy(d, { stopped: true });
  const spec = recoveryJobFrom(getJob(d, j.id), { nowIso: 'now' });
  assert.equal(spec.kind, 'recover_app');
  assert.equal(spec.app, 'pp-x');
  assert.deepEqual(spec.plan.steps, ['start_unit', 'probe_port', 'health_check', 'verify_credential']);
  assert.equal(spec.plan.params.webPort, 4000);
  assert.equal(spec.plan.params.unit, 'mock2-dev.service');
  assert.deepEqual(spec.plan.params.guard, { table: 'auth_connections', schema: 'public' });
  assert.equal(spec.plan.params.origin.jobId, j.id);
  assert.equal(validateRunnerJob({ kind: spec.kind, app: spec.app, plan: spec.plan }).ok, true);
});

test('boot sweep: the successor records what its predecessor left — interrupted-and-released, or recovery-required with a queued recover_app and a stale, kept lease', () => {
  const d = db();
  const stoppedJob = deadDeploy(d, { stopped: true });
  const d2 = db();
  const cleanJob = deadDeploy(d2, { stopped: false });

  // A live job of the predecessor is NOT touched.
  assert.deepEqual(sweepSetupEngineOnBoot(d, { owner: BACKEND_B, nowMs: T0 + 1000 }), { interrupted: [], recoveryQueued: [], skipped: [] });

  const s = sweepSetupEngineOnBoot(d, { owner: BACKEND_B, nowMs: T0 + 60_000 });
  assert.equal(s.recoveryQueued.length, 1);
  assert.equal(s.recoveryQueued[0].job, stoppedJob.id);
  const rec = getJob(d, s.recoveryQueued[0].recovery);
  assert.equal(rec.kind, 'recover_app');
  assert.equal(rec.status, 'queued');
  assert.equal(rec.via, 'system');
  const dead = getJob(d, stoppedJob.id);
  assert.equal(dead.status, 'recovery_required');
  assert.equal(dead.outcome, 'interrupted_after_stop');
  assert.match(dead.reason, /may still be stopped; recovery job/);
  assert.equal(JSON.parse(dead.verification_json).state, 'recovery_required');
  const lock = readLock(d, 'pp-x');
  assert.equal(lock.owner, BACKEND_A, 'the dead holder\'s lease is KEPT');
  assert.ok(lock.stale_since);
  assert.equal(lock.recovery_job_id, rec.id);
  // A new operation on that app is refused with the recorded condition.
  const refused = acquireLock(d, { app: 'pp-x', owner: BACKEND_B, operation: 'deploy', nowMs: T0 + 61_000 });
  assert.equal(refused.reason, 'stale');
  // Idempotent: a second sweep, or a second boot, queues nothing more.
  assert.deepEqual(sweepSetupEngineOnBoot(d, { owner: BACKEND_B, nowMs: T0 + 62_000 }), { interrupted: [], recoveryQueued: [], skipped: [] });
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM setup_jobs WHERE kind = 'recover_app'`).get().n, 1);

  const s2 = sweepSetupEngineOnBoot(d2, { owner: BACKEND_B, nowMs: T0 + 60_000 });
  assert.deepEqual(s2.interrupted, [cleanJob.id]);
  assert.equal(getJob(d2, cleanJob.id).status, 'failed');
  assert.equal(getJob(d2, cleanJob.id).outcome, 'interrupted');
  assert.equal(readLock(d2, 'pp-x'), null, 'nothing was left changed, so the lease is released');
  assert.equal(acquireLock(d2, { app: 'pp-x', owner: BACKEND_B, operation: 'deploy', nowMs: T0 + 61_000 }).ok, true);

  const over = engineOverview(d, { nowMs: T0 + 63_000 });
  assert.equal(over.locks[0].stale, true);
  assert.deepEqual(over.recoveryRequired, ['pp-x']);
  assert.equal(over.runnerJobsQueued, 1);
  const detail = jobDetail(d, stoppedJob.id);
  assert.ok(detail.events.some((e) => e.kind === 'reconciled'));
  assert.equal(jobDetail(d, 'nope'), null);
});

test('boot sweep never touches a runner\'s jobs or a job whose lease is live', () => {
  const d = db();
  const r = createJob(d, { kind: 'recover_app', app: 'pp-z', nowMs: T0 });
  claimNextJob(d, { owner: RUNNER, kinds: ['recover_app'], leaseMs: 1000, nowMs: T0 });
  const s = sweepSetupEngineOnBoot(d, { owner: BACKEND_B, nowMs: T0 + 60_000 });
  assert.deepEqual(s, { interrupted: [], recoveryQueued: [], skipped: [] });
  assert.equal(getJob(d, r.id).status, 'running', 'a runner\'s dead job is the runner\'s to reconcile');
  assert.equal(staleRunningJobs(d, { nowMs: T0 + 60_000 }).length, 1);
  assert.equal(staleRunningJobs(d, { nowMs: T0 + 60_000, ownerKind: 'backend' }).length, 0);
});

// ── retry reuse + validation ────────────────────────────────────────────

test('retryPlan keeps the approved plan and lists every generated resource for reuse; runner jobs are validated', () => {
  const d = db();
  const j = createJob(d, { kind: 'recover_app', app: 'pp-x', plan: { steps: ['start_unit'], params: { container: 'pp-x', webPort: 3000 } }, nowMs: T0 });
  claimNextJob(d, { owner: RUNNER, kinds: ['recover_app'], nowMs: T0 });
  recordGenerated(d, { id: j.id, owner: RUNNER, epoch: 1, resource: { kind: 'snapshot', name: 'pp-pre-recover-1', where: 'pp-x' } });
  finishJob(d, { id: j.id, owner: RUNNER, epoch: 1, status: 'failed', reason: 'x' });
  const plan = retryPlan(getJob(d, j.id));
  assert.equal(plan.retryOf, j.id);
  assert.deepEqual(plan.steps, ['start_unit']);
  assert.deepEqual(plan.reuse, [{ kind: 'snapshot', name: 'pp-pre-recover-1', where: 'pp-x' }]);
  assert.equal(validateRunnerJob({ kind: 'restore_project_db', app: 'pp-x' }).ok, false, 'the pre-move kind name is history, not a runner job');
  assert.equal(validateRunnerJob({ kind: 'restore_snapshot', app: 'pp-x' }).ok, false, 'a snapshot restore without a snapshot name is invalid');
  assert.equal(validateRunnerJob({ kind: 'deploy', app: 'pp-x', plan: { params: { container: 'pp-x', contract: { hasContract: true, start: 'npm start', install: 'npm ci' } } } }).ok, true);
  assert.equal(validateRunnerJob({ kind: 'deploy', app: 'pp-x', plan: { params: { container: 'pp-x', contract: { hasContract: true, start: 'npm start\nrm -rf /' } } } }).ok, false, 'a contract command is one line');
  assert.equal(validateRunnerJob({ kind: 'deploy', app: 'pp-x', plan: { params: { container: 'pp-x', secrets: { configs: [{ key: 'AUTH_JWT_SECRET', value: 'x' }] } } } }).ok, false, 'a secret config carries no value');
  assert.equal(validateRunnerJob({ kind: 'verify_app', app: 'pp-x', plan: { params: { container: 'pp-x', contract: { start: 'x' } } } }).ok, false, 'only a deploy carries a contract');
  assert.equal(validateRunnerJob({ kind: 'recover_app', app: '../etc' }).ok, false);
  assert.equal(validateRunnerJob({ kind: 'recover_app', app: 'pp-x', plan: { params: { container: 'pp-y' } } }).ok, false);
  assert.equal(validateRunnerJob({ kind: 'recover_app', app: 'pp-x', plan: { params: { command: 'rm -rf /' } } }).ok, false);
  assert.equal(validateRunnerJob({ kind: 'recover_app', app: 'pp-x', plan: { params: { webPort: 70000 } } }).ok, false);
  assert.equal(validateRunnerJob({ kind: 'recover_app', app: 'pp-x', plan: { params: { unit: 'evil; rm' } } }).ok, false);
  assert.equal(validateRunnerJob({ kind: 'recover_app', app: 'pp-x', plan: { params: { password: 'secret-value' } } }).ok, false, 'a plan with a secret value is refused');
  assert.equal(validateRunnerJob({ kind: 'verify_app', app: 'pp-x', plan: { params: { webPort: 3000, unit: 'mock2-dev.service' } } }).ok, true);
});

test('requestAppRecovery does not duplicate an open recovery job, and verify-only is its own kind', () => {
  const d = db();
  const a = requestAppRecovery(d, { app: 'pp-x', requestedBy: 'alice', via: 'ui', webPort: 8080, nowMs: T0 });
  assert.equal(a.created, true);
  assert.equal(a.job.kind, 'recover_app');
  assert.equal(JSON.parse(a.job.plan_json).params.webPort, 8080);
  const b = requestAppRecovery(d, { app: 'pp-x', requestedBy: 'bob', via: 'mcp', nowMs: T0 + 1 });
  assert.equal(b.created, false);
  assert.equal(b.job.id, a.job.id);
  const v = requestAppRecovery(d, { app: 'pp-x', verifyOnly: true, nowMs: T0 + 2 });
  assert.equal(v.created, true);
  assert.equal(v.job.kind, 'verify_app');
});

// ── the container lock with its persistent backing ──────────────────────

function configured(d) {
  configureContainerLockStore({ getDb: () => d, owner: BACKEND_A, leaseMs: 2000, renewMs: 50 });
}

test('withContainerLock (persistent): the lease and the job exist while fn runs, fn gets a checkpoint handle, and both are closed with the outcome', async (t) => {
  const d = db();
  configured(d);
  t.after(() => configureContainerLockStore(null));
  assert.equal(containerLockStoreConfigured(), true);
  let seenJob = null;
  const result = await withContainerLock('pp-x', 'deploy', async (job) => {
    seenJob = job.id;
    assert.equal(job.persistent, true);
    const lock = readLock(d, 'pp-x');
    assert.equal(lock.owner, BACKEND_A);
    assert.equal(lock.operation, 'deploy');
    assert.equal(lock.job_id, job.id);
    assert.equal(getJob(d, job.id).status, 'running');
    assert.equal(job.checkpoint('stopping_app', { app_stopped: true, container: 'pp-x' }, 'stopping'), 1);
    assert.equal(job.generated({ kind: 'secret', name: 'AUTH_JWT_SECRET', where: '/etc/environment' }), 1);
    await new Promise((r) => setTimeout(r, 120)); // past a renewal tick
    assert.ok(Date.parse(readLock(d, 'pp-x').lease_expires_at) > Date.now(), 'renewed while running');
    return { ok: true };
  }, { job: { kind: 'deploy', plan: { steps: ['x'], params: { container: 'pp-x' } }, requestedBy: 'alice', via: 'ui' } });
  assert.deepEqual(result, { ok: true });
  assert.equal(readLock(d, 'pp-x'), null, 'released');
  const row = getJob(d, seenJob);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.requested_by, 'alice');
  assert.equal(row.via, 'ui');
  assert.equal(JSON.parse(row.checkpoint_json).app_stopped, true);
  assert.equal(JSON.parse(row.progress_json).generated.length, 1);
});

test('withContainerLock (persistent): a failed result and a throw are both recorded, sanitized, and the lease released', async (t) => {
  const d = db();
  configured(d);
  t.after(() => configureContainerLockStore(null));
  await withContainerLock('pp-x', 'deploy', async () => ({ ok: false, step: 'start', error: 'could not start; DATABASE_URL=postgres://app:pw123@127.0.0.1/app' }), { job: { kind: 'deploy' } });
  let rows = d.prepare(`SELECT * FROM setup_jobs ORDER BY created_at`).all();
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].outcome, 'failed at start');
  assert.equal(rows[0].reason.includes('pw123'), false);
  assert.match(rows[0].reason, /\[redacted\]@127/);
  await assert.rejects(withContainerLock('pp-x', 'restore_snapshot', async () => { throw new Error('incus exploded'); }, { job: { kind: 'restore_snapshot' } }), /incus exploded/);
  rows = d.prepare(`SELECT * FROM setup_jobs ORDER BY created_at`).all();
  assert.equal(rows[1].status, 'failed');
  assert.equal(rows[1].outcome, 'threw');
  await withContainerLock('pp-x', 'deploy', async () => ({ ok: true, deferred: true, reason: 'master secret deferred: marker missing' }), { job: { kind: 'deploy' } });
  rows = d.prepare(`SELECT * FROM setup_jobs ORDER BY created_at`).all();
  assert.equal(rows[2].status, 'deferred', 'deferral is an explicit outcome, not success');
  assert.equal(readLock(d, 'pp-x'), null);
});

test('withContainerLock (persistent): refused by another live holder (the runner), and refused with the RECORDED condition when a dead holder\'s lease is stale', async (t) => {
  const d = db();
  configured(d);
  t.after(() => configureContainerLockStore(null));
  // The host runner holds pp-x (recovering it).
  acquireLock(d, { app: 'pp-x', owner: RUNNER, operation: 'recover_app', leaseMs: 60_000 });
  let ran = false;
  await assert.rejects(withContainerLock('pp-x', 'restore_snapshot', async () => { ran = true; }, { wait: false, job: { kind: 'restore_snapshot' } }), (e) => e instanceof ContainerBusyError && /recover_app/.test(e.holder));
  assert.equal(ran, false);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM setup_jobs`).get().n, 0, 'no job row for a refused request');
  releaseLock(d, { app: 'pp-x', owner: RUNNER, epoch: 1 });
  // A predecessor backend died holding pp-y.
  acquireLock(d, { app: 'pp-y', owner: BACKEND_B, operation: 'deploy', jobId: 'dead-job', leaseMs: 1000, nowMs: Date.now() - 10_000 });
  await assert.rejects(withContainerLock('pp-y', 'deploy', async () => { ran = true; }, { job: { kind: 'deploy' } }), (e) => e instanceof ContainerLockStaleError && e.code === 'CONTAINER_LOCK_STALE' && e.holder === BACKEND_B && e.jobId === 'dead-job' && /recovery is required/.test(e.message));
  assert.equal(ran, false);
  assert.equal(readLock(d, 'pp-y').owner, BACKEND_B, 'the stale lease was not taken');
});

test('withContainerLock without a configured store behaves as before: in-process only, fn gets a no-op handle', async () => {
  configureContainerLockStore(null);
  const r = await withContainerLock('pp-q', 'deploy', async (job) => { assert.equal(job.persistent, false); assert.equal(job.checkpoint('x', {}), 0); return 'fine'; });
  assert.equal(r, 'fine');
});

test('the migration text is the store\'s schema, registered as 1000 in db.js', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.ok(src.includes("runMigration(db, 1000, 'setup_engine_locks_jobs_events'"));
  assert.ok(src.includes('d.exec(SETUP_ENGINE_SCHEMA)'));
  assert.ok(SETUP_ENGINE_SCHEMA.includes('CREATE TABLE IF NOT EXISTS setup_locks'));
  const deploy = readFileSync(new URL('../lib/setup-engine/deploy-op.js', import.meta.url), 'utf8');
  const stopIdx = deploy.indexOf("mark('stopping_app', { app_stopped: true");
  const stopCall = deploy.indexOf('systemctl stop ${p.unit}');
  assert.ok(stopIdx > 0 && stopCall > stopIdx, 'the checkpoint is written BEFORE the app is stopped');
  assert.ok(deploy.includes("mark('app_started', { app_stopped: false"));
});
