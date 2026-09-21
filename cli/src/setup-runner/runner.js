// Host runner — the independent process that ACTS on setup jobs
// (docs/core/setup-engine-requirements.md R2). It runs as root on the host,
// outside the dashboard container, and it is the only thing that executes a
// recovery: the browser, the CLI and MCP submit and observe rows; this loop
// claims them.
//
//   reconcile   on start and periodically: every running job whose lease
//               lapsed is looked at — a dead backend that had stopped an app
//               gets a recover_app job queued and its lease flagged stale; a
//               dead runner's resumable job is requeued; anything else is
//               recorded as interrupted and its lease released.
//   executeJob  one claimed job: validate the kind and its parameters
//               (nothing here takes a command), take or take over the app's
//               lease, run the steps with a heartbeat before every guest
//               command (a heartbeat that changes nothing means ownership
//               moved — stop), record the R4 verification, release.
//
// Every dependency is injected (db, exec, owner, clock, log) so the suite
// drives the whole loop against node:sqlite and a scripted guest.

import {
  claimNextJob, heartbeat, checkpoint, finishJob, recordJobOutcome, staleRunningJobs, readLock, takeoverLock, releaseLock,
  acquireLock, markLockStale, createJob, openRecoveryJobFor, appendEvent, getJob, renewLock, fenceJob, recordGenerated, recordProgress,
  runnerHeartbeat, runnerGoodbye, requeueJob,
} from '../../../admin/backend/src/lib/setup-engine/store.js';
import {
  validateRunnerJob, reconcileDecision, recoveryJobFrom, verifyJobFrom, RUNNER_JOB_KINDS, parseJson, sanitizeReason, parseOwner, FencedError, CancelledError,
} from '../../../admin/backend/src/lib/setup-engine/logic.js';
import { runDeployOperation, reapOrphansScript, parseOrphans, PreviousWriterAliveError } from '../../../admin/backend/src/lib/setup-engine/deploy-op.js';
import {
  unitStatusScript, parseUnitStatus, startUnitScript, parseStartUnit, portProbeScript, parsePortProbe,
  healthScript, parseHealth, activeKeyScript, credentialProbeScript, credentialVerdict, verificationFromObservations, DEFAULT_UNIT,
} from './probes.js';

export { FencedError, CancelledError };

const GUEST_TIMEOUT_MS = 90_000;
const LEASE_MS = 30_000;

// ── reconcile ───────────────────────────────────────────────────────────

