// Application storage — the SEAM between the cleanup/retention half (WS2) and
// the check/store/policy/monitor half (WS1). Everything WS2 needs from WS1 is
// reached here, and only here, by the module paths and export names DESIGN.md
// fixes (§1, §2.5, §3.4, §4, §5):
//
//   ./store.js          createStorageStore(mock2Db)
//   ./targets.js        resolveTarget(key, { mock2Db, mainDb }),
//                       activityFor(target, { mainDb, mock2Db, excludeJobId }),
//                       listTargets({ mock2Db, mainDb })
//   ./policy.js         effectiveReleaseRetention(targetId, { mock2Db }),
//                       effectiveSnapshotLimits({ mock2Db, mainDb }),
//                       policySelection(check, policy), policyFor? (see below)
//   ./perform-check.js  performCheck({ target, activity, exec, store, policy, now, origin })
//   ./monitor.js        postCleanupAlert(event, { mainDb? })
//   ./check-service.js  createCheckService(...) (only when no instance is passed)
//
// They are imported lazily, so this branch builds, boots and tests before WS1
// lands: until then release jobs and snapshot retention use the static files
// (Nodus unchanged), and the cleanup job and the scheduler report themselves
// unavailable. The integrator checks the names above against WS1's exports
// (contract-changes.md, 2026-10-20 entries) and adjusts this file only.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setSnapshotLimitsProvider } from '../snapshot-retention.js';
import { APPLICATION_RELEASE_RETENTION } from '../setup-engine/application-release-cleanup.js';
import { getJob } from '../setup-engine/store.js';
import { createExportStore } from '../lxc-exports.js';
import { createCleanupService } from './cleanup-service.js';
import { createRetentionScheduler } from './retention-scheduler.js';

const WS1_MODULES = Object.freeze({ store: './store.js', targets: './targets.js', policy: './policy.js', performCheck: './perform-check.js', monitor: './monitor.js', checkService: './check-service.js' });
export class AppStorageUnavailable extends Error { constructor(missing) { super(`application storage module ${missing} is not installed`); this.code = 'APP_STORAGE_UNAVAILABLE'; } }

const cache = new Map();
async function load(key, { optional = false } = {}) {
  if (cache.has(key)) return cache.get(key);
  const p = import(WS1_MODULES[key]).catch(e => {
    cache.delete(key);
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message || '').includes(WS1_MODULES[key].slice(2))) { if (optional) return null; throw new AppStorageUnavailable(WS1_MODULES[key]); }
    throw e;
  });
  cache.set(key, p);
  return p;
}
export async function loadAppStorageModules() {
  const [store, targets, policy, performCheck, monitor] = await Promise.all(['store', 'targets', 'policy', 'performCheck', 'monitor'].map(k => load(k)));
  return { store, targets, policy, performCheck, monitor };
}

const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

// The policy document in force for a target: WS1's policyFor when it exports
// one (defaults applied there), else the stored row's document.
export async function policyOf(targetKey, { policy, store, mock2Db, mainDb }) {
  if (typeof policy?.policyFor === 'function') return policy.policyFor(targetKey, { mock2Db, mainDb, store });
  const row = await store.getPolicy?.(targetKey);
  return parse(row?.policy_json ?? row?.policy) || null;
}

