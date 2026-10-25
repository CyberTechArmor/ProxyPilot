// Real-Docker proof of the foundation guest stack (foundation-stack.js +
// foundation-stack-logic.js). Skipped unless FOUNDATION_E2E=1.
//
// The SAME generated files and the SAME exec module run against the local
// Docker daemon: the guest runner is swapped for a local one and the layout
// for an `a3-fstack-<pid>` Compose project in a temp dir (its own volume
// names and published ports — Postgres' reporting port included), so nothing
// named mock2-foundation is touched. FOUNDATION_E2E_TAG replaces the `a3`
// prefix on a shared Docker daemon. Everything created is removed afterwards
// (docker compose down -v on the test's own project only).
//
// NOT covered here: the embeddings service. Its image lives on ghcr.io and its
// model on huggingface.co, both unreachable from this sandbox, so the test
// runs with embeddings OFF (bring-up must then leave the service stopped).
// The local embedding model is proven on a host.
//
//   FOUNDATION_E2E=1 [FOUNDATION_E2E_TAG=xy] node --test src/__tests__/foundation-stack.docker.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createServer, connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { generateMasterKey, STACK, FOUNDATION_DATABASE_URL } from '../mock2/foundation-contract.js';
import {
  resolveLayout, composeArgv, foundationReadOnlySqlScript, foundationDumpScript,
  foundationCloneDumpArgv, foundationCloneRestoreArgv, foundationEnsureSql, buildFoundationComposeYaml,
  buildFoundationComposeModel,
} from '../mock2/foundation-stack-logic.js';
import { buildPlatformFiles } from '../mock2/scaffold-platform.js';
import { materializeReadonly, runReadonly } from './helpers/platform-readonly.js';
import {
  _setFoundationGuestExecForTests, bringUpFoundation, ensureMasterKey, foundationCompose, foundationPsql,
  foundationServiceStatus, setFoundationService, bundledStorageObjectCount, writeFoundationFiles,
} from '../mock2/foundation-stack.js';

const ENABLED = process.env.FOUNDATION_E2E === '1';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const skip = !ENABLED ? 'set FOUNDATION_E2E=1 to run the real-Docker foundation test'
  : !IS_ROOT ? 'needs root: peer authentication maps the guest root to the app role' : false;

const GUEST = 'a3-local';
// A run on a shared Docker daemon picks its own prefix (projects, volumes).
const PREFIX = /^[a-z0-9-]{1,16}$/.test(process.env.FOUNDATION_E2E_TAG || '') ? process.env.FOUNDATION_E2E_TAG : 'a3';

function run(argv, { input = null, timeoutMs = 120000, uid = null, env = null } = {}) {
  return new Promise((resolve) => {
    const opts = { stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] };
    if (uid != null) { opts.uid = uid; opts.gid = uid; }
    if (env) opts.env = { ...process.env, ...env };
    let child;
    try { child = spawn(argv[0], argv.slice(1), opts); } catch (e) { resolve({ code: null, stdout: '', stderr: e.message }); return; }
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
const localGuestExec = (_name, argv, opts) => run(argv, opts);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const keyId = () => `A3${randomBytes(9).toString('hex').toUpperCase()}`;
const secret = () => randomBytes(30).toString('base64').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 'open' when something accepts a TCP connection, 'refused' otherwise.
function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = tcpConnect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done('refused'));
    sock.once('connect', () => done('open'));
    sock.once('error', () => done('refused'));
  });
}

