// Lean BEAF Pro — DB access (main DB, lbp_* tables from migration 700).
//
// Thin CRUD over getDb(); every decision (stage rules, movement, grounded
// briefs, validation) lives in lean-beaf-logic.js so it stays testable
// without better-sqlite3. Every mutation here writes exactly one
// lbp_activity entry via addActivity() — that single funnel is what powers
// meeting-to-meeting movement (R04) and the grounded briefs (R07).

import { getDb } from '../db.js';
import { dueScheduleMarkers } from './lean-beaf-logic.js';

const nowIso = () => new Date().toISOString();

const WORKSPACE_ID = 1; // single workspace ("Spec Ops") for now

// ---- projects ----

export function listProjects() {
  return getDb().prepare(`SELECT * FROM lbp_projects ORDER BY pinned DESC, last_activity_at DESC`).all();
}

export function getProject(id) {
  return getDb().prepare(`SELECT * FROM lbp_projects WHERE id = ?`).get(id);
}

export function createProject({ name, description, stage = 'Idea', startDate, assigneeIds = [], createdBy, mock2ProjectId = null }) {
  const db = getDb();
  const now = nowIso();
  const start = startDate || now.slice(0, 10);
  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO lbp_projects
        (workspace_id, name, description, stage, start_date, mock2_project_id,
         last_activity_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(WORKSPACE_ID, name, description ?? null, stage, start, mock2ProjectId, now, createdBy ?? null, now, now);
    const id = r.lastInsertRowid;
    db.prepare(`INSERT INTO lbp_rollout_scopes (project_id) VALUES (?)`).run(id);
    const insA = db.prepare(`INSERT OR IGNORE INTO lbp_project_assignees (project_id, user_id) VALUES (?, ?)`);
    for (const uid of assigneeIds) insA.run(id, String(uid));
    return id;
  });
  const id = tx();
  addActivity(id, { type: 'created', authorId: createdBy, payload: { stage } });
  return getProject(id);
}

export function updateProjectFields(id, { name, description, start_date, pinned }) {
  const db = getDb();
  const sets = [];
  const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
  if (start_date !== undefined) { sets.push('start_date = ?'); vals.push(start_date); }
  if (pinned !== undefined) { sets.push('pinned = ?'); vals.push(pinned ? 1 : 0); }
  if (!sets.length) return getProject(id);
  sets.push('updated_at = ?'); vals.push(nowIso());
  db.prepare(`UPDATE lbp_projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getProject(id);
}

export function setStage(id, stage) {
  getDb().prepare(`UPDATE lbp_projects SET stage = ?, updated_at = ? WHERE id = ?`).run(stage, nowIso(), id);
  return getProject(id);
}

export function closeProject(id, { outcome, reason, takeaway, userId }) {
  const now = nowIso();
  getDb().prepare(`
    UPDATE lbp_projects
       SET outcome = ?, outcome_at = ?, outcome_by = ?, outcome_reason = ?, outcome_takeaway = ?, updated_at = ?
     WHERE id = ?
  `).run(outcome, now, userId ?? null, reason, takeaway, now, id);
  return getProject(id);
}

export function setAssignees(id, userIds = []) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM lbp_project_assignees WHERE project_id = ?`).run(id);
    const ins = db.prepare(`INSERT OR IGNORE INTO lbp_project_assignees (project_id, user_id) VALUES (?, ?)`);
    for (const uid of userIds) ins.run(id, String(uid));
  });
  tx();
}

// project_id → [{user_id, username}] for a set of projects in one query.
export function assigneesByProject() {
  const rows = getDb().prepare(`
    SELECT a.project_id, a.user_id, u.username
      FROM lbp_project_assignees a
      LEFT JOIN users u ON u.id = a.user_id
     ORDER BY u.username
  `).all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.project_id)) map.set(r.project_id, []);
    map.get(r.project_id).push({ user_id: r.user_id, username: r.username || 'unknown' });
  }
  return map;
}

export function linkMock2Project(id, mock2ProjectId) {
  getDb().prepare(`UPDATE lbp_projects SET mock2_project_id = ?, updated_at = ? WHERE id = ?`)
    .run(mock2ProjectId, nowIso(), id);
  return getProject(id);
}

