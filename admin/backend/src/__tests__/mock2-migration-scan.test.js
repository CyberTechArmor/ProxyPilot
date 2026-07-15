// Migration scanning — pure decisions for existing projects on their first
// cycle under the updated harness. Written RED first: nothing scanned legacy
// projects for shipped stubs, and analysis failure had no representation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  migrationFindingsFromAnalysis, analysisIncompleteFinding, legacyFindingBlocking,
  MIGRATION_SCHEMA_VERSION,
} from '../mock2/migration-scan-logic.js';
import { analyzeIntegrations, parseIntegrationManifest, bootstrapManifestFromDiscovery } from '../mock2/integration-logic.js';
import { MANIFEST_OK, CONFIG_MODULE, FIXTURE_ADP2_PATTERN, toFiles } from './fixtures/integration-fixtures.js';

const manifest = parseIntegrationManifest(MANIFEST_OK).manifest;

test('legacy scan converts B.4 findings into NON-blocking migration findings at scan time', () => {
  const analysis = analyzeIntegrations({ files: toFiles(CONFIG_MODULE, FIXTURE_ADP2_PATTERN), manifest });
  const findings = migrationFindingsFromAnalysis({ analysis, projectId: 5, frameworkVersionId: 9 });
  assert.ok(findings.length >= 2);
  for (const f of findings) {
    assert.equal(f.kind, 'suspected_legacy_stub');
    assert.equal(f.blocking, false);
    assert.equal(f.schema_version, MIGRATION_SCHEMA_VERSION);
    assert.ok(f.subsystem);
    assert.ok(f.detail.file);
    assert.equal(f.framework_version_id, 9);
  }
});

test('a legacy finding becomes blocking when a cycle touches the affected subsystem', () => {
  const finding = { kind: 'suspected_legacy_stub', subsystem: 'people', blocking: false, framework_version_id: 9 };
  assert.equal(legacyFindingBlocking({ finding, touchedSubsystems: ['people'], currentFrameworkVersionId: 9 }), true);
  assert.equal(legacyFindingBlocking({ finding, touchedSubsystems: ['billing'], currentFrameworkVersionId: 9 }), false);
});

test('a legacy finding becomes blocking at the next framework-version reconciliation', () => {
  const finding = { kind: 'suspected_legacy_stub', subsystem: 'people', blocking: false, framework_version_id: 9 };
  assert.equal(legacyFindingBlocking({ finding, touchedSubsystems: [], currentFrameworkVersionId: 10 }), true);
});

test('analysis-incomplete: states exactly what could not be analyzed; never reported as clean', () => {
  const f = analysisIncompleteFinding({
    projectId: 5, frameworkVersionId: 9,
    reason: 'unsupported language', details: ['src/people/service.py'],
  });
  assert.equal(f.kind, 'analysis_incomplete');
  assert.equal(f.blocking, false);
  assert.match(f.message, /unsupported language/);
  assert.match(f.message, /service\.py/);
  assert.equal(f.schema_version, MIGRATION_SCHEMA_VERSION);
  // Same escalation rules as suspected stubs.
  assert.equal(legacyFindingBlocking({ finding: f, touchedSubsystems: [], currentFrameworkVersionId: 10 }), true);
});

test('manifest bootstrap: source discovery proposes entries for undeclared integrations', () => {
  const analysis = analyzeIntegrations({
    files: [{ path: 'src/notify/service.ts', content: `export async function push(m){ const r = await fetch('https://hooks.chat-provider.example/x', {method:'POST'}); return {ok:r.ok}; }` }],
    manifest: { schema_version: 1, entries: [] },
  });
  const boot = bootstrapManifestFromDiscovery(analysis);
  assert.ok(boot.entries.length >= 1);
  const e = boot.entries[0];
  assert.equal(e.subsystem, 'notify');
  assert.equal(e.bootstrapped, true);
  assert.ok(e.destination);
});
