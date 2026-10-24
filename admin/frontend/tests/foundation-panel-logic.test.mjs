// Application foundation panel — the pure rules (src/components/mock2/
// foundation-panel-logic.js): the API readings, the request bodies, the
// refusal → next-step mapping, and the mirror of the backend contract.
//   node --test tests/foundation-panel-logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../../backend/src/mock2/foundation-contract.js';
import {
  LOCAL_EMBEDDINGS_WARNING, DEPENDENT_CAPABILITIES, LOCAL_MODEL, LOCAL_DIMENSIONS, LEGACY_TEXT,
  isLegacy, projectSaysLegacy, healthView, checkedAgo, formatBytes, hasSecret, storageView, embeddingsView,
  localWarning, otherWarnings, dependentsOf, turnOffCopy, refusalOf, nextSteps, optionAction, refusalNeedsMode,
  storageFormDefaults, storageNeedsMode, storageCanKeepKeys, storageSwitchBody, ackText,
  embeddingsFormDefaults, embeddingsSwitchBody, reembedNeeded, exceptionBody, jobView, activeJobs, jobFeature,
} from '../src/components/mock2/foundation-panel-logic.js';

const defaults = contract.defaultFeatures();
const bundled = (over = {}) => ({ ...defaults.storage, health: { status: 'ready', detail: {}, checked_at: '2026-10-24T10:00:00Z' }, has_secret: { access_key_id: true, secret_access_key: true }, dependents: [], ...over });
const external = (over = {}) => bundled({ provider: 'external', config: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'files', prefix: 'app/', force_path_style: true }, ...over });
const local = (over = {}) => ({ ...defaults.embeddings, health: { status: 'ready', detail: {}, checked_at: null }, has_secret: {}, dependents: [], ...over });

test('the mirrored contract text and dependents match the backend contract exactly', () => {
  assert.equal(LOCAL_EMBEDDINGS_WARNING, contract.LOCAL_EMBEDDINGS_WARNING);
  assert.deepEqual(DEPENDENT_CAPABILITIES, contract.DEPENDENT_CAPABILITIES);
  assert.equal(LOCAL_MODEL, contract.STACK.embeddings.model);
  assert.equal(LOCAL_DIMENSIONS, contract.STACK.embeddings.dimensions);
  for (const status of contract.HEALTH_STATUSES) {
    const v = healthView({ health: { status } });
    assert.equal(v.status, status);
    assert.notEqual(v.label, 'Not checked', `${status} has no label`);
  }
});

test('legacy: the project column decides when exposed, else the foundation read', () => {
  assert.equal(projectSaysLegacy({ id: 1, foundation_version: null }), true);
  assert.equal(projectSaysLegacy({ id: 1, foundation_version: contract.FOUNDATION_VERSION }), false);
  assert.equal(projectSaysLegacy({ id: 1 }), false, 'a project row without the column is not judged');
  assert.equal(isLegacy({ id: 1 }, { foundation_version: null }), true);
  assert.equal(isLegacy({ id: 1 }, { foundation_version: contract.FOUNDATION_VERSION }), false);
  assert.equal(isLegacy({ id: 1 }, null), false);
  assert.equal(LEGACY_TEXT, 'This project predates the application foundation.');
});

test('health: every contract status has a label; unknown is "Not checked", never ready', () => {
  assert.equal(healthView({ health: { status: 'ready' } }).label, 'Ready');
  assert.equal(healthView({ health: { status: 'missing_credentials' } }).label, 'Needs credentials');
  assert.equal(healthView({ health: { status: 'missing_credentials' } }).tone, 'warn');
  assert.equal(healthView({ health: { status: 'unavailable', detail: { message: 'probe failed' } } }).detail, 'probe failed');
  assert.equal(healthView({ state: 'off' }).label, 'Off');
  assert.equal(healthView({}).label, 'Not checked');
  assert.equal(healthView({ health: { status: 'weird' } }).tone, 'muted');
  assert.equal(checkedAgo('2026-10-24T10:00:00Z', Date.parse('2026-10-24T10:00:10Z')), 'Checked just now');
  assert.equal(checkedAgo('2026-10-24T10:00:00Z', Date.parse('2026-10-24T10:05:00Z')), 'Checked 5 min ago');
  assert.equal(checkedAgo(null), null);
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
});

