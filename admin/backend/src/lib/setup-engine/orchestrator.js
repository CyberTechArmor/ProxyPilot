// Setup engine — the ORCHESTRATOR every caller of a runner job goes
// through (the restores, the retry mint; the deploy keeps its own equivalent
// in mock2/deploy.js): validate and record the job, decide who executes
// from the installation policy, and observe it to its terminal row.
//
//   submitRunnerJob(db, spec)       → { job } | { error, code, holder }
//   resolveRetryOf(db, { jobId, app, kind }) → the prior job row this app
//                                    may retry, or an error (server-side,
//                                    ownership checked: same app, same kind)
//   runSubmittedJob(db, job, opts)  → the outcome the caller reports
//
// A restore (EXCLUSIVE_JOB_KINDS) is REFUSED at submission while the app's
// lease is held or any mutating job of the app is open: it must never start
// minutes later under a state its operator never looked at. With no
// executor available (policy runner-required, no live runner) an exclusive
// job is refused as well — cancelled on the record, never left queued; the
// other kinds queue and are reported unavailable, as the deploy is.

import { createJob, getJob, readLock, openJobsFor, cancelQueuedJob } from './store.js';
import { validateRunnerJob, EXCLUSIVE_JOB_KINDS, MUTATING_JOB_KINDS, lockVerdict, parseJson, TERMINAL_STATUS } from './logic.js';
import { executionMode, drainRunnerJobsInProcess, waitForJob } from './backend.js';

const describe = (kind) => (kind === 'restore_db' || kind === 'restore_snapshot' ? 'the restore' : kind === 'guest_setup' ? 'the guest setup' : `the ${String(kind).replace('_', ' ')}`);

export function submitRunnerJob(db, { kind, app, params, configRefs = {}, requestedBy = null, via = 'system', retryOf = null, reason = null, nowMs = Date.now() }) {
  const spec = { kind, app, plan: { steps: [], params: { ...params, container: app } } };
  const v = validateRunnerJob(spec);
  if (!v.ok) return { error: v.reason, code: 'INVALID' };
  if (EXCLUSIVE_JOB_KINDS.includes(kind)) {
    const lock = readLock(db, app);
    if (lock) {
      const verdict = lockVerdict({ lock, owner: null, nowMs });
      const holder = `${lock.operation} (${lock.owner})`;
      if (verdict.reason === 'stale') return { error: `a previous ${lock.operation} for ${app} did not finish (holder ${lock.owner}); recovery is required before ${describe(kind)} — see the setup jobs for this app`, code: 'CONTAINER_LOCK_STALE', holder };
      return { error: `${holder} is in progress for ${app} — ${describe(kind)} was refused before any change; submit it again when it finishes`, code: 'CONTAINER_BUSY', holder };
    }
    const open = openJobsFor(db, app, [...MUTATING_JOB_KINDS]);
    if (open.length) return { error: `${open[0].kind} job ${open[0].id} is ${open[0].status} for ${app} — ${describe(kind)} was refused before any change; submit it again when it finishes`, code: 'CONTAINER_BUSY', holder: `${open[0].kind} (${open[0].status})` };
  }
  const job = createJob(db, { kind, app, plan: spec.plan, configRefs, requestedBy, via, retryOf, reason, nowMs });
  return { job };
}

export function resolveRetryOf(db, { jobId, app, kind }) {
  if (jobId == null || jobId === '') return { job: null };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(jobId))) return { error: 'retry_of must be a job id' };
  const prior = getJob(db, String(jobId));
  if (!prior) return { error: `retry_of: no such job ${jobId}` };
  if (prior.app !== app) return { error: `retry_of: job ${jobId} belongs to ${prior.app}, not ${app}` };
  if (prior.kind !== kind) return { error: `retry_of: job ${jobId} is a ${prior.kind}, not a ${kind}` };
  if (!TERMINAL_STATUS.includes(prior.status)) return { error: `retry_of: job ${jobId} is still ${prior.status}` };
  return { job: prior };
}

