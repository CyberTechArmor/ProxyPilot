// Application storage fixtures shaped like DESIGN §2.6 / §6 (API contract of
// /api/app-storage). A Nodus-like check: live, rollback and backing-root
// releases plus one older release, preserved model data, an abandoned staging
// workspace and its bundle, caches, memory-backed /tmp groups, a journal
// vacuum, history copies, an unknown leftover worktree ("Needs a look"),
// two snapshots and one export. Used by the browser journey
// (tests/app-storage.browser.mjs) and the backend model test
// (admin/backend/src/__tests__/app-storage-ui-model.test.js). Numbers follow
// the live survey of pp-nodus (nodus-layout.md), rounded.

import { createHash } from 'node:crypto';

const H = (s) => createHash('sha256').update(s).digest('hex');
const DAY = 86400000;
const HOUR = 3600000;

export const NODUS_KEY = 'application:1';
export const PROJECT_KEY = 'project:7';
export const CHECK_ID = 'chk_5b0f2c64-1d0e-4a7b-9c55-2e7f1a6b3c90';
export const NEW_CHECK_ID = 'chk_8a1d4e20-6b3f-4c2a-8e11-9f0d7c5b2a41';
export const CLEANUP_ID = 'cln_3e9a7c12-4f5b-4d6e-8a90-b1c2d3e4f5a6';
// The cleanup job's own sentences (setup-engine/storage-cleanup-op.js).
export const PARKED_REASON = 'It changed while the cleanup ran, so it was set aside (not removed) under a name starting with .pp-cleanup-hold-; check it before removing it.';
export const SETTLING_NOTE = 'The filesystem may still be releasing space, or snapshots still hold it; check again in a few minutes.';

const LIVE = '/opt/nodus-releases/3c932650511871784d485e98e1808b9e8b5c4fd5-p6-f3ec00f4-01ac-4fd0-a1bf-2e447ccc8709';
const ROLLBACK = '/opt/nodus-releases/62a4fbff0c7d1e2a9b8c3d4e5f60718293a4b5c6-p6-b981f91d-8e7b-4e09-94cb-e93853de3d11';
const BACKING = '/opt/nodus-releases/adopted-c5adcdaf5bf2b0263831a75aeffd3e426e153fc0';
const OLD = '/opt/nodus-releases/9d1e7a0c44b2e8f19a3c5d7e9f0a1b2c3d4e5f60-p5-1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b';
const STAGING = '/opt/nodus-releases/.staging/6f0c2a11-9b7e-4c55-a3d2-0c1e5b7a9f10-1';

function item(checkId, now, o) {
  const path = o.path ?? null;
  const location = o.location ?? 'guest';
  const mtimeMs = now - (o.ageMs ?? 3 * DAY);
  const ino = parseInt(H(`${path}|ino`).slice(0, 8), 16);
  const id = H(`${checkId}|${location}|${path}|${ino}|${mtimeMs}|${o.kind ?? 'directory'}|${o.label}`).slice(0, 16);
  return {
    id,
    category: o.category,
    label: o.label,
    path,
    kind: o.kind ?? 'directory',
    status: o.status,
    reason: o.reason,
    logicalBytes: o.logical ?? o.alloc,
    allocatedBytes: o.alloc,
    files: o.files ?? 1,
    newestMtimeMs: mtimeMs,
    precision: o.precision ?? 'exact',
    memoryBacked: Boolean(o.memoryBacked),
    action: o.status === 'eligible' ? (o.action ?? 'remove') : null,
    location,
    identity: { dev: 64769, ino, mtimeMs, size: o.alloc, ...(o.identity || {}) },
    ...(o.members ? { members: o.members, memberCount: o.members.length } : {}),
    ...(o.breakdown ? { breakdown: o.breakdown } : {}),
    // Like classify.js: a memory-backed temp item carries the memory hint.
    ...(o.hint || o.memoryBacked ? { hint: o.hint || 'Uses memory, not disk.' } : {}),
    ...(o.recoverableBytes != null ? { recoverableBytes: o.recoverableBytes } : {}),
    ...(o.sub ? { sub: o.sub } : {}),
    ...(o.sharedHost ? { sharedHost: true } : {}),
  };
}

