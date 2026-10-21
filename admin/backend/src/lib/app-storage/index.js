// Application storage: the one instance the backend shares between its
// routes (routes/app-storage.js), the read-only MCP tools and the monitor.
// createAppStorage() takes every dependency (tests use it with node:sqlite and
// a scripted executor); getAppStorage() builds the backend's singleton over
// mock2.db, the main DB, the bell and the backend executor — reached only on
// an install with Dev Studio enabled (mock2.db exists there).

import { createStorageStore, readInstalledAt } from './store.js';
import { listTargets, resolveTarget, activityFor, existingTargetKeys, AppStorageError } from './targets.js';
import { createCheckService } from './check-service.js';
import { createAppStorageMonitor, createGuestLister, registerMonitor, unregisterMonitor } from './monitor.js';
import { backendExec, exportsFor } from './host-measures.js';
import { estimateSelection } from './accounting.js';
import {
  RULES, RULE_KEYS, DEFAULT_POLICY, resolvePolicy, ruleStates, proposedAfterEdit, validatePolicy, policyDiff, policyEffects,
  effectiveReleaseRetention, effectiveSnapshotLimits, recordNewProjectDefaults as recordDefaultsOnce, auditLogWriter, NEW_PROJECT_DEFAULTS_ORIGIN,
} from './policy.js';

export { NEW_PROJECT_DEFAULTS_ORIGIN };

/** Until the cleanup service is wired (WS2), cleanup requests answer 503 and reads come from the store. */
export function unavailableCleanupService(store = null) {
  return {
    available: false,
    async requestCleanup() {
      throw new AppStorageError('CLEANUP_UNAVAILABLE', 'Cleanup is not available on this ProxyPilot version yet; the storage check works without it.', 503);
    },
    getCleanup: (id) => (store ? store.getCleanup(id) : null),
    listCleanups: (targetKey, limit = 10) => (store ? store.listCleanups(targetKey, { limit }) : []),
  };
}

