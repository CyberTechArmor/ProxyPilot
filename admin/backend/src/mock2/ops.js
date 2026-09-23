// The platform operations that moved into runner jobs — the two restores and
// the retry mint (A-13, A-14, A-15), then the Incus lifecycle and snapshot
// verbs (A-17.2 … A-17.5) — as the calls their surfaces make: each resolves REFERENCES on the
// server (the project, its guard, the recovery set's origin job, the prior
// attempt for a retry), records the job through the orchestrator and
// observes it to its outcome. The MCP tools, the dashboard route and the
// retry-deploy path call these; none of them runs a guest or host command
// itself any more.

import { containerLockStore } from './container-lock.js';
import { inProcessExecutorDeps, resolveDeployParams } from './deploy.js';
import { submitRunnerJob, resolveRetryOf, runSubmittedJob } from '../lib/setup-engine/orchestrator.js';
import { DUMP_NAME_RE, ENV_COPY_NAME_RE, recoverySetOf, bindRecoverySet } from '../lib/setup-engine/restore-logic.js';
import { getJob } from '../lib/setup-engine/store.js';
import { LIFECYCLE_JOB_KINDS, LIFECYCLE_PROFILE, validateLifecycleParams } from '../lib/setup-engine/lifecycle-logic.js';
import { SETUP_PHASES, validateSetupParams, createStatusView, normalizeServices, BACKEND_STEP_KINDS } from '../lib/setup-engine/setup-logic.js';
import { CONFIG_JOB_KINDS, SNAPSHOT_KINDS, validateConfigParams } from '../lib/setup-engine/config-logic.js';
import { drainBackendSteps, waitForJob } from '../lib/setup-engine/backend.js';
import { listJobs, jobView } from '../lib/setup-engine/store.js';
import { createHash } from 'node:crypto';

const noStore = () => ({ ok: false, step: 'submit', error: 'the setup engine store is not configured; the operation cannot be recorded, so it is not run' });

// planDigest(plan) → the short digest a confirmation token is bound to, so
// the token confirms THIS plan (dump, environment copy, snapshot, accept
// flags, retry origin) and nothing else.
export function planDigest(plan) {
  const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => { if (v[k] !== undefined) o[k] = canon(v[k]); return o; }, {}) : Array.isArray(v) ? v.map(canon) : v);
  return createHash('sha256').update(JSON.stringify(canon(plan))).digest('hex').slice(0, 16);
}

// resolveRestoreDbPlan({ containerName, projectId, file, environmentCopy, retryOf })
// → { ok, plan, params, retryJob } | { ok: false, error }. Pure resolution:
// names validated, the recovery set bound to a job record of THIS app.
export function resolveRestoreDbPlan(db, { containerName, file, environmentCopy = null, retryOf = null, guard = null, guardKey = null, webPort = 3000, dumpsDir = undefined }) {
  const dumpName = String(file || '').split('/').pop();
  if (!DUMP_NAME_RE.test(dumpName)) return { ok: false, error: `file must be a dump name inside the project's dump directory (from dump_project_db, a deploy's pre-deploy copy or a restore's pre-restore copy)` };
  const envCopyName = environmentCopy ? String(environmentCopy).split('/').pop() : null;
  if (envCopyName && !ENV_COPY_NAME_RE.test(envCopyName)) return { ok: false, error: 'environment_copy must be an environment copy name (environment.pre-<job>), no path' };
  let originJob = null;
  if (envCopyName) {
    // The recovery set's job: the one the dump's name says, verified by
    // what that job recorded for THIS app (bindRecoverySet).
    const hint = recoverySetOf(dumpName);
    originJob = hint.jobId ? getJob(db, hint.jobId) : null;
    const bind = bindRecoverySet({ app: containerName, dumpName, envCopyName, originJob });
    if (!bind.ok) return { ok: false, error: bind.reason };
  }
  const r = resolveRetryOf(db, { jobId: retryOf, app: containerName, kind: 'restore_db' });
  if (r.error) return { ok: false, error: r.error };
  const params = {
    container: containerName, webPort, unit: 'mock2-dev.service', environmentFile: '/etc/environment', appDir: '/srv/app',
    ...(dumpsDir ? { dumpsDir } : {}),
    dump: { name: dumpName },
    envCopy: envCopyName ? { name: envCopyName, originJobId: originJob.id } : null,
    guard: guard || null, guardKey: guardKey || null,
    ...(r.job ? { retryOf: r.job.id } : {}),
  };
  const plan = { container: containerName, dump: dumpName, environment_copy: envCopyName, mode: envCopyName ? 'recovery_set' : 'current_configuration', recovery_set_job: originJob?.id || null, retry_of: r.job?.id || null };
  return { ok: true, plan, params, retryJob: r.job, digest: planDigest(plan) };
}

