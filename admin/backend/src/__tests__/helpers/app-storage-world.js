// Test world for the application storage check: a Nodus-like guest layout
// built from REAL directories under a temp prefix, and a scripted executor
// whose guest/host calls run the REAL collector program against that prefix
// (paths are rewritten in and out, like a chroot), while `incus query` and
// `zfs get` answer from fixtures. Used by app-storage-*.test.js.

import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, linkSync, utimesSync, lutimesSync, readdirSync, lstatSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SCAN_PROGRAM } from '../../lib/app-storage/scan-program.js';
import { APPLICATION_RELEASE_SCHEMA } from '../../mock2/application-profile.js';
import { APP_STORAGE_SCHEMA, INSTALLED_AT_SETTING } from '../../lib/app-storage/store.js';
import { SETUP_ENGINE_SCHEMA } from '../../lib/setup-engine/store.js';

export const DAY = 86_400_000;
export const LIVE_SHA = '3c932650511871784d485e98e1808b9e8b5c4fd5';
export const ROLLBACK_SHA = '62a4fbff00000000000000000000000000000000';
export const OLD_SHA = '1111111111111111111111111111111111111111';
export const CANDIDATE_SHA = '241d346400000000000000000000000000000000';
export const LIVE = `${LIVE_SHA}-p6-f3ec00f4-01ac-4fd0-a1bf-2e447ccc8709`;
export const ROLLBACK = `${ROLLBACK_SHA}-p6-b981f91d-8e7b-4e09-94cb-e93853de3d11`;
export const OLD = `${OLD_SHA}-p5-aaaaaaaa-1111-4111-8111-111111111111`;
export const CANDIDATE = `${CANDIDATE_SHA}-p6-cccccccc-2222-4222-8222-222222222222`;
export const ADOPTED = 'adopted-c5adcdaf5bf2b0263831a75aeffd3e426e153fc0';
export const ACTIVE_JOB = 'dddddddd-3333-4333-8333-333333333333';
export const OLD_JOB = 'eeeeeeee-4444-4444-8444-444444444444';
export const RELEASE_ROOT = '/opt/nodus-releases';

export function makeRoot(prefix = 'pp-app-storage-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Set mtime (and atime) of a path and, for a directory, everything inside it. */
export function age(path, ms) {
  const t = new Date(ms);
  const st = lstatSync(path);
  if (st.isDirectory()) for (const n of readdirSync(path)) age(join(path, n), ms);
  if (st.isSymbolicLink()) lutimesSync(path, t, t); else utimesSync(path, t, t);
}

function file(root, rel, bytes = 100, content = null) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content ?? Buffer.alloc(bytes, 97));
  return p;
}
function dir(root, rel) { const p = join(root, rel); mkdirSync(p, { recursive: true }); return p; }
function release(root, name, sha, at) {
  const r = dir(root, `${RELEASE_ROOT.slice(1)}/${name}`);
  file(r, 'node_modules/pkg/index.js', 4000);
  file(r, 'dist/server/index.js', 2000);
  file(r, 'release-evidence/test.log', 3000);
  file(r, 'test-results/shot.png', 5000);
  file(r, '.proxypilot-release.json', 0, JSON.stringify({ sha, treeSha: 'b'.repeat(40), artifactDigest: 'c'.repeat(64) }));
  dir(r, 'voice');
  symlinkSync(join(root, `${RELEASE_ROOT.slice(1)}/${ADOPTED}/voice/models`), join(r, 'voice/models'));
  age(r, at);
  chmodSync(r, 0o755);
  return r;
}

/**
 * Build the Nodus-like guest under `root` (as if `root` were `/`). Returns
 * the profile, live record and candidates as the target would carry them.
 */
