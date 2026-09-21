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
import { ownerIdentity, reconcileDecision, recoveryJobFrom, parseJson } from './logic.js';
import {
  staleRunningJobs, readLock, releaseLock, markLockStale, recordJobOutcome, createJob, openRecoveryJobFor, listLocks, listJobs, getJob, listEvents, jobView,
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