test('storage: bundled vs external summaries, object count from the row or the health detail', () => {
  const b = storageView(bundled({ object_count: 1204 }));
  assert.equal(b.providerLabel, 'Bundled SeaweedFS');
  assert.equal(b.where, 'Inside this app\'s container');
  assert.equal(b.objectsText, '1,204');
  assert.equal(storageView(bundled({ object_count: 0 })).objectsText, 'None yet');
  assert.equal(b.keysSaved, null, 'bundled keys are platform-held, not shown');
  const x = storageView(external({ has_secret: { 'storage.access_key_id': true, 'storage.secret_access_key': false } }));
  assert.equal(x.providerLabel, 'External S3');
  assert.equal(x.where, 'acct.r2.cloudflarestorage.com · bucket files · folder app/');
  assert.equal(x.keysSaved, false);
  assert.equal(storageView(bundled({ health: { status: 'ready', detail: { objects: 3 } } })).objects, 3);
  assert.equal(storageView(bundled()).objectsText, null);
  assert.match(storageView(bundled({ pending: { provider: 'external' } })).pending, /^Switching to External S3/);
});

test('embeddings: summary, index status and the local warning (API text first)', () => {
  const v = embeddingsView(local({ index: { id: 'v1', state: 'active', item_count: 42 } }));
  assert.equal(v.providerLabel, 'Local model');
  assert.equal(v.dimensions, 384);
  assert.equal(v.indexText, 'In use · 42 items');
  assert.equal(v.keySaved, null);
  const c = embeddingsView({ provider: 'openai_compatible', config: { base_url: 'https://emb.example.com/v1', model: 'm', dimensions: 768 }, has_secret: { api_key: true } });
  assert.equal(c.providerLabel, 'OpenAI-compatible · emb.example.com');
  assert.equal(c.keySaved, true);
  assert.equal(localWarning({ embeddings: local() }), contract.LOCAL_EMBEDDINGS_WARNING);
  assert.equal(localWarning({ embeddings: local(), warnings: [{ code: 'LOCAL_EMBEDDINGS', feature: 'embeddings', message: 'API words' }] }), 'API words');
  assert.equal(localWarning({ embeddings: { provider: 'openai' }, warnings: [contract.LOCAL_EMBEDDINGS_WARNING] }), null);
  // The local warning is shown in its card, not repeated in the panel header.
  assert.deepEqual(otherWarnings({ embeddings: local(), warnings: [contract.LOCAL_EMBEDDINGS_WARNING, 'Disk 92% full'] }), ['Disk 92% full']);
  assert.deepEqual(otherWarnings({ embeddings: { provider: 'openai' }, warnings: [{ message: 'x' }, 'x'] }), ['x']);
});

test('dependents: the API list wins, else the contract; turn-off copy says nothing is deleted', () => {
  assert.deepEqual(dependentsOf({ storage: { dependents: ['Avatars'] } }, 'storage'), ['Avatars']);
  assert.deepEqual(dependentsOf({ storage: { dependents: [] } }, 'storage'), [...contract.DEPENDENT_CAPABILITIES.storage]);
  assert.deepEqual(dependentsOf({}, 'embeddings'), [...contract.DEPENDENT_CAPABILITIES.embeddings]);
  for (const [f, row] of [['storage', bundled()], ['storage', external()], ['embeddings', local()]]) {
    assert.match(turnOffCopy(f, row), /^No data is deleted\./);
  }
  assert.match(turnOffCopy('storage', external()), /external storage is touched/);
});

