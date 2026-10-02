import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as immediate } from 'node:timers/promises';
import { operationsFixture } from './helpers/operations-fixture.js';
import { operationalSelectedBrowserMigration1118 } from '../lib/operational-selected-browser-schema.js';
import { operationalBrowserArtifactsMigration1119 } from '../lib/operational-browser-artifacts-schema.js';
import { operationalBrowserConversionMigration1120 } from '../lib/operational-browser-conversion.js';
import { browserArtifactsConfiguration, createSelectedBrowserAttestationVerifier, createSelectedBrowserRuntime,
  operationalSelectedBrowserRuntimeMigration1121 } from '../lib/operational-selected-browser-runtime.js';
import { browserDraftHash } from '../lib/operational-browser-agent-proposal.js';
import { browserModelRequestDigest } from '../lib/operational-browser-model.js';
import { BROWSER_ASSET_REVIEW_STATEMENT } from '../lib/operational-browser-artifacts-store.js';
import { recordControlGrant } from '../lib/operational-control-grants.js';
import { SELECTED_BROWSER_CONSENT } from '../lib/operational-selected-browser-contract.js';

const key = generateKeyPairSync('ed25519'), vm = randomUUID(), boot = randomUUID();
const publicKeyPem = key.publicKey.export({ format: 'pem', type: 'spki' });
const attestation = (payload, prefix = 'sbr1') => {
  const body = Buffer.from(JSON.stringify(payload));
  return prefix + '.' + body.toString('base64url') + '.' + sign(null, body, key.privateKey).toString('base64url');
};
const attest = (value, kind) => ({ ...value, attestation: attestation({ kind, ...value }) });
const attestModel = (value, kind) => ({ ...value, attestation: attestation({ kind, ...value }, 'pbm1') });
const decode = value => JSON.parse(Buffer.from(value.split('.')[1], 'base64url'));
const assetRef = a => ({ id: a.id, sha256: a.sha256, mime_type: a.mime_type, byte_count: a.byte_count });
const modelIdentity = ['run_id', 'attempt_id', 'fence', 'call_id', 'project_id', 'project_revision',
  'project_limits_revision', 'purpose', 'policy_hash', 'guide_version_id', 'guide_hash', 'consent_hash'];

