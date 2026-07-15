// B.4 integration truthfulness gate — pure analyzer. Reproduce-first: this file
// was written RED against the current harness (no integration-logic.js existed;
// no gate could detect the ADP2 pattern), then the analyzer was implemented to
// green. Detection must be capability/transport/provenance-based — the fixtures
// deliberately avoid every name from the ADP2 incident.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIntegrationManifest, manifestEntryHash, analyzeIntegrations,
  INTEGRATION_MANIFEST_PATH, MANIFEST_SCHEMA_VERSION,
} from '../mock2/integration-logic.js';
import {
  MANIFEST_OK, MANIFEST_EMPTY, CONFIG_MODULE, toFiles,
  FIXTURE_ADP2_PATTERN, FIXTURE_HONEST,
  EVASION_HELPER_CANNED, EVASION_BUNDLED_JSON, EVASION_RESPONSE_IGNORED,
  EVASION_ERROR_TO_SUCCESS, EVASION_DEAD_CODE, EVASION_PROD_FIXTURE_MODE,
  EVASION_UNDECLARED,
  CLEAN_PLAIN_FEATURE, CLEAN_TEST_FIXTURE_SERVER, CLEAN_TRANSFORMING_INTEGRATION,
} from './fixtures/integration-fixtures.js';

const manifest = () => parseIntegrationManifest(MANIFEST_OK).manifest;
const run = (fileMaps, m = manifest()) => analyzeIntegrations({ files: toFiles(CONFIG_MODULE, ...fileMaps), manifest: m });
const findingKinds = (r) => r.findings.map((f) => f.kind);

// ---- manifest (B.2) ----

test('manifest: parses, validates, and hashes the versioned entry', () => {
  const r = parseIntegrationManifest(MANIFEST_OK);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.schema_version, MANIFEST_SCHEMA_VERSION);
  assert.equal(r.manifest.entries.length, 1);
  const e = r.manifest.entries[0];
  assert.equal(e.id, 'directory-provider');
  assert.equal(e.subsystem, 'people');
  assert.equal(e.provenance.response_to_output, 'required');
  assert.equal(e.live_verification.required, true);
  const h1 = manifestEntryHash(e);
  assert.match(h1, /^[a-f0-9]{64}$/);
  // The hash is content-derived: a changed endpoint changes it.
  const h2 = manifestEntryHash({ ...e, destination: { ...e.destination, key: 'other.key' } });
  assert.notEqual(h1, h2);
  assert.equal(INTEGRATION_MANIFEST_PATH, 'state/integrations.json');
});

test('manifest: rejects missing required fields and unknown schema versions', () => {
  assert.equal(parseIntegrationManifest('not json').ok, false);
  assert.equal(parseIntegrationManifest(JSON.stringify({ schema_version: 99, entries: [] })).ok, false);
  const missing = JSON.stringify({ schema_version: 1, entries: [{ id: 'x' }] });
  const r = parseIntegrationManifest(missing);
  assert.equal(r.ok, false);
  assert.match(r.error, /subsystem/);
});

// ---- the ADP2 recreation must fail the gate on source analysis alone ----

test('ADP2 pattern: presence-only connection test fails execution; hardcoded upsert fails provenance', () => {
  const r = run([FIXTURE_ADP2_PATTERN]);
  assert.equal(r.verdict, 'fail');
  const kinds = findingKinds(r);
  assert.ok(kinds.includes('execution_without_transport'), `expected execution_without_transport in ${kinds}`);
  assert.ok(kinds.includes('fabricated_output'), `expected fabricated_output in ${kinds}`);
  // Findings are actionable: they name the file and function.
  const exec = r.findings.find((f) => f.kind === 'execution_without_transport');
  assert.equal(exec.file, 'src/people/connection.ts');
  assert.match(exec.function || '', /checkDirectoryConnection/);
  const fab = r.findings.find((f) => f.kind === 'fabricated_output');
  assert.equal(fab.file, 'src/people/service.ts');
});

// ---- the honest implementation must pass ----

test('honest implementation: config flows to transport, output derives from response — passes', () => {
  const r = run([FIXTURE_HONEST]);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.findings, null, 2));
});

// ---- evasion fixtures (Part C.3) — each caught ----

