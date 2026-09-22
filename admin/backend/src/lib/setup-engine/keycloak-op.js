import { assertKeycloakRouteAvailable } from './keycloak-routes.js';
import { keycloakTargetSchema, keycloakJobSchema, KEYCLOAK_APP } from './keycloak-logic.js';
import { readKeycloak } from './keycloak-store.js';
import { ensureKeycloakRuntime } from './keycloak-runtime.js';
import { verifyKeycloak } from './keycloak-discovery.js';
import { createJob, getJob } from './store.js';
export async function runKeycloakOperation({ db, params, exec, job, runtime = ensureKeycloakRuntime, verify = verifyKeycloak }) {
  keycloakJobSchema.parse(params);
  let row = readKeycloak(db, params.installationId);
  if (!row || row.last_job_id !== job.id) throw new Error('Keycloak installation is missing or this operation was superseded.');
  const target = keycloakTargetSchema.parse({ mode: row.ownership === 'managed' ? 'install' : 'connect', url: row.origin, realm: row.realm });
  let resources = row.resources_json ? JSON.parse(row.resources_json) : null;
  if (row.ownership === 'managed') {
    assertKeycloakRouteAvailable(db, row);
    resources = await runtime(row, { exec, job });
    job.fence();
    db.prepare('UPDATE setup_keycloak SET resources_json = ? WHERE id = ?').run(JSON.stringify(resources), row.id);
    row = readKeycloak(db, row.id);
    let route = row.route_job_id ? getJob(db, row.route_job_id) : null;
    if (!route) {
      job.fence();
      db.exec('BEGIN IMMEDIATE');
      try {
        route = createJob(db, { app: KEYCLOAK_APP, kind: 'configure_keycloak_route', plan: { params }, requestedBy: 'keycloak_setup', via: 'system' });
        db.prepare('UPDATE setup_keycloak SET route_job_id = ? WHERE id = ?').run(route.id, row.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    job.checkpoint('public_route', { resumable: true, keycloak: true });
    job.progress({ route_job_id: route.id });
    if (['queued', 'running'].includes(route.status)) return { waiting: true, reason: 'Waiting for the existing backend Caddy route step. Closing the browser is safe.' };
    if (route.status !== 'succeeded') throw new Error('Managed Caddy route was not applied. Inspect its job, correct the conflict or render failure, then retry the reviewed Keycloak plan.');
  }
  job.checkpoint('public_issuer_verification', { resumable: true, keycloak: true });
  job.onStep('public_issuer_verification', 'Verify public HTTPS discovery, exact issuer and signing keys');
  const verification = { ...(await verify(target)), ownership: row.ownership,
    databaseReady: row.ownership === 'managed' ? resources.databaseReady : 'not_checked',
    serviceReady: row.ownership === 'managed' ? resources.serviceReady : 'not_checked',
    state: row.ownership === 'managed' ? 'keycloak_ready' : 'keycloak_connected',
    label: 'Keycloak ready/connected; ProxyPilot SSO not activated.' };
  job.fence();
  db.prepare('UPDATE setup_keycloak SET verified_json = ?, verified_at = ? WHERE id = ? AND last_job_id = ?').run(JSON.stringify(verification), verification.verifiedAt, row.id, job.id);
  return { verification };
}