export async function restoreProjectDb({ containerName, file, environmentCopy = null, retryOf = null, requestedBy = null, via = 'system', onEvent = null, detach = false }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  const refs = await resolveDeployParams({ containerName });
  const res = resolveRestoreDbPlan(db, { containerName, file, environmentCopy, retryOf, guard: refs.guard, guardKey: refs.guardKey || null, webPort: refs.webPort });
  if (!res.ok) return { ok: false, step: 'plan', error: res.error };
  const sub = submitRunnerJob(db, { kind: 'restore_db', app: containerName, params: res.params, configRefs: { dump: res.plan.dump, environmentCopy: res.plan.environment_copy, mode: res.plan.mode, guard: refs.guard || null, webPort: refs.webPort, unit: 'mock2-dev.service', environmentFile: '/etc/environment', appDir: '/srv/app' }, requestedBy, via, retryOf: res.retryJob?.id || null });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  return runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env, onEvent, detach });
}

export function resolveRestoreSnapshotPlan(db, { containerName, snapshot, acceptPartial = false, retryOf = null, managed = false, webPort = null, guard = null }) {
  const r = resolveRetryOf(db, { jobId: retryOf, app: containerName, kind: 'restore_snapshot' });
  if (r.error) return { ok: false, error: r.error };
  const params = { container: containerName, snapshot: String(snapshot), acceptPartial: acceptPartial === true, managed: managed === true, ...(managed ? { webPort: Number(webPort) || 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment', guard: guard || null } : {}), ...(r.job ? { retryOf: r.job.id } : {}) };
  const plan = { container: containerName, restore_to: String(snapshot), accept_partial: acceptPartial === true, retry_of: r.job?.id || null };
  return { ok: true, plan, params, retryJob: r.job, digest: planDigest(plan) };
}

export async function restoreSnapshot({ containerName, snapshot, acceptPartial = false, retryOf = null, requestedBy = null, via = 'system', onEvent = null, detach = false }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  // A guest the registry knows is a managed app: verified up the ladder
  // after the restore; any other guest is restored and reported as Incus
  // sees it.
  const refs = await resolveDeployParams({ containerName });
  const managed = refs.projectId != null;
  const res = resolveRestoreSnapshotPlan(db, { containerName, snapshot, acceptPartial, retryOf, managed, webPort: refs.webPort, guard: refs.guard });
  if (!res.ok) return { ok: false, step: 'plan', error: res.error };
  const sub = submitRunnerJob(db, { kind: 'restore_snapshot', app: containerName, params: res.params, configRefs: { snapshot: res.plan.restore_to, acceptPartial: res.plan.accept_partial, managed, ...(managed ? { guard: refs.guard || null, webPort: refs.webPort, unit: 'mock2-dev.service', environmentFile: '/etc/environment' } : {}) }, requestedBy, via, retryOf: res.retryJob?.id || null });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  return runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env, onEvent, detach });
}

// retryProjectSecrets({ containerName, retryOf }) → { ok, minted, deferred,
// required, reused, jobId } — the retry path's mint as a job. Refused (not
// queued) when nothing can execute it: the deploy that follows reports the
// same unavailability, and it mints on its own when it runs.
export async function retryProjectSecrets({ containerName, retryOf = null, requestedBy = null, via = 'system' }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  const refs = await resolveDeployParams({ containerName });
  const r = resolveRetryOf(db, { jobId: retryOf, app: containerName, kind: 'retry_secrets' });
  if (r.error) return { ok: false, step: 'plan', error: r.error };
  const params = { container: containerName, appDir: refs.appDir, environmentFile: refs.environmentFile, secrets: { configs: refs.secrets.configs }, guard: refs.guard || null, ...(r.job ? { retryOf: r.job.id } : {}) };
  const sub = submitRunnerJob(db, { kind: 'retry_secrets', app: containerName, params, configRefs: { environmentFile: refs.environmentFile, keys: refs.secrets.configs.map((c) => c.key) }, requestedBy, via, retryOf: r.job?.id || null });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  const out = await runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env });
  if (out.step === 'runner_unavailable') {
    // Not left in the queue: the deploy that follows carries the same mint.
    const { cancelQueuedJob } = await import('../lib/setup-engine/store.js');
    cancelQueuedJob(db, { id: out.jobId, outcome: 'runner_unavailable', reason: `${out.error}; the deploy that follows mints the same keys when it runs`, by: 'orchestrator' });
    return { ...out, refused: true, queued: false };
  }
  return out;
}

