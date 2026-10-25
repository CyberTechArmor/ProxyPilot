// Application foundation — the HOST STORE (mock2/foundation-store.js) over
// migration 564, and the project create path (mock2/projects.js):
//   * migration 564: the three tables + mock2_projects.foundation_version;
//   * every secret is encrypted at rest (lib/secrets.js) — no plaintext in a row;
//   * the stack's provisioning inputs are generated once and stable;
//   * the sync seals every app secret under the master key (they open with the
//     contract's openForApp), never syncs host-only ones, never puts a
//     plaintext secret in the SQL, deletes app-DB secrets that no longer exist;
//   * component secrets for foundation deployments (mint, never overwrite,
//     delivered by the sync; a FULL clone takes only its source's data-guarding
//     keys, a fresh clone none — the token signing key is always its own);
//   * new projects get FOUNDATION_VERSION, a clone inherits, delete purges.
// ./db.js and ./foundation-stack.js are stubbed at the module boundary.

import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { installFoundationHooks, freshMock2Db, addProject, scriptedStack, world } from './helpers/foundation-world.js';
import { MOCK2_MIGRATIONS } from '../mock2/migrations.js';
import { openForApp, SECRET_NAMES, FOUNDATION_VERSION, defaultFeatures } from '../mock2/foundation-contract.js';
import { BUNDLED_APP_IDENTITY } from '../mock2/foundation-logic.js';

process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);
installFoundationHooks();
const store = await import('../mock2/foundation-store.js');
const projects = await import('../mock2/projects.js');

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test('migration 564 is registered after 563, creates the foundation tables and adds foundation_version; re-running is harmless', () => {
  const m = MOCK2_MIGRATIONS.find((x) => x.version === 564);
  assert.ok(m);
  assert.equal(m.name, 'mock2_app_foundation');
  assert.ok(MOCK2_MIGRATIONS.findIndex((x) => x.version === 564) > MOCK2_MIGRATIONS.findIndex((x) => x.version === 563));
  const versions = MOCK2_MIGRATIONS.map((x) => x.version);
  assert.equal(new Set(versions).size, versions.length);
  const db = freshMock2Db();
  assert.deepEqual(cols(db, 'mock2_foundation_features'), ['project_id', 'feature', 'state', 'provider', 'config_json', 'pending_json', 'updated_at']);
  assert.deepEqual(cols(db, 'mock2_foundation_secrets'), ['project_id', 'name', 'ciphertext', 'created_at', 'rotated_at']);
  assert.deepEqual(cols(db, 'mock2_foundation_jobs'), ['id', 'project_id', 'kind', 'state', 'params_json', 'progress_json', 'error', 'created_by', 'created_at', 'updated_at', 'finished_at']);
  assert.ok(cols(db, 'mock2_projects').includes('foundation_version'));
  m.up(db);
  assert.throws(() => db.prepare("INSERT INTO mock2_foundation_features (project_id, feature, state, provider, updated_at) VALUES (1, 'search', 'on', 'x', 'now')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO mock2_foundation_jobs (id, project_id, kind, state, created_at, updated_at) VALUES ('j', 1, 'backup', 'queued', 'n', 'n')").run(), /CHECK/);
  assert.match(m.up.toString(), /CREATE TABLE IF NOT EXISTS mock2_foundation_secrets/, 'the DDL is written out in the migration');
});

