// Setup engine — the job EXECUTOR: what claims a queued job, takes (or takes
// over) the app's lease, runs the kind's steps against a guest, and records
// the outcome. One implementation, two hosts:
//
//   * the host runner (cli/src/setup-runner) runs it as root on the host
//     with `incus exec`, the production executor;
//   * the backend runs it in-process only under the `backend-allowed`
//     installation policy (logic.js executorPolicy) — the legacy /
//     development executor — with the same code, record and locking rules.
//
// Dependencies are injected: db, owner, exec.guest, reviewLogin(container) →
// { email, password } | null (read by the host from mock2.db, never from a
// job row), nowMs, log.
//
// Containment (guest-probes): before a deploy or a recovery touches the
// guest, every group (scope unit or cgroup) another job recorded is killed
// and counted, as are legacy marker scripts; a survivor
// is a recovery-required condition — the job ends there, the lease is KEPT
// and flagged stale so every conflicting operation is refused with the
// recorded reason, and nothing is silently cleared.
//
// Durable verification: a deploy that ends serving queues the application-
// owned credential check as its own `verify_app` job BEFORE it reports
// itself finished, so a dead API or runner never loses the obligation; the
// check's outcome lands on both records.

import {
  claimNextJob, heartbeat, checkpoint, finishJob, recordJobOutcome, staleRunningJobs, readLock, takeoverLock, releaseLock,
  acquireLock, markLockStale, createJob, openRecoveryJobFor, appendEvent, getJob, renewLock, fenceJob, recordGenerated, recordProgress,
  runnerHeartbeat, requeueJob, recordVerificationRung,
} from './store.js';
import {
  validateRunnerJob, reconcileDecision, recoveryJobFrom, verifyJobFrom, RUNNER_JOB_KINDS, EXCLUSIVE_JOB_KINDS, parseJson, sanitizeReason, parseOwner,
  FencedError, CancelledError, verificationState, CREDENTIAL_USE_OUTCOMES,
} from './logic.js';
import { runDeployOperation, PreviousWriterAliveError, ContainmentUnavailableError } from './deploy-op.js';
import { runRestoreDbOperation } from './restore-db-op.js';
import { runRestoreSnapshotOperation } from './restore-snapshot-op.js';
import { runRetrySecretsOperation } from './retry-secrets-op.js';
import {
  unitStatusScript, parseUnitStatus, startUnitScript, parseStartUnit, portProbeScript, parsePortProbe,
  healthScript, parseHealth, activeKeyScript, credentialProbeScript, credentialVerdict, verificationFromObservations, DEFAULT_UNIT,
  reapStaleWritersScript, parseStaleWriters, credentialUseScript, interpretCredentialUse, CONTAINMENT_RUN_DIR,
} from './guest-probes.js';

const FOLLOW_UP_RETRY_MS = 30_000;

export { FencedError, CancelledError };

const GUEST_TIMEOUT_MS = 90_000;
const LEASE_MS = 30_000;

// ── reconcile ───────────────────────────────────────────────────────────