test('evasion: canned success moved into a helper function is still caught', () => {
  const r = run([EVASION_HELPER_CANNED]);
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('execution_without_transport'));
});

test('evasion: fake data loaded from a bundled JSON file is caught', () => {
  const r = run([EVASION_BUNDLED_JSON]);
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('fabricated_output'));
});

test('evasion: a real socket call whose response is ignored is caught', () => {
  const r = run([EVASION_RESPONSE_IGNORED]);
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('fabricated_output'));
});

test('evasion: transport error caught and converted into success is caught', () => {
  const r = run([EVASION_ERROR_TO_SUCCESS]);
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('error_converted_to_success'));
});

test('evasion: endpoint called only from dead/unreachable code is caught', () => {
  const r = run([EVASION_DEAD_CODE]);
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('execution_without_transport'));
});

test('evasion: fixture mode reachable through production configuration is caught', () => {
  const r = run([EVASION_PROD_FIXTURE_MODE]);
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('fixture_reachable_in_production'));
});

test('evasion: an outbound integration absent from the manifest is a gate failure', () => {
  const r = analyzeIntegrations({ files: toFiles(EVASION_UNDECLARED), manifest: parseIntegrationManifest(MANIFEST_EMPTY).manifest });
  assert.equal(r.verdict, 'fail');
  const und = r.findings.find((f) => f.kind === 'undeclared_integration');
  assert.ok(und, JSON.stringify(r.findings));
  assert.equal(und.file, 'src/notify/service.ts');
});

// ---- clean controls (Part C.4) — each NOT flagged ----

test('clean control: an ordinary non-integration feature produces no findings', () => {
  const r = analyzeIntegrations({ files: toFiles(CLEAN_PLAIN_FEATURE), manifest: parseIntegrationManifest(MANIFEST_EMPTY).manifest });
  assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
  assert.equal(r.findings.length, 0);
});

test('clean control: an explicitly isolated test-only fixture server is not flagged', () => {
  const r = run([CLEAN_TEST_FIXTURE_SERVER, FIXTURE_HONEST]);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
});

test('clean control: parsing/transforming the received response passes provenance', () => {
  const r = run([CLEAN_TRANSFORMING_INTEGRATION]);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
});

// ---- fail-closed + generality invariants ----

test('fail closed: a declared subsystem with no analyzable source yields provenance_not_established (never pass)', () => {
  const r = analyzeIntegrations({ files: [], manifest: manifest() });
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('provenance_not_established'));
});

test('fail closed: an unsupported language in the declared subsystem is not inferred as success', () => {
  const r = analyzeIntegrations({
    files: [{ path: 'src/people/service.py', content: 'def sync():\n    return {"ok": True}\n' }],
    manifest: manifest(),
  });
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('provenance_not_established'));
  const f = r.findings.find((x) => x.kind === 'provenance_not_established');
  assert.match(f.message, /\.py|language|analyz/i);
});

test('generality: merely containing an HTTP call somewhere is insufficient (dead-code fixture has one)', () => {
  // EVASION_DEAD_CODE contains a genuine https.request — but unreachable from
  // the action. If detection were "does the subsystem contain an HTTP call",
  // this would pass; it must fail.
  const r = run([EVASION_DEAD_CODE]);
  assert.equal(r.verdict, 'fail');
});

test('the analyzer documents its supported languages and known limits', () => {
  const r = run([FIXTURE_HONEST]);
  assert.ok(Array.isArray(r.limits.supported_languages) && r.limits.supported_languages.includes('typescript'));
  assert.ok(Array.isArray(r.limits.transport_patterns) && r.limits.transport_patterns.length > 0);
  assert.ok(Array.isArray(r.limits.known_limits) && r.limits.known_limits.length > 0);
  assert.equal(r.schema_version, 1);
});

test('contract test requirements: missing negative-path contract test is a finding', () => {
  // Honest code but no contract test file at the declared path.
  const noContract = { ...FIXTURE_HONEST };
  delete noContract['src/people/contract.test.ts'];
  const r = run([noContract]);
  assert.equal(r.verdict, 'fail');
  assert.ok(findingKinds(r).includes('contract_test_missing'));
});
