// Mock2 Phase M5 tests — the framework-registry pure decision layer (ADR-003)
// and the git-connector pure layer (ADR-006).
//
// Stub-first (risk R9): imports ONLY the *-logic.js modules (native-free). The
// real seed insert + publish→v2 + revert→v3 round-trip run against mock2.db on
// an enabled host (M5 verify checklist); the versioning/validation RULES are
// proven here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAMEWORK_CONTENT_FIELDS,
  FRAMEWORK_EXPORT_FORMAT,
  nextVersionNumber,
  validateFrameworkContent,
  buildRevertContent,
  publicFrameworkShape,
  buildFrameworkExport,
  parseFrameworkImport,
} from '../mock2/framework-logic.js';
import {
  GIT_PROVIDERS,
  GIT_AUTH_KINDS,
  validateGitConnectorInput,
  gitTestPlan,
  interpretGitTestResponse,
  publicGitConnectorShape,
} from '../mock2/git-logic.js';

// ---- framework versioning ----

test('nextVersionNumber: monotonic, 1 when empty', () => {
  assert.equal(nextVersionNumber([]), 1);
  assert.equal(nextVersionNumber([{ version: 1 }, { version: 2 }]), 3);
  assert.equal(nextVersionNumber([{ version: 3 }, { version: 1 }]), 4); // max, not count
});

test('validateFrameworkContent: requires all content, valid JSON gates/skills', () => {
  const good = {
    constitution_md: 'c', skills_json: '{"skills":[]}',
    gates_json: '[{"name":"g","script":"exit 0","order":1}]',
    design_system_md: 'd', project_template_ref: 'builtin:x',
  };
  assert.equal(validateFrameworkContent(good).ok, true);
  assert.match(validateFrameworkContent({ ...good, constitution_md: '' }).error, /constitution_md/);
  assert.match(validateFrameworkContent({ ...good, skills_json: 'nope' }).error, /skills_json must be valid JSON/);
  assert.match(validateFrameworkContent({ ...good, gates_json: '{}' }).error, /array/);
  assert.match(validateFrameworkContent({ ...good, gates_json: '[{"script":"x"}]' }).error, /name/);
});

test('buildRevertContent: carries source content, stamps reverted_from_version', () => {
  const source = {
    version: 1, constitution_md: 'C1', skills_json: 'S1', gates_json: 'G1',
    design_system_md: 'D1', project_template_ref: 'T1',
  };
  const content = buildRevertContent(source);
  for (const f of FRAMEWORK_CONTENT_FIELDS) assert.equal(content[f], source[f]);
  assert.equal(content.reverted_from_version, 1);
  assert.match(content.changelog, /Revert to v1/);
});

test('publicFrameworkShape: content hidden by default, included on request', () => {
  const row = {
    id: 2, version: 2, changelog: 'x', reverted_from_version: null, source: 'in_app',
    source_git_commit: null, created_by: 1, created_at: '2026-07-10T00:00:00Z',
    constitution_md: 'C', skills_json: 'S', gates_json: 'G', design_system_md: 'D', project_template_ref: 'T',
  };
  const meta = publicFrameworkShape(row);
  assert.equal(meta.version, 2);
  assert.equal(meta.constitution_md, undefined);
  const full = publicFrameworkShape(row, { includeContent: true });
  assert.equal(full.constitution_md, 'C');
  assert.equal(full.project_template_ref, 'T');
});

// ---- portable export / import (download the harness) ----

const GOOD_GATES = JSON.stringify([{ name: 'typecheck', script: '#!/bin/sh\nexit 0\n', order: 1 }]);
const FRAMEWORK_ROW = {
  id: 9, version: 4, changelog: 'v4 changes', reverted_from_version: null, source: 'in_app',
  created_by: 1, created_at: '2026-07-15T00:00:00Z',
  constitution_md: '# Constitution', skills_json: '{"a":1}', gates_json: GOOD_GATES,
  design_system_md: '# Design', project_template_ref: 'scaffold@run-1',
};

test('buildFrameworkExport: self-contained document, no install-specific ids', () => {
  const doc = buildFrameworkExport(FRAMEWORK_ROW);
  assert.equal(doc.format, FRAMEWORK_EXPORT_FORMAT);
  assert.equal(doc.exported_from_version, 4);
  assert.equal(doc.changelog, 'v4 changes');
  for (const f of FRAMEWORK_CONTENT_FIELDS) assert.equal(doc[f], FRAMEWORK_ROW[f]);
  // No id / created_by / source leak into the portable document.
  assert.equal(doc.id, undefined);
  assert.equal(doc.created_by, undefined);
});