test('refusals: 409 bodies normalise; options become next steps; never a dead end on a card', () => {
  const err = Object.assign(new Error('Bundled storage still holds 12 files.'), { status: 409, code: 'STORAGE_HAS_OBJECTS', options: ['copy', 'fresh'], object_count: 12 });
  const r = refusalOf(err);
  assert.equal(r.code, 'STORAGE_HAS_OBJECTS');
  assert.equal(r.objects, 12);
  assert.deepEqual(nextSteps(r).map((s) => [s.kind, s.mode]), [['mode', 'copy'], ['mode', 'fresh']]);
  assert.equal(refusalNeedsMode(r), true);
  // The `error: { code, message, options }` envelope lands in details.
  const nested = refusalOf(Object.assign(new Error('A job is running.'), { status: 409, code: 'FOUNDATION_JOB_RUNNING', details: { code: 'FOUNDATION_JOB_RUNNING', options: [{ id: 'cancel', label: 'Cancel it' }], job_id: 'j1' } }));
  assert.equal(nested.jobId, 'j1');
  assert.deepEqual(nextSteps(nested).map((s) => [s.kind, s.label]), [['show_job', 'Show its progress'], ['cancel_job', 'Cancel it']]);
  // Known codes without options still offer their step.
  assert.deepEqual(nextSteps({ code: 'STORAGE_HAS_OBJECTS', options: [] }).map((s) => s.mode), ['copy', 'fresh']);
  assert.deepEqual(nextSteps({ code: 'FOUNDATION_JOB_RUNNING', options: [] }).map((s) => s.kind), ['show_job']);
  // Anything else: a card always gets a way forward; a dialog keeps its own submit.
  assert.deepEqual(nextSteps({ code: null, options: [] }).map((s) => s.kind), ['refresh']);
  assert.deepEqual(nextSteps({ code: null, options: [] }, 'storage', { fallback: false }), []);
  assert.equal(optionAction('credentials', 'embeddings').label, 'Add API key');
  assert.equal(optionAction('something_new').label, 'Something new');
  assert.equal(refusalOf(Object.assign(new Error('Sudo cancelled'), { status: 401 })).message, 'Nothing was changed: the confirmation was cancelled.');
  // An upper-case machine code in `error` is read as the code.
  assert.equal(refusalOf(Object.assign(new Error('m'), { status: 409, error: 'STORAGE_HAS_OBJECTS' })).code, 'STORAGE_HAS_OBJECTS');
});

test('storage switch: defaults never carry a secret; bodies match the documented shape', () => {
  const d = storageFormDefaults(bundled());
  assert.equal(d.provider, 'external');
  assert.equal(d.endpoint, '', 'the bundled loopback endpoint is not offered as an external one');
  assert.equal(d.region, contract.STACK.storage.region);
  assert.equal(d.access_key_id, '');
  assert.equal(d.secret_access_key, '');
  const dx = storageFormDefaults(external());
  assert.equal(dx.provider, 'bundled');
  assert.equal(dx.bucket, 'files');
  assert.equal(dx.secret_access_key, '');

  const missing = storageSwitchBody({ ...d }, { storage: bundled(), needsMode: false });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.endpoint && missing.errors.bucket && missing.errors.access_key_id && missing.errors.secret_access_key);

  const form = { ...d, endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'files', prefix: '/app/', force_path_style: true, access_key_id: 'AKIA', secret_access_key: 's3cr3t' };
  const ok = storageSwitchBody(form, { storage: bundled(), needsMode: false });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body, {
    action: 'switch', provider: 'external',
    config: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'files', prefix: 'app/', force_path_style: true },
    credentials: { access_key_id: 'AKIA', secret_access_key: 's3cr3t' },
  });
  assert.equal(storageSwitchBody({ ...form, bucket: 'Bad_Bucket' }, { storage: bundled() }).ok, false);
  assert.equal(storageSwitchBody({ ...form, endpoint: 'acct.r2' }, { storage: bundled() }).ok, false);
  assert.equal(storageSwitchBody({ ...form, secret_access_key: '' }, { storage: bundled() }).errors.secret_access_key, 'Enter the secret access key too.');

  // Staying on external with saved keys may leave them empty.
  assert.equal(storageCanKeepKeys(external(), 'external'), true);
  assert.equal(storageCanKeepKeys(bundled(), 'external'), false);
  const keep = storageSwitchBody({ ...storageFormDefaults(external()), provider: 'external' }, { storage: external() });
  assert.equal(keep.ok, true);
  assert.equal(keep.body.credentials, undefined);
});

