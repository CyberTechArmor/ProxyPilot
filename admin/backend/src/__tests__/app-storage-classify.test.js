// Storage classification: every rule of DESIGN §2.3, over a real Nodus-like
// guest (the real collector against real directories) and over hand-built
// facts for the edge cases. Default is "Needs a look"; size and age alone
// never make anything eligible; everything the application needs is
// protected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { performCheck } from '../lib/app-storage/perform-check.js';
import { classify, buildContext, scanPlanFor, namePattern, isSealedRelease, GROUP_THRESHOLD } from '../lib/app-storage/classify.js';
import * as W from './helpers/app-storage-world.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const CHECK_ID = 'chk_00000000-0000-4000-8000-000000000001';
const inside = (root, p) => p === root || p.startsWith(`${root}/`);

async function nodusCheck(t, { activity = {}, snapshots = [], snapshotUsed = {}, exports = [], mutate = null } = {}) {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const world = W.buildNodusGuest(root, NOW);
  if (mutate) mutate(root, world);
  const release = W.holdOpen(`${root}/tmp/busy`);
  t.after(release);
  await new Promise((r) => setTimeout(r, 150));
  const exec = W.scriptedExec({ prefix: root, snapshots, snapshotUsed });
  const result = await performCheck({ target: W.nodusTarget(world), activity, exec, policy: null, now: NOW, checkId: CHECK_ID, listExports: () => exports });
  const at = (p) => result.items.find((it) => it.path === p);
  const label = (re) => result.items.find((it) => re.test(it.label));
  return { result, at, label, root, world };
}

test('a Nodus-like guest: running app, rollback, waiting candidate and the shared backing root are protected; only an older sealed release is eligible', async (t) => {
  const { result, at, label } = await nodusCheck(t);
  assert.equal(result.status, 'complete');
  const R = W.RELEASE_ROOT;
  const live = at(`${R}/${W.LIVE}`);
  assert.equal(live.category, 'running_app'); assert.equal(live.status, 'protected'); assert.equal(live.sub, 'live'); assert.equal(live.kind, 'release');
  assert.deepEqual(live.breakdown.map((b) => b.name).sort(), ['node_modules', 'release-evidence', 'test-results']);
  assert.match(live.reason, /running now/);
  const rollback = at(`${R}/${W.ROLLBACK}`);
  assert.deepEqual([rollback.category, rollback.status, rollback.sub], ['releases', 'protected', 'rollback']);
  assert.match(rollback.reason, /roll back/);
  const candidate = at(`${R}/${W.CANDIDATE}`);
  assert.deepEqual([candidate.status, candidate.sub], ['protected', 'candidate']);
  assert.match(candidate.reason, /waiting to be deployed/);
  const backing = at(`${R}/${W.ADOPTED}`);
  assert.deepEqual([backing.category, backing.status, backing.sub], ['releases', 'protected', 'backing']);
  assert.match(backing.reason, /shared data/);
  const old = at(`${R}/${W.OLD}`);
  assert.deepEqual([old.status, old.action, old.kind], ['eligible', 'remove-release', 'release']);
  assert.equal(old.identity.markerSha, W.OLD_SHA);
  assert.deepEqual(result.context.backingRoots, [`${R}/${W.ADOPTED}`]);
  // Models are measured as data on their own and not inside the backing root.
  const models = at(`${R}/${W.ADOPTED}/voice/models`);
  assert.deepEqual([models.category, models.status, models.sub], ['data', 'protected', 'models']);
  assert.equal(models.hint, 'Declared as /opt/nodus/voice/models');
  assert.ok(label(/^Release 3c932650 \(running now\)$/));
});