export function findByMock2Project(mock2ProjectId) {
  return getDb().prepare(`SELECT * FROM lbp_projects WHERE mock2_project_id = ?`).get(mock2ProjectId);
}

// Persist the manual vertical order of a Kanban column: board_pos = index for
// each id, scoped to that stage. A view preference — deliberately writes NO
// activity entry, so reordering never counts as "movement".
export function reorderProjects(stage, orderedIds) {
  const db = getDb();
  const upd = db.prepare(`UPDATE lbp_projects SET board_pos = ? WHERE id = ? AND stage = ?`);
  const tx = db.transaction(() => {
    orderedIds.forEach((id, i) => upd.run(i, Number(id), stage));
  });
  tx();
}

// ---- rollout scope (R03) ----

export function getScope(projectId) {
  const db = getDb();
  const base = db.prepare(`SELECT testers_text, site_id, region_id FROM lbp_rollout_scopes WHERE project_id = ?`).get(projectId)
    || { testers_text: null, site_id: null, region_id: null };
  const pods = db.prepare(`SELECT location_id, planned FROM lbp_scope_pods WHERE project_id = ?`).all(projectId);
  return {
    testers_text: base.testers_text,
    site_id: base.site_id,
    region_id: base.region_id,
    pod_ids: pods.filter((p) => !p.planned).map((p) => p.location_id),
    planned_pod_ids: pods.filter((p) => p.planned).map((p) => p.location_id),
  };
}

export function setScope(projectId, { testers_text, site_id, region_id, pod_ids = [], planned_pod_ids = [] }) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO lbp_rollout_scopes (project_id, testers_text, site_id, region_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET testers_text = excluded.testers_text,
        site_id = excluded.site_id, region_id = excluded.region_id
    `).run(projectId, testers_text ?? null, site_id ?? null, region_id ?? null);
    db.prepare(`DELETE FROM lbp_scope_pods WHERE project_id = ?`).run(projectId);
    const ins = db.prepare(`INSERT OR IGNORE INTO lbp_scope_pods (project_id, location_id, planned) VALUES (?, ?, ?)`);
    for (const lid of pod_ids) ins.run(projectId, Number(lid), 0);
    for (const lid of planned_pod_ids) ins.run(projectId, Number(lid), 1);
  });
  tx();
  return getScope(projectId);
}

export function scopesByProject() {
  const db = getDb();
  const bases = db.prepare(`SELECT * FROM lbp_rollout_scopes`).all();
  const pods = db.prepare(`SELECT * FROM lbp_scope_pods`).all();
  const map = new Map();
  for (const b of bases) {
    map.set(b.project_id, {
      testers_text: b.testers_text, site_id: b.site_id, region_id: b.region_id,
      pod_ids: [], planned_pod_ids: [],
    });
  }
  for (const p of pods) {
    const s = map.get(p.project_id);
    if (!s) continue;
    (p.planned ? s.planned_pod_ids : s.pod_ids).push(p.location_id);
  }
  return map;
}

// ---- activity (the single mutation funnel) ----

export function addActivity(projectId, { type, authorId = null, body = null, payload = null }) {
  const db = getDb();
  const now = nowIso();
  const r = db.prepare(`
    INSERT INTO lbp_activity (project_id, type, author_id, body, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, type, authorId ?? null, body, payload ? JSON.stringify(payload) : null, now);
  db.prepare(`UPDATE lbp_projects SET last_activity_at = ? WHERE id = ?`).run(now, projectId);
  return db.prepare(`SELECT * FROM lbp_activity WHERE id = ?`).get(r.lastInsertRowid);
}

const parseActivity = (r) => ({
  id: r.id, project_id: r.project_id, type: r.type, author_id: r.author_id,
  body: r.body, created_at: r.created_at,
  payload: r.payload_json ? JSON.parse(r.payload_json) : null,
});