// ── the Incus lifecycle and snapshot verbs (A-17.2 … A-17.5) ──────────────
//
// One entry for the seven kinds. The caller names the kind, the guest and the
// few validated parameters (force, snapshot, note, the launch plan, the
// identity it confirmed); the job renders the fixed command. A start or a
// restart of a MANAGED application (a project guest) gets the verification
// ladder as a follow-up; any other guest is reported as Incus reads it.

export const LIFECYCLE_ACTIONS = Object.freeze({ start: 'instance_start', stop: 'instance_stop', restart: 'instance_restart', delete: 'instance_delete' });
export { LIFECYCLE_JOB_KINDS };

// resolveLifecyclePlan(db, { kind, containerName, … }) → { ok, plan, params,
// digest } | { ok: false, error }. Pure: the plan is what a confirmation
// token is bound to (kind, guest, snapshot, force, the confirmed identity,
// the launch parameters), and params is what the job carries.
export function resolveLifecyclePlan(db, { kind, containerName, force = false, snapshot = null, note = null, expect = null, managed = false, webPort = null, guard = null, image = null, profile = null, config = null, vm = false, network = null, rootSize = null, setup = null, fixup = false }) {
  if (!LIFECYCLE_JOB_KINDS.includes(kind)) return { ok: false, error: `unknown lifecycle operation '${kind}'` };
  const prof = LIFECYCLE_PROFILE[kind];
  const params = { container: String(containerName || '') };
  if (['instance_stop', 'instance_restart', 'instance_delete'].includes(kind) && force === true) params.force = true;
  if (prof.target === 'snapshot') params.snapshot = snapshot == null ? '' : String(snapshot);
  if (kind === 'snapshot_create' && note != null && String(note).trim() !== '') params.note = String(note);
  if (expect && (expect.uuid != null || expect.created_at != null)) params.expect = { ...(expect.uuid != null ? { uuid: String(expect.uuid) } : {}), ...(expect.created_at != null ? { created_at: String(expect.created_at) } : {}) };
  if (kind === 'instance_create') {
    params.image = image == null ? '' : String(image);
    if (profile) params.profile = String(profile);
    if (config && typeof config === 'object') params.config = Object.fromEntries(Object.entries(config).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    if (vm === true) params.vm = true;
    if (network) params.network = String(network);
    if (rootSize) params.rootSize = String(rootSize);
    // The post-launch setup (A-17.7) the executor queues as a follow-up of
    // the launch, bound to the guest it reads back: phases in their fixed
    // order, the script by reference, the services validated here.
    if (setup && typeof setup === 'object') {
      const phases = [...SETUP_PHASES].filter((ph) => Array.isArray(setup.phases) && setup.phases.includes(ph));
      params.setup = { phases };
      if (setup.addressTimeoutMs != null) params.setup.addressTimeoutMs = Number(setup.addressTimeoutMs);
      if (setup.initTimeoutMs != null) params.setup.initTimeoutMs = Number(setup.initTimeoutMs);
      if (setup.resolvers) params.setup.resolvers = setup.resolvers;
      if (setup.initScript) params.setup.initScript = { ref: String(setup.initScript.ref), sha256: String(setup.initScript.sha256), bytes: Number(setup.initScript.bytes) };
      if (setup.services) { params.setup.services = setup.services; params.setup.serviceName = String(setup.serviceName || ''); }
    }
  }
  // The post-start fix-up (NAT + DNS) a start / restart asks for.
  if (fixup === true && (kind === 'instance_start' || kind === 'instance_restart')) params.fixup = true;
  if (managed === true && (kind === 'instance_start' || kind === 'instance_restart')) {
    params.managed = true; params.webPort = Number(webPort) || 3000; params.unit = 'mock2-dev.service'; params.environmentFile = '/etc/environment'; params.guard = guard || null;
  }
  const v = validateLifecycleParams(kind, params);
  if (!v.ok) return { ok: false, error: v.reason };
  const plan = { kind, container: params.container, ...(params.snapshot ? { snapshot: params.snapshot } : {}), force: params.force === true, expect: params.expect || null, ...(kind === 'instance_create' ? { image: params.image, profile: params.profile || 'default', config: params.config || {}, vm: params.vm === true, network: params.network || null, root_size: params.rootSize || null, setup: params.setup ? { phases: params.setup.phases, init_script: params.setup.initScript?.sha256 || null, services: (params.setup.services || []).map((s) => s.domain) } : null } : {}), ...(params.fixup ? { fixup: true } : {}) };
  return { ok: true, plan, params, digest: planDigest(plan) };
}

// runLifecycle({ kind, containerName, …, detach, onEvent }) → the outcome
// every caller reports: { ok, step, jobId, instanceState, verified, … } or
// { ok: false, step, error, code?, jobId? }. Refused (never queued) while the
// guest's lease is held or a mutating job is open, and when no executor is
// available. `managed` is resolved here from the project registry for a
// start / restart: a project guest gets the ladder as a follow-up.
export async function runLifecycle({ kind, containerName, force = false, snapshot = null, note = null, expect = null, image = null, profile = null, config = null, vm = false, network = null, rootSize = null, setup = null, fixup = false, requestedBy = null, via = 'system', onEvent = null, detach = false, awaitKick = false, waitMs = null }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  let managed = false; let webPort = null; let guard = null;
  if (kind === 'instance_start' || kind === 'instance_restart') {
    try { const refs = await resolveDeployParams({ containerName }); managed = refs.projectId != null; webPort = refs.webPort; guard = refs.guard || null; } catch { managed = false; }
  }
  const res = resolveLifecyclePlan(db, { kind, containerName, force, snapshot, note, expect, managed, webPort, guard, image, profile, config, vm, network, rootSize, setup, fixup });
  if (!res.ok) return { ok: false, step: 'plan', code: 'INVALID', error: res.error };
  const sub = submitRunnerJob(db, { kind, app: res.params.container, params: res.params, configRefs: { ...res.plan, kind: undefined, managed }, requestedBy, via });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  const out = await runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env, onEvent, detach, awaitKick, waitMs });
  if (out.setupJobId == null && out.jobId) { const row = getJob(db, out.jobId); const prog = row ? JSON.parse(row.progress_json || '{}') : {}; out.setupJobId = prog.setup_job_id || null; }
  return out;
}

