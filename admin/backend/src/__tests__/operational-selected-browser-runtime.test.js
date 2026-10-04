import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as immediate } from 'node:timers/promises';
import { operationsFixture } from './helpers/operations-fixture.js';
import { operationalSelectedBrowserMigration1118, operationalPublicNavigationMigration1123 } from '../lib/operational-selected-browser-schema.js';
import { operationalBrowserArtifactsMigration1119 } from '../lib/operational-browser-artifacts-schema.js';
import { operationalBrowserConversionMigration1120 } from '../lib/operational-browser-conversion.js';
import { operationalBrowserRunCommentsMigration1125 } from '../lib/operational-browser-run-comments.js';
import { browserArtifactsConfiguration, createSelectedBrowserAttestationVerifier, createSelectedBrowserRuntime,
  operationalSelectedBrowserRuntimeMigration1121 } from '../lib/operational-selected-browser-runtime.js';
import { browserDraftHash, canonicalBrowserDraft } from '../lib/operational-browser-agent-proposal.js';
import { browserModelRequestDigest } from '../lib/operational-browser-model.js';
import { BROWSER_ASSET_REVIEW_STATEMENT, createBrowserArtifactsStore } from '../lib/operational-browser-artifacts-store.js';
import { createBrowserArtifactsService } from '../lib/operational-browser-artifacts-service.js';
import { createBrowserArtifactFiles } from '../lib/operational-browser-artifacts-files.js';
import { recordControlGrant } from '../lib/operational-control-grants.js';
import { SELECTED_BROWSER_CONSENT } from '../lib/operational-selected-browser-contract.js';
import { operationalSelectedBrowserAuthMigration1122 } from '../lib/operational-selected-browser-auth-schema.js';
import { SELECTED_BROWSER_AUTH_STATEMENT, selectedAuthDigest, selectedAuthInventoryDigest,
  SELECTED_BROWSER_AUTH_INVENTORY_BODY_MAX } from '../lib/operational-selected-browser-auth-contract.js';

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
const hostPins = workspaceId => ({ contract_version: 'selected-browser.v1', vm_uuid: vm, boot_id: boot,
  workspace_id: workspaceId, network_plan_sha256: 'b'.repeat(64), original_fence: 1 });

// This is the owned supervisor's frozen _blocked_result wire contract: outer
// display facts and cumulative meters, with launch/envelope/no-effect pins in
// the signed-only payload. It deliberately has no guest result object.
function blockedReply(w, params) {
  const envelope = w.executed.find(e => e.ordinal === params.ordinal);
  const proof = { kind: 'selected-browser-blocked-action', ...hostPins(w.launched.workspace_id),
    ...Object.fromEntries(['run_id', 'attempt_id', 'fence', 'policy_sha256', 'ordinal'].map(k => [k, params[k]])),
    envelope_sha256: browserDraftHash(canonicalBrowserDraft(envelope)), request_refs: ['blocked_fixture_request'],
    no_effect_sent: true, replay_allowed: false, ledger_sha256: 'd'.repeat(64), usage: { requests: params.ordinal * 2, response_bytes: params.ordinal * 100 } };
  return { kind: 'done', state: 'blocked', ordinal: params.ordinal, code: 'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT',
    usage: { ...proof.usage, artifact_bytes: 0 }, usage_mode: 'cumulative',
    facts: [{ code: 'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT', source_ref: null }], attestation: attestation(proof) };
}

