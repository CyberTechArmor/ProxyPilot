// Application storage — the CLEANUP SERVICE (DESIGN §3.1): the one place a
// cleanup is approved. Both the dashboard (origin 'user', behind sudo) and
// the retention scheduler (origin 'policy', the enabled policy is the
// authorization) call requestCleanup; nothing else creates a cleanup.
//
//   createCleanupService({ store, getCheck, submitJob, resolveTarget,
//     activityFor, now, audit, monitor, getJob?, listEvents?, newId? })
//   → { requestCleanup, getCleanup, listCleanups }
// `store` is store.js createStorageStore; `getCheck(id)` returns its check
// row (store.getCheck); `monitor.postCleanupAlert(targetKey, outcome, opts)`
// is monitor.js's.
//
// requestCleanup(...) → { changed: false, message }                  nothing selected
//                     → { changed: true, cleanupId, jobId, estimate }
// Errors carry .code and .status: INVALID_REQUEST 400, TARGET_NOT_FOUND 404,
// CHECK_STALE 409, NOT_ELIGIBLE 409 (.details.items), SNAPSHOT_ACK_REQUIRED
// 400, GUEST_BUSY 409, RUNNER_UNAVAILABLE 503, JOB_UNAVAILABLE 503.
//
// The approval is the only confirmation: once the job is submitted it runs to
// its honest result without asking again. The selection stored on the row is
// copied from the check; the request contributes ids and nothing else.

import { randomUUID } from 'node:crypto';
import { normalizeRequest, validateCleanupRequest, resolveSelection, SelectionError, NOTHING_SELECTED } from './selection.js';
import { checkFreshness, checkView as checkDocOfRow } from './check-service.js';
import { estimateSelection } from './accounting.js';
import { cleanupRow, busyFrom } from './cleanup-rows.js';

export { cleanupRow, busyFrom };

export const TARGET_KEY_RE = /^(application|project):[1-9][0-9]*$/;
export const ORIGINS = Object.freeze(['user', 'policy']);
export const GUEST_BUSY_MESSAGE = 'A build or another change is running on this application; try again when it finishes.';
export const CLEANUP_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'partial', 'failed', 'refused', 'cancelled']);
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'refused', 'cancelled']);
const JOB_TERMINAL = new Set(['succeeded', 'failed', 'deferred', 'refused', 'recovery_required', 'cancelled']);
const BUSY_CODES = new Set(['CONTAINER_BUSY', 'CONTAINER_LOCK_STALE', 'GUEST_BUSY', 'APPLICATION_BUSY', 'lock_held', 'lock_stale']);

export class CleanupError extends SelectionError {}
const error = (code, status, message, details) => new CleanupError(code, status, message, details);

const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const iso = ms => new Date(ms).toISOString();

// A check as a stored row (store.getCheck) or already as its result document.
export function checkView(x) {
  if (!x) return null;
  if (Array.isArray(x.items)) return x;
  return checkDocOfRow({ ...x, result: parse(x.result ?? x.result_json) });
}

