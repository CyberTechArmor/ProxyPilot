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
  'migrations/0100_platform.sql',
  'public/theme.js',
  'public/platform.js',
  'public/platform-admin.js',
  'public/base.css',
]);

export const PLATFORM_OWNED_IF_PRESENT = Object.freeze([
  'src/platform/routes.ts',
]);

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
