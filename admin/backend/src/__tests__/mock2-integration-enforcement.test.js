// The composite finish-time decision the runner consults (integration gate +
// egress + screening → block / pending-operator-verification / succeeded), and
// the full lifecycle (pending → succeeded on recorded confirmation; invalidation
// reopens verification). Written RED first — no enforcement path existed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateIntegrationTruthfulness, haltReasonForDecision, blockingSummary, contentHash,
} from '../mock2/integration-enforcement.js';
import {
  validateConfirmation, verificationTransition, supersessionNeeded, reportedCycleOutcome,
} from '../mock2/verification-logic.js';
import {
  MANIFEST_OK, MANIFEST_EMPTY, CONFIG_MODULE, toFiles,
  FIXTURE_ADP2_PATTERN, FIXTURE_HONEST, CLEAN_PLAIN_FEATURE,
  EVASION_HELPER_CANNED, EVASION_BUNDLED_JSON, EVASION_RESPONSE_IGNORED,
  EVASION_ERROR_TO_SUCCESS, EVASION_DEAD_CODE, EVASION_PROD_FIXTURE_MODE, EVASION_UNDECLARED,
} from './fixtures/integration-fixtures.js';

const files = (...maps) => toFiles(CONFIG_MODULE, ...maps);

// ---- Part C.1: ADP2 recreation is BLOCKED at finish (source-level) ----

test('ADP2 recreation → blocked-deviation via the integration gate, with actionable reasons + options', () => {
  const r = evaluateIntegrationTruthfulness({
    files: files(FIXTURE_ADP2_PATTERN), manifestText: MANIFEST_OK,
    finish: { summary: 'wired up the people sync', acceptance: ['as admin, open People, expect a roster'], assumptions: { verified: [], assumed: [] } },
  });
  assert.equal(r.outcome, 'blocked-deviation');
  assert.equal(r.blocking, true);
  assert.equal(haltReasonForDecision(r), 'integration_gate');
  const s = blockingSummary(r);
  assert.ok(s.reason.length > 0);
  assert.ok(s.options.length >= 2);
  assert.ok(r.reasons.some((x) => /fabricated_output|execution_without_transport/.test(x)));
});

// ---- Part C.1(b): finish-time DISCLOSURE alone creates a blocking candidate ----

test('finish disclosure alone (honest code) → blocked-deviation via screening', () => {
  const r = evaluateIntegrationTruthfulness({
    files: files(FIXTURE_HONEST), manifestText: MANIFEST_OK,
    finish: {
      summary: 'people sync implemented',
      acceptance: ['as admin, open People'],
      assumptions: { verified: ['src/people/transport.ts issues the mTLS request'], assumed: ['full worker fetch is synthesized because no live endpoint is reachable from the build container'] },
    },
  });
  assert.equal(r.blocking, true);
  assert.equal(r.outcome, 'blocked-deviation');
  assert.equal(haltReasonForDecision(r), 'simulation_disclosure');
  assert.ok(r.screening.candidates.some((c) => c.tier === 'high'));
});

// ---- Part C.2: honest implementation → pending-operator-verification → succeeded ----

test('honest implementation lands in pending-operator-verification with a live checklist', () => {
  const r = evaluateIntegrationTruthfulness({
    files: files(FIXTURE_HONEST), manifestText: MANIFEST_OK,
    finish: { summary: 'implemented the directory sync over mTLS', acceptance: ['as admin, open People, expect real rows'], assumptions: { verified: ['src/people/transport.ts'], assumed: [] } },
  });
  assert.equal(r.blocking, false);
  assert.equal(r.outcome, 'pending-operator-verification');
  assert.equal(r.checklist.length, 2);
  assert.ok(r.checklist.every((it) => it.manifest_id === 'directory-provider' && /^[a-f0-9]{64}$/.test(it.manifest_hash)));
  // The reported cycle outcome reflects the pending state.
  assert.equal(reportedCycleOutcome({ status: 'awaiting_user', verification_state: 'pending' }), 'pending-operator-verification');
});