// The runtime, lifecycle and private filesystem are real. Only the owned
// supervisor transport and timer are injected; no website/provider is called.
function world({ hostChange = () => {}, configured = true, privateStorage = configured, storageState = 'safe',
  decisions = ['candidate', 'escalate'], operation = { kind: 'read', scope: 'visible_page', selection_ref: null },
  streamOpening = () => {}, authPathPreview = '/signin' } = {}) {
  const f = operationsFixture();
  for (const migrate of [operationalSelectedBrowserMigration1118, operationalBrowserArtifactsMigration1119,
    operationalBrowserConversionMigration1120, operationalSelectedBrowserRuntimeMigration1121, operationalSelectedBrowserAuthMigration1122, operationalPublicNavigationMigration1123,
    operationalBrowserRunCommentsMigration1125]) migrate(f.adapter);
  f.db.exec('ALTER TABLE sessions ADD COLUMN sudo_until TEXT');
  const owner = f.addUser(), p = f.store.create(owner, { name: 'Selected runtime test' });
  const guide = f.store.saveDraft(owner, p.id, 1, { title: 'Current guide', instructions: 'Read selected pages and report sources.' }).version;
  const c = JSON.parse(readFileSync(new URL('../../../../contracts/browser-agent/fixtures/general-agent.draft.json', import.meta.url), 'utf8'));
  c.work.guide_ref = { id: guide.id, sha256: guide.content_hash };
  let config = f.store.createBrowserConfiguration(owner, p.id, f.store.get(owner, p.id).revision, { configuration: c }).configuration;
  let now = Date.now(), launched = null, observationCount = 0, decisionCount = 0, enabled = true, metadataEnabled = true;
  let nextOperation = operation, pending = [], inflight = 0, authAcknowledged = 0, effectsSent = 0, counters = { requests: 0, response_bytes: 0 };
  const authenticationRequests = [], acknowledgedRequests = new Set();
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
      else if(method==='selected_browser_view')out={png_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGqkAAAAASUVORK5CYII=',width:1,height:1};
      else if (method === 'selected_browser_model_status') out = attestModel({ contract_version: 'selected-browser-model.v1', available: true,
        price_table_revision: 1, prices: { input: '0.2', output: '1', cache_write: '0.2', cached_input: '0.02' }, valid_until: new Date(now + 30000).toISOString() }, 'selected-browser-model-status');
      else if (method === 'selected_browser_launch') {
        launched = params;
        out = attest({ contract_version: 'selected-browser.v1', run_id: params.run_id, attempt_id: params.attempt_id, fence: params.fence,
          policy_sha256: params.configuration_sha256, vm_uuid: vm, boot_id: boot, workspace_id: params.workspace_id,
          network_plan_sha256: 'b'.repeat(64), original_fence: params.fence }, 'selected-browser-launch');
      } else if (method === 'selected_browser_stop') {
        pending = []; inflight = 0;
        const signed = attest({ contract_version: 'selected-browser.v1', ...params, closed: { browser: true, network: true, session: true, temporary_files: true },
          final_network: { ...counters, effects_sent: effectsSent, effects_uncertain: 0, auth_effects_acknowledged: authAcknowledged,
            inflight, pending_count: pending.length, ledger_sha256: browserDraftHash('closed-ledger:' + counters.requests + ':' + effectsSent + ':' + authAcknowledged) },
          gateway_ledger_sha256: browserDraftHash('closed-ledger:' + counters.requests + ':' + effectsSent + ':' + authAcknowledged),
          vm_uuid: vm, boot_id: boot, workspace_id: params.attempt_id, network_plan_sha256: 'b'.repeat(64), original_fence: 1 }, 'selected-browser-teardown');
        out = Object.fromEntries(['contract_version', 'run_id', 'attempt_id', 'fence', 'policy_sha256', 'closed', 'final_network', 'attestation'].map(k => [k, signed[k]]));
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
      else if (method === 'selected_browser_pending') out = { pending, cumulativeusage: { ...counters }, usage: { ...counters }, inflight, effects_sent: effectsSent, effects_uncertain: 0, auth_effects_acknowledged: authAcknowledged };
      else if (method === 'selected_browser_deny_request') {
        const r = f.db.prepare('SELECT manual_auth,controller_user_id FROM ops_selected_browser_runs WHERE id=?').get(params.run_id);
        const manual = !!r.manual_auth && !!r.controller_user_id;
        out = { ...params, denied: true, no_contact: true, paused: !manual, state: manual ? 'human_control' : 'paused', manual_auth: manual };
        out.attestation = attestation({ kind: 'selected-browser-request-denial', ...out, ...hostPins(launched.workspace_id),
          ledger_sha256: 'd'.repeat(64), replay_allowed: false });
        pending = [];
      }
      else if (method === 'selected_browser_approve_request') {
        const held = pending.find(request => request.request_ref === params.request_ref);
        assert.ok(held); effectsSent++; counters = { requests: counters.requests + 1, response_bytes: counters.response_bytes + 100 };
        if (held.role === 'authentication') authenticationRequests.push({
          request_ref: held.request_ref, binding_sha256: held.binding_sha256, request_sha256: held.request_sha256,
          url_sha256: held.url_sha256, body_sha256: held.body_sha256, body_bytes: held.body_bytes, origin: held.origin,
          role: held.role, method: held.method, approval_ref: params.grant.approval_ref, purpose_sha256: params.grant.purpose_sha256,
          path_preview: authPathPreview, human_context: params.grant.human_context,
          ledger_send_ref: browserDraftHash('send:' + held.request_ref), ledger_response_ref: browserDraftHash('response:' + held.request_ref), transport_complete: true });
        pending = pending.filter(request => request.request_ref !== held.request_ref); out = { approved: true, request_ref: params.request_ref };
      }
      else if (method === 'selected_browser_auth_inventory') {
        out = { schema: 'selected-browser-auth-inventory.v1', ...Object.fromEntries(['run_id', 'attempt_id', 'fence', 'policy_sha256', 'controller_id', 'session_id'].map(k => [k, params[k]])),
          viewer_conn_sha256: browserDraftHash(params.conn), ledger_sha256: browserDraftHash('auth-ledger:' + effectsSent + ':' + authAcknowledged),
          effects_sent: effectsSent, effects_uncertain: 0, inflight, pending_count: pending.length, auth_effects_acknowledged: authAcknowledged,
          requests: authenticationRequests.filter(request => !acknowledgedRequests.has(request.request_ref)) };
        out.inventory_sha256 = selectedAuthInventoryDigest(out);
        out.attestation = attestation({ kind: 'selected-browser-auth-inventory', ...out, ...hostPins(launched.workspace_id), replay_allowed: false });
      }
      else if (method === 'selected_browser_confirm_authentication') {
        const packet = params.packet;
        for (const request of packet.request_refs) { assert.equal(acknowledgedRequests.has(request.request_ref), false); acknowledgedRequests.add(request.request_ref); }
        authAcknowledged += packet.request_refs.length;
        out = { schema: 'selected-browser-auth-confirmation-ack.v1', ...Object.fromEntries(['run_id', 'attempt_id', 'fence', 'policy_sha256', 'controller_id', 'session_id', 'viewer_conn_sha256', 'inventory_sha256'].map(k => [k, packet[k]])),
          confirmation_ref: packet.confirmation_ref, request_sha256: selectedAuthDigest(packet), ledger_sha256: browserDraftHash('auth-ledger:' + effectsSent + ':' + authAcknowledged),
          auth_effects_acknowledged: authAcknowledged, effects_sent: effectsSent, confirmed: true, replay_allowed: false };
        out.attestation = attestation({ kind: 'selected-browser-auth-confirmation', ...out, ...hostPins(launched.workspace_id) });
      }
      else if (method === 'selected_browser_takeover') out = { state: 'human', manual_auth: true, controlling: true };
      else if (method === 'cancel_selected_browser_model') out = { cancelled: true, broker_confirmed: true, provider_already_accepted: false };
      else if (['selected_browser_pause', 'selected_browser_resume', 'selected_browser_release', 'selected_browser_renew',
        'selected_browser_stage'].includes(method)) out = { state: 'accepted' };
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
  return { f, owner, p, calls, runtime, root, logs, executed, streams, scheduled, consent, start, session, authPathPreview,
    get config() { return config; }, get launched() { return launched; }, get now() { return now; },
    get(id, actor = owner) { return runtime.runs.get(actor, p.id, id); },
    async step(id) { return runtime.runs.step(owner, p.id, id, this.get(id).run.revision); },
    async approve(id, approval) { return runtime.runs.decision(owner, p.id, id, approval.id, this.get(id).run.revision,
      { decision: 'approve', action_sha256: approval.action_sha256 }); },
    setOperation(value) { nextOperation = value; }, setPending(value) { pending = value; }, setInflight(value) { inflight = value; },
    setEffectsSent(value) { effectsSent = value; }, setAuthAcknowledged(value) { authAcknowledged = value; },
    setNetworkCounters(value) { counters = { ...value }; },
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

// Use F1's real intake and private file adapter with a deterministic UUID source
// to place retained records before expired records. The runtime sees the same
// database/files; its maintenance API and deletion outcomes are never mocked.
function maintenanceAssets(w) {
  const db = w.f.adapter, at = w.now;
  let createdAt = at, nextArtifactId = null;
  const files = createBrowserArtifactFiles(w.root);
  const store = createBrowserArtifactsStore({
    one: (sql, ...args) => db.prepare(sql).get(...args), all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args), tx: fn => db.transaction(fn).immediate(),
    access: (actor, project) => ({ p: w.f.store.get(actor, project), role: 'owner' }),
    now: () => new Date(createdAt).toISOString(),
    uuid: () => { const id = nextArtifactId; nextArtifactId = null; return id || randomUUID(); },
    authorizeAttempt: () => assert.fail('Cleanup fixtures cannot create browser attempts'), event() {},
  }, { installationBytes: 134217728, accountBytes: 134217728, projectBytes: 134217728 });
  const service = createBrowserArtifactsService({ store, files });
  return {
    async add(n, { expired = false, expiresSoon = false, cancelled = false } = {}) {
      createdAt = expired ? at - 15 * 86400000 : expiresSoon ? at - 14 * 86400000 + 30000 : at;
      nextArtifactId = n.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000';
      const bytes = Buffer.from('Private cleanup fixture ' + n);
      const asset = await service.asset(w.owner, w.p.id, { idempotency_key: randomUUID(), byte_count: bytes.length,
        mime_type: 'text/plain', sha256: browserDraftHash(bytes) }, [bytes]);
      if (cancelled) store.cancel(w.owner, w.p.id, asset.id);
      return { ...asset, filename: path.join(w.root, asset.id + '.blob') };
    },
    close() { files.close(); },
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

test('human run comments persist without execution, provider or file authority and never change run pins',async()=>{
  const w=world();try{
    w.consent();const started=await w.start(),before=w.get(started.run.id).run;
    w.enable(false);const callCount=w.calls.length;
    const note=w.runtime.comments.append(w.owner,w.p.id,started.run.id,{text:'Human review of this run',idempotency_key:randomUUID()});
    assert.equal(note.replayed,false);assert.equal(w.runtime.comments.list(w.owner,w.p.id,started.run.id).comments[0].id,note.comment.id);
    assert.equal(w.calls.length,callCount);assert.equal(w.get(started.run.id).run.revision,before.revision);
    assert.equal(w.get(started.run.id).run.fence,before.fence);
    const event=w.f.db.prepare("SELECT metadata_json FROM ops_project_events WHERE subject_id=? AND action='browser_run_comment_added'").get(note.comment.id);
    assert.ok(event);assert.ok(!event.metadata_json.includes(note.comment.text));
    w.metadata(false);assert.throws(()=>w.runtime.comments.list(w.owner,w.p.id,started.run.id),e=>e.code==='BROWSER_METADATA_DISABLED');
  }finally{await w.close();}
});

test('forged host available booleans cannot enable start despite working private storage', async () => {
  const w = world({ hostChange: (method, out) => method === 'selected_browser_status' ? { ...out, attestation: 'forged' } : out });
  try {
    w.consent(); assert.equal((await w.runtime.runs.readiness(w.owner, w.p.id, w.config.id)).can_start, false);
    await assert.rejects(w.start, e => e.code === 'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED');
    assert.equal(w.calls.some(x => x.method === 'selected_browser_launch'), false);
  } finally { await w.close(); }
});

test('ordinary source delivery with a preserved legacy runtime cannot admit selected execution', async () => {
  const w = world({ hostChange: (method, out) => {
    if (method === 'selected_browser_status') throw Object.assign(new Error('METHOD_NOT_ALLOWED'), { code: 'METHOD_NOT_ALLOWED' });
    return out;
  } });
  try {
    w.consent();
    const ready = await w.runtime.runs.readiness(w.owner, w.p.id, w.config.id);
    assert.equal(ready.can_start, false);
    await assert.rejects(w.start, e => e.code === 'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED');
    assert.equal(w.calls.some(x => x.method === 'selected_browser_launch'), false);
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_runs').get().n, 0);
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

function changeFinalNetwork(raw, change, { signed = true } = {}) {
  const final = change({ ...raw.final_network }), payload = decode(raw.attestation);
  if (signed) { payload.final_network = final; payload.gateway_ledger_sha256 = final.ledger_sha256; }
  return { ...raw, final_network: final, attestation: signed ? attestation(payload) : raw.attestation };
}

function changeClosed(raw, change, { signed = true } = {}) {
  const closed = change({ ...raw.closed }), payload = decode(raw.attestation);
  if (signed) payload.closed = closed;
  return { ...raw, closed, attestation: signed ? attestation(payload) : raw.attestation };
}

test('signed partial shutdown retains final traffic and requires fresh full closure on cleanup retry', async () => {
  let fullClosure = false, partialStops = 0;
  const w = world({ decisions: ['done'], hostChange: (method, out) => {
    if (method !== 'selected_browser_stop') return out;
    if (fullClosure) return out;
    const requests = 2 + partialStops++;
    return changeClosed(changeFinalNetwork(out, n => ({ ...n, requests, response_bytes: requests * 100, inflight: 1 })), n => ({ ...n, network: false }));
  } });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id); let result = w.get(started.run.id);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' && c.params.purpose === 'report').length, 1);
    assert.equal(result.run.state, 'uncertain'); assert.equal(result.receipts.length, 1);
    assert.equal(result.receipts[0].closed.network, false); assert.equal(result.receipts[0].final_network.inflight, 1);
    assert.equal(result.run.usage.requests, 2); assert.equal(result.run.usage.response_bytes, 200);
    assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_attempts WHERE id=?').get(result.run.attempt_id).state, 'cleanup_unverified');
    assert.ok(result.uncertainties.some(u => u.kind === 'CLEANUP_UNVERIFIED' && u.state === 'unresolved'));
    assert.notEqual(result.report_visibility, 'available'); assert.equal(result.report, null);
    await assert.rejects(() => w.runtime.runs.retryCleanup(w.owner, w.p.id, started.run.id, result.run.revision), e => e.code === 'SIGNED_CLEANUP_RECEIPT_REQUIRED');
    result = w.get(started.run.id);
    assert.equal(result.run.usage.requests, 3); assert.equal(result.run.usage.response_bytes, 300);
    assert.ok(result.run.revision > started.run.revision);
    assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_attempts WHERE id=?').get(result.run.attempt_id).state, 'cleanup_unverified');
    fullClosure = true;
    result = await w.runtime.runs.retryCleanup(w.owner, w.p.id, started.run.id, result.run.revision);
    assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_attempts WHERE id=?').get(result.run.attempt_id).state, 'closed');
    assert.equal(result.receipts.length, 1); assert.equal(result.receipts[0].closed.network, true);
    assert.equal(result.receipts[0].final_network.inflight, 0);
    assert.equal(result.run.usage.requests, 3); assert.equal(result.run.usage.response_bytes, 300);
    assert.ok(result.uncertainties.some(u => u.kind === 'CLEANUP_UNVERIFIED' && u.state === 'reconciled'));
    assert.equal(result.run.state, 'uncertain'); assert.notEqual(result.report_visibility, 'available'); assert.equal(result.report, null);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_stop').length, 3);
    assert.equal(w.executed.length, 0);
  } finally { await w.close(); }
});

test('a write first revealed by the signed final cleanup ledger withholds a generated completed report', async () => {
  const w = world({ decisions: ['done'], hostChange: (method, out) => method === 'selected_browser_stop'
    ? changeFinalNetwork(out, n => ({ ...n, requests: 1, response_bytes: 100, effects_sent: 1, ledger_sha256: browserDraftHash('late sent fixture effect') })) : out });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id); const result = w.get(started.run.id);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' && c.params.purpose === 'report').length, 1);
    assert.equal(result.run.state, 'uncertain'); assert.notEqual(result.report_visibility, 'available'); assert.equal(result.report, null);
    assert.equal(result.run.usage.requests, 1); assert.equal(result.run.usage.response_bytes, 100);
    assert.equal(result.receipts.length, 1); assert.equal(result.receipts[0].final_network.effects_sent, 1);
    assert.ok(result.uncertainties.some(u => u.kind === 'EXTERNAL_EFFECT_UNVERIFIED'));
    assert.equal(w.executed.length, 0);
  } finally { await w.close(); }
});

for (const [name, change] of [
  ['absent final facts', raw => { const { final_network, ...out } = raw; return out; }],
  ['unsigned final meters', raw => changeFinalNetwork(raw, n => ({ ...n, requests: n.requests + 1 }), { signed: false })],
  ['unsafe integer counters', raw => changeFinalNetwork(raw, n => ({ ...n, requests: Number.MAX_SAFE_INTEGER + 1 }))],
  ['unknown authority field', raw => changeFinalNetwork(raw, n => ({ ...n, permit_all_destinations: true }))],
  ['invalid ledger hash', raw => changeFinalNetwork(raw, n => ({ ...n, ledger_sha256: 'invalid' }))],
  ['missing signed gateway ledger', raw => { const payload = decode(raw.attestation); delete payload.gateway_ledger_sha256; return { ...raw, attestation: attestation(payload) }; }],
  ['mismatched signed gateway ledger', raw => { const payload = decode(raw.attestation); payload.gateway_ledger_sha256 = 'f'.repeat(64); return { ...raw, attestation: attestation(payload) }; }],
  ['numeric closed flag', raw => changeClosed(raw, n => ({ ...n, network: 1 }))],
  ['string closed flag', raw => changeClosed(raw, n => ({ ...n, network: 'true' }))],
  ['missing closed flag', raw => changeClosed(raw, n => { const { network, ...closed } = n; return closed; })],
  ['unknown closed flag', raw => changeClosed(raw, n => ({ ...n, all_sites_permitted: true }))],
  ['unsigned partial closed flag', raw => changeClosed(raw, n => ({ ...n, network: false }), { signed: false })],
]) test('cleanup with ' + name + ' cannot prove a completed run or publish its report', async () => {
  const w = world({ decisions: ['done'], hostChange: (method, out) => method === 'selected_browser_stop' ? change(out) : out });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id); const result = w.get(started.run.id);
    assert.equal(result.run.state, 'uncertain'); assert.equal(result.receipts.length, 0);
    assert.notEqual(result.report_visibility, 'available'); assert.equal(result.report, null);
    assert.ok(result.uncertainties.some(u => u.kind === 'CLEANUP_UNVERIFIED'));
  } finally { await w.close(); }
});

for (const preview of ['/signin/private-session-token', '/account/person@example.com',
  '/oauth/callback?code=private-auth-code', '/signin/%5Bredacted%5D', '/signin/../token',
  '/signin/private\nheader']) test('signed authentication inventory refuses unredacted endpoint ' + JSON.stringify(preview), async () => {
  const w = world({ authPathPreview: preview });
  try {
    const { started } = await preparedAuthentication(w);
    await assert.rejects(() => w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id),
      error => error.code === 'AUTHENTICATION_INVENTORY_UNVERIFIED');
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_auth_confirmations').get().n, 0);
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_auth_confirmed_requests').get().n, 0);
    assert.equal(w.get(started.run.id).run.manual_auth, true);
    assert.equal(w.get(started.run.id).controls.can_release, false);
    assert.equal(w.calls.filter(call => ['selected_browser_confirm_authentication', 'selected_browser_model',
      'selected_browser_observe'].includes(call.method)).length, 0);
    assert.ok(!JSON.stringify(w.f.db.prepare('SELECT * FROM ops_selected_browser_events').all()).includes(preview));
  } finally { await w.close(); }
});

for (const [name, change] of [
  ['unknown effect', n => ({ ...n, effects_uncertain: 1 })],
  ['outstanding request', n => ({ ...n, pending_count: 1 })],
  ['inflight transport', n => ({ ...n, inflight: 1 })],
  ['unrecorded authentication acknowledgement', n => ({ ...n, effects_sent: 1, auth_effects_acknowledged: 1 })],
]) test('signed final ledger with ' + name + ' retains its facts but withholds completion', async () => {
  const w = world({ decisions: ['done'], hostChange: (method, out) => method === 'selected_browser_stop'
    ? changeFinalNetwork(out, n => change({ ...n, requests: 2, response_bytes: 200 })) : out });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id); const result = w.get(started.run.id);
    assert.equal(result.run.state, 'uncertain'); assert.equal(result.receipts.length, 1);
    assert.equal(result.run.usage.requests, 2); assert.equal(result.run.usage.response_bytes, 200);
    assert.notEqual(result.report_visibility, 'available'); assert.equal(result.report, null);
  } finally { await w.close(); }
});

