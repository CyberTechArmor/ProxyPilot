import { runLifecycle } from './full-platform-lifecycle.js';
import { runReset } from './full-platform-reset.js';
import { prepareServiceConnections, serviceReaders, applyService } from './full-platform-services.js';
import { runAdministrator, withKeycloakLease } from './full-platform-admin.js';
import { networkInterfaces } from 'node:os';
import { readFullPlatform, fail, jobSchema } from './full-platform-store.js';
import { connectManagedKeycloak, protectedValue } from './full-platform-keycloak.js';
import { readPlatformPlan, savePlatformPlan, emptyChoices } from './platform-plan.js';
import { applyKeycloak, readKeycloak } from './keycloak-store.js';
import { readConfig, saveConfig, queueSsoJob } from '../sso/store.js';
import { readPomerium, savePomerium, applyPomerium } from './pomerium-store.js';
import { getJob } from './store.js';

const privateIp = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
export async function runFullPlatformOperation({ db, params, exec, job, identity = connectManagedKeycloak, interfaces = networkInterfaces(), administratorDeps = {}, lifecycleDeps = {}, resetDeps = {} }) {
  jobSchema.parse(params);
  let full = readFullPlatform(db);
  // A reset may discard a saved-but-never-applied plan, so it is bound to the
  // saved revision and its own queued review, not to approved_revision.
  if (params.operation === 'reset') {
    if (!full || full.revision !== params.revision || full.last_job_id !== job.id || !full.state?.reset) throw fail('The reviewed Full Platform reset was superseded.');
    return runReset(db, full, job, exec, resetDeps);
  }
  if (!full || full.revision !== params.revision || full.approved_revision !== params.revision || full.last_job_id !== job.id) throw fail('The reviewed Full Platform operation was superseded.');
  if (params.operation === 'lifecycle') return runLifecycle(db, full, job, exec, lifecycleDeps);
  if (params.operation) return runAdministrator(db, full, params.operation, job, administratorDeps);
  const state = { ...full.state, actions: { ...full.state.actions }, dispatched: { ...full.state.dispatched } };
  const remember = () => { job.fence(); db.prepare('UPDATE setup_full_platform SET state_json=? WHERE id=1 AND revision=? AND last_job_id=?').run(JSON.stringify(state), params.revision, job.id); };
  const wait = reason => { remember(); return { waiting: true, reason }; };
  const handoff = (service, reason) => { state.stage = 'administrator'; state.actions[service] = reason; remember(); return { verification: { state: 'awaiting_user_action', label: reason, complete: false } }; };
  state.stage = 'install'; remember();
  if (!full.plan_revision || full.state.planForRevision !== full.revision) {
    const choices = emptyChoices();
    for (const [id, s] of Object.entries(full.config.services)) choices[id] = { ...s };
    choices.keycloak.realm = full.config.realm;
    const existingPlan = readPlatformPlan(db);
    if (choices.infisical.mode !== 'skip') {
      const prior = existingPlan.choices.infisical;
      const host = Object.values(interfaces).flat().find(i => !i.internal && privateIp(i.address))?.address;
      if (!prior.agentProxyUrl && !host) return handoff('infisical', 'No private runner address was discovered for Agent Proxy. Configure a private host address before continuing.');
      choices.infisical.agentProxyMode = prior.agentProxyMode || choices.infisical.mode;
      choices.infisical.agentProxyUrl = prior.agentProxyUrl || `http://${host}:17322`;
    } else choices.infisical.agentProxyUrl = '';
    job.fence();
    const saved = savePlatformPlan(db, { schemaVersion: 1, expectedRevision: existingPlan.revision, choices }, { checks: [], source: 'full_platform_review', checkedAt: new Date().toISOString() }, full.created_by);
    if (!saved) throw fail('The shared platform plan changed. Reopen and retry.');
    state.planForRevision = full.revision;
    db.prepare('UPDATE setup_full_platform SET plan_revision=? WHERE id=1 AND revision=?').run(saved.revision, full.revision);
    remember(); full = readFullPlatform(db);
  }
  const plan = readPlatformPlan(db);
  if (plan.revision !== full.plan_revision) throw fail('Custom setup changed the shared service plan. Review the Full Platform plan again before continuing.');
  if (Object.keys(state.removed || {}).length) return handoff('runtime', 'One or more service runtimes were explicitly removed. Use their reviewed Reinstall action; ordinary continue will not undo removal.');
  if (full.config.services.keycloak.mode === 'skip') return handoff('keycloak', 'Connect a verified identity provider through Custom setup before connecting the selected services.');
  job.checkpoint('keycloak_install_or_reuse', { resumable: true });
  const result = applyKeycloak(db, { expectedRevision: plan.revision, reviewed: true, retry: state.dispatched.keycloak?.coordinator !== job.id }, full.created_by, true);
  state.dispatched.keycloak = { coordinator: job.id, jobId: result.job.id }; remember();
  let child = getJob(db, result.job.id);
  if (['queued', 'running'].includes(child.status)) return wait('Keycloak installation/verification is running in its existing job.');
  if (child.status !== 'succeeded') return handoff('keycloak', `Keycloak needs attention: ${child.reason || child.status}. Review its recorded operation before retrying.`);
  const k = db.prepare('SELECT * FROM setup_keycloak WHERE last_job_id=?').get(child.id);
  if (!k?.verified_at) throw fail('Keycloak has no verified connection for this installation.');
  if (k.ownership !== 'managed') return handoff('keycloak', 'External Keycloak was checked read-only. Its owner must authorize the dedicated client connection through Custom setup.');
  prepareServiceConnections(db, full, plan, k);
  job.checkpoint('connect_managed_identity', { resumable: true });
  const connected = full.state.administratorVerified ? full.state.identity : await withKeycloakLease(db, job, guarded => identity(db, readKeycloak(db, k.id), full, { job: guarded }));
  job.fence(); state.identity = connected; delete state.actions.keycloak; remember();
  let sso = readConfig(db);
  if (!sso) {
    sso = saveConfig(db, { expectedRevision: 0, connectionId: k.id, publicOrigin: full.config.publicOrigin, recoveryOrigin: full.config.recoveryOrigin,
      clientId: connected.clients.proxypilot.id, readerClientId: connected.clients.observer.id,
      clientSecret: protectedValue(db, connected.clients.proxypilot.ref).secret, readerSecret: protectedValue(db, connected.clients.observer.ref).secret,
      keycloakVersion: '26.7.4', requiredAcr: '1', recoveryNetworks: full.config.recoveryNetworks, roleMapping: 'local-only', reviewed: true }, full.created_by);
  } else if (sso.config.connectionId !== k.id || sso.config.publicOrigin !== full.config.publicOrigin || sso.config.recoveryOrigin !== full.config.recoveryOrigin) throw fail('Existing SSO uses a different identity or recovery target. Its working access was retained; review a bounded replacement.');
  for (const [kind, field] of [['configure_recovery_route', 'route_job_id'], ['verify_sso', 'job_id']]) {
    sso = readConfig(db);
    const previous = sso[field] && getJob(db, sso[field]);
    if (!previous || previous.status !== 'succeeded' && !['queued','running'].includes(previous.status) && state.dispatched[kind]?.coordinator !== job.id) { const queued = queueSsoJob(db, sso, kind, full.created_by); state.dispatched[kind] = { coordinator: job.id }; return wait('Verifying the managed ProxyPilot client and independent recovery route.'); }
    if (['queued', 'running'].includes(previous.status)) return wait('Verifying the managed ProxyPilot client and independent recovery route.');
    if (previous.status !== 'succeeded') return handoff('keycloak', `${kind === 'verify_sso' ? 'SSO verification' : 'Recovery route'} needs attention. ${previous.reason || ''}`);
  }
  if (full.config.services.pomerium.mode !== 'skip') {
    job.checkpoint('pomerium_connection', { resumable: true });
    let p = readPomerium(db);
    if (!p) {
      if (full.config.services.pomerium.mode === 'connect') return handoff('pomerium', 'Use Custom setup to confirm the existing Pomerium container and its ownership before connecting.');
      savePomerium(db, { expectedPlanRevision: plan.revision, expectedRevision: 0, connectionId: k.id, clientId: connected.clients.pomerium.id, clientSecret: protectedValue(db, connected.clients.pomerium.ref).secret, reviewed: true }); p = readPomerium(db);
    }
  }
  state.stage = 'administrator';
  if (!full.state.administratorVerified) state.actions.administrator = 'Enroll a passkey, link and prove the permanent administrator, and verify independent recovery before activating SSO.';
  let pending = false;
  for (const id of ['pomerium', 'infisical', 'openbao', 'vaultwarden']) {
    if (full.config.services[id].mode === 'skip') continue;
    const row = serviceReaders[id](db);
    const previous = row?.last_job_id && getJob(db, row.last_job_id);
    if (row?.verified_json && previous?.status === 'succeeded') { delete state.actions[id]; continue; }
    if (previous && ['queued','running'].includes(previous.status)) { pending = true; state.actions[id] = 'The recorded service operation is running.'; continue; }
    if (state.dispatched[id]?.coordinator !== job.id) {
      const queued = applyService(db, id, full.created_by);
      state.dispatched[id] = { coordinator: job.id, jobId: queued.job.id }; pending = true;
      state.actions[id] = 'Installing and connecting through the existing service adapter.';
    } else {
      state.actions[id] = previous?.verification?.label || previous?.reason || 'Complete the recorded service handoff, then continue saved setup.';
    }
  }
  if (pending) { state.stage = 'install'; return wait('Selected service jobs are running; completed connections and pending handoffs are retained.'); }
  state.stage = full.state.administratorVerified ? 'verify' : 'administrator';
  remember();
  return { verification: { state: 'awaiting_user_action', label: 'Managed connections prepared. Complete the administrator, recovery and selected-service access checks.', complete: false } };
}