test('storage switch: moving away from bundled storage that holds files requires copy/fresh and the acknowledgement', () => {
  assert.equal(storageNeedsMode({ storage: bundled({ object_count: 5 }), provider: 'external' }), true);
  assert.equal(storageNeedsMode({ storage: bundled({ object_count: 0 }), provider: 'external' }), false);
  assert.equal(storageNeedsMode({ storage: bundled(), provider: 'external' }), false, 'unknown count: the server decides');
  assert.equal(storageNeedsMode({ storage: external(), provider: 'bundled', refusal: { code: 'STORAGE_HAS_OBJECTS', options: [] } }), true);
  const form = { ...storageFormDefaults(bundled()), endpoint: 'https://s3.example.com', bucket: 'files', access_key_id: 'a', secret_access_key: 'b' };
  const noChoice = storageSwitchBody(form, { storage: bundled({ object_count: 5 }), needsMode: true });
  assert.equal(noChoice.ok, false);
  assert.ok(noChoice.errors.mode && noChoice.errors.acknowledge);
  const fresh = storageSwitchBody({ ...form, mode: 'fresh', acknowledge: true }, { storage: bundled({ object_count: 5 }), needsMode: true });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.body.mode, 'fresh');
  assert.equal(fresh.body.acknowledge, true);
  const copy = storageSwitchBody({ ...form, mode: 'copy', acknowledge: true }, { storage: bundled({ object_count: 5 }), needsMode: true });
  assert.equal(copy.body.mode, 'copy');
  assert.equal(ackText('bundled'), 'Existing files stay in the preserved bundled storage. Turning bundled storage back on brings them back.');
  assert.match(ackText('external'), /external storage/);
  // Back to bundled: no external fields at all.
  const back = storageSwitchBody({ ...storageFormDefaults(external()), mode: 'copy', acknowledge: true }, { storage: external(), needsMode: true });
  assert.deepEqual(back.body, { action: 'switch', provider: 'bundled', mode: 'copy', acknowledge: true });
});

test('embeddings switch: OpenAI defaults, compatible needs a base URL, local is fixed, nothing-changed is caught', () => {
  const d = embeddingsFormDefaults(local());
  assert.deepEqual([d.provider, d.model, d.dimensions, d.api_key], ['openai', 'text-embedding-3-small', '1536', '']);
  const noKey = embeddingsSwitchBody(d, { embeddings: local() });
  assert.equal(noKey.ok, false);
  assert.ok(noKey.errors.api_key);
  const openai = embeddingsSwitchBody({ ...d, api_key: 'sk-test' }, { embeddings: local() });
  assert.deepEqual(openai.body, { action: 'switch', provider: 'openai', config: { model: 'text-embedding-3-small', dimensions: 1536 }, credentials: { api_key: 'sk-test' } });
  assert.equal(reembedNeeded(local(), openai.body), true);

  const comp = embeddingsFormDefaults(local(), 'openai_compatible');
  assert.equal(comp.model, '');
  const compBad = embeddingsSwitchBody({ ...comp, model: 'nomic', dimensions: '768' }, { embeddings: local() });
  assert.ok(compBad.errors.base_url);
  const compOk = embeddingsSwitchBody({ ...comp, base_url: 'https://emb.example.com/v1', model: 'nomic', dimensions: '768' }, { embeddings: local() });
  assert.equal(compOk.ok, true, 'a compatible service may need no key');
  assert.deepEqual(compOk.body.config, { model: 'nomic', dimensions: 768, base_url: 'https://emb.example.com/v1' });

  const toLocal = embeddingsSwitchBody(embeddingsFormDefaults({ provider: 'openai', config: { model: 'text-embedding-3-small', dimensions: 1536 } }, 'local'), { embeddings: { provider: 'openai', config: { model: 'text-embedding-3-small', dimensions: 1536 } } });
  assert.deepEqual(toLocal.body, { action: 'switch', provider: 'local', config: { model: LOCAL_MODEL, dimensions: LOCAL_DIMENSIONS } });

  const current = { provider: 'openai', config: { model: 'text-embedding-3-small', dimensions: 1536 }, has_secret: { api_key: true } };
  const same = embeddingsSwitchBody(embeddingsFormDefaults(current), { embeddings: current });
  assert.equal(same.ok, false);
  assert.match(same.errors.form, /^Nothing changed/);
  const rotate = embeddingsSwitchBody({ ...embeddingsFormDefaults(current), api_key: 'sk-new' }, { embeddings: current });
  assert.equal(rotate.ok, true, 'a new key alone is a change');
  assert.equal(reembedNeeded(current, rotate.body), false);
  assert.equal(embeddingsSwitchBody({ ...d, api_key: 'k', dimensions: '0' }, { embeddings: local() }).errors.dimensions, 'Use a whole number from 1 to 16000.');
});