// ── the post-launch / post-start guest setup (A-17.7) ─────────────────────
//
// Normally a FOLLOW-UP the executor queues from a create (the whole plan) or
// a start / restart (`fixup`), bound to the guest it read back. Submitted
// directly (an operator re-running the setup of a guest that is there), it
// is exclusive like a lifecycle verb: refused while the guest is busy or no
// executor is live, never queued behind.

export function resolveSetupPlan(db, { containerName, phases, expect = null, initScript = null, services = null, serviceName = null, addressTimeoutMs = null, initTimeoutMs = null, resolvers = null, retryOf = null }) {
  const r = resolveRetryOf(db, { jobId: retryOf, app: containerName, kind: 'guest_setup' });
  if (r.error) return { ok: false, error: r.error };
  const params = { container: String(containerName || ''), phases: [...SETUP_PHASES].filter((ph) => Array.isArray(phases) && phases.includes(ph)) };
  if (expect && (expect.uuid != null || expect.created_at != null)) params.expect = { ...(expect.uuid != null ? { uuid: String(expect.uuid) } : {}), ...(expect.created_at != null ? { created_at: String(expect.created_at) } : {}) };
  if (initScript) params.initScript = { ref: String(initScript.ref), sha256: String(initScript.sha256), bytes: Number(initScript.bytes) };
  if (services) { params.services = services; params.serviceName = String(serviceName || ''); }
  if (addressTimeoutMs != null) params.addressTimeoutMs = Number(addressTimeoutMs);
  if (initTimeoutMs != null) params.initTimeoutMs = Number(initTimeoutMs);
  if (resolvers) params.resolvers = resolvers;
  if (r.job) params.retryOf = r.job.id;
  const v = validateSetupParams(params);
  if (!v.ok) return { ok: false, error: v.reason };
  const plan = { kind: 'guest_setup', container: params.container, phases: params.phases, expect: params.expect || null, init_script: params.initScript?.sha256 || null, services: (params.services || []).map((s) => s.domain), retry_of: r.job?.id || null };
  return { ok: true, plan, params, retryJob: r.job, digest: planDigest(plan) };
}

