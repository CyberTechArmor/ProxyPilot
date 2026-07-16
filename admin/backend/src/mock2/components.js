// Mock2 component library — data access (migration 516). The thin
// better-sqlite3 half; every rule (path safety, size caps, key format, version
// assignment, shapes) is pure in component-logic.js and unit-tested stub-first
// (risk R9).
//
// Follows the framework-registry idiom (framework.js): content rows are
// IMMUTABLE (no UPDATE path on versions); a revert or edit is a NEW version;
// mock2_components.current_version_id always points at the newest version.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { nextComponentVersion } from './component-logic.js';

const nowIso = () => new Date().toISOString();

// ---- reads ----

export function listComponents({ status = null } = {}) {
  const db = getMock2Db();
  const rows = status
    ? db.prepare(`SELECT * FROM mock2_components WHERE status = ? ORDER BY name COLLATE NOCASE`).all(String(status))
    : db.prepare(`SELECT * FROM mock2_components ORDER BY name COLLATE NOCASE`).all();
  return rows;
}

export function getComponent(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_components WHERE id = ?`).get(Number(id));
}

export function getComponentByKey(key) {
  return getMock2Db().prepare(`SELECT * FROM mock2_components WHERE key = ?`).get(String(key || '').trim());
}

export function getComponentVersion(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_component_versions WHERE id = ?`).get(Number(id));
}

// Version history, newest first, WITHOUT the (large) files_json bodies.
export function listComponentVersions(componentId) {
  return getMock2Db()
    .prepare(
      `SELECT id, component_id, version, change_reason, reverted_from_version, source,
              source_project_id, submission_id, created_by, created_at
         FROM mock2_component_versions WHERE component_id = ? ORDER BY version DESC`,
    )
    .all(Number(componentId));
}

// The current (pinned) version row of a component, content included.
export function getCurrentComponentVersion(component) {
  if (!component?.current_version_id) return null;
  return getComponentVersion(component.current_version_id);
}

// The runner's catalog: every PUBLISHED component joined with its current
// version's number (metadata only — get_component / materialization fetch the
// bodies). Ordered by key for a stable prompt.
export function listPublishedComponents() {
  return getMock2Db()
    .prepare(
      `SELECT c.id, c.key, c.name, c.description, c.category, c.tags,
              c.current_version_id, v.version AS current_version, v.contract_json
         FROM mock2_components c
         JOIN mock2_component_versions v ON v.id = c.current_version_id
        WHERE c.status = 'published'
        ORDER BY c.key`,
    )
    .all();
}

// One published component + its current version, for the runner's
// get_component tool (addressed by key). Null when absent or not published —
// the runner is only ever offered the published catalog.
export function getPublishedComponentWithVersion(key) {
  const component = getComponentByKey(key);
  if (!component || component.status !== 'published') return null;
  const version = getCurrentComponentVersion(component);
  if (!version) return null;
  return { component, version };
}

// ---- writes ----

// Create a component WITH its version 1 in one transaction. `files` is the
// already-validated normalized array; callers run component-logic validation
// first. Returns { component, version }.
export function insertComponent({
  key, name, description = null, category = null, tags = [],
  status = 'published', files, usage_md = null, contract = null, change_reason,
  source = 'in_app', sourceProjectId = null, submissionId = null, createdBy,
}) {
  const db = getMock2Db();
  let out;
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO mock2_components (key, name, description, category, tags, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, name, description, category, JSON.stringify(tags || []), status, createdBy, nowIso(), nowIso());
    const componentId = info.lastInsertRowid;
    const vinfo = db
      .prepare(
        `INSERT INTO mock2_component_versions
           (component_id, version, files_json, usage_md, contract_json, change_reason, source, source_project_id, submission_id, created_by, created_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(componentId, JSON.stringify(files), usage_md, contract ? JSON.stringify(contract) : null,
        change_reason, source, sourceProjectId, submissionId, createdBy, nowIso());
    db.prepare(`UPDATE mock2_components SET current_version_id = ? WHERE id = ?`).run(vinfo.lastInsertRowid, componentId);
    out = {
      component: db.prepare(`SELECT * FROM mock2_components WHERE id = ?`).get(componentId),
      version: db.prepare(`SELECT * FROM mock2_component_versions WHERE id = ?`).get(vinfo.lastInsertRowid),
    };
  });
  tx();
  return out;
}

// Append a new version (the ONLY way content changes; the version number is
// assigned monotonically inside the transaction). Returns the new version row.
export function insertComponentVersion(componentId, {
  files, usage_md = null, contract = null, change_reason, revertedFromVersion = null,
  source = 'in_app', sourceProjectId = null, submissionId = null, createdBy,
}) {
  const db = getMock2Db();
  let row;
  const tx = db.transaction(() => {
    const existing = db.prepare(`SELECT version FROM mock2_component_versions WHERE component_id = ?`).all(Number(componentId));
    const version = nextComponentVersion(existing);
    const info = db
      .prepare(
        `INSERT INTO mock2_component_versions
           (component_id, version, files_json, usage_md, contract_json, change_reason, reverted_from_version,
            source, source_project_id, submission_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(Number(componentId), version, JSON.stringify(files), usage_md, contract ? JSON.stringify(contract) : null,
        change_reason, revertedFromVersion, source, sourceProjectId, submissionId, createdBy, nowIso());
    db.prepare(`UPDATE mock2_components SET current_version_id = ?, updated_at = ? WHERE id = ?`)
      .run(info.lastInsertRowid, nowIso(), Number(componentId));
    row = db.prepare(`SELECT * FROM mock2_component_versions WHERE id = ?`).get(info.lastInsertRowid);
  });
  tx();
  return row;
}