test('lower signed final counters cannot refund previously metered action traffic', async () => {
  const w = world({ hostChange: (method, out) => method === 'selected_browser_stop'
    ? changeFinalNetwork(out, n => ({ ...n, requests: 0, response_bytes: 0 })) : out });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id);
    const result = await w.runtime.runs.cancel(w.owner, w.p.id, started.run.id, w.get(started.run.id).run.revision);
    assert.equal(result.run.usage.requests, 2); assert.equal(result.run.usage.response_bytes, 100);
    assert.equal(result.run.usage.actions, 1); assert.equal(w.executed.length, 1);
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

test('maintenance advances past a full page of retained files to delete expired and cancelled files', async () => {
  const w = world(), assets = maintenanceAssets(w);
  try {
    const retained = [];
    for (let n = 1; n <= 25; n++) retained.push(await assets.add(n));
    const expired = await assets.add(26, { expired: true }), cancelled = await assets.add(27, { cancelled: true });
    await w.runtime.startMaintenance();
    await w.tick();
    assert.ok(retained.every(a => existsSync(a.filename)));
    assert.ok(existsSync(expired.filename)); assert.ok(existsSync(cancelled.filename));
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_deletions').get().n, 0);
    await w.tick();
    for (const a of [expired, cancelled]) {
      assert.equal(existsSync(a.filename), false);
      const row = w.f.db.prepare('SELECT * FROM ops_browser_artifacts WHERE id=?').get(a.id);
      assert.equal(row.file_state, 'deleted'); assert.equal(row.charged_bytes, 0);
      assert.equal(w.f.db.prepare('SELECT outcome FROM ops_browser_artifact_deletions WHERE artifact_id=?').get(a.id).outcome, 'deleted');
    }
    for (const a of retained) {
      assert.ok(existsSync(a.filename));
      const row = w.f.db.prepare('SELECT * FROM ops_browser_artifacts WHERE id=?').get(a.id);
      assert.equal(row.state, 'staged'); assert.equal(row.file_state, 'sealed'); assert.equal(row.charged_bytes, a.byte_count);
    }
    assert.deepEqual(w.calls, []); assert.deepEqual(w.logs, []);
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_runs').get().n, 0);
  } finally { assets.close(); await w.close(); }
});

test('disabled browser and metadata gates still remove expired private files without host dispatch', async () => {
  const w = world(), assets = maintenanceAssets(w);
  try {
    const retained = await assets.add(1), expired = await assets.add(2, { expired: true }), cancelled = await assets.add(3, { cancelled: true });
    w.enable(false); w.metadata(false);
    await w.runtime.startMaintenance(); await w.tick();
    assert.ok(existsSync(retained.filename));
    assert.equal(existsSync(expired.filename), false); assert.equal(existsSync(cancelled.filename), false);
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_deletions').get().n, 2);
    assert.equal(w.f.db.prepare('SELECT charged_bytes FROM ops_browser_artifacts WHERE id=?').get(retained.id).charged_bytes, retained.byte_count);
    assert.deepEqual(w.calls, []); assert.deepEqual(w.logs, []);
  } finally { assets.close(); await w.close(); }
});

test('cleanup preserves a current read lease and retries unsafe deletes after the bounded scan wraps', async () => {
  const w = world(), assets = maintenanceAssets(w);
  try {
    const retained = [];
    for (let n = 1; n <= 25; n++) retained.push(await assets.add(n));
    const leased = await assets.add(26, { expiresSoon: true });
    const lease = w.runtime.artifacts.store.openAssetRead(w.owner, w.p.id, leased.id, 'review');
    const unsafe = await assets.add(27, { expired: true }), removable = await assets.add(28, { expired: true });
    chmodSync(unsafe.filename, 0o644); w.advance(31000);
    await w.runtime.startMaintenance(); await w.tick(); await w.tick();
    assert.ok(existsSync(leased.filename)); assert.ok(existsSync(unsafe.filename)); assert.equal(existsSync(removable.filename), false);
    for (const a of [leased, unsafe]) {
      assert.equal(w.f.db.prepare('SELECT charged_bytes FROM ops_browser_artifacts WHERE id=?').get(a.id).charged_bytes, a.byte_count);
      assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_deletions WHERE artifact_id=?').get(a.id).n, 0);
    }
    w.runtime.artifacts.store.closeRead(lease); chmodSync(unsafe.filename, 0o600);
    await w.tick();
    assert.ok(existsSync(leased.filename)); assert.ok(existsSync(unsafe.filename));
    await w.tick();
    assert.equal(existsSync(leased.filename), false); assert.equal(existsSync(unsafe.filename), false);
    assert.ok(retained.every(a => existsSync(a.filename)));
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_deletions').get().n, 3);
    assert.deepEqual(w.calls, []); assert.deepEqual(w.logs, []);
  } finally { assets.close(); await w.close(); }
});

test('actual numeric host inflight state pauses the signed launched run before model or action dispatch', async () => {
  const w = world({ decisions: ['done'] });
  try {
    await w.runtime.startMaintenance(); w.consent(); const started = await w.start();
    w.setInflight(1); await w.tick();
    await until(() => w.get(started.run.id).run.state === 'paused', () => JSON.stringify({ run: w.get(started.run.id).run, logs: w.logs }));
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_launch').length, 1);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_observe').length, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_stop').length, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_pause').length, 1);
    assert.equal(w.executed.length, 0); assert.equal(w.get(started.run.id).run.usage.model_calls, 0);
    const row = w.f.db.prepare('SELECT network_state_json FROM ops_selected_browser_runs WHERE id=?').get(started.run.id);
    assert.equal(JSON.parse(row.network_state_json).inflight_action, true);
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

test('signed host no-effect settlement retains the blocked fact and charges cumulative traffic once', async () => {
  const w = world({ hostChange: (method, out, params) => method === 'selected_browser_poll_action' ? blockedReply(w, params) : out });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id);
    for (let n = 0; n < 3; n++) await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id);
    const row = w.f.db.prepare('SELECT * FROM ops_selected_browser_steps WHERE run_id=?').get(started.run.id);
    assert.equal(row.state, 'blocked');
    const outcome = JSON.parse(row.outcome_json);
    assert.deepEqual(outcome.facts, [{ code: 'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT', source_ref: null }]);
    assert.deepEqual(outcome.usage, { requests: 2, response_bytes: 100, artifact_bytes: 0 }); assert.equal(outcome.usage_mode, 'cumulative');
    const result = w.get(started.run.id);
    assert.equal(result.run.state, 'running'); assert.deepEqual(result.uncertainties, []);
    assert.equal(result.run.usage.actions, 1); assert.equal(result.run.usage.requests, 2); assert.equal(result.run.usage.response_bytes, 100);
    assert.equal(w.executed.length, 1); assert.equal(w.calls.filter(c => c.method === 'selected_browser_poll_action').length, 1);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 1);
  } finally { await w.close(); }
});

