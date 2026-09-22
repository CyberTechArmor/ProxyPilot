// Mock2 deploy step (Run phase) — the host/exec half. After a build cycle's
// gates pass (or on rehydrate of an already-built project), this runs INSIDE the
// fenced container, through host.js (R3 — never a raw exec): install deps →
// migrate against the in-container Postgres (ADR-008) → build → rewrite the
// mock2-dev.service ExecStart to the manifest `start` command → daemon-reload +
// restart → verify the app is actually serving. "Succeeded" means "running": a
// failure at any step is returned as a distinct, actionable result (deploy-logic
// deployFailureMessage), never a silent success.
//
// The DECISIONS (run-contract parse, unit string, step plan) are the pure
// deploy-logic.js; this module is the exec orchestration. It is always called by
// a holder of the checkout lock (ADR-004 — the runner cycle, or the rehydrate
// job that owns the container), so it does not take the lock itself.
//
// The install/migrate/build commands reach the internet over the bridge's Incus
// NAT (squid was removed). We still source /etc/environment so any operator-set
// env is honored, but there is no proxy to configure; if the registry is
// unreachable the deploy fails loudly.
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'node:crypto';
import { sh, b64, runHost } from './host.js';
import { scaffoldPwaFiles } from './scaffold.js';
import {
  parseRunContract, deployStepLabel,
  newBuildId, sanitizeBuildId, buildIdStampScript, buildStampReportScript, interpretBuildStamp,
  LEGACY_SW_JS, BUILD_ID_PLACEHOLDER,
} from './deploy-logic.js';
import { parseDeclaredEgress } from './egress-logic.js';
import { containerLockStore } from './container-lock.js';
import { submitDeployJob, waitForJob, deployResultFromJob, executionMode, drainRunnerJobsInProcess } from '../lib/setup-engine/backend.js';
// The declared default port; a project row normally carries its own.
import { DEFAULT_WEB_PORT } from './template.js';
import { updateProject } from './projects.js';
import { installBrowserScript } from './scaffold-e2e.js';