export async function runGuestSetup({ containerName, phases, expect = null, initScript = null, services = null, serviceName = null, addressTimeoutMs = null, initTimeoutMs = null, resolvers = null, retryOf = null, requestedBy = null, via = 'system', onEvent = null, detach = false, awaitKick = false, waitMs = null }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  const res = resolveSetupPlan(db, { containerName, phases, expect, initScript, services, serviceName, addressTimeoutMs, initTimeoutMs, resolvers, retryOf });
  if (!res.ok) return { ok: false, step: 'plan', code: 'INVALID', error: res.error };
  const sub = submitRunnerJob(db, { kind: 'guest_setup', app: res.params.container, params: res.params, configRefs: { ...res.plan, kind: undefined }, requestedBy, via, retryOf: res.retryJob?.id || null });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  return runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env, onEvent, detach, awaitKick, waitMs });
}

// ── the guest configuration verbs (A-17.8) ────────────────────────────────
//
// One entry for the seven kinds: the caller names the kind, the guest, the
// identity it confirmed and the few validated parameters (allowlisted config
// keys and values, a device's properties, the address, the forward's ports,
// the egress service); the job renders every command, takes the pre-change
// snapshot the plan names before it changes anything, and reads the
// requested state back before it reports done. Exclusive like a lifecycle
// verb: refused, never queued, while the guest is busy or no executor is
// live.

export { CONFIG_JOB_KINDS };

const identityOf = (expect) => (expect && (expect.uuid != null || expect.created_at != null) ? { ...(expect.uuid != null ? { uuid: String(expect.uuid) } : {}), ...(expect.created_at != null ? { created_at: String(expect.created_at) } : {}) } : null);