for (const [name, change] of [
  ['unsigned receipt', raw => ({ ...raw, attestation: 'forged' })],
  ['wrong original boot', raw => { const p = decode(raw.attestation); p.boot_id = randomUUID(); return { ...raw, attestation: attestation(p) }; }],
  ['wrong attempt identity', raw => { const p = decode(raw.attestation); p.attempt_id = randomUUID(); return { ...raw, attestation: attestation(p) }; }],
  ['wrong destination plan', raw => { const p = decode(raw.attestation); p.network_plan_sha256 = 'f'.repeat(64); return { ...raw, attestation: attestation(p) }; }],
  ['wrong reserved envelope', raw => { const p = decode(raw.attestation); p.envelope_sha256 = 'f'.repeat(64); return { ...raw, attestation: attestation(p) }; }],
  ['possibly sent effect', raw => { const p = decode(raw.attestation); p.no_effect_sent = false; return { ...raw, attestation: attestation(p) }; }],
  ['replay allowed', raw => { const p = decode(raw.attestation); p.replay_allowed = true; return { ...raw, attestation: attestation(p) }; }],
  ['unbound cumulative usage', raw => ({ ...raw, usage: { ...raw.usage, requests: 0 } })],
  ['invalid ledger reference', raw => { const p = decode(raw.attestation); p.ledger_sha256 = 'invalid'; return { ...raw, attestation: attestation(p) }; }],
  ['wrong action ordinal', raw => ({ ...raw, ordinal: raw.ordinal + 1 })],
  ['delta counter semantics', raw => ({ ...raw, usage_mode: 'delta' })],
  ['generic failed state', raw => ({ ...raw, state: 'failed' })],
]) test('blocked action with ' + name + ' stays uncertain instead of safely settled', async () => {
  const w = world({ hostChange: (method, out, params) => method === 'selected_browser_poll_action' ? change(blockedReply(w, params)) : out });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id);
    assert.equal(w.get(started.run.id).run.state, 'uncertain'); assert.equal(w.get(started.run.id).run.usage.actions, 1);
    assert.equal(w.executed.length, 1);
    assert.equal(w.f.db.prepare("SELECT count(*) n FROM ops_selected_browser_steps WHERE state IN('done','blocked')").get().n, 0);
    assert.ok(w.get(started.run.id).uncertainties.some(u => u.kind === 'ACTION_OUTCOME_UNKNOWN'));
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
    assert.equal(call.params.session_id, w.owner.jti); assert.equal(w.streams[2].params.session_id, w.owner.jti);
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
      url_sha256: browserDraftHash('https://example.com/upload'), request_sha256: 'f'.repeat(64), no_contact: true,
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
      url_sha256: browserDraftHash('https://example.com/upload'), request_sha256: 'f'.repeat(64), no_contact: true }]);
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

