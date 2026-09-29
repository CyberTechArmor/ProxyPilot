import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { operationsFixture } from './helpers/operations-fixture.js';
import { createOperationalCredentialStore } from '../lib/operational-credential-bindings.js';
import { WORKER_INSTALL_BASELINE, WORKER_TARGET, createOperationalWorkerStore, createWorkerLauncher,
  validateBrowserAction, validateWorkerLaunch } from '../lib/operational-worker-boundary.js';

const hash = 'a'.repeat(64);
const origin = 'https://demo.fractionate.ai';
const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts');

function setup(actions = ['navigate','click','type','read','logout']) {
  const f = operationsFixture();
  const owner = f.addUser(), reviewer = f.addUser(), stranger = f.addUser();
  const p = f.store.create(owner, { name: 'A4 fixture' });
  f.store.grant(owner, p.id, reviewer.id, p.revision, { role: 'reviewer' });
  f.store.site(owner, p.id, f.store.get(owner, p.id).revision, { site_origin: origin });
  f.store.agentLimits(owner, p.id, f.store.get(owner, p.id).revision, { limits: { max_tokens: 2000, max_usd: 0.001 } });
  const created = f.store.createProfile(owner, p.id, f.store.get(owner, p.id).revision,
    { display_name: 'Synthetic', workflow_type: 'synthetic_sign_in', proposed_actions: actions,
      proposed_origins: [origin] }).profile;
  f.store.saveDraft(owner, p.id, 1, { title: 'Guide', instructions: 'Synthetic only' });
  const submitted = f.store.submit(owner, p.id, 2, {}).submission;
  const version = f.store.review(reviewer, p.id, submitted.id, 1, { decision: 'approve' }).version;
  const profile = f.store.assignProfile(owner, p.id, created.id, created.revision, { guide_version_id: version.id }).profile;
  const project = f.store.get(owner, p.id);
  const config = { project_id: p.id, profile_id: profile.id, profile_revision: profile.revision, site_origin: origin,
    site_revision: project.site_revision, guide_version_id: version.id, guide_hash: version.content_hash,
    policy_digest: hash };
  return { f, owner, stranger, p, profile, config };
}

const bindInput = (s, binding_id = randomUUID()) => ({ binding_id, project_id: s.p.id, profile_id: s.profile.id,
  username: 'a4-fixture@demo.fractionate.ai', vault_mount: 'pp-kv', vault_path: 'agents/a4-broker/a4-fixture-password',
  vault_version: 1 });

test('migration 1110 stores a vault path and version, never a value, with immutable history', () => {
  const s = setup();
  try {
    const columns = s.f.db.prepare("SELECT name FROM pragma_table_info('ops_agent_credential_bindings')").all()
      .map(c => c.name);
    assert.deepEqual(columns.filter(c => /value|secret|password|token|hash|key/i.test(c)), []);
    assert.ok(columns.includes('vault_path') && columns.includes('vault_version') && columns.includes('revision'));
    const runColumns = s.f.db.prepare("SELECT name FROM pragma_table_info('ops_agent_runs')").all().map(c => c.name);
    assert.ok(runColumns.includes('credential_binding_id') && runColumns.includes('credential_binding_revision'));
    const bindings = createOperationalCredentialStore(s.f.db);
    const bound = bindings.bind(s.owner, bindInput(s));
    assert.deepEqual(bound.vault, { mount: 'pp-kv', path: 'agents/a4-broker/a4-fixture-password', version: 1 });
    bindings.revoke(s.owner, { binding_id: bound.binding_id });
    assert.throws(() => s.f.db.prepare("UPDATE ops_agent_credential_bindings SET state='active' WHERE id=?")
      .run(bound.binding_id), /immutable/);
    assert.throws(() => s.f.db.prepare('DELETE FROM ops_agent_credential_bindings').run(), /immutable/);
    assert.throws(() => s.f.db.prepare('DELETE FROM ops_agent_credential_binding_events').run(), /immutable/);
    const kinds = s.f.db.prepare('SELECT kind,revision FROM ops_agent_credential_binding_events ORDER BY id').all()
      .map(e => [e.kind, e.revision]);
    assert.deepEqual(kinds, [['created', 1], ['revoked', 1]]);
  } finally { s.f.close(); }
});

