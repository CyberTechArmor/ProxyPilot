import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { operationsFixture, fixtureRouter } from './helpers/operations-fixture.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { csrfProtection } from '../middleware/csrf.js';
import { browserDraftHash, canonicalBrowserDraft, validateBrowserDraftImport } from '../lib/operational-browser-agent-proposal.js';

const fixtureUrl = new URL('../../../../contracts/browser-agent/fixtures/general-agent.draft.json', import.meta.url);
const body = () => ({ configuration: JSON.parse(readFileSync(fixtureUrl, 'utf8')) });
const withWorld = fn => async () => {
  const f = operationsFixture(), owner = f.addUser(), p = f.store.create(owner, { name: 'Browser draft fixtures' });
  const revision = () => f.store.get(owner, p.id).revision;
  try { await fn({ f, owner, p, revision }); } finally { f.close(); }
};
const fails = (status, fn, code) => assert.throws(fn, e => e.status === status && (!code || e.code === code));
const count = (f, table) => f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const create = w => w.f.store.createBrowserConfiguration(w.owner, w.p.id, w.revision(), body());

test('generated runtime schema is byte-identical to the proposal and rejects raw authority fields', () => {
  assert.equal(readFileSync(new URL('../lib/operational-browser-agent-proposal.schema.json', import.meta.url), 'utf8'),
    readFileSync(new URL('../../../../contracts/browser-agent/proposal-v1.schema.json', import.meta.url), 'utf8'));
  const b = body(), v = validateBrowserDraftImport(b);
  assert.equal(v.configuration.destinations.network_scope, 'explicit_destinations');
  assert.equal(v.configuration.permissions.external_change_approval, 'per_action');
  for (const field of ['password', 'cookie', 'token', 'execution_enabled', 'approved', 'credentials']) {
    const bad = body(); bad.configuration[field] = 'CANARY_VALUE';
    fails(400, () => validateBrowserDraftImport(bad), 'BROWSER_DRAFT_INVALID');
  }
  const reordered = Object.fromEntries(Object.entries(b.configuration).reverse());
  assert.equal(validateBrowserDraftImport({ configuration: reordered }).configuration_sha256, v.configuration_sha256);
  assert.equal(canonicalBrowserDraft(b.configuration), v.configuration_json);
});

test('import cannot weaken the user-selected per-action and destination approval policy', () => {
  for (const scope of [null, 'public_internet', 'approved_internal', 'unrestricted']) {
    const b = body(); b.configuration.destinations.network_scope = scope;
    fails(400, () => validateBrowserDraftImport(b), 'BROWSER_DRAFT_INVALID');
  }
  for (const approval of [null, 'named_preauthorizations', 'never']) {
    const b = body(); b.configuration.permissions.external_change_approval = approval;
    fails(400, () => validateBrowserDraftImport(b), 'BROWSER_DRAFT_INVALID');
  }
  for (const [field, value] of [['persist_to_allowlist', true], ['wildcards', true], ['lifetime', 'permanent'], ['scope', 'any_site']]) {
    const b = body(); b.configuration.destinations.off_list_approval[field] = value;
    fails(400, () => validateBrowserDraftImport(b), 'BROWSER_DRAFT_INVALID');
  }
  const named = body(); named.configuration.permissions.preauthorization_refs = [{ id: randomUUID(), revision: 1, sha256: 'a'.repeat(64) }];
  fails(400, () => validateBrowserDraftImport(named), 'BROWSER_DRAFT_INVALID');
});

test('exact internal names, addresses and ports are draft metadata with no reachability or execution grant', withWorld(w => {
  for (const origin of ['https://intranet', 'https://internal.example.com:8443', 'https://10.24.8.12', 'https://[fd12::1]:8443', 'http://intranet:8080']) {
    const b = body(), d = b.configuration.destinations;
    d.allowed_origins = [{ id: 'selected-site', origin, roles: ['navigation', 'resource'], session_headers: 'omit' }];
    d.entry_urls = [origin + '/']; d.network_policy_ref = { id: randomUUID(), sha256: 'a'.repeat(64) };
    const r = w.f.store.validateBrowserConfiguration(w.owner, w.p.id, b);
    assert.equal(r.configuration.destinations.allowed_origins[0].origin, origin);
    assert.equal(r.readiness.can_start, false);
    for (const code of ['RUNNER_REACHABILITY_UNVERIFIED', 'EXACT_TARGET_NETWORK_POLICY_UNVERIFIED', 'SELECTED_BROWSER_RUNTIME_NOT_IMPLEMENTED'])
      assert(r.readiness.checks.some(c => c.code === code));
  }
  assert.equal(count(w.f, 'ops_browser_agent_configurations'), 0);
  assert.equal(count(w.f, 'ops_agent_runs'), 0);
  const insecure = body(); insecure.configuration.destinations.allowed_origins[0].origin = 'http://intranet';
  insecure.configuration.destinations.entry_urls = ['http://intranet/'];
  fails(400, () => validateBrowserDraftImport(insecure), 'BROWSER_INSECURE_SESSION_DESTINATION');
  for (const origin of ['https://internal.example.com:443', 'https://internal.example.com:65536', 'https://10.024.8.12', 'https://[fd12:0::1]']) {
    const b = body(); b.configuration.destinations.allowed_origins[0].origin = origin;
    fails(400, () => validateBrowserDraftImport(b), 'BROWSER_DESTINATION_INVALID');
  }
}));

