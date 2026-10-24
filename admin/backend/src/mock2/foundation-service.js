// Mock2 application foundation — the HOST ORCHESTRATION of per-deployment
// switches (docs/features/app-foundation.md § "Feature switches and their
// rules"). The rules are foundation-logic.js; the state is foundation-store.js;
// the guest is driven through foundation-stack.js (psql over the socket, the
// compose services, the app's own `foundation` CLI and detached job runs).
//
// A provider switch is never applied blind:
//   stage `pending` (+ pending.* credentials) → sync it into the app database →
//   test it from INSIDE the guest (storage-test / embeddings-test --pending) →
//   then either promote at once, or start the job that has to finish first
//   (storage_migrate copies every object, verified; reembed builds and
//   validates a new index) and promote when it succeeds.
// Promotion: pending → active in mock2.db, then one app-database transaction
// (feature rows, sealed secrets, and for a reembed the index swap); if the app
// side refuses, mock2.db is put back. A service no longer used is stopped; its
// volume is always kept. No switch deletes data.
//
// One job per deployment at a time (FOUNDATION_JOB_RUNNING); one write at a
// time per deployment in this process (FOUNDATION_BUSY). Jobs are polled by
// sweepFoundationJobs (index.js, every minute) and on every GET.
//
// Terminology (risk R7): nothing here is named "agent".

import { randomBytes } from 'node:crypto';
import * as store from './foundation-store.js';
import {
  CODES, BUNDLED_APP_IDENTITY, refusal, planStorageAction, planEmbeddingsAction, serviceStillUsed, interpretCliTest,
  parseHealthOutput, projectFoundation, projectJob, credentialSecretNames, parseJsonObject, parseJsonRows, newJobId, newIndexId,
  buildJobInsertSql, buildJobPollSql, buildActiveIndexSql, buildHealthReadSql, buildCancelJobSql, promoteIndexStatements,
  SQL_MARKERS, parseMarker, sanitizeDetail, redactSecrets, isValidJobId,
} from './foundation-logic.js';
import { SECRET_NAMES } from './foundation-contract.js';

const APP_DIR = '/srv/app';
const nowIso = () => new Date().toISOString();
const stack = () => import('./foundation-stack.js');
// A job whose app-side row has not moved for this long is relaunched (job-run
// is resumable and idempotent), at most RELAUNCH_MAX times.
export const JOB_STALE_MS = 10 * 60_000;
export const RELAUNCH_MAX = 5;
const HEALTH_CACHE_MS = 10_000;
const REFRESH_MIN_MS = 5_000;

const FEATURE_OF_JOB = Object.freeze({ storage_migrate: 'storage', reembed: 'embeddings' });

