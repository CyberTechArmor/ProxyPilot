// Application storage targets: registered existing applications (Nodus) and
// Dev Studio projects with a guest. One key format, `<kind>:<id>`. Reads
// mock2.db (targets) and the main DB (setup-engine jobs and leases) through
// injected handles, so nothing here opens a database or imports a native
// module.

import { createApplicationStore } from '../../mock2/application-store.js';
import { APPLICATION_JOB_KINDS, applicationGuestName } from '../setup-engine/application-deploy-logic.js';

export const TARGET_KINDS = Object.freeze(['application', 'project']);
const KEY_RE = /^(application|project):([1-9][0-9]{0,15})$/;
const LIVE_CYCLE_STATUSES = Object.freeze(['queued', 'estimating', 'running']);
const OPEN_STATUSES = "('queued','running')";
// An application job is open while queued or running, and also while it is
// recovery_required and not yet recovered (the same rule as the setup
// engine's own "is an application job open", backend.js): its staging
// attempt and transfer copies are still needed by the recovery.
const appJobKinds = APPLICATION_JOB_KINDS.map((k) => `'${String(k).replace(/'/g, "''")}'`).join(',');
const OPEN_JOB_SQL = `(status IN ${OPEN_STATUSES} OR (status = 'recovery_required' AND kind IN (${appJobKinds}) AND (outcome IS NULL OR outcome <> 'application_recovered')))`;

export class AppStorageError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'AppStorageError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export const targetKeyOf = (kind, id) => `${kind}:${Number(id)}`;

/** `application:1` → { kind, id }; anything else is refused. */
export function parseTargetKey(key) {
  const m = KEY_RE.exec(String(key ?? ''));
  if (!m) throw new AppStorageError('INVALID_TARGET', 'Name an application or project as application:<id> or project:<id>.', 400);
  return { kind: m[1], id: Number(m[2]) };
}

function safeJson(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
}

function projectGuest(row) {
  return row.container_name || `m2-${row.id}`;
}

/** Every target shown in the overview, applications first. */
export function listTargets({ mock2Db }) {
  const out = [];
  if (tableExists(mock2Db, 'mock2_applications')) {
    for (const row of mock2Db.prepare('SELECT id, target_id, name, created_at, imported_at FROM mock2_applications ORDER BY name, id').all()) {
      out.push({ key: targetKeyOf('application', row.id), kind: 'application', id: Number(row.id), name: row.name, guest: applicationGuestName(row.target_id), targetId: row.target_id, createdAt: row.created_at || null });
    }
  }
  if (tableExists(mock2Db, 'mock2_projects')) {
    for (const row of mock2Db.prepare('SELECT id, name, container_name, lifecycle, created_at FROM mock2_projects ORDER BY name, id').all()) {
      // An archived project has no guest any more (its container_name is NULL).
      if (row.lifecycle === 'archived' && !row.container_name) continue;
      out.push({ key: targetKeyOf('project', row.id), kind: 'project', id: Number(row.id), name: row.name, guest: projectGuest(row), lifecycle: row.lifecycle, createdAt: row.created_at || null });
    }
  }
  return out;
}

/** The full target, with the layout knowledge classification needs. */
export function resolveTarget(key, { mock2Db }) {
  const { kind, id } = parseTargetKey(key);
  const notFound = () => new AppStorageError('TARGET_NOT_FOUND', kind === 'application' ? 'That application is not registered.' : 'That project does not exist or has no container.', 404);
  if (kind === 'application') {
    if (!tableExists(mock2Db, 'mock2_applications')) throw notFound();
    const row = mock2Db.prepare('SELECT id, target_id, name, created_at, imported_at FROM mock2_applications WHERE id = ?').get(id);
    if (!row) throw notFound();
    let app;
    try { app = createApplicationStore(mock2Db).get(id); } catch { throw notFound(); }
    const profile = app.profile || {};
    return {
      key: targetKeyOf(kind, id), kind, id, name: app.name, guest: applicationGuestName(app.targetId), targetId: app.targetId,
      createdAt: row.created_at || null, importedAt: row.imported_at || null,
      profile: {
        sourceDir: profile.sourceDir || null, releaseRoot: profile.releaseRoot || null, serviceName: profile.serviceName || null,
        healthUrl: profile.healthUrl || null, preservePaths: profile.preservePaths || [], envFiles: profile.envFiles || [], revision: profile.revision || null,
      },
      live: app.live || null,
      candidates: (app.candidates || []).map((c) => ({ sha: c.sha, checkpointAt: c.checkpointAt, validation: c.validation ? { passed: !!c.validation.passed, releasePath: c.validation.releasePath || null, validatedAt: c.validation.validatedAt || null, jobId: c.validation.jobId || null } : null })),
    };
  }
  if (!tableExists(mock2Db, 'mock2_projects')) throw notFound();
  const row = mock2Db.prepare('SELECT id, name, container_name, lifecycle, repo_path, created_at FROM mock2_projects WHERE id = ?').get(id);
  if (!row || (row.lifecycle === 'archived' && !row.container_name)) throw notFound();
  return {
    key: targetKeyOf(kind, id), kind, id, name: row.name, guest: projectGuest(row), lifecycle: row.lifecycle,
    createdAt: row.created_at || null, repoPath: row.repo_path || null, appDir: '/srv/app', repoMount: '/srv/repo.git',
  };
}