// reconcile({ db, owner, nowMs }) → summary. Idempotent.
export function reconcile({ db, owner, nowMs = Date.now(), log = () => {} } = {}) {
  const summary = { requeued: [], interrupted: [], recoveryQueued: [], skipped: [] };
  for (const job of staleRunningJobs(db, { nowMs })) {
    if (job.owner === owner) continue;
    const lock = readLock(db, job.app);
    const d = reconcileDecision({ job, lock, nowMs, canAct: true });
    const cp = parseJson(job.checkpoint_json) || {};
    if (d.action === 'resume') {
      // A dead runner's resumable job: back to the queue, where this loop
      // claims it under a new epoch. The steps are idempotent.
      requeueJob(db, { id: job.id, by: owner, reason: `${d.reason}; requeued by ${owner}`, nowMs });
      if (lock && lock.owner === job.owner) releaseLock(db, { app: job.app, owner: lock.owner, epoch: lock.epoch });
      summary.requeued.push(job.id);
    } else if (d.action === 'record_interrupted') {
      recordJobOutcome(db, { id: job.id, status: 'failed', outcome: 'interrupted', reason: `${d.reason}; nothing was left changed`, by: owner, nowMs });
      if (lock && lock.owner === job.owner) releaseLock(db, { app: job.app, owner: lock.owner, epoch: lock.epoch });
      summary.interrupted.push(job.id);
    } else if (d.action === 'verify') {
      const spec = verifyJobFrom(job, { nowIso: new Date(nowMs).toISOString() });
      const verify = createJob(db, { kind: spec.kind, app: spec.app, plan: spec.plan, configRefs: { origin: spec.plan.params.origin }, requestedBy: spec.requested_by, via: spec.via, reason: spec.reason, nowMs });
      recordJobOutcome(db, { id: job.id, status: 'failed', outcome: 'interrupted_unverified', reason: `${d.reason}; verification job ${verify.id} queued; the recovery references are kept on this record`, by: owner, nowMs });
      if (lock && lock.owner === job.owner) releaseLock(db, { app: job.app, owner: lock.owner, epoch: lock.epoch });
      summary.interrupted.push(job.id);
      summary.recoveryQueued.push({ job: job.id, recovery: verify.id, app: job.app, kind: 'verify_app' });
    } else if (d.action === 'recover') {
      let recovery = openRecoveryJobFor(db, job.app);
      if (!recovery) {
        const spec = recoveryJobFrom(job, { nowIso: new Date(nowMs).toISOString() });
        recovery = createJob(db, { kind: spec.kind, app: spec.app, plan: spec.plan, configRefs: { origin: spec.plan.params.origin }, requestedBy: spec.requested_by, via: spec.via, reason: spec.reason, nowMs });
      }
      recordJobOutcome(db, {
        id: job.id, status: 'recovery_required', outcome: 'interrupted_after_stop',
        reason: `${d.reason}; the application '${cp.container || job.app}' may still be stopped; recovery job ${recovery.id} queued`,
        verification: { state: 'recovery_required', failedAt: 'port_responding', note: 'not verified: the owner died while the application was stopped' },
        by: owner, nowMs,
      });
      if (lock && lock.owner === job.owner) markLockStale(db, { app: job.app, nowMs, recoveryJobId: recovery.id });
      summary.recoveryQueued.push({ job: job.id, recovery: recovery.id, app: job.app });
    } else {
      summary.skipped.push({ job: job.id, reason: d.reason });
    }
  }
  if (summary.requeued.length || summary.interrupted.length || summary.recoveryQueued.length) log('reconcile', summary);
  return summary;
}

// ── execute ─────────────────────────────────────────────────────────────