// ---- per-deployment write lock (this process) --------------------------------
const busy = new Set();
async function exclusive(projectId, fn) {
  const key = Number(projectId);
  if (busy.has(key)) return refusal(CODES.FOUNDATION_BUSY, 'Another foundation change for this deployment is in progress; try again in a moment.', []);
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

function requireFoundation(projectId, { online = true } = {}) {
  const project = store.getFoundationProject(projectId);
  if (!project) return { error: refusal(CODES.PROJECT_NOT_FOUND, 'Project not found', [], 404) };
  if (!project.foundation_version) {
    return { error: refusal(CODES.NOT_A_FOUNDATION_PROJECT, 'This project was created before the application foundation; it keeps its native stack and has no foundation switches.', []) };
  }
  if (online && (project.lifecycle !== 'active' || !project.container_name)) {
    return { error: refusal(CODES.FOUNDATION_UNAVAILABLE, 'The project is not online; wake it first, then change its foundation.', [{ action: 'wake' }]) };
  }
  return { project };
}

function currentFor(projectId, feature) {
  const rows = store.readFeatureRows(projectId);
  const job = store.activeJobFor(projectId);
  return {
    rows,
    current: { ...rows[feature], secretNames: new Set(store.listSecretNames(projectId)), activeJob: job ? { id: job.id, kind: job.kind } : null },
  };
}

async function setService(project, name, action) {
  try {
    const { setFoundationService } = await stack();
    const r = await setFoundationService(project.container_name, name, action);
    // A throw, { ok: false } or a non-zero exit code are all failures.
    if (r && typeof r === 'object' && (r.ok === false || (typeof r.code === 'number' && r.code !== 0))) {
      return { ok: false, error: redactSecrets(String(r.error || r.stderr || `${action} ${name} failed`)).slice(-300) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: redactSecrets(e?.message || String(e)).slice(0, 300) };
  }
}

async function bundledObjectCount(project) {
  try {
    const creds = store.bundledAdminCredentials(project.id);
    if (!creds) return null;
    const { bundledStorageObjectCount } = await stack();
    const n = await bundledStorageObjectCount(project.container_name, creds);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
}

// ---- health -----------------------------------------------------------------

const healthCache = new Map();
async function readHealth(project, { fresh = false } = {}) {
  const cached = healthCache.get(project.id);
  if (!fresh && cached && Date.now() - cached.at < HEALTH_CACHE_MS) return cached.value;
  let value;
  try {
    const r = await store.appPsql(project.container_name, buildHealthReadSql(), { timeoutMs: 15_000 });
    value = Number(r?.code) === 0 && parseMarker(r.stdout, SQL_MARKERS.ok).length
      ? { rows: parseJsonRows(r.stdout).map((h) => ({ component: h.component, status: h.status, detail: sanitizeDetail(h.detail), checked_at: h.checked_at || null })), error: null }
      : { rows: [], error: 'the app database did not answer' };
  } catch (e) {
    value = { rows: [], error: redactSecrets(e?.message || String(e)).slice(0, 200) };
  }
  healthCache.set(project.id, { at: Date.now(), value });
  return value;
}

// Run the real probes now (the app CLI writes mock2_foundation.health).
async function probeHealth(project) {
  try {
    const { foundationCli } = await stack();
    const r = await foundationCli(project.container_name, ['health', '--json'], { appDir: APP_DIR, timeoutMs: 90_000 });
    const rows = parseHealthOutput(r?.stdout);
    const value = rows.length ? { rows, error: null } : { rows: [], error: `the health probe did not report (exit ${r?.code})` };
    healthCache.set(project.id, { at: Date.now(), value });
    return value;
  } catch (e) {
    const value = { rows: [], error: redactSecrets(e?.message || String(e)).slice(0, 200) };
    healthCache.set(project.id, { at: Date.now(), value });
    return value;
  }
}

function shape(project, health) {
  return projectFoundation({
    project,
    rows: store.readFeatureRows(project.id),
    secretNames: store.listSecretNames(project.id),
    jobs: store.listJobs(project.id, 10),
    health: health?.rows || null,
    healthError: health?.error || null,
  });
}

// GET /foundation
const lastRefresh = new Map();
export async function getFoundation(projectId, { refresh = true } = {}) {
  const project = store.getFoundationProject(projectId);
  if (!project) return null;
  if (!project.foundation_version) return projectFoundation({ project });
  if (project.lifecycle !== 'active' || !project.container_name) return shape(project, { rows: [], error: 'the project is not online' });
  if (refresh && Date.now() - (lastRefresh.get(project.id) || 0) > REFRESH_MIN_MS) {
    lastRefresh.set(project.id, Date.now());
    for (const job of store.listJobs(project.id, 5)) if (['queued', 'running'].includes(job.state)) await refreshJob(project, job).catch(() => {});
  }
  return shape(project, await readHealth(project));
}

// POST /foundation/health
export async function runHealth(projectId) {
  const { project, error } = requireFoundation(projectId);
  if (error) return error;
  return { ok: true, foundation: shape(project, await probeHealth(project)) };
}

// ---- staging and testing a pending provider ------------------------------------

function stagePending(project, feature, plan) {
  const pid = project.id;
  const pendingNames = credentialSecretNames(feature, { pending: true });
  store.deleteSecrets(pid, pendingNames);
  if (plan.credentials === 'supplied') {
    for (const [name, value] of Object.entries(plan.values)) store.writeSecret(pid, name, value);
  } else if (plan.credentials === 'reuse_active') {
    for (const active of credentialSecretNames(feature)) store.copySecret(pid, active, `pending.${active}`);
  } else if (plan.credentials === 'bundled_identity') {
    store.copySecret(pid, BUNDLED_APP_IDENTITY.accessKeyId, `pending.${SECRET_NAMES.storageAccessKeyId}`);
    store.copySecret(pid, BUNDLED_APP_IDENTITY.secretAccessKey, `pending.${SECRET_NAMES.storageSecretAccessKey}`);
  }
  const row = store.readFeatureRows(pid)[feature];
  store.writeFeature(pid, feature, { ...row, pending: { ...plan.pending, staged_at: nowIso(), test: null, job_id: null } });
}

function updatePending(projectId, feature, patch) {
  const row = store.readFeatureRows(projectId)[feature];
  if (!row.pending) return;
  store.writeFeature(projectId, feature, { ...row, pending: { ...row.pending, ...patch } });
}

// Abandon a staged switch: pending cleared, pending.* credentials deleted.
function clearPending(projectId, feature) {
  store.deleteSecrets(projectId, credentialSecretNames(feature, { pending: true }));
  const row = store.readFeatureRows(projectId)[feature];
  if (row.pending) store.writeFeature(projectId, feature, { ...row, pending: null });
}

async function testPending(project, feature, knownValues) {
  try {
    const { foundationCli } = await stack();
    const r = await foundationCli(project.container_name, [feature === 'storage' ? 'storage-test' : 'embeddings-test', '--pending', '--json'], { appDir: APP_DIR, timeoutMs: 90_000 });
    return interpretCliTest(r, knownValues);
  } catch (e) {
    return { ok: false, status: 'unavailable', detail: { message: redactSecrets(e?.message || String(e), knownValues).slice(0, 300) } };
  }
}

// ---- promotion ----------------------------------------------------------------

// pending → active for one feature, mock2.db first, then the app database in
// one transaction (with the index swap for a reembed). Restores mock2.db when
// the app side refuses.
async function promote(project, feature, { indexId = null } = {}) {
  const pid = project.id;
  const activeNames = credentialSecretNames(feature);
  const pendingNames = credentialSecretNames(feature, { pending: true });
  const snap = store.snapshotFeature(pid, feature, [...activeNames, ...pendingNames]);
  const row = store.readFeatureRows(pid)[feature];
  if (!row.pending?.provider) return { ok: false, error: 'nothing is staged to promote' };
  const pending = row.pending;
  // Active credentials become exactly the pending ones (a provider that takes
  // none leaves none behind).
  activeNames.forEach((active, i) => {
    if (store.hasSecret(pid, pendingNames[i])) store.copySecret(pid, pendingNames[i], active);
    else store.deleteSecrets(pid, [active]);
  });
  store.deleteSecrets(pid, pendingNames);
  store.writeFeature(pid, feature, { state: 'on', provider: pending.provider, config: pending.config || {}, pending: null });
  const s = await store.syncFoundationToApp(pid, { statements: indexId ? promoteIndexStatements(indexId) : [] });
  if (!s.ok) {
    store.restoreFeature(pid, snap);
    return { ok: false, error: s.error };
  }
  const after = store.readFeatureRows(pid)[feature];
  const service = feature === 'storage' ? 'storage' : 'embeddings';
  let serviceNote = null;
  if (!serviceStillUsed(feature, after)) {
    const stop = await setService(project, service, 'stop');
    if (!stop.ok) serviceNote = `the ${service} service could not be stopped: ${stop.error}`;
  }
  healthCache.delete(pid);
  await probeHealth(project).catch(() => {});
  return { ok: true, generation: s.generation, ...(serviceNote ? { warning: serviceNote } : {}) };
}

// ---- jobs -----------------------------------------------------------------------

async function startJob(project, feature, { kind, params, index = null }, { userId }) {
  const pid = project.id;
  const id = newJobId(randomBytes(10).toString('hex'));
  store.insertJob({ id, projectId: pid, kind, params, createdBy: userId });
  updatePending(pid, feature, { job_id: id });
  let r;
  try { r = await store.appPsql(project.container_name, buildJobInsertSql({ job: { id, kind, params }, index }), { timeoutMs: 30_000 }); }
  catch (e) { r = { code: -1, stderr: e?.message || String(e) }; }
  if (Number(r?.code) !== 0 || !parseMarker(r.stdout, SQL_MARKERS.ok).length) {
    store.updateJob(id, { state: 'failed', error: `the job could not be recorded in the app database: ${redactSecrets(String(r?.stderr || r?.stdout || '')).slice(-200)}`, finished: true });
    updatePending(pid, feature, { job_id: null });
    return refusal(CODES.FOUNDATION_UNAVAILABLE, 'The app database did not accept the job; nothing was switched.', [{ action: 'retry' }]);
  }
  try {
    const { runFoundationJobDetached } = await stack();
    await runFoundationJobDetached(project.container_name, id, { appDir: APP_DIR });
    store.updateJob(id, { progress: { launched_at: nowIso(), launches: 1 } });
  } catch (e) {
    store.updateJob(id, { state: 'failed', error: `the job could not be started in the guest: ${redactSecrets(e?.message || String(e)).slice(0, 200)}`, finished: true });
    updatePending(pid, feature, { job_id: null });
    await store.appPsql(project.container_name, buildCancelJobSql({ jobId: id, indexId: index?.id || null })).catch(() => {});
    return refusal(CODES.FOUNDATION_UNAVAILABLE, 'The job could not be started in the guest; nothing was switched.', [{ action: 'retry' }]);
  }
  return { ok: true, job: projectJob(store.getJob(id)) };
}

async function stopIfUnused(project, feature) {
  const row = store.readFeatureRows(project.id)[feature];
  if (!serviceStillUsed(feature, row)) await setService(project, feature, 'stop');
}

// Poll one active job against the app database; promote when it succeeded.
export async function refreshJob(project, job) {
  if (!job || !['queued', 'running'].includes(job.state)) return job;
  const params = parseJsonObject(job.params_json, {}) || {};
  const feature = FEATURE_OF_JOB[job.kind];
  let r;
  try { r = await store.appPsql(project.container_name, buildJobPollSql({ jobId: job.id, indexId: params.target_index || null }), { timeoutMs: 20_000 }); }
  catch (e) { r = { code: -1, stderr: e?.message || String(e) }; }
  if (Number(r?.code) !== 0 || !parseMarker(r.stdout, SQL_MARKERS.ok).length) {
    return store.updateJob(job.id, { progress: { last_poll_error: redactSecrets(String(r?.stderr || 'no answer')).slice(-200), last_poll_at: nowIso() } });
  }
  const rows = parseJsonRows(r.stdout);
  const appJob = rows.find((x) => x.type === 'job');
  const index = rows.find((x) => x.type === 'index') || null;
  if (!appJob) {
    updatePending(project.id, feature, { job_id: null });
    return store.updateJob(job.id, { state: 'failed', error: 'the job row is missing from the application database', finished: true });
  }
  const appProgress = {};
  for (const [k, v] of Object.entries(appJob.progress || {})) if (v == null || ['number', 'boolean', 'string'].includes(typeof v)) appProgress[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  const hostProgress = parseJsonObject(job.progress_json, {}) || {};
  if (appJob.state === 'queued' || appJob.state === 'running') {
    const updated = Date.parse(appJob.updated_at || '') || 0;
    if (updated && Date.now() - updated > JOB_STALE_MS) {
      const launches = Number(hostProgress.launches) || 0;
      if (launches >= RELAUNCH_MAX) {
        await store.appPsql(project.container_name, buildCancelJobSql({ jobId: job.id, indexId: params.target_index || null })).catch(() => {});
        updatePending(project.id, feature, { job_id: null });
        return store.updateJob(job.id, { state: 'failed', error: `the job stopped making progress (relaunched ${launches} times)`, finished: true, progress: appProgress });
      }
      try {
        const { runFoundationJobDetached } = await stack();
        await runFoundationJobDetached(project.container_name, job.id, { appDir: APP_DIR });
      } catch { /* the next sweep tries again */ }
      return store.updateJob(job.id, { state: appJob.state, progress: { ...appProgress, launches: launches + 1, relaunched_at: nowIso(), last_poll_at: nowIso() } });
    }
    return store.updateJob(job.id, { state: appJob.state, progress: { ...appProgress, last_poll_at: nowIso() } });
  }
  if (appJob.state === 'failed' || appJob.state === 'cancelled') {
    // The switch stays staged (tested) so it can be tried again; a service
    // started only for the new provider is stopped again.
    updatePending(project.id, feature, { job_id: null });
    await stopIfUnused(project, feature);
    return store.updateJob(job.id, { state: appJob.state, error: appJob.error || (appJob.state === 'failed' ? 'the job failed' : null), progress: appProgress, finished: true });
  }
  // succeeded — promote (the switch is done only once promoted).
  const row = store.readFeatureRows(project.id)[feature];
  if (row.pending?.job_id !== job.id) {
    return store.updateJob(job.id, { state: 'failed', error: 'the job finished but the switch it served is no longer staged; nothing was promoted', progress: appProgress, finished: true });
  }
  if (job.kind === 'reembed' && !['ready', 'active'].includes(index?.state)) {
    updatePending(project.id, feature, { job_id: null });
    return store.updateJob(job.id, { state: 'failed', error: `the new index did not validate (state ${index?.state || 'missing'}); the active index is unchanged`, progress: appProgress, finished: true });
  }
  const p = await promote(project, feature, { indexId: job.kind === 'reembed' ? params.target_index : null });
  if (!p.ok) return store.updateJob(job.id, { state: 'running', error: `promotion pending: ${p.error}`, progress: { ...appProgress, phase: 'promoting' } });
  return store.updateJob(job.id, { state: 'succeeded', error: null, progress: { ...appProgress, phase: 'promoted', promoted_at: nowIso() }, finished: true });
}

export async function getJob(projectId, jobId, { refresh = true } = {}) {
  if (!isValidJobId(jobId)) return null;
  let job = store.getJob(jobId);
  if (!job || job.project_id !== Number(projectId)) return null;
  const project = store.getFoundationProject(projectId);
  if (refresh && project?.lifecycle === 'active' && project.container_name) job = await refreshJob(project, job).catch(() => job);
  return projectJob(job);
}

export async function cancelJob(projectId, jobId) {
  const { project, error } = requireFoundation(projectId, { online: false });
  if (error) return error;
  return exclusive(project.id, async () => {
    const job = isValidJobId(jobId) ? store.getJob(jobId) : null;
    if (!job || job.project_id !== project.id) return refusal(CODES.JOB_NOT_FOUND, 'Job not found', [], 404);
    if (!['queued', 'running'].includes(job.state)) return refusal(CODES.JOB_NOT_ACTIVE, `The job is already ${job.state}.`, []);
    const params = parseJsonObject(job.params_json, {}) || {};
    let appCancelled = false;
    if (project.lifecycle === 'active' && project.container_name) {
      try {
        const r = await store.appPsql(project.container_name, buildCancelJobSql({ jobId: job.id, indexId: params.target_index || null }));
        appCancelled = Number(r?.code) === 0 && parseMarker(r.stdout, SQL_MARKERS.ok).length > 0;
      } catch { appCancelled = false; }
    }
    // Host-side the job ends here either way: promotion is the host's, so a
    // cancelled job is never promoted, whatever the guest does next.
    store.updateJob(job.id, { state: 'cancelled', finished: true, progress: { cancelled_in_app: appCancelled } });
    const feature = FEATURE_OF_JOB[job.kind];
    clearPending(project.id, feature);
    let note = null;
    if (project.lifecycle === 'active' && project.container_name) {
      const s = await store.syncFoundationToApp(project.id);
      if (!s.ok) note = `the app database was not told: ${s.error}`;
      await stopIfUnused(project, feature);
    }
    return { ok: true, job: projectJob(store.getJob(job.id)), app_cancelled: appCancelled, ...(note ? { warning: note } : {}) };
  });
}

// Every active job, every deployment (index.js, once a minute). Never throws.
export async function sweepFoundationJobs() {
  const out = { polled: 0, errors: 0 };
  let jobs = [];
  try { jobs = store.listActiveJobs(); } catch { return out; }
  for (const job of jobs) {
    try {
      const project = store.getFoundationProject(job.project_id);
      if (!project) { store.updateJob(job.id, { state: 'failed', error: 'the project no longer exists', finished: true }); continue; }
      if (project.lifecycle !== 'active' || !project.container_name) continue;
      await refreshJob(project, job);
      out.polled += 1;
    } catch { out.errors += 1; }
  }
  return out;
}

// ---- on / off --------------------------------------------------------------------

async function setState(project, feature, plan) {
  const pid = project.id;
  const before = store.snapshotFeature(pid, feature);
  const row = store.readFeatureRows(pid)[feature];
  if (plan.state === 'on' && plan.service) {
    const s = await setService(project, plan.service.name, 'start');
    if (!s.ok) return refusal(CODES.FOUNDATION_UNAVAILABLE, `The ${plan.service.name} service could not be started: ${s.error}`, [{ action: 'on' }]);
  }
  store.writeFeature(pid, feature, { ...row, state: plan.state });
  const sync = await store.syncFoundationToApp(pid);
  if (!sync.ok) {
    store.restoreFeature(pid, before);
    if (plan.state === 'on' && plan.service) await setService(project, plan.service.name, 'stop');
    return refusal(CODES.FOUNDATION_UNAVAILABLE, `The app database could not be updated, so nothing changed: ${sync.error}`, [{ action: plan.state }]);
  }
  let warning = null;
  if (plan.state === 'off' && plan.service) {
    const s = await setService(project, plan.service.name, 'stop');
    if (!s.ok) warning = `the ${plan.service.name} service could not be stopped (the app no longer uses it): ${s.error}`;
  }
  healthCache.delete(pid);
  await probeHealth(project).catch(() => {});
  return { ok: true, state: plan.state, ...(warning ? { warning } : {}) };
}

// ---- the switch -------------------------------------------------------------------

async function performSwitch(project, feature, plan, { userId }) {
  const pid = project.id;
  const known = Object.values(plan.values || {});
  const activeRow = store.readFeatureRows(pid)[feature];
  stagePending(project, feature, plan);
  if (plan.startService) {
    const s = await setService(project, plan.startService, 'start');
    if (!s.ok) {
      updatePending(pid, feature, { test: { ok: false, status: 'unavailable', detail: { message: s.error }, at: nowIso() } });
      return refusal(CODES.FOUNDATION_UNAVAILABLE, `The ${plan.startService} service could not be started for the test: ${s.error}`, [{ action: 'switch' }]);
    }
  }
  const stopUnused = async () => { if (plan.startService && !serviceStillUsed(feature, activeRow)) await setService(project, plan.startService, 'stop'); };
  const sync = await store.syncFoundationToApp(pid);
  if (!sync.ok) {
    updatePending(pid, feature, { test: { ok: false, status: 'unavailable', detail: { message: sync.error }, at: nowIso() } });
    await stopUnused();
    return refusal(CODES.FOUNDATION_UNAVAILABLE, `The pending provider could not be handed to the app for testing: ${sync.error}`, [{ action: 'switch' }]);
  }
  const test = await testPending(project, feature, known);
  updatePending(pid, feature, { test: { ...test, at: nowIso() } });
  if (!test.ok) {
    await stopUnused();
    if (test.status === 'missing_credentials') {
      return refusal(CODES.MISSING_CREDENTIALS, 'The new provider reports missing credentials; nothing was switched. The switch stays staged until it is tested successfully.', [{ action: 'switch', provider: plan.pending.provider, field: 'credentials' }]);
    }
    return refusal(CODES.PROVIDER_TEST_FAILED, `The new provider failed its test from inside the guest (${test.status}); nothing was switched.${test.detail?.message ? ` ${test.detail.message}` : ''}`, [{ action: 'switch', provider: plan.pending.provider }]);
  }
  if (plan.after === 'promote') {
    const p = await promote(project, feature);
    if (!p.ok) return refusal(CODES.FOUNDATION_UNAVAILABLE, `The switch tested fine but could not be applied: ${p.error}`, [{ action: 'switch' }]);
    return { ok: true, promoted: true, ...(p.warning ? { warning: p.warning } : {}), ...(plan.warnings?.length ? { warnings: plan.warnings } : {}) };
  }
  if (plan.after === 'copy_job') {
    return startJob(project, feature, {
      kind: 'storage_migrate',
      params: { from: { provider: activeRow.provider, ...pickSide(activeRow.config) }, to: { provider: plan.pending.provider, ...pickSide(plan.pending.config) }, verify: ['size', 'sha256'] },
    }, { userId });
  }
  // reembed: when the app has no active index there is nothing to rebuild —
  // promote at once; otherwise build and validate a new index first.
  let active;
  try {
    const r = await store.appPsql(project.container_name, buildActiveIndexSql(), { timeoutMs: 20_000 });
    active = Number(r?.code) === 0 && parseMarker(r.stdout, SQL_MARKERS.ok).length ? (parseJsonRows(r.stdout)[0] || false) : null;
  } catch { active = null; }
  if (active == null) {
    await stopUnused();
    return refusal(CODES.FOUNDATION_UNAVAILABLE, 'The app database did not say whether an index exists; nothing was switched.', [{ action: 'switch' }]);
  }
  if (active === false) {
    const p = await promote(project, feature);
    if (!p.ok) return refusal(CODES.FOUNDATION_UNAVAILABLE, `The switch tested fine but could not be applied: ${p.error}`, [{ action: 'switch' }]);
    return { ok: true, promoted: true, reembedded: false, ...(plan.warnings?.length ? { warnings: plan.warnings } : {}) };
  }
  const target = newIndexId(randomBytes(8).toString('hex'));
  const cfg = plan.pending.config;
  return startJob(project, feature, {
    kind: 'reembed',
    params: {
      from: { provider: active.provider, model: active.model, dimensions: active.dimensions, metric: active.metric, index: active.id },
      to: { provider: plan.pending.provider, model: cfg.model, dimensions: cfg.dimensions, metric: cfg.metric, index: target },
      source_index: active.id, target_index: target,
    },
    index: { id: target, provider: plan.pending.provider, model: cfg.model, dimensions: cfg.dimensions, metric: cfg.metric },
  }, { userId });
}

function pickSide(config = {}) {
  const out = {};
  for (const k of ['endpoint', 'bucket', 'region', 'prefix']) if (config?.[k] != null) out[k] = config[k];
  return out;
}

// POST /foundation/storage and /foundation/embeddings.
export async function featureAction(projectId, feature, request, { userId = null } = {}) {
  const { project, error } = requireFoundation(projectId);
  if (error) return error;
  return exclusive(project.id, async () => {
    const { current } = currentFor(project.id, feature);
    let facts = {};
    if (feature === 'storage' && current.provider === 'bundled' && !current.activeJob && (request?.action === 'off' || request?.action === 'switch')) {
      facts = { bundledObjectCount: await bundledObjectCount(project) };
    }
    const decision = feature === 'storage' ? planStorageAction({ current, request, facts }) : planEmbeddingsAction({ current, request });
    if (!decision.ok) return decision;
    const plan = decision.plan;
    if (plan.op === 'noop') return { ok: true, noop: true, reason: plan.reason };
    if (plan.op === 'set_state') return setState(project, feature, plan);
    return performSwitch(project, feature, plan, { userId });
  });
}

// For tests: drop in-process caches.
export function resetFoundationServiceCaches() {
  healthCache.clear(); lastRefresh.clear(); busy.clear();
}