const attemptOf = (job) => `${job.id}-${job.epoch || 1}`;

/**
 * What is happening on the target now: open setup-engine jobs on its guest,
 * a held guest lease, a running Dev Studio build. `excludeJobId` leaves out
 * the caller's own job (the cleanup job's rescan).
 */
export function activityFor(target, { mainDb, mock2Db, now = Date.now(), excludeJobId = null } = {}) {
  const nowMs = typeof now === 'function' ? now() : Number(now);
  const out = { openJobs: [], buildActive: false, leaseHeld: null, openRestoreJob: false, anyApplicationJobOpen: false, activeAttempts: [], recoveryAttempts: [], openJobIds: [], reasons: [] };
  const guest = target.guest;
  if (mainDb && tableExists(mainDb, 'setup_jobs')) {
    const rows = mainDb.prepare(`SELECT id, kind, app, status, epoch FROM setup_jobs WHERE app = ? AND ${OPEN_JOB_SQL} ORDER BY created_at`).all(String(guest));
    for (const job of rows) {
      if (excludeJobId && job.id === excludeJobId) continue;
      out.openJobs.push({ id: job.id, kind: job.kind, status: job.status, attempt: attemptOf(job) });
      out.openJobIds.push(job.id, attemptOf(job));
    }
    out.activeAttempts = out.openJobs.filter((j) => APPLICATION_JOB_KINDS.includes(j.kind)).map((j) => j.attempt);
    out.recoveryAttempts = out.openJobs.filter((j) => APPLICATION_JOB_KINDS.includes(j.kind) && j.status === 'recovery_required').map((j) => j.attempt);
    out.openRestoreJob = out.openJobs.some((j) => j.kind === 'restore_snapshot');
    const marks = APPLICATION_JOB_KINDS.map(() => '?').join(',');
    const anyApp = mainDb.prepare(`SELECT id FROM setup_jobs WHERE kind IN (${marks}) AND ${OPEN_JOB_SQL}`).all(...APPLICATION_JOB_KINDS);
    out.anyApplicationJobOpen = anyApp.some((j) => j.id !== excludeJobId);
    if (target.kind === 'application') {
      const build = out.openJobs.find((j) => APPLICATION_JOB_KINDS.includes(j.kind));
      if (build) { out.buildActive = true; out.reasons.push(build.status === 'recovery_required' ? `An application ${build.kind.replace('application_', '')} job was interrupted and needs recovery.` : `An application ${build.kind.replace('application_', '')} job is ${build.status}.`); }
    } else {
      const deploy = out.openJobs.find((j) => j.kind === 'deploy');
      if (deploy) { out.buildActive = true; out.reasons.push(`A deploy of this project is ${deploy.status}.`); }
    }
    if (out.openRestoreJob) out.reasons.push('A snapshot restore is running.');
  }
  if (mainDb && tableExists(mainDb, 'setup_locks')) {
    const lock = mainDb.prepare('SELECT app, operation, job_id, lease_expires_at, stale_since FROM setup_locks WHERE app = ?').get(String(guest));
    if (lock && lock.job_id !== excludeJobId) {
      const expires = Date.parse(lock.lease_expires_at || '');
      if ((Number.isFinite(expires) && expires > nowMs) || lock.stale_since) {
        out.leaseHeld = { operation: lock.operation, jobId: lock.job_id || null, stale: !!lock.stale_since };
        out.reasons.push(lock.stale_since ? 'The container is held by an interrupted job that needs recovery.' : `The container is busy (${lock.operation}).`);
      }
    }
  }
  if (target.kind === 'project' && mock2Db) {
    const pid = Number(target.id);
    if (tableExists(mock2Db, 'mock2_cycles')) {
      const n = mock2Db.prepare(`SELECT COUNT(*) AS n FROM mock2_cycles WHERE project_id = ? AND status IN (${LIVE_CYCLE_STATUSES.map(() => '?').join(',')})`).get(pid, ...LIVE_CYCLE_STATUSES).n;
      if (n > 0) { out.buildActive = true; out.reasons.push('A build is running on this project.'); }
    }
    if (tableExists(mock2Db, 'mock2_build_queue')) {
      const started = mock2Db.prepare("SELECT id FROM mock2_build_queue WHERE project_id = ? AND status = 'started' LIMIT 1").get(pid);
      if (started) { out.buildActive = true; out.reasons.push('A queued build has started.'); }
    }
    if (tableExists(mock2Db, 'mock2_locks')) {
      const lock = mock2Db.prepare('SELECT holder_cycle_id, holder_user_id FROM mock2_locks WHERE project_id = ?').get(pid);
      if (lock && lock.holder_cycle_id != null) { out.buildActive = true; out.reasons.push('A build holds the project checkout.'); }
    }
  }
  out.reasons = [...new Set(out.reasons)];
  return out;
}

/** A guest is busy for a cleanup when its lease is held or a mutating job is open. */
export function guestBusy(activity) {
  return !!activity?.leaseHeld || (activity?.openJobs || []).length > 0 || !!activity?.buildActive;
}