// The runtime, lifecycle and private filesystem are real. Only the owned
// supervisor transport and timer are injected; no website/provider is called.
function world({ hostChange = () => {}, configured = true, privateStorage = configured, storageState = 'safe',
  decisions = ['candidate', 'escalate'], operation = { kind: 'read', scope: 'visible_page', selection_ref: null },
  streamOpening = () => {} } = {}) {
  const f = operationsFixture();
  for (const migrate of [operationalSelectedBrowserMigration1118, operationalBrowserArtifactsMigration1119,
    operationalBrowserConversionMigration1120, operationalSelectedBrowserRuntimeMigration1121]) migrate(f.adapter);
  f.db.exec('ALTER TABLE sessions ADD COLUMN sudo_until TEXT');
  const owner = f.addUser(), p = f.store.create(owner, { name: 'Selected runtime test' });
  const guide = f.store.saveDraft(owner, p.id, 1, { title: 'Current guide', instructions: 'Read selected pages and report sources.' }).version;
  const c = JSON.parse(readFileSync(new URL('../../../../contracts/browser-agent/fixtures/general-agent.draft.json', import.meta.url), 'utf8'));
  c.work.guide_ref = { id: guide.id, sha256: guide.content_hash };
  let config = f.store.createBrowserConfiguration(owner, p.id, f.store.get(owner, p.id).revision, { configuration: c }).configuration;
  let now = Date.now(), launched = null, observationCount = 0, decisionCount = 0, enabled = true, metadataEnabled = true;
  let nextOperation = operation, pending = [], counters = { requests: 0, response_bytes: 0 };
  const calls = [], streams = [], scheduled = [], logs = [], executed = [];
  const root = privateStorage ? mkdtempSync(path.join(tmpdir(), 'pp-selected-runtime-')) : null;
  if (root) chmodSync(root, 0o700);
  if (root && storageState === 'unsafe') chmodSync(root, 0o755);
  if (root && storageState === 'missing') rmSync(root, { recursive: true });
  const session = (actor = owner, fresh = false) => {
    if (fresh || !actor.jti) actor.jti = randomUUID();
    const expires = new Date(now + 3600000).toISOString();
    f.db.prepare(`INSERT INTO sessions(id,user_id,expires_at,sudo_until) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,sudo_until=excluded.sudo_until`).run(actor.jti, actor.id, expires, expires);
    recordControlGrant(f.adapter, { sessionId: actor.jti, userId: actor.id, factor: 'passkey', at: new Date(now).toISOString() });
    return actor;
  };
  session();
  const modelReply = params => {
    let answer;
    if (params.purpose === 'report') answer = { summary: 'The selected fixture page was reviewed.', citations: params.input.source_inputs.map(s => s.ref.id), limitations: [] };
    else {
      const selected = decisions[decisionCount++] ?? 'escalate';
      answer = typeof selected === 'function' ? selected(params) : selected === 'candidate'
        ? { kind: 'candidate', candidate_id: params.input.candidates[0].id }
        : { kind: selected, reason: 'The fixture has no further authorized action.' };
    }
    const reply = { text: JSON.stringify(answer), usage: { prompt_tokens: 100, completion_tokens: 10 }, settled_usd: '0.0001', price_table_revision: 1 };
    const payload = { kind: 'selected-browser-model', ...Object.fromEntries(modelIdentity.map(k => [k, params[k]])),
      request_hash: browserModelRequestDigest(params), response_hash: browserDraftHash(reply.text),
      usage: reply.usage, settled_usd: reply.settled_usd, price_table_revision: reply.price_table_revision };
    return { ...reply, attestation: attestation(payload, 'pbm1') };
  };
  const client = {
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      let out;
      if (method === 'selected_browser_status') out = attest({ contract_version: 'selected-browser.v1', supervisor_version: 'selected-browser.v1',
        policy_sha256: params.configuration_sha256, available: true, verified_supervisor: true, isolation: true, destinations: true,
        site_policy: true, vm_uuid: vm, valid_until: new Date(now + 30000).toISOString(), reachability: 'pending_launch_check' }, 'selected-browser-status');
      else if (method === 'selected_browser_model_status') out = attestModel({ contract_version: 'selected-browser-model.v1', available: true,
        price_table_revision: 1, prices: { input: 0.2, output: 1, cache_write: 0.2 }, valid_until: new Date(now + 30000).toISOString() }, 'selected-browser-model-status');
      else if (method === 'selected_browser_launch') {
        launched = params;
        out = attest({ contract_version: 'selected-browser.v1', run_id: params.run_id, attempt_id: params.attempt_id, fence: params.fence,
          policy_sha256: params.configuration_sha256, vm_uuid: vm, boot_id: boot, workspace_id: params.workspace_id,
          network_plan_sha256: 'b'.repeat(64), original_fence: params.fence }, 'selected-browser-launch');
      } else if (method === 'selected_browser_stop') {
        const signed = attest({ contract_version: 'selected-browser.v1', ...params, closed: { browser: true, network: true, session: true, temporary_files: true },
          vm_uuid: vm, boot_id: boot, workspace_id: params.attempt_id, network_plan_sha256: 'b'.repeat(64), original_fence: 1 }, 'selected-browser-teardown');
        out = Object.fromEntries(['contract_version', 'run_id', 'attempt_id', 'fence', 'policy_sha256', 'closed', 'attestation'].map(k => [k, signed[k]]));
      } else if (method === 'selected_browser_observe') {
        const observation = 'Selected fixture page ' + (++observationCount);
        const operation = typeof nextOperation === 'function' ? nextOperation() : nextOperation;
        out = { snapshot_ref: { id: randomUUID(), sha256: browserDraftHash(observation) }, observation,
          candidates: [{ candidate_ref: { id: randomUUID(), sha256: browserDraftHash(JSON.stringify(operation) + observation) }, operation,
            effect: ['upload', 'submit', 'type', 'paste'].includes(operation.kind) ? 'external_change' : 'read', label: 'Use the selected fixture target' }],
          source_refs: [], input_targets: [], page: { origin: 'https://example.com', url_sha256: browserDraftHash('https://example.com/') } };
      } else if (method === 'selected_browser_model') out = modelReply(params);
      else if (method === 'selected_browser_action') {
        executed.push(params.envelope);
        counters = { requests: params.envelope.ordinal * 2, response_bytes: params.envelope.ordinal * 100 };
        out = { kind: 'pending', state: 'started', ordinal: params.envelope.ordinal };
      } else if (method === 'selected_browser_poll_action') out = { kind: 'done', state: 'completed', result: { status: 'done' },
        usage: { ...counters, artifact_bytes: 0 }, usage_mode: 'cumulative' };
      else if (method === 'selected_browser_pending') out = { pending, cumulativeusage: { ...counters }, inflight_action: false, effects_sent: 0, effects_uncertain: 0 };
      else if (method === 'selected_browser_takeover') out = { state: 'human', manual_auth: true, controlling: true };
      else if (method === 'cancel_selected_browser_model') out = { cancelled: true, broker_confirmed: true, provider_already_accepted: false };
      else if (['selected_browser_pause', 'selected_browser_resume', 'selected_browser_release', 'selected_browser_renew',
        'selected_browser_stage', 'selected_browser_approve_request'].includes(method)) out = { state: 'accepted' };
      else throw new Error('Unexpected method ' + method);
      return await hostChange(method, out, params) ?? out;
    },
    async stream(method, params, options) {
      assert.equal(method, 'selected_browser_live');
      const stream = { method, params: structuredClone(params), options, sent: [], closeCount: 0,
        emit: message => options.onMessage(message), end: reason => options.onClose(reason) };
      stream.handle = { conn: randomUUID(), ice_servers: [], ttl_seconds: 60,
        send(message) { stream.sent.push(message); return true; }, close() { stream.closeCount++; options.onClose('viewer_closed'); } };
      streams.push(stream); await streamOpening(stream); return stream.handle;
    },
  };
  const runtime = createSelectedBrowserRuntime(configured ? { execution: { socket: '/tmp/owned-supervisor', publicKeyPath: '/tmp/public-key', vmUuid: vm } }
    : { execution: null, reason: 'not_configured' }, {
    db: f.adapter, store: f.store, readFile: () => publicKeyPem, client,
    artifactConfig: root ? { available: true, root, quota: 134217728 } : { available: false },
    clock: () => now, isEnabled: () => enabled, isMetadataEnabled: () => metadataEnabled, log: value => logs.push(value),
    scheduleInterval(callback, interval) { const handle = { callback, interval, cancelled: false, unref() {} }; scheduled.push(handle); return handle; },
    cancelInterval(handle) { if (handle) handle.cancelled = true; },
  });
  const consent = () => runtime.runs.consent(owner, p.id, config.id, { configuration_revision: config.revision,
    configuration_sha256: config.configuration_sha256, allow: true, reviewed_statement: SELECTED_BROWSER_CONSENT });
  const start = () => runtime.runs.start(owner, p.id, config.id, { configuration_revision: config.revision,
    configuration_sha256: config.configuration_sha256, project_revision: f.store.get(owner, p.id).revision, idempotency_key: randomUUID() });
  return { f, owner, p, calls, runtime, root, logs, executed, streams, scheduled, consent, start, session,
    get config() { return config; }, get launched() { return launched; },
    get(id, actor = owner) { return runtime.runs.get(actor, p.id, id); },
    async step(id) { return runtime.runs.step(owner, p.id, id, this.get(id).run.revision); },
    async approve(id, approval) { return runtime.runs.decision(owner, p.id, id, approval.id, this.get(id).run.revision,
      { decision: 'approve', action_sha256: approval.action_sha256 }); },
    setOperation(value) { nextOperation = value; }, setPending(value) { pending = value; },
    enable(value) { enabled = value; }, metadata(value) { metadataEnabled = value; },
    configure(change) { const value = structuredClone(config.configuration); change(value);
      config = f.store.createBrowserConfiguration(owner, p.id, f.store.get(owner, p.id).revision, { configuration: value }).configuration; return config; },
    advance(ms) { now += ms; f.advance(ms); },
    advanceTo(value) { const ms = value - now; now += ms; f.advance(ms); },
    async tick() { assert.equal(scheduled.length, 1); assert.equal(scheduled[0].cancelled, false); await scheduled[0].callback(); },
    async asset(bytes = Buffer.from('Private approved upload fixture')) {
      const a = await runtime.artifacts.service.asset(owner, p.id, { idempotency_key: randomUUID(), byte_count: bytes.length,
        mime_type: 'text/plain', sha256: browserDraftHash(bytes) }, [bytes]);
      runtime.artifacts.store.reviewAsset(owner, p.id, a.id, { decision: 'approve', reviewed_statement: BROWSER_ASSET_REVIEW_STATEMENT });
      return { ref: assetRef(a), expires_at: a.expires_at };
    },
    async close() { await runtime.close(); if (root) rmSync(root, { recursive: true, force: true }); f.close(); },
  };
}

