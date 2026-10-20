// Setup engine — the STORAGE CLEANUP operation (DESIGN §3.2), a runner job
// under the guest's lease. Everything it removes comes from the stored
// cleanup row, cross-checked against the storage check it was approved from;
// the job plan carries only the cleanup id and the target key.
//
//   1. load the row (a finished row is returned as it is); resolve the target
//      and its activity now (this job excluded) — busy → refused, nothing done
//   2. reap stale writers in the guest, as the application ops do; every
//      guest call runs inside this attempt's containment
//   3. re-derive protection now (live/rollback/candidate/backing from the
//      guest, active build attempts and open jobs from the database)
//   4. files, data-farthest first: before each item the activity and the
//      live pointer are read again — a change stops the cleanup and every
//      remaining item is skipped; each item is a verified, quarantined,
//      non-following removal by the fixed cleanup program (checkpoint after
//      each item; a resume first finishes this cleanup's quarantine entries)
//   5. snapshots bound to their creation time; exports through the export
//      store (a copy being prepared is never removed)
//   6. health without a snapshot: the deploy op's guest `verify` for an
//      application release layout, the unit/port/health ladder for a project
//   7. rescan through the storage check, a settle wait, a re-measure
//   8. an honest result on the row, an audit entry, the cleanup and health
//      alerts (posted on failure, resolved on success)
// One item's failure never stops the others; only the stop conditions do.

import path from 'node:path';
import {
  containedScript, parseContainment, reapStaleWritersScript, parseStaleWriters,
  unitStatusScript, parseUnitStatus, portProbeScript, parsePortProbe, healthScript, parseHealth, DEFAULT_UNIT,
} from './guest-probes.js';
import { applicationGuestScript } from './application-deploy-op.js';
import { APPLICATION_JOB_KINDS } from './application-deploy-logic.js';
import { releaseContextFromApplication } from './application-release-cleanup.js';
import { readRetentionInstance } from '../snapshot-retention.js';
import { cleanupProgramScript, cleanupProgramArgv, parseProgramOutput } from '../app-storage/cleanup-program.js';
import { pathAllowed, approvedRootsFor, selectionEstimate, MIN_JOURNAL_BYTES } from '../app-storage/selection.js';
import { cleanupRow, checkView, busyFrom } from '../app-storage/cleanup-service.js';

export { STORAGE_CLEANUP_JOB_KINDS, validateStorageCleanupJob } from './storage-cleanup-logic.js';

export const SETTLING_NOTE = 'The filesystem may still be releasing space, or snapshots still hold it; check again in a few minutes.';
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'refused', 'cancelled']);
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const DEFAULT_WEB_PORT = 3000;

const REASONS = Object.freeze({
  CHANGED_SINCE_CHECK: 'It changed after the storage check, so it was left alone.',
  SYMLINK_IN_PATH: 'Its location now goes through a link, so it was left alone.',
  NOT_A_DIRECTORY: 'Its location is no longer a plain folder, so it was left alone.',
  OUTSIDE_APPROVED_ROOTS: 'Outside the locations this cleanup may change.',
  INVALID_PATH: 'Its location is not usable.',
  IN_USE: 'In use by a running process.',
  MOUNT_INSIDE: 'Another filesystem is mounted inside it.',
  NOT_REMOVABLE_TYPE: 'Not a file or folder.',
  RELEASE_IS_LIVE: 'Now protected: the release the application is running now.',
  RELEASE_IS_ROLLBACK: 'Now protected: kept so you can roll back to the previous version.',
  RELEASE_IS_CANDIDATE: 'Now protected: a validated release waiting to be deployed.',
  RELEASE_HOLDS_SHARED_DATA: 'Now protected: holds shared data that newer releases link to.',
  NOT_A_SEALED_RELEASE: 'No longer a recognised release.',
  RELEASE_OUTSIDE_ROOT: 'Outside the release folder.',
  LIVE_RELEASE_CHANGED_DURING_CLEANUP: 'The live release changed during cleanup.',
  UNSAFE_RETENTION_ROOT: 'The release folder is not in the expected safe layout.',
  RETENTION_REQUIRES_SYMLINK_LAYOUT: 'The release folder is not in the expected safe layout.',
  LIVE_RELEASE_OUTSIDE_ROOT: 'The release folder is not in the expected safe layout.',
  NODE_MISSING: 'Node.js is not installed in this guest, so nothing inside it was removed.',
  CONTAINMENT_UNAVAILABLE: 'The guest offers no process containment, so nothing inside it was removed.',
  INVALID_JOURNAL_TARGET: 'No usable size limit was recorded for the system logs.',
  JOURNAL_VACUUM_FAILED: 'The system log could not be trimmed.',
  PROGRAM_RESULT_INVALID: 'The cleanup program did not return a result.',
});
export const reasonFor = code => REASONS[code] || `Not removed (${String(code || 'unknown').slice(0, 60)}).`;

