import { randomBytes } from 'node:crypto';
import { keycloakTargetSchema, keycloakReview, KEYCLOAK_APP } from './keycloak-logic.js';
import { createJob, getJob, jobView, appendEvent } from './store.js';
export const KEYCLOAK_SCHEMA = `
CREATE TABLE IF NOT EXISTS setup_keycloak (
 id TEXT PRIMARY KEY, ownership TEXT NOT NULL CHECK(ownership IN ('managed','external')),
 origin TEXT NOT NULL, realm TEXT NOT NULL, created_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, last_job_id TEXT, route_job_id TEXT,
 resources_json TEXT, verified_json TEXT, verified_at TEXT,
 UNIQUE(origin, realm)
);
CREATE UNIQUE INDEX IF NOT EXISTS setup_keycloak_one_managed ON setup_keycloak(ownership) WHERE ownership = 'managed';
`;
export const readKeycloak = (db, id) => db.prepare('SELECT * FROM setup_keycloak WHERE id = ?').get(id);
export function keycloakState(db) {
  return db.prepare('SELECT * FROM setup_keycloak ORDER BY created_at').all().map(r => ({
    id: r.id, ownership: r.ownership, origin: r.origin, realm: r.realm,
    resources: r.resources_json ? JSON.parse(r.resources_json) : null,
    verification: r.verified_json ? JSON.parse(r.verified_json) : null,
    verifiedAt: r.verified_at, job: r.last_job_id ? jobView(getJob(db, r.last_job_id)) : null,
  }));
}
const refusal = (code, message) => Object.assign(new Error(message), { code, status: 409 });
export function reviewedKeycloak(db, expectedRevision) {
  const plan = db.prepare('SELECT * FROM setup_platform_plan WHERE id = 1').get();
  if (!plan || plan.revision !== expectedRevision) throw refusal('PLAN_REVISION_CONFLICT', 'This plan changed. Reopen and review the saved revision before applying Keycloak.');
  const t = JSON.parse(plan.choices_json).keycloak;
  if (t.mode === 'skip') throw refusal('KEYCLOAK_SKIPPED', 'Keycloak is skipped. No operation was submitted.');
  const parsed = keycloakTargetSchema.safeParse(t);
  if (!parsed.success) throw refusal('KEYCLOAK_TARGET_INVALID', 'Save an HTTPS origin and a valid realm before applying Keycloak.');
  return keycloakReview(parsed.data);
}
// Single transaction binds revision, stable resource identity and job submission.
export function applyKeycloak(db, input, by, available) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const review = reviewedKeycloak(db, input.expectedRevision);
    const t = review.target;
    let row = db.prepare('SELECT * FROM setup_keycloak WHERE origin = ? AND realm = ?').get(t.url, t.realm);
    if (row && row.ownership !== review.ownership) throw refusal('OWNERSHIP_CONFLICT', 'This connection has different ownership; G2 never adopts or replaces a recorded installation.');
    const managed = db.prepare("SELECT * FROM setup_keycloak WHERE ownership = 'managed'").get();
    if (t.mode === 'install' && managed && managed.id !== row?.id) throw refusal('MANAGED_TARGET_CONFLICT', 'A managed installation is already recorded. Restore its original origin and realm to retry it.');
    if (row?.last_job_id) {
      const last = getJob(db, row.last_job_id);
      if (last && (['queued', 'running', 'succeeded'].includes(last.status) || !input.retry)) { db.exec('COMMIT'); return { job: jobView(last), created: false, review, runnerAvailable: available }; }
    }
    if (!row) {
      const id = `kc-${randomBytes(6).toString('hex')}`;
      db.prepare('INSERT INTO setup_keycloak (id, ownership, origin, realm, created_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, review.ownership, t.url, t.realm, input.expectedRevision, new Date().toISOString());
      row = readKeycloak(db, id);
    }
    const job = createJob(db, { app: KEYCLOAK_APP, kind: 'keycloak_setup', plan: { params: { installationId: row.id, revision: input.expectedRevision } }, configRefs: { connection: row.id }, requestedBy: by, via: 'ui', retryOf: row.last_job_id,
      reason: available ? 'Reviewed Keycloak plan queued for the host runner.' : 'runner_unavailable: queued; start the existing setup runner to continue. No backend host fallback.' });
    db.prepare('UPDATE setup_keycloak SET last_job_id = ?, route_job_id = NULL WHERE id = ?').run(job.id, row.id);
    appendEvent(db, { jobId: job.id, kind: 'reviewed_plan', message: `Approved revision ${input.expectedRevision}; ${review.ownership} ${review.issuer}. ProxyPilot SSO not activated.`, data: { revision: input.expectedRevision, connection: row.id, runnerAvailable: available } });
    db.exec('COMMIT');
    return { job: jobView(job), created: true, review, runnerAvailable: available };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
