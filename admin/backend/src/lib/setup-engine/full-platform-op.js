import { runLifecycle } from './full-platform-lifecycle.js';
import { runReset } from './full-platform-reset.js';
import { prepareServiceConnections, serviceReaders, applyService } from './full-platform-services.js';
import { runAdministrator, withKeycloakLease } from './full-platform-admin.js';
import { networkInterfaces } from 'node:os';
import { readFullPlatform, fail, jobSchema, platformStages, STAGES } from './full-platform-store.js';
import { effectiveFor } from './platform-networks.js';
import { connectManagedKeycloak, protectedValue } from './full-platform-keycloak.js';
import { readPlatformPlan, savePlatformPlan, emptyChoices } from './platform-plan.js';
import { applyKeycloak, readKeycloak } from './keycloak-store.js';
import { readConfig, saveConfig, queueSsoJob } from '../sso/store.js';
import { readPomerium, savePomerium, applyPomerium } from './pomerium-store.js';
import { getJob } from './store.js';
import { dnsRefusal } from './platform-dns.js';
import { runKeycloakRecovery } from './full-platform-kc-recovery.js';

const privateIp = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
export async function runFullPlatformOperation({ db, params, exec, job, identity = connectManagedKeycloak, interfaces = networkInterfaces(), administratorDeps = {}, lifecycleDeps = {}, resetDeps = {}, dnsCheck = dnsRefusal, recoveryDeps = {} }) {
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
  if (params.operation === 'keycloak_recovery') {
    // 3h: recover the bootstrap administrator, then resume the coordinator
    // from connect_managed_identity in this same job.
    if (full.state?.keycloakRecovery) await runKeycloakRecovery(db, full, job, exec, recoveryDeps);
    full = readFullPlatform(db);
  } else if (params.operation) return runAdministrator(db, full, params.operation, job, administratorDeps);
  const state = { ...full.state, actions: { ...full.state.actions }, dispatched: { ...full.state.dispatched } };
  const remember = () => { job.fence(); db.prepare('UPDATE setup_full_platform SET state_json=? WHERE id=1 AND revision=? AND last_job_id=?').run(JSON.stringify(state), params.revision, job.id); };
  const wait = reason => { remember(); return { waiting: true, reason }; };
  const handoff = (service, reason) => { state.actions[service] = reason; remember(); return { verification: { state: 'awaiting_user_action', label: reason, complete: false } }; };
  // One stage per coordinator job (apply / continue). The stage is fixed when
  // the job first runs and kept across its requeues; a later stage is never
  // started early, and finishing this stage ends the job with "continue".
  const stageName = id => STAGES.find(st => st.id === id)?.name || id;
  const stage = state.jobStage?.job === job.id ? state.jobStage.stage : platformStages(db).current;
  state.jobStage = { job: job.id, stage }; state.stage = stage;
  if (stage === 'E' || stage === 'complete') return handoff('sso', stage === 'E' ? 'Every service is verified. Activate SSO in Platform Setup → E; that is a human, step-up-gated action.' : 'Full Platform setup is complete.');
  const finished = () => {
    const now = platformStages(db);
    if (now.current === stage) return null;
    delete state.actions.stage;
    return handoff('stage', `Stage ${stage} (${stageName(stage)}) is verified. Continue the saved setup to start stage ${now.current} (${stageName(now.current)}).`);
  };
  remember();
  if (!full.plan_revision || full.state.planForRevision !== full.revision) {
    const choices = emptyChoices();
    for (const [id, s] of Object.entries(full.config.services)) choices[id] = { mode: 'install', url: s.url };
    choices.keycloak.realm = full.config.realm;
    const existingPlan = readPlatformPlan(db);
    const prior = existingPlan.choices.infisical;
    const host = Object.values(interfaces).flat().find(i => !i.internal && privateIp(i.address))?.address;
    if (!prior.agentProxyUrl && !host) return handoff('infisical', 'No private runner address was discovered for Agent Proxy. Configure a private host address before continuing.');
    choices.infisical.agentProxyMode = 'install';
    choices.infisical.agentProxyUrl = prior.agentProxyUrl || `http://${host}:17322`;
    job.fence();
    const saved = savePlatformPlan(db, { schemaVersion: 1, expectedRevision: existingPlan.revision, choices }, { checks: [], source: 'full_platform_review', checkedAt: new Date().toISOString() }, full.created_by);
    if (!saved) throw fail('The shared platform plan changed. Reopen and retry.');
    state.planForRevision = full.revision;
    db.prepare('UPDATE setup_full_platform SET plan_revision=? WHERE id=1 AND revision=?').run(saved.revision, full.revision);
    remember(); full = readFullPlatform(db);
  }
  const plan = readPlatformPlan(db);
  if (plan.revision !== full.plan_revision) throw fail('The shared service plan changed after this Full Platform revision recorded it. Resync the shared plan (Platform overview → Resync shared plan, or resync_platform_plan), then continue.');
  if (Object.keys(state.removed || {}).length) return handoff('runtime', 'One or more service runtimes were explicitly removed. Use their reviewed Reinstall action; ordinary continue will not undo removal.');

  /* ---- Stage B: Keycloak (re-verified on every continue: later stages depend on it) ---- */
  job.checkpoint('keycloak_install_or_reuse', { resumable: true });
  const result = applyKeycloak(db, { expectedRevision: plan.revision, reviewed: true, retry: state.dispatched.keycloak?.coordinator !== job.id }, full.created_by, true);
  state.dispatched.keycloak = { coordinator: job.id, jobId: result.job.id }; remember();
  let child = getJob(db, result.job.id);
  if (['queued', 'running'].includes(child.status)) return wait('Keycloak installation/verification is running in its existing job.');
  if (child.status !== 'succeeded') return handoff('keycloak', `Stage B failed at Keycloak: ${child.reason || child.status}. Review its recorded operation before retrying.`);
  const k = db.prepare('SELECT * FROM setup_keycloak WHERE last_job_id=?').get(child.id);
  if (!k?.verified_at) throw fail('Keycloak has no verified connection for this installation.');
  if (k.ownership !== 'managed') return handoff('keycloak', 'This Keycloak is an external connection; Full Platform installs and manages its own. Remove the external connection first.');
  // Inert service records (no job, no container): the identity step creates
  // each service's Keycloak client from them, and retiring the bootstrap in B
  // requires every client. Installing those services waits for C and D.
  prepareServiceConnections(db, full, plan, k);
  job.checkpoint('connect_managed_identity', { resumable: true });
  const connected = full.state.administratorVerified ? full.state.identity : await withKeycloakLease(db, job, guarded => identity(db, readKeycloak(db, k.id), full, { job: guarded }));
  job.fence(); state.identity = connected; delete state.actions.keycloak; remember();
  let sso = readConfig(db);
  if (!sso) {
    sso = saveConfig(db, { expectedRevision: 0, connectionId: k.id, publicOrigin: full.config.publicOrigin, recoveryOrigin: full.config.recoveryOrigin,
      clientId: connected.clients.proxypilot.id, readerClientId: connected.clients.observer.id,
      clientSecret: protectedValue(db, connected.clients.proxypilot.ref).secret, readerSecret: protectedValue(db, connected.clients.observer.ref).secret,
      keycloakVersion: '26.7.4', requiredAcr: '1', recoveryNetworks: effectiveFor(db, full.config), roleMapping: 'local-only', reviewed: true }, full.created_by);
  } else if (sso.config.connectionId !== k.id || sso.config.publicOrigin !== full.config.publicOrigin || sso.config.recoveryOrigin !== full.config.recoveryOrigin) throw fail('Existing SSO uses a different identity or recovery target. Its working access was retained; review a bounded replacement.');
  for (const [kind, field] of [['configure_recovery_route', 'route_job_id'], ['verify_sso', 'job_id']]) {
    sso = readConfig(db);
    const previous = sso[field] && getJob(db, sso[field]);
    if (!previous || previous.status !== 'succeeded' && !['queued','running'].includes(previous.status) && state.dispatched[kind]?.coordinator !== job.id) { queueSsoJob(db, sso, kind, full.created_by); state.dispatched[kind] = { coordinator: job.id }; return wait('Verifying the managed ProxyPilot client and independent recovery route.'); }
    if (['queued', 'running'].includes(previous.status)) return wait('Verifying the managed ProxyPilot client and independent recovery route.');
    if (previous.status !== 'succeeded') return handoff('keycloak', `Stage B failed at ${kind === 'verify_sso' ? 'SSO verification' : 'the recovery route'}: ${previous.reason || previous.status}`);
  }
  if (!full.state.administratorVerified) {
    // B's automatic part is done. What remains is the person's: nothing
    // else is installed until they finish it and retire the bootstrap.
    state.actions.administrator = 'Stage B: reveal the initial Keycloak password, create the permanent administrator and enroll a passkey, link your ProxyPilot account, test SSO login, step-up and recovery from a separate browser, then retire the bootstrap account. Pomerium, Infisical, OpenBao and Vaultwarden are installed only after that.';
    remember();
    return { verification: { state: 'awaiting_user_action', label: state.actions.administrator, complete: false } };
  }
  delete state.actions.administrator;
  if (stage === 'B') return finished() || handoff('stage', 'Stage B is not verified yet. Review the Keycloak and administrator checks.');

  /* ---- Stage C: Pomerium; Stage D: Infisical, OpenBao, Vaultwarden ---- */
  const ids = STAGES.find(st => st.id === stage).services;
  if (stage === 'C' && !readPomerium(db)) {
    job.checkpoint('pomerium_connection', { resumable: true });
    savePomerium(db, { expectedPlanRevision: plan.revision, expectedRevision: 0, connectionId: k.id, clientId: connected.clients.pomerium.id, clientSecret: protectedValue(db, connected.clients.pomerium.ref).secret, reviewed: true });
  }
  let pending = false;
  for (const id of ids) {
    const row = serviceReaders[id](db);
    const previous = row?.last_job_id && getJob(db, row.last_job_id);
    if (row?.verified_json && previous?.status === 'succeeded') { delete state.actions[id]; continue; }
    if (previous && ['queued','running'].includes(previous.status)) { pending = true; state.actions[id] = 'The recorded service operation is running.'; continue; }
    if (state.dispatched[id]?.coordinator !== job.id) {
      // 3e: a service whose hostname does not resolve to the Caddy host (from
      // this host AND from a public resolver) is not queued; the reason names
      // both answers, the expected address and where the record is changed.
      const refusal = await dnsCheck(db, [new URL(full.config.services[id].url).hostname]);
      job.fence();
      if (refusal) { state.actions[id] = refusal.error; state.dnsBlocked = { ...(state.dnsBlocked || {}), [id]: refusal.error }; continue; }
      if (state.dnsBlocked?.[id]) { const { [id]: _cleared, ...rest } = state.dnsBlocked; state.dnsBlocked = rest; }
      const queued = applyService(db, id, full.created_by);
      state.dispatched[id] = { coordinator: job.id, jobId: queued.job.id }; pending = true;
      state.actions[id] = 'Installing and connecting through the existing service adapter.';
    } else {
      state.actions[id] = previous?.verification?.label || previous?.reason || 'Complete the recorded service handoff, then continue saved setup.';
    }
  }
  if (pending) return wait(`Stage ${stage} (${stageName(stage)}) service jobs are running; completed connections and pending handoffs are retained.`);
  const done = finished();
  if (done) return done;
  const failing = ids.filter(id => { const row = serviceReaders[id](db), last = row?.last_job_id && getJob(db, row.last_job_id); return last && ['failed', 'refused', 'recovery_required'].includes(last.status) || state.dnsBlocked?.[id]; });
  const label = failing.length
    ? `Stage ${stage} (${stageName(stage)}) failed: ${failing.map(id => `${id} — ${state.actions[id]}`).join('; ')}`
    : `Stage ${stage} (${stageName(stage)}) is waiting on its human steps: ${ids.filter(id => state.actions[id]).map(id => `${id} — ${state.actions[id]}`).join('; ') || 'complete them, then continue'}.`;
  remember();
  return { verification: { state: 'awaiting_user_action', label, complete: false } };
}