async function until(predicate, details = () => '') {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await immediate(); }
  assert.fail('Runtime did not settle after queued microtasks: ' + details());
}

test('selected status verifier requires signature, exact VM/config facts and current expiry', () => {
  const now = Date.now(), check = createSelectedBrowserAttestationVerifier({ publicKeyPem, vmUuid: vm, clock: () => now });
  const raw = attest({ contract_version: 'selected-browser.v1', vm_uuid: vm, available: true, valid_until: new Date(now + 30000).toISOString() }, 'selected-browser-status');
  assert.ok(check(raw, 'selected-browser-status'));
  assert.equal(check({ ...raw, available: false }, 'selected-browser-status'), null);
  assert.equal(check({ ...raw, attestation: 'fake' }, 'selected-browser-status'), null);
  assert.equal(check(attest({ ...raw, vm_uuid: randomUUID() }, 'selected-browser-status'), 'selected-browser-status'), null);
  assert.equal(check(attest({ ...raw, valid_until: new Date(now - 1).toISOString() }, 'selected-browser-status'), 'selected-browser-status'), null);
});

test('unconfigured runtime keeps drafts blocked without host or private storage', async () => {
  const w = world({ configured: false });
  try {
    w.consent(); const ready = await w.runtime.runs.readiness(w.owner, w.p.id, w.config.id);
    assert.equal(ready.can_start, false); assert.ok(ready.checks.some(c => c.code === 'PRIVATE_SOURCE_MEMORY_UNAVAILABLE'));
    assert.equal(w.calls.length, 0); assert.equal(w.runtime.artifacts, null);
    await assert.rejects(w.start, e => e.code === 'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED');
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_runs').get().n, 0);
  } finally { await w.close(); }
});

test('forged host available booleans cannot enable start despite working private storage', async () => {
  const w = world({ hostChange: (method, out) => method === 'selected_browser_status' ? { ...out, attestation: 'forged' } : out });
  try {
    w.consent(); assert.equal((await w.runtime.runs.readiness(w.owner, w.p.id, w.config.id)).can_start, false);
    await assert.rejects(w.start, e => e.code === 'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED');
    assert.equal(w.calls.some(x => x.method === 'selected_browser_launch'), false);
  } finally { await w.close(); }
});

