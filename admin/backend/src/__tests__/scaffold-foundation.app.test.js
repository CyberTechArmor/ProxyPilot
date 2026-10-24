// The WHOLE generated application on the foundation (FOUNDATION_E2E=1):
//
//   1. typecheck — the full seed (scaffold + platform + foundation) plus the
//      auth component and its wiring, npm-installed, `tsc --noEmit` clean, with
//      feature-style code importing the adapters both as '#foundation' and by
//      relative path; the declarations themselves pass with skipLibCheck off;
//      a misuse of the typed API is rejected.
//   2. build + migrate + boot — `npm run build`, `npm run migrate` against a
//      real pgvector Postgres, then `npm run start` (node --import=<bootstrap>)
//      in PRODUCTION mode with the auth component's AUTH_JWT_SECRET /
//      AUTH_MASTER_SECRET present ONLY as sealed component.* secrets in the app
//      database. The auth component refuses its dev defaults in production, so
//      the app serving at all proves the bootstrap put them in process.env
//      before the app modules ran; a probe module imported FIRST by the entry
//      also sees one at module load.
//   3. the admin-only GET /api/foundation/health end to end (401 anonymous,
//      200 for the first administrator), and the dev script (tsx watch with
//      the same --import) boots too.
//
// Storage and embeddings are switched off here (the S3 and embedding paths are
// proven by scaffold-foundation.docker.test.js); every container is a4-.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import * as contract from '../mock2/foundation-contract.js';
import { buildSeedFiles } from '../mock2/template.js';
import { buildAuthWiredFiles } from '../mock2/scaffold-auth.js';

const E2E = process.env.FOUNDATION_E2E === '1';
const SKIP = E2E ? false : 'set FOUNDATION_E2E=1 to typecheck, build and boot a generated app on the foundation (Docker + npm registry)';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTH_COMPONENT = path.resolve(HERE, '..', 'mock2', 'framework-seed', 'proxypilot-auth.component.json');
const PG = `a4-${process.pid}-pg-app`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(cmd, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 900000, ...opts });
  return { ...r, ms: Date.now() - started };
}

function write(dir, rel, content, mode) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, mode ? { mode } : undefined);
}

// Start a long-running command; resolve once `ready` appears in its output.
function startUntil(cmd, args, { cwd, env, ready, timeout = 90000 }) {
  const child = spawn(cmd, args, { cwd, env, detached: true });
  let out = '';
  const onData = (d) => { out += d; };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (ready.test(out)) { clearInterval(tick); resolve({ child, output: () => out, stop }); }
      else if (child.exitCode !== null || Date.now() - started > timeout) {
        clearInterval(tick);
        stop();
        reject(new Error(`${cmd} ${args.join(' ')} did not get ready (exit ${child.exitCode}):\n${out.slice(-4000)}`));
      }
    }, 100);
  });
}

const FEATURE_USAGE_TS = `// Feature-style code over the foundation adapters (typecheck only).
import {
  storage, vector, embeddings, foundationHttpError, FoundationUnavailableError, isLocalEmbeddings,
  LOCAL_EMBEDDINGS_WARNING, healthReport, DEPENDENT_CAPABILITIES,
  type SearchHit, type HealthReport, type StorageDescription,
} from '#foundation';
import { openStorage } from '../foundation/index.mjs';
import { describeDatabase } from '../foundation/runtime/config.mjs';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';

export async function usage(_req: Request, res: Response): Promise<void> {
  try {
    await storage.put('a.txt', Buffer.from('x'), { contentType: 'text/plain', metadata: { owner: 'me' } });
    await storage.put('b.bin', Readable.from([Buffer.from('y')]));
    const obj = await storage.get('a.txt');
    obj.body.resume();
    const head = await storage.head('a.txt');
    const size: number | undefined = head?.size;
    const page = await storage.list({ prefix: 'a', limit: 10 });
    const cursor: string | null = page.cursor;
    for await (const item of storage.listAll({ prefix: 'a' })) { const k: string = item.key; void k; }
    const url: string = await storage.presignGet('a.txt', { expiresIn: 60 });
    const st = await openStorage({ pending: false });
    const info: StorageDescription = st.info();
    const r = await vector.upsert({ source: 's', itemId: '1', content: 'hello', metadata: { a: 1 } });
    const embedded: boolean = r.embedded;
    const hits: SearchHit[] = await vector.search({ query: 'hello', k: 5, source: 's' });
    const removed: number = (await vector.remove({ source: 's', itemId: '1' })).removed;
    const v: number[][] = await embeddings.embed(['a']);
    const rep: HealthReport = await healthReport({ refresh: true });
    const dependents: readonly string[] = DEPENDENT_CAPABILITIES.storage;
    res.json({ size, cursor, url, info, embedded, hits, removed, v, rep, dependents, local: isLocalEmbeddings(), warning: LOCAL_EMBEDDINGS_WARNING, where: describeDatabase('x') });
  } catch (err) {
    if (err instanceof FoundationUnavailableError) { const code: 'STORAGE_OFF' | string = err.code; void code; }
    const http = foundationHttpError(err);
    if (http) { res.status(http.status).json(http.body); return; }
    throw err;
  }
}
`;

