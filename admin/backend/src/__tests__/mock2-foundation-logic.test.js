// Application foundation — the host control plane's PURE rules
// (mock2/foundation-logic.js), one test per rule in
// docs/features/app-foundation.md § "Feature switches and their rules", plus
// provider validation, the projections (which can never carry a secret), the
// SQL sent to the app database (escaping, no plaintext), and the
// component-secret mint rule for foundation deployments.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODES, BUNDLED_APP_IDENTITY, planStorageAction, planEmbeddingsAction, needsReembed, validateStorageConfig,
  validateEmbeddingsConfig, validateCredentials, isValidBucketName, projectFoundation, projectJob, featureRowsFrom,
  interpretCliTest, parseHealthOutput, redactSecrets, sqlLiteral, buildSyncSql, buildJobInsertSql, buildJobPollSql,
  buildCancelJobSql, promoteIndexStatements, buildGuardProbeSql, buildGuardRowsSql, parseGeneration, parseJsonRows,
  planFoundationComponentMint, normalizeFoundationDeployRef, appSecretNames, isHostOnlySecret, isStorableSecretName,
  serviceStillUsed, OPENAI_DEFAULT_MODEL, newJobId, isValidJobId,
} from '../mock2/foundation-logic.js';
import {
  FOUNDATION_VERSION, LOCAL_EMBEDDINGS_WARNING, DEPENDENT_CAPABILITIES, SECRET_NAMES, STACK, defaultFeatures, FOUNDATION_NOTIFY_CHANNEL,
} from '../mock2/foundation-contract.js';

const S3 = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'my-app-files', region: 'auto', prefix: 'prod' };
const CREDS = { access_key_id: 'AKIAEXAMPLEKEY123456', secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const bundledOn = (extra = {}) => ({ ...defaultFeatures().storage, pending: null, secretNames: new Set([SECRET_NAMES.storageAccessKeyId, SECRET_NAMES.storageSecretAccessKey]), activeJob: null, ...extra });
const externalOn = (extra = {}) => ({ state: 'on', provider: 'external', config: validateStorageConfig(S3).config, pending: null, secretNames: new Set([SECRET_NAMES.storageAccessKeyId, SECRET_NAMES.storageSecretAccessKey]), activeJob: null, ...extra });
const localOn = (extra = {}) => ({ ...defaultFeatures().embeddings, pending: null, secretNames: new Set(), activeJob: null, ...extra });
const storage = (current, request, count) => planStorageAction({ current, request, facts: { bundledObjectCount: count } });
const embeddings = (current, request) => planEmbeddingsAction({ current, request });

// ---- storage -----------------------------------------------------------------

test('storage: bundled and empty → off is allowed; the container is stopped (the volume is kept — no delete step exists)', () => {
  const r = storage(bundledOn(), { action: 'off' }, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan, { op: 'set_state', state: 'off', service: { name: 'storage', action: 'stop' } });
});

test('storage: bundled holding objects → off is REFUSED (STORAGE_HAS_OBJECTS) with the copy and fresh options', () => {
  const r = storage(bundledOn(), { action: 'off' }, 12);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, CODES.STORAGE_HAS_OBJECTS);
  assert.match(r.message, /12 object/);
  assert.deepEqual(r.options.map((o) => [o.action, o.provider, o.mode, o.acknowledge ?? null]), [['switch', 'external', 'copy', null], ['switch', 'external', 'fresh', true]]);
});

test('storage: an object count that cannot be read is never taken as empty (STORAGE_OBJECTS_UNKNOWN)', () => {
  const r = storage(bundledOn(), { action: 'off' }, null);
  assert.equal(r.code, CODES.STORAGE_OBJECTS_UNKNOWN);
  assert.ok(r.options.some((o) => o.mode === 'copy'));
});

test('storage: external → off is allowed and touches nothing (no service action); off when already off is a no-op', () => {
  assert.deepEqual(storage(externalOn(), { action: 'off' }, 99).plan, { op: 'set_state', state: 'off', service: null });
  assert.equal(storage(bundledOn({ state: 'off' }), { action: 'off' }, 5).plan.op, 'noop');
});

test('storage: off → on starts the same container on the same volume (bundled); external needs no service', () => {
  assert.deepEqual(storage(bundledOn({ state: 'off' }), { action: 'on' }).plan, { op: 'set_state', state: 'on', service: { name: 'storage', action: 'start' } });
  assert.deepEqual(storage(externalOn({ state: 'off' }), { action: 'on' }).plan, { op: 'set_state', state: 'on', service: null });
  assert.equal(storage(bundledOn(), { action: 'on' }).plan.op, 'noop');
});