test('database exception: 10–2000 characters of the person\'s own words plus the acknowledgement', () => {
  assert.ok(exceptionBody('too short', true).errors.request_text);
  assert.ok(exceptionBody('x'.repeat(2001), true).errors.request_text);
  assert.ok(exceptionBody('Please build this with SQLite.', false).errors.acknowledge);
  const ok = exceptionBody('  Please build this with SQLite, it runs offline.  ', true);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body, { engine: 'sqlite', request_text: 'Please build this with SQLite, it runs offline.', acknowledge: true });
});

test('jobs: progress in files/bytes or items, cancellable while active, outcome says nothing switched on failure', () => {
  const run = jobView({ id: 'j1', kind: 'storage_migrate', state: 'running', progress: { objects_done: 300, objects_total: 1204, bytes_done: 50 * 1024 ** 2, bytes_total: 200 * 1024 ** 2 } });
  assert.equal(run.feature, 'storage');
  assert.equal(run.percent, 24);
  assert.equal(run.progressText, '300 of 1,204 files · 50.0 MB of 200 MB');
  assert.equal(run.cancellable, true);
  const re = jobView({ id: 'j2', kind: 'reembed', state: 'running', progress: { items_done: 10, items_total: 40, phase: 'validating' } });
  assert.equal(re.progressText, '10 of 40 items');
  assert.equal(re.phaseText, 'Checking the new index');
  assert.equal(jobView({ id: 'j', kind: 'reembed', state: 'queued' }).percent, null);
  const failed = jobView({ id: 'j3', kind: 'storage_migrate', state: 'failed', error: 'sha256 mismatch on a.png' });
  assert.equal(failed.cancellable, false);
  assert.match(failed.outcome, /^Failed: sha256 mismatch on a\.png\. Nothing was switched/);
  assert.match(jobView({ kind: 'storage_migrate', state: 'succeeded' }).outcome, /verified/);
  assert.deepEqual(activeJobs({ jobs: [{ id: 1, state: 'running' }, { id: 2, state: 'succeeded' }, { id: 3, state: 'queued' }] }).map((j) => j.id), [1, 3]);
  assert.equal(jobFeature({ feature: 'embeddings', kind: 'storage_migrate' }), 'embeddings');
});

test('has_secret accepts both short and contract-named keys', () => {
  assert.equal(hasSecret('embeddings', { has_secret: { 'embeddings.api_key': true } }, 'api_key'), true);
  assert.equal(hasSecret('embeddings', { has_secret: { api_key: false } }, 'api_key'), false);
  assert.equal(hasSecret('embeddings', {}, 'api_key'), false);
});