// audit_log through a given main DB handle (the runner has no db.js
// singleton; the columns are those of db.js logAudit).
export function auditInto(db, { resourceType = 'app_storage' } = {}) {
  return entry => {
    db.prepare('INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), entry.userId ?? null, entry.action, resourceType, entry.targetKey ?? null, JSON.stringify(entry.details ?? {}), entry.ip ?? null);
  };
}

// submitStorageCleanupJob(db, spec) → { jobId } | { error, code }. The job is
// exclusive: refused while the guest's lease is held or a mutating job is
// open (CONTAINER_BUSY / CONTAINER_LOCK_STALE), and refused outright when no
// host runner is live — it never waits to run later under a state nobody
// looked at, and the backend never executes it in its own process.
// (The orchestrator is loaded on use: the host runner imports this module and
// must not pull the backend's whole step graph with it.)
export async function submitStorageCleanupJob(db, { cleanupId, targetKey, guest, requestedBy = null, origin = 'user', nowMs = Date.now(), env = process.env }) {
  const [{ submitRunnerJob }, { executionMode }] = await Promise.all([import('../setup-engine/orchestrator.js'), import('../setup-engine/backend.js')]);
  const mode = executionMode(db, { env, nowMs });
  if (mode.executor !== 'runner') return { error: 'Storage cleanup runs on the host runner, which is not running; start proxypilot-setup-runner.service and try again. Nothing was changed.', code: 'RUNNER_UNAVAILABLE' };
  const r = submitRunnerJob(db, { kind: 'storage_cleanup', app: guest, params: { cleanupId, targetKey }, requestedBy, via: origin === 'policy' ? 'system' : 'ui', reason: `storage cleanup ${cleanupId} of ${targetKey}`, nowMs });
  if (r.error) return { error: r.error, code: r.code };
  return { jobId: r.job.id };
}

// ── the backend side ────────────────────────────────────────────────────

// The cleanup service WS1's routes call (requestCleanup/getCleanup/listCleanups).
export async function createBackendCleanupService({ mainDb, mock2Db, logAudit, now = () => Date.now(), modules = null }) {
  const m = modules || await loadAppStorageModules();
  const store = m.store.createStorageStore(mock2Db);
  return createCleanupService({
    store,
    getCheck: id => store.getCheck(id),
    submitJob: spec => submitStorageCleanupJob(mainDb, spec),
    resolveTarget: key => m.targets.resolveTarget(key, { mock2Db, mainDb }),
    activityFor: target => m.targets.activityFor(target, { mainDb, mock2Db }),
    now,
    audit: e => logAudit(e.userId ?? null, e.action, 'app_storage', e.targetKey ?? null, e.details ?? {}, e.ip ?? null),
    monitor: { postCleanupAlert: event => m.monitor.postCleanupAlert(event) },
    getJob: id => getJob(mainDb, id),
    // The newest 20, oldest first: a long cleanup writes a checkpoint per item.
    listEvents: id => mainDb.prepare('SELECT * FROM (SELECT * FROM setup_job_events WHERE job_id = ? ORDER BY id DESC LIMIT 20) ORDER BY id').all(String(id)),
  });
}

// Installs the policy-fed snapshot limits for this process. Without WS1's
// policy module the static file stays in force. → true when installed.
export async function installSnapshotLimitsProvider({ getMainDb, getMock2Db, log = () => {} }) {
  let policy;
  try { policy = await load('policy', { optional: true }); } catch (e) { log('[app-storage] policy module failed to load; snapshot limits stay on the static file', e?.message || e); return false; }
  if (typeof policy?.effectiveSnapshotLimits !== 'function') return false;
  setSnapshotLimitsProvider(() => policy.effectiveSnapshotLimits({ mock2Db: getMock2Db(), mainDb: getMainDb() }));
  return true;
}

// startAppStorageAutomation — the index.js hook: policy-fed snapshot limits
// (then a reconcile so a newly limited guest is pruned at once) and the
// retention scheduler (off with PROXYPILOT_DISABLE_CRONS=1). Pass the shared
// check service when WS1 has one; one is created otherwise. → stop()
export async function startAppStorageAutomation({ getMainDb, getMock2Db, logAudit, reconcileSnapshots = null, checkService = null, cleanupService = null, log = console.log, env = process.env }) {
  const stops = [];
  if (await installSnapshotLimitsProvider({ getMainDb, getMock2Db, log })) { try { reconcileSnapshots?.(); } catch { /* the listener retries on its own */ } }
  if (env.PROXYPILOT_DISABLE_CRONS === '1') return () => {};
  let m;
  try { m = await loadAppStorageModules(); } catch (e) { log(e?.code === 'APP_STORAGE_UNAVAILABLE' ? '[app-storage] retention scheduler not started: the storage check modules are not installed' : `[app-storage] retention scheduler not started: ${e?.message || e}`); return () => {}; }
  const mainDb = getMainDb(), mock2Db = getMock2Db();
  const store = m.store.createStorageStore(mock2Db);
  const cleanups = cleanupService || await createBackendCleanupService({ mainDb, mock2Db, logAudit, modules: m });
  let checks = checkService;
  if (!checks) { const cs = await load('checkService'); checks = cs.createCheckService({ mock2Db, mainDb, audit: logAudit }); }
  const scheduler = createRetentionScheduler({
    listTargets: () => m.targets.listTargets({ mock2Db, mainDb }),
    resolveTarget: key => m.targets.resolveTarget(key, { mock2Db, mainDb }),
    policyFor: key => policyOf(key, { policy: m.policy, store, mock2Db, mainDb }),
    runCheck: key => awaitCheck(checks, key),
    policySelection: typeof m.policy.policySelection === 'function' ? m.policy.policySelection : null,
    activityFor: target => m.targets.activityFor(target, { mainDb, mock2Db }),
    requestCleanup: spec => cleanups.requestCleanup(spec),
    monitor: { postCleanupAlert: event => m.monitor.postCleanupAlert(event) },
    log, env,
  });
  scheduler.start();
  stops.push(() => scheduler.stop());
  return () => { for (const s of stops) try { s(); } catch { /* */ } };
}

// Requests a policy check and waits for it to finish (bounded).
export async function awaitCheck(checks, targetKey, { timeoutMs = 15 * 60_000, pollMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const started = await checks.requestCheck(targetKey, { origin: 'policy', userId: null });
  const until = now() + timeoutMs;
  for (;;) {
    const c = await checks.getCheck(started.checkId);
    const view = c && (Array.isArray(c.items) ? c : parse(c.result_json ?? c.result) || c);
    if (view && view.status && view.status !== 'running') return view;
    if (now() > until) throw Object.assign(new Error('the storage check did not finish in time'), { code: 'CHECK_TIMEOUT' });
    await sleep(pollMs);
  }
}

// ── the host runner side ────────────────────────────────────────────────

function hostExec(argv, { timeoutMs = 120_000 } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, status: -1, stdout: '', stderr: e.message }); return; }
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch { /* */ } resolve({ code: 124, status: 124, timedOut: true, stdout, stderr }); } }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, status: -1, stdout, stderr: e.message }); } });
    child.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, status: code, stdout, stderr }); } });
  });
}