test('storage: bundled with objects → external needs a mode; fresh needs acknowledge: true; copy is a job; fresh promotes at once', () => {
  const base = { action: 'switch', provider: 'external', config: S3, credentials: CREDS };
  const noMode = storage(bundledOn(), base, 3);
  assert.equal(noMode.code, CODES.SWITCH_MODE_REQUIRED);
  assert.deepEqual(noMode.options.map((o) => o.mode), ['copy', 'fresh']);
  const noAck = storage(bundledOn(), { ...base, mode: 'fresh' }, 3);
  assert.equal(noAck.code, CODES.ACKNOWLEDGE_REQUIRED);
  assert.match(noAck.message, /preserved volume/);
  const fresh = storage(bundledOn(), { ...base, mode: 'fresh', acknowledge: true }, 3);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.plan.after, 'promote');
  assert.equal(fresh.plan.pending.mode, 'fresh');
  const copy = storage(bundledOn(), { ...base, mode: 'copy' }, 3);
  assert.equal(copy.plan.after, 'copy_job');
  assert.equal(copy.plan.credentials, 'supplied');
  assert.deepEqual(Object.keys(copy.plan.values).sort(), [`pending.${SECRET_NAMES.storageAccessKeyId}`, `pending.${SECRET_NAMES.storageSecretAccessKey}`], 'credentials are staged under pending.* names');
  assert.equal(copy.plan.startService, null, 'an external provider needs no local service for its test');
});

test('storage: an empty bundled storage switches to external with no mode (nothing to copy or leave behind)', () => {
  const r = storage(bundledOn(), { action: 'switch', provider: 'external', config: S3, credentials: CREDS }, 0);
  assert.equal(r.ok, true);
  assert.equal(r.plan.after, 'promote');
  assert.equal(r.plan.pending.mode, null);
});

test('storage: external → bundled is the same choice in reverse; bundled uses the platform identity and refuses credentials', () => {
  const noMode = storage(externalOn(), { action: 'switch', provider: 'bundled' });
  assert.equal(noMode.code, CODES.SWITCH_MODE_REQUIRED);
  const copy = storage(externalOn(), { action: 'switch', provider: 'bundled', mode: 'copy' });
  assert.equal(copy.plan.after, 'copy_job');
  assert.equal(copy.plan.credentials, 'bundled_identity');
  assert.equal(copy.plan.startService, 'storage', 'the bundled container must run for the test');
  assert.deepEqual(copy.plan.pending.config, defaultFeatures().storage.config);
  const fresh = storage(externalOn(), { action: 'switch', provider: 'bundled', mode: 'fresh', acknowledge: true });
  assert.equal(fresh.plan.after, 'promote');
  const withCreds = storage(externalOn(), { action: 'switch', provider: 'bundled', mode: 'copy', credentials: CREDS });
  assert.equal(withCreds.status, 400);
  assert.equal(storage(bundledOn(), { action: 'switch', provider: 'bundled' }, 0).status, 400, 'bundled → bundled is not a switch');
});

test('storage: an external switch with no credentials is MISSING_CREDENTIALS; the stored ones are reused only for the SAME endpoint', () => {
  assert.equal(storage(bundledOn(), { action: 'switch', provider: 'external', config: S3 }, 0).code, CODES.MISSING_CREDENTIALS);
  const sameEndpoint = storage(externalOn(), { action: 'switch', provider: 'external', config: { ...S3, bucket: 'other-bucket' }, mode: 'copy' });
  assert.equal(sameEndpoint.plan.credentials, 'reuse_active');
  assert.deepEqual(sameEndpoint.plan.values, {});
  const newEndpoint = storage(externalOn(), { action: 'switch', provider: 'external', config: { ...S3, endpoint: 'https://evil.example.com' }, mode: 'copy' });
  assert.equal(newEndpoint.code, CODES.MISSING_CREDENTIALS, 'stored credentials never go to a new endpoint');
  assert.equal(storage(externalOn(), { action: 'switch', provider: 'external', config: S3 }).plan.op, 'noop');
  const half = storage(bundledOn(), { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: CREDS.access_key_id } }, 0);
  assert.equal(half.status, 400);
});

test('one active job per deployment: every write action is refused with FOUNDATION_JOB_RUNNING and a cancel option', () => {
  const activeJob = { id: 'fj_abcdef123456', kind: 'storage_migrate' };
  for (const request of [{ action: 'on' }, { action: 'off' }, { action: 'switch', provider: 'external', config: S3, credentials: CREDS, mode: 'copy' }]) {
    const r = storage(bundledOn({ activeJob }), request, 0);
    assert.equal(r.code, CODES.FOUNDATION_JOB_RUNNING, JSON.stringify(request));
    assert.deepEqual(r.options, [{ action: 'cancel_job', job_id: activeJob.id }]);
  }
  for (const request of [{ action: 'on' }, { action: 'off' }, { action: 'switch', provider: 'local' }]) {
    assert.equal(embeddings(localOn({ activeJob: { id: 'fj_x1234567', kind: 'reembed' } }), request).code, CODES.FOUNDATION_JOB_RUNNING);
  }
});