const LABELS = {
  running_app: 'Running application', dependencies: 'Dependencies', data: 'Application data (database, uploads, models, settings)',
  releases: 'Releases', workspaces: 'Build workspaces', archives: 'Source and transfer archives', caches: 'Caches',
  test_reports: 'Test reports', temp: 'Temporary files', logs: 'Logs', history: 'Execution history',
  snapshots: 'Snapshots (restore points)', exports: 'Exports (downloadable copies)', other: 'Other or unclassified',
};

// Category summaries as WS1 writes them since ws/check-fixes (contract
// 2026-10-21 §5): disk and memory apart, host-wide shared items in neither,
// "mixed" only when something can be cleaned up.
function summarize(items) {
  const sum = (list, k = 'allocatedBytes') => list.reduce((n, i) => n + (i[k] || 0), 0);
  return Object.keys(LABELS).map((key) => {
    const own = items.filter((i) => i.category === key);
    const counted = own.filter((i) => !i.sharedHost);
    const eligible = own.filter((i) => i.status === 'eligible');
    const statuses = new Set(own.map((i) => i.status));
    const status = !own.length ? 'empty' : statuses.size === 1 ? [...statuses][0] : statuses.has('eligible') ? 'mixed' : statuses.has('investigate') ? 'investigate' : 'protected';
    return {
      key, label: LABELS[key], status,
      logicalBytes: sum(counted.filter((i) => !i.memoryBacked), 'logicalBytes'),
      allocatedBytes: sum(counted.filter((i) => !i.memoryBacked)),
      memoryBytes: sum(counted.filter((i) => i.memoryBacked)),
      sharedHostBytes: sum(own.filter((i) => i.sharedHost)),
      count: own.reduce((n, i) => n + i.files, 0),
      itemCount: own.length,
      eligibleCount: eligible.length,
      eligibleBytes: sum(eligible.filter((i) => !i.memoryBacked)),
      eligibleMemoryBytes: sum(eligible.filter((i) => i.memoryBacked)),
      newestMtimeMs: own.reduce((m, i) => Math.max(m, i.newestMtimeMs), 0) || null,
      precision: own.some((i) => i.precision === 'at-least') ? 'at-least' : 'exact',
    };
  });
}