const heldRequest = requestRef => ({ kind: 'network_effect', request_ref: requestRef, binding_sha256: 'e'.repeat(64),
  origin: 'https://example.com', role: 'resource', method: 'POST', body_sha256: browserDraftHash(''), body_bytes: 0,
  purpose: 'Review a held fixture request', url_sha256: browserDraftHash('https://example.com/fixture'), request_sha256: 'f'.repeat(64), no_contact: true });

async function preparedAuthentication(w, count = 2) {
  w.configure(c => { c.destinations.allowed_origins.find(d => d.origin === 'https://example.com').roles.push('authentication'); });
  w.consent(); const started = await w.start();
  const live = await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { session_id: randomUUID(), onMessage() {} });
  assert.equal(w.streams[0].params.session_id, w.owner.jti);
  await w.runtime.runs.takeover(w.owner, w.p.id, started.run.id, w.get(started.run.id).run.revision);
  const requests = Array.from({ length: count }, (_, n) => ({ kind: 'network_effect', request_ref: 'auth_fixture_' + n,
    binding_sha256: browserDraftHash('authentication binding ' + n), origin: 'https://example.com', role: 'authentication', method: 'POST',
    body_sha256: browserDraftHash('private authentication fixture body ' + n), body_bytes: Buffer.byteLength('private authentication fixture body ' + n),
    purpose: 'Review this selected sign-in or MFA fixture request ' + n,
    url_sha256: browserDraftHash('https://example.com' + w.authPathPreview + '?private_fixture_query=' + n),
    request_sha256: browserDraftHash('authentication request metadata ' + n), no_contact: true }));
  w.setPending(requests); await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id);
  for (const approval of w.get(started.run.id).pending_approvals) await w.approve(started.run.id, approval);
  return { started, live, requests };
}

async function confirmAuthentication(w, runId, inventory, refs = inventory.requests.slice(0, 1)) {
  return w.runtime.runs.confirmAuthentication(w.owner, w.p.id, runId, w.get(runId).run.revision, {
    inventory_sha256: inventory.inventory_sha256, request_refs: refs.map(r => ({ request_ref: r.request_ref, binding_sha256: r.binding_sha256 })),
    reviewed_statement: SELECTED_BROWSER_AUTH_STATEMENT });
}

test('authentication readback confirms only individually selected approved requests and needs explicit Give back and Resume', async () => {
  const w = world({ decisions: ['escalate'] });
  try {
    const { started } = await preparedAuthentication(w);
    await assert.rejects(() => w.runtime.runs.release(w.owner, w.p.id, started.run.id, w.get(started.run.id).run.revision), e => e.code === 'AUTHENTICATION_READBACK_REQUIRED');
    let readback = await w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id);
    assert.equal(readback.inventory.requests.length, 2); assert.equal(readback.inventory.auth_effects_acknowledged, 0);
    assert.equal(w.get(started.run.id).controls.can_confirm_authentication, true);
    const first = readback.inventory.requests[0];
    let result = await confirmAuthentication(w, started.run.id, readback.inventory);
    assert.equal(result.run.state, 'human_control'); assert.equal(result.run.manual_auth, true);
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_auth_confirmed_requests').get().n, 1);
    const confirmation = w.calls.find(c => c.method === 'selected_browser_confirm_authentication');
    assert.deepEqual(confirmation.params.packet.request_refs, [first]);
    assert.equal(confirmation.params.conn, w.streams[0].handle.conn); assert.equal(confirmation.params.packet.session_id, w.owner.jti);
    const receipt = w.f.db.prepare("SELECT * FROM ops_selected_browser_auth_confirmations WHERE state='accepted'").get();
    assert.equal(receipt.acknowledged_count, 1); assert.equal(receipt.request_sha256, selectedAuthDigest(confirmation.params.packet));
    assert.equal(decode(JSON.parse(receipt.receipt_json).attestation).request_sha256, receipt.request_sha256);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' || c.method === 'selected_browser_observe').length, 0);
    await assert.rejects(() => w.runtime.runs.release(w.owner, w.p.id, started.run.id, w.get(started.run.id).run.revision), e => e.code === 'AUTHENTICATION_READBACK_REQUIRED');
    readback = await w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id);
    assert.equal(readback.inventory.requests.length, 1); assert.notEqual(readback.inventory.requests[0].request_ref, first.request_ref);
    result = await confirmAuthentication(w, started.run.id, readback.inventory);
    assert.equal(result.run.state, 'human_control'); assert.equal(result.run.usage.requests, 2); assert.deepEqual(result.uncertainties.filter(u => u.state === 'unresolved'), []);
    result = await w.runtime.runs.release(w.owner, w.p.id, started.run.id, result.run.revision);
    assert.equal(result.run.state, 'paused'); assert.equal(result.run.manual_auth, false);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' || c.method === 'selected_browser_observe').length, 0);
    await w.runtime.runs.resume(w.owner, w.p.id, started.run.id, result.run.revision); await w.step(started.run.id);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 1);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_observe').length, 1);
    assert.equal(w.executed.length, 0);
    assert.ok(!JSON.stringify(readback.inventory).includes('private_fixture_query'));
    assert.ok(!JSON.stringify(w.calls.filter(c => c.method.includes('auth_inventory') || c.method.includes('confirm_authentication'))).includes('private authentication fixture body'));
  } finally { await w.close(); }
});