test('storage config validation: endpoint, bucket rules, region, prefix, and no credentials in config or URL', () => {
  assert.deepEqual(validateStorageConfig(S3).config, { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-app-files', prefix: 'prod/', force_path_style: true });
  assert.equal(validateStorageConfig({ ...S3, region: '' }).config.region, STACK.storage.region);
  assert.equal(validateStorageConfig({ ...S3, endpoint: 'https://h.example/' }).config.endpoint, 'https://h.example');
  for (const bad of [
    { ...S3, endpoint: 'ftp://x' }, { ...S3, endpoint: 'https://user:pw@x.example' }, { ...S3, endpoint: 'https://x.example?a=1' }, { ...S3, endpoint: '' },
    { ...S3, bucket: 'AB' }, { ...S3, region: 'US East' }, { ...S3, prefix: '/abs' }, { ...S3, prefix: 'a/../b' }, { ...S3, prefix: 'a//b' }, { ...S3, prefix: 'semi;colon' },
    { ...S3, secret_access_key: 'x' }, { ...S3, force_path_style: 'yes' }, null,
  ]) {
    const r = validateStorageConfig(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.status, 400);
  }
  for (const good of ['abc', 'my-bucket', 'my.bucket.1', 'a'.repeat(63)]) assert.equal(isValidBucketName(good), true, good);
  for (const bad of ['ab', 'a'.repeat(64), 'My-Bucket', '-abc', 'abc-', 'a..b', 'a.-b', '192.168.1.1', 'xn--abc', 'sthree-x', 'abc-s3alias', 'abc--ol-s3', 'a_b']) assert.equal(isValidBucketName(bad), false, bad);
});

// ---- embeddings --------------------------------------------------------------

test('embeddings: on → off stops the local container (vectors stay); off → on with the same provider is available at once', () => {
  assert.deepEqual(embeddings(localOn(), { action: 'off' }).plan, { op: 'set_state', state: 'off', service: { name: 'embeddings', action: 'stop' } });
  assert.deepEqual(embeddings(localOn({ state: 'off' }), { action: 'on' }).plan, { op: 'set_state', state: 'on', service: { name: 'embeddings', action: 'start' } });
  const openai = { state: 'on', provider: 'openai', config: validateEmbeddingsConfig('openai', {}).config, pending: null, secretNames: new Set([SECRET_NAMES.embeddingsApiKey]), activeJob: null };
  assert.deepEqual(embeddings(openai, { action: 'off' }).plan, { op: 'set_state', state: 'off', service: null });
  assert.equal(embeddings(localOn({ state: 'off' }), { action: 'off' }).plan.op, 'noop');
});

test('embeddings: OpenAI defaults to text-embedding-3-small at 1536 dimensions; a provider/model/dimension change re-embeds', () => {
  const v = validateEmbeddingsConfig('openai', {});
  assert.deepEqual(v.config, { base_url: 'https://api.openai.com/v1', model: OPENAI_DEFAULT_MODEL, dimensions: 1536, metric: 'cosine' });
  assert.equal(OPENAI_DEFAULT_MODEL, 'text-embedding-3-small');
  const r = embeddings(localOn(), { action: 'switch', provider: 'openai', credentials: { api_key: 'sk-test-0123456789abcdef' } });
  assert.equal(r.plan.after, 'reembed');
  assert.deepEqual(r.plan.values, { 'pending.embeddings.api_key': 'sk-test-0123456789abcdef' });
  assert.equal(r.plan.startService, null);
  assert.equal(needsReembed({ provider: 'openai', config: { model: 'a', dimensions: 10 } }, { provider: 'openai', config: { model: 'a', dimensions: 10, metric: 'cosine' } }), false);
  for (const change of [{ provider: 'openai_compatible' }, { model: 'b' }, { dimensions: 11 }, { metric: 'l2' }]) {
    const pending = { provider: change.provider || 'openai', config: { model: change.model || 'a', dimensions: change.dimensions || 10, metric: change.metric || 'cosine' } };
    assert.equal(needsReembed({ provider: 'openai', config: { model: 'a', dimensions: 10 } }, pending), true, JSON.stringify(change));
  }
});

test('embeddings: OpenAI with no key is MISSING_CREDENTIALS; a new key alone (same model/dimensions) promotes without re-embedding', () => {
  assert.equal(embeddings(localOn(), { action: 'switch', provider: 'openai' }).code, CODES.MISSING_CREDENTIALS);
  const openai = { state: 'on', provider: 'openai', config: validateEmbeddingsConfig('openai', {}).config, pending: null, secretNames: new Set([SECRET_NAMES.embeddingsApiKey]), activeJob: null };
  const rotate = embeddings(openai, { action: 'switch', provider: 'openai', credentials: { api_key: 'sk-new-key-0123456789' } });
  assert.equal(rotate.plan.after, 'promote');
  assert.equal(embeddings(openai, { action: 'switch', provider: 'openai' }).plan.op, 'noop');
  const shorter = embeddings(openai, { action: 'switch', provider: 'openai', config: { dimensions: 512 } });
  assert.equal(shorter.plan.after, 'reembed');
  assert.equal(shorter.plan.credentials, 'reuse_active', 'same provider at the same address reuses the stored key');
});

test('embeddings: OpenAI-compatible needs base_url, model and dimensions; its key is optional and never reused at a new address', () => {
  assert.equal(validateEmbeddingsConfig('openai_compatible', { model: 'm', dimensions: 768 }).status, 400);
  assert.equal(validateEmbeddingsConfig('openai_compatible', { base_url: 'http://10.0.0.5:8080/v1', dimensions: 768 }).status, 400);
  assert.equal(validateEmbeddingsConfig('openai_compatible', { base_url: 'http://10.0.0.5:8080/v1', model: 'nomic-embed-text' }).status, 400);
  const cfg = { base_url: 'http://10.0.0.5:8080/v1', model: 'nomic-embed-text', dimensions: 768 };
  const r = embeddings(localOn(), { action: 'switch', provider: 'openai_compatible', config: cfg });
  assert.equal(r.ok, true);
  assert.equal(r.plan.credentials, 'none');
  const current = { state: 'on', provider: 'openai_compatible', config: { ...cfg, metric: 'cosine' }, pending: null, secretNames: new Set([SECRET_NAMES.embeddingsApiKey]), activeJob: null };
  assert.equal(embeddings(current, { action: 'switch', provider: 'openai_compatible', config: { ...cfg, base_url: 'https://elsewhere.example/v1' } }).plan.credentials, 'none');
});

test('embeddings: model/dimension validation against the model and vectorColumnPlan (index limit warned, out of range refused)', () => {
  assert.equal(validateEmbeddingsConfig('openai', { model: 'text-embedding-3-small', dimensions: 3000 }).status, 400);
  assert.equal(validateEmbeddingsConfig('openai', { model: 'text-embedding-ada-002', dimensions: 512 }).status, 400);
  assert.equal(validateEmbeddingsConfig('openai', { model: 'text-embedding-3-large' }).config.dimensions, 3072);
  assert.equal(validateEmbeddingsConfig('openai', { model: 'gpt-x' }).status, 400);
  assert.equal(validateEmbeddingsConfig('openai', { base_url: 'http://api.openai.com/v1' }).status, 400, 'OpenAI only over https');
  assert.equal(validateEmbeddingsConfig('local', { model: 'other' }).status, 400);
  assert.equal(validateEmbeddingsConfig('local', { dimensions: 768 }).status, 400);
  assert.deepEqual(validateEmbeddingsConfig('local', {}).config, { base_url: defaultFeatures().embeddings.config.base_url, model: STACK.embeddings.model, dimensions: 384, metric: 'cosine' });
  const big = validateEmbeddingsConfig('openai_compatible', { base_url: 'https://x.example/v1', model: 'big', dimensions: 5000 });
  assert.equal(big.ok, true);
  assert.match(big.warnings[0], /exact scan/);
  assert.equal(validateEmbeddingsConfig('openai_compatible', { base_url: 'https://x.example/v1', model: 'big', dimensions: 16001 }).status, 400);
  assert.equal(validateEmbeddingsConfig('openai', { metric: 'manhattan' }).status, 400);
  assert.equal(validateEmbeddingsConfig('openai', { api_key: 'sk-x' }).status, 400, 'a key in config is refused');
  assert.equal(validateCredentials('embeddings', 'local', { api_key: 'sk-whatever-1234' }).status, 400);
  assert.equal(validateCredentials('embeddings', 'openai', { api_key: 'has space here' }).status, 400);
  assert.equal(validateCredentials('embeddings', 'openai', { token: 'x' }).status, 400);
});

test('serviceStillUsed: a service is stopped only when nothing uses it', () => {
  assert.equal(serviceStillUsed('storage', { state: 'on', provider: 'bundled' }), true);
  assert.equal(serviceStillUsed('storage', { state: 'on', provider: 'external' }), false);
  assert.equal(serviceStillUsed('storage', { state: 'off', provider: 'bundled' }), false);
  assert.equal(serviceStillUsed('embeddings', { state: 'on', provider: 'local' }), true);
  assert.equal(serviceStillUsed('embeddings', { state: 'on', provider: 'openai' }), false);
});

// ---- health and the projections --------------------------------------------

const PROJECT = { id: 7, foundation_version: FOUNDATION_VERSION };

test('missing credentials is reported as missing_credentials — never ready, whatever the probe said', () => {
  const rows = featureRowsFrom([
    { feature: 'storage', state: 'on', provider: 'external', config_json: JSON.stringify(validateStorageConfig(S3).config), pending_json: null, updated_at: '2026-10-24T10:00:00Z' },
    { feature: 'embeddings', state: 'on', provider: 'openai', config_json: JSON.stringify(validateEmbeddingsConfig('openai', {}).config), pending_json: null, updated_at: '2026-10-24T10:00:00Z' },
  ]);
  const health = [{ component: 'storage', status: 'ready', detail: {}, checked_at: '2026-10-24T11:00:00Z' }, { component: 'embeddings', status: 'ready', detail: {}, checked_at: '2026-10-24T11:00:00Z' }];
  const p = projectFoundation({ project: PROJECT, rows, secretNames: [], health });
  assert.equal(p.storage.health.status, 'missing_credentials');
  assert.equal(p.embeddings.health.status, 'missing_credentials');
  assert.equal(p.storage.has_secret, false);
  const ok = projectFoundation({ project: PROJECT, rows, secretNames: [SECRET_NAMES.storageAccessKeyId, SECRET_NAMES.storageSecretAccessKey, SECRET_NAMES.embeddingsApiKey], health });
  assert.equal(ok.storage.health.status, 'ready');
  assert.equal(ok.embeddings.has_secret, true);
});

test('health: off overrides; no probe is unavailable; a ready probe older than the last change is not ready', () => {
  const rows = featureRowsFrom([{ feature: 'storage', state: 'off', provider: 'bundled', config_json: '{}', pending_json: null, updated_at: '2026-10-24T10:00:00Z' }]);
  const names = [SECRET_NAMES.storageAccessKeyId, SECRET_NAMES.storageSecretAccessKey];
  const p = projectFoundation({ project: PROJECT, rows, secretNames: names, health: [{ component: 'storage', status: 'ready', detail: {}, checked_at: '2026-10-24T11:00:00Z' }] });
  assert.equal(p.storage.health.status, 'off');
  assert.equal(p.embeddings.health.status, 'unavailable', 'never probed');
  assert.equal(p.database.health.status, 'unavailable');
  const on = featureRowsFrom([{ feature: 'storage', state: 'on', provider: 'bundled', config_json: '{}', pending_json: null, updated_at: '2026-10-24T12:00:00Z' }]);
  assert.equal(projectFoundation({ project: PROJECT, rows: on, secretNames: names, health: [{ component: 'storage', status: 'ready', detail: {}, checked_at: '2026-10-24T11:00:00Z' }] }).storage.health.status, 'unavailable');
});

test('projection: DEPENDENT_CAPABILITIES on every feature, LOCAL_EMBEDDINGS_WARNING for the local provider, the database on its socket', () => {
  const p = projectFoundation({ project: PROJECT, rows: featureRowsFrom([]), secretNames: [] });
  assert.equal(p.foundation_version, FOUNDATION_VERSION);
  assert.deepEqual(p.storage.dependents, [...DEPENDENT_CAPABILITIES.storage]);
  assert.deepEqual(p.embeddings.dependents, [...DEPENDENT_CAPABILITIES.embeddings]);
  assert.equal(p.embeddings.warning, LOCAL_EMBEDDINGS_WARNING);
  assert.deepEqual(p.warnings.map((w) => w.code), ['LOCAL_EMBEDDINGS']);
  assert.equal(p.database.config.socket_dir, STACK.postgres.socketDir);
  assert.deepEqual(Object.keys(p).sort(), ['database', 'embeddings', 'foundation_version', 'jobs', 'storage', 'warnings']);
  for (const f of ['storage', 'embeddings']) assert.deepEqual(Object.keys(p[f]).filter((k) => k !== 'warning' && !(f === 'embeddings' && k === 'index')).sort(), ['config', 'dependents', 'has_secret', 'health', 'pending', 'provider', 'state']);
  assert.equal(p.embeddings.index, null, 'no active index reported → null, never a guess');
  assert.equal('object_count' in p.storage, false, 'no count taken yet → not reported');
  assert.deepEqual(projectFoundation({ project: { id: 1, foundation_version: null } }), { foundation_version: null, database: null, storage: null, embeddings: null, jobs: [], warnings: [] }, 'a pre-foundation project has no switches');
});

test('RATCHET: no projection can carry a secret value — only has_secret flags', () => {
  const planted = ['sk-live-SECRETVALUE0123456789', 'AKIAPLANTEDACCESSKEY01', 'wJalrPLANTEDsecretKEY/0123456789', 'mfs1:aaaa:bbbb:cccc', 'hunter2-planted-password'];
  const rows = featureRowsFrom([
    { feature: 'storage', state: 'on', provider: 'external', updated_at: '2026-10-24T10:00:00Z',
      config_json: JSON.stringify({ ...validateStorageConfig(S3).config, secret_access_key: planted[2], access_key_id: planted[1] }),
      pending_json: JSON.stringify({ provider: 'external', config: { ...S3, password: planted[4] }, mode: 'copy', staged_at: 'x', job_id: 'fj_abcdef12345678',
        test: { ok: false, status: 'degraded', detail: { message: `InvalidAccessKeyId ${planted[1]} secret=${planted[2]}`, api_key: planted[0] }, at: 'y' } }) },
    { feature: 'embeddings', state: 'on', provider: 'openai', updated_at: '2026-10-24T10:00:00Z', config_json: JSON.stringify({ ...validateEmbeddingsConfig('openai', {}).config, api_key: planted[0] }), pending_json: null },
  ]);
  const jobs = [{ id: 'fj_abcdef12345678', kind: 'storage_migrate', state: 'failed', params_json: JSON.stringify({ from: { provider: 'bundled', secret: planted[2] }, to: { provider: 'external', bucket: 'b' } }),
    progress_json: JSON.stringify({ copied: 3, token: planted[0], note: `key ${planted[0]}` }), error: `Incorrect API key provided: ${planted[0]}; sealed ${planted[3]}`, created_at: 'a', updated_at: 'b', finished_at: null }];
  const health = [{ component: 'embeddings', status: 'degraded', detail: { api_key: planted[0], message: `401 ${planted[0]}`, nested: { password: planted[4] } }, checked_at: '2026-10-24T11:00:00Z' }];
  const names = Object.values(SECRET_NAMES).concat(Object.values(BUNDLED_APP_IDENTITY), ['pending.storage.access_key_id']);
  const out = JSON.stringify(projectFoundation({ project: PROJECT, rows, secretNames: names, jobs, health }));
  for (const s of planted) assert.equal(out.includes(s), false, `leaked ${s}`);
  assert.equal(out.includes('"has_secret":true'), true);
  assert.equal(JSON.stringify(projectJob(jobs[0])).includes('sk-live'), false);
});

test('CLI test results: exit 0 is ready; exit 2 is missing_credentials or unavailable; exit 1 is degraded; detail is redacted', () => {
  assert.deepEqual(interpretCliTest({ code: 0, stdout: '{"status":"ready","detail":{"latency_ms":12}}' }), { ok: true, status: 'ready', detail: { latency_ms: 12 } });
  assert.equal(interpretCliTest({ code: 0, stdout: '{"status":"degraded"}' }).ok, false, 'a contrary status is never ready');
  const missing = interpretCliTest({ code: 2, stdout: '{"status":"missing_credentials","detail":{"message":"no api key"}}' });
  assert.deepEqual([missing.ok, missing.status], [false, 'missing_credentials']);
  assert.equal(interpretCliTest({ code: 2, stdout: 'garbage' }).status, 'unavailable');
  assert.equal(interpretCliTest({ code: 2, stdout: '{"status":"ready"}' }).status, 'unavailable', 'exit 2 is never ready');
  const err = interpretCliTest({ code: 1, stdout: 'log line\n{"status":"degraded","detail":{"message":"Incorrect API key provided: sk-abcdef0123456789xyz"}}' }, ['abcdef0123456789xyz']);
  assert.equal(err.status, 'degraded');
  assert.equal(JSON.stringify(err).includes('abcdef0123456789'), false);
  assert.equal(interpretCliTest({ code: 1, stderr: 'boom wJalrXUtnFEMI/K7MDENG' }, ['wJalrXUtnFEMI/K7MDENG']).detail.message.includes('wJalr'), false);
  assert.deepEqual(parseHealthOutput('[{"component":"database","status":"ready","detail":{}},{"component":"storage","status":"weird"},{"component":"x","status":"ready"}]').map((h) => [h.component, h.status]), [['database', 'ready'], ['storage', 'unavailable']]);
  assert.equal(redactSecrets('Authorization: Bearer abc123def456').includes('abc123def456'), false);
  assert.equal(redactSecrets('{"api_key":"k-0123456789"}').includes('k-0123456789'), false);
});

// ---- the secret names ---------------------------------------------------------

test('host-only secrets (master key, bundled admin, retained bundled identity) are never in the synced set', () => {
  const all = [...Object.values(SECRET_NAMES), ...Object.values(BUNDLED_APP_IDENTITY), 'pending.storage.access_key_id', 'component.AUTH_MASTER_SECRET', 'bogus.name'];
  assert.deepEqual(appSecretNames(all), ['component.AUTH_MASTER_SECRET', 'embeddings.api_key', 'pending.storage.access_key_id', 'storage.access_key_id', 'storage.secret_access_key']);
  for (const n of [SECRET_NAMES.masterKey, SECRET_NAMES.storageAdminAccessKeyId, BUNDLED_APP_IDENTITY.accessKeyId]) assert.equal(isHostOnlySecret(n), true, n);
  assert.equal(isStorableSecretName(BUNDLED_APP_IDENTITY.secretAccessKey), true);
  assert.equal(isStorableSecretName('component.lower'), false);
});

// ---- SQL ------------------------------------------------------------------------

test('sqlLiteral: quotes doubled, backslashes literal (standard_conforming_strings forced on), NUL refused', () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral('a\\b'), "'a\\b'");
  assert.equal(sqlLiteral(null), 'NULL');
  assert.throws(() => sqlLiteral('a\u0000b'), /NUL/);
});

