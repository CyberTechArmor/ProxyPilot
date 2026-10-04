import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { operationsFixture, fixtureRouter } from './helpers/operations-fixture.js';
import { createSourceMemorySetup, localBrowserArtifactsConfiguration, SOURCE_MEMORY_SETTING, SOURCE_MEMORY_QUOTA } from '../lib/operations-source-memory-setup.js';
import { createBrowserArtifactFiles } from '../lib/operational-browser-artifacts-files.js';
import { createOperationsSettingsRouter } from '../routes/operations-settings.js';

function world() {
  const f = operationsFixture(), directory = fs.mkdtempSync(path.join(os.homedir(), 'pp-source-memory-test-'));
  fs.chmodSync(directory, 0o700);
  f.db.exec(`CREATE TABLE audit_log(id TEXT PRIMARY KEY,user_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,details TEXT,ip_address TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  const root = path.join(directory, 'private'), admin = f.addUser('admin'), user = f.addUser('user'), env = { OPERATIONS_BROWSER_ARTIFACT_BOUNDARY_REVIEWED: 'false', OPERATIONS_BROWSER_ARTIFACT_DIR: '', OPERATIONS_BROWSER_ARTIFACT_QUOTA_BYTES: '' };
  const service = options => createSourceMemorySetup({ db: f.db, root, env, ...options });
  return { f, root, admin, user, env, service, close() { f.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('explicit setup verifies private file custody and actual write/read/hash/delete before audited persistence; restart reopens without enabling parsers', () => {
  const w = world(); try {
    assert.equal(w.service().status().state, 'not_configured');
    assert.equal(localBrowserArtifactsConfiguration(w.f.db, w.env, { root: w.root }).available, false);
    assert.equal(fs.existsSync(w.root), false);
    const before = structuredClone(w.env), result = w.service().enable(w.admin, '127.0.0.1');
    assert.equal(result.state, 'reload_required'); assert.deepEqual(w.env, before);
    assert.equal(fs.statSync(w.root).mode & 0o777, 0o700); assert.equal(fs.statSync(w.root).uid, process.getuid()); assert.deepEqual(fs.readdirSync(w.root), []);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1);
    assert.equal(w.f.db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'operations_toggle:%'").get().n, 0);
    const config = localBrowserArtifactsConfiguration(w.f.db, w.env, { root: w.root });
    assert.deepEqual(config, { available: true, root: w.root, quota: SOURCE_MEMORY_QUOTA, imageRunner: null, redactRunner: null, pdfRunner: null });
    const reopened = createBrowserArtifactFiles(config.root); try { reopened.verify(); } finally { reopened.close(); }
    assert.equal(w.service({ active: () => true }).status().state, 'available');
    assert.equal(w.service({ activationAttempted: () => true }).status().state, 'unavailable');
    assert.equal(w.service({ activationAttempted: () => true }).status().can_setup, false);
    assert.equal(w.service().enable(w.admin).state, 'reload_required'); // explicit retry is inert
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1);
  } finally { w.close(); }
});

test('custom settings, explicit local disable and unauthorized actors remain unchanged and unavailable', () => {
  const w = world(); try {
    assert.throws(() => w.service().enable({ ...w.user, role: 'admin' }), { status: 403 });
    for (const override of [{ OPERATIONS_BROWSER_ARTIFACT_DIR: '/owner/custom' }, { OPERATIONS_BROWSER_ARTIFACT_QUOTA_BYTES: '123' }, { OPERATIONS_BROWSER_ARTIFACT_BOUNDARY_REVIEWED: 'true' }, { OPERATIONS_BROWSER_LOCAL_STORAGE_DISABLED: 'true' }]) {
      const env = { ...w.env, ...override }, before = structuredClone(env), service = w.service({ env });
      assert.equal(service.status().can_setup, false); assert.throws(() => service.enable(w.admin), { status: 409 });
      assert.deepEqual(env, before); assert.equal(fs.existsSync(w.root), false);
      assert.equal(w.f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING), undefined);
    }
  } finally { w.close(); }
});

test('symlinks, unsafe permissions, occupied unreviewed roots and replacement identity refuse without chmod or deleting private bytes', () => {
  const w = world(); try {
    fs.symlinkSync(path.dirname(w.root), w.root); assert.throws(() => w.service().enable(w.admin), { status: 409 }); fs.unlinkSync(w.root);
    fs.mkdirSync(w.root, { mode: 0o755 }); assert.throws(() => w.service().enable(w.admin), { status: 409 }); assert.equal(fs.statSync(w.root).mode & 0o777, 0o755);
    fs.chmodSync(w.root, 0o700); fs.writeFileSync(path.join(w.root, 'preserved'), 'private'); assert.throws(() => w.service().enable(w.admin), { status: 409 }); assert.equal(fs.readFileSync(path.join(w.root, 'preserved'), 'utf8'), 'private'); fs.unlinkSync(path.join(w.root, 'preserved'));
    w.service().enable(w.admin); fs.renameSync(w.root, w.root + '-original'); fs.mkdirSync(w.root, { mode: 0o700 });
    assert.equal(w.service().status().state, 'unavailable'); assert.equal(localBrowserArtifactsConfiguration(w.f.db, w.env, { root: w.root }).available, false); assert.throws(() => w.service().enable(w.admin), { status: 409 });
    fs.rmSync(w.root + '-original', { recursive: true });
  } finally { w.close(); }
});

test('failed review transaction does not persist activation, probe objects or runtime grants', () => {
  const w = world(); try {
    w.f.db.exec("CREATE TRIGGER reject_storage_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'audit refused'); END;");
    assert.throws(() => w.service().enable(w.admin), /audit refused/);
    assert.equal(w.f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING), undefined);
    assert.deepEqual(fs.readdirSync(w.root), []); assert.equal(localBrowserArtifactsConfiguration(w.f.db, w.env, { root: w.root }).available, false);
  } finally { w.close(); }
});

test('setup route is administrator plus sudo, accepts exactly an empty object and exposes precise pending reload status', async () => {
  const w = world(); try {
    const router = createOperationsSettingsRouter({ Router: fixtureRouter, db: () => w.f.db, sourceMemory: w.service(),
      requireAdmin: (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'admin required' }),
      requireSudo: (req, res, next) => req.sudo ? next() : res.status(401).json({ sudo_required: true }) });
    const call = (user, body = {}, sudo = true) => router.dispatch({ method: 'POST', path: '/source-memory', user, body, sudo });
    assert.equal((await call(w.user)).statusCode, 403); assert.equal((await call(w.admin, {}, false)).statusCode, 401);
    for (const body of [null, true, 1, 'string', [], { path: w.root }, { enabled: true }]) assert.equal((await call(w.admin, body)).statusCode, 400);
    assert.equal(fs.existsSync(w.root), false);
    const result = await call(w.admin); assert.equal(result.statusCode, 200); assert.equal(result.body.source_memory.state, 'reload_required'); assert.ok(result.body.toggles.every(t => !t.stored));
  } finally { w.close(); }
});

test('creation races refuse occupied EEXIST and never create through a swapped ancestor', () => {
  const w = world(), mkdir = fs.mkdirSync; try {
    let raced = false;
    fs.mkdirSync = (target, options) => { if (!raced && String(target).endsWith('/private')) { raced = true; mkdir(w.root, { mode: 0o700 }); fs.writeFileSync(path.join(w.root, 'preserved'), 'private'); } return mkdir(target, options); };
    assert.throws(() => w.service().enable(w.admin), { status: 409 });
    assert.equal(fs.readFileSync(path.join(w.root, 'preserved'), 'utf8'), 'private'); assert.equal(w.f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING), undefined);
    fs.mkdirSync = mkdir; fs.rmSync(w.root, { recursive: true });
    const parent = path.join(path.dirname(w.root), 'reviewed-parent'), outside = path.join(path.dirname(w.root), 'outside'); mkdir(parent, { mode: 0o700 }); mkdir(outside, { mode: 0o700 }); const root = path.join(parent, 'private');
    raced = false; fs.mkdirSync = (target, options) => { if (!raced && String(target).endsWith('/private')) { raced = true; fs.renameSync(parent, parent + '-original'); fs.symlinkSync(outside, parent); } return mkdir(target, options); };
    assert.throws(() => w.service({ root }).enable(w.admin), { status: 409 }); assert.equal(fs.existsSync(path.join(outside, 'private')), false); assert.equal(w.f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING), undefined);
  } finally { fs.mkdirSync = mkdir; w.close(); }
});

test('replacement after successful probe or immediately before transaction review cannot bless a different inode', () => {
  for (const point of ['adapter_close', 'transaction']) {
    const w = world(), close = fs.closeSync, exec = w.f.db.exec.bind(w.f.db); let raced = false;
    const replace = () => { if (raced) return; raced = true; fs.renameSync(w.root, w.root + '-probed'); fs.mkdirSync(w.root, { mode: 0o700 }); };
    try {
      if (point === 'adapter_close') fs.closeSync = fd => { let name; try { name = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch {} const result = close(fd); if (name === w.root) replace(); return result; };
      else w.f.db.exec = sql => { const result = exec(sql); if (sql === 'BEGIN IMMEDIATE') replace(); return result; };
      assert.throws(() => w.service().enable(w.admin), { status: 409 }); assert(raced); assert.equal(w.f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING), undefined); assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);
    } finally { fs.closeSync = close; w.close(); }
  }
});

test('exact0700, safe ancestors, explicit disable and malformed or unlinked review receipts fail closed', () => {
  const w = world(); try {
    for (const mode of [0o500, 0o300, 0o000]) { fs.mkdirSync(w.root, { mode }); assert.throws(() => w.service().enable(w.admin), { status: 409 }); assert.equal(fs.statSync(w.root).mode & 0o777, mode); fs.rmdirSync(w.root); }
    fs.chmodSync(path.dirname(w.root), 0o777); assert.throws(() => w.service().enable(w.admin), { status: 409 }); fs.chmodSync(path.dirname(w.root), 0o700);
    w.service().enable(w.admin); const saved = w.f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING).value;
    for (const value of ['not-json', '{}', JSON.stringify({ ...JSON.parse(saved), verified_at: 'invalid' }), JSON.stringify({ ...JSON.parse(saved), reviewed_by: 'not-an-actor' })]) { w.f.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(value, SOURCE_MEMORY_SETTING); assert.equal(w.service().status().state, 'unavailable'); assert.equal(localBrowserArtifactsConfiguration(w.f.db, w.env, { root: w.root }).available, false); }
    w.f.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(saved, SOURCE_MEMORY_SETTING);
    assert.equal(localBrowserArtifactsConfiguration(w.f.db, { ...w.env, OPERATIONS_BROWSER_LOCAL_STORAGE_DISABLED: 'true' }, { root: w.root }).available, false);
    for (const mode of [0o500, 0o000]) { fs.chmodSync(w.root, mode); assert.equal(w.service({ active: () => true }).status().state, 'unavailable'); assert.equal(localBrowserArtifactsConfiguration(w.f.db, w.env, { root: w.root }).available, false); } fs.chmodSync(w.root, 0o700);
    w.f.db.exec('DELETE FROM audit_log'); assert.equal(localBrowserArtifactsConfiguration(w.f.db, w.env, { root: w.root }).available, false);
  } finally { w.close(); }
});

test('cleanup refusal still closes the pinned adapter, preserves unknown replacement bytes and never persists activation', () => {
  const w = world(), sync = fs.fsyncSync, close = fs.closeSync; let raced = false, closed = false;
  try {
    fs.fsyncSync = fd => { const name = fs.readlinkSync(`/proc/self/fd/${fd}`); const result = sync(fd); if (!raced && name.endsWith('.blob')) { raced = true; fs.renameSync(w.root, w.root + '-probed'); fs.mkdirSync(w.root, { mode: 0o700 }); fs.writeFileSync(path.join(w.root, 'preserved'), 'private'); } return result; };
    fs.closeSync = fd => { let name; try { name = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch {} if (name === w.root + '-probed') closed = true; return close(fd); };
    assert.throws(() => w.service().enable(w.admin)); assert(raced && closed); assert.equal(fs.readFileSync(path.join(w.root, 'preserved'), 'utf8'), 'private'); assert.equal(w.f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING), undefined);
  } finally { fs.fsyncSync = sync; fs.closeSync = close; w.close(); }
});

test('a copied setting alone and cross-root restore refuse; full same-host review plus audit continuation retains only the same physical storage capability', () => {
  const w = world(), restored = world(); try {
    w.service().enable(w.admin); const value = w.f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING).value;
    restored.f.db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(SOURCE_MEMORY_SETTING, value);
    assert.equal(localBrowserArtifactsConfiguration(restored.f.db, w.env, { root: w.root }).available, false);
    const audit = w.f.db.prepare('SELECT * FROM audit_log').get(); restored.f.db.prepare('INSERT INTO audit_log(id,user_id,action,resource_type,resource_id,details,ip_address) VALUES(?,?,?,?,?,?,?)').run(audit.id,audit.user_id,audit.action,audit.resource_type,audit.resource_id,audit.details,audit.ip_address);
    assert.equal(localBrowserArtifactsConfiguration(restored.f.db, w.env, { root: w.root }).available, true);
    assert.equal(localBrowserArtifactsConfiguration(restored.f.db, w.env, { root: restored.root }).available, false);
    const checkoutRoot = new URL('../../../../..', import.meta.url).pathname;
    assert.equal(w.service({ root: path.join(checkoutRoot, 'uncreated-private') }).status().can_setup, false);
  } finally { w.close(); restored.close(); }
});

test('real HTTP route preserves double-submit CSRF and sudo before any filesystem mutation', async () => {
  const { default: express } = await import('express'), { csrfProtection } = await import('../middleware/csrf.js');
  const w = world(), app = express(); let server;
  try {
    app.use(express.json()); app.use((req, _res, next) => { req.user = w.admin; req.cookies = { pp_csrf: 'fixture-csrf' }; next(); }); app.use('/api', csrfProtection);
    app.use('/api/operations-settings', createOperationsSettingsRouter({ Router: express.Router, db: () => w.f.db, sourceMemory: w.service(), requireAdmin: (_req,_res,next) => next(), requireSudo: (req,res,next) => req.headers['x-fixture-sudo'] === 'fresh' ? next() : res.status(401).json({ sudo_required: true }) }));
    server = await new Promise(resolve => { const opened = app.listen(0, '127.0.0.1', () => resolve(opened)); }); const url = `http://127.0.0.1:${server.address().port}/api/operations-settings/source-memory`;
    const post = headers => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await post({ 'x-fixture-sudo': 'fresh' })).status, 403); assert.equal(fs.existsSync(w.root), false);
    assert.equal((await post({ 'x-csrf-token': 'fixture-csrf' })).status, 401); assert.equal(fs.existsSync(w.root), false);
    const result = await post({ 'x-fixture-sudo': 'fresh', 'x-csrf-token': 'fixture-csrf' }); assert.equal(result.status, 200); assert.equal((await result.json()).source_memory.state, 'reload_required');
  } finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } w.close(); }
});

test('the active runtime file adapter refuses lost owner permissions on verify, read and write', () => {
  const w = world(); try {
    w.service().enable(w.admin); const files = createBrowserArtifactFiles(w.root), id = '22222222-2222-4222-8222-222222222222', bytes = Buffer.from('private'), pins = files.write(id, bytes);
    try {
      for (const mode of [0o500, 0o000]) {
        fs.chmodSync(w.root, mode); assert.throws(() => files.verify(), /unavailable/); assert.throws(() => files.read(id, pins), /unavailable/); assert.throws(() => files.write('33333333-3333-4333-8333-333333333333', bytes), /unavailable/);
        assert.equal(w.service({ active: () => true }).status().state, 'unavailable');
      }
    } finally { fs.chmodSync(w.root, 0o700); files.close(); bytes.fill(0); }
  } finally { w.close(); }
});