// executeJob(job, deps) → { status, verification }. deps: { db, owner, exec:
// { guest(container, script, { timeoutMs }) }, nowMs(), log }.
export async function executeJob(job, { db, owner, exec, nowMs = () => Date.now(), log = () => {} }) {
  const epoch = Number(job.epoch);
  const fin = (status, outcome, reason, verification = null) => {
    finishJob(db, { id: job.id, owner, epoch, status, outcome, reason, verification, nowMs: nowMs() });
    return { status, outcome, verification };
  };
  const v = validateRunnerJob(job);
  if (!v.ok) return fin('refused', 'invalid', v.reason);
  const plan = parseJson(job.plan_json) || {};
  const p = plan.params || {};
  const container = String(p.container || job.app);
  const unit = String(p.unit || DEFAULT_UNIT);
  const webPort = Number(p.webPort) || 3000;
  const envFile = String(p.environmentFile || '/etc/environment');
  const steps = Array.isArray(plan.steps) && plan.steps.length ? plan.steps : defaultSteps(job.kind);

  // The app's lease: take it, or take over a dead holder's (the very case a
  // recovery job exists for). A LIVE foreign lease means someone is working
  // on the app right now — defer, do not queue behind them blind.
  const lockNow = nowMs();
  let lockEpoch;
  const got = acquireLock(db, { app: job.app, owner, operation: job.kind, jobId: job.id, leaseMs: LEASE_MS, nowMs: lockNow });
  if (got.ok) {
    lockEpoch = Number(got.lock.epoch);
  } else if (got.reason === 'stale') {
    const t = takeoverLock(db, { app: job.app, by: owner, operation: job.kind, jobId: job.id, reason: `taking over ${got.operation} lease of ${got.holder} (expired ${got.expiredAt}) to run ${job.kind}`, leaseMs: LEASE_MS, nowMs: lockNow });
    if (!t.ok) return fin('deferred', 'lock_held', `the app's lease is held by ${t.holder}; retry when it finishes`);
    lockEpoch = Number(t.lock.epoch);
  } else {
    return fin('deferred', 'lock_held', `the app's lease is held by ${got.holder} (${got.operation}); retry when it finishes`);
  }

  const obs = { unit: null, port: null, health: null, credential: null };
  const fence = (opts = {}) => {
    fenceJob(db, { id: job.id, owner, epoch, safe: !!opts.safe, leaseMs: LEASE_MS, nowMs: nowMs() });
    renewLock(db, { app: job.app, owner, epoch: lockEpoch, leaseMs: LEASE_MS, nowMs: nowMs() });
  };
  const guest = async (phase, script, { timeoutMs = GUEST_TIMEOUT_MS, resumable = true, data = {}, safe = false } = {}) => {
    // The fence, before every command that touches the target.
    fence({ safe });
    checkpoint(db, { id: job.id, owner, epoch, phase, checkpoint: { resumable, container, unit, webPort, ...data }, message: `${phase}`, nowMs: nowMs() });
    const r = await exec.guest(container, script, { timeoutMs });
    return r || { code: -1, stdout: '', stderr: 'no result' };
  };

  try {
    // A previous writer's scripts (a dead deploy's install/build/start, ours
    // or a backend's) must be gone before this job touches the guest: the
    // lease expiring is not proof they stopped. Reap, then count survivors.
    if (job.kind === 'deploy' || job.kind === 'recover_app') {
      const reap = await guest('reap_previous_writer', reapOrphansScript(), { timeoutMs: 30_000, safe: true });
      const left = parseOrphans(reap.stdout);
      if (left != null && left > 0) {
        const again = await guest('reap_previous_writer', reapOrphansScript(), { timeoutMs: 30_000, safe: true });
        const still = parseOrphans(again.stdout);
        if (still == null || still > 0) throw new PreviousWriterAliveError(container, still ?? left);
      }
      appendEvent(db, { jobId: job.id, kind: 'step', phase: 'reap_previous_writer', message: left == null ? 'orphan count unavailable; proceeding' : `${left} orphan script(s) signalled; none remain`, nowMs: nowMs() });
    }

    if (job.kind === 'deploy') {
      const handle = {
        fence,
        checkpoint: (phase, data, message) => checkpoint(db, { id: job.id, owner, epoch, phase, checkpoint: data, message, nowMs: nowMs() }),
        generated: (resource) => recordGenerated(db, { id: job.id, owner, epoch, resource, nowMs: nowMs() }),
        event: (kind, message, data = null) => appendEvent(db, { jobId: job.id, kind, message, data, nowMs: nowMs() }),
        onStep: (key, label) => appendEvent(db, { jobId: job.id, kind: 'step', phase: key, message: label, nowMs: nowMs() }),
      };
      // Reap already done above; the operation's own reap would be a repeat.
      const result = await runDeployOperation({ params: { ...p, reapOrphans: false }, exec: { guest: (c, script, o) => { fence(); return exec.guest(c, script, o); } }, job: handle, log });
      // A cancel that arrived after the disruptive step was not honoured
      // mid-way: the app was brought up; say so on the record.
      const late = (parseJson(getJob(db, job.id)?.progress_json) || {}).cancel_requested;
      if (late) appendEvent(db, { jobId: job.id, kind: 'cancel_declined', message: `cancel by ${late.by} arrived after the application had been stopped; the deploy finished bringing it up instead of leaving it down`, nowMs: nowMs() });
      const { verification, ...rest } = result;
      const pub = { ...rest, verification: verification ? { state: verification.state, label: verification.label, failedAt: verification.failedAt || null, next: verification.next || null } : null };
      if (result.ok) {
        const state = result.skipped ? 'skipped' : (verification?.state || 'serving');
        recordProgress(db, { id: job.id, owner, epoch, progress: { result: pub }, nowMs: nowMs() });
        const r = fin(result.skipped ? 'succeeded' : (verification?.state === 'recovery_required' ? 'recovery_required' : 'succeeded'), state, result.skipped ? 'no run contract; nothing to deploy' : `${container}: ${verification?.label || 'serving'}`, verification || null);
        return { ...r, result };
      }
      recordProgress(db, { id: job.id, owner, epoch, progress: { result: pub, failed_step: result.step }, nowMs: nowMs() });
      const r = fin('failed', `failed at ${result.step}`, result.error, verification || null);
      return { ...r, result };
    }

    for (const step of steps) {
      switch (step) {
        case 'unit_status': case 'start_unit': {
          const st = parseUnitStatus((await guest('unit_status', unitStatusScript(unit))).stdout);
          obs.unit = st;
          if (st.loaded === false) {
            const verification = verificationFromObservations(obs);
            return fin('recovery_required', 'unit_missing', `unit ${unit} is not present in ${container}; ${verification.next}`, verification);
          }
          if (step === 'start_unit' && !st.isActive) {
            const started = parseStartUnit((await guest('start_unit', startUnitScript(unit), { data: { disruptive: false } })).stdout);
            obs.unit = { ...st, observed: true, active: started.active || st.active, isActive: started.active === 'active', startRc: started.rc };
            appendEvent(db, { jobId: job.id, kind: 'step', phase: 'start_unit', message: `systemctl start ${unit}: rc ${started.rc ?? '?'}, now ${started.active || '?'}`, nowMs: nowMs() });
          }
          break;
        }
        case 'probe_port': {
          obs.port = parsePortProbe((await guest('probe_port', portProbeScript(webPort, 15))).stdout);
          appendEvent(db, { jobId: job.id, kind: 'step', phase: 'probe_port', message: obs.port.observed ? `port ${webPort}: ${obs.port.responding ? 'responding' : 'not responding'} (${obs.port.code})` : `port ${webPort}: probe produced no output`, nowMs: nowMs() });
          if (obs.port.responding === false) {
            const verification = verificationFromObservations(obs);
            return fin('recovery_required', 'not_serving', `${container}: ${unit} does not serve on ${webPort}; ${verification.next}`, verification);
          }
          break;
        }
        case 'health_check': {
          obs.health = parseHealth((await guest('health_check', healthScript(webPort))).stdout);
          appendEvent(db, { jobId: job.id, kind: 'step', phase: 'health_check', message: obs.health.observed ? (obs.health.healthy ? `healthy (${JSON.stringify(obs.health.codes)})` : `not healthy: ${obs.health.why}`) : 'health probe produced no output', nowMs: nowMs() });
          if (obs.health.healthy === false) {
            const verification = verificationFromObservations(obs);
            return fin('recovery_required', 'unhealthy', `${container}: the application answers but is failing (${obs.health.why}); ${verification.next}`, verification);
          }
          break;
        }
        case 'verify_credential': {
          if (!p.guard) {
            obs.credential = { verified: null, code: null, detail: 'no data guard recorded for this app; the credential check was not run' };
            appendEvent(db, { jobId: job.id, kind: 'step', phase: 'verify_credential', message: obs.credential.detail, nowMs: nowMs() });
            break;
          }
          let script;
          try { script = credentialProbeScript(p.guard); } catch (e) {
            obs.credential = { verified: null, code: null, detail: `invalid data guard: ${e.message}` };
            break;
          }
          // The key value lives in this variable only.
          const envKey = String((await guest('read_active_key', activeKeyScript(envFile), { timeoutMs: 15_000 })).stdout || '').trim();
          const probeRun = await guest('verify_credential', script, { timeoutMs: 30_000 });
          obs.credential = credentialVerdict({ guard: p.guard, envKey, probeStdout: probeRun.stdout });
          appendEvent(db, { jobId: job.id, kind: 'step', phase: 'verify_credential', message: `MASTERKEY_ROWS ${obs.credential.code}: ${obs.credential.detail}`, nowMs: nowMs() });
          break;
        }
        default:
          return fin('refused', 'invalid', `unknown step '${step}'`);
      }
    }
    const verification = verificationFromObservations(obs);
    const status = verification.state === 'recovery_required' ? 'recovery_required' : 'succeeded';
    const result = fin(status, verification.state, `${container}: ${verification.label}${verification.deferredReason ? ` (${verification.deferredReason})` : ''}`, verification);
    noteOrigin(db, p, job, result, nowMs());
    return result;
  } catch (e) {
    if (e instanceof FencedError || e?.code === 'FENCED') { log('fenced', job.id); return { status: 'fenced', outcome: null, verification: null }; }
    if (e instanceof CancelledError || e?.code === 'CANCELLED') return fin('cancelled', 'cancelled', e.message, null);
    if (e?.code === 'PREVIOUS_WRITER_ALIVE') return fin('failed', 'previous_writer_alive', e.message, null);
    const verification = verificationFromObservations(obs);
    return fin('failed', 'error', sanitizeReason(e?.message || String(e)), verification);
  } finally {
    releaseLock(db, { app: job.app, owner, epoch: lockEpoch });
  }
}