test('preserve paths, env files, databases and the operating system are protected; unknown folders need a look', async (t) => {
  const { at } = await nodusCheck(t);
  assert.deepEqual([at('/var/lib/nodus').category, at('/var/lib/nodus').status], ['data', 'protected']);
  const env = at('/etc/nodus/nodus.env');
  assert.deepEqual([env.category, env.status, env.sub], ['data', 'protected', 'settings']);
  assert.match(env.reason, /never read/);
  assert.deepEqual([at('/var/lib/postgresql').sub, at('/var/lib/postgresql').status], ['database', 'protected']);
  assert.equal(at('/usr').category, 'dependencies');
  assert.equal(at('/var/lib/dpkg').category, 'dependencies');
  assert.equal(at('/var/lib/apt').status, 'protected');
  const w48 = at('/opt/nodus-w48');
  assert.deepEqual([w48.category, w48.status], ['other', 'investigate']);
  assert.equal(w48.hint, 'A leftover working copy: its .git link no longer resolves.');
  assert.equal(at('/var/lib/nodus-publication').status, 'investigate');
  assert.equal(at(`${W.RELEASE_ROOT}/stray-notes.txt`).status, 'investigate');
  assert.equal(at('/var/backups/proxypilot-db/app-manual-20261001.sql').status, 'protected');
});

test('nothing eligible lies inside anything the application needs', async (t) => {
  const { result } = await nodusCheck(t);
  const keep = [result.context.liveRelease, result.context.rollbackRelease, result.context.waitingCandidate, ...result.context.backingRoots, '/var/lib/nodus', '/etc/nodus', '/var/lib/postgresql', '/usr', '/var/lib/dpkg'];
  // The one deliberate exception (rule 6): download caches in the service
  // user's home stay eligible even when that home is a preserved path.
  const homeCache = (p) => /^\/var\/lib\/nodus\/(\.npm\/(_cacache|_npx)|\.cache\/[^/]+)$/.test(p);
  for (const it of result.items.filter((x) => x.status === 'eligible' && x.path)) {
    for (const k of keep) assert.equal(inside(k, it.path) && !(k === '/var/lib/nodus' && homeCache(it.path) && it.category === 'caches'), false, `${it.path} is eligible inside ${k}`);
  }
  // Every eligible item names a removal action; no protected item does.
  for (const it of result.items) assert.equal(it.action == null, it.status !== 'eligible', it.label);
  // Ids are unique, short and stable for the check.
  const ids = result.items.map((it) => it.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-f0-9]{16}$/);
});

test('build workspaces: the active attempt is protected, an abandoned one is eligible, unknown names need a look', async (t) => {
  const activity = { activeAttempts: [`${W.ACTIVE_JOB}-1`], openJobIds: [W.ACTIVE_JOB, `${W.ACTIVE_JOB}-1`] };
  const { at } = await nodusCheck(t, { activity });
  const S = `${W.RELEASE_ROOT}/.staging`;
  assert.deepEqual([at(`${S}/${W.ACTIVE_JOB}-1`).status, at(`${S}/${W.ACTIVE_JOB}-1`).reason], ['protected', 'A build is using it.']);
  assert.deepEqual([at(`${S}/${W.OLD_JOB}-1`).category, at(`${S}/${W.OLD_JOB}-1`).status], ['workspaces', 'eligible']);
  assert.deepEqual([at(`${S}/${W.OLD_JOB}-1.bundle`).category, at(`${S}/${W.OLD_JOB}-1.bundle`).status], ['archives', 'eligible']);
  assert.equal(at(`${S}/operator-note`).status, 'investigate');
  // The containment record of the running job stays; the finished one may go.
  assert.equal(at(`/run/mock2-deploy/${W.ACTIVE_JOB}-1.units`).status, 'protected');
  assert.equal(at(`/run/mock2-deploy/${W.OLD_JOB}-1.units`).status, 'eligible');
});

test('an abandoned attempt changed within the hour is still protected', async (t) => {
  const { at } = await nodusCheck(t, { mutate: (root) => W.age(`${root}${W.RELEASE_ROOT}/.staging/${W.OLD_JOB}-1`, NOW - 10 * 60_000) });
  const it = at(`${W.RELEASE_ROOT}/.staging/${W.OLD_JOB}-1`);
  assert.equal(it.status, 'protected');
  assert.match(it.reason, /last hour/);
});