// resolveConfigPlan(db, { kind, containerName, … }) → { ok, plan, params,
// digest, retryJob } | { ok: false, error }. Pure: the plan is what a
// confirmation is bound to, params what the job carries.
export function resolveConfigPlan(db, { kind, containerName, expect = null, changes = null, rootSize = null, acknowledgeRisk = false, snapshot = null, device = null, deviceType = null, props = null, ip = null, previous = null, forward = null, bridgeIp = null, serviceTag = null, serviceId = null, action = null, service = null, reason = null, retryOf = null }) {
  if (!CONFIG_JOB_KINDS.includes(kind)) return { ok: false, error: `unknown configuration operation '${kind}'` };
  const r = resolveRetryOf(db, { jobId: retryOf, app: containerName, kind });
  if (r.error) return { ok: false, error: r.error };
  const params = { container: String(containerName || '') };
  const id = identityOf(expect);
  if (id) params.expect = id;
  if (acknowledgeRisk === true) params.acknowledgeRisk = true;
  if (snapshot && SNAPSHOT_KINDS.includes(kind)) params.snapshot = { name: String(typeof snapshot === 'object' ? snapshot.name : snapshot) };
  switch (kind) {
    case 'config_set':
      if (Array.isArray(changes)) params.changes = changes.map((c) => ({ key: String(c?.key ?? ''), value: String(c?.value ?? '') }));
      if (rootSize != null) params.rootSize = String(rootSize);
      break;
    case 'device_add':
      params.device = String(device || ''); params.deviceType = String(deviceType || '');
      params.props = Object.fromEntries(Object.entries(props || {}).filter(([, v]) => v != null && v !== false).map(([k, v]) => [k, v === true ? 'true' : String(v)]));
      break;
    case 'device_remove': params.device = String(device || ''); break;
    case 'network_pin': params.ip = String(ip || ''); if (previous) params.previous = String(previous); break;
    case 'forward_apply': case 'forward_remove': {
      const f = forward || {};
      params.forward = { id: String(f.id || ''), proto: f.proto, listen: Number(f.listen), connect: Number(f.connect), ...(f.listenEnd != null ? { listenEnd: Number(f.listenEnd) } : {}), ...(f.connectEnd != null ? { connectEnd: Number(f.connectEnd) } : {}), ...(f.description ? { description: String(f.description) } : {}) };
      if (kind === 'forward_apply') { params.bridgeIp = String(bridgeIp || ''); params.serviceId = String(serviceId || ''); }
      if (serviceTag) params.serviceTag = String(serviceTag);
      break;
    }
    case 'egress_set': params.action = String(action || ''); params.service = String(service || ''); if (reason) params.reason = String(reason); break;
    default: break;
  }
  if (r.job) params.retryOf = r.job.id;
  const v = validateConfigParams(kind, params);
  if (!v.ok) return { ok: false, error: v.reason };
  const plan = {
    kind, container: params.container, expect: params.expect || null, snapshot: params.snapshot?.name || null, retry_of: r.job?.id || null,
    ...(kind === 'config_set' ? { changes: params.changes || [], root_size: params.rootSize || null, acknowledge_risk: params.acknowledgeRisk === true } : {}),
    ...(kind === 'device_add' ? { device: params.device, type: params.deviceType, props: params.props } : {}),
    ...(kind === 'device_remove' ? { device: params.device } : {}),
    ...(kind === 'network_pin' ? { ip: params.ip, previous: params.previous || null } : {}),
    ...(kind === 'forward_apply' || kind === 'forward_remove' ? { forward: params.forward, bridge_ip: params.bridgeIp || null, service_tag: params.serviceTag || null, service_id: params.serviceId || null } : {}),
    ...(kind === 'egress_set' ? { action: params.action, service: params.service, reason: params.reason || null } : {}),
  };
  return { ok: true, plan, params, retryJob: r.job, digest: planDigest(plan) };
}

