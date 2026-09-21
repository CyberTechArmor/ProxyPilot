// Setup engine — the BACKEND-executed steps (A-17.7): job kinds the backend
// runs itself, whatever the executor policy, because they are ProxyPilot's
// own work and not a host privilege: today `configure_routes` — the route
// rows and the Caddy render for the services a guest was created with (the
// Caddy pivot itself is A-17.12's). One record, the same lease rules:
//
//   * queued as a durable follow-up by the guest_setup job (before that job
//     reports done), so a closed browser or a restarted API loses nothing —
//     the boot drain and the periodic drain pick it up;
//   * runs under the guest's lease (a lifecycle verb meanwhile is refused
//     busy) and the host-wide `@host/routes` lease (two guests' route writes
//     and renders never interleave); a held lease REQUEUES it with a
//     not-before, an unresolved hold waits longer — it is an obligation,
//     never finished deferred;
//   * idempotent through lib/guest-routes.js: a retry re-renders what it
//     created and never duplicates a row;
//   * its outcome lands on the guest_setup record's `routes` phase (and the
//     event stream of that job), so the one setup record shows every phase.

import {
  claimNextJob, acquireLock, takeoverLock, releaseLock, readLock, requeueJob, checkpoint, recordProgress, finishJob, appendEvent, getJob, annotateJobProgress, fenceJob,
} from './store.js';
import { validateRoutesParams, HOST_ROUTES_LOCK, BACKEND_STEP_KINDS } from './setup-logic.js';
import { parseJson, sanitizeReason, leaseHold, FencedError, CancelledError } from './logic.js';

export { BACKEND_STEP_KINDS };
const LEASE_MS = 30_000;
const RETRY_MS = 30_000;
const HOLD_RETRY_MS = 5 * 60_000;
const ROUTES_LEASE_WAIT_MS = 15_000;

