// The storage check service: one running check per target (a new request
// while one runs returns it), checks run in-process in the background and
// their results are stored (newest 20 per target), plus the overview across
// every application and project. Everything it touches is injected.

import { performCheck as defaultPerformCheck, newCheckId, publicTarget, CHECK_RESULT_VERSION } from './perform-check.js';
import { AppStorageError } from './targets.js';
import { SEPARATE_CATEGORIES } from './categories.js';

/** A cleanup needs a check at most this old (DESIGN §3.1). */
export const CHECK_MAX_AGE_MS = 60 * 60 * 1000;
/** A check still "running" after this long was interrupted (a restart). */
export const RUNNING_CHECK_STALE_MS = 15 * 60 * 1000;

const nowOf = (now) => (typeof now === 'function' ? now() : now == null ? Date.now() : Number(now));
const timeText = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time'; };

/**
 * May this check back a cleanup now? null when yes, else a 409 CHECK_STALE
 * error: the check must exist, belong to the target, be its latest complete
 * or partial check and be at most CHECK_MAX_AGE_MS old.
 */
export function checkFreshness({ check, latest, targetKey, now = Date.now(), maxAgeMs = CHECK_MAX_AGE_MS }) {
  if (!check || (targetKey && check.targetKey !== targetKey)) return new AppStorageError('CHECK_STALE', 'Run a new storage check first; that check was not found for this application.', 409);
  if (!['complete', 'partial'].includes(check.status)) return new AppStorageError('CHECK_STALE', 'Run a new storage check first; that check did not finish.', 409);
  if (!latest || latest.id !== check.id) return new AppStorageError('CHECK_STALE', `Run a new storage check first; a newer check exists than the one from ${timeText(check.finishedAt || check.startedAt)}.`, 409);
  const at = Date.parse(check.finishedAt || check.startedAt || '');
  if (!Number.isFinite(at) || nowOf(now) - at > maxAgeMs) return new AppStorageError('CHECK_STALE', `Run a new storage check first; this one is from ${timeText(check.finishedAt || check.startedAt)}.`, 409);
  return null;
}

/** What a stored row looks like through the API. */
export function checkView(row) {
  if (!row) return null;
  if (row.result && typeof row.result === 'object') return { ...row.result, status: row.status, finishedAt: row.finishedAt || row.result.finishedAt || null };
  return {
    version: CHECK_RESULT_VERSION, checkId: row.id, target: { key: row.targetKey }, origin: row.origin, status: row.status,
    startedAt: row.startedAt, finishedAt: row.finishedAt,
    ...(row.status === 'failed' ? { error: { code: row.errorCode || 'CHECK_FAILED', message: row.errorCode === 'INTERRUPTED' ? 'The check was interrupted (the service restarted); run it again.' : 'The storage check failed; nothing was changed.' } } : {}),
    totals: null, categories: [], items: [], context: null, unmeasured: [], notes: [],
  };
}

/** What can be cleaned up from the files, on disk only (snapshots and exports apart). */
export function eligibleBytesOf(result) {
  return (result?.categories || []).filter((c) => !SEPARATE_CATEGORIES.includes(c.key)).reduce((s, c) => s + Number(c.eligibleBytes || 0), 0);
}
/** The same for memory-backed (tmpfs) files: memory, not disk. */
export function eligibleMemoryBytesOf(result) {
  return (result?.categories || []).filter((c) => !SEPARATE_CATEGORIES.includes(c.key)).reduce((s, c) => s + Number(c.eligibleMemoryBytes || 0), 0);
}