// runGuestConfig({ kind, containerName, …, requestedBy, via }) → the outcome
// every caller reports: { ok, step, jobId, applied, snapshot, previous,
// instanceState, … } or { ok: false, step, error, code?, jobId? }. Refused
// (never queued) while the guest's lease is held or a mutating job is open,
// and when no executor is available.
export async function runGuestConfig({ kind, containerName, requestedBy = null, via = 'system', onEvent = null, detach = false, awaitKick = false, waitMs = null, ...fields }) {
  const store = containerLockStore();
  if (!store) return noStore();
  const db = store.getDb();
  const res = resolveConfigPlan(db, { kind, containerName, ...fields });
  if (!res.ok) return { ok: false, step: 'plan', code: 'INVALID', error: res.error };
  const sub = submitRunnerJob(db, { kind, app: res.params.container, params: res.params, configRefs: { ...res.plan, kind: undefined }, requestedBy, via, retryOf: res.retryJob?.id || null });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error, code: sub.code, holder: sub.holder };
  return runSubmittedJob(db, sub.job, { store, deps: inProcessExecutorDeps(store), env: store.env || process.env, onEvent, detach, awaitKick, waitMs });
}

// backendStepDeps(store) → { configureRoutes } — the route configurator the
// backend-executed `configure_routes` step calls: ProxyPilot's own rows and
// its Caddy render (lib/guest-routes.js over the services router's render
// bundle). The step's ownership `fence` is forwarded as-is: it is checked
// before every row, every site file, the validation, the reload and every
// write of a rollback. The Caddy bundle (`store.renderDeps`) is the ONE
// external dependency a test replaces; the adapter, the configurator and
// the render logic stay the production code. A store may still supply a
// whole `configureRoutes` of its own.
export function backendStepDeps(store = containerLockStore()) {
  if (store?.configureRoutes) return { configureRoutes: store.configureRoutes };
  return {
    platformResetRoutesStep: async ({ resetJob, fence }) => {
      const { removeResetRoutes } = await import('../lib/setup-engine/full-platform-reset.js');
      const render = store?.renderDeps || (await import('../routes/services.js')).caddyRenderDeps;
      return removeResetRoutes(store.getDb(), { resetJob, fence, render });
    },
    vaultwardenStep: async ({revision,fence}) => {
      const {configureVaultwardenRoute}=await import('../lib/setup-engine/vaultwarden-routes.js');
      const render=store?.renderDeps || (await import('../routes/services.js')).caddyRenderDeps;
      return configureVaultwardenRoute(store.getDb(),{revision,fence,render});
    },
    openbaoStep: async ({revision,fence}) => {
      const {configureOpenBaoRoute}=await import('../lib/setup-engine/openbao-routes.js');
      const render=store?.renderDeps || (await import('../routes/services.js')).caddyRenderDeps;
      return configureOpenBaoRoute(store.getDb(),{revision,fence,render});
    },
    infisicalStep: async ({revision,fence}) => {
      const {configureInfisicalRoute}=await import('../lib/setup-engine/infisical-routes.js');
      const render=store?.renderDeps || (await import('../routes/services.js')).caddyRenderDeps;
      return configureInfisicalRoute(store.getDb(),{revision,fence,render});
    },
    pomeriumStep: async ({revision,stage,fence}) => {
      const {configurePomeriumRoutes}=await import('../lib/setup-engine/pomerium-routes.js');
      const render=store?.renderDeps || (await import('../routes/services.js')).caddyRenderDeps;
      return configurePomeriumRoutes(store.getDb(),{revision,stage,fence,render});
    },
    ssoStep: async ({ kind, fingerprint, fence }) => {
      const { assertCurrent } = await import('../lib/sso/store.js');
      fence(); const r = assertCurrent(store.getDb(), fingerprint);
      if (kind === 'verify_sso') {
        const { verifySettings } = await import('../lib/sso/oidc.js');
        await verifySettings(store.getDb(), r, { fence }); fence(); return {};
      }
      const { configureRecoveryRoute } = await import('../lib/sso/recovery-route.js');
      const render = store?.renderDeps || (await import('../routes/services.js')).caddyRenderDeps;
      return configureRecoveryRoute(store.getDb(), { fingerprint, fence, render });
    },
    configureKeycloakRoute: async ({ installationId, fence }) => {
      const { configureKeycloakRoute } = await import('../lib/setup-engine/keycloak-routes.js');
      const render = store?.renderDeps || (await import('../routes/services.js')).caddyRenderDeps;
      return configureKeycloakRoute(store.getDb(), { installationId, fence, render });
    },
    configureRoutes: async ({ name, ip, services, fence = null }) => {
      const { configureGuestRoutes } = await import('../lib/guest-routes.js');
      const render = store?.renderDeps || (await import('../routes/services.js')).caddyRenderDeps;
      return configureGuestRoutes(store.getDb(), { name, ip, services, render, fence });
    },
  };
}

