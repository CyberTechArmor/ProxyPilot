// END-TO-END: the application foundation's REAL host code paths against REAL
// containers, with this sandbox standing in for the guest (FOUNDATION_E2E=1).
//
//   FOUNDATION_E2E=1 node --test src/__tests__/foundation-e2e.docker.test.js
//
// What is real:
//   * mock2.db — a temp better-sqlite3 file with every mock2 migration
//     (mock2/db.js initMock2Db through DATABASE_PATH), one foundation project;
//   * the host control plane — foundation-store.js, foundation-service.js and
//     foundation-routes.js mounted on an express router (requireRole / sudo /
//     archived checks are pass-through: they are the mock2 router's, not the
//     foundation's), driven over HTTP;
//   * the guest stack — foundation-stack.js bring-up through mock2/host.js
//     runHost('incus', …): the SAME generated compose.yaml / pg_hba / init files
//     run as a Compose project on this Docker daemon;
//   * the app — the full Dev Studio seed (template.js buildSeedFiles), its
//     runtime dependencies npm-installed, and its own foundation CLI and
//     adapters ('#foundation') — over the REAL peer-auth Unix socket, as root,
//     like the guest's app unit: no TCP, no password, no trust auth.
//
// What stands in:
//   * `incus` and `systemd-run` are the test shims in helpers/
//     foundation-e2e-shims.js (first on PATH): `incus exec` runs here, with a
//     clean environment; `systemd-run` starts the job DETACHED. The guest's
//     /srv/app is the test's app dir, and the guest's /etc/environment adds the
//     test layout's DATABASE_URL (the socket in a temp dir) and
//     FOUNDATION_KEY_FILE (the master key in a temp dir).
//   * The layout: Compose project, socket dir, key file, stack dir and volumes
//     are unique (i2-fnd-<pid>, a temp dir). The bundled S3 must publish
//     127.0.0.1:8333: the bundled storage endpoint is the contract's fixed
//     address (defaultFeatures), not part of the layout.
//   * "External" S3 (Cloudflare R2 in production) is a second SeaweedFS,
//     container i2-ext-s3, with its own identities.
//   * Embeddings: THE LOCAL MODEL (text-embeddings-inference) IS NOT PROVEN
//     HERE — its image (ghcr.io) and weights (huggingface.co) cannot be fetched
//     in this sandbox. Bring-up runs with embeddings off; the provider is then
//     switched to `openai_compatible` in-process fakes (384 dimensions, no key;
//     1536 dimensions behind an API key).
//
// Everything created (containers, volumes, networks prefixed i2-, the temp dir,
// detached job processes) is removed at the end, also on failure.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { installGuestShims, startedUnitPids, unitLogs } from './helpers/foundation-e2e-shims.js';

const E2E = process.env.FOUNDATION_E2E === '1';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const HAS_DOCKER = E2E && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
const SKIP = !E2E ? 'set FOUNDATION_E2E=1 to run the end-to-end foundation test (Docker + npm registry)'
  : !IS_ROOT ? 'needs root: peer authentication maps the guest root to the app role'
    : !HAS_DOCKER ? 'needs a reachable Docker daemon' : false;

const PID = process.pid;
const GUEST = 'i2-guest';
const PROJECT = `i2-fnd-${PID}`;
const EXT = 'i2-ext-s3';
const PROJECT_ID = 4242;
const KEY_1536 = `i2k-${crypto.randomBytes(12).toString('hex')}`;
const BUNDLED_S3_PORT = 8333;

const W = { api: [], audits: [] }; // the world
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- processes ----------------------------------------------------------------

// Asynchronous on purpose: the fake embedding servers and the API live in THIS
// process, so a blocking spawnSync would stall them under a running job.
function run(cmd, args, { input = null, timeoutMs = 180000, env = null, cwd = undefined, uid = undefined } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, uid, gid: uid, env: env || process.env, stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: null, stdout: '', stderr: e.message }); return; }
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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function until(fn, { timeoutMs = 120000, everyMs = 500, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await sleep(everyMs);
  }
}

// ---- fake OpenAI-compatible embedding servers ----------------------------------------

// Deterministic: each token lands on 4 signed coordinates, so texts sharing
// words are close and others near-orthogonal (self-retrieval is exact).
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
  const stats = { requests: 0, inputs: 0, refused: 0, auth: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') { res.writeHead(404); res.end(); return; }
      stats.auth.add(req.headers.authorization || '(none)');
      if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
        stats.refused += 1;
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
        return;
      }
      const body = JSON.parse(raw);
      stats.requests += 1;
      stats.inputs += body.input.length;
      const data = body.input.map((t, i) => ({ object: 'embedding', index: i, embedding: fakeVector(t, dims) })).reverse();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', model: body.model, data, usage: { prompt_tokens: 1, total_tokens: 1 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, stats, port, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

// ---- the host API (foundation-routes.js on an express router) ------------------

async function api(method, route, body) {
  const res = await fetch(`${W.apiBase}/projects/${PROJECT_ID}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  W.api.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const getFoundationApi = async () => {
  const r = await api('GET', '/foundation');
  assert.equal(r.status, 200, r.text);
  return r.body;
};

// Poll a job the way production does: index.js's sweep and the dashboard's
// GET /jobs/:id and GET /foundation, OVERLAPPING (a promotion takes seconds).
// job.seen = every state any poll reported.
async function waitJob(jobId, { timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  for (;;) {
    const [, r, f] = await Promise.all([W.service.sweepFoundationJobs(), api('GET', `/foundation/jobs/${jobId}`), api('GET', '/foundation')]);
    assert.equal(r.status, 200, r.text);
    const job = r.body.job;
    seen.add(job.state);
    for (const j of f.body?.jobs || []) if (j.id === jobId) seen.add(j.state);
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return { ...job, seen: [...seen] };
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish: ${JSON.stringify(job)}\n${unitLogs(W.stateDir)}`);
    await sleep(1000);
  }
}

