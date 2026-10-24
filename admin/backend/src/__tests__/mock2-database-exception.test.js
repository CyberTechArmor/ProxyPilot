// "No SQLite without an explicit request" (app foundation, 2026-10;
// docs/features/app-foundation.md). The recorded exception (migration 565,
// /api/mock2/projects/:id/database-exception), the finish guard that stops a
// build which ADDS a refused engine, the command policy every lane applies,
// and the ratchets that keep the one database rule in every place a builder
// reads instructions — and keep the exception out of reach of MCP and of the
// repository. ./db.js is stubbed at the module boundary (node:sqlite stands in
// for better-sqlite3); nothing here opens the real mock2.db.

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { MOCK2_MIGRATIONS } from '../mock2/migrations.js';
import {
  DATABASE_RULE, DATABASE_EXCEPTION_UI_PATH, classifyEngineSpecifier, validateExceptionInput, shapeException,
  databaseRuleLine, gateExceptionValue, introducedEngineHits, packageEngineHits, sourceEngineHits,
} from '../mock2/database-exception-logic.js';
import {
  buildChangedEngineReadScript, parseChangedEngineRead, databaseEngineRejectionMessage,
  initFinishGuard, recordFinishRejection, FINISH_REJECTION_BUDGET,
} from '../mock2/finish-guard-logic.js';
import { registerDatabaseExceptionRoutes } from '../mock2/database-exception-routes.js';
import { commandAllowed, foundationCommandPolicy, refusedDatabaseInstall } from '../mock2/harness-safety.js';
import { makePreToolUseGuard } from '../mock2/runner-sdk-hooks.js';
import { buildRunnerSystemPrompt, buildRunnerClaudeMd } from '../mock2/runner-logic.js';
import { BUILD_PLAN_SYSTEM_PROMPT } from '../mock2/contract-classifier-logic.js';
import { agentsMd } from '../mock2/continuity-convention.js';
import { buildSeedFiles } from '../mock2/template.js';
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOLS } from '../lib/mcp-logic.js';

// ---- the store over migration 565, with ./db.js stubbed ----

const fixture = { db: null };
globalThis.__mock2DbExceptionFixture = fixture;
const storeUrl = new URL('../mock2/database-exception.js', import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === storeUrl && specifier === './db.js') {
      return { url: `data:text/javascript,${encodeURIComponent('export const getMock2Db = () => globalThis.__mock2DbExceptionFixture.db;')}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const store = await import(storeUrl);
hook.deregister();

const m565 = MOCK2_MIGRATIONS.find((m) => m.version === 565);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  const adapter = { prepare: (sql) => db.prepare(sql), exec: (sql) => db.exec(sql), raw: db };
  m565.up(adapter);
  fixture.db = adapter;
  return adapter;
}

const REQUEST = 'Please build this on SQLite — it is a single-user desktop tool and I do not want a server.';

test('migration 565 creates mock2_database_exceptions as specified, leaves 564 free, and is idempotent', () => {
  assert.ok(m565, 'registered');
  assert.equal(m565.name, 'mock2_database_exceptions');
  const versions = MOCK2_MIGRATIONS.map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length, 'no duplicate version');
  assert.ok(!MOCK2_MIGRATIONS.some((m) => m.version === 564 && m.name === 'mock2_database_exceptions'), '564 is the sibling change\'s');
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(mock2_database_exceptions)').all()
    .map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}`);
  assert.deepEqual(cols, ['project_id INTEGER PK', 'engine TEXT NOT NULL', 'request_text TEXT NOT NULL', 'recorded_by TEXT NOT NULL', 'created_at TEXT NOT NULL']);
  m565.up(db); // re-running is harmless
  // The CHECKs hold even against a writer that skipped validation.
  const ins = db.prepare('INSERT INTO mock2_database_exceptions (project_id, engine, request_text, recorded_by, created_at) VALUES (?, ?, ?, ?, ?)');
  assert.throws(() => ins.run(1, 'mysql', REQUEST, 'ann', '2026-10-24T00:00:00Z'), /CHECK/);
  assert.throws(() => ins.run(1, 'sqlite', 'too short', 'ann', '2026-10-24T00:00:00Z'), /CHECK/);
  assert.throws(() => ins.run(1, 'sqlite', 'x'.repeat(2001), 'ann', '2026-10-24T00:00:00Z'), /CHECK/);
  assert.match(m565.up.toString(), /CREATE TABLE IF NOT EXISTS mock2_database_exceptions/, 'the DDL is written out in the migration');
});