function safeError(code, message) { const e = new Error(message); e.code = code; e.storageCleanupSafe = true; return e; }
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const clone = v => JSON.parse(JSON.stringify(v));
const profileFor = p => ({ sourceDir: p.sourceDir, releaseRoot: p.releaseRoot || null, preservePaths: p.preservePaths || [], envFiles: p.envFiles || [] });

// The activity WS1 reports, with this job's own open job and lease removed
// (activityFor is asked to exclude it; this is the belt to those braces).
function ownFiltered(activity, jobId) {
  if (!activity) return { openJobs: [], buildActive: false, reasons: [] };
  return {
    ...activity,
    openJobs: (Array.isArray(activity.openJobs) ? activity.openJobs : []).filter(j => j && j.id !== jobId),
    lease: activity.lease && activity.lease.jobId !== jobId ? activity.lease : null,
    leaseHeld: activity.lease ? activity.lease.jobId !== jobId && activity.leaseHeld === true : activity.leaseHeld === true,
  };
}

function openJobIds(db, ownId) {
  if (!db) return null;
  try { return db.prepare(`SELECT id FROM setup_jobs WHERE status IN ('queued', 'running') AND id <> ?`).all(String(ownId)).map(r => r.id); } catch { return null; }
}
function applicationJobOpen(db) {
  if (!db) return true;
  try { return !!db.prepare(`SELECT 1 AS x FROM setup_jobs WHERE kind IN (${APPLICATION_JOB_KINDS.map(() => '?').join(', ')}) AND status IN ('queued', 'running') LIMIT 1`).get(...APPLICATION_JOB_KINDS); } catch { return true; }
}

