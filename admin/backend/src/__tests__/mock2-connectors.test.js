// Mock2 Phase M5 tests — the model-connector pure decision layer.
//
// Stub-first (risk R9 / docs/known-issues.md): imports ONLY connector-logic.js,
// which has NO native (better-sqlite3), Express, or network imports. The
// real encrypted-key round-trip and the live test-connection HTTP call are
// exercised against a real/fake key on an enabled host (M5 verify checklist).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_SLOTS,
  CAPABILITIES,
  PROVIDERS,
  isCloudProvider,
  SLOT_REQUIRED_CAPABILITY,
  connectorCoversSlot,
  slotAssignmentError,
  defaultCapabilitiesForProvider,
  normalizeCapabilities,
  parseCapabilities,
  validateConnectorInput,
  hostFromBaseUrl,
  connectorEgressHost,
  connectorEgressHosts,
  requiresBaaAck,
  publicConnectorShape,
  connectorTestPlan,
  interpretTestResponse,
} from '../mock2/connector-logic.js';

// ---- slots + capabilities ----

test('the 7 slots are present', () => {
  assert.deepEqual(MODEL_SLOTS, ['concept_chat', 'mockup', 'audit', 'classifier', 'build_runner', 'summary', 'remediation']);
});

test('build_runner + remediation require agentic_build', () => {
  assert.equal(SLOT_REQUIRED_CAPABILITY.build_runner, 'agentic_build');
  assert.equal(SLOT_REQUIRED_CAPABILITY.remediation, 'agentic_build');
});

test('connectorCoversSlot: a chat-only model cannot be build_runner', () => {
  const chatOnly = ['chat'];
  assert.equal(connectorCoversSlot(chatOnly, 'concept_chat'), true);
  assert.equal(connectorCoversSlot(chatOnly, 'build_runner'), false);
});

test('slotAssignmentError: rejects chat-only for build_runner, allows a full model', () => {
  assert.match(slotAssignmentError(['chat', 'summarize'], 'build_runner'), /agentic_build/);
  assert.equal(slotAssignmentError(['chat', 'agentic_build', 'summarize', 'classify'], 'build_runner'), null);
  assert.match(slotAssignmentError(['chat'], 'nonsense_slot'), /Unknown slot/);
});

test('slotAssignmentError: classifier needs classify, summary needs summarize', () => {
  assert.equal(slotAssignmentError(['classify'], 'classifier'), null);
  assert.match(slotAssignmentError(['chat'], 'classifier'), /classify/);
  assert.equal(slotAssignmentError(['summarize'], 'summary'), null);
  assert.match(slotAssignmentError(['chat'], 'summary'), /summarize/);
});

// ---- provider metadata ----

test('cloud providers are anthropic/openai/gemini', () => {
  assert.equal(isCloudProvider('anthropic'), true);
  assert.equal(isCloudProvider('openai'), true);
  assert.equal(isCloudProvider('gemini'), true);
  assert.equal(isCloudProvider('ollama'), false);
  assert.equal(isCloudProvider('openai_compatible'), false);
});

test('default capabilities: cloud gets everything, local gets the safe subset', () => {
  assert.deepEqual(defaultCapabilitiesForProvider('anthropic'), ['chat', 'agentic_build', 'summarize', 'classify']);
  assert.deepEqual(defaultCapabilitiesForProvider('ollama'), ['chat', 'summarize', 'classify']);
});

test('normalizeCapabilities drops unknowns and dedupes', () => {
  assert.deepEqual(normalizeCapabilities(['chat', 'chat', 'bogus', 'classify']), ['chat', 'classify']);
  assert.deepEqual(normalizeCapabilities('nope'), []);
});

test('validateConnectorInput: base_url required for local providers', () => {
  assert.equal(validateConnectorInput({ provider: 'anthropic' }), null);
  assert.match(validateConnectorInput({ provider: 'ollama' }), /base URL is required/);
  assert.equal(validateConnectorInput({ provider: 'ollama', base_url: 'http://localhost:11434' }), null);
  assert.match(validateConnectorInput({ provider: 'openai_compatible', base_url: 'ftp://x' }), /http\(s\)/);
  assert.match(validateConnectorInput({ provider: 'nope' }), /Unknown provider/);
});

// ---- egress host derivation (the M4 seam) ----

test('hostFromBaseUrl: extracts host, null for loopback/IP', () => {
  assert.equal(hostFromBaseUrl('https://ollama.example.com:11434/v1'), 'ollama.example.com');
  assert.equal(hostFromBaseUrl('http://localhost:11434'), null);
  assert.equal(hostFromBaseUrl('http://127.0.0.1:11434'), null);
  assert.equal(hostFromBaseUrl('http://10.0.0.5:11434'), null);
  assert.equal(hostFromBaseUrl(''), null);
});