export function createCheckService({
  store, exec, mainDb = null, now = () => Date.now(), resolveTarget, listTargets = () => [], activityFor = () => ({}),
  policyFor = () => ({ policy: null }), performCheck = defaultPerformCheck, listExports = null, onFinished = null,
  listGuests = null, alertsFor = () => [], logger = console,
} = {}) {
  if (!store) throw new TypeError('createCheckService needs a store');
  if (typeof resolveTarget !== 'function') throw new TypeError('createCheckService needs resolveTarget');
  const inflight = new Map();

  function sweepStale() {
    for (const row of store.listRunningChecks()) {
      if (inflight.has(row.id)) continue;
      if (nowOf(now) - Date.parse(row.startedAt) > RUNNING_CHECK_STALE_MS) store.finishCheck(row.id, { status: 'failed', errorCode: 'INTERRUPTED' });
    }
  }

  async function run(checkId, target, origin) {
    let result;
    try {
      const activity = activityFor(target) || {};
      const { policy } = policyFor(target) || {};
      result = await performCheck({ target, activity, exec, policy, now, origin, checkId, mainDb, listExports });
    } catch (e) {
      logger?.error?.('[app-storage] check failed:', e?.message || e);
      result = { version: CHECK_RESULT_VERSION, checkId, target: publicTarget(target), origin, status: 'failed', startedAt: new Date(nowOf(now)).toISOString(), finishedAt: new Date(nowOf(now)).toISOString(), error: { code: 'CHECK_FAILED', message: 'The storage check failed before it could finish; nothing was changed.' }, totals: null, categories: [], items: [], context: null, unmeasured: [], notes: [] };
    }
    try { store.finishCheck(checkId, { status: result.status, result, errorCode: result.error?.code || null, finishedAt: result.finishedAt }); } catch (e) { logger?.error?.('[app-storage] storing a check failed:', e?.message || e); }
    try { await onFinished?.(result); } catch { /* best effort */ }
    return result;
  }

  /** Start a check (or return the one running). → { checkId, status: 'running', reused } */
  function requestCheck(targetKey, { userId = null, origin = 'user', requestedBy = null } = {}) {
    const target = resolveTarget(targetKey);
    sweepStale();
    const running = store.runningCheck(target.key, { maxAgeMs: RUNNING_CHECK_STALE_MS });
    if (running) return { checkId: running.id, status: 'running', reused: true };
    const checkId = newCheckId();
    store.insertCheck({ id: checkId, targetKey: target.key, origin, requestedBy: requestedBy ?? (userId == null ? null : String(userId)) });
    const p = run(checkId, target, origin);
    inflight.set(checkId, p);
    p.finally(() => inflight.delete(checkId)).catch(() => {});
    return { checkId, status: 'running', reused: false };
  }

  /** Wait for a check to finish (in-flight here, else what is stored). */
  async function waitForCheck(checkId) {
    const p = inflight.get(checkId);
    if (p) await p;
    return getCheck(checkId);
  }

  /** Request and wait: the finished result. */
  async function runCheck(targetKey, opts = {}) {
    const { checkId } = requestCheck(targetKey, opts);
    return waitForCheck(checkId);
  }

  function getCheck(checkId) {
    if (typeof checkId !== 'string' || !/^chk_[a-f0-9-]{36}$/.test(checkId)) return null;
    return checkView(store.getCheck(checkId));
  }

  function latestCheck(targetKey, { statuses } = {}) {
    return checkView(store.latestCheck(targetKey, statuses ? { statuses } : undefined));
  }

  async function overview() {
    sweepStale();
    const checkedAt = new Date(nowOf(now)).toISOString();
    let guests = null;
    try { guests = listGuests ? await listGuests() : null; } catch { guests = null; }
    const targets = [];
    for (const t of listTargets()) {
      const last = store.latestCheck(t.key, { statuses: ['complete', 'partial', 'failed'] });
      const running = store.runningCheck(t.key, { maxAgeMs: RUNNING_CHECK_STALE_MS });
      const g = guests?.get?.(t.guest) || null;
      const sample = g ? null : store.latestSample(t.key);
      let pol = null;
      try { pol = policyFor(t); } catch { pol = null; }
      targets.push({
        key: t.key, kind: t.kind, id: t.id, name: t.name, guest: t.guest,
        guestStatus: g?.status || null,
        usage: g?.usedBytes != null ? { usedBytes: g.usedBytes, sampledAt: guests.checkedAt || checkedAt } : sample ? { usedBytes: sample.usedBytes, sampledAt: sample.sampledAt } : null,
        lastCheck: last ? { checkId: last.id, finishedAt: last.finishedAt, status: last.status, totals: last.result?.totals || null, eligibleBytes: eligibleBytesOf(last.result), eligibleMemoryBytes: eligibleMemoryBytesOf(last.result) } : null,
        runningCheckId: running?.id || null,
        alerts: (alertsFor(t.key) || []).map((a) => ({ key: a.key, level: a.level, title: a.title })),
        policy: pol ? { source: pol.source, enabledRules: pol.enabledRules || [], proposedRules: pol.proposedRules || [] } : null,
      });
    }
    return { targets, checkedAt };
  }

  return { requestCheck, runCheck, waitForCheck, getCheck, latestCheck, overview, sweepStale };
}