test('temporary files: in use, recent and service-private ones are protected; old unused ones are eligible and grouped', async (t) => {
  const { at, label } = await nodusCheck(t);
  assert.deepEqual([at('/tmp/busy').status, at('/tmp/busy').reason], ['protected', 'In use by a running process.']);
  assert.deepEqual([at('/tmp/tsx-989').status, at('/tmp/tsx-989').reason], ['protected', 'Changed in the last day.']);
  assert.equal(at('/tmp/systemd-private-0123456789abcdef-nodus.service-Sj5Zwh').status, 'protected');
  assert.equal(at('/tmp/playwright-download-Fs12Md').status, 'eligible');
  assert.equal(at('/var/tmp/nodus-w56-http.json').status, 'eligible');
  const group = label(/nodus-embed-\* \(6 folders\)/);
  assert.equal(group.kind, 'group');
  assert.equal(group.status, 'eligible');
  assert.equal(group.memberCount, 6);
  assert.equal(group.members.length, 6);
  assert.ok(group.members.every((m) => m.path.startsWith('/tmp/nodus-embed-') && m.identity.ino != null));
  assert.equal(group.path, null);
});

test('caches, logs and execution history follow their rules', async (t) => {
  const { at, label } = await nodusCheck(t);
  assert.equal(at('/var/lib/nodus/.npm/_cacache').status, 'eligible');
  const pw = at('/var/lib/nodus/.cache/ms-playwright');
  assert.deepEqual([pw.category, pw.status, pw.hint], ['caches', 'eligible', 'Tests download it again.']);
  assert.equal(at('/root/.cache/Microsoft').status, 'eligible');
  assert.equal(at('/var/cache/apt/archives/nodejs_22.deb').status, 'eligible');
  assert.equal(result_items_have(at, '/var/cache/apt/archives/lock'), false, 'apt lock is not a cache item');
  assert.equal(at('/var/log/nodus-image-e2e.log').status, 'eligible');
  assert.equal(at('/var/log/syslog.2.gz').status, 'eligible');
  assert.equal(at('/var/log/dpkg.log').status, 'protected');
  assert.equal(at('/var/log/postgresql/postgresql-17-main.log').status, 'protected');
  const journal = label(/^System journal$/);
  assert.deepEqual([journal.kind, journal.status], ['journal', 'protected']);
  const dumps = ['job3', 'job2', 'job1'].map((j) => at(`/var/backups/proxypilot-db/app-pre-deploy-${j}.sql`));
  assert.deepEqual(dumps.map((d) => d.status), ['protected', 'protected', 'eligible']);
  assert.deepEqual(dumps.map((d) => d.rank), [0, 1, 2]);
  const units = ['job3', 'job2', 'job1'].map((j) => at(`/etc/systemd/system/nodus.service.pre-${j}`));
  assert.deepEqual(units.map((d) => d.status), ['protected', 'protected', 'eligible']);
  assert.equal(at('/etc/environment.pre-job3').status, 'protected');
});
function result_items_have(at, p) { return !!at(p); }

test('while a build runs, caches and test output are protected', async (t) => {
  const { at } = await nodusCheck(t, { activity: { buildActive: true, reasons: ['An application validate job is running.'] } });
  const pw = at('/var/lib/nodus/.cache/ms-playwright');
  assert.deepEqual([pw.status, pw.reason], ['protected', 'A build is running.']);
});

test('host transfer leftovers: eligible when no application job is open anywhere, else protected', async (t) => {
  const a = await nodusCheck(t);
  assert.equal(a.at('/var/lib/proxypilot/application-release-transfers/bundle-a1b2c3').status, 'eligible');
  assert.equal(a.at('/var/lib/proxypilot/application-release-transfers/bundle-a1b2c3').location, 'host');
  const b = await nodusCheck(t, { activity: { anyApplicationJobOpen: true } });
  assert.equal(b.at('/var/lib/proxypilot/application-release-transfers/bundle-a1b2c3').status, 'protected');
});