export function buildNodusGuest(root, now = Date.now()) {
  const rr = dir(root, RELEASE_ROOT.slice(1));
  chmodSync(rr, 0o755);
  // Shared backing root: the adopted checkout that holds the models.
  file(root, `${RELEASE_ROOT.slice(1)}/${ADOPTED}/voice/models/wespeaker.onnx`, 26_000);
  file(root, `${RELEASE_ROOT.slice(1)}/${ADOPTED}/embed/models/bge/model_quantized.onnx`, 34_000);
  file(root, `${RELEASE_ROOT.slice(1)}/${ADOPTED}/node_modules/old/index.js`, 9000);
  file(root, `${RELEASE_ROOT.slice(1)}/${ADOPTED}/package-lock.json.old`, 2000);
  age(join(rr, ADOPTED), now - 6 * DAY);
  release(root, OLD, OLD_SHA, now - 5 * DAY);
  release(root, ROLLBACK, ROLLBACK_SHA, now - 2 * DAY);
  release(root, LIVE, LIVE_SHA, now - 1 * DAY);
  release(root, CANDIDATE, CANDIDATE_SHA, now - 2 * 3_600_000);
  file(root, `${RELEASE_ROOT.slice(1)}/stray-notes.txt`, 50);
  // Build workspaces.
  dir(root, `${RELEASE_ROOT.slice(1)}/.staging/${OLD_JOB}-1/node_modules`);
  file(root, `${RELEASE_ROOT.slice(1)}/.staging/${OLD_JOB}-1/node_modules/x.js`, 7000);
  file(root, `${RELEASE_ROOT.slice(1)}/.staging/${OLD_JOB}-1.bundle`, 3000);
  age(join(rr, '.staging', `${OLD_JOB}-1`), now - 3 * 3_600_000);
  age(join(rr, '.staging', `${OLD_JOB}-1.bundle`), now - 3 * 3_600_000);
  file(root, `${RELEASE_ROOT.slice(1)}/.staging/${ACTIVE_JOB}-1/package.json`, 100);
  file(root, `${RELEASE_ROOT.slice(1)}/.staging/operator-note`, 10);
  symlinkSync(join(root, RELEASE_ROOT.slice(1), LIVE), join(root, 'opt/nodus'));
  // An orphaned worktree whose .git link no longer resolves.
  file(root, 'opt/nodus-w48/.git', 0, 'gitdir: /opt/nodus/.git/worktrees/nodus-w48\n');
  file(root, 'opt/nodus-w48/test-results/a.png', 6000);
  // Data, settings, databases, OS.
  file(root, 'var/lib/nodus/handoff/note.md', 900);
  file(root, 'var/lib/nodus/.npm/_cacache/index-v5/aa', 1500);
  file(root, 'var/lib/nodus/.npm/_logs/debug.log', 200);
  file(root, 'var/lib/nodus/.cache/ms-playwright/chromium/chrome', 8000);
  age(join(root, 'var/lib/nodus/.cache'), now - 3 * DAY);
  linkSync(join(root, 'var/lib/nodus/handoff/note.md'), join(root, 'opt/nodus-w48/note-hardlink.md'));
  file(root, 'etc/nodus/nodus.env', 0, 'SECRET=never-read\n');
  file(root, 'var/lib/postgresql/17/main/base/1', 12_000);
  file(root, 'var/lib/apt/lists/deb.debian.org_dists', 3000);
  file(root, 'var/lib/nodus-publication/chat/source/x.js', 700);
  file(root, 'usr/bin/node', 50_000);
  file(root, 'var/lib/dpkg/status', 1000);
  // Temporary files.
  for (let i = 0; i < 6; i += 1) { file(root, `tmp/nodus-embed-Ab${i}cD9/model_quantized.onnx`, 725); }
  for (let i = 0; i < 6; i += 1) age(join(root, `tmp/nodus-embed-Ab${i}cD9`), now - 3 * DAY);
  file(root, 'tmp/playwright-download-Fs12Md/chromium.zip', 20_000);
  age(join(root, 'tmp/playwright-download-Fs12Md'), now - 2 * DAY);
  file(root, 'tmp/tsx-989/cache.json', 4000);
  file(root, 'tmp/busy/held.txt', 100);
  age(join(root, 'tmp/busy'), now - 5 * DAY);
  dir(root, 'tmp/systemd-private-0123456789abcdef-nodus.service-Sj5Zwh/tmp');
  age(join(root, 'tmp/systemd-private-0123456789abcdef-nodus.service-Sj5Zwh'), now - 20 * DAY);
  file(root, 'var/tmp/nodus-w56-http.json', 300);
  age(join(root, 'var/tmp/nodus-w56-http.json'), now - 10 * DAY);
  // Logs.
  file(root, 'var/log/journal/62dc/system.journal', 9000);
  file(root, 'var/log/nodus-image-e2e.log', 4000); age(join(root, 'var/log/nodus-image-e2e.log'), now - 20 * DAY);
  file(root, 'var/log/syslog.2.gz', 1000); age(join(root, 'var/log/syslog.2.gz'), now - 10 * DAY);
  file(root, 'var/log/dpkg.log', 2000);
  file(root, 'var/log/postgresql/postgresql-17-main.log', 3000);
  // Execution history.
  for (const [i, d] of [[1, 9], [2, 5], [3, 1]]) {
    const dump = file(root, `var/backups/proxypilot-db/app-pre-deploy-job${i}.sql`, 1000 * i); age(dump, now - d * DAY);
    const unit = file(root, `etc/systemd/system/nodus.service.pre-job${i}`, 300); age(unit, now - d * DAY);
  }
  file(root, 'var/backups/proxypilot-db/app-manual-20261001.sql', 800);
  file(root, 'etc/environment.pre-job3', 50);
  file(root, `run/mock2-deploy/${ACTIVE_JOB}-1.units`, 40);
  file(root, `run/mock2-deploy/${OLD_JOB}-1.units`, 40);
  // Caches.
  file(root, 'root/.cache/Microsoft/DeveloperTools/.onnxruntime', 3800);
  file(root, 'var/cache/apt/archives/nodejs_22.deb', 9000);
  file(root, 'var/cache/apt/archives/lock', 0);
  // Host side: a transfer bundle left by an interrupted build.
  file(root, 'host/var/lib/proxypilot/application-release-transfers/bundle-app1-a1b2c3/source.bundle', 5000);
  age(join(root, 'host/var/lib/proxypilot/application-release-transfers/bundle-app1-a1b2c3'), now - 4 * 3_600_000);

  const profile = {
    sourceDir: '/opt/nodus', releaseRoot: RELEASE_ROOT, serviceName: 'nodus.service', healthUrl: 'http://127.0.0.1:3000/ready',
    preservePaths: ['/var/lib/nodus', '/opt/nodus/voice/models'], envFiles: ['/etc/nodus/nodus.env'], revision: 6,
  };
  const live = { sha: LIVE_SHA, releasePath: `${RELEASE_ROOT}/${LIVE}`, previousSha: null, verifiedAt: new Date(now - 1 * DAY).toISOString(), restored: false };
  const candidates = [
    { sha: CANDIDATE_SHA, checkpointAt: new Date(now - 3 * 3_600_000).toISOString(), validation: { passed: true, releasePath: `${RELEASE_ROOT}/${CANDIDATE}`, validatedAt: new Date(now - 2 * 3_600_000).toISOString() } },
    { sha: LIVE_SHA, checkpointAt: new Date(now - 30 * 3_600_000).toISOString(), validation: { passed: true, releasePath: `${RELEASE_ROOT}/${LIVE}`, validatedAt: new Date(now - 29 * 3_600_000).toISOString() } },
  ];
  return { profile, live, candidates };
}