// Metadata-only update (name/description/category/tags/status). Content never
// changes here — that is a new version.
export function updateComponentMeta(id, { name, description, category, tags, status } = {}) {
  const db = getMock2Db();
  const sets = [];
  const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
  if (category !== undefined) { sets.push('category = ?'); vals.push(category); }
  if (tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(tags || [])); }
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (!sets.length) return getComponent(id);
  sets.push('updated_at = ?'); vals.push(nowIso());
  vals.push(Number(id));
  db.prepare(`UPDATE mock2_components SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getComponent(id);
}

// Hard delete (admin + sudo at the route). Prefer status='deprecated' — this
// exists for mistakes, and takes the version history with it.
export function deleteComponent(id) {
  const db = getMock2Db();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM mock2_component_versions WHERE component_id = ?`).run(Number(id));
    db.prepare(`DELETE FROM mock2_components WHERE id = ?`).run(Number(id));
  });
  tx();
}

// ---- submissions (the in-platform promotion path) ----

export function insertSubmission({
  projectId, componentId = null, proposedKey = null, proposedName,
  description = null, category = null, tags = [], files, usage_md = null,
  notes = null, createdBy,
}) {
  const db = getMock2Db();
  const info = db
    .prepare(
      `INSERT INTO mock2_component_submissions
         (project_id, component_id, proposed_key, proposed_name, description, category, tags,
          files_json, usage_md, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(Number(projectId), componentId, proposedKey, proposedName, description, category,
      JSON.stringify(tags || []), JSON.stringify(files), usage_md, notes, createdBy, nowIso());
  return getSubmission(info.lastInsertRowid);
}

export function getSubmission(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_component_submissions WHERE id = ?`).get(Number(id));
}

export function listSubmissions({ status = null, projectId = null } = {}) {
  const db = getMock2Db();
  const where = [];
  const vals = [];
  if (status) { where.push('status = ?'); vals.push(String(status)); }
  if (projectId != null) { where.push('project_id = ?'); vals.push(Number(projectId)); }
  const sql = `SELECT * FROM mock2_component_submissions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
  return db.prepare(sql).all(...vals);
}

export function countPendingSubmissions() {
  return getMock2Db().prepare(`SELECT COUNT(*) AS n FROM mock2_component_submissions WHERE status = 'pending'`).get().n;
}

// Approve a pending submission INTO the library in one transaction: targeting an
// existing component appends a new version; otherwise a new component is created
// (the reviewer may override key/name/category/tags). The submission row records
// the result ids. Throws on a key collision when creating new — the route maps
// that to a 409 telling the reviewer to target the existing component instead.
export function approveSubmission(submission, { reviewerId, reason = null, overrides = {} } = {}) {
  const db = getMock2Db();
  let out;
  const tx = db.transaction(() => {
    const files = JSON.parse(submission.files_json);
    const changeReason = reason
      || `Approved from project submission #${submission.id}${submission.notes ? ` — ${submission.notes.slice(0, 500)}` : ''}`;
    let component; let version;
    if (submission.component_id) {
      component = getComponent(submission.component_id);
      if (!component) throw new Error('target component no longer exists');
      version = insertComponentVersion(component.id, {
        files, usage_md: submission.usage_md, change_reason: changeReason,
        source: 'submission', sourceProjectId: submission.project_id,
        submissionId: submission.id, createdBy: reviewerId,
      });
    } else {
      ({ component, version } = insertComponent({
        key: overrides.key || submission.proposed_key,
        name: overrides.name || submission.proposed_name,
        description: overrides.description !== undefined ? overrides.description : submission.description,
        category: overrides.category !== undefined ? overrides.category : submission.category,
        tags: overrides.tags !== undefined ? overrides.tags : JSON.parse(submission.tags || '[]'),
        files, usage_md: submission.usage_md, change_reason: changeReason,
        source: 'submission', sourceProjectId: submission.project_id,
        submissionId: submission.id, createdBy: reviewerId,
      }));
    }
    db.prepare(
      `UPDATE mock2_component_submissions
          SET status = 'approved', review_reason = ?, reviewed_by = ?, reviewed_at = ?,
              result_component_id = ?, result_version_id = ?
        WHERE id = ?`,
    ).run(reason, reviewerId, nowIso(), component.id, version.id, submission.id);
    out = { component, version, submission: getSubmission(submission.id) };
  });
  tx();
  return out;
}

