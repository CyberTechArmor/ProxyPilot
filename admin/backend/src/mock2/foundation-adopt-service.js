// Mock2 application foundation — ADOPTION of an existing project, the
// ORCHESTRATION (user decision 2026-10-25; docs/features/app-foundation.md).
//
// plan → confirm → twelve durable steps (foundation-adopt-logic.js ADOPT_STEPS)
// that move a pre-foundation Dev Studio project (projects.foundation_version
// IS NULL) onto the application foundation, so it ends up like a NEW
// foundation project: Docker-ready guest, the Compose stack, its data in the
// foundation PostgreSQL, its component secrets in the encrypted store, the
// platform-owned foundation/ module in its repository and a foundation deploy.
//
//   * Nothing happens without a person's confirmation (editor + sudo, a plan
//     token recomputed from fresh probes, acknowledge_downtime).
//   * The checkout lock (mock2_locks, an operation lease) is held for the
//     whole run, from the confirmation to the last step; a build cannot start.
//   * Every step is recorded in mock2_foundation_adoptions (migration 566) and
//     idempotent, so an interrupted run (backend restart → `failed` on boot)
//     resumes at its failed step; a refusal that would repeat (row counts
//     differ, a target that is not empty) offers the rollback instead.
//   * The rollback restores the step-1 snapshot (taking a pre-rollback
//     snapshot first, so nothing written since is lost), puts the guest's
//     original config back, resets the repository's main if the platform
//     commit is still its tip, clears foundation_version and the foundation
//     rows the run created, and releases the lock — from any failed step and
//     after success.
//   * Nothing is deleted: the snapshot, the native data directory and the dump
//     stay until a person removes them.
//   * No secret value is ever logged, audited, stored in the run's record or
//     returned: values cross from /etc/environment into lib/secrets.js
//     ciphertext in memory only.
//
// The guest and host commands go through injected deps (defaultDeps below:
// incus exec through mock2/host.js runHost — nsenter-aware, R3); tests replace
// them with a scripted guest. No MCP tool reaches any of this (ratchet).
//
// Terminology (risk R7): nothing here is named "agent".

import { randomBytes } from 'node:crypto';
import * as adoptStore from './foundation-adopt-store.js';
import * as fstore from './foundation-store.js';
import {
  ADOPT_CODES, ADOPT_STEPS, STEP_NAMES, APP_DIR, NATIVE_DEFAULT, adoptRefusal, stepRetry,
  newAdoptionId, snapshotNameFor, preRollbackSnapshotNameFor, adoptProbeScript, parseProbe,
  adoptionBlockers, buildAdoptionPlan, planTokenOf, tokensEqual, secretsToMove, guestConfigFacts,
  stopAppScript, dumpScript, parseDump, stopNativeScript, portCheckScript, parsePortCheck, restoreScript, COUNT_SQL, OWNER_SQL, parseCounts, parseNotAppOwned,
  compareCounts, describeMismatches, totalRows, formatBytes, READ_ENVIRONMENT_SCRIPT, removeEnvironmentKeysScript,
  parseEnvRemaining, moduleCommitScript, parseModuleCommit, mergeFoundationPackageJson, configChanges, configRestore,
  projectAdoption, resumeAvailable,
} from './foundation-adopt-logic.js';
import { FOUNDATION_VERSION, FEATURES, componentSecretName, defaultFeatures } from './foundation-contract.js';
import { redactSecrets, parseHealthOutput } from './foundation-logic.js';
import { dockerProbeScript, parseDockerProbe, DEFAULT_LAYOUT } from './foundation-stack-logic.js';
import { getLock, acquireCheckoutOperationLease, settleCheckoutOperationLease } from './locks.js';
import { lockHolder } from './lock-logic.js';
import { parseEnvironmentFile } from './deploy-logic.js';
import { listProjectComponents } from './components.js';
import { parseContractJson } from './component-logic.js';
import { scaffoldFoundationFiles } from './scaffold.js';
import { buildSeedPayload } from './seed-tar.js';
import { foundationRuntimeInstallScript } from './template.js';
import { parseInstanceList, snapshotCoverage } from '../lib/setup-engine/restore-logic.js';
import { createSnapshotWithFallback } from '../lib/setup-engine/restore-snapshot-op.js';
import { snapshotArgv } from '../lib/mcp-logic.js';

const MIN = 60_000;
const LEASE_KIND = 'project-write';
const tail = (r, n = 400) => `${r?.stderr || ''}${r?.stdout ? `\n${r.stdout}` : ''}`.trim().slice(-n);
const say = (msg) => console.log(`[mock2] foundation adoption: ${msg}`);

// ---- dependencies ------------------------------------------------------------

let depsOverride = null;
let defaultDepsPromise = null;
const running = new Map();        // adoption id → the promise driving it (this process)
const busyProjects = new Set();   // start / resume / rollback admission, per project
const repoHeadCache = new Map();  // project id → { at, head }

// Test seam: a scripted guest/host and adapters. null restores the defaults.
export function _setAdoptionDepsForTests(deps = null) {
  depsOverride = deps;
  repoHeadCache.clear();
}
// Resolves when the run (or rollback) currently driving this adoption settles.
export function _whenAdoptionSettled(id) {
  return running.get(String(id)) || Promise.resolve();
}
// Test seam: what a backend restart does to this process's memory — the
// in-flight runs are forgotten (their late results are discarded: each run
// carries a driver id that a resume or a rollback replaces).
export function _simulateRestartForTests() {
  running.clear();
  busyProjects.clear();
  repoHeadCache.clear();
}

async function deps() {
  if (depsOverride) return { native: NATIVE_DEFAULT, ...depsOverride };
  if (!defaultDepsPromise) defaultDepsPromise = defaultDeps();
  return defaultDepsPromise;
}

