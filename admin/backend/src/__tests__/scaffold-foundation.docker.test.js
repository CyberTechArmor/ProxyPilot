// The generated app-side foundation against a REAL stack (FOUNDATION_E2E=1).
//
// What runs: the generated foundation/ (written to a temp dir, its own
// dependencies installed from the npm registry), a pgvector Postgres
// (pgvector/pgvector:0.8.7-pg18), two SeaweedFS S3 servers (chrislusf/
// seaweedfs:4.48 — "bundled" and "external", each with an app identity and an
// admin identity, anonymous access refused), and two in-process
// OpenAI-compatible embedding servers with deterministic vectors: 384
// dimensions with no key (standing in for the local text-embeddings-inference
// model, whose image and weights need ghcr.io / huggingface.co — unreachable
// here, so THE REAL LOCAL MODEL IS NOT PROVEN BY THIS TEST), and 1536
// dimensions behind an API key (standing in for OpenAI).
//
// The host side is played by this test: it applies FOUNDATION_SCHEMA_SQL as the
// superuser, writes feature rows, seals secrets with the CONTRACT module
// (sealForApp) and sends NOTIFY — exactly what ProxyPilot does.
//
// Postgres is reached over TCP with trust auth via DATABASE_URL (the runtime
// honours an explicit DATABASE_URL), and once over its Unix socket in the
// FOUNDATION_DATABASE_URL shape. Every container, volume and port is prefixed
// a4- and removed at the end.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import * as contract from '../mock2/foundation-contract.js';
import { buildFoundationFiles, FOUNDATION_DEPENDENCIES } from '../mock2/scaffold-foundation.js';
import { buildFoundationComposeYaml } from '../mock2/foundation-stack-logic.js';
import { SCAFFOLD_DEPENDENCIES } from '../mock2/scaffold.js';

const E2E = process.env.FOUNDATION_E2E === '1';
const SKIP = E2E ? false : 'set FOUNDATION_E2E=1 to run the real-stack foundation test (Docker + npm registry)';
// FOUNDATION_E2E_TAG lets a run on a shared Docker daemon pick its own prefix.
const TAG = `${/^[a-z0-9-]{1,16}$/.test(process.env.FOUNDATION_E2E_TAG || '') ? process.env.FOUNDATION_E2E_TAG : 'a4'}-${process.pid}`;
const PG = `${TAG}-pg`;
const S3A = `${TAG}-s3-bundled`;
const S3B = `${TAG}-s3-external`;
const LOCAL_MODEL = contract.STACK.embeddings.model;
const OPENAI_MODEL = 'text-embedding-3-small';
const OPENAI_KEY = `sk-test-${crypto.randomBytes(8).toString('hex')}`;

const W = {}; // the world: dirs, ports, clients, runtime modules

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args, { allowFail = false, timeout = 120000 } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function until(fn, { timeout = 60000, every = 250, what = 'condition' } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await sleep(every);
  }
}

// Deterministic "embedding": each token lands on 4 signed coordinates; texts
// sharing words are close, texts that do not are near-orthogonal.
function fakeVector(text, dims) {
  const v = new Float64Array(dims);
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || ['empty'];
  for (const t of tokens) {
    const h = crypto.createHash('sha256').update(t).digest();
    for (let j = 0; j < 4; j += 1) v[h.readUInt32BE(j * 4) % dims] += (h[16 + j] & 1) ? 1 : -1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}

function fakeEmbeddingServer({ dims, apiKey = null }) {
  // stats.fail = true makes it answer 503 (an outage), counted in stats.failed.
  const stats = { requests: 0, inputs: 0, bodies: [], auth: [], fail: false, failed: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') { res.writeHead(404); res.end(); return; }
      if (stats.fail) {
        stats.failed += 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }));
        return;
      }
      stats.auth.push(req.headers.authorization || null);
      if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
        return;
      }
      const body = JSON.parse(raw);
      stats.requests += 1;
      stats.inputs += body.input.length;
      stats.bodies.push({ model: body.model, dimensions: body.dimensions, n: body.input.length });
      // Answers in REVERSED order (with indices) so the adapter must sort; and
      // always in its own dimensions, whatever was asked (so a misconfigured
      // dimension is caught by the adapter, not hidden by the server).
      const data = body.input.map((t, i) => ({ object: 'embedding', index: i, embedding: fakeVector(t, dims) })).reverse();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', model: body.model, data, usage: { prompt_tokens: 1, total_tokens: 1 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, stats, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

// A TCP proxy in front of an S3 server that passes the client's bytes on at
// bytesPerSec (answers unthrottled): a slow upload link. SigV4 still verifies,
// since the Host header the client signed is what reaches the server. A
// client that drops its connection drops the upstream one too.
function throttleProxy(port, bytesPerSec) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const slice = Math.max(1024, Math.floor(bytesPerSec / 20));
    const slow = new Transform({
      transform(chunk, _enc, cb) {
        let off = 0;
        const step = () => {
          if (off >= chunk.length) { cb(); return; }
          const part = chunk.subarray(off, off + slice);
          off += part.length;
          this.push(part);
          setTimeout(step, Math.ceil((part.length / bytesPerSec) * 1000));
        };
        step();
      },
    });
    const kill = () => { client.destroy(); upstream.destroy(); slow.destroy(); sockets.delete(client); sockets.delete(upstream); };
    for (const s of [client, upstream, slow]) s.on('error', kill);
    client.on('close', kill);
    upstream.on('close', kill);
    client.pipe(slow).pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => { for (const s of sockets) s.destroy(); server.close(); },
    }));
  });
}

