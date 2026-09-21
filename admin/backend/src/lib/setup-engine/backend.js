// Setup engine — the backend's half: its owner identity, the boot sweep that
// turns a predecessor's dead leases into RECORDED conditions, and the shape
// the API hands out. The host runner (cli/src/setup-runner) does the acting;
// this module never starts a unit or touches a guest.
//
// Boot (docs/core/setup-engine-requirements.md R2): a backend that restarts
// finds every job its predecessor (same kind, same host) was running with an
// expired lease and decides per job:
//   - no disruptive step had begun → the job is recorded as interrupted and
//     its lease released (nothing was left in a changed state);
//   - the app had been stopped → the job is recorded as recovery_required, a
//     recover_app job is queued for the runner, and the lease stays, flagged
//     stale and pointing at that job. Until the runner (or an operator)
//     resolves it, every new operation on that app is refused with the
//     recorded condition, never silently queued behind a dead holder.

import os from 'node:os';
import crypto from 'node:crypto';
import { ownerIdentity, reconcileDecision, recoveryJobFrom, verifyJobFrom, parseJson, runnerIsLive, RUNNER_LIVE_MS, validateRunnerJob, TERMINAL_STATUS, executorPolicy, RUNNER_JOB_KINDS } from './logic.js';
import { runOnce, recordUncertainLifecycle } from './executor.js';
import {
  staleRunningJobs, readLock, releaseLock, markLockStale, recordJobOutcome, createJob, openRecoveryJobFor, listLocks, listJobs, getJob, listEvents, jobView, liveRunners,
} from './store.js';

let identity = null;

export function backendOwner() {
  if (!identity) identity = ownerIdentity({ kind: 'backend', host: os.hostname(), pid: process.pid, instance: crypto.randomUUID().slice(0, 8) });
  return identity;
}

// sweepSetupEngineOnBoot(db, { owner, nowMs }) → summary. Idempotent: a
// second sweep finds nothing running.
export function sweepSetupEngineOnBoot(db, { owner = backendOwner(), nowMs = Date.now() } = {}) {
  const summary = { interrupted: [], recoveryQueued: [], skipped: [] };
  const mine = staleRunningJobs(db, { nowMs, ownerKind: 'backend' });
  for (const job of mine) {
    if (job.owner === owner) continue; // cannot be: fresh identity, but never touch our own
    const lock = readLock(db, job.app);
    const d = reconcileDecision({ job, lock, nowMs, canAct: false });
    if (d.action === 'record_interrupted') {
      recordJobOutcome(db, { id: job.id, status: 'failed', outcome: 'interrupted', reason: `${d.reason}; nothing was left changed`, by: owner, nowMs });
      if (lock && lock.owner === job.owner) releaseLock(db, { app: job.app, owner: lock.owner, epoch: lock.epoch });
      summary.interrupted.push(job.id);
    } else if (d.action === 'record_uncertain') {
      recordUncertainLifecycle(db, { job, lock, owner, reason: d.reason, nowMs });
      summary.interrupted.push(job.id);
    } else if (d.action === 'verify') {
      const spec = verifyJobFrom(job, { nowIso: new Date(nowMs).toISOString() });
      const verify = createJob(db, { kind: spec.kind, app: spec.app, plan: spec.plan, configRefs: { origin: spec.plan.params.origin }, requestedBy: spec.requested_by, via: spec.via, reason: spec.reason, nowMs });
      recordJobOutcome(db, { id: job.id, status: 'failed', outcome: 'interrupted_unverified', reason: `${d.reason}; verification job ${verify.id} queued; the recovery references are kept on this record`, by: owner, nowMs });
      if (lock && lock.owner === job.owner) releaseLock(db, { app: job.app, owner: lock.owner, epoch: lock.epoch });
      summary.interrupted.push(job.id);
      summary.recoveryQueued.push({ job: job.id, recovery: verify.id, app: job.app, kind: 'verify_app' });
    } else if (d.action === 'record_recovery_required' || d.action === 'recover') {
      const cp = parseJson(job.checkpoint_json) || {};
      let recovery = openRecoveryJobFor(db, job.app);
      if (!recovery) {
        const spec = recoveryJobFrom(job, { nowIso: new Date(nowMs).toISOString() });
        recovery = createJob(db, { kind: spec.kind, app: spec.app, plan: spec.plan, configRefs: { origin: spec.plan.params.origin }, requestedBy: spec.requested_by, via: spec.via, reason: spec.reason, nowMs });
      }
      recordJobOutcome(db, {
        id: job.id, status: 'recovery_required', outcome: 'interrupted_after_stop',
        reason: `${d.reason}; the application '${cp.container || job.app}' may still be stopped; recovery job ${recovery.id} queued for the host runner`,
        verification: { state: 'recovery_required', failedAt: 'port_responding', note: 'not verified: the backend restarted while the application was stopped' },
        by: owner, nowMs,
      });
      if (lock && lock.owner === job.owner) markLockStale(db, { app: job.app, nowMs, recoveryJobId: recovery.id });
      summary.recoveryQueued.push({ job: job.id, recovery: recovery.id, app: job.app });
    } else {
      summary.skipped.push({ job: job.id, reason: d.reason });
    }
  }
  return summary;
}

