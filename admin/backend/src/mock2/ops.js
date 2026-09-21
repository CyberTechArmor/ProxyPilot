// The three platform operations that moved into runner jobs (A-13, A-14,
// A-15), as the calls their surfaces make: each resolves REFERENCES on the
// server (the project, its guard, the recovery set's origin job, the prior
// attempt for a retry), records the job through the orchestrator and
// observes it to its outcome. The MCP tools, the dashboard route and the
// retry-deploy path call these; none of them runs a guest or host command
// itself any more.

import { containerLockStore } from './container-lock.js';
import { inProcessExecutorDeps, resolveDeployParams } from './deploy.js';
import { submitRunnerJob, resolveRetryOf, runSubmittedJob } from '../lib/setup-engine/orchestrator.js';
import { DUMP_NAME_RE, ENV_COPY_NAME_RE, recoverySetOf, bindRecoverySet } from '../lib/setup-engine/restore-logic.js';
import { getJob } from '../lib/setup-engine/store.js';
import { createHash } from 'node:crypto';

const noStore = () => ({ ok: false, step: 'submit', error: 'the setup engine store is not configured; the operation cannot be recorded, so it is not run' });

// planDigest(plan) → the short digest a confirmation token is bound to, so
// the token confirms THIS plan (dump, environment copy, snapshot, accept
// flags, retry origin) and nothing else.
export function planDigest(plan) {
  const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => { if (v[k] !== undefined) o[k] = canon(v[k]); return o; }, {}) : Array.isArray(v) ? v.map(canon) : v);
  return createHash('sha256').update(JSON.stringify(canon(plan))).digest('hex').slice(0, 16);
}

// resolveRestoreDbPlan({ containerName, projectId, file, environmentCopy, retryOf })
// → { ok, plan, params, retryJob } | { ok: false, error }. Pure resolution:
// names validated, the recovery set bound to a job record of THIS app.
export function resolveRestoreDbPlan(db, { containerName, file, environmentCopy = null, retryOf = null, guard = null, guardKey = null, webPort = 3000, dumpsDir = undefined }) {
  const dumpName = String(file || '').split('/').pop();
  if (!DUMP_NAME_RE.test(dumpName)) return { ok: false, error: `file must be a dump name inside the project's dump directory (from dump_project_db, a deploy's pre-deploy copy or a restore's pre-restore copy)` };
  const envCopyName = environmentCopy ? String(environmentCopy).split('/').pop() : null;
  if (envCopyName && !ENV_COPY_NAME_RE.test(envCopyName)) return { ok: false, error: 'environment_copy must be an environment copy name (environment.pre-<job>), no path' };
  let originJob = null;
  if (envCopyName) {
    // The recovery set's job: the one the dump's name says, verified by
    // what that job recorded for THIS app (bindRecoverySet).
    const hint = recoverySetOf(dumpName);
    originJob = hint.jobId ? getJob(db, hint.jobId) : null;
    const bind = bindRecoverySet({ app: containerName, dumpName, envCopyName, originJob });
    if (!bind.ok) return { ok: false, error: bind.reason };
  }
  const r = resolveRetryOf(db, { jobId: retryOf, app: containerName, kind: 'restore_db' });
  if (r.error) return { ok: false, error: r.error };
  const params = {
    container: containerName, webPort, unit: 'mock2-dev.service', environmentFile: '/etc/environment', appDir: '/srv/app',
    ...(dumpsDir ? { dumpsDir } : {}),
    dump: { name: dumpName },
    envCopy: envCopyName ? { name: envCopyName, originJobId: originJob.id } : null,
    guard: guard || null, guardKey: guardKey || null,
    ...(r.job ? { retryOf: r.job.id } : {}),
  };
  const plan = { container: containerName, dump: dumpName, environment_copy: envCopyName, mode: envCopyName ? 'recovery_set' : 'current_configuration', recovery_set_job: originJob?.id || null, retry_of: r.job?.id || null };
  return { ok: true, plan, params, retryJob: r.job, digest: planDigest(plan) };
}