test('store: get → null, set records the person\'s words, set again replaces, clear removes and returns what was there', () => {
  freshDb();
  assert.equal(store.getDatabaseException(7), null);
  const e = store.setDatabaseException(7, { engine: 'sqlite', request_text: REQUEST }, 'ann', '2026-10-24T10:00:00.000Z');
  assert.deepEqual(e, { engine: 'sqlite', request_text: REQUEST, recorded_by: 'ann', created_at: '2026-10-24T10:00:00.000Z' });
  assert.deepEqual(store.getDatabaseException(7), e);
  assert.equal(store.getDatabaseException(8), null, 'per project');
  const e2 = store.setDatabaseException(7, { engine: 'sqlite', request_text: `${REQUEST} Again.` }, 'bob', '2026-10-25T10:00:00.000Z');
  assert.equal(e2.recorded_by, 'bob');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM mock2_database_exceptions').get().n, 1);
  assert.deepEqual(store.clearDatabaseException(7), e2);
  assert.equal(store.getDatabaseException(7), null);
  assert.equal(store.clearDatabaseException(7), null);
});

test('store: a missing table reads as NO exception (the strict rule), never as one', () => {
  fixture.db = { prepare: () => { throw new Error('no such table: mock2_database_exceptions'); } };
  assert.equal(store.getDatabaseException(1), null);
});

test('deleting a project removes its recorded exception (ids can be reused)', async () => {
  const src = await readFile(new URL('../mock2/projects.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function deleteProject'), src.indexOf('return tx();', src.indexOf('export function deleteProject')));
  assert.match(body, /DELETE FROM mock2_database_exceptions WHERE project_id = \?/);
});

// ---- the pure layer ----

test('validateExceptionInput: sqlite only, acknowledge: true, the user\'s own words 10–2000 characters', () => {
  assert.deepEqual(validateExceptionInput({ engine: 'sqlite', request_text: `  ${REQUEST}  `, acknowledge: true }),
    { ok: true, value: { engine: 'sqlite', request_text: REQUEST } });
  for (const [body, code] of [
    [{ engine: 'mysql', request_text: REQUEST, acknowledge: true }, 'ENGINE_NOT_EXCEPTABLE'],
    [{ engine: 'pglite', request_text: REQUEST, acknowledge: true }, 'ENGINE_NOT_EXCEPTABLE'],
    [{ request_text: REQUEST, acknowledge: true }, 'ENGINE_NOT_EXCEPTABLE'],
    [{ engine: 'sqlite', request_text: REQUEST }, 'ACKNOWLEDGE_REQUIRED'],
    [{ engine: 'sqlite', request_text: REQUEST, acknowledge: 'true' }, 'ACKNOWLEDGE_REQUIRED'],
    [{ engine: 'sqlite', acknowledge: true }, 'REQUEST_TEXT_REQUIRED'],
    [{ engine: 'sqlite', request_text: 'sqlite pls', acknowledge: true }, null],
    [{ engine: 'sqlite', request_text: 'sqlite', acknowledge: true }, 'REQUEST_TEXT_LENGTH'],
    [{ engine: 'sqlite', request_text: 'x'.repeat(2001), acknowledge: true }, 'REQUEST_TEXT_LENGTH'],
    [null, 'ENGINE_NOT_EXCEPTABLE'],
  ]) {
    const v = validateExceptionInput(body);
    if (code === null) assert.equal(v.ok, true, JSON.stringify(body));
    else assert.equal(v.code, code, JSON.stringify(body));
  }
  // Control characters are dropped; newlines are the person's.
  assert.equal(validateExceptionInput({ engine: 'sqlite', request_text: 'use\u0000 SQLite\r\nplease', acknowledge: true }).value.request_text, 'use SQLite\nplease');
});

