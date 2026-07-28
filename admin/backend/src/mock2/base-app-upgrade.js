// Base-app upgrade — the NATIVE half (container I/O, checkpoint, deploy).
// The decision layer is base-app-upgrade-logic.js so it stays testable.
//
// What this does: read the project's state/platform-version.json, compare it
// to what the scaffold generators produce today, and — when they differ —
// rewrite ONLY the platform-owned files, checkpoint, and redeploy.
//
// What it deliberately does NOT do: touch application code, run the model, or
// migrate data. It is a file-level refresh of the half of the app the platform
// owns. Everything else is the project's.

import { sh, b64 } from './host.js';
import { buildPlatformFiles, buildPlatformRoutes, PLATFORM_MODULE_VERSION, PLATFORM_CSS } from './scaffold-platform.js';
import { MOCK2_SCAFFOLD_VERSION, baseCss, scaffoldPwaFiles } from './scaffold.js';
import { playwrightConfigTs, e2eServerMjs, platformSpecTs, E2E_SCRIPTS, E2E_DEV_DEPENDENCIES } from './scaffold-e2e.js';
import { insertMessage } from './chats.js';
import { getProject } from './projects.js';
import {
  PLATFORM_VERSION_PATH, renderPlatformVersionFile, parsePlatformVersionFile,
  planBaseAppUpgrade, upgradeSummary, PLATFORM_OWNED_ALWAYS, PLATFORM_OWNED_IF_PRESENT,
  mergeE2ePackageJson,
} from './base-app-upgrade-logic.js';

const APP_DIR = '/srv/app';

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

// The payload goes to the container's STDIN still ENCODED, because the script
// running inside decodes it. Piping `base64 -d` on the HOST first decoded it
// twice: the container's `base64 -d` then read plain source, consumed the
// leading run of base64-legal characters, and wrote those few bytes before
// erroring on the first space.
//
// That is not theoretical. Project 44's src/platform/schema.ts was found as
// FOUR BYTES — 8a 6a 68 ae — which is exactly `printf 'import' | base64 -d`,
// the opening word of the file it was supposed to contain. A failed upgrade
// left a load-bearing platform file destroyed, and a later build spent turns
// discovering it and restoring it from git.
//
// concept.js and audit.js always did this correctly (`{ input: b64(content) }`)
// — this helper is the one that decoded first. Do not add a host-side decode.
function containerShWithStdin(containerName, script, b64Payload, { timeoutMs = 60000 } = {}) {
  return sh(
    `incus exec ${containerName} -- sh -c "$(printf '%s' '${b64(script)}' | base64 -d)"`,
    { timeoutMs, input: b64Payload },
  );
}

// The files the CURRENT scaffold would emit for the platform half. base.css is
// included because it carries PLATFORM_CSS (the theme/legal/footer styles) and
// the build is bound never to restyle the shell — it is platform-owned.
// `project` feeds the branding seed only (src/platform/branding.ts bakes the
// app's own name). Passing it matters on an upgrade: an app provisioned before
// v8 carries the "Application" placeholder in its branding row, and the file
// written here is what adopts the project name on the next boot.
export function currentPlatformFiles(project = null) {
  const pwa = scaffoldPwaFiles();
  return [
    ...buildPlatformFiles(project),
    ...buildPlatformRoutes(),
    { path: 'public/base.css', content: baseCss() + PLATFORM_CSS },
    // sw.js and install.js are platform plumbing too: the push handlers and the
    // one-time install modal reach an EXISTING project only through this.
    { path: 'public/sw.js', content: pwa.swJs },
    { path: 'public/install.js', content: pwa.installJs },
    // Browser tests: an existing project gets the runner, the self-starting
    // server and the platform spec. Its OWN specs under e2e/ are never touched.
    { path: 'playwright.config.ts', content: playwrightConfigTs() },
    { path: 'scripts/e2e-server.mjs', content: e2eServerMjs() },
    { path: 'e2e/platform.spec.ts', content: platformSpecTs() },
  ];
}

async function readContainerFile(containerName, relPath) {
  const r = await containerSh(containerName, `cat '${APP_DIR}/${relPath}' 2>/dev/null`);
  return r.code === 0 ? (r.stdout || '') : '';
}