// ---- per-project component selection (migration 524) ----
//
// WHICH components a project uses: suggested at define time (from the app's
// required capabilities), confirmed/declined by the editor, or picked directly
// by an operator — then installed deterministically by component-install.js
// (no model tokens) before the build runner starts. One row per
// (project, component); status is the lifecycle, install_manifest_json records
// exactly what landed (paths/bytes/sha256, never contents).

export function listProjectComponents(projectId) {
  return getMock2Db()
    .prepare(
      `SELECT pc.*, c.key, c.name, c.description, c.status AS component_status,
              v.version AS pinned_version, v.contract_json
         FROM mock2_project_components pc
         JOIN mock2_components c ON c.id = pc.component_id
         LEFT JOIN mock2_component_versions v ON v.id = pc.version_id
        WHERE pc.project_id = ?
        ORDER BY c.key`,
    )
    .all(Number(projectId));
}

export function getProjectComponent(projectId, componentId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_project_components WHERE project_id = ? AND component_id = ?`)
    .get(Number(projectId), Number(componentId));
}

export function getProjectComponentByQuestion(questionId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_project_components WHERE question_id = ?`)
    .get(Number(questionId));
}

// Insert a define-time suggestion row (status 'suggested'), linked to its
// component_suggestion audit question. No-op (returns the existing row) when
// the component was already decided for this project.
export function insertProjectComponentSuggestion({ projectId, componentId, versionId = null, questionId = null }) {
  const db = getMock2Db();
  const existing = getProjectComponent(projectId, componentId);
  if (existing) return existing;
  const info = db
    .prepare(
      `INSERT INTO mock2_project_components
         (project_id, component_id, version_id, status, origin, question_id, created_at, updated_at)
       VALUES (?, ?, ?, 'suggested', 'define', ?, ?, ?)`,
    )
    .run(Number(projectId), Number(componentId), versionId, questionId, nowIso(), nowIso());
  return db.prepare(`SELECT * FROM mock2_project_components WHERE id = ?`).get(info.lastInsertRowid);
}

// Record a decision (confirmed/declined) — from an editor's suggestion answer
// or an operator's direct pick. Upserts so an operator can select a component
// that was never suggested, or re-confirm a previously declined one.
export function decideProjectComponent({
  projectId, componentId, versionId = null, status, origin = 'operator',
  options = null, questionId = null, decidedBy = null,
}) {
  const db = getMock2Db();
  const existing = getProjectComponent(projectId, componentId);
  if (existing) {
    db.prepare(
      `UPDATE mock2_project_components
          SET status = ?, version_id = COALESCE(?, version_id), options_json = ?,
              question_id = COALESCE(?, question_id), selected_by = ?, decided_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(status, versionId, options ? JSON.stringify(options) : null, questionId,
      decidedBy, nowIso(), nowIso(), existing.id);
    return db.prepare(`SELECT * FROM mock2_project_components WHERE id = ?`).get(existing.id);
  }
  const info = db
    .prepare(
      `INSERT INTO mock2_project_components
         (project_id, component_id, version_id, status, origin, options_json, question_id, selected_by, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(Number(projectId), Number(componentId), versionId, status, origin,
      options ? JSON.stringify(options) : null, questionId, decidedBy, nowIso(), nowIso(), nowIso());
  return db.prepare(`SELECT * FROM mock2_project_components WHERE id = ?`).get(info.lastInsertRowid);
}

// Record an install outcome. 'installed' pins the version that landed and its
// manifest; 'install_failed' records the error for the queue item / UI.
export function markProjectComponentInstall({ id, ok, versionId = null, manifest = null, error = null }) {
  const db = getMock2Db();
  if (ok) {
    db.prepare(
      `UPDATE mock2_project_components
          SET status = 'installed', version_id = COALESCE(?, version_id),
              install_manifest_json = ?, install_error = NULL, installed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(versionId, manifest ? JSON.stringify(manifest) : null, nowIso(), nowIso(), Number(id));
  } else {
    db.prepare(
      `UPDATE mock2_project_components
          SET status = 'install_failed', install_error = ?, updated_at = ?
        WHERE id = ?`,
    ).run(String(error || 'install failed').slice(0, 2000), nowIso(), Number(id));
  }
  return db.prepare(`SELECT * FROM mock2_project_components WHERE id = ?`).get(Number(id));
}

export function rejectSubmission(submissionId, { reviewerId, reason }) {
  getMock2Db()
    .prepare(
      `UPDATE mock2_component_submissions
          SET status = 'rejected', review_reason = ?, reviewed_by = ?, reviewed_at = ?
        WHERE id = ?`,
    )
    .run(reason, reviewerId, nowIso(), Number(submissionId));
  return getSubmission(submissionId);
}