test('shapeException / gateExceptionValue fail closed on anything but a known engine', () => {
  assert.equal(shapeException(null), null);
  assert.equal(shapeException({ engine: 'mysql', request_text: REQUEST }), null);
  assert.equal(gateExceptionValue(null), '');
  assert.equal(gateExceptionValue({ engine: 'mysql' }), '');
  assert.equal(gateExceptionValue({ engine: 'sqlite', request_text: REQUEST }), 'sqlite');
});

test('classifyEngineSpecifier: PostgreSQL drivers and relative paths are never engines', () => {
  for (const ok of ['pg', 'postgres', 'drizzle-orm', 'drizzle-orm/node-postgres', 'drizzle-orm/postgres-js', 'drizzle-orm/pg-core',
    'pgvector', 'pgvector/pg', '@aws-sdk/client-s3', 'zod', './sqlite-store.js', '../db/sqlite.ts', '/abs/sqlite.js', 'kysely']) {
    assert.equal(classifyEngineSpecifier(ok), null, ok);
  }
});

test('databaseRuleLine: the rule by default; the recorded request quoted, with its date, when there is one', () => {
  assert.equal(databaseRuleLine(null), DATABASE_RULE);
  const line = databaseRuleLine({ engine: 'sqlite', request_text: 'Use SQLite,\n  it is offline-only.', created_at: '2026-10-24T10:00:00.000Z' });
  assert.match(line, /^Database: The user explicitly asked for SQLite: "Use SQLite, it is offline-only\." \(recorded 2026-10-24\)\./);
  assert.match(line, /every other engine is still refused/);
});

// ---- the finish guard ----

test('introducedEngineHits: only what THIS build added counts; the exception allows the SQLite family only', () => {
  const files = [
    { path: 'src/db.ts', base: "import pg from 'pg';", current: "import pg from 'pg';\nimport Database from 'better-sqlite3';" },
    { path: 'src/old.ts', base: "import x from 'sqlite3';", current: "import x from 'sqlite3';\nconst y = 1;" },
    { path: 'package.json', base: JSON.stringify({ dependencies: { pg: '8' } }), current: JSON.stringify({ dependencies: { pg: '8', 'better-sqlite3': '11', mysql2: '3' } }) },
    { path: 'node_modules/x/index.js', base: '', current: "require('sqlite3')" },
    { path: 'docs/notes.md', base: '', current: "import x from 'sqlite3'" },
  ];
  const hits = introducedEngineHits({ files });
  assert.deepEqual(hits.map((h) => `${h.path}:${h.name}`).sort(), ['package.json:better-sqlite3', 'package.json:mysql2', 'src/db.ts:better-sqlite3']);
  const allowed = introducedEngineHits({ files, exception: { engine: 'sqlite', request_text: REQUEST } });
  assert.deepEqual(allowed.map((h) => h.name), ['mysql2']);
  // An unreadable package.json is not a clean one.
  assert.equal(introducedEngineHits({ files: [{ path: 'package.json', base: '{}', current: '{ "dependencies": ' }] })[0].key, 'pkg:unparseable');
  assert.deepEqual(packageEngineHits('package.json', ''), []);
  assert.equal(sourceEngineHits('README.md', "import x from 'sqlite3'").length, 0, 'docs are never read');
});