test('buildSyncSql: one transaction — generation bump, both features, sealed secrets, stale secrets deleted, NOTIFY — and no injection', () => {
  const evil = "x'); DROP TABLE mock2_foundation.secrets; --";
  const features = featureRowsFrom([{ feature: 'storage', state: 'on', provider: 'external', config_json: JSON.stringify({ endpoint: 'https://e.example', bucket: 'b-1', prefix: evil }), pending_json: JSON.stringify({ provider: 'bundled', config: {}, mode: 'copy', test: { detail: 'host only' }, staged_at: 't' }), updated_at: 'u' }]);
  const sealed = [{ name: 'storage.access_key_id', sealed: 'mfs1:aa:bb:cc' }, { name: 'component.AUTH_MASTER_SECRET', sealed: 'mfs1:dd:ee:ff' }];
  const sql = buildSyncSql({ features, sealed, statements: ['SELECT 1;'] });
  assert.match(sql, /^\\set ON_ERROR_STOP on\nSET standard_conforming_strings = on;\n/);
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('SELECT 1;') && sql.indexOf('SELECT 1;') < sql.indexOf('INSERT INTO mock2_foundation.features'));
  assert.match(sql, /INSERT INTO mock2_foundation\.meta \(key, value, updated_at\) VALUES \('generation'/);
  assert.match(sql, /COALESCE\(\(mock2_foundation\.meta\.value #>> '\{\}'\)::bigint, 0\) \+ 1/);
  assert.equal((sql.match(/INSERT INTO mock2_foundation\.features/g) || []).length, 2);
  assert.match(sql, /DELETE FROM mock2_foundation\.secrets WHERE name NOT IN \('storage\.access_key_id', 'component\.AUTH_MASTER_SECRET'\);/);
  assert.match(sql, new RegExp(`SELECT pg_notify\\('${FOUNDATION_NOTIFY_CHANNEL}', `));
  assert.ok(sql.indexOf('pg_notify') < sql.indexOf('COMMIT;'));
  assert.ok(sql.includes("x''); DROP TABLE mock2_foundation.secrets; --"), 'the quote is doubled inside the JSON literal');
  assert.equal(sql.includes("x'); DROP"), false);
  assert.equal(sql.includes('host only'), false, 'test results and timestamps stay host-side');
  assert.match(sql, /"mode":"copy"/);
  assert.match(buildSyncSql({ features, sealed: [] }), /DELETE FROM mock2_foundation\.secrets;/);
  assert.throws(() => buildSyncSql({ features, sealed: [{ name: 'master_key', sealed: 'mfs1:a:b:c' }] }), /refusing/);
  assert.throws(() => buildSyncSql({ features, sealed: [{ name: BUNDLED_APP_IDENTITY.accessKeyId, sealed: 'mfs1:a:b:c' }] }), /refusing/);
  assert.throws(() => buildSyncSql({ features, sealed: [{ name: 'storage.access_key_id', sealed: 'PLAINTEXT' }] }), /not sealed/);
  assert.equal(parseGeneration('BEGIN\nINSERT 0 1\n MF_GENERATION:42 \nCOMMIT'), 42);
  assert.equal(parseGeneration('nothing'), null);
});

test('job, poll, cancel and promotion SQL only interpolate validated ids; JSON rows parse from marked lines', () => {
  const id = newJobId('ABCDEF0123456789abcd');
  assert.equal(isValidJobId(id), true);
  assert.throws(() => buildJobInsertSql({ job: { id: "fj_x'; drop", kind: 'reembed' } }), /invalid job id/);
  const ins = buildJobInsertSql({ job: { id, kind: 'reembed', params: { note: "it's" } }, index: { id: 'ix_0011aabb', provider: 'openai', model: "m'x", dimensions: 1536, metric: 'cosine' } });
  assert.match(ins, /INSERT INTO mock2_foundation\.jobs .*'queued'/);
  assert.match(ins, /'ix_0011aabb', 'openai', 'm''x', 1536, 'cosine', 'building', 'vec_ix_0011aabb'/);
  assert.match(ins, /"note":"it''s"/);
  assert.throws(() => buildJobInsertSql({ job: { id, kind: 'reembed' }, index: { id: 'BAD-ID', provider: 'p', model: 'm', dimensions: 3, metric: 'cosine' } }), /invalid index id/);
  assert.match(buildJobPollSql({ jobId: id, indexId: 'ix_0011aabb' }), /FROM mock2_foundation\.vector_indexes WHERE id = 'ix_0011aabb'/);
  assert.match(buildCancelJobSql({ jobId: id, indexId: 'ix_0011aabb' }), /SET state = 'failed' WHERE id = 'ix_0011aabb' AND state IN \('building','ready'\)/);
  const promote = promoteIndexStatements('ix_0011aabb');
  assert.match(promote[0], /RAISE EXCEPTION/);
  assert.match(promote[1], /SET state = 'retired'.*WHERE state = 'active' AND id <> 'ix_0011aabb'/);
  assert.match(promote[2], /SET state = 'active'.*WHERE id = 'ix_0011aabb' AND state = 'ready'/);
  assert.throws(() => promoteIndexStatements("x'"), /invalid index id/);
  assert.deepEqual(parseJsonRows('header\n MF_JSON:{"type":"job","state":"running"}\nMF_JSON:not json\n(1 row)'), [{ type: 'job', state: 'running' }]);
  assert.throws(() => buildGuardProbeSql({ table: 'x"; drop', secret_column: 'c' }), /identifier/);
  assert.match(buildGuardProbeSql({ table: 'auth_connections', secret_column: 'secret_ciphertext' }), /to_regclass\('"public"\."auth_connections"'\)/);
  assert.match(buildGuardRowsSql({ table: 'auth_connections', schema: 'app', secret_column: 'secret_ciphertext' }), /FROM "app"\."auth_connections" WHERE "secret_ciphertext" IS NOT NULL/);
});

// ---- component secrets ---------------------------------------------------------

test('component secrets on a foundation deployment: held never overwritten; unguarded minted; data-guarded only on fresh storage', () => {
  const cfg = (key, extra = {}) => ({ key, secret: true, generate: true, ...extra });
  const guard = { protects: { table: 'auth_connections', secret_column: 'secret_ciphertext' }, requires_marker: { path: 'src/x.ts', contains: 'm' } };
  const plan = planFoundationComponentMint({
    configs: [cfg('SESSION_SECRET'), cfg('AUTH_JWT_SECRET'), cfg('AUTH_MASTER_SECRET', guard), cfg('lower_key'), { key: 'PLAIN', secret: false }, cfg('SESSION_SECRET')],
    heldNames: ['component.AUTH_JWT_SECRET'],
    newlyProvisioned: false,
  });
  assert.deepEqual(plan.held, ['AUTH_JWT_SECRET']);
  assert.deepEqual(plan.mint, ['SESSION_SECRET']);
  assert.deepEqual(plan.deferred.map((d) => d.key), ['AUTH_MASTER_SECRET', 'lower_key']);
  assert.deepEqual(plan.required, ['AUTH_JWT_SECRET', 'SESSION_SECRET']);
  const fresh = planFoundationComponentMint({ configs: [cfg('AUTH_MASTER_SECRET', guard)], newlyProvisioned: true, probes: { AUTH_MASTER_SECRET: 'no_table' } });
  assert.deepEqual(fresh.mint, ['AUTH_MASTER_SECRET']);
  assert.deepEqual(planFoundationComponentMint({ configs: [cfg('AUTH_MASTER_SECRET', guard)], newlyProvisioned: true, probes: { AUTH_MASTER_SECRET: 'empty' } }).mint, ['AUTH_MASTER_SECRET']);
  for (const probe of ['rows', 'unknown']) {
    const r = planFoundationComponentMint({ configs: [cfg('AUTH_MASTER_SECRET', guard)], newlyProvisioned: true, probes: { AUTH_MASTER_SECRET: probe } });
    assert.deepEqual(r.mint, [], probe);
    assert.match(r.deferred[0].reason, new RegExp(probe));
  }
  const ref = normalizeFoundationDeployRef({ version: FOUNDATION_VERSION, required: ['A_KEY', 'bad key', 'A_KEY'], delivered: ['A_KEY'], error: 'sync failed: sk-abcdefghijklmnop', values: { A_KEY: 'v' } });
  assert.deepEqual(ref, { version: FOUNDATION_VERSION, required: ['A_KEY'], delivered: ['A_KEY'], error: 'sync failed: sk-[redacted]' });
  assert.equal(normalizeFoundationDeployRef(null), null);
});