test('accepted original-attempt authentication receipts remain valid when final cleanup advances the fence', async () => {
  const w = world({ decisions: ['done'] });
  try {
    const { started } = await preparedAuthentication(w, 1);
    const { inventory } = await w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id);
    let result = await confirmAuthentication(w, started.run.id, inventory);
    result = await w.runtime.runs.release(w.owner, w.p.id, started.run.id, result.run.revision);
    result = await w.runtime.runs.resume(w.owner, w.p.id, started.run.id, result.run.revision);
    result = await w.step(started.run.id);
    assert.equal(result.run.state, 'completed'); assert.equal(result.run.fence, 2); assert.equal(result.report_visibility, 'available');
    assert.equal(result.receipts[0].final_network.auth_effects_acknowledged, 1); assert.equal(result.receipts[0].final_network.effects_sent, 1);
    assert.equal(w.f.db.prepare('SELECT fence FROM ops_selected_browser_auth_confirmed_requests').get().fence, 1);
    assert.equal(result.run.usage.requests, 1); assert.equal(result.run.usage.response_bytes, 100);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 2);
  } finally { await w.close(); }
});

function changeSignedAuth(raw, changes, kind) {
  const payload = { ...decode(raw.attestation), ...changes };
  const out = { ...raw };
  for (const [name, value] of Object.entries(changes)) if (Object.hasOwn(raw, name)) out[name] = value;
  if (kind) payload.kind = kind;
  return { ...out, attestation: attestation(payload) };
}

test('64 separately approved authentication requests fit the finite inventory-only proof cap without dropped entries', async () => {
  const w = world({ authPathPreview: '/signin/' + '[redacted]/'.repeat(80) });
  try {
    const { started, requests } = await preparedAuthentication(w, 64);
    const { inventory } = await w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id);
    assert.equal(inventory.requests.length, 64); assert.equal(new Set(inventory.requests.map(r => r.request_ref)).size, 64);
    assert.deepEqual(inventory.requests.map(r => r.request_ref).sort(), requests.map(r => r.request_ref).sort());
    const bytes = Buffer.from(inventory.attestation.split('.')[1], 'base64url').length;
    assert.ok(bytes > 100000); assert.ok(bytes <= SELECTED_BROWSER_AUTH_INVENTORY_BODY_MAX); assert.ok(inventory.attestation.length > 16000);
    const result = await confirmAuthentication(w, started.run.id, inventory, inventory.requests.slice(12, 13));
    assert.equal(result.run.state, 'human_control'); assert.equal(result.authentication_receipts[0].acknowledged_count, 1);
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_auth_confirmed_requests').get().n, 1);
    assert.equal(result.controls.can_release, false); assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' || c.method === 'selected_browser_observe').length, 0);
  } finally { await w.close(); }
});

for (const [name, change] of [
  ['unsigned proof', raw => ({ ...raw, attestation: 'forged' })],
  ['wrong original boot', raw => changeSignedAuth(raw, { boot_id: randomUUID() })],
  ['another controller session', raw => changeSignedAuth(raw, { session_id: randomUUID() })],
  ['another live connection', raw => changeSignedAuth(raw, { viewer_conn_sha256: 'a'.repeat(64) })],
  ['wrong inventory digest', raw => changeSignedAuth(raw, { inventory_sha256: 'a'.repeat(64) })],
  ['unrecorded acknowledgement count', raw => changeSignedAuth(raw, { auth_effects_acknowledged: 1 })],
  ['replay allowed', raw => changeSignedAuth(raw, { replay_allowed: true })],
  ['oversized signed body', raw => { const p = decode(raw.attestation); p.padding = ''; p.padding = 'x'.repeat(SELECTED_BROWSER_AUTH_INVENTORY_BODY_MAX + 1 - Buffer.byteLength(JSON.stringify(p))); return { ...raw, attestation: attestation(p) }; }],
]) test('authentication inventory with ' + name + ' cannot create confirmation authority', async () => {
  const w = world({ hostChange: (method, out) => method === 'selected_browser_auth_inventory' ? change(out) : out });
  try {
    const { started } = await preparedAuthentication(w);
    await assert.rejects(() => w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id), e => e.code === 'AUTHENTICATION_INVENTORY_UNVERIFIED');
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_confirm_authentication').length, 0);
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_auth_confirmations').get().n, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' || c.method === 'selected_browser_observe').length, 0);
  } finally { await w.close(); }
});

for (const [name, change] of [
  ['unsigned proof', raw => ({ ...raw, attestation: 'forged' })],
  ['wrong original destination plan', raw => changeSignedAuth(raw, { network_plan_sha256: 'a'.repeat(64) })],
  ['another controller session', raw => changeSignedAuth(raw, { session_id: randomUUID() })],
  ['another live connection', raw => changeSignedAuth(raw, { viewer_conn_sha256: 'a'.repeat(64) })],
  ['different full packet hash', raw => changeSignedAuth(raw, { request_sha256: 'a'.repeat(64) })],
  ['different inventory digest', raw => changeSignedAuth(raw, { inventory_sha256: 'a'.repeat(64) })],
  ['count beyond the selected subset', raw => changeSignedAuth(raw, { auth_effects_acknowledged: raw.auth_effects_acknowledged + 1 })],
  ['replay allowed', raw => changeSignedAuth(raw, { replay_allowed: true })],
]) test('authentication acknowledgement with ' + name + ' stays fenced and cannot unlock model or page capture', async () => {
  const w = world({ hostChange: (method, out) => method === 'selected_browser_confirm_authentication' ? change(out) : out });
  try {
    const { started } = await preparedAuthentication(w);
    const { inventory } = await w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id);
    const result = await confirmAuthentication(w, started.run.id, inventory);
    assert.equal(result.run.state, 'uncertain'); assert.ok(result.run.fence > started.run.fence);
    assert.equal(result.authentication_receipts[0].state, 'uncertain');
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_auth_confirmed_requests').get().n, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_confirm_authentication').length, 1);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' || c.method === 'selected_browser_observe').length, 0);
    assert.equal(w.executed.length, 0);
  } finally { await w.close(); }
});

test('successful background transport without a DOM reservation stops the signed launched agent before model or capture', async () => {
  const w = world({ decisions: ['done'] });
  try {
    w.consent(); const started = await w.start(); w.setEffectsSent(1); w.setNetworkCounters({ requests: 1, response_bytes: 100 }); await w.step(started.run.id);
    const result = w.get(started.run.id);
    assert.equal(result.run.state, 'uncertain'); assert.ok(result.uncertainties.some(u => u.kind === 'EXTERNAL_EFFECT_UNVERIFIED'));
    assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_steps').get().n, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' || c.method === 'selected_browser_observe').length, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_stop').length, 1); assert.equal(result.run.usage.model_calls, 0);
    assert.equal(result.run.usage.requests, 1); assert.equal(result.run.usage.response_bytes, 100);
  } finally { await w.close(); }
});