export function createAppStorage({
  mock2Db, mainDb = null, exec = null, now = () => Date.now(), notifications = null, listGuests = null,
  logger = console, cleanupService = null, performCheck = undefined, audit = null,
} = {}) {
  if (!mock2Db) throw new TypeError('createAppStorage needs the mock2 database');
  const executor = exec || backendExec();
  const store = createStorageStore(mock2Db, { now });
  const list = () => listTargets({ mock2Db });
  const resolve = (key) => resolveTarget(key, { mock2Db });
  const activity = (target, opts = {}) => activityFor(target, { mainDb, mock2Db, now: now(), ...opts });
  const limitOf = (targetKey) => {
    try { return store.latestCheckSummary(targetKey)?.summary?.totals?.limit?.bytes ?? null; } catch { return null; }
  };
  // A new project's defaults are recorded once, by the shared
  // recordNewProjectDefaults (policy.js) on whichever side resolves the policy
  // first; here with the backend's audit (user NULL, actor 'backend'). The
  // policy listeners are not told: the stored rules are the defaults that
  // were already in force, so no limit changes.
  const auditSink = typeof audit === 'function' ? (e) => audit(e) : auditLogWriter(mainDb);
  const recordNewProjectDefaults = (target) => recordDefaultsOnce(target, { mock2Db, audit: auditSink, actor: 'backend', diskLimitBytes: limitOf(target?.key), logger, now });
  const policyFor = (target) => {
    recordNewProjectDefaults(target);
    const r = resolvePolicy(target, { store, installedAt: readInstalledAt(mock2Db), diskLimitBytes: limitOf(target.key) });
    return { ...r, ...ruleStates(r.policy, r.source, r.stored ? r.proposedRules : null) };
  };
  const guestLister = listGuests || createGuestLister(executor, { now });
  const monitor = createAppStorageMonitor({ store, listTargets: list, listGuests: guestLister, policyFor, notifications, now, logger, knownTargetKeys: () => existingTargetKeys({ mock2Db }) });
  const checks = createCheckService({
    store, exec: executor, mainDb, now, resolveTarget: resolve, listTargets: list, activityFor: (t) => activity(t), policyFor,
    listExports: (guest) => exportsFor(mainDb, guest), listGuests: guestLister, alertsFor: (key) => monitor.alertsFor(key), logger,
    ...(performCheck ? { performCheck } : {}),
  });
  let cleanup = cleanupService || unavailableCleanupService(store);
  // Told after every saved policy (the snapshot-limit memo is dropped then).
  const policyListeners = new Set();

  function getPolicy(targetKey) {
    const target = resolve(targetKey);
    const pol = policyFor(target);
    const latest = checks.latestCheck(target.key);
    return {
      targetKey: target.key, policy: pol.policy, defaults: pol.defaults.policy, defaultsSource: pol.defaults.source, source: pol.source,
      revision: pol.revision, stored: pol.stored, updatedAt: pol.updatedAt, updatedBy: pol.updatedBy,
      enabledRules: pol.enabledRules, proposedRules: pol.proposedRules, rules: RULES,
      effects: policyEffects(latest, pol.policy, now()), checkId: latest?.checkId || null,
      ...(pol.invalidStored ? { invalidStored: true } : {}),
    };
  }

  /** Save a whole policy document as the next revision → { policy, revision, source, changed, previous }. */
  function putPolicy(targetKey, input, { userId = null, expectedRevision = undefined } = {}) {
    const target = resolve(targetKey);
    const policy = validatePolicy(input);
    const before = policyFor(target);
    const changed = policyDiff(before.policy, policy);
    const proposedRules = proposedAfterEdit(before.proposedRules, policy);
    const row = store.putPolicy(target.key, { policy, source: 'edited', updatedBy: userId == null ? null : String(userId), expectedRevision, proposedRules });
    for (const fn of policyListeners) { try { fn(target.key); } catch (e) { logger?.error?.('[app-storage] policy listener failed', e?.message || e); } }
    return { targetKey: target.key, policy: row.policy, revision: row.revision, source: row.source, proposedRules, changed, previousRevision: before.revision, previousSource: before.source };
  }

  async function guestStatusOf(target, latest) {
    try { const g = (await guestLister())?.get?.(target.guest); if (g) return g.status || null; } catch { /* fall back to the last check */ }
    return latest?.guest?.status || null;
  }

  async function targetDetail(targetKey) {
    const target = resolve(targetKey);
    const running = store.runningCheck(target.key, { maxAgeMs: 15 * 60 * 1000 });
    const pol = getPolicy(target.key);
    const latest = checks.latestCheck(target.key);
    return {
      target: { key: target.key, kind: target.kind, id: target.id, name: target.name, guest: target.guest, guestStatus: await guestStatusOf(target, latest), ...(target.kind === 'project' ? { lifecycle: target.lifecycle } : {}) },
      latestCheck: latest,
      runningCheckId: running?.id || null,
      policy: { policy: pol.policy, source: pol.source, revision: pol.revision, enabledRules: pol.enabledRules, proposedRules: pol.proposedRules },
      effects: pol.effects,
      activity: activity(target).reasons,
    };
  }

  return {
    store, checks, monitor, exec: executor,
    listTargets: list, resolveTarget: resolve, activityFor: activity, policyFor,
    overview: () => checks.overview(),
    requestCheck: (key, opts) => checks.requestCheck(key, opts),
    runCheck: (key, opts) => checks.runCheck(key, opts),
    getCheck: (id) => checks.getCheck(id),
    latestCheck: (key) => checks.latestCheck(key),
    targetDetail, getPolicy, putPolicy,
    estimateSelection: (checkId, selection) => estimateSelection(checks.getCheck(checkId), selection),
    effectiveReleaseRetention: (targetId) => effectiveReleaseRetention(targetId, { mock2Db }),
    effectiveSnapshotLimits: () => {
      // A new project's defaults are recorded (inside) before they first decide anything.
      return effectiveSnapshotLimits({ mock2Db, mainDb, audit: auditSink, actor: 'backend', logger });
    },
    postCleanupAlert: (targetKey, outcome, opts) => monitor.postCleanupAlert(targetKey, outcome, opts),
    cleanupService: () => cleanup,
    setCleanupService(svc) { cleanup = svc || unavailableCleanupService(store); },
    onPolicyChange(fn) { policyListeners.add(fn); return () => policyListeners.delete(fn); },
    RULE_KEYS, DEFAULT_POLICY,
  };
}

let singleton = null;

/** The backend's instance (Dev Studio enabled only: it opens mock2.db). */
export function getAppStorage() {
  if (!singleton) {
    singleton = (async () => {
      const [{ getMock2Db }, db, bell, dispatch] = await Promise.all([
        import('../../mock2/db.js'), import('../../db.js'), import('../notifications.js'), import('../notification-dispatch.js'),
      ]);
      return createAppStorage({
        mock2Db: getMock2Db(), mainDb: db.getDb(),
        notifications: { post: bell.postNotification, resolve: bell.resolveNotification, list: bell.listNotifications, dispatch: dispatch.dispatchToChannels },
        audit: ({ action, targetKey, detail }) => db.logAudit(null, action, 'app_storage', String(targetKey), detail, null),
      });
    })();
    singleton.catch(() => { singleton = null; });
  }
  return singleton;
}

/** Tests (and the integrator's wiring) install their own instance. */
export function setAppStorage(instance) { singleton = instance ? Promise.resolve(instance) : null; }

/** Start the alert monitor: hydrate from the bell, then the cron. Off with PROXYPILOT_DISABLE_CRONS=1. */
export async function startAppStorageMonitor({ storage = null, firstRunAfterMs = 30_000 } = {}) {
  if (process.env.PROXYPILOT_DISABLE_CRONS === '1') return { started: false };
  const s = storage || await getAppStorage();
  await s.monitor.hydrate();
  registerMonitor(s.monitor);
  setTimeout(() => { s.monitor.runOnce().catch(() => {}); }, firstRunAfterMs).unref?.();
  return { started: true };
}

export function stopAppStorageMonitor() { unregisterMonitor(); }

export { effectiveReleaseRetention, effectiveSnapshotLimits } from './policy.js';
export { postCleanupAlert } from './monitor.js';
