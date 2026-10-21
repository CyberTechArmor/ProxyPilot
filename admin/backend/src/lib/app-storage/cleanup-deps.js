// Application storage — the wiring of the cleanup half (WS2) onto the shared
// storage modules (store.js, targets.js, policy.js, perform-check.js,
// monitor.js), for the two processes that run it:
//
//   the backend      createBackendCleanupService({ storage, mainDb, logAudit })
//                    → the service the routes call; index.js installs it with
//                    storage.setCleanupService(...). startAppStorageAutomation
//                    ({ storage, reconcileSnapshots }) feeds the policy-fed
//                    snapshot limits and starts the retention scheduler over
//                    the SAME storage instance (its check service and cleanup
//                    service).
//   the host runner  runnerAppStorage({ mainDb, mock2DbPath }) → the
//                    executor's appStorage: release retention for release
//                    jobs, the storage_cleanup op's dependencies, the
//                    snapshot limits for the runner's own snapshot jobs.
//
// The host runner has no db.js connection: its alerts go to the bell over the
// main DB it opened (bellOver), and the out-of-band delivery (push, e-mail,
// webhooks) is left to the backend's monitor, which relays a runner-posted
// cleanup or health alert once on its next round (monitor.js runOnce).

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setSnapshotLimitsProvider } from '../snapshot-retention.js';
import { getJob } from '../setup-engine/store.js';
import { createExportStore } from '../lxc-exports.js';
import { createCleanupService } from './cleanup-service.js';
import { createRetentionScheduler } from './retention-scheduler.js';
import { createStorageStore, readInstalledAt } from './store.js';
import { resolveTarget, activityFor } from './targets.js';
import { resolvePolicy, effectiveReleaseRetention, effectiveSnapshotLimits } from './policy.js';
import { performCheck, newCheckId } from './perform-check.js';
import { postCleanupAlert } from './monitor.js';
import { checkView } from './check-service.js';
import { exportsFor } from './host-measures.js';