test('a background write discovered after a signed model response settles known spend and suppresses its candidate', async () => {
  const w = world({ hostChange: (method, out) => { if (method === 'selected_browser_model') { w.setEffectsSent(1); w.setNetworkCounters({ requests: 1, response_bytes: 100 }); } return out; } });
  try {
    w.consent(); const started = await w.start(); await w.step(started.run.id);
    const result = w.get(started.run.id), reservation = w.f.db.prepare('SELECT * FROM ops_selected_browser_model_reservations').get();
    assert.equal(result.run.state, 'uncertain'); assert.equal(w.executed.length, 0);
    assert.equal(reservation.state, 'settled'); assert.equal(reservation.actual_tokens, 110); assert.equal(reservation.actual_usd, 0.0001);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 1);
    assert.ok(result.uncertainties.some(u => u.kind === 'EXTERNAL_EFFECT_UNVERIFIED'));
  } finally { await w.close(); }
});

test('host authentication count without a durable accepted receipt cannot resume agent work', async () => {
  const w = world();
  try {
    w.consent(); const started = await w.start(); w.setEffectsSent(1); w.setAuthAcknowledged(1); await w.step(started.run.id);
    assert.equal(w.get(started.run.id).run.state, 'uncertain'); assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_auth_confirmed_requests').get().n, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' || c.method === 'selected_browser_observe').length, 0);
  } finally { await w.close(); }
});

test('multiple viewers in the controlling session cannot select authentication connection authority', async () => {
  const w = world();
  try {
    const { started } = await preparedAuthentication(w);
    await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage() {} });
    assert.equal(w.get(started.run.id).controls.can_confirm_authentication, false);
    await assert.rejects(() => w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id), e => e.code === 'VERIFIED_LIVE_VIEWER_REQUIRED');
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_auth_inventory').length, 0);
  } finally { await w.close(); }
});

for (const phase of ['inventory', 'confirmation']) for (const loss of ['viewer', 'session', 'expiry']) {
  test('authentication ' + phase + ' loses authority when ' + loss + ' changes during the host await', async () => {
    let armed = false;
    const method = phase === 'inventory' ? 'selected_browser_auth_inventory' : 'selected_browser_confirm_authentication';
    const w = world({ hostChange: (name, out) => {
      if (armed && name === method) {
        if (loss === 'viewer') w.streams[0].end('authentication_viewer_closed');
        else if (loss === 'session') w.f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(new Date(w.now).toISOString(), w.owner.jti);
        else w.advance(phase === 'confirmation' ? 31000 : 901000);
      }
      return out;
    } });
    try {
      const { started } = await preparedAuthentication(w);
      if (phase === 'inventory') {
        armed = true;
        await assert.rejects(() => w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id));
        assert.equal(w.calls.filter(c => c.method === 'selected_browser_confirm_authentication').length, 0);
      } else {
        const { inventory } = await w.runtime.runs.authenticationReadback(w.owner, w.p.id, started.run.id); armed = true;
        const result = await confirmAuthentication(w, started.run.id, inventory);
        assert.equal(result.run.state, 'uncertain'); assert.equal(result.authentication_receipts[0].state, 'uncertain');
      }
      assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_auth_confirmed_requests').get().n, 0);
      assert.equal(w.calls.filter(c => c.method === 'selected_browser_model' || c.method === 'selected_browser_observe').length, 0);
    } finally { await w.close(); }
  });
}

for (const manual of [false, true]) test('signed denial ' + (manual ? 'preserves the current human controller' : 'pauses the agent') + ' and invalidates other held authority', async () => {
  const w = world();
  try {
    w.consent(); const started = await w.start();
    if (manual) {
      await w.runtime.live.openLive(w.owner, w.p.id, started.run.id, { onMessage() {} });
      await w.runtime.runs.takeover(w.owner, w.p.id, started.run.id, w.get(started.run.id).run.revision);
    }
    w.setPending([heldRequest('held_deny_fixture'), heldRequest('held_other_fixture')]);
    await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id);
    const approval = w.get(started.run.id).pending_approvals.find(a => a.kind === 'network_effect');
    const result = await w.runtime.runs.decision(w.owner, w.p.id, started.run.id, approval.id, w.get(started.run.id).run.revision,
      { decision: 'deny', action_sha256: approval.action_sha256 });
    assert.equal(result.run.state, manual ? 'human_control' : 'paused'); assert.equal(result.run.manual_auth, manual);
    assert.equal(result.run.controller_user_id, manual ? w.owner.id : null); assert.equal(result.pending_approvals.length, 0);
    assert.deepEqual(result.uncertainties, []);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_deny_request').length, 1);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_pause').length, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_stop').length, 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 0); assert.equal(w.executed.length, 0);
    await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id);
    assert.equal(w.get(started.run.id).pending_approvals.length, 0);
  } finally { await w.close(); }
});