// runBackendSteps({ db, owner, deps: { configureRoutes }, nowMs, log, max, sleep }) → { ran: [...] }
export async function runBackendSteps({ db, owner, deps, nowMs = () => Date.now(), log = () => {}, max = 5, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const out = { ran: [] };
  for (let i = 0; i < max; i += 1) {
    const job = claimNextJob(db, { owner, kinds: [...BACKEND_STEP_KINDS], leaseMs: LEASE_MS, nowMs: nowMs() });
    if (!job) break;
    log('claimed', job.id, job.kind, job.app);
    const r = await executeBackendStep(job, { db, owner, deps, nowMs, log, sleep });
    out.ran.push({ id: job.id, kind: job.kind, app: job.app, ...r });
    log('finished', job.id, r.status, r.outcome);
  }
  return out;
}

export async function executeBackendStep(job, { db, owner, deps = {}, nowMs = () => Date.now(), log = () => {}, sleep }) {
  const epoch = Number(job.epoch);
  const fin = (status, outcome, reason, verification = null) => { finishJob(db, { id: job.id, owner, epoch, status, outcome, reason, verification, nowMs: nowMs() }); return { status, outcome }; };
  const event = (kind, message, data = null, phase = null) => appendEvent(db, { jobId: job.id, kind, phase, message, data, nowMs: nowMs() });
  if (job.kind !== 'configure_routes') return fin('refused', 'invalid', `${job.kind} is not a backend step`);
  const p = (parseJson(job.plan_json) || {}).params || {};
  const v = validateRoutesParams(p);
  if (!v.ok) return fin('refused', 'invalid', v.reason);
  const origin = p.origin || {};
  const noteOrigin = (state, extra = {}) => {
    if (!origin.jobId || !getJob(db, origin.jobId)) return;
    const prior = (parseJson(getJob(db, origin.jobId).progress_json) || {}).phases || {};
    annotateJobProgress(db, { id: origin.jobId, progress: { phases: { ...prior, routes: { ...(prior.routes || {}), state, job: job.id, ...extra } }, routes_job_id: job.id }, nowMs: nowMs() });
    appendEvent(db, { jobId: origin.jobId, kind: 'recovery_result', phase: 'routes', message: `configure_routes job ${job.id}: ${state}${extra.detail ? ` — ${extra.detail}` : ''}`, data: { follow_up_job: job.id, state }, nowMs: nowMs() });
  };
  const requeue = (why, ms) => { requeueJob(db, { id: job.id, by: owner, reason: why, notBeforeMs: nowMs() + ms, nowMs: nowMs() }); return { status: 'requeued', outcome: 'lock_held' }; };

  // The guest's lease.
  const got = acquireLock(db, { app: job.app, owner, operation: job.kind, jobId: job.id, leaseMs: LEASE_MS, nowMs: nowMs() });
  let lockEpoch;
  if (got.ok) lockEpoch = Number(got.lock.epoch);
  else if (got.reason === 'stale') {
    const stale = readLock(db, job.app);
    const hold = leaseHold({ lock: stale, recordingJob: stale?.recovery_job_id ? getJob(db, stale.recovery_job_id) : null });
    if (hold.hold) { event('hold', hold.reason, { recording_job: stale.recovery_job_id }, 'lock'); return requeue(`${hold.reason}; this follow-up waits`, HOLD_RETRY_MS); }
    const t = takeoverLock(db, { app: job.app, by: owner, operation: job.kind, jobId: job.id, reason: `taking over ${got.operation} lease of ${got.holder} (expired ${got.expiredAt}) to configure routes`, leaseMs: LEASE_MS, nowMs: nowMs() });
    if (!t.ok) return requeue(`the guest's lease is held by ${t.holder}; this follow-up waits and retries`, RETRY_MS);
    lockEpoch = Number(t.lock.epoch);
  } else return requeue(`the guest's lease is held by ${got.holder} (${got.operation}); this follow-up waits and retries`, RETRY_MS);

  let routesHeld = false; let routesEpoch = null;
  try {
    // The shared route store: one writer at a time across every guest.
    const started = nowMs();
    for (;;) {
      const r = acquireLock(db, { app: HOST_ROUTES_LOCK, owner, operation: 'configure_routes', jobId: job.id, leaseMs: LEASE_MS, nowMs: nowMs() });
      if (r.ok) { routesHeld = true; routesEpoch = Number(r.lock.epoch); break; }
      if (r.reason === 'stale') { const t = takeoverLock(db, { app: HOST_ROUTES_LOCK, by: owner, operation: 'configure_routes', jobId: job.id, reason: `taking over the dead holder ${r.holder}'s routes lease`, leaseMs: LEASE_MS, nowMs: nowMs() }); if (t.ok) { routesHeld = true; routesEpoch = Number(t.lock.epoch); break; } }
      if (nowMs() - started >= ROUTES_LEASE_WAIT_MS) return requeue(`the route store is being written by ${r.holder || 'another job'}; this follow-up waits and retries`, RETRY_MS);
      await sleep(500);
    }
    fenceJob(db, { id: job.id, owner, epoch, safe: true, leaseMs: LEASE_MS, nowMs: nowMs() });
    const ck = checkpoint(db, { id: job.id, owner, epoch, phase: 'routes', checkpoint: { resumable: false, disruptive: false, routes: true, container: p.container, domains: p.services.map((s) => s.domain) }, message: `configuring ${p.services.length} route(s) for ${p.container} → ${p.ip}`, nowMs: nowMs() });
    if (!(Number(ck) > 0)) throw new FencedError(job.id);
    if (typeof deps.configureRoutes !== 'function') { noteOrigin('failed', { detail: 'no route configurator is available in this process' }); return fin('failed', 'error', 'no route configurator is available in this process; retry the job'); }
    const res = await deps.configureRoutes({ container: p.container, name: p.serviceName, ip: p.ip, services: p.services });
    const pub = { created: res.created || [], existing: res.existing || [], conflicts: res.conflicts || [], rendered: res.rendered || [], renderWarning: res.renderWarning || null, upstreamWarning: res.upstreamWarning || null, ip: p.ip };
    recordProgress(db, { id: job.id, owner, epoch, progress: { result: pub }, nowMs: nowMs() });
    const summary = `${p.container}: ${pub.created.length} route(s) created, ${pub.existing.length} already present, ${pub.conflicts.length} conflict(s)${pub.conflicts.length ? ` (${pub.conflicts.map((c) => c.domain).join(', ')})` : ''}; ${pub.renderWarning ? pub.renderWarning : `${pub.rendered.length} rendered`}${pub.upstreamWarning ? `; ${pub.upstreamWarning}` : ''}`;
    if (pub.renderWarning) {
      noteOrigin('failed', { detail: pub.renderWarning, created: pub.created, existing: pub.existing, conflicts: pub.conflicts });
      const r = fin('failed', 'routes_recorded_render_failed', summary, { state: 'not_applicable', label: summary, failedAt: 'routes', next: 'the rows are recorded; retry the job to render them, or fix Caddy first' });
      return { ...r, result: pub };
    }
    noteOrigin('done', { created: pub.created, existing: pub.existing, conflicts: pub.conflicts, rendered: pub.rendered, ...(pub.upstreamWarning ? { detail: pub.upstreamWarning } : {}) });
    const r = fin('succeeded', 'routes_configured', summary, { state: 'not_applicable', label: summary, failedAt: null, next: null });
    return { ...r, result: pub };
  } catch (e) {
    if (e instanceof FencedError || e?.code === 'FENCED') { log('fenced', job.id); return { status: 'fenced', outcome: null }; }
    if (e instanceof CancelledError || e?.code === 'CANCELLED') { noteOrigin('skipped', { detail: 'cancelled' }); return fin('cancelled', 'cancelled', e.message); }
    noteOrigin('failed', { detail: sanitizeReason(e?.message || String(e), 300) });
    return fin('failed', 'error', sanitizeReason(e?.message || String(e)));
  } finally {
    if (routesHeld) releaseLock(db, { app: HOST_ROUTES_LOCK, owner, epoch: routesEpoch });
    releaseLock(db, { app: job.app, owner, epoch: lockEpoch });
  }
}