test('databaseEngineRejectionMessage names the file, the engine and the way out', () => {
  const msg = databaseEngineRejectionMessage([{ path: 'src/db.ts', line: 2, name: 'better-sqlite3', engine: 'SQLite', family: 'sqlite', key: 'spec:better-sqlite3' }]);
  assert.match(msg, /^Not finished — this build adds a database engine the platform refuses\./);
  assert.match(msg, /Found: src\/db\.ts:2 better-sqlite3 \(SQLite\)\./);
  assert.ok(msg.includes(DATABASE_EXCEPTION_UI_PATH));
  assert.match(msg, /a build cannot\./);
  assert.match(msg, /If PostgreSQL is unreachable, report it and stop/);
});

test('the database-engine rejection uses the SHARED finish budget: exhaustion concludes, never succeeds', () => {
  let g = initFinishGuard();
  let r;
  for (let i = 0; i <= FINISH_REJECTION_BUDGET; i++) {
    r = recordFinishRejection(g, { validator: 'database-engine', input: { summary: `attempt ${i} with different words ${'x'.repeat(i * 7)}`, acceptance: [`check ${i}`] } });
    g = r.state;
  }
  assert.equal(r.exhausted, true);
  assert.ok(g.history.every((h) => h.validator === 'database-engine'));
});

