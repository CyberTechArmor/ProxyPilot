// Component library (migration 516) — PURE logic tests, stub-first (risk R9).
// Imports ONLY native-free modules (component-logic.js, runner-logic.js): the
// path/size/key rules, export/import round-trip, the runner catalog + tool
// wiring. DB access (components.js), the routes, and the container-path
// submission flow are covered by the manual checklist, not here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_COMPONENT_FILES, MAX_COMPONENT_FILE_CHARS, MAX_COMPONENT_PROMPT_CHARS,
  COMPONENT_EXPORT_FORMAT, COMPONENT_STATUSES,
  validateComponentKey, deriveComponentKey, normalizeTags, parseTagsJson,
  safeComponentPath, validateComponentFiles, parseFilesJson,
  nextComponentVersion, validateChangeReason,
  publicComponentShape, publicComponentVersionShape, publicSubmissionShape,
  buildComponentExport, parseComponentImport,
  buildComponentCatalogSection, formatComponentForModel,
} from '../mock2/component-logic.js';
import {
  RUNNER_TOOL_NAMES, buildRunnerSystemPrompt, buildRunnerClaudeMd, describeRunnerStep,
} from '../mock2/runner-logic.js';

// ---- keys + tags ----

test('validateComponentKey: accepts slugs, rejects everything else', () => {
  assert.equal(validateComponentKey('ldaps-auth').ok, true);
  assert.equal(validateComponentKey('a2').ok, true);
  assert.equal(validateComponentKey('').ok, false);
  assert.equal(validateComponentKey('x').ok, false); // too short
  assert.equal(validateComponentKey('-leading').ok, false);
  assert.equal(validateComponentKey('trailing-').ok, false);
  assert.equal(validateComponentKey('Has Caps').ok, false);
  assert.equal(validateComponentKey('a'.repeat(65)).ok, false);
});

test('deriveComponentKey: name → slug', () => {
  assert.equal(deriveComponentKey('LDAPS Connection'), 'ldaps-connection');
  assert.equal(deriveComponentKey('  Rate/Limiter v2! '), 'rate-limiter-v2');
  assert.equal(deriveComponentKey(''), '');
});