async function waitFor(fn, { timeoutMs = 120000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

test('foundation stack on real Docker', { skip, timeout: 20 * 60 * 1000 }, async (t) => {
  const { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const pg = (await import('pg')).default;
  const pgConnect = async (url) => {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });
    try { await c.connect(); } catch (e) { await c.end().catch(() => {}); throw e; }
    return c;
  };

  const base = mkdtempSync(join(tmpdir(), 'a3-fs-'));
  chmodSync(base, 0o755); // so the non-root client reaches the socket and is refused by PEER, not by the directory
  const pid = process.pid;
  const project = `${PREFIX}-fstack-${pid}`;
  const layout = resolveLayout({
    composeProject: project,
    dir: join(base, 'stack'),
    keyFile: join(base, 'key', 'master.key'),
    socketDir: join(base, 'sock'),
    volumes: { postgres: `${project}-pg`, storage: `${project}-s3`, embeddings: `${project}-embed` },
    ports: { postgres: await freePort(), storage: await freePort(), embeddings: await freePort() },
  });
  _setFoundationGuestExecForTests(localGuestExec, { layout });
  t.after(async () => {
    await run([...composeArgv(layout), 'down', '-v', '--remove-orphans', '--timeout', '5'], { timeoutMs: 180000 });
    _setFoundationGuestExecForTests();
    rmSync(base, { recursive: true, force: true });
  });

  const features = {
    storage: { state: 'on', provider: 'bundled', config: {} },
    embeddings: { state: 'off', provider: 'local', config: {} }, // TEI cannot be pulled in this sandbox
  };
  const creds = { app: { accessKeyId: keyId(), secretAccessKey: secret() }, admin: { accessKeyId: keyId(), secretAccessKey: secret() } };
  const masterKey = generateMasterKey();
  const s3 = (c) => new S3Client({ endpoint: `http://127.0.0.1:${layout.ports.storage}`, region: STACK.storage.region, forcePathStyle: true, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, maxAttempts: 1 });
  const sock = layout.socketDir;
  const psqlAs = (sql, { uid = null, user = 'app', db = 'app' } = {}) => run(['psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', `host=${sock} user=${user} dbname=${db}`, '-c', sql], { uid });
  const steps = [];

  await t.test('bring-up succeeds and reports every step', async () => {
    const r = await bringUpFoundation({ containerName: GUEST, features, masterKey, storageCredentials: creds, onStep: (name) => steps.push(name) });
    assert.equal(r.ok, true, `bring-up failed: ${r.error}\n${JSON.stringify(r.steps, null, 1)}`);
    assert.deepEqual(r.steps.map((s) => s.name), ['docker', 'master-key', 'files', 'pull', 'up', 'healthy', 'schema', 'storage-identities', 'features']);
    assert.ok(r.steps.every((s) => s.ok));
    assert.deepEqual(steps, r.steps.map((s) => s.name));
    // No secret in any step detail.
    const text = JSON.stringify(r);
    for (const v of [creds.app.secretAccessKey, creds.admin.secretAccessKey, creds.app.accessKeyId, creds.admin.accessKeyId, masterKey]) assert.ok(!text.includes(v), 'a secret leaked into the bring-up result');
  });

  await t.test('first initialization ran the image init files (the portable copy depends on them)', async () => {
    const logs = await foundationCompose(GUEST, ['logs', '--no-color', 'postgres']);
    const text = `${logs.stdout}${logs.stderr}`;
    assert.match(text, /running \/docker-entrypoint-initdb\.d\/01-mock2-foundation\.sql/);
    assert.match(text, /sourcing \/docker-entrypoint-initdb\.d\/99-mock2-seal\.sh/);
    assert.match(text, /PostgreSQL init process complete/);
    assert.doesNotMatch(text, /\bERROR:|FATAL:.*authentication/);
    const pgdataHba = await foundationCompose(GUEST, ['exec', '-T', 'postgres', 'sh', '-c', 'cat "$PGDATA/pg_hba.conf"']);
    assert.doesNotMatch(pgdataHba.stdout, /trust/, 'the data directory\'s own pg_hba.conf still allows trust');
  });

  await t.test('services: postgres + storage healthy, embeddings not running', async () => {
    const st = await foundationServiceStatus(GUEST);
    const by = Object.fromEntries(st.map((s) => [s.service, s]));
    assert.equal(by.postgres.state, 'running'); assert.equal(by.postgres.health, 'healthy');
    assert.equal(by.storage.state, 'running'); assert.equal(by.storage.health, 'healthy');
    assert.notEqual(by.embeddings.state, 'running');
  });

  await t.test('master key file is 0600 and re-writing it is a no-op', async () => {
    const st = statSync(layout.keyFile);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, 0);
    assert.equal(statSync(join(base, 'key')).mode & 0o777, 0o700);
    assert.equal(readFileSync(layout.keyFile, 'utf8').trim(), masterKey);
    const again = await ensureMasterKey(GUEST, masterKey);
    assert.equal(again.ok, true); assert.equal(again.changed, false);
    assert.equal((await ensureMasterKey(GUEST, 'not-a-key')).ok, false);
  });

  let gateway = null;
  await t.test('postgres TCP: one port, published on 127.0.0.1 only, from its own network', async () => {
    const r = await run(['docker', 'inspect', '--format', '{{.HostConfig.NetworkMode}} {{json .NetworkSettings.Ports}}', `${layout.composeProject}-postgres-1`]);
    assert.equal(r.code, 0, r.stderr);
    const [mode, ports] = [r.stdout.trim().split(' ')[0], JSON.parse(r.stdout.trim().split(' ').slice(1).join(' '))];
    assert.equal(mode, `${layout.composeProject}_postgres`);
    assert.deepEqual(ports, { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(layout.ports.postgres) }] });
    const net = await run(['docker', 'network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}|{{len .Containers}}|{{.EnableIPv6}}', `${layout.composeProject}_postgres`]);
    assert.equal(net.code, 0, net.stderr);
    const [gw, members, v6] = net.stdout.trim().split('|');
    gateway = gw.trim().split(' ')[0];
    assert.match(gateway, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(members, '1', 'nothing but postgres is attached to its network');
    assert.equal(v6, 'false', 'the postgres network is IPv4 only');
    const show = await foundationPsql(GUEST, 'SHOW listen_addresses;\nSHOW password_encryption;\nSHOW hba_file;', { database: 'postgres' });
    assert.deepEqual(show.stdout.trim().split('\n'), ['0.0.0.0', 'scram-sha-256', '/etc/mock2/pg_hba.conf']);
    // Not reachable on any other address of this host (never 0.0.0.0).
    const others = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    for (const addr of others) assert.equal(await tcpProbe(addr, layout.ports.postgres), 'refused', `reachable on ${addr}`);
    assert.equal(await tcpProbe('127.0.0.1', layout.ports.postgres), 'open');
  });

  await t.test('peer auth: root connects as app; other OS users are refused (uid 999 too)', async () => {
    const root = await psqlAs('SELECT current_user');
    assert.equal(root.code, 0, root.stderr);
    assert.equal(root.stdout.trim(), 'app');
    const su = await psqlAs('SELECT current_user', { user: 'postgres' });
    assert.equal(su.stdout.trim(), 'postgres');
    for (const uid of [65534, 1000, 999]) {
      const r = await psqlAs('SELECT 1', { uid });
      assert.notEqual(r.code, 0, `uid ${uid} connected`);
      assert.match(r.stderr, /peer authentication failed|could not look up local user|no pg_hba\.conf entry|does not match/i, `uid ${uid}: ${r.stderr}`);
    }
    // The first-initialization mapping is gone.
    const ident = await foundationCompose(GUEST, ['exec', '-T', 'postgres', 'test', '-e', '/run/mock2-init/pg_ident.conf']);
    assert.notEqual(ident.code, 0, 'the init-only ident mapping still exists');
  });

  await t.test('the app role: login + createdb + createrole, no superuser, no password', async () => {
    const r = await foundationPsql(GUEST, "SELECT rolcanlogin, rolcreatedb, rolcreaterole, rolsuper, rolpassword IS NULL FROM pg_authid WHERE rolname = 'app';", { database: 'postgres' });
    assert.equal(r.stdout.trim(), 't|t|t|f|t');
    const owner = await foundationPsql(GUEST, "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'app';", { database: 'postgres' });
    assert.equal(owner.stdout.trim(), 'app');
  });

  // The generated app's own src/platform/readonly.ts, run as the app runs it:
  // DATABASE_URL is the socket URL (peer: root → app), and the port override
  // points its connection string at this test's published port.
  const roDir = join(base, 'ro-app');
  const roEnv = (over = {}) => ({ DATABASE_URL: FOUNDATION_DATABASE_URL.replace(STACK.postgres.socketDir, sock), MOCK2_FOUNDATION_PG_PORT: String(layout.ports.postgres), ...over });
  let issued = null;

  await t.test('read-only SQL: the app issues app_readonly over the socket; it reads its views over TCP and nothing else', async () => {
    materializeReadonly(roDir, { foundation: true, real: true });
    const migration = buildPlatformFiles().find((f) => f.path === 'migrations/0100_platform.sql').content;
    const m = await psqlAs(migration);
    assert.equal(m.code, 0, m.stderr);
    assert.equal(runReadonly(roDir, 'status', roEnv()).result.enabled, false);

    const en = runReadonly(roDir, 'enable', roEnv());
    assert.equal(en.error, undefined, JSON.stringify(en.error));
    issued = en.result;
    assert.equal(issued.role, 'app_readonly');
    assert.match(issued.url, new RegExp(`^postgres://app_readonly:[A-Za-z0-9_-]{32}@127\\.0\\.0\\.1:${layout.ports.postgres}/app$`));
    assert.match(issued.odbc, new RegExp(`Server=127\\.0\\.0\\.1;Port=${layout.ports.postgres};Database=app;Uid=app_readonly;`));
    assert.equal(runReadonly(roDir, 'status', roEnv()).result.enabled, true);

    // A SCRAM verifier, and a role that cannot widen its own access.
    const attrs = await foundationPsql(GUEST, "SELECT rolpassword LIKE 'SCRAM-SHA-256$%', rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls FROM pg_authid WHERE rolname = 'app_readonly';", { database: 'postgres' });
    assert.equal(attrs.stdout.trim(), 't|t|f|f|f|f|f|f');
    const admin = await foundationPsql(GUEST, "SELECT pg_has_role('app', 'app_readonly', 'USAGE WITH ADMIN OPTION');", { database: 'postgres' });
    assert.equal(admin.stdout.trim(), 't', 'CREATEROLE: the app holds ADMIN on the role it created');

    const c = await pgConnect(issued.url);
    try {
      const who = (await c.query('SELECT current_user AS u, system_user AS s, host(inet_client_addr()) AS a, current_database() AS d')).rows[0];
      assert.deepEqual({ u: who.u, s: who.s, d: who.d }, { u: 'app_readonly', s: 'scram-sha-256:app_readonly', d: 'app' });
      assert.equal(who.a, gateway, 'the published port arrives from the bridge gateway (pg_hba samenet)');
      assert.equal((await c.query('SELECT org_name FROM api_read.branding')).rows[0].org_name, 'Application');
      assert.ok((await c.query('SELECT count(*)::int AS n FROM api_read.api_keys')).rows[0].n >= 0);
      for (const [label, q] of [
        ['insert through a view', "INSERT INTO api_read.branding (id, org_name) VALUES (2, 'x')"],
        ['update through a view', "UPDATE api_read.legal_pages SET title = 'x'"],
        ['a base table', 'SELECT token_hash FROM public.api_keys'],
        ['a base table', 'SELECT * FROM public.branding'],
        ['the platform schema', 'SELECT * FROM mock2_foundation.secrets'],
        ['create a table', 'CREATE TABLE public.ro_probe (x int)'],
        ['create a view schema object', 'CREATE VIEW api_read.ro_probe AS SELECT 1'],
      ]) {
        await assert.rejects(c.query(q), /permission denied/, `${label}: ${q}`);
      }
    } finally { await c.end(); }
  });

  await t.test('TCP admits app_readonly on app only: wrong password, other databases, the app role and the superuser are refused', async () => {
    const tcp = (user, password, database = 'app') => `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${layout.ports.postgres}/${database}`;
    await assert.rejects(pgConnect(tcp('app_readonly', 'not-the-password')), /password authentication failed for user "app_readonly"/);
    await assert.rejects(pgConnect(issued.url.replace(/\/app$/, '/postgres')), /pg_hba\.conf rejects connection .*user "app_readonly", database "postgres"/);
    // Give the app role and the superuser real passwords: TCP still refuses
    // them, because pg_hba rejects before any password is asked for.
    const set = await foundationPsql(GUEST, "ALTER ROLE app PASSWORD 'a3-tcp-probe-app';\nALTER ROLE postgres PASSWORD 'a3-tcp-probe-su';\n", { database: 'postgres' });
    assert.equal(set.code, 0, set.stderr);
    try {
      for (const [user, pw] of [['app', 'a3-tcp-probe-app'], ['postgres', 'a3-tcp-probe-su'], ['app', ''], ['postgres', 'x']]) {
        for (const database of ['app', 'postgres']) {
          await assert.rejects(pgConnect(tcp(user, pw, database)), new RegExp(`pg_hba\\.conf rejects connection for host "${gateway.replace(/\./g, '\\.')}", user "${user}", database "${database}"`), `${user}@${database}`);
        }
      }
      // Another role the app creates (CREATEROLE allows it) is not admitted either.
      const other = await psqlAs("CREATE ROLE a3_other LOGIN PASSWORD 'a3-other-pw'");
      assert.equal(other.code, 0, other.stderr);
      await assert.rejects(pgConnect(tcp('a3_other', 'a3-other-pw')), /pg_hba\.conf rejects connection .*user "a3_other"/);
    } finally {
      await foundationPsql(GUEST, "ALTER ROLE app PASSWORD NULL;\nALTER ROLE postgres PASSWORD NULL;\nDROP ROLE IF EXISTS a3_other;\n", { database: 'postgres' });
    }
    // The socket path is unchanged: root still connects as app and postgres by peer.
    assert.equal((await psqlAs('SELECT current_user')).stdout.trim(), 'app');
    assert.equal((await psqlAs('SELECT current_user', { user: 'postgres' })).stdout.trim(), 'postgres');
  });

  await t.test('CREATEROLE stays narrow: the app cannot touch the superuser or hand out elevated attributes', async () => {
    for (const q of [
      "ALTER ROLE postgres PASSWORD 'x'",
      'ALTER ROLE postgres NOLOGIN',
      'ALTER ROLE app SUPERUSER',
      'ALTER ROLE app_readonly SUPERUSER',
      'ALTER ROLE app_readonly BYPASSRLS',
      'CREATE ROLE a3_su SUPERUSER',
      'CREATE ROLE a3_repl REPLICATION',
      'GRANT pg_read_server_files TO app_readonly',
      'GRANT pg_execute_server_program TO app',
      'GRANT postgres TO app_readonly',
      'GRANT app TO app_readonly',
    ]) {
      const r = await psqlAs(q);
      assert.notEqual(r.code, 0, `the app role could run: ${q}`);
      assert.match(r.stderr, /permission denied|must have|only roles with|must be superuser/i, `${q}: ${r.stderr}`);
    }
    const roles = await foundationPsql(GUEST, "SELECT string_agg(rolname || ':' || (rolsuper OR rolbypassrls OR rolreplication)::text, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('app', 'app_readonly', 'a3_su', 'a3_repl');", { database: 'postgres' });
    assert.equal(roles.stdout.trim(), 'app:false,app_readonly:false');
  });

  await t.test('rotation, the fixed role name and disable', async () => {
    const again = runReadonly(roDir, 'enable', roEnv());
    assert.equal(again.error, undefined, JSON.stringify(again.error));
    assert.notEqual(again.result.url, issued.url);
    await assert.rejects(pgConnect(issued.url), /password authentication failed/, 'the previous password still works after a rotation');
    const c = await pgConnect(again.result.url); await c.end();
    issued = again.result;

    const other = runReadonly(roDir, 'enable', roEnv({ READONLY_DB_ROLE: 'reporting' }));
    assert.equal(other.error?.code, 'READONLY_ROLE_NOT_ADMITTED');
    assert.match(other.error.message, /one role only, "app_readonly"/);
    assert.equal((await foundationPsql(GUEST, "SELECT count(*) FROM pg_roles WHERE rolname = 'reporting';", { database: 'postgres' })).stdout.trim(), '0');
    const st = runReadonly(roDir, 'status', roEnv({ READONLY_DB_ROLE: 'reporting' })).result;
    assert.equal(st.code, 'READONLY_ROLE_NOT_ADMITTED');
    assert.equal(st.enabled, true, 'the live app_readonly credential is shown, so it can be turned off');

    const off = runReadonly(roDir, 'disable', roEnv({ READONLY_DB_ROLE: 'reporting' }));
    assert.equal(off.error, undefined, JSON.stringify(off.error));
    await assert.rejects(pgConnect(issued.url), /not permitted to log in/);
    assert.equal(runReadonly(roDir, 'status', roEnv()).result.enabled, false);
  });

  await t.test('schema present and a vector operation works as app', async () => {
    const tables = await psqlAs("SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'mock2_foundation'");
    assert.equal(tables.stdout.trim(), 'features,health,jobs,meta,secrets,storage_migration_items,vector_indexes');
    const owner = await psqlAs("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'mock2_foundation'");
    assert.equal(owner.stdout.trim(), 'app');
    const ver = await psqlAs("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    assert.equal(ver.stdout.trim(), '0.8.7');
    const v = await psqlAs("CREATE TABLE a3_items (id int PRIMARY KEY, embedding vector(3)); INSERT INTO a3_items VALUES (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0.9,0.1,0]'); CREATE INDEX ON a3_items USING hnsw (embedding vector_cosine_ops); SELECT string_agg(id::text, ',') FROM (SELECT id FROM a3_items ORDER BY embedding <=> '[1,0.05,0]' LIMIT 2) s");
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.stdout.trim(), '1,3');
  });

  await t.test('app can create a scratch database over the socket (smoke / e2e path)', async () => {
    // The connection string the unit carries, with this test's socket dir.
    const url = FOUNDATION_DATABASE_URL.replace(STACK.postgres.socketDir, sock);
    const admin = new URL(url); admin.pathname = '/postgres';
    const c = new pg.Client({ connectionString: admin.toString() });
    await c.connect();
    try {
      await c.query('CREATE DATABASE a3_scratch');
      const s = new URL(url); s.pathname = '/a3_scratch';
      const c2 = new pg.Client({ connectionString: s.toString() });
      await c2.connect();
      assert.equal((await c2.query('SELECT current_user AS u, current_database() AS d')).rows[0].d, 'a3_scratch');
      await c2.end();
      await c.query('DROP DATABASE a3_scratch WITH (FORCE)');
    } finally { await c.end(); }
  });

  await t.test('the smoke DB connector derives a scratch DSN on the socket and creates/drops it', async () => {
    const { smokeScratchDbScript } = await import('../mock2/smoke.js');
    const url = FOUNDATION_DATABASE_URL.replace(STACK.postgres.socketDir, sock);
    const script = smokeScratchDbScript({ socketDir: sock, foundationUrl: url })
      + 'printf "SDSN:%s\\n" "$SDSN"\n'
      + 'printf "DB:%s\\n" "$(psql -X -tA "$SDSN" -c "SELECT current_database() || \',\' || current_user")"\n';
    const env = { ...process.env }; delete env.DATABASE_URL; delete env.DB_URL;
    const r = await new Promise((resolve) => {
      const c = spawn('sh', ['-c', script], { env });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
      c.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(r.code, 0, r.out);
    const sdsn = (r.out.match(/^SDSN:(.*)$/m) || [])[1];
    assert.match(sdsn, new RegExp(`^postgres:///smoke_mig_\\d+\\?host=${sock.replace(/[/.]/g, '\\$&')}&user=app$`));
    assert.match(r.out, /^DB:smoke_mig_\d+,app$/m);
    const left = await foundationPsql(GUEST, "SELECT count(*) FROM pg_database WHERE datname LIKE 'smoke_mig_%';", { database: 'postgres' });
    assert.equal(left.stdout.trim(), '0', 'the scratch database was not dropped');
  });

  let objectCount = 0;
  await t.test('S3: app key reads/writes bucket app; anonymous and other buckets refused; admin counts', async () => {
    const app = s3(creds.app); const admin = s3(creds.admin);
    for (let i = 0; i < 3; i++) await app.send(new PutObjectCommand({ Bucket: 'app', Key: `a3/obj-${i}.txt`, Body: `hello ${i}` }));
    const got = await app.send(new GetObjectCommand({ Bucket: 'app', Key: 'a3/obj-1.txt' }));
    assert.equal(await got.Body.transformToString(), 'hello 1');
    for (const [m, path] of [['GET', '/'], ['GET', '/app'], ['GET', '/app/a3/obj-1.txt'], ['PUT', '/app/anon.txt']]) {
      const r = await fetch(`http://127.0.0.1:${layout.ports.storage}${path}`, { method: m, body: m === 'PUT' ? 'x' : undefined });
      assert.equal(r.status, 403, `anonymous ${m} ${path} → ${r.status}`);
    }
    await admin.send(new CreateBucketCommand({ Bucket: 'a3-other' }));
    await assert.rejects(app.send(new PutObjectCommand({ Bucket: 'a3-other', Key: 'x', Body: 'x' })), (e) => e.$metadata?.httpStatusCode === 403);
    await assert.rejects(app.send(new ListObjectsV2Command({ Bucket: 'a3-other' })), (e) => e.$metadata?.httpStatusCode === 403);
    objectCount = await bundledStorageObjectCount(GUEST, creds.admin);
    assert.equal(objectCount, 3);
    assert.equal(await bundledStorageObjectCount(GUEST, { accessKeyId: keyId(), secretAccessKey: secret() }), null, 'an unknown key must not produce a count');
  });

  await t.test('object count pages through more than 1000 keys', async () => {
    const app = s3(creds.app);
    const keys = Array.from({ length: 1100 }, (_, i) => `bulk/${String(i).padStart(5, '0')}&<x>.txt`);
    for (let i = 0; i < keys.length; i += 50) {
      await Promise.all(keys.slice(i, i + 50).map((Key) => app.send(new PutObjectCommand({ Bucket: 'app', Key, Body: 'b' }))));
    }
    objectCount = await bundledStorageObjectCount(GUEST, creds.admin);
    assert.equal(objectCount, 3 + 1100);
  });

  await t.test('memory: the running services stay well inside their limits (reported)', async (st) => {
    const r = await run(['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}', `${layout.composeProject}-postgres-1`, `${layout.composeProject}-storage-1`]);
    assert.equal(r.code, 0, r.stderr);
    st.diagnostic(r.stdout.trim().replace(/\n/g, ' | '));
    for (const line of r.stdout.trim().split('\n')) {
      const m = line.match(/ ([\d.]+)(KiB|MiB|GiB) \/ ([\d.]+)(MiB|GiB)/);
      assert.ok(m, line);
      const mib = (v, u) => Number(v) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 })[u];
      assert.ok(mib(m[1], m[2]) < mib(m[3], m[4]) * 0.8, `close to its limit: ${line}`);
    }
  });

  await t.test('storage stop / start keeps the objects', async () => {
    assert.equal((await setFoundationService(GUEST, 'storage', 'stop')).ok, true);
    const stopped = await foundationServiceStatus(GUEST);
    assert.equal(stopped.find((s) => s.service === 'storage').state, 'exited');
    assert.equal(await bundledStorageObjectCount(GUEST, creds.admin), null);
    assert.equal((await setFoundationService(GUEST, 'storage', 'start')).ok, true);
    const healthy = await waitFor(async () => (await foundationServiceStatus(GUEST))?.find((s) => s.service === 'storage' && s.health === 'healthy'), { timeoutMs: 120000 });
    assert.ok(healthy, 'storage did not come back healthy');
    const got = await waitFor(async () => {
      try { return await (await s3(creds.app).send(new GetObjectCommand({ Bucket: 'app', Key: 'a3/obj-2.txt' }))).Body.transformToString(); } catch { return null; }
    }, { timeoutMs: 60000 });
    assert.equal(got, 'hello 2');
    assert.equal(await bundledStorageObjectCount(GUEST, creds.admin), objectCount);
    assert.equal((await setFoundationService(GUEST, 'postgres', 'stop')).ok, false, 'postgres must never be stopped through a switch');
  });

  await t.test('postgres restart and container recreate keep the data', async () => {
    assert.equal((await foundationCompose(GUEST, ['restart', 'postgres'], { timeoutMs: 180000 })).code, 0);
    const back = await waitFor(async () => (await foundationServiceStatus(GUEST))?.find((s) => s.service === 'postgres' && s.health === 'healthy'), { timeoutMs: 120000 });
    assert.ok(back);
    assert.equal((await psqlAs('SELECT count(*) FROM a3_items')).stdout.trim(), '3');
    assert.equal((await foundationCompose(GUEST, ['up', '-d', '--force-recreate', 'postgres'], { timeoutMs: 180000 })).code, 0);
    const again = await waitFor(async () => (await foundationServiceStatus(GUEST))?.find((s) => s.service === 'postgres' && s.health === 'healthy'), { timeoutMs: 120000 });
    assert.ok(again);
    assert.equal((await psqlAs('SELECT count(*) FROM a3_items')).stdout.trim(), '3');
    for (const uid of [999, 65534]) assert.notEqual((await psqlAs('SELECT 1', { uid })).code, 0, `uid ${uid} connected after a recreate`);
  });

  await t.test('volume-deleting compose arguments are refused before anything runs', async () => {
    for (const args of [['down', '-v'], ['down', '--volumes'], ['rm', '-sfv'], ['volume', 'ls']]) {
      const r = await foundationCompose(GUEST, args);
      assert.equal(r.refused, true, args.join(' '));
    }
    const v = await run(['docker', 'volume', 'inspect', layout.volumes.postgres, layout.volumes.storage]);
    assert.equal(v.code, 0, 'a volume disappeared');
  });

  await t.test('MCP read-only SQL and dump scripts work on the stack', async () => {
    const r = await run(['sh', '-c', foundationReadOnlySqlScript(layout), 'sh', '50'], { input: 'SELECT id, embedding::text AS e FROM a3_items ORDER BY id;\n' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const lines = r.stdout.split('\n').filter((l) => l && !/^(SET|BEGIN|ROLLBACK)$/.test(l));
    assert.equal(lines[0], 'id|e');
    assert.equal(lines[1], '1|[1,0,0]');
    const w = await run(['sh', '-c', foundationReadOnlySqlScript(layout), 'sh', '50'], { input: 'INSERT INTO a3_items VALUES (9, NULL);\n' });
    assert.notEqual(w.code, 0);
    assert.match(w.stdout, /read-only transaction/);
    const file = join(base, 'dumps', 'app-test.sql');
    const d = await run(['sh', '-c', foundationDumpScript(layout), 'sh', file], { timeoutMs: 120000 });
    assert.equal(d.code, 0, d.stderr);
    assert.match(readFileSync(file, 'utf8').slice(0, 200), /PostgreSQL database dump/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  await t.test('clone dump leaves out the source deployment\'s secrets and switches', async () => {
    await foundationPsql(GUEST, "INSERT INTO mock2_foundation.secrets (name, sealed) VALUES ('storage.access_key_id', 'mfs1:a3-marker-secret');\nINSERT INTO mock2_foundation.features (feature, state, provider) VALUES ('storage', 'on', 'a3-marker-provider');\n");
    const d = await run(foundationCloneDumpArgv(layout), { timeoutMs: 120000 });
    assert.equal(d.code, 0, d.stderr);
    assert.ok(!d.stdout.includes('a3-marker-secret'));
    assert.ok(!d.stdout.includes('a3-marker-provider'));
    assert.match(d.stdout, /CREATE TABLE mock2_foundation\.secrets/);
    assert.match(d.stdout, /COPY public\.a3_items/);
  });

  await t.test('clone restore: the dump replays into a foundation database; the schema re-applies on top', async () => {
    const q = (a) => a.map((x) => `'${x.replace(/'/g, `'\\''`)}'`).join(' ');
    // Source and target are the same database here, so go through a file: a
    // live pipe would have the restore's DROPs wait on the dump's own locks.
    const file = join(base, 'clone.sql');
    const pipe = `set -o pipefail\n${q(foundationCloneDumpArgv(layout))} > '${file}' && ${q(foundationCloneRestoreArgv(layout))} < '${file}' 2>&1 | tail -n 3`;
    const r = await run(['bash', '-c', pipe], { timeoutMs: 180000 });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal((await psqlAs('SELECT count(*) FROM a3_items')).stdout.trim(), '3');
    assert.equal((await foundationPsql(GUEST, 'SELECT count(*) FROM mock2_foundation.secrets;')).stdout.trim(), '0', 'the source deployment\'s sealed secrets must not arrive');
    const ensure = await foundationPsql(GUEST, foundationEnsureSql(), { database: 'postgres' });
    assert.equal(ensure.code, 0, ensure.stderr);
    assert.equal((await psqlAs("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'mock2_foundation'")).stdout.trim(), '7');
    // A failing dump fails the pipe (pipefail), unlike the native one-liner.
    const broken = `set -o pipefail\n${q([...composeArgv(layout), 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', 'no_such_db'])} | ${q(foundationCloneRestoreArgv(layout))} 2>&1 | tail -n 3`;
    assert.notEqual((await run(['bash', '-c', broken], { timeoutMs: 60000 })).code, 0);
  });

  await t.test('bring-up again is idempotent and a rotated S3 key replaces the old one', async () => {
    const rotated = { ...creds, app: { accessKeyId: keyId(), secretAccessKey: secret() } };
    const r = await bringUpFoundation({ containerName: GUEST, features, masterKey, storageCredentials: rotated });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.steps.find((s) => s.name === 'files').detail, 'unchanged');
    assert.match(r.steps.find((s) => s.name === 'master-key').detail, /unchanged/);
    assert.equal((await psqlAs('SELECT count(*) FROM a3_items')).stdout.trim(), '3');
    assert.equal(await bundledStorageObjectCount(GUEST, creds.admin), objectCount);
    const fresh = await waitFor(async () => {
      try { return await (await s3(rotated.app).send(new GetObjectCommand({ Bucket: 'app', Key: 'a3/obj-0.txt' }))).Body.transformToString(); } catch { return null; }
    }, { timeoutMs: 30000 });
    assert.equal(fresh, 'hello 0');
    await assert.rejects(s3(creds.app).send(new GetObjectCommand({ Bucket: 'app', Key: 'a3/obj-0.txt' })), (e) => e.$metadata?.httpStatusCode === 403, 'the old app key still works after rotation');
    const files = await writeFoundationFiles(GUEST, { features });
    assert.equal(files.changed, false);
  });

  await t.test('a stack from before the reporting port converges at bring-up: CREATEROLE, the port, the pg_hba line; data kept', async () => {
    // The stack as the previous revision wrote it: no network and no port,
    // listen_addresses empty, a socket-only pg_hba, an app role without
    // CREATEROLE and no reporting role yet.
    const model = buildFoundationComposeModel({ layout });
    const prev = model.services.postgres;
    delete prev.ports; delete prev.networks; delete model.networks.postgres;
    prev.network_mode = 'none';
    prev.command = ['postgres', '-c', 'hba_file=/etc/mock2/pg_hba.conf', '-c', 'ident_file=/etc/mock2/pg_ident.conf', '-c', 'listen_addresses='];
    writeFileSync(layout.composeFile, `${JSON.stringify(model, null, 2)}\n`); // JSON is YAML
    writeFileSync(join(layout.dir, 'postgres', 'pg_hba.conf'), '# the previous revision\nlocal   all       all   peer map=mock2\n');
    const old = await foundationCompose(GUEST, ['up', '-d', 'postgres'], { timeoutMs: 180000 });
    assert.equal(old.code, 0, old.stderr);
    assert.ok(await waitFor(async () => (await foundationServiceStatus(GUEST))?.find((s) => s.service === 'postgres' && s.health === 'healthy'), { timeoutMs: 120000 }), 'the previous-revision postgres did not come up');
    const reset = await foundationPsql(GUEST, 'ALTER ROLE app NOCREATEROLE;\nDROP OWNED BY app_readonly;\nDROP ROLE app_readonly;\n');
    assert.equal(reset.code, 0, reset.stderr);
    assert.equal(await tcpProbe('127.0.0.1', layout.ports.postgres), 'refused');
    const before = runReadonly(roDir, 'enable', roEnv());
    assert.equal(before.error?.code, 'DB_PRIVILEGE', JSON.stringify(before));
    assert.match(before.error.message, /next bring-up/);

    const r = await bringUpFoundation({ containerName: GUEST, features, masterKey, storageCredentials: creds });
    assert.equal(r.ok, true, r.error);
    const files = r.steps.find((s) => s.name === 'files').detail;
    assert.match(files, /compose\.yaml/);
    assert.match(files, /postgres\/pg_hba\.conf/);
    assert.equal((await foundationPsql(GUEST, "SELECT rolcreaterole FROM pg_roles WHERE rolname = 'app';", { database: 'postgres' })).stdout.trim(), 't');
    assert.equal((await psqlAs('SELECT count(*) FROM a3_items')).stdout.trim(), '3');
    const en = runReadonly(roDir, 'enable', roEnv());
    assert.equal(en.error, undefined, JSON.stringify(en.error));
    const c = await pgConnect(en.result.url);
    try { assert.equal((await c.query('SELECT org_name FROM api_read.branding')).rows[0].org_name, 'Application'); } finally { await c.end(); }
    // And once more: nothing to change, still reachable.
    const again = await bringUpFoundation({ containerName: GUEST, features, masterKey, storageCredentials: creds });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.steps.find((s) => s.name === 'files').detail, 'unchanged');
    const c2 = await pgConnect(en.result.url); await c2.end();
  });

  await t.test('embeddings off: bring-up left it stopped, the volume is declared', async () => {
    const st = await foundationServiceStatus(GUEST);
    assert.notEqual(st.find((s) => s.service === 'embeddings').state, 'running');
  });

  await t.test('compose model as Docker parses it: every port on 127.0.0.1, postgres on its own network', async () => {
    const r = await run([...composeArgv(layout), 'config', '--format', 'json']);
    assert.equal(r.code, 0, r.stderr);
    const cfg = JSON.parse(r.stdout);
    assert.equal(cfg.services.postgres.network_mode, undefined);
    assert.deepEqual(Object.keys(cfg.services.postgres.networks), ['postgres']);
    assert.deepEqual(cfg.services.postgres.ports.map((p) => [p.host_ip, String(p.published), p.target]), [['127.0.0.1', String(layout.ports.postgres), 5432]]);
    for (const s of ['storage', 'embeddings']) {
      assert.ok(cfg.services[s].ports.length > 0);
      for (const p of cfg.services[s].ports) assert.equal(p.host_ip, '127.0.0.1', `${s} publishes on ${p.host_ip}`);
    }
    assert.equal(cfg.volumes[layout.volumes.postgres].name, layout.volumes.postgres);
  });

  await t.test('the portable copy is a valid Compose file with the same design', async () => {
    const dir = join(base, 'portable');
    const files = (await import('../mock2/foundation-stack-logic.js')).buildFoundationFiles({ portable: true });
    for (const f of files) {
      const p = join(dir, f.path);
      spawnSync('mkdir', ['-p', join(p, '..')]);
      (await import('node:fs')).writeFileSync(p, f.content, { mode: f.mode });
    }
    assert.ok(existsSync(join(dir, 'postgres/initdb/01-mock2-foundation.sql')));
    const r = await run(['docker', 'compose', '-f', join(dir, 'compose.yaml'), 'config', '--format', 'json'], { env: { MOCK2_FOUNDATION_PROJECT: `${PREFIX}-portable-${pid}` } });
    assert.equal(r.code, 0, r.stderr);
    const cfg = JSON.parse(r.stdout);
    assert.equal(cfg.name, `${PREFIX}-portable-${pid}`);
    assert.equal(cfg.services.postgres.network_mode, undefined);
    assert.deepEqual(cfg.services.postgres.ports.map((p) => [p.host_ip, String(p.published), p.target]), [['127.0.0.1', '5432', 5432]]);
    const moved = await run(['docker', 'compose', '-f', join(dir, 'compose.yaml'), 'config', '--format', 'json'], { env: { MOCK2_FOUNDATION_PROJECT: `${PREFIX}-portable-${pid}`, MOCK2_FOUNDATION_PG_PORT: '15432' } });
    assert.equal(JSON.parse(moved.stdout).services.postgres.ports[0].published, '15432');
    assert.ok(cfg.services.postgres.volumes.some((v) => v.target === '/var/run/postgresql' && v.source === STACK.postgres.socketDir));
    for (const s of ['storage', 'embeddings']) for (const p of cfg.services[s].ports) assert.equal(p.host_ip, '127.0.0.1');
    assert.equal(buildFoundationComposeYaml({ portable: true }).includes('mock2_pg_data:\n    name:'), false, 'portable volumes must be project-scoped');
  });
});