test('snapshots and exports are separate items; protected while a restore runs or an export is being prepared', async (t) => {
  const snapshots = [{ name: 'snap0', created_at: '2026-10-18T10:00:00Z' }, { name: 'snap1', created_at: '2026-10-19T10:00:00Z' }];
  const exports = [{ id: 7, state: 'ready', bytes: 1200, createdAt: '2026-10-19T08:00:00Z', filename: 'a.tar.zst' }, { id: 8, state: 'preparing', bytes: 10, createdAt: '2026-10-20T08:00:00Z', filename: 'b.tar.zst' }, { id: 9, state: 'failed', bytes: 0, createdAt: '2026-10-20T08:00:00Z', filename: 'c.tar.zst' }];
  const a = await nodusCheck(t, { snapshots, snapshotUsed: { snap0: 40_000_000, snap1: 30_000_000 }, exports });
  const snaps = a.result.items.filter((it) => it.category === 'snapshots');
  assert.deepEqual(snaps.map((s) => [s.label, s.status, s.action, s.allocatedBytes]), [['snap0', 'eligible', 'delete-snapshot', 40_000_000], ['snap1', 'eligible', 'delete-snapshot', 30_000_000]]);
  assert.match(snaps[0].reason, /^A restore point from 2026-10-18 10:00 UTC\. Deleting it removes the option to restore to that point\.$/);
  assert.equal(snaps[0].identity.createdAt, '2026-10-18T10:00:00Z');
  const ex = a.result.items.filter((it) => it.category === 'exports');
  assert.deepEqual(ex.map((e) => [e.identity.exportId, e.status]), [[7, 'eligible'], [8, 'protected'], [9, 'eligible']]);
  const b = await nodusCheck(t, { snapshots, activity: { openRestoreJob: true } });
  assert.ok(b.result.items.filter((it) => it.category === 'snapshots').every((s) => s.status === 'protected' && s.action === null));
});

test('the rollback is the release of live.previousSha when known; an older validation is not a waiting candidate', async (t) => {
  const { at } = await nodusCheck(t, { mutate: (root, world) => {
    world.live.previousSha = W.OLD_SHA; // the oldest release is the recorded previous one
    world.candidates[0].validation.validatedAt = new Date(NOW - 3 * W.DAY).toISOString();
    world.candidates[0].checkpointAt = new Date(NOW - 3 * W.DAY).toISOString();
  } });
  const R = W.RELEASE_ROOT;
  assert.equal(at(`${R}/${W.OLD}`).sub, 'rollback');
  assert.equal(at(`${R}/${W.ROLLBACK}`).status, 'eligible', 'the newer non-previous release is no longer needed');
  assert.equal(at(`${R}/${W.CANDIDATE}`).status, 'eligible', 'validated before the live release was verified');
});

/* ------------------------------ hand-built facts ------------------------------ */

let ino = 100;
function facts(roots, items, extra = {}) {
  return {
    ok: true, rootDev: 1, journal: { bytes: 0 }, resolved: {}, tracked: {}, service: null, budgetExceeded: false,
    fs: [{ path: '/', mount: '/', fstype: 'zfs', totalBytes: 10e9, freeBytes: 7e9, availBytes: 7e9 }],
    roots: roots.map((r, i) => ({ i, declared: r.path, depth: 0, exists: true, ...r })),
    items: items.map((it) => ({ type: 'dir', uid: 0, mode: 0o755, dev: 1, ino: ino++, files: 1, logicalBytes: 1000, allocatedBytes: 1000, mtimeMs: NOW - 30 * W.DAY, newestMtimeMs: NOW - 30 * W.DAY, name: it.path.split('/').pop(), ...it })),
    ...extra,
  };
}
const appTarget = { key: 'application:2', kind: 'application', id: 2, name: 'App', guest: 'pp-app', targetId: 'app', profile: { sourceDir: '/srv/app', releaseRoot: null, preservePaths: [], envFiles: [] }, live: null, candidates: [] };
const projTarget = { key: 'project:4', kind: 'project', id: 4, name: 'Proj', guest: 'm2-4', repoPath: '/var/lib/proxypilot/mock2/repos/4.git', appDir: '/srv/app' };
function run(target, f, { context = {}, host = null } = {}) {
  const ctx = { ...buildContext({ target, activity: context, facts: f }), ...context };
  const out = classify({ target, context: ctx, facts: f, host, now: NOW, checkId: CHECK_ID });
  return { ...out, at: (p) => out.items.find((it) => it.path === p) };
}

test('size and age alone never make anything eligible: a huge, years-old unknown folder needs a look', () => {
  const r = run(appTarget, facts([{ path: '/opt', depth: 1, role: 'other' }, { path: '/var/lib', depth: 1, role: 'other' }], [
    { path: '/opt/giant', r: 0, logicalBytes: 80e9, allocatedBytes: 50e9, mtimeMs: NOW - 900 * W.DAY, newestMtimeMs: NOW - 900 * W.DAY },
    { path: '/var/lib/docker', r: 1, allocatedBytes: 30e9, newestMtimeMs: NOW - 400 * W.DAY },
    { path: '/opt/notes.old', r: 0, type: 'file' },
  ]));
  assert.deepEqual([r.at('/opt/giant').status, r.at('/opt/giant').category], ['investigate', 'other']);
  assert.equal(r.at('/var/lib/docker').status, 'investigate');
  assert.equal(r.at('/opt/notes.old').hint, 'An old backup file.');
  assert.equal(r.items.filter((it) => it.status === 'eligible').length, 0);
});