test('buildFrameworkExport → parseFrameworkImport round-trips into insertable content', () => {
  const doc = buildFrameworkExport(FRAMEWORK_ROW);
  const r = parseFrameworkImport(doc);
  assert.equal(r.ok, true);
  for (const f of FRAMEWORK_CONTENT_FIELDS) assert.equal(r.data[f], FRAMEWORK_ROW[f]);
  assert.equal(r.data.exported_from_version, 4);
  assert.match(r.data.changelog, /v4 changes/);
});

test('parseFrameworkImport: rejects a wrong/missing format tag', () => {
  assert.equal(parseFrameworkImport(null).ok, false);
  assert.equal(parseFrameworkImport([]).ok, false);
  assert.equal(parseFrameworkImport({ ...buildFrameworkExport(FRAMEWORK_ROW), format: 'proxypilot-component@1' }).ok, false);
  const { format, ...noFormat } = buildFrameworkExport(FRAMEWORK_ROW);
  assert.equal(parseFrameworkImport(noFormat).ok, false);
});

test('parseFrameworkImport: holds an imported bundle to the SAME content bar as a publish', () => {
  // Malformed gates JSON in the document is rejected (validateFrameworkContent).
  const bad = { ...buildFrameworkExport(FRAMEWORK_ROW), gates_json: 'not json' };
  const r = parseFrameworkImport(bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /gates_json/);
  // Missing required content is rejected.
  const missing = { ...buildFrameworkExport(FRAMEWORK_ROW), constitution_md: '' };
  assert.equal(parseFrameworkImport(missing).ok, false);
});

test('parseFrameworkImport: defaults a changelog when the document omits one', () => {
  const doc = buildFrameworkExport(FRAMEWORK_ROW);
  delete doc.changelog;
  const r = parseFrameworkImport(doc);
  assert.equal(r.ok, true);
  assert.match(r.data.changelog, /Imported framework .*v4/);
});

// ---- git connectors (ADR-006) ----

test('git provider + auth vocab', () => {
  assert.deepEqual(GIT_PROVIDERS, ['github', 'gitea', 'generic_https', 'generic_ssh']);
  assert.deepEqual(GIT_AUTH_KINDS, ['token', 'ssh_key']);
});

test('validateGitConnectorInput: gitea/generic need base_url; ssh needs ssh_key', () => {
  assert.equal(validateGitConnectorInput({ provider: 'github', auth_kind: 'token' }), null);
  assert.match(validateGitConnectorInput({ provider: 'gitea', auth_kind: 'token' }), /base URL is required/);
  assert.match(validateGitConnectorInput({ provider: 'generic_ssh', auth_kind: 'token', base_url: 'ssh://x' }), /ssh_key/);
  assert.equal(validateGitConnectorInput({ provider: 'generic_ssh', auth_kind: 'ssh_key', base_url: 'ssh://x' }), null);
});

test('gitTestPlan: token providers get an identity endpoint; ssh/generic get none', () => {
  assert.equal(gitTestPlan({ provider: 'github', auth_kind: 'token', __token: 't' }).url, 'https://api.github.com/user');
  assert.equal(gitTestPlan({ provider: 'gitea', auth_kind: 'token', base_url: 'https://g/', __token: 't' }).url, 'https://g/api/v1/user');
  assert.equal(gitTestPlan({ provider: 'generic_https', auth_kind: 'token', __token: 't' }), null);
  assert.equal(gitTestPlan({ provider: 'github', auth_kind: 'ssh_key' }), null);
});

test('interpretGitTestResponse', () => {
  assert.equal(interpretGitTestResponse(200).ok, true);
  assert.equal(interpretGitTestResponse(401).ok, false);
});

test('publicGitConnectorShape: never leaks the credential', () => {
  const row = {
    id: 1, name: 'gh', provider: 'github', base_url: null, auth_kind: 'token',
    credential_enc: 'enc:v1:aa:bb:cc', test_status: '{"ok":true}', test_at: 't', created_by: 1, created_at: 't',
  };
  const shaped = publicGitConnectorShape(row, { secretDecryptable: true });
  assert.equal(shaped.credential_enc, undefined);
  assert.equal(shaped.has_credential, true);
  assert.equal(shaped.secret_decryptable, true);
});
