// The app-side foundation module (scaffold-foundation.js) — generator output,
// byte-compatibility of the sealed-secret format with the host contract, the
// contract values the app carries, the scaffold/upgrade wiring, and the
// failure paths that need no Docker (an unreachable database is an explicit
// error after a short retry window, never a silent fallback).
//
// The real-stack proof (pgvector, two S3 servers, fake embedding providers)
// is scaffold-foundation.docker.test.js (FOUNDATION_E2E=1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildFoundationFiles, FOUNDATION_DEPENDENCIES, FOUNDATION_OPTIONAL_DEPENDENCIES,
  FOUNDATION_NODE_IMPORT, FOUNDATION_PACKAGE_IMPORTS, FOUNDATION_BOOTSTRAP, SELF_RETRIEVAL,
} from '../mock2/scaffold-foundation.js';
import { buildFoundationComposeYaml } from '../mock2/foundation-stack-logic.js';
import * as contract from '../mock2/foundation-contract.js';
import {
  buildScaffoldFiles, SCAFFOLD_DEPENDENCIES, MOCK2_SCAFFOLD_VERSION, scaffoldFoundationFiles,
} from '../mock2/scaffold.js';
import { buildSeedFiles } from '../mock2/template.js';
import {
  planBaseAppUpgrade, isPlatformOwnedPath, FOUNDATION_MARKER, PLATFORM_OWNED_ALWAYS, upgradeSummary,
} from '../mock2/base-app-upgrade-logic.js';
import { currentPlatformFiles } from '../mock2/base-app-upgrade.js';
import { buildPlatformRoutes, buildPlatformFiles, PLATFORM_MODULE_VERSION } from '../mock2/scaffold-platform.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const compose = () => buildFoundationComposeYaml({ portable: true });
const files = () => buildFoundationFiles({ composeYaml: compose() });
const byPath = (list) => new Map(list.map((f) => [f.path, f]));
// The portable stack mounts its Postgres files from beside compose.yaml, so the
// scaffold ships them under foundation/ too (foundation-stack-logic.js).
const STACK_FILES = Object.freeze([
  'foundation/postgres/entrypoint.sh', 'foundation/postgres/initdb/01-mock2-foundation.sql',
  'foundation/postgres/initdb/99-mock2-seal.sh', 'foundation/postgres/pg_hba.conf', 'foundation/postgres/pg_ident.conf',
]);

// Write the generated foundation/ into a temp dir. With node_modules, link the
// backend's (it carries pg and the AWS SDK) so the runtime can be imported.
function materialize({ withNodeModules = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-foundation-'));
  for (const f of files()) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content, { mode: f.mode || 0o644 });
  }
  if (withNodeModules) fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function closedPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const EXPECTED = [
  'foundation/README.md',
  'foundation/compose.yaml',
  'foundation/index.mjs', 'foundation/index.d.mts',
  'foundation/bin/foundation.mjs',
  ...['contract', 'errors', 'seal', 'config', 'bootstrap', 'storage', 'embeddings', 'vector', 'health', 'jobs']
    .flatMap((m) => [`foundation/runtime/${m}.mjs`, `foundation/runtime/${m}.d.mts`]),
];

// ---------------------------------------------------------------------------
// Generator output
// ---------------------------------------------------------------------------

test('buildFoundationFiles needs the portable compose stack as an explicit input', () => {
  assert.throws(() => buildFoundationFiles(), /composeYaml/);
  assert.throws(() => buildFoundationFiles({ composeYaml: '  ' }), /composeYaml/);
  const out = byPath(buildFoundationFiles({ composeYaml: 'services: {}' }));
  assert.equal(out.get('foundation/compose.yaml').content, 'services: {}\n');
});