export function nodusTarget(world) {
  return { key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus', targetId: 'nodus', createdAt: '2026-09-27T10:00:00.000Z', profile: world.profile, live: world.live, candidates: world.candidates };
}

/** Rewrite the collector's input into the prefix, run it, rewrite its output back. */
// describeReleases' input under the prefix: every path it reads.
function prefixReleases(r, P) {
  return {
    ...r,
    profile: { ...r.profile, sourceDir: P(r.profile.sourceDir), releaseRoot: P(r.profile.releaseRoot), preservePaths: (r.profile.preservePaths || []).map(P), envFiles: (r.profile.envFiles || []).map(P) },
    rollback: P(r.rollback),
    previousLive: r.previousLive ? { ...r.previousLive, path: P(r.previousLive.path) } : null,
    validated: (r.validated || []).map((v) => ({ ...v, path: P(v.path) })),
  };
}

export function runScanUnder(prefix, input, { home = '/var/lib/nodus', viaShell = true } = {}) {
  const P = (x) => (typeof x === 'string' && x.startsWith('/') ? prefix + x : x);
  const data = {
    ...input,
    roots: (input.roots || []).map((r) => ({ ...r, path: typeof r.path === 'string' && r.path.startsWith('~service') ? prefix + home + r.path.slice('~service'.length) : P(r.path) })),
    resolve: (input.resolve || []).map(P),
    tracked: (input.tracked || []).map((t) => ({ ...t, repo: P(t.repo) })),
    statfs: (input.statfs || []).map(P),
    service: null,
    ...(input.releases ? { releases: prefixReleases(input.releases, P) } : {}),
  };
  const b64 = Buffer.from(JSON.stringify(data)).toString('base64');
  const r = viaShell
    ? spawnSync('sh', ['-c', 'cd / && exec node -e "$1" "$2"; ', 'sh', SCAN_PROGRAM, b64], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('node', ['-e', SCAN_PROGRAM, b64], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stdout = String(r.stdout || '').split(prefix).join('');
  // Keys of `resolved` and `tracked` were prefixed too; the split/join restores them.
  return { code: r.status, stdout, stderr: r.stderr };
}

/**
 * The scripted executor: exec.guest runs the real collector under
 * `prefix`; exec.host answers incus/zfs from fixtures and runs host scans
 * under `${prefix}/host`.
 */
export function scriptedExec({ prefix, guest = 'pp-nodus', status = 'Running', snapshots = [], snapshotUsed = {}, zfs = null, rootSize = '220GiB', usage = 2_956_918_784, pool = 'Storage', driver = 'zfs', noNode = false, calls = [] } = {}) {
  const instance = {
    name: guest, status, type: 'container',
    expanded_devices: { root: { type: 'disk', path: '/', pool, size: rootSize } },
    state: { disk: { root: { usage } } },
    snapshots: snapshots.map((s) => ({ name: s.name, created_at: s.created_at, stateful: false })),
  };
  const zfsOut = zfs || { used: 2956898304, referenced: 3155775488, usedbysnapshots: 120_000_000, usedbydataset: 2836898304, logicalused: 6200000000, logicalreferenced: 6600000000, compressratio: '2.10', refquota: 0, quota: 236223201280, available: 233266216960 };
  return {
    calls,
    async guest(container, script) {
      calls.push(['guest', container]);
      if (container !== guest) return { code: 1, stdout: '', stderr: 'not found' };
      if (noNode) return { code: 127, stdout: 'NO_NODE\n', stderr: '' };
      const m = /'([A-Za-z0-9+/=]+)'\n$/.exec(script);
      const input = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      return runScanUnder(prefix, input);
    },
    async host(argv) {
      calls.push(['host', ...argv.slice(0, 3)]);
      const [bin, a1, a2] = argv;
      if (bin === 'incus' && a1 === 'query' && a2 === `/1.0/instances/${guest}?recursion=1`) return { code: 0, stdout: JSON.stringify(instance) };
      if (bin === 'incus' && a1 === 'query' && a2 === `/1.0/storage-pools/${pool}`) return { code: 0, stdout: JSON.stringify({ name: pool, driver, config: { source: 'Fractionate-ZFS/incus' } }) };
      if (bin === 'incus' && a1 === 'query' && /\/snapshots\/[^/]+\/state$/.test(a2)) {
        const snap = a2.split('/snapshots/')[1].split('/')[0];
        return snapshotUsed[snap] == null ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify({ usage: { used: snapshotUsed[snap] } }) };
      }
      if (bin === 'zfs' && a1 === 'get') return { code: 0, stdout: Object.entries(zfsOut).map(([k, v]) => `${k}\t${v}`).join('\n') + '\n' };
      if (bin === 'incus' && a1 === 'list') return { code: 0, stdout: JSON.stringify([instance]) };
      if (bin === 'node' && a1 === '-e') {
        const input = JSON.parse(Buffer.from(argv[3], 'base64').toString('utf8'));
        return runScanUnder(`${prefix}/host`, input, { viaShell: false });
      }
      return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
    },
  };
}

/** Hold `path` as a process's working directory (so the collector sees it in use). */
export function holdOpen(path) {
  const child = spawn('sleep', ['60'], { cwd: path, stdio: 'ignore' });
  return () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
}

/** An in-memory mock2.db with the application, project and storage tables, and a main DB with the setup engine. */
export function databases({ installedAt = '2026-10-20T22:00:00.000Z' } = {}) {
  const mock2Db = new DatabaseSync(':memory:');
  mock2Db.exec('CREATE TABLE mock2_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by INTEGER);');
  mock2Db.exec(`CREATE TABLE mock2_projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, container_name TEXT, lifecycle TEXT NOT NULL DEFAULT 'active', repo_path TEXT NOT NULL, created_at TEXT, archived_at TEXT);
    CREATE TABLE mock2_cycles (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE mock2_build_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE mock2_locks (project_id INTEGER PRIMARY KEY, holder_user_id INTEGER, holder_cycle_id INTEGER, acquired_at TEXT NOT NULL, last_write_at TEXT NOT NULL);`);
  mock2Db.exec(APPLICATION_RELEASE_SCHEMA);
  mock2Db.exec(APP_STORAGE_SCHEMA);
  if (installedAt) mock2Db.prepare('INSERT INTO mock2_settings (key, value, updated_at) VALUES (?, ?, ?)').run(INSTALLED_AT_SETTING, installedAt, installedAt);
  const mainDb = new DatabaseSync(':memory:');
  mainDb.exec(SETUP_ENGINE_SCHEMA);
  mainDb.exec(`CREATE TABLE lxc_exports (id INTEGER PRIMARY KEY AUTOINCREMENT, container_name TEXT NOT NULL, snapshot_name TEXT, path TEXT NOT NULL, filename TEXT NOT NULL, compression TEXT NOT NULL, state TEXT NOT NULL, bytes_done INTEGER NOT NULL DEFAULT 0, bytes_total INTEGER, sha256 TEXT, error TEXT, created_at TEXT NOT NULL, created_by TEXT, ready_at TEXT, expires_at TEXT, downloads INTEGER NOT NULL DEFAULT 0, last_downloaded_at TEXT);`);
  return { mock2Db, mainDb };
}

/** Register the Nodus application (profile revision 6) in mock2Db. */
export function registerNodus(mock2Db, world, { createdAt = '2026-09-27T10:00:00.000Z', targetId = 'nodus', name = 'Nodus' } = {}) {
  const info = mock2Db.prepare('INSERT INTO mock2_applications (target_id, name, repository_path, profile_revision, created_at, imported_at, live_json) VALUES (?, ?, ?, 6, ?, ?, ?)')
    .run(targetId, name, '/var/lib/proxypilot/application-repositories/1/repo.git', createdAt, createdAt, JSON.stringify(world?.live || null));
  const id = Number(info.lastInsertRowid);
  const p = { name, targetId, sourceDir: world?.profile?.sourceDir || '/opt/nodus', serviceName: 'nodus.service', healthUrl: 'http://127.0.0.1:3000/ready', installScript: null, buildScript: 'build', validationScripts: ['test'], preservePaths: world?.profile?.preservePaths || [], envFiles: world?.profile?.envFiles || [], connectorId: 1, remoteRepo: 'fractionate/nodus', remoteBranch: 'main', releaseRoot: world?.profile?.releaseRoot || null };
  mock2Db.prepare('INSERT INTO mock2_application_profiles VALUES (?, ?, ?, ?, ?)').run(id, 6, 'd'.repeat(64), JSON.stringify(p), createdAt);
  for (const c of world?.candidates || []) {
    mock2Db.prepare('INSERT INTO mock2_application_candidates (application_id, sha, profile_revision, profile_digest, tree_sha, checkpoint_at, hygiene_json, validation_json) VALUES (?, ?, 6, ?, ?, ?, ?, ?)')
      .run(id, c.sha, 'd'.repeat(64), 'b'.repeat(40), c.checkpointAt, '{"passed":true}', JSON.stringify(c.validation));
  }
  return id;
}

/**
 * The deploy history of the fixture: the rollback release was live before
 * the current one (its candidate row keeps that live record), while the live
 * record itself names no previous release — as on the real Nodus. Without
 * it, the previous release is unknown and no release is cleanable.
 */
export function addDeployHistory(mock2Db, applicationId, { now = Date.now() } = {}) {
  mock2Db.prepare("INSERT INTO mock2_application_candidates (application_id, sha, profile_revision, profile_digest, tree_sha, checkpoint_at, hygiene_json, validation_json, live_json) VALUES (?, ?, 6, ?, ?, ?, '{}', ?, ?)")
    .run(applicationId, ROLLBACK_SHA, 'd'.repeat(64), 'b'.repeat(40), new Date(now - 5 * DAY).toISOString(), JSON.stringify({ passed: true, releasePath: `${RELEASE_ROOT}/${ROLLBACK}` }), JSON.stringify({ sha: ROLLBACK_SHA, releasePath: `${RELEASE_ROOT}/${ROLLBACK}`, verifiedAt: new Date(now - 4 * DAY).toISOString() }));
}

/** The same history for a hand-built target (no database): what release-history.js would find. */
export const DEPLOY_HISTORY = Object.freeze({ sha: ROLLBACK_SHA, path: `${RELEASE_ROOT}/${ROLLBACK}` });

export function cleanupRoot(root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