test('import validation checks destination roles, current asset pins, request classification and UTF-8 limits', () => {
  const duplicate = body(); duplicate.configuration.destinations.allowed_origins[1].origin = 'https://example.com';
  fails(400, () => validateBrowserDraftImport(duplicate), 'BROWSER_DESTINATION_DUPLICATE');
  const outside = body(); outside.configuration.destinations.entry_urls = ['https://other.example.com/'];
  fails(400, () => validateBrowserDraftImport(outside), 'BROWSER_ENTRY_OUTSIDE_ALLOWLIST');
  const resource = body(); resource.configuration.destinations.allowed_origins[1].session_headers = 'this_origin_session';
  fails(400, () => validateBrowserDraftImport(resource), 'BROWSER_RESOURCE_SESSION_HEADERS_DENIED');
  for (const url of ['https://user:pass@example.com/', 'https://@example.com/', 'https://example.com:8443/', 'https://example.com./']) {
    const b = body(); b.configuration.destinations.entry_urls = [url];
    fails(400, () => validateBrowserDraftImport(b), 'BROWSER_ENTRY_OUTSIDE_ALLOWLIST');
  }
  const fragment = body(); fragment.configuration.destinations.entry_urls = ['https://example.com/#section'];
  validateBrowserDraftImport(fragment);
  const write = body(); write.configuration.destinations.request_rules = [{ id: 'r1', destination_id: 'site-1',
    path_prefix: '/', methods: ['POST'], query_keys: [], resource_types: ['fetch'], effect: 'read', max_request_bytes: 1024 }];
  fails(400, () => validateBrowserDraftImport(write), 'BROWSER_READ_METHOD_REVIEW_REQUIRED');
  const assets = body(), a = { id: randomUUID(), sha256: 'a'.repeat(64), mime_type: 'text/plain', byte_count: 10 };
  assets.configuration.work.source_inputs = [a]; assets.configuration.artifacts.upload_asset_refs = [{ ...a, sha256: 'b'.repeat(64) }];
  fails(400, () => validateBrowserDraftImport(assets), 'BROWSER_ASSET_PIN_CONFLICT');
  const huge = body(); huge.configuration.work.instructions = '🙂'.repeat(30000);
  fails(400, () => validateBrowserDraftImport(huge), 'BROWSER_DRAFT_TOO_LARGE');
});

test('preview has no writes; create preserves source and is unconditionally non-executable', withWorld(w => {
  const { f, owner, p, revision } = w;
  const preview = f.store.validateBrowserConfiguration(owner, p.id, body());
  assert.equal(preview.persisted, false); assert.equal(preview.readiness.can_start, false);
  assert.equal(count(f, 'ops_browser_agent_configurations'), 0);
  const source_text = 'Original plain-language instruction.\nPreserve these bytes: café.';
  const saved = f.store.createBrowserConfiguration(owner, p.id, revision(), { ...body(), source_text });
  assert.equal(saved.configuration.source_text, source_text);
  assert.equal(saved.configuration.source_sha256, browserDraftHash(source_text));
  assert.equal(saved.configuration.revision, 1); assert.equal(saved.configuration.execution_enabled, false);
  assert.equal(saved.readiness.can_start, false); assert.equal(saved.readiness.execution_enabled, false);
  assert(saved.readiness.checks.some(c => c.code === 'PER_ACTION_APPROVAL_SELECTED'));
  assert(saved.readiness.checks.some(c => c.code === 'RUNNER_REACHABILITY_UNVERIFIED'));
  assert.equal(count(f, 'ops_browser_agent_configuration_versions'), 1);
  assert.equal(count(f, 'ops_agent_runs'), 0); assert.equal(count(f, 'ops_agent_credential_bindings'), 0);
  const event = f.db.prepare("SELECT * FROM ops_project_events WHERE action='browser_configuration_created'").get();
  assert.equal(event.metadata_json.includes(source_text), false);
  assert.deepEqual(Object.keys(JSON.parse(event.metadata_json)).sort(), ['configuration_sha256', 'revision', 'source_sha256']);
  assert.throws(() => f.db.prepare('UPDATE ops_browser_agent_configurations SET execution_enabled=1 WHERE id=?').run(saved.configuration.id), /CHECK constraint/);
}));