test('signed launch pins authoritative config, guide, consent and boot with real private storage', async () => {
  const w = world();
  try {
    assert.equal(statSync(w.root).mode & 0o777, 0o700); w.consent();
    assert.equal((await w.runtime.runs.readiness(w.owner, w.p.id, w.config.id)).can_start, true);
    const started = await w.start(), pin = w.f.db.prepare('SELECT * FROM ops_selected_browser_host_pins').get();
    assert.equal(started.run.state, 'running');
    assert.equal(pin.boot_id, boot); assert.equal(pin.vm_uuid, vm); assert.equal(pin.workspace_id, started.run.attempt_id);
    assert.equal(w.launched.configuration_sha256, w.config.configuration_sha256);
    assert.equal(w.launched.configuration_json, w.f.db.prepare('SELECT configuration_json FROM ops_browser_agent_configurations').get().configuration_json);
    assert.equal(w.launched.project_revision, w.f.store.get(w.owner, w.p.id).revision); assert.equal(w.launched.configuration_id, w.config.id);
    assert.equal(w.launched.guide_hash, w.config.configuration.work.guide_ref.sha256); assert.deepEqual(w.launched.project_limits, {});
    assert.equal(Object.hasOwn(w.launched, 'command'), false);
    assert.throws(() => w.f.db.exec("UPDATE ops_selected_browser_host_pins SET boot_id='different'"));
    const cancelled = await w.runtime.runs.cancel(w.owner, w.p.id, started.run.id, started.run.revision);
    assert.equal(cancelled.run.state, 'cancelled'); assert.equal(cancelled.run.fence, 2); assert.equal(cancelled.receipts.length, 1);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_stop').length, 1); assert.equal(w.calls.at(-1).params.reason, 'cancelled');
  } finally { await w.close(); }
});

test('signed cleanup for another boot remains uncertain and never proves teardown', async () => {
  const w = world({ hostChange: (method, out) => {
    if (method !== 'selected_browser_stop') return out;
    const payload = decode(out.attestation); payload.boot_id = randomUUID(); return { ...out, attestation: attestation(payload) };
  } });
  try {
    w.consent(); const started = await w.start(); const stopped = await w.runtime.runs.cancel(w.owner, w.p.id, started.run.id, started.run.revision);
    assert.equal(stopped.run.state, 'uncertain'); assert.equal(stopped.receipts.length, 0); assert.ok(stopped.uncertainties.some(u => u.kind === 'CLEANUP_UNVERIFIED'));
  } finally { await w.close(); }
});

test('revoked session defeats forged actor flags before launch', async () => {
  const w = world();
  try {
    w.consent(); w.f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), w.owner.jti);
    await assert.rejects(w.start, e => e.code === 'AGENT_CONTROL_VERIFICATION_REQUIRED');
    assert.equal(w.calls.some(x => x.method === 'selected_browser_launch'), false);
  } finally { await w.close(); }
});

test('maintenance timer advances a newly started run through signed decision and offered candidate', async () => {
  const w = world();
  try {
    await w.runtime.startMaintenance(); assert.equal(w.scheduled[0].interval, 5000);
    w.consent(); const started = await w.start(); assert.equal(w.executed.length, 0);
    await w.tick(); await until(() => w.get(started.run.id).run.state === 'paused', () => JSON.stringify({ state: w.get(started.run.id).run.state, logs: w.logs }));
    const result = w.get(started.run.id), models = w.calls.filter(c => c.method === 'selected_browser_model');
    assert.equal(result.run.usage.actions, 1); assert.equal(w.executed.length, 1); assert.equal(models.length, 2);
    const offered = models[0].params.input.candidates[0], packet = w.executed[0];
    assert.deepEqual(packet.candidate_ref, { id: offered.id, sha256: offered.sha256 });
    assert.deepEqual(packet.snapshot_ref, models[0].params.input.snapshot_ref); assert.equal(packet.operation.kind, offered.operation);
    assert.equal(result.run.usage.requests, 2); assert.equal(result.run.usage.response_bytes, 100);
    const sources = w.f.db.prepare('SELECT * FROM ops_selected_browser_sources WHERE run_id=?').all(started.run.id);
    assert.equal(sources.length, 2); assert.ok(models.every(call => call.params.input.source_inputs.some(s => sources.some(source => source.id === s.ref.id))));
    const reservations = w.f.db.prepare('SELECT * FROM ops_selected_browser_model_reservations WHERE run_id=?').all(started.run.id);
    assert.equal(reservations.length, 2);
    for (const row of reservations) {
      assert.equal(row.state, 'settled'); assert.equal(row.actual_tokens, 110); assert.equal(row.actual_usd, 0.0001);
      const receipt = JSON.parse(row.receipt_json), payload = decode(receipt.attestation);
      assert.equal(row.request_sha256, payload.request_hash); assert.equal(receipt.request_sha256, payload.request_hash);
      assert.equal(payload.call_id, row.id); assert.equal(payload.attempt_id, started.run.attempt_id); assert.equal(payload.fence, 1);
    }
    await w.tick(); await immediate();
    assert.equal(w.executed.length, 1); assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 2); assert.deepEqual(w.logs, []);
    const callCount = w.calls.length;
    await w.runtime.close(); assert.equal(w.scheduled[0].cancelled, true);
    await w.scheduled[0].callback(); await immediate();
    assert.equal(w.calls.length, callCount);
  } finally { await w.close(); }
});