// audit_log through a given main DB handle (the columns of db.js logAudit).
export function auditInto(db, { resourceType = 'app_storage' } = {}) {
  return entry => {
    db.prepare('INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), entry.userId ?? null, entry.action, resourceType, entry.targetKey ?? null, JSON.stringify(entry.details ?? {}), entry.ip ?? null);
  };
}

// The bell (notifications table, migration 300) over a given main DB handle,
// with notifications.js's semantics: post upserts on dedupe_key (a repeat
// re-emerges a dismissed row, re-flags unread only when escalating to error),
// resolve dismisses with "auto-resolved: <reason>", list shows open rows.
// No dispatch here: see the header.
export function bellOver(db) {
  return {
    post({ level = 'info', title, body = null, source, source_id = null, dedupe_key = null } = {}) {
      if (dedupe_key) {
        const existing = db.prepare('SELECT id FROM notifications WHERE dedupe_key = ?').get(dedupe_key);
        if (existing) {
          db.prepare(`UPDATE notifications SET level = ?, title = ?, body = ?, source = ?, source_id = ?, seen_count = seen_count + 1, last_seen_at = CURRENT_TIMESTAMP,
            read_at = CASE WHEN read_at IS NULL THEN NULL WHEN ? = 'error' AND level <> 'error' THEN NULL ELSE read_at END, dismissed_at = NULL WHERE dedupe_key = ?`)
            .run(level, title, body, source, source_id, level, dedupe_key);
          return existing.id;
        }
      }
      const id = randomUUID();
      db.prepare('INSERT INTO notifications (id, level, title, body, source, source_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, level, title, body, source, source_id, dedupe_key);
      return id;
    },
    resolve(dedupe_key, { reason = 'recovered' } = {}) {
      if (!dedupe_key) return false;
      return Number(db.prepare('UPDATE notifications SET dismissed_at = CURRENT_TIMESTAMP, body = ? WHERE dedupe_key = ? AND dismissed_at IS NULL').run(`auto-resolved: ${reason}`, dedupe_key).changes) > 0;
    },
    list({ limit = 50, includeDismissed = false } = {}) {
      return db.prepare(`SELECT * FROM notifications WHERE ${includeDismissed ? '1=1' : 'dismissed_at IS NULL'} ORDER BY last_seen_at DESC LIMIT ?`).all(Math.max(1, Number(limit) || 50));
    },
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

// The newest 20 events of a job, oldest first (a long cleanup writes a
// checkpoint per item).
const newestEvents = db => id => db.prepare('SELECT * FROM (SELECT * FROM setup_job_events WHERE job_id = ? ORDER BY id DESC LIMIT 20) ORDER BY id').all(String(id));

// ── the backend ─────────────────────────────────────────────────────────

/** The cleanup service over the backend's shared storage instance (lib/app-storage/index.js). */
export function createBackendCleanupService({ storage, mainDb, logAudit, now = () => Date.now() }) {
  return createCleanupService({
    store: storage.store,
    getCheck: id => storage.store.getCheck(id),
    submitJob: spec => submitStorageCleanupJob(mainDb, spec),
    resolveTarget: key => storage.resolveTarget(key),
    activityFor: target => storage.activityFor(target),
    now,
    audit: e => logAudit(e.userId ?? null, e.action, 'app_storage', e.targetKey ?? null, e.details ?? {}, e.ip ?? null),
    monitor: { postCleanupAlert: (key, outcome, opts) => storage.postCleanupAlert(key, outcome, opts) },
    getJob: id => getJob(mainDb, id),
    listEvents: newestEvents(mainDb),
  });
}

// startAppStorageAutomation — the index.js hook. Snapshot limits follow the
// enabled policies (re-read on every use; then a reconcile so a newly limited
// guest is pruned at once), and the retention scheduler runs the periodic
// rules through storage.runCheck and storage.cleanupService() — the shared
// instances, never second copies. → stop()
export function startAppStorageAutomation({ storage, reconcileSnapshots = null, log = console.log, env = process.env }) {
  setSnapshotLimitsProvider(() => storage.effectiveSnapshotLimits());
  try { reconcileSnapshots?.(); } catch { /* the listener reconciles on its own */ }
  if (env.PROXYPILOT_DISABLE_CRONS === '1') return () => { setSnapshotLimitsProvider(null); };
  const scheduler = createRetentionScheduler({
    listTargets: () => storage.listTargets(),
    resolveTarget: key => storage.resolveTarget(key),
    policyFor: key => storage.policyFor(storage.resolveTarget(key))?.policy || null,
    runCheck: key => storage.runCheck(key, { origin: 'policy' }),
    activityFor: target => storage.activityFor(target),
    requestCleanup: spec => storage.cleanupService().requestCleanup(spec),
    monitor: { postCleanupAlert: (key, outcome, opts) => storage.postCleanupAlert(key, outcome, opts) },
    log, env,
  });
  scheduler.start().catch(() => {});
  return () => { scheduler.stop(); setSnapshotLimitsProvider(null); };
}

// ── the host runner ─────────────────────────────────────────────────────

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

// The cleanup's rescan: a stored check (origin 'cleanup') through the same
// performCheck the backend runs, over the runner's executor.
export async function storedRescan({ store, mock2Db, mainDb, target, activity, exec, now = () => Date.now() }) {
  const checkId = newCheckId();
  store.insertCheck({ id: checkId, targetKey: target.key, origin: 'cleanup', requestedBy: 'storage-cleanup' });
  let policy = null;
  try { policy = resolvePolicy(target, { store, installedAt: readInstalledAt(mock2Db), diskLimitBytes: store.latestCheck(target.key)?.result?.totals?.limit?.bytes ?? null }).policy; } catch { policy = null; }
  const result = await performCheck({ target, activity, exec, policy, now, origin: 'cleanup', checkId, mainDb, listExports: guest => exportsFor(mainDb, guest) });
  store.finishCheck(checkId, { status: result.status, result, errorCode: result.error?.code || null, finishedAt: result.finishedAt });
  return result;
}

// The storage_cleanup op's dependencies over the given databases.
export function cleanupDepsFor({ mainDb, mock2Db, now = () => Date.now(), bell = bellOver(mainDb), exports = runnerExportStore(mainDb) }) {
  const store = createStorageStore(mock2Db, { now });
  return {
    store,
    getCheck: id => checkView(store.getCheck(id)),
    resolveTarget: key => resolveTarget(key, { mock2Db }),
    activityFor: (target, opts = {}) => activityFor(target, { mainDb, mock2Db, now: now(), ...opts }),
    rescan: args => storedRescan({ store, mock2Db, mainDb, now, ...args }),
    monitor: { postCleanupAlert: (key, outcome, opts = {}) => postCleanupAlert(key, outcome, { ...opts, notifications: bell }) },
    audit: auditInto(mainDb),
    exports,
  };
}

// runnerAppStorage({ mainDb, mock2DbPath }) → the executor's appStorage for
// the host runner.
export function runnerAppStorage({ mainDb, mock2DbPath, openDb = null, log = () => {} }) {
  let mock2 = null;
  const mock2Db = () => {
    if (!mock2) mock2 = (async () => { if (openDb) return openDb(mock2DbPath); const { default: Database } = await import('better-sqlite3'); const db = new Database(mock2DbPath, { fileMustExist: true, timeout: 5000 }); db.pragma('busy_timeout = 5000'); return db; })();
    mock2.catch(() => { mock2 = null; });
    return mock2;
  };
  return {
    // The policy's release rule when it is on, else the static file; without
    // a readable mock2.db, the static file (Nodus keeps its numbers).
    async releaseRetention(targetId) {
      let db2 = null;
      try { db2 = await mock2Db(); } catch (e) { log('release retention from the static file:', e?.message || e); }
      return effectiveReleaseRetention(targetId, { mock2Db: db2 });
    },
    async cleanup() { return cleanupDepsFor({ mainDb, mock2Db: await mock2Db() }); },
    // The policy-fed snapshot limits for this runner's own snapshot jobs.
    async installSnapshotLimits() {
      const db2 = await mock2Db();
      setSnapshotLimitsProvider(() => effectiveSnapshotLimits({ mock2Db: db2, mainDb }));
      return true;
    },
    mock2DbPath: path.resolve(mock2DbPath),
  };
}
