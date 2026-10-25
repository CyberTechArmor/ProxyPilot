// END-TO-END: ADOPTION of a legacy project onto the application foundation —
// the REAL adoption service, scripts and stack against a REAL native
// PostgreSQL and a REAL foundation stack (FOUNDATION_E2E=1, root, Docker).
//
//   FOUNDATION_E2E=1 node --test src/__tests__/foundation-adopt-e2e.docker.test.js
//
// What is real:
//   * mock2.db — a temp better-sqlite3 file with every mock2 migration (566
//     included), one LEGACY project (foundation_version NULL) with an installed
//     component that owns two secrets;
//   * the native database — a scratch cluster of this sandbox's PostgreSQL
//     (pg_createcluster, its own port) with the legacy app's data: an enum, a
//     citext column under a unique constraint, jsonb, a foreign key, an index,
//     a view, a second schema, a table comment, sequences, a migration ledger;
//   * the adoption service with its own guest scripts through mock2/host.js
//     runHost('incus', …): the read-only probe, pg_dump -Fc + row counts, the
//     native stop + port check, the port check after the restart, pg_restore
//     INSIDE the pgvector container as role app in one transaction, the row
//     count and ownership checks, the environment rewrite, the platform commit
//     pushed to a bare repository, the foundation CLI's health over the peer
//     socket; the foundation stack's own bring-up (foundation-stack.js) under a
//     test layout; the plan token; the checkout lease; the rollback's
//     repository reset and mock2.db clearing;
//   * the foundation deploy's environment check: the real resolveDeployParams
//     (minting/delivery from the encrypted store) and validateDeployEnvironment
//     on the adopted environment file.
//
// What stands in (and therefore is NOT proven here):
//   * `incus exec` is the test shim (helpers/foundation-e2e-shims.js): commands
//     run on this sandbox. The guest's /srv/app is a temp directory, its
//     /etc/environment a temp file;
//   * every other Incus verb — list, snapshot create/restore, config set,
//     restart — is an in-process fake. The snapshot restore is EMULATED (the
//     environment file and the working tree put back, the native cluster
//     started, the stack stopped): real Incus snapshot/restore semantics and a
//     guest restart with the Docker-ready keys are proven on a host only;
//   * the Docker install step is skipped (this sandbox's Docker is used; the
//     install fragment is template.js's, unchanged);
//   * the deploy pipeline itself (setup-engine job, npm install, migrate, unit
//     swap, the app serving) is not run; its environment check is;
//   * storage and embeddings are turned OFF at the confirmation: the local
//     embedding model cannot be fetched here and the bundled S3's contract
//     endpoint (127.0.0.1:8333) may belong to another run. Bring-up still
//     starts storage once to configure its identities, on a free port.
//
// Everything created (the cluster, containers, volumes, networks prefixed
// ad-, the dump directory, the temp dir) is removed at the end, also on failure.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installGuestShims } from './helpers/foundation-e2e-shims.js';

const E2E = process.env.FOUNDATION_E2E === '1';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const HAS_DOCKER = E2E && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
const HAS_PG = E2E && spawnSync('sh', ['-c', 'command -v pg_createcluster && command -v pg_ctlcluster && ls /usr/lib/postgresql'], { encoding: 'utf8' }).status === 0;
const SKIP = !E2E ? 'set FOUNDATION_E2E=1 to run the end-to-end adoption test (Docker + a native PostgreSQL)'
  : !IS_ROOT ? 'needs root: peer authentication and the native cluster'
    : !HAS_DOCKER ? 'needs a reachable Docker daemon'
      : !HAS_PG ? 'needs a native PostgreSQL with pg_createcluster (postgresql-common)' : false;