test('update keeps original source by default and appends immutable version snapshots', withWorld(w => {
  const { f, owner, p } = w, first = create(w).configuration, update = body();
  update.configuration.work.instructions = 'Updated structured task instructions.';
  update.configuration.name = 'Revised draft';
  const second = f.store.updateBrowserConfiguration(owner, p.id, first.id, first.revision, update).configuration;
  assert.equal(second.revision, 2); assert.equal(second.source_text, first.source_text);
  assert.notEqual(second.configuration_sha256, first.configuration_sha256);
  const versions = f.db.prepare('SELECT * FROM ops_browser_agent_configuration_versions WHERE configuration_id=? ORDER BY revision').all(first.id);
  assert.equal(versions.length, 2);
  assert.equal(JSON.parse(versions[0].configuration_json).work.instructions, first.configuration.work.instructions);
  assert.equal(versions[0].source_text, first.source_text);
  assert.throws(() => f.db.prepare("UPDATE ops_browser_agent_configuration_versions SET source_text='changed'").run(), /immutable/);
  assert.throws(() => f.db.prepare('DELETE FROM ops_browser_agent_configuration_versions').run(), /immutable/);
  const third = f.store.updateBrowserConfiguration(owner, p.id, first.id, 2, { ...update, source_text: 'Explicit replacement source.' }).configuration;
  assert.equal(third.source_text, 'Explicit replacement source.');
  assert.equal(count(f, 'ops_browser_agent_configuration_versions'), 3);
}));

test('stale revisions and failing snapshot insertion roll back draft updates and audit', withWorld(w => {
  const { f, owner, p, revision } = w, first = create(w).configuration;
  fails(412, () => f.store.createBrowserConfiguration(owner, p.id, revision() + 1, body()));
  fails(412, () => f.store.updateBrowserConfiguration(owner, p.id, first.id, 2, body()));
  const events = count(f, 'ops_project_events');
  f.db.exec(`CREATE TEMP TRIGGER reject_browser_version BEFORE INSERT ON ops_browser_agent_configuration_versions
    BEGIN SELECT RAISE(ABORT, 'fixture snapshot failure'); END;`);
  const changed = body(); changed.configuration.name = 'Should roll back';
  assert.throws(() => f.store.updateBrowserConfiguration(owner, p.id, first.id, 1, changed), /snapshot failure/);
  assert.equal(f.store.browserConfiguration(owner, p.id, first.id).configuration.revision, 1);
  assert.equal(count(f, 'ops_browser_agent_configuration_versions'), 1);
  assert.equal(count(f, 'ops_project_events'), events);
}));

test('current guide pin is validated and withdrawal/staleness is visible without execution', withWorld(w => {
  const { f, owner, p, revision } = w;
  const guide = f.store.saveDraft(owner, p.id, f.store.draft(owner, p.id).revision, { title: 'Browser guide', instructions: 'Review selected pages.' }).version;
  const b = body(); b.configuration.work.guide_ref = { id: guide.id, sha256: guide.content_hash };
  const saved = f.store.createBrowserConfiguration(owner, p.id, revision(), b).configuration;
  assert(f.store.browserConfiguration(owner, p.id, saved.id).readiness.checks.some(c => c.kind === 'guide' && c.state === 'ready'));
  const wrong = body(); wrong.configuration.work.guide_ref = { id: randomUUID(), sha256: guide.content_hash };
  fails(409, () => f.store.validateBrowserConfiguration(owner, p.id, wrong));
  f.store.startRevision(owner, p.id, f.store.draft(owner, p.id).revision, { version_id: guide.id, discard_draft: true });
  f.store.saveDraft(owner, p.id, f.store.draft(owner, p.id).revision, { title: 'New guide', instructions: 'Different task.' });
  const current = f.store.browserConfiguration(owner, p.id, saved.id);
  assert(current.readiness.checks.some(c => c.kind === 'guide' && c.code === 'GUIDE_STALE'));
  assert.equal(current.readiness.can_start, false);
  fails(409, () => f.store.updateBrowserConfiguration(owner, p.id, saved.id, 1, b));
}));

