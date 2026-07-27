// Base-app upgrade — the PURE half (risk R9: no container, no DB, no native
// module), so the "what would this upgrade touch, and is one needed" decision
// is testable on any host.
//
// WHY THIS EXISTS. The scaffold declared MOCK2_SCAFFOLD_VERSION and NOTHING
// read it. A project was seeded once at provision and then frozen: every later
// improvement to the base app — theme, branding, legal pages, the asset
// library, machine API keys, read-only SQL — reached new projects only. The
// premise "the base app is continuously updated, so builds should lean on it"
// was false for every project that already existed.
//
// THE RULE THAT MAKES THIS SAFE. An upgrade re-emits PLATFORM-OWNED files
// only, and never application code. The build is told (runner-logic's
// PLATFORM_SECTION) that src/platform is load-bearing and must be extended
// rather than edited, and the platform-intact gate enforces it — so
// overwriting those paths cannot destroy work the app was supposed to keep.
// Anything outside this list is the app's, and the upgrade must not touch it.

// The version marker that rides in the project repo. Kept in state/ (not
// package.json) so it survives rehydrate, travels in the hash-chained history,
// and is readable without parsing the app's own manifest.
export const PLATFORM_VERSION_PATH = 'state/platform-version.json';

export function renderPlatformVersionFile({ scaffoldVersion, platformVersion, at = null }) {
  return `${JSON.stringify({
    schema_version: 1,
    scaffold_version: String(scaffoldVersion || ''),
    platform_version: String(platformVersion || ''),
    updated_at: at || null,
  }, null, 2)}\n`;
}

export function parsePlatformVersionFile(text) {
  try {
    const doc = JSON.parse(String(text || ''));
    if (!doc || typeof doc !== 'object') return null;
    return {
      scaffold_version: String(doc.scaffold_version || ''),
      platform_version: String(doc.platform_version || ''),
      updated_at: doc.updated_at || null,
    };
  } catch {
    return null;
  }
}

// The paths an upgrade owns. Two tiers:
//   always   — emitted whether or not they already exist.
//   ifPresent— only replaced when the project already has them, because their
//              presence depends on how the project was scaffolded
//              (src/platform/routes.ts ships only with the auth wiring).
export const PLATFORM_OWNED_ALWAYS = Object.freeze([
  'src/platform/schema.ts',
  'src/platform/branding.ts',
  'src/platform/api-keys.ts',
  'src/platform/api-key-auth.ts',
  'src/platform/readonly.ts',
  // Web Push + the install invitation (v4). Platform-owned: three RFCs of
  // silent-failure crypto is not something a build should carry.
  'src/platform/push.ts',
  'migrations/0100_platform.sql',
  'public/theme.js',
  'public/platform.js',
  'public/platform-admin.js',
  'public/push.js',
  'public/base.css',
  // The PWA plumbing: sw.js gained the push/notificationclick handlers and
  // install.js became a one-time modal instead of a permanent floating pill,
  // so an existing project needs both rewritten to get the feature.
  'public/sw.js',
  'public/install.js',
  // The browser-test plumbing (v5). The CONFIG and the server script are
  // platform-owned; so is platform.spec.ts, which asserts the base app's own
  // guarantees and says so in its header — a build that edits it to make a
  // change pass is doing the wrong thing, and its own specs go in other files
  // under e2e/, which this never touches.
  'playwright.config.ts',
  'scripts/e2e-server.mjs',
  'e2e/platform.spec.ts',
]);

export const PLATFORM_OWNED_IF_PRESENT = Object.freeze([
  'src/platform/routes.ts',
]);