test('only the project owner authorizes a binding; no value field is accepted', () => {
  const s = setup();
  try {
    const bindings = createOperationalCredentialStore(s.f.db);
    assert.throws(() => bindings.bind(s.stranger, bindInput(s)), { code: 'FORBIDDEN' });
    for (const bad of [{ value: 'A4-secret' }, { password: 'x' }, { vault_path: '../sys/raw' }, { vault_version: 0 },
      { username: 'Not Email' }, { binding_id: 'x' }])
      assert.throws(() => bindings.bind(s.owner, { ...bindInput(s), ...bad }), { code: 'INVALID_BINDING' });
    const bound = bindings.bind(s.owner, bindInput(s));
    assert.throws(() => bindings.bind(s.owner, bindInput(s, bound.binding_id)), { code: 'BINDING_EXISTS' });
    assert.throws(() => bindings.bind(s.owner, bindInput(s)), /UNIQUE/);   // one active binding per profile
    assert.throws(() => bindings.rotate(s.owner, { binding_id: bound.binding_id, expected_revision: 2, vault_version: 2 }),
      { code: 'BINDING_REVISION_MISMATCH' });
    const rotated = bindings.rotate(s.owner, { binding_id: bound.binding_id, expected_revision: 1, vault_version: 2 });
    assert.equal(rotated.revision, 2);
    assert.throws(() => bindings.rotate(s.stranger, { binding_id: bound.binding_id, expected_revision: 2,
      vault_version: 3 }), { code: 'FORBIDDEN' });
    assert.equal(bindings.revoke(s.owner, { binding_id: bound.binding_id }).state, 'revoked');
    assert.throws(() => bindings.revoke(s.owner, { binding_id: bound.binding_id }), { code: 'BINDING_REVOKED' });
  } finally { s.f.close(); }
});

test('a run pins the binding revision; rotation and revocation refuse at launch and at the next submit', () => {
  const s = setup();
  try {
    let now = new Date('2026-09-28T12:00:00Z');
    const bindings = createOperationalCredentialStore(s.f.db, () => now);
    const workers = createOperationalWorkerStore(s.f.db, () => now, randomUUID, () => true);
    const bound = bindings.bind(s.owner, bindInput(s));
    const prepared = workers.prepare({ ...s.config, credential_binding_id: bound.binding_id });
    assert.equal(prepared.credential_binding_revision, 1);
    const a = workers.reserveAttempt(prepared.run_id);
    const spec = workers.launchSpec(a);
    assert.deepEqual(spec.credential, { project_id: s.p.id, profile_id: s.profile.id,
      profile_revision: s.profile.revision, binding_id: bound.binding_id, binding_revision: 1 });
    assert.deepEqual(spec.limits, { max_tokens: 2000, max_usd: 0.001 });
    workers.markRunning(a);
    const ref = { run_id: a.run_id, attempt_id: a.attempt_id, fence: a.fence };
    assert.throws(() => workers.authorizeAction({ ...ref, action: 'submit_bound_fixture' }), { code: 'INVALID_BROWSER_ACTION' });
    assert.throws(() => workers.authorizeAction({ ...ref, action: 'submit_bound_fixture', binding_id: randomUUID() }),
      { code: 'BINDING_MISMATCH' });
    assert.equal(workers.authorizeAction({ ...ref, action: 'submit_bound_fixture', binding_id: bound.binding_id })
      .ordinal, 1);
    bindings.rotate(s.owner, { binding_id: bound.binding_id, expected_revision: 1, vault_version: 2 });
    assert.throws(() => workers.authorizeAction({ ...ref, action: 'submit_bound_fixture', binding_id: bound.binding_id }),
      { code: 'CREDENTIAL_REVISION_MISMATCH' });
    assert.throws(() => workers.authorizeAction({ ...ref, action: 'read_session' }),
      { code: 'CREDENTIAL_REVISION_MISMATCH' });
    workers.fence(prepared.run_id);
    workers.finishStop(prepared.run_id, 'cancelled', { run_id: prepared.run_id, attempt_id: a.attempt_id,
      fence: a.fence, descendants_gone: true, workspace_removed: true, attestation: 'test-only' });
    // A new run pins revision 2 and launches; then revocation refuses it at once.
    const second = workers.prepare({ ...s.config, credential_binding_id: bound.binding_id });
    assert.equal(second.credential_binding_revision, 2);
    const b = workers.reserveAttempt(second.run_id);
    assert.equal(workers.launchSpec(b).credential.binding_revision, 2);
    bindings.revoke(s.owner, { binding_id: bound.binding_id });
    assert.throws(() => workers.launchSpec(b), { code: 'CREDENTIAL_BINDING_REVOKED' });
    assert.throws(() => workers.markRunning(b), { code: 'CREDENTIAL_BINDING_REVOKED' });
    workers.recover();
    workers.finishStop(second.run_id, 'blocked', { run_id: second.run_id, attempt_id: b.attempt_id, fence: b.fence,
      descendants_gone: true, workspace_removed: true, attestation: 'test-only' });
    assert.throws(() => workers.prepare({ ...s.config, credential_binding_id: bound.binding_id }),
      { code: 'CREDENTIAL_BINDING_REVOKED' });
    // A run prepared without a binding cannot submit one.
    const plain = workers.prepare(s.config), c = workers.reserveAttempt(plain.run_id);
    assert.equal('credential' in workers.launchSpec(c), false);
    workers.markRunning(c);
    assert.throws(() => workers.authorizeAction({ run_id: c.run_id, attempt_id: c.attempt_id, fence: c.fence,
      action: 'submit_bound_fixture', binding_id: bound.binding_id }), { code: 'CREDENTIAL_NOT_BOUND' });
  } finally { s.f.close(); }
});