test('project isolation, role revocation, archive and administrator non-bypass apply to browser drafts', withWorld(w => {
  const { f, owner, p, revision } = w, editor = f.addUser(), viewer = f.addUser(), admin = f.addUser('admin');
  f.store.grant(owner, p.id, editor.id, revision(), { role: 'editor' });
  f.store.grant(owner, p.id, viewer.id, revision(), { role: 'viewer' });
  const saved = f.store.createBrowserConfiguration(editor, p.id, revision(), body()).configuration;
  f.store.browserConfiguration(viewer, p.id, saved.id);
  fails(403, () => f.store.validateBrowserConfiguration(viewer, p.id, body()));
  fails(404, () => f.store.browserConfiguration(admin, p.id, saved.id));
  const other = f.store.create(owner, { name: 'Other project' });
  fails(404, () => f.store.browserConfiguration(owner, other.id, saved.id));
  f.db.prepare('DELETE FROM ops_project_grants WHERE project_id=? AND user_id=?').run(p.id, editor.id);
  fails(404, () => f.store.updateBrowserConfiguration(editor, p.id, saved.id, 1, body()));
  f.store.archive(owner, p.id, revision(), { reason: 'Frozen' });
  fails(409, () => f.store.updateBrowserConfiguration(owner, p.id, saved.id, 1, body()));
  assert(f.store.browserConfiguration(owner, p.id, saved.id).readiness.checks.some(c => c.code === 'PROJECT_ARCHIVED'));
}));

test('additive draft persistence does not alter legacy synthetic or typed API configurations', withWorld(w => {
  const { f, owner, p, revision } = w;
  const profile = f.store.createProfile(owner, p.id, revision(), { display_name: 'Legacy synthetic', workflow_type: 'synthetic_sign_in',
    proposed_actions: ['navigate'], proposed_origins: ['https://demo.fractionate.ai'] }).profile;
  const api = f.store.createConfiguration(owner, p.id, { workflow_type: 'typed_api_v1', work: { name: 'Legacy API' } }).agent;
  const oldProfile = f.db.prepare('SELECT * FROM ops_agent_profiles WHERE id=?').get(profile.id);
  const oldApi = f.db.prepare('SELECT * FROM ops_agent_configurations WHERE id=?').get(api.id);
  create(w);
  assert.deepEqual(f.db.prepare('SELECT * FROM ops_agent_profiles WHERE id=?').get(profile.id), oldProfile);
  assert.deepEqual(f.db.prepare('SELECT * FROM ops_agent_configurations WHERE id=?').get(api.id), oldApi);
  const list = f.store.browserConfigurations(owner, p.id, { limit: '1' });
  assert.equal(list.configurations.length, 1);
  assert.equal('configuration' in list.configurations[0], false);
  assert.equal('source_text' in list.configurations[0], false);
}));

test('draft routes enforce metadata gate, revisions, CSRF and no execution endpoint', withWorld(async w => {
  const { f, owner, p, revision } = w;
  const make = options => createOperationsRouter({ Router: fixtureRouter, store: f.store, enabled: true, agentsEnabled: true,
    lookupLimiter: (_r, _s, next) => next(), ...options });
  const path = `/${p.id}/browser-agent-configurations`, router = make({});
  const req = (method, suffix = '', input = body(), expected) => ({ method, path: path + suffix, url: path + suffix,
    originalUrl: `/api/operations/projects${path}${suffix}`, cookies: {}, user: owner, body: input,
    headers: expected == null ? {} : { 'if-match': `"${expected}"` } });
  const preview = await router.dispatch(req('POST', '/validate'));
  assert.equal(preview.statusCode, 200); assert.equal(preview.body.persisted, false);
  assert.equal((await router.dispatch(req('POST'))).statusCode, 428);
  assert.equal((await make({ agentsEnabled: false }).dispatch(req('POST', '/validate'))).statusCode, 404);
  assert.equal((await router.dispatch(req('POST', '', body(), revision()), [csrfProtection])).statusCode, 403);
  const authorized = req('POST', '', body(), revision()); authorized.cookies.pp_csrf = 'fixture'; authorized.headers['x-csrf-token'] = 'fixture';
  const created = await router.dispatch(authorized, [csrfProtection]);
  assert.equal(created.statusCode, 201); assert.equal(created.headers.etag, '"1"');
  const id = created.body.configuration.id;
  assert.equal((await router.dispatch(req('POST', `/${id}/start`, {}, 1))).statusCode, 404);
  assert.equal((await router.dispatch(req('PATCH', `/${id}`, body(), 2))).statusCode, 412);
  const changed = await router.dispatch(req('PATCH', `/${id}`, body(), 1));
  assert.equal(changed.statusCode, 200); assert.equal(changed.headers.etag, '"2"');
  const r = await router.dispatch(req('GET', `/${id}/readiness`, {}));
  assert.equal(r.body.readiness.can_start, false); assert.equal(r.body.readiness.execution_enabled, false);
  const bad = body(); bad.configuration.destinations.network_scope = 'public_internet';
  const refusal = await router.dispatch(req('POST', '/validate', bad));
  assert.equal(refusal.statusCode, 400); assert.equal(refusal.body.code, 'BROWSER_DRAFT_INVALID');
  assert.equal(count(f, 'ops_agent_runs'), 0);
}));
