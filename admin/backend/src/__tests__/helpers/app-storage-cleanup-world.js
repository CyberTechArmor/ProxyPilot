// Fakes for the application-storage CLEANUP tests (WS2): an in-memory storage store
// with the interface WS1's lib/app-storage/store.js provides (DESIGN §5,
// contract-changes.md 2026-10-20), and check/target builders.

export const RELEASES = '/opt/nodus-releases';
export const JOB_UUID = '11111111-1111-4111-8111-111111111111';
export const releasePath = n => `${RELEASES}/${String(n).repeat(40)}-p6-${JOB_UUID}`;

export function memoryStore() {
  const checks = new Map();
  const cleanups = new Map();
  const policies = new Map();
  let seq = 0;
  return {
    checks, cleanups, policies,
    insertCheck(row) { checks.set(row.checkId || row.id, { ...row }); return row; },
    putCheck(check) { checks.set(check.checkId, check); return check; },
    getCheck: id => checks.get(id) || null,
    latestCheck: key => [...checks.values()].filter(c => c.target?.key === key).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null,
    listChecks: (key, limit = 20) => [...checks.values()].filter(c => c.target?.key === key).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit),
    insertCleanup(row) { seq += 1; cleanups.set(row.id, { ...row, seq }); return cleanups.get(row.id); },
    updateCleanup(id, patch) { const row = cleanups.get(id); if (!row) return 0; Object.assign(row, patch); return 1; },
    getCleanup: id => cleanups.get(id) || null,
    listCleanups: (key, limit = 10) => [...cleanups.values()].filter(r => r.targetKey === key).sort((a, b) => b.seq - a.seq).slice(0, limit),
    getPolicy: key => policies.get(key) || null,
  };
}

export const nodusTarget = (over = {}) => ({
  key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus',
  profile: { targetId: 'nodus', sourceDir: '/opt/nodus', releaseRoot: RELEASES, serviceName: 'nodus.service', healthUrl: 'http://127.0.0.1:3000/ready', preservePaths: ['/var/lib/nodus', '/opt/nodus/embed/models'], envFiles: ['/etc/nodus/nodus.env'] },
  live: { sha: '3'.repeat(40), releasePath: releasePath(3), previousSha: '2'.repeat(40), verifiedAt: '2026-10-20T20:10:10Z' },
  candidates: [{ sha: '2'.repeat(40), checkpointAt: '2026-10-19T10:00:00Z', validation: { passed: true, releasePath: releasePath(2) }, live: { releasePath: releasePath(2) } }],
  serviceHome: '/var/lib/nodus',
  ...over,
});

export const projectTarget = (over = {}) => ({ key: 'project:4', kind: 'project', id: 4, name: 'Shop', guest: 'm2-4', project: { id: 4, container_name: 'm2-4', web_port: 3000 }, ...over });

const id = s => s.padEnd(16, '0');
export const ids = { release: id('a1'), group: id('a2'), cache: id('a3'), journal: id('a4'), live: id('a5'), other: id('a6'), dump: id('a7'), staging: id('a8'), hostBundle: id('a9'), snap1: id('s1'), snap2: id('s2'), export1: id('e1') };

export function nodusCheck(over = {}) {
  const item = o => ({ precision: 'exact', location: 'guest', logicalBytes: 100, allocatedBytes: 50, identity: { dev: 1, ino: 2, mtimeMs: 3, size: 4 }, ...o });
  return {
    version: 1, checkId: 'chk-1', target: { key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus' },
    origin: 'user', status: 'complete', startedAt: '2026-10-20T22:30:00Z', finishedAt: '2026-10-20T22:31:00Z',
    totals: { guest: { usedBytes: 3_000_000_000, totalBytes: 236_000_000_000 }, dataset: { usedBytes: 2_900_000_000, snapshotsBytes: 900 } },
    context: { serviceHome: '/var/lib/nodus' },
    items: [
      item({ id: ids.release, category: 'releases', kind: 'release', path: releasePath(1), status: 'eligible', action: 'remove-release', allocatedBytes: 4000, label: 'Old release 1111111' }),
      item({ id: ids.group, category: 'temp', kind: 'group', path: null, status: 'eligible', action: 'remove', label: 'nodus-embed-* (2 folders)', memoryBacked: true, allocatedBytes: 10, newestMtimeMs: Date.parse('2026-10-15T00:00:00Z'), members: [{ path: '/tmp/nodus-embed-a1b2', identity: { dev: 9, ino: 1 } }, { path: '/tmp/nodus-embed-c3d4', identity: { dev: 9, ino: 2 } }] }),
      item({ id: ids.cache, category: 'caches', kind: 'directory', path: '/root/.cache/ms-playwright', status: 'eligible', action: 'remove', allocatedBytes: 300, label: 'Playwright browsers', newestMtimeMs: Date.parse('2026-09-01T00:00:00Z') }),
      item({ id: ids.journal, category: 'logs', kind: 'journal', path: '/var/log/journal', status: 'eligible', action: 'vacuum-journal', allocatedBytes: 600_000_000, targetBytes: 256 * 1024 * 1024, recoverableBytes: 331_564_544, label: 'System logs' }),
      item({ id: ids.live, category: 'running_app', kind: 'release', path: releasePath(3), status: 'protected', action: null, reason: 'The release the application is running now.' }),
      item({ id: ids.other, category: 'other', kind: 'directory', path: '/opt/nodus-w48', status: 'investigate', action: null, reason: 'Not created by ProxyPilot.' }),
      item({ id: ids.dump, category: 'history', kind: 'file', path: '/var/backups/proxypilot-db/app-pre-deploy-x.sql', status: 'eligible', action: 'remove', allocatedBytes: 70, label: 'Old database copy', newestMtimeMs: Date.parse('2026-09-01T00:00:00Z') }),
      item({ id: ids.staging, category: 'workspaces', kind: 'directory', path: `${RELEASES}/.staging/22222222-2222-4222-8222-222222222222-1`, status: 'eligible', action: 'remove', allocatedBytes: 900, label: 'Abandoned build workspace', newestMtimeMs: Date.parse('2026-10-19T00:00:00Z') }),
      item({ id: ids.hostBundle, category: 'archives', kind: 'directory', location: 'host', path: '/var/lib/proxypilot/application-release-transfers/bundle-AbC123', status: 'eligible', action: 'remove', allocatedBytes: 800, label: 'Transfer copy', newestMtimeMs: Date.parse('2026-10-19T00:00:00Z') }),
      item({ id: ids.snap1, category: 'snapshots', kind: 'snapshot', path: null, name: 'snap-1', status: 'eligible', action: 'delete-snapshot', identity: { createdAt: '2026-10-01T12:00:00.123456789Z' }, allocatedBytes: 100, label: 'snap-1' }),
      item({ id: ids.snap2, category: 'snapshots', kind: 'snapshot', path: null, name: 'snap-2', status: 'eligible', action: 'delete-snapshot', identity: { createdAt: '2026-10-02T12:00:00Z' }, allocatedBytes: 200, label: 'snap-2' }),
      item({ id: ids.export1, category: 'exports', kind: 'export', path: null, status: 'eligible', action: 'delete-export', identity: { exportId: 7, createdAt: '2026-10-03T00:00:00Z' }, allocatedBytes: 5000, label: 'Export #7' }),
    ],
    ...over,
  };
}
