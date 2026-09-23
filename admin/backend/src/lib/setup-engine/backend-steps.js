import { readVaultwarden } from './vaultwarden-store.js';
import { VAULTWARDEN_APP, jobSchema as vaultwardenJobSchema } from './vaultwarden-logic.js';
import { readOpenBao } from './openbao-store.js';
import { OPENBAO_APP,jobSchema as openbaoJobSchema } from './openbao-logic.js';
import { readInfisical } from './infisical-store.js';
import { INFISICAL_APP,infisicalJobSchema } from './infisical-logic.js';
import { readPomerium } from './pomerium-store.js';
import { POMERIUM_APP } from './pomerium-logic.js';
import { assertCurrent, SSO_APP } from '../sso/store.js';
import { readKeycloak } from './keycloak-store.js';
import { keycloakRouteParams } from './keycloak-routes.js';
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
  claimNextJob, acquireLock, takeoverLock, releaseLock, readLock, requeueJob, checkpoint, recordProgress, finishJob, appendEvent, getJob, annotateJobProgress, annotateTerminalOutcome, fenceJob, renewLock, heartbeat,
} from './store.js';
import { validateRoutesParams, HOST_ROUTES_LOCK, BACKEND_STEP_KINDS, setupOutcome, phaseSummary } from './setup-logic.js';
import { parseJson, sanitizeReason, leaseHold, FencedError, CancelledError } from './logic.js';

export { BACKEND_STEP_KINDS };

// Thrown by the fence configureGuestRoutes calls before every write when a
// lease this step holds (the guest's, the route store's) is no longer its
// own at its epoch: nothing further is written.
export class LeaseLostError extends Error {
  constructor(name) { super(`the ${name} lease is no longer this job's; no further route write is issued`); this.name = 'LeaseLostError'; this.code = 'LEASE_LOST'; this.lease = name; }
}

// settleSetupRecord(db, { setupJobId, createJobId, phase, update, event })
// — a follow-up's outcome landing on the setup record it was delegated
// from: the phase is rewritten, the AGGREGATE completion recomputed
// (setupOutcome) and recorded as the setup job's `progress.completion` and
// — the job being terminal — its outcome (`setup_complete` /
// `setup_partial`, from `setup_pending`), then mirrored onto the lifecycle
// job the setup followed. Execution status stays what it was; the
// completion contract is one function for every surface.
export function settleSetupRecord(db, { setupJobId, createJobId = null, phase, update, event, nowMs = Date.now() }) {
  const setup = getJob(db, setupJobId);
  if (!setup) return null;
  const prog = parseJson(setup.progress_json) || {};
  const phases = { ...(prog.phases || {}), [phase]: { ...((prog.phases || {})[phase] || {}), ...update } };
  const verdict = setupOutcome(phases);
  annotateJobProgress(db, { id: setupJobId, progress: { phases, completion: verdict.completion }, nowMs });
  if (['succeeded', 'failed'].includes(setup.status) && setup.outcome !== verdict.outcome && verdict.completion !== 'uncertain') {
    annotateTerminalOutcome(db, { id: setupJobId, fromStatus: setup.status, outcome: verdict.outcome, reason: `${setup.app}: ${phaseSummary(phases)}; completion ${verdict.completion}`, nowMs });
  }
  appendEvent(db, { jobId: setupJobId, kind: 'recovery_result', phase, message: `${event}; completion ${verdict.completion}`, data: { phase, state: update.state, completion: verdict.completion, follow_up_job: update.job || null }, nowMs });
  const originId = createJobId || ((parseJson(setup.plan_json) || {}).params || {}).origin?.jobId || null;
  if (originId && getJob(db, originId)) {
    const o = parseJson(getJob(db, originId).progress_json) || {};
    annotateJobProgress(db, { id: originId, progress: { setup: { ...(o.setup || {}), job: setupJobId, outcome: verdict.outcome, completion: verdict.completion, phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v.state])) } }, nowMs });
    appendEvent(db, { jobId: originId, kind: 'recovery_result', phase: 'setup', message: `guest_setup job ${setupJobId}: ${phase} ${update.state} — completion ${verdict.completion}`, data: { follow_up_job: setupJobId, state: verdict.completion }, nowMs });
  }
  return verdict;
}
const LEASE_MS = 30_000;
const KEEPALIVE_MS = 10_000;
// What renewAll reports when the job claim itself is no longer this step's.
const JOB_CLAIM = Symbol('job claim');
const RETRY_MS = 30_000;
const HOLD_RETRY_MS = 5 * 60_000;
const ROUTES_LEASE_WAIT_MS = 15_000;