export function listActivity(projectId, { limit = 200 } = {}) {
  return getDb().prepare(`
    SELECT * FROM lbp_activity WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(projectId, limit).map(parseActivity);
}

export function listActivitySince(sinceIso, { limit = 500 } = {}) {
  const db = getDb();
  const rows = sinceIso
    ? db.prepare(`SELECT * FROM lbp_activity WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`).all(sinceIso, limit)
    : db.prepare(`SELECT * FROM lbp_activity ORDER BY created_at ASC LIMIT ?`).all(limit);
  return rows.map(parseActivity);
}

// ---- meetings (R05) ----

export function latestMarker() {
  return getDb().prepare(`SELECT * FROM lbp_meeting_markers ORDER BY marked_at DESC, id DESC LIMIT 1`).get() || null;
}

export function addMarker({ markedBy = null, source = 'manual', markedAt } = {}) {
  const at = markedAt || nowIso();
  const r = getDb().prepare(`
    INSERT INTO lbp_meeting_markers (workspace_id, marked_at, marked_by, source) VALUES (?, ?, ?, ?)
  `).run(WORKSPACE_ID, at, markedBy, source);
  return getDb().prepare(`SELECT * FROM lbp_meeting_markers WHERE id = ?`).get(r.lastInsertRowid);
}

export function listMarkers({ limit = 50 } = {}) {
  return getDb().prepare(`SELECT * FROM lbp_meeting_markers ORDER BY marked_at DESC LIMIT ?`).all(limit);
}

// ---- meeting schedules (multiple, daily|weekly — migration 703) ----

export function listSchedules() {
  return getDb()
    .prepare(`SELECT * FROM lbp_schedules WHERE workspace_id = ? ORDER BY active DESC, frequency, day_of_week, time_hhmm`)
    .all(WORKSPACE_ID);
}

export function getScheduleRow(id) {
  return getDb().prepare(`SELECT * FROM lbp_schedules WHERE id = ? AND workspace_id = ?`).get(id, WORKSPACE_ID);
}

export function createSchedule({ label, frequency, day_of_week, time_hhmm, active = true, createdBy }) {
  const r = getDb().prepare(`
    INSERT INTO lbp_schedules (workspace_id, label, frequency, day_of_week, time_hhmm, active, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    WORKSPACE_ID, label ?? null, frequency,
    frequency === 'weekly' ? day_of_week : null,
    time_hhmm, active ? 1 : 0, createdBy ?? null, nowIso(),
  );
  return getScheduleRow(r.lastInsertRowid);
}

export function updateSchedule(id, patch = {}) {
  const db = getDb();
  const sets = []; const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if (patch.label !== undefined) set('label', patch.label ?? null);
  if (patch.frequency !== undefined) {
    set('frequency', patch.frequency);
    // Weekly needs a day; daily clears it. Keep them consistent here.
    if (patch.frequency === 'daily') set('day_of_week', null);
  }
  if (patch.day_of_week !== undefined) set('day_of_week', patch.day_of_week);
  if (patch.time_hhmm !== undefined) set('time_hhmm', patch.time_hhmm);
  if (patch.active !== undefined) set('active', patch.active ? 1 : 0);
  if (sets.length) db.prepare(`UPDATE lbp_schedules SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...vals, id, WORKSPACE_ID);
  return getScheduleRow(id);
}

export function deleteSchedule(id) {
  return getDb().prepare(`DELETE FROM lbp_schedules WHERE id = ? AND workspace_id = ?`).run(id, WORKSPACE_ID).changes > 0;
}

// Lazily materialize schedule markers if occurrences have passed since the
// latest marker (across ALL active schedules). Called by meeting-aware reads;
// markers accumulate as history (R05) so this never deletes or edits anything.
export function ensureScheduledMarker(now = new Date()) {
  const schedules = listSchedules().filter((s) => s.active);
  if (schedules.length === 0) return;
  const last = latestMarker();
  const due = dueScheduleMarkers({ schedules, lastMarkerAt: last?.marked_at || null, now });
  for (const iso of due) addMarker({ source: 'schedule', markedAt: iso });
}

// ---- locations ----

export function listLocations({ includeInactive = false } = {}) {
  return getDb().prepare(
    includeInactive
      ? `SELECT * FROM lbp_locations ORDER BY kind, name`
      : `SELECT * FROM lbp_locations WHERE active = 1 ORDER BY kind, name`,
  ).all();
}

export function getLocation(id) {
  return getDb().prepare(`SELECT * FROM lbp_locations WHERE id = ?`).get(id);
}

export function locationsById() {
  return new Map(listLocations({ includeInactive: true }).map((l) => [l.id, l]));
}

export function createLocation({ name, kind, parent_id }) {
  const r = getDb().prepare(`INSERT INTO lbp_locations (name, kind, parent_id) VALUES (?, ?, ?)`)
    .run(name, kind, parent_id ?? null);
  return getLocation(r.lastInsertRowid);
}

export function updateLocation(id, { name, parent_id, active }) {
  const db = getDb();
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (parent_id !== undefined) { sets.push('parent_id = ?'); vals.push(parent_id); }
  if (active !== undefined) { sets.push('active = ?'); vals.push(active ? 1 : 0); }
  if (sets.length) db.prepare(`UPDATE lbp_locations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getLocation(id);
}

// ---- metric catalog + immutable reports (R06) ----

export function listMetricDefinitions() {
  return getDb().prepare(`SELECT * FROM lbp_metric_definitions ORDER BY status = 'active' DESC, name`).all();
}

export function getMetricDefinition(id) {
  return getDb().prepare(`SELECT * FROM lbp_metric_definitions WHERE id = ?`).get(id);
}

export function createMetricDefinition({ name, unit, direction = 'up', status, proposedBy }) {
  const r = getDb().prepare(`
    INSERT INTO lbp_metric_definitions (workspace_id, name, unit, direction, status, proposed_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(WORKSPACE_ID, name, unit, direction, status, proposedBy ?? null);
  return getMetricDefinition(r.lastInsertRowid);
}

export function setMetricDefinitionStatus(id, status) {
  getDb().prepare(`UPDATE lbp_metric_definitions SET status = ? WHERE id = ?`).run(status, id);
  return getMetricDefinition(id);
}

export function addMetricReport(projectId, { metric_definition_id, value, period_label, source_text, source_url, file_id, location_id, corrects_report_id, reportedBy }) {
  const r = getDb().prepare(`
    INSERT INTO lbp_metric_reports
      (project_id, metric_definition_id, value, period_label, source_text, source_url,
       file_id, location_id, corrects_report_id, reported_by, reported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, metric_definition_id, value, period_label ?? null, source_text ?? null,
    source_url ?? null, file_id ?? null, location_id ?? null, corrects_report_id ?? null,
    reportedBy ?? null, nowIso());
  return getDb().prepare(`SELECT * FROM lbp_metric_reports WHERE id = ?`).get(r.lastInsertRowid);
}

const REPORT_SELECT = `
  SELECT r.*, m.name AS metric_name, m.unit AS unit
    FROM lbp_metric_reports r
    JOIN lbp_metric_definitions m ON m.id = r.metric_definition_id
`;

export function listMetricReports(projectId) {
  return getDb().prepare(`${REPORT_SELECT} WHERE r.project_id = ? ORDER BY r.reported_at DESC`).all(projectId);
}

export function listAllMetricReports() {
  return getDb().prepare(`${REPORT_SELECT} ORDER BY r.reported_at DESC`).all();
}

// ---- time events ----

export function addTimeEvent(projectId, { type, date, hours, note, location_id, createdBy }) {
  const r = getDb().prepare(`
    INSERT INTO lbp_time_events (project_id, type, date, hours, note, location_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, type, date, hours ?? null, note ?? null, location_id ?? null, createdBy ?? null, nowIso());
  return getDb().prepare(`SELECT * FROM lbp_time_events WHERE id = ?`).get(r.lastInsertRowid);
}

export function listTimeEvents(projectId) {
  return getDb().prepare(`SELECT * FROM lbp_time_events WHERE project_id = ? ORDER BY date DESC, id DESC`).all(projectId);
}

export function timeEventsByProject() {
  const rows = getDb().prepare(`SELECT * FROM lbp_time_events`).all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.project_id)) map.set(r.project_id, []);
    map.get(r.project_id).push(r);
  }
  return map;
}

// ---- feedback / learnings ----

export function addFeedback(projectId, { source_name, source_role, sentiment, body, capturedBy }) {
  const r = getDb().prepare(`
    INSERT INTO lbp_feedback (project_id, source_name, source_role, sentiment, body, captured_by, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, source_name ?? null, source_role ?? null, sentiment, body, capturedBy ?? null, nowIso());
  return getFeedback(r.lastInsertRowid);
}

export function getFeedback(id) {
  return getDb().prepare(`SELECT * FROM lbp_feedback WHERE id = ?`).get(id);
}

export function updateFeedback(id, { source_name, source_role, sentiment, body }) {
  getDb().prepare(`
    UPDATE lbp_feedback SET source_name = ?, source_role = ?, sentiment = ?, body = ?, updated_at = ? WHERE id = ?
  `).run(source_name ?? null, source_role ?? null, sentiment, body, nowIso(), id);
  return getFeedback(id);
}

export function listFeedback(projectId) {
  return getDb().prepare(`SELECT * FROM lbp_feedback WHERE project_id = ? ORDER BY captured_at DESC`).all(projectId);
}

export function addLearning(projectId, { body, createdBy }) {
  const r = getDb().prepare(`
    INSERT INTO lbp_learnings (project_id, body, created_by, created_at) VALUES (?, ?, ?, ?)
  `).run(projectId, body, createdBy ?? null, nowIso());
  return getDb().prepare(`SELECT * FROM lbp_learnings WHERE id = ?`).get(r.lastInsertRowid);
}

export function listLearnings(projectId) {
  return getDb().prepare(`SELECT * FROM lbp_learnings WHERE project_id = ? ORDER BY created_at DESC`).all(projectId);
}

export function learningsByProject() {
  const rows = getDb().prepare(`SELECT project_id, body FROM lbp_learnings`).all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.project_id)) map.set(r.project_id, []);
    map.get(r.project_id).push(r.body);
  }
  return map;
}

// ---- blockers (blocked flag + break-barrier audit trail) ----

const nowDate = () => nowIso().slice(0, 10);

// The project's currently-open blocker (resolved_at IS NULL), or undefined.
export function getOpenBlocker(projectId) {
  return getDb()
    .prepare(`SELECT * FROM lbp_blockers WHERE project_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get(projectId);
}

// Full blocker history for a project (the audit trail), newest first.
export function listBlockers(projectId) {
  return getDb()
    .prepare(`SELECT * FROM lbp_blockers WHERE project_id = ? ORDER BY created_at DESC, id DESC`)
    .all(projectId);
}

export function addBlocker(projectId, { reason, blocked_at, blockedBy }) {
  const r = getDb().prepare(`
    INSERT INTO lbp_blockers (project_id, reason, blocked_at, blocked_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(projectId, reason, blocked_at || nowDate(), blockedBy ?? null, nowIso());
  return getDb().prepare(`SELECT * FROM lbp_blockers WHERE id = ?`).get(r.lastInsertRowid);
}

// Break the barrier: resolve the open blocker, recording the date (defaults
// today, editable) and who did it. Returns the resolved row, or null if none
// was open.
export function resolveOpenBlocker(projectId, { resolved_at, resolvedBy, resolved_note } = {}) {
  const open = getOpenBlocker(projectId);
  if (!open) return null;
  getDb().prepare(`
    UPDATE lbp_blockers SET resolved_at = ?, resolved_by = ?, resolved_note = ? WHERE id = ?
  `).run(resolved_at || nowDate(), resolvedBy ?? null, resolved_note ?? null, open.id);
  return getDb().prepare(`SELECT * FROM lbp_blockers WHERE id = ?`).get(open.id);
}

// projectId → open blocker, for shaping list/board/overview cards in one query.
export function openBlockersByProject() {
  const rows = getDb().prepare(`SELECT * FROM lbp_blockers WHERE resolved_at IS NULL`).all();
  const map = new Map();
  for (const r of rows) if (!map.has(r.project_id)) map.set(r.project_id, r);
  return map;
}

// ---- files ----

export function addFile(projectId, { original_name, stored_name, mime, size_bytes, uploadedBy }) {
  const r = getDb().prepare(`
    INSERT INTO lbp_files (project_id, original_name, stored_name, mime, size_bytes, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, original_name, stored_name, mime ?? null, size_bytes ?? null, uploadedBy ?? null, nowIso());
  return getFile(r.lastInsertRowid);
}

export function getFile(id) {
  return getDb().prepare(`SELECT * FROM lbp_files WHERE id = ?`).get(id);
}

export function listFiles(projectId) {
  return getDb().prepare(`SELECT * FROM lbp_files WHERE project_id = ? ORDER BY created_at DESC`).all(projectId);
}

// ---- project links (R11) ----

export function addLink({ a, b, note, createdBy }) {
  getDb().prepare(`
    INSERT INTO lbp_project_links (project_a, project_b, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_a, project_b) DO UPDATE SET note = excluded.note
  `).run(a, b, note ?? null, createdBy ?? null, nowIso());
  return getDb().prepare(`SELECT * FROM lbp_project_links WHERE project_a = ? AND project_b = ?`).get(a, b);
}

export function removeLink(id) {
  return getDb().prepare(`DELETE FROM lbp_project_links WHERE id = ?`).run(id).changes > 0;
}

export function getLink(id) {
  return getDb().prepare(`SELECT * FROM lbp_project_links WHERE id = ?`).get(id);
}

// Links touching a project, rendered bidirectionally with the OTHER
// project's name/stage/outcome so the UI can show state-marked chips.
export function listLinksFor(projectId) {
  return getDb().prepare(`
    SELECT l.id, l.note, l.created_at,
           CASE WHEN l.project_a = @id THEN l.project_b ELSE l.project_a END AS other_id,
           p.name AS other_name, p.stage AS other_stage, p.outcome AS other_outcome
      FROM lbp_project_links l
      JOIN lbp_projects p ON p.id = CASE WHEN l.project_a = @id THEN l.project_b ELSE l.project_a END
     WHERE l.project_a = @id OR l.project_b = @id
     ORDER BY l.created_at DESC
  `).all({ id: projectId });
}

// ---- tasks ----

export function listTasks(projectId) {
  return getDb().prepare(`SELECT * FROM lbp_tasks WHERE project_id = ? ORDER BY position, id`).all(projectId);
}

export function getTask(id) {
  return getDb().prepare(`SELECT * FROM lbp_tasks WHERE id = ?`).get(id);
}

export function addTask(projectId, { title, parent_id, createdBy }) {
  const db = getDb();
  const pos = db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM lbp_tasks WHERE project_id = ?`).get(projectId).p;
  const r = db.prepare(`
    INSERT INTO lbp_tasks (project_id, parent_id, title, position, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, parent_id ?? null, title, pos, createdBy ?? null, nowIso());
  return getTask(r.lastInsertRowid);
}

export function updateTask(id, { title, done }) {
  const db = getDb();
  const sets = []; const vals = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (done !== undefined) {
    sets.push('done = ?'); vals.push(done ? 1 : 0);
    sets.push('done_at = ?'); vals.push(done ? nowIso() : null);
  }
  if (sets.length) db.prepare(`UPDATE lbp_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getTask(id);
}

export function deleteTask(id) {
  return getDb().prepare(`DELETE FROM lbp_tasks WHERE id = ? OR parent_id = ?`).run(id, id).changes > 0;
}

export function taskCountsByProject() {
  const rows = getDb().prepare(`
    SELECT project_id,
           SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN parent_id IS NULL AND done = 1 THEN 1 ELSE 0 END) AS done
      FROM lbp_tasks GROUP BY project_id
  `).all();
  return new Map(rows.map((r) => [r.project_id, { total: r.total, done: r.done }]));
}

// ---- users (R01: every non-pending user is a workspace member) ----

export function listWorkspaceUsers() {
  return getDb().prepare(`
    SELECT id, username, role FROM users WHERE role != 'pending' ORDER BY username
  `).all();
}

// ---- idea checker input (R10: all projects ever + their learnings) ----

export function ideaCandidates() {
  const projects = getDb().prepare(`
    SELECT id, name, description, stage, outcome, outcome_reason, outcome_takeaway FROM lbp_projects
  `).all();
  const learnings = learningsByProject();
  return projects.map((p) => ({ ...p, learnings: learnings.get(p.id) || [] }));
}

// ---- Mock2 integration ----

// Best-effort card creation when an LXC AI-dev (Mock2) project is created.
// Called from the Mock2 create route inside a try/catch — a failure here
// must never break container provisioning.
export function createCardForMock2Project({ mock2ProjectId, name, description, createdBy }) {
  const existing = findByMock2Project(mock2ProjectId);
  if (existing) return existing;
  const project = createProject({
    name, description: description ?? null, createdBy, mock2ProjectId,
  });
  addActivity(project.id, {
    type: 'lxc_linked', authorId: createdBy,
    payload: { mock2_project_id: mock2ProjectId, source: 'auto_on_mock2_create' },
  });
  return getProject(project.id);
}

// ---- demo portfolio (sample data from the concept mockup) ----

// Seeds the concept's sample portfolio so every UI state is visible.
// Admin-invoked (POST /api/lbp/seed-demo), refuses when projects exist.
export function seedDemoPortfolio({ userId } = {}) {
  const db = getDb();
  if (db.prepare(`SELECT COUNT(*) AS n FROM lbp_projects`).get().n > 0) {
    return { ok: false, error: 'Projects already exist — the demo portfolio only seeds into an empty workspace' };
  }
  const locs = listLocations({ includeInactive: true });
  const byName = (n) => locs.find((l) => l.name === n)?.id ?? null;
  const west = byName('West'); const east = byName('East');
  const northside = byName('Northside'); const region = byName('North Region');
  const mk = (args) => createProject({ ...args, createdBy: userId });

  const reminders = mk({ name: 'AI Appointment Reminders', description: 'AI phone agent that calls patients with appointment reminders and reschedules on request.', stage: 'POD' });
  setScope(reminders.id, { pod_ids: [west].filter(Boolean), planned_pod_ids: [east].filter(Boolean) });

  const selfSched = mk({ name: 'Self-Scheduling Assistant', description: 'Patient-facing assistant that books appointments without front-desk involvement.', stage: 'Testing' });
  setScope(selfSched.id, { testers_text: 'Front-desk pilot group' });

  const referral = mk({ name: 'Referral Triage Automation', description: 'Classifies inbound referrals and routes them to the right queue. Supersedes the abandoned Paper Referral OCR attempt.', stage: 'MVP' });

  const intake = mk({ name: 'Digital Intake Forms', description: 'Digital patient intake replacing paper clipboards.', stage: 'Site' });
  setScope(intake.id, { site_id: northside });

  const efax = mk({ name: 'E-Fax Routing Bot', description: 'Routes inbound e-faxes to the correct department automatically.', stage: 'Region' });
  setScope(efax.id, { region_id: region });
  addLearning(efax.id, { body: 'Department mailbox naming had to be standardized before routing accuracy passed 95%.', createdBy: userId });
  closeProject(efax.id, { outcome: 'rolled_out', reason: 'Adopted region-wide; routing accuracy sustained above target.', takeaway: 'Standardize the destination taxonomy before automating routing.', userId });
  addActivity(efax.id, { type: 'outcome_set', authorId: userId, payload: { outcome: 'rolled_out' } });

  const texting = mk({ name: 'Two-Way Patient Texting', description: 'Two-way SMS between care teams and patients.', stage: 'All' });
  closeProject(texting.id, { outcome: 'rolled_out', reason: 'Live everywhere; sustained usage across all PODs.', takeaway: 'Champion-per-site drove adoption more than training material did.', userId });
  addActivity(texting.id, { type: 'outcome_set', authorId: userId, payload: { outcome: 'rolled_out' } });

  const ocr = mk({ name: 'Paper Referral OCR', description: 'OCR of faxed paper referrals into structured fields.', stage: 'Testing' });
  addLearning(ocr.id, { body: 'Fax image quality was too inconsistent for reliable OCR on handwritten forms.', createdBy: userId });
  closeProject(ocr.id, { outcome: 'abandoned', reason: 'OCR accuracy on handwritten faxes plateaued below a usable threshold.', takeaway: 'Fix the input format (digital intake) before automating recognition.', userId });
  addActivity(ocr.id, { type: 'outcome_set', authorId: userId, payload: { outcome: 'abandoned' } });

  const vm = mk({ name: 'Voicemail Transcription Triage', description: 'Transcribes clinic voicemails and drafts triage suggestions.', stage: 'Testing' });
  closeProject(vm.id, { outcome: 'abandoned', reason: 'Transcription quality on clinical vocabulary was not good enough for triage decisions.', takeaway: 'Domain vocabulary is the hard part — evaluate on real audio before piloting.', userId });
  addActivity(vm.id, { type: 'outcome_set', authorId: userId, payload: { outcome: 'abandoned' } });

  addLink({ ...{ a: Math.min(referral.id, ocr.id), b: Math.max(referral.id, ocr.id) }, note: 'Referral Triage supersedes the abandoned OCR attempt', createdBy: userId });

  return { ok: true, seeded: 8 };
}