test('cumulative counters include repeated refreshes and later actions exactly once', async () => {
  const w = world({ decisions: ['candidate', 'candidate', 'escalate'] });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id); assert.equal(w.get(started.run.id).run.usage.requests, 2);
    const polls = w.calls.filter(c => c.method === 'selected_browser_poll_action').length;
    for (let i = 0; i < 3; i++) await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id);
    assert.equal(w.get(started.run.id).run.usage.requests, 2); assert.equal(w.calls.filter(c => c.method === 'selected_browser_poll_action').length, polls);
    await w.step(started.run.id);
    for (let i = 0; i < 3; i++) await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id);
    const result = w.get(started.run.id), sources = w.f.db.prepare('SELECT sum(original_bytes) bytes FROM ops_selected_browser_sources WHERE run_id=?').get(started.run.id);
    assert.equal(result.run.usage.actions, 2); assert.equal(result.run.usage.requests, 4); assert.equal(result.run.usage.response_bytes, 200);
    assert.equal(result.run.usage.artifact_bytes, sources.bytes); assert.equal(w.executed.length, 2);
    assert.equal(w.f.db.prepare("SELECT count(*) n FROM ops_selected_browser_steps WHERE state='done'").get().n, 2);
  } finally { await w.close(); }
});

test('automatic completion stores only disclosed source citations before signed teardown', async () => {
  const w = world({ decisions: ['candidate', 'done'] });
  try {
    await w.runtime.startMaintenance(); w.consent(); const started = await w.start(); await w.tick();
    await until(() => ['completed', 'failed', 'uncertain'].includes(w.get(started.run.id).run.state));
    const result = w.get(started.run.id);
    assert.equal(result.run.state, 'completed'); assert.equal(result.receipts.length, 1); assert.equal(result.report_visibility, 'available');
    const report = w.calls.find(c => c.method === 'selected_browser_model' && c.params.purpose === 'report');
    assert.ok(report); assert.ok(report.params.input.source_inputs.length >= 2);
    assert.deepEqual(result.report.citations, report.params.input.source_inputs.map(s => s.ref.id));
    assert.deepEqual(result.report.evidence_refs, report.params.input.source_inputs.map(s => s.ref));
    const reportIndex = w.calls.indexOf(report), stopIndex = w.calls.findIndex(c => c.method === 'selected_browser_stop');
    assert.ok(stopIndex > reportIndex); assert.equal(w.calls[stopIndex].params.reason, 'completed');
    assert.equal(w.executed.length, 1); assert.equal(result.run.usage.model_calls, 3);
  } finally { await w.close(); }
});

test('nonzero downloaded bytes stay private and are charged once across cumulative refreshes', async () => {
  const bytes = Buffer.from('Private download fixture');
  const w = world({ decisions: ['candidate', 'candidate'], operation: { kind: 'download', resource_ref: 'fixture_resource' },
    hostChange: (method, out) => method === 'selected_browser_poll_action' ? { ...out,
      result: { status: 'done', artifact: { kind: 'download', mime_type: 'text/plain', sha256: browserDraftHash(bytes), byte_count: bytes.length, bytes_base64: bytes.toString('base64') } },
      usage: { ...out.usage, artifact_bytes: bytes.length } } : out });
  try {
    w.consent(); const started = await w.start();
    for (let i = 0; i < 2; i++) { await w.step(started.run.id); await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id); }
    const downloads = w.f.db.prepare("SELECT * FROM ops_browser_artifacts WHERE kind='download'").all();
    assert.equal(downloads.length, 2); assert.ok(downloads.every(a => a.sha256 === browserDraftHash(bytes)));
    const pageBytes = w.f.db.prepare('SELECT sum(original_bytes) bytes FROM ops_selected_browser_sources').get().bytes;
    assert.equal(w.get(started.run.id).run.usage.artifact_bytes, pageBytes + bytes.length * 2);
    assert.equal(w.get(started.run.id).run.usage.requests, 4);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_poll_action').length, 2);
    assert.ok(!JSON.stringify(w.f.db.prepare('SELECT metadata_json FROM ops_selected_browser_events').all()).includes(bytes.toString()));
  } finally { await w.close(); }
});

for (const [name, reply] of [
  ['absent result', { kind: 'done' }],
  ['absent usage', { kind: 'done', state: 'completed', result: { status: 'done' }, usage_mode: 'cumulative' }],
  ['absent counter semantics', { kind: 'done', state: 'completed', result: { status: 'done' }, usage: { requests: 0, response_bytes: 0, artifact_bytes: 0 } }],
]) test('an action with ' + name + ' cannot settle as a free completed action', async () => {
  const w = world({ hostChange: (method, out) => method === 'selected_browser_poll_action' ? reply : out });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id); const result = w.get(started.run.id);
    assert.equal(result.run.state, 'uncertain'); assert.equal(w.executed.length, 1);
    assert.equal(w.f.db.prepare("SELECT count(*) n FROM ops_selected_browser_steps WHERE state='done'").get().n, 0);
    assert.equal(w.f.db.prepare("SELECT count(*) n FROM ops_selected_browser_events WHERE kind='ACTION_SETTLED'").get().n, 0);
    assert.ok(result.uncertainties.some(u => u.kind === 'ACTION_OUTCOME_UNKNOWN'));
  } finally { await w.close(); }
});