test('normalizeTags: dedupes, lowercases, caps at 12', () => {
  assert.deepEqual(normalizeTags('LDAP, auth , ldap'), ['ldap', 'auth']);
  assert.deepEqual(normalizeTags(['SSO', '', 'sso']), ['sso']);
  assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 12);
  assert.deepEqual(parseTagsJson('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseTagsJson('not json'), []);
});

// ---- files ----

test('safeComponentPath: relative only, no traversal', () => {
  assert.equal(safeComponentPath('src/lib/ldaps.ts'), 'src/lib/ldaps.ts');
  assert.equal(safeComponentPath('./src/a.ts'), 'src/a.ts');
  assert.equal(safeComponentPath('/etc/passwd'), null);
  assert.equal(safeComponentPath('../escape.ts'), null);
  assert.equal(safeComponentPath('a/../../b'), null);
  assert.equal(safeComponentPath('a//b'), null);
  assert.equal(safeComponentPath('a\\b'), null);
  assert.equal(safeComponentPath(''), null);
});

test('validateComponentFiles: normalizes, rejects dup/unsafe/oversize', () => {
  const ok = validateComponentFiles([{ path: './src/a.ts', content: 'x' }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.files, [{ path: 'src/a.ts', content: 'x' }]);

  assert.equal(validateComponentFiles([]).ok, false);
  assert.equal(validateComponentFiles([{ path: '../a', content: '' }]).ok, false);
  assert.equal(validateComponentFiles([
    { path: 'a.ts', content: '1' }, { path: './a.ts', content: '2' },
  ]).ok, false); // duplicate after normalization
  assert.equal(validateComponentFiles([{ path: 'a.ts', content: 'x'.repeat(MAX_COMPONENT_FILE_CHARS + 1) }]).ok, false);
  assert.equal(validateComponentFiles(Array.from({ length: MAX_COMPONENT_FILES + 1 }, (_, i) => ({ path: `f${i}.ts`, content: '' }))).ok, false);
  assert.equal(validateComponentFiles([{ path: 'a.ts', content: 42 }]).ok, false);
});

// ---- versioning + reasons ----

test('nextComponentVersion: monotonic, 1 when empty', () => {
  assert.equal(nextComponentVersion([]), 1);
  assert.equal(nextComponentVersion([{ version: 3 }, { version: 1 }]), 4);
});

test('validateChangeReason: required, bounded', () => {
  assert.equal(validateChangeReason('  ').ok, false);
  assert.equal(validateChangeReason('ok').ok, false); // < 3 chars
  const v = validateChangeReason('  switch to pooled connections  ');
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'switch to pooled connections');
  assert.equal(validateChangeReason('x'.repeat(2001)).ok, false);
});

// ---- shapes ----

test('publicComponentShape: metadata always, files only when asked', () => {
  const row = { id: 1, key: 'ldaps-auth', name: 'LDAPS', tags: '["auth"]', status: 'published', current_version_id: 9 };
  const version = { version: 2, files_json: '[{"path":"a.ts","content":"x"}]', usage_md: 'notes' };
  const bare = publicComponentShape(row, { currentVersion: version });
  assert.equal(bare.current_version, 2);
  assert.equal(bare.files, undefined);
  const full = publicComponentShape(row, { currentVersion: version, includeFiles: true });
  assert.deepEqual(full.files, [{ path: 'a.ts', content: 'x' }]);
  assert.equal(full.usage_md, 'notes');
  assert.equal(publicComponentShape(null), null);
});

test('publicSubmissionShape: file_count without bodies by default', () => {
  const row = {
    id: 5, project_id: 2, proposed_name: 'X', status: 'pending',
    files_json: '[{"path":"a.ts","content":"1"},{"path":"b.ts","content":"2"}]', tags: '[]',
  };
  const s = publicSubmissionShape(row);
  assert.equal(s.file_count, 2);
  assert.equal(s.files, undefined);
  assert.deepEqual(publicSubmissionShape(row, { includeFiles: true }).files.map((f) => f.path), ['a.ts', 'b.ts']);
});

// ---- export / import round trip ----

test('export → import round-trips a component', () => {
  const component = { key: 'ldaps-auth', name: 'LDAPS Auth', description: 'binds', category: 'auth', tags: '["ldap"]' };
  const version = { version: 3, usage_md: 'wire it', files_json: '[{"path":"src/ldaps.ts","content":"code"}]' };
  const doc = buildComponentExport(component, version);
  assert.equal(doc.format, COMPONENT_EXPORT_FORMAT);
  const parsed = parseComponentImport(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.key, 'ldaps-auth');
  assert.deepEqual(parsed.data.files, [{ path: 'src/ldaps.ts', content: 'code' }]);
  assert.equal(parsed.data.usage_md, 'wire it');
});

test('parseComponentImport: rejects wrong format / bad files / missing name', () => {
  assert.equal(parseComponentImport(null).ok, false);
  assert.equal(parseComponentImport({ format: 'other@9' }).ok, false);
  assert.equal(parseComponentImport({ format: COMPONENT_EXPORT_FORMAT, name: '', files: [] }).ok, false);
  assert.equal(parseComponentImport({
    format: COMPONENT_EXPORT_FORMAT, name: 'X', key: 'x-x', files: [{ path: '/abs', content: '' }],
  }).ok, false);
  // key derived from name when absent
  const derived = parseComponentImport({ format: COMPONENT_EXPORT_FORMAT, name: 'My Thing', files: [{ path: 'a.ts', content: '' }] });
  assert.equal(derived.ok, true);
  assert.equal(derived.data.key, 'my-thing');
});

// ---- runner integration ----

test('buildComponentCatalogSection: empty catalog → empty string', () => {
  assert.equal(buildComponentCatalogSection([]), '');
  assert.equal(buildComponentCatalogSection(null), '');
});

test('buildComponentCatalogSection: tool mode names get_component; files mode names the dir', () => {
  const catalog = [{ key: 'ldaps-auth', name: 'LDAPS Auth', description: 'binds', current_version: 2, tags: '["ldap"]' }];
  const tool = buildComponentCatalogSection(catalog, { access: 'tool' });
  assert.match(tool, /Component library/);
  assert.match(tool, /ldaps-auth \(v2\): LDAPS Auth — binds \[ldap\]/);
  assert.match(tool, /get_component/);
  const files = buildComponentCatalogSection(catalog, { access: 'files', dir: '.claude/components' });
  assert.match(files, /\.claude\/components\/<key>\//);
  assert.match(files, /never import from/);
  assert.doesNotMatch(files, /get_component/);
});

test('formatComponentForModel: small inline as before; over budget → full manifest, never a cutoff', () => {
  const component = { key: 'k-x', name: 'X', description: 'd' };
  const version = { version: 1, usage_md: 'notes', files_json: JSON.stringify([{ path: 'a.ts', content: 'hello' }]) };
  const out = formatComponentForModel(component, version);
  assert.match(out, /Component k-x v1/);
  assert.match(out, /## Integration notes\nnotes/);
  assert.match(out, /--- a\.ts ---\nhello/);
  assert.doesNotMatch(out, /materialize_component/); // small components unchanged

  // Over the budget: NO truncated file bodies — a manifest (path/bytes/sha256)
  // plus the directive to materialize_component, which delivers files whole.
  const huge = { version: 1, files_json: JSON.stringify([{ path: 'big.ts', content: 'x'.repeat(MAX_COMPONENT_PROMPT_CHARS + 1000) }]) };
  const manifested = formatComponentForModel(component, huge);
  assert.ok(manifested.length <= MAX_COMPONENT_PROMPT_CHARS);
  assert.doesNotMatch(manifested, /truncated/);
  assert.doesNotMatch(manifested, /xxxxxxxxxx/); // no content fragments
  assert.match(manifested, /- big\.ts \(\d+ bytes, sha256 [0-9a-f]{64}\)/);
  assert.match(manifested, /materialize_component/);

  assert.equal(formatComponentForModel(null, null), 'error: component not found');
});

test('RUNNER_TOOLS: get_component is offered and described in the step line', () => {
  assert.ok(RUNNER_TOOL_NAMES.includes('get_component'));
  assert.match(describeRunnerStep(0, [{ name: 'get_component', input: { key: 'ldaps-auth' } }]), /fetching component ldaps-auth/);
});

test('buildRunnerSystemPrompt: catalog appears only when components exist', () => {
  const bare = buildRunnerSystemPrompt({ constitution: 'C' });
  assert.doesNotMatch(bare, /Component library/);
  const withLib = buildRunnerSystemPrompt({
    constitution: 'C',
    components: [{ key: 'ldaps-auth', name: 'LDAPS Auth', current_version: 1 }],
  });
  assert.match(withLib, /Component library \(reuse before you rebuild\)/);
  assert.match(withLib, /get_component/);
});

test('buildRunnerClaudeMd: SDK variant points at materialized reference copies', () => {
  const md = buildRunnerClaudeMd({
    constitution: 'C',
    components: [{ key: 'ldaps-auth', name: 'LDAPS Auth', current_version: 1 }],
  });
  assert.match(md, /Component library \(reuse before you rebuild\)/);
  assert.match(md, /\.claude\/components\/<key>\//);
  assert.doesNotMatch(md, /get_component/);
  // and stays byte-stable when the library is empty (existing parity tests)
  assert.doesNotMatch(buildRunnerClaudeMd({ constitution: 'C' }), /Component library/);
});

test('COMPONENT_STATUSES: the three lifecycle states', () => {
  assert.deepEqual([...COMPONENT_STATUSES], ['draft', 'published', 'deprecated']);
});
