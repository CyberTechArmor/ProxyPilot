// Storage classification (pure, the heart of the storage check). Turns the
// read-only facts (guest scan, host measures) into items with a category, a
// status and a plain-language reason.
//
// The default is "Needs a look" (investigate): an item becomes "Can be
// cleaned up" (eligible) only when a rule recognises it by location AND
// name/marker AND, where stated, age / not in use / not tracked. Size and
// age alone never make anything eligible. Everything the running application
// needs (the live release, the rollback release, a waiting candidate, the
// roots that back shared data, preserved paths, settings, databases) is
// protected.

import { createHash } from 'node:crypto';
import { categoryLabel } from './categories.js';
import { computeTotals, summarizeCategories, formatBytes } from './accounting.js';
import { HOST_TRANSFER_ROOT } from './host-measures.js';
import { releaseContextFromApplication, ROLLBACK_UNKNOWN_REASON } from '../setup-engine/application-release-cleanup.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const RELEASE_NAME_RE = /^[a-f0-9]{40}-p[1-9][0-9]*-[a-f0-9-]{36}$/;
export const ATTEMPT_RE = /^[a-f0-9-]{36}-[1-9][0-9]*$/;
export const BUNDLE_RE = /^[a-f0-9-]{36}-[1-9][0-9]*\.bundle$/;
export const DATABASE_DIRS = Object.freeze(['/var/lib/postgresql', '/var/lib/mysql', '/var/lib/redis', '/var/lib/mongodb']);
export const TEST_REPORT_DIRS = Object.freeze(['test-results', 'playwright-report', 'coverage', '.nyc_output']);
export const KNOWN_LOG_DIRS = Object.freeze(['postgresql', 'nginx', 'apt', 'mysql', 'redis', 'caddy', 'apache2', 'mongodb', 'installer', 'unattended-upgrades']);
// /var/lib children that belong to the operating system or its packages.
const SYSTEM_VAR_LIB = new Set(['apt', 'dpkg', 'systemd', 'ucf', 'pam', 'polkit-1', 'dbus', 'dhcp', 'misc', 'private', 'sudo', 'logrotate', 'sgml-base', 'xml-core', 'python', 'man-db', 'vim', 'os-prober', 'update-rc.d', 'ca-certificates', 'shells.state', 'lxcfs', 'cloud', 'initramfs-tools', 'usbutils', 'pcrlock.d', 'emacsen-common', 'git', 'locales', 'update-notifier', 'ubuntu-advantage', 'snapd', 'command-not-found', 'plymouth', 'udisks2', 'upower', 'nftables', 'iptables', 'machines', 'portables', 'hp', 'ispell', 'aspell', 'dictionaries-common', 'tpm', 'chrony', 'ntp', 'ntpsec', 'openssh', 'sss', 'krb5kdc']);
export const GROUP_THRESHOLD = 5;
const TEMP_MIN_AGE_MS = DAY;
const WORKSPACE_MIN_AGE_MS = HOUR;
const ROTATED_MIN_AGE_MS = 7 * DAY;
// A current (not rotated) log nothing has written for this long and nothing
// holds open is a leftover worth a look (never cleaned up automatically).
export const IDLE_LOG_MS = 14 * DAY;
// The system's own records stay protected however quiet they are: the
// package manager's and installer's logs, and the login records (no .log).
const SYSTEM_LOG_NAMES = new Set(['dpkg.log', 'alternatives.log', 'bootstrap.log', 'cloud-init.log', 'cloud-init-output.log', 'fontconfig.log']);
const SYSTEM_LOG_DIRS = new Set(['/var/log/apt', '/var/log/installer', '/var/log/unattended-upgrades', '/var/log/dist-upgrade']);
const EVIDENCE_MIN_AGE_MS = 14 * DAY;
const HISTORY_KEEP = 2;