const FEATURE_MISUSE_TS = `import { vector } from '#foundation';
export async function misuse(): Promise<void> {
  await vector.search({ k: 5 });
}
`;

const ORDER_PROBE_TS = `// Test-only: reads a component secret at MODULE LOAD, as the very first module
// the entry imports.
const seen = process.env.FOUNDATION_ORDER_PROBE;
console.log('[order-probe] ' + (seen ? 'component secret present at module load' : 'component secret MISSING at module load'));
export {};
`;

test('a generated app typechecks, builds, migrates and boots on the foundation, with component secrets only in the database', { skip: SKIP, timeout: 1800000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-foundation-app-'));
  const app = path.join(tmp, 'app');
  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
    spawnSync('docker', ['rm', '-f', '-v', PG], { encoding: 'utf8' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- the generated tree: seed + the auth component + its wiring ----------
  for (const f of buildSeedFiles({ name: 'Foundation Probe' })) write(app, f.path, f.content, f.mode);
  const auth = JSON.parse(fs.readFileSync(AUTH_COMPONENT, 'utf8'));
  for (const f of auth.files) write(app, f.path, f.content);
  for (const f of buildAuthWiredFiles()) write(app, f.path, f.content);
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  pkg.dependencies.cookie = '^0.7.2';
  pkg.dependencies.ldapts = 'latest';
  fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  write(app, 'src/foundation-usage.ts', FEATURE_USAGE_TS);
  write(app, 'src/order-probe.ts', ORDER_PROBE_TS);
  const serverTs = path.join(app, 'src/server.ts');
  fs.writeFileSync(serverTs, `import './order-probe.js';\n${fs.readFileSync(serverTs, 'utf8')}`);

  const install = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: app });
  assert.equal(install.status, 0, install.stderr);
  console.log(`[a4] npm install of the generated app: ${Math.round(install.ms / 1000)} s`);

  // ---- 1. typecheck --------------------------------------------------------
  const tsc = run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: app });
  assert.equal(tsc.status, 0, `tsc --noEmit failed:\n${tsc.stdout}${tsc.stderr}`);
  console.log(`[a4] tsc --noEmit (strict, NodeNext, with the foundation imports): ${(tsc.ms / 1000).toFixed(1)} s`);

  const declFiles = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.d.mts')) declFiles.push(path.relative(app, p)); } };
  walk(path.join(app, 'foundation'));
  write(app, 'tsconfig.foundation.json', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] },
    files: declFiles,
  }));
  const decl = run('npx', ['tsc', '-p', 'tsconfig.foundation.json'], { cwd: app });
  assert.equal(decl.status, 0, `the foundation declarations do not check:\n${decl.stdout}${decl.stderr}`);

  write(app, 'src/foundation-misuse.ts', FEATURE_MISUSE_TS);
  const misuse = run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: app });
  assert.notEqual(misuse.status, 0, 'a search without a query must not typecheck');
  assert.match(misuse.stdout, /foundation-misuse\.ts.*'query' is missing/s);
  fs.rmSync(path.join(app, 'src/foundation-misuse.ts'));

  // ---- 2. build, a real database, migrate, boot in production --------------
  const build = run('npm', ['run', 'build'], { cwd: app });
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
  assert.ok(fs.existsSync(path.join(app, 'dist/server.js')));

  // The app's own pool: a failed connection names the database it tried —
  // by default the foundation socket, otherwise the explicit DATABASE_URL.
  const poolProbe = "const { pool } = await import('./dist/db/index.js');"
    + " try { await pool.query('SELECT 1'); console.log('UNEXPECTED success'); } catch (e) { console.log('ERR ' + e.message); }"
    + ' await pool.end().catch(() => {});';
  const noDbEnv = { ...process.env };
  delete noDbEnv.DATABASE_URL;
  const viaDefault = run(process.execPath, ['--input-type=module', '-e', poolProbe], { cwd: app, env: noDbEnv });
  assert.match(viaDefault.stdout, new RegExp(`ERR Cannot connect to the application database \\(socket ${contract.STACK.postgres.socketDir}, database app, user app\\): `));
  const unusedPort = await freePort();
  const viaUrl = run(process.execPath, ['--input-type=module', '-e', poolProbe], { cwd: app, env: { ...noDbEnv, DATABASE_URL: `postgres://app@127.0.0.1:${unusedPort}/app` } });
  assert.match(viaUrl.stdout, new RegExp(`ERR Cannot connect to the application database \\(127\\.0\\.0\\.1:${unusedPort}, database app, user app\\): `));

  const pgPort = await freePort();
  const dockerRun = run('docker', ['run', '-d', '--name', PG, '-e', 'POSTGRES_PASSWORD=a4-unused', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-p', `127.0.0.1:${pgPort}:5432`, contract.STACK.postgres.image]);
  assert.equal(dockerRun.status, 0, dockerRun.stderr);
  const superClient = async (db) => { const c = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${pgPort}/${db}` }); c.on('error', () => {}); await c.connect(); return c; };
  let su;
  for (let i = 0; ; i += 1) {
    try { su = await superClient('postgres'); break; } catch (err) { if (i > 240) throw err; await sleep(250); }
  }
  await su.query('CREATE ROLE app LOGIN');
  await su.query('CREATE DATABASE app OWNER app');
  await su.end();
  su = await superClient('app');
  cleanups.push(() => su.end());
  await su.query(contract.FOUNDATION_SCHEMA_SQL);
  const defaults = contract.defaultFeatures();
  for (const f of ['storage', 'embeddings']) {
    await su.query("INSERT INTO mock2_foundation.features (feature, state, provider, config, generation) VALUES ($1, 'off', $2, $3::jsonb, 1)", [f, defaults[f].provider, JSON.stringify(defaults[f].config)]);
  }
  const masterKey = contract.generateMasterKey();
  const keyFile = path.join(tmp, 'master.key');
  fs.writeFileSync(keyFile, `${masterKey}\n`, { mode: 0o600 });
  const componentSecrets = {
    AUTH_JWT_SECRET: crypto.randomBytes(48).toString('base64url'),
    AUTH_MASTER_SECRET: crypto.randomBytes(48).toString('base64url'),
    FOUNDATION_ORDER_PROBE: 'present',
  };
  for (const [k, v] of Object.entries(componentSecrets)) {
    const name = contract.componentSecretName(k);
    await su.query('INSERT INTO mock2_foundation.secrets (name, sealed, generation) VALUES ($1, $2, 1)', [name, contract.sealForApp(masterKey, name, v)]);
  }
  await su.query("INSERT INTO mock2_foundation.meta (key, value) VALUES ('generation', to_jsonb(1))");

  // The environment carries NO secret: only where the database and key file are.
  const env = { ...process.env, DATABASE_URL: `postgres://app@127.0.0.1:${pgPort}/app`, FOUNDATION_KEY_FILE: keyFile, FOUNDATION_DB_RETRY_MS: '20000' };
  for (const k of Object.keys(componentSecrets)) delete env[k];
  delete env.NODE_ENV;

  const migrate = run('npm', ['run', 'migrate'], { cwd: app, env });
  assert.equal(migrate.status, 0, `${migrate.stdout}${migrate.stderr}`);
  assert.match(migrate.stdout, /apply 0001_init\.sql/);
  const applied = (await su.query('SELECT name FROM _migrations ORDER BY name')).rows.map((r) => r.name);
  assert.ok(applied.includes('0001_auth.sql') && applied.includes('0100_platform.sql'), applied.join(','));

  // A migrate that cannot reach its database says where it looked and applies nothing.
  const deadPort = await freePort();
  const badMigrate = run('npm', ['run', 'migrate'], { cwd: app, env: { ...env, DATABASE_URL: `postgres://app@127.0.0.1:${deadPort}/app`, FOUNDATION_DB_RETRY_MS: '300' } });
  assert.notEqual(badMigrate.status, 0);
  assert.match(badMigrate.stderr, new RegExp(`127\\.0\\.0\\.1:${deadPort}, database app, user app`));
  assert.match(badMigrate.stderr, /nothing was applied/);

  const port = await freePort();
  const server = await startUntil('npm', ['run', 'start'], {
    cwd: app, env: { ...env, PORT: String(port), NODE_ENV: 'production' }, ready: /app listening on 0\.0\.0\.0:\d+/,
  });
  cleanups.push(() => server.stop());
  const log = server.output();
  assert.match(log, /\[foundation\] loaded generation 1 from 127\.0\.0\.1:\d+, database app, user app; storage off \(bundled\); embeddings off \(local\); 3 component secrets in memory/);
  assert.match(log, /\[order-probe\] component secret present at module load/, 'the first app module already sees component secrets');
  for (const v of Object.values(componentSecrets).filter((x) => x !== 'present')) assert.ok(!log.includes(v), 'no secret in the log');

  // ---- 3. the admin-only foundation health route ---------------------------
  const base = `http://127.0.0.1:${port}`;
  const anon = await fetch(`${base}/api/foundation/health`);
  assert.ok([401, 503].includes(anon.status), `anonymous: ${anon.status}`);
  const boot = await fetch(`${base}/api/auth/bootstrap/superadmin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@foundation.test', password: `Probe-${crypto.randomBytes(9).toString('base64url')}!9a` }),
  });
  assert.equal(boot.status, 201, await boot.text());
  const cookie = boot.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(`${base}/api/foundation/health?refresh=1`, { headers: { cookie } });
  assert.equal(res.status, 200, await res.clone().text());
  const report = await res.json();
  assert.equal(report.foundation_version, contract.FOUNDATION_VERSION);
  assert.deepEqual(report.components.map((c) => [c.component, c.status]), [['database', 'ready'], ['storage', 'off'], ['embeddings', 'off']]);
  assert.equal(report.local_embeddings, true);
  assert.deepEqual(report.warnings, [contract.LOCAL_EMBEDDINGS_WARNING]);
  assert.equal((await fetch(`${base}/api/foundation/health?refresh=2`, { headers: { cookie } })).status, 400, 'the query is validated');
  const anonAfter = await fetch(`${base}/api/foundation/health`);
  assert.equal(anonAfter.status, 401, 'administrators only');
  const recorded = (await su.query('SELECT component, status FROM mock2_foundation.health ORDER BY component')).rows;
  assert.deepEqual(recorded, [{ component: 'database', status: 'ready' }, { component: 'embeddings', status: 'off' }, { component: 'storage', status: 'off' }]);
  server.stop();

  // ---- the dev script runs with the same bootstrap -------------------------
  const devPort = await freePort();
  const dev = await startUntil('npm', ['run', 'dev'], {
    cwd: app, env: { ...env, PORT: String(devPort) }, ready: /app listening on 0\.0\.0\.0:\d+/,
  });
  cleanups.push(() => dev.stop());
  assert.match(dev.output(), /\[order-probe\] component secret present at module load/);
  dev.stop();
});