// ---- the app (feature code over '#foundation', in the "guest") ----------------

const PROBE = String.raw`// i2 e2e: feature-code stand-in. Uses '#foundation' only (no S3 SDK, no
// embedding HTTP), loaded after the bootstrap exactly like the app's start script.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { storage, vector, getFoundation, isFoundationUnavailable } from '#foundation';

const out = (v) => { process.stdout.write('I2_RESULT:' + JSON.stringify(v) + '\n'); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]));
}
const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'put-dir') {
    const keys = [];
    for (const key of walk(args[0])) { await storage.put(key, fs.readFileSync(path.join(args[0], key))); keys.push(key); }
    out({ ok: true, keys });
  } else if (cmd === 'put') {
    await storage.put(args[0], Buffer.from(args[1]));
    out({ ok: true });
  } else if (cmd === 'list-sha') {
    const items = {};
    for await (const it of storage.listAll({})) {
      const buf = await storage.getBuffer(it.key);
      items[it.key] = { size: buf.length, sha256: sha(buf) };
    }
    const st = getFoundation().features.storage;
    out({ ok: true, items, provider: st.provider, endpoint: st.config.endpoint });
  } else if (cmd === 'upsert') {
    const results = await vector.upsertMany(JSON.parse(fs.readFileSync(args[0], 'utf8')));
    out({ ok: true, results });
  } else if (cmd === 'search') {
    const hits = await vector.search({ query: args[0], k: Number(args[1] || 3) });
    out({ ok: true, hits: hits.map((h) => ({ itemId: h.itemId, source: h.source, score: h.score })), index: await vector.activeIndex() });
  } else if (cmd === 'indexes') {
    out({ ok: true, indexes: await vector.listIndexes() });
  } else {
    out({ ok: false, code: 'USAGE', message: 'unknown probe command ' + cmd });
  }
} catch (err) {
  out({ ok: false, code: err && err.code ? err.code : null, unavailable: isFoundationUnavailable(err), message: err && err.message });
}
process.exit(0);
`;