test('forged model receipt prevents candidate execution through the composed runtime', async () => {
  const w = world({ hostChange: (method, out) => method === 'selected_browser_model' ? { ...out, usage: { prompt_tokens: 1, completion_tokens: 1 } } : out });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id);
    assert.equal(w.get(started.run.id).run.state, 'uncertain'); assert.equal(w.executed.length, 0);
    const row = w.f.db.prepare('SELECT * FROM ops_selected_browser_model_reservations').get();
    assert.equal(row.state, 'uncertain'); assert.equal(row.actual_tokens, null); assert.ok(w.get(started.run.id).run.usage.tokens >= row.reserved_tokens);
  } finally { await w.close(); }
});

test('live relay filters both directions and removes private initialization fields', async () => {
  const w = world(), messages = [];
  try {
    w.consent(); const started = await w.start();
    const live = await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage: message => messages.push(message) }); const stream = w.streams[0];
    assert.equal(w.runtime.live.sendLive(live.viewer, randomUUID(), { event: 'client/heartbeat' }), false);
    for (const message of [{ event: 'clipboard/paste', payload: { text: 'private input' } }, { event: 'chat/message', payload: { text: 'private chat' } },
      { event: 'signal/answer', payload: { sdp: 'fixture' }, authorization: 'forged' }, { event: 'signal/answer', payload: { sdp: 'x'.repeat(65536) } }])
      assert.equal(w.runtime.live.sendLive(live.viewer, w.owner.id, message), false);
    assert.equal(w.runtime.live.sendLive(live.viewer, w.owner.id, { event: 'signal/answer', payload: { sdp: 'fixture' } }), true);
    assert.deepEqual(stream.sent, [{ event: 'signal/answer', payload: { sdp: 'fixture' } }]);
    stream.emit({ event: 'chat/message', payload: { text: 'private outbound' } });
    stream.emit({ event: 'system/init', payload: { session_id: 'own-session', control_host: null, screen_size: { width: 1280, height: 800 },
      webrtc: {}, members: ['other person'], credentials: 'private init' } });
    stream.emit({ event: 'signal/provide', payload: { sdp: 'fixture', iceservers: [{ username: 'private turn' }] } });
    assert.equal(messages[0], null);
    assert.deepEqual(messages[1], { event: 'system/init', payload: { session_id: 'own-session', control_host: null, screen_size: { width: 1280, height: 800 }, webrtc: {} } });
    assert.deepEqual(messages[2], { event: 'signal/provide', payload: { sdp: 'fixture' } }); assert.ok(!JSON.stringify(messages).includes('private'));
    w.runtime.live.closeLive(live.viewer); assert.equal(w.runtime.live.sendLive(live.viewer, w.owner.id, { event: 'client/heartbeat' }), false);
  } finally { await w.close(); }
});

test('a revoked exact viewer session cannot send or receive another signalling message', async () => {
  const w = world(), messages = [], closed = [];
  try {
    w.consent(); const started = await w.start();
    const live = await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage: message => messages.push(message), onClose: reason => closed.push(reason) });
    w.f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), w.owner.jti);
    assert.equal(w.runtime.live.sendLive(live.viewer, w.owner.id, { event: 'client/heartbeat' }), false);
    w.streams[0].emit({ event: 'signal/offer', payload: { sdp: 'late private offer' } });
    assert.deepEqual(w.streams[0].sent, []); assert.deepEqual(messages, []); assert.equal(w.streams[0].closeCount, 1); assert.deepEqual(closed, ['viewer_closed']);
  } finally { await w.close(); }
});

test('closed before opening never registers a viewer or changes takeover state', async () => {
  const w = world({ streamOpening: stream => stream.end('closed_during_open') }), closed = [];
  try {
    w.consent(); const started = await w.start();
    await assert.rejects(() => w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage() {}, onClose: reason => closed.push(reason) }), e => e.code === 'LIVE_OPENING_ENDED');
    assert.ok(closed.includes('closed_during_open')); assert.equal(w.streams[0].closeCount, 1);
    await assert.rejects(() => w.runtime.runs.takeover(w.owner, w.p.id, started.run.id, started.run.revision), e => e.code === 'VERIFIED_LIVE_VIEWER_REQUIRED');
    assert.equal(w.get(started.run.id).run.state, 'running'); assert.equal(w.get(started.run.id).run.revision, started.run.revision);
    assert.equal(w.calls.some(c => c.method === 'selected_browser_takeover' || c.method === 'selected_browser_stop'), false);
  } finally { await w.close(); }
});