const inside = (root, p) => typeof root === 'string' && typeof p === 'string' && (p === root || p.startsWith(`${root === '/' ? '' : root}/`));
const dirname = (p) => { const i = String(p).lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const basename = (p) => String(p).slice(String(p).lastIndexOf('/') + 1);
const nowOf = (now) => (typeof now === 'function' ? now() : now == null ? Date.now() : Number(now));
const dateText = (ms) => { if (!Number.isFinite(ms)) return 'an unknown date'; const d = new Date(ms); return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`; };

/* ------------------------------ the scan plan ------------------------------ */

/**
 * The fixed roots the guest collector measures for a target, in the order the
 * hard-link dedupe should credit them: data and preserved paths first, then
 * releases, then everything else. Paths come from the saved profile and the
 * fixed layout, never from a request.
 */
export function scanPlanFor(target, { budget = { ms: 60_000, entries: 2_000_000 } } = {}) {
  const roots = [];
  const add = (path, depth, role, extra = {}) => { if (typeof path === 'string' && (path.startsWith('/') || path.startsWith('~service/'))) roots.push({ path, depth, role, ...extra }); };
  const tracked = [];
  const resolve = [];
  let service = null;
  let releases = null;
  if (target.kind === 'application') {
    const p = target.profile || {};
    service = p.serviceName || null;
    if (p.sourceDir) resolve.push(p.sourceDir);
    for (const x of p.preservePaths || []) { add(x, 0, 'preserve', { resolve: true }); resolve.push(x); }
    for (const x of p.envFiles || []) { add(x, 0, 'env', { resolve: true }); resolve.push(x); }
    for (const d of DATABASE_DIRS) add(d, 0, 'database');
    add('/usr', 0, 'os');
    add('/var/lib/dpkg', 0, 'os');
    if (p.releaseRoot) {
      // The release roles are decided in the guest by describeReleases, the
      // one definition the release job and the cleanup also run, from the
      // records' facts (the previous release from the deploy history).
      if (p.sourceDir) releases = { profile: { sourceDir: p.sourceDir, releaseRoot: p.releaseRoot, preservePaths: [...(p.preservePaths || [])], envFiles: [...(p.envFiles || [])] }, ...releaseContextFromApplication(target, { root: p.releaseRoot, ...('previousLive' in target ? { previousLive: target.previousLive ?? null } : {}) }) };
      add(p.releaseRoot, 1, 'release-root', { marker: true, breakdown: ['node_modules', 'release-evidence', 'test-results'] });
      add(`${p.releaseRoot}/.staging`, 1, 'staging');
      if (p.sourceDir) add(p.sourceDir, 0, 'live', { resolve: true, breakdown: ['node_modules', 'release-evidence', 'test-results'] });
    } else if (p.sourceDir) {
      for (const d of TEST_REPORT_DIRS) add(`${p.sourceDir}/${d}`, 0, 'test-report');
      tracked.push({ repo: p.sourceDir, paths: [...TEST_REPORT_DIRS] });
      add(p.sourceDir, 0, 'app-dir', { breakdown: ['node_modules', 'dist'] });
    }
  } else {
    service = 'mock2-dev.service';
    const app = target.appDir || '/srv/app';
    add(`${app}/state/db`, 0, 'project-data');
    add(`${app}/data`, 0, 'project-data');
    for (const d of DATABASE_DIRS) add(d, 0, 'database');
    add('/usr', 0, 'os');
    add('/var/lib/dpkg', 0, 'os');
    add(`${app}/.mock2/cache`, 0, 'project-cache');
    add(`${app}/.mock2/evidence`, 1, 'evidence');
    for (const d of TEST_REPORT_DIRS) add(`${app}/${d}`, 0, 'test-report');
    tracked.push({ repo: app, paths: [...TEST_REPORT_DIRS] });
    add(app, 0, 'app-dir', { breakdown: ['node_modules', 'dist'] });
    add(target.repoMount || '/srv/repo.git', 0, 'repo-mount');
  }
  add('~service/.npm', 1, 'cache', { match: '^(_cacache|_npx)$' });
  add('~service/.cache', 1, 'cache');
  add('/root/.npm', 1, 'cache', { match: '^(_cacache|_npx)$' });
  add('/root/.cache', 1, 'cache');
  add('/var/cache/apt/archives', 1, 'cache-apt', { match: '\\.deb$' });
  add('/tmp', 1, 'temp');
  add('/var/tmp', 1, 'temp');
  add('/var/log/journal', 0, 'journal');
  for (const d of KNOWN_LOG_DIRS) add(`/var/log/${d}`, 1, 'log');
  add('/var/log', 1, 'log');
  add('/var/backups/proxypilot-db', 1, 'db-dump');
  add('/etc/systemd/system', 1, 'unit-copy', { match: '\\.pre-' });
  add('/etc', 1, 'env-copy', { match: '^environment\\.pre-' });
  add('/run/mock2-deploy', 1, 'containment');
  for (const d of ['/opt', '/srv', '/home', '/var/lib']) add(d, 1, 'other', { gitLinks: true });
  return { roots, resolve, tracked, service, ...(releases ? { releases } : {}), statfs: ['/', '/tmp', '/var/tmp', '/run'], procScan: true, journal: true, budget, maxItems: 20_000, maxChildren: 5_000 };
}

/* -------------------------------- context --------------------------------- */

function itemsOfRole(facts, role) {
  const roots = facts?.roots || [];
  return (facts?.items || []).filter((it) => roots[it.r]?.role === role);
}

export function isSealedRelease(it) {
  return it?.type === 'dir' && RELEASE_NAME_RE.test(it.name || basename(it.path)) && Number(it.uid) === 0 && !(Number(it.mode) & 0o022) && it.marker?.present === true && !it.marker.unsafe;
}

/**
 * What must stay, derived from the target's records and the facts:
 * { liveRelease, rollbackRelease, waitingCandidate, backingRoots,
 *   releasesKnown, releasesUnknown, rollbackUnknown, keptReleases,
 *   pendingReleases, sealedReleases, activeAttempts, recoveryAttempts, buildActive,
 *   openRestoreJob, anyApplicationJobOpen, openJobIds }.
 * The release roles come only from describeReleases' answer in the facts
 * (facts.releases); without one, no release is cleanable and the live
 * release and backing roots are named for the labels only.
 */
export function buildContext({ target, activity = {}, facts = null } = {}) {
  const ctx = { liveRelease: null, rollbackRelease: null, waitingCandidate: null, backingRoots: [], releasesKnown: false, releasesUnknown: null, rollbackUnknown: false, keptReleases: [], sealedReleases: [], activeAttempts: [...(activity.activeAttempts || [])], recoveryAttempts: [...(activity.recoveryAttempts || [])], buildActive: !!activity.buildActive, openRestoreJob: !!activity.openRestoreJob, anyApplicationJobOpen: !!activity.anyApplicationJobOpen, openJobIds: [...(activity.openJobIds || [])] };
  if (target?.kind !== 'application' || !facts) return ctx;
  const p = target.profile || {};
  const rel = facts.releases;
  if (rel && rel.ok === true) {
    ctx.releasesKnown = true;
    ctx.liveRelease = rel.live || null;
    ctx.rollbackRelease = rel.rollback || null;
    ctx.waitingCandidate = rel.waiting || null;
    ctx.backingRoots = [...(rel.backing || [])].sort();
    ctx.rollbackUnknown = !!rel.rollbackUnknown;
    ctx.keptReleases = [...(rel.protect || [])];
    ctx.pendingReleases = [...(rel.pending || [])];
    // A validation still running is recorded as not passed until it ends;
    // while its job is open the release is being validated, not rejected.
    const open = new Set(ctx.openJobIds);
    for (const c of target.candidates || []) {
      const v = c?.validation;
      if (v && v.passed !== true && v.jobId && open.has(v.jobId) && typeof v.releasePath === 'string' && !ctx.pendingReleases.includes(v.releasePath)) ctx.pendingReleases.push(v.releasePath);
    }
    ctx.sealedReleases = (rel.sealed || []).map((r) => r.path);
    return ctx;
  }
  ctx.releasesUnknown = p.releaseRoot ? (rel?.code || 'NOT_DESCRIBED') : null;
  const live = p.sourceDir ? facts.resolved?.[p.sourceDir] : null;
  if (live?.exists && live.realpath) ctx.liveRelease = live.realpath;
  const releaseItems = itemsOfRole(facts, 'release-root');
  const root = releaseItems.length ? dirname(releaseItems[0].path) : (p.releaseRoot || null);
  // Backing roots (labels only here): the release-root child holding the real path of a preserved path or env file.
  if (root) {
    const backing = new Set();
    for (const x of [...(p.preservePaths || []), ...(p.envFiles || [])]) {
      const real = facts.resolved?.[x]?.realpath;
      if (!real || !inside(root, real) || real === root) continue;
      backing.add(`${root}/${real.slice(root.length + 1).split('/')[0]}`);
    }
    ctx.backingRoots = [...backing].sort();
  }
  return ctx;
}

// Why the release roles are not known, in plain words (describeReleases' refusals).
const RELEASES_UNKNOWN_REASONS = {
  RETENTION_REQUIRES_SYMLINK_LAYOUT: 'The application does not run through a link into its release folder, so which release is which cannot be told; no release is cleaned up.',
  UNSAFE_RETENTION_ROOT: 'The release folder is not owned by root or can be changed by other accounts, so no release is cleaned up.',
  LIVE_RELEASE_OUTSIDE_ROOT: 'The application runs from outside its release folder, so which release is which cannot be told; no release is cleaned up.',
};
const releasesUnknownReason = (code) => RELEASES_UNKNOWN_REASONS[code] || 'Which release is which could not be worked out in the container, so no release is cleaned up.';

/* ------------------------------ item building ----------------------------- */

const kindOf = (it) => ({ dir: 'directory', file: 'file', link: 'link', other: 'other' }[it.type] || 'other');

// A walk cut short by the budget, or one with unreadable parts, does not know
// how recently its contents changed: an age rule can never decide for it.
const AGE_ROLES = new Set(['temp', 'staging', 'evidence', 'log', 'host-transfers']);
export function unknownAgeReason(it) {
  if (it?.partial) return 'Too large to measure fully here, so how recently it changed is unknown.';
  if (Number(it?.inaccessible) > 0) return 'Parts of it could not be read, so how recently it changed is unknown.';
  return null;
}
function ageGuard(cls, it, role) {
  if (!cls || cls.status !== 'eligible' || !AGE_ROLES.has(role)) return cls;
  const why = unknownAgeReason(it);
  return why ? { ...cls, status: 'investigate', reason: why, action: null } : cls;
}

function unreadableHint(it) {
  const n = Number(it.inaccessible || 0);
  if (!n) return null;
  const paths = (it.inaccessiblePaths || []).slice(0, 3);
  return `${n === 1 ? 'One part' : `${n} parts`} could not be read and ${n === 1 ? 'is' : 'are'} not counted${paths.length ? `: ${paths.join(', ')}${n > paths.length ? ', …' : ''}` : ''}.`;
}

function fileItem(it, root, cls) {
  const status = cls.status;
  const unreadable = unreadableHint(it);
  return {
    id: null,
    category: cls.category,
    label: cls.label || it.path,
    path: it.path,
    kind: cls.kind || kindOf(it),
    sub: cls.sub || null,
    status,
    reason: cls.reason,
    hint: [cls.hint, unreadable].filter(Boolean).join(' ') || null,
    logicalBytes: Number(it.logicalBytes || 0),
    allocatedBytes: Number(it.allocatedBytes || 0),
    files: Number(it.files || 0),
    newestMtimeMs: Number.isFinite(it.newestMtimeMs) ? it.newestMtimeMs : (Number.isFinite(it.mtimeMs) ? it.mtimeMs : null),
    precision: it.partial || Number(it.inaccessible || 0) > 0 ? 'at-least' : 'exact',
    hardLinkedBytes: Number(it.hardLinkedBytes || 0),
    memoryBacked: !!it.memoryBacked,
    action: status === 'eligible' ? (cls.action || 'remove') : null,
    location: cls.location || 'guest',
    root: root?.path || null,
    identity: { type: it.type || null, dev: it.dev ?? null, ino: it.ino ?? null, mtimeMs: it.mtimeMs ?? null, birthtimeMs: it.birthtimeMs ?? null, size: it.size ?? null, uid: it.uid ?? null, ...(cls.identity || {}) },
    inUse: !!it.inUse,
    dev: it.dev ?? null,
    crossesDevice: !!it.crossesDevice,
    sharedBytes: Number(it.sharedBytes || 0),
    inaccessible: Number(it.inaccessible || 0),
    ...(it.inaccessiblePaths ? { inaccessiblePaths: it.inaccessiblePaths } : {}),
    ...(cls.breakdown ? { breakdown: cls.breakdown } : {}),
    ...(cls.extra || {}),
  };
}

const BREAKDOWN_LABELS = { node_modules: 'Dependencies (node_modules)', 'release-evidence': 'Release evidence', 'test-results': 'Test results', dist: 'Build output (dist)' };
const breakdownOf = (it) => (it.breakdown || []).map((b) => ({ label: BREAKDOWN_LABELS[b.name] || b.name, name: b.name, allocatedBytes: Number(b.allocatedBytes || 0), logicalBytes: Number(b.logicalBytes || 0) }));
const tooYoung = (it, now, ms) => !Number.isFinite(it.newestMtimeMs) || it.newestMtimeMs > now - ms;

/* -------------------------------- the rules ------------------------------- */

export const HOLD_PREFIX = '.pp-cleanup-hold-';
const HOLD_CLASS = { category: 'other', status: 'investigate', sub: 'held', reason: 'Set aside by an earlier cleanup because it changed while the cleanup ran; check it before removing it.' };

// Why a build keeps an item: running, or interrupted and waiting for recovery.
function buildBusyReason(context) {
  const recovering = context?.recoveryAttempts || [];
  const running = (context?.activeAttempts || []).some((a) => !recovering.includes(a));
  return recovering.length && !running ? 'A build was interrupted and still needs recovery.' : 'A build is running.';
}

function classifyGuestItem(it, root, env) {
  const { target, context, now, facts } = env;
  const role = root?.role;
  const svcUid = facts?.service?.uid;
  if (it.missing) return null;
  // Never cleanable, whatever folder it sits in.
  if ((it.name || basename(it.path)).startsWith(HOLD_PREFIX)) return HOLD_CLASS;
  switch (role) {
    case 'preserve': {
      const models = /model/i.test(root.declared || it.path) || /model/i.test(it.path);
      // Labelled with the path the profile names; where it really lives is the detail.
      const moved = root.declared && root.declared !== it.path;
      return { category: 'data', status: 'protected', sub: models ? 'models' : 'data', label: moved ? root.declared : null, reason: models ? 'Model files the application uses; kept across releases.' : 'Application data kept across releases.', hint: moved ? `Stored at ${it.path} (the path above links there).` : null };
    }
    case 'env':
      return { category: 'data', status: 'protected', sub: 'settings', reason: 'Settings and secrets (contents are never read).' };
    case 'database':
      return { category: 'data', status: 'protected', sub: 'database', reason: 'Database files.' };
    case 'project-data':
      return { category: 'data', status: 'protected', sub: it.path.endsWith('/state/db') ? 'database' : 'data', reason: it.path.endsWith('/state/db') ? "The project's database snapshot, kept with its source." : 'Application data.' };
    case 'os':
      return { category: 'dependencies', status: 'protected', reason: 'Operating system and installed packages.' };
    case 'release-root':
      return classifyReleaseChild(it, env);
    case 'live':
      if (it.type === 'link') return null;
      return { category: 'running_app', status: 'protected', reason: 'The application is running from here.', breakdown: breakdownOf(it), hint: it.breakdown?.length ? 'Its dependencies, evidence and test results are part of it and are removed only with it.' : null };
    case 'app-dir':
      return { category: 'running_app', status: 'protected', reason: 'The running application (its working copy, dependencies and build output).', breakdown: breakdownOf(it) };
    case 'staging':
      return classifyStaging(it, env);
    case 'test-report': {
      const repo = target.kind === 'project' ? (target.appDir || '/srv/app') : target.profile?.sourceDir;
      const rel = repo && inside(repo, it.path) ? it.path.slice(repo.length + 1) : it.name;
      const t = facts?.tracked?.[repo];
      if (!t || !t.ok) return { category: 'test_reports', status: 'investigate', reason: 'Could not check whether Git tracks it, so it is left for you to look at.' };
      if (t.paths.some((x) => x === rel || x.startsWith(`${rel}/`))) return { category: 'test_reports', status: 'protected', reason: 'Part of the source (tracked in Git).' };
      if (context.buildActive) return { category: 'test_reports', status: 'protected', reason: buildBusyReason(context) };
      if (it.inUse) return { category: 'test_reports', status: 'protected', reason: 'In use by a running process.' };
      return { category: 'test_reports', status: 'eligible', reason: 'Test output that the next test run writes again.' };
    }
    case 'project-cache':
      if (context.buildActive) return { category: 'caches', status: 'protected', reason: buildBusyReason(context) };
      if (it.inUse) return { category: 'caches', status: 'protected', reason: 'In use by a running process.' };
      return { category: 'caches', status: 'eligible', reason: 'Check results the next check computes again.' };
    case 'evidence':
      if (context.buildActive) return { category: 'test_reports', status: 'protected', reason: buildBusyReason(context) };
      if (it.inUse) return { category: 'test_reports', status: 'protected', reason: 'In use by a running process.' };
      if (tooYoung(it, now, EVIDENCE_MIN_AGE_MS)) return { category: 'test_reports', status: 'protected', reason: 'Recent check results.' };
      return { category: 'test_reports', status: 'eligible', reason: 'An old check report.' };
    case 'repo-mount':
      if (it.crossesDevice || it.mountPoint) return null; // measured on the host instead
      return { category: 'data', status: 'protected', reason: "The project's source history, kept by ProxyPilot." };
    case 'cache': case 'cache-apt': {
      if (it.type === 'link') return { category: 'caches', status: 'investigate', reason: 'A link inside a cache folder (never followed).' };
      if (it.inUse) return { category: 'caches', status: 'protected', reason: 'In use by a running process.' };
      if (context.buildActive) return { category: 'caches', status: 'protected', reason: buildBusyReason(context) };
      const hint = it.name === 'ms-playwright' ? 'Tests download it again.' : null;
      return { category: 'caches', status: 'eligible', reason: role === 'cache-apt' ? 'A downloaded package file that is fetched again when needed.' : 'Downloaded files that are fetched again when needed.', hint };
    }
    case 'temp':
      return classifyTemp(it, env, svcUid);
    case 'journal': return null; // built separately (it has its own action)
    case 'log':
      return classifyLog(it, env);
    case 'db-dump': return null; // ranked as a group below
    case 'unit-copy': case 'env-copy': return null; // ranked as a group below
    case 'containment': {
      const open = (context.openJobIds || []).some((id) => id && (it.name === id || it.name.startsWith(`${id}.`)));
      if (open) return { category: 'history', status: 'protected', reason: 'Belongs to a job that is running.' };
      return { category: 'history', status: 'eligible', reason: 'A record of a finished job (tiny, in memory).' };
    }
    case 'other':
      return classifyOther(it, env);
    default:
      return { category: 'other', status: 'investigate', reason: 'Not recognised by any rule, so it is left for you to look at.' };
  }
}

function classifyReleaseChild(it, { context }) {
  const name = it.name || basename(it.path);
  // Sealed as describeReleases saw it when its answer is there (the same test).
  const sealed = context.releasesKnown ? (context.sealedReleases || []).includes(it.path) : isSealedRelease(it);
  const sha8 = it.marker?.sha ? it.marker.sha.slice(0, 8) : name.slice(0, 8);
  if (it.path === context.liveRelease) {
    return { category: 'running_app', status: 'protected', kind: 'release', sub: 'live', label: `Release ${sha8} (running now)`, reason: 'The release the application is running now.', breakdown: breakdownOf(it), hint: 'Inside a sealed release; its parts are removed only with the whole release.', identity: { markerSha: it.marker?.sha || null } };
  }
  if (context.backingRoots.includes(it.path)) {
    return { category: 'releases', status: 'protected', sub: 'backing', label: `${name} (holds shared data)`, reason: 'Holds shared data that newer releases link to (models). Most of it may be an old copy of the application; move the shared data out to let it be cleaned up.', identity: { markerSha: it.marker?.sha || null } };
  }
  if (it.type === 'link') return { category: 'other', status: 'investigate', reason: 'A link in the release folder (never followed).' };
  if (sealed) {
    const release = { category: 'releases', kind: 'release', breakdown: breakdownOf(it), identity: { markerSha: it.marker?.sha || null } };
    // Without describeReleases' answer nothing is decided here.
    if (!context.releasesKnown) return { ...release, status: 'protected', sub: 'unknown', label: `Release ${sha8}`, reason: releasesUnknownReason(context.releasesUnknown) };
    if (it.path === context.rollbackRelease) return { ...release, status: 'protected', sub: 'rollback', label: `Release ${sha8} (rollback)`, reason: 'Kept so you can roll back to the previous version.' };
    if (it.path === context.waitingCandidate) return { ...release, status: 'protected', sub: 'candidate', label: `Release ${sha8} (waiting to deploy)`, reason: 'A validated release waiting to be deployed.' };
    if ((context.pendingReleases || []).includes(it.path)) return { ...release, status: 'protected', sub: 'pending', label: `Release ${sha8} (being validated)`, reason: 'Its validation has no result yet, so it is kept.' };
    if (context.rollbackUnknown) return { ...release, status: 'protected', sub: 'rollback-unknown', label: `Release ${sha8}`, reason: ROLLBACK_UNKNOWN_REASON };
    if ((context.keptReleases || []).includes(it.path)) return { ...release, status: 'protected', sub: 'kept', label: `Release ${sha8}`, reason: 'Kept by the release process.' };
    return { ...release, status: 'eligible', sub: 'sealed', action: 'remove-release', label: `Release ${sha8}`, reason: 'An older release that is no longer needed for rollback.' };
  }
  if (RELEASE_NAME_RE.test(name)) return { category: 'other', status: 'investigate', reason: 'Looks like a release but is not sealed by ProxyPilot (no valid release marker or unexpected owner), so it is left for you to look at.' };
  return { category: 'other', status: 'investigate', reason: "Not created by ProxyPilot's release process." };
}

function classifyStaging(it, { context, now }) {
  const name = it.name || basename(it.path);
  if (it.type === 'link') return { category: 'workspaces', status: 'investigate', reason: 'A link in the build workspace folder (never followed).' };
  const attempt = ATTEMPT_RE.test(name) && it.type === 'dir' ? name : BUNDLE_RE.test(name) && it.type === 'file' ? name.slice(0, -'.bundle'.length) : null;
  if (!attempt) return { category: 'workspaces', status: 'investigate', reason: "Not created by ProxyPilot's build process." };
  const category = name.endsWith('.bundle') ? 'archives' : 'workspaces';
  const what = category === 'archives' ? 'A source archive' : 'A build workspace';
  if ((context.recoveryAttempts || []).includes(attempt)) return { category, status: 'protected', reason: 'Belongs to a build that was interrupted and still needs recovery.' };
  if (context.activeAttempts.includes(attempt)) return { category, status: 'protected', reason: 'A build is using it.' };
  if (tooYoung(it, now, WORKSPACE_MIN_AGE_MS)) return { category, status: 'protected', reason: 'Changed in the last hour; a build may still be finishing.' };
  return { category, status: 'eligible', reason: `${what} left behind by a build that has ended.`, extra: { attempt } };
}

function classifyTemp(it, { now }, svcUid) {
  const name = it.name || basename(it.path);
  // memoryBacked is on the item itself; the page shows it once.
  const base = { category: 'temp' };
  if (/^systemd-private-/.test(name)) return { ...base, status: 'protected', reason: 'Private temporary space of a system service.' };
  if (/^\.[A-Za-z0-9]+-unix$/.test(name)) return { ...base, status: 'protected', reason: 'A system folder.' };
  if (it.type === 'other') return { ...base, status: 'protected', reason: it.special === 'socket' ? 'A system socket.' : 'A special file (pipe or device).' };
  if (it.mountPoint || it.crossesDevice) return { ...base, status: 'protected', reason: 'A mount point.' };
  if (it.inUse) return { ...base, status: 'protected', reason: 'In use by a running process.' };
  if (!(Number(it.uid) === 0 || (svcUid != null && Number(it.uid) === Number(svcUid)))) return { ...base, status: 'protected', reason: 'Belongs to another account.' };
  if (tooYoung(it, now, TEMP_MIN_AGE_MS)) return { ...base, status: 'protected', reason: 'Changed in the last day.' };
  return { ...base, status: 'eligible', reason: it.type === 'link' ? 'A temporary link nothing is using (the link only; never followed).' : 'Temporary files nothing is using that have not changed for over a day.' };
}

// Rotated copies only: name.1 … name.N, compressed copies (.gz .xz .bz2 .zst),
// .old, and date-stamped copies (name-YYYYMMDD[HH]), each optionally
// compressed. Current logs — dpkg.log, apt/history.log, alternatives.log,
// bootstrap.log, an application's own .log — are never cleaned up here: they
// are the record of what happened, and logrotate already manages them.
export const ROTATED_RE = /(\.[0-9]+|\.old|-[0-9]{8}(?:[0-9]{2})?)?(?:\.(?:gz|xz|bz2|zst))?$/;
export function isRotatedLog(name) {
  const m = ROTATED_RE.exec(String(name || ''));
  return !!m && m[0].length > 0 && m.index > 0;
}

function classifyLog(it, { now }) {
  const name = it.name || basename(it.path);
  if (it.type === 'dir') return { category: 'logs', status: 'protected', reason: 'A log folder; its files are not checked one by one.' };
  if (it.type !== 'file') return { category: 'logs', status: 'protected', reason: 'A system log entry.' };
  if (isRotatedLog(name)) {
    if (it.inUse) return { category: 'logs', status: 'protected', sub: 'rotated', reason: 'Being written now.' };
    if (tooYoung(it, now, ROTATED_MIN_AGE_MS)) return { category: 'logs', status: 'protected', sub: 'rotated', reason: 'A recently rotated log.' };
    return { category: 'logs', status: 'eligible', sub: 'rotated', reason: 'An old rotated copy of a log.' };
  }
  if (it.inUse) return { category: 'logs', status: 'protected', sub: 'current', reason: 'Being written now.' };
  // A log file nothing writes to any more (an application's one-off logs):
  // Needs a look, never cleanable by a rule.
  const systemRecord = SYSTEM_LOG_NAMES.has(name) || SYSTEM_LOG_DIRS.has(dirname(it.path)) || !/\.log$/.test(name);
  if (!systemRecord && !tooYoung(it, now, IDLE_LOG_MS)) return { category: 'logs', status: 'investigate', sub: 'idle', reason: 'A log file nothing writes to any more; check it before removing it by hand.' };
  return { category: 'logs', status: 'protected', sub: 'current', reason: 'A current log; only old rotated copies are cleaned up.' };
}

function classifyOther(it, { target }) {
  const name = it.name || basename(it.path);
  if (target.kind === 'application' && it.path === target.profile?.sourceDir && it.type === 'link') {
    return { category: 'running_app', status: 'protected', reason: 'The link the application starts from (it points at the running release).' };
  }
  if (it.path.startsWith('/var/lib/') && SYSTEM_VAR_LIB.has(name)) return { category: 'dependencies', status: 'protected', reason: 'Part of the operating system.' };
  let hint = null;
  if (it.gitLink && it.gitLink.exists === false) hint = `A leftover working copy: its Git link no longer resolves, so Git does not track it any more. To remove it by hand, open the container's terminal, look through it for anything you still need (ls -la ${it.path}), make sure no service runs from it (systemctl status shows each service's folder), then delete it with rm -r ${it.path}.`;
  else if (/\.old$/.test(name)) hint = 'An old backup file.';
  else if (it.type === 'link') hint = it.linkTargetExists === false ? 'A link whose target no longer exists (never followed).' : 'A link (never followed).';
  return { category: 'other', status: 'investigate', reason: 'Not recognised by any rule, so it is left for you to look at.', hint };
}

/* ----------------------- ranked history (newest N kept) -------------------- */

// Execution history as RECOVERY SETS: the copies one job took before a change
// belong together — app-pre-deploy-<job>.sql with environment.pre-<job> and
// <unit>.pre-<job>; app-pre-restore-<job>.sql with environment.pre-restore-<job>.
// restore_project_db needs a dump together with the environment copy its job
// recorded, so sets are kept or removed whole: the newest HISTORY_KEEP sets
// (and any set whose job is still open) are protected; older sets are one
// cleanable item each (a group when the set has several files).
const DUMP_SET_RE = /^app-pre-(deploy|restore)-([A-Za-z0-9-]{1,64})\.sql$/;
const COPY_SET_RE = /^(.+)\.pre-(restore-)?([A-Za-z0-9-]{1,64})$/;
export function recoverySetKey(role, name) {
  if (role === 'db-dump') { const m = DUMP_SET_RE.exec(name); return m ? { job: m[2], kind: m[1], part: 'database' } : null; }
  const m = COPY_SET_RE.exec(name);
  if (!m) return null;
  if (role === 'env-copy' && m[1] !== 'environment') return null;
  return { job: m[3], kind: m[2] ? 'restore' : null, part: role === 'env-copy' ? 'environment' : 'service unit' };
}

function historyItems(facts, roleItems, env) {
  const out = [];
  const sets = new Map();
  const openIds = env?.context?.openJobIds || [];
  for (const { it, root } of roleItems) {
    if (it.missing) continue;
    const name = it.name || basename(it.path);
    if (name.startsWith(HOLD_PREFIX)) { out.push(fileItem(it, root, HOLD_CLASS)); continue; }
    const key = it.type === 'file' ? recoverySetKey(root.role, name) : null;
    if (!key) {
      if (root.role === 'db-dump' && it.type === 'file') out.push(fileItem(it, root, { category: 'data', status: 'protected', sub: 'database', reason: 'A database copy made on request.' }));
      else out.push(fileItem(it, root, { category: 'history', status: 'investigate', reason: it.type === 'file' ? 'Not recognised as a copy ProxyPilot takes before a change, so it is left for you to look at.' : 'Not a plain file, so it is left for you to look at.' }));
      continue;
    }
    if (!sets.has(key.job)) sets.set(key.job, { job: key.job, kind: null, members: [] });
    const set = sets.get(key.job);
    if (key.kind) set.kind = key.kind;
    set.members.push({ it, root, part: key.part });
  }
  const ordered = [...sets.values()].map((set) => ({ ...set, newest: Math.max(...set.members.map((m) => Number(m.it.mtimeMs) || 0)) }))
    .sort((a, b) => b.newest - a.newest || (a.job < b.job ? -1 : 1));
  ordered.forEach((set, rank) => {
    const open = openIds.some((id) => id === set.job || String(id).startsWith(`${set.job}-`) || set.job.startsWith(`${id}-`));
    const keep = open || rank < HISTORY_KEEP;
    const reason = open ? 'Belongs to a job that is running.'
      : keep ? 'Recent copies taken before a change (database and settings together, as a restore needs them).'
        : 'Older copies taken before a change; they are removed together, so no database copy loses its settings (contents are not read).';
    const parts = [...new Set(set.members.map((m) => m.part))];
    const what = set.kind === 'deploy' ? 'a deploy' : set.kind === 'restore' ? 'a restore' : 'a change';
    const label = `Copies taken before ${what} (job ${set.job.slice(0, 8)}): ${parts.join(', ')}`;
    const status = keep ? 'protected' : 'eligible';
    const extra = { group: `history:${set.job}`, rank, setJob: set.job, setParts: parts };
    if (set.members.length === 1) {
      const { it, root } = set.members[0];
      out.push(fileItem(it, root, { category: 'history', status, reason, label, sub: 'recovery-set', extra }));
      return;
    }
    const items = set.members.map(({ it, root }) => fileItem(it, root, { category: 'history', status, reason, sub: 'recovery-set' }));
    out.push({
      ...items[0], id: null, path: null, label, kind: 'group', sub: 'recovery-set',
      logicalBytes: items.reduce((n, x) => n + x.logicalBytes, 0), allocatedBytes: items.reduce((n, x) => n + x.allocatedBytes, 0),
      files: items.length, newestMtimeMs: Math.max(...items.map((x) => Number(x.newestMtimeMs) || 0)),
      precision: items.some((x) => x.precision !== 'exact') ? 'at-least' : 'exact', inUse: items.some((x) => x.inUse), hint: null,
      identity: { set: set.job }, memberCount: items.length, memberKind: 'files',
      members: items.map((x) => ({ path: x.path, kind: x.kind, identity: x.identity, allocatedBytes: x.allocatedBytes, logicalBytes: x.logicalBytes, newestMtimeMs: x.newestMtimeMs })),
      ...extra,
    });
  });
  return out;
}

/* ------------------------------ temp grouping ------------------------------ */

/** The name pattern shared by generated siblings: random suffixes stripped. */
export function namePattern(name) {
  let stem = String(name); let ext = '';
  const m = /^(.+?)(\.[a-z]{1,5})$/.exec(stem);
  if (m && !/^\.[0-9]/.test(m[2])) { stem = m[1]; ext = m[2]; }
  const random = (tok) => /[0-9]/.test(tok) || (tok.length >= 5 && /[A-Z]/.test(tok.slice(1)) && /[a-z]/.test(tok));
  let sep = null;
  for (let i = 0; i < 8; i += 1) {
    const mm = /^(.+?)([-_.])([0-9A-Za-z]+)$/.exec(stem);
    if (!mm || !random(mm[3])) break;
    stem = mm[1]; sep = mm[2];
  }
  // The label keeps the separator the names really use (tmp.* for tmp.XXXX).
  return sep ? `${stem}${sep}*${ext}` : null;
}

function groupTemp(items) {
  const out = [];
  const buckets = new Map();
  for (const item of items) {
    const pattern = namePattern(basename(item.path));
    const parent = dirname(item.path);
    if (!pattern) { out.push(item); continue; }
    const key = `${parent}\0${pattern}\0${item.status}`;
    if (!buckets.has(key)) buckets.set(key, { parent, pattern, status: item.status, members: [] });
    buckets.get(key).members.push(item);
  }
  for (const b of buckets.values()) {
    if (b.members.length < GROUP_THRESHOLD) { out.push(...b.members); continue; }
    const m = b.members;
    const dirs = m.filter((x) => x.kind === 'directory').length;
    const noun = dirs === m.length ? 'folders' : dirs === 0 ? 'files' : 'entries';
    const reasons = [...new Set(m.map((x) => x.reason))];
    // Members are grouped by status, so one pattern can give two groups: their
    // labels say which is which instead of repeating each other.
    const which = b.status === 'eligible' ? '' : b.status === 'protected' ? ', kept' : ', to look at';
    out.push({
      ...m[0],
      id: null,
      path: null,
      label: `${b.parent === '/' ? '' : b.parent}/${b.pattern} (${m.length} ${noun}${which})`,
      memberKind: noun,
      kind: 'group',
      reason: reasons.length === 1 ? reasons[0] : m[0].reason,
      logicalBytes: m.reduce((s, x) => s + x.logicalBytes, 0),
      allocatedBytes: m.reduce((s, x) => s + x.allocatedBytes, 0),
      files: m.reduce((s, x) => s + x.files, 0),
      hardLinkedBytes: m.reduce((s, x) => s + (x.hardLinkedBytes || 0), 0),
      sharedBytes: m.reduce((s, x) => s + (x.sharedBytes || 0), 0),
      inaccessible: m.reduce((s, x) => s + (x.inaccessible || 0), 0),
      newestMtimeMs: Math.max(...m.map((x) => Number(x.newestMtimeMs) || 0)),
      precision: m.some((x) => x.precision === 'at-least') ? 'at-least' : 'exact',
      inUse: m.some((x) => x.inUse),
      identity: { pattern: b.pattern, parent: b.parent },
      memberCount: m.length,
      members: m.map((x) => ({ path: x.path, kind: x.kind, identity: x.identity, allocatedBytes: x.allocatedBytes, logicalBytes: x.logicalBytes, newestMtimeMs: x.newestMtimeMs })),
      pattern: b.pattern,
    });
  }
  return out;
}

/* ---------------------------- the classification --------------------------- */

export function itemId(checkId, it) {
  const name = it.kind === 'group' ? it.label : it.kind === 'snapshot' ? it.identity?.name : it.kind === 'export' ? String(it.identity?.exportId) : it.kind === 'pseudo' ? 'pseudo' : basename(it.path || '');
  const raw = `${checkId}|${it.location}|${it.path || ''}|${it.identity?.ino ?? ''}|${it.identity?.mtimeMs ?? it.identity?.createdAt ?? ''}|${it.kind}|${name}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * classify({ target, context, facts, host, policy, now, checkId })
 *   → { items, categories, totals, notes, unmeasured }
 * facts: the guest scan (null when the guest could not be measured);
 * host: measureHost() output.
 */
export function classify({ target, context, facts = null, host = null, policy = null, now = Date.now(), checkId = 'check' }) {
  const nowMs = nowOf(now);
  const env = { target, context: { ...context, openJobIds: context?.openJobIds || [] }, facts, now: nowMs, policy };
  const items = [];
  const unmeasured = [...(host?.unmeasured || [])];
  const notes = [];
  const roots = facts?.roots || [];
  const temp = []; const historyRole = [];
  let journalDone = false;
  for (const it of facts?.items || []) {
    const root = roots[it.r] || {};
    if (root.role === 'journal') {
      if (it.missing) continue;
      journalDone = true;
      items.push(journalItem(it, root, facts, policy));
      continue;
    }
    if (['db-dump', 'unit-copy', 'env-copy'].includes(root.role)) { historyRole.push({ it, root }); continue; }
    const cls = ageGuard(classifyGuestItem(it, root, env), it, root.role);
    if (!cls) continue;
    const item = fileItem(it, root, cls);
    if (root.role === 'temp') temp.push(item); else items.push(item);
  }
  items.push(...groupTemp(temp));
  items.push(...historyItems(facts, historyRole, env));
  if (facts && !journalDone && facts.journal?.bytes > 0) items.push(journalItem(null, null, facts, policy));
  // Host-side files: transfer bundles (applications) and the bare repository (projects).
  const hostRoots = host?.hostFiles?.roots || [];
  for (const it of host?.hostFiles?.items || []) {
    if (it.missing) continue;
    const root = hostRoots[it.r] || {};
    if (root.role === 'host-transfers') { const cls = ageGuard(transferClass(it, env), it, root.role); if (cls) items.push(fileItem(it, root, cls)); }
    else if (root.role === 'host-repo') items.push(fileItem(it, root, { category: 'data', status: 'protected', location: 'host', reason: "The project's source history, kept by ProxyPilot (on the host)." }));
  }
  // Snapshots and exports: separate selections.
  for (const s of host?.snapshots || []) {
    const created = Date.parse(s.createdAt || '');
    items.push({
      id: null, category: 'snapshots', label: s.name, path: null, kind: 'snapshot', sub: null,
      status: context?.openRestoreJob ? 'protected' : 'eligible',
      reason: context?.openRestoreJob ? 'A restore from a snapshot is running.' : `A restore point from ${dateText(created)}. Deleting it removes the option to restore to that point.`,
      hint: s.usedBytes == null ? 'The space only this snapshot holds could not be read.' : null,
      logicalBytes: Number(s.usedBytes || 0), allocatedBytes: Number(s.usedBytes || 0), files: 0, newestMtimeMs: Number.isFinite(created) ? created : null,
      precision: s.usedBytes == null ? 'estimate' : 'exact', memoryBacked: false,
      action: context?.openRestoreJob ? null : 'delete-snapshot', location: 'host', root: null,
      identity: { name: s.name, createdAt: s.createdAt || null, stateful: !!s.stateful },
      inUse: false, dev: null, crossesDevice: false, sharedBytes: 0, inaccessible: 0,
    });
  }
  for (const e of host?.exports || []) {
    const created = Date.parse(e.createdAt || '');
    const preparing = e.state === 'preparing';
    const failed = e.state === 'failed';
    items.push({
      id: null, category: 'exports', label: e.filename || `Export #${e.id}`, path: null, kind: 'export', sub: e.state || null,
      status: preparing ? 'protected' : 'eligible',
      reason: preparing ? 'Being prepared now.' : failed ? 'A copy that failed to finish; removing it clears it.' : `A downloadable copy from ${dateText(created)}.`,
      hint: null, logicalBytes: Number(e.bytes || 0), allocatedBytes: Number(e.bytes || 0), files: preparing ? 0 : 1, newestMtimeMs: Number.isFinite(created) ? created : null,
      precision: 'exact', memoryBacked: false, action: preparing ? null : 'delete-export', location: 'host', root: null,
      identity: { exportId: e.id, createdAt: e.createdAt || null, state: e.state || null },
      inUse: false, dev: null, crossesDevice: false, sharedBytes: 0, inaccessible: 0,
    });
  }
  const totals = computeTotals({ facts, host, items: items.map((x) => ({ ...x, location: x.location })) });
  if (totals.sharedHostFilesystem) notes.push('This container is on a storage pool that shares the host filesystem, so the used and available figures are the whole host\'s, and what this check did not measure one by one cannot be estimated.');
  if (facts && totals.unattributedBytes > 0) {
    items.push({
      id: null, category: 'other', label: 'Not measured individually (operating system and other files)', path: null, kind: 'pseudo', sub: null,
      status: 'investigate', reason: 'The rest of what the container uses: files outside the folders this check looks at.', hint: null,
      logicalBytes: null, allocatedBytes: totals.unattributedBytes, files: 0, newestMtimeMs: null, precision: 'estimate', memoryBacked: false,
      action: null, location: 'guest', root: null, identity: {}, inUse: false, dev: null, crossesDevice: false, sharedBytes: 0, inaccessible: 0,
    });
  }
  // Stable ids, unique within the check.
  const ids = new Set();
  for (const it of items) {
    let id = itemId(checkId, it);
    for (let k = 1; ids.has(id); k += 1) id = createHash('sha256').update(`${id}|${k}`).digest('hex').slice(0, 16);
    ids.add(id); it.id = id;
  }
  // Notes, in plain language.
  const mem = items.filter((it) => it.memoryBacked && it.location === 'guest').reduce((s, it) => s + it.allocatedBytes, 0);
  if (mem > 0) notes.push(`Some temporary files use memory, not disk (about ${formatBytes(mem)}); they are gone after a restart.`);
  const snaps = items.filter((it) => it.category === 'snapshots');
  if (snaps.length) {
    const held = totals.dataset?.snapshotsBytes;
    notes.push(`Space held by snapshots${held ? ` (about ${formatBytes(held)})` : ''} is only returned after those snapshots are deleted.`);
    notes.push("Each snapshot's figure is the space only that snapshot holds. Space that several snapshots share is freed only when all of them are deleted, so the figures add up to less than the total held by snapshots.");
  }
  if (env.context.rollbackUnknown) notes.push(ROLLBACK_UNKNOWN_REASON);
  if (facts?.budgetExceeded) notes.push('The measurement stopped at its time or size budget; figures marked "at least" are lower bounds.');
  if (facts?.truncatedItems) notes.push(`${facts.truncatedItems} entries were not listed one by one (too many); their space is in "Not measured individually".`);
  const omitted = (facts?.roots || []).reduce((s, r) => s + Number(r.omitted || 0), 0);
  if (omitted) notes.push(`${omitted} entries in very large folders were not listed one by one; their space is in "Not measured individually".`);
  const inacc = items.reduce((s, it) => s + Number(it.inaccessible || 0), 0);
  if (inacc) notes.push(`${inacc} folders or files could not be read; their sizes are not included.`);
  if (facts) notes.push('Space on disk is measured after compression; file sizes are before compression.');
  const categories = summarizeCategories(items);
  return { items, categories, totals, notes, unmeasured };
}

function journalItem(it, root, facts, policy) {
  const limitMB = Number(policy?.rules?.logs?.journalMaxMB) || 256;
  const target = limitMB * 1024 * 1024;
  const usage = Number(facts?.journal?.bytes ?? it?.allocatedBytes ?? 0);
  const over = usage > target;
  return {
    id: null, category: 'logs', label: 'System journal', path: it?.path || '/var/log/journal', kind: 'journal', sub: 'journal',
    status: over ? 'eligible' : 'protected',
    reason: over ? `Keeps the newest ${limitMB} MB of system logs.` : `Within the limit (${limitMB} MB).`,
    hint: null,
    logicalBytes: Number(it?.logicalBytes ?? usage), allocatedBytes: Number(it?.allocatedBytes ?? usage), files: Number(it?.files || 0),
    newestMtimeMs: it?.newestMtimeMs ?? null, precision: it?.partial ? 'at-least' : 'exact', memoryBacked: !!it?.memoryBacked,
    action: over ? 'vacuum-journal' : null, location: 'guest', root: root?.path || null,
    identity: { type: it?.type || 'dir', dev: it?.dev ?? null, ino: it?.ino ?? null, mtimeMs: it?.mtimeMs ?? null, size: it?.size ?? null },
    targetBytes: target, usageBytes: usage, recoverableBytes: over ? usage - target : 0,
    inUse: !!it?.inUse, dev: it?.dev ?? null, crossesDevice: false, sharedBytes: 0, inaccessible: Number(it?.inaccessible || 0),
  };
}

// Host transfer bundles live in ONE host-wide folder. A bundle belongs to an
// application only when its name says so (bundle-app<id>-…); another
// application's bundle is not listed at all, and a bundle whose name names no
// application is listed as shared (Needs a look, never cleanable from an
// application's page, kept out of the category totals so no application —
// and no overview — counts it as its own).
export const ATTRIBUTED_BUNDLE_RE = /^bundle-app([1-9][0-9]{0,15})-[A-Za-z0-9]{1,40}$/;
export function bundleOwner(name) {
  const m = ATTRIBUTED_BUNDLE_RE.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

function transferClass(it, { target, context, now }) {
  const name = it.name || basename(it.path);
  if (name.startsWith(HOLD_PREFIX)) return { ...HOLD_CLASS, location: 'host' };
  if (!/^bundle-/.test(name)) return { category: 'archives', status: 'investigate', location: 'host', reason: "Not created by ProxyPilot's release process." };
  const owner = bundleOwner(name);
  if (owner == null) return { category: 'archives', status: 'investigate', location: 'host', sub: 'shared', reason: "In the host's shared transfer folder; its name does not say which application left it, so it is not cleaned up from an application's page.", extra: { sharedHost: true } };
  if (target.kind !== 'application' || owner !== Number(target.id)) return null;
  if (it.type === 'link') return { category: 'archives', status: 'investigate', location: 'host', reason: 'A link (never followed).' };
  if (context.anyApplicationJobOpen) return { category: 'archives', status: 'protected', location: 'host', reason: 'An application build is running or waiting for recovery; transfer copies may be in use.' };
  if (tooYoung(it, now, WORKSPACE_MIN_AGE_MS)) return { category: 'archives', status: 'protected', location: 'host', reason: 'Changed in the last hour.' };
  return { category: 'archives', status: 'eligible', location: 'host', reason: 'A transfer copy left by an interrupted build of this application.' };
}

/** The scan roots on the host that classification knows (for WS2's approved roots). */
export const HOST_ROOTS = Object.freeze({ transfers: HOST_TRANSFER_ROOT });
export { categoryLabel };