// The export store over the runner's own main DB (no db.js singleton here).
export function runnerExportStore(mainDb) {
  return createExportStore({
    getDb: () => mainDb,
    runHost: (bin, args, opts) => hostExec([bin, ...args], opts),
    hostSh: (script, argv = [], opts = {}) => hostExec(['sh', '-c', script, 'sh', ...argv], { timeoutMs: 60000, ...opts }),
    exportsDir: async () => '/var/lib/proxypilot/mcp-exports',
    getSetting: key => { try { return mainDb.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null; } catch { return null; } },
    logAudit: (userId, action, resourceType, resourceId, details, ip) => auditInto(mainDb, { resourceType })({ userId, action, targetKey: resourceId, details, ip }),
    hasBinary: async () => true,
  });
}

// runnerAppStorage({ mainDb, mock2DbPath }) → the executor's appStorage for
// the host runner: release retention from the policy (static file until WS1
// is installed) and the storage cleanup op's dependencies.
export function runnerAppStorage({ mainDb, mock2DbPath, openDb = null, log = () => {} }) {
  let mock2 = null;
  const mock2Db = async () => {
    if (!mock2) mock2 = (async () => { if (openDb) return openDb(mock2DbPath); const { default: Database } = await import('better-sqlite3'); const db = new Database(mock2DbPath, { fileMustExist: true, timeout: 5000 }); db.pragma('busy_timeout = 5000'); return db; })();
    return mock2;
  };
  return {
    async releaseRetention(targetId) {
      const policy = await load('policy', { optional: true });
      if (typeof policy?.effectiveReleaseRetention !== 'function') return Object.hasOwn(APPLICATION_RELEASE_RETENTION, targetId) ? APPLICATION_RELEASE_RETENTION[targetId] : null;
      return policy.effectiveReleaseRetention(targetId, { mock2Db: await mock2Db() });
    },
    async cleanup() {
      const m = await loadAppStorageModules();
      const db2 = await mock2Db();
      const store = m.store.createStorageStore(db2);
      return {
        store,
        getCheck: id => store.getCheck(id),
        resolveTarget: key => m.targets.resolveTarget(key, { mock2Db: db2, mainDb }),
        activityFor: (target, opts = {}) => m.targets.activityFor(target, { mainDb, mock2Db: db2, ...opts }),
        performCheck: args => m.performCheck.performCheck(args),
        policyFor: key => policyOf(key, { policy: m.policy, store, mock2Db: db2, mainDb }),
        monitor: { postCleanupAlert: event => m.monitor.postCleanupAlert(event, { mainDb }) },
        audit: auditInto(mainDb),
        exports: runnerExportStore(mainDb),
      };
    },
    // The policy-fed snapshot limits for this runner's own snapshot jobs;
    // without WS1's policy module nothing is opened and the static file stays.
    async installSnapshotLimits() {
      const policy = await load('policy', { optional: true });
      if (typeof policy?.effectiveSnapshotLimits !== 'function') return false;
      const db2 = await mock2Db();
      setSnapshotLimitsProvider(() => policy.effectiveSnapshotLimits({ mock2Db: db2, mainDb }));
      return true;
    },
    mock2DbPath: path.resolve(mock2DbPath),
  };
}
