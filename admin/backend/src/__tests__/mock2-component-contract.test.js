// Component CONTRACTS + define-time selection + deterministic install plans
// (migration 524) — PURE logic tests, stub-first (risk R9). Imports ONLY
// native-free modules; the DB half (components.js), the container installer
// (component-install.js), and the audit orchestration are covered by the
// integration checklist, not here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  validateComponentContract, parseContractJson, normalizeCapability,
  parseComponentImport, buildComponentExport,
  extractCapabilities, suggestComponentsForCapabilities,
  buildComponentSuggestionQuestion, parseComponentSuggestionAnswer,
  COMPONENT_SUGGESTION_ACCEPT, COMPONENT_SUGGESTION_DECLINE,
  planMigrationRenumber, mergeEnvDefaults, manifestEntryFromConnection,
  deriveComponentSubsystem, buildComponentsStateDoc, buildInstalledComponentsSection,
  publicProjectComponentShape, COMPONENTS_STATE_PATH,
} from '../mock2/component-logic.js';
import { parseIntegrationManifest } from '../mock2/integration-logic.js';
import { buildRunnerSystemPrompt, buildRunnerClaudeMd, buildCompletionSummaryBody } from '../mock2/runner-logic.js';
import { parseInventory } from '../mock2/concept-logic.js';

const FULL_CONTRACT = {
  provides: ['auth', 'auth.bootstrap-superadmin', 'rbac'],
  requires_when: { capabilities_any: ['users', 'login'], suggest_prompt: 'Use the standard auth?' },
  api: [
    { method: 'get', path: '/api/auth/bootstrap/status', summary: 'first-run flag', auth: 'public' },
    { method: 'POST', path: '/api/auth/login', summary: 'sign in', auth: 'public' },
    { method: 'GET', path: '/api/admin/users', summary: 'user admin', auth: 'role:admin' },
  ],
  exports: ['initAuth', 'requireRole'],
  config: [
    { key: 'AUTH_JWT_SECRET', secret: true, required: true, description: 'signing key' },
    { key: 'ACCESS_TOKEN_TTL_SECONDS', default: '900' },
  ],
  connections: [
    { id: 'ldaps-directory', transport: 'ldaps', optional: true, egress: { classification: 'private', port: 636, protocol: 'tcp' }, config_keys: ['LDAPS_TRANSPORT'], live_verification: { required: true } },
  ],
  dependencies: { runtime: ['cookie', 'ldapts', 'zod'], peers: ['express'], dev: ['vitest'] },
  migrations: { dir: 'migrations', renumber: 'append' },
};

// ---- contract validation ----

test('validateComponentContract: null/absent is fine, full contract normalizes', () => {
  assert.deepEqual(validateComponentContract(null), { ok: true, contract: null });
  assert.deepEqual(validateComponentContract(undefined), { ok: true, contract: null });
  const r = validateComponentContract(FULL_CONTRACT);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.contract.provides, ['auth', 'auth.bootstrap-superadmin', 'rbac']);
  assert.equal(r.contract.api[0].method, 'GET'); // upcased
  assert.equal(r.contract.api[0].auth, 'public');
  assert.equal(r.contract.connections[0].egress.port, 636);
  assert.equal(r.contract.migrations.renumber, 'append');
});

test('validateComponentContract: rejects the malformed', () => {
  assert.equal(validateComponentContract([]).ok, false);
  assert.equal(validateComponentContract({ provides: ['Not A Slug!'] }).ok, false);
  assert.equal(validateComponentContract({ api: [{ method: 'FETCH', path: '/x' }] }).ok, false);
  assert.equal(validateComponentContract({ api: [{ method: 'GET', path: 'no-slash' }] }).ok, false);
  assert.equal(validateComponentContract({ config: [{ key: '1BAD' }] }).ok, false);
  assert.equal(validateComponentContract({ config: [{ key: 'A' }, { key: 'A' }] }).ok, false);
  assert.equal(validateComponentContract({ connections: [{ id: 'x y' }] }).ok, false);
  assert.equal(validateComponentContract({ connections: [{ id: 'ok', egress: { classification: 'wild' } }] }).ok, false);
  assert.equal(validateComponentContract({ migrations: { dir: '../etc' } }).ok, false);
});

test('normalizeCapability: slugs only', () => {
  assert.equal(normalizeCapability('Users'), 'users');
  assert.equal(normalizeCapability('auth.ldaps'), 'auth.ldaps');
  assert.equal(normalizeCapability('has space'), null);
  assert.equal(normalizeCapability(''), null);
});