test('temp rules: sockets, mount points and other accounts are protected; the service user may own eligible temp', () => {
  const f = facts([{ path: '/tmp', depth: 1, role: 'temp' }], [
    { path: '/tmp/.X11-unix', r: 0 },
    { path: '/tmp/app.sock', r: 0, type: 'other', special: 'socket' },
    { path: '/tmp/mnt', r: 0, mountPoint: true, crossesDevice: true },
    { path: '/tmp/someone-elses', r: 0, uid: 1001 },
    { path: '/tmp/service-owned', r: 0, uid: 989 },
    { path: '/tmp/fresh', r: 0, newestMtimeMs: NOW - 3_600_000 },
    { path: '/tmp/old-link', r: 0, type: 'link', linkTarget: '/nowhere' },
  ], { service: { unit: 'app.service', user: 'app', uid: 989, home: '/var/lib/app' } });
  const r = run(appTarget, f);
  assert.equal(r.at('/tmp/.X11-unix').status, 'protected');
  assert.deepEqual([r.at('/tmp/app.sock').status, r.at('/tmp/app.sock').reason], ['protected', 'A system socket.']);
  assert.deepEqual([r.at('/tmp/mnt').status, r.at('/tmp/mnt').reason], ['protected', 'A mount point.']);
  assert.deepEqual([r.at('/tmp/someone-elses').status, r.at('/tmp/someone-elses').reason], ['protected', 'Belongs to another account.']);
  assert.equal(r.at('/tmp/service-owned').status, 'eligible');
  assert.equal(r.at('/tmp/fresh').status, 'protected');
  assert.equal(r.at('/tmp/old-link').status, 'eligible');
  assert.match(r.at('/tmp/old-link').reason, /never followed/);
});

test('a group is eligible only when every member is: members in use or recent are split out and protected', () => {
  const items = [];
  for (let i = 0; i < 7; i += 1) items.push({ path: `/tmp/pulse-Ab${i}xY`, r: 0 });
  items.push({ path: '/tmp/pulse-Zz9fresh', r: 0, newestMtimeMs: NOW - 60_000 });
  items.push({ path: '/tmp/pulse-Qq8busy', r: 0, inUse: true });
  for (let i = 0; i < GROUP_THRESHOLD - 1; i += 1) items.push({ path: `/tmp/small-${i}1a2b`, r: 0 });
  const r = run(appTarget, facts([{ path: '/tmp', depth: 1, role: 'temp' }], items));
  const groups = r.items.filter((it) => it.kind === 'group');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].status, 'eligible');
  assert.equal(groups[0].memberCount, 7);
  assert.equal(groups[0].label, '/tmp/pulse-* (7 folders)');
  assert.equal(r.at('/tmp/pulse-Zz9fresh').status, 'protected');
  assert.equal(r.at('/tmp/pulse-Qq8busy').status, 'protected');
  assert.equal(r.items.filter((it) => it.path?.startsWith('/tmp/small-')).length, GROUP_THRESHOLD - 1, 'below the threshold siblings stay single items');
});

test('test reports: tracked ones are part of the source, untracked ones are eligible, unknown tracking needs a look', () => {
  const roots = [{ path: '/srv/app/test-results', role: 'test-report' }, { path: '/srv/app/coverage', role: 'test-report' }, { path: '/srv/app/playwright-report', role: 'test-report' }];
  const items = [{ path: '/srv/app/test-results', r: 0 }, { path: '/srv/app/coverage', r: 1 }, { path: '/srv/app/playwright-report', r: 2 }];
  const r = run(projTarget, facts(roots, items, { tracked: { '/srv/app': { ok: true, paths: ['coverage/lcov.info'] } } }));
  assert.equal(r.at('/srv/app/test-results').status, 'eligible');
  assert.deepEqual([r.at('/srv/app/coverage').status, r.at('/srv/app/coverage').reason], ['protected', 'Part of the source (tracked in Git).']);
  const unknown = run(projTarget, facts(roots, items, { tracked: { '/srv/app': { ok: false, paths: [] } } }));
  assert.equal(unknown.at('/srv/app/test-results').status, 'investigate');
  const building = run(projTarget, facts(roots, items, { tracked: { '/srv/app': { ok: true, paths: [] } } }), { context: { buildActive: true } });
  assert.equal(building.at('/srv/app/test-results').status, 'protected');
});

