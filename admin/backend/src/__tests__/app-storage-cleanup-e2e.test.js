// End to end, with the real pieces together: WS1's Nodus-shaped guest built
// from real directories and its real collector → the real check service and
// store → the cleanup service the routes call (requestCleanup) → the
// storage_cleanup job through executeJob over an in-memory setup-engine DB,
// whose executor runs the REAL cleanup program against the same directories
// (paths rewritten into the world's prefix, as the collector's are) → the
// rescan stored → audit rows and bell alerts in the main DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRoot, buildNodusGuest, scriptedExec, databases, registerNodus, cleanupRoot, LIVE, ROLLBACK, OLD, CANDIDATE, ADOPTED, OLD_JOB, ACTIVE_JOB, RELEASE_ROOT } from './helpers/app-storage-world.js';
import { unwrapContained } from './helpers/scripted-guest.js';
import { createAppStorage } from '../lib/app-storage/index.js';
import { createBackendCleanupService, cleanupDepsFor, bellOver, auditInto, runnerExportStore } from '../lib/app-storage/cleanup-deps.js';
import { CLEANUP_PROGRAM } from '../lib/app-storage/cleanup-program.js';
import { ensureSetupEngineSchema, claimNextJob, getJob, runnerHeartbeat } from '../lib/setup-engine/store.js';
import { executeJob } from '../lib/setup-engine/executor.js';
import { ownerIdentity } from '../lib/setup-engine/logic.js';

const skip = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() !== 0);
const RUNNER = ownerIdentity({ kind: 'runner', host: 'e2e', pid: 1, instance: 'one' });
const SNAP_OLD = { name: 'pp-mcp-pre-resources-20261018', created_at: '2026-10-18T10:00:00.123456789Z' };
const SNAP_NEW = { name: 'pp-pre-restore-abc12345', created_at: '2026-10-19T10:00:00Z' };