test('parseContractJson: tolerant of junk', () => {
  assert.equal(parseContractJson('not json'), null);
  assert.equal(parseContractJson(null), null);
  const c = parseContractJson(JSON.stringify(FULL_CONTRACT));
  assert.equal(c.api.length, 3);
});

// ---- import/export round-trip with a contract ----

test('parseComponentImport carries a valid contract and rejects a bad one', () => {
  const doc = {
    format: 'proxypilot-component@1', key: 'auth-x', name: 'Auth X',
    contract: FULL_CONTRACT, files: [{ path: 'src/auth/index.ts', content: 'x' }],
  };
  const r = parseComponentImport(doc);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.contract.dependencies.runtime, ['cookie', 'ldapts', 'zod']);

  const bad = parseComponentImport({ ...doc, contract: { api: [{ method: 'NOPE', path: '/x' }] } });
  assert.equal(bad.ok, false);
});

test('buildComponentExport round-trips the contract through import', () => {
  const component = { key: 'auth-x', name: 'Auth X', description: null, category: 'auth', tags: '[]' };
  const version = {
    version: 3, usage_md: 'notes',
    files_json: JSON.stringify([{ path: 'src/a.ts', content: 'x' }]),
    contract_json: JSON.stringify(validateComponentContract(FULL_CONTRACT).contract),
  };
  const doc = buildComponentExport(component, version);
  assert.equal(doc.contract.api.length, 3);
  const back = parseComponentImport(doc);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(back.data.contract, doc.contract);
});

// ---- capabilities + suggestion matching ----

test('extractCapabilities: array and object forms, junk dropped', () => {
  assert.deepEqual(extractCapabilities({ required_capabilities: ['users', 'Users', 'no way'] }), ['users']);
  assert.deepEqual(
    extractCapabilities({ required_capabilities: { users: true, roles: ['admin-stuff'], notifications: false } }),
    ['users', 'roles', 'admin-stuff'],
  );
  assert.deepEqual(extractCapabilities({}), []);
  assert.deepEqual(extractCapabilities(null), []);
});