test('Dev Studio project: the app dir and its data are protected, check results age out, the repo is measured on the host', () => {
  const f = facts([
    { path: '/srv/app/state/db', role: 'project-data' }, { path: '/srv/app/.mock2/cache', role: 'project-cache' },
    { path: '/srv/app/.mock2/evidence', depth: 1, role: 'evidence' }, { path: '/srv/app', role: 'app-dir' }, { path: '/srv/repo.git', role: 'repo-mount' },
  ], [
    { path: '/srv/app/state/db', r: 0 }, { path: '/srv/app/.mock2/cache', r: 1 },
    { path: '/srv/app/.mock2/evidence/run-old.json', r: 2, type: 'file' }, { path: '/srv/app/.mock2/evidence/run-new.json', r: 2, type: 'file', newestMtimeMs: NOW - W.DAY },
    { path: '/srv/app', r: 3, breakdown: [{ name: 'node_modules', logicalBytes: 5, allocatedBytes: 5, files: 1 }] }, { path: '/srv/repo.git', r: 4, mountPoint: true, crossesDevice: true },
  ]);
  const host = { status: 'Running', running: true, unmeasured: [], snapshots: [], exports: [], hostFiles: { roots: [{ i: 0, path: '/var/lib/proxypilot/mock2/repos/4.git', role: 'host-repo' }], items: [{ path: '/var/lib/proxypilot/mock2/repos/4.git', r: 0, type: 'dir', allocatedBytes: 7e8, logicalBytes: 9e8, files: 100, dev: 9, ino: 5 }] } };
  const r = run(projTarget, f, { host });
  assert.deepEqual([r.at('/srv/app/state/db').category, r.at('/srv/app/state/db').sub], ['data', 'database']);
  assert.equal(r.at('/srv/app/.mock2/cache').status, 'eligible');
  assert.equal(r.at('/srv/app/.mock2/evidence/run-old.json').status, 'eligible');
  assert.deepEqual([r.at('/srv/app/.mock2/evidence/run-new.json').status, r.at('/srv/app/.mock2/evidence/run-new.json').reason], ['protected', 'Recent check results.']);
  assert.deepEqual([r.at('/srv/app').category, r.at('/srv/app').status], ['running_app', 'protected']);
  assert.equal(r.items.filter((it) => it.path === '/srv/repo.git').length, 0, 'the mounted repo is not counted inside the guest');
  const repo = r.at('/var/lib/proxypilot/mock2/repos/4.git');
  assert.deepEqual([repo.category, repo.status, repo.location], ['data', 'protected', 'host']);
});

test('the journal is eligible for a vacuum only above its limit; the recoverable part is an estimate', () => {
  const f = facts([{ path: '/var/log/journal', role: 'journal' }], [{ path: '/var/log/journal', r: 0, allocatedBytes: 900e6, logicalBytes: 1e9 }], { journal: { bytes: 600 * 1024 * 1024 } });
  const r = classify({ target: appTarget, context: buildContext({ target: appTarget, facts: f }), facts: f, policy: { rules: { logs: { journalMaxMB: 256 } } }, now: NOW, checkId: CHECK_ID });
  const j = r.items.find((it) => it.kind === 'journal');
  assert.deepEqual([j.status, j.action], ['eligible', 'vacuum-journal']);
  assert.equal(j.targetBytes, 256 * 1024 * 1024);
  assert.equal(j.recoverableBytes, (600 - 256) * 1024 * 1024);
  assert.equal(j.reason, 'Keeps the newest 256 MB of system logs.');
  assert.equal(r.categories.find((c) => c.key === 'logs').eligibleBytes, (600 - 256) * 1024 * 1024);
});