test('pending → succeeded only on recorded confirmations (observed results, not checkboxes)', () => {
  const r = evaluateIntegrationTruthfulness({ files: files(FIXTURE_HONEST), manifestText: MANIFEST_OK, finish: { summary: 'sync', acceptance: ['x'], assumptions: { verified: [], assumed: [] } } });
  // Each checklist item confirmed with a real observed result.
  for (const item of r.checklist) {
    const conf = validateConfirmation({
      item_id: item.item_id, manifest_id: item.manifest_id, manifest_hash: item.manifest_hash,
      operator_id: 7, environment: 'production', endpoint_classification: item.endpoint_classification,
      observed_result: 'mTLS handshake accepted against api.provider.example; sync-people returned 41 workers, 41 rows upserted',
    });
    assert.equal(conf.ok, true);
  }
  assert.equal(verificationTransition({ state: 'pending-operator-verification', event: 'all_items_confirmed' }).next, 'succeeded');
  // A bare checkbox does NOT advance it.
  const bad = validateConfirmation({ item_id: 'x', manifest_id: 'm', manifest_hash: 'a'.repeat(64), operator_id: 7, environment: 'production', endpoint_classification: 'public', observed_result: 'true' });
  assert.equal(bad.ok, false);
});

// ---- Part C.3: every evasion fixture is blocked ----

for (const [name, map] of [
  ['helper-canned', EVASION_HELPER_CANNED],
  ['bundled-json', EVASION_BUNDLED_JSON],
  ['response-ignored', EVASION_RESPONSE_IGNORED],
  ['error-to-success', EVASION_ERROR_TO_SUCCESS],
  ['dead-code', EVASION_DEAD_CODE],
  ['prod-fixture-mode', EVASION_PROD_FIXTURE_MODE],
]) {
  test(`evasion "${name}" → blocked-deviation`, () => {
    const r = evaluateIntegrationTruthfulness({ files: files(map), manifestText: MANIFEST_OK, finish: { summary: 'done', acceptance: ['x'], assumptions: { verified: [], assumed: [] } } });
    assert.equal(r.outcome, 'blocked-deviation', JSON.stringify(r.reasons));
  });
}

test('evasion "undeclared" (integration absent from manifest) → blocked-deviation', () => {
  const r = evaluateIntegrationTruthfulness({ files: toFiles(EVASION_UNDECLARED), manifestText: MANIFEST_EMPTY, finish: { summary: 'notify', acceptance: ['x'], assumptions: { verified: [], assumed: [] } } });
  assert.equal(r.outcome, 'blocked-deviation');
  assert.ok(r.reasons.some((x) => /undeclared_integration/.test(x)));
  // The decision proposes a bootstrapped manifest entry for it.
  assert.ok(r.manifest.bootstrapped_from_discovery.length >= 1);
});

// ---- Part C.4: clean controls are NOT blocked ----

test('clean control: ordinary non-integration feature → succeeded (no external integrations in scope)', () => {
  const r = evaluateIntegrationTruthfulness({ files: toFiles(CLEAN_PLAIN_FEATURE), manifestText: MANIFEST_EMPTY, finish: { summary: 'added tasks', acceptance: ['as user, create a task'], assumptions: { verified: [], assumed: [] } } });
  assert.equal(r.outcome, 'succeeded');
  assert.equal(r.blocking, false);
  assert.equal(r.checklist.length, 0);
});

test('clean control: response-transforming integration passes and goes pending (not blocked)', () => {
  const r = evaluateIntegrationTruthfulness({ files: files(FIXTURE_HONEST), manifestText: MANIFEST_OK, finish: { summary: 'sync', acceptance: ['x'], assumptions: { verified: [], assumed: [] } } });
  assert.notEqual(r.outcome, 'blocked-deviation');
});

// ---- Part C.6: invalidation reopens verification ----

test('invalidation: a changed manifest entry hash supersedes a verified record and downgrades to pending', () => {
  const verifiedRecord = { manifest_id: 'directory-provider', manifest_hash: 'a'.repeat(64), expires_at: null };
  // Same hash → no supersession.
  assert.equal(supersessionNeeded({ record: verifiedRecord, currentManifestHash: 'a'.repeat(64) }).needed, false);
  // Endpoint changed → manifest hash changes → supersede + downgrade to pending.
  const sup = supersessionNeeded({ record: verifiedRecord, currentManifestHash: 'c'.repeat(64) });
  assert.equal(sup.needed, true);
  assert.match(sup.reason, /manifest/i);
});

test('decision records are content-hashed (append-only, tamper-evident)', () => {
  const r = evaluateIntegrationTruthfulness({ files: files(FIXTURE_HONEST), manifestText: MANIFEST_OK, finish: { summary: 'x', acceptance: ['y'], assumptions: { verified: [], assumed: [] } } });
  assert.match(r.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(r.content_hash, contentHash({ outcome: r.outcome, reasons: r.reasons, gate: r.gate, egress: r.egress, screening: r.screening }));
});
