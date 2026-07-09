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

import { spawnHost } from '../lib/host-exec.js';
import { updateProject } from './projects.js';
import { publishDomain } from './publish.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import { buildSeedFiles, buildContainerSetupScript, buildCheckpointScript, parseManifestWebPort, DEFAULT_WEB_PORT } from './template.js';

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

// runHost — promise wrapper over spawnHost with captured stdout/stderr and an
// optional stdin payload (used to stream base64 script bodies into the host or
// a container). Resolves { code, stdout, stderr } (never rejects on non-zero
// exit — the caller decides what a non-zero code means).
function runHost(bin, args, { input = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnHost(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ code: null, stdout, stderr: stderr + '\n[mock2] host command timed out', timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); finish({ code: null, stdout, stderr: stderr + err.message }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
    if (input != null) {
      try { child.stdin.write(input); child.stdin.end(); } catch { /* ignore */ }
    }
  });
}

// Run a shell one-liner on the host (nsenter-pivoted inside Docker).
function sh(script, opts) {
  return runHost('sh', ['-c', script], opts);
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

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
if [ ! -d "$REPO" ]; then
  git init --bare -b main "$REPO"
fi
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
  const cur = activeProvisions.get(Number(projectId)) || {};
  activeProvisions.set(Number(projectId), { ...cur, ...patch, updatedAt: Date.now() });
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

  // ---- Launch the container (unprivileged, shared bridge) ----
  setStatus(projectId, { phase: 'launch', message: `${rehydrate ? 'Rehydrating' : 'Provisioning'}: launching container…` });
  const launch = await sh(`incus launch ${image} ${containerName}`, { timeoutMs: 300000 });
  if (launch.code !== 0) return bail(`container launch failed: ${(launch.stderr || '').trim().slice(-500)}`);

  // ---- Wait for a bridge IP ----
  setStatus(projectId, { phase: 'network', message: 'Waiting for network…' });
  const ip = await waitForContainerIp(containerName);
  if (!ip) return bail('container did not obtain a bridge IP within timeout');
  updateProject(projectId, { container_ip: ip, container_name: containerName });

  // Public DNS so apt/registry reachability works on the shared bridge (M4
  // replaces this with the egress proxy).
  await sh(`incus exec ${containerName} -- sh -c 'grep -q 9.9.9.9 /etc/resolv.conf 2>/dev/null || printf "nameserver 9.9.9.9\\nnameserver 1.1.1.1\\n" > /etc/resolv.conf'`).catch(() => {});

  // ---- Mount the bare repo (ADR-011) + clone the working tree ----
  setStatus(projectId, { phase: 'repo-mount', message: 'Mounting repo and cloning working tree…' });
  const mount = await sh(`incus config device add ${containerName} reporepo disk source=${repoPath} path=${REPO_MOUNT} shift=true 2>&1`);
  if (mount.code !== 0) return bail(`repo mount failed: ${(mount.stderr || mount.stdout || '').trim().slice(-500)}`);
  const clone = await sh(
    `incus exec ${containerName} -- sh -c 'command -v git >/dev/null 2>&1 || (apt-get update -y && apt-get install -y --no-install-recommends git); git config --global --add safe.directory ${REPO_MOUNT}; rm -rf ${APP_DIR}; git clone ${REPO_MOUNT} ${APP_DIR}; git config --global --add safe.directory ${APP_DIR}'`,
    { timeoutMs: 180000 },
  );
  if (clone.code !== 0) return bail(`working clone failed: ${(clone.stderr || clone.stdout || '').trim().slice(-800)}`);

  // ---- Read the DECLARED web port from the repo (ADR-005) ----
  setStatus(projectId, { phase: 'manifest', message: 'Reading declared topology…' });
  const manifest = await sh(`incus exec ${containerName} -- cat ${APP_DIR}/mock2.yaml 2>/dev/null`);
  const declaredPort = parseManifestWebPort(manifest.stdout) || project.web_port || DEFAULT_WEB_PORT;

  // ---- Run the container setup script (runtime + Postgres + dev server) ----
  setStatus(projectId, { phase: 'setup', message: 'Installing runtime and starting dev server…' });
  const setupScript = buildContainerSetupScript({ appDir: APP_DIR, webPort: declaredPort });
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

  // ---- Register the slug's FQDN block in the parent-domain Caddy file ----
  setStatus(projectId, { phase: 'caddy', message: 'Publishing route…' });
  // Flip to active FIRST so publishDomain's active-FQDN computation includes
  // this project (projectActiveFqdns skips non-active/no-upstream projects).
  // archived_at cleared here (and only here) so a failed rehydrate that reverts
  // to 'archived' keeps its original archive timestamp.
  updateProject(projectId, { lifecycle: 'active', provision_error: null, archived_at: null, last_activity_at: new Date().toISOString() });
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
  scheduleCleanup(projectId);
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

  // 2. Destroy the container. KEEP the bare repo + slug history + memberships.
  setStatus(projectId, { phase: 'teardown', message: 'Destroying container…' });
  await sh(`incus delete ${containerName} --force 2>/dev/null || true`, { timeoutMs: 60000 });

  // 3. Mark archived. container_name/container_ip go NULL (03-data-model.md:
  //    container_name is NULL when archived); archived_at stamped.
  updateProject(projectId, {
    lifecycle: 'archived',
    archived_at: new Date().toISOString(),
    container_name: null,
    container_ip: null,
  });

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
  const caddy = await publishDomain(project.parent_domain_id);
  setStatus(projectId, { phase: 'ready', message: 'Container running', caddy });
  console.log(`[mock2] project ${projectId} woken (container ${containerName} @ ${ip})`);
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

// Tear down a project's host artifacts (container + mount + repo). Used by the
// delete route. Best-effort; a missing artifact is success. The bare repo is
// removed only on hard delete — archive (M3) keeps it.
export async function teardownProject({ containerName, repoPath, removeRepo = false }) {
  const results = {};
  results.container = await sh(`incus delete ${containerName} --force 2>/dev/null || true`, { timeoutMs: 60000 });
  if (removeRepo && repoPath) {
    // Guard the rm to the repos dir so a malformed path can't escape.
    if (repoPath.startsWith(`${MOCK2_DATA_DIR}/repos/`) && repoPath.endsWith('.git')) {
      results.repo = await sh(`rm -rf ${repoPath} 2>/dev/null || true`, { timeoutMs: 30000 });
    }
  }
  return results;
}