test('provisioning inputs: generated once, stable, encrypted at rest; app identity = bundled identity; admin distinct', () => {
  const db = freshMock2Db();
  addProject(db, { id: 1 });
  const a = store.getFoundationProvisionInputs(1);
  const b = store.getFoundationProvisionInputs(1);
  assert.deepEqual(a, b, 'stable afterwards');
  assert.equal(Buffer.from(a.masterKey, 'base64').length, 32);
  assert.deepEqual(a.features, Object.fromEntries(Object.entries(defaultFeatures()).map(([k, v]) => [k, v])));
  assert.match(a.storageCredentials.app.accessKeyId, /^[A-Z2-7]{20}$/);
  assert.ok(a.storageCredentials.app.secretAccessKey.length >= 40);
  assert.notEqual(a.storageCredentials.admin.accessKeyId, a.storageCredentials.app.accessKeyId);
  assert.equal(store.readSecret(1, SECRET_NAMES.storageAccessKeyId), a.storageCredentials.app.accessKeyId, 'the active app credentials start as the bundled identity');
  const rows = db.prepare('SELECT name, ciphertext FROM mock2_foundation_secrets WHERE project_id = 1').all();
  assert.deepEqual(rows.map((r) => r.name).sort(), [BUNDLED_APP_IDENTITY.accessKeyId, BUNDLED_APP_IDENTITY.secretAccessKey, SECRET_NAMES.masterKey, SECRET_NAMES.storageAccessKeyId, SECRET_NAMES.storageAdminAccessKeyId, SECRET_NAMES.storageAdminSecretAccessKey, SECRET_NAMES.storageSecretAccessKey].sort());
  const plaintexts = [a.masterKey, a.storageCredentials.app.accessKeyId, a.storageCredentials.app.secretAccessKey, a.storageCredentials.admin.accessKeyId, a.storageCredentials.admin.secretAccessKey];
  for (const r of rows) {
    assert.match(r.ciphertext, /^enc:v1:/);
    for (const p of plaintexts) assert.equal(r.ciphertext.includes(p), false, `plaintext of ${r.name} at rest`);
  }
  const dump = JSON.stringify(db.prepare('SELECT * FROM mock2_foundation_secrets').all()) + JSON.stringify(db.prepare('SELECT * FROM mock2_foundation_features').all());
  for (const p of plaintexts) assert.equal(dump.includes(p), false);
  addProject(db, { id: 2, foundationVersion: null });
  assert.throws(() => store.getFoundationProvisionInputs(2), /not a foundation deployment/);
});

test('writeSecret: encrypted, rotated_at only on a real change; insertSecretIfAbsent never overwrites; names are checked', () => {
  const db = freshMock2Db();
  addProject(db, { id: 1 });
  assert.deepEqual(store.writeSecret(1, SECRET_NAMES.embeddingsApiKey, 'sk-one-0123456789'), { created: true, rotated: false });
  assert.deepEqual(store.writeSecret(1, SECRET_NAMES.embeddingsApiKey, 'sk-one-0123456789'), { created: false, rotated: false });
  assert.deepEqual(store.writeSecret(1, SECRET_NAMES.embeddingsApiKey, 'sk-two-0123456789'), { created: false, rotated: true });
  assert.ok(db.prepare('SELECT rotated_at FROM mock2_foundation_secrets WHERE name = ?').get(SECRET_NAMES.embeddingsApiKey).rotated_at);
  assert.equal(store.insertSecretIfAbsent(1, SECRET_NAMES.embeddingsApiKey, 'sk-three-0123456789'), false);
  assert.equal(store.readSecret(1, SECRET_NAMES.embeddingsApiKey), 'sk-two-0123456789');
  assert.throws(() => store.writeSecret(1, 'arbitrary', 'x'), /invalid foundation secret name/);
  assert.throws(() => store.writeSecret(1, SECRET_NAMES.embeddingsApiKey, ''), /empty/);
});