test('missing viewer is reversible and reconnect takeover uses the current exact session', async () => {
  const w = world();
  try {
    w.consent(); const started = await w.start();
    await assert.rejects(() => w.runtime.runs.takeover(w.owner, w.p.id, started.run.id, started.run.revision), e => e.code === 'VERIFIED_LIVE_VIEWER_REQUIRED');
    assert.deepEqual({ state: w.get(started.run.id).run.state, revision: w.get(started.run.id).run.revision, manual_auth: w.get(started.run.id).run.manual_auth },
      { state: 'running', revision: started.run.revision, manual_auth: false });
    await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage() {} }); w.streams[0].end('viewer_lost');
    const otherSession = w.session({ ...w.owner }, true);
    await w.runtime.live.openLive(otherSession, w.p.id, started.run.id, { onMessage() {} });
    await assert.rejects(() => w.runtime.runs.takeover(w.owner, w.p.id, started.run.id, started.run.revision), e => e.code === 'VERIFIED_LIVE_VIEWER_REQUIRED');
    const current = await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage() {} });
    const taken = await w.runtime.runs.takeover(w.owner, w.p.id, started.run.id, started.run.revision);
    assert.equal(taken.run.state, 'human_control'); assert.equal(taken.run.manual_auth, true);
    const call = w.calls.find(c => c.method === 'selected_browser_takeover');
    assert.equal(call.params.conn, w.streams[2].handle.conn); assert.notEqual(call.params.conn, w.streams[0].handle.conn); assert.notEqual(call.params.conn, w.streams[1].handle.conn);
    assert.equal(w.runtime.live.sendLive(current.viewer, w.owner.id, { event: 'client/heartbeat' }), true); assert.equal(w.calls.some(c => c.method === 'selected_browser_stop'), false);
  } finally { await w.close(); }
});

async function preparedUpload(w) {
  const asset = await w.asset();
  // Actual immutable retention expires during the approval wait. Dashboard
  // authentication is refreshed before starting; the run deadline stays live.
  w.advanceTo(Date.parse(asset.expires_at) - 60000); w.session();
  w.configure(c => { c.artifacts.upload_asset_refs = [asset.ref]; });
  w.setOperation({ kind: 'upload', element_ref: 'fixture_upload', asset_ref: asset.ref }); w.consent();
  return { asset, started: await w.start() };
}

test('real approved upload expiring during DOM approval cannot send an action', async () => {
  const w = world();
  try {
    const { started } = await preparedUpload(w); await w.step(started.run.id);
    const approval = w.get(started.run.id).pending_approvals.find(a => a.kind === 'consequential_action');
    assert.ok(approval); assert.equal(w.executed.length, 0); assert.equal(w.calls.filter(c => c.method === 'selected_browser_stage').length, 1);
    w.advance(61000); await w.approve(started.run.id, approval);
    assert.equal(w.executed.length, 0); assert.equal(w.calls.some(c => c.method === 'selected_browser_approve_request'), false); assert.equal(w.get(started.run.id).run.state, 'uncertain');
  } finally { await w.close(); }
});

test('staged upload expiring during wire approval cannot authorize its held request', async () => {
  let held;
  const w = world({ hostChange: (method, out) => method === 'selected_browser_poll_action' && held ? { kind: 'request_approval', request: held } : out });
  try {
    const { asset, started } = await preparedUpload(w); await w.step(started.run.id);
    const dom = w.get(started.run.id).pending_approvals.find(a => a.kind === 'consequential_action');
    const payload = JSON.parse(w.f.db.prepare('SELECT payload_json FROM ops_selected_browser_approvals WHERE id=?').get(dom.id).payload_json);
    held = { kind: 'network_effect', request_ref: 'held_upload', binding_sha256: 'e'.repeat(64), origin: 'https://example.com', role: 'resource',
      method: 'POST', body_sha256: asset.ref.sha256, body_bytes: asset.ref.byte_count, purpose: 'Upload the exact approved private fixture',
      request_sha256: 'f'.repeat(64), no_contact: true,
      current_action: { ordinal: payload.packet.ordinal, snapshot_ref: payload.snapshot_ref, candidate_ref: payload.candidate.candidate_ref } };
    await w.approve(started.run.id, dom); assert.equal(w.executed.length, 1);
    const wire = w.get(started.run.id).pending_approvals.find(a => a.kind === 'network_effect'); assert.ok(wire);
    w.advance(61000); await w.approve(started.run.id, wire);
    assert.equal(w.calls.some(c => c.method === 'selected_browser_approve_request'), false); assert.equal(w.executed.length, 1); assert.equal(w.get(started.run.id).run.state, 'uncertain');
  } finally { await w.close(); }
});

test('manual-auth wire approval checks retained upload without activating a private input', async () => {
  const w = world();
  try {
    const { asset, started } = await preparedUpload(w); await w.step(started.run.id);
    await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage() {} });
    const taken = await w.runtime.runs.takeover(w.owner, w.p.id, started.run.id, w.get(started.run.id).run.revision);
    assert.equal(taken.run.state, 'human_control');
    const modelCount = w.calls.filter(c => c.method === 'selected_browser_model').length;
    const stageCount = w.calls.filter(c => c.method === 'selected_browser_stage').length;
    w.setPending([{ kind: 'network_effect', request_ref: 'held_manual_upload', binding_sha256: 'e'.repeat(64), origin: 'https://example.com', role: 'resource',
      method: 'POST', body_sha256: asset.ref.sha256, body_bytes: asset.ref.byte_count, purpose: 'Review private fixture upload during human control',
      request_sha256: 'f'.repeat(64), no_contact: true }]);
    await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id);
    const approval = w.get(started.run.id).pending_approvals.find(a => a.kind === 'network_effect'); assert.ok(approval);
    const after = await w.approve(started.run.id, approval);
    assert.equal(after.run.state, 'human_control'); assert.equal(after.run.manual_auth, true);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_approve_request').length, 1);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_stage').length, stageCount);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, modelCount);
    assert.equal(w.executed.length, 0);
  } finally { await w.close(); }
});