for (const [name, change] of [
  ['unsigned acknowledgement', raw => ({ ...raw, attestation: 'forged' })],
  ['another held request', raw => ({ ...raw, request_ref: 'other_request' })],
  ['wrong original boot', raw => { const p = decode(raw.attestation); p.boot_id = randomUUID(); return { ...raw, attestation: attestation(p) }; }],
  ['no no-contact proof', raw => { const p = decode(raw.attestation); p.no_contact = false; return { ...raw, no_contact: false, attestation: attestation(p) }; }],
  ['wrong manual state', raw => { const p = decode(raw.attestation); Object.assign(p, { manual_auth: true, paused: false, state: 'human_control' }); return { ...raw, manual_auth: true, paused: false, state: 'human_control', attestation: attestation(p) }; }],
  ['replay allowed', raw => { const p = decode(raw.attestation); p.replay_allowed = true; return { ...raw, attestation: attestation(p) }; }],
]) test('request denial with ' + name + ' cannot preserve a safe controller state', async () => {
  const w = world({ hostChange: (method, out) => method === 'selected_browser_deny_request' ? change(out) : out });
  try {
    w.consent(); const started = await w.start(); w.setPending([heldRequest('held_deny_fixture')]);
    await w.runtime.runs.refresh(w.owner, w.p.id, started.run.id);
    const approval = w.get(started.run.id).pending_approvals.find(a => a.kind === 'network_effect');
    const result = await w.runtime.runs.decision(w.owner, w.p.id, started.run.id, approval.id, w.get(started.run.id).run.revision,
      { decision: 'deny', action_sha256: approval.action_sha256 });
    assert.equal(result.run.state, 'uncertain'); assert.ok(result.uncertainties.length > 0);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_stop').length, 1);
    assert.equal(w.calls.filter(c => c.method === 'selected_browser_model').length, 0); assert.equal(w.executed.length, 0);
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

function neverAdmittedReceipt(params,change=()=>{}){
 const value={contract_version:'selected-browser.v1',run_id:params.run_id,attempt_id:params.attempt_id,fence:params.fence,policy_sha256:params.policy_sha256,
   closed:{browser:true,network:true,session:true,temporary_files:true},
   final_network:{requests:0,response_bytes:0,effects_sent:0,effects_uncertain:0,auth_effects_acknowledged:0,inflight:0,pending_count:0,ledger_sha256:'0'.repeat(64)},
   vm_uuid:vm,boot_id:null,workspace_id:params.attempt_id,network_plan_sha256:null,gateway_ledger_sha256:'0'.repeat(64),
   original_fence:1,no_launch:true,gateway_never_registered:true,evidence:{launched:false},uncertain_ordinals:[],
   native_inputs:{measured:true,counts:{key:0,click:0,scroll:0}}};
 change(value);const signed=attest(value,'selected-browser-teardown');
 return Object.fromEntries(['contract_version','run_id','attempt_id','fence','policy_sha256','closed','final_network','attestation'].map(k=>[k,signed[k]]));
}
const openPublic=w=>w.runtime.runs.openPublic(w.owner,w.p.id,{url:'https://selected.example/',project_revision:w.f.store.get(w.owner,w.p.id).revision,idempotency_key:randomUUID()});
test('signed never-admitted public cleanup resolves missing launch pins only on explicit verified retry',async()=>{
 let recover=false,failLaunch=true;
 const w=world({privateStorage:false,hostChange:(method,out,params)=>{
  if(method==='selected_browser_launch'&&failLaunch)throw new Error('Fixture pre-admission failure');
  if(method==='selected_browser_stop')return recover?neverAdmittedReceipt(params):{...out,attestation:'unverified'};
 }});try{
  const started=await openPublic(w);assert.equal(started.run.state,'uncertain');assert.equal(started.run.result_code,'LAUNCH_UNCERTAIN');
  assert.equal(w.f.db.prepare('SELECT count(*) n FROM ops_selected_browser_host_pins').get().n,0);
  assert.equal((await w.runtime.runs.publicReadiness(w.owner,w.p.id,'https://selected.example/')).can_start,false);
  w.session();recover=true;
  const resolved=await w.runtime.runs.retryCleanup(w.owner,w.p.id,started.run.id,started.run.revision);
  assert.equal(resolved.run.uncertain,false);assert.equal(resolved.run.state,'uncertain');assert.equal(resolved.receipts.length,1);
  assert.equal(w.executed.length,0);assert.equal(w.calls.filter(c=>c.method==='selected_browser_model').length,0);
  failLaunch=false;w.setOperation({kind:'navigate',destination_id:'public-entry',url:'https://selected.example/'});
  const next=await openPublic(w);assert.equal(next.run.state,'running');assert.notEqual(next.run.id,started.run.id);
 }finally{await w.close();}
});
for(const [name,change] of [
 ['missing proof',p=>delete p.no_launch],['untyped proof',p=>p.no_launch='true'],
 ['gateway history absent',p=>delete p.gateway_never_registered],['wrong VM',p=>p.vm_uuid=randomUUID()],
 ['wrong run',p=>p.run_id=randomUUID()],['wrong attempt',p=>p.attempt_id=randomUUID()],['wrong fence',p=>p.fence++],
 ['wrong policy',p=>p.policy_sha256='a'.repeat(64)],['invented boot',p=>p.boot_id=boot],
 ['wrong workspace',p=>p.workspace_id=randomUUID()],['invented network plan',p=>p.network_plan_sha256='b'.repeat(64)],
 ['browser launched',p=>p.evidence.launched=true],['partial closure',p=>p.closed.network=false],
 ['untyped ordinals',p=>p.uncertain_ordinals=''],['uncertain action',p=>p.uncertain_ordinals=[1]],
 ['native input',p=>p.native_inputs.counts.click=1],
 ...['requests','response_bytes','effects_sent','effects_uncertain','auth_effects_acknowledged','inflight','pending_count'].map(k=>[k,p=>p.final_network[k]=1])
])test('never-admitted cleanup rejects '+name,async()=>{
 const w=world({privateStorage:false,hostChange:(method,out,params)=>{
  if(method==='selected_browser_launch')throw new Error('Fixture pre-admission failure');
  if(method==='selected_browser_stop')return neverAdmittedReceipt(params,change);
 }});try{
  const started=await openPublic(w);assert.equal(started.run.state,'uncertain');assert.equal(started.run.uncertain,true);
  w.session();await assert.rejects(()=>w.runtime.runs.retryCleanup(w.owner,w.p.id,started.run.id,started.run.revision),e=>e.code==='SIGNED_CLEANUP_RECEIPT_REQUIRED');
  assert.equal(w.get(started.run.id).run.uncertain,true);assert.equal(w.executed.length,0);
 }finally{await w.close();}
});
test('a never-admitted proof cannot replace existing launch pins or recover an agent run',async()=>{
 for(const agent of [false,true]){
  const w=world({hostChange:(method,out,params)=>{
   if(agent&&method==='selected_browser_launch')throw new Error('Fixture lost launch reply');
   if(method==='selected_browser_stop')return neverAdmittedReceipt(params);
  }});try{
   w.session();if(agent)w.consent();else w.setOperation({kind:'navigate',destination_id:'public-entry',url:'https://selected.example/'});const started=agent?await w.start():await openPublic(w);
   const stopped=agent?started:await w.runtime.runs.cancel(w.owner,w.p.id,started.run.id,started.run.revision);
   assert.equal(stopped.run.uncertain,true);
   await assert.rejects(()=>w.runtime.runs.retryCleanup(w.owner,w.p.id,stopped.run.id,stopped.run.revision),e=>e.code==='SIGNED_CLEANUP_RECEIPT_REQUIRED');
  }finally{await w.close();}
 }
});

test('public frame reaches installed selected view with exact wire identity, no private files or model call',async()=>{
 const w=world({privateStorage:false});try{
  w.session();w.setOperation({kind:'navigate',destination_id:'public-entry',url:'https://selected.example/'});
  const {run}=await openPublic(w),frame=await w.runtime.runs.publicFrame(w.owner,w.p.id,run.id,{attempt_id:run.attempt_id,fence:run.fence});
  assert.equal(frame.width,1);assert.equal(frame.height,1);
  const requests=w.calls.filter(c=>c.method==='selected_browser_view');assert.equal(requests.length,1);
  assert.deepEqual(requests[0].params,{run_id:run.id,attempt_id:run.attempt_id,fence:1,policy_sha256:run.policy_sha256});
  assert.equal(w.calls.filter(c=>c.method==='selected_browser_model').length,0);assert.equal(w.runtime.artifacts,null);assert.equal(w.get(run.id).run.usage.artifact_bytes,0);
 }finally{await w.close();}
});
for(const code of ['BROWSER_PROTOCOL','CHANNEL_CLOSED','OBSERVATION_DESTINATION_UNAUTHORIZED',
 'SUPERVISOR_TIMEOUT','SUPERVISOR_UNREACHABLE','SUPERVISOR_PROTOCOL','CANCELLED',
 'SECRET_INTERNAL_ADDRESS',undefined])test('public viewing exposes only fixed refusal code '+String(code),async()=>{
 const w=world({privateStorage:false,hostChange:(method,out)=>{
  if(method==='selected_browser_view')throw Object.assign(new Error('private page URL and diagnostic text'),{code});
  return out;
 }});try{
  w.setOperation({kind:'navigate',destination_id:'public-entry',url:'https://selected.example/'});
  const {run}=await openPublic(w);
  const expected=!code||code==='SECRET_INTERNAL_ADDRESS'?'PUBLIC_VIEW_UNAVAILABLE':'PUBLIC_VIEW_'+code;
  await assert.rejects(()=>w.runtime.runs.publicFrame(w.owner,w.p.id,run.id,{attempt_id:run.attempt_id,fence:run.fence}),error=>{
   assert.equal(error.status,503);assert.equal(error.code,expected);assert.equal(error.message,expected);return true;
  });
  assert.equal(w.runtime.artifacts,null);assert.equal(w.get(run.id).run.usage.artifact_bytes,0);
 }finally{await w.close();}
});
for(const [name,change] of [
 ['unknown fields',raw=>({...raw,untrusted_page_url:'https://private.invalid/secret'})],
 ['bad base64',raw=>({...raw,png_base64:'not a PNG'})],
 ['wrong dimensions',raw=>({...raw,width:2})],
 ['oversize',raw=>({...raw,png_base64:'A'.repeat(3*1024*1024+4)})],
 ['wrong signature',raw=>({...raw,png_base64:Buffer.from('this is not a png header').toString('base64')})]
])test('public view suppresses '+name,async()=>{
 const w=world({privateStorage:false,hostChange:(method,out)=>method==='selected_browser_view'?change(out):out});try{
  w.session();w.setOperation({kind:'navigate',destination_id:'public-entry',url:'https://selected.example/'});
  const {run}=await openPublic(w);await assert.rejects(()=>w.runtime.runs.publicFrame(w.owner,w.p.id,run.id,{attempt_id:run.attempt_id,fence:run.fence}),e=>e.code==='PUBLIC_VIEW_INVALID');
 }finally{await w.close();}
});
