// Mock2 audit-question data access (mock2_audit_questions, in mock2.db) — Phase
// M8. The audit step (audit.js) writes questions here, split by route (ADR-002):
// editor questions render in-chat, admin questions materialize queue items. Both
// block the deferred Build; the "awaiting user" / "awaiting admin" project status
// is DERIVED from the open rows here (03-data-model.md), never a stored flag.
//
// The pure decisions (kind→route, parse, shapes) live in audit-logic.js so they
// unit-test without better-sqlite3 (stub-first, risk R9); this module is the thin
// native half. Native (getMock2Db) — reached only on an enabled host.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

export function getQuestion(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_audit_questions WHERE id = ?`).get(Number(id));
}

export function listQuestionsForProject(projectId, { status = null } = {}) {
  const db = getMock2Db();
  if (status) {
    return db.prepare(`SELECT * FROM mock2_audit_questions WHERE project_id = ? AND status = ? ORDER BY id ASC`).all(Number(projectId), status);
  }
  return db.prepare(`SELECT * FROM mock2_audit_questions WHERE project_id = ? ORDER BY id ASC`).all(Number(projectId));
}

export function listQuestionsForCycle(cycleId, { status = null } = {}) {
  const db = getMock2Db();
  if (status) {
    return db.prepare(`SELECT * FROM mock2_audit_questions WHERE cycle_id = ? AND status = ? ORDER BY id ASC`).all(Number(cycleId), status);
  }
  return db.prepare(`SELECT * FROM mock2_audit_questions WHERE cycle_id = ? ORDER BY id ASC`).all(Number(cycleId));
}

// The open editor questions for a project — what renders as tappable choices in
// chat and what "awaiting user" derives from.
export function listOpenEditorQuestions(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_audit_questions WHERE project_id = ? AND route = 'editor' AND status = 'open' ORDER BY id ASC`)
    .all(Number(projectId));
}

export function countOpenEditorQuestions(projectId) {
  return getMock2Db()
    .prepare(`SELECT COUNT(*) AS n FROM mock2_audit_questions WHERE project_id = ? AND route = 'editor' AND status = 'open'`)
    .get(Number(projectId)).n;
}

// Open admin questions (framework deviations) — what "awaiting admin" derives
// from, mirrored as framework_deviation queue items for the admin page.
export function countOpenAdminQuestions(projectId) {
  return getMock2Db()
    .prepare(`SELECT COUNT(*) AS n FROM mock2_audit_questions WHERE project_id = ? AND route = 'admin' AND status = 'open'`)
    .get(Number(projectId)).n;
}

// Insert one audit question. choices is a plain array (stored as choices_json).
export function insertQuestion({ projectId, cycleId, route, kind, question, choices = [] }) {
  const db = getMock2Db();
  const info = db
    .prepare(
      `INSERT INTO mock2_audit_questions
         (project_id, cycle_id, route, kind, question, choices_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      Number(projectId), Number(cycleId), route, kind, String(question || ''),
      JSON.stringify(Array.isArray(choices) ? choices : []), nowIso(),
    );
  return getQuestion(info.lastInsertRowid);
}

// Mark a question answered (the editor confirmed a rule). Records the answer, who
// answered, when, and where it landed in rules.md (rules_md_anchor).
export function answerQuestion(id, { answer, answeredBy, rulesMdAnchor = null }) {
  getMock2Db()
    .prepare(
      `UPDATE mock2_audit_questions
         SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?, rules_md_anchor = ?
       WHERE id = ?`,
    )
    .run(String(answer ?? ''), answeredBy == null ? null : Number(answeredBy), nowIso(), rulesMdAnchor, Number(id));
  return getQuestion(id);
}

// Dismiss a question (an admin resolved the deviation without a rule write, or a
// stale question is being cleared). Records who/when via answered_by/answered_at.
export function dismissQuestion(id, { by = null, answer = null } = {}) {
  getMock2Db()
    .prepare(
      `UPDATE mock2_audit_questions
         SET status = 'dismissed', answer = COALESCE(?, answer), answered_by = ?, answered_at = ?
       WHERE id = ?`,
    )
    .run(answer, by == null ? null : Number(by), nowIso(), Number(id));
  return getQuestion(id);
}