const PID = process.pid;
const GUEST = 'ad-guest';
const PROJECT = `ad-fnd-${PID}`;
const CLUSTER = `ad${PID}`;
const PROJECT_ID = 4343;
const PLANTED = { auth: `ad-auth-${crypto.randomBytes(12).toString('hex')}`, session: `ad-sess-${crypto.randomBytes(12).toString('hex')}`, dbpw: `ad-pw-${crypto.randomBytes(6).toString('hex')}` };
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const W = { calls: [], chats: [], snapshots: new Map(), incusConfig: { 'limits.cpu': '2' } };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function run(cmd, args, { input = null, timeoutMs = 180000, cwd = undefined, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, env: env || process.env, stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: null, stdout: '', stderr: e.message }); return; }
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
const docker = (args, opts) => run('docker', args, opts);
const compose = (args, opts) => docker(['compose', '-p', PROJECT, '-f', W.layout.composeFile, ...args], opts);
const git = (dir, ...args) => run('git', ['-C', dir, '-c', 'user.name=ad', '-c', 'user.email=ad@test', ...args]);
const nativeSql = (sql, db = 'app') => run('su', ['-', 'postgres', '-c', `psql -p ${W.nativePort} -X -At -v ON_ERROR_STOP=1 -d ${db}`], { input: sql });
const appRoleSql = (sql) => compose(['exec', '-T', 'postgres', 'psql', '-U', 'app', '-d', 'app', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const LEGACY_SQL = `
CREATE EXTENSION IF NOT EXISTS citext;
SET ROLE app;
CREATE TYPE user_role AS ENUM ('admin', 'member');
CREATE TABLE users (id serial PRIMARY KEY, email citext NOT NULL UNIQUE, role user_role NOT NULL DEFAULT 'member', profile jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sessions (id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash text NOT NULL);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE SCHEMA audit;
CREATE TABLE audit.events (id bigserial PRIMARY KEY, kind text NOT NULL, at timestamptz DEFAULT now());
CREATE VIEW active_admins AS SELECT id, email FROM users WHERE role = 'admin';
CREATE TABLE health_checks (id serial PRIMARY KEY, note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now());
COMMENT ON TABLE users IS 'the app''s users';
INSERT INTO users (email, role, profile) SELECT 'user' || g || '@example.test', (CASE WHEN g % 10 = 0 THEN 'admin' ELSE 'member' END)::user_role, jsonb_build_object('n', g) FROM generate_series(1, 2500) g;
INSERT INTO sessions (user_id, token_hash) SELECT (g % 2500) + 1, md5(g::text) FROM generate_series(1, 4000) g;
INSERT INTO audit.events (kind) SELECT 'login' FROM generate_series(1, 321);
INSERT INTO health_checks (note) VALUES ('legacy');
INSERT INTO app_migrations (name) VALUES ('0001_init.sql'), ('0100_platform.sql');
RESET ROLE;
`;
const EXPECTED = { 'app_migrations': 2, 'audit.events': 321, 'health_checks': 1, 'sessions': 4000, 'users': 2500 };
const expectedCounts = () => Object.fromEntries(Object.entries(EXPECTED).map(([t, n]) => [t.includes('.') ? t : `public.${t}`, n]));

// The fake Incus: everything but `exec` (which is the shim).
async function fakeIncus(argv, opts) {
  const [bin, ...a] = argv;
  if (bin === 'git') return run('git', a, opts);
  if (bin !== 'incus') return { code: 1, stdout: '', stderr: `unexpected host command ${bin}` };
  W.calls.push(`incus ${a.slice(0, 2).join(' ')}`);
  if (a[0] === 'list') {
    return { code: 0, stdout: JSON.stringify([{ name: GUEST, type: 'container', status: 'Running', config: { ...W.incusConfig }, snapshots: [...W.snapshots.entries()].map(([name, s]) => ({ name, created_at: s.created_at })), expanded_devices: { root: { type: 'disk', path: '/' } } }]), stderr: '' };
  }
  if (a[0] === 'snapshot' && a[1] === 'create') {
    W.snapshots.set(a[3], { created_at: new Date().toISOString(), env: fs.readFileSync(W.envFile, 'utf8'), head: (await git(W.appDir, 'rev-parse', 'HEAD')).stdout.trim(), config: { ...W.incusConfig } });
    return { code: 0, stdout: '', stderr: '' };
  }
  if (a[0] === 'snapshot' && a[1] === 'restore') {
    // EMULATED: what restoring the guest's root disk would put back.
    const s = W.snapshots.get(a[3]);
    if (!s) return { code: 1, stdout: '', stderr: 'Error: snapshot not found' };
    fs.writeFileSync(W.envFile, s.env);
    await git(W.appDir, 'reset', '-q', '--hard', s.head);
    await git(W.appDir, 'clean', '-fdq', '--', 'foundation');
    W.incusConfig = { ...s.config };
    await compose(['stop'], { timeoutMs: 120000 });
    const st = await run('pg_ctlcluster', ['16', CLUSTER, 'start']);
    return st.code === 0 ? { code: 0, stdout: '', stderr: '' } : st;
  }
  if (a[0] === 'config' && a[1] === 'set') { for (const kv of a.slice(3)) { const i = kv.indexOf('='); W.incusConfig[kv.slice(0, i)] = kv.slice(i + 1); } return { code: 0, stdout: '', stderr: '' }; }
  if (a[0] === 'config' && a[1] === 'unset') { delete W.incusConfig[a[3]]; return { code: 0, stdout: '', stderr: '' }; }
  if (['restart', 'start', 'stop'].includes(a[0])) return { code: 0, stdout: '', stderr: '' };
  return { code: 1, stdout: '', stderr: `fake incus: ${a.join(' ')}` };
}

describe('foundation adoption end to end (native PostgreSQL → foundation stack, real scripts)', { skip: SKIP }, () => {
  before(async () => {
    W.base = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-fe2e-'));
    fs.chmodSync(W.base, 0o755);
    W.bin = path.join(W.base, 'bin');
    W.appDir = path.join(W.base, 'app');
    W.bare = path.join(W.base, 'repo.git');
    W.envFile = path.join(W.base, 'environment');
    W.guestEnv = path.join(W.base, 'guest-environment');
    W.shimLog = path.join(W.base, 'shim.log');
    for (const d of [W.appDir, path.join(W.base, 'db'), path.join(W.base, 'state')]) fs.mkdirSync(d, { recursive: true });
    installGuestShims(W.bin);
    W.nativePort = await freePort();
    Object.assign(process.env, {
      DATABASE_PATH: path.join(W.base, 'db', 'proxypilot.db'),
      TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      PATH: `${W.bin}:${process.env.PATH}`,
      I2_GUEST: GUEST, I2_APP_DIR: W.appDir, I2_STATE_DIR: path.join(W.base, 'state'), I2_GUEST_ENV: W.guestEnv, I2_BIN: W.bin, I2_SHIM_LOG: W.shimLog,
    });

    // The native database of the legacy app.
    const mk = await run('pg_createcluster', ['16', CLUSTER, '-p', String(W.nativePort), '--start'], { timeoutMs: 120000 });
    assert.equal(mk.code, 0, `pg_createcluster: ${mk.stderr}`);
    W.clusterMade = true;
    let r = await nativeSql("CREATE ROLE app LOGIN PASSWORD 'app';\nCREATE DATABASE app OWNER app;\n", 'postgres');
    assert.equal(r.code, 0, r.stderr);
    r = await nativeSql(LEGACY_SQL);
    assert.equal(r.code, 0, r.stderr);

    // The foundation stack's test layout.
    const logic = await import('../mock2/foundation-stack-logic.js');
    W.layout = logic.resolveLayout({
      composeProject: PROJECT,
      dir: path.join(W.base, 'stack'),
      keyFile: path.join(W.base, 'key', 'master.key'),
      socketDir: path.join(W.base, 'sock'),
      volumes: { postgres: `${PROJECT}-pg`, storage: `${PROJECT}-s3`, embeddings: `${PROJECT}-embed` },
      ports: { postgres: await freePort(), storage: await freePort(), embeddings: await freePort() },
    });
    fs.writeFileSync(W.guestEnv, `DATABASE_URL=postgres:///app?host=${W.layout.socketDir}&user=app\nFOUNDATION_KEY_FILE=${W.layout.keyFile}\n`);
    W.stack = await import('../mock2/foundation-stack.js');
    W.stack._setFoundationGuestExecForTests(null, { layout: W.layout });

    // mock2.db: a LEGACY project with an installed component owning two secrets.
    const mock2Db = await import('../mock2/db.js');
    W.db = mock2Db.initMock2Db();
    W.db.prepare(`INSERT INTO mock2_projects (id, name, repo_path, lifecycle, container_name, created_at, foundation_version, web_port) VALUES (?, 'ad e2e', ?, 'active', ?, ?, NULL, 3000)`)
      .run(PROJECT_ID, W.bare, GUEST, new Date().toISOString());
    const now = new Date().toISOString();
    const c = W.db.prepare("INSERT INTO mock2_components (key, name, status, created_by, created_at) VALUES ('ad-auth', 'Auth', 'published', 1, ?)").run(now);
    const v = W.db.prepare("INSERT INTO mock2_component_versions (component_id, version, files_json, change_reason, source, created_by, created_at, contract_json) VALUES (?, 1, '[]', 'seed', 'in_app', 1, ?, ?)")
      .run(c.lastInsertRowid, now, JSON.stringify({ config: [
        { key: 'AUTH_MASTER_SECRET', secret: true, generate: true, protects: { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce' } },
        { key: 'SESSION_SECRET', secret: true, generate: true },
      ] }));
    W.db.prepare("INSERT INTO mock2_project_components (project_id, component_id, version_id, status, origin, created_at) VALUES (?, ?, ?, 'installed', 'operator', ?)").run(PROJECT_ID, c.lastInsertRowid, v.lastInsertRowid, now);

    // The legacy app: the seed as it was before the foundation (no foundation/,
    // no --import), committed and pushed to its bare repository.
    const { buildSeedFiles } = await import('../mock2/template.js');
    const { FOUNDATION_NODE_IMPORT, FOUNDATION_DEPENDENCIES } = await import('../mock2/scaffold-foundation.js');
    for (const f of buildSeedFiles({ name: 'ad e2e' })) {
      if (f.path.startsWith('foundation/')) continue;
      let content = f.content;
      if (f.path === 'package.json') {
        const pkg = JSON.parse(content);
        pkg.scripts.start = pkg.scripts.start.replace(` ${FOUNDATION_NODE_IMPORT}`, '');
        pkg.scripts.dev = pkg.scripts.dev.replace(` ${FOUNDATION_NODE_IMPORT}`, '');
        delete pkg.scripts.foundation; delete pkg.imports;
        for (const k of Object.keys(FOUNDATION_DEPENDENCIES)) delete pkg.dependencies[k];
        content = `${JSON.stringify(pkg, null, 2)}\n`;
      }
      const p = path.join(W.appDir, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, { mode: f.mode || 0o644 });
    }
    fs.writeFileSync(path.join(W.appDir, '.gitignore'), 'node_modules\n');
    assert.equal((await run('git', ['init', '-q', '--bare', '-b', 'main', W.bare])).code, 0);
    assert.equal((await run('git', ['init', '-q', '-b', 'main', W.appDir])).code, 0);
    await git(W.appDir, 'remote', 'add', 'origin', W.bare);
    await git(W.appDir, 'add', '-A');
    assert.equal((await git(W.appDir, 'commit', '-qm', 'seed (legacy)')).code, 0);
    assert.equal((await git(W.appDir, 'push', '-q', 'origin', 'HEAD:main')).code, 0);
    W.preHead = (await git(W.appDir, 'rev-parse', 'HEAD')).stdout.trim();
    // The foundation runtime's own dependencies (pg) for its CLI and bootstrap:
    // the deploy's npm install provides them in a guest.
    fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(W.appDir, 'node_modules'));
    // The guest's environment file as a legacy app has it.
    W.envOriginal = `PATH="/usr/local/bin:/usr/bin:/bin"\nAUTH_MASTER_SECRET=${PLANTED.auth}\nSESSION_SECRET="${PLANTED.session}"\nDATABASE_URL=postgres://app:${PLANTED.dbpw}@127.0.0.1:${W.nativePort}/app\nOPERATOR_SETTING=keep\n`;
    fs.writeFileSync(W.envFile, W.envOriginal, { mode: 0o644 });

    // The adoption service with its REAL guest runner (the incus exec shim),
    // the REAL stack adapters and the fake Incus verbs.
    const { runHost } = await import('../mock2/host.js');
    const { resolveDeployParams } = await import('../mock2/deploy.js');
    const { buildDevServiceUnit, validateDeployEnvironment } = await import('../mock2/deploy-logic.js');
    W.adopt = await import('../mock2/foundation-adopt-service.js');
    W.adoptStore = await import('../mock2/foundation-adopt-store.js');
    W.fstore = await import('../mock2/foundation-store.js');
    W.locks = await import('../mock2/locks.js');
    W.logic = await import('../mock2/foundation-adopt-logic.js');
    W.adopt._setAdoptionDepsForTests({
      native: { port: W.nativePort },
      appDir: W.appDir,
      environmentFile: W.envFile,
      layout: W.layout,
      pgPort: W.layout.ports.postgres,
      guest: (container, script, { args = [], input = null, timeoutMs = 120000 } = {}) => {
        if (script.includes('FOUNDATION SETUP FAILED')) { W.calls.push('install_runtime (stand-in: this sandbox\'s Docker)'); return { code: 0, stdout: '[ad] install skipped in the sandbox\n', stderr: '' }; }
        return runHost('incus', ['exec', container, '--', 'sh', '-c', script, 'sh', ...args.map(String)], { input, timeoutMs });
      },
      host: fakeIncus,
      ensureMasterKey: W.stack.ensureMasterKey,
      bringUpFoundation: W.stack.bringUpFoundation,
      foundationPsql: W.stack.foundationPsql,
      foundationCli: W.stack.foundationCli,
      deploy: async (project) => {
        W.calls.push('deploy (environment check only)');
        const params = await resolveDeployParams({ containerName: project.container_name, deliverFoundationSecrets: true });
        const unit = buildDevServiceUnit({ appDir: '/srv/app', webPort: 3000, execStart: "/bin/sh -lc 'exec npm run start'", foundation: true });
        W.deployCheck = { params: params.foundation, verdict: validateDeployEnvironment({ unitText: unit, environmentText: fs.readFileSync(W.envFile, 'utf8'), requiredKeys: params.foundation?.required || [], foundation: true, storeKeys: params.foundation?.delivered || [] }) };
        return W.deployCheck.verdict.ok ? { ok: true } : { ok: false, step: 'start', error: W.deployCheck.verdict.error };
      },
      stampDeployedCommit: async () => {},
      probeServing: async () => ({ serving: true, reason: 'not run here (stand-in)' }),
      afterGuestRestart: async () => ({ ok: true, ip: '10.0.0.9' }),
      busy: async () => ({}),
      repoHead: async () => { const x = await run('git', ['--git-dir', W.bare, 'rev-parse', '--verify', 'refs/heads/main']); return x.code === 0 ? x.stdout.trim() : null; },
      repoReset: (project, { from, to }) => run('git', ['--git-dir', W.bare, 'update-ref', 'refs/heads/main', to, from]),
      notify: async (_pid, body) => { W.chats.push(body); },
    });
  }, { timeout: 600000 });

  after(async () => {
    try { W.adopt?._setAdoptionDepsForTests(null); } catch { /* best effort */ }
    if (W.layout) await compose(['down', '-v', '--remove-orphans', '--timeout', '5'], { timeoutMs: 180000 });
    const ids = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`])).stdout.split('\n').filter(Boolean);
    if (ids.length) await docker(['rm', '-f', '-v', ...ids]);
    for (const v of ['pg', 's3', 'embed']) await docker(['volume', 'rm', '-f', `${PROJECT}-${v}`]);
    for (const n of ['postgres', 'storage', 'embeddings', 'default']) await docker(['network', 'rm', `${PROJECT}_${n}`]);
    if (W.clusterMade) await run('pg_dropcluster', ['--stop', '16', CLUSTER], { timeoutMs: 120000 });
    if (W.dumpDir && W.dumpDir.startsWith('/var/lib/mock2-adopt/fa_')) fs.rmSync(W.dumpDir, { recursive: true, force: true });
    try { if (fs.existsSync('/var/lib/mock2-adopt') && !fs.readdirSync('/var/lib/mock2-adopt').length) fs.rmdirSync('/var/lib/mock2-adopt'); } catch { /* another run's dumps */ }
    try { W.stack?._setFoundationGuestExecForTests(); } catch { /* best effort */ }
    try { W.db?.close(); } catch { /* best effort */ }
    if (W.base) fs.rmSync(W.base, { recursive: true, force: true });
  });

  test('1. plan: the real read-only probes find a clean legacy project', { timeout: 120000 }, async () => {
    const p = await W.adopt.planAdoption(PROJECT_ID);
    assert.equal(p.ok, true);
    assert.deepEqual(p.blockers, [], JSON.stringify(p.blockers, null, 1));
    assert.match(p.plan_token, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.plan.secrets_to_move, ['AUTH_MASTER_SECRET', 'SESSION_SECRET']);
    assert.equal(p.plan.database.tables, Object.keys(EXPECTED).length);
    assert.ok(p.plan.database.size_bytes > 1024 * 1024);
    assert.ok(p.plan.disk.free_bytes > p.plan.disk.needed_bytes);
    W.plan = p;
  });

  test('2. adopt: every step runs for real (bar the stand-ins) and the run succeeds', { timeout: 900000 }, async () => {
    const t0 = Date.now();
    const r = await W.adopt.startAdoption(PROJECT_ID, { plan_token: W.plan.plan_token, acknowledge_downtime: true, features: { storage: 'off', embeddings: 'off' } }, { userId: 'ad-e2e' });
    assert.equal(r.ok, true, r.message);
    W.id = r.adoption.id;
    await W.adopt._whenAdoptionSettled(W.id);
    const row = W.adoptStore.getAdoption(W.id);
    const steps = W.adoptStore.readSteps(row);
    assert.equal(row.state, 'succeeded', `${row.error}\n${JSON.stringify(steps, null, 1)}\n${W.calls.join('\n')}`);
    for (const s of steps) assert.equal(s.state, 'done', s.name);
    W.data = W.adoptStore.adoptionData(row);
    W.dumpDir = path.dirname(W.data.dump.path);
    console.log(`[ad] adoption: ${Math.round((Date.now() - t0) / 1000)} s; ${steps.map((s) => `${s.name}: ${s.detail}`).join('\n')}`);
    assert.equal(W.locks.getLock(PROJECT_ID), undefined, 'the checkout lock is released');
  });

  test('3. the data: every count equal, owned by role app, constraints, sequences, extensions and the view intact', { timeout: 120000 }, async () => {
    assert.deepEqual(W.data.counts, expectedCounts(), 'the dump counted what the legacy database held');
    const counts = await W.stack.foundationPsql(GUEST, W.logic.COUNT_SQL, { database: 'app' });
    assert.deepEqual(W.logic.parseCounts(counts.stdout).counts, expectedCounts());
    assert.equal(W.logic.parseNotAppOwned((await W.stack.foundationPsql(GUEST, W.logic.OWNER_SQL, { database: 'app' })).stdout), 0);
    const ext = await W.stack.foundationPsql(GUEST, "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension;\n", { database: 'app' });
    assert.match(ext.stdout, /citext/);
    assert.match(ext.stdout, /vector/);
    // As the app's own role, over the peer socket inside the stack.
    const ins = await appRoleSql("INSERT INTO users (email) VALUES ('new@example.test') RETURNING id;\n");
    assert.equal(ins.code, 0, ins.stderr);
    assert.equal(ins.stdout.trim().split('\n').pop(), '2501', 'the sequence continues after the copied rows');
    const dup = await appRoleSql("INSERT INTO users (email) VALUES ('USER7@EXAMPLE.TEST');\n");
    assert.notEqual(dup.code, 0, 'the citext unique constraint came along');
    assert.match(dup.stderr, /duplicate key value violates unique constraint/);
    const view = await appRoleSql("SELECT count(*) FROM active_admins;\nSELECT obj_description('users'::regclass, 'pg_class');\nSELECT role FROM users WHERE id = 10;\nSELECT count(*) FROM sessions s JOIN users u ON u.id = s.user_id;\n");
    assert.equal(view.code, 0, view.stderr);
    assert.deepEqual(view.stdout.trim().split('\n'), ['250', "the app's users", 'admin', '4000']);
    const fk = await appRoleSql('INSERT INTO sessions (user_id, token_hash) VALUES (999999, \'x\');\n');
    assert.match(fk.stderr, /violates foreign key constraint/);
    // The app role can alter its tables (its migrations will).
    assert.equal((await appRoleSql('ALTER TABLE health_checks ADD COLUMN adopted boolean;\nALTER TABLE health_checks DROP COLUMN adopted;\n')).code, 0);
  });

  test('4. the secrets: in the encrypted store, out of the environment file, delivered sealed — the app gets them in memory', { timeout: 120000 }, async () => {
    assert.equal(W.fstore.readSecret(PROJECT_ID, 'component.AUTH_MASTER_SECRET'), PLANTED.auth);
    assert.equal(W.fstore.readSecret(PROJECT_ID, 'component.SESSION_SECRET'), PLANTED.session);
    assert.equal(fs.readFileSync(W.envFile, 'utf8'), 'PATH="/usr/local/bin:/usr/bin:/bin"\nOPERATOR_SETTING=keep\n');
    const names = await W.stack.foundationPsql(GUEST, "SELECT string_agg(name, ',' ORDER BY name) FROM mock2_foundation.secrets WHERE name LIKE 'component.%';\n", { database: 'app' });
    assert.equal(names.stdout.trim(), 'component.AUTH_MASTER_SECRET,component.SESSION_SECRET');
    // The app's own bootstrap (node --import) opens them with the master key.
    const probe = "import crypto from 'node:crypto'; const h = (v) => crypto.createHash('sha256').update(String(v)).digest('hex'); console.log('AD_ENV:' + h(process.env.AUTH_MASTER_SECRET) + ':' + h(process.env.SESSION_SECRET)); process.exit(0);";
    fs.writeFileSync(path.join(W.appDir, 'ad-probe.mjs'), probe);
    const r = await run('incus', ['exec', GUEST, '--cwd', '/srv/app', '--', 'node', '--import=./foundation/runtime/bootstrap.mjs', 'ad-probe.mjs'], { timeoutMs: 120000 });
    fs.rmSync(path.join(W.appDir, 'ad-probe.mjs'));
    const line = r.stdout.split('\n').find((l) => l.startsWith('AD_ENV:'));
    assert.ok(line, `${r.stdout}\n${r.stderr}`);
    assert.equal(line, `AD_ENV:${sha(PLANTED.auth)}:${sha(PLANTED.session)}`);
    // The real foundation deploy check passed on the adopted environment.
    assert.deepEqual(W.deployCheck.verdict, { ok: true, mode: 'production' });
    assert.deepEqual([...W.deployCheck.params.required].sort(), ['AUTH_MASTER_SECRET', 'SESSION_SECRET']);
  });

  test('5. the repository: one pushed platform commit of foundation/ and package.json; health ready over the peer socket', { timeout: 120000 }, async () => {
    const main = (await run('git', ['--git-dir', W.bare, 'rev-parse', 'refs/heads/main'])).stdout.trim();
    assert.equal(main, W.data.adopt_commit);
    assert.notEqual(main, W.preHead);
    const show = (await git(W.appDir, 'show', '--name-only', '--format=%s', main)).stdout.trim().split('\n');
    assert.equal(show[0], W.logic.ADOPT_COMMIT_MESSAGE);
    assert.ok(show.slice(1).filter(Boolean).every((p) => p === 'package.json' || p.startsWith('foundation/')), show.join(','));
    const pkg = JSON.parse(fs.readFileSync(path.join(W.appDir, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.start, /--import=\.\/foundation\/runtime\/bootstrap\.mjs/);
    const h = await W.stack.foundationCli(GUEST, ['health', '--json'], { appDir: '/srv/app', timeoutMs: 120000 });
    const { parseHealthOutput } = await import('../mock2/foundation-logic.js');
    const rows = parseHealthOutput(h.stdout);
    assert.equal(rows.find((x) => x.component === 'database')?.status, 'ready', h.stdout + h.stderr);
    assert.equal(rows.find((x) => x.component === 'storage')?.status, 'off');
    // The port check a resume runs: the port is now the stack's own.
    const pc = await run('incus', ['exec', GUEST, '--', 'sh', '-c', W.logic.portCheckScript({ port: W.layout.ports.postgres, composeProject: PROJECT })]);
    assert.deepEqual(W.logic.parsePortCheck(pc.stdout), { free: false, port: W.layout.ports.postgres, nativeOnline: 0, owner: PROJECT });
  });

  test('6. the native database: stopped, its data directory untouched', { timeout: 60000 }, async () => {
    const ls = await run('pg_lsclusters', ['-h']);
    const line = ls.stdout.split('\n').find((l) => l.split(/\s+/)[1] === CLUSTER);
    assert.match(line, /\sdown\s/);
    assert.ok(fs.existsSync(`/var/lib/postgresql/16/${CLUSTER}/PG_VERSION`));
    assert.equal(fs.statSync(W.data.dump.path).mode & 0o777, 0o600, 'the dump is root-only');
    assert.equal(fs.statSync(W.dumpDir).mode & 0o777, 0o700);
  });

  test('7. rollback after success: the native database answers with its data, the repository and mock2.db go back', { timeout: 300000 }, async () => {
    const r = await W.adopt.rollbackAdoption(PROJECT_ID, { userId: 'ad-e2e' });
    assert.equal(r.ok, true, r.message);
    await W.adopt._whenAdoptionSettled(W.id);
    const row = W.adoptStore.getAdoption(W.id);
    assert.equal(row.state, 'rolled_back', row.error);
    assert.ok(W.snapshots.has(`pre-rollback-${W.id}`), 'the adopted state is kept first');
    // The native data as it was (the foundation copy took the new row; the old one did not).
    const n = await nativeSql(W.logic.COUNT_SQL);
    assert.equal(n.code, 0, n.stderr);
    assert.deepEqual(W.logic.parseCounts(n.stdout).counts, expectedCounts());
    assert.equal(fs.readFileSync(W.envFile, 'utf8'), W.envOriginal);
    assert.equal((await run('git', ['--git-dir', W.bare, 'rev-parse', 'refs/heads/main'])).stdout.trim(), W.preHead, 'the platform commit is no longer main');
    assert.equal(W.db.prepare('SELECT foundation_version FROM mock2_projects WHERE id = ?').get(PROJECT_ID).foundation_version, null);
    assert.deepEqual(W.adoptStore.foundationRowCounts(PROJECT_ID), { features: 0, secrets: 0, jobs: 0 });
    assert.equal(W.locks.getLock(PROJECT_ID), undefined);
    assert.deepEqual(W.incusConfig, { 'limits.cpu': '2' }, 'the guest settings of the snapshot');
  });

  test('8. no secret value crossed a command line or landed in the run record', () => {
    const log = fs.existsSync(W.shimLog) ? fs.readFileSync(W.shimLog, 'utf8') : '';
    assert.ok(log.length > 0, 'the shim saw the guest commands');
    const rows = JSON.stringify(W.db.prepare('SELECT * FROM mock2_foundation_adoptions').all());
    for (const p of Object.values(PLANTED)) {
      assert.equal(log.includes(p), false, 'argv');
      assert.equal(rows.includes(p), false, 'run record');
      assert.equal(W.chats.join('\n').includes(p), false, 'chat');
    }
  });
});
