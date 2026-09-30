import { randomUUID } from 'node:crypto';
import { assertEligible, validId } from './operational-projects-logic.js';

const ORIGIN = 'https://demo.fractionate.ai';
const AUTHORIZED = 'a8_pilot_self_review_authorized';
export const PILOT_REVIEW_USED = 'a8_pilot_self_review_used';
const HOUR = 60 * 60 * 1000;
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const refuse = () => { throw new Error('PILOT_REVIEW_REFUSED'); };

// Read by the workflow; grants can only be written by the host operator CLI.
// No grant changes a project role or supplies an approval itself.
export function pilotSelfReviewAuthorization({ one, all, now }, submission) {
  if (submission.state !== 'pending') return null;
  const project = one('SELECT owner_user_id,site_origin,archived_at FROM ops_projects WHERE id=?', submission.project_id);
  if (!project || project.archived_at || project.site_origin !== ORIGIN) return null;
  const owner = one('SELECT role FROM users WHERE id=?', project.owner_user_id);
  if (!owner || !['user', 'admin'].includes(owner.role)) return null;
  if (one('SELECT 1 FROM ops_project_events WHERE project_id=? AND subject_id=? AND action=?',
    submission.project_id, submission.id, PILOT_REVIEW_USED)) return null;
  const clock = Date.parse(now());
  for (const grant of all('SELECT * FROM ops_project_events WHERE project_id=? AND subject_id=? AND action=? ORDER BY id DESC LIMIT 20',
    submission.project_id, submission.id, AUTHORIZED)) {
    let metadata;
    try { metadata = JSON.parse(grant.metadata_json); } catch { continue; }
    if (!metadata || Object.keys(metadata).sort().join(',') !== 'content_hash,expires_at,owner_id,submission_revision') continue;
    if (grant.actor_id !== project.owner_user_id || metadata.owner_id !== project.owner_user_id ||
      metadata.content_hash !== submission.content_hash || metadata.submission_revision !== submission.revision ||
      !canonicalTime(grant.created_at) || !canonicalTime(metadata.expires_at)) continue;
    const issued = Date.parse(grant.created_at), expiry = Date.parse(metadata.expires_at);
    if (!Number.isFinite(clock) || issued > clock || expiry <= clock || expiry <= issued || expiry - issued > HOUR) continue;
    return { authorization_event_id: grant.id, owner_id: metadata.owner_id, expires_at: metadata.expires_at,
      content_hash: metadata.content_hash };
  }
  return null;
}

// Caller must be the root-only CLI. Exact pending snapshot, active demo owner,
// no active project run; all checks and the immutable event share a write lock.
export function authorizePilotSelfReview(db, { owner_id, project_id, submission_id, content_hash },
  { now = () => new Date().toISOString() } = {}) {
  if (![owner_id, project_id, submission_id].every(validId) || !/^[a-f0-9]{64}$/.test(content_hash ?? '')) refuse();
  db.exec('BEGIN IMMEDIATE');
  try {
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const actor = one('SELECT id,role FROM users WHERE id=?', owner_id);
    assertEligible(actor, actor);
    const project = one('SELECT * FROM ops_projects WHERE id=?', project_id);
    const submission = one('SELECT * FROM ops_guide_submissions WHERE project_id=? AND id=?', project_id, submission_id);
    if (!project || project.owner_user_id !== owner_id || project.archived_at || project.site_origin !== ORIGIN ||
      !submission || submission.state !== 'pending' || submission.content_hash !== content_hash ||
      !(submission.submitted_by === owner_id || JSON.parse(submission.contributors_json).includes(owner_id)) ||
      one("SELECT 1 FROM ops_agent_runs WHERE project_id=? AND state IN ('prepared','starting','running','cancelling')", project_id) ||
      one('SELECT 1 FROM ops_project_events WHERE project_id=? AND subject_id=? AND action=?', project_id, submission_id, PILOT_REVIEW_USED)) refuse();
    const created_at = now();
    if (!canonicalTime(created_at)) refuse();
    const expires_at = new Date(Date.parse(created_at) + HOUR).toISOString();
    const result = db.prepare(`INSERT INTO ops_project_events(project_id,actor_id,action,subject_id,created_at,request_id,metadata_json)
      VALUES(?,?,?,?,?,?,?)`).run(project_id, owner_id, AUTHORIZED, submission_id, created_at, randomUUID(),
      JSON.stringify({ owner_id, content_hash, submission_revision: submission.revision, expires_at }));
    db.exec('COMMIT');
    return { authorization_event_id: Number(result.lastInsertRowid), project_id, submission_id, content_hash, expires_at };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