// requestAppRecovery(db, { app, requestedBy, via, webPort, unit }) → the job
// row (an existing open one is returned rather than duplicated). What a
// dashboard, the CLI or MCP call to ask the runner to recover and verify.
export function requestAppRecovery(db, { app, requestedBy = null, via = 'ui', webPort = null, unit = 'mock2-dev.service', guard = null, verifyOnly = false, nowMs = Date.now() }) {
  const existing = openRecoveryJobFor(db, app);
  if (existing && !verifyOnly) return { job: existing, created: false };
  const kind = verifyOnly ? 'verify_app' : 'recover_app';
  const params = { container: String(app), webPort: Number(webPort) || 3000, unit, guard: guard || null, environmentFile: '/etc/environment' };
  const job = createJob(db, {
    kind, app, plan: { steps: verifyOnly ? ['probe_port', 'health_check', 'verify_credential'] : ['start_unit', 'probe_port', 'health_check', 'verify_credential'], params },
    requestedBy, via, nowMs,
  });
  return { job, created: true };
}

// The API shapes.
export function engineOverview(db, { nowMs = Date.now() } = {}) {
  const locks = listLocks(db).map((l) => ({ ...l, stale: !l.lease_expires_at || Date.parse(l.lease_expires_at) <= nowMs }));
  const jobs = listJobs(db, { limit: 100 }).map(jobView);
  return { locks, jobs, runnerJobsQueued: jobs.filter((j) => j.status === 'queued').length, recoveryRequired: jobs.filter((j) => j.status === 'recovery_required').map((j) => j.app) };
}

export function jobDetail(db, id) {
  const row = getJob(db, id);
  if (!row) return null;
  return { job: jobView(row), events: listEvents(db, id).map((e) => ({ ...e, data: parseJson(e.data_json), data_json: undefined })) };
}

// ── who executes a deploy ───────────────────────────────────────────────

// runnerAvailable(db, { nowMs }) → the live runner row, or null. A deploy is
// submitted to the runner only while one has a fresh heartbeat; otherwise the
// backend executes the same operation itself (the in-process executor).
export function runnerAvailable(db, { nowMs = Date.now() } = {}) {
  const rows = liveRunners(db, { nowMs, maxAgeMs: RUNNER_LIVE_MS });
  return rows.find((r) => runnerIsLive(r, nowMs)) || null;
}

