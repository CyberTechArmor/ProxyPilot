// Mock2 project provisioning + lifecycle host jobs (Phase M2 + M3).
//
// Mirrors the LXC create pattern (routes/lxc.js: 202 + in-memory progress map +
// poll endpoint). The route inserts the project row (lifecycle='provisioning'),
// returns 202 immediately, and this module drives the host-side work in the
// background; the frontend polls GET /projects/:id/provision-status until the
// row flips to 'active' or 'failed_provisioning'.
//
// M3 adds three more host jobs that share the SAME progress map + poll
// endpoint: archive (checkpoint → push → destroy → 'archived'), rehydrate
// (rebuild from the bare repo → 'active', same slug) and wake (restart a
// stopped container). The launch→mount→clone→setup→publish sequence is factored
// into bringUpFromRepo() so create and rehydrate never fork it (04-phased-plan
// §M3). Rehydrate depends ONLY on the bare repo (ADR-006) — never a snapshot.
//
// EVERY host mutation pivots through lib/host-exec.js spawnHost (risk R3:
// nsenter when the backend runs inside Docker). New host artifacts — the bare
// repo, the container, the Caddy block — are created only here, only on an
// enabled host (ADR-001).
//
// The bare-repo transport decision (risk R6, recorded as ADR-011 in
// docs/mock2/02-adrs.md): the bare repo at MOCK2_DATA_DIR/repos/<id>.git is
// mounted into the container as an Incus disk device at /srv/repo.git, and the
// container's working clone (/srv/app) uses it as `origin` over that mount — no
// git-over-bridge transport, no host ports. The seed commit is made host-side
// before the container exists, so `git log` in the bare repo proves the seed
// immediately (M2 verification checklist).
//
// Terminology (risk R7): the AI build component is the runner; this file
// provisions a container + repo and is named accordingly. Nothing is "agent."

import { runHost, sh, b64 } from './host.js';
import { updateProject, getProject } from './projects.js';
import { publishDomain } from './publish.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import { buildSeedFiles, buildContainerSetupScript, buildCheckpointScript, parseManifestWebPort, DEFAULT_WEB_PORT } from './template.js';
import {
  bridgeNameForProject,
  bridgeCidrForProject,
  gatewayForCidr,
  createProjectBridge,
  deleteProjectBridge,
  ensureHostEgress,
} from './network.js';
import { reconcileMock2Firewall } from './firewall.js';
import { runPortDriftCheck } from './port-check.js';
import { deployProject } from './deploy.js';
import { parseDeclaredEgress } from './egress-logic.js';
import { syncDeclaredEgress, probeEgressGrants } from './egress-grants.js';
import { projectHasBeenDeployed } from './cycles.js';

export const MOCK2_DATA_DIR = process.env.MOCK2_DATA_DIR || '/var/lib/proxypilot/mock2';
// Base image for project containers. Overridable for hosts that mirror images
// under a different remote; default is the standard Incus images: remote.
const MOCK2_BASE_IMAGE = process.env.MOCK2_BASE_IMAGE || 'images:debian/12';
const APP_DIR = '/srv/app';
const REPO_MOUNT = '/srv/repo.git';

// Live provisioning progress, keyed by project id. The route reads this for the
// poll endpoint; entries are dropped a couple minutes after the job settles.
export const activeProvisions = new Map();

export function getProvisionStatus(projectId) {
  return activeProvisions.get(Number(projectId)) || null;
}

export function repoPathForProject(projectId) {
  return `${MOCK2_DATA_DIR}/repos/${projectId}.git`;
}
export function containerNameForProject(projectId) {
  return `m2-${projectId}`;
}

// runHost/sh/b64 are the shared host-command pivots (mock2/host.js) — imported
// above so provision.js and the M4 network/firewall/egress modules use one
// nsenter-aware runner (risk R3).

// Build the host shell script that creates the bare repo and lands the seed
// commit in it. Files are base64-encoded (shell-safe) and written into a temp
// working tree, committed, and pushed into the bare repo, which is then left as
// the project's permanent origin (ADR-006).
function buildSeedScript({ repoPath, files, projectName }) {
  const writes = files.map((f) => {
    const dir = f.path.includes('/') ? f.path.replace(/\/[^/]*$/, '') : '';
    const mkdir = dir ? `mkdir -p "$WT/${dir}"` : ':';
    const chmod = f.mode ? `chmod ${f.mode.toString(8)} "$WT/${f.path}"` : ':';
    return `${mkdir}\nprintf '%s' '${b64(f.content)}' | base64 -d > "$WT/${f.path}"\n${chmod}`;
  }).join('\n');

  return `set -e
REPO="${repoPath}"
mkdir -p "$(dirname "$REPO")"
# Seed runs only for a BRAND-NEW project (rehydrate clones the existing repo and
# never re-seeds), so any repo already at this path is stale — a crashed prior
# provision, or a reused project id whose predecessor's repo was kept. Start
# clean, otherwise the seed 'git push main:main' is rejected as a non-fast-
# forward against the old history ("[rejected] main -> main (fetch first)").
rm -rf "$REPO"
git init --bare -b main "$REPO"
WT="$(mktemp -d)"
git init -q -b main "$WT"
${writes}
git -C "$WT" add -A
GIT_AUTHOR_NAME="ProxyPilot Mock2" GIT_AUTHOR_EMAIL="mock2@proxypilot.local" \
GIT_COMMITTER_NAME="ProxyPilot Mock2" GIT_COMMITTER_EMAIL="mock2@proxypilot.local" \
  git -C "$WT" commit -q -m "seed: ${projectName.replace(/["'`$\\]/g, '')} placeholder (Mock2 M2 template)"