// The host's own S3 client (bucket creation, reading the migration target),
// from the backend's dependencies — independent of the runtime under test.
async function s3Admin(endpoint, credentials) {
  const s3 = await import('@aws-sdk/client-s3');
  return {
    s3,
    client: new s3.S3Client({
      endpoint, region: 'us-east-1', forcePathStyle: true, credentials,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  };
}

function seaweedConfig(bucket, app, admin) {
  return JSON.stringify({
    identities: [
      { name: 'admin', credentials: [{ accessKey: admin.accessKeyId, secretKey: admin.secretAccessKey }], actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'] },
      { name: 'app', credentials: [{ accessKey: app.accessKeyId, secretKey: app.secretAccessKey }], actions: [`Read:${bucket}`, `Write:${bucket}`, `List:${bucket}`, `Tagging:${bucket}`] },
    ],
  });
}

const cred = (p) => ({ accessKeyId: `${p}${crypto.randomBytes(6).toString('hex')}`, secretAccessKey: crypto.randomBytes(24).toString('base64url') });

// ---- the host side (what ProxyPilot writes into the app database) ---------

async function superClient(db = 'app') {
  const c = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${W.pgPort}/${db}` });
  c.on('error', () => {});
  await c.connect();
  return c;
}

// The host keeps its counter in mock2_foundation.meta 'generation' (a jsonb
// number) and NOTIFYs that number as text.
let generation = 1;
async function bump() {
  generation += 1;
  await W.su.query(
    "INSERT INTO mock2_foundation.meta (key, value, updated_at) VALUES ('generation', to_jsonb($1::bigint), now()) "
    + 'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
    [generation],
  );
}
async function setFeature(feature, { state = 'on', provider, config, pending = null }) {
  await bump();
  await W.su.query(
    'INSERT INTO mock2_foundation.features (feature, state, provider, config, pending, generation, updated_at) '
    + 'VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now()) ON CONFLICT (feature) DO UPDATE SET state = EXCLUDED.state, '
    + 'provider = EXCLUDED.provider, config = EXCLUDED.config, pending = EXCLUDED.pending, generation = EXCLUDED.generation, updated_at = now()',
    [feature, state, provider, JSON.stringify(config), pending ? JSON.stringify(pending) : null, generation],
  );
}
async function setSecret(name, value) {
  await bump();
  await W.su.query(
    'INSERT INTO mock2_foundation.secrets (name, sealed, generation, updated_at) VALUES ($1, $2, $3, now()) '
    + 'ON CONFLICT (name) DO UPDATE SET sealed = EXCLUDED.sealed, generation = EXCLUDED.generation, updated_at = now()',
    [name, contract.sealForApp(W.masterKey, name, value), generation],
  );
}
async function deleteSecret(name) {
  await W.su.query('DELETE FROM mock2_foundation.secrets WHERE name = $1', [name]);
}
async function notify() {
  await W.su.query('SELECT pg_notify($1, $2)', [contract.FOUNDATION_NOTIFY_CHANNEL, String(generation)]);
}

const bundledConfig = () => ({ endpoint: W.s3a, region: 'us-east-1', bucket: 'app', prefix: '', force_path_style: true });
const externalConfig = (prefix) => ({ endpoint: W.s3b, region: 'us-east-1', bucket: 'ext', prefix, force_path_style: true });
const localEmbeddings = () => ({ base_url: W.local.baseUrl, model: LOCAL_MODEL, dimensions: 384, metric: 'cosine' });
const openaiEmbeddings = (dims = 1536) => ({ base_url: W.openai.baseUrl, model: OPENAI_MODEL, dimensions: dims, metric: 'cosine' });

async function baseline() {
  await setFeature('storage', { provider: 'bundled', config: bundledConfig() });
  await setFeature('embeddings', { provider: 'local', config: localEmbeddings() });
  await setSecret('storage.access_key_id', W.appA.accessKeyId);
  await setSecret('storage.secret_access_key', W.appA.secretAccessKey);
  await W.rt.config.reloadFoundation();
}

// The CLI as the host runs it. Asynchronous on purpose: the fake embedding
// servers live in THIS process, so a blocking spawnSync would deadlock them.
function cli(args, env = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [contract.FOUNDATION_CLI, ...args], { cwd: W.app, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('exit', (status) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* human output */ }
      resolve({ status, stdout, stderr, json, ms: Date.now() - started });
    });
  });
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('the generated foundation against a real stack', { skip: SKIP }, () => {
  before(async () => {
    W.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-foundation-'));
    W.app = path.join(W.tmp, 'app');
    for (const f of buildFoundationFiles({ composeYaml: buildFoundationComposeYaml({ portable: true }) })) {
      const p = path.join(W.app, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content, { mode: f.mode || 0o644 });
    }
    fs.writeFileSync(path.join(W.app, 'package.json'), JSON.stringify({
      name: 'a4-foundation-e2e', private: true, type: 'module',
      dependencies: {
        pg: SCAFFOLD_DEPENDENCIES.dependencies.pg,
        ...FOUNDATION_DEPENDENCIES,
        '@aws-sdk/s3-request-presigner': FOUNDATION_DEPENDENCIES['@aws-sdk/client-s3'],
      },
    }, null, 2));
    const t0 = Date.now();
    const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: W.app, encoding: 'utf8', timeout: 600000 });
    assert.equal(npm.status, 0, `npm install failed: ${npm.stderr}`);
    console.log(`[a4] npm install of the foundation dependencies: ${Math.round((Date.now() - t0) / 1000)} s`);

    W.pgPort = await freePort();
    W.s3aPort = await freePort();
    W.s3bPort = await freePort();
    W.s3a = `http://127.0.0.1:${W.s3aPort}`;
    W.s3b = `http://127.0.0.1:${W.s3bPort}`;
    W.sock = path.join(W.tmp, 'sock');
    fs.mkdirSync(W.sock, { mode: 0o777 });
    fs.chmodSync(W.sock, 0o777);
    W.masterKey = contract.generateMasterKey();
    W.keyFile = path.join(W.tmp, 'master.key');
    fs.writeFileSync(W.keyFile, `${W.masterKey}\n`, { mode: 0o600 });

    W.appA = cred('a4app'); W.adminA = cred('a4adm');
    W.appB = cred('a4ext'); W.adminB = cred('a4exa');
    for (const [dir, bucket, app, admin] of [['s3a', 'app', W.appA, W.adminA], ['s3b', 'ext', W.appB, W.adminB]]) {
      fs.mkdirSync(path.join(W.tmp, dir));
      fs.writeFileSync(path.join(W.tmp, dir, 's3.json'), seaweedConfig(bucket, app, admin));
    }

    docker(['run', '-d', '--name', PG, '-e', 'POSTGRES_PASSWORD=a4-unused', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p', `127.0.0.1:${W.pgPort}:5432`, '-v', `${W.sock}:/var/run/postgresql`, contract.STACK.postgres.image]);
    for (const [name, port, dir] of [[S3A, W.s3aPort, 's3a'], [S3B, W.s3bPort, 's3b']]) {
      docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:8333`, '-v', `${path.join(W.tmp, dir)}:/cfg`,
        contract.STACK.storage.image, 'server', '-dir=/data', '-s3', '-s3.port=8333', '-s3.config=/cfg/s3.json']);
    }

    // Postgres: role + database as the guest provisions them, then the schema.
    await until(async () => { const c = await superClient('postgres'); await c.end(); return true; }, { what: 'postgres' });
    const pgsu = await superClient('postgres');
    await pgsu.query('CREATE ROLE app LOGIN');
    await pgsu.query('CREATE DATABASE app OWNER app');
    await pgsu.end();
    W.su = await superClient('app');
    await W.su.query(contract.FOUNDATION_SCHEMA_SQL);

    // S3: buckets created by the admin identities (the app identity cannot).
    for (const [endpoint, admin, bucket] of [[W.s3a, W.adminA, 'app'], [W.s3b, W.adminB, 'ext']]) {
      const { s3, client } = await s3Admin(endpoint, admin);
      await until(() => client.send(new s3.ListBucketsCommand({})).then(() => true), { what: `seaweedfs ${endpoint}` });
      await client.send(new s3.CreateBucketCommand({ Bucket: bucket }));
      client.destroy();
    }
    const ext = await s3Admin(W.s3b, W.adminB);
    W.extS3 = ext;

    W.local = await fakeEmbeddingServer({ dims: 384 });
    W.openai = await fakeEmbeddingServer({ dims: 1536, apiKey: OPENAI_KEY });

    process.env.DATABASE_URL = `postgres://app@127.0.0.1:${W.pgPort}/app`;
    process.env.FOUNDATION_KEY_FILE = W.keyFile;
    process.env.FOUNDATION_DB_RETRY_MS = '5000';
    delete process.env.TEST_COMPONENT_SECRET;
    const mod = (m) => import(pathToFileURL(path.join(W.app, 'foundation', 'runtime', `${m}.mjs`)).href);
    W.rt = {
      config: await mod('config'), errors: await mod('errors'), storage: await mod('storage'),
      embeddings: await mod('embeddings'), vector: await mod('vector'), health: await mod('health'), jobs: await mod('jobs'),
    };
    W.cliEnv = { DATABASE_URL: process.env.DATABASE_URL, FOUNDATION_KEY_FILE: W.keyFile, FOUNDATION_DB_RETRY_MS: '5000' };
  }, { timeout: 900000 });

  after(async () => {
    try { if (W.rt) await W.rt.config.closeFoundation(); } catch { /* best effort */ }
    try { if (W.su) await W.su.end(); } catch { /* best effort */ }
    try { if (W.extS3) W.extS3.client.destroy(); } catch { /* best effort */ }
    for (const s of [W.local, W.openai]) if (s) s.server.close();
    docker(['rm', '-f', '-v', PG, S3A, S3B], { allowFail: true });
    if (W.tmp) fs.rmSync(W.tmp, { recursive: true, force: true });
  });

  test('health is ready only from real probes (database + vector op, storage put/get/delete, one embedding), recorded, with the local warning', { timeout: 120000 }, async () => {
    await baseline();
    const componentSecret = `cs-${crypto.randomBytes(12).toString('hex')}`;
    await setSecret('component.TEST_COMPONENT_SECRET', componentSecret);
    await W.rt.config.reloadFoundation();
    assert.equal(process.env.TEST_COMPONENT_SECRET, componentSecret, 'component.<KEY> is in process.env, in memory');

    const results = await W.rt.health.runHealth();
    assert.deepEqual(results.map((r) => [r.component, r.status]), [['database', 'ready'], ['storage', 'ready'], ['embeddings', 'ready']]);
    const [db, st, emb] = results;
    assert.equal(db.detail.vector, true);
    assert.equal(st.detail.anonymous_refused, true, 'an unauthenticated read of the probe object was refused');
    assert.equal(emb.detail.returned_dimensions, 384);
    assert.equal(emb.detail.warning, contract.LOCAL_EMBEDDINGS_WARNING);
    const rows = (await W.su.query('SELECT component, status FROM mock2_foundation.health ORDER BY component')).rows;
    assert.deepEqual(rows, [{ component: 'database', status: 'ready' }, { component: 'embeddings', status: 'ready' }, { component: 'storage', status: 'ready' }]);
    const report = await W.rt.health.healthReport({ refresh: true });
    assert.equal(report.local_embeddings, true);
    assert.deepEqual(report.warnings, [contract.LOCAL_EMBEDDINGS_WARNING]);
    // No probe object is left behind.
    const left = await (await W.rt.storage.openStorage()).list({ prefix: '.mock2-health/' });
    assert.equal(left.items.length, 0);

    const h = await cli(['health', '--json'], W.cliEnv);
    assert.equal(h.status, 0, h.stderr);
    assert.equal(h.json.ok, true);
    const c = await cli(['config', '--json'], W.cliEnv);
    assert.equal(c.status, 0, c.stderr);
    for (const secret of [W.appA.accessKeyId, W.appA.secretAccessKey, componentSecret, W.masterKey]) {
      assert.ok(!c.stdout.includes(secret) && !c.stderr.includes(secret), 'config never prints a secret');
      assert.ok(!h.stdout.includes(secret), 'health never prints a secret');
    }
    assert.equal(c.json.features.storage.has_secret['storage.access_key_id'], true);
    assert.equal(c.json.features.storage.has_secret['pending.storage.access_key_id'], false);
    assert.equal(c.json.master_key.present, true);
    assert.deepEqual(c.json.warnings, [contract.LOCAL_EMBEDDINGS_WARNING]);

    // The FOUNDATION_DATABASE_URL shape — Unix socket, no password — works.
    const sockUrl = `postgres:///app?host=${W.sock}&user=app`;
    const s = await cli(['health', '--json'], { ...W.cliEnv, DATABASE_URL: sockUrl });
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.json.components[0].detail.target, `socket ${W.sock}, database app, user app`);
  });

  test('storage: put/get/head/list/delete, streams and multipart, presigned GET, typed errors', { timeout: 120000 }, async () => {
    const { storage, openStorage } = W.rt.storage;
    const { FoundationError } = W.rt.errors;
    await storage.put('docs/a.txt', 'hello', { contentType: 'text/plain', metadata: { owner: 'test' } });
    await storage.put('docs/b.txt', Buffer.from('second'));
    assert.equal((await storage.getBuffer('docs/a.txt')).toString(), 'hello');
    const got = await storage.get('docs/a.txt');
    assert.equal(got.size, 5);
    assert.equal(got.contentType, 'text/plain');
    assert.equal(got.metadata.owner, 'test');
    got.body.destroy();
    const head = await storage.head('docs/a.txt');
    assert.equal(head.size, 5);
    assert.equal(await storage.head('docs/missing.txt'), null);
    const page1 = await storage.list({ prefix: 'docs/', limit: 1 });
    assert.equal(page1.items.length, 1);
    assert.ok(page1.cursor, 'paginated');
    const page2 = await storage.list({ prefix: 'docs/', limit: 1, cursor: page1.cursor });
    assert.deepEqual([page1.items[0].key, page2.items[0].key].sort(), ['docs/a.txt', 'docs/b.txt']);
    const all = [];
    for await (const it of storage.listAll({ prefix: 'docs/' })) all.push(it.key);
    assert.deepEqual(all.sort(), ['docs/a.txt', 'docs/b.txt']);

    const url = await storage.presignGet('docs/a.txt', { expiresIn: 60 });
    assert.equal(await (await fetch(url)).text(), 'hello');
    const st = await openStorage();
    assert.equal((await fetch(st.objectUrl('docs/a.txt'))).status, 403, 'anonymous read refused');

    // 20 MiB from a stream: multipart through lib-storage.
    const chunk = crypto.randomBytes(1024 * 1024);
    const big = Buffer.concat(Array.from({ length: 20 }, () => chunk));
    await storage.put('docs/big.bin', Readable.from((function* () { for (let i = 0; i < 20; i += 1) yield chunk; })()));
    assert.equal((await storage.head('docs/big.bin')).size, big.length);
    assert.deepEqual(await st.sha256('docs/big.bin'), { sha256: sha(big), size: big.length });

    await storage.delete('docs/big.bin');
    await storage.delete('docs/big.bin'); // idempotent
    assert.equal(await storage.head('docs/big.bin'), null);
    await assert.rejects(storage.get('docs/big.bin'), (e) => e instanceof FoundationError && e.code === 'NOT_FOUND');
    await assert.rejects(storage.put('/abs', 'x'), (e) => e.code === 'INVALID_KEY');
    await storage.delete('docs/a.txt');
    await storage.delete('docs/b.txt');
  });

  test('unavailable is reported, never a crash: missing credentials, missing master key, storage off, embeddings off', { timeout: 120000 }, async () => {
    const { storage } = W.rt.storage;
    const { FoundationUnavailableError } = W.rt.errors;
    const { probeStorage, probeDatabase, probeEmbeddings } = W.rt.health;

    await deleteSecret('storage.secret_access_key');
    await W.rt.config.reloadFoundation();
    await assert.rejects(storage.put('x.txt', 'x'), (e) => e instanceof FoundationUnavailableError && e.code === 'MISSING_CREDENTIALS');
    let r = await probeStorage();
    assert.equal(r.status, 'missing_credentials');
    assert.equal(r.detail.reason, 'MISSING_CREDENTIALS');
    await baseline();

    // Wrong storage credentials: the provider refuses them.
    await setSecret('storage.secret_access_key', 'wrong-secret');
    await W.rt.config.reloadFoundation();
    r = await probeStorage();
    assert.equal(r.status, 'missing_credentials');
    assert.equal(r.detail.reason, 'STORAGE_REJECTED_CREDENTIALS');
    await baseline();

    // The master key file is gone: the database still works; storage reports
    // MISSING_MASTER_KEY; component secrets already in memory are kept.
    process.env.FOUNDATION_KEY_FILE = path.join(W.tmp, 'no-such.key');
    await W.rt.config.reloadFoundation();
    assert.equal(W.rt.config.getFoundation().masterKey.present, false);
    assert.equal((await probeDatabase()).status, 'ready');
    r = await probeStorage();
    assert.equal(r.status, 'missing_credentials');
    assert.equal(r.detail.reason, 'MISSING_MASTER_KEY');
    assert.equal((await probeEmbeddings()).status, 'ready', 'the local model needs no key');
    assert.ok(process.env.TEST_COMPONENT_SECRET, 'a briefly unreadable key does not strip component secrets');
    const k = await cli(['storage-test', '--json'], { ...W.cliEnv, FOUNDATION_KEY_FILE: path.join(W.tmp, 'no-such.key') });
    assert.equal(k.status, 2);
    assert.equal(k.json.detail.reason, 'MISSING_MASTER_KEY');
    process.env.FOUNDATION_KEY_FILE = W.keyFile;
    await W.rt.config.reloadFoundation();

    // Storage off: STORAGE_OFF for feature code, 'off' in health (not a failure).
    await setFeature('storage', { state: 'off', provider: 'bundled', config: bundledConfig() });
    await W.rt.config.reloadFoundation();
    await assert.rejects(storage.put('x.txt', 'x'), (e) => e instanceof FoundationUnavailableError && e.code === 'STORAGE_OFF');
    assert.equal((await probeStorage()).status, 'off');
    const h = await cli(['health', '--json'], W.cliEnv);
    assert.equal(h.status, 0, 'off is a state, not a failure');
    assert.equal(h.json.components[1].status, 'off');

    // OpenAI with no key → missing_credentials; with a wrong key → refused.
    await setFeature('storage', { provider: 'bundled', config: bundledConfig() });
    await setFeature('embeddings', { provider: 'openai', config: openaiEmbeddings() });
    await W.rt.config.reloadFoundation();
    r = await probeEmbeddings();
    assert.equal(r.status, 'missing_credentials');
    assert.equal(r.detail.reason, 'MISSING_CREDENTIALS');
    assert.equal((await cli(['embeddings-test', '--json'], W.cliEnv)).status, 2);
    await setSecret('embeddings.api_key', 'sk-wrong');
    await W.rt.config.reloadFoundation();
    r = await probeEmbeddings();
    assert.equal(r.status, 'missing_credentials');
    assert.equal(r.detail.reason, 'PROVIDER_REJECTED_CREDENTIALS');
    await deleteSecret('embeddings.api_key');
    await baseline();
  });

  test('LISTEN/NOTIFY: a host change reaches the running app without a restart', { timeout: 60000 }, async () => {
    const cfg = W.rt.config;
    await cfg.closeFoundation();
    await cfg.loadFoundation({ listen: true });
    const before = cfg.getFoundation().generation;
    const rotated = `cs-${crypto.randomBytes(12).toString('hex')}`;
    await setSecret('component.TEST_COMPONENT_SECRET', rotated);
    await setFeature('embeddings', { provider: 'local', config: { ...localEmbeddings(), batch_size: 16 } });
    await notify();
    await until(() => cfg.getFoundation() && cfg.getFoundation().generation > before && cfg.getFoundation().features.embeddings.config.batch_size === 16, { timeout: 10000, every: 50, what: 'the reload' });
    assert.equal(process.env.TEST_COMPONENT_SECRET, rotated, 'a rotated component secret replaces the old one in memory');
    assert.equal(cfg.getFoundation().generation, generation, "the generation is the host's meta number");
    await cfg.closeFoundation();
    await cfg.loadFoundation();
  });

  test('vector: upsert/search/remove in the active index; unchanged content is not re-embedded; embeddings off → EMBEDDINGS_OFF', { timeout: 120000 }, async () => {
    const { vector } = W.rt.vector;
    const docs = [
      ['zebra', 'The zebra has black and white stripes and lives on the savanna'],
      ['penguin', 'Penguins are flightless birds that swim in cold antarctic water'],
      ['volcano', 'A volcano erupts molten lava ash and sulfur gas'],
      ['piano', 'The piano has eighty eight keys hammers and strings'],
      ['espresso', 'Espresso is strong coffee brewed under pressure'],
      ['glacier', 'A glacier is a slow river of compacted ice'],
    ];
    const res = await vector.upsertMany(docs.map(([id, content]) => ({ source: 'kb', itemId: id, content, metadata: { title: id } })));
    assert.ok(res.every((x) => x.embedded && x.inserted));
    const [idx] = await vector.listIndexes();
    assert.equal(idx.state, 'active');
    assert.equal(idx.dimensions, 384);
    assert.equal(idx.provider, 'local');
    assert.equal(idx.item_count, docs.length);
    const ann = (await W.su.query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'mock2_foundation' AND tablename = $1", [idx.table_name])).rows.map((r) => r.indexdef).join('\n');
    assert.match(ann, /USING hnsw \(embedding vector_cosine_ops\)/);

    const hits = await vector.search({ query: 'zebra stripes', k: 3 });
    assert.equal(hits[0].itemId, 'zebra');
    assert.ok(hits[0].score > hits[1].score);
    assert.deepEqual(hits[0].metadata, { title: 'zebra' });

    const inputs = W.local.stats.inputs;
    const same = await vector.upsert({ source: 'kb', itemId: 'zebra', content: docs[0][1], metadata: { title: 'Zebra', v: 2 } });
    assert.equal(same.embedded, false, 'unchanged content is not re-embedded');
    assert.equal(W.local.stats.inputs, inputs);
    assert.deepEqual((await vector.search({ query: 'zebra stripes', k: 1 }))[0].metadata, { title: 'Zebra', v: 2 });
    const changed = await vector.upsert({ source: 'kb', itemId: 'zebra', content: 'The zebra stripes confuse biting flies' });
    assert.equal(changed.embedded, true);
    assert.equal(changed.inserted, false);

    await vector.upsertMany([
      { source: 'faq', itemId: 'q1', chunk: 0, content: 'How do I reset my password' },
      { source: 'faq', itemId: 'q1', chunk: 1, content: 'Use the forgot password link on the sign in page' },
    ]);
    const faq = await vector.search({ query: 'reset password', k: 5, source: 'faq' });
    assert.ok(faq.length >= 1 && faq.every((h) => h.source === 'faq'));
    assert.deepEqual(await vector.remove({ source: 'faq', itemId: 'q1' }), { removed: 2 });
    const count = Number((await W.su.query(`SELECT count(*) AS n FROM mock2_foundation.${idx.table_name}`)).rows[0].n);
    assert.equal((await vector.activeIndex()).item_count, count);

    await setFeature('embeddings', { state: 'off', provider: 'local', config: localEmbeddings() });
    await W.rt.config.reloadFoundation();
    await assert.rejects(vector.search({ query: 'zebra' }), (e) => e.code === 'EMBEDDINGS_OFF');
    await assert.rejects(vector.upsert({ source: 'kb', itemId: 'x', content: 'x' }), (e) => e.code === 'EMBEDDINGS_OFF');
    // The vectors stay in Postgres while embeddings are off.
    assert.equal(Number((await W.su.query(`SELECT count(*) AS n FROM mock2_foundation.${idx.table_name}`)).rows[0].n), count);
    assert.equal((await W.rt.health.probeEmbeddings()).status, 'off');
    await baseline();
    assert.equal((await vector.search({ query: 'zebra stripes', k: 1 }))[0].itemId, 'zebra', 'back on: search is available at once');
  });

  test('storage_migrate copies to the pending provider with size + sha256 verification, resumes after an interruption and a crash, honours cancel', { timeout: 300000 }, async () => {
    const { storage } = W.rt.storage;
    const { runJob, JobInterrupted } = W.rt.jobs;
    const objects = new Map();
    for (let i = 0; i < 40; i += 1) {
      const buf = crypto.randomBytes(1024 + Math.floor(Math.random() * 96 * 1024));
      objects.set(`mig/obj-${String(i).padStart(2, '0')}.bin`, buf);
    }
    objects.set('mig/big.bin', crypto.randomBytes(6 * 1024 * 1024));
    objects.set('mig/empty.bin', Buffer.alloc(0));
    objects.set('mig/ünïcode name.txt', Buffer.from('unicode key'));
    for (const [k, v] of objects) await storage.put(k, v);
    const total = objects.size;

    const pendingTo = async (prefix) => {
      await setFeature('storage', { provider: 'bundled', config: bundledConfig(), pending: { provider: 'external', config: externalConfig(prefix), mode: 'copy', test: { at: new Date().toISOString() } } });
      await setSecret('pending.storage.access_key_id', W.appB.accessKeyId);
      await setSecret('pending.storage.secret_access_key', W.appB.secretAccessKey);
      await W.rt.config.reloadFoundation();
    };
    // What the host writes: from/to as planned, verify, plus our concurrency.
    const where = (provider, c) => ({ provider, endpoint: c.endpoint, bucket: c.bucket, region: c.region, prefix: c.prefix });
    const job = async (id, prefix, extra = {}) => {
      const params = { from: where('bundled', bundledConfig()), to: where('external', externalConfig(prefix)), verify: ['size', 'sha256'], ...extra };
      await W.su.query("INSERT INTO mock2_foundation.jobs (id, kind, state, params) VALUES ($1, 'storage_migrate', 'queued', $2::jsonb)", [id, JSON.stringify(params)]);
    };
    const verified = async (id) => Number((await W.su.query("SELECT count(*) AS n FROM mock2_foundation.storage_migration_items WHERE job_id = $1 AND state = 'verified'", [id])).rows[0].n);
    const targetSha = async (key) => {
      const { s3, client } = W.extS3;
      const r = await client.send(new s3.GetObjectCommand({ Bucket: 'ext', Key: key }));
      return sha(Buffer.from(await r.Body.transformToByteArray()));
    };

    await pendingTo('tenant1/');
    const t = await cli(['storage-test', '--pending', '--json'], W.cliEnv);
    assert.equal(t.status, 0, t.stderr);
    assert.equal(t.json.detail.pending, true);

    // 1. Interrupted in-process after 8 verified objects, then resumed.
    await job('mig-1', 'tenant1/', { concurrency: 2 });
    const ac = new AbortController();
    await assert.rejects(
      runJob('mig-1', { signal: ac.signal, onProgress: (_p, s) => { if (s.copied >= 8) ac.abort(new Error('test interruption')); } }),
      (e) => e instanceof JobInterrupted,
    );
    let row = (await W.su.query("SELECT state, error FROM mock2_foundation.jobs WHERE id = 'mig-1'")).rows[0];
    assert.equal(row.state, 'queued');
    assert.match(row.error, /resume/);
    const done1 = await verified('mig-1');
    assert.ok(done1 >= 8 && done1 < total, `partial (${done1}/${total})`);
    const out = await runJob('mig-1');
    assert.equal(out.job.state, 'succeeded', JSON.stringify(out));
    assert.equal(out.stats.skipped_verified, done1, 'verified objects are skipped on resume');
    assert.equal(out.stats.copied, total - done1);
    assert.deepEqual(
      { t: out.job.progress.objects_total, d: out.job.progress.objects_done, f: out.job.progress.failed },
      { t: total, d: total, f: 0 },
    );
    assert.equal(out.job.progress.bytes_done, [...objects.values()].reduce((n, b) => n + b.length, 0));
    for (const [k, v] of objects) assert.equal(await targetSha(`tenant1/${k}`), sha(v), `${k} on the target`);
    const items = (await W.su.query("SELECT key, size, sha256, state FROM mock2_foundation.storage_migration_items WHERE job_id = 'mig-1'")).rows;
    assert.equal(items.length, total);
    for (const it of items) {
      assert.equal(it.state, 'verified');
      assert.equal(it.sha256, sha(objects.get(it.key)));
      assert.equal(Number(it.size), objects.get(it.key).length);
    }
    assert.equal((await runJob('mig-1')).ran, false, 'a succeeded job is not re-run');

    // 2. The CLI is SIGKILLed mid-copy (a crash): the row stays 'running', and
    //    the next run resumes from the verified objects.
    await pendingTo('tenant2/');
    await job('mig-2', 'tenant2/', { concurrency: 1 });
    const child = spawn(process.execPath, [contract.FOUNDATION_CLI, 'job-run', 'mig-2', '--json'], { cwd: W.app, env: { ...process.env, ...W.cliEnv }, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const atKill = await until(async () => { const n = await verified('mig-2'); return n >= 2 ? n : 0; }, { timeout: 60000, every: 10, what: 'two verified objects' });
    child.kill('SIGKILL');
    await exited;
    assert.ok(atKill < total, `killed mid-copy (${atKill}/${total})`);
    row = (await W.su.query("SELECT state FROM mock2_foundation.jobs WHERE id = 'mig-2'")).rows[0];
    assert.equal(row.state, 'running', 'a crash leaves the row running');
    // The killed session's advisory lock goes when Postgres notices the closed
    // connection; until then the job reports JOB_BUSY rather than running twice.
    let resumed;
    for (let i = 0; i < 20; i += 1) {
      resumed = await cli(['job-run', 'mig-2', '--json'], W.cliEnv);
      if (!(resumed.json && resumed.json.code === 'JOB_BUSY')) break;
      await sleep(250);
    }
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(resumed.json.job.state, 'succeeded');
    assert.ok(resumed.json.stats.skipped_verified >= 2);
    assert.equal(await verified('mig-2'), total);

    // 3. Cancelled by the host mid-run.
    await pendingTo('tenant3/');
    await job('mig-3', 'tenant3/', { concurrency: 1 });
    let cancelled = false;
    const c = await runJob('mig-3', {
      onProgress: (_p, s) => {
        if (!cancelled && s.copied >= 3) {
          cancelled = true;
          W.su.query("UPDATE mock2_foundation.jobs SET state = 'cancelled' WHERE id = 'mig-3'").catch(() => {});
        }
      },
    });
    assert.equal(c.cancelled, true);
    row = (await W.su.query("SELECT state, finished_at FROM mock2_foundation.jobs WHERE id = 'mig-3'")).rows[0];
    assert.equal(row.state, 'cancelled');
    assert.ok(row.finished_at);
    assert.ok(await verified('mig-3') < total);

    // 4. A plan that no longer matches the app database is refused: nothing copied.
    await job('mig-4', 'tenant9/');
    const f = await runJob('mig-4');
    assert.equal(f.job.state, 'failed');
    assert.equal(f.error.code, 'JOB_PARAMS_MISMATCH');
    assert.match(f.error.message, /to prefix "tenant9\/" vs "tenant3\/"/);
    assert.equal(Number((await W.su.query("SELECT count(*) AS n FROM mock2_foundation.storage_migration_items WHERE job_id = 'mig-4'")).rows[0].n), 0);
    await job('mig-5', 'tenant3/', { verify: ['md5'] });
    assert.equal((await runJob('mig-5')).error.code, 'JOB_PARAMS_INVALID');

    // 6. An object written to the source WHILE the copy runs is caught by the
    //    next listing pass: the job ends only on a listing that finds nothing new.
    await pendingTo('tenant6/');
    await job('mig-6', 'tenant6/', { concurrency: 2 });
    const lateBuf = crypto.randomBytes(2048);
    let late = null;
    const six = await runJob('mig-6', {
      onProgress: (p) => { if (!late && p.phase === 'copying' && p.pass === 1) late = storage.put('mig/late-during-copy.bin', lateBuf); },
    });
    await late;
    assert.equal(six.job.state, 'succeeded', JSON.stringify(six));
    assert.equal(six.job.progress.converged, true);
    assert.ok(six.job.progress.passes >= 2, `passes ${six.job.progress.passes}`);
    assert.equal(six.job.progress.objects_total, total + 1);
    assert.equal(await targetSha('tenant6/mig/late-during-copy.bin'), sha(lateBuf), 'the object written mid-copy is on the target');

    // 7. A source that never stops changing is not reported as copied.
    await pendingTo('tenant7/');
    await job('mig-7', 'tenant7/', { concurrency: 4 });
    let churning = true;
    let churned = 0;
    const churn = (async () => { while (churning) { await storage.put(`mig/churn-${churned}.bin`, crypto.randomBytes(64)); churned += 1; } })();
    const seven = await runJob('mig-7');
    churning = false;
    await churn;
    assert.equal(seven.job.state, 'failed', JSON.stringify(seven.job));
    assert.equal(seven.error.code, 'SOURCE_STILL_CHANGING');
    assert.equal(seven.job.progress.converged, false);
    assert.equal(seven.job.progress.passes, 5);
    for (let i = 0; i < churned; i += 1) await storage.delete(`mig/churn-${i}.bin`);
    await storage.delete('mig/late-during-copy.bin');

    for (const k of objects.keys()) await storage.delete(k);
    await W.su.query("DELETE FROM mock2_foundation.secrets WHERE name LIKE 'pending.%'");
    await baseline();
  });

  // Shared by the two tests below: stage a switch to the external S3 (bucket
  // ext) under a prefix, insert the host's job row, read the target directly.
  const stageExternal = async (config) => {
    await setFeature('storage', { provider: 'bundled', config: bundledConfig(), pending: { provider: 'external', config, mode: 'copy', test: { at: new Date().toISOString() } } });
    await setSecret('pending.storage.access_key_id', W.appB.accessKeyId);
    await setSecret('pending.storage.secret_access_key', W.appB.secretAccessKey);
    await W.rt.config.reloadFoundation();
  };
  const insertCopyJob = async (id, to, extra = {}) => {
    const c = bundledConfig();
    const params = { from: { provider: 'bundled', endpoint: c.endpoint, bucket: c.bucket, region: c.region, prefix: c.prefix }, to: { provider: 'external', ...to }, verify: ['size', 'sha256'], ...extra };
    await W.su.query("INSERT INTO mock2_foundation.jobs (id, kind, state, params) VALUES ($1, 'storage_migrate', 'queued', $2::jsonb)", [id, JSON.stringify(params)]);
  };
  const extObject = async (key) => {
    const { s3, client } = W.extS3;
    try {
      const r = await client.send(new s3.GetObjectCommand({ Bucket: 'ext', Key: key }));
      return Buffer.from(await r.Body.transformToByteArray());
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  };
  const extKeys = async (prefix) => {
    const { s3, client } = W.extS3;
    const keys = [];
    let token;
    do {
      const r = await client.send(new s3.ListObjectsV2Command({ Bucket: 'ext', Prefix: prefix, ContinuationToken: token }));
      for (const c of r.Contents || []) keys.push(c.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  };
  const sourceKeys = async () => {
    const keys = [];
    for await (const it of W.rt.storage.storage.listAll()) if (!it.key.startsWith('.mock2-health/')) keys.push(it.key);
    return keys.sort();
  };

  test('storage_migrate follows the source to the end: a same-size overwrite is copied again, a deleted key is deleted from the target (only keys the job wrote), the source is never deleted from; storage-test --pending counts the target', { timeout: 300000 }, async () => {
    const { storage } = W.rt.storage;
    const { runJob } = W.rt.jobs;
    const { s3, client } = W.extS3;
    const objects = new Map();
    for (let i = 0; i < 30; i += 1) objects.set(`conv/a-${String(i).padStart(2, '0')}.bin`, crypto.randomBytes(4096));
    for (const [k, v] of objects) await storage.put(k, v);
    // On the target before the job, and not the job's: never touched.
    await client.send(new s3.PutObjectCommand({ Bucket: 'ext', Key: 'conv1/unrelated.txt', Body: 'already here, not from the source' }));
    await client.send(new s3.PutObjectCommand({ Bucket: 'ext', Key: 'elsewhere/keep.txt', Body: 'outside the prefix' }));
    const config = externalConfig('conv1/');
    await stageExternal(config);
    await insertCopyJob('conv-1', { endpoint: config.endpoint, bucket: 'ext', region: config.region, prefix: 'conv1/' }, { concurrency: 1 });

    // While pass 1 still copies, the app overwrites an object that is already
    // verified on the target with other bytes of the SAME size, and deletes
    // another verified one.
    const overwritten = crypto.randomBytes(4096);
    let mutation = null;
    const out = await runJob('conv-1', {
      onProgress: (p, s) => {
        if (!mutation && p.pass === 1 && s.copied >= 3) {
          mutation = (async () => { await storage.put('conv/a-00.bin', overwritten); await storage.delete('conv/a-01.bin'); })();
        }
      },
    });
    await mutation;
    assert.equal(out.job.state, 'succeeded', JSON.stringify(out));
    assert.equal(out.job.progress.converged, true);
    assert.ok(out.job.progress.passes >= 3, `a pass copied the changes, a later one was quiet (${out.job.progress.passes})`);
    assert.equal(sha(await extObject('conv1/conv/a-00.bin')), sha(overwritten), 'the same-size overwrite reached the target');
    assert.equal(await extObject('conv1/conv/a-01.bin'), null, 'the object deleted from the source is gone from the target');
    assert.equal(out.job.progress.deleted_from_target, 1);
    assert.equal(out.stats.deleted_from_target, 1);
    assert.equal(out.job.progress.bytes_in_flight, 0);
    for (const [k, v] of objects) if (k !== 'conv/a-00.bin' && k !== 'conv/a-01.bin') assert.equal(sha(await extObject(`conv1/${k}`)), sha(v), k);
    // Nothing the job did not write was touched, on either side of the prefix.
    assert.equal(String(await extObject('conv1/unrelated.txt')), 'already here, not from the source');
    assert.equal(String(await extObject('elsewhere/keep.txt')), 'outside the prefix');
    // The source lost only what the app deleted: the job never deletes there.
    const src = await sourceKeys();
    assert.deepEqual(src.filter((k) => k.startsWith('conv/')), [...objects.keys()].filter((k) => k !== 'conv/a-01.bin').sort());
    assert.ok(sha(await storage.getBuffer('conv/a-00.bin')) === sha(overwritten));
    // The job's record follows the source too, and holds no object names
    // outside storage_migration_items.
    const items = (await W.su.query("SELECT key, sha256, state FROM mock2_foundation.storage_migration_items WHERE job_id = 'conv-1'")).rows;
    assert.equal(items.length, src.length);
    assert.ok(items.every((i) => i.state === 'verified'));
    assert.ok(!items.some((i) => i.key === 'conv/a-01.bin'));
    assert.equal(items.find((i) => i.key === 'conv/a-00.bin').sha256, sha(overwritten));
    const sources = (await W.su.query("SELECT key_sha256, fingerprint, written FROM mock2_foundation.storage_migration_sources WHERE job_id = 'conv-1'")).rows;
    assert.equal(sources.length, src.length);
    assert.ok(sources.every((r) => /^[0-9a-f]{64}$/.test(r.key_sha256) && r.written === true));

    // storage-test --pending reports how many objects the target holds under
    // its prefix (probe keys left out) — here the copies plus the one that was
    // already there.
    const probe = await cli(['storage-test', '--pending', '--json'], W.cliEnv);
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    const onTarget = (await extKeys('conv1/')).filter((k) => !k.startsWith('conv1/.mock2-health/'));
    assert.equal(onTarget.length, out.job.progress.objects_done + 1);
    assert.equal(probe.json.detail.object_count, onTarget.length);
    // A listing that fails gives no count, never a guess.
    await setSecret('pending.storage.secret_access_key', 'not-the-secret');
    const refused = await cli(['storage-test', '--pending', '--json'], W.cliEnv);
    assert.equal(refused.status, 2);
    assert.equal(refused.json.detail.object_count, undefined);

    for (const k of objects.keys()) await storage.delete(k);
    await client.send(new s3.DeleteObjectCommand({ Bucket: 'ext', Key: 'elsewhere/keep.txt' }));
    await W.su.query("DELETE FROM mock2_foundation.secrets WHERE name LIKE 'pending.%'");
    await baseline();
  });

  test('a slow object keeps its job alive (the row moves while it is in flight), a cancel stops it mid-object, a relaunched run resumes after the finished objects', { timeout: 300000 }, async () => {
    const { storage } = W.rt.storage;
    const { runJob } = W.rt.jobs;
    const RATE = 192 * 1024;
    const BIG = 3 * 1024 * 1024; // ~16 s through the throttled link
    const slow = await throttleProxy(W.s3bPort, RATE);
    const slowEndpoint = `http://127.0.0.1:${slow.port}`;
    const objects = new Map([['slow/a.bin', crypto.randomBytes(2048)], ['slow/b.bin', crypto.randomBytes(2048)], ['slow/c.bin', crypto.randomBytes(2048)]]);
    objects.set('slow/z-big.bin', crypto.randomBytes(BIG));
    for (const [k, v] of objects) await storage.put(k, v);
    const total = (await sourceKeys()).length;
    const slowConfig = (prefix, endpoint = slowEndpoint) => ({ endpoint, region: 'us-east-1', bucket: 'ext', prefix, force_path_style: true });
    const jobRow = async (id) => (await W.su.query('SELECT state, updated_at, progress FROM mock2_foundation.jobs WHERE id = $1', [id])).rows[0];
    const inFlight = (row) => Number(row.progress.bytes_in_flight) || 0;
    try {
      // 1. The host's watchdog reads jobs.updated_at: while the big object
      //    crawls through the link the row keeps moving (and says how many
      //    bytes are in flight), so the job never looks dead.
      await stageExternal(slowConfig('slow1/'));
      await insertCopyJob('slow-1', { endpoint: slowEndpoint, bucket: 'ext', region: 'us-east-1', prefix: 'slow1/' }, { concurrency: 1 });
      const samples = [];
      let running = true;
      const watch = (async () => {
        while (running) {
          const r = await jobRow('slow-1');
          samples.push({ at: Date.now(), age: Date.now() - new Date(r.updated_at).getTime(), inFlight: inFlight(r), updated: new Date(r.updated_at).getTime() });
          await sleep(100);
        }
      })();
      const started = Date.now();
      const one = await runJob('slow-1', { heartbeatMs: 200 });
      running = false;
      await watch;
      assert.equal(one.job.state, 'succeeded', JSON.stringify(one));
      assert.ok(Date.now() - started > 8000, `the big object was slow (${Date.now() - started} ms)`);
      const during = samples.filter((x) => x.inFlight >= BIG);
      assert.ok(during.length >= 40, `sampled while the big object was in flight (${during.length})`);
      assert.ok(new Set(during.map((x) => x.updated)).size >= 20, 'the job row was written again and again while one object was in flight');
      const oldest = Math.max(...during.map((x) => x.age));
      assert.ok(oldest < 2500, `the row was never older than ${oldest} ms while the object was in flight (the host gives up after 10 min)`);
      assert.equal(sha(await extObject('slow1/slow/z-big.bin')), sha(objects.get('slow/z-big.bin')));

      // 2. A cancel mid-object stops the job within moments — not when the
      //    object is done — and the aborted upload leaves nothing behind.
      await stageExternal(slowConfig('slow2/'));
      await insertCopyJob('slow-2', { endpoint: slowEndpoint, bucket: 'ext', region: 'us-east-1', prefix: 'slow2/' }, { concurrency: 1 });
      const second = runJob('slow-2', { heartbeatMs: 200 });
      await until(async () => inFlight(await jobRow('slow-2')) >= BIG, { timeout: 60000, every: 50, what: 'the big object in flight' });
      await sleep(1000);
      const cancelledAt = Date.now();
      await W.su.query("UPDATE mock2_foundation.jobs SET state = 'cancelled' WHERE id = 'slow-2'");
      const two = await second;
      const stopMs = Date.now() - cancelledAt;
      assert.equal(two.cancelled, true, JSON.stringify(two));
      assert.ok(stopMs < 3000, `stopped ${stopMs} ms after the cancel (the object alone takes ~16 s)`);
      assert.equal((await jobRow('slow-2')).state, 'cancelled');
      await sleep(1000);
      assert.equal(await extObject('slow2/slow/z-big.bin'), null, 'the aborted upload left no object');

      // 3. The CLI, as the host runs it (default heartbeat), is killed while
      //    the big object is in flight. Its row moved meanwhile; the relaunched
      //    run skips every finished object and copies only the big one. (The
      //    plan names no endpoint, so it can finish over the direct link.)
      await stageExternal(slowConfig('slow3/'));
      await insertCopyJob('slow-3', { bucket: 'ext', region: 'us-east-1', prefix: 'slow3/' }, { concurrency: 1 });
      const child = spawn(process.execPath, [contract.FOUNDATION_CLI, 'job-run', 'slow-3', '--json'], { cwd: W.app, env: { ...process.env, ...W.cliEnv }, stdio: 'ignore' });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      const first = await until(async () => { const r = await jobRow('slow-3'); return inFlight(r) >= BIG ? r : null; }, { timeout: 60000, every: 50, what: 'a heartbeat with the big object in flight' });
      const firstAt = new Date(first.updated_at).getTime();
      await until(async () => { const r = await jobRow('slow-3'); return new Date(r.updated_at).getTime() > firstAt && inFlight(r) >= BIG; }, { timeout: 9000, every: 100, what: 'the next heartbeat of the CLI' });
      child.kill('SIGKILL');
      await exited;
      const verifiedAtKill = Number((await W.su.query("SELECT count(*) AS n FROM mock2_foundation.storage_migration_items WHERE job_id = 'slow-3' AND state = 'verified'")).rows[0].n);
      assert.equal(verifiedAtKill, total - 1, 'every object but the big one was finished');
      await stageExternal(slowConfig('slow3/', W.s3b));
      let three;
      for (let i = 0; i < 40; i += 1) {
        three = await runJob('slow-3').catch((e) => e);
        if (!(three && three.code === 'JOB_BUSY')) break;
        await sleep(250);
      }
      assert.equal(three.job.state, 'succeeded', JSON.stringify(three));
      assert.equal(three.stats.skipped_verified, total - 1);
      assert.equal(three.stats.copied, 1);
      assert.equal(sha(await extObject('slow3/slow/z-big.bin')), sha(objects.get('slow/z-big.bin')));
    } finally {
      slow.close();
      for (const k of objects.keys()) await storage.delete(k);
      await W.su.query("DELETE FROM mock2_foundation.secrets WHERE name LIKE 'pending.%'");
      await baseline();
    }
  });

  test('reembed builds a validated 1536-dimension index from the stored content; the active index is untouched and vector spaces never mix', { timeout: 300000 }, async () => {
    const { vector } = W.rt.vector;
    const { runJob, JobInterrupted, SELF_RETRIEVAL } = W.rt.jobs;
    // Only this test's requests (an earlier one sent a wrong key on purpose).
    const openaiFrom = W.openai.stats.bodies.length;
    const authFrom = W.openai.stats.auth.length;
    const words = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'iris', 'juniper', 'kelp', 'lagoon',
      'marble', 'nectar', 'onyx', 'prairie', 'quartz', 'ridge', 'sierra', 'tundra', 'umber', 'valley', 'willow', 'xenon', 'yarrow', 'zephyr'];
    await vector.upsertMany(words.map((w, i) => ({ source: 'atlas', itemId: w, content: `${w} ${words[(i + 7) % words.length]} field notes number ${i}` })));
    const active = await vector.activeIndex();
    const activeTable = `mock2_foundation.${active.table_name}`;
    const snapshot = async () => (await W.su.query(`SELECT source, item_id, chunk, content_sha256, vector_dims(embedding) AS d FROM ${activeTable} ORDER BY 1, 2, 3`)).rows;
    const before = await snapshot();
    assert.ok(before.length >= 30);

    // Stage the switch: pending provider + its key, then the building index.
    const pendingTo = async (config) => {
      await setFeature('embeddings', { provider: 'local', config: localEmbeddings(), pending: { provider: 'openai', config } });
      await setSecret('pending.embeddings.api_key', OPENAI_KEY);
      await W.rt.config.reloadFoundation();
    };
    const building = async (id, dims) => {
      await W.su.query(
        "INSERT INTO mock2_foundation.vector_indexes (id, provider, model, dimensions, metric, state, table_name) VALUES ($1, 'openai', $2, $3, 'cosine', 'building', $4)",
        [id, OPENAI_MODEL, dims, contract.vectorTableName(id)],
      );
    };
    // What the host writes: from/to as planned, source_index, target_index.
    const reembedJob = async (id, target, { dims = 1536, source = active.id, ...extra } = {}) => {
      const params = {
        from: { provider: 'local', model: LOCAL_MODEL, dimensions: 384, metric: 'cosine', index: active.id },
        to: { provider: 'openai', model: OPENAI_MODEL, dimensions: dims, metric: 'cosine', index: target },
        source_index: source,
        target_index: target,
        ...extra,
      };
      await W.su.query("INSERT INTO mock2_foundation.jobs (id, kind, state, params) VALUES ($1, 'reembed', 'queued', $2::jsonb)", [id, JSON.stringify(params)]);
    };
    await pendingTo(openaiEmbeddings(1536));
    const probe = await cli(['embeddings-test', '--pending', '--json'], W.cliEnv);
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assert.equal(probe.json.detail.returned_dimensions, 1536);

    await building('ix_openai_1536', 1536);
    await reembedJob('re-1', 'ix_openai_1536');
    const out = await runJob('re-1');
    assert.equal(out.job.state, 'succeeded', JSON.stringify(out));
    const target = (await W.su.query("SELECT * FROM mock2_foundation.vector_indexes WHERE id = 'ix_openai_1536'")).rows[0];
    assert.equal(target.state, 'ready');
    const v = target.validation;
    assert.equal(v.passed, true);
    assert.equal(v.item_count_source, before.length);
    assert.equal(v.item_count_target, before.length);
    assert.equal(Number(target.item_count), before.length);
    assert.equal(v.dimension_mismatches, 0);
    assert.equal(v.self_retrieval.sample_size, Math.min(SELF_RETRIEVAL.sample, before.length));
    assert.ok(v.self_retrieval.hit_rate >= SELF_RETRIEVAL.threshold);
    assert.equal(v.self_retrieval.threshold, SELF_RETRIEVAL.threshold);
    const dims = (await W.su.query('SELECT DISTINCT vector_dims(embedding) AS d FROM mock2_foundation.vec_ix_openai_1536')).rows;
    assert.deepEqual(dims, [{ d: 1536 }]);
    assert.ok(W.openai.stats.bodies.slice(openaiFrom).every((b) => b.dimensions === 1536 && b.model === OPENAI_MODEL), 'OpenAI is sent "dimensions"');
    assert.ok(W.openai.stats.auth.slice(authFrom).every((a) => a === `Bearer ${OPENAI_KEY}`));
    // The active index was only read.
    assert.deepEqual(await snapshot(), before);
    assert.equal((await vector.activeIndex()).id, active.id);
    // While the switch is pending, writes still go to the active (384) index.
    const w = await vector.upsert({ source: 'atlas', itemId: 'new', content: 'new aurora notes' });
    assert.equal(w.indexId, active.id);

    // Interrupted after the first batch, then resumed: present items are skipped.
    await building('ix_openai_b', 1536);
    await reembedJob('re-2', 'ix_openai_b', { batch_size: 8 });
    const ac = new AbortController();
    await assert.rejects(runJob('re-2', { signal: ac.signal, onProgress: (_p, s) => { if (s.embedded >= 8) ac.abort(new Error('test interruption')); } }), (e) => e instanceof JobInterrupted);
    const resumed = await runJob('re-2');
    assert.equal(resumed.job.state, 'succeeded', JSON.stringify(resumed));
    assert.ok(resumed.stats.already_present >= 8);
    assert.equal(resumed.stats.already_present + resumed.stats.embedded, before.length + 1);

    // A target that does not match the pending provider is refused, and the
    // target ends 'failed' (the host promotes only from 'ready').
    const targetState = async (id) => (await W.su.query('SELECT state, validation FROM mock2_foundation.vector_indexes WHERE id = $1', [id])).rows[0];
    await building('ix_wrong_768', 768);
    await reembedJob('re-3', 'ix_wrong_768', { dims: 768 });
    const bad = await runJob('re-3');
    assert.equal(bad.job.state, 'failed');
    assert.equal(bad.error.code, 'PENDING_MISMATCH');
    let ts = await targetState('ix_wrong_768');
    assert.equal(ts.state, 'failed');
    assert.equal(ts.validation.code, 'PENDING_MISMATCH');

    // A plan whose source index is not the active one is refused.
    await building('ix_stale', 1536);
    await reembedJob('re-4', 'ix_stale', { source: 'ix_someother' });
    const stale = await runJob('re-4');
    assert.equal(stale.error.code, 'JOB_PARAMS_MISMATCH');
    assert.match(stale.error.message, /source_index "ix_someother"/);
    assert.equal((await targetState('ix_stale')).state, 'failed');

    // Cancelled by the host mid-build: the job stops and the target is failed.
    await building('ix_cancel', 1536);
    await reembedJob('re-5', 'ix_cancel', { batch_size: 4 });
    let cancelSent = false;
    const cancelled = await runJob('re-5', {
      onProgress: (_p, st) => {
        if (!cancelSent && st.embedded >= 4) {
          cancelSent = true;
          W.su.query("UPDATE mock2_foundation.jobs SET state = 'cancelled' WHERE id = 're-5'").catch(() => {});
        }
      },
    });
    assert.equal(cancelled.cancelled, true);
    ts = await targetState('ix_cancel');
    assert.equal(ts.state, 'failed');
    assert.equal(ts.validation.code, 'CANCELLED');

    // A provider that answers in other dimensions than configured is refused.
    await pendingTo(openaiEmbeddings(1024));
    const mism = await cli(['embeddings-test', '--pending', '--json'], W.cliEnv);
    assert.equal(mism.status, 2);
    assert.equal(mism.json.detail.reason, 'DIMENSIONS_MISMATCH');

    // The host promotes the validated index (what ProxyPilot does).
    await W.su.query("UPDATE mock2_foundation.vector_indexes SET state = 'retired', retired_at = now() WHERE id = $1", [active.id]);
    await W.su.query("UPDATE mock2_foundation.vector_indexes SET state = 'retired' WHERE id = 'ix_openai_b'");
    await W.su.query("UPDATE mock2_foundation.vector_indexes SET state = 'active', activated_at = now() WHERE id = 'ix_openai_1536'");
    await setFeature('embeddings', { provider: 'openai', config: openaiEmbeddings(1536) });
    await setSecret('embeddings.api_key', OPENAI_KEY);
    await deleteSecret('pending.embeddings.api_key');
    await W.rt.config.reloadFoundation();
    const localBefore = W.local.stats.requests;
    const hits = await vector.search({ query: 'quartz xenon field notes number 16', k: 3 });
    assert.equal(hits[0].itemId, 'quartz');
    assert.equal(W.local.stats.requests, localBefore, 'the old provider is no longer asked');
    assert.equal((await vector.activeIndex()).dimensions, 1536);

    // The provider is switched back WITHOUT re-embedding: refused, not mixed.
    await setFeature('embeddings', { provider: 'local', config: localEmbeddings() });
    await W.rt.config.reloadFoundation();
    await assert.rejects(vector.upsert({ source: 'atlas', itemId: 'x', content: 'x y' }), (e) => e.code === 'INDEX_PROVIDER_MISMATCH');
    await assert.rejects(vector.search({ query: 'quartz' }), (e) => e.code === 'INDEX_PROVIDER_MISMATCH');
    await baseline();
  });

  test('re-embed on a busy app: writes reach the new index while it builds and until it is promoted, validation compares the sets, a pending-provider outage is caught up — also across the promotion', { timeout: 300000 }, async () => {
    const { vector } = W.rt.vector;
    const { runJob } = W.rt.jobs;
    // A fresh start: the test above left a promoted 1536 index beside local embeddings.
    await W.su.query("UPDATE mock2_foundation.vector_indexes SET state = 'retired', retired_at = now() WHERE state IN ('active','building','ready')");
    await W.su.query("DELETE FROM mock2_foundation.secrets WHERE name LIKE 'pending.%'");
    await baseline();
    const words = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'iris', 'juniper', 'kelp', 'lagoon', 'marble'];
    const pick = () => words[Math.floor(Math.random() * words.length)];
    // Each text carries its item id as a word of its own, so it finds itself.
    const text = (id) => `${id} ${pick()} ${pick()} ${pick()} notes`;
    const expected = new Map();
    let serial = 0;
    const seed = [];
    for (let i = 0; i < 80; i += 1) {
      const id = `bz${serial++}`;
      const content = text(id);
      seed.push({ source: 'busy', itemId: id, content });
      expected.set(id, content);
    }
    await vector.upsertMany(seed);
    const L = await vector.activeIndex();
    assert.equal(L.provider, 'local');
    const T = 'ix_busy_1536';
    const tableOf = (id) => `mock2_foundation.${contract.vectorTableName(id)}`;
    const diff = async () => (await W.su.query(
      'SELECT count(*) FILTER (WHERE d.item_id IS NULL)::int AS missing, count(*) FILTER (WHERE s.item_id IS NULL)::int AS extra, '
      + 'count(*) FILTER (WHERE s.item_id IS NOT NULL AND d.item_id IS NOT NULL AND s.content_sha256 <> d.content_sha256)::int AS stale '
      + `FROM ${tableOf(L.id)} s FULL JOIN ${tableOf(T)} d ON d.source = s.source AND d.item_id = s.item_id AND d.chunk = s.chunk`,
    )).rows[0];
    const contentOf = async (id) => new Map((await W.su.query(`SELECT item_id, content_sha256 FROM ${tableOf(id)} WHERE source = 'busy'`)).rows.map((r) => [r.item_id, r.content_sha256]));
    const asWritten = async (id) => {
      const rows = await contentOf(id);
      assert.equal(rows.size, expected.size, `${id} holds as many items as the app wrote`);
      for (const [itemId, content] of expected) assert.equal(rows.get(itemId), sha(Buffer.from(content)), `${id}: ${itemId}`);
    };
    const byItem = (a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0);
    const catchups = async () => (await W.su.query('SELECT index_id, item_id FROM mock2_foundation.vector_catchup')).rows.sort(byItem);

    // The host stages the switch: pending OpenAI 1536 + its key, the target
    // index ('building') and the job.
    await setFeature('embeddings', { provider: 'local', config: localEmbeddings(), pending: { provider: 'openai', config: openaiEmbeddings(1536) } });
    await setSecret('pending.embeddings.api_key', OPENAI_KEY);
    await W.rt.config.reloadFoundation();
    await W.su.query(
      "INSERT INTO mock2_foundation.vector_indexes (id, provider, model, dimensions, metric, state, table_name) VALUES ($1, 'openai', $2, 1536, 'cosine', 'building', $3)",
      [T, OPENAI_MODEL, contract.vectorTableName(T)],
    );
    await W.su.query("INSERT INTO mock2_foundation.jobs (id, kind, state, params) VALUES ('busy-1', 'reembed', 'queued', $1::jsonb)", [JSON.stringify({
      from: { provider: 'local', model: LOCAL_MODEL, dimensions: 384, metric: 'cosine', index: L.id },
      to: { provider: 'openai', model: OPENAI_MODEL, dimensions: 1536, metric: 'cosine', index: T },
      source_index: L.id, target_index: T, batch_size: 2,
    })]);

    // The busy app: new items, changed content and removals, nonstop.
    let busy = true;
    let ops = 0;
    let opError = null;
    const app = (async () => {
      while (busy) {
        try {
          const r = Math.random();
          const ids = [...expected.keys()];
          if (r < 0.4 || ids.length < 20) {
            const id = `bz${serial++}`;
            const content = text(id);
            await vector.upsert({ source: 'busy', itemId: id, content });
            expected.set(id, content);
          } else if (r < 0.8) {
            const id = ids[Math.floor(Math.random() * ids.length)];
            const content = text(id);
            await vector.upsert({ source: 'busy', itemId: id, content });
            expected.set(id, content);
          } else {
            const id = ids[Math.floor(Math.random() * ids.length)];
            await vector.remove({ source: 'busy', itemId: id });
            expected.delete(id);
          }
          ops += 1;
        } catch (err) {
          opError = err;
          busy = false;
        }
        await sleep(3);
      }
    })();
    const opsBefore = ops;
    const built = await runJob('busy-1');
    const opsDuring = ops - opsBefore;
    assert.equal(built.job.state, 'succeeded', JSON.stringify(built));
    const target = (await W.su.query('SELECT state, validation FROM mock2_foundation.vector_indexes WHERE id = $1', [T])).rows[0];
    assert.equal(target.state, 'ready');
    assert.equal(target.validation.passed, true, JSON.stringify(target.validation));
    assert.ok(opsDuring > 0, 'the app wrote while the index was built');
    // ... and goes on writing while the host has not promoted it yet.
    const opsAtReady = ops;
    await until(() => ops >= opsAtReady + 30 || opError, { timeout: 60000, what: 'writes while promotion is pending' });
    busy = false;
    await app;
    assert.equal(opError, null, opError && opError.stack);
    assert.deepEqual(await diff(), { missing: 0, extra: 0, stale: 0 }, 'the new index has every write the active one has');
    await asWritten(L.id);
    await asWritten(T);
    assert.deepEqual((await W.su.query(`SELECT DISTINCT vector_dims(embedding) AS d FROM ${tableOf(T)}`)).rows, [{ d: 1536 }]);
    assert.deepEqual((await W.su.query(`SELECT DISTINCT vector_dims(embedding) AS d FROM ${tableOf(L.id)}`)).rows, [{ d: 384 }]);
    assert.deepEqual(await catchups(), []);

    // The pending provider goes down. The app's writes still succeed; the new
    // index drops its older copy and records a catch-up instead.
    W.openai.stats.fail = true;
    const failedFrom = W.openai.stats.failed;
    const changedId = [...expected.keys()][0];
    const c1 = text('ou1');
    await vector.upsert({ source: 'busy', itemId: 'ou1', content: c1 });
    expected.set('ou1', c1);
    const askedOnce = W.openai.stats.failed;
    assert.ok(askedOnce > failedFrom, 'the pending provider was asked');
    const quick = Date.now();
    const c2 = text(changedId);
    await vector.upsert({ source: 'busy', itemId: changedId, content: c2 });
    expected.set(changedId, c2);
    await vector.upsert({ source: 'busy', itemId: 'ou2', content: text('ou2') });
    await vector.remove({ source: 'busy', itemId: 'ou2' });
    assert.ok(Date.now() - quick < 1500, 'writes right after a failure do not wait for the failing provider again');
    assert.equal(W.openai.stats.failed, askedOnce);
    assert.deepEqual(await catchups(), [{ index_id: T, item_id: changedId }, { index_id: T, item_id: 'ou1' }].sort(byItem));
    const inTarget = await contentOf(T);
    assert.ok(!inTarget.has('ou1') && !inTarget.has(changedId), 'no older copy stays in the new index');
    await asWritten(L.id);

    // Back up: the catch-up embeds them with the pending provider.
    W.openai.stats.fail = false;
    const drained = await vector.drainCatchup();
    assert.deepEqual(drained, { embedded: 2, dropped: 0, skipped: 0, remaining: 0 });
    assert.deepEqual(await diff(), { missing: 0, extra: 0, stale: 0 });
    await asWritten(T);

    // Down again right before the promotion: this write's catch-up is for the
    // index the host is about to promote.
    W.openai.stats.fail = true;
    const c3 = text('ou3');
    await vector.upsert({ source: 'busy', itemId: 'ou3', content: c3 });
    expected.set('ou3', c3);
    W.openai.stats.fail = false;
    assert.deepEqual(await catchups(), [{ index_id: T, item_id: 'ou3' }]);
    // The host promotes. The app has not heard of it yet when it writes next:
    // that write reaches the NEW active index (it re-reads the configuration
    // instead of refusing), and the catch-up follows into it.
    await W.su.query('BEGIN');
    await W.su.query("UPDATE mock2_foundation.vector_indexes SET state = 'retired', retired_at = now() WHERE id = $1", [L.id]);
    await W.su.query("UPDATE mock2_foundation.vector_indexes SET state = 'active', activated_at = now() WHERE id = $1 AND state = 'ready'", [T]);
    await W.su.query('COMMIT');
    await setSecret('embeddings.api_key', OPENAI_KEY);
    await setFeature('embeddings', { provider: 'openai', config: openaiEmbeddings(1536) });
    await deleteSecret('pending.embeddings.api_key');
    const c4 = text('ou4');
    const w = await vector.upsert({ source: 'busy', itemId: 'ou4', content: c4 });
    expected.set('ou4', c4);
    assert.equal(w.indexId, T);
    await until(async () => (await catchups()).length === 0, { timeout: 30000, what: 'the catch-up into the promoted index' });
    await asWritten(T);
    const hits = await vector.search({ query: c3, k: 1 });
    assert.equal(hits[0].itemId, 'ou3');

    W.openai.stats.fail = false;
    await W.su.query("UPDATE mock2_foundation.vector_indexes SET state = 'retired', retired_at = now() WHERE state = 'active'");
    await baseline();
  });

  test('an unreachable database is an explicit error after a short retry window, and the runtime recovers when it is back', { timeout: 180000 }, async () => {
    await W.rt.config.closeFoundation();
    await W.su.end().catch(() => {});
    W.su = null;
    docker(['stop', '-t', '5', PG]);

    const down = await cli(['health', '--json'], { ...W.cliEnv, FOUNDATION_DB_RETRY_MS: '1500' });
    assert.equal(down.status, 2);
    assert.equal(down.json.components[0].status, 'unavailable');
    assert.match(down.json.components[0].detail.message, new RegExp(`127\\.0\\.0\\.1:${W.pgPort}, database app, user app`));
    assert.match(down.json.components[0].detail.message, /never falls back/);
    assert.ok(down.ms < 15000, `gave up after the window (${down.ms} ms)`);
    await assert.rejects(W.rt.config.connectWithRetry({ retryMs: 1000, log: () => {} }), (e) => e.code === 'DATABASE_UNREACHABLE' && e.detail.attempts >= 2);

    // The CLI is started while Postgres is down; Postgres comes back 2 s later;
    // the CLI's retry loop waits for it and succeeds.
    const child = spawn(process.execPath, [contract.FOUNDATION_CLI, 'health', '--json'], { cwd: W.app, env: { ...process.env, ...W.cliEnv, FOUNDATION_DB_RETRY_MS: '60000' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const code = new Promise((resolve) => child.on('exit', resolve));
    await sleep(2000);
    docker(['start', PG]);
    assert.equal(await code, 0, stdout + stderr);
    assert.match(stderr, /waiting for the database/);
    assert.match(stderr, /database reachable after \d+ attempts/);
    assert.equal(JSON.parse(stdout).components[0].status, 'ready');
  });
});