test('every foundation file is generated, each runtime module has its declarations, the CLI is executable', () => {
  const out = byPath(files());
  assert.deepEqual([...out.keys()].sort(), [...EXPECTED].sort());
  for (const p of out.keys()) {
    if (p.endsWith('.mjs')) assert.ok(out.has(p.replace(/\.mjs$/, '.d.mts')) || p === contract.FOUNDATION_CLI, `${p} has no .d.mts`);
  }
  assert.equal(out.get(contract.FOUNDATION_CLI).mode, 0o755);
  assert.match(out.get(contract.FOUNDATION_CLI).content, /^#!\/usr\/bin\/env node\n/);
  assert.equal(FOUNDATION_BOOTSTRAP, 'foundation/runtime/bootstrap.mjs');
  assert.ok(out.has(FOUNDATION_BOOTSTRAP));
});

test('every generated .mjs parses (node --check)', () => {
  const dir = materialize();
  try {
    for (const p of EXPECTED.filter((x) => x.endsWith('.mjs'))) {
      const r = spawnSync(process.execPath, ['--check', path.join(dir, p)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${p}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function specifiers(src) {
  const out = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)import\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

test('every import in the generated runtime resolves: relative ones to generated files, bare ones to declared dependencies', () => {
  const out = byPath(files());
  const declared = new Set(['pg', ...Object.keys(FOUNDATION_DEPENDENCIES), ...FOUNDATION_OPTIONAL_DEPENDENCIES]);
  for (const [p, f] of out) {
    if (!/\.(mjs|d\.mts)$/.test(p)) continue;
    for (const spec of specifiers(f.content)) {
      if (spec.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(p), spec));
        assert.match(spec, /\.mjs$/, `${p}: relative import ${spec} must carry its .mjs extension`);
        assert.ok(out.has(target), `${p}: ${spec} → ${target} is not generated`);
        if (p.endsWith('.d.mts')) assert.ok(out.has(target.replace(/\.mjs$/, '.d.mts')), `${p}: ${spec} has no declarations`);
      } else if (spec.startsWith('node:')) {
        // builtin
      } else {
        assert.ok(declared.has(spec), `${p}: imports ${spec}, which the scaffold does not declare`);
      }
    }
  }
  // The scaffold's package.json carries the runtime's dependencies.
  const pkg = JSON.parse(byPath(buildScaffoldFiles({ name: 'x' })).get('package.json').content);
  for (const dep of ['pg', ...Object.keys(FOUNDATION_DEPENDENCIES)]) assert.ok(pkg.dependencies[dep], `package.json lacks ${dep}`);
});

test('the generated foundation carries no secret values and no password-in-URL defaults', () => {
  for (const f of files()) {
    assert.doesNotMatch(f.content, /app:app@/, `${f.path} has a password-in-URL default`);
    assert.doesNotMatch(f.content, /AKIA[0-9A-Z]{16}/, `${f.path} has an access key`);
    assert.doesNotMatch(f.content, /BEGIN [A-Z ]*PRIVATE KEY/, `${f.path} has a private key`);
    assert.doesNotMatch(f.content, /password\s*[:=]\s*['"][^'"]+['"]/i, `${f.path} has a literal password`);
    assert.doesNotMatch(f.content, /(?:secretAccessKey|accessKeyId|api_?key)\s*:\s*['"][^'"]+['"]/i, `${f.path} has a literal credential`);
  }
  // The URL the runtime defaults to is the contract's socket URL (no password).
  const contractMjs = byPath(files()).get('foundation/runtime/contract.mjs').content;
  assert.ok(contractMjs.includes(JSON.stringify(contract.FOUNDATION_DATABASE_URL)));
  assert.doesNotMatch(contract.FOUNDATION_DATABASE_URL, /:[^/]*@/);
});

test('the README states the adapter-only rule and the missing-master-key behaviour', () => {
  const readme = byPath(files()).get('foundation/README.md').content;
  assert.match(readme, /Feature code uses these adapters only — never an S3 SDK or an embedding API\s+directly/);
  assert.match(readme, /If the master key file is missing/);
  assert.match(readme, /MISSING_MASTER_KEY/);
  assert.match(readme, /Running outside ProxyPilot/);
  assert.ok(readme.includes(contract.LOCAL_EMBEDDINGS_WARNING));
});

// ---------------------------------------------------------------------------
// The contract the app carries
// ---------------------------------------------------------------------------

test('contract.mjs carries exactly the host contract values and helpers', async () => {
  const dir = materialize();
  try {
    const app = await import(pathToFileURL(path.join(dir, 'foundation/runtime/contract.mjs')).href);
    for (const name of [
      'FOUNDATION_VERSION', 'FEATURES', 'FEATURE_STATES', 'STORAGE_PROVIDERS', 'EMBEDDING_PROVIDERS',
      'STORAGE_SWITCH_MODES', 'VECTOR_METRICS', 'HEALTH_STATUSES', 'STACK', 'FOUNDATION_DATABASE_URL',
      'LOCAL_EMBEDDINGS_WARNING', 'DEPENDENT_CAPABILITIES', 'SECRET_NAMES', 'HOST_ONLY_SECRETS',
      'FOUNDATION_NOTIFY_CHANNEL', 'FOUNDATION_CLI', 'FOUNDATION_CLI_COMMANDS',
    ]) {
      assert.deepEqual(app[name], contract[name], name);
    }
    assert.equal(app.VECTOR_INDEX_ID_RE.source, contract.VECTOR_INDEX_ID_RE.source);
    assert.ok(Object.isFrozen(app.STACK.postgres), 'contract values are frozen');
    for (const d of [1, 2, 384, 1024, 1536, 2000, 2001, 3072, 4000, 4001, 8192, 16000]) {
      assert.deepEqual(app.vectorColumnPlan(d), contract.vectorColumnPlan(d), `plan(${d})`);
    }
    for (const d of [0, -1, 1.5, 16001, 'x', null]) {
      assert.throws(() => app.vectorColumnPlan(d));
      assert.throws(() => contract.vectorColumnPlan(d));
    }
    for (const id of ['ix_1', 'a', 'x'.repeat(40)]) assert.equal(app.vectorTableName(id), contract.vectorTableName(id));
    for (const id of ['', 'A', 'x'.repeat(41), 'a-b', 'a;drop']) assert.throws(() => app.vectorTableName(id));
    assert.equal(app.componentSecretName('SESSION_SECRET'), contract.componentSecretName('SESSION_SECRET'));
    assert.equal(app.pendingSecretName('embeddings.api_key'), contract.pendingSecretName('embeddings.api_key'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seal.mjs is byte-compatible with the contract: sealed by either side, opened by the other', async () => {
  const dir = materialize();
  try {
    const app = await import(pathToFileURL(path.join(dir, 'foundation/runtime/seal.mjs')).href);
    const key = contract.generateMasterKey();
    const values = ['', 'plain', 'üñíçødé ✓ 秘密', 'x'.repeat(10000), 'with:colons:and\nnewlines'];
    for (const name of ['storage.access_key_id', 'embeddings.api_key', 'component.SESSION_SECRET', 'pending.storage.secret_access_key']) {
      for (const v of values) {
        const hostSealed = contract.sealForApp(key, name, v);
        assert.match(hostSealed, /^mfs1:[\w-]+:[\w-]+:[\w-]*$/);
        assert.equal(app.openForApp(key, name, hostSealed), v, `host → app ${name}`);
        const appSealed = app.sealForApp(key, name, v);
        assert.equal(contract.openForApp(key, name, appSealed), v, `app → host ${name}`);
      }
    }
    // The name is the AAD: a sealed value cannot be moved to another name.
    const sealed = contract.sealForApp(key, 'storage.access_key_id', 'AK');
    assert.throws(() => app.openForApp(key, 'storage.secret_access_key', sealed));
    // A different master key cannot open it; a tampered value is refused.
    assert.throws(() => app.openForApp(contract.generateMasterKey(), 'storage.access_key_id', sealed));
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    assert.throws(() => app.openForApp(key, 'storage.access_key_id', tampered));
    assert.throws(() => app.openForApp(key, 'storage.access_key_id', 'plain'), /not a sealed/);
    assert.throws(() => app.openForApp('c2hvcnQ=', 'storage.access_key_id', sealed), /32 bytes/);
    // The same names are valid on both sides.
    for (const n of [
      'master_key', 'storage.access_key_id', 'storage.secret_access_key', 'storage.admin_access_key_id',
      'storage.admin_secret_access_key', 'embeddings.api_key', 'pending.storage.access_key_id',
      'pending.embeddings.api_key', 'component.SESSION_SECRET', 'component.A', `component.A${'B'.repeat(63)}`,
      'component.a', 'component.', 'pending.master_key', 'storage.other', '', 'component.1A', `component.A${'B'.repeat(64)}`,
    ]) {
      assert.equal(app.isValidSecretName(n), contract.isValidSecretName(n), n);
    }
    assert.throws(() => app.sealForApp(key, 'not.a.name', 'v'), /invalid foundation secret name/);
    assert.equal(app.parseMasterKey(`${key}\n`), key);
    assert.equal(app.parseMasterKey('c2hvcnQ='), null);
    assert.equal(app.parseMasterKey(''), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the generated re-embed validation bar is the exported one', () => {
  const jobs = byPath(files()).get('foundation/runtime/jobs.mjs').content;
  assert.ok(jobs.includes(`export const SELF_RETRIEVAL = Object.freeze(${JSON.stringify(SELF_RETRIEVAL)});`));
  assert.ok(SELF_RETRIEVAL.threshold >= 0.8 && SELF_RETRIEVAL.threshold < 1);
});

test('storage_migrate change detection: a same-size overwrite changes the source fingerprint (ETag, Last-Modified), an unchanged listing does not', async () => {
  const dir = materialize({ withNodeModules: true });
  try {
    const jobs = await import(pathToFileURL(path.join(dir, 'foundation/runtime/jobs.mjs')).href);
    const listed = { key: 'a.bin', size: 4096, etag: '"0cc175b9c0f1b6a831c399e269772661"', lastModified: '2026-10-25T10:00:00.000Z' };
    const fp = jobs.sourceFingerprint(listed);
    assert.equal(jobs.sourceFingerprint({ ...listed }), fp, 'the same listing gives the same fingerprint');
    assert.equal(jobs.sourceFingerprint({ ...listed, etag: '0cc175b9c0f1b6a831c399e269772661' }), fp, 'quotes are not a change');
    assert.equal(jobs.sourceFingerprint({ ...listed, etag: 'W/"0cc175b9c0f1b6a831c399e269772661"' }), fp, 'a weak marker is not a change');
    assert.equal(jobs.sourceFingerprint({ ...listed, lastModified: '2026-10-25T10:00:00.700Z' }), fp, 'Last-Modified counts to the second');
    assert.notEqual(jobs.sourceFingerprint({ ...listed, etag: '"92eb5ffee6ae2fec3ad71c777531578f"' }), fp, 'same size, other content (ETag)');
    assert.notEqual(jobs.sourceFingerprint({ ...listed, lastModified: '2026-10-25T10:00:01.000Z' }), fp, 'same size and ETag, rewritten later');
    assert.notEqual(jobs.sourceFingerprint({ ...listed, size: 4097 }), fp);
    assert.match(jobs.keySha256('ünïcode name.txt'), /^[0-9a-f]{64}$/);
    assert.equal(jobs.keySha256('k'), crypto.createHash('sha256').update('k', 'utf8').digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('storage_migrate never deletes from the SOURCE: its one delete is on the pending target, behind a guard', () => {
  const jobs = byPath(files()).get('foundation/runtime/jobs.mjs').content;
  const deletes = (jobs.match(/\b[A-Za-z_.]+\.delete\(/g) || []).filter((d) => d !== 'ctx.transfers.delete(');
  assert.deepEqual(deletes, ['target.delete('], 'the only storage delete in jobs.mjs');
  assert.match(jobs, /async function deleteFromTarget\(target, key\) \{\n {2}if \(!target \|\| target\.pending !== true\)/);
  assert.doesNotMatch(jobs, /source\.(?:delete|put)\(/);
});

test('health: the pending storage probe counts the objects under bucket + prefix (probe keys left out, every page), or omits the count', async () => {
  const dir = materialize({ withNodeModules: true });
  try {
    const health = await import(pathToFileURL(path.join(dir, 'foundation/runtime/health.mjs')).href);
    const keys = ['a', 'b/c', '.mock2-health/0b1e', 'd', '.mock2-health/x', 'e.mock2-health/kept'];
    let pages = 0;
    const paged = { async *listAll() { for (const key of keys) { if (key === 'd') pages += 1; yield { key, size: 1 }; } } };
    assert.equal(await health.countObjects(paged), 4);
    assert.equal(pages, 1);
    const broken = { async *listAll() { yield { key: 'a' }; throw new Error('listing failed'); } };
    assert.equal(await health.countObjects(broken), null, 'a failed listing is no count, never a guess');
    const jobs = byPath(files()).get('foundation/runtime/jobs.mjs').content;
    assert.match(jobs, /const items = page\.items\.filter\(\(i\) => !i\.key\.startsWith\(PROBE_PREFIX\)\);/, 'the copy job skips the probe keys it is compared without');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The runtime without Docker: configuration helpers and the failure paths
// ---------------------------------------------------------------------------

test('config.mjs: database description never shows a password; config redaction; an explicit DATABASE_URL wins', async () => {
  const dir = materialize({ withNodeModules: true });
  const saved = process.env.DATABASE_URL;
  try {
    const cfg = await import(pathToFileURL(path.join(dir, 'foundation/runtime/config.mjs')).href);
    assert.equal(cfg.describeDatabase(contract.FOUNDATION_DATABASE_URL), `socket ${contract.STACK.postgres.socketDir}, database app, user app`);
    assert.equal(cfg.describeDatabase('postgres://app:hunter2@db.internal:6543/appdb'), 'db.internal:6543, database appdb, user app');
    assert.doesNotMatch(cfg.describeDatabase('postgres://app:hunter2@db.internal:6543/appdb'), /hunter2/);
    assert.equal(cfg.describeDatabase('not a url'), 'an unparseable DATABASE_URL');
    delete process.env.DATABASE_URL;
    assert.equal(cfg.databaseUrl(), contract.FOUNDATION_DATABASE_URL);
    process.env.DATABASE_URL = 'postgres://app@127.0.0.1:1/e2e';
    assert.equal(cfg.databaseUrl(), 'postgres://app@127.0.0.1:1/e2e');
    assert.deepEqual(
      cfg.redactConfig({ endpoint: 'https://user:pw@s3.example.com/x', bucket: 'b', api_key: 'sk-1', nested: { secretKey: 'x', ok: 1 }, list: [{ token: 't' }] }),
      { endpoint: 'https://s3.example.com/x', bucket: 'b', api_key: '[redacted]', nested: { secretKey: '[redacted]', ok: 1 }, list: [{ token: '[redacted]' }] },
    );
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreachable database is an explicit error naming the target after the retry window — never a fallback', async () => {
  const dir = materialize({ withNodeModules: true });
  try {
    const cfg = await import(pathToFileURL(path.join(dir, 'foundation/runtime/config.mjs')).href);
    const errors = await import(pathToFileURL(path.join(dir, 'foundation/runtime/errors.mjs')).href);
    const port = await closedPort();
    const started = Date.now();
    const logs = [];
    await assert.rejects(
      cfg.connectWithRetry({ url: `postgres://app@127.0.0.1:${port}/app`, retryMs: 900, log: (m) => logs.push(m) }),
      (err) => {
        assert.ok(err instanceof errors.FoundationDatabaseError);
        assert.equal(err.code, 'DATABASE_UNREACHABLE');
        assert.match(err.message, new RegExp(`127\\.0\\.0\\.1:${port}, database app, user app`));
        assert.match(err.message, /never falls back to another database/);
        assert.ok(err.detail.attempts >= 2, `retried (${err.detail.attempts} attempts)`);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 400 && elapsed < 5000, `gave up after the window (${elapsed} ms)`);
    assert.match(logs[0], /waiting for the database/);
    // The default URL is the socket, and the error names the socket.
    await assert.rejects(
      cfg.connectWithRetry({ url: 'postgres:///app?host=/nonexistent/mock2-socket&user=app', retryMs: 0, log: () => {} }),
      /socket \/nonexistent\/mock2-socket, database app, user app/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A stand-in `pg` for the runtime's state reads (features, secrets, meta):
// rows come from globalThis.__fakeFoundationDb, so the key rules below run
// without a database.
function fakePg(dir) {
  const pkg = path.join(dir, 'node_modules', 'pg');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'pg', version: '0.0.0-test', main: 'index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), `
const answer = async (sql) => {
  const w = globalThis.__fakeFoundationDb || {};
  if (/FROM mock2_foundation\\.features/.test(sql)) return { rows: w.features || [] };
  if (/FROM mock2_foundation\\.secrets/.test(sql)) return { rows: w.secrets || [] };
  return { rows: [] };
};
class Client { on() {} removeListener() {} async connect() {} async end() {} query(sql) { return answer(sql); } escapeIdentifier(s) { return '"' + s + '"'; } }
class Pool { on() {} query(sql) { return answer(sql); } async connect() { return Object.assign(new Client(), { release() {} }); } async end() {} }
module.exports = { Client, Pool };
`);
}

test('embeddings: an OpenAI-compatible provider is asked without a key unless one is stored; OpenAI always needs one', async () => {
  // The host allows a key-less OpenAI-compatible provider (credentialsRequired:
  // openai only); the app used to refuse it as MISSING_CREDENTIALS, so the
  // switch could never pass its pending test (found by foundation-e2e).
  const dir = materialize();
  fakePg(dir);
  const keyFile = path.join(dir, 'master.key');
  const masterKey = contract.generateMasterKey();
  fs.writeFileSync(keyFile, `${masterKey}\n`, { mode: 0o600 });
  const saved = { url: process.env.DATABASE_URL, key: process.env.FOUNDATION_KEY_FILE };
  process.env.DATABASE_URL = 'postgres:///app?host=/nonexistent&user=app';
  process.env.FOUNDATION_KEY_FILE = keyFile;
  const row = (provider, extra = {}) => ({ feature: 'embeddings', state: 'on', provider, config: { base_url: 'http://127.0.0.1:1/v1', model: 'm', dimensions: 8 }, pending: null, generation: 1, ...extra });
  const sealed = (name, value) => ({ name, sealed: contract.sealForApp(masterKey, name, value), generation: 1 });
  try {
    const cfg = await import(pathToFileURL(path.join(dir, 'foundation/runtime/config.mjs')).href);
    const emb = await import(pathToFileURL(path.join(dir, 'foundation/runtime/embeddings.mjs')).href);
    const set = async (w) => { globalThis.__fakeFoundationDb = w; await cfg.reloadFoundation(); };
    await set({ features: [row('openai_compatible')], secrets: [] });
    assert.equal((await emb.resolveEmbeddingsConfig()).apiKey, null, 'no key stored: asked without one');
    await set({ features: [row('openai_compatible')], secrets: [sealed('embeddings.api_key', 'k-stored-1')] });
    assert.equal((await emb.resolveEmbeddingsConfig()).apiKey, 'k-stored-1', 'a stored key is sent');
    await set({ features: [row('openai_compatible', { pending: { provider: 'openai_compatible', config: { base_url: 'http://127.0.0.1:2/v1', model: 'n', dimensions: 4 } } })], secrets: [sealed('embeddings.api_key', 'k-active')] });
    assert.equal((await emb.resolveEmbeddingsConfig({ pending: true })).apiKey, null, 'the pending provider never borrows the active key');
    await set({ features: [row('openai')], secrets: [] });
    await assert.rejects(emb.resolveEmbeddingsConfig(), (e) => e.code === 'MISSING_CREDENTIALS');
    await set({ features: [row('openai')], secrets: [sealed('embeddings.api_key', 'sk-openai-1')] });
    assert.equal((await emb.resolveEmbeddingsConfig()).apiKey, 'sk-openai-1');
    // A stored key that cannot be opened is reported, not silently dropped.
    process.env.FOUNDATION_KEY_FILE = path.join(dir, 'missing.key');
    await set({ features: [row('openai_compatible')], secrets: [sealed('embeddings.api_key', 'k-stored-1')] });
    await assert.rejects(emb.resolveEmbeddingsConfig(), (e) => e.code === 'MISSING_MASTER_KEY');
    await set({ features: [row('openai_compatible')], secrets: [] });
    assert.equal((await emb.resolveEmbeddingsConfig()).apiKey, null, 'no key to open: no master key needed');
  } finally {
    delete globalThis.__fakeFoundationDb;
    for (const [k, v] of [['DATABASE_URL', saved.url], ['FOUNDATION_KEY_FILE', saved.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(dir, args, env) {
  return spawnSync(process.execPath, [path.join(dir, contract.FOUNDATION_CLI), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env },
  });
}

test('the CLI: exit codes 0/1/2, JSON errors, usage, and an unreachable database reported (never hidden)', async () => {
  const dir = materialize({ withNodeModules: true });
  try {
    const port = await closedPort();
    const env = { DATABASE_URL: `postgres://app@127.0.0.1:${port}/app`, FOUNDATION_DB_RETRY_MS: '300' };
    const health = runCli(dir, ['health', '--json'], env);
    assert.equal(health.status, 2, health.stderr);
    const h = JSON.parse(health.stdout);
    assert.equal(h.ok, false);
    assert.deepEqual(h.components.map((c) => [c.component, c.status]), [['database', 'unavailable'], ['storage', 'unavailable'], ['embeddings', 'unavailable']]);
    assert.match(h.components[0].detail.message, new RegExp(`127\\.0\\.0\\.1:${port}`));

    const cfg = runCli(dir, ['config', '--json'], env);
    assert.equal(cfg.status, 1);
    assert.equal(JSON.parse(cfg.stdout).code, 'DATABASE_UNREACHABLE');

    const st = runCli(dir, ['storage-test', '--pending', '--json'], env);
    assert.equal(st.status, 2);

    const bad = runCli(dir, ['frobnicate'], env);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown command frobnicate/);
    assert.match(bad.stderr, /usage: node foundation\/bin\/foundation\.mjs/);

    const opt = runCli(dir, ['health', '--nope', '--json'], env);
    assert.equal(opt.status, 1);
    assert.equal(JSON.parse(opt.stdout).code, 'USAGE');

    const noId = runCli(dir, ['job-run', '--json'], env);
    assert.equal(noId.status, 1);
    assert.match(JSON.parse(noId.stdout).message, /needs a job id/);

    const help = runCli(dir, ['--help'], env);
    assert.equal(help.status, 0);
    for (const c of contract.FOUNDATION_CLI_COMMANDS) assert.match(help.stdout, new RegExp(`\\b${c}\\b`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the bootstrap fails loudly (non-zero exit, the target named) when the database never comes up', async () => {
  const dir = materialize({ withNodeModules: true });
  try {
    const port = await closedPort();
    fs.writeFileSync(path.join(dir, 'entry.mjs'), "console.log('ENTRY RAN');\n");
    const r = spawnSync(process.execPath, [`--import=./${FOUNDATION_BOOTSTRAP}`, 'entry.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, DATABASE_URL: `postgres://app@127.0.0.1:${port}/app`, FOUNDATION_DB_RETRY_MS: '300' },
    });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /ENTRY RAN/, 'the app entry never runs without the foundation');
    assert.match(r.stderr, /FoundationDatabaseError/);
    assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${port}, database app`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scaffold wiring
// ---------------------------------------------------------------------------

test('the scaffold ships the foundation, runs every entry with the bootstrap first, and imports it as #foundation', () => {
  assert.equal(MOCK2_SCAFFOLD_VERSION, 'mock2-ts-express-drizzle-v8');
  const out = byPath(buildScaffoldFiles({ name: 'Demo' }));
  for (const p of EXPECTED) assert.ok(out.has(p), `scaffold lacks ${p}`);
  assert.deepEqual(scaffoldFoundationFiles().map((f) => f.path).sort(), [...EXPECTED, ...STACK_FILES].sort());
  const pkg = JSON.parse(out.get('package.json').content);
  assert.equal(FOUNDATION_NODE_IMPORT, '--import=./foundation/runtime/bootstrap.mjs');
  assert.equal(pkg.scripts.start, `node ${FOUNDATION_NODE_IMPORT} dist/server.js`);
  assert.equal(pkg.scripts.dev, `tsx watch ${FOUNDATION_NODE_IMPORT} src/server.ts`);
  assert.equal(pkg.scripts.foundation, `node ${contract.FOUNDATION_CLI}`);
  assert.deepEqual(pkg.imports, FOUNDATION_PACKAGE_IMPORTS);
  for (const [dep, v] of Object.entries(FOUNDATION_DEPENDENCIES)) {
    assert.equal(pkg.dependencies[dep], v);
    assert.match(v, /^\^3\.\d+\.\d+$/);
    // Not in the repair set the runner restores into EVERY project (including
    // the ones that predate the foundation).
    assert.equal(SCAFFOLD_DEPENDENCIES.dependencies[dep], undefined);
  }
});

test('the database defaults to the foundation socket (no password) and a failed connection is explicit', () => {
  const out = byPath(buildScaffoldFiles({ name: 'Demo' }));
  const cfg = out.get('src/config.ts').content;
  assert.ok(cfg.includes(`DATABASE_URL: z.string().default('${contract.FOUNDATION_DATABASE_URL}')`));
  const db = out.get('src/db/index.ts').content;
  assert.match(db, /class ExplicitClient extends pg\.Client/);
  assert.match(db, /new pg\.Pool\(\{ connectionString: config\.DATABASE_URL, Client: ExplicitClient \}\)/);
  assert.match(db, /Cannot connect to the application database/);
  const migrate = out.get('scripts/migrate.mjs').content;
  assert.match(migrate, /import \{ connectWithRetry, databaseUrl, retryWindowMs \} from '\.\.\/foundation\/runtime\/config\.mjs'/);
  assert.match(migrate, /nothing was applied/);
  const seed = byPath(buildSeedFiles({ name: 'Demo' }));
  const env = seed.get('.env.example').content;
  assert.ok(env.includes(`DATABASE_URL=${contract.FOUNDATION_DATABASE_URL}`));
  assert.match(env, /holds NO password/);
  for (const [p, content] of [['src/config.ts', cfg], ['src/db/index.ts', db], ['scripts/migrate.mjs', migrate], ['.env.example', env]]) {
    assert.doesNotMatch(content, /app:app@/, `${p} still defaults to a password-in-URL`);
  }
  assert.match(seed.get('README.md').content, /foundation\/README\.md/);
});

test('the platform module serves the admin-only foundation health route and stays inert without the foundation', () => {
  const routes = buildPlatformRoutes()[0].content;
  assert.equal(PLATFORM_MODULE_VERSION, 'mock2-platform-v12');
  assert.match(routes, /platformRoutes\.get\('\/api\/foundation\/health', requireRole\('admin'\)/);
  assert.match(routes, /new URL\('\.\.\/\.\.\/foundation\/runtime\/health\.mjs', import\.meta\.url\)/);
  assert.match(routes, /FOUNDATION_NOT_INSTALLED/);
  // Loaded by URL (no static import), so a project without foundation/ compiles.
  assert.doesNotMatch(routes, /from '\.\.\/\.\.\/foundation/);
  const admin = buildPlatformFiles().find((f) => f.path === 'public/platform-admin.js').content;
  assert.match(admin, /fetch\('\/api\/foundation\/health'/);
  assert.match(admin, /Foundation services/);
});

// ---------------------------------------------------------------------------
// Base-app upgrade: platform-owned as a group, only where it already exists
// ---------------------------------------------------------------------------

test('the base-app upgrade refreshes foundation/ only in projects that already have it', () => {
  const candidates = currentPlatformFiles({ name: 'Demo' });
  const foundationPaths = candidates.filter((f) => f.path.startsWith('foundation/')).map((f) => f.path).sort();
  assert.deepEqual(foundationPaths, [...EXPECTED, ...STACK_FILES].sort());
  for (const p of foundationPaths) assert.ok(isPlatformOwnedPath(p), p);
  assert.equal(isPlatformOwnedPath('foundation/../src/app.ts'), false);
  assert.equal(isPlatformOwnedPath('src/app.ts'), false);

  const base = { installed: null, currentScaffoldVersion: MOCK2_SCAFFOLD_VERSION, currentPlatformVersion: PLATFORM_MODULE_VERSION, candidates };
  const legacy = planBaseAppUpgrade({ ...base, present: PLATFORM_OWNED_ALWAYS });
  assert.equal(legacy.paths.filter((p) => p.startsWith('foundation/')).length, 0, 'a pre-foundation project never gets foundation/');
  assert.doesNotMatch(upgradeSummary(legacy), /foundation runtime/);

  // Marker present: EVERY foundation file is written, including ones the
  // project does not have yet (a newer foundation may add a module).
  const modern = planBaseAppUpgrade({ ...base, present: [...PLATFORM_OWNED_ALWAYS, FOUNDATION_MARKER] });
  assert.deepEqual(modern.paths.filter((p) => p.startsWith('foundation/')).sort(), [...EXPECTED, ...STACK_FILES].sort());
  assert.match(upgradeSummary(modern), /foundation runtime in foundation\//);
});