// runSubmittedJob(db, job, { store, deps, env, detach, awaitKick, onEvent, waitMs })
//   → { ok, step, jobId, executor, policy, queued?, refused?, ...result }
export async function runSubmittedJob(db, job, { store = null, deps = null, env = process.env, detach = false, awaitKick = false, onEvent = null, waitMs = null, nowMs = () => Date.now() } = {}) {
  const mode = executionMode(db, { env, nowMs: nowMs() });
  const jobId = job.id;
  if (mode.executor === 'none') {
    if (EXCLUSIVE_JOB_KINDS.includes(job.kind)) {
      cancelQueuedJob(db, { id: jobId, outcome: 'runner_unavailable', reason: `no host runner is live (policy ${mode.policy.mode}); ${describe(job.kind)} is not left queued to run later under a state nobody looked at — it was refused before any change`, by: 'orchestrator', nowMs: nowMs() });
      return { ok: false, step: 'runner_unavailable', refused: true, jobId, policy: mode.policy.mode, executor: 'none', error: `no host runner is live (policy ${mode.policy.mode}); ${describe(job.kind)} was refused before any change — start proxypilot-setup-runner.service and submit it again` };
    }
    return { ok: false, step: 'runner_unavailable', queued: true, jobId, policy: mode.policy.mode, executor: 'none', error: `no host runner is live (policy ${mode.policy.mode}); ${job.kind} job ${jobId} is queued and will run when proxypilot-setup-runner.service is back — see /api/setup/jobs/${jobId}` };
  }
  if (detach) {
    // A detached submission under the in-process executor still has to be
    // run by somebody: kick the drain without waiting for it (the periodic
    // drain in index.js would pick it up later anyway).
    if (mode.executor === 'backend' && deps) {
      const kick = (async () => { await drainRunnerJobsInProcess(db, { ...deps, env, max: 3, nowMs }); await drainRunnerJobsInProcess(db, { ...deps, env, max: 3, nowMs, kinds: ['verify_app'] }); })();
      kick.catch(() => {});
      if (awaitKick) await kick;
    }
    return { ok: true, submitted: true, jobId, executor: mode.executor, policy: mode.policy.mode, runner: mode.runner?.owner || null };
  }
  if (mode.executor === 'backend') {
    if (!deps) return { ok: false, step: 'submit', jobId, error: 'no in-process executor dependencies were supplied' };
    await drainRunnerJobsInProcess(db, { ...deps, env, max: 3, nowMs });
    await drainRunnerJobsInProcess(db, { ...deps, env, max: 3, nowMs, kinds: ['verify_app'] });
  }
  const row = await waitForJob(db, jobId, { onEvent, timeoutMs: waitMs ?? (mode.executor === 'backend' ? 5_000 : 45 * 60 * 1000), nowMs });
  if (!row) return { ok: false, step: 'wait', jobId, executor: mode.executor, policy: mode.policy.mode, error: `${job.kind} job ${jobId} did not finish in time; it may still be running — see /api/setup/jobs/${jobId}` };
  return resultFromJob(row, mode);
}

export function resultFromJob(row, mode = null) {
  const progress = parseJson(row.progress_json) || {};
  const result = progress.result && typeof progress.result === 'object' ? progress.result : null;
  const base = { jobId: row.id, status: row.status, outcome: row.outcome, reason: row.reason, executor: mode?.executor || null, policy: mode?.policy?.mode || null, verificationJobId: progress.verification_job_id || null };
  if (row.status === 'succeeded') return { ok: true, step: result?.step || row.outcome || 'completed', ...(result || {}), ...base };
  return { ok: false, step: result?.step || progress.failed_step || row.phase || row.kind, error: row.reason || `${row.kind} ${row.status}`, ...(result || {}), ...base };
}