// The executor the job sees: guest/host commands answered by the world, the
// cleanup program run for real under the prefix, the release verify scripted
// (no systemd here), Incus snapshots held in mutable state.
function worldExec(root) {
  const state = { snapshots: [SNAP_OLD, SNAP_NEW], verify: [], program: [] };
  const base = scriptedExec({ prefix: root, snapshots: state.snapshots, snapshotUsed: { [SNAP_OLD.name]: 40_000_000, [SNAP_NEW.name]: 20_000_000 } });
  const withSnapshots = stdout => { const x = JSON.parse(stdout); const fix = i => ({ ...i, snapshots: state.snapshots.map(s => ({ ...s, stateful: false })) }); return JSON.stringify(Array.isArray(x) ? x.map(fix) : fix(x)); };
  const runProgram = (data, prefix) => {
    const P = x => (typeof x === 'string' && x.startsWith('/') ? prefix + x : x);
    const d = { ...data };
    for (const k of ['path', 'sourceDir', 'rollback', 'release']) if (d[k]) d[k] = P(d[k]);
    for (const k of ['approvedRoots', 'parents', 'protect']) if (Array.isArray(d[k])) d[k] = d[k].map(P);
    if (Array.isArray(d.entries)) d.entries = d.entries.map(e => ({ ...e, path: P(e.path) }));
    if (d.profile) d.profile = { ...d.profile, sourceDir: P(d.profile.sourceDir), releaseRoot: P(d.profile.releaseRoot), preservePaths: (d.profile.preservePaths || []).map(P), envFiles: (d.profile.envFiles || []).map(P) };
    state.program.push(data);
    const r = spawnSync('node', ['-e', CLEANUP_PROGRAM, Buffer.from(JSON.stringify(d)).toString('base64')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { code: r.status, stdout: String(r.stdout || '').split(prefix).join(''), stderr: 'CONTAINMENT:systemd e2e\n' };
  };
  const exec = {
    async guest(container, raw) {
      if (/STALE_WRITERS:/.test(raw) && !/printf '%s'/.test(raw)) return { code: 0, stdout: 'STALE_WRITERS:0\n' };
      if (/printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d/.test(raw)) {
        const data = JSON.parse(Buffer.from(unwrapContained(raw).match(/ '([A-Za-z0-9+/=]+)'\n$/)[1], 'base64').toString());
        if (data.action === 'verify') { state.verify.push(data); return { code: 0, stdout: JSON.stringify({ ok: true, target: data.expected, sha: data.sha }), stderr: 'CONTAINMENT:systemd e2e\n' }; }
        return runProgram(data, root);
      }
      // The storage check's collector. WS1's world runs it with `service: null`
      // (no systemd or passwd here) and resolves ~service itself; production's
      // collector records the service user and home, which the cleanup uses to
      // tell a cache in that home from the preserved data around it.
      const r = await base.guest(container, raw);
      if (r.code !== 0) return r;
      try { const facts = JSON.parse(r.stdout); if (facts && typeof facts === 'object' && !facts.service) return { ...r, stdout: JSON.stringify({ ...facts, service: { unit: 'nodus.service', user: 'nodus', uid: 989, home: '/var/lib/nodus' } }) }; } catch { /* not the collector */ }
      return r;
    },
    async host(argv, opts) {
      if (argv[1] === '-e' && argv[2] === CLEANUP_PROGRAM) return runProgram(JSON.parse(Buffer.from(argv[3], 'base64').toString()), `${root}/host`);
      if (argv[0] === 'incus' && argv[1] === 'snapshot' && argv[2] === 'delete') { state.snapshots = state.snapshots.filter(s => s.name !== argv[4]); return { code: 0, stdout: '' }; }
      if (argv[0] === 'incus' && argv[1] === 'query' && argv[2] === '/1.0/instances/pp-nodus/state') return { code: 0, stdout: JSON.stringify({ disk: { root: { usage: 2_956_918_784 } } }) };
      const r = await base.host(argv, opts);
      if (r.code === 0 && argv[0] === 'incus' && (argv[1] === 'list' || argv[2] === '/1.0/instances/pp-nodus?recursion=1')) return { ...r, stdout: withSnapshots(r.stdout) };
      return r;
    },
  };
  return { exec, state };
}

async function setup(t) {
  const root = makeRoot('pp-cleanup-e2e-');
  t.after(() => cleanupRoot(root));
  const world = buildNodusGuest(root, Date.now());
  const { mock2Db, mainDb } = databases();
  ensureSetupEngineSchema(mainDb);
  mainDb.exec(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE notifications (id TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, body TEXT, source TEXT NOT NULL, source_id TEXT, dedupe_key TEXT, seen_count INTEGER NOT NULL DEFAULT 1, first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT, dismissed_at TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);`);
  registerNodus(mock2Db, world);
  // A ready prepared download of the guest, recorded under its short name.
  const exportFile = path.join(root, 'exports', 'nodus-20261003.tar.zst');
  fs.mkdirSync(path.dirname(exportFile), { recursive: true }); fs.writeFileSync(exportFile, Buffer.alloc(5000, 1));
  mainDb.prepare("INSERT INTO lxc_exports (container_name, path, filename, compression, state, bytes_done, bytes_total, created_at) VALUES ('nodus', ?, 'nodus-20261003.tar.zst', 'zstd', 'ready', 5000, 5000, '2026-10-03 00:00:00')").run(exportFile);
  const { exec, state } = worldExec(root);
  const dispatched = [];
  const bell = bellOver(mainDb);
  // The backend: the shared storage instance and the cleanup service the routes call.
  const storage = createAppStorage({ mock2Db, mainDb, exec, notifications: { ...bell, dispatch: m => { dispatched.push(m); } }, logger: { error() {}, log() {} } });
  const logAudit = (userId, action, type, id, details, ip) => auditInto(mainDb, { resourceType: type })({ userId, action, targetKey: id, details, ip });
  storage.setCleanupService(createBackendCleanupService({ storage, mainDb, logAudit }));
  runnerHeartbeat(mainDb, { owner: RUNNER, host: 'e2e', pid: 1, nowMs: Date.now() });
  const check = await storage.runCheck('application:1', { userId: 1 });
  const find = (pred, what) => { const it = check.items.find(pred); assert.ok(it, `the check lists ${what}`); assert.equal(it.status, 'eligible', `${what} is eligible: ${it.reason}`); return it; };
  const runJob = async () => {
    const job = claimNextJob(mainDb, { owner: RUNNER, kinds: ['storage_cleanup'], nowMs: Date.now() });
    assert.ok(job, 'the storage_cleanup job was queued');
    const r = await executeJob(job, { db: mainDb, owner: RUNNER, exec, appStorage: { cleanup: cleanupDepsFor({ mainDb, mock2Db, bell, exports: runnerExportStore(mainDb) }) }, sleep: async () => {} });
    return { job: getJob(mainDb, job.id), r };
  };
  const P = rel => path.join(root, rel.replace(/^\//, ''));
  return { root, world, mock2Db, mainDb, storage, check, find, runJob, P, state, dispatched, bell };
}

const quarantined = dir => { const out = []; const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (n.startsWith('.pp-cleanup-')) out.push(f); const s = fs.lstatSync(f); if (s.isDirectory() && !s.isSymbolicLink()) walk(f); } }; walk(dir); return out; };

test('end to end: a check, an approved mixed cleanup, the job, the rescan; protected data untouched', { skip }, async t => {
  const w = await setup(t);
  assert.equal(w.check.status === 'complete' || w.check.status === 'partial', true);
  const picks = {
    group: w.find(it => it.kind === 'group' && it.category === 'temp' && /nodus-embed/.test(it.label), 'the nodus-embed-* temp group'),
    staging: w.find(it => it.path === `${RELEASE_ROOT}/.staging/${OLD_JOB}-1`, 'the abandoned staging workspace'),
    bundle: w.find(it => it.path === `${RELEASE_ROOT}/.staging/${OLD_JOB}-1.bundle`, 'its source archive'),
    release: w.find(it => it.path === `${RELEASE_ROOT}/${OLD}`, 'the old sealed release'),
    cache: w.find(it => it.path === '/var/lib/nodus/.cache/ms-playwright', "the service user's browser cache"),
    log: w.find(it => it.path === '/var/log/syslog.2.gz', 'a rotated log'),
    dump: w.find(it => it.category === 'history' && (it.path === '/var/backups/proxypilot-db/app-pre-deploy-job1.sql' || (it.members || []).some(m => m.path === '/var/backups/proxypilot-db/app-pre-deploy-job1.sql')), 'the oldest pre-deploy recovery set'),
    host: w.find(it => it.location === 'host' && /bundle-a1b2c3$/.test(it.path || ''), 'the host transfer copy'),
  };
  const snapshot = w.find(it => it.kind === 'snapshot' && it.identity?.name === SNAP_OLD.name, 'the older snapshot');
  const exported = w.find(it => it.kind === 'export', 'the prepared download');
  // Pre-existing alerts from an earlier failed cleanup and a failed health check.
  w.bell.post({ level: 'error', title: 'old failure', source: 'app-storage', source_id: 'application:1', dedupe_key: 'appstorage:cleanup:application:1' });
  w.bell.post({ level: 'error', title: 'old health', source: 'app-storage', source_id: 'application:1', dedupe_key: 'appstorage:health:application:1' });

  const approved = await w.storage.cleanupService().requestCleanup({ targetKey: 'application:1', checkId: w.check.checkId, items: Object.values(picks).map(i => i.id), snapshots: [snapshot.id], exports: [exported.id], acknowledgeSnapshotLoss: true, scope: 'items', origin: 'user', userId: 1, ip: '127.0.0.1' });
  assert.equal(approved.changed, true);
  assert.ok(approved.estimate.bytes > 0);
  const { job, r } = await w.runJob();
  assert.equal(r.status, 'succeeded', job.reason);

  const cleanup = await w.storage.cleanupService().getCleanup(approved.cleanupId);
  assert.equal(cleanup.status, 'succeeded', JSON.stringify(cleanup.result, null, 1));
  assert.deepEqual(cleanup.result.skipped, []); assert.deepEqual(cleanup.result.failed, []);
  assert.deepEqual(new Set(cleanup.result.removed.map(x => x.id)), new Set([...Object.values(picks).map(i => i.id), snapshot.id, exported.id]));
  assert.equal(cleanup.result.health, 'passed');
  assert.equal(w.state.verify.length, 1, 'the live release was verified once (the deploy op verify)');
  assert.equal(w.state.verify[0].expected, `${RELEASE_ROOT}/${LIVE}`);
  assert.ok(cleanup.result.removed.find(x => x.id === picks.release.id).bytes > 0, 'removed bytes are measured');

  // Removed, for real.
  for (const gone of [`${RELEASE_ROOT}/.staging/${OLD_JOB}-1`, `${RELEASE_ROOT}/.staging/${OLD_JOB}-1.bundle`, `${RELEASE_ROOT}/${OLD}`, '/var/lib/nodus/.cache/ms-playwright', '/var/log/syslog.2.gz', '/var/backups/proxypilot-db/app-pre-deploy-job1.sql', '/etc/systemd/system/nodus.service.pre-job1', '/host/var/lib/proxypilot/application-release-transfers/bundle-a1b2c3']) assert.equal(fs.existsSync(w.P(gone)), false, gone);
  for (const m of picks.group.members) assert.equal(fs.existsSync(w.P(m.path)), false, m.path);
  assert.equal(fs.existsSync(path.join(w.root, 'exports', 'nodus-20261003.tar.zst')), false);
  assert.equal(w.mainDb.prepare('SELECT COUNT(*) AS n FROM lxc_exports').get().n, 0);
  assert.deepEqual(w.state.snapshots.map(s => s.name), [SNAP_NEW.name]);
  // Protected, untouched.
  for (const kept of [`${RELEASE_ROOT}/${LIVE}/.proxypilot-release.json`, `${RELEASE_ROOT}/${ROLLBACK}/.proxypilot-release.json`, `${RELEASE_ROOT}/${CANDIDATE}/.proxypilot-release.json`, `${RELEASE_ROOT}/${ADOPTED}/voice/models/wespeaker.onnx`, `${RELEASE_ROOT}/${ADOPTED}/embed/models/bge/model_quantized.onnx`, '/var/lib/nodus/handoff/note.md', '/var/lib/nodus/.npm/_cacache/index-v5/aa', '/etc/nodus/nodus.env', '/var/lib/postgresql/17/main/base/1', `${RELEASE_ROOT}/.staging/${ACTIVE_JOB}-1/package.json`, `${RELEASE_ROOT}/.staging/operator-note`, '/tmp/playwright-download-Fs12Md/chromium.zip', '/var/backups/proxypilot-db/app-pre-deploy-job3.sql', '/opt/nodus-w48/test-results/a.png']) assert.equal(fs.existsSync(w.P(kept)), true, kept);
  assert.equal(fs.readFileSync(w.P('/opt/nodus/voice/models/wespeaker.onnx')).length, 26_000, 'the live release still reaches its models');
  assert.deepEqual(quarantined(w.root), [], 'no quarantine entry is left anywhere');

  // The rescan is stored and is the cleanup's afterCheckId; what was removed is no longer listed.
  const latest = w.storage.store.listChecks('application:1', { limit: 5 })[0];
  assert.equal(latest.origin, 'cleanup'); assert.equal(cleanup.result.afterCheckId, latest.id);
  const after = w.storage.getCheck(latest.id);
  assert.equal(after.items.some(it => it.path === `${RELEASE_ROOT}/${OLD}` || it.path === `${RELEASE_ROOT}/.staging/${OLD_JOB}-1`), false);
  assert.ok(after.items.some(it => it.path === `${RELEASE_ROOT}/${ROLLBACK}` && it.sub === 'rollback'), 'the rollback release is still there and still protected');
  assert.ok(cleanup.result.remaining?.guest?.usedBytes > 0);

  // Audit rows (backend approval, job finish, export delete) and the alerts resolved by the success.
  const actions = w.mainDb.prepare('SELECT action FROM audit_log ORDER BY rowid').all().map(x => x.action);
  for (const a of ['STORAGE_CLEANUP_APPROVED', 'LXC_EXPORT_DELETE', 'STORAGE_CLEANUP_FINISHED']) assert.ok(actions.includes(a), a);
  const approval = JSON.parse(w.mainDb.prepare("SELECT details FROM audit_log WHERE action = 'STORAGE_CLEANUP_APPROVED'").get().details);
  assert.deepEqual(approval.counts, { items: 8, snapshots: 1, exports: 1 });
  const dismissed = key => w.mainDb.prepare('SELECT dismissed_at FROM notifications WHERE dedupe_key = ?').get(key).dismissed_at;
  assert.ok(dismissed('appstorage:cleanup:application:1'), 'a successful cleanup resolves the cleanup alert');
  assert.ok(dismissed('appstorage:health:application:1'), 'a passing health check resolves the health alert');
});

test('end to end: an item changed between the check and the cleanup is skipped, the others go, status partial', { skip }, async t => {
  const w = await setup(t);
  const staging = w.find(it => it.path === `${RELEASE_ROOT}/.staging/${OLD_JOB}-1`, 'the abandoned staging workspace');
  const cache = w.find(it => it.path === '/var/lib/nodus/.cache/ms-playwright', "the service user's browser cache");
  const group = w.find(it => it.kind === 'group' && /nodus-embed/.test(it.label), 'the temp group');
  const approved = await w.storage.cleanupService().requestCleanup({ targetKey: 'application:1', checkId: w.check.checkId, items: [staging.id, cache.id, group.id], origin: 'user', userId: 1 });
  // Someone writes into the workspace after the check.
  fs.writeFileSync(w.P(`${RELEASE_ROOT}/.staging/${OLD_JOB}-1/written-later.txt`), 'new work');
  await w.runJob();
  const cleanup = await w.storage.cleanupService().getCleanup(approved.cleanupId);
  assert.equal(cleanup.status, 'partial');
  assert.deepEqual(cleanup.result.removed.map(x => x.id).sort(), [cache.id, group.id].sort());
  assert.deepEqual(cleanup.result.skipped, [{ id: staging.id, label: staging.label, reason: 'It changed after the storage check, so it was left alone.' }]);
  assert.equal(fs.readFileSync(w.P(`${RELEASE_ROOT}/.staging/${OLD_JOB}-1/written-later.txt`), 'utf8'), 'new work');
  assert.equal(fs.existsSync(w.P('/var/lib/nodus/.cache/ms-playwright')), false);
  assert.deepEqual(quarantined(w.root), []);
  // A skip is not a failure: no cleanup alert is raised.
  assert.equal(w.mainDb.prepare("SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key = 'appstorage:cleanup:application:1' AND dismissed_at IS NULL").get().n, 0);
});

test('a cleanup alert the host runner posts is delivered once by the backend monitor', { skip }, async t => {
  const w = await setup(t);
  const runnerSide = cleanupDepsFor({ mainDb: w.mainDb, mock2Db: w.mock2Db, bell: w.bell });
  await runnerSide.monitor.postCleanupAlert('application:1', { ok: false, failedCount: 2, healthFailed: true }, { name: 'Nodus' });
  const open = w.mainDb.prepare("SELECT dedupe_key, level FROM notifications WHERE dismissed_at IS NULL AND dedupe_key LIKE 'appstorage:%' ORDER BY dedupe_key").all();
  assert.deepEqual(open.map(r => r.dedupe_key), ['appstorage:cleanup:application:1', 'appstorage:health:application:1']);
  assert.equal(w.dispatched.length, 0, 'the runner writes the bell row only');
  await w.storage.monitor.runOnce();
  assert.deepEqual(w.dispatched.map(m => m.event).sort(), ['appstorage.cleanup', 'appstorage.health']);
  await w.storage.monitor.runOnce();
  assert.equal(w.dispatched.length, 2, 'delivered once, not every round');
  await runnerSide.monitor.postCleanupAlert('application:1', { ok: true, failedCount: 0, healthFailed: false }, { name: 'Nodus' });
  await w.storage.monitor.runOnce();
  assert.equal(w.storage.monitor.active.has('appstorage:cleanup:application:1'), false, 'a runner-resolved alert leaves the active set');
});