export async function runStorageCleanupOperation({ params, exec, job, prior = null, db = null, deps, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), settleMs = 10_000, hostNode = process.execPath }) {
  const { store } = deps;
  const iso = () => new Date(now()).toISOString();
  const row = cleanupRow(await store.getCleanup(params.cleanupId));
  if (!row) throw safeError('CLEANUP_NOT_FOUND', 'The cleanup record was not found; nothing was removed.');
  if (row.targetKey !== params.targetKey) throw safeError('CLEANUP_TARGET_MISMATCH', 'The cleanup record names another application; nothing was removed.');
  if (TERMINAL.has(row.status)) return { status: row.status, result: row.result, alreadyFinished: true };
  const target = await deps.resolveTarget(row.targetKey);
  if (!target || target.guest !== job.app) throw safeError('GUEST_IDENTITY_MISMATCH', 'The cleanup record does not match the locked guest; nothing was removed.');
  const container = target.guest;
  const name = target.name || container;
  const attempt = `${job.id}-${job.epoch || 1}`;
  const resumed = prior?.storageCleanup === true && prior.cleanupId === row.id;
  const acc = resumed && prior.results ? clone(prior.results) : { removed: [], skipped: [], failed: [] };
  const done = new Set(resumed ? prior.done || [] : []);
  const parents = { guest: new Set(resumed ? prior.parents?.guest || [] : []), host: new Set(resumed ? prior.parents?.host || [] : []) };
  const notes = resumed ? [...(prior.notes || [])] : [];
  const startedAt = resumed && prior.startedAt ? prior.startedAt : iso();
  const wasCurrent = id => resumed && prior.current === id;
  let before = resumed ? prior.before || null : null;
  await store.updateCleanup(row.id, { status: 'running', jobId: job.id });
  const selection = Array.isArray(row.selection) ? row.selection : [];
  const save = (phase, current = null) => job.checkpoint(phase, { storageCleanup: true, resumable: true, cleanupId: row.id, done: [...done], current, parents: { guest: [...parents.guest], host: [...parents.host] }, results: acc, before, notes, startedAt });
  const audit = entry => { try { deps.audit?.({ userId: null, targetKey: row.targetKey, ...entry }); } catch { /* the row is the record */ } };
  const alert = async event => { if (!deps.monitor?.postCleanupAlert) return; try { await deps.monitor.postCleanupAlert({ targetKey: row.targetKey, targetName: name, cleanupId: row.id, ...event }); } catch { /* an alert never changes the result */ } };

  // ── executors ──
  const guestProgram = async (data, timeoutMs = 600_000) => {
    job.fence({ safe: true });
    const r = await exec.guest(container, containedScript(attempt, cleanupProgramScript(data)), { timeoutMs });
    // After a command a cancel is not honoured: its result must be recorded.
    job.fence({ safe: false });
    if (parseContainment(r?.stderr)?.kind === 'none') return { ok: false, code: 'CONTAINMENT_UNAVAILABLE' };
    return parseProgramOutput(r);
  };
  const hostProgram = async (data, timeoutMs = 600_000) => {
    job.fence({ safe: true });
    const r = await exec.host(cleanupProgramArgv(data, { node: hostNode }), { timeoutMs });
    job.fence({ safe: false });
    return parseProgramOutput(r);
  };
  const host = async (argv, timeoutMs = 60_000) => {
    job.fence({ safe: true });
    const r = await exec.host(argv, { timeoutMs });
    job.fence({ safe: false });
    return r || { code: -1, stdout: '', stderr: '' };
  };
  const guestScript = async (script, timeoutMs = 60_000) => {
    job.fence({ safe: true });
    const r = await exec.guest(container, containedScript(attempt, script), { timeoutMs });
    job.fence({ safe: false });
    return r || { code: -1, stdout: '', stderr: '' };
  };
  const hostUsage = async () => {
    try {
      const r = await host(['incus', 'query', `/1.0/instances/${container}/state`], 30_000);
      const usage = Number(JSON.parse(r.stdout || 'null')?.disk?.root?.usage);
      return r.code === 0 && Number.isFinite(usage) ? usage : null;
    } catch (e) { if (['FENCED', 'CANCELLED'].includes(e?.code)) throw e; return null; }
  };
  const activityNow = async () => ownFiltered(await deps.activityFor(target, { excludeJobId: job.id }), job.id);

  const finish = async (status, extra = {}) => {
    const result = {
      status, removed: acc.removed, skipped: acc.skipped, failed: acc.failed, health: 'not-checked', estimateBytes: null,
      reclaimed: { guestBytes: null, datasetBytes: null, settling: false }, afterCheckId: null, remaining: null, notes, startedAt, finishedAt: iso(), ...extra,
    };
    await store.updateCleanup(row.id, { status, result, finishedAt: result.finishedAt });
    audit({ action: 'STORAGE_CLEANUP_FINISHED', details: { cleanupId: row.id, jobId: job.id, status, removed: acc.removed.length, skipped: acc.skipped.length, failed: acc.failed.length, health: result.health, reclaimedBytes: result.reclaimed?.guestBytes ?? null } });
    return { status, result };
  };
  const skipRest = reason => { for (const e of selection) if (!done.has(e.id)) { acc.skipped.push({ id: e.id, label: e.label, reason }); done.add(e.id); } };

  // ── 1. activity before anything ──
  const firstActivity = await activityNow();
  const busy = busyFrom(firstActivity);
  // A fresh job stops here; a resumed one first finishes what its interrupted
  // attempt set aside, and its first stop check then skips the rest.
  if (busy && !resumed) {
    const reason = target.kind === 'project' && firstActivity.buildActive ? 'A build started; nothing was removed.' : `${busy.replace(/\.$/, '')}; nothing was removed.`;
    skipRest(`Not started: ${reason}`);
    return finish('refused', { reason });
  }

  // ── 2. stale writers, guest reachability ──
  job.fence({ safe: true });
  const reap = await exec.guest(container, reapStaleWritersScript(attempt), { timeoutMs: 30_000 });
  const stale = parseStaleWriters(reap?.stdout);
  let guestUnavailable = null;
  if (stale === null) guestUnavailable = 'The guest is not running, so nothing inside it was changed.';
  else if (stale > 0) {
    const reason = 'A previous writer in this guest could not be stopped; nothing was removed.';
    skipRest(`Not started: ${reason}`);
    return finish(acc.removed.length || acc.failed.length ? 'partial' : 'refused', { reason });
  }
  const releaseRoot = target.kind === 'application' ? (target.profile?.releaseRoot || null) : null;
  const relCtx = target.kind === 'application' ? releaseContextFromApplication(target, { root: releaseRoot }) : { previousSha: null, rollback: null, protect: [] };
  const sourceDir = target.kind === 'application' ? target.profile?.sourceDir || null : null;
  let liveInfo = null;
  if (!guestUnavailable) {
    liveInfo = await guestProgram({ action: 'live', sourceDir, ...(releaseRoot ? { profile: profileFor(target.profile), ...relCtx } : {}), statfs: true }, 120_000);
    if (!liveInfo.ok) { guestUnavailable = reasonFor(liveInfo.code); liveInfo = null; }
  }
  if (guestUnavailable && !notes.includes(guestUnavailable)) notes.push(guestUnavailable);
  const live0 = liveInfo?.live || null;
  if (!before) before = { guestUsedBytes: liveInfo?.fs?.usedBytes ?? null, datasetUsedBytes: await hostUsage() };

  // ── 3. the check it was approved from, and the target as the check saw it ──
  const check = checkView(await (deps.getCheck ? deps.getCheck(row.checkId) : store.getCheck(row.checkId)));
  const byId = new Map((check?.items || []).map(i => [i.id, i]));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const matchesCheck = e => { const i = byId.get(e.id); return !!i && i.status === 'eligible' && i.action === e.action && (i.location || 'guest') === e.location && (i.path ?? null) === e.path && same(i.identity, e.identity) && (e.kind !== 'group' || same((i.members || []).map(m => [m.path, m.identity]), (e.members || []).map(m => [m.path, m.identity]))); };
  // The service user's home as the check found it (cache roots under it).
  const pathTarget = { ...target, serviceHome: target.serviceHome ?? check?.guest?.service?.home ?? check?.context?.serviceHome ?? null, homes: target.homes ?? check?.context?.homes ?? [] };
  const attemptsOf = a => (a.openJobs || []).map(j => j.attempt || `${j.id}-${j.epoch || 1}`);

  const protectedNow = (e, activity) => {
    if (e.category === 'releases') {
      const r = liveInfo?.releases;
      if (!r) return 'The release folder could not be read now, so no release was removed.';
      if (e.path === r.live) return REASONS.RELEASE_IS_LIVE;
      if (e.path === r.rollback) return REASONS.RELEASE_IS_ROLLBACK;
      if (e.path === r.candidate || (r.protect || []).includes(e.path)) return REASONS.RELEASE_IS_CANDIDATE;
      if ((r.backing || []).includes(e.path)) return REASONS.RELEASE_HOLDS_SHARED_DATA;
    }
    if (['workspaces', 'archives'].includes(e.category) && e.location === 'guest' && attemptsOf(activity).includes(path.basename(String(e.path)).replace(/\.bundle$/, ''))) return 'Now protected: a build is using it.';
    if (e.category === 'archives' && e.location === 'host' && applicationJobOpen(db)) return 'Now protected: an application build is running.';
    if (e.category === 'history' && String(e.path || '').startsWith('/run/mock2-deploy/')) {
      const open = openJobIds(db, job.id);
      const owner = path.basename(e.path).split('.')[0];
      if (!open || open.some(id => owner === id || owner.startsWith(`${id}-`))) return 'Now protected: its job is still running.';
    }
    return null;
  };

  // A resumed job first finishes the quarantine entries the interrupted
  // attempt left (only this cleanup's names, only in approved directories).
  const finishQuarantine = async () => {
    for (const location of ['guest', 'host']) {
      const roots = [...new Set(selection.filter(e => e.location === location && e.action !== 'vacuum-journal' && e.action !== 'delete-snapshot' && e.action !== 'delete-export').flatMap(e => approvedRootsFor(e, pathTarget)))];
      if (!roots.length || (location === 'guest' && guestUnavailable)) continue;
      const data = { action: 'finish-quarantine', cleanupId: row.id, approvedRoots: roots, parents: [...parents[location]] };
      const out = location === 'host' ? await hostProgram(data, 600_000) : await guestProgram(data, 600_000);
      if (out.ok && out.removed?.length) notes.push(`Finished removing ${out.removed.length} item(s) an interrupted step had set aside.`);
      if (out.ok && out.failed?.length) notes.push(`${out.failed.length} item(s) set aside by an interrupted step could not be removed yet.`);
    }
  };

  const recordRemoveResults = (e, out) => {
    const results = Array.isArray(out.results) ? out.results : [];
    const removed = results.filter(r => r.status === 'removed');
    const gone = results.filter(r => r.status === 'gone');
    const refused = results.filter(r => r.status === 'refused');
    const failed = results.filter(r => r.status === 'failed');
    const total = results.length || 1;
    // Entries an interrupted attempt had already moved into quarantine
    // (finished above) count as removed, at their check-time size.
    const goneBytes = wasCurrent(e.id) && gone.length ? Math.round((e.allocatedBytes || 0) * gone.length / total) : 0;
    const bytes = removed.reduce((n, r) => n + (Number(r.bytes) || 0), 0) + goneBytes;
    const doneCount = removed.length + (wasCurrent(e.id) ? gone.length : 0);
    if (failed.length) acc.failed.push({ id: e.id, label: e.label, error: `${reasonFor(failed[0].code)}${total > 1 ? ` (${failed.length} of ${total} could not be removed)` : ''}`, bytes });
    else if (refused.length && !doneCount) acc.skipped.push({ id: e.id, label: e.label, reason: reasonFor(refused[0].code) });
    else if (refused.length) acc.skipped.push({ id: e.id, label: e.label, reason: `${doneCount} of ${total} removed; the rest: ${reasonFor(refused[0].code)}`, bytes });
    else if (!doneCount) acc.skipped.push({ id: e.id, label: e.label, reason: 'It no longer exists.' });
    else acc.removed.push({ id: e.id, label: e.label, bytes, ...(goneBytes ? { precision: 'estimate' } : {}), ...(gone.length && !wasCurrent(e.id) ? { alreadyGone: gone.length } : {}) });
  };

  const processFile = async (e, activity) => {
    if (e.action === 'vacuum-journal') {
      if (guestUnavailable) return void acc.skipped.push({ id: e.id, label: e.label, reason: guestUnavailable });
      if (!matchesCheck(e)) return void acc.skipped.push({ id: e.id, label: e.label, reason: 'It does not match the storage check it was approved from.' });
      if (!Number.isInteger(e.targetBytes) || e.targetBytes < MIN_JOURNAL_BYTES) return void acc.skipped.push({ id: e.id, label: e.label, reason: REASONS.INVALID_JOURNAL_TARGET });
      save('cleanup:item', e.id);
      const out = await guestProgram({ action: 'vacuum-journal', targetBytes: e.targetBytes }, 330_000);
      if (!out.ok) return void acc.failed.push({ id: e.id, label: e.label, error: reasonFor(out.code) });
      return void acc.removed.push({ id: e.id, label: e.label, bytes: Math.max(0, (Number(out.beforeBytes) || 0) - (Number(out.afterBytes) || 0)) });
    }
    const allowed = pathAllowed(e, pathTarget);
    if (!allowed.ok) return void acc.skipped.push({ id: e.id, label: e.label, reason: allowed.reason });
    if (!matchesCheck(e)) return void acc.skipped.push({ id: e.id, label: e.label, reason: 'It does not match the storage check it was approved from.' });
    const prot = protectedNow(e, activity);
    if (prot) return void acc.skipped.push({ id: e.id, label: e.label, reason: prot });
    if (e.location === 'guest' && guestUnavailable) return void acc.skipped.push({ id: e.id, label: e.label, reason: guestUnavailable });
    const members = e.kind === 'group' ? e.members : [{ path: e.path, identity: e.identity }];
    for (const m of members) parents[e.location].add(path.dirname(m.path));
    save('cleanup:item', e.id);
    const data = e.action === 'remove-release'
      ? { action: 'remove-release', cleanupId: row.id, approvedRoots: allowed.roots, profile: profileFor(target.profile), path: e.path, identity: e.identity, ...relCtx }
      : { action: 'remove', cleanupId: row.id, approvedRoots: allowed.roots, entries: members, checkInUse: true };
    const out = e.location === 'host' ? await hostProgram(data) : await guestProgram(data);
    if (!out.ok) {
      if (['CONTAINMENT_UNAVAILABLE', 'NODE_MISSING'].includes(out.code)) return void acc.skipped.push({ id: e.id, label: e.label, reason: reasonFor(out.code) });
      return void acc.failed.push({ id: e.id, label: e.label, error: reasonFor(out.code) });
    }
    recordRemoveResults(e, out);
  };

  const processSnapshot = async e => {
    if (!SNAPSHOT_NAME_RE.test(String(e.name || '')) || typeof e.identity?.createdAt !== 'string' || !matchesCheck(e)) return void acc.skipped.push({ id: e.id, label: e.label, reason: 'This restore point is not identified well enough to delete.' });
    const hostArgv = async (argv, o) => host(argv, o?.timeoutMs);
    let instance;
    try { instance = await readRetentionInstance(hostArgv, container); } catch (err) { if (['FENCED', 'CANCELLED'].includes(err?.code)) throw err; return void acc.failed.push({ id: e.id, label: e.label, error: 'The restore points could not be read.' }); }
    const snap = instance?.snapshots?.find(s => s.name === e.name);
    if (!snap) return void (wasCurrent(e.id) ? acc.removed.push({ id: e.id, label: e.label, bytes: e.allocatedBytes || 0, precision: 'estimate' }) : acc.skipped.push({ id: e.id, label: e.label, reason: 'This restore point no longer exists.' }));
    if (snap.created_at !== e.identity.createdAt) return void acc.skipped.push({ id: e.id, label: e.label, reason: 'This restore point changed since the check, so it was kept.' });
    save('cleanup:snapshot', e.id);
    const r = await host(['incus', 'snapshot', 'delete', container, e.name], 300_000);
    if (r.code !== 0) return void acc.failed.push({ id: e.id, label: e.label, error: 'Incus could not delete the restore point.' });
    let after;
    try { after = await readRetentionInstance(hostArgv, container); } catch (err) { if (['FENCED', 'CANCELLED'].includes(err?.code)) throw err; after = null; }
    if (!after || after.snapshots?.some(s => s.name === e.name)) return void acc.failed.push({ id: e.id, label: e.label, error: 'The restore point could not be verified as deleted.' });
    acc.removed.push({ id: e.id, label: e.label, bytes: e.allocatedBytes || 0 });
  };

  const processExport = async e => {
    if (!deps.exports?.get || !deps.exports?.remove) return void acc.skipped.push({ id: e.id, label: e.label, reason: 'Downloadable copies cannot be removed from here.' });
    if (!matchesCheck(e)) return void acc.skipped.push({ id: e.id, label: e.label, reason: 'It does not match the storage check it was approved from.' });
    const view = await deps.exports.get(e.exportId);
    if (!view) return void (wasCurrent(e.id) ? acc.removed.push({ id: e.id, label: e.label, bytes: e.allocatedBytes || 0, precision: 'estimate' }) : acc.skipped.push({ id: e.id, label: e.label, reason: 'This copy no longer exists.' }));
    if (view.container !== container) return void acc.skipped.push({ id: e.id, label: e.label, reason: 'This copy belongs to another guest.' });
    if (view.state !== 'ready') return void acc.skipped.push({ id: e.id, label: e.label, reason: 'This copy is being prepared or did not complete.' });
    if (e.identity?.createdAt && view.created_at !== e.identity.createdAt) return void acc.skipped.push({ id: e.id, label: e.label, reason: 'This copy changed since the check.' });
    save('cleanup:export', e.id);
    job.fence({ safe: true });
    const r = await deps.exports.remove(e.exportId, { actor: 'storage-cleanup' });
    if (!r?.deleted) return void acc.failed.push({ id: e.id, label: e.label, error: String(r?.error || 'The copy could not be deleted.').slice(0, 200) });
    acc.removed.push({ id: e.id, label: e.label, bytes: Number(view.bytes) || e.allocatedBytes || 0 });
  };

  let cancelled = null;
  try {
    if (resumed) await finishQuarantine();
    // ── 4–5. items, in the stored order (files data-farthest first, then snapshots, exports) ──
    for (const e of selection) {
      if (done.has(e.id)) continue;
      const activity = await activityNow();
      const b = busyFrom(activity);
      let stop = b ? (target.kind === 'project' && activity.buildActive ? 'a build started' : b.replace(/\.$/, '').toLowerCase()) : null;
      if (!stop && sourceDir && live0 && !guestUnavailable) {
        const l = await guestProgram({ action: 'live', sourceDir }, 60_000);
        if (!l.ok || l.live !== live0) stop = 'the live release changed';
      }
      if (stop) { skipRest(`Skipped: the application changed during cleanup (${stop}).`); notes.push(`Stopped early: ${stop}.`); break; }
      job.event?.('step', e.action === 'delete-snapshot' ? `Deleting restore point ${e.label}` : e.action === 'delete-export' ? `Deleting copy ${e.label}` : `Cleaning up ${e.label}`, { id: e.id });
      try {
        if (e.action === 'delete-snapshot') await processSnapshot(e);
        else if (e.action === 'delete-export') await processExport(e);
        else await processFile(e, activity);
      } catch (err) {
        if (['FENCED', 'CANCELLED'].includes(err?.code)) throw err;
        acc.failed.push({ id: e.id, label: e.label, error: 'An unexpected error stopped this item; its details were withheld.' });
      }
      done.add(e.id);
      save('cleanup:done', null);
    }
    // Whatever a failed removal left in quarantine was already verified and
    // approved: finish it now rather than leave it for a resume that never comes.
    if (acc.failed.length) await finishQuarantine();
  } catch (err) {
    if (err?.code !== 'CANCELLED') throw err;
    cancelled = err;
    skipRest('Skipped: the cleanup was cancelled before this item.');
  }

  // ── 6. health, without creating a snapshot ──
  let health = 'not-checked';
  let healthDetail = null;
  const changed = acc.removed.length || acc.failed.length;
  if (changed && !guestUnavailable && !cancelled) {
    job.event?.('step', 'Checking that the application is still healthy');
    try {
      if (target.kind === 'application' && releaseRoot && target.live?.sha && live0) {
        let last = null;
        for (let n = 0; n < 3 && health !== 'passed'; n += 1) {
          if (n) await sleep(2000);
          const r = await guestScript(applicationGuestScript({ action: 'verify', profile: target.profile, retention: null, expected: live0, sha: target.live.sha }), 300_000);
          let answer = null; try { answer = JSON.parse(String(r.stdout || '').trim()); } catch { answer = null; }
          if (r.code === 0 && answer?.ok) health = 'passed'; else last = answer?.code || 'VERIFY_FAILED';
        }
        if (health !== 'passed') { health = 'failed'; healthDetail = last; }
      } else if (target.kind === 'application' && target.profile?.serviceName) {
        const url = target.profile.healthUrl || '';
        const r = await guestScript(`U=${quote(target.profile.serviceName)}; echo "UNIT_ACTIVE:$(systemctl is-active "$U" 2>/dev/null || echo unknown)"; ${url ? `echo "HEALTH:$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 ${quote(url)} 2>/dev/null || echo 000)"` : 'echo HEALTH:none'}\n`, 60_000);
        const active = /^UNIT_ACTIVE:active$/m.test(r.stdout || '');
        const code = (String(r.stdout || '').match(/^HEALTH:(\d{3}|none)$/m) || [])[1];
        health = active && (code === 'none' || (code && Number(code) >= 200 && Number(code) < 400)) ? 'passed' : 'failed';
        if (health === 'failed') healthDetail = active ? `HEALTH_${code || 'NONE'}` : 'SERVICE_NOT_ACTIVE';
      } else if (target.kind === 'project') {
        const webPort = Number(target.project?.web_port) || DEFAULT_WEB_PORT;
        const unit = parseUnitStatus((await guestScript(unitStatusScript(DEFAULT_UNIT), 30_000)).stdout);
        const port = unit.isActive ? parsePortProbe((await guestScript(portProbeScript(webPort, 10), 60_000)).stdout) : { responding: false };
        const probe = port.responding ? parseHealth((await guestScript(healthScript(webPort), 60_000)).stdout) : { healthy: false };
        health = unit.isActive && port.responding && probe.healthy !== false ? 'passed' : 'failed';
        if (health === 'failed') healthDetail = !unit.isActive ? 'SERVICE_NOT_ACTIVE' : !port.responding ? 'NOT_SERVING' : 'UNHEALTHY';
      }
    } catch (err) {
      if (err?.code === 'FENCED') throw err;
      health = 'failed'; healthDetail = 'HEALTH_CHECK_ERROR';
    }
  }

  // ── 7. rescan, settle, re-measure ──
  let afterCheck = null;
  if (!cancelled && deps.performCheck) {
    job.event?.('step', 'Checking storage again');
    try {
      const fenced = { guest: (c, s, o) => { job.fence({ safe: false }); return exec.guest(c, s, o); }, host: (argv, o) => { job.fence({ safe: false }); return exec.host(argv, o); } };
      afterCheck = await deps.performCheck({ target, activity: await activityNow(), exec: fenced, policy: deps.policyFor ? await deps.policyFor(row.targetKey) : null, now, origin: 'cleanup', store });
    } catch (err) {
      if (err?.code === 'FENCED') throw err;
      notes.push('The storage check after the cleanup could not run; request a new check to see the remaining storage.');
    }
  }
  if (changed && !cancelled) { await sleep(settleMs); job.fence({ safe: false }); }
  const measured = !guestUnavailable && !cancelled ? await guestProgram({ action: 'measure' }, 60_000).catch(err => { if (err?.code === 'FENCED') throw err; return null; }) : null;
  const guestAfter = measured?.ok && measured.fs ? measured.fs.usedBytes : (afterCheck?.totals?.guest?.usedBytes ?? null);
  const datasetAfter = cancelled ? null : await hostUsage();
  const reclaimed = {
    guestBytes: before?.guestUsedBytes != null && guestAfter != null ? before.guestUsedBytes - guestAfter : null,
    datasetBytes: before?.datasetUsedBytes != null && datasetAfter != null ? before.datasetUsedBytes - datasetAfter : null,
    settling: false,
  };
  const byEntry = new Map(selection.map(e => [e.id, e]));
  const removedDisk = acc.removed.reduce((n, r) => { const e = byEntry.get(r.id); return e && e.action !== 'delete-snapshot' && e.action !== 'delete-export' && !e.memoryBacked && e.location === 'guest' ? n + (Number(r.bytes) || 0) : n; }, 0);
  if (removedDisk > 0 && (reclaimed.guestBytes == null || reclaimed.guestBytes < removedDisk * 0.5)) { reclaimed.settling = true; notes.push(SETTLING_NOTE); }
  const estimateBytes = selectionEstimate(selection, check).bytes;

  // ── 8. the honest result ──
  let status;
  if (cancelled) status = 'cancelled';
  else if (acc.failed.length && !acc.removed.length) status = 'failed';
  else if (acc.failed.length || acc.skipped.length || health === 'failed') status = 'partial';
  else status = 'succeeded';
  const out = await finish(status, { health, ...(healthDetail ? { healthDetail } : {}), estimateBytes, reclaimed, afterCheckId: afterCheck?.checkId ?? null, remaining: afterCheck?.totals ?? (measured?.ok && measured.fs ? { guest: { usedBytes: measured.fs.usedBytes, availableBytes: measured.fs.availBytes, totalBytes: measured.fs.totalBytes } } : null), ...(cancelled ? { reason: 'The cleanup was cancelled.' } : {}) });
  if (acc.failed.length) await alert({ kind: 'cleanup', ok: false, level: 'error', title: `Storage cleanup for ${name} did not finish`, body: `${acc.failed.length} item${acc.failed.length === 1 ? '' : 's'} failed: ${acc.failed.slice(0, 3).map(f => f.label).join(', ')}` });
  else if (!cancelled) await alert({ kind: 'cleanup', ok: true });
  if (health === 'failed') await alert({ kind: 'health', ok: false, level: 'error', title: `${name} did not pass its health check after storage cleanup`, body: `The health check after the cleanup failed (${healthDetail}). Nothing was rolled back and no snapshot was taken; look at the application now.` });
  else if (health === 'passed') await alert({ kind: 'health', ok: true });
  if (cancelled) throw cancelled;
  return out;
}