export function nodusCheck(now = Date.now(), { checkId = CHECK_ID, ageMs = 5 * 60000, sharedHost = false } = {}) {
  const at = now - ageMs;
  const I = (o) => item(checkId, at, o);
  const embedMembers = Array.from({ length: 263 }, (_, n) => ({ path: `/tmp/nodus-embed-${(0x1a2b3c + n * 7919).toString(36)}`, kind: 'directory', identity: { dev: 41, ino: 900000 + n, mtimeMs: at - 3 * DAY - n * HOUR } }));
  const pulseMembers = Array.from({ length: 126 }, (_, n) => ({ path: `/tmp/pulse-${(0x5c6d7e + n * 104729).toString(36)}`, kind: 'directory', identity: { dev: 41, ino: 700000 + n, mtimeMs: at - 2 * DAY - n * HOUR } }));
  const items = [
    I({ category: 'running_app', label: 'Live release 3c932650', path: LIVE, kind: 'release', status: 'protected', reason: 'The release the application is running now.', alloc: 510e6, logical: 925e6, files: 48210, ageMs: 20 * 60000, hint: 'Inside a sealed release; removed only with the whole release.', breakdown: [{ label: 'node_modules', allocatedBytes: 402e6 }, { label: 'release-evidence', allocatedBytes: 1.3e6 }, { label: 'test-results', allocatedBytes: 1.1e6 }] }),
    I({ category: 'dependencies', label: '/usr', path: '/usr', status: 'protected', reason: 'Operating system and installed packages.', alloc: 890e6, logical: 1.62e9, files: 61234, ageMs: 9 * DAY }),
    I({ category: 'dependencies', label: '/var/lib/dpkg', path: '/var/lib/dpkg', status: 'protected', reason: 'Operating system and installed packages.', alloc: 21e6, logical: 38e6, files: 3412, ageMs: 9 * DAY }),
    I({ category: 'data', label: 'Database files', path: '/var/lib/postgresql', status: 'protected', reason: 'Database files.', alloc: 182e6, logical: 240e6, files: 1904, precision: 'at-least', ageMs: 30 * 60000 }),
    I({ category: 'data', label: '/var/lib/nodus', path: '/var/lib/nodus', status: 'protected', reason: 'Kept between releases (a preserved path in the application profile).', alloc: 243e3, logical: 134e3, files: 31, ageMs: 2 * HOUR }),
    I({ category: 'data', label: 'Voice models', path: '/opt/nodus/voice/models', status: 'protected', reason: 'Models kept between releases.', alloc: 26.5e6, files: 1, ageMs: 21 * DAY }),
    I({ category: 'data', label: 'Embedding models', path: '/opt/nodus/embed/models', status: 'protected', reason: 'Models kept between releases.', alloc: 34.2e6, files: 2, ageMs: 19 * DAY }),
    I({ category: 'data', label: 'nodus.env', path: '/etc/nodus/nodus.env', kind: 'file', status: 'protected', reason: 'Settings and secrets (contents are never read).', alloc: 4096, logical: 359, files: 1, ageMs: 12 * DAY }),
    I({ category: 'releases', label: 'Rollback release 62a4fbff', path: ROLLBACK, kind: 'release', status: 'protected', reason: 'Kept so you can roll back to the previous version.', alloc: 505e6, logical: 918e6, files: 48102, ageMs: 2 * HOUR }),
    I({ category: 'releases', label: 'Adopted checkout c5adcdaf', path: BACKING, kind: 'release', status: 'protected', reason: 'Holds shared data that newer releases link to (models). Most of it may be an old copy of the application; move the shared data out to let it be cleaned up.', alloc: 498e6, logical: 940e6, files: 51023, ageMs: 6 * DAY }),
    I({ category: 'releases', label: 'Release 9d1e7a0c', path: OLD, kind: 'release', action: 'remove-release', status: 'eligible', reason: 'An older release that is no longer needed for rollback.', alloc: 497e6, logical: 905e6, files: 47900, ageMs: 2 * DAY, identity: { markerSha: '9d1e7a0c44b2e8f19a3c5d7e9f0a1b2c3d4e5f60' } }),
    I({ category: 'workspaces', label: 'Build workspace 6f0c2a11', path: STAGING, status: 'eligible', reason: 'Left behind by a build that has ended.', alloc: 412e6, logical: 421e6, files: 9120, ageMs: 2 * DAY }),
    I({ category: 'archives', label: 'Source bundle 6f0c2a11', path: `${STAGING}.bundle`, kind: 'file', status: 'eligible', reason: 'Left behind by a build that has ended.', alloc: 38e6, files: 1, ageMs: 2 * DAY }),
    I({ category: 'archives', label: 'Transfer copy bundle-k3j2h1', path: '/var/lib/proxypilot/application-release-transfers/bundle-k3j2h1', location: 'host', status: 'eligible', reason: 'A transfer copy left by an interrupted build.', alloc: 37e6, files: 1, ageMs: 3 * DAY }),
    I({ category: 'caches', label: 'npm downloads', path: '/var/lib/nodus/.npm', status: 'eligible', reason: 'Downloaded files that are fetched again when needed.', alloc: 118e6, logical: 131e6, files: 4210, ageMs: 4 * DAY }),
    I({ category: 'caches', label: 'Browser downloads for tests', path: '/root/.cache/ms-playwright', status: 'eligible', reason: 'Downloaded files that are fetched again when needed.', hint: 'Tests download it again.', alloc: 301e6, logical: 312e6, files: 812, ageMs: 5 * DAY }),
    I({ category: 'caches', label: '/root/.cache/Microsoft', path: '/root/.cache/Microsoft', status: 'eligible', reason: 'Downloaded files that are fetched again when needed.', alloc: 383e3, files: 3, ageMs: 3 * DAY }),
    I({ category: 'caches', label: 'Package downloads', path: '/var/cache/apt/archives', status: 'eligible', reason: 'Downloaded files that are fetched again when needed.', alloc: 64e6, files: 41, ageMs: 9 * DAY }),
    I({ category: 'temp', label: 'nodus-embed-* (263 folders)', path: '/tmp/nodus-embed-*', kind: 'group', status: 'eligible', reason: 'Left behind by test runs; nothing is using them.', alloc: 1.3e6, logical: 1.2e6, files: 789, memoryBacked: true, members: embedMembers, ageMs: 3 * DAY }),
    I({ category: 'temp', label: 'pulse-* (126 folders)', path: '/tmp/pulse-*', kind: 'group', status: 'eligible', reason: 'Left behind by test runs; nothing is using them.', alloc: 520e3, files: 252, memoryBacked: true, members: pulseMembers, ageMs: 2 * DAY }),
    I({ category: 'temp', label: 'Abandoned browser download', path: '/tmp/playwright-download-Fs12Md', status: 'eligible', reason: 'Not changed for more than a day and nothing is using it.', alloc: 137.6e6, files: 1, memoryBacked: true, ageMs: DAY + 7 * HOUR }),
    I({ category: 'temp', label: 'playwright-transform-cache-0', path: '/tmp/playwright-transform-cache-0', status: 'eligible', reason: 'Not changed for more than a day and nothing is using it.', alloc: 42e6, files: 1760, memoryBacked: true, ageMs: 7 * DAY }),
    I({ category: 'temp', label: 'tsx-989', path: '/tmp/tsx-989', status: 'protected', reason: 'Changed in the last day.', alloc: 22.2e6, files: 2000, memoryBacked: true, precision: 'at-least', ageMs: 30 * 60000 }),
    I({ category: 'temp', label: 'nodus.service private files', path: '/tmp/systemd-private-62dc0f1e-nodus.service-Sj5Zwh', status: 'protected', reason: 'In use by a running process.', alloc: 8192, files: 1, memoryBacked: true, ageMs: 40 * 60000 }),
    I({ category: 'temp', label: 'nodus-w56-http.json', path: '/var/tmp/nodus-w56-http.json', kind: 'file', status: 'eligible', reason: 'Not changed for more than a day and nothing is using it.', alloc: 4096, logical: 1876, files: 1, ageMs: 11 * DAY }),
    I({ category: 'logs', label: 'System logs (journal)', path: '/var/log/journal', kind: 'journal', action: 'vacuum-journal', status: 'eligible', reason: 'Keeps the newest 256 MB of system logs.', alloc: 612e6, logical: 640e6, files: 14, precision: 'estimate', recoverableBytes: 356e6, ageMs: 10 * 60000 }),
    I({ category: 'logs', label: 'syslog.2.gz', path: '/var/log/syslog.2.gz', kind: 'file', sub: 'rotated', status: 'eligible', reason: 'An old rotated log.', alloc: 45e3, logical: 43920, files: 1, ageMs: 16 * DAY }),
    I({ category: 'logs', label: 'postgresql-17-main.log', path: '/var/log/postgresql/postgresql-17-main.log', kind: 'file', sub: 'current', status: 'protected', reason: 'Being written now.', alloc: 660e3, logical: 657104, files: 1, ageMs: 60000 }),
    I({ category: 'history', label: 'app-pre-deploy-62348a2a.sql', path: '/var/backups/proxypilot-db/app-pre-deploy-62348a2a.sql', kind: 'file', status: 'protected', reason: 'Recent database copy taken before a change.', alloc: 48e6, files: 1, ageMs: 3 * HOUR }),
    I({ category: 'history', label: 'app-pre-deploy-51e0a9b2.sql', path: '/var/backups/proxypilot-db/app-pre-deploy-51e0a9b2.sql', kind: 'file', status: 'protected', reason: 'Recent database copy taken before a change.', alloc: 47e6, files: 1, ageMs: DAY }),
    I({ category: 'history', label: 'app-pre-deploy-1f2e3d4c.sql', path: '/var/backups/proxypilot-db/app-pre-deploy-1f2e3d4c.sql', kind: 'file', status: 'eligible', reason: 'An older database copy taken before a change.', alloc: 46e6, files: 1, ageMs: 6 * DAY }),
    I({ category: 'history', label: 'nodus.service.pre-1f2e3d4c', path: '/etc/systemd/system/nodus.service.pre-1f2e3d4c', kind: 'file', status: 'eligible', reason: 'An old copy of a settings file from before a change (contents are not read).', alloc: 4096, logical: 1203, files: 1, ageMs: 6 * DAY }),
    I({ category: 'snapshots', label: 'pp-mcp-pre-resources-20261012-0912', path: null, kind: 'snapshot', action: 'delete-snapshot', location: 'host', status: 'eligible', reason: 'A restore point from 12 Oct 2026. Deleting it removes the option to restore to that point.', alloc: 214e6, files: 0, ageMs: 8 * DAY, identity: { createdAt: '2026-10-12T09:12:03.418223511Z' } }),
    I({ category: 'snapshots', label: 'pp-pre-restore-62348a2a-k2j1', path: null, kind: 'snapshot', action: 'delete-snapshot', location: 'host', status: 'eligible', reason: 'A restore point from 18 Oct 2026. Deleting it removes the option to restore to that point.', alloc: 158e6, files: 0, ageMs: 2 * DAY, identity: { createdAt: '2026-10-18T16:40:55.120004871Z' } }),
    I({ category: 'exports', label: 'pp-nodus-20261019.tar.zst', path: null, kind: 'export', action: 'delete-export', location: 'host', status: 'eligible', reason: 'A downloadable copy of the whole container, ready to download.', alloc: 1.42e9, files: 1, ageMs: DAY, identity: { exportId: 7 } }),
    I({ category: 'other', label: '/opt/nodus-w48', path: '/opt/nodus-w48', status: 'investigate', reason: 'Not created by ProxyPilot’s release process.', hint: 'A leftover working copy: its .git link no longer resolves.', alloc: 31e6, logical: 58e6, files: 2210, ageMs: 12 * DAY }),
    I({ category: 'other', label: '/opt/nodus-w49', path: '/opt/nodus-w49', status: 'investigate', reason: 'Not created by ProxyPilot’s release process.', hint: 'A leftover working copy: its .git link no longer resolves.', alloc: 29e6, logical: 55e6, files: 2190, ageMs: 12 * DAY }),
    // WS1 sub values (contract 2026-10-21 §3, §4): a set-aside entry, a
    // release whose validation has not passed, a bundle no application name claims.
    I({ category: 'other', label: '/opt/nodus-releases/.pp-cleanup-hold-3e9a7c12-1', path: '/opt/nodus-releases/.pp-cleanup-hold-3e9a7c12-1', sub: 'held', status: 'investigate', reason: 'Set aside by an earlier cleanup because it changed while the cleanup ran; check it before removing it.', alloc: 8192, files: 2, ageMs: 3 * HOUR }),
    I({ category: 'releases', label: 'Release 7b7b7b7b (validation not passed)', path: '/opt/nodus-releases/7b7b7b7b00000000000000000000000000000000-p6-7b7b7b7b-1111-4111-8111-111111111111', kind: 'release', sub: 'pending', status: 'protected', reason: 'Its validation has not passed (it may still be running), so it is kept.', alloc: 488e6, logical: 900e6, files: 47800, ageMs: HOUR }),
    I({ category: 'archives', label: 'Transfer copy bundle-k9x2', path: '/var/lib/proxypilot/application-release-transfers/bundle-k9x2', location: 'host', sub: 'shared', sharedHost: true, status: 'investigate', reason: 'A transfer copy no application name claims; it may belong to another application.', alloc: 21e6, files: 1, ageMs: 5 * DAY }),
    I({ category: 'other', label: '/var/lib/nodus-publication', path: '/var/lib/nodus-publication', status: 'investigate', reason: 'Not claimed by any rule.', alloc: 12e6, files: 340, ageMs: 6 * DAY }),
    I({ category: 'other', label: 'Not measured individually (operating system and other files)', path: null, kind: 'pseudo', status: 'investigate', reason: 'The rest of the used space; it is not attributed to a folder.', alloc: 238e6, files: 0, precision: 'estimate', ageMs: 0 }),
  ];
  return {
    version: 1,
    checkId,
    target: { key: NODUS_KEY, kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus' },
    origin: 'user',
    status: 'complete',
    startedAt: new Date(at - 41000).toISOString(),
    finishedAt: new Date(at).toISOString(),
    // WS1 §6 shape; `sharedHost` gives a dir-pool container (figures are the host's).
    totals: sharedHost ? {
      guest: { totalBytes: 1.9e12, usedBytes: 512e9, availableBytes: 1.39e12, precision: 'exact', shared: true, source: 'shared-host-df', label: "The host filesystem this container shares with other containers and the host itself; it is not this container's own use" },
      sharedHostFilesystem: true,
      usageBytes: 2.1e9,
      usageSource: 'incus-root-usage',
      limit: { bytes: null, source: null },
      dataset: null,
      memoryBacked: [{ mount: '/tmp', usedBytes: 1111255137 }],
      measuredBytes: 3.37e9,
      unattributedBytes: null,
      unattributedPrecision: null,
    } : {
      guest: { totalBytes: 236422037504, usedBytes: 3.61e9, availableBytes: 232.81e9, precision: 'exact', shared: false, source: 'container-df' },
      sharedHostFilesystem: false,
      limit: { bytes: 236223201280, source: 'root-device' },
      dataset: { usedBytes: 3.95e9, referencedBytes: 3.61e9, snapshotsBytes: 412e6, logicalUsedBytes: 7.4e9, compressRatio: 2.1, source: 'zfs-dataset' },
      memoryBacked: [{ mount: '/tmp', usedBytes: 1111255137 }],
      measuredBytes: 3.37e9,
      unattributedBytes: 238e6,
    },
    categories: summarize(sharedHost ? items.filter((i) => i.kind !== 'pseudo') : items),
    items: sharedHost ? items.filter((i) => i.kind !== 'pseudo') : items,
    context: { liveRelease: LIVE, rollbackRelease: ROLLBACK, waitingCandidate: null, backingRoots: [BACKING], activeAttempts: [], buildActive: false },
    unmeasured: [{ area: 'Some folders under /tmp', reason: 'Some folders could not be read, so their size is at least what is shown.' }],
    notes: ['Files linked from several places are counted once.', 'Each snapshot’s size counts only what that snapshot holds by itself; space shared by several snapshots is in “Held by snapshots”.'],
  };
}

export const DEFAULT_POLICY = {
  version: 1,
  rules: {
    releases: { enabled: true, keepReleases: 2, trimBeforeSeal: ['.cache', 'node_modules/.cache', 'test-results', 'playwright-report', 'coverage', '.nyc_output'] },
    snapshots: { enabled: true, keep: 3 },
    workspaces: { enabled: true, abandonedAfterHours: 1 },
    caches: { enabled: true, maxAgeDays: 14 },
    tempFiles: { enabled: true, maxAgeDays: 2 },
    testArtifacts: { enabled: true, maxAgeDays: 14 },
    logs: { enabled: true, rotatedMaxAgeDays: 14, journalMaxMB: 256 },
    history: { enabled: true, keepNewest: 2, maxAgeDays: 30 },
  },
  alerts: { enabled: true, warnBytes: 20e9, growthBytes: 2e9, growthWindowHours: 24 },
};

export function nodusPolicy() {
  return {
    version: 1,
    rules: {
      releases: { enabled: true, keepReleases: 2, trimBeforeSeal: ['.cache'] },
      snapshots: { enabled: true, keep: 3 },
      workspaces: { enabled: true, abandonedAfterHours: 1 },
      caches: { enabled: false, maxAgeDays: 14 },
      tempFiles: { enabled: false, maxAgeDays: 2 },
      testArtifacts: { enabled: false, maxAgeDays: 14 },
      logs: { enabled: false, rotatedMaxAgeDays: 14, journalMaxMB: 256 },
      history: { enabled: false, keepNewest: 2, maxAgeDays: 30 },
    },
    alerts: { enabled: true, warnBytes: 10e9, growthBytes: 2e9, growthWindowHours: 24 },
  };
}

export function nodusEffects() {
  return [
    { rule: 'releases', enabled: true, items: 1, bytes: 497e6, examples: ['Release 9d1e7a0c'], note: 'Keeps the live release, the rollback release and a waiting candidate; would remove 1 older release.' },
    { rule: 'snapshots', enabled: true, items: 0, bytes: 0, examples: [], note: 'Keeps the newest 3 snapshots; there are 2, so none would be deleted.' },
    { rule: 'workspaces', enabled: true, items: 3, bytes: 487e6, examples: ['Build workspace 6f0c2a11', 'Source bundle 6f0c2a11', 'Transfer copy bundle-k3j2h1'] },
    { rule: 'caches', enabled: false, items: 0, bytes: 0, examples: [], note: 'No cache is older than 14 days yet.' },
    { rule: 'tempFiles', enabled: false, items: 4, bytes: 181.4e6, examples: ['nodus-embed-* (263 folders)', 'Abandoned browser download', 'playwright-transform-cache-0'] },
    { rule: 'testArtifacts', enabled: false, items: 0, bytes: 0, examples: [] },
    { rule: 'logs', enabled: false, items: 2, bytes: 356e6, examples: ['System logs (journal)', 'syslog.2.gz'] },
    { rule: 'history', enabled: false, items: 0, bytes: 0, examples: [], note: 'Nothing is older than 30 days yet.' },
  ];
}

// The overview's "can be cleaned up" figures (WS1 §7): disk and memory apart.
function eligibleSplit(check) {
  const el = check.items.filter((i) => i.status === 'eligible' && !['snapshots', 'exports'].includes(i.category) && i.kind !== 'pseudo');
  return { eligibleBytes: el.filter((i) => !i.memoryBacked).reduce((n, i) => n + i.allocatedBytes, 0), eligibleMemoryBytes: el.filter((i) => i.memoryBacked).reduce((n, i) => n + i.allocatedBytes, 0) };
}

export function overview(now = Date.now(), { nodusRunning = null, nodusCheckId = CHECK_ID } = {}) {
  const check = nodusCheck(now);
  return {
    checkedAt: new Date(now).toISOString(),
    targets: [
      {
        key: NODUS_KEY, kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus', guestStatus: 'Running',
        usage: { usedBytes: 3.95e9, sampledAt: new Date(now - 4 * 60000).toISOString(), source: 'incus-root-usage' },
        lastCheck: { checkId: nodusCheckId, finishedAt: check.finishedAt, status: 'complete', totals: check.totals, ...eligibleSplit(check) },
        runningCheckId: nodusRunning,
        alerts: [],
        policy: { source: 'preserved', enabledRules: ['releases', 'snapshots', 'workspaces'], proposedRules: ['caches', 'tempFiles', 'testArtifacts', 'logs', 'history'] },
      },
      {
        key: PROJECT_KEY, kind: 'project', id: 7, name: 'Pulse board with a fairly long project name for wrapping', guest: 'm2-7', guestStatus: 'Running',
        usage: { usedBytes: 21.3e9, sampledAt: new Date(now - 6 * 60000).toISOString() },
        lastCheck: null,
        runningCheckId: null,
        alerts: [{ key: 'appstorage:usage:project:7', level: 'warning', title: 'Pulse board uses 21.3 GB of storage (warning level 20 GB)' }, { key: 'appstorage:growth:project:7', level: 'warning', title: 'Pulse board grew by 2.3 GB in the last 24 hours' }],
        policy: { source: 'defaults-existing', enabledRules: [], proposedRules: ['releases', 'snapshots', 'workspaces', 'caches', 'tempFiles', 'testArtifacts', 'logs', 'history'] },
      },
      {
        key: 'project:9', kind: 'project', id: 9, name: 'Stopped demo', guest: 'm2-9', guestStatus: 'Stopped',
        usage: null, lastCheck: null, runningCheckId: null, alerts: [],
        policy: { source: 'defaults-new', enabledRules: ['releases', 'snapshots', 'workspaces', 'caches', 'tempFiles', 'testArtifacts', 'logs', 'history'], proposedRules: [] },
      },
    ],
  };
}

export function targetDetail(now = Date.now(), { check = nodusCheck(now), runningCheckId = null, cleanups = [] } = {}) {
  return {
    target: { key: NODUS_KEY, kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus', guestStatus: 'Running' },
    latestCheck: check,
    runningCheckId,
    policy: { policy: nodusPolicy(), source: 'preserved', revision: 1 },
    effects: nodusEffects(),
    cleanups,
  };
}

export function policyResponse({ policy = nodusPolicy(), revision = 1, source = 'preserved', updatedAt = null, updatedBy = null, checkId = CHECK_ID } = {}) {
  return { policy, defaults: DEFAULT_POLICY, source, revision, updatedAt, updatedBy, checkId, effects: nodusEffects() };
}

/** GET /cleanups/:id for a finished cleanup of the requested ids: one skipped with its reason. */
export function cleanupResult(check, body, now = Date.now()) {
  const byId = new Map(check.items.map((i) => [i.id, i]));
  const chosen = [...body.items, ...body.snapshots, ...body.exports].map((id) => byId.get(id)).filter(Boolean);
  const [first, ...rest] = chosen;
  // Shaped like WS2's result (ws/storage-fixes 70929e70): a changed entry is
  // set aside under .pp-cleanup-hold-* and named in `parked`.
  const skipped = first ? [{ id: first.id, label: first.label, reason: PARKED_REASON, ...(first.path ? { parked: [`${first.path.replace(/\/[^/]+$/, '')}/.pp-cleanup-hold-${CLEANUP_ID.slice(4, 12)}-1`] } : {}) }] : [];
  const removed = rest.map((i) => ({ id: i.id, label: i.label, bytes: i.allocatedBytes }));
  const memory = rest.filter((i) => i.memoryBacked);
  const snaps = rest.filter((i) => i.kind === 'snapshot');
  const estimateBytes = chosen.reduce((n, i) => n + (i.recoverableBytes ?? i.allocatedBytes), 0);
  const reclaimed = Math.round(removed.reduce((n, i) => n + i.bytes, 0) * 0.4);
  return {
    id: CLEANUP_ID, targetKey: NODUS_KEY, status: skipped.length ? 'partial' : 'succeeded', origin: 'user', scope: body.scope,
    createdAt: new Date(now - 30000).toISOString(), finishedAt: new Date(now).toISOString(),
    selection: chosen.map((i) => ({ id: i.id, label: i.label, bytes: i.allocatedBytes, category: i.category })),
    result: {
      removed, skipped, failed: [],
      health: 'passed',
      estimateBytes,
      reclaimed: {
        guestBytes: reclaimed,
        memoryBytes: memory.length ? memory.reduce((n, i) => n + i.allocatedBytes, 0) : null,
        datasetBytes: Math.round(reclaimed * 0.9) + snaps.reduce((n, i) => n + i.allocatedBytes, 0),
        settling: true,
      },
      notes: [SETTLING_NOTE],
      afterCheckId: NEW_CHECK_ID,
      remaining: { ...check.totals, guest: { ...check.totals.guest, usedBytes: check.totals.guest.usedBytes - reclaimed, availableBytes: check.totals.guest.availableBytes + reclaimed } },
    },
    job: { status: 'succeeded', phase: 'done', events: [{ kind: 'checkpoint', message: 'Checked the live release again before removing anything.' }, { kind: 'item', message: `Removed ${removed.length} items.` }, { kind: 'health', message: 'Health check passed.' }] },
  };
}

export function cleanupRunning(now = Date.now()) {
  return {
    id: CLEANUP_ID, targetKey: NODUS_KEY, status: 'running', origin: 'user', scope: 'items',
    createdAt: new Date(now - 5000).toISOString(), finishedAt: null, selection: [], result: null,
    job: { status: 'running', phase: 'removing', events: [{ kind: 'checkpoint', message: 'Checked the live release again before removing anything.' }] },
  };
}