// submitDeployJob(db, { app, params, requestedBy, via }) → the queued job.
// Refused (returned as { error }) when the plan does not validate, or when an
// open deploy for the same app is already queued or running — a repeated
// submission observes that job instead of duplicating work.
export function submitDeployJob(db, { app, params, requestedBy = null, via = 'system', nowMs = Date.now() }) {
  const open = db.prepare(`SELECT * FROM setup_jobs WHERE app = ? AND kind = 'deploy' AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(String(app));
  if (open) return { job: open, created: false };
  const spec = { kind: 'deploy', app, plan: { steps: ['install', 'migrate', 'build', 'stop', 'mint', 'unit', 'start', 'health', 'verify'], params } };
  const v = validateRunnerJob(spec);
  if (!v.ok) return { error: v.reason };
  const job = createJob(db, { kind: 'deploy', app, plan: spec.plan, configRefs: { webPort: params.webPort, unit: 'mock2-dev.service', environmentFile: params.environmentFile || '/etc/environment', appDir: params.appDir || '/srv/app', guard: params.guard || null }, requestedBy, via, nowMs });
  // A verification still queued for an OLDER deploy of this app is left in
  // the queue: it is an obligation. When it runs it reads what the guest
  // runs and records `superseded` if this deploy changed it — and still
  // verifies the older revision if this deploy failed before changing
  // anything (executor, verify_credential_use).
  return { job, created: true };
}

// waitForJob(db, id, { pollMs, timeoutMs, onEvent, sleep }) → the terminal row,
// or null on timeout. Replays events to onEvent as they appear (the callers'
// onStep labels come from the executor's step events).
export async function waitForJob(db, id, { pollMs = 1000, timeoutMs = 45 * 60 * 1000, onEvent = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), nowMs = () => Date.now() } = {}) {
  const start = nowMs();
  let lastEvent = 0;
  for (;;) {
    const row = getJob(db, id);
    if (!row) return null;
    if (onEvent) {
      for (const e of db.prepare(`SELECT * FROM setup_job_events WHERE job_id = ? AND id > ? ORDER BY id`).all(String(id), lastEvent)) {
        lastEvent = e.id;
        try { onEvent(e); } catch { /* */ }
      }
    }
    if (TERMINAL_STATUS.includes(row.status)) return row;
    if (nowMs() - start > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// deployResultFromJob(row) → the { ok, step, error, skipped, … } shape every
// deploy caller has always consumed, from the persisted outcome.
export function deployResultFromJob(row) {
  if (!row) return { ok: false, step: 'submit', error: 'the deploy job disappeared' };
  const progress = parseJson(row.progress_json) || {};
  const result = progress.result || null;
  if (result && typeof result === 'object') return { ...result, jobId: row.id, status: row.status };
  if (row.status === 'succeeded') return { ok: true, step: 'serving', jobId: row.id, status: row.status };
  if (row.status === 'cancelled') return { ok: false, step: 'cancelled', error: row.reason || 'cancelled', jobId: row.id, status: row.status };
  return { ok: false, step: progress.failed_step || row.phase || 'deploy', error: row.reason || `deploy ${row.status}`, jobId: row.id, status: row.status };
}

// ── who executes: the installation policy, never a request parameter ────

// executionMode(db, { env, nowMs }) → { policy, runner, executor }:
//   executor 'runner'   a live runner will execute (either policy)
//   executor 'backend'  backend-allowed and no live runner: this process
//                       executes with the same code (legacy / development)
//   executor 'none'     runner-required and no live runner: submissions are
//                       queued and reported unavailable; nothing runs here
export function executionMode(db, { env = process.env, nowMs = Date.now() } = {}) {
  const policy = executorPolicy(env);
  const runner = runnerAvailable(db, { nowMs });
  if (runner) return { policy, runner, executor: 'runner' };
  if (policy.mode === 'backend-allowed') return { policy, runner: null, executor: 'backend' };
  return { policy, runner: null, executor: 'none' };
}

// drainRunnerJobsInProcess(db, { owner, exec, reviewLogin, max, nowMs, env })
// — the legacy / development executor: claim and execute queued runner jobs
// in this backend process with the shared executor. Refuses (returns
// { skipped }) unless the policy allows it AND no runner is live; the runner
// is preferred whenever it exists. Heartbeats are not written (a backend is
// not a runner).
export async function drainRunnerJobsInProcess(db, { owner = backendOwner(), exec, reviewLogin = null, max = 5, nowMs = () => Date.now(), env = process.env, log = () => {}, kinds = [...RUNNER_JOB_KINDS] } = {}) {
  const mode = executionMode(db, { env, nowMs: nowMs() });
  if (mode.executor !== 'backend') return { skipped: mode.executor, policy: mode.policy.mode, ran: [] };
  if (!exec) return { skipped: 'no_exec', policy: mode.policy.mode, ran: [] };
  return runOnce({ db, owner, exec, reviewLogin, nowMs, log, heartbeat: false }, { max, reconcileFirst: false, kinds });
}