test('syncFoundationToApp: sealed values open with the contract; no plaintext and no host-only secret in the SQL; on stdin through foundationPsql', async () => {
  const db = freshMock2Db();
  addProject(db, { id: 1 });
  const { guest, calls } = scriptedStack();
  const inputs = store.getFoundationProvisionInputs(1);
  store.writeSecret(1, SECRET_NAMES.embeddingsApiKey, 'sk-live-abcdef0123456789');
  store.writeSecret(1, 'component.AUTH_MASTER_SECRET', 'component-secret-value-xyz');
  const r = await store.syncFoundationToApp(1);
  assert.deepEqual(r, { ok: true, generation: 1 });
  assert.equal(calls.psql.length, 1);
  assert.equal(calls.psql[0].container, 'm2-p1');
  assert.equal(calls.psql[0].opts.database, 'app');
  const sql = guest.lastSync;
  for (const p of [inputs.masterKey, inputs.storageCredentials.app.secretAccessKey, inputs.storageCredentials.admin.accessKeyId, inputs.storageCredentials.admin.secretAccessKey, 'sk-live-abcdef0123456789', 'component-secret-value-xyz']) {
    assert.equal(sql.includes(p), false, 'a plaintext secret reached the SQL');
  }
  for (const hostOnly of [SECRET_NAMES.masterKey, SECRET_NAMES.storageAdminAccessKeyId, SECRET_NAMES.storageAdminSecretAccessKey, BUNDLED_APP_IDENTITY.accessKeyId]) {
    assert.equal(sql.includes(`'${hostOnly}'`), false, `${hostOnly} must never be synced`);
  }
  const sealed = Object.fromEntries([...sql.matchAll(/INSERT INTO mock2_foundation\.secrets \(name, sealed, generation, updated_at\) VALUES \('([^']+)', '([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(sealed).sort(), ['component.AUTH_MASTER_SECRET', 'embeddings.api_key', 'storage.access_key_id', 'storage.secret_access_key']);
  assert.equal(openForApp(inputs.masterKey, 'embeddings.api_key', sealed['embeddings.api_key']), 'sk-live-abcdef0123456789');
  assert.equal(openForApp(inputs.masterKey, 'component.AUTH_MASTER_SECRET', sealed['component.AUTH_MASTER_SECRET']), 'component-secret-value-xyz');
  assert.equal(openForApp(inputs.masterKey, 'storage.access_key_id', sealed['storage.access_key_id']), inputs.storageCredentials.app.accessKeyId);
  assert.throws(() => openForApp(inputs.masterKey, 'storage.access_key_id', sealed['embeddings.api_key']), 'a sealed value cannot be moved to another name');
  assert.match(sql, /DELETE FROM mock2_foundation\.secrets WHERE name NOT IN \(/);
  assert.match(sql, /pg_notify\('mock2_foundation_changed'/);
  // A secret removed from the store is removed from the app DB on the next sync.
  store.deleteSecrets(1, [SECRET_NAMES.embeddingsApiKey]);
  assert.equal((await store.syncFoundationToApp(1)).generation, 2);
  assert.match(guest.lastSync, /DELETE FROM mock2_foundation\.secrets WHERE name NOT IN \('component\.AUTH_MASTER_SECRET', 'storage\.access_key_id', 'storage\.secret_access_key'\);/);
  // Failures are returned, never thrown, and carry no secret.
  guest.failSync = true;
  const bad = await store.syncFoundationToApp(1);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /did not accept/);
  addProject(db, { id: 3 });
  assert.match((await store.syncFoundationToApp(3)).error, /no master key/);
  addProject(db, { id: 4, foundationVersion: null });
  assert.match((await store.syncFoundationToApp(4)).error, /not a foundation deployment/);
});

test('syncs for one deployment are serialized in the order requested', async () => {
  const db = freshMock2Db();
  addProject(db, { id: 1 });
  const { stack } = scriptedStack();
  store.getFoundationProvisionInputs(1);
  const order = [];
  const real = stack.foundationPsql;
  let n = 0;
  stack.foundationPsql = async (...a) => { const me = ++n; order.push(`start${me}`); await new Promise((r) => setTimeout(r, me === 1 ? 30 : 1)); order.push(`end${me}`); return real(...a); };
  await Promise.all([store.syncFoundationToApp(1), store.syncFoundationToApp(1)]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
});

test('component secrets: minted encrypted as component.<KEY>, never overwritten, delivered by the sync; data-guarded keys only on fresh storage', async () => {
  const db = freshMock2Db();
  addProject(db, { id: 1 });
  const { guest } = scriptedStack();
  store.getFoundationProvisionInputs(1);
  const project = store.getFoundationProject(1);
  const guard = { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'n' };
  const configs = [{ key: 'AUTH_JWT_SECRET', secret: true, generate: true }, { key: 'AUTH_MASTER_SECRET', secret: true, generate: true, protects: guard }];
  const existing = await store.mintFoundationComponentSecrets({ project, configs, newlyProvisioned: false });
  assert.deepEqual(existing.minted, ['AUTH_JWT_SECRET']);
  assert.deepEqual(existing.deferred.map((d) => d.key), ['AUTH_MASTER_SECRET']);
  assert.deepEqual(existing.delivered, ['AUTH_JWT_SECRET']);
  const first = store.readSecret(1, 'component.AUTH_JWT_SECRET');
  assert.ok(first.length >= 40);
  guest.guardTable = false;
  const fresh = await store.mintFoundationComponentSecrets({ project, configs, newlyProvisioned: true });
  assert.deepEqual(fresh.minted, ['AUTH_MASTER_SECRET']);
  assert.deepEqual(fresh.held, ['AUTH_JWT_SECRET']);
  assert.equal(store.readSecret(1, 'component.AUTH_JWT_SECRET'), first, 'never overwritten');
  assert.ok(guest.lastSync.includes("'component.AUTH_MASTER_SECRET'"));
  for (const v of [first, store.readSecret(1, 'component.AUTH_MASTER_SECRET')]) {
    assert.equal(guest.lastSync.includes(v), false);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM mock2_foundation_secrets').all()).includes(v), false);
  }
  // A guarded table that holds rows defers, even on a "new" deployment.
  addProject(db, { id: 2 });
  store.getFoundationProvisionInputs(2);
  guest.guardTable = true; guest.guardRows = true;
  const rows = await store.mintFoundationComponentSecrets({ project: store.getFoundationProject(2), configs: [configs[1]], newlyProvisioned: true });
  assert.deepEqual(rows.minted, []);
  assert.match(rows.deferred[0].reason, /rows/);
  // A failed sync: stored, not delivered — and reported.
  guest.failSync = true;
  const undelivered = await store.mintFoundationComponentSecrets({ project, configs: [{ key: 'NEW_KEY', secret: true, generate: true }] });
  assert.equal(undelivered.ok, false);
  assert.deepEqual(undelivered.delivered, []);
  assert.ok(store.hasSecret(1, 'component.NEW_KEY'));
  const ref = await store.foundationDeployParams({ project, configs: [{ key: 'NEW_KEY', secret: true, generate: true }], deliver: false });
  assert.deepEqual(ref, { version: FOUNDATION_VERSION, required: ['NEW_KEY'], delivered: [] }, 'without deliver: names held, nothing written or synced');
});

test('projects.createProject: a new project gets FOUNDATION_VERSION; a clone inherits its source; existing rows stay NULL; delete purges foundation rows', () => {
  const db = freshMock2Db();
  addProject(db, { id: 50, foundationVersion: null });
  const fresh = projects.createProject({ name: 'New', createdBy: 1 });
  assert.equal(fresh.foundation_version, FOUNDATION_VERSION);
  const cloneOfFoundation = projects.createProject({ name: 'Clone', createdBy: 1, origin: { kind: 'clone', sourceProjectId: fresh.id, mode: 'fresh' } });
  assert.equal(cloneOfFoundation.foundation_version, FOUNDATION_VERSION);
  const cloneOfLegacy = projects.createProject({ name: 'Old clone', createdBy: 1, origin: { kind: 'clone', sourceProjectId: 50, mode: 'full' } });
  assert.equal(cloneOfLegacy.foundation_version, null, 'a clone of a pre-foundation project keeps the native stack');
  assert.equal(projects.getProject(50).foundation_version, null, 'existing rows untouched');
  // The clone is its own deployment (its component keys: the next test).
  db.prepare('UPDATE mock2_projects SET container_name = ? WHERE id = ?').run('m2-src', fresh.id);
  store.getFoundationProvisionInputs(fresh.id);
  store.writeSecret(fresh.id, 'component.AUTH_MASTER_SECRET', 'source-master-secret-value');
  const cloneInputs = store.getFoundationProvisionInputs(cloneOfFoundation.id);
  assert.equal(store.hasSecret(cloneOfFoundation.id, 'component.AUTH_MASTER_SECRET'), false, 'a fresh clone takes no component key');
  assert.notEqual(cloneInputs.masterKey, store.readSecret(fresh.id, SECRET_NAMES.masterKey), 'the clone is its own deployment');
  store.insertJob({ id: 'fj_0123456789ab', projectId: fresh.id, kind: 'reembed' });
  assert.equal(projects.deleteProject(fresh.id), true);
  for (const t of ['mock2_foundation_secrets', 'mock2_foundation_features', 'mock2_foundation_jobs']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`).get(fresh.id).n, 0, t);
  }
  assert.ok(store.hasSecret(cloneOfFoundation.id, SECRET_NAMES.masterKey), 'other deployments untouched');
});

test('clones: a FULL clone takes only the data-guarding component keys; a fresh clone none; the JWT signing key is never shared', async () => {
  const db = freshMock2Db();
  const { guest } = scriptedStack();
  guest.guardTable = false;
  const components = await import('../mock2/components.js');
  const { parseContractJson } = await import('../mock2/component-logic.js');
  const seed = JSON.parse(readFileSync(new URL('../mock2/framework-seed/proxypilot-auth.component.json', import.meta.url), 'utf8'));
  const { component, version } = components.insertComponent({ key: 'proxypilot-auth', name: 'Auth', files: [], contract: seed.contract, change_reason: 'seed', createdBy: 1 });
  const configs = parseContractJson(JSON.stringify(seed.contract)).config.filter((c) => c.secret && c.generate);
  assert.deepEqual(configs.map((c) => c.key), ['AUTH_JWT_SECRET', 'AUTH_MASTER_SECRET'], 'the real auth contract: a signing key and a data-guarding key');
  const withContainer = (p, name) => { db.prepare('UPDATE mock2_projects SET container_name = ? WHERE id = ?').run(name, p.id); return store.getFoundationProject(p.id); };
  const source = withContainer(projects.createProject({ name: 'Source', createdBy: 1 }), 'm2-src');
  const pc = components.decideProjectComponent({ projectId: source.id, componentId: component.id, versionId: version.id, status: 'confirmed' });
  components.markProjectComponentInstall({ id: pc.id, ok: true, versionId: version.id });
  store.getFoundationProvisionInputs(source.id);
  await store.mintFoundationComponentSecrets({ project: source, configs, newlyProvisioned: true });
  const srcJwt = store.readSecret(source.id, 'component.AUTH_JWT_SECRET');
  const srcMaster = store.readSecret(source.id, 'component.AUTH_MASTER_SECRET');
  assert.ok(srcJwt && srcMaster);
  for (const mode of ['full', 'fresh']) {
    const clone = withContainer(projects.createProject({ name: `Clone ${mode}`, createdBy: 1, origin: { kind: 'clone', sourceProjectId: source.id, mode } }), `m2-c${mode}`);
    store.getFoundationProvisionInputs(clone.id);
    const taken = store.listSecretNames(clone.id).filter((n) => n.startsWith('component.'));
    assert.deepEqual(taken, mode === 'full' ? ['component.AUTH_MASTER_SECRET'] : [], `${mode}: what the first provisioning takes from the source`);
    // The clone's first deploy mints the rest (a full clone holds existing data).
    const minted = await store.mintFoundationComponentSecrets({ project: clone, configs, newlyProvisioned: mode === 'fresh' });
    assert.deepEqual(minted.deferred, [], mode);
    const jwt = store.readSecret(clone.id, 'component.AUTH_JWT_SECRET');
    assert.ok(jwt);
    assert.notEqual(jwt, srcJwt, `${mode}: a token signed by the source must not verify on the clone`);
    const master = store.readSecret(clone.id, 'component.AUTH_MASTER_SECRET');
    if (mode === 'full') assert.equal(master, srcMaster, 'full: the copied rows stay readable');
    else assert.notEqual(master, srcMaster, 'fresh: a new database gets its own key');
  }
  assert.equal(store.readSecret(source.id, 'component.AUTH_JWT_SECRET'), srcJwt, 'the source is untouched');
});

test('clones: a FULL clone starts on its source\'s embedding provider (non-secret config, never the key); storage stays its own bundled default', async () => {
  const db = freshMock2Db();
  scriptedStack();
  const { projectFoundation } = await import('../mock2/foundation-logic.js');
  const source = projects.createProject({ name: 'Source', createdBy: 1 });
  store.getFoundationProvisionInputs(source.id);
  const openaiCfg = { base_url: 'https://api.openai.com/v1', model: 'text-embedding-3-large', dimensions: 1024, metric: 'cosine' };
  store.writeFeature(source.id, 'embeddings', { state: 'on', provider: 'openai', config: openaiCfg, pending: null });
  store.writeSecret(source.id, SECRET_NAMES.embeddingsApiKey, 'sk-source-key-0123456789');
  store.writeFeature(source.id, 'storage', { state: 'on', provider: 'external', config: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'source-files', prefix: '', force_path_style: true }, pending: null });
  const full = projects.createProject({ name: 'Full', createdBy: 1, origin: { kind: 'clone', sourceProjectId: source.id, mode: 'full' } });
  const fresh = projects.createProject({ name: 'Fresh', createdBy: 1, origin: { kind: 'clone', sourceProjectId: source.id, mode: 'fresh' } });
  const fullInputs = store.getFoundationProvisionInputs(full.id);
  const freshInputs = store.getFoundationProvisionInputs(fresh.id);
  assert.deepEqual(fullInputs.features.embeddings, { state: 'on', provider: 'openai', config: openaiCfg }, 'the full clone\'s indexes match');
  assert.deepEqual(fullInputs.features.storage, defaultFeatures().storage, 'never the source\'s bucket');
  assert.deepEqual(freshInputs.features, defaultFeatures(), 'a fresh clone starts on the defaults');
  assert.equal(store.hasSecret(full.id, SECRET_NAMES.embeddingsApiKey), false, 'the key is never copied');
  const view = projectFoundation({ project: store.getFoundationProject(full.id), rows: store.readFeatureRows(full.id), secretNames: store.listSecretNames(full.id) });
  assert.equal(view.embeddings.health.status, 'missing_credentials');
  assert.equal(store.readFeatureRows(source.id).embeddings.provider, 'openai', 'the source is untouched');
});

test('the project JSON the dashboard receives carries foundation_version', async () => {
  const { publicProjectShape } = await import('../mock2/project-logic.js');
  assert.equal(publicProjectShape({ id: 1, name: 'x', lifecycle: 'active', foundation_version: FOUNDATION_VERSION }).foundation_version, FOUNDATION_VERSION);
  assert.equal(publicProjectShape({ id: 2, name: 'y', lifecycle: 'active' }).foundation_version, null);
});

test('jobs: one active per deployment is visible to the store; updates redact', () => {
  const db = freshMock2Db();
  addProject(db, { id: 1 });
  assert.equal(store.activeJobFor(1), null);
  store.insertJob({ id: 'fj_aaaaaaaaaaaa', projectId: 1, kind: 'storage_migrate', params: { from: { provider: 'bundled' } }, createdBy: 3 });
  assert.equal(store.activeJobFor(1).id, 'fj_aaaaaaaaaaaa');
  store.updateJob('fj_aaaaaaaaaaaa', { state: 'failed', error: 'Incorrect API key provided: sk-abcdefghijklmnopq', finished: true });
  const j = store.getJob('fj_aaaaaaaaaaaa');
  assert.equal(j.error.includes('abcdefghijklmnopq'), false);
  assert.ok(j.finished_at);
  assert.equal(store.activeJobFor(1), null);
  assert.equal(world.db, db);
  assert.throws(() => store.insertJob({ id: 'bad', projectId: 1, kind: 'reembed' }), /invalid job id/);
});