test('a binding needs a profile that may type', () => {
  const s = setup(['navigate','click','read']);
  try {
    const bound = createOperationalCredentialStore(s.f.db).bind(s.owner, bindInput(s));
    const workers = createOperationalWorkerStore(s.f.db);
    assert.throws(() => workers.prepare({ ...s.config, credential_binding_id: bound.binding_id }),
      { code: 'ACTION_NOT_CONFIGURED' });
  } finally { s.f.close(); }
});

test('launch and action contracts carry the pin and the binding ID only', async () => {
  const credential = { project_id: randomUUID(), profile_id: randomUUID(), profile_revision: 2,
    binding_id: randomUUID(), binding_revision: 1 };
  const spec = { run_id: randomUUID(), attempt_id: randomUUID(), workspace_id: randomUUID(), fence: 1,
    policy_digest: hash, project_limits_revision: 1, origin, target: WORKER_TARGET, limits: {},
    install: { ...WORKER_INSTALL_BASELINE }, credential };
  assert.deepEqual(validateWorkerLaunch(spec).credential, credential);
  for (const bad of [null, { ...credential, value: 'x' }, { ...credential, binding_revision: 0 },
    { ...credential, binding_id: 'x' }])
    assert.throws(() => validateWorkerLaunch({ ...spec, credential: bad }), { code: 'INVALID_LAUNCH' });
  const ref = { run_id: spec.run_id, attempt_id: spec.attempt_id, fence: 1 };
  validateBrowserAction({ ...ref, action: 'submit_bound_fixture', binding_id: credential.binding_id });
  for (const bad of [{ action: 'submit_bound_fixture' }, { action: 'submit_bound_fixture', binding_id: 'x' },
    { action: 'open_landing', binding_id: credential.binding_id },
    { action: 'submit_bound_fixture', binding_id: credential.binding_id, value: 'x' }])
    assert.throws(() => validateBrowserAction({ ...ref, ...bad }), { code: 'INVALID_BROWSER_ACTION' });
  const sent = [];
  const client = { request: async (method, params) => {
    sent.push([method, params]);
    return { ordinal: 3, untrusted: true, result: { binding_id: params.binding_id, binding_revision: 1,
      outcome: 'signed_in', login_requests: 1, untrusted_page_claim_authenticated_as_bound_account: true } };
  } };
  const launcher = createWorkerLauncher({ client, vmUuid: '49592202-a8b0-45af-9ac6-5439761d73e4' });
  const result = await launcher.action({ ...ref, action: 'submit_bound_fixture', binding_id: credential.binding_id });
  assert.equal(result.result.outcome, 'signed_in');
  assert.deepEqual(sent[0], ['action', { ...ref, action: 'submit_bound_fixture', binding_id: credential.binding_id }]);
  const wrong = createWorkerLauncher({ vmUuid: '49592202-a8b0-45af-9ac6-5439761d73e4', client: {
    request: async () => ({ ordinal: 3, untrusted: true, result: { binding_id: randomUUID(), binding_revision: 1,
      outcome: 'signed_in' } }) } });
  await assert.rejects(wrong.action({ ...ref, action: 'submit_bound_fixture', binding_id: credential.binding_id }),
    { code: 'SUPERVISOR_PROTOCOL' });
});

test('the backend launch contract is accepted by the host supervisor exactly', { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
  const s = setup();
  try {
    const bound = createOperationalCredentialStore(s.f.db).bind(s.owner, bindInput(s));
    const workers = createOperationalWorkerStore(s.f.db);
    const r = workers.prepare({ ...s.config, credential_binding_id: bound.binding_id });
    const withBinding = workers.launchSpec(workers.reserveAttempt(r.run_id));
    const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('sup', sys.argv[1])
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
for line in sys.stdin:
    s.validate_launch(json.loads(line))
print('ok')`;
    const input = `${JSON.stringify(withBinding)}\n`;
    const result = spawnSync('python3', ['-I', '-c', code, path.join(scripts, 'a3-worker-supervisor.py')],
      { input, encoding: 'utf8' });
    assert.equal(result.stdout.trim(), 'ok', result.stderr);
  } finally { s.f.close(); }
});