// drainBackendStepsNow(store) — the boot / interval / on-demand drain of the
// backend's own steps. One drain at a time in this process; a second caller
// during a drain gets the running one.
let backendDrain = null;
export async function drainBackendStepsNow(store = containerLockStore(), { max = 5, nowMs, keepAliveMs } = {}) {
  if (!store) return { skipped: 'no_store', ran: [] };
  if (backendDrain) return backendDrain;
  backendDrain = drainBackendSteps(store.getDb(), { deps: backendStepDeps(store), owner: store.owner, max, ...(nowMs ? { nowMs } : {}), ...(keepAliveMs ? { keepAliveMs } : {}) }).finally(() => { backendDrain = null; });
  return backendDrain;
}

// createStatus(db, incusName, { nowMs }) → the dashboard's create-status
// answer for a guest, derived from the records alone: the newest
// instance_create job of the guest, the guest_setup it queued and the
// configure_routes that setup queued. Null when no create was recorded.
export function createStatus(db, incusName, { nowMs = Date.now() } = {}) {
  const creates = listJobs(db, { app: incusName, limit: 200 }).filter((j) => j.kind === 'instance_create');
  if (!creates.length) return null;
  const create = jobView(creates[0]);
  const setupId = create.progress?.setup_job_id || null;
  const setup = setupId ? jobView(getJob(db, setupId)) : null;
  const routesId = setup?.progress?.routes_job_id || null;
  const routes = routesId ? jobView(getJob(db, routesId)) : null;
  const view = createStatusView({ create, setup, routes, nowMs });
  if (view && routes && ['queued'].includes(routes.status) && BACKEND_STEP_KINDS.includes(routes.kind)) drainBackendStepsNow().catch(() => {});
  return view;
}

// waitForSetup(db, setupJobId, { timeoutMs }) → the terminal setup row
// (through jobView) or null on timeout — what the MCP create waits on for
// the address.
export async function waitForSetup(db, setupJobId, { timeoutMs = 60_000, onEvent = null } = {}) {
  const row = await waitForJob(db, setupJobId, { timeoutMs, onEvent, pollMs: 500 });
  return row ? jobView(row) : null;
}

export { normalizeServices };

// lifecycleHttpStatus(out) → the HTTP status a REST route answers a failed
// runLifecycle with: 409 for a held guest or a changed target, 503 for no
// executor, 404 for a missing resource, 400 for an invalid plan, 500 else.
export function lifecycleHttpStatus(out) {
  if (!out || out.ok) return 200;
  if (out.code === 'CONTAINER_BUSY' || out.code === 'CONTAINER_LOCK_STALE') return 409;
  if (out.code === 'INVALID') return 400;
  if (out.step === 'runner_unavailable') return 503;
  if (out.notFound) return 404;
  if (out.step === 'target' || (out.step === 'query' && out.refused)) return 409;
  // A configuration job refused before any change: a contended shared lease,
  // a device that exists with other properties, a snapshot of unknown content.
  if (out.refused && (out.contended || out.step === 'protect' || out.step === 'device' || out.step === 'lease')) return 409;
  return 500;
}