test('artifact configuration needs dedicated path, finite quota and independent parser review', () => {
  assert.deepEqual(browserArtifactsConfiguration({}), { available: false });
  const env = { OPERATIONS_BROWSER_ARTIFACT_BOUNDARY_REVIEWED: 'true', OPERATIONS_BROWSER_ARTIFACT_DIR: '/var/lib/proxypilot/browser-private', OPERATIONS_BROWSER_ARTIFACT_QUOTA_BYTES: '268435456' };
  const c = browserArtifactsConfiguration(env); assert.equal(c.available, true); assert.equal(c.pdfRunner, null); assert.equal(c.imageRunner, null);
  const checkout = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  for (const root of [checkout, path.join(checkout, 'admin/private'), path.dirname(checkout)]) {
    assert.equal(browserArtifactsConfiguration({ ...env, OPERATIONS_BROWSER_ARTIFACT_DIR: root }).available, false);
  }
  assert.equal(browserArtifactsConfiguration({ ...env, OPERATIONS_BROWSER_ARTIFACT_QUOTA_BYTES: 'Infinity' }).available, false);
});

for (const storageState of ['missing', 'unsafe']) test('review flag cannot start a browser with ' + storageState + ' private storage', async () => {
  const w = world({ storageState });
  try {
    w.consent(); assert.equal(w.runtime.artifacts, null);
    const ready = await w.runtime.runs.readiness(w.owner, w.p.id, w.config.id);
    assert.equal(ready.can_start, false); assert.ok(ready.checks.some(c => c.code === 'PRIVATE_SOURCE_MEMORY_UNAVAILABLE'));
    await assert.rejects(w.start);
    assert.equal(w.calls.some(c => c.method === 'selected_browser_launch'), false);
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_runs').get().n, 0);
    assert.ok(w.logs.some(e => e.code === 'BROWSER_PRIVATE_STORAGE_UNAVAILABLE'));
  } finally { await w.close(); }
});

test('private directory becoming non-private after construction revokes readiness before host launch', async () => {
  const w = world();
  try {
    w.consent(); assert.equal((await w.runtime.runs.readiness(w.owner, w.p.id, w.config.id)).can_start, true);
    chmodSync(w.root, 0o755);
    assert.equal((await w.runtime.runs.readiness(w.owner, w.p.id, w.config.id)).can_start, false);
    await assert.rejects(w.start, e => e.code === 'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED');
    assert.equal(w.calls.some(c => c.method === 'selected_browser_launch'), false);
  } finally { await w.close(); }
});

test('run toggle revocation during model await settles known spend and suppresses candidate execution', async () => {
  let w;
  w = world({ hostChange: (method, out) => { if (method === 'selected_browser_model') w.enable(false); return out; } });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id);
    const result = w.get(started.run.id), reservation = w.f.db.prepare('SELECT * FROM ops_selected_browser_model_reservations').get();
    assert.equal(result.run.state, 'failed'); assert.equal(result.run.result_code, 'MODEL_SOURCE_UNAVAILABLE'); assert.equal(w.executed.length, 0);
    assert.equal(reservation.state, 'settled'); assert.equal(reservation.actual_tokens, 110); assert.equal(reservation.actual_usd, 0.0001);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 1);
  } finally { await w.close(); }
});

test('run toggle revocation immediately stops live relay, source reads and binary private output', async () => {
  const w = world(), messages = [];
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id);
    const live = await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage: message => messages.push(message) });
    const source = w.f.db.prepare('SELECT * FROM ops_selected_browser_sources').get();
    const scope = { project_id: w.p.id, run_id: started.run.id, attempt_id: started.run.attempt_id, fence: 1 };
    w.enable(false);
    await assert.rejects(() => w.runtime.runs.sources(w.owner, w.p.id, started.run.id), e => e.code === 'BROWSER_RUN_DISABLED');
    let writes = 0;
    await assert.rejects(() => w.runtime.artifacts.service.serve(w.owner, { project_id: w.p.id, scope, id: source.id, purpose: 'review' },
      { method: 'GET', headers: {} }, { write() { writes++; }, set() {}, end() {} }), e => e.code === 'BROWSER_RUN_DISABLED');
    assert.equal(writes, 0);
    assert.equal(w.runtime.live.sendLive(live.viewer, w.owner.id, { event: 'client/heartbeat' }), false);
    w.streams[0].emit({ event: 'signal/offer', payload: { sdp: 'late signalling' } });
    assert.deepEqual(w.streams[0].sent, []); assert.deepEqual(messages, []);
  } finally { await w.close(); }
});

test('metadata toggle revocation prevents project asset binary reads and new private allocations', async () => {
  const w = world();
  try {
    const asset = await w.asset(), count = w.f.db.prepare('SELECT count(*) n FROM ops_browser_artifacts').get().n;
    w.metadata(false); let writes = 0;
    await assert.rejects(() => w.runtime.artifacts.service.serve(w.owner, { project_id: w.p.id, id: asset.ref.id, purpose: 'review' },
      { method: 'GET', headers: {} }, { write() { writes++; }, set() {}, end() {} }), e => e.code === 'BROWSER_METADATA_DISABLED');
    await assert.rejects(() => w.asset(), e => e.code === 'BROWSER_METADATA_DISABLED');
    assert.equal(writes, 0); assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_browser_artifacts').get().n, count);
  } finally { await w.close(); }
});
