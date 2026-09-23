import { localEdge } from './local-edge.js';
import { assertUpstreamListening } from './owned-runtime.js';
import { readVaultwarden, secrets, currentPlan } from './vaultwarden-store.js';
import { VAULTWARDEN_ROOT, VAULTWARDEN_PORT, VAULTWARDEN_APP, jobSchema, digest, fail } from './vaultwarden-logic.js';
import { ensureRuntime, keyEvidence } from './vaultwarden-runtime.js';
import { createClient, health, verifyEffective } from './vaultwarden-api.js';
import { verifyClient } from './vaultwarden-identity.js';
import { verifyKeycloak } from './keycloak-discovery.js';
import { verifiedProvider } from './pomerium-store.js';
import { assertVaultwardenRouteAvailable } from './vaultwarden-routes.js';
import { createJob, getJob } from './store.js';
export async function runVaultwardenOperation({ db, params, exec, job, root = VAULTWARDEN_ROOT, send, runtime = ensureRuntime,
  clientProbe = verifyClient, providerProbe = verifyKeycloak, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 30 }) {
  jobSchema.parse(params); const original = job;
  job = { ...original, fence() { original.fence(); const r = readVaultwarden(db);
    if (!r || r.revision !== params.revision || r.last_job_id !== job.id) throw fail('Vaultwarden operation was superseded.'); currentPlan(db, r); } };
  job.fence(); let r = readVaultwarden(db); const credentials = secrets(db, r), phase = name => job.checkpoint(name, { resumable: true, vaultwarden: true });
  // Existing services are observed before any identity checks. This adapter never
  // writes their configuration, accounts, database or keys.
  if (r.config.mode === 'connect') { phase('existing_read_only_checks'); const h = await health(createClient(r.config.origin, { send, job })); if (h.state !== 'healthy') throw fail(`Existing Vaultwarden is ${h.state}. No external changes were made.`); }
  phase('dedicated_keycloak_handoff');
  try { const provider = verifiedProvider(db, r.config.connectionId); await providerProbe({ mode: 'connect', url: provider.origin, realm: provider.realm }); }
  catch { throw fail('The saved Keycloak provider is unavailable or unverified.'); }
  job.fence(); const client = await clientProbe(db, r); job.fence();
  if (r.config.mode === 'install') {
    phase('owned_private_runtime'); assertVaultwardenRouteAvailable(db, r);
    const resources = await runtime(r, credentials, { exec, job, root }); job.fence();
    db.prepare('UPDATE setup_vaultwarden SET resources_json=? WHERE id=1').run(JSON.stringify({ ...r.resources, ...resources })); r = readVaultwarden(db);
    const local = createClient(`http://127.0.0.1:${VAULTWARDEN_PORT}`, { send, job, local: true });
    let h; for (let i = 0; i < attempts; i++) { h = await health(local); if (h.state === 'healthy') break; await sleep(1000); }
    if (h?.state !== 'healthy') throw fail('Managed Vaultwarden is unavailable or unhealthy after start. Its data and keys are preserved.');
    await verifyEffective(local, r, credentials);
    const serverKeys = keyEvidence(r.resources.data, r.resources.serverKeys); job.fence();
    db.prepare('UPDATE setup_vaultwarden SET resources_json=? WHERE id=1').run(JSON.stringify({ ...r.resources, serverKeys })); r = readVaultwarden(db);
    let child = r.edge_job_id ? getJob(db, r.edge_job_id) : null;
    if (!child) { job.fence(); db.exec('BEGIN IMMEDIATE'); try { child = createJob(db, { app: VAULTWARDEN_APP, kind: 'configure_vaultwarden_route', plan: { params }, requestedBy: 'vaultwarden_apply', via: 'system' });
      db.prepare('UPDATE setup_vaultwarden SET edge_job_id=? WHERE id=1').run(child.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
    phase('caddy_route'); if (['queued', 'running'].includes(child.status)) return { waiting: true, reason: 'Waiting for the recorded Vaultwarden Caddy route step.' };
    if (child.status !== 'succeeded') throw fail('Vaultwarden Caddy configuration failed. Resolve its conflict and explicitly retry.');
    await assertUpstreamListening({ run: argv => exec.host(argv, { timeoutMs: 15000 }), port: VAULTWARDEN_PORT, fail, label: 'Vaultwarden' }); job.fence();
  }
  phase('effective_configuration');
  const effective = await verifyEffective(createClient(r.config.origin, { send, job, edge: r.config.mode === 'install' ? localEdge(db) : null }), r, credentials); job.fence();
  const verification = { state: 'configuration_verified', label: 'Vaultwarden configuration verified. Sign in to Vaultwarden with your own account, unlock the vault and record the browser checks. Users without the access role are refused by the verified Keycloak rule.',
    ...effective, configurationFingerprint: digest([effective.configurationFingerprint, client.fingerprint]), revision: r.revision, fingerprint: digest(r.config), client, verifiedAt: new Date().toISOString() };
  db.prepare('UPDATE setup_vaultwarden SET verified_json=? WHERE id=1').run(JSON.stringify(verification)); return { verification };
}