function defaultSteps(kind) {
  if (kind === 'deploy') return [];
  if (kind === 'recover_app') return ['start_unit', 'probe_port', 'health_check', 'verify_credential'];
  if (kind === 'verify_app') return ['unit_status', 'probe_port', 'health_check', 'verify_credential'];
  return ['unit_status', 'probe_port'];
}

// The job that died is told what its recovery found — a pointer, on the
// record an operator will open first.
function noteOrigin(db, params, job, result, nowMs) {
  const origin = params?.origin?.jobId;
  if (!origin || !getJob(db, origin)) return;
  appendEvent(db, { jobId: origin, kind: 'recovery_result', phase: null, message: `recovery job ${job.id}: ${result.status} — ${result.verification?.label || result.outcome}`, data: { recovery_job: job.id, state: result.verification?.state || null }, nowMs });
}

// ── the loop ────────────────────────────────────────────────────────────

// runOnce(deps, { max }) → { reconciled, ran: [...] }: reconcile, then claim
// and execute up to `max` queued runner jobs.
export async function runOnce(deps, { max = 5, reconcileFirst = true } = {}) {
  const { db, owner } = deps;
  const out = { reconciled: null, ran: [] };
  try { runnerHeartbeat(db, { owner, host: describeOwner(owner).host, pid: describeOwner(owner).pid, version: deps.version || null, nowMs: deps.nowMs ? deps.nowMs() : Date.now() }); } catch { /* */ }
  if (reconcileFirst) out.reconciled = reconcile({ db, owner, nowMs: deps.nowMs ? deps.nowMs() : Date.now(), log: deps.log });
  for (let i = 0; i < max; i += 1) {
    const job = claimNextJob(db, { owner, kinds: [...RUNNER_JOB_KINDS], leaseMs: LEASE_MS, nowMs: deps.nowMs ? deps.nowMs() : Date.now() });
    if (!job) break;
    deps.log?.('claimed', job.id, job.kind, job.app);
    const r = await executeJob(job, deps);
    out.ran.push({ id: job.id, kind: job.kind, app: job.app, ...r });
    deps.log?.('finished', job.id, r.status, r.verification?.state || r.outcome);
  }
  return out;
}

// serve(deps, { pollMs, reconcileEveryMs, shouldStop }) — the long-running
// loop the systemd unit runs. Reconciles on start and periodically, polls the
// queue between. Never throws: a failed tick is logged and the next one runs.
export async function serve(deps, { pollMs = 2000, reconcileEveryMs = 60_000, shouldStop = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastReconcile = 0;
  deps.log?.('serve', `runner ${deps.owner} started`);
  while (!shouldStop()) {
    const now = deps.nowMs ? deps.nowMs() : Date.now();
    try {
      await runOnce(deps, { reconcileFirst: now - lastReconcile >= reconcileEveryMs });
      if (now - lastReconcile >= reconcileEveryMs) lastReconcile = now;
    } catch (e) {
      deps.log?.('tick failed', e?.message || e);
    }
    await sleep(pollMs);
  }
  try { runnerGoodbye(deps.db, { owner: deps.owner }); } catch { /* */ }
  deps.log?.('serve', 'stopping');
}

export function describeOwner(owner) {
  return parseOwner(owner) || { kind: '?', host: '?', pid: 0, instance: '' };
}