test('the runners wire the finish guard before acceptance, pass the exception to the gates, and keep it out of the repo', async () => {
  const runner = await readFile(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  const guard = runner.indexOf("validator: 'database-engine'");
  assert.ok(guard > 0, 'the hand-rolled finish rejects through rejectFinishOrConclude');
  assert.ok(runner.indexOf('readIntroducedDatabaseEngines({ containerSh, containerName, appDir: APP_DIR, projectId })') < guard);
  assert.ok(guard < runner.indexOf("validator: 'acceptance-demonstrated'"), 'checked before the acceptance verdict');
  // The gate's env comes from mock2.db on every gate command line — empty when nothing is recorded.
  const battery = runner.slice(runner.indexOf('export async function runGateBattery'), runner.indexOf('export function formatGateReports'));
  assert.match(battery, /gateExceptionValue\(getDatabaseException\(getCycle\(cycleId\)\?\.project_id\)\)/);
  assert.match(battery, /MOCK2_DATABASE_EXCEPTION='\$\{dbException === 'sqlite' \? 'sqlite' : ''\}'/);
  assert.match(battery, /MOCK2_GATE_PROFILE=/);
  // The SDK lane: same check, same exception in its governance file and Bash guard.
  const sdk = await readFile(new URL('../mock2/runner-sdk.js', import.meta.url), 'utf8');
  assert.match(sdk, /readIntroducedDatabaseEngines\(/);
  assert.match(sdk, /databaseException,\n/);
});

test('buildChangedEngineReadScript → parseChangedEngineRead → introducedEngineHits against a real git checkout', { skip: spawnSync('git', ['--version']).status !== 0 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'db-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const put = async (p, c) => { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); };
  git('init', '-q');
  await put('package.json', `${JSON.stringify({ name: 'a', dependencies: { pg: '8' } }, null, 2)}\n`);
  await put('src/legacy.ts', "import x from 'sqlite3';\n");
  await put('src/app.ts', "import pg from 'pg';\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  // This "cycle": a modified tracked file, a new untracked file, a dependency.
  await put('package.json', `${JSON.stringify({ name: 'a', dependencies: { pg: '8', 'better-sqlite3': '11' } }, null, 2)}\n`);
  await put('src/app.ts', "import pg from 'pg';\nconst m = await import('node:sqlite');\n");
  await put('src/new store.ts', "export * from '@libsql/client';\n");
  await put('src/legacy.ts', "import x from 'sqlite3';\nexport const y = 2;\n");
  await put('.env.example', 'DATABASE_URL=file:./dev.db\n');
  const script = buildChangedEngineReadScript({ appDir: dir });
  const containerSh = async (_name, s) => {
    const r = spawnSync('sh', ['-c', s], { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout };
  };
  const out = await containerSh('c', script);
  const files = parseChangedEngineRead(out.stdout);
  assert.deepEqual(files.map((f) => f.path).sort(), ['.env.example', 'package.json', 'src/app.ts', 'src/legacy.ts', 'src/new store.ts']);
  const hits = introducedEngineHits({ files });
  assert.deepEqual(hits.map((h) => `${h.path}${h.line ? `:${h.line}` : ''} ${h.name}`).sort(), [
    '.env.example:1 DATABASE_URL', 'package.json better-sqlite3', 'src/app.ts:2 node:sqlite', 'src/new store.ts:1 @libsql/client',
  ], 'the legacy sqlite3 import was already at HEAD — the gate owns it, not the finish guard');

  // The I/O wrapper: the exception comes from mock2.db, and a read error fails open.
  freshDb();
  assert.equal((await store.readIntroducedDatabaseEngines({ containerSh, containerName: 'c', appDir: dir, projectId: 3 })).length, 4);
  store.setDatabaseException(3, { engine: 'sqlite', request_text: REQUEST }, 'ann');
  assert.deepEqual(await store.readIntroducedDatabaseEngines({ containerSh, containerName: 'c', appDir: dir, projectId: 3 }), []);
  assert.deepEqual(await store.readIntroducedDatabaseEngines({ containerSh: async () => { throw new Error('incus down'); }, containerName: 'c', appDir: dir, projectId: 4 }), []);
});

// ---- the routes ----

function routeFixture({ project = { id: 5, lifecycle: 'active' } } = {}) {
  freshDb();
  const routes = new Map();
  const router = Object.fromEntries(['get', 'put', 'delete'].map((m) => [m, (path, ...handlers) => routes.set(`${m} ${path}`, handlers)]));
  const roles = {};
  const requireRole = (role) => { const fn = (req, _res, next) => { req.mock2Project = project; req.mock2Access = { actingAsAdmin: false }; next(); }; roles[role] = fn; fn.role = role; return fn; };
  const refuseIfArchived = (_req, _res, next) => next();
  const requireSudo = (_req, _res, next) => next();
  const audits = [];
  registerDatabaseExceptionRoutes(router, {
    requireRole, refuseIfArchived, requireSudo,
    audit: (...a) => audits.push(a),
    store: { get: store.getDatabaseException, set: store.setDatabaseException, clear: store.clearDatabaseException },
  });
  async function call(method, body) {
    const handlers = routes.get(`${method} /projects/:id/database-exception`);
    let status = 200; let json;
    const req = { params: { id: String(project.id) }, body, user: { id: 9, username: 'ann' }, ip: '10.0.0.9' };
    const res = { status(c) { status = c; return this; }, json(v) { json = v; return this; } };
    for (const h of handlers.slice(0, -1)) await new Promise((resolve) => h(req, res, resolve));
    await handlers.at(-1)(req, res);
    return { status, body: json };
  }
  return { routes, call, audits, refuseIfArchived, requireSudo };
}

test('routes: viewer reads; editor + sudo records and clears; recording also refuses an archived project', () => {
  assert.throws(() => registerDatabaseExceptionRoutes({ get() {}, put() {}, delete() {} }, {}), /dependency is required/);
  const f = routeFixture();
  assert.deepEqual([...f.routes.keys()].sort(), ['delete /projects/:id/database-exception', 'get /projects/:id/database-exception', 'put /projects/:id/database-exception']);
  const chain = (k) => f.routes.get(k);
  assert.equal(chain('get /projects/:id/database-exception')[0].role, 'viewer');
  assert.ok(!chain('get /projects/:id/database-exception').includes(f.requireSudo));
  const put = chain('put /projects/:id/database-exception');
  assert.equal(put[0].role, 'editor');
  assert.ok(put.includes(f.refuseIfArchived) && put.includes(f.requireSudo));
  const del = chain('delete /projects/:id/database-exception');
  assert.equal(del[0].role, 'editor');
  assert.ok(del.includes(f.requireSudo));
});

test('routes: GET null → PUT records (audited, words kept) → GET shape → DELETE clears (audited) → DELETE again is a no-op', async () => {
  const f = routeFixture();
  assert.deepEqual((await f.call('get')).body, { exception: null });
  const bad = await f.call('put', { engine: 'sqlite', request_text: REQUEST });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'ACKNOWLEDGE_REQUIRED');
  assert.equal((await f.call('put', { engine: 'mysql', request_text: REQUEST, acknowledge: true })).status, 400);
  assert.equal(f.audits.length, 0, 'a refused write audits nothing');
  const ok = await f.call('put', { engine: 'sqlite', request_text: REQUEST, acknowledge: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body.exception), ['engine', 'request_text', 'recorded_by', 'created_at']);
  assert.equal(ok.body.exception.recorded_by, 'ann');
  assert.equal(ok.body.exception.request_text, REQUEST);
  assert.deepEqual(f.audits[0].slice(0, 4), [9, 'MOCK2_DATABASE_EXCEPTION_SET', 'mock2_project', 5]);
  assert.equal(f.audits[0][4].request_text, REQUEST);
  assert.equal(f.audits[0][4].replaced, false);
  assert.deepEqual((await f.call('get')).body, { exception: ok.body.exception });
  const cleared = await f.call('delete');
  assert.deepEqual(cleared.body, { exception: null, cleared: true });
  assert.deepEqual(f.audits[1].slice(0, 4), [9, 'MOCK2_DATABASE_EXCEPTION_CLEARED', 'mock2_project', 5]);
  assert.deepEqual((await f.call('delete')).body, { exception: null, cleared: false });
  assert.equal(f.audits.length, 2, 'clearing nothing audits nothing');
});

test('routes are mounted on the mock2 router with the project role check, sudo and the audit log', async () => {
  const src = await readFile(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  assert.match(src, /registerDatabaseExceptionRoutes\(router, \{\n\s+requireRole: requireMock2Role, refuseIfArchived, requireSudo, audit: logAudit,/);
});

// ---- no MCP tool can set it ----

test('ratchet: no MCP tool names, describes or reaches the database exception', async () => {
  for (const t of MCP_TOOLS) {
    const text = `${t.name} ${t.description || ''} ${JSON.stringify(t.inputSchema || t.input_schema || {})}`;
    assert.doesNotMatch(text, /database[_ -]?exception|mock2_database_exceptions/i, `MCP tool ${t.name}`);
  }
  const roots = ['../routes/mcp.js', '../routes/mcp-editor.js', '../routes/mcp-tools/', '../lib/mcp-logic.js', '../lib/mcp-ext/', '../lib/mcp-policy/'];
  const files = [];
  async function walk(url) {
    if (!url.pathname.endsWith('/')) { files.push(url); return; }
    for (const e of await readdir(url, { withFileTypes: true })) {
      await walk(new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, url));
    }
  }
  for (const r of roots) await walk(new URL(r, import.meta.url));
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    assert.doesNotMatch(src, /database-exception(?:-routes)?\.js|mock2_database_exceptions|setDatabaseException|MOCK2_DATABASE_EXCEPTION=/, f.pathname);
  }
});

// ---- the command policy (every lane) ----

test('refused database installs: npm / pnpm / yarn / bun, any spelling; removal and Postgres are fine', () => {
  for (const cmd of [
    'npm install better-sqlite3', 'npm i -D @types/better-sqlite3', 'npm add sqlite3@5.1.7', 'yarn add sqlite', 'pnpm add @libsql/client@^0.6',
    'bun add sql.js', 'bun i drizzle-orm better-sqlite3', 'npm install --save mysql2', 'npm i mongoose', 'npm install @electric-sql/pglite',
    'npm test && npm i prisma @prisma/client', 'cd server; pnpm install knex', 'npm i alias@npm:better-sqlite3@11',
  ]) {
    const r = foundationCommandPolicy(cmd);
    assert.equal(r.ok, false, cmd);
    assert.match(r.reason, /PostgreSQL \(with pgvector, from the application foundation\) is the only application database/);
    assert.ok(r.reason.includes(DATABASE_EXCEPTION_UI_PATH), 'says how to record an exception');
  }
  for (const cmd of ['npm install', 'npm ci', 'npm install pg drizzle-orm', 'npm uninstall better-sqlite3', 'npm rm sqlite3',
    'yarn add zod', 'echo "npm install sqlite3"', 'npm run sqlite:export', 'npm i ./local-sqlite-tool']) {
    assert.equal(foundationCommandPolicy(cmd).ok, true, cmd);
  }
  // The recorded request allows the SQLite family only.
  const ex = { engine: 'sqlite', request_text: REQUEST };
  assert.equal(foundationCommandPolicy('npm install better-sqlite3 @types/better-sqlite3', { databaseException: ex }).ok, true);
  assert.equal(foundationCommandPolicy('npm install mysql2', { databaseException: ex }).ok, false);
  assert.deepEqual(refusedDatabaseInstall('npm i sqlite3 mysql2', { databaseException: ex }).packages, ['mysql2 (MySQL)']);
});

test('the foundation stack: no volume removal, no teardown, no writes, no master key — in any lane', () => {
  for (const cmd of [
    'docker compose down -v', 'docker compose down --volumes', 'docker-compose down -v --remove-orphans', 'docker compose -f x.yml down -v',
    'docker volume rm mock2_pg_data', 'docker volume prune -f', 'docker system prune -af', 'docker container prune',
    'docker stop mock2-foundation-postgres-1', 'docker rm -f mock2-foundation-storage-1', 'docker kill mock2_foundation_embeddings_1',
    'docker stop $(docker ps -q)', 'docker compose -p mock2-foundation down', 'docker compose -p mock2-foundation rm -f storage',
    'cd /opt/mock2-foundation && docker compose down', 'docker compose -f /opt/mock2-foundation/compose.yaml stop',
    'rm -rf /opt/mock2-foundation', 'sed -i s/x/y/ /opt/mock2-foundation/compose.yaml', 'echo x >> /opt/mock2-foundation/compose.yaml',
    'cat /etc/mock2-foundation/master.key', 'cp /etc/mock2-foundation/master.key /tmp/k', 'ls /etc/mock2-foundation',
    'rm -rf /var/lib/docker/volumes/mock2_pg_data', 'rm /run/mock2-foundation/postgres/.s.PGSQL.5432',
  ]) {
    const r = foundationCommandPolicy(cmd);
    assert.equal(r.ok, false, cmd);
    assert.match(r.reason, /^refused: /);
  }
  for (const cmd of ['docker compose ps', 'docker ps', 'docker compose logs postgres', 'docker compose down', 'docker compose up -d',
    'cat /opt/mock2-foundation/compose.yaml', 'node foundation/bin/foundation.mjs health --json', 'psql "$DATABASE_URL" -c "select 1"']) {
    assert.equal(foundationCommandPolicy(cmd).ok, true, cmd);
  }
  // commandAllowed (run_terminal) carries it too, and keeps its old answers.
  assert.equal(commandAllowed('docker volume rm x').ok, false);
  assert.equal(commandAllowed('npm install better-sqlite3').ok, false);
  assert.equal(commandAllowed('npm install better-sqlite3', { databaseException: { engine: 'sqlite' } }).ok, true);
  assert.equal(commandAllowed('npm test').ok, true);
  assert.equal(commandAllowed('curl http://x').ok, false);
});

test('the SDK Bash guard denies through the foundation policy and honours the recorded exception', async () => {
  const events = [];
  const ctx = (databaseException) => ({ logEvent: (k, e) => events.push([k, e]), now: () => 'T', databaseException });
  const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const denied = await makePreToolUseGuard(ctx(null))(bash('npm install better-sqlite3'));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /installing better-sqlite3 \(SQLite\) is refused/);
  assert.equal(events.at(-1)[1].meta.reason, 'foundation_policy');
  assert.equal((await makePreToolUseGuard(ctx(null))(bash('docker compose down -v'))).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await makePreToolUseGuard(ctx({ engine: 'sqlite' }))(bash('npm install better-sqlite3')), {});
  assert.deepEqual(await makePreToolUseGuard(ctx(null))(bash('npm test')), {});
});

// ---- one rule, everywhere a builder reads instructions ----

test('ratchet: the database rule is in the seeded CLAUDE.md, AGENTS.md, copilot-instructions (Profile: cpr) and the MCP instructions', async () => {
  const files = Object.fromEntries(buildSeedFiles({ name: 'Demo App' }).map((f) => [f.path, f.content]));
  const claude = files['CLAUDE.md'];
  const stack = claude.slice(claude.indexOf('## Stack'), claude.indexOf('## Commands'));
  assert.ok(stack.includes(DATABASE_RULE), 'CLAUDE.md ## Stack');
  assert.doesNotMatch(claude, /Deviations from the default, with reason/, 'no invitation to pick another database here');
  assert.match(stack, /platform administrator/);
  const copilot = files['.github/copilot-instructions.md'];
  assert.match(copilot, /^Profile: cpr$/m, 'the PRO profile rules bind only a repo that records it');
  assert.ok(copilot.includes(DATABASE_RULE));
  assert.ok(files['AGENTS.md'].includes(DATABASE_RULE));
  assert.equal(files['AGENTS.md'], agentsMd({ name: 'Demo App' }));
  assert.ok(MCP_SERVER_INSTRUCTIONS.includes(DATABASE_RULE));
  assert.ok(MCP_SERVER_INSTRUCTIONS.indexOf(DATABASE_RULE) + DATABASE_RULE.length < 4000,
    'inside the first ~4 KB: some clients cut the server instructions off there');
  // continuity-convention imports nothing, so it writes the rule out — and it
  // must stay byte-identical to the one in database-exception-logic.js.
  const conv = await readFile(new URL('../mock2/continuity-convention.js', import.meta.url), 'utf8');
  assert.doesNotMatch(conv, /^\s*import\s/m);
  assert.ok(agentsMd(null).includes(`7. **One database.** ${DATABASE_RULE}`));
});

test('ratchet: the build prompt states the rule in every mode header, quotes a recorded request instead, and so does the plan', () => {
  for (const buildMode of ['quick', 'mvp', 'full']) {
    for (const harness of ['proxypilot', 'copilot']) {
      const p = buildRunnerSystemPrompt({ constitution: 'C', buildMode, harness });
      const at = p.indexOf(DATABASE_RULE);
      assert.ok(at > 0 && at < 4000, `${buildMode}/${harness}: the rule rides the mode header, near the top`);
      assert.ok(at < p.indexOf('# Organizational constitution'));
    }
  }
  const ex = { engine: 'sqlite', request_text: REQUEST, created_at: '2026-10-24T10:00:00.000Z' };
  const quoted = buildRunnerSystemPrompt({ constitution: 'C', buildMode: 'quick', databaseException: ex });
  assert.ok(quoted.includes(`The user explicitly asked for SQLite: "${REQUEST}" (recorded 2026-10-24).`));
  assert.ok(!quoted.includes(DATABASE_RULE), 'the quote replaces the rule line');
  assert.ok(buildRunnerClaudeMd({ constitution: 'C' }).includes(DATABASE_RULE));
  assert.ok(buildRunnerClaudeMd({ constitution: 'C', databaseException: ex }).includes('The user explicitly asked for SQLite: "'));
  assert.ok(BUILD_PLAN_SYSTEM_PROMPT.includes(DATABASE_RULE));
  // The quick lane no longer claims there is no battery: the database check runs there.
  assert.doesNotMatch(buildRunnerSystemPrompt({ buildMode: 'quick' }), /There is NO gate battery/);
  assert.match(buildRunnerSystemPrompt({ buildMode: 'quick' }), /constitution-lint, the database check/);
});