async function defaultDeps() {
  const [{ runHost }, stack, deploy, containerLock, setupStore] = await Promise.all([
    import('./host.js'), import('./foundation-stack.js'), import('./deploy.js'), import('./container-lock.js'), import('../lib/setup-engine/store.js'),
  ]);
  const dataDir = process.env.MOCK2_DATA_DIR || '/var/lib/proxypilot/mock2';
  const repoPath = (project) => project.repo_path || `${dataDir}/repos/${Number(project.id)}.git`;
  const host = (argv, { timeoutMs = 2 * MIN, input = null } = {}) => runHost(argv[0], argv.slice(1), { timeoutMs, input });
  return {
    native: NATIVE_DEFAULT,
    guest: (container, script, { args = [], input = null, timeoutMs = 2 * MIN } = {}) => runHost('incus', ['exec', String(container), '--', 'sh', '-c', script, 'sh', ...args.map(String)], { input, timeoutMs }),
    host,
    ensureMasterKey: stack.ensureMasterKey,
    bringUpFoundation: stack.bringUpFoundation,
    foundationPsql: stack.foundationPsql,
    foundationCli: stack.foundationCli,
    deploy: (project) => deploy.deployProject({ containerName: project.container_name, appDir: APP_DIR, webPort: project.web_port || 3000, via: 'foundation-adopt' }),
    stampDeployedCommit: (project) => deploy.stampDeployedCommit(project.id, project.container_name, APP_DIR),
    probeServing: (project) => deploy.probeServing(project),
    afterGuestRestart: async (project) => {
      const { waitForContainerIp } = await import('./provision.js');
      const ip = await waitForContainerIp(project.container_name, { attempts: 180, delayMs: 1000 });
      if (!ip) return { ok: false, error: 'the guest did not get its network address back within 3 minutes of the restart' };
      adoptStore.setContainerIp(project.id, ip);
      try { const { reconcileMock2Firewall } = await import('./firewall.js'); await reconcileMock2Firewall(); } catch (e) { console.warn('[mock2] foundation adoption: firewall reconcile failed:', e?.message); }
      if (project.parent_domain_id) {
        try { const { publishDomain } = await import('./publish.js'); await publishDomain(project.parent_domain_id); } catch (e) { console.warn('[mock2] foundation adoption: route publish failed:', e?.message); }
      }
      return { ok: true, ip };
    },
    busy: async (project) => {
      const out = { deploy: false, setupLease: false, baseAppDeploying: false, provisioning: false };
      const name = project.container_name;
      if (name) {
        out.deploy = !!containerLock.containerLockHolder(name);
        const store = containerLock.containerLockStore();
        if (store) {
          try {
            const db = store.getDb();
            out.setupLease = !!setupStore.readLock(db, name);
            out.deploy = out.deploy || db.prepare("SELECT count(*) AS n FROM setup_jobs WHERE app = ? AND status IN ('queued','running')").get(String(name)).n > 0;
          } catch { /* the engine store is optional here */ }
        }
      }
      try {
        const provision = await import('./provision.js');
        out.baseAppDeploying = provision.isBaseAppDeploying(project.id);
        const st = provision.getProvisionStatus(project.id);
        out.provisioning = !!st && !['ready', 'failed', 'archived'].includes(st.phase);
      } catch { /* provisioning state is in-process only */ }
      return out;
    },
    repoHead: async (project) => {
      const r = await host(['git', '--git-dir', repoPath(project), 'rev-parse', '--verify', 'refs/heads/main'], { timeoutMs: 30_000 });
      const sha = String(r.stdout || '').trim();
      return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
    repoReset: (project, { from, to }) => host(['git', '--git-dir', repoPath(project), 'update-ref', 'refs/heads/main', to, from], { timeoutMs: 30_000 }),
    notify: async (projectId, body) => {
      try { const { insertMessage } = await import('./chats.js'); insertMessage({ projectId, kind: 'system', body }); } catch { /* best effort */ }
    },
  };
}

// ---- facts -------------------------------------------------------------------

// The component secret keys the installed components declare (secret: true).
function installedSecretConfigKeys(projectId) {
  const keys = new Set();
  for (const row of listProjectComponents(projectId)) {
    if (row?.status !== 'installed') continue;
    for (const c of parseContractJson(row.contract_json)?.config || []) {
      if (c && c.secret === true && /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(c.key || ''))) keys.add(String(c.key));
    }
  }
  return [...keys].sort();
}