export function createCleanupService({
  store, getCheck, submitJob, resolveTarget, activityFor, now = () => Date.now(), audit = () => {}, monitor = null,
  getJob = null, listEvents = null, newId = () => `cln_${randomUUID()}`, log = () => {},
}) {
  const record = entry => { try { const r = audit(entry); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { log('audit failed', e?.message || e); } };

  async function target(targetKey) {
    if (typeof targetKey !== 'string' || !TARGET_KEY_RE.test(targetKey)) throw error('TARGET_NOT_FOUND', 404, 'This application or project was not found.');
    try {
      const t = await resolveTarget(targetKey);
      if (!t) throw Object.assign(new Error('not found'), { code: 'TARGET_NOT_FOUND' });
      return t;
    } catch (e) {
      if (e?.code === 'TARGET_NOT_FOUND') throw error('TARGET_NOT_FOUND', 404, 'This application or project was not found.');
      throw e;
    }
  }

  async function requestCleanup({ targetKey, checkId, items = [], snapshots = [], exports = [], acknowledgeSnapshotLoss = false, scope = 'items', origin = 'user', userId = null, ip = null } = {}) {
    if (!ORIGINS.includes(origin)) throw error('INVALID_REQUEST', 400, 'Cleanups are requested from the dashboard or by an enabled retention policy.');
    const request = normalizeRequest({ items, snapshots, exports, acknowledgeSnapshotLoss, scope });
    if (!request.items.length && !request.snapshots.length && !request.exports.length) {
      record({ action: 'STORAGE_CLEANUP_NONE', userId, ip, targetKey: String(targetKey || ''), level: 'info', details: { checkId: checkId ?? null, origin } });
      return { changed: false, message: NOTHING_SELECTED };
    }
    const t = await target(targetKey);
    // The same freshness rule the route applies, re-checked here (a policy
    // cleanup never passes the route): the target's latest finished check,
    // at most an hour old.
    const row = checkId ? await getCheck(checkId) : null;
    const stale = checkFreshness({ check: row, latest: await store.latestCheck(targetKey), targetKey, now: now() });
    if (stale) throw stale;
    const check = checkView(row);
    const validated = validateCleanupRequest({ check, request, target: t });
    const busy = busyFrom(await activityFor(t));
    if (busy) throw error('GUEST_BUSY', 409, GUEST_BUSY_MESSAGE, { reason: busy });
    const selection = resolveSelection(validated);
    const est = estimateSelection(check, { items: validated.items.map(i => i.id), snapshots: validated.snapshots.map(i => i.id), exports: validated.exports.map(i => i.id) });
    const cleanupId = newId();
    await store.insertCleanup({ id: cleanupId, targetKey, checkId: check.checkId, origin, status: 'queued', scope: validated.scope, selection, createdAt: iso(now()), requestedBy: userId == null ? null : String(userId) });
    let sub;
    try { sub = await submitJob({ cleanupId, targetKey, guest: t.guest, origin, requestedBy: userId == null ? origin : String(userId) }); }
    catch (e) { sub = { error: e?.message || String(e), code: e?.code || 'JOB_UNAVAILABLE' }; }
    if (!sub || sub.error || !sub.jobId) {
      const isBusy = BUSY_CODES.has(sub?.code);
      const reason = isBusy ? GUEST_BUSY_MESSAGE : sub?.code === 'RUNNER_UNAVAILABLE' ? sub.error : 'The cleanup job could not be started; nothing was changed.';
      await store.updateCleanup(cleanupId, { status: 'refused', finishedAt: iso(now()), result: { status: 'refused', reason, removed: [], skipped: selection.map(e => ({ id: e.id, label: e.label, reason: 'Not started.' })), failed: [], health: 'not-checked' } });
      record({ action: 'STORAGE_CLEANUP_REFUSED', userId, ip, targetKey, details: { cleanupId, origin, code: sub?.code || null } });
      if (isBusy) throw error('GUEST_BUSY', 409, GUEST_BUSY_MESSAGE);
      if (sub?.code === 'RUNNER_UNAVAILABLE') throw error('RUNNER_UNAVAILABLE', 503, sub.error);
      throw error('JOB_UNAVAILABLE', 503, reason);
    }
    await store.updateCleanup(cleanupId, { jobId: sub.jobId });
    const count = kind => selection.filter(kind).length;
    record({
      action: origin === 'policy' ? 'STORAGE_RETENTION_APPLIED' : 'STORAGE_CLEANUP_APPROVED', userId, ip, targetKey,
      details: {
        cleanupId, jobId: sub.jobId, checkId: check.checkId, scope: validated.scope, origin,
        counts: { items: count(e => e.action !== 'delete-snapshot' && e.action !== 'delete-export'), snapshots: count(e => e.action === 'delete-snapshot'), exports: count(e => e.action === 'delete-export') },
        estimateBytes: est.bytes, labels: selection.slice(0, 200).map(e => e.label),
      },
    });
    return { changed: true, cleanupId, jobId: sub.jobId, estimate: est };
  }

  // A row whose job ended without the operation writing a result (refused
  // before it ran, interrupted before its first item, lost): the row takes the
  // job's verdict, from the job's recorded result when there is one.
  async function reconcile(row) {
    if (!row || TERMINAL.has(row.status) || !row.jobId || typeof getJob !== 'function') return row;
    const job = await getJob(row.jobId);
    if (!job || !JOB_TERMINAL.has(job.status)) return row;
    const recorded = parse(job.progress_json ?? job.progress)?.result?.cleanup;
    let result = recorded && CLEANUP_STATUSES.includes(recorded.status) ? recorded : null;
    if (!result) {
      const refused = job.status === 'refused' || job.status === 'deferred';
      const status = job.status === 'cancelled' ? 'cancelled' : refused ? 'refused' : 'failed';
      const reason = status === 'cancelled' ? 'The cleanup was cancelled before it recorded a result.' : refused ? `The cleanup did not start: ${job.reason || job.outcome || job.status}.` : `The cleanup job ended (${job.outcome || job.status}) before it recorded a result.`;
      result = { status, reason, removed: [], skipped: [], failed: [], health: 'not-checked' };
    }
    const finishedAt = job.finished_at || iso(now());
    await store.updateCleanup(row.id, { status: result.status, result, finishedAt });
    if (result.status === 'failed' && monitor?.postCleanupAlert && !recorded) {
      let name = row.targetKey;
      try { name = (await resolveTarget(row.targetKey))?.name || name; } catch { /* the key names it */ }
      try { await monitor.postCleanupAlert(row.targetKey, { ok: false, failedCount: 0 }, { name }); } catch (e) { log('alert failed', e?.message || e); }
    }
    return { ...row, status: result.status, result, finishedAt };
  }

  // The job as the UI reads it: status, phase and its last 20 events (the
  // engine redacts events on write).
  const summary = async job => {
    if (!job) return null;
    let events = [];
    if (typeof listEvents === 'function') {
      try { events = ((await listEvents(job.id)) || []).slice(-20).map(e => ({ at: e.at ?? e.created_at ?? null, kind: e.kind ?? null, phase: e.phase ?? null, message: e.message ?? null })); } catch { events = []; }
    }
    return { id: job.id, status: job.status, phase: job.phase ?? null, outcome: job.outcome ?? null, reason: job.reason ?? null, events };
  };
  const publicView = async row => ({
    ...row,
    selection: row.selection.map(e => ({ id: e.id, label: e.label, category: e.category, kind: e.kind, action: e.action, bytes: e.action === 'vacuum-journal' && e.recoverableBytes != null ? e.recoverableBytes : e.allocatedBytes, memoryBacked: e.memoryBacked === true })),
    job: row.jobId && typeof getJob === 'function' ? await summary(await getJob(row.jobId)) : null,
  });

  async function getCleanup(id) {
    if (typeof id !== 'string' || !/^cln_[a-f0-9-]{36}$/.test(id)) return null;
    const row = cleanupRow(await store.getCleanup(id));
    if (!row) return null;
    return publicView(await reconcile(row));
  }

  async function listCleanups(targetKey, limit = 10) {
    if (typeof targetKey !== 'string' || !TARGET_KEY_RE.test(targetKey)) return [];
    const rows = ((await store.listCleanups(targetKey, { limit: Math.min(50, Math.max(1, Number(limit) || 10)) })) || []).map(cleanupRow);
    const out = [];
    for (const row of rows) out.push(await publicView(await reconcile(row)));
    return out;
  }

  return { requestCleanup, getCleanup, listCleanups };
}
