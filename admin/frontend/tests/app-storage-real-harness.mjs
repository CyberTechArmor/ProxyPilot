// The REAL application storage backend, in-process, for the browser journey
// app-storage-real.browser.mjs: an Express app mounting the real
// registerAppStorageRoutes over a real createAppStorage(...) instance (WS1's
// store, check service, policy, monitor) and the real cleanup service
// (createBackendCleanupService, WS2), with in-memory mock2 and main
// databases (migration 560's schema + the setup-engine schema). The guest is
// WS1's Nodus world (helpers/app-storage-world.js): real directories under a
// temp prefix and the real collector; the storage_cleanup job is claimed by a
// stand-in host runner here and run through the real executeJob, whose
// executor runs the real cleanup program on the same directories (the exec
// of app-storage-cleanup-e2e.test.js). Only the session is fake: one admin,
// and a requireSudo that answers the real `sudo_required` envelope until
// POST /api/auth/sudo has been made (what the dashboard's sudo modal does).
//
// startRealBackend({ jobDelayMs }) → { origin, state, storage, world, root, P, close }

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  makeRoot, buildNodusGuest, scriptedExec, databases, registerNodus, cleanupRoot, ROLLBACK, ROLLBACK_SHA, RELEASE_ROOT,
} from '../../backend/src/__tests__/helpers/app-storage-world.js';
import { unwrapContained } from '../../backend/src/__tests__/helpers/scripted-guest.js';
import { registerAppStorageRoutes } from '../../backend/src/routes/app-storage.js';
import { createAppStorage } from '../../backend/src/lib/app-storage/index.js';
import { createBackendCleanupService, cleanupDepsFor, bellOver, auditInto, runnerExportStore } from '../../backend/src/lib/app-storage/cleanup-deps.js';
import { CLEANUP_PROGRAM } from '../../backend/src/lib/app-storage/cleanup-program.js';
import { ensureSetupEngineSchema, claimNextJob, getJob, runnerHeartbeat } from '../../backend/src/lib/setup-engine/store.js';
import { executeJob } from '../../backend/src/lib/setup-engine/executor.js';
import { ownerIdentity } from '../../backend/src/lib/setup-engine/logic.js';

const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const express = backendRequire('express');

export const USER = { id: 1, username: 'admin', role: 'admin', permissions: [] };
export const SNAP_OLD = { name: 'pp-mcp-pre-resources-20261018', created_at: '2026-10-18T10:00:00.123456789Z' };
export const SNAP_NEW = { name: 'pp-pre-restore-abc12345', created_at: '2026-10-19T10:00:00Z' };
const RUNNER = ownerIdentity({ kind: 'runner', host: 'ui-journey', pid: process.pid, instance: 'real' });