// `incus exec i2-guest --cwd /srv/app -- node --import=<bootstrap> i2-probe.mjs …`
async function app(...args) {
  const r = await run('incus', ['exec', GUEST, '--cwd', '/srv/app', '--', 'node', '--import=./foundation/runtime/bootstrap.mjs', 'i2-probe.mjs', ...args], { timeoutMs: 180000 });
  const line = String(r.stdout).split('\n').reverse().find((l) => l.startsWith('I2_RESULT:'));
  assert.ok(line, `the app probe printed no result (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice('I2_RESULT:'.length));
}

// The host's own CLI path (foundation-stack.js foundationCli, as root, peer auth).
async function cli(args, timeoutMs = 120000) {
  const r = await W.stack.foundationCli(GUEST, args, { appDir: '/srv/app', timeoutMs });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { ...r, json };
}

// Superuser SQL in the app database (foundation-stack.js foundationPsql).
async function sql(text) {
  const r = await W.stack.foundationPsql(GUEST, text, { database: 'app' });
  assert.equal(r.code, 0, `psql failed: ${r.stderr}`);
  return String(r.stdout).trim();
}

async function serviceState(service) {
  const r = await docker(['inspect', '-f', '{{.State.Status}}', `${PROJECT}-${service}-1`]);
  return r.code === 0 ? r.stdout.trim() : 'absent';
}

// ---- the suite -------------------------------------------------------------------

describe('application foundation end to end (host control plane + guest stack + app over the peer socket)', { skip: SKIP }, () => {
  before(async () => {
    const t0 = Date.now();
    assert.ok(await portFree(BUNDLED_S3_PORT), `127.0.0.1:${BUNDLED_S3_PORT} is in use: the bundled S3 must publish there (the contract's fixed endpoint)`);
    W.base = fs.mkdtempSync(path.join(os.tmpdir(), 'i2-fe2e-'));
    fs.chmodSync(W.base, 0o755);
    W.bin = path.join(W.base, 'bin');
    W.stateDir = path.join(W.base, 'state');
    W.appDir = path.join(W.base, 'app');
    W.objectsDir = path.join(W.base, 'objects');
    W.guestEnv = path.join(W.base, 'guest-environment');
    W.shimLog = path.join(W.base, 'shim.log');
    for (const d of [W.stateDir, W.appDir, W.objectsDir, path.join(W.base, 'db')]) fs.mkdirSync(d, { recursive: true });
    installGuestShims(W.bin);
    W.etcEnvironment = fs.existsSync('/etc/environment') ? fs.readFileSync('/etc/environment', 'utf8') : null;

    // Environment for the product modules (read at import time) and the shims.
    Object.assign(process.env, {
      DATABASE_PATH: path.join(W.base, 'db', 'proxypilot.db'),
      TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      PATH: `${W.bin}:${process.env.PATH}`,
      I2_GUEST: GUEST, I2_APP_DIR: W.appDir, I2_STATE_DIR: W.stateDir, I2_GUEST_ENV: W.guestEnv, I2_BIN: W.bin, I2_SHIM_LOG: W.shimLog,
    });

    W.contract = await import('../mock2/foundation-contract.js');
    const logic = await import('../mock2/foundation-stack-logic.js');
    W.layout = logic.resolveLayout({
      composeProject: PROJECT,
      dir: path.join(W.base, 'stack'),
      keyFile: path.join(W.base, 'key', 'master.key'),
      socketDir: path.join(W.base, 'sock'),
      volumes: { postgres: `${PROJECT}-pg`, storage: `${PROJECT}-s3`, embeddings: `${PROJECT}-embed` },
      ports: { postgres: await freePort(), storage: BUNDLED_S3_PORT, embeddings: await freePort() },
    });
    fs.writeFileSync(W.guestEnv, [
      `DATABASE_URL=postgres:///app?host=${W.layout.socketDir}&user=app`,
      `FOUNDATION_KEY_FILE=${W.layout.keyFile}`,
      '',
    ].join('\n'));
    W.stack = await import('../mock2/foundation-stack.js');
    W.stack._setFoundationGuestExecForTests(null, { layout: W.layout }); // the REAL incus runner, the test layout
    const mock2Db = await import('../mock2/db.js');
    W.db = mock2Db.initMock2Db();
    W.store = await import('../mock2/foundation-store.js');
    W.service = await import('../mock2/foundation-service.js');
    W.service.resetFoundationServiceCaches();
    W.db.prepare(`INSERT INTO mock2_projects (id, name, repo_path, lifecycle, container_name, created_at, foundation_version) VALUES (?, ?, '', 'active', ?, ?, ?)`)
      .run(PROJECT_ID, 'i2 e2e', GUEST, new Date().toISOString(), W.contract.FOUNDATION_VERSION);

    // The host API.
    const express = (await import('express')).default;
    const { registerFoundationRoutes } = await import('../mock2/foundation-routes.js');
    const router = express.Router();
    const pass = (_req, _res, next) => next();
    registerFoundationRoutes(router, {
      requireRole: () => pass, requireSudo: pass, refuseIfArchived: pass,
      audit: (_req, action, projectId, detail) => { W.audits.push({ action, projectId, detail }); },
      service: W.service,
    });
    const web = express();
    web.use(express.json());
    web.use('/api/mock2', router);
    await new Promise((resolve) => { W.web = web.listen(0, '127.0.0.1', resolve); });
    W.apiBase = `http://127.0.0.1:${W.web.address().port}/api/mock2`;

    // The app: the full seed, its runtime dependencies, the probe.
    const { buildSeedFiles } = await import('../mock2/template.js');
    for (const f of buildSeedFiles({ name: 'i2 e2e' })) {
      const p = path.join(W.appDir, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content, { mode: f.mode || 0o644 });
    }
    fs.writeFileSync(path.join(W.appDir, 'i2-probe.mjs'), PROBE);
    const t1 = Date.now();
    const npm = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: W.appDir, timeoutMs: 600000 });
    assert.equal(npm.code, 0, `npm install failed: ${npm.stderr}`);
    console.log(`[i2] npm install --omit=dev of the seed: ${Math.round((Date.now() - t1) / 1000)} s`);

    // Fake embedding providers.
    W.fake384 = await fakeEmbeddingServer({ dims: 384 });
    W.fake1536 = await fakeEmbeddingServer({ dims: 1536, apiKey: KEY_1536 });

    // The "external" S3: SeaweedFS with its own identities (R2 in production).
    W.extPort = await freePort();
    W.extApp = { accessKeyId: `I2EXT${crypto.randomBytes(8).toString('hex').toUpperCase()}`, secretAccessKey: crypto.randomBytes(24).toString('base64url') };
    W.extAdmin = { accessKeyId: `I2EXA${crypto.randomBytes(8).toString('hex').toUpperCase()}`, secretAccessKey: crypto.randomBytes(24).toString('base64url') };
    fs.mkdirSync(path.join(W.base, 'ext'));
    fs.writeFileSync(path.join(W.base, 'ext', 's3.json'), JSON.stringify({
      identities: [
        { name: 'admin', credentials: [{ accessKey: W.extAdmin.accessKeyId, secretKey: W.extAdmin.secretAccessKey }], actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'] },
        { name: 'app', credentials: [{ accessKey: W.extApp.accessKeyId, secretKey: W.extApp.secretAccessKey }], actions: ['Read:ext', 'Write:ext', 'List:ext', 'Tagging:ext'] },
      ],
    }));
    await docker(['rm', '-f', '-v', EXT]);
    const ext = await docker(['run', '-d', '--name', EXT, '-p', `127.0.0.1:${W.extPort}:8333`, '-v', `${path.join(W.base, 'ext')}:/cfg:ro`,
      W.contract.STACK.storage.image, 'server', '-dir=/data', '-s3', '-s3.port=8333', '-s3.config=/cfg/s3.json']);
    assert.equal(ext.code, 0, `starting ${EXT} failed: ${ext.stderr}`);
    const s3 = await import('@aws-sdk/client-s3');
    W.s3 = s3;
    W.extAdminClient = new s3.S3Client({
      endpoint: `http://127.0.0.1:${W.extPort}`, region: 'us-east-1', forcePathStyle: true, credentials: W.extAdmin,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
    await until(() => W.extAdminClient.send(new s3.ListBucketsCommand({})).then(() => true), { what: EXT });
    await W.extAdminClient.send(new s3.CreateBucketCommand({ Bucket: 'ext' }));
    console.log(`[i2] setup: ${Math.round((Date.now() - t0) / 1000)} s`);
  }, { timeout: 900000 });

  after(async () => {
    for (const pid of startedUnitPids(W.stateDir || '/nonexistent')) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { W.extAdminClient?.destroy(); } catch { /* best effort */ }
    for (const s of [W.fake384, W.fake1536]) { try { s?.server.close(); } catch { /* best effort */ } }
    try { W.web?.close(); } catch { /* best effort */ }
    if (W.layout) await compose(['down', '-v', '--remove-orphans', '--timeout', '5'], { timeoutMs: 180000 });
    await docker(['rm', '-f', '-v', EXT]);
    // Belt and braces: anything of this run's project left behind.
    const ids = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`])).stdout.split('\n').filter(Boolean);
    if (ids.length) await docker(['rm', '-f', '-v', ...ids]);
    for (const v of ['pg', 's3', 'embed']) await docker(['volume', 'rm', '-f', `${PROJECT}-${v}`]);
    for (const n of ['storage', 'embeddings', 'default']) await docker(['network', 'rm', `${PROJECT}_${n}`]);
    try { W.stack?._setFoundationGuestExecForTests(); } catch { /* best effort */ }
    try { W.db?.close(); } catch { /* best effort */ }
    if (W.base) fs.rmSync(W.base, { recursive: true, force: true });
  });

  // ---- 1 --------------------------------------------------------------------------
  test('1. bring-up from nothing, idempotent re-run, schema present, health ready through the CLI over the peer socket', { timeout: 900000 }, async () => {
    const { store, stack, contract, layout } = W;
    // The provisioning inputs are generated once (encrypted) and stable.
    const first = store.getFoundationProvisionInputs(PROJECT_ID);
    assert.equal(first.features.storage.provider, 'bundled');
    assert.equal(first.features.embeddings.provider, 'local');
    // The local embedding model cannot be fetched here: bring-up with embeddings off.
    const rows = store.readFeatureRows(PROJECT_ID);
    store.writeFeature(PROJECT_ID, 'embeddings', { state: 'off', provider: rows.embeddings.provider, config: rows.embeddings.config, pending: null });
    const inputs = store.getFoundationProvisionInputs(PROJECT_ID);
    assert.equal(inputs.masterKey, first.masterKey, 'the master key is stable');
    assert.deepEqual(inputs.storageCredentials, first.storageCredentials, 'the storage identities are stable');
    assert.equal(inputs.features.embeddings.state, 'off');
    W.inputs = inputs;

    // provision.js provisionFoundation, step by step (it is not exported).
    const key = await stack.ensureMasterKey(GUEST, inputs.masterKey);
    assert.equal(key.ok, true, key.error);
    const t0 = Date.now();
    const up = await stack.bringUpFoundation({ containerName: GUEST, features: inputs.features, masterKey: inputs.masterKey, storageCredentials: inputs.storageCredentials });
    assert.equal(up.ok, true, `bring-up failed: ${up.error}\n${JSON.stringify(up.steps, null, 1)}`);
    assert.deepEqual(up.steps.map((s) => s.name), ['docker', 'master-key', 'files', 'pull', 'up', 'healthy', 'schema', 'storage-identities', 'features']);
    console.log(`[i2] bring-up from nothing: ${Math.round((Date.now() - t0) / 1000)} s`);
    const sync1 = await store.syncFoundationToApp(PROJECT_ID);
    assert.equal(sync1.ok, true, sync1.error);
    assert.equal(fs.statSync(layout.keyFile).mode & 0o777, 0o600);
    assert.equal(await serviceState('postgres'), 'running');
    assert.equal(await serviceState('storage'), 'running');
    assert.equal(await serviceState('embeddings'), 'absent', 'embeddings are off: never started');

    // Idempotent re-run: nothing recreated, nothing rewritten, the sync moves on.
    const idsBefore = (await compose(['ps', '-aq'])).stdout.split('\n').filter(Boolean).sort();
    const again = await stack.bringUpFoundation({ containerName: GUEST, features: inputs.features, masterKey: inputs.masterKey, storageCredentials: inputs.storageCredentials });
    assert.equal(again.ok, true, again.error);
    const detail = Object.fromEntries(again.steps.map((s) => [s.name, s.detail]));
    assert.match(detail['master-key'], /unchanged/);
    assert.equal(detail.files, 'unchanged');
    assert.match(detail.pull, /all images already present/);
    assert.deepEqual((await compose(['ps', '-aq'])).stdout.split('\n').filter(Boolean).sort(), idsBefore, 'no container was recreated');
    const sync2 = await store.syncFoundationToApp(PROJECT_ID);
    assert.equal(sync2.ok, true, sync2.error);
    assert.equal(sync2.generation, sync1.generation + 1);

    // Schema: pgvector + every mock2_foundation table; only app secrets synced.
    assert.match(await sql("SELECT extversion FROM pg_extension WHERE extname = 'vector';"), /^0\.8\.\d+$/);
    const tables = (await sql("SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'mock2_foundation';")).split(',');
    assert.deepEqual(tables, ['features', 'health', 'jobs', 'meta', 'secrets', 'storage_migration_items', 'vector_indexes']);
    assert.equal(await sql("SELECT string_agg(feature || ':' || state || ':' || provider, ',' ORDER BY feature) FROM mock2_foundation.features;"), 'embeddings:off:local,storage:on:bundled');
    assert.equal(await sql("SELECT string_agg(name, ',' ORDER BY name) FROM mock2_foundation.secrets;"), 'storage.access_key_id,storage.secret_access_key');

    // Health through the app's own CLI, as the host runs it: root over the socket.
    const h = await cli(['health', '--json']);
    assert.equal(h.code, 0, `${h.stdout}\n${h.stderr}`);
    const by = Object.fromEntries(h.json.components.map((c) => [c.component, c]));
    assert.equal(by.database.status, 'ready');
    assert.equal(by.database.detail.vector, true, 'a real vector operation ran');
    assert.equal(by.database.detail.target, `socket ${layout.socketDir}, database app, user app`, 'peer auth over the Unix socket');
    assert.equal(by.storage.status, 'ready');
    assert.equal(by.storage.detail.provider, 'bundled');
    assert.equal(by.storage.detail.anonymous_refused, true);
    assert.equal(by.embeddings.status, 'off');
    // Peer authentication is real: another OS user on the same socket is refused.
    const nobody = await run('psql', ['-X', '-tAc', 'SELECT 1', `host=${layout.socketDir} user=app dbname=app`], { uid: 65534, cwd: '/' });
    assert.notEqual(nobody.code, 0);
    assert.match(nobody.stderr, /Peer authentication failed/);

    // Embeddings on: an OpenAI-compatible provider with no key (the fake, 384).
    const sw = await api('POST', '/foundation/embeddings', { action: 'switch', provider: 'openai_compatible', config: { base_url: W.fake384.baseUrl, model: 'i2-fake-384', dimensions: 384 } });
    assert.equal(sw.status, 200, sw.text);
    assert.equal(sw.body.promoted, true, sw.text);
    assert.equal(sw.body.reembedded, false, 'no index yet: promoted at once');
    const f = await getFoundationApi();
    assert.equal(f.foundation_version, contract.FOUNDATION_VERSION);
    assert.equal(f.database.health.status, 'ready');
    assert.equal(f.storage.health.status, 'ready');
    assert.equal(f.embeddings.state, 'on');
    assert.equal(f.embeddings.provider, 'openai_compatible');
    assert.equal(f.embeddings.config.dimensions, 384);
    assert.equal(f.embeddings.health.status, 'ready', JSON.stringify(f.embeddings.health));
    assert.equal(f.embeddings.health.detail.returned_dimensions, 384);
    assert.ok(W.fake384.stats.requests >= 2, 'the pending test and the health probe embedded through the fake');
  });

  // ---- 2 --------------------------------------------------------------------------
  test('2. the app puts and gets objects in bundled storage through its storage adapter', { timeout: 300000 }, async () => {
    const objects = new Map([
      ['docs/readme.txt', Buffer.from('hello foundation\n')],
      ['docs/nested/deep/data.json', Buffer.from(JSON.stringify({ a: 1, b: [2, 3] }))],
      ['bin/random-1m.bin', crypto.randomBytes(1024 * 1024)],
      ['bin/random-7m.bin', crypto.randomBytes(7 * 1024 * 1024)], // multipart
      ['empty.bin', Buffer.alloc(0)],
      ['ünïcode name.txt', Buffer.from('unicode key')],
    ]);
    for (const [k, v] of objects) {
      fs.mkdirSync(path.dirname(path.join(W.objectsDir, k)), { recursive: true });
      fs.writeFileSync(path.join(W.objectsDir, k), v);
    }
    W.expected = Object.fromEntries([...objects].map(([k, v]) => [k, { size: v.length, sha256: sha(v) }]));
    const put = await app('put-dir', W.objectsDir);
    assert.equal(put.ok, true, JSON.stringify(put));
    assert.deepEqual(put.keys.sort(), [...objects.keys()].sort());
    const listed = await app('list-sha');
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.provider, 'bundled');
    assert.deepEqual(listed.items, W.expected);
    assert.equal(await W.stack.bundledStorageObjectCount(GUEST, W.store.bundledAdminCredentials(PROJECT_ID)), objects.size);
  });

  // ---- 3 --------------------------------------------------------------------------
  test('3. bundled storage holding objects cannot be turned off: STORAGE_HAS_OBJECTS with the options', async () => {
    const r = await api('POST', '/foundation/storage', { action: 'off' });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.code, 'STORAGE_HAS_OBJECTS');
    assert.match(r.body.message, /6 object/);
    assert.deepEqual(r.body.options.map((o) => [o.provider, o.mode, o.acknowledge === true]), [['external', 'copy', false], ['external', 'fresh', true]]);
    const f = await getFoundationApi();
    assert.equal(f.storage.state, 'on');
    assert.equal(await serviceState('storage'), 'running');
  });

  // ---- 4 --------------------------------------------------------------------------
  test('4. switch to external S3 with mode copy: staged, tested in the guest, detached storage_migrate, promoted; bundled stopped, volume kept', { timeout: 600000 }, async () => {
    const config = { endpoint: `http://127.0.0.1:${W.extPort}`, bucket: 'ext', region: 'us-east-1', prefix: 'i2' };
    const credentials = { access_key_id: W.extApp.accessKeyId, secret_access_key: W.extApp.secretAccessKey };
    const r = await api('POST', '/foundation/storage', { action: 'switch', provider: 'external', config, credentials, mode: 'copy' });
    assert.equal(r.status, 202, r.text);
    const jobId = r.body.job.id;
    assert.equal(r.body.job.kind, 'storage_migrate');
    // While it runs: staged and tested, and nothing promoted yet.
    const during = await getFoundationApi();
    assert.equal(during.storage.provider, 'bundled');
    assert.equal(during.storage.pending.provider, 'external');
    assert.equal(during.storage.pending.config.prefix, 'i2/');
    assert.equal(during.storage.pending.test.ok, true, JSON.stringify(during.storage.pending.test));
    assert.equal(during.storage.pending.has_secret, true);
    // The detached unit the host started.
    const units = fs.readdirSync(path.join(W.stateDir, 'units'));
    assert.ok(units.includes(`mock2-foundation-job-${jobId}.pid`), `no detached unit for ${jobId}: ${units}`);

    const job = await waitJob(jobId);
    assert.equal(job.state, 'succeeded', `${JSON.stringify(job)}\n${unitLogs(W.stateDir)}`);
    assert.ok(!job.seen.includes('failed'), `a poll reported the job failed: ${job.seen}`);
    assert.equal(job.progress.phase, 'promoted');
    assert.equal(await sql(`SELECT count(*) FROM mock2_foundation.storage_migration_items WHERE job_id = '${jobId}' AND state = 'verified';`), '6');

    const f = await getFoundationApi();
    assert.equal(f.storage.provider, 'external');
    assert.equal(f.storage.state, 'on');
    assert.equal(f.storage.pending, null);
    assert.equal(f.storage.has_secret, true);
    assert.equal(f.storage.config.endpoint, config.endpoint);
    assert.ok(f.warnings.some((w) => w.code === 'PLAINTEXT_STORAGE_ENDPOINT'));
    assert.equal(f.storage.health.status, 'ready', JSON.stringify(f.storage.health));
    // The bundled container is stopped; its volume is kept.
    assert.equal(await serviceState('storage'), 'exited');
    assert.equal((await docker(['volume', 'inspect', W.layout.volumes.storage])).code, 0, 'the bundled volume is kept');
    // The app reads every object from external, byte-identical.
    const listed = await app('list-sha');
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.provider, 'external');
    assert.deepEqual(listed.items, W.expected);
    // …and they really are on the external S3, under the prefix.
    const raw = await W.extAdminClient.send(new W.s3.ListObjectsV2Command({ Bucket: 'ext', Prefix: 'i2/' }));
    assert.deepEqual((raw.Contents || []).map((o) => o.Key).sort(), Object.keys(W.expected).map((k) => `i2/${k}`).sort());
    // A new object lands on external only.
    assert.equal((await app('put', 'after-switch.txt', 'written while external')).ok, true);
  });

  // ---- 5 --------------------------------------------------------------------------
  test('5. back to bundled with mode fresh + acknowledge: the same container and volume, the old objects visible again', { timeout: 300000 }, async () => {
    const noAck = await api('POST', '/foundation/storage', { action: 'switch', provider: 'bundled', mode: 'fresh' });
    assert.equal(noAck.status, 409, noAck.text);
    assert.equal(noAck.body.code, 'ACKNOWLEDGE_REQUIRED');
    const r = await api('POST', '/foundation/storage', { action: 'switch', provider: 'bundled', mode: 'fresh', acknowledge: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.promoted, true, r.text);
    assert.equal(await serviceState('storage'), 'running');
    const f = await getFoundationApi();
    assert.equal(f.storage.provider, 'bundled');
    assert.equal(f.storage.health.status, 'ready', JSON.stringify(f.storage.health));
    const listed = await app('list-sha');
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.provider, 'bundled');
    assert.deepEqual(listed.items, W.expected, 'the preserved volume brings the old objects back; nothing written on external was copied');
    // External is untouched (its objects stay there).
    const raw = await W.extAdminClient.send(new W.s3.ListObjectsV2Command({ Bucket: 'ext', Prefix: 'i2/' }));
    assert.equal((raw.Contents || []).length, Object.keys(W.expected).length + 1);
  });

  // ---- 6 --------------------------------------------------------------------------
  const DOCS = [
    ['zebra', 'The zebra has black and white stripes and lives on the savanna'],
    ['penguin', 'Penguins are flightless birds that swim in cold antarctic water'],
    ['volcano', 'A volcano erupts molten lava ash and sulfur gas'],
    ['piano', 'The piano has eighty eight keys hammers and strings'],
    ['espresso', 'Espresso is strong coffee brewed under pressure'],
    ['glacier', 'A glacier is a slow river of compacted ice'],
    ['comet', 'A comet trails a tail of dust and ice past the sun'],
    ['cactus', 'The cactus stores water in its thick spiny stem'],
    ['violin', 'The violin is played with a bow across four strings'],
    ['lighthouse', 'A lighthouse guides ships with a rotating beam of light'],
    ['honeybee', 'Honeybees gather nectar and pollen to make honey'],
    ['canyon', 'A canyon is a deep gorge carved by a river'],
  ];
  test('6. embeddings provider/dimension switch (384 → 1536): reembed job, validated, promoted; search on the new index; old index retired; no mixed dimensions', { timeout: 600000 }, async () => {
    const itemsFile = path.join(W.base, 'items.json');
    fs.writeFileSync(itemsFile, JSON.stringify(DOCS.map(([id, content]) => ({ source: 'kb', itemId: id, content, metadata: { title: id } }))));
    const up = await app('upsert', itemsFile);
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.ok(up.results.every((x) => x.embedded && x.inserted));
    const s1 = await app('search', 'zebra stripes', '3');
    assert.equal(s1.ok, true, JSON.stringify(s1));
    assert.equal(s1.hits[0].itemId, 'zebra');
    assert.equal(s1.index.dimensions, 384);
    const oldIndex = s1.index;

    const r = await api('POST', '/foundation/embeddings', { action: 'switch', provider: 'openai_compatible', config: { base_url: W.fake1536.baseUrl, model: 'i2-fake-1536', dimensions: 1536 }, credentials: { api_key: KEY_1536 } });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.body.job.kind, 'reembed');
    const target = r.body.job.target_index;
    assert.ok(target);
    const job = await waitJob(r.body.job.id);
    assert.equal(job.state, 'succeeded', `${JSON.stringify(job)}\n${unitLogs(W.stateDir)}`);
    assert.ok(!job.seen.includes('failed'), `a poll reported the job failed: ${job.seen}`);

    const ix = await app('indexes');
    assert.equal(ix.ok, true, JSON.stringify(ix));
    const byId = Object.fromEntries(ix.indexes.map((i) => [i.id, i]));
    assert.equal(byId[target].state, 'active');
    assert.equal(byId[target].dimensions, 1536);
    assert.equal(byId[target].item_count, DOCS.length);
    assert.equal(byId[target].validation.passed, true, JSON.stringify(byId[target].validation));
    assert.equal(byId[oldIndex.id].state, 'retired', 'the old index is retired, not deleted');
    assert.equal(ix.indexes.filter((i) => i.state === 'active').length, 1);
    // Both tables exist; each holds one dimension only.
    assert.equal(await sql(`SELECT string_agg(DISTINCT vector_dims(embedding)::text, ',') || '/' || count(*) FROM mock2_foundation.${byId[target].table_name};`), `1536/${DOCS.length}`);
    assert.equal(await sql(`SELECT string_agg(DISTINCT vector_dims(embedding)::text, ',') || '/' || count(*) FROM mock2_foundation.${oldIndex.table_name};`), `384/${DOCS.length}`);
    assert.equal(await sql(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'mock2_foundation.${byId[target].table_name}'::regclass AND attname = 'embedding';`), 'vector(1536)');

    const s2 = await app('search', 'zebra stripes', '3');
    assert.equal(s2.ok, true, JSON.stringify(s2));
    assert.equal(s2.hits[0].itemId, 'zebra');
    assert.equal(s2.index.id, target);
    assert.ok(W.fake1536.stats.requests > 0 && [...W.fake1536.stats.auth].includes(`Bearer ${KEY_1536}`), 'the app opened the sealed API key');
    const f = await getFoundationApi();
    assert.equal(f.embeddings.provider, 'openai_compatible');
    assert.equal(f.embeddings.config.dimensions, 1536);
    assert.equal(f.embeddings.has_secret, true);
    assert.equal(f.embeddings.pending, null);
    assert.equal(f.embeddings.health.status, 'ready', JSON.stringify(f.embeddings.health));
    W.activeIndex = byId[target];
  });

  // ---- 7 --------------------------------------------------------------------------
  test('7. embeddings off: search answers EMBEDDINGS_OFF and the vectors are kept; on again: search works', { timeout: 300000 }, async () => {
    const off = await api('POST', '/foundation/embeddings', { action: 'off' });
    assert.equal(off.status, 200, off.text);
    const s = await app('search', 'zebra stripes');
    assert.equal(s.ok, false);
    assert.equal(s.code, 'EMBEDDINGS_OFF');
    assert.equal(await sql(`SELECT count(*) FROM mock2_foundation.${W.activeIndex.table_name};`), String(DOCS.length));
    const f = await getFoundationApi();
    assert.equal(f.embeddings.state, 'off');
    assert.equal(f.embeddings.health.status, 'off');
    const on = await api('POST', '/foundation/embeddings', { action: 'on' });
    assert.equal(on.status, 200, on.text);
    const s2 = await app('search', 'penguins swim', '1');
    assert.equal(s2.ok, true, JSON.stringify(s2));
    assert.equal(s2.hits[0].itemId, 'penguin');
    assert.equal(s2.index.id, W.activeIndex.id, 'the same index, not rebuilt');
  });

  // ---- 8 --------------------------------------------------------------------------
  test('8. missing credentials: OpenAI with no key is refused, a key-less switch to a keyed server reports missing_credentials from the guest; nothing switched', { timeout: 300000 }, async () => {
    const before = await getFoundationApi();
    const r = await api('POST', '/foundation/embeddings', { action: 'switch', provider: 'openai', config: { model: 'text-embedding-3-small' } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.code, 'MISSING_CREDENTIALS');
    let f = await getFoundationApi();
    assert.equal(f.embeddings.provider, before.embeddings.provider);
    assert.equal(f.embeddings.pending, null, 'nothing was staged');
    assert.ok(!W.store.listSecretNames(PROJECT_ID).some((n) => n.startsWith('pending.')));

    // An OpenAI-compatible address that wants a key, given none: staged, tested
    // inside the guest, reported missing_credentials (never ready), not promoted.
    const refusedBefore = W.fake1536.stats.refused;
    const r2 = await api('POST', '/foundation/embeddings', { action: 'switch', provider: 'openai_compatible', config: { base_url: `http://localhost:${W.fake1536.port}/v1`, model: 'i2-fake-1536', dimensions: 1536 } });
    assert.equal(r2.status, 409, r2.text);
    assert.equal(r2.body.code, 'MISSING_CREDENTIALS');
    assert.ok(W.fake1536.stats.refused > refusedBefore, 'the guest really asked the provider');
    f = await getFoundationApi();
    assert.equal(f.embeddings.config.base_url, W.fake1536.baseUrl, 'the active provider is unchanged');
    assert.equal(f.embeddings.pending.test.ok, false);
    assert.equal(f.embeddings.pending.test.status, 'missing_credentials');
    assert.equal(f.embeddings.health.status, 'ready', 'the active provider keeps working');
    assert.equal(await sql("SELECT config->>'base_url' FROM mock2_foundation.features WHERE feature = 'embeddings';"), W.fake1536.baseUrl);
  });

  // ---- 9 --------------------------------------------------------------------------
  test('9. no secret value anywhere: /etc/environment, the app dir, the stack files, container env, API responses, argv, mock2.db (ciphertext only)', { timeout: 300000 }, async () => {
    const { inputs, store } = W;
    const secrets = {
      master_key: inputs.masterKey,
      bundled_app_id: inputs.storageCredentials.app.accessKeyId,
      bundled_app_secret: inputs.storageCredentials.app.secretAccessKey,
      bundled_admin_id: inputs.storageCredentials.admin.accessKeyId,
      bundled_admin_secret: inputs.storageCredentials.admin.secretAccessKey,
      external_id: W.extApp.accessKeyId,
      external_secret: W.extApp.secretAccessKey,
      embeddings_api_key: KEY_1536,
    };
    const leaks = (label, text) => Object.entries(secrets).filter(([, v]) => String(text).includes(v)).map(([k]) => `${k} in ${label}`);
    const found = [];
    const etc = fs.existsSync('/etc/environment') ? fs.readFileSync('/etc/environment', 'utf8') : null;
    assert.equal(etc, W.etcEnvironment, '/etc/environment was not written');
    found.push(...leaks('/etc/environment', etc || ''));
    for (const [label, dir] of [['the app dir', W.appDir], ['the stack dir', W.layout.dir]]) {
      const g = await run('grep', ['-rlF', ...Object.values(secrets).flatMap((v) => ['-e', v]), dir]);
      assert.ok(g.code === 1 || g.code === 0, g.stderr);
      if (g.stdout.trim()) found.push(`${label}: ${g.stdout.trim()}`);
    }
    const ids = (await compose(['ps', '-aq'])).stdout.split('\n').filter(Boolean);
    assert.ok(ids.length >= 2);
    const inspect = await docker(['inspect', ...ids]);
    assert.equal(inspect.code, 0, inspect.stderr);
    found.push(...leaks('docker inspect (env, cmd, labels)', inspect.stdout));
    found.push(...leaks('API responses', W.api.join('\n')));
    found.push(...leaks('audit entries', JSON.stringify(W.audits)));
    found.push(...leaks('incus / systemd-run argv', fs.readFileSync(W.shimLog, 'utf8')));
    found.push(...leaks('detached job logs', unitLogs(W.stateDir)));
    // mock2.db on disk (the file and its WAL): ciphertext only.
    const dbPath = W.db.name;
    for (const f of [dbPath, `${dbPath}-wal`]) if (fs.existsSync(f)) found.push(...leaks(path.basename(f), fs.readFileSync(f).toString('latin1')));
    const rows = W.db.prepare('SELECT name, ciphertext FROM mock2_foundation_secrets WHERE project_id = ?').all(PROJECT_ID);
    assert.ok(rows.length >= 8, `secret rows: ${rows.map((r) => r.name)}`);
    for (const r of rows) assert.match(r.ciphertext, /^enc:v1:/, `${r.name} is not encrypted at rest`);
    assert.equal(store.readSecret(PROJECT_ID, 'embeddings.api_key'), KEY_1536, 'the ciphertext opens to the value');
    // The app database: sealed values only, no host-only secret.
    const appSecrets = await sql("SELECT string_agg(name || '=' || left(sealed, 5), ',' ORDER BY name) FROM mock2_foundation.secrets;");
    assert.equal(appSecrets, 'embeddings.api_key=mfs1:,storage.access_key_id=mfs1:,storage.secret_access_key=mfs1:', 'app secrets only, every one sealed; no host-only secret');
    const appDump = await sql("SELECT string_agg(t::text, E'\\n') FROM (SELECT row_to_json(s)::text AS t FROM mock2_foundation.secrets s UNION ALL SELECT row_to_json(f)::text FROM mock2_foundation.features f UNION ALL SELECT row_to_json(j)::text FROM mock2_foundation.jobs j) x;");
    found.push(...leaks('the app database (secrets, features, jobs rows)', appDump));
    assert.deepEqual(found, [], `secret values leaked:\n${found.join('\n')}`);
  });

  // ---- 10 -------------------------------------------------------------------------
  test('10. failure and recovery: postgres stopped → database unavailable (CLI exit 2); started → ready again', { timeout: 600000 }, async () => {
    const stop = await compose(['stop', 'postgres'], { timeoutMs: 120000 });
    assert.equal(stop.code, 0, stop.stderr);
    const down = await cli(['health', '--json'], 120000);
    assert.equal(down.code, 2, `${down.stdout}\n${down.stderr}`);
    const db = down.json.components.find((c) => c.component === 'database');
    assert.equal(db.status, 'unavailable');
    const viaApi = await api('POST', '/foundation/health');
    assert.equal(viaApi.status, 200, viaApi.text);
    assert.equal(viaApi.body.database.health.status, 'unavailable');
    assert.notEqual(viaApi.body.storage.health.status, 'ready');

    // Back through the product's own service start (up -d, same volume).
    const start = await W.stack.foundationCompose(GUEST, ['up', '-d', '--no-deps', 'postgres'], { timeoutMs: 300000 });
    assert.equal(start.code, 0, start.stderr);
    await until(async () => {
      const st = await W.stack.foundationServiceStatus(GUEST);
      return st?.find((s) => s.service === 'postgres')?.health === 'healthy';
    }, { timeoutMs: 180000, everyMs: 2000, what: 'postgres healthy again' });
    const upAgain = await cli(['health', '--json'], 120000);
    assert.equal(upAgain.code, 0, `${upAgain.stdout}\n${upAgain.stderr}`);
    assert.deepEqual(upAgain.json.components.map((c) => [c.component, c.status]), [['database', 'ready'], ['storage', 'ready'], ['embeddings', 'ready']]);
    const viaApi2 = await api('POST', '/foundation/health');
    assert.equal(viaApi2.body.database.health.status, 'ready');
    // The data survived: the same vectors answer.
    const s = await app('search', 'lava volcano', '1');
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.hits[0].itemId, 'volcano');
  });
});
