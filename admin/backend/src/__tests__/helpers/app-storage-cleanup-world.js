// Fixtures for the application-storage CLEANUP tests (WS2): WS1's real
// storage store over an in-memory node:sqlite mock2 database, plus a
// Nodus-shaped check document and target. (WS1's own world with real
// directories and the real collector is helpers/app-storage-world.js.)

import { DatabaseSync } from 'node:sqlite';
import { createStorageStore, ensureAppStorageSchema } from '../../lib/app-storage/store.js';

export const RELEASES = '/opt/nodus-releases';
export const JOB_UUID = '11111111-1111-4111-8111-111111111111';
export const CHECK_ID = 'chk_00000000-0000-4000-8000-000000000001';
export const CHECK_ID_2 = 'chk_00000000-0000-4000-8000-000000000002';
export const releasePath = n => `${RELEASES}/${String(n).repeat(40)}-p6-${JOB_UUID}`;

// The real store; putCheck(doc) stores a finished check the way the check
// service does (insertCheck, then finishCheck with the result document).
export function memoryStore({ now = () => Date.now() } = {}) {
  const db = new DatabaseSync(':memory:');
  ensureAppStorageSchema(db);
  const store = createStorageStore(db, { now });
  return Object.assign(store, {
    db,
    putCheck(doc) {
      store.insertCheck({ id: doc.checkId, targetKey: doc.target.key, origin: doc.origin || 'user', startedAt: doc.startedAt });
      store.finishCheck(doc.checkId, { status: doc.status, result: doc, finishedAt: doc.finishedAt });
      return doc;
    },
    cleanupCount: () => db.prepare('SELECT COUNT(*) AS n FROM mock2_storage_cleanups').get().n,
    clearCleanups: () => db.exec('DELETE FROM mock2_storage_cleanups'),
  });
}

export const nodusTarget = (over = {}) => ({
  key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus', targetId: 'nodus',
  profile: { targetId: 'nodus', sourceDir: '/opt/nodus', releaseRoot: RELEASES, serviceName: 'nodus.service', healthUrl: 'http://127.0.0.1:3000/ready', preservePaths: ['/var/lib/nodus', '/opt/nodus/embed/models'], envFiles: ['/etc/nodus/nodus.env'] },
  live: { sha: '3'.repeat(40), releasePath: releasePath(3), previousSha: '2'.repeat(40), verifiedAt: '2026-10-20T20:10:10Z' },
  candidates: [{ sha: '2'.repeat(40), checkpointAt: '2026-10-19T10:00:00Z', validation: { passed: true, releasePath: releasePath(2) }, live: { releasePath: releasePath(2) } }],
  ...over,
});

export const projectTarget = (over = {}) => ({ key: 'project:4', kind: 'project', id: 4, name: 'Shop', guest: 'm2-4', appDir: '/srv/app', repoMount: '/srv/repo.git', lifecycle: 'active', ...over });

const id = s => s.padEnd(16, '0');
export const ids = { release: id('a1'), group: id('a2'), cache: id('a3'), journal: id('a4'), live: id('a5'), other: id('a6'), dump: id('a7'), staging: id('a8'), hostBundle: id('a9'), snap1: id('b1'), snap2: id('b2'), export1: id('e1') };

