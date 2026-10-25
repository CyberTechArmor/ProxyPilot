// Mock2 application foundation — ADOPTION records in mock2.db (migration 566).
// One row per adoption run (mock2_foundation_adoptions): state, step, the
// per-step record and the run's non-secret facts (data_json). The project row
// is read and its foundation_version written here directly, like
// foundation-store.js does, so this module needs nothing but mock2.db.
//
// Never a secret value: data_json holds names, sizes, hashes, counts, commit
// ids and snapshot names only.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { initialSteps, normalizeSteps, parseJson } from './foundation-adopt-logic.js';

const nowIso = () => new Date().toISOString();

export function getAdoptProject(projectId) {
  return getMock2Db().prepare('SELECT id, name, lifecycle, container_name, repo_path, web_port, parent_domain_id, foundation_version FROM mock2_projects WHERE id = ?').get(Number(projectId)) || null;
}

export function insertAdoption({ id, projectId, data = {}, lockToken = null, createdBy = null }) {
  const now = nowIso();
  getMock2Db().prepare(`INSERT INTO mock2_foundation_adoptions (id, project_id, state, step, steps_json, data_json, error, resumable, lock_token, created_by, created_at, updated_at, finished_at)
    VALUES (?, ?, 'running', ?, ?, ?, NULL, 0, ?, ?, ?, ?, NULL)`).run(
    id, Number(projectId), 'snapshot', JSON.stringify(initialSteps()), JSON.stringify(data), lockToken, createdBy == null ? null : String(createdBy), now, now,
  );
  return getAdoption(id);
}

export function getAdoption(id) {
  return getMock2Db().prepare('SELECT * FROM mock2_foundation_adoptions WHERE id = ?').get(String(id)) || null;
}

export function latestAdoption(projectId) {
  return getMock2Db().prepare('SELECT * FROM mock2_foundation_adoptions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(Number(projectId)) || null;
}

export function listAdoptionsInState(states = []) {
  if (!states.length) return [];
  return getMock2Db().prepare(`SELECT * FROM mock2_foundation_adoptions WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`).all(...states);
}

export const adoptionData = (row) => parseJson(row?.data_json, {}) || {};

// updateAdoption(id, { state, step, error, resumable, lockToken, data (merged), finished })
export function updateAdoption(id, patch = {}) {
  const cur = getAdoption(id);
  if (!cur) return null;
  const data = patch.data ? { ...adoptionData(cur), ...patch.data } : adoptionData(cur);
  getMock2Db().prepare(`UPDATE mock2_foundation_adoptions SET state = ?, step = ?, error = ?, resumable = ?, lock_token = ?, data_json = ?, updated_at = ?, finished_at = ? WHERE id = ?`).run(
    patch.state || cur.state,
    patch.step === undefined ? cur.step : patch.step,
    patch.error === undefined ? cur.error : (patch.error == null ? null : String(patch.error).slice(0, 1000)),
    patch.resumable === undefined ? cur.resumable : (patch.resumable ? 1 : 0),
    patch.lockToken === undefined ? cur.lock_token : patch.lockToken,
    JSON.stringify(data),
    nowIso(),
    patch.finished === undefined ? cur.finished_at : (patch.finished ? nowIso() : null),
    id,
  );
  return getAdoption(id);
}

// updateStep(id, name, { state, detail }) — stamps started_at / finished_at.
export function updateStep(id, name, { state, detail } = {}) {
  const cur = getAdoption(id);
  if (!cur) return null;
  const steps = normalizeSteps(parseJson(cur.steps_json, []));
  const s = steps.find((x) => x.name === name);
  if (!s) return cur;
  const now = nowIso();
  if (state) {
    if (state === 'running') { s.started_at = now; s.finished_at = null; }
    if (state === 'done' || state === 'failed' || state === 'skipped') s.finished_at = now;
    if (state === 'pending') { s.started_at = null; s.finished_at = null; }
    s.state = state;
  }
  if (detail !== undefined) s.detail = detail == null ? null : String(detail).slice(0, 600);
  getMock2Db().prepare('UPDATE mock2_foundation_adoptions SET steps_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(steps), now, id);
  return getAdoption(id);
}

export function readSteps(row) {
  return normalizeSteps(parseJson(row?.steps_json, []));
}

// ---- the project row ----

export function setFoundationVersion(projectId, version) {
  getMock2Db().prepare('UPDATE mock2_projects SET foundation_version = ? WHERE id = ?').run(version == null ? null : String(version), Number(projectId));
}

export function touchProjectActivity(projectId) {
  try { getMock2Db().prepare('UPDATE mock2_projects SET last_activity_at = ? WHERE id = ?').run(nowIso(), Number(projectId)); } catch { /* advisory */ }
}

export function deployedCommit(projectId) {
  try { return getMock2Db().prepare('SELECT deployed_commit FROM mock2_projects WHERE id = ?').get(Number(projectId))?.deployed_commit || null; } catch { return null; }
}
export function setDeployedCommit(projectId, sha) {
  try { getMock2Db().prepare('UPDATE mock2_projects SET deployed_commit = ? WHERE id = ?').run(sha == null ? null : String(sha), Number(projectId)); } catch { /* advisory: a miss costs one redundant deploy */ }
}

export function setContainerIp(projectId, ip) {
  if (!ip) return;
  getMock2Db().prepare('UPDATE mock2_projects SET container_ip = ? WHERE id = ?').run(String(ip), Number(projectId));
}

// The deployment's foundation rows in mock2.db — the run created every one of
// them (the project was not a foundation project before it): features,
// encrypted secrets, jobs and the cached object count. Returns the counts.
export function clearFoundationRows(projectId) {
  const db = getMock2Db();
  const pid = Number(projectId);
  const out = {};
  db.transaction(() => {
    for (const table of ['mock2_foundation_features', 'mock2_foundation_secrets', 'mock2_foundation_jobs']) {
      out[table] = db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(pid).changes;
    }
    out.object_count = db.prepare('DELETE FROM mock2_settings WHERE key = ?').run(`foundation_object_count.${pid}`).changes;
  })();
  return out;
}

export function foundationRowCounts(projectId) {
  const db = getMock2Db();
  const pid = Number(projectId);
  const n = (table) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`).get(pid).n;
  return { features: n('mock2_foundation_features'), secrets: n('mock2_foundation_secrets'), jobs: n('mock2_foundation_jobs') };
}

// ---- the checkout lease the run holds (mock2_locks, kind project-write) ----

// Re-assert a lease the run still owns after a backend restart marked it
// uncertain: the run itself is the remote operation, and it is resuming.
export function reactivateLease(projectId, token) {
  return getMock2Db().prepare("UPDATE mock2_locks SET holder_operation_state = 'active', last_write_at = ? WHERE project_id = ? AND holder_operation_id = ?")
    .run(nowIso(), Number(projectId), String(token || '')).changes === 1;
}