async function readInstance(d, container) {
  const r = await d.host(['incus', 'list', String(container), '--format', 'json'], { timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  const inst = parseInstanceList(r.stdout, container);
  if (!inst) return null;
  return {
    type: inst.type || 'container',
    status: inst.status || null,
    config: inst.config || {},
    snapshots: Array.isArray(inst.snapshots) ? inst.snapshots.filter(Boolean).map((s) => ({ name: s.name, created_at: s.created_at || null })) : [],
    customVolumes: snapshotCoverage(inst).customVolumes.length,
  };
}

async function gatherFacts(projectId, d) {
  const project = adoptStore.getAdoptProject(projectId);
  if (!project) return null;
  const latest = adoptStore.latestAdoption(projectId);
  let lockRow = null;
  try { lockRow = getLock(projectId) || null; } catch { lockRow = null; }
  // The run's own lease (a failed run keeps it) is reported as the run, not as a lock.
  const ownLease = lockRow && latest?.lock_token && lockRow.holder_operation_id === latest.lock_token;
  const facts = {
    project,
    adoption: latest ? { state: latest.state, step: latest.step } : null,
    lock: { holder: ownLease ? null : lockHolder(lockRow) },
    busy: await d.busy(project),
    instance: undefined,
    guest: null,
    components: { secretKeys: [] },
  };
  if (project.foundation_version || project.lifecycle !== 'active' || !project.container_name) return facts;
  facts.instance = await readInstance(d, project.container_name);
  facts.components.secretKeys = installedSecretConfigKeys(projectId);
  if (facts.instance && String(facts.instance.status || '').toLowerCase() === 'running') {
    const r = await d.guest(project.container_name, adoptProbeScript({ native: d.native }), { timeoutMs: 2 * MIN });
    facts.guest = parseProbe(r.stdout);
  }
  return facts;
}

// ---- plan ----------------------------------------------------------------------

export async function planAdoption(projectId) {
  const d = await deps();
  const facts = await gatherFacts(projectId, d);
  if (!facts) return adoptRefusal(ADOPT_CODES.PROJECT_NOT_FOUND, 'Project not found', { status: 404 });
  const blockers = adoptionBlockers(facts);
  return { ok: true, plan: buildAdoptionPlan(facts), blockers, plan_token: blockers.length ? null : planTokenOf(facts) };
}

// ---- admission -----------------------------------------------------------------

async function exclusive(projectId, fn) {
  const key = Number(projectId);
  if (busyProjects.has(key)) return adoptRefusal(ADOPT_CODES.ADOPTION_BUSY, 'Another adoption request for this project is being handled; try again in a moment.');
  busyProjects.add(key);
  try { return await fn(); } finally { busyProjects.delete(key); }
}

function view(id) {
  const row = adoptStore.getAdoption(id);
  return projectAdoption(row, { running: running.has(String(id)) });
}

// One driver at a time per run: launch records a fresh driver id and the run
// writes only while that id is still the run's (a resume or a rollback after a
// restart replaces it, so a step that returns late changes nothing).
function launch(id, fn) {
  const key = String(id);
  const driver = randomBytes(6).toString('hex');
  adoptStore.updateAdoption(key, { data: { driver } });
  const p = Promise.resolve().then(() => fn(key, driver)).catch((e) => {
    console.error(`[mock2] foundation adoption ${key} crashed:`, redactSecrets(e?.message || String(e)).slice(0, 300));
    try {
      const row = adoptStore.getAdoption(key);
      if (row && (row.state === 'running' || row.state === 'rolling_back') && adoptStore.adoptionData(row).driver === driver) {
        adoptStore.updateAdoption(key, { state: 'failed', error: `The ${row.state === 'running' ? 'adoption' : 'rollback'} stopped unexpectedly: ${redactSecrets(e?.message || String(e)).slice(0, 300)}`, resumable: row.state === 'running', finished: true });
      }
    } catch { /* the boot sweep records it */ }
  }).finally(() => { if (running.get(key) === p) running.delete(key); });
  running.set(key, p);
  return p;
}

const FEATURE_VALUES = ['on', 'off'];

// startAdoption(projectId, { plan_token, acknowledge_downtime, features }, { userId })
export async function startAdoption(projectId, body = {}, { userId = null } = {}) {
  if (body?.acknowledge_downtime !== true) {
    return adoptRefusal(ADOPT_CODES.ACKNOWLEDGE_DOWNTIME_REQUIRED, 'Confirm the downtime (acknowledge_downtime: true): the app is stopped from step 2 until the deploy in step 11 serves it again.', { status: 400 });
  }
  const features = { storage: 'on', embeddings: 'on' };
  for (const f of FEATURES) {
    const v = body?.features?.[f];
    if (v === undefined) continue;
    if (!FEATURE_VALUES.includes(v)) return adoptRefusal(ADOPT_CODES.INVALID_REQUEST, `features.${f} must be "on" or "off"`, { status: 400 });
    features[f] = v;
  }
  return exclusive(projectId, async () => {
    const d = await deps();
    const facts = await gatherFacts(projectId, d);
    if (!facts) return adoptRefusal(ADOPT_CODES.PROJECT_NOT_FOUND, 'Project not found', { status: 404 });
    const blockers = adoptionBlockers(facts);
    if (blockers.length) return adoptRefusal(ADOPT_CODES.PLAN_BLOCKED, 'The adoption cannot start: the fresh checks found blockers. Resolve them and plan again.', { blockers });
    if (!tokensEqual(body?.plan_token, planTokenOf(facts))) {
      return adoptRefusal(ADOPT_CODES.PLAN_STALE, 'The project changed since this plan was made (its commits, tables, secrets or guest settings). Plan again and confirm the new plan.', { options: [{ action: 'plan' }] });
    }
    const pid = Number(projectId);
    const lease = acquireCheckoutOperationLease(pid, LEASE_KIND);
    if (!lease.ok) return adoptRefusal(ADOPT_CODES.CHECKOUT_LOCK_HELD, `The project's checkout lock could not be taken: ${lease.reason || 'held by another writer'}. Wait for it to be free, then plan again.`);
    const id = newAdoptionId(randomBytes(8).toString('hex'));
    const g = facts.guest;
    const data = {
      version: FOUNDATION_VERSION,
      plan_token: planTokenOf(facts),
      features,
      container: facts.project.container_name,
      secrets_to_move: secretsToMove(facts),
      tables: g.native.tables,
      db_size_bytes: g.native.sizeBytes,
      pre_commit: g.git.head,
      pre_remote: g.git.remote,
      original_config: guestConfigFacts(facts.instance),
    };
    try {
      adoptStore.insertAdoption({ id, projectId: pid, data, lockToken: lease.token, createdBy: userId });
    } catch (e) {
      settleCheckoutOperationLease(pid, lease.token);
      if (/UNIQUE/i.test(String(e?.message))) return adoptRefusal(ADOPT_CODES.ADOPTION_RUNNING, 'An adoption is already running for this project.');
      throw e;
    }
    adoptStore.touchProjectActivity(pid);
    say(`${id} started for project ${pid} (${facts.project.container_name})`);
    launch(id, drive);
    return { ok: true, status: 202, adoption: view(id) };
  });
}

// ---- the run -------------------------------------------------------------------

const ok = (detail) => ({ ok: true, detail });
const fail = (error, { retryable = true, code = null } = {}) => ({ ok: false, error, retryable, code });

async function guestOk(ctx, script, opts = {}) {
  const r = await ctx.d.guest(ctx.container, script, opts);
  return { r, ok: r && r.code === 0 };
}

async function requireInstance(ctx) {
  const inst = await readInstance(ctx.d, ctx.container);
  if (!inst) throw new Error(`Incus could not report the guest ${ctx.container}`);
  return inst;
}

const STEP_IMPL = {
  async snapshot(ctx) {
    const name = snapshotNameFor(ctx.id);
    let inst = await requireInstance(ctx);
    let found = inst.snapshots.find((s) => s.name === name);
    if (!found) {
      const c = await createSnapshotWithFallback(ctx.d.host, ctx.container, name, { deferRetention: true });
      if (!c.ok) return fail(`could not take the snapshot ${name}: ${redactSecrets(c.error || 'unknown error').slice(0, 300)}`);
      inst = await requireInstance(ctx);
      found = inst.snapshots.find((s) => s.name === name);
      if (!found) return fail(`the snapshot ${name} was reported created but is not on the guest`);
    }
    ctx.save({ snapshot: { name, created_at: found.created_at || null } });
    return ok(`Snapshot ${name} taken${found.created_at ? ` (${found.created_at})` : ''}.`);
  },

  async stop_app(ctx) {
    const { r } = await guestOk(ctx, stopAppScript(), { timeoutMs: 3 * MIN });
    const was = (String(r?.stdout || '').match(/^WAS_ENABLED:(.*)$/m) || [])[1]?.trim() || 'unknown';
    if (ctx.data.app_unit_was_enabled == null) ctx.save({ app_unit_was_enabled: was });
    if (!/^APP_STOPPED:yes$/m.test(String(r?.stdout || ''))) return fail(`the app (mock2-dev.service) did not stop: ${tail(r, 200) || 'no answer from the guest'}`);
    return ok('The checkout lock is held for the run; the app is stopped (and disabled until the deploy).');
  },

  async dump_database(ctx) {
    const { r, ok: done } = await guestOk(ctx, dumpScript(ctx.id, { native: ctx.d.native }), { timeoutMs: 60 * MIN });
    const dump = parseDump(r?.stdout);
    if (!done || !dump.path || dump.size_bytes == null || !dump.sha256 || !dump.countsComplete) {
      return fail(`dumping the native "app" database failed: ${tail(r, 300) || 'no answer from the guest'}`);
    }
    ctx.save({ dump: { path: dump.path, size_bytes: dump.size_bytes, sha256: dump.sha256 }, counts: dump.counts });
    const n = Object.keys(dump.counts).length;
    return ok(`Dumped ${formatBytes(dump.size_bytes)} to ${dump.path} (sha256 ${dump.sha256.slice(0, 12)}…): ${n} table${n === 1 ? '' : 's'}, ${totalRows(dump.counts)} rows.`);
  },

  async stop_native_database(ctx) {
    const port = ctx.d.pgPort || DEFAULT_LAYOUT.ports.postgres;
    const { r } = await guestOk(ctx, stopNativeScript({ port }), { timeoutMs: 3 * MIN });
    const out = String(r?.stdout || '');
    const was = (out.match(/^WAS_ENABLED:(.*)$/m) || [])[1]?.trim() || 'unknown';
    if (ctx.data.native_was_enabled == null) ctx.save({ native_was_enabled: was });
    if (!/^NATIVE_STOPPED:yes$/m.test(out)) return fail(`the native PostgreSQL did not stop: ${tail(r, 200) || 'no answer from the guest'}`);
    if (parsePortCheck(out).free !== true) return fail(`the native PostgreSQL is stopped, but something still listens on port ${port} in the guest, which the foundation's PostgreSQL publishes on 127.0.0.1 — find it (ss -ltnp in the guest), stop it, then resume`);
    return ok(`The native PostgreSQL is stopped and disabled (port ${port} is free); its data directory is untouched.`);
  },

  async docker_ready(ctx) {
    let inst = await requireInstance(ctx);
    const changes = configChanges(inst.config);
    if (changes.length) {
      const r = await ctx.d.host(['incus', 'config', 'set', ctx.container, ...changes.map((c) => `${c.key}=${c.value}`)], { timeoutMs: MIN });
      if (r.code !== 0) return fail(`incus config set failed: ${tail(r, 300)}`);
      inst = await requireInstance(ctx);
      const left = configChanges(inst.config);
      if (left.length) return fail(`the guest still has ${left.map((c) => c.key).join(', ')} unset after incus config set`);
      ctx.save({ config_changed: true, restarted_after_config: false });
    }
    const data = ctx.reload();
    let restarted = false;
    if (changes.length || (data.config_changed && !data.restarted_after_config)) {
      const r = await ctx.d.host(['incus', 'restart', ctx.container], { timeoutMs: 5 * MIN });
      if (r.code !== 0) return fail(`incus restart failed: ${tail(r, 300)}`);
      const up = await ctx.d.afterGuestRestart(ctx.project);
      if (!up?.ok) return fail(up?.error || 'the guest did not come back after the restart');
      ctx.save({ restarted_after_config: true });
      restarted = true;
    }
    const { r, ok: alive } = await guestOk(ctx, 'echo ADOPT_GUEST_UP', { timeoutMs: MIN });
    if (!alive || !/ADOPT_GUEST_UP/.test(String(r?.stdout || ''))) return fail('the guest does not answer after the restart');
    return ok(restarted ? 'The guest is Docker-ready (security.nesting and the syscall intercepts) and was restarted.' : 'The guest already had the Docker-ready settings in force.');
  },

  async install_runtime(ctx) {
    const { r, ok: done } = await guestOk(ctx, foundationRuntimeInstallScript(), { timeoutMs: 20 * MIN });
    if (!done) return fail(`installing Docker, Compose and the PostgreSQL client failed: ${tail(r, 500)}`);
    const probe = parseDockerProbe((await ctx.d.guest(ctx.container, dockerProbeScript(), { timeoutMs: MIN }))?.stdout);
    if (!probe.ok) return fail(probe.error);
    return ok(`Docker ${probe.docker}, Compose ${probe.compose} (storage driver ${probe.driver})${probe.warning ? ` — ${probe.warning}` : ''}.`);
  },

  async start_foundation(ctx) {
    const pid = ctx.pid;
    // The guest restarted in docker_ready: the native server must not have
    // come back on the port the stack publishes (stopping it again is the
    // same idempotent step 4).
    const port = ctx.d.pgPort || DEFAULT_LAYOUT.ports.postgres;
    let pc = parsePortCheck((await ctx.d.guest(ctx.container, portCheckScript({ port }), { timeoutMs: MIN }))?.stdout);
    if (pc.free !== true || (pc.nativeOnline || 0) > 0) {
      const again = await ctx.d.guest(ctx.container, stopNativeScript({ port }), { timeoutMs: 3 * MIN });
      pc = parsePortCheck(again?.stdout);
      if (pc.free !== true) return fail(`port ${port} in the guest is in use (the foundation's PostgreSQL publishes it on 127.0.0.1) — find what listens (ss -ltnp in the guest), stop it, then resume`);
    }
    if (!adoptStore.getAdoptProject(pid)?.foundation_version) adoptStore.setFoundationVersion(pid, FOUNDATION_VERSION);
    const defaults = defaultFeatures();
    const chosen = ctx.data.features || { storage: 'on', embeddings: 'on' };
    const writeChosen = () => {
      for (const f of FEATURES) fstore.writeFeature(pid, f, { state: chosen[f] === 'off' ? 'off' : 'on', provider: defaults[f].provider, config: defaults[f].config, pending: null });
    };
    const first = !ctx.data.features_written;
    if (first) writeChosen();
    let inputs = fstore.getFoundationProvisionInputs(pid);
    if (first) {
      // A project that started as a clone would inherit its source's
      // embeddings settings and component keys here; an adopted project keeps
      // its OWN keys (moved from its environment in move_secrets) and starts
      // on the features chosen at the confirmation.
      writeChosen();
      const moving = new Set((ctx.data.secrets_to_move || []).map((k) => componentSecretName(k)));
      const stray = fstore.listSecretNames(pid).filter((n) => n.startsWith('component.') && !moving.has(n));
      if (stray.length) fstore.deleteSecrets(pid, stray);
      inputs = fstore.getFoundationProvisionInputs(pid);
      ctx.save({ features_written: true });
    }
    const key = await ctx.d.ensureMasterKey(ctx.container, inputs.masterKey);
    if (!key?.ok) return fail(`writing the master key failed: ${redactSecrets(key?.error || 'unknown error').slice(0, 300)}`);
    const up = await ctx.d.bringUpFoundation({
      containerName: ctx.container, features: inputs.features, masterKey: inputs.masterKey, storageCredentials: inputs.storageCredentials,
      onStep: (_n, label) => ctx.detail(label),
    });
    if (!up?.ok) {
      const at = up?.steps?.find((s) => !s.ok)?.name || 'bring-up';
      return fail(`the foundation stack failed at "${at}": ${redactSecrets(up?.error || 'unknown error').slice(0, 400)}`);
    }
    const on = FEATURES.filter((f) => inputs.features[f].state === 'on');
    return ok(`The foundation stack is up (PostgreSQL + pgvector${on.length ? `, ${on.join(', ')}` : ''}${on.length < FEATURES.length ? `; ${FEATURES.filter((f) => !on.includes(f)).join(', ')} off` : ''}).`);
  },

  async restore_database(ctx) {
    const expected = ctx.data.counts || {};
    const count = async () => {
      const r = await ctx.d.foundationPsql(ctx.container, COUNT_SQL, { database: 'app', timeoutMs: 20 * MIN });
      const c = parseCounts(r?.stdout);
      return r?.code === 0 && c.complete ? c.counts : null;
    };
    const before = await count();
    if (!before) return fail('the foundation PostgreSQL could not be read before the restore');
    let restored = false;
    if (Object.keys(before).length === 0) {
      const dumpPath = ctx.data.dump?.path;
      if (!dumpPath) return fail('the dump of step 3 is not recorded', { retryable: false });
      const { r, ok: done } = await guestOk(ctx, restoreScript(), { args: [dumpPath], timeoutMs: 90 * MIN });
      if (!done || !/^RESTORE:done$/m.test(String(r?.stdout || ''))) return fail(`pg_restore into the foundation PostgreSQL failed (nothing was kept: it runs in one transaction): ${tail(r, 500)}`);
      restored = true;
    } else {
      const cmp = compareCounts(expected, before);
      if (!cmp.ok) {
        return fail(`the foundation PostgreSQL already holds tables that do not match the dump (${describeMismatches(cmp.mismatches, 4)}); it is not overwritten — roll back`, { retryable: false, code: ADOPT_CODES.RESTORE_TARGET_NOT_EMPTY });
      }
    }
    const vec = await ctx.d.foundationPsql(ctx.container, 'CREATE EXTENSION IF NOT EXISTS vector;\n', { database: 'app', timeoutMs: MIN });
    if (vec?.code !== 0) return fail(`enabling pgvector failed: ${tail(vec, 300)}`);
    const after = await count();
    if (!after) return fail('the foundation PostgreSQL could not be read after the restore');
    const cmp = compareCounts(expected, after);
    if (!cmp.ok) return fail(`the restored row counts differ from the dump: ${describeMismatches(cmp.mismatches)} — the run stops here; roll back`, { retryable: false, code: ADOPT_CODES.ROW_COUNT_MISMATCH });
    const owners = await ctx.d.foundationPsql(ctx.container, OWNER_SQL, { database: 'app', timeoutMs: MIN });
    const notApp = parseNotAppOwned(owners?.stdout);
    if (owners?.code !== 0 || notApp == null) return fail('the restored tables\' owner could not be checked');
    if (notApp > 0) return fail(`${notApp} restored table(s) are not owned by role app, so the app's migrations could not change them — roll back`, { retryable: false, code: ADOPT_CODES.ROW_COUNT_MISMATCH });
    const n = Object.keys(after).length;
    ctx.save({ restored: { tables: n, rows: totalRows(after) } });
    return ok(`${restored ? 'Restored' : 'Already restored'} and verified: ${n} table${n === 1 ? '' : 's'}, ${totalRows(after)} rows, every count equal to the dump; owned by role app; pgvector enabled.`);
  },

  async move_secrets(ctx) {
    const pid = ctx.pid;
    const keys = installedSecretConfigKeys(pid);
    const read = await ctx.d.guest(ctx.container, READ_ENVIRONMENT_SCRIPT, { timeoutMs: MIN });
    if (read?.code !== 0) return fail('reading /etc/environment in the guest failed');
    const env = parseEnvironmentFile(read.stdout || '');
    const values = [];
    const moved = [];
    const remove = [];
    try {
      for (const k of keys) {
        if (!env.has(k)) continue;
        const v = env.get(k);
        remove.push(k);
        if (v === '') continue;
        values.push(v);
        fstore.writeSecret(pid, componentSecretName(k), v);
        moved.push(k);
      }
    } catch (e) {
      return fail(`storing the secrets failed: ${redactSecrets(e?.message || String(e), values).slice(0, 200)}`);
    }
    if (env.has('DATABASE_URL')) remove.push('DATABASE_URL');
    if (remove.length) {
      const { r, ok: done } = await guestOk(ctx, removeEnvironmentKeysScript(), { args: remove, timeoutMs: MIN });
      const left = parseEnvRemaining(r?.stdout);
      if (!done || left !== 0) return fail(`removing ${remove.length} line(s) from /etc/environment failed: ${redactSecrets(tail(r, 200), values)}`);
    }
    const sync = await fstore.syncFoundationToApp(pid);
    if (!sync?.ok) return fail(`delivering the secrets to the app database failed: ${redactSecrets(sync?.error || 'unknown error', values).slice(0, 300)}`);
    const all = [...new Set([...(ctx.data.moved_secrets || []), ...moved])].sort();
    const missing = (ctx.data.secrets_to_move || []).filter((k) => !all.includes(k));
    ctx.save({ moved_secrets: all, database_url_removed: !!(ctx.data.database_url_removed || env.has('DATABASE_URL')) });
    return ok(`${all.length ? `Moved ${all.join(', ')} into the encrypted store and delivered sealed to the app database (generation ${sync.generation})` : `No component secret to move; the app database is in sync (generation ${sync.generation})`}`
      + `${remove.length ? `; removed ${remove.length} line(s) from /etc/environment${remove.includes('DATABASE_URL') ? ' (DATABASE_URL included)' : ''}` : ''}`
      + `${missing.length ? `; not found any more: ${missing.join(', ')}` : ''}.`);
  },

  async install_foundation_module(ctx) {
    const pkg = await ctx.d.guest(ctx.container, `cat '${APP_DIR}/package.json'`, { timeoutMs: MIN });
    if (pkg?.code !== 0) return fail('reading package.json in the guest failed');
    const merge = mergeFoundationPackageJson(pkg.stdout);
    if (!merge.ok) return fail(`package.json cannot take the foundation entries: ${merge.error}`, { retryable: false });
    const files = [...scaffoldFoundationFiles(), { path: 'package.json', content: merge.content }];
    const { r, ok: done } = await guestOk(ctx, moduleCommitScript(), { input: buildSeedPayload(files), timeoutMs: 5 * MIN });
    const c = parseModuleCommit(r?.stdout);
    if (!done || !c.head || !c.pushed) return fail(`the platform commit or its push failed: ${tail(r, 400)}`);
    if (c.head !== ctx.data.pre_commit) ctx.save({ adopt_commit: c.head });
    const head = await ctx.d.repoHead(ctx.project);
    if (head !== c.head) return fail(`the project repository's main is ${head ? head.slice(0, 12) : 'unreadable'}, not the platform commit ${c.head.slice(0, 12)}`);
    return ok(`${c.made ? 'Committed' : 'Already committed'} foundation/ (${files.length - 1} files) and package.json as ${c.head.slice(0, 12)} and pushed it to the project repository.`);
  },

  async deploy(ctx) {
    const project = adoptStore.getAdoptProject(ctx.pid);
    const r = await ctx.d.deploy(project);
    if (!r?.ok) return fail(`the deploy failed at "${r?.step || 'unknown'}": ${redactSecrets(String(r?.error || 'unknown error')).slice(0, 500)}`);
    if (r.skipped) return fail('the deploy found no run contract in mock2.yaml, so nothing was started', { retryable: false });
    try { await ctx.d.stampDeployedCommit(project); } catch { /* advisory */ }
    const h = await ctx.d.foundationCli(ctx.container, ['health', '--json'], { appDir: APP_DIR, timeoutMs: 2 * MIN });
    const rows = parseHealthOutput(h?.stdout);
    const status = (c) => rows.find((x) => x.component === c)?.status || 'unknown';
    if (status('database') !== 'ready') return fail(`the app was deployed, but its foundation reports the database ${status('database')}`);
    const serving = await ctx.d.probeServing(project);
    if (!serving?.serving) return fail(`the app was deployed but does not serve (${serving?.reason || 'no answer'})`);
    return ok(`Deployed as a foundation deployment; the app serves; foundation health: database ready, storage ${status('storage')}, embeddings ${status('embeddings')}.`);
  },

  async done(ctx) {
    const token = adoptStore.getAdoption(ctx.id)?.lock_token;
    if (token) settleCheckoutOperationLease(ctx.pid, token);
    const d = ctx.reload();
    return ok(`The checkout lock is released. Kept for the rollback: snapshot ${d.snapshot?.name || 'none'}, the native PostgreSQL data directory and the dump ${d.dump?.path || ''}.`.replace(/ \.$/, '.'));
  },
};

const driving = (id, driver, state) => {
  const row = adoptStore.getAdoption(id);
  return row && row.state === state && adoptStore.adoptionData(row).driver === driver ? row : null;
};

async function drive(id, driver) {
  const d = await deps();
  for (const name of STEP_NAMES) {
    const row = driving(id, driver, 'running');
    if (!row) return;
    const step = adoptStore.readSteps(row).find((s) => s.name === name);
    if (step.state === 'done' || step.state === 'skipped') continue;
    const pid = Number(row.project_id);
    const project = adoptStore.getAdoptProject(pid);
    const stop = (error, retryable = true) => {
      adoptStore.updateStep(id, name, { state: 'failed', detail: error });
      adoptStore.updateAdoption(id, { state: 'failed', step: name, error: `${name}: ${error}`, resumable: retryable && stepRetry(name) !== 'never', finished: true });
      say(`${id} failed at ${name}`);
      d.notify?.(pid, `The foundation adoption stopped at "${name}": ${error} ${retryable ? 'Resume it when the cause is fixed, or roll it back.' : 'Roll it back (Dev Studio → project → Foundation).'}`);
    };
    if (!project) return stop('the project no longer exists', false);
    if (name !== 'done' && (project.lifecycle !== 'active' || !project.container_name)) return stop(`the project is ${project.lifecycle}; wake it, then resume`);
    let lockRow = null;
    try { lockRow = getLock(pid); } catch { lockRow = null; }
    if (!row.lock_token || lockRow?.holder_operation_id !== row.lock_token) return stop('the project\'s checkout lock is no longer held by this adoption; resume to take it again');
    adoptStore.updateAdoption(id, { step: name });
    adoptStore.updateStep(id, name, { state: 'running', detail: null });
    adoptStore.touchProjectActivity(pid);
    const ctx = {
      id, d, pid, project, container: project.container_name,
      data: adoptStore.adoptionData(row),
      reload() { this.data = adoptStore.adoptionData(adoptStore.getAdoption(id)); return this.data; },
      save(patch) { adoptStore.updateAdoption(id, { data: patch }); this.data = { ...this.data, ...patch }; },
      detail: (text) => { try { adoptStore.updateStep(id, name, { detail: text }); } catch { /* progress only */ } },
    };
    let result;
    try { result = await STEP_IMPL[name](ctx); } catch (e) { result = fail(redactSecrets(e?.message || String(e)).slice(0, 400)); }
    if (!driving(id, driver, 'running')) return;
    if (!result?.ok) return stop(result?.error || 'failed', result?.retryable !== false);
    adoptStore.updateStep(id, name, { state: 'done', detail: result.detail || null });
  }
  const row = driving(id, driver, 'running');
  if (!row) return;
  adoptStore.updateAdoption(id, { state: 'succeeded', step: 'done', error: null, resumable: false, finished: true });
  say(`${id} succeeded for project ${row.project_id}`);
  d.notify?.(Number(row.project_id), 'The project now runs on the application foundation (PostgreSQL + pgvector, storage, embeddings in its own stack). The rollback snapshot, the old database\'s data directory and the dump are kept; the rollback stays available until you remove them.');
}

// ---- lease for resume / rollback ---------------------------------------------

function holdLease(row) {
  const pid = Number(row.project_id);
  let lockRow = null;
  try { lockRow = getLock(pid); } catch { lockRow = null; }
  if (row.lock_token && lockRow?.holder_operation_id === row.lock_token) {
    adoptStore.reactivateLease(pid, row.lock_token);
    return { ok: true, token: row.lock_token, fresh: false };
  }
  const lease = acquireCheckoutOperationLease(pid, LEASE_KIND);
  if (!lease.ok) return { ok: false, reason: lease.reason || 'held by another writer' };
  return { ok: true, token: lease.token, fresh: true };
}

function online(project) {
  return project && project.lifecycle === 'active' && project.container_name;
}

// ---- resume ----------------------------------------------------------------------

export async function resumeAdoption(projectId, { userId = null } = {}) {
  void userId;
  return exclusive(projectId, async () => {
    const project = adoptStore.getAdoptProject(projectId);
    if (!project) return adoptRefusal(ADOPT_CODES.PROJECT_NOT_FOUND, 'Project not found', { status: 404 });
    const row = adoptStore.latestAdoption(projectId);
    if (!row) return adoptRefusal(ADOPT_CODES.NO_ADOPTION, 'This project has no adoption to resume.', { status: 404 });
    if (running.has(row.id) || row.state === 'running' || row.state === 'rolling_back') return adoptRefusal(ADOPT_CODES.ADOPTION_RUNNING, 'The adoption is still running.');
    if (!resumeAvailable(row)) {
      return adoptRefusal(ADOPT_CODES.NOT_RESUMABLE, row.state === 'failed'
        ? `The step "${row.step}" cannot simply be run again (${row.error || 'its result would not change'}). Roll the adoption back instead.`
        : `The adoption is ${row.state}; there is nothing to resume.`, { options: row.state === 'failed' ? [{ action: 'rollback' }] : [] });
    }
    if (!online(project)) return adoptRefusal(ADOPT_CODES.NOT_ONLINE, `The project is ${project.lifecycle}. Wake it first, then resume.`, { options: [{ action: 'wake' }] });
    const lease = holdLease(row);
    if (!lease.ok) return adoptRefusal(ADOPT_CODES.CHECKOUT_LOCK_HELD, `The project's checkout lock could not be taken: ${lease.reason}. Wait for it to be free, then resume.`);
    adoptStore.updateStep(row.id, row.step, { state: 'pending', detail: null });
    adoptStore.updateAdoption(row.id, { state: 'running', error: null, resumable: false, lockToken: lease.token, finished: false });
    say(`${row.id} resumed at ${row.step}`);
    launch(row.id, drive);
    return { ok: true, status: 202, adoption: view(row.id) };
  });
}

// ---- rollback ----------------------------------------------------------------------

export async function rollbackAdoption(projectId, { userId = null } = {}) {
  void userId;
  return exclusive(projectId, async () => {
    const d = await deps();
    const project = adoptStore.getAdoptProject(projectId);
    if (!project) return adoptRefusal(ADOPT_CODES.PROJECT_NOT_FOUND, 'Project not found', { status: 404 });
    const row = adoptStore.latestAdoption(projectId);
    if (!row) return adoptRefusal(ADOPT_CODES.NO_ADOPTION, 'This project has no adoption to roll back.', { status: 404 });
    if (running.has(row.id) || row.state === 'running' || row.state === 'rolling_back') return adoptRefusal(ADOPT_CODES.ADOPTION_RUNNING, 'The adoption is still running; wait for it to stop.');
    if (row.state !== 'failed' && row.state !== 'succeeded') return adoptRefusal(ADOPT_CODES.NOT_ROLLBACKABLE, `The adoption is ${row.state}; there is nothing to roll back.`);
    const data = adoptStore.adoptionData(row);
    if (data.snapshot && !online(project)) return adoptRefusal(ADOPT_CODES.NOT_ONLINE, `The project is ${project.lifecycle}. Wake it first, then roll back.`, { options: [{ action: 'wake' }] });
    const lease = holdLease(row);
    if (!lease.ok) return adoptRefusal(ADOPT_CODES.CHECKOUT_LOCK_HELD, `The project's checkout lock could not be taken: ${lease.reason}. Wait for it to be free, then roll back.`);
    const release = () => { if (lease.fresh) settleCheckoutOperationLease(Number(projectId), lease.token); };
    if (data.adopt_commit) {
      const head = await d.repoHead(project);
      if (head && head !== data.adopt_commit && head !== data.pre_remote) {
        release();
        return adoptRefusal(ADOPT_CODES.ROLLBACK_REPO_MOVED, 'The project repository has new commits since the adoption (later builds). A rollback would discard them, so it is not available any more.');
      }
    }
    if (data.snapshot) {
      const inst = await readInstance(d, project.container_name);
      if (!inst) { release(); return adoptRefusal(ADOPT_CODES.NOT_ONLINE, `Incus could not report the guest ${project.container_name}; nothing was changed.`); }
      if (!inst.snapshots.some((s) => s.name === data.snapshot.name)) {
        release();
        return adoptRefusal(ADOPT_CODES.SNAPSHOT_MISSING, `The rollback snapshot ${data.snapshot.name} is no longer on the guest (was it removed?). Nothing was changed.`);
      }
    }
    adoptStore.updateAdoption(row.id, { state: 'rolling_back', resumable: false, lockToken: lease.token, finished: false, data: { rollback_attempted: true, rollback_from: { state: row.state, step: row.step } } });
    say(`${row.id} rolling back (from ${row.state} at ${row.step})`);
    launch(row.id, driveRollback);
    return { ok: true, status: 202, adoption: view(row.id) };
  });
}

async function driveRollback(id, driver) {
  const d = await deps();
  const row = driving(id, driver, 'rolling_back');
  if (!row) return;
  const pid = Number(row.project_id);
  const project = adoptStore.getAdoptProject(pid);
  const data = adoptStore.adoptionData(row);
  const failRollback = (error) => {
    if (!driving(id, driver, 'rolling_back')) return;
    adoptStore.updateAdoption(id, { state: 'failed', error: `Rollback failed: ${error} Run the rollback again.`, resumable: false, finished: true });
    say(`${id} rollback failed`);
    d.notify?.(pid, `The foundation adoption's rollback failed: ${error} Run the rollback again.`);
  };
  const host = d.host;
  const container = project?.container_name;
  try {
    if (data.snapshot) {
      const instOf = () => readInstance(d, container);
      let inst = await instOf();
      if (!inst) return failRollback(`Incus could not report the guest ${container}.`);
      const pre = preRollbackSnapshotNameFor(id);
      if (!inst.snapshots.some((s) => s.name === pre)) {
        const c = await createSnapshotWithFallback(host, container, pre, { deferRetention: true });
        if (!c.ok) return failRollback(`the pre-rollback snapshot ${pre} could not be taken (${redactSecrets(c.error || '').slice(0, 200)}); nothing was restored.`);
        adoptStore.updateAdoption(id, { data: { pre_rollback_snapshot: pre } });
      }
      const r = await host(['incus', ...snapshotArgv('restore', container, data.snapshot.name)], { timeoutMs: 10 * MIN });
      if (r.code !== 0) return failRollback(`incus snapshot restore ${data.snapshot.name} failed: ${tail(r, 300)} (the pre-rollback snapshot ${pre} exists).`);
      inst = await instOf();
      if (!inst) return failRollback('the guest is not reported after the restore.');
      const restore = configRestore(data.original_config || {}, inst.config);
      if (restore.set.length || restore.unset.length) {
        if (String(inst.status || '').toLowerCase() === 'running') {
          const s = await host(['incus', 'stop', container], { timeoutMs: 5 * MIN });
          if (s.code !== 0) return failRollback(`stopping the guest to put its settings back failed: ${tail(s, 200)}`);
        }
        if (restore.set.length) {
          const s = await host(['incus', 'config', 'set', container, ...restore.set.map((c) => `${c.key}=${c.value}`)], { timeoutMs: MIN });
          if (s.code !== 0) return failRollback(`putting the guest's settings back failed: ${tail(s, 200)}`);
        }
        for (const k of restore.unset) {
          const s = await host(['incus', 'config', 'unset', container, k], { timeoutMs: MIN });
          if (s.code !== 0) return failRollback(`unsetting ${k} failed: ${tail(s, 200)}`);
        }
        inst = await instOf();
      }
      if (String(inst?.status || '').toLowerCase() !== 'running') {
        const s = await host(['incus', 'start', container], { timeoutMs: 5 * MIN });
        if (s.code !== 0) return failRollback(`starting the guest after the restore failed: ${tail(s, 200)}`);
      }
      const up = await d.afterGuestRestart(project);
      if (!up?.ok) return failRollback(up?.error || 'the guest did not come back after the restore.');
    }
    if (data.adopt_commit && data.pre_remote) {
      const head = await d.repoHead(project);
      if (head === data.adopt_commit) {
        const r = await d.repoReset(project, { from: data.adopt_commit, to: data.pre_remote });
        if (r?.code !== 0) return failRollback(`resetting the project repository to ${data.pre_remote.slice(0, 12)} failed: ${tail(r, 200)}`);
        if ((await d.repoHead(project)) !== data.pre_remote) return failRollback('the project repository did not move back to the commit before the adoption.');
      } else if (head && head !== data.pre_remote) {
        return failRollback('the project repository has new commits since the adoption; it was not reset.');
      }
    }
    if (!driving(id, driver, 'rolling_back')) return;
    adoptStore.setFoundationVersion(pid, null);
    const cleared = adoptStore.clearFoundationRows(pid);
    const tokenRow = adoptStore.getAdoption(id);
    if (tokenRow?.lock_token) settleCheckoutOperationLease(pid, tokenRow.lock_token);
    adoptStore.updateAdoption(id, { state: 'rolled_back', error: null, resumable: false, finished: true, data: { rolled_back: { foundation_rows_removed: cleared } } });
    repoHeadCache.delete(pid);
    say(`${id} rolled back for project ${pid}`);
    d.notify?.(pid, `The foundation adoption was rolled back: the guest is back at ${data.snapshot ? `snapshot ${data.snapshot.name}` : 'its state before the run'} with its native PostgreSQL${data.snapshot ? `; everything written after the snapshot is kept in ${preRollbackSnapshotNameFor(id)}` : ''}.`);
  } catch (e) {
    failRollback(redactSecrets(e?.message || String(e)).slice(0, 300));
  }
}

// ---- read ------------------------------------------------------------------------

async function repoMovedFor(row, project) {
  const data = adoptStore.adoptionData(row);
  if (row.state !== 'succeeded' || !data.adopt_commit) return false;
  const pid = Number(project.id);
  const cached = repoHeadCache.get(pid);
  let head;
  if (cached && Date.now() - cached.at < 15_000) head = cached.head;
  else {
    try { head = await (await deps()).repoHead(project); } catch { head = null; }
    repoHeadCache.set(pid, { at: Date.now(), head });
  }
  return !!head && head !== data.adopt_commit && head !== data.pre_remote;
}

export async function getAdoption(projectId) {
  const project = adoptStore.getAdoptProject(projectId);
  if (!project) return adoptRefusal(ADOPT_CODES.PROJECT_NOT_FOUND, 'Project not found', { status: 404 });
  const row = adoptStore.latestAdoption(projectId);
  if (!row) return { ok: true, adoption: null };
  const repoMoved = await repoMovedFor(row, project);
  return { ok: true, adoption: projectAdoption(row, { running: running.has(row.id), repoMoved }) };
}

// ---- boot --------------------------------------------------------------------------

// sweepAdoptionsOnBoot() — a run or rollback that was in flight when the
// backend stopped is recorded as failed, with its step and the reason. A run
// resumes at that step (every step is idempotent or re-checks itself); an
// interrupted rollback is simply run again. Never throws.
export function sweepAdoptionsOnBoot() {
  let n = 0;
  try {
    for (const row of adoptStore.listAdoptionsInState(['running', 'rolling_back'])) {
      if (running.has(row.id)) continue;
      if (row.state === 'running') {
        const step = row.step || STEP_NAMES[0];
        adoptStore.updateStep(row.id, step, { state: 'failed', detail: 'Interrupted by a backend restart.' });
        adoptStore.updateAdoption(row.id, { state: 'failed', step, error: `${step}: interrupted by a backend restart. Resume retries this step; or roll the adoption back.`, resumable: stepRetry(step) !== 'never', finished: true });
      } else {
        adoptStore.updateAdoption(row.id, { state: 'failed', error: 'Rollback failed: interrupted by a backend restart. Run the rollback again.', resumable: false, finished: true });
      }
      n += 1;
    }
  } catch (e) {
    console.error('[mock2] foundation adoption boot sweep failed:', e?.message || e);
  }
  if (n) say(`boot sweep recorded ${n} interrupted adoption(s) as failed`);
  return n;
}

export { ADOPT_STEPS };