git -C "$WT" push -q "$REPO" main:main
rm -rf "$WT"
echo "[mock2] seeded bare repo $REPO"
`;
}

function setStatus(projectId, patch) {
  const id = Number(projectId);
  const cur = activeProvisions.get(id) || {};
  // Accumulate a step log so the UI can show what actually happened (and the
  // failing step's error), not just the latest one-line message. Append on each
  // distinct message; cap the length so a stuck loop can't grow it unbounded.
  const log = Array.isArray(cur.log) ? cur.log : [];
  if (patch.message && patch.message !== cur.message) {
    log.push({ t: Date.now(), phase: patch.phase || cur.phase || '', message: patch.message });
    if (log.length > 100) log.splice(0, log.length - 100);
  }
  activeProvisions.set(id, { ...cur, ...patch, log, updatedAt: Date.now() });
}

// startProvision(project) — kick off the background job. Returns immediately;
// progress is on activeProvisions and the terminal state on the project row.
export function startProvision(project) {
  const projectId = Number(project.id);
  const repoPath = project.repo_path || repoPathForProject(projectId);
  const containerName = project.container_name || containerNameForProject(projectId);
  setStatus(projectId, { phase: 'starting', message: 'Starting provisioning…', startedAt: Date.now(), error: null });

  // Fire-and-forget; the function owns its own error handling and always lands
  // the row in a terminal lifecycle.
  provisionProject(project, { repoPath, containerName }).catch((err) => {
    console.error(`[mock2] provisioning crashed for project ${projectId}:`, err?.message || err);
    fail(project, `provisioning crashed: ${err?.message || err}`);
  });
  return true;
}

// Land the project in a terminal failure state. `lifecycle` is the state to
// mark: 'failed_provisioning' for a create (M2), but 'archived' for a failed
// REHYDRATE so the project falls back to its safe archived state and can be
// retried (its bare repo is untouched — ADR-006).
function fail(project, reason, { lifecycle = 'failed_provisioning' } = {}) {
  const projectId = Number(project.id);
  setStatus(projectId, { phase: 'failed', message: reason, error: reason });
  try {
    updateProject(projectId, { lifecycle, provision_error: reason });
  } catch (e) { console.error('[mock2] failed to mark provision failure:', e?.message); }
  try {
    raiseQueueItem({
      kind: 'provisioning_failed',
      project_id: projectId,
      dedupe_key: `mock2-provision:${projectId}`,
      ref_table: 'mock2_projects',
      ref_id: projectId,
      detail: `${project.name}: ${reason}`,
    });
  } catch (e) { console.error('[mock2] raiseQueueItem failed:', e?.message); }
  // Best-effort teardown of a partial container so a retry starts clean.
  const containerName = project.container_name || containerNameForProject(projectId);
  sh(`incus delete ${containerName} --force 2>/dev/null || true`).catch(() => {});
  scheduleCleanup(projectId);
}

function scheduleCleanup(projectId) {
  setTimeout(() => activeProvisions.delete(Number(projectId)), 120000);
}

// Create-only step 1: seed the bare repo host-side (ADR-006/011). Runs before
// any container exists, so `git log` in the bare repo proves the seed
// immediately. Then hands off to the shared bringUpFromRepo sequence.
async function provisionProject(project, { repoPath, containerName }) {
  const projectId = Number(project.id);
  setStatus(projectId, { phase: 'repo', message: 'Creating bare repo and seeding template…' });
  const seedFiles = buildSeedFiles(project, { webPort: DEFAULT_WEB_PORT });
  const seed = await sh(buildSeedScript({ repoPath, files: seedFiles, projectName: project.name }), { timeoutMs: 60000 });
  if (seed.code !== 0) return fail(project, `bare repo seed failed: ${(seed.stderr || seed.stdout || '').trim().slice(-500)}`);
  return bringUpFromRepo(project, { repoPath, containerName, mode: 'provision' });
}

// bringUpFromRepo — the SHARED launch→mount→clone→setup→publish sequence used
// by BOTH create (after the seed) and rehydrate (the bare repo already holds
// the archived state). Rehydrate re-adds the ADR-011 disk-device mount and
// re-clones from the bare repo — never a snapshot (ADR-006), which is why the
// M3 verify test can delete the image cache between archive and rehydrate and
// still succeed. Each step updates the progress map; any hard failure calls
// fail() (with the mode-appropriate terminal lifecycle) and returns.
async function bringUpFromRepo(project, { repoPath, containerName, mode = 'provision' }) {
  const projectId = Number(project.id);
  const image = MOCK2_BASE_IMAGE;
  const rehydrate = mode === 'rehydrate';
  const failLifecycle = rehydrate ? 'archived' : 'failed_provisioning';
  const bail = (reason) => fail(project, reason, { lifecycle: failLifecycle });

  // Idempotency: clear any stale container of this name (a prior failed
  // attempt, or a leftover) so the sequence can always start clean. No-op if
  // absent. On rehydrate the container was destroyed at archive, so this is a
  // cheap safety net.
  await sh(`incus delete ${containerName} --force 2>/dev/null || true`, { timeoutMs: 60000 });

  // ---- Create the per-project managed bridge (M4, ADR-010) ----
  // Each project gets its OWN bridge m2br<id>/<own /24> so the fence and proxy
  // can key rules on its source subnet. Deterministic + stored on the row
  // (migration 505) so a boot reconcile can rebuild without extra state. On
  // rehydrate the bridge was torn down at archive; recreate it (idempotent).
  setStatus(projectId, { phase: 'bridge', message: 'Creating project network…' });
  const bridgeName = bridgeNameForProject(projectId);
  const bridgeCidr = project.bridge_cidr || bridgeCidrForProject(projectId);
  const bridge = await createProjectBridge({ name: bridgeName, cidr: bridgeCidr });
  if (!bridge.ok) return bail(`project bridge create failed: ${bridge.error}`);
  updateProject(projectId, { bridge_name: bridgeName, bridge_cidr: bridgeCidr });
  // Egress is the bridge's own Incus NAT (ipv4.nat=true) — no host-side proxy to
  // install or keep alive. But the host must actually FORWARD + masquerade the
  // bridge out: enable IPv4 forwarding and, on a Docker host (whose FORWARD chain
  // defaults to DROP for non-Docker bridges), allow m2br* through DOCKER-USER.
  // Without this the clone below can't reach the Debian mirrors ("Unable to
  // connect"). Idempotent + best-effort; run before the container launches.
  await ensureHostEgress().catch((e) => console.warn('[mock2] ensureHostEgress failed:', e?.message));

  // ---- Launch the container, NIC pinned to the project bridge ----
  setStatus(projectId, { phase: 'launch', message: `${rehydrate ? 'Rehydrating' : 'Provisioning'}: launching container…` });
  const launch = await sh(`incus launch ${image} ${containerName} --network ${bridgeName}`, { timeoutMs: 300000 });
  if (launch.code !== 0) return bail(`container launch failed: ${(launch.stderr || '').trim().slice(-500)}`);

  // ---- Wait for a bridge IP ----
  setStatus(projectId, { phase: 'network', message: 'Waiting for network…' });
  const ip = await waitForContainerIp(containerName);
  if (!ip) return bail('container did not obtain a bridge IP within timeout');
  updateProject(projectId, { container_ip: ip, container_name: containerName });

  // Point the container's resolver at its OWN bridge gateway (Incus's dnsmasq
  // on m2br<id> serves DNS there). Under the fence (applied at activation) DNS
  // to the gateway is allowed; direct public resolvers are denied. DHCP usually
  // sets this already, but force it so the value is deterministic (M4, ADR-010).
  const gateway = gatewayForCidr(bridgeCidr);
  await sh(`incus exec ${containerName} -- sh -c 'printf "nameserver ${gateway}\\n" > /etc/resolv.conf'`).catch(() => {});

  // ---- Force apt onto IPv4 before anything fetches packages ----
  // The clone + setup below reach the Debian mirrors over the bridge's Incus NAT.
  // The bridge is v4-only (ipv6.address=none, network.js), so apt must not try a
  // v6 route ("Network is unreachable"). No proxy — squid was removed.
  const bootstrapEgress = 'mkdir -p /etc/apt/apt.conf.d\nprintf \'Acquire::ForceIPv4 "true";\\n\' > /etc/apt/apt.conf.d/00mock2-ipv4\n';
  await sh(`printf '%s' '${b64(bootstrapEgress)}' | base64 -d | incus exec ${containerName} -- sh`)
    .catch((e) => console.warn('[mock2] container bootstrap egress config failed:', e?.message));

  // ---- Mount the bare repo (ADR-011) + clone the working tree ----
  setStatus(projectId, { phase: 'repo-mount', message: 'Mounting repo and cloning working tree…' });
  const mount = await sh(`incus config device add ${containerName} reporepo disk source=${repoPath} path=${REPO_MOUNT} shift=true 2>&1`);
  if (mount.code !== 0) return bail(`repo mount failed: ${(mount.stderr || mount.stdout || '').trim().slice(-500)}`);
  const clone = await sh(
    `incus exec ${containerName} -- sh -c 'command -v git >/dev/null 2>&1 || (apt-get update -y && apt-get install -y --no-install-recommends git); git config --global --add safe.directory ${REPO_MOUNT}; rm -rf ${APP_DIR}; git clone ${REPO_MOUNT} ${APP_DIR}; git config --global --add safe.directory ${APP_DIR}'`,
    { timeoutMs: 180000 },
  );
  if (clone.code !== 0) {
    // A clone failure is almost always the container failing to install git,
    // which is really "no working egress to the Debian mirrors". Detect that
    // signature and turn the cryptic apt/`git: not found` cascade into an
    // operator-actionable message that names the actual cause and the fix.
    const out = (clone.stderr || clone.stdout || '').trim();
    const noEgress = /unable to connect|could not resolve|network is unreachable|failed to fetch|cannot initiate the connection|temporary failure in name resolution/i.test(out);
    const hint = noEgress
      ? ' — the project container could not reach the package mirrors to install git. Egress is the bridge\'s Incus NAT: check that the HOST itself has working internet and that the m2br* bridge has ipv4.nat=true (incus network show m2br<id>). If the host reaches the internet only via an upstream HTTP proxy, the container needs that proxy too. mock2 containers cannot provision or build without egress.'
      : '';
    return bail(`working clone failed: ${out.slice(-600)}${hint}`);
  }

  // ---- Read the DECLARED web port from the repo (ADR-005) ----
  setStatus(projectId, { phase: 'manifest', message: 'Reading declared topology…' });
  const manifest = await sh(`incus exec ${containerName} -- cat ${APP_DIR}/mock2.yaml 2>/dev/null`);
  const declaredPort = parseManifestWebPort(manifest.stdout) || project.web_port || DEFAULT_WEB_PORT;

  // Sync the app's DECLARED egress (mock2.yaml `egress:`) into the grant store so
  // each declared host becomes a pending admin-queue item and a removed one is
  // revoked. Done before the fence reconcile below, so any already-approved grant
  // is wired this provision. Best-effort — a parse/DB hiccup never fails provision.
  try {
    const sync = syncDeclaredEgress(projectId, parseDeclaredEgress(manifest.stdout || ''));
    if (sync.added.length) await probeEgressGrants(sync.added).catch(() => {});
  } catch (e) { console.warn('[mock2] egress sync (provision) failed:', e?.message); }

  // ---- Run the container setup script (runtime + Postgres + dev server) ----
  // Egress is the bridge's Incus NAT — no proxy env to bake in (squid removed).
  setStatus(projectId, { phase: 'setup', message: 'Installing runtime and starting dev server…' });
  const setupScript = buildContainerSetupScript({
    appDir: APP_DIR,
    webPort: declaredPort,
  });
  const pushSetup = await sh(
    `printf '%s' '${b64(setupScript)}' | base64 -d | incus exec ${containerName} -- tee /tmp/mock2-setup.sh >/dev/null && incus exec ${containerName} -- sh /tmp/mock2-setup.sh`,
    { timeoutMs: 420000 },
  );
  if (pushSetup.code !== 0) {
    // The dev server not starting means no live URL — treat as failure so the
    // operator sees why.
    return bail(`container setup failed: ${(pushSetup.stderr || pushSetup.stdout || '').trim().slice(-800)}`);
  }

  updateProject(projectId, { web_port: declaredPort, container_ip: ip });

  // Flip to active FIRST so publishDomain's active-FQDN computation (and the
  // fence plan) include this project — projectActiveFqdns / buildFenceEntries
  // both skip non-active projects. archived_at cleared here (and only here) so a
  // failed rehydrate that reverts to 'archived' keeps its original timestamp.
  setStatus(projectId, { phase: 'activate', message: 'Activating…' });
  updateProject(projectId, { lifecycle: 'active', provision_error: null, archived_at: null, last_activity_at: new Date().toISOString() });

  // ---- Apply the network fence now the project is active (M4, ADR-010) ----
  // With container_ip + web_port known and lifecycle 'active', this project is
  // now included in the fence plan: default-deny egress off the bridge, DNS +
  // egress-proxy to its gateway only, inbound only to the declared web port.
  // Applied HERE (not during setup) so bootstrap apt/clone had direct egress.
  // From this point the fence logs + contains egress (it never blocks the
  // internet path — the bridge NATs out).
  setStatus(projectId, { phase: 'fence', message: 'Applying network isolation…' });
  await reconcileMock2Firewall().catch((e) => console.error('[mock2] firewall reconcile (provision) failed:', e?.message));
  // Verify declared vs live ports (ADR-005 inbound half). A listener the
  // manifest does not declare raises a port_drift queue item (bell until M8).
  await runPortDriftCheck({ ...project, container_name: containerName, web_port: declaredPort })
    .catch((e) => console.warn('[mock2] port-drift check failed:', e?.message));

  // ---- Run-phase rehydrate idempotency (deploy the built app) ----
  // The setup script just re-seeded the PLACEHOLDER serve.py unit; a rehydrated
  // container has no node_modules/dist (gitignored) and lost the deploy-rewritten
  // unit. If this project had been built and serving before archive, re-run the
  // deploy step through the now-active fence so the REAL app comes back, not the
  // placeholder (Run-phase idempotency). Only on rehydrate, and only if it was
  // previously deployed; a Concept-stage project stays on the placeholder.
  if (rehydrate) {
    await redeployIfBuilt(project, { containerName, webPort: declaredPort })
      .catch((e) => console.warn('[mock2] rehydrate re-deploy failed:', e?.message));
  }

  // ---- Register the slug's FQDN block in the parent-domain Caddy file ----
  setStatus(projectId, { phase: 'caddy', message: 'Publishing route…' });
  const reload = await publishDomain(project.parent_domain_id);
  const caddyDedupe = `mock2-provision-caddy:${projectId}`;
  if (!reload.ok) {
    // The container is up but Caddy didn't reload — surface it (ACME/reload
    // failures become notifications, not a rolled-back provision).
    setStatus(projectId, { phase: 'ready', message: `Container ready; Caddy reload failed: ${reload.error}`, caddy: reload });
    try {
      raiseQueueItem({
        kind: 'provisioning_failed',
        project_id: projectId,
        dedupe_key: caddyDedupe,
        ref_table: 'mock2_projects',
        ref_id: projectId,
        detail: `${project.name}: container online but Caddy reload failed — ${reload.error}`,
      });
    } catch { /* best effort */ }
  } else {
    resolveQueueItem(`mock2-provision:${projectId}`, { resolution: rehydrate ? 'rehydrated' : 'provisioned' });
    resolveQueueItem(caddyDedupe, { resolution: 'published' });
    setStatus(projectId, { phase: 'ready', message: rehydrate ? 'Project rehydrated' : 'Project online', caddy: reload });
  }

  console.log(`[mock2] project ${projectId} ${rehydrate ? 'rehydrated' : 'provisioned'}: ${containerName} @ ${ip}:${declaredPort}`);

  // ---- Base-app activation (fresh provision only) ----
  // A NEW project should be a WORKING app the moment it exists — open the URL,
  // create the first administrator, sign in — before any mockup or build.
  if (!rehydrate) {
    await deployBaseApp(getProject(projectId), { reason: 'provision' });
  }
  scheduleCleanup(projectId);
}

// deployBaseApp — pre-install the standard components (wires the auth
// bootstrap into the scaffold, zero tokens) and deploy the scaffold through
// the active fence (npm install → migrate → tsc build → unit swap →
// health-check), so the project URL serves the real sign-in-able base app
// instead of the placeholder. Used at fresh provision AND as the self-heal
// when the Builder reaches for the app and it isn't deployed yet (e.g. Skip
// mockup on a project whose provision-time deploy failed). Never throws: any
// failure leaves the placeholder serving, posts a VISIBLE chat message with
// the step + error, and raises an admin-queue item.
// After a health-step failure, the app frequently recovers SECONDS later: the
// unit keeps restarting (Restart=on-failure) and wins once whatever held the
// port dies — dev2/Fly both served the sign-in page minutes after being marked
// "deploy failed". Re-probe a few times and record the recovery, so the status
// converges to the truth instead of staying a lie until someone presses a
// button. In-process timers — a backend restart drops them, and the wake/
// rehydrate self-heal covers that path.
const baseAppRecheckTimers = new Map();
function scheduleBaseAppRecheck(projectId, attempt = 1) {
  if (attempt > 4 || baseAppRecheckTimers.has(projectId)) return;
  const t = setTimeout(async () => {
    baseAppRecheckTimers.delete(projectId);
    try {
      const fresh = getProject(projectId);
      if (!fresh || fresh.base_app_deployed_at || fresh.lifecycle !== 'active') return;
      const containerName = fresh.container_name || containerNameForProject(projectId);
      const webPort = fresh.web_port || DEFAULT_WEB_PORT;
      const probe = await sh(
        `incus exec ${containerName} -- sh -c 'code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${webPort}/" 2>/dev/null); exec_line=$(grep -h "^ExecStart" /etc/systemd/system/mock2-dev.service 2>/dev/null); echo "$code|$exec_line"'`,
        { timeoutMs: 20000 },
      );
      const [codeStr, execLine = ''] = String(probe.stdout || '').trim().split('|');
      const code = Number(codeStr);
      if (code >= 200 && code < 500 && /node/.test(execLine)) {
        updateProject(projectId, { base_app_deployed_at: new Date().toISOString() });
        setStatus(projectId, { phase: 'ready', message: 'Project online — the base app is live (create the first administrator on its URL).' });
        try { resolveQueueItem(`mock2-base-app:${projectId}`); } catch { /* best effort */ }
        try {
          const { insertMessage } = await import('./chats.js');
          insertMessage({ projectId, kind: 'system', body: 'The base app RECOVERED and is now live on your project URL — the earlier "deploy failed" was its health check giving up while the app was still winning the port back. Open the URL to create the first administrator and sign in.' });
        } catch { /* best effort */ }
        console.log(`[mock2] project ${projectId} base app recovered after failed health check (recheck ${attempt})`);
      } else {
        scheduleBaseAppRecheck(projectId, attempt + 1);
      }
    } catch { /* best effort — next wake self-heals */ }
  }, 60000);
  baseAppRecheckTimers.set(projectId, t);
}

// One base-app deploy per project at a time. Every caller is fire-and-forget
// (provision, the skip-mockup self-heal, the retry route), so nothing upstream
// serializes them — and two concurrent `npm install`s in the same tree fail
// each other with ETXTBSY on esbuild's binary (a double-pressed retry button
// produced exactly that).
const baseAppDeployInFlight = new Set();
export function isBaseAppDeploying(projectId) {
  return baseAppDeployInFlight.has(Number(projectId));
}

export async function deployBaseApp(project, { reason = 'provision' } = {}) {
  const projectId = Number(project?.id);
  if (!Number.isFinite(projectId)) return { ok: false, error: 'no project' };
  if (baseAppDeployInFlight.has(projectId)) {
    return { ok: false, inFlight: true, error: 'a base-app deploy is already running for this project' };
  }
  baseAppDeployInFlight.add(projectId);
  try {
    return await deployBaseAppInner(project, projectId, { reason });
  } finally {
    baseAppDeployInFlight.delete(projectId);
  }
}

async function deployBaseAppInner(project, projectId, { reason }) {
  const containerName = project.container_name || containerNameForProject(projectId);
  const webPort = project.web_port || DEFAULT_WEB_PORT;
  const say = async (body) => {
    try { const { insertMessage } = await import('./chats.js'); insertMessage({ projectId, kind: 'system', body }); }
    catch { /* best effort */ }
  };
  try {
    // Fast path: the app may ALREADY be serving — a deploy whose health window
    // closed during a transient port conflict is marked failed, but the unit
    // keeps restarting and wins once the holder dies. If the unit runs the
    // built app (node, not the serve.py placeholder) and the port answers,
    // record the truth instead of redeploying.
    try {
      const probe = await sh(
        `incus exec ${containerName} -- sh -c 'code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${webPort}/" 2>/dev/null); exec_line=$(grep -h "^ExecStart" /etc/systemd/system/mock2-dev.service 2>/dev/null); echo "$code|$exec_line"'`,
        { timeoutMs: 20000 },
      );
      const [codeStr, execLine = ''] = String(probe.stdout || '').trim().split('|');
      const code = Number(codeStr);
      if (code >= 200 && code < 500 && /node/.test(execLine)) {
        updateProject(projectId, { base_app_deployed_at: new Date().toISOString() });
        setStatus(projectId, { phase: 'ready', message: 'Project online — the base app is live (create the first administrator on its URL).' });
        try { resolveQueueItem(`mock2-base-app:${projectId}`); } catch { /* best effort */ }
        await say('The base app is already live on your project URL — open it to create the first administrator and sign in. (An earlier deploy was marked failed because its health window closed during a temporary port conflict, but the app recovered on its own.)');
        console.log(`[mock2] project ${projectId} base app already serving (${reason}) — stamped without redeploy`);
        return { ok: true, alreadyServing: true };
      }
    } catch { /* fall through to the full deploy */ }

    setStatus(projectId, { phase: 'base-app', message: 'Setting up the base app (sign-in + first-admin bootstrap)…' });
    // Dynamic import: component-install imports this module (container
    // naming), so a static import would be a cycle.
    const { preinstallComponents } = await import('./component-install.js');
    const pre = await preinstallComponents({ project, initiatedBy: project?.created_by ?? null });
    if (!pre.ok) {
      // Deploying with missing components would fail at tsc against absent
      // modules (the "Cannot find module 'ldapts'" failure) — stop here with
      // the real cause instead. Any later build retries the install first.
      const detail = pre.failed?.map((f) => `${f.row?.key}: ${f.error}`).join('; ') || 'unknown';
      console.warn(`[mock2] base-app component pre-install failed for ${projectId}:`, detail);
      setStatus(projectId, { phase: 'ready', message: `Project online on the placeholder — component install failed: ${detail.slice(0, 200)}` });
      await say(`Base app setup stopped — component install failed (${detail.slice(0, 400)}). The placeholder keeps serving; fix the cause (component install retries on the next build) or run any build/Quick update.`);
      try {
        raiseQueueItem({
          kind: 'flag', project_id: projectId, dedupe_key: `mock2-base-app:${projectId}`,
          ref_table: 'mock2_projects', ref_id: projectId,
          detail: `${project.name}: base app component pre-install failed — ${detail.slice(0, 300)}`,
        });
      } catch { /* best effort */ }
      return { ok: false, error: `component pre-install failed: ${detail}` };
    }
    setStatus(projectId, { phase: 'base-app', message: 'Deploying the base app (install, migrate, build, start)…' });
    const result = await deployProject({
      containerName, appDir: APP_DIR, webPort,
      onStep: (_key, label) => setStatus(projectId, { phase: 'base-app', message: label }),
    });
    if (result.ok && !result.skipped) {
      setStatus(projectId, { phase: 'ready', message: 'Project online — the base app is live (create the first administrator on its URL).' });
      try { updateProject(projectId, { base_app_deployed_at: new Date().toISOString() }); } catch { /* best effort */ }
      try { resolveQueueItem(`mock2-base-app:${projectId}`); } catch { /* best effort */ }
      await say('The base app is live on your project URL — open it to create the first administrator and sign in. It ships with the full admin area: users, roles & permissions, directory sign-in (LDAPS), and self-signup live at /admin, and every account has /profile. From here you can mock up a design and apply it, or skip the mockup and start making quick updates to the running app.');
      console.log(`[mock2] project ${projectId} base app deployed (${reason})`);
      return { ok: true };
    }
    if (!result.ok) {
      setStatus(projectId, { phase: 'ready', message: `Project online on the placeholder — base app deploy failed at "${result.step}": ${result.error}` });
      console.warn(`[mock2] base-app deploy failed for ${projectId} (${reason}): ${result.step} — ${result.error}`);
      await say(`Base app deploy failed at "${result.step}": ${String(result.error || '').slice(0, 900)} — the placeholder keeps serving. Fix the cause (or run any build, which deploys the app) and try again.`);
      try {
        raiseQueueItem({
          kind: 'flag', project_id: projectId, dedupe_key: `mock2-base-app:${projectId}`,
          ref_table: 'mock2_projects', ref_id: projectId,
          detail: `${project.name}: base app deploy failed at "${result.step}" — ${String(result.error || '').slice(0, 300)}`,
        });
      } catch { /* best effort */ }
      // A health failure is often a crash loop the app WINS after the check
      // gives up — re-probe and record the recovery if it comes.
      if (result.step === 'health') scheduleBaseAppRecheck(projectId);
      return { ok: false, step: result.step, error: result.error };
    }
    return { ok: true, skipped: true };
  } catch (e) {
    console.warn(`[mock2] base-app activation failed for ${projectId} (${reason}; placeholder keeps serving):`, e?.message || e);
    await say(`Base app setup crashed: ${String(e?.message || e).slice(0, 400)} — the placeholder keeps serving. Any successful build will deploy the app.`);
    return { ok: false, error: e?.message || String(e) };
  }
}

// redeployIfBuilt — restore a previously-built app after a rehydrate rebuilds
// the container from the repo. deployProject reads the run contract from the
// working tree (declared, not discovered), installs deps + runs migrations
// against the fresh in-container Postgres (ADR-008; dev data is disposable) +
// builds + swaps the systemd unit to the app's start command + restarts. Runs
// AFTER the fence so npm install exercises the same egress path a build does.
// Best-effort: a failure leaves the container up on the placeholder and is
// surfaced on the progress map — the operator can retry a build to redeploy.
async function redeployIfBuilt(project, { containerName, webPort }) {
  const projectId = Number(project.id);
  let built = false;
  try { built = projectHasBeenDeployed(projectId) || !!project.base_app_deployed_at; }
  catch (e) { console.warn('[mock2] rehydrate deploy check failed:', e?.message); }
  if (!built) {
    // Never-deployed but the Builder already committed to working on the live
    // app (design approved/skipped): a rehydrate would otherwise park them on
    // the placeholder waiting for a manual "Deploy base app" press. Run the
    // base-app deploy instead — it pre-installs components (repairing deps and
    // upgrading an unwireable auth version) before deploying, so a project
    // that failed under an older backend heals on its next wake.
    if (project.design_approved_at) {
      await deployBaseApp(project, { reason: 'rehydrate' })
        .catch((e) => console.warn('[mock2] rehydrate base-app deploy failed:', e?.message));
    }
    return;
  }
  setStatus(projectId, { phase: 'deploy', message: 'Restoring the built app (install, migrate, build, start)…' });
  const result = await deployProject({
    containerName, appDir: APP_DIR, webPort,
    onStep: (_key, label) => setStatus(projectId, { phase: 'deploy', message: label }),
  });
  if (!result.ok) {
    setStatus(projectId, { phase: 'deploy', message: `Rehydrated on the placeholder — restoring the built app failed at "${result.step}": ${result.error}` });
    console.warn(`[mock2] rehydrate re-deploy failed for ${projectId}: ${result.step} — ${result.error}`);
  } else if (!result.skipped) {
    setStatus(projectId, { phase: 'deploy', message: 'Built app restored — serving on the live URL.' });
    console.log(`[mock2] project ${projectId} re-deployed on rehydrate`);
  }
}

// ---- Rehydrate (M3): rebuild an archived project from the bare repo ----

// startRehydrate(project) — kick off the background rebuild. The route has
// already flipped lifecycle to 'provisioning' and restored container_name, so
// the existing provisioning poll/UI drives it. Same slug, same URL — the slug
// was never released (ADR-006). Returns immediately.
export function startRehydrate(project) {
  const projectId = Number(project.id);
  const repoPath = project.repo_path || repoPathForProject(projectId);
  const containerName = project.container_name || containerNameForProject(projectId);
  setStatus(projectId, { phase: 'starting', message: 'Starting rehydrate…', startedAt: Date.now(), error: null });
  rehydrateProject(project, { repoPath, containerName }).catch((err) => {
    console.error(`[mock2] rehydrate crashed for project ${projectId}:`, err?.message || err);
    fail(project, `rehydrate crashed: ${err?.message || err}`, { lifecycle: 'archived' });
  });
  return true;
}

async function rehydrateProject(project, { repoPath, containerName }) {
  const projectId = Number(project.id);
  // The bare repo IS the recovery path (ADR-006). If it is gone there is
  // nothing to rehydrate from — fail back to archived rather than launch an
  // empty container.
  const check = await sh(`[ -d ${repoPath} ] && echo ok || echo missing`);
  if ((check.stdout || '').trim() !== 'ok') {
    return fail(project, `bare repo missing at ${repoPath} — cannot rehydrate`, { lifecycle: 'archived' });
  }
  return bringUpFromRepo(project, { repoPath, containerName, mode: 'rehydrate' });
}

// ---- Archive (M3): checkpoint → push → destroy → 'archived' ----

// startArchive(project) — kick off the background archive. Returns immediately;
// the frontend polls until lifecycle flips to 'archived'. The bare repo, slug
// history, chats, change records, and memberships are all RETAINED (ADR-006);
// only the container is destroyed.
export function startArchive(project) {
  const projectId = Number(project.id);
  setStatus(projectId, { phase: 'archiving', message: 'Archiving…', startedAt: Date.now(), error: null });
  archiveProjectJob(project).catch((err) => {
    console.error(`[mock2] archive crashed for project ${projectId}:`, err?.message || err);
    // Leave lifecycle unchanged (still active/stopped) so the operator can
    // retry; record the error on the progress map.
    setStatus(projectId, { phase: 'failed', message: `archive crashed: ${err?.message || err}`, error: String(err?.message || err) });
  });
  return true;
}

async function archiveProjectJob(project) {
  const projectId = Number(project.id);
  const containerName = project.container_name || containerNameForProject(projectId);

  // 1. Checkpoint-commit the working tree and push it into the bare repo over
  //    the ADR-011 mount (the ONLY recovery path). Tolerant: a container that's
  //    already gone means the last checkpoint is already the repo state.
  setStatus(projectId, { phase: 'checkpoint', message: 'Checkpointing working tree into the bare repo…' });
  const checkpoint = await sh(
    `printf '%s' '${b64(buildCheckpointScript({ appDir: APP_DIR }))}' | base64 -d | incus exec ${containerName} -- sh 2>&1`,
    { timeoutMs: 120000 },
  );
  if (checkpoint.code !== 0) {
    // Non-zero here is either "container already gone" (safe — the bare repo
    // holds the last pushed state) or a real push failure. Log it; still
    // archive so the row doesn't get stuck. A genuine push failure would leave
    // the last checkpoint as the recoverable state, not the newest edits.
    console.warn(`[mock2] archive checkpoint non-zero for ${projectId}: ${(checkpoint.stdout || checkpoint.stderr || '').trim().slice(-400)}`);
  }

  // 2. Destroy the container, then its per-project bridge (M4). Order matters —
  //    Incus refuses to delete a network with an instance attached. KEEP the
  //    bare repo + slug history + memberships + the allowlist + bridge_cidr (so
  //    rehydrate reuses the same subnet).
  setStatus(projectId, { phase: 'teardown', message: 'Destroying container and network…' });
  await sh(`incus delete ${containerName} --force 2>/dev/null || true`, { timeoutMs: 60000 });
  await deleteProjectBridge(bridgeNameForProject(projectId))
    .catch((e) => console.warn(`[mock2] archive: bridge teardown failed for ${projectId}:`, e?.message));

  // 3. Mark archived. container_name/container_ip go NULL (03-data-model.md:
  //    container_name is NULL when archived); archived_at stamped. bridge_cidr
  //    is retained so a later rehydrate lands on the same subnet.
  updateProject(projectId, {
    lifecycle: 'archived',
    archived_at: new Date().toISOString(),
    container_name: null,
    container_ip: null,
  });

  // Drop this project from the fence plan now it is no longer active.
  await reconcileMock2Firewall().catch((e) => console.error('[mock2] firewall reconcile (archive) failed:', e?.message));

  // 4. Republish — drops this project's slug block (an archived project has no
  //    upstream, so projectActiveFqdns returns nothing). The slug STAYS
  //    reserved in mock2_slug_history (never reusable, ADR-006).
  setStatus(projectId, { phase: 'caddy', message: 'Removing route…' });
  let caddy = { ok: true };
  if (project.parent_domain_id) caddy = await publishDomain(project.parent_domain_id);

  setStatus(projectId, { phase: 'archived', message: 'Project archived', caddy });
  console.log(`[mock2] project ${projectId} archived (bare repo + slug retained)`);
  scheduleCleanup(projectId);
}

// ---- Idle-stop groundwork (M3): stop / wake a container without archiving ----

// stopProjectContainer(project) — `incus stop` (graceful), mark 'stopped', drop
// the route. Distinct from archive: the container is STOPPED, not destroyed, so
// wake is a fast `incus start`. Used by the idle sweep (idle.js).
export async function stopProjectContainer(project) {
  const containerName = project.container_name || containerNameForProject(project.id);
  const r = await sh(`incus stop ${containerName} 2>&1`, { timeoutMs: 60000 });
  updateProject(project.id, { lifecycle: 'stopped', container_ip: null });
  if (project.parent_domain_id) await publishDomain(project.parent_domain_id).catch(() => {});
  // A stopped project leaves the fence plan (no container to fence). The bridge
  // is KEPT (unlike archive) so wake is a fast start. Egress ACLs stay too —
  // harmless with no container, and one fewer reload on wake.
  await reconcileMock2Firewall().catch((e) => console.error('[mock2] firewall reconcile (idle-stop) failed:', e?.message));
  console.log(`[mock2] project ${project.id} idle-stopped (container ${containerName})`);
  return r;
}

// startWake(project) — restart-on-visit: start a stopped container, refresh its
// IP, republish, flip back to 'active'. Background job on the shared progress
// map so the frontend can poll.
export function startWake(project) {
  const projectId = Number(project.id);
  setStatus(projectId, { phase: 'waking', message: 'Starting container…', startedAt: Date.now(), error: null });
  wakeProjectJob(project).catch((err) => {
    console.error(`[mock2] wake crashed for project ${projectId}:`, err?.message || err);
    setStatus(projectId, { phase: 'failed', message: `wake failed: ${err?.message || err}`, error: String(err?.message || err) });
  });
  return true;
}

async function wakeProjectJob(project) {
  const projectId = Number(project.id);
  const containerName = project.container_name || containerNameForProject(projectId);
  await sh(`incus start ${containerName} 2>&1`, { timeoutMs: 60000 }); // 'already running' is harmless
  setStatus(projectId, { phase: 'network', message: 'Waiting for network…' });
  const ip = await waitForContainerIp(containerName);
  if (!ip) {
    setStatus(projectId, { phase: 'failed', message: 'container did not obtain an IP after start', error: 'no ip after start' });
    return;
  }
  updateProject(projectId, { container_ip: ip, lifecycle: 'active', last_activity_at: new Date().toISOString() });
  // Re-apply the fence — the woken container is active again with a (possibly
  // new) IP. The bridge and allowlist were kept across the stop, so this just
  // re-asserts the rules for the fresh address.
  await reconcileMock2Firewall().catch((e) => console.error('[mock2] firewall reconcile (wake) failed:', e?.message));
  const caddy = await publishDomain(project.parent_domain_id);
  setStatus(projectId, { phase: 'ready', message: 'Container running', caddy });
  console.log(`[mock2] project ${projectId} woken (container ${containerName} @ ${ip})`);
  // Same self-heal as rehydrate: a design-approved/skipped project whose base
  // app never successfully deployed (it failed under an older backend) would
  // otherwise wake straight back onto the placeholder. Fire-and-forget — the
  // deploy repairs deps / upgrades an unwireable auth component first, posts
  // its outcome in the chat, and the fast path just stamps an already-serving
  // app without redeploying.
  try {
    const fresh = getProject(projectId);
    const built = projectHasBeenDeployed(projectId) || !!fresh?.base_app_deployed_at;
    if (!built && fresh?.design_approved_at) {
      void deployBaseApp(fresh, { reason: 'wake' });
    }
  } catch (e) { console.warn('[mock2] wake base-app heal check failed:', e?.message); }
  scheduleCleanup(projectId);
}

// Poll `incus list <name> --format json` for a global-scope IPv4 on the
// container's primary interface (mirrors lxc.js extractIPv4 semantics).
async function waitForContainerIp(containerName, { attempts = 30, delayMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const r = await sh(`incus list ${containerName} --format json 2>/dev/null`, { timeoutMs: 8000 });
    if (r.code !== 0) continue;
    let arr;
    try { arr = JSON.parse(r.stdout || '[]'); } catch { continue; }
    const ip = pickContainerIp(arr[0]);
    if (ip) return ip;
  }
  return null;
}

// A non-loopback, global-scope IPv4 on eth0 (falling back to any non-docker
// iface). Kept local to avoid importing routes/lxc.js (circular + heavy).
function pickContainerIp(container) {
  const net = container?.state?.network;
  if (!net) return null;
  const isDocker = (n) => /^docker\d+$|^docker_gwbridge$|^br-[0-9a-f]+$|^veth/.test(n);
  const ok = (a) => a.family === 'inet' && (!a.scope || a.scope === 'global') && !a.address.startsWith('127.');
  for (const [name, iface] of Object.entries(net)) {
    if (name !== 'eth0') continue;
    for (const a of iface.addresses || []) if (ok(a)) return a.address;
  }
  for (const [name, iface] of Object.entries(net)) {
    if (name === 'lo' || isDocker(name)) continue;
    for (const a of iface.addresses || []) if (ok(a)) return a.address;
  }
  return null;
}

// Tear down a project's host artifacts (container + bridge + mount + repo). Used
// by the delete route. Best-effort; a missing artifact is success. The bare repo
// is removed only on hard delete — archive (M3) keeps it. The per-project bridge
// is always removed here (M4); the delete route reconciles the fence + proxy
// afterwards (the row is already gone, so the reconcile drops this project).
export async function teardownProject({ containerName, projectId, repoPath, removeRepo = false }) {
  const results = {};
  results.container = await sh(`incus delete ${containerName} --force 2>/dev/null || true`, { timeoutMs: 60000 });
  if (projectId != null) {
    results.bridge = await deleteProjectBridge(bridgeNameForProject(projectId))
      .catch((e) => ({ ok: false, error: e?.message }));
  }
  if (removeRepo && repoPath) {
    // Guard the rm to the repos dir so a malformed path can't escape.
    if (repoPath.startsWith(`${MOCK2_DATA_DIR}/repos/`) && repoPath.endsWith('.git')) {
      results.repo = await sh(`rm -rf ${repoPath} 2>/dev/null || true`, { timeoutMs: 30000 });
    }
  }
  return results;
}