test('parseInventory normalizes required_capabilities', () => {
  const r = parseInventory(JSON.stringify({
    screens: [{ name: 'Home' }],
    required_capabilities: ['Users', 'users', 'LDAP', 'bad slug!'],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.inventory.required_capabilities, ['users', 'ldap']);
});

test('suggestComponentsForCapabilities: matches contracts, skips decided and contract-less', () => {
  const catalog = [
    { key: 'proxypilot-auth', name: 'Auth', contract: { requires_when: { capabilities_any: ['users', 'login'], suggest_prompt: 'Use auth?' } } },
    { key: 'no-contract', name: 'Plain' },
    { key: 'files-store', name: 'Files', contract: { requires_when: { capabilities_any: ['files'] } } },
  ];
  const out = suggestComponentsForCapabilities(catalog, ['users'], new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'proxypilot-auth');
  assert.deepEqual(out[0].matched, ['users']);
  // Already decided (confirmed OR declined) never re-suggests.
  assert.equal(suggestComponentsForCapabilities(catalog, ['users'], new Set(['proxypilot-auth'])).length, 0);
  assert.equal(suggestComponentsForCapabilities(catalog, [], new Set()).length, 0);
});

test('component suggestion question + answer parse: ambiguous answers DECLINE', () => {
  const q = buildComponentSuggestionQuestion({ key: 'proxypilot-auth', name: 'Auth', suggest_prompt: 'Use the standard auth component?' });
  assert.equal(q.question, 'Use the standard auth component?');
  assert.deepEqual(q.choices, [COMPONENT_SUGGESTION_ACCEPT, COMPONENT_SUGGESTION_DECLINE]);
  assert.equal(parseComponentSuggestionAnswer(COMPONENT_SUGGESTION_ACCEPT).decision, 'confirmed');
  assert.equal(parseComponentSuggestionAnswer('yes please').decision, 'confirmed');
  assert.equal(parseComponentSuggestionAnswer(COMPONENT_SUGGESTION_DECLINE).decision, 'declined');
  assert.equal(parseComponentSuggestionAnswer('hmm, tell me more').decision, 'declined');
  assert.equal(parseComponentSuggestionAnswer('').decision, 'declined');
});

// ---- deterministic install plans ----

test('planMigrationRenumber: appends after existing, skips same-suffix, honors none', () => {
  const files = [
    { path: 'migrations/0001_auth.sql', content: 'CREATE TABLE users;' },
    { path: 'migrations/0002_audit.sql', content: 'CREATE TABLE audit;' },
    { path: 'src/auth/index.ts', content: 'code' },
  ];
  const plan = planMigrationRenumber(files, ['0001_init.sql', '0002_core.sql', '0003_adp.sql'], { dir: 'migrations', renumber: 'append' });
  assert.deepEqual(plan.renames.map((r) => [r.from, r.to]), [
    ['migrations/0001_auth.sql', 'migrations/0004_auth.sql'],
    ['migrations/0002_audit.sql', 'migrations/0005_audit.sql'],
  ]);
  assert.equal(plan.migrationPaths.has('src/auth/index.ts'), false);
  assert.equal(plan.migrationPaths.has('migrations/0001_auth.sql'), true);

  // A same-suffix migration already present (earlier install) is skipped.
  const again = planMigrationRenumber(files, ['0001_init.sql', '0004_auth.sql'], { dir: 'migrations', renumber: 'append' });
  assert.deepEqual(again.skipped, ['migrations/0001_auth.sql']);
  assert.deepEqual(again.renames.map((r) => r.to), ['migrations/0005_audit.sql']);

  const none = planMigrationRenumber(files, ['0001_init.sql'], { dir: 'migrations', renumber: 'none' });
  assert.equal(none.renames.length, 0);
  assert.equal(none.migrationPaths.size, 2);
});

test('mergeEnvDefaults: adds only missing non-secret defaults, never secrets', () => {
  const config = [
    { key: 'AUTH_JWT_SECRET', secret: true, default: 'nope' },
    { key: 'ACCESS_TOKEN_TTL_SECONDS', default: '900' },
    { key: 'ALREADY_SET', default: 'x' },
    { key: 'NO_DEFAULT' },
  ];
  const r = mergeEnvDefaults('ALREADY_SET=1\n', config);
  assert.deepEqual(r.added, ['ACCESS_TOKEN_TTL_SECONDS']);
  assert.match(r.text, /ACCESS_TOKEN_TTL_SECONDS=900/);
  assert.doesNotMatch(r.text, /AUTH_JWT_SECRET/);
  assert.match(r.text, /^ALREADY_SET=1/);
  // Nothing to add → text unchanged (no write needed).
  const noop = mergeEnvDefaults('ACCESS_TOKEN_TTL_SECONDS=900\nALREADY_SET=1\n', config);
  assert.deepEqual(noop.added, []);
});

test('manifestEntryFromConnection produces a manifest entry the gate validates', () => {
  const contract = validateComponentContract(FULL_CONTRACT).contract;
  const entry = manifestEntryFromConnection({ componentKey: 'proxypilot-auth', connection: contract.connections[0], subsystem: 'auth' });
  const manifest = parseIntegrationManifest(JSON.stringify({ schema_version: 1, entries: [entry] }));
  assert.equal(manifest.ok, true, manifest.error);
  assert.equal(entry.id, 'proxypilot-auth-ldaps-directory');
  assert.equal(entry.subsystem, 'auth');
  assert.equal(entry.transport, 'ldaps');
  assert.equal(entry.egress.classification, 'private');
  assert.equal(entry.live_verification.required, true);
});

test('deriveComponentSubsystem: first src/* wins, fallback otherwise', () => {
  assert.equal(deriveComponentSubsystem([{ path: 'migrations/0001.sql' }, { path: 'src/auth/repo.ts' }]), 'auth');
  assert.equal(deriveComponentSubsystem([{ path: 'public/login.html' }], 'proxypilot-auth'), 'proxypilot-auth');
});

// ---- state doc + prompt sections + shapes ----

test('buildComponentsStateDoc: stable committed artifact', () => {
  assert.equal(COMPONENTS_STATE_PATH, 'state/components.json');
  const doc = JSON.parse(buildComponentsStateDoc([
    { key: 'proxypilot-auth', version: 3, status: 'installed', origin: 'define', options: { answer: 'Use the standard component' }, api: [{ method: 'GET', path: '/api/auth/bootstrap/status' }], installed_at: 't' },
  ]));
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.entries[0].key, 'proxypilot-auth');
  assert.equal(doc.entries[0].api.length, 1);
});

test('buildInstalledComponentsSection: wiring contract in, empty out', () => {
  assert.equal(buildInstalledComponentsSection([]), '');
  const s = buildInstalledComponentsSection([
    { key: 'proxypilot-auth', name: 'ProxyPilot Auth', version: 3, contract: validateComponentContract(FULL_CONTRACT).contract },
  ]);
  assert.match(s, /# Installed components/);
  assert.match(s, /wire, don't rebuild/i);
  assert.match(s, /GET \/api\/auth\/bootstrap\/status \[public\]/);
  assert.match(s, /Secrets the operator supplies.*AUTH_JWT_SECRET/);
  assert.match(s, /do NOT re-materialize/i);
});

test('runner prompts carry the installed section and it precedes the catalog', () => {
  const installed = [{ key: 'proxypilot-auth', name: 'Auth', version: 3, contract: validateComponentContract(FULL_CONTRACT).contract }];
  const catalog = [{ key: 'files-store', name: 'Files', current_version: 1, tags: '[]' }];
  const sys = buildRunnerSystemPrompt({ constitution: 'C', components: catalog, installedComponents: installed });
  assert.match(sys, /# Installed components/);
  assert.match(sys, /# Component library/);
  assert.ok(sys.indexOf('# Installed components') < sys.indexOf('# Component library'));
  const md = buildRunnerClaudeMd({ constitution: 'C', components: catalog, installedComponents: installed });
  assert.match(md, /## Installed components/);
});

test('publicProjectComponentShape: client-safe, contract summarized', () => {
  const shape = publicProjectComponentShape({
    id: 5, project_id: 8, component_id: 2, key: 'proxypilot-auth', name: 'Auth',
    status: 'installed', origin: 'define', pinned_version: 3,
    options_json: '{"answer":"Use the standard component"}', question_id: 12,
    decided_at: 'd', installed_at: 'i', install_error: null,
    install_manifest_json: JSON.stringify([{ path: 'a', bytes: 1, sha256: 'x' }]),
    contract_json: JSON.stringify(validateComponentContract(FULL_CONTRACT).contract),
  });
  assert.equal(shape.key, 'proxypilot-auth');
  assert.equal(shape.version, 3);
  assert.equal(shape.files_installed, 1);
  assert.deepEqual(shape.provides, ['auth', 'auth.bootstrap-superadmin', 'rbac']);
  assert.equal(shape.api_count, 3);
  assert.equal(shape.options.answer, 'Use the standard component');
});

// ---- the completion review summary (posted into the build chat) ----

test('buildCompletionSummaryBody: deployed success with summary + files', () => {
  const body = buildCompletionSummaryBody({
    summary: 'Added the login page and wired it to the auth component.',
    changedFiles: ['src/app.ts', 'src/auth-wiring.ts', 'public/login.css'],
    deployed: { ok: true },
  });
  assert.match(body, /^Build complete — deployed and live/);
  assert.match(body, /What was done:\nAdded the login page/);
  assert.match(body, /Files changed \(3\):/);
  assert.match(body, /- src\/app\.ts/);
  assert.match(body, /Change history/);
  assert.doesNotMatch(body, /Verify live/);
});

test('buildCompletionSummaryBody: no-op, checkpoint-only, and file overflow', () => {
  assert.match(buildCompletionSummaryBody({ deployed: { ok: true, skipped: true, noop: true } }), /nothing needed changing/);
  assert.match(buildCompletionSummaryBody({ deployed: { ok: true, skipped: true } }), /checkpointed into the repo/);
  const many = buildCompletionSummaryBody({ changedFiles: Array.from({ length: 20 }, (_, i) => `f${i}.ts`), deployed: { ok: true } });
  assert.match(many, /Files changed \(20\):/);
  assert.match(many, /… and 5 more/);
});

test('buildCompletionSummaryBody: pending live verification lists the checks', () => {
  const body = buildCompletionSummaryBody({
    summary: 'LDAPS transport implemented.',
    changedFiles: ['src/auth/ldap.ts'],
    deployed: { ok: true },
    pendingChecklist: [{ item_id: 'ldaps-bind', description: 'Bind against the production directory' }],
  });
  assert.match(body, /1 live verification left/);
  assert.match(body, /Verify live when ready/);
  assert.match(body, /Bind against the production directory/);
});

// ---- the shipped example: bootstrap must be there ----

test('proxypilot-auth example imports cleanly with a bootstrap-bearing contract', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.join(here, '../../../../docs/features/examples/proxypilot-auth.component.json');
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  const r = parseComponentImport(doc);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.key, 'proxypilot-auth');
  const c = r.data.contract;
  assert.ok(c, 'contract present');
  assert.ok(c.provides.includes('auth.bootstrap-superadmin'), 'bootstrap capability declared');
  assert.ok(c.api.some((a) => a.path === '/api/auth/bootstrap/superadmin' && a.method === 'POST'), 'bootstrap endpoint declared');
  assert.ok(c.api.some((a) => a.path === '/api/auth/bootstrap/status'), 'bootstrap status endpoint declared');
  assert.ok(r.data.files.some((f) => f.path === 'public/login.html'), 'first-run login page shipped');
  assert.ok(r.data.files.some((f) => f.path === 'scripts/bootstrap-superadmin.mjs'), 'bootstrap CLI shipped');
  assert.ok(c.requires_when.capabilities_any.includes('users'), 'suggested whenever the app has users');
  assert.equal(c.connections[0].id, 'ldaps-directory');
});
