// Application storage store (mock2.db, migration 560). Checks, per-target
// policies, cleanup records and usage samples. The feature must not itself
// grow without bound: the newest 20 checks per target, 50 cleanups per
// target and 30 days of samples are kept (pruned on insert).
//
// Works on any handle with prepare()/exec() (better-sqlite3 in production,
// node:sqlite in tests); no transaction helper is required.

export const APP_STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS mock2_storage_checks (
  id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  requested_by TEXT,
  result_json TEXT,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_mock2_storage_checks_target ON mock2_storage_checks(target_key, started_at);
CREATE TABLE IF NOT EXISTS mock2_storage_policies (
  target_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  proposed_json TEXT
);
CREATE TABLE IF NOT EXISTS mock2_storage_cleanups (
  id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  check_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  job_id TEXT,
  scope TEXT,
  selection_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  requested_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_mock2_storage_cleanups_target ON mock2_storage_cleanups(target_key, created_at);
CREATE TABLE IF NOT EXISTS mock2_storage_samples (
  target_key TEXT NOT NULL,
  sampled_at TEXT NOT NULL,
  used_bytes INTEGER NOT NULL,
  PRIMARY KEY (target_key, sampled_at)
);
`;

/** The mock2 setting written once by migration 560: when this feature was installed. */
export const INSTALLED_AT_SETTING = 'app_storage.installed_at';

export const CHECKS_PER_TARGET = 20;
export const CLEANUPS_PER_TARGET = 50;
export const SAMPLE_RETENTION_DAYS = 30;
export const CHECK_STATUSES = Object.freeze(['running', 'complete', 'partial', 'failed']);
export const CLEANUP_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'partial', 'failed', 'refused', 'cancelled']);
const OPEN_CLEANUP = "('queued','running')";

const iso = (v) => (v == null ? new Date().toISOString() : typeof v === 'number' ? new Date(v).toISOString() : v instanceof Date ? v.toISOString() : String(v));
const parse = (text) => { if (text == null) return null; try { return JSON.parse(text); } catch { return null; } };

export function ensureAppStorageSchema(db) {
  db.exec(APP_STORAGE_SCHEMA);
}

export function readInstalledAt(db) {
  try { return db.prepare('SELECT value FROM mock2_settings WHERE key = ?').get(INSTALLED_AT_SETTING)?.value || null; } catch { return null; }
}

export function createStorageStore(db, { now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('createStorageStore needs a database handle');
  const nowMs = () => (typeof now === 'function' ? now() : Number(now));

  const checkView = (r, { withResult = true } = {}) => (!r ? null : {
    id: r.id, checkId: r.id, targetKey: r.target_key, origin: r.origin, status: r.status,
    startedAt: r.started_at, finishedAt: r.finished_at || null, requestedBy: r.requested_by || null, errorCode: r.error_code || null,
    ...(withResult ? { result: parse(r.result_json) } : {}),
  });

  function pruneChecks(targetKey) {
    // Keep the newest CHECKS_PER_TARGET; a running check is never pruned.
    const stale = db.prepare(`SELECT id FROM mock2_storage_checks WHERE target_key = ? AND status <> 'running' ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?`).all(String(targetKey), CHECKS_PER_TARGET);
    const del = db.prepare('DELETE FROM mock2_storage_checks WHERE id = ?');
    for (const r of stale) del.run(r.id);
    return stale.length;
  }

  function pruneCleanups(targetKey) {
    const stale = db.prepare(`SELECT id FROM mock2_storage_cleanups WHERE target_key = ? AND status NOT IN ${OPEN_CLEANUP} ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`).all(String(targetKey), CLEANUPS_PER_TARGET);
    const del = db.prepare('DELETE FROM mock2_storage_cleanups WHERE id = ?');
    for (const r of stale) del.run(r.id);
    return stale.length;
  }

  function pruneSamples(targetKey = null) {
    const cutoff = iso(nowMs() - SAMPLE_RETENTION_DAYS * 86_400_000);
    const r = targetKey == null
      ? db.prepare('DELETE FROM mock2_storage_samples WHERE sampled_at < ?').run(cutoff)
      : db.prepare('DELETE FROM mock2_storage_samples WHERE target_key = ? AND sampled_at < ?').run(String(targetKey), cutoff);
    return Number(r?.changes || 0);
  }

  function getPolicy(targetKey) {
    const r = db.prepare('SELECT * FROM mock2_storage_policies WHERE target_key = ?').get(String(targetKey));
    return r ? { targetKey: r.target_key, revision: Number(r.revision), policy: parse(r.policy_json), source: r.source, updatedAt: r.updated_at, updatedBy: r.updated_by || null, proposedRules: Array.isArray(parse(r.proposed_json)) ? parse(r.proposed_json) : null } : null;
  }

  function getCleanup(id) {
    const r = db.prepare('SELECT * FROM mock2_storage_cleanups WHERE id = ?').get(String(id));
    return r ? {
      id: r.id, targetKey: r.target_key, checkId: r.check_id, origin: r.origin, status: r.status, jobId: r.job_id || null, scope: r.scope || null,
      selection: parse(r.selection_json) || [], result: parse(r.result_json), createdAt: r.created_at, finishedAt: r.finished_at || null, requestedBy: r.requested_by || null,
    } : null;
  }

  return {
    /* ------------------------------ checks ------------------------------ */
    insertCheck({ id, targetKey, origin = 'user', requestedBy = null, startedAt = null }) {
      if (!id || !targetKey) throw new Error('insertCheck needs id and targetKey');
      db.prepare(`INSERT INTO mock2_storage_checks (id, target_key, origin, status, started_at, requested_by) VALUES (?, ?, ?, 'running', ?, ?)`)
        .run(String(id), String(targetKey), String(origin), iso(startedAt ?? nowMs()), requestedBy == null ? null : String(requestedBy));
      pruneChecks(targetKey);
      return checkView(db.prepare('SELECT * FROM mock2_storage_checks WHERE id = ?').get(String(id)));
    },
    finishCheck(id, { status, result = null, errorCode = null, finishedAt = null } = {}) {
      if (!CHECK_STATUSES.includes(status) || status === 'running') throw new Error(`finishCheck: invalid status ${status}`);
      const r = db.prepare(`UPDATE mock2_storage_checks SET status = ?, finished_at = ?, result_json = ?, error_code = ? WHERE id = ? AND status = 'running'`)
        .run(status, iso(finishedAt ?? nowMs()), result == null ? null : JSON.stringify(result), errorCode, String(id));
      return Number(r?.changes || 0) === 1;
    },
    getCheck(id) {
      return checkView(db.prepare('SELECT * FROM mock2_storage_checks WHERE id = ?').get(String(id)));
    },
    /** The newest finished check of the target (complete or partial unless asked otherwise). */
    latestCheck(targetKey, { statuses = ['complete', 'partial'] } = {}) {
      const marks = statuses.map(() => '?').join(',');
      return checkView(db.prepare(`SELECT * FROM mock2_storage_checks WHERE target_key = ? AND status IN (${marks}) ORDER BY started_at DESC, id DESC LIMIT 1`).get(String(targetKey), ...statuses));
    },
    /** The check running now for this target; one older than maxAgeMs is not counted (it was interrupted). */
    runningCheck(targetKey, { maxAgeMs = null } = {}) {
      const row = db.prepare(`SELECT * FROM mock2_storage_checks WHERE target_key = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`).get(String(targetKey));
      if (!row) return null;
      if (maxAgeMs != null && nowMs() - Date.parse(row.started_at) > maxAgeMs) return null;
      return checkView(row, { withResult: false });
    },
    listChecks(targetKey, { limit = CHECKS_PER_TARGET } = {}) {
      return db.prepare('SELECT * FROM mock2_storage_checks WHERE target_key = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(String(targetKey), Math.max(1, Math.min(100, Number(limit) || CHECKS_PER_TARGET)))
        .map((r) => checkView(r, { withResult: false }));
    },
    /** Every check still marked running (any target), oldest first. */
    listRunningChecks() {
      return db.prepare("SELECT * FROM mock2_storage_checks WHERE status = 'running' ORDER BY started_at").all().map((r) => checkView(r, { withResult: false }));
    },

    /* ----------------------------- policies ----------------------------- */
    getPolicy,
    /**
     * Save a policy document as the next revision. `expectedRevision` (the
     * revision the editor read; 0 = none stored yet) refuses a lost update.
     */
    putPolicy(targetKey, { policy, source = 'edited', updatedBy = null, expectedRevision = undefined, proposedRules = null } = {}) {
      if (!policy || typeof policy !== 'object') throw new Error('putPolicy needs a policy document');
      const current = getPolicy(targetKey);
      const currentRevision = current ? current.revision : 0;
      if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== currentRevision) {
        const e = new Error('The policy changed since it was read; reload it and try again.');
        e.code = 'POLICY_CHANGED'; e.status = 409; e.currentRevision = currentRevision;
        throw e;
      }
      const revision = currentRevision + 1;
      const at = iso(nowMs());
      // Rules still proposed (never turned on) keep that marker across edits of other rules.
      const proposed = Array.isArray(proposedRules) ? JSON.stringify(proposedRules.map(String)) : null;
      if (current) {
        const r = db.prepare('UPDATE mock2_storage_policies SET revision = ?, policy_json = ?, source = ?, updated_at = ?, updated_by = ?, proposed_json = ? WHERE target_key = ? AND revision = ?')
          .run(revision, JSON.stringify(policy), String(source), at, updatedBy == null ? null : String(updatedBy), proposed, String(targetKey), currentRevision);
        if (Number(r?.changes || 0) !== 1) { const e = new Error('The policy changed while it was being saved; reload it and try again.'); e.code = 'POLICY_CHANGED'; e.status = 409; throw e; }
      } else {
        db.prepare('INSERT INTO mock2_storage_policies (target_key, revision, policy_json, source, updated_at, updated_by, proposed_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(String(targetKey), revision, JSON.stringify(policy), String(source), at, updatedBy == null ? null : String(updatedBy), proposed);
      }
      return getPolicy(targetKey);
    },
    listPolicies() {
      return db.prepare('SELECT * FROM mock2_storage_policies ORDER BY target_key').all()
        .map((r) => getPolicy(r.target_key));
    },

    /* ----------------------------- cleanups ----------------------------- */
    insertCleanup({ id, targetKey, checkId, origin = 'user', status = 'queued', jobId = null, scope = null, selection, requestedBy = null, createdAt = null }) {
      if (!id || !targetKey || !checkId) throw new Error('insertCleanup needs id, targetKey and checkId');
      if (!CLEANUP_STATUSES.includes(status)) throw new Error(`insertCleanup: invalid status ${status}`);
      db.prepare(`INSERT INTO mock2_storage_cleanups (id, target_key, check_id, origin, status, job_id, scope, selection_json, created_at, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(String(id), String(targetKey), String(checkId), String(origin), status, jobId, scope, JSON.stringify(selection ?? []), iso(createdAt ?? nowMs()), requestedBy == null ? null : String(requestedBy));
      pruneCleanups(targetKey);
      return getCleanup(id);
    },
    updateCleanup(id, { status = undefined, jobId = undefined, result = undefined, finishedAt = undefined } = {}) {
      const sets = []; const args = [];
      if (status !== undefined) { if (!CLEANUP_STATUSES.includes(status)) throw new Error(`updateCleanup: invalid status ${status}`); sets.push('status = ?'); args.push(status); }
      if (jobId !== undefined) { sets.push('job_id = ?'); args.push(jobId); }
      if (result !== undefined) { sets.push('result_json = ?'); args.push(result == null ? null : JSON.stringify(result)); }
      if (finishedAt !== undefined) { sets.push('finished_at = ?'); args.push(finishedAt == null ? null : iso(finishedAt)); }
      if (!sets.length) return false;
      const r = db.prepare(`UPDATE mock2_storage_cleanups SET ${sets.join(', ')} WHERE id = ?`).run(...args, String(id));
      return Number(r?.changes || 0) === 1;
    },
    getCleanup,
    listCleanups(targetKey, { limit = 10 } = {}) {
      return db.prepare('SELECT id FROM mock2_storage_cleanups WHERE target_key = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(String(targetKey), Math.max(1, Math.min(CLEANUPS_PER_TARGET, Number(limit) || 10)))
        .map((r) => getCleanup(r.id));
    },

    /* ------------------------------ samples ----------------------------- */
    addSample(targetKey, usedBytes, sampledAt = null) {
      const used = Math.round(Number(usedBytes));
      if (!Number.isFinite(used) || used < 0) return false;
      db.prepare('INSERT OR REPLACE INTO mock2_storage_samples (target_key, sampled_at, used_bytes) VALUES (?, ?, ?)').run(String(targetKey), iso(sampledAt ?? nowMs()), used);
      pruneSamples(targetKey);
      return true;
    },
    samplesSince(targetKey, since) {
      return db.prepare('SELECT sampled_at, used_bytes FROM mock2_storage_samples WHERE target_key = ? AND sampled_at >= ? ORDER BY sampled_at').all(String(targetKey), iso(since))
        .map((r) => ({ sampledAt: r.sampled_at, usedBytes: Number(r.used_bytes) }));
    },
    latestSample(targetKey) {
      const r = db.prepare('SELECT sampled_at, used_bytes FROM mock2_storage_samples WHERE target_key = ? ORDER BY sampled_at DESC LIMIT 1').get(String(targetKey));
      return r ? { sampledAt: r.sampled_at, usedBytes: Number(r.used_bytes) } : null;
    },

    /** Apply every retention limit (all targets). */
    prune() {
      let checks = 0; let cleanups = 0;
      for (const { target_key: key } of db.prepare('SELECT DISTINCT target_key FROM mock2_storage_checks').all()) checks += pruneChecks(key);
      for (const { target_key: key } of db.prepare('SELECT DISTINCT target_key FROM mock2_storage_cleanups').all()) cleanups += pruneCleanups(key);
      return { checks, cleanups, samples: pruneSamples() };
    },
  };
}