// The executor of app-storage-cleanup-e2e.test.js (WS2): the world answers the
// guest and host commands, the cleanup program runs for real under the prefix,
// the release verify is scripted (no systemd here), Incus snapshots are held
// in mutable state, and the collector's record gains the service user and
// home that production's collector writes.
function worldExec(root) {
  const state = { snapshots: [SNAP_OLD, SNAP_NEW], verify: [], program: [] };
  const base = scriptedExec({ prefix: root, snapshots: state.snapshots, snapshotUsed: { [SNAP_OLD.name]: 40_000_000, [SNAP_NEW.name]: 20_000_000 } });
  const withSnapshots = (stdout) => { const x = JSON.parse(stdout); const fix = (i) => ({ ...i, snapshots: state.snapshots.map((s) => ({ ...s, stateful: false })) }); return JSON.stringify(Array.isArray(x) ? x.map(fix) : fix(x)); };
  const runProgram = (data, prefix) => {
    const P = (x) => (typeof x === 'string' && x.startsWith('/') ? prefix + x : x);
    const d = { ...data };
    for (const k of ['path', 'sourceDir', 'rollback', 'release']) if (d[k]) d[k] = P(d[k]);
    for (const k of ['approvedRoots', 'parents', 'protect']) if (Array.isArray(d[k])) d[k] = d[k].map(P);
    if (Array.isArray(d.entries)) d.entries = d.entries.map((e) => ({ ...e, path: P(e.path) }));
    if (d.profile) d.profile = { ...d.profile, sourceDir: P(d.profile.sourceDir), releaseRoot: P(d.profile.releaseRoot), preservePaths: (d.profile.preservePaths || []).map(P), envFiles: (d.profile.envFiles || []).map(P) };
    state.program.push(data);
    const r = spawnSync('node', ['-e', CLEANUP_PROGRAM, Buffer.from(JSON.stringify(d)).toString('base64')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { code: r.status, stdout: String(r.stdout || '').split(prefix).join(''), stderr: 'CONTAINMENT:systemd journey\n' };
  };
  const exec = {
    async guest(container, raw) {
      if (/STALE_WRITERS:/.test(raw) && !/printf '%s'/.test(raw)) return { code: 0, stdout: 'STALE_WRITERS:0\n' };
      if (/printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d/.test(raw)) {
        const data = JSON.parse(Buffer.from(unwrapContained(raw).match(/ '([A-Za-z0-9+/=]+)'\n$/)[1], 'base64').toString());
        if (data.action === 'verify') { state.verify.push(data); return { code: 0, stdout: JSON.stringify({ ok: true, target: data.expected, sha: data.sha }), stderr: 'CONTAINMENT:systemd journey\n' }; }
        return runProgram(data, root);
      }
      const r = await base.guest(container, raw);
      if (r.code !== 0) return r;
      try { const facts = JSON.parse(r.stdout); if (facts && typeof facts === 'object' && !facts.service) return { ...r, stdout: JSON.stringify({ ...facts, service: { unit: 'nodus.service', user: 'nodus', uid: 989, home: '/var/lib/nodus' } }) }; } catch { /* not the collector */ }
      return r;
    },
    async host(argv, opts) {
      if (argv[1] === '-e' && argv[2] === CLEANUP_PROGRAM) return runProgram(JSON.parse(Buffer.from(argv[3], 'base64').toString()), `${root}/host`);
      if (argv[0] === 'incus' && argv[1] === 'snapshot' && argv[2] === 'delete') { state.snapshots = state.snapshots.filter((s) => s.name !== argv[4]); return { code: 0, stdout: '' }; }
      if (argv[0] === 'incus' && argv[1] === 'query' && argv[2] === '/1.0/instances/pp-nodus/state') return { code: 0, stdout: JSON.stringify({ disk: { root: { usage: 2_956_918_784 } } }) };
      const r = await base.host(argv, opts);
      if (r.code === 0 && argv[0] === 'incus' && (argv[1] === 'list' || argv[2] === '/1.0/instances/pp-nodus?recursion=1')) return { ...r, stdout: withSnapshots(r.stdout) };
      return r;
    },
  };
  return { exec, state };
}

// The real middleware's envelope (middleware/auth.js requireSudo), over this
// harness's one session; db.js (native better-sqlite3) is not loaded here.
function sudoGate(session) {
  return (req, res, next) => {
    const until = session.sudo_until ? Date.parse(session.sudo_until) : 0;
    if (!Number.isFinite(until) || until <= Date.now()) {
      session.refusals += 1;
      return res.status(401).json({ error: 'sudo_required', sudo_required: true, message: 'This action requires sudo re-authentication.' });
    }
    next();
  };
}

export async function startRealBackend({ jobDelayMs = 2500 } = {}) {
  const root = makeRoot('pp-app-storage-ui-real-');
  const world = buildNodusGuest(root, Date.now());
  const { mock2Db, mainDb } = databases();
  ensureSetupEngineSchema(mainDb);
  mainDb.exec(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE notifications (id TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, body TEXT, source TEXT NOT NULL, source_id TEXT, dedupe_key TEXT, seen_count INTEGER NOT NULL DEFAULT 1, first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT, dismissed_at TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);`);
  const appId = registerNodus(mock2Db, world);
  // The deploy history, as app-storage-cleanup-e2e.test.js records it: the
  // rollback release was live before the current one.
  mock2Db.prepare("INSERT INTO mock2_application_candidates (application_id, sha, profile_revision, profile_digest, tree_sha, checkpoint_at, hygiene_json, validation_json, live_json) VALUES (?, ?, 6, ?, ?, ?, '{}', ?, ?)")
    .run(appId, ROLLBACK_SHA, 'd'.repeat(64), 'b'.repeat(40), new Date(Date.now() - 5 * 86_400_000).toISOString(), JSON.stringify({ passed: true, releasePath: `${RELEASE_ROOT}/${ROLLBACK}` }), JSON.stringify({ sha: ROLLBACK_SHA, releasePath: `${RELEASE_ROOT}/${ROLLBACK}`, verifiedAt: new Date(Date.now() - 4 * 86_400_000).toISOString() }));
  // A ready prepared download of the guest (recorded under its short name, as lxc_exports does).
  const exportFile = path.join(root, 'exports', 'nodus-20261003.tar.zst');
  fs.mkdirSync(path.dirname(exportFile), { recursive: true });
  fs.writeFileSync(exportFile, Buffer.alloc(5000, 1));
  mainDb.prepare("INSERT INTO lxc_exports (container_name, path, filename, compression, state, bytes_done, bytes_total, created_at) VALUES ('nodus', ?, 'nodus-20261003.tar.zst', 'zstd', 'ready', 5000, 5000, '2026-10-03 00:00:00')").run(exportFile);

  const { exec, state: execState } = worldExec(root);
  const bell = bellOver(mainDb);
  const dispatched = [];
  const storage = createAppStorage({ mock2Db, mainDb, exec, notifications: { ...bell, dispatch: (m) => { dispatched.push(m); } }, logger: { error() {}, log() {}, warn() {} } });
  const logAudit = (userId, action, type, id, details, ip) => auditInto(mainDb, { resourceType: type })({ userId, action, targetKey: id, details, ip });
  storage.setCleanupService(createBackendCleanupService({ storage, mainDb, logAudit }));

  const state = { requests: [], sudoPosts: 0, jobs: [], jobErrors: [], exec: execState, dispatched };
  const session = { id: 'journey-session', sudo_until: null, refusals: 0 };
  state.session = session;

  // A stand-in host runner: a fresh heartbeat, and each queued storage_cleanup
  // job claimed after `jobDelayMs` (so the dashboard shows the queued state)
  // and run through the real executor.
  const beat = () => runnerHeartbeat(mainDb, { owner: RUNNER, host: 'ui-journey', pid: process.pid, nowMs: Date.now() });
  beat();
  const firstSeen = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      beat();
      const queued = mainDb.prepare("SELECT id FROM setup_jobs WHERE status = 'queued' AND kind = 'storage_cleanup'").all();
      for (const q of queued) if (!firstSeen.has(q.id)) firstSeen.set(q.id, Date.now());
      if (!queued.some((q) => Date.now() - firstSeen.get(q.id) >= jobDelayMs)) return;
      const job = claimNextJob(mainDb, { owner: RUNNER, kinds: ['storage_cleanup'], nowMs: Date.now() });
      if (!job) return;
      const r = await executeJob(job, { db: mainDb, owner: RUNNER, exec, appStorage: { cleanup: cleanupDepsFor({ mainDb, mock2Db, bell, exports: runnerExportStore(mainDb) }) }, sleep: async () => {} });
      state.jobs.push({ id: job.id, status: r?.status, job: getJob(mainDb, job.id) });
    } catch (e) {
      state.jobErrors.push(String(e?.stack || e));
    } finally { busy = false; }
  };
  const timer = setInterval(() => { tick(); }, 200);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { req.user = USER; req.session = session; next(); });
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/app-storage/') && req.method !== 'GET') state.requests.push({ method: req.method, path: req.path, body: req.body, csrf: req.get('x-csrf-token') || null, sudo: Boolean(session.sudo_until) });
    next();
  });
  // What the dashboard shell asks for around the page.
  app.get('/api/auth/verify', (req, res) => res.json({ user: USER }));
  app.get('/api/user/profile', (req, res) => res.json({ user: { ...USER, hasPasskey: false } }));
  app.get('/api/auth/sso/session', (req, res) => res.json({ canReauthenticate: false }));
  app.post('/api/auth/sudo', (req, res) => {
    state.sudoPosts += 1;
    if (!req.body?.password || !/^[0-9]{6}$/.test(String(req.body?.totpCode || ''))) return res.status(401).json({ error: 'Invalid password or code' });
    session.sudo_until = new Date(Date.now() + 4 * 3600_000).toISOString();
    res.json({ ok: true, sudo_until: session.sudo_until });
  });
  app.get('/api/notifications', (req, res) => res.json({ notifications: [], unread_count: 0 }));
  app.get('/api/mock2/status', (req, res) => res.status(404).json({ error: 'disabled' }));
  app.get('/api/user/version', (req, res) => res.json({ version: 'real-backend-journey' }));
  app.get('/api/user/version/check', (req, res) => res.json({ updateAvailable: false }));
  // The real routes.
  const router = express.Router();
  registerAppStorageRoutes(router, {
    storage: () => storage,
    cleanupService: () => storage.cleanupService(),
    requireAdmin: (req, res, next) => next(),
    requireSudo: sudoGate(session),
    audit: (req, action, targetKey, detail) => logAudit(req.user?.id ?? null, action, 'app_storage', String(targetKey), detail, req.ip),
  });
  app.use('/api/app-storage', router);
  app.use('/api', (req, res) => res.json({}));

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const P = (rel) => path.join(root, rel.replace(/^\//, ''));
  const audits = () => mainDb.prepare('SELECT action, details FROM audit_log ORDER BY rowid').all();
  return {
    origin, state, storage, world, root, P, mock2Db, mainDb, audits,
    async close() { clearInterval(timer); await new Promise((r) => server.close(r)); cleanupRoot(root); },
  };
}