export function reconcile({ db, owner, nowMs = Date.now(), log = () => {} } = {}) {
  const summary = { requeued: [], interrupted: [], recoveryQueued: [], skipped: [] };
  for (const job of staleRunningJobs(db, { nowMs })) {
    if (job.owner === owner) continue;
    const lock = readLock(db, job.app);
    const d = reconcileDecision({ job, lock, nowMs, canAct: true });
    const cp = parseJson(job.checkpoint_json) || {};
    if (d.action === 'resume') {
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
        recovery = createJob(db, { kind: spec.kind, app: spec.app, plan: spec.plan, configRefs: { origin: spec.plan.params.origin, recovery: cp.recovery || null }, requestedBy: spec.requested_by, via: spec.via, reason: spec.reason, nowMs });
      }
      const mig = cp.migration_in_progress === true ? ` A migration was in flight (retry class: ${cp.recovery?.migration?.retry || 'unknown'}).` : '';
      const rst = cp.restore_in_progress === true ? ` A database restore was in flight: the database may be partially restored; the pre-restore dump ${cp.recovery?.protected?.dbDump?.path || 'is not recorded'} is the protected copy.` : (job.kind === 'restore_snapshot' ? ` A snapshot restore was in flight (pre-restore snapshot ${cp.recovery?.preRestore?.name || 'not recorded'}).` : '');
      recordJobOutcome(db, {
        id: job.id, status: 'recovery_required', outcome: 'interrupted_after_stop',
        reason: `${d.reason}; the application '${cp.container || job.app}' may still be stopped;${mig}${rst} recovery job ${recovery.id} queued`,
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

export async function executeJob(job, { db, owner, exec, reviewLogin = null, nowMs = () => Date.now(), log = () => {} }) {
  const epoch = Number(job.epoch);
  let keepLease = false;
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
  const runDir = String(p.runDir || CONTAINMENT_RUN_DIR);
  const steps = Array.isArray(plan.steps) && plan.steps.length ? plan.steps : defaultSteps(job.kind);

  const lockNow = nowMs();
  let lockEpoch;
  // A follow-up (a verification or recovery queued for another job) is an
  // OBLIGATION: when the app is busy it goes back to the queue with a
  // not-before, never to a terminal 'deferred'.
  const isFollowUp = !!p.origin?.jobId;
  const busy = (holder, operation) => {
    if (isFollowUp) {
      requeueJob(db, { id: job.id, by: owner, reason: `the app's lease is held by ${holder}${operation ? ` (${operation})` : ''}; this follow-up waits and retries`, notBeforeMs: nowMs() + FOLLOW_UP_RETRY_MS, nowMs: nowMs() });
      return { status: 'requeued', outcome: 'lock_held', verification: null };
    }
    // A restore never runs later under a state nobody looked at: refused.
    if (EXCLUSIVE_JOB_KINDS.includes(job.kind)) return fin('refused', 'lock_held', `the app's lease is held by ${holder}${operation ? ` (${operation})` : ''}; the restore was refused before any change — submit it again when the holder has finished`);
    return fin('deferred', 'lock_held', `the app's lease is held by ${holder}${operation ? ` (${operation})` : ''}; retry when it finishes`);
  };
  const got = acquireLock(db, { app: job.app, owner, operation: job.kind, jobId: job.id, leaseMs: LEASE_MS, nowMs: lockNow });
  if (got.ok) {
    lockEpoch = Number(got.lock.epoch);
  } else if (got.reason === 'stale') {
    const t = takeoverLock(db, { app: job.app, by: owner, operation: job.kind, jobId: job.id, reason: `taking over ${got.operation} lease of ${got.holder} (expired ${got.expiredAt}) to run ${job.kind}`, leaseMs: LEASE_MS, nowMs: lockNow });
    if (!t.ok) return busy(t.holder, null);
    lockEpoch = Number(t.lock.epoch);
  } else {
    return busy(got.holder, got.operation);
  }

  const obs = { unit: null, port: null, health: null, credential: null, credentialUse: null };
  const fence = (opts = {}) => {
    fenceJob(db, { id: job.id, owner, epoch, safe: !!opts.safe, leaseMs: LEASE_MS, nowMs: nowMs() });
    renewLock(db, { app: job.app, owner, epoch: lockEpoch, leaseMs: LEASE_MS, nowMs: nowMs() });
  };
  const guest = async (phase, script, { timeoutMs = GUEST_TIMEOUT_MS, resumable = true, data = {}, safe = false } = {}) => {
    fence({ safe });
    checkpoint(db, { id: job.id, owner, epoch, phase, checkpoint: { resumable, container, unit, webPort, ...data }, message: `${phase}`, nowMs: nowMs() });
    const r = await exec.guest(container, script, { timeoutMs });
    return r || { code: -1, stdout: '', stderr: 'no result' };
  };
  const event = (kind, message, data = null, phase = null) => appendEvent(db, { jobId: job.id, kind, phase, message, data, nowMs: nowMs() });

  try {
    // Containment before anything that touches the guest: other jobs'
    // groups and legacy marker scripts are killed and counted. A survivor
    // is recorded and the job stops here with the lease kept.
    if (['deploy', 'recover_app', 'restore_db', 'retry_secrets'].includes(job.kind)) {
      const script = reapStaleWritersScript(job.id, { runDir });
      const reap = await guest('reap_previous_writer', script, { timeoutMs: 30_000, safe: true });
      const left = parseStaleWriters(reap.stdout);
      if (left != null && left > 0) {
        const again = await guest('reap_previous_writer', script, { timeoutMs: 30_000, safe: true });
        const still = parseStaleWriters(again.stdout);
        if (still == null || still > 0) throw new PreviousWriterAliveError(container, still ?? left);
      }
      event('step', left == null ? 'stale-writer count unavailable; proceeding' : `${left} stale process group(s)/script(s) of other jobs signalled; none remain`, null, 'reap_previous_writer');
    }

    if (['deploy', 'restore_db', 'restore_snapshot', 'retry_secrets'].includes(job.kind)) {
      const handle = {
        id: job.id,
        fence,
        checkpoint: (phase, data, message) => checkpoint(db, { id: job.id, owner, epoch, phase, checkpoint: data, message, nowMs: nowMs() }),
        generated: (resource) => recordGenerated(db, { id: job.id, owner, epoch, resource, nowMs: nowMs() }),
        event: (kind, message, data = null) => event(kind, message, data),
        onStep: (key, label) => event('step', label, null, key),
      };
      const fencedExec = { guest: (c, script, o) => { fence(); return exec.guest(c, script, o); }, ...(typeof exec.host === 'function' ? { host: (argv, o) => { fence(); return exec.host(argv, o); } } : {}) };
      // What a previous attempt recorded (a retry's origin, and this job's own
      // progress when it was resumed): reused only after revalidation.
      const reuse = reuseFrom(db, job, p);
      let result;
      if (job.kind === 'deploy') result = await runDeployOperation({ params: { ...p, reapOrphans: false, runDir }, exec: fencedExec, job: handle, log });
      else if (job.kind === 'restore_db') {
        const originJob = p.envCopy?.originJobId ? getJob(db, String(p.envCopy.originJobId)) : null;
        result = await runRestoreDbOperation({ params: { ...p, runDir }, exec: fencedExec, job: handle, originJob, reuse, log });
      } else if (job.kind === 'restore_snapshot') result = await runRestoreSnapshotOperation({ params: p, exec: fencedExec, job: handle, reuse, log });
      else result = await runRetrySecretsOperation({ params: { ...p, runDir }, exec: fencedExec, job: handle, reuse, log });
      const late = (parseJson(getJob(db, job.id)?.progress_json) || {}).cancel_requested;
      if (late) event('cancel_declined', `cancel by ${late.by} arrived after the disruptive step; the ${job.kind} finished bringing the app up instead of leaving it down`);
      const { verification: opVerification, recovery, ...rest } = result;
      // A restore reports the ladder it observed with the application rungs
      // pending for its follow-up; the deploy and the mint bring their own.
      const verification = opVerification || (job.kind === 'restore_db' && result.ok
        ? verificationFromObservations({ unit: { loaded: true, observed: true, isActive: result.unitActive === true, active: result.unitActive ? 'active' : 'inactive' }, port: result.port || null, health: result.health }, { pendingRungs: ['credential_decryptable', 'credential_use_verified'] })
        : (job.kind === 'restore_snapshot' && result.ok && result.followUp ? { state: 'configured', label: 'restored; verification pending', pending: ['port_responding', 'app_healthy', 'credential_decryptable', 'credential_use_verified'], facts: { pendingRungs: ['credential_use_verified'] } } : null));
      const okOutcome = job.kind === 'deploy' ? 'serving' : (result.step || 'completed');
      const pub = { ...rest, verification: verification ? { state: verification.state, label: verification.label, failedAt: verification.failedAt || null, next: verification.next || null, pending: verification.pending || [] } : null };
      const queueFollowUp = (steps, rung, reason, revision) => createJob(db, {
        kind: 'verify_app', app: job.app,
        plan: { steps, params: { container, webPort, unit, environmentFile: envFile, guard: p.guard || null, runDir, origin: { jobId: job.id, kind: 'deploy', rung, revision: revision || null } } },
        configRefs: { origin: { jobId: job.id }, recovery: recovery || null },
        requestedBy: 'deploy', via: 'system', reason, nowMs: nowMs(),
      });
      if (result.ok) {
        // The obligation to verify is persisted BEFORE the job reports done.
        let verificationJobId = null;
        if (result.followUp && !result.skipped) {
          const follow = queueFollowUp(result.followUp.steps, result.followUp.rung, job.kind === 'deploy' ? `application-owned credential check for deploy ${job.id}` : `verify ${container} after ${job.kind} ${job.id}`, result.followUp.revision);
          verificationJobId = follow.id;
          pub.verificationJobId = follow.id;
        }
        recordProgress(db, { id: job.id, owner, epoch, progress: { result: pub, verification_job_id: verificationJobId, execution: result.skipped ? 'skipped' : okOutcome }, nowMs: nowMs() });
        const summary = job.kind === 'deploy' ? `${container}: serving` : job.kind === 'restore_db' ? `${container}: database restored from ${rest.restored?.dump} (${rest.errors ?? '?'} error line(s); ${rest.compatibility?.mode})` : job.kind === 'restore_snapshot' ? `${container}: restored to ${rest.restoredTo}${rest.partial ? ' (root disk only; custom volumes NOT restored)' : ''}; pre-restore ${rest.preRestore?.name}` : `${container}: ${(rest.minted || []).length} secret(s) minted, ${(rest.deferred || []).length} deferred, ${(rest.reused || []).length} reused`;
        const r = fin(
          result.skipped ? 'succeeded' : (verification?.state === 'recovery_required' ? 'recovery_required' : 'succeeded'),
          result.skipped ? 'skipped' : okOutcome,
          result.skipped ? 'no run contract; nothing to deploy' : `${summary}; verification ${verification?.state || 'not_applicable'}${verification?.pending?.length ? ` (pending: ${verification.pending.join(', ')} → job ${verificationJobId})` : ''}`,
          verification || null,
        );
        return { ...r, result, verificationJobId };
      }
      // A failure after the disruptive step left SOMETHING running (the
      // restart was attempted, or the new unit started and failed health):
      // what that is must be verified, not assumed — a post-failure
      // verification is queued so the record ends with a checked state.
      let verificationJobId = null;
      if (result.restartAttempted || result.unitStarted) {
        const follow = queueFollowUp(['unit_status', 'probe_port', 'health_check', 'verify_credential', 'verify_credential_use'], 'post_failure', `verify what runs in ${container} after ${job.kind} ${job.id} failed at ${result.step}`, null);
        verificationJobId = follow.id;
        pub.verificationJobId = follow.id;
      }
      recordProgress(db, { id: job.id, owner, epoch, progress: { result: pub, failed_step: result.step, execution: 'failed', verification_job_id: verificationJobId }, nowMs: nowMs() });
      const r = fin('failed', `failed at ${result.step}`, `${result.error}${verificationJobId ? ` (post-failure verification queued: job ${verificationJobId})` : ''}`, verification || null);
      return { ...r, result, verificationJobId };
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
            event('step', `systemctl start ${unit}: rc ${started.rc ?? '?'}, now ${started.active || '?'}`, null, 'start_unit');
          }
          break;
        }
        case 'probe_port': {
          obs.port = parsePortProbe((await guest('probe_port', portProbeScript(webPort, 15))).stdout);
          event('step', obs.port.observed ? `port ${webPort}: ${obs.port.responding ? 'responding' : 'not responding'} (${obs.port.code})` : `port ${webPort}: probe produced no output`, null, 'probe_port');
          if (obs.port.responding === false) {
            const verification = verificationFromObservations(obs);
            return fin('recovery_required', 'not_serving', `${container}: ${unit} does not serve on ${webPort}; ${verification.next}`, verification);
          }
          break;
        }
        case 'health_check': {
          obs.health = parseHealth((await guest('health_check', healthScript(webPort))).stdout);
          event('step', obs.health.observed ? (obs.health.healthy ? `healthy (${JSON.stringify(obs.health.codes)})` : `not healthy: ${obs.health.why}`) : 'health probe produced no output', null, 'health_check');
          if (obs.health.healthy === false) {
            const verification = verificationFromObservations(obs);
            return fin('recovery_required', 'unhealthy', `${container}: the application answers but is failing (${obs.health.why}); ${verification.next}`, verification);
          }
          break;
        }
        case 'verify_credential': {
          if (!p.guard) {
            obs.credential = { verified: null, code: null, detail: 'no data guard recorded for this app; the credential check was not run' };
            event('step', obs.credential.detail, null, 'verify_credential');
            break;
          }
          let script;
          try { script = credentialProbeScript(p.guard); } catch (e) {
            obs.credential = { verified: null, code: null, detail: `invalid data guard: ${e.message}` };
            break;
          }
          const envKey = String((await guest('read_active_key', activeKeyScript(envFile), { timeoutMs: 15_000 })).stdout || '').trim();
          const probeRun = await guest('verify_credential', script, { timeoutMs: 30_000 });
          obs.credential = credentialVerdict({ guard: p.guard, envKey, probeStdout: probeRun.stdout });
          event('step', `MASTERKEY_ROWS ${obs.credential.code}: ${obs.credential.detail}`, null, 'verify_credential');
          break;
        }
        case 'verify_credential_use': {
          // The application-owned rung. The login is the host's to supply
          // (reviewLogin), used to build the script in memory only.
          // First: is the guest still running the revision this check was
          // queued for? A newer deploy in between makes the answer about a
          // different application — recorded as superseded, never certified.
          const want = p.origin?.revision;
          if (want && (want.commit || want.buildId)) {
            const rev = await guest('read_revision', `git -C '${String(p.appDir || '/srv/app')}' rev-parse HEAD 2>/dev/null | sed 's/^/REV_COMMIT:/'; [ -f '${String(p.appDir || '/srv/app')}/public/build-id.txt' ] && sed 's/^/REV_BUILD:/' '${String(p.appDir || '/srv/app')}/public/build-id.txt' | head -1\n`, { timeoutMs: 15_000 });
            const commit = (String(rev.stdout || '').match(/^REV_COMMIT:([0-9a-f]{40})/m) || [])[1] || null;
            const build = (String(rev.stdout || '').match(/^REV_BUILD:(\S+)/m) || [])[1] || null;
            const mismatch = (want.commit && commit && want.commit !== commit) || (want.buildId && build && want.buildId !== build);
            if (mismatch) {
              obs.credentialUse = { verified: null, outcome: CREDENTIAL_USE_OUTCOMES.superseded, detail: `the guest runs ${commit ? commit.slice(0, 10) : '?'}/${build || '?'}, not the revision this check was queued for (${want.commit ? want.commit.slice(0, 10) : '?'}/${want.buildId || '?'}); that revision was never verified` };
              event('step', `${obs.credentialUse.outcome}: ${obs.credentialUse.detail}`, { outcome: 'superseded' }, 'verify_credential_use');
              const originJob = p.origin?.jobId && getJob(db, p.origin.jobId);
              if (originJob) recordVerificationRung(db, { id: p.origin.jobId, rung: p.origin.rung === 'post_failure' ? 'post_failure_credential_use' : 'credential_use_verified', value: null, detail: `superseded: ${obs.credentialUse.detail}`, by: owner, nowMs: nowMs() });
              break;
            }
          }
          if (!p.guard) {
            obs.credentialUse = { verified: null, outcome: CREDENTIAL_USE_OUTCOMES.not_applicable, detail: 'not applicable: no data guard, nothing to read back' };
          } else {
            let login = null;
            try { login = reviewLogin ? await reviewLogin(container) : null; } catch (e) { login = null; log('reviewLogin', e?.message || e); }
            if (!login?.email || !login?.password) {
              obs.credentialUse = { verified: null, outcome: CREDENTIAL_USE_OUTCOMES.no_verification_credentials, detail: 'no review-account login is available for this app on this host; the application-owned credential check could not run' };
            } else {
              const r = await guest('verify_credential_use', credentialUseScript(webPort, login), { timeoutMs: 45_000 });
              obs.credentialUse = interpretCredentialUse(r.stdout);
            }
          }
          event('step', `${obs.credentialUse.outcome}: ${obs.credentialUse.detail}`, { outcome: obs.credentialUse.outcome, verified: obs.credentialUse.verified }, 'verify_credential_use');
          // Recorded on the deploy this verifies, as its own rung.
          const origin = p.origin?.jobId;
          if (origin && getJob(db, origin)) {
            const originVerification = parseJson(getJob(db, origin).verification_json) || {};
            const state = verificationState({ ...(originVerification.facts || {}), credentialUseVerified: obs.credentialUse.verified, pendingRungs: [], deferredReason: obs.credentialUse.verified == null ? obs.credentialUse.detail : null }).state;
            const rungName = p.origin?.rung === 'post_failure' ? 'post_failure_credential_use' : 'credential_use_verified';
            recordVerificationRung(db, { id: origin, rung: rungName, value: obs.credentialUse.verified, detail: `${obs.credentialUse.outcome}: ${obs.credentialUse.detail}`, by: owner, state: rungName === 'credential_use_verified' ? state : null, nowMs: nowMs() });
            // A recovery's follow-up also lands on the deploy it recovered.
            for (const alsoId of (Array.isArray(p.origin?.also) ? p.origin.also : [])) if (alsoId !== origin && getJob(db, alsoId)) recordVerificationRung(db, { id: alsoId, rung: rungName, value: obs.credentialUse.verified, detail: `${obs.credentialUse.outcome}: ${obs.credentialUse.detail} (after recovery job ${origin})`, by: owner, nowMs: nowMs() });
          }
          break;
        }
        default:
          return fin('refused', 'invalid', `unknown step '${step}'`);
      }
    }
    // A verify_app that only carries the application rung reports that rung's
    // outcome as its own verification; a fuller plan reports the ladder.
    const verification = steps.length === 1 && steps[0] === 'verify_credential_use'
      ? { state: obs.credentialUse.verified === true ? 'credential_use_verified' : obs.credentialUse.verified === false ? 'recovery_required' : 'app_healthy', outcome: obs.credentialUse.outcome, label: obs.credentialUse.detail, failedAt: obs.credentialUse.verified === false ? 'credential_use_verified' : null, next: obs.credentialUse.verified === false ? 'the stored rows decrypt under the configured key but the running application cannot read the credential: restart the unit from the current unit file and re-verify; if it persists, the process is not loading the configured key' : null, observations: { credentialUse: obs.credentialUse } }
      : verificationFromObservations(obs);
    const status = verification.state === 'recovery_required' ? 'recovery_required' : 'succeeded';
    // A recovery that brought the app up still owes the application-owned
    // check the interrupted deploy never reached: queued here, before the
    // recovery reports done, landing on the recovery AND on that deploy.
    let verificationJobId = null;
    if (job.kind === 'recover_app' && status === 'succeeded' && p.guard) {
      const follow = createJob(db, {
        kind: 'verify_app', app: job.app,
        plan: { steps: ['verify_credential_use'], params: { container, webPort, unit, environmentFile: envFile, guard: p.guard, runDir, appDir: p.appDir || undefined, origin: { jobId: job.id, kind: 'recover_app', rung: 'credential_use_verified', revision: null, also: p.origin?.jobId ? [p.origin.jobId] : [] } } },
        configRefs: { origin: { jobId: job.id } }, requestedBy: 'recovery', via: 'system', reason: `application-owned credential check after recovery ${job.id}${p.origin?.jobId ? ` of deploy ${p.origin.jobId}` : ''}`, nowMs: nowMs(),
      });
      verificationJobId = follow.id;
      recordProgress(db, { id: job.id, owner, epoch, progress: { verification_job_id: follow.id }, nowMs: nowMs() });
    }
    const result = fin(status, verification.outcome || verification.state, `${container}: ${verification.label}${verification.deferredReason ? ` (${verification.deferredReason})` : ''}${verificationJobId ? ` (application-owned check pending → job ${verificationJobId})` : ''}`, verification);
    noteOrigin(db, p, job, result, nowMs());
    return { ...result, verificationJobId };
  } catch (e) {
    if (e instanceof FencedError || e?.code === 'FENCED') { log('fenced', job.id); return { status: 'fenced', outcome: null, verification: null }; }
    if (e instanceof CancelledError || e?.code === 'CANCELLED') return fin('cancelled', 'cancelled', e.message, null);
    if (e instanceof ContainmentUnavailableError || e?.code === 'CONTAINMENT_UNAVAILABLE') {
      // Nothing ran in the guest; the lease is released (nothing to protect)
      // and the job records exactly what the guest lacks.
      return fin('recovery_required', 'containment_unavailable', e.message, { state: 'recovery_required', failedAt: 'containment', next: `give ${container} a process-containment mechanism: a running systemd with systemd-run (the provisioned guest image has it), or a writable cgroup tree; then retry` });
    }
    if (e?.code === 'PREVIOUS_WRITER_ALIVE') {
      // Recorded, and the lease is KEPT and flagged: every conflicting
      // operation is refused with this reason until an operator (or a
      // later reap that succeeds) resolves it.
      keepLease = true;
      const r = fin('recovery_required', 'previous_writer_alive', `${e.message}; the app's lease is kept and flagged stale — stop the surviving processes in the guest (the scope units and cgroups recorded under ${runDir}) and retry`, { state: 'recovery_required', failedAt: 'containment', next: `stop the surviving deploy processes in ${container} (the scope units / cgroups recorded under ${runDir}: systemctl kill --kill-whom=all <scope>, or echo 1 > <cgroup>/cgroup.kill; never the application unit) and retry the operation` });
      markLockStale(db, { app: job.app, nowMs: nowMs(), recoveryJobId: job.id });
      return r;
    }
    const verification = verificationFromObservations(obs);
    return fin('failed', 'error', sanitizeReason(e?.message || String(e)), verification);
  } finally {
    if (!keepLease) releaseLock(db, { app: job.app, owner, epoch: lockEpoch });
  }
}

// reuseFrom(db, job, params) → the artifacts a retry's origin and this job's
// own earlier attempt recorded, with their identity, for revalidation.
function reuseFrom(db, job, params) {
  const out = [];
  const add = (row) => { for (const g of (parseJson(row?.progress_json) || {}).generated || []) out.push({ kind: g.kind, name: g.name, where: g.where || null, sha256: g.sha256 || null, bytes: g.bytes ?? null, created_at: g.created_at || null }); };
  const originId = job.retry_of || params?.retryOf || null;
  if (originId) { const origin = getJob(db, String(originId)); if (origin && origin.app === job.app && origin.kind === job.kind) add(origin); }
  add(getJob(db, job.id));
  for (const r of Array.isArray(params?.reuse) ? params.reuse : []) if (r && r.kind && r.name && !out.some((o) => o.kind === r.kind && o.name === r.name)) out.push({ kind: r.kind, name: r.name, where: r.where || null, sha256: r.sha256 || null, bytes: r.bytes ?? null, created_at: r.created_at || null });
  return out;
}

function defaultSteps(kind) {
  if (kind === 'deploy') return [];
  if (kind === 'recover_app') return ['start_unit', 'probe_port', 'health_check', 'verify_credential'];
  if (kind === 'verify_app') return ['unit_status', 'probe_port', 'health_check', 'verify_credential'];
  return ['unit_status', 'probe_port'];
}

function noteOrigin(db, params, job, result, nowMs) {
  const origin = params?.origin?.jobId;
  if (!origin || !getJob(db, origin)) return;
  appendEvent(db, { jobId: origin, kind: 'recovery_result', phase: null, message: `${job.kind} job ${job.id}: ${result.status} — ${result.verification?.label || result.outcome}`, data: { follow_up_job: job.id, kind: job.kind, state: result.verification?.state || null }, nowMs });
}

// ── the loop ────────────────────────────────────────────────────────────

export async function runOnce(deps, { max = 5, reconcileFirst = true, kinds = [...RUNNER_JOB_KINDS] } = {}) {
  const { db, owner } = deps;
  const out = { reconciled: null, ran: [] };
  if (deps.heartbeat !== false) {
    const who = parseOwner(owner) || {};
    try { runnerHeartbeat(db, { owner, host: who.host || null, pid: who.pid || null, version: deps.version || null, nowMs: deps.nowMs ? deps.nowMs() : Date.now() }); } catch { /* */ }
  }
  if (reconcileFirst) out.reconciled = reconcile({ db, owner, nowMs: deps.nowMs ? deps.nowMs() : Date.now(), log: deps.log });
  for (let i = 0; i < max; i += 1) {
    const job = claimNextJob(db, { owner, kinds, leaseMs: LEASE_MS, nowMs: deps.nowMs ? deps.nowMs() : Date.now() });
    if (!job) break;
    deps.log?.('claimed', job.id, job.kind, job.app);
    const r = await executeJob(job, deps);
    out.ran.push({ id: job.id, kind: job.kind, app: job.app, ...r });
    deps.log?.('finished', job.id, r.status, r.verification?.state || r.outcome);
  }
  return out;
}

export function describeOwner(owner) {
  return parseOwner(owner) || { kind: '?', host: '?', pid: 0, instance: '' };
}