// mergeE2ePackageJson — the ONE application-owned file the upgrade may touch,
// and only additively.
//
// An existing project that receives playwright.config.ts still has a
// package.json with no @playwright/test and no test:e2e script, so the runner
// it just received cannot run — the gate would skip forever with "npm install"
// as advice that does not help. This adds the missing devDependency and the
// missing scripts and NOTHING else: an existing entry always wins (the project
// may have pinned a version or wired its own script), and a package.json that
// already has them comes back unchanged so the upgrade reports no diff.
//
// Pure and total: returns { changed, content } and never throws on malformed
// JSON — it declines instead, because rewriting a file we could not parse is
// how an upgrade destroys a project.
export function mergeE2ePackageJson(source, { scripts = {}, devDependencies = {} } = {}) {
  let pkg;
  try { pkg = JSON.parse(String(source || '')); } catch { return { changed: false, content: null, reason: 'package.json is not valid JSON' }; }
  if (!pkg || typeof pkg !== 'object') return { changed: false, content: null, reason: 'package.json is not an object' };

  let changed = false;
  const nextScripts = { ...(pkg.scripts || {}) };
  for (const [k, v] of Object.entries(scripts)) {
    if (nextScripts[k] === undefined) { nextScripts[k] = v; changed = true; }
  }
  const nextDev = { ...(pkg.devDependencies || {}) };
  for (const [k, v] of Object.entries(devDependencies)) {
    if (nextDev[k] === undefined) { nextDev[k] = v; changed = true; }
  }
  if (!changed) return { changed: false, content: null, reason: 'already present' };

  // Preserve key order: rebuilding the object from scratch would reorder the
  // whole file and turn a two-line addition into an unreviewable diff.
  const out = { ...pkg, scripts: nextScripts, devDependencies: nextDev };
  return { changed: true, content: `${JSON.stringify(out, null, 2)}\n` };
}

export function isPlatformOwnedPath(p) {
  return PLATFORM_OWNED_ALWAYS.includes(p) || PLATFORM_OWNED_IF_PRESENT.includes(p);
}

// planBaseAppUpgrade — decide whether an upgrade is needed and which of the
// candidate files it would write.
//
// installed: parsed state/platform-version.json, or null for a project seeded
//            before the marker existed (that is still an upgrade — it is
//            exactly the population that is missing the most).
// candidates: [{ path, content }] from the scaffold generators.
// present:   the set/array of platform-owned paths that exist in the project.
export function planBaseAppUpgrade({
  installed = null,
  currentScaffoldVersion = '',
  currentPlatformVersion = '',
  candidates = [],
  present = [],
} = {}) {
  const have = new Set(present || []);
  const files = (candidates || []).filter((f) => {
    if (PLATFORM_OWNED_ALWAYS.includes(f.path)) return true;
    if (PLATFORM_OWNED_IF_PRESENT.includes(f.path)) return have.has(f.path);
    return false; // never write anything outside the owned list
  });

  const from = installed
    ? { scaffold: installed.scaffold_version, platform: installed.platform_version }
    : { scaffold: null, platform: null };
  const to = { scaffold: String(currentScaffoldVersion), platform: String(currentPlatformVersion) };
  const upToDate = !!installed
    && installed.scaffold_version === to.scaffold
    && installed.platform_version === to.platform;

  return {
    needed: !upToDate,
    // A project with no marker at all predates the platform module; say so
    // rather than reporting an upgrade "from null", which reads like a bug.
    firstTime: !installed,
    from,
    to,
    files,
    paths: files.map((f) => f.path),
  };
}

// The chat/receipt line. Deliberately names what did NOT change: the whole
// point is that an operator can accept this without auditing their app.
export function upgradeSummary(plan) {
  if (!plan?.needed) return 'The base app is already up to date.';
  const n = plan.paths.length;
  const lead = plan.firstTime
    ? 'Installed the base-app platform module for the first time'
    : `Updated the base app from ${plan.from.platform || 'an untracked version'} to ${plan.to.platform}`;
  return `${lead} — ${n} platform file${n === 1 ? '' : 's'} rewritten `
    + `(${plan.paths.slice(0, 4).join(', ')}${n > 4 ? `, +${n - 4} more` : ''}). `
    + 'No application code was touched: the upgrade only rewrites platform-owned paths '
    + '(theme, branding, legal pages, assets, API keys, read-only SQL and the shared shell stylesheet). '
    + 'Run a build to redeploy.';
}