// runBackendSteps({ db, owner, deps: { configureRoutes }, nowMs, log, max, sleep }) → { ran: [...] }
export async function runBackendSteps({ db, owner, deps, nowMs = () => Date.now(), log = () => {}, max = 5, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), keepAliveMs = KEEPALIVE_MS }) {
  const out = { ran: [] };
  for (let i = 0; i < max; i += 1) {
    const job = claimNextJob(db, { owner, kinds: [...BACKEND_STEP_KINDS], leaseMs: LEASE_MS, nowMs: nowMs() });
    if (!job) break;
    log('claimed', job.id, job.kind, job.app);
    const r = await executeBackendStep(job, { db, owner, deps, nowMs, log, sleep, keepAliveMs });
    out.ran.push({ id: job.id, kind: job.kind, app: job.app, ...r });
    log('finished', job.id, r.status, r.outcome);
  }
  return out;
}

export async function executeBackendStep(job, { db, owner, deps = {}, nowMs = () => Date.now(), log = () => {}, sleep, keepAliveMs = KEEPALIVE_MS }) {
  const epoch = Number(job.epoch);
  const fin = (status, outcome, reason, verification = null) => { finishJob(db, { id: job.id, owner, epoch, status, outcome, reason, verification, nowMs: nowMs() }); return { status, outcome }; };
  const event = (kind, message, data = null, phase = null) => appendEvent(db, { jobId: job.id, kind, phase, message, data, nowMs: nowMs() });
  if (!BACKEND_STEP_KINDS.includes(job.kind)) return fin('refused', 'invalid', `${job.kind} is not a backend step`);
  let p = (parseJson(job.plan_json) || {}).params || {};
  const isVaultwarden = job.kind === 'configure_vaultwarden_route';
  if(isVaultwarden){const r=readVaultwarden(db);if(!vaultwardenJobSchema.safeParse(p).success||!r||r.revision!==p.revision||r.edge_job_id!==job.id||!['queued','running'].includes(getJob(db,r.last_job_id)?.status))return fin('refused','invalid','Superseded Vaultwarden route intent.');p={...p,container:VAULTWARDEN_APP,services:[],ip:'127.0.0.1'};}
  const isOpenBao = job.kind === 'configure_openbao_route';
  if(isOpenBao){const r=readOpenBao(db);if(!openbaoJobSchema.safeParse(p).success||!r||r.revision!==p.revision||r.edge_job_id!==job.id||!['queued','running'].includes(getJob(db,r.last_job_id)?.status))return fin('refused','invalid','Superseded OpenBao route intent.');p={...p,container:OPENBAO_APP,services:[],ip:'127.0.0.1'};}
  const isInfisical = job.kind === 'configure_infisical_route';
  if(isInfisical) { const r=readInfisical(db);
    if(!infisicalJobSchema.safeParse(p).success || !r || r.revision!==p.revision || r.edge_job_id!==job.id || !['queued','running'].includes(getJob(db,r.last_job_id)?.status)) return fin('refused','invalid','Superseded Infisical route intent.');
    p={...p,container:INFISICAL_APP,services:[],ip:'127.0.0.1'};
  }
  const isPomerium = job.kind === 'configure_pomerium_routes';
  if(isPomerium) { try {
    const r=readPomerium(db);
    if(!r || r.revision!==p.revision || r.edge_job_id!==job.id || !['queued','running'].includes(getJob(db,r.last_job_id)?.status) || Object.keys(p).length!==2 || !['deny','gateway'].includes(p.stage)) throw new Error('Superseded');
    p={...p,container:POMERIUM_APP,services:[],ip:'127.0.0.1'};
  } catch {return fin('refused','invalid','Invalid or superseded Pomerium route intent.');} }
  const isReset = job.kind === 'remove_platform_routes';
  if (isReset) { try {
    // Read directly: importing full-platform-store here would pull the platform
    // plan (and its route/mock2 modules) into every backend step's load order.
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='setup_full_platform'").get() && db.prepare('SELECT last_job_id, state_json FROM setup_full_platform WHERE id=1').get();
    const full = row ? { last_job_id: row.last_job_id, state: parseJson(row.state_json) || {} } : null;
    if (Object.keys(p).length !== 1 || typeof p.resetJob !== 'string' || job.app !== 'pp-platform-reset-routes' || full?.last_job_id !== p.resetJob || full.state?.reset?.routesJob !== job.id || !['queued', 'running'].includes(getJob(db, p.resetJob)?.status)) throw new Error('Superseded');
    p = { ...p, container: 'pp-platform-reset-routes', services: [], ip: '127.0.0.1' };
  } catch { return fin('refused', 'invalid', 'Invalid or superseded Full Platform reset route step.'); } }
  const isKeycloak = job.kind === 'configure_keycloak_route';
  const isSso = ['verify_sso','configure_recovery_route'].includes(job.kind);
  if (isSso) { try {
    const r = assertCurrent(db, p.fingerprint);
    if (Object.keys(p).length !== 1 || job.app !== SSO_APP || r[job.kind === 'verify_sso' ? 'job_id' : 'route_job_id'] !== job.id) throw new Error('Superseded');
    p = { ...p, container: SSO_APP, services: [], ip: '127.0.0.1' };
  } catch { return fin('refused','invalid','Invalid or superseded SSO configuration reference.'); } }
  if (isKeycloak) { try {
    const installation = readKeycloak(db, p.installationId);
    if (installation?.route_job_id !== job.id || !['queued', 'running'].includes(getJob(db, installation.last_job_id)?.status)) throw new Error('Superseded or cancelled');
    p = keycloakRouteParams(db, p);
  } catch { return fin('refused', 'invalid', 'Invalid, cancelled or superseded Keycloak route reference.'); } }
  const v = (isReset || isKeycloak || isSso || isPomerium || isInfisical || isOpenBao || isVaultwarden) ? { ok: job.app === p.container, reason: 'Keycloak route app mismatch' } : validateRoutesParams(p);
  if (!v.ok) return fin('refused', 'invalid', v.reason);
  const origin = p.origin || {};
  const noteOrigin = (state, extra = {}) => {
    if (!origin.jobId || !getJob(db, origin.jobId)) return;
    annotateJobProgress(db, { id: origin.jobId, progress: { routes_job_id: job.id }, nowMs: nowMs() });
    settleSetupRecord(db, { setupJobId: origin.jobId, createJobId: origin.createJobId || null, phase: 'routes', update: { state, job: job.id, ...extra }, event: `configure_routes job ${job.id}: ${state}${extra.detail ? ` — ${extra.detail}` : ''}`, nowMs: nowMs() });
  };
  const requeue = (why, ms) => { requeueJob(db, { id: job.id, by: owner, reason: why, notBeforeMs: nowMs() + ms, nowMs: nowMs() }); return { status: 'requeued', outcome: 'lock_held' }; };

  // The guest's lease — an unresolved hold first, whoever the lease names
  // (the backend's own in-process setup may have recorded it).
  {
    const existing = readLock(db, job.app);
    if (existing && existing.stale_since && existing.recovery_job_id) {
      const hold = leaseHold({ lock: existing, recordingJob: getJob(db, existing.recovery_job_id) });
      if (hold.hold) { event('hold', hold.reason, { recording_job: existing.recovery_job_id }, 'lock'); return requeue(`${hold.reason}; this follow-up waits`, HOLD_RETRY_MS); }
    }
  }
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

  let routesHeld = false; let routesEpoch = null; let keepAlive = null; let lost = null;
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
    if (typeof (isReset ? deps.platformResetRoutesStep : isVaultwarden ? deps.vaultwardenStep : isOpenBao ? deps.openbaoStep : isInfisical ? deps.infisicalStep : isPomerium ? deps.pomeriumStep : isSso ? deps.ssoStep : isKeycloak ? deps.configureKeycloakRoute : deps.configureRoutes) !== 'function') { noteOrigin('failed', { detail: 'no route configurator is available in this process' }); return fin('failed', 'error', 'no route configurator is available in this process; retry the job'); }
    // Before every write the configurator makes, THREE leases are renewed at
    // the epochs this step holds them — the job claim itself (`setup_jobs`,
    // the store's fenced heartbeat: owner + epoch + still running), the
    // guest's lock and the shared routes lock; a renewal that changes no row
    // means another owner has it, or the job was ended or re-claimed, and
    // nothing further is written. Between writes — a `caddy adapt` or reload
    // that runs long — a keep-alive renews all three every KEEPALIVE_MS, so a
    // legitimately long operation never lets the claim lapse for the runner's
    // reconcile to record it interrupted under live locks, and never lets a
    // lock lapse either; a keep-alive renewal that changes no row is
    // remembered and the next fence throws before anything else is written.
    // The claim is renewed FIRST: a claim that is no longer this step's (a
    // zero-row heartbeat — reassigned, terminal, or already reconciled) is a
    // FencedError, the same signal the executor's gate raises, and a lost
    // claim is never revived because the heartbeat only extends a claim this
    // owner still holds at this epoch.
    const renewAll = () => {
      if (!(heartbeat(db, { id: job.id, owner, epoch, leaseMs: LEASE_MS, nowMs: nowMs() }) > 0)) return JOB_CLAIM;
      if (!(renewLock(db, { app: job.app, owner, epoch: lockEpoch, leaseMs: LEASE_MS, nowMs: nowMs() }) > 0)) return job.app;
      if (!(renewLock(db, { app: HOST_ROUTES_LOCK, owner, epoch: routesEpoch, leaseMs: LEASE_MS, nowMs: nowMs() }) > 0)) return HOST_ROUTES_LOCK;
      return null;
    };
    const fence = () => {
      const gone = lost || renewAll();
      if (gone) { lost = gone; throw gone === JOB_CLAIM ? new FencedError(job.id) : new LeaseLostError(gone); }
    };
    keepAlive = setInterval(() => { try { const gone = renewAll(); if (gone) lost = gone; } catch { /* the next fence decides */ } }, Math.max(20, Number(keepAliveMs) || KEEPALIVE_MS));
    if (typeof keepAlive.unref === 'function') keepAlive.unref();
    fence();
    const res = isReset ? await deps.platformResetRoutesStep({ resetJob: p.resetJob, fence }) : isVaultwarden ? await deps.vaultwardenStep({revision:p.revision,fence}) : isOpenBao ? await deps.openbaoStep({revision:p.revision,fence}) : isInfisical ? await deps.infisicalStep({revision:p.revision,fence}) : isPomerium ? await deps.pomeriumStep({revision:p.revision,stage:p.stage,fence}) : isSso ? await deps.ssoStep({ kind: job.kind, fingerprint: p.fingerprint, fence }) : isKeycloak ? await deps.configureKeycloakRoute({ installationId: p.installationId, fence }) : await deps.configureRoutes({ container: p.container, name: p.serviceName, ip: p.ip, services: p.services, fence });
    fence();
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
    if (e instanceof LeaseLostError || e?.code === 'LEASE_LOST') {
      event('step', e.message, { lease: e.lease }, 'routes');
      noteOrigin('failed', { detail: `${e.message}; retry the job` });
      return fin('failed', 'lease_lost', `${e.message}; the routes were not completed by this job — retry it`, { state: 'not_applicable', label: e.message, failedAt: 'routes', next: 'retry the job' });
    }
    if (isSso) return fin('failed','sso_check_failed', e?.ssoSafe ? e.message : 'SSO verification failed. Check observer access, TLS and the configured client.');
    noteOrigin('failed', { detail: sanitizeReason(e?.message || String(e), 300) });
    return fin('failed', 'error', sanitizeReason(e?.message || String(e)));
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    if (routesHeld) releaseLock(db, { app: HOST_ROUTES_LOCK, owner, epoch: routesEpoch });
    releaseLock(db, { app: job.app, owner, epoch: lockEpoch });
  }
}