// Which platform-owned paths this project actually has — decides whether the
// auth-dependent routes.ts is in scope.
async function presentPlatformPaths(containerName) {
  const all = [...PLATFORM_OWNED_ALWAYS, ...PLATFORM_OWNED_IF_PRESENT];
  const script = all.map((p) => `[ -f '${APP_DIR}/${p}' ] && echo '${p}'`).join('\n');
  const r = await containerSh(containerName, `${script}\nexit 0`);
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// baseAppUpgradeStatus — what the UI shows: installed vs current, and whether
// an upgrade is available. Never throws; an unreachable container reports
// "unknown" rather than inventing an answer.
export async function baseAppUpgradeStatus(project) {
  const current = { scaffold: MOCK2_SCAFFOLD_VERSION, platform: PLATFORM_MODULE_VERSION };
  if (!project?.container_name || project.lifecycle !== 'active') {
    return { ok: false, reason: 'The project is not online.', current, installed: null, upgrade_available: false };
  }
  try {
    const installed = parsePlatformVersionFile(await readContainerFile(project.container_name, PLATFORM_VERSION_PATH));
    const present = await presentPlatformPaths(project.container_name);
    const plan = planBaseAppUpgrade({
      installed,
      currentScaffoldVersion: current.scaffold,
      currentPlatformVersion: current.platform,
      candidates: currentPlatformFiles(project),
      present,
    });
    return {
      ok: true,
      current,
      installed: installed || null,
      upgrade_available: plan.needed,
      first_time: plan.firstTime,
      paths: plan.paths,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || 'could not read the project', current, installed: null, upgrade_available: false };
  }
}

// upgradeBaseApp — write the platform-owned files, stamp the version, commit.
//
// Deploy is NOT run here: the new files are TypeScript that has to compile with
// the app around them, and the deploy pipeline belongs to the build/deploy
// path. The caller decides (the route redeploys; the auto-hook leaves it to
// the next build, so an upgrade never restarts a serving app on its own).
export async function upgradeBaseApp(project, { initiatedBy = null, reason = 'manual' } = {}) {
  const containerName = project?.container_name;
  if (!containerName || project.lifecycle !== 'active') {
    return { ok: false, error: 'The project is not online.' };
  }
  const current = { scaffold: MOCK2_SCAFFOLD_VERSION, platform: PLATFORM_MODULE_VERSION };
  const installed = parsePlatformVersionFile(await readContainerFile(containerName, PLATFORM_VERSION_PATH));
  const present = await presentPlatformPaths(containerName);
  const plan = planBaseAppUpgrade({
    installed,
    currentScaffoldVersion: current.scaffold,
    currentPlatformVersion: current.platform,
    candidates: currentPlatformFiles(project),
    present,
  });
  if (!plan.needed) return { ok: true, changed: false, plan, message: upgradeSummary(plan) };

  // Write each file with its payload on STDIN — the platform sources run to
  // tens of KB and an argv-inlined heredoc is how the seed hit E2BIG.
  const written = [];
  for (const f of plan.files) {
    const script = `d="${APP_DIR}/${f.path}"; mkdir -p "$(dirname "$d")"; base64 -d > "$d"`;
    const r = await containerShWithStdin(containerName, script, b64(f.content), { timeoutMs: 60000 });
    if (r.code !== 0) {
      return { ok: false, error: `could not write ${f.path}: ${(r.stderr || r.stdout || '').trim().slice(-300)}` };
    }
    written.push(f.path);
  }
  // The one additive touch to an application-owned file: without the
  // devDependency and the scripts, the Playwright config we just wrote cannot
  // be run. Declines silently on an unparseable package.json rather than
  // rewriting something we did not understand.
  try {
    const pkgSource = await readContainerFile(containerName, 'package.json');
    if (pkgSource) {
      const merged = mergeE2ePackageJson(pkgSource, { scripts: E2E_SCRIPTS, devDependencies: E2E_DEV_DEPENDENCIES });
      if (merged.changed) {
        const pScript = `d="${APP_DIR}/package.json"; base64 -d > "$d"`;
        const pr = await containerShWithStdin(containerName, pScript, b64(merged.content), { timeoutMs: 30000 });
        if (pr.code === 0) written.push('package.json');
      }
    }
  } catch (e) {
    console.warn(`[mock2] could not add the e2e scripts to package.json for project ${project.id}:`, e?.message);
  }

  const marker = renderPlatformVersionFile({
    scaffoldVersion: current.scaffold, platformVersion: current.platform, at: new Date().toISOString(),
  });
  const mScript = `d="${APP_DIR}/${PLATFORM_VERSION_PATH}"; mkdir -p "$(dirname "$d")"; base64 -d > "$d"`;
  await containerShWithStdin(containerName, mScript, b64(marker), { timeoutMs: 30000 });

  // Commit so the upgrade rides the project's history and survives rehydrate.
  const commit = `cd '${APP_DIR}' && git add -A && `
    + `git -c user.email=platform@proxypilot -c user.name=ProxyPilot commit -m 'base app: platform module ${current.platform}' 2>&1 || true`;
  await containerSh(containerName, commit, { timeoutMs: 60000 }).catch(() => undefined);

  const message = upgradeSummary(plan);
  try { insertMessage({ projectId: project.id, kind: 'system', body: message }); } catch { /* best effort */ }
  console.log(`[mock2] base app upgraded for project ${project.id} (${reason}): ${written.length} files → ${current.platform}`);
  return { ok: true, changed: true, plan, written, message, initiatedBy };
}

// maybeUpgradeBaseApp — the automatic hook. Called when a project comes online
// and before a build starts, so a project picks up base-app improvements
// without anyone remembering to press anything. Best-effort and SILENT when
// there is nothing to do; a failure is logged and never blocks the caller.
const upgrading = new Set();
export async function maybeUpgradeBaseApp(projectId, { reason = 'auto' } = {}) {
  const id = Number(projectId);
  if (!Number.isFinite(id) || upgrading.has(id)) return { ok: false, skipped: 'busy' };
  upgrading.add(id);
  try {
    const project = getProject(id);
    if (!project || project.lifecycle !== 'active') return { ok: false, skipped: 'not_online' };
    const res = await upgradeBaseApp(project, { reason });
    if (!res.ok) console.warn(`[mock2] base-app auto-upgrade for project ${id} failed: ${res.error}`);
    // The e2e browser, BEFORE the gate battery.
    //
    // The install lives in the deploy, and gates run BEFORE the deploy — so on
    // a project whose base app was deployed before this feature existed the
    // browser never arrives, and the e2e gate skips forever. Project 39's build
    // wrote 84 lines of real Playwright specs and not one of them ran.
    // This hook is the one that fires before every build, which is exactly
    // where the browser needs to already be. Best-effort and idempotent: it
    // returns immediately once the browser cache is populated.
    try {
      const { ensureE2eBrowser } = await import('./deploy.js');
      await ensureE2eBrowser(project);
    } catch (e) {
      console.warn(`[mock2] e2e browser check for project ${id} skipped:`, e?.message);
    }
    // The project's own logo as the app's favicon, home-screen icon and
    // manifest icon. Here rather than in the scaffold because the logo usually
    // arrives AFTER the app was first provisioned — the operator uploads it
    // during the design stage — and because a rename should move the
    // home-screen label too. Idempotent (the page links are fenced) and
    // best-effort: no usable logo keeps the scaffold's mark and is not an
    // error.
    try {
      const { applyProjectIcons } = await import('./project-icons.js');
      const icons = await applyProjectIcons(project);
      if (icons.state === 'applied') console.log(`[mock2] project ${id} icons: ${icons.reason}`);
      else if (!icons.ok) console.warn(`[mock2] project ${id} icons: ${icons.reason}`);
    } catch (e) {
      console.warn(`[mock2] project ${id} icon apply skipped:`, e?.message);
    }
    return res;
  } catch (e) {
    console.warn(`[mock2] base-app auto-upgrade for project ${id} threw:`, e?.message);
    return { ok: false, error: e?.message };
  } finally {
    upgrading.delete(id);
  }
}