// Run a script inside the container (base64-streamed to `incus exec -- sh`, so
// no quoting hazard). Always resolves { code, stdout, stderr }.
function containerSh(containerName, script, { timeoutMs = 120000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

// Every deploy-step script carries this marker in its command line (a no-op
// shell comment), so a NEW deploy can reap scripts a DEAD writer left running
// in the container (deploy-op.js reaps and verifies before it starts).
const DEPLOY_MARKER = 'mock2_deploy_marker';

// Run a deploy command in the app dir. Sources /etc/environment (so any
// operator-set env is present) then runs the command; egress is the bridge NAT.
// `set -a` makes the `KEY=VALUE` lines exported.
function runInApp(containerName, appDir, command, timeoutMs) {
  const script = `: ${DEPLOY_MARKER}\nset -a\n. /etc/environment 2>/dev/null || true\nset +a\ncd '${appDir}' || exit 97\n${command}\n`;
  return containerSh(containerName, script, { timeoutMs });
}

function tail(r) {
  return `${r?.stdout || ''}${r?.stderr ? `\n${r.stderr}` : ''}`.trim().slice(-800);
}

// readRunContract(containerName, appDir) → parse the deployed app's mock2.yaml
// run contract from the working tree (declared, not discovered — ADR-005).
export async function readRunContract(containerName, appDir = '/srv/app') {
  const r = await containerSh(containerName, `cat '${appDir}/mock2.yaml' 2>/dev/null`);
  return parseRunContract(r.stdout || '');
}

// readDeclaredEgress(containerName, appDir) → the parsed `egress:` list the app
// declares in mock2.yaml (declared, never discovered — extends ADR-005). The caller syncs
// it into the grant store (egress-grants.syncDeclaredEgress) so each new
// declaration becomes a pending admin-queue item and a removed one is revoked.
export async function readDeclaredEgress(containerName, appDir = '/srv/app') {
  const r = await containerSh(containerName, `cat '${appDir}/mock2.yaml' 2>/dev/null`);
  return parseDeclaredEgress(r.stdout || '');
}

// All deploy entry points — the build cycle's deploy stage, "Retry deploy",
// the base-app deploy, the rehydrate restore — can fire independently, and two
// deploys interleaving on ONE container stomp the same unit and web port: each
// runs freeWebPortScript then `systemctl start`, so one instance binds and the
// other crash-loops on EADDRINUSE until the health window closes. The
// per-container lock (container-lock.js) serializes them, and it is the SAME
// lock the database and snapshot restores take, so a restore cannot rewrite
// the database between the deploy's probe and its start. A queued deploy
// simply runs after the current one finishes (idempotent — it redeploys the
// same checkout). The lock is held for the deploy's whole lifetime.

// deployProject({ containerName, appDir, webPort, runContract, onStep }) →
// { ok, step, error }. Runs the ordered plan, then swaps the unit and restarts,
// then health-checks the web port. onStep(key, label) reports progress (wired to
// setJob so the CycleCard shows "Installing dependencies…" etc.).
// deployProject(args) → { ok, step, error, skipped, buildStamp, verification, jobId }.
//
// Gate two: the deploy is a persisted job executed by ONE operation
// (lib/setup-engine/deploy-op.js) through ONE executor (lib/setup-engine/
// executor.js). Who runs the executor is the INSTALLATION'S policy
// (SETUP_EXECUTOR_POLICY, logic.js executorPolicy), never a request parameter:
//
//   * a live host runner (proxypilot-setup-runner.service, heartbeat in
//     setup_runners) → the job is submitted and this call WAITS for it,
//     replaying the runner's step events to onStep. The browser, this API
//     process and this promise can all go away; the runner finishes the job
//     and queues the application-owned credential check as a durable
//     follow-up before it reports done.
//   * no live runner, policy `backend-allowed` (the legacy / development
//     executor) → this process claims and executes the queued job — the
//     same executor, the same record, the same lease — and drains the
//     follow-up verification too.
//   * no live runner, policy `runner-required` → the job stays QUEUED for the
//     runner and the caller is told the runner is unavailable. Nothing runs
//     in this process.
//
// Everything the operation needs about the project is resolved HERE into
// references (the run contract from args or the guest's manifest, the
// installed components' secret contracts and data guards from mock2.db, the
// port, the app dir, the previously deployed commit) — never a secret value.
// `detach: true` submits and returns the job id without waiting.
export async function deployProject(args) {
  const containerName = String(args?.containerName || '');
  const params = await resolveDeployParams({ ...args, containerName });
  const store = containerLockStore();
  const requestedBy = args?.requestedBy || null;
  const via = args?.via || 'system';
  const onStep = typeof args?.onStep === 'function' ? args.onStep : null;
  if (!store) {
    // No engine store (a test importing this module without configuring one):
    // nothing can be recorded, so nothing runs.
    return { ok: false, step: 'submit', error: 'the setup engine store is not configured; a deploy cannot be recorded, so it is not run' };
  }
  const db = store.getDb();
  const sub = submitDeployJob(db, { app: containerName, params, requestedBy, via });
  if (sub.error) return { ok: false, step: 'submit', error: sub.error };
  const jobId = sub.job.id;
  const mode = executionMode(db, { env: store.env || process.env });

  if (mode.executor === 'none') {
    const msg = `no host runner is live (policy ${mode.policy.mode}); deploy job ${jobId} is queued and will run when proxypilot-setup-runner.service is back — see /api/setup/jobs/${jobId}`;
    return { ok: false, step: 'runner_unavailable', error: msg, jobId, queued: true, created: sub.created, policy: mode.policy.mode };
  }
  if (args?.detach) return { ok: true, submitted: true, jobId, created: sub.created, runner: mode.runner?.owner || null, executor: mode.executor, policy: mode.policy.mode };

  if (mode.executor === 'backend') {
    // Legacy / development: execute here. The drain claims THIS job (and any
    // other queued runner job — the backend is the executor on this host),
    // then the follow-up verification it queued.
    const deps = inProcessExecutorDeps(store);
    await drainRunnerJobsInProcess(db, { ...deps, env: store.env || process.env, max: 3 });
    await drainRunnerJobsInProcess(db, { ...deps, env: store.env || process.env, max: 3, kinds: ['verify_app'] });
  }
  const row = await waitForJob(db, jobId, {
    onEvent: (e) => { if (e.kind === 'step' && onStep) onStep(e.phase || 'deploy', e.message || deployStepLabel(e.phase)); },
    timeoutMs: mode.executor === 'backend' ? 5_000 : 45 * 60 * 1000,
  });
  if (!row) return { ok: false, step: 'wait', error: `deploy job ${jobId} did not finish in time; it may still be running — see /api/setup/jobs/${jobId}`, jobId };
  return deployResultFromJob(row);
}

// inProcessExecutorDeps(store) → { exec, reviewLogin, owner } for the legacy
// executor: the nsenter guest pivot and the registry's review login (the
// same modules the backend's readiness probe uses). index.js configures the
// store with overrides for tests.
export function inProcessExecutorDeps(store = containerLockStore()) {
  return {
    owner: store?.owner,
    // The init-script input store next to the database (setup-inputs.js).
    inputsDir: store?.inputsDir || null,
    // The reserved-ports drop-in a forward job refreshes (tests point it at a temp file).
    reservedPortsPath: store?.reservedPortsPath || null,
    exec: store?.guestExec || {
      guest: (name, script, { timeoutMs } = {}) => containerSh(name, script, { timeoutMs }),
      // Host commands as argv arrays (a snapshot restore); through the same
      // pivot every host command of this process takes, never a shell string.
      host: store?.hostExec || (async (argv, { timeoutMs } = {}) => runHost(argv[0], argv.slice(1), { timeoutMs })),
    },
    reviewLogin: store?.reviewLogin || (async (container) => {
      try {
        const [{ getProjectByContainerName }, { getReviewLogin }] = await Promise.all([import('./projects.js'), import('./review-account.js')]);
        const project = getProjectByContainerName(container);
        return project ? getReviewLogin(project.id) : null;
      } catch { return null; }
    }),
  };
}

// drainInProcessNow(store) — the boot / interval drain for the legacy
// executor (index.js): queued runner jobs (a detached deploy, a reconcile's
// recovery, a pending verification) run here when no runner is live and the
// policy allows it; otherwise nothing.
export async function drainInProcessNow(store = containerLockStore(), { max = 3 } = {}) {
  if (!store) return { skipped: 'no_store', ran: [] };
  const deps = inProcessExecutorDeps(store);
  return drainRunnerJobsInProcess(store.getDb(), { ...deps, env: store.env || process.env, max });
}

// resolveDeployParams(args) → the operation's REFERENCES. The components'
// secret contracts come from mock2.db (dynamic import: this module stays
// importable without it); a project the registry does not know gets no
// secret configuration and no guard — the deploy then mints nothing.
// `guard` and `secretConfigs` may be supplied by a SERVER caller that already
// resolved them (provision, tests); a registry lookup fills them otherwise.
// They are references (table and column names, key names), never values.
export async function resolveDeployParams({ containerName, appDir = '/srv/app', webPort = DEFAULT_WEB_PORT, runContract = null, newlyProvisioned = false, guard = null, secretConfigs = null } = {}) {
  const params = {
    container: String(containerName || ''), appDir: String(appDir || '/srv/app'), webPort: Number(webPort) || DEFAULT_WEB_PORT,
    environmentFile: '/etc/environment',
    contract: runContract && runContract.hasContract ? pickContract(runContract) : null,
    secrets: { configs: Array.isArray(secretConfigs) ? secretConfigs.map(secretConfigRef) : [], newlyProvisioned: newlyProvisioned === true },
    guard: guard || null,
  };
  try {
    const [{ getProjectByContainerName }, { listProjectComponents }, { parseContractJson, secretDataGuards }] = await Promise.all([
      import('./projects.js'), import('./components.js'), import('./component-logic.js'),
    ]);
    const project = getProjectByContainerName(containerName);
    if (project) {
      params.projectId = project.id;
      params.previousDeployedCommit = project.deployed_commit || null;
      if (!webPort && project.web_port) params.webPort = Number(project.web_port) || params.webPort;
      for (const row of listProjectComponents(project.id)) {
        if (row?.status !== 'installed') continue;
        const contract = parseContractJson(row.contract_json);
        for (const c of contract?.config || []) {
          if (c && c.secret === true && c.generate === true) params.secrets.configs.push(secretConfigRef(c));
        }
      }
      const guards = secretDataGuards(params.secrets.configs);
      if (!params.guard && guards[0]?.guard) params.guard = guards[0].guard;
      if (guards[0]?.key) params.guardKey = guards[0].key;
    }
  } catch { /* no mock2 registry here: nothing to mint, nothing to guard */ }
  return params;
}

function pickContract(c) {
  const out = { hasContract: true };
  for (const k of ['runtime', 'install', 'migrate', 'build', 'start']) if (c[k]) out[k] = String(c[k]);
  return out;
}

// The parts of a contract.config entry the mint needs: key, the marker and the
// data guard. Never a default or a value.
function secretConfigRef(c) {
  const out = { key: String(c.key), secret: true, generate: true };
  if (c.requires_marker) out.requires_marker = { path: c.requires_marker.path, contains: c.requires_marker.contains, built: c.requires_marker.built || null };
  if (c.protects) out.protects = { ...c.protects };
  return out;
}

// The application-owned credential check lives in the executor (verify_app
// with verify_credential_use); its interpreter is re-exported for callers.
export { interpretCredentialUse } from '../lib/setup-engine/guest-probes.js';

// Record the commit the app is now SERVING (best-effort). Every successful
// deploy path calls this; the runner's verified-no-op deploy skip compares it
// to HEAD so committed-but-undeployed work always deploys.
// stampBuildId — write this deploy's build id into the PWA plumbing (sw.js,
// build-id.js, build-id.txt) inside the container. The script itself is pure
// (deploy-logic.buildIdStampScript) so its idempotency is unit-tested.
export async function stampBuildId(containerName, appDir = '/srv/app', buildId = newBuildId()) {
  const id = sanitizeBuildId(buildId);
  const r = await containerSh(containerName, buildIdStampScript(appDir, id), { timeoutMs: 20000 });
  return { ok: /MOCK2_BUILD_ID:/.test(r.stdout || ''), buildId: id };
}

// retrofitPwaBuildPlumbing — bring a project built BEFORE this instrumentation
// up to date, on its next deploy, without ever clobbering a customization.
//
// Two rules, matching the auth wiring's keep-existing semantics:
//   * build-id.js / build-id.txt are ADDITIVE — written only when absent.
//   * public/sw.js is replaced ONLY when it is byte-identical to the known
//     legacy worker (the hardcoded-cache version that can never update). A
//     worker a build has customized is left alone; verifyBuildStamp then
//     reports the residual stale risk rather than silently overwriting work.
export async function retrofitPwaBuildPlumbing(containerName, appDir = '/srv/app') {
  const legacyHash = createHash('sha256').update(LEGACY_SW_JS, 'utf8').digest('hex');
  const { swJs: CURRENT_SW_JS, buildIdJs: BUILD_ID_JS } = scaffoldPwaFiles();
  const script = `cd '${appDir}' 2>/dev/null || exit 0
[ -d public ] || exit 0
[ -f public/build-id.js ] || printf '%s' '${b64(BUILD_ID_JS)}' | base64 -d > public/build-id.js
[ -f public/build-id.txt ] || printf '%s\n' '${BUILD_ID_PLACEHOLDER}' > public/build-id.txt
if [ -f public/sw.js ]; then
  cur=$(sha256sum public/sw.js 2>/dev/null | cut -d' ' -f1)
  if [ "$cur" = '${legacyHash}' ]; then
    printf '%s' '${b64(CURRENT_SW_JS)}' | base64 -d > public/sw.js
    echo MOCK2_SW_RETROFIT
  fi
fi
echo MOCK2_RETROFIT_DONE`;
  const r = await containerSh(containerName, script, { timeoutMs: 20000 });
  return { ok: /MOCK2_RETROFIT_DONE/.test(r.stdout || ''), swReplaced: /MOCK2_SW_RETROFIT/.test(r.stdout || '') };
}

// verifyBuildStamp — read back the stamped ids and judge whether a deploy can
// actually reach a browser. Never throws and never fails a deploy: it reports,
// so the cycle can surface "clients may be serving a stale cache" instead of
// the operator discovering it three builds later.
export async function verifyBuildStamp(containerName, appDir = '/srv/app') {
  try {
    const r = await containerSh(containerName, buildStampReportScript(appDir), { timeoutMs: 15000 });
    return interpretBuildStamp(r.stdout || '');
  } catch (err) {
    return { ok: true, instrumented: false, stale_risk: false, detail: `build-stamp check skipped: ${err?.message || err}` };
  }
}

export async function stampDeployedCommit(projectId, containerName, appDir) {
  try {
    const r = await containerSh(containerName, `git -C '${appDir}' rev-parse HEAD 2>/dev/null\n`, { timeoutMs: 30000 });
    const sha = String(r.stdout || '').trim().split('\n').pop().trim();
    if (/^[0-9a-f]{40}$/.test(sha)) updateProject(projectId, { deployed_commit: sha });
  } catch { /* the stamp is advisory; a miss only costs one redundant deploy */ }
}

// ---- "is it actually serving?" ----------------------------------------
//
// WHY THIS EXISTS. A build can finish, pass every gate, checkpoint cleanly —
// and leave nothing answering on the project's URL. It happened: the anomaly
// tripwire HELD the deploy of a project's very first build, so the app was
// never started, and the only signal was the design review screenshotting
// ERR_CONNECTION_REFUSED. The operator had to notice and press Deploy.
//
// Nothing in the pipeline asked the simplest possible question afterwards:
// does the URL answer? This asks it, and fixes it when the answer is no.

// installE2eBrowser — the one-time Chromium download for the project's own
// Playwright suite. Idempotent (the script returns immediately when the browser
// cache is populated) and never throws into the deploy.
export async function ensureE2eBrowser(project) {
  const containerName = project?.container_name;
  if (!containerName || project.lifecycle !== 'active') return;
  await installE2eBrowser(containerName, '/srv/app', null);
}

async function installE2eBrowser(containerName, appDir, onStep) {
  const probe = await runInApp(
    containerName, appDir,
    '[ -f playwright.config.ts ] || [ -f playwright.config.js ] || exit 1\n'
    + '[ -n "$(ls -A "$HOME/.cache/ms-playwright" 2>/dev/null)" ] && exit 1\n'
    + 'exit 0',
    20000,
  ).catch(() => ({ code: 1 }));
  // Non-zero means "no suite" or "already installed" — either way, nothing to do.
  if (probe.code !== 0) return;
  if (onStep) onStep('e2e-browser', 'Installing the test browser (one time)…');
  const r = await runInApp(containerName, appDir, installBrowserScript(appDir), 600000).catch(() => null);
  if (!r || r.code !== 0) {
    console.warn(`[mock2] e2e browser install did not complete for ${containerName} — the e2e gate will skip until it does`);
  }
}

// probeServing — one cheap request from INSIDE the container. Same accept rule
// as the deploy health check: anything under 500 means the app is up and its
// own routing is its business; a 5xx or a refused connection is not serving.
export async function probeServing(project, { timeoutMs = 15000 } = {}) {
  const containerName = project?.container_name;
  const port = project?.web_port || DEFAULT_WEB_PORT;
  if (!containerName || project.lifecycle !== 'active') {
    return { serving: false, reason: 'the project is not online' };
  }
  try {
    const r = await containerSh(
      containerName,
      `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}/" 2>/dev/null)\n`
      + `echo "CODE:\${code:-000}"\n`,
      { timeoutMs },
    );
    const code = (String(r.stdout || '').match(/CODE:(\d+)/) || [])[1] || '000';
    const n = Number(code);
    return { serving: n > 0 && n < 500, code: n, reason: n === 0 ? 'connection refused' : `http ${n}` };
  } catch (e) {
    return { serving: false, reason: e?.message || 'probe failed' };
  }
}

// ensureServing — probe, and deploy if the app is not answering.
//
// Idempotent and cheap in the happy path (one curl). Best-effort: it never
// throws into the caller, because the caller is usually a build closing out.
// Returns { serving, redeployed, error }.
export async function ensureServing(project, { reason = 'post-build' } = {}) {
  const first = await probeServing(project);
  if (first.serving) return { serving: true, redeployed: false };

  console.warn(`[mock2] project ${project?.id} is not serving after ${reason} (${first.reason}) — deploying`);
  try {
    const out = await deployProject({
      containerName: project.container_name,
      webPort: project.web_port || DEFAULT_WEB_PORT,
      projectId: project.id,
    });
    if (!out?.ok) return { serving: false, redeployed: true, error: out?.error || `deploy failed at ${out?.step || 'unknown'}` };
    const after = await probeServing(project);
    return { serving: after.serving, redeployed: true, error: after.serving ? null : after.reason };
  } catch (e) {
    return { serving: false, redeployed: false, error: e?.message || 'deploy threw' };
  }
}