test('a release-looking folder without a valid marker or owner is not treated as sealed', () => {
  const name = 'a'.repeat(40) + '-p1-' + '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12);
  assert.equal(isSealedRelease({ type: 'dir', name, uid: 0, mode: 0o755, marker: { present: true } }), true);
  assert.equal(isSealedRelease({ type: 'dir', name, uid: 0, mode: 0o775, marker: { present: true } }), false, 'group-writable');
  assert.equal(isSealedRelease({ type: 'dir', name, uid: 1000, mode: 0o755, marker: { present: true } }), false, 'not root-owned');
  assert.equal(isSealedRelease({ type: 'dir', name, uid: 0, mode: 0o755 }), false, 'no marker');
  assert.equal(isSealedRelease({ type: 'dir', name, uid: 0, mode: 0o755, marker: { present: false, unsafe: true } }), false, 'marker is a link');
});

test('name patterns strip random suffixes only', () => {
  assert.equal(namePattern('nodus-embed-Ab12Cd'), 'nodus-embed-*');
  assert.equal(namePattern('pulse-Rk3jW'), 'pulse-*');
  assert.equal(namePattern('mat-debug-12.log'), 'mat-debug-*.log');
  assert.equal(namePattern('playwright_chromiumdev_profile-uQmWP1'), 'playwright_chromiumdev_profile-*');
  assert.equal(namePattern('tsx-989'), 'tsx-*');
  assert.equal(namePattern('nodus-w48-final'), null, 'plain words are not random');
  assert.equal(namePattern('systemd'), null);
});

test('the scan plan is fixed by the target: data first, then releases, then everything else', () => {
  const plan = scanPlanFor(W.nodusTarget({ profile: { sourceDir: '/opt/nodus', releaseRoot: '/opt/nodus-releases', serviceName: 'nodus.service', preservePaths: ['/var/lib/nodus'], envFiles: ['/etc/nodus/nodus.env'] }, live: null, candidates: [] }));
  const roles = plan.roots.map((r) => r.role);
  assert.ok(roles.indexOf('preserve') < roles.indexOf('release-root'));
  assert.ok(roles.indexOf('release-root') < roles.indexOf('temp'));
  assert.equal(plan.service, 'nodus.service');
  assert.deepEqual(plan.resolve, ['/opt/nodus', '/var/lib/nodus', '/etc/nodus/nodus.env']);
  assert.equal(plan.roots.find((r) => r.role === 'release-root').marker, true);
  assert.ok(plan.roots.some((r) => r.path === '~service/.cache'));
  const p = scanPlanFor(projTarget);
  assert.equal(p.service, 'mock2-dev.service');
  assert.deepEqual(p.tracked, [{ repo: '/srv/app', paths: ['test-results', 'playwright-report', 'coverage', '.nyc_output'] }]);
});

test('a stopped guest, a guest without Node.js and an unknown guest are reported honestly', async (t) => {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const world = W.buildNodusGuest(root, NOW);
  const stopped = await performCheck({ target: W.nodusTarget(world), exec: W.scriptedExec({ prefix: root, status: 'Stopped' }), now: NOW, checkId: CHECK_ID, listExports: () => [] });
  assert.equal(stopped.status, 'partial');
  assert.deepEqual(stopped.unmeasured[0], { area: 'guest files', reason: 'The guest is stopped, so its files could not be measured' });
  assert.ok(stopped.items.some((it) => it.location === 'host'), 'host-side facts are still shown');
  assert.equal(stopped.items.some((it) => it.kind === 'pseudo'), false);
  const noNode = await performCheck({ target: W.nodusTarget(world), exec: W.scriptedExec({ prefix: root, noNode: true }), now: NOW, checkId: CHECK_ID, listExports: () => [] });
  assert.equal(noNode.status, 'partial');
  assert.match(noNode.unmeasured[0].reason, /Node\.js is not installed in this guest/);
  const missing = await performCheck({ target: { ...W.nodusTarget(world), guest: 'pp-gone' }, exec: W.scriptedExec({ prefix: root }), now: NOW, checkId: CHECK_ID, listExports: () => [] });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error.code, 'GUEST_NOT_FOUND');
  const broken = await performCheck({ target: W.nodusTarget(world), exec: null, now: NOW, checkId: CHECK_ID });
  assert.equal(broken.status, 'failed');
  assert.equal(broken.error.code, 'NO_EXECUTOR');
});