test('connectorEgressHost: cloud → fixed API host, local → base_url host', () => {
  assert.equal(connectorEgressHost({ provider: 'anthropic' }), 'api.anthropic.com');
  assert.equal(connectorEgressHost({ provider: 'openai' }), 'api.openai.com');
  assert.equal(connectorEgressHost({ provider: 'gemini' }), 'generativelanguage.googleapis.com');
  assert.equal(connectorEgressHost({ provider: 'openai_compatible', base_url: 'https://llm.corp.net/v1' }), 'llm.corp.net');
  assert.equal(connectorEgressHost({ provider: 'ollama', base_url: 'http://localhost:11434' }), null);
});

test('connectorEgressHosts: only ENABLED connectors, deduped', () => {
  const hosts = connectorEgressHosts([
    { provider: 'anthropic', enabled: 1 },
    { provider: 'anthropic', enabled: 1 }, // dupe host
    { provider: 'openai', enabled: 0 }, // disabled — excluded
    { provider: 'ollama', enabled: 1, base_url: 'http://localhost:11434' }, // local — no host
    { provider: 'openai_compatible', enabled: 1, base_url: 'https://llm.corp.net' },
  ]);
  assert.deepEqual(hosts, ['api.anthropic.com', 'llm.corp.net']);
});

// ---- BAA ack (Q7) ----

test('requiresBaaAck: cloud + not yet acked', () => {
  assert.equal(requiresBaaAck('anthropic', null), true);
  assert.equal(requiresBaaAck('anthropic', '2026-07-10T00:00:00Z'), false); // already acked
  assert.equal(requiresBaaAck('ollama', null), false); // local — no BAA
});

// ---- publicConnectorShape: never leaks the secret ----

test('publicConnectorShape omits the key, exposes has_key + secret_decryptable', () => {
  const row = {
    id: 3, name: 'Claude', provider: 'anthropic', base_url: null,
    api_key_enc: 'enc:v1:aa:bb:cc', capabilities: '["chat","agentic_build"]',
    enabled: 1, test_status: '{"ok":true,"detail":"reachable"}', test_at: '2026-07-10T00:00:00Z',
    baa_ack_by: 5, baa_ack_at: '2026-07-10T00:00:00Z', created_by: 1, created_at: '2026-07-10T00:00:00Z',
  };
  const shaped = publicConnectorShape(row, { secretDecryptable: true });
  assert.equal(shaped.api_key_enc, undefined);
  assert.equal('api_key' in shaped, false);
  assert.equal(shaped.has_key, true);
  assert.equal(shaped.secret_decryptable, true);
  assert.deepEqual(shaped.capabilities, ['chat', 'agentic_build']);
  assert.deepEqual(shaped.test, { ok: true, detail: 'reachable' });
  assert.equal(shaped.is_cloud, true);
  assert.equal(shaped.egress_host, 'api.anthropic.com');
});

test('parseCapabilities tolerates junk', () => {
  assert.deepEqual(parseCapabilities('["chat"]'), ['chat']);
  assert.deepEqual(parseCapabilities('not json'), []);
  assert.deepEqual(parseCapabilities(null), []);
});

// ---- test-connection plan + verdict (pure halves) ----

test('connectorTestPlan: provider endpoints + auth headers', () => {
  assert.equal(connectorTestPlan({ provider: 'anthropic', __apiKey: 'sk' }).url, 'https://api.anthropic.com/v1/models');
  assert.equal(connectorTestPlan({ provider: 'anthropic', __apiKey: 'sk' }).headers['x-api-key'], 'sk');
  assert.equal(connectorTestPlan({ provider: 'openai', __apiKey: 'sk' }).headers.authorization, 'Bearer sk');
  assert.match(connectorTestPlan({ provider: 'gemini', __apiKey: 'sk' }).url, /key=sk/);
  assert.equal(connectorTestPlan({ provider: 'ollama', base_url: 'http://h:11434/' }).url, 'http://h:11434/api/tags');
  assert.equal(connectorTestPlan({ provider: 'openai_compatible', base_url: 'https://x/v1/' }).url, 'https://x/v1/v1/models');
});

test('interpretTestResponse: 2xx ok, 401 auth, else HTTP n', () => {
  assert.equal(interpretTestResponse(200, '{"data":[1,2,3]}').ok, true);
  assert.equal(interpretTestResponse(200, '{"data":[1,2,3]}').models, 3);
  assert.equal(interpretTestResponse(401, '').ok, false);
  assert.match(interpretTestResponse(401, '').detail, /auth rejected/);
  assert.equal(interpretTestResponse(500, '').ok, false);
});

test('providers + capabilities vocab are stable', () => {
  assert.deepEqual(PROVIDERS, ['anthropic', 'openai', 'gemini', 'ollama', 'openai_compatible']);
  assert.deepEqual(CAPABILITIES, ['chat', 'agentic_build', 'summarize', 'classify']);
});