export async function restoreProjectDb({ containerName, file, environmentCopy = null, retryOf = null, requestedBy = null, via = 'system', onEvent = null, detach = false }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  const refs = await resolveDeployParams({ containerName });
  const res = resolveRestoreDbPlan(db, { containerName, file, environmentCopy, retryOf, guard: refs.guard, guardKey: refs.guardKey || null, webPort: refs.webPort });
  if (!res.ok) return { ok: false, step: 'plan', error: res.error };
  const sub = submitRunnerJob(db, { kind: 'restore_db', app: containerName, params: res.params, configRefs: { dump: res.plan.dump, environmentCopy: res.plan.environment_copy, mode: res.plan.mode, guard: refs.guard || null, webPort: refs.webPort, unit: 'mock2-dev.service', environmentFile: '/etc/environment', appDir: '/srv/app' }, requestedBy, via, retryOf: res.retryJob?.id || null });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  return runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env, onEvent, detach });
}

export function resolveRestoreSnapshotPlan(db, { containerName, snapshot, acceptPartial = false, retryOf = null, managed = false, webPort = null, guard = null }) {
  const r = resolveRetryOf(db, { jobId: retryOf, app: containerName, kind: 'restore_snapshot' });
  if (r.error) return { ok: false, error: r.error };
  const params = { container: containerName, snapshot: String(snapshot), acceptPartial: acceptPartial === true, managed: managed === true, ...(managed ? { webPort: Number(webPort) || 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment', guard: guard || null } : {}), ...(r.job ? { retryOf: r.job.id } : {}) };
  const plan = { container: containerName, restore_to: String(snapshot), accept_partial: acceptPartial === true, retry_of: r.job?.id || null };
  return { ok: true, plan, params, retryJob: r.job, digest: planDigest(plan) };
}

export async function restoreSnapshot({ containerName, snapshot, acceptPartial = false, retryOf = null, requestedBy = null, via = 'system', onEvent = null, detach = false }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  // A guest the registry knows is a managed app: verified up the ladder
  // after the restore; any other guest is restored and reported as Incus
  // sees it.
  const refs = await resolveDeployParams({ containerName });
  const managed = refs.projectId != null;
  const res = resolveRestoreSnapshotPlan(db, { containerName, snapshot, acceptPartial, retryOf, managed, webPort: refs.webPort, guard: refs.guard });
  if (!res.ok) return { ok: false, step: 'plan', error: res.error };
  const sub = submitRunnerJob(db, { kind: 'restore_snapshot', app: containerName, params: res.params, configRefs: { snapshot: res.plan.restore_to, acceptPartial: res.plan.accept_partial, managed, ...(managed ? { guard: refs.guard || null, webPort: refs.webPort, unit: 'mock2-dev.service', environmentFile: '/etc/environment' } : {}) }, requestedBy, via, retryOf: res.retryJob?.id || null });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  return runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env, onEvent, detach });
}

// retryProjectSecrets({ containerName, retryOf }) → { ok, minted, deferred,
// required, reused, jobId } — the retry path's mint as a job. Refused (not
// queued) when nothing can execute it: the deploy that follows reports the
// same unavailability, and it mints on its own when it runs.
export async function retryProjectSecrets({ containerName, retryOf = null, requestedBy = null, via = 'system' }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  const refs = await resolveDeployParams({ containerName });
  const r = resolveRetryOf(db, { jobId: retryOf, app: containerName, kind: 'retry_secrets' });
  if (r.error) return { ok: false, step: 'plan', error: r.error };
  const params = { container: containerName, appDir: refs.appDir, environmentFile: refs.environmentFile, secrets: { configs: refs.secrets.configs }, guard: refs.guard || null, ...(r.job ? { retryOf: r.job.id } : {}) };
  const sub = submitRunnerJob(db, { kind: 'retry_secrets', app: containerName, params, configRefs: { environmentFile: refs.environmentFile, keys: refs.secrets.configs.map((c) => c.key) }, requestedBy, via, retryOf: r.job?.id || null });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  const out = await runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env });
  if (out.step === 'runner_unavailable') {
    // Not left in the queue: the deploy that follows carries the same mint.
    const { cancelQueuedJob } = await import('../lib/setup-engine/store.js');
    cancelQueuedJob(db, { id: out.jobId, outcome: 'runner_unavailable', reason: `${out.error}; the deploy that follows mints the same keys when it runs`, by: 'orchestrator' });
    return { ...out, refused: true, queued: false };
  }
  return out;
}