export function nodusCheck(over = {}) {
  const item = o => ({ precision: 'exact', location: 'guest', logicalBytes: 100, allocatedBytes: 50, identity: { type: 'dir', dev: 1, ino: 2, mtimeMs: 3, size: 4 }, ...o });
  return {
    version: 1, checkId: CHECK_ID, target: { key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus' },
    origin: 'user', status: 'complete', startedAt: '2026-10-20T22:30:00.000Z', finishedAt: '2026-10-20T22:31:00.000Z',
    totals: { guest: { usedBytes: 3_000_000_000, totalBytes: 236_000_000_000 }, dataset: { usedBytes: 2_900_000_000, snapshotsBytes: 900 } },
    context: {}, guest: { status: 'Running', running: true, service: { unit: 'nodus.service', user: 'nodus', uid: 989, home: '/var/lib/nodus' } },
    items: [
      item({ id: ids.release, category: 'releases', kind: 'release', sub: 'sealed', path: releasePath(1), root: RELEASES, status: 'eligible', action: 'remove-release', allocatedBytes: 4000, label: 'Old release 1111111', identity: { type: 'dir', dev: 1, ino: 2, mtimeMs: 3, size: 4, uid: 0, markerSha: '1'.repeat(40) } }),
      item({ id: ids.group, category: 'temp', kind: 'group', path: null, root: '/tmp', status: 'eligible', action: 'remove', label: 'nodus-embed-* (2 folders)', memoryBacked: true, allocatedBytes: 10, newestMtimeMs: Date.parse('2026-10-15T00:00:00Z'), identity: { pattern: 'nodus-embed-*', parent: '/tmp' }, memberCount: 2, members: [{ path: '/tmp/nodus-embed-a1b2', kind: 'directory', identity: { type: 'dir', dev: 9, ino: 1, mtimeMs: 1, size: 4096 } }, { path: '/tmp/nodus-embed-c3d4', kind: 'directory', identity: { type: 'dir', dev: 9, ino: 2, mtimeMs: 1, size: 4096 } }] }),
      item({ id: ids.cache, category: 'caches', kind: 'directory', path: '/root/.cache/ms-playwright', root: '/root/.cache', status: 'eligible', action: 'remove', allocatedBytes: 300, label: 'Playwright browsers', newestMtimeMs: Date.parse('2026-09-01T00:00:00Z') }),
      item({ id: ids.journal, category: 'logs', kind: 'journal', sub: 'journal', path: '/var/log/journal', root: '/var/log', status: 'eligible', action: 'vacuum-journal', allocatedBytes: 600_000_000, targetBytes: 256 * 1024 * 1024, usageBytes: 600_000_000, recoverableBytes: 331_564_544, label: 'System journal' }),
      item({ id: ids.live, category: 'running_app', kind: 'release', sub: 'live', path: releasePath(3), status: 'protected', action: null, reason: 'The release the application is running now.' }),
      item({ id: ids.other, category: 'other', kind: 'directory', path: '/opt/nodus-w48', status: 'investigate', action: null, reason: 'Not created by ProxyPilot.' }),
      item({ id: ids.dump, category: 'history', kind: 'file', sub: 'dump', path: '/var/backups/proxypilot-db/app-pre-deploy-x.sql', root: '/var/backups/proxypilot-db', status: 'eligible', action: 'remove', allocatedBytes: 70, label: 'Old database copy', newestMtimeMs: Date.parse('2026-09-01T00:00:00Z'), identity: { type: 'file', dev: 1, ino: 7, mtimeMs: 3, size: 4 } }),
      item({ id: ids.staging, category: 'workspaces', kind: 'directory', path: `${RELEASES}/.staging/22222222-2222-4222-8222-222222222222-1`, root: `${RELEASES}/.staging`, status: 'eligible', action: 'remove', allocatedBytes: 900, label: 'Abandoned build workspace', newestMtimeMs: Date.parse('2026-10-19T00:00:00Z') }),
      item({ id: ids.hostBundle, category: 'archives', kind: 'directory', location: 'host', path: '/var/lib/proxypilot/application-release-transfers/bundle-AbC123', root: '/var/lib/proxypilot/application-release-transfers', status: 'eligible', action: 'remove', allocatedBytes: 800, label: 'Transfer copy', newestMtimeMs: Date.parse('2026-10-19T00:00:00Z') }),
      item({ id: ids.snap1, category: 'snapshots', kind: 'snapshot', location: 'host', path: null, root: null, status: 'eligible', action: 'delete-snapshot', identity: { name: 'snap-1', createdAt: '2026-10-01T12:00:00.123456789Z', stateful: false }, allocatedBytes: 100, label: 'snap-1' }),
      item({ id: ids.snap2, category: 'snapshots', kind: 'snapshot', location: 'host', path: null, root: null, status: 'eligible', action: 'delete-snapshot', identity: { name: 'snap-2', createdAt: '2026-10-02T12:00:01Z', stateful: false }, allocatedBytes: 200, label: 'snap-2' }),
      item({ id: ids.export1, category: 'exports', kind: 'export', location: 'host', path: null, root: null, status: 'eligible', action: 'delete-export', identity: { exportId: 7, createdAt: '2026-10-03T00:00:00Z', state: 'ready' }, allocatedBytes: 5000, label: 'Export #7' }),
    ],
    ...over,
  };
}
