// Component materialization — PURE logic tests, stub-first (risk R9).
//
// The defect these guard against: a build could only reach a component's
// source through the get_component tool result, truncated at the prompt
// budget (and again at the runner's tool-result cap) — large components were
// served cut off mid-file and existed nowhere on disk. Delivery now goes
// server-side (materialize_component writes files into the app source over
// the write_file channel), and these tests pin the contract: complete,
// byte-exact, and NEVER silently truncated.
//
// Imports ONLY native-free modules (component-logic.js, runner-logic.js).
// The container half (writeFileInContainer/containerSh) is the same proven
// channel every other runner write uses; its script halves are tested here
// as strings and exercised for real against a local directory by `sh` when
// available (skipped otherwise — shape assertions still run).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MAX_COMPONENT_PROMPT_CHARS,
  parseComponentImport, buildComponentExport, parseFilesJson,
  sha256Hex, buildComponentManifest, formatManifestLines,
  formatComponentForModel, formatMaterializeResult,
  buildPathsExistScript, parsePathsExistOutput,
  buildManifestVerifyScript, parseShaVerifyOutput,
  buildComponentCatalogSection,
} from '../mock2/component-logic.js';
import { RUNNER_TOOL_NAMES, describeRunnerStep } from '../mock2/runner-logic.js';

// ---- fixture: a proxypilot-auth-shaped component (27 files, ~142KB) ----
//
// Deterministic content, realistic paths, one security-sensitive migration —
// the exact shape that used to be served truncated after the first file.

function bigComponentFiles() {
  const files = [];
  const mk = (path, seed, chars) => {
    let s = `// ${path} — seed ${seed}\n`;
    while (s.length < chars) s += `const ${seed}_${s.length} = "${seed}"; // ${'.'.repeat(37)}\n`;
    files.push({ path, content: s });
  };
  const sqlHeader = '-- 0001_auth.sql — roles, users, sessions, ldaps_settings\nCREATE TABLE auth_users (id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL);\n';
  files.push({ path: 'migrations/0001_auth.sql', content: sqlHeader + '-- pad\n'.repeat(1200) });
  for (let i = 0; i < 22; i += 1) mk(`src/lib/auth/mod${String(i).padStart(2, '0')}.ts`, `m${i}`, 5500);
  mk('public/login.html', 'html', 4000);
  mk('public/login.js', 'js', 4000);
  mk('src/index.ts', 'barrel', 3000);
  mk('README-usage.md', 'usage', 2000);
  return files;
}

const FIXTURE = bigComponentFiles();
const FIXTURE_TOTAL = FIXTURE.reduce((n, f) => n + f.content.length, 0);

test('fixture matches the failing shape: 27 files, ~142KB, well over the 60k budget', () => {
  assert.equal(FIXTURE.length, 27);
  assert.ok(FIXTURE_TOTAL > 130_000 && FIXTURE_TOTAL < 200_000, `total ${FIXTURE_TOTAL}`);
  assert.ok(FIXTURE_TOTAL > MAX_COMPONENT_PROMPT_CHARS * 2);
});

// ---- manifest ----

test('sha256Hex + buildComponentManifest: correct hashes and byte sizes', () => {
  // known vector
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const manifest = buildComponentManifest([{ path: 'a.ts', content: 'héllo' }]);
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].bytes, Buffer.byteLength('héllo', 'utf8')); // multibyte counted as bytes
  assert.equal(manifest[0].sha256, createHash('sha256').update('héllo', 'utf8').digest('hex'));
  assert.match(formatManifestLines(manifest), /- a\.ts \(6 bytes, sha256 [0-9a-f]{64}\)/);
});

// ---- import → retrieval integrity (the 600k ceiling is the ONLY limit) ----

test('round-trip: a 27-file 142KB component imports and every file survives byte-exact', () => {
  const doc = {
    format: 'proxypilot-component@1',
    key: 'proxypilot-auth', name: 'ProxyPilot Auth',
    usage_md: '# notes', files: FIXTURE,
  };
  const parsed = parseComponentImport(doc);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.data.files.length, 27);
  // byte-for-byte: the manifest of what import stored equals the manifest of
  // the originals, file by file (path, bytes, sha256)
  const before = buildComponentManifest(FIXTURE);
  const after = buildComponentManifest(parsed.data.files);
  assert.deepEqual(after, before);
  // the migration specifically — the file that used to be unreachable
  const mig = parsed.data.files.find((f) => f.path === 'migrations/0001_auth.sql');
  assert.equal(mig.content, FIXTURE[0].content);

  // and through export (what a version row serves back to the runner)
  const exported = buildComponentExport(
    { key: 'proxypilot-auth', name: 'ProxyPilot Auth', tags: '[]' },
    { version: 1, usage_md: '# notes', files_json: JSON.stringify(parsed.data.files) },
  );
  assert.deepEqual(buildComponentManifest(exported.files), before);
});

// ---- get_component: no silent truncation, ever ----

test('get_component over budget: full manifest for ALL 27 files, zero content, explicit hand-off', () => {
  const component = { key: 'proxypilot-auth', name: 'ProxyPilot Auth', description: 'auth' };
  const version = { version: 1, usage_md: '# notes', files_json: JSON.stringify(FIXTURE) };
  const out = formatComponentForModel(component, version);
  assert.ok(out.length < MAX_COMPONENT_PROMPT_CHARS, `manifest mode must be small, got ${out.length}`);
  assert.doesNotMatch(out, /…\[truncated/);
  for (const f of FIXTURE) assert.ok(out.includes(`- ${f.path} (`), `manifest missing ${f.path}`);
  assert.ok(out.includes(sha256Hex(FIXTURE[0].content)), 'migration sha missing');
  assert.ok(!out.includes('CREATE TABLE auth_users'), 'file contents must not leak into manifest mode');
  assert.match(out, /materialize_component/);
  assert.match(out, /## Integration notes\n# notes/); // usage_md still delivered
});

test('regression at the old 60k boundary: just-under is inline in full, just-over flips to manifest', () => {
  const component = { key: 'k', name: 'K' };
  const render = (content) => formatComponentForModel(component, { version: 1, files_json: JSON.stringify([{ path: 'a.ts', content }]) });
  // just under: the ENTIRE file is inline, no marker of any kind
  const underContent = 'u'.repeat(MAX_COMPONENT_PROMPT_CHARS - 200);
  const under = render(underContent);
  assert.ok(under.includes(underContent), 'under-budget content must be complete');
  assert.doesNotMatch(under, /materialize_component|truncated/);
  // just over: no partial content — manifest mode with the full byte count
  const overContent = 'o'.repeat(MAX_COMPONENT_PROMPT_CHARS + 200);
  const over = render(overContent);
  assert.ok(!over.includes('ooooooooo'), 'over-budget content must not be partially inlined');
  assert.ok(over.includes(`(${overContent.length} bytes`), 'manifest must state the full size');
  assert.match(over, /materialize_component/);
});

// ---- the materialization scripts (string halves + real sh round-trip) ----

test('exist/verify scripts: base64-armored paths, parsers round-trip', () => {
  const paths = ['src/a b.ts', 'migrations/0001_auth.sql'];
  const exist = buildPathsExistScript(paths, { appDir: '/srv/app' });
  const verify = buildManifestVerifyScript(paths, { appDir: '/srv/app' });
  for (const p of paths) {
    const b = Buffer.from(p, 'utf8').toString('base64');
    assert.ok(exist.includes(b), `exist script missing b64 of ${p}`);
    assert.ok(verify.includes(b), `verify script missing b64 of ${p}`);
    assert.ok(!exist.includes(`"${p}"`) || p.includes(' ') === false, 'raw path must not be quoted into the script');
  }
  assert.deepEqual([...parsePathsExistOutput('EXISTS src/a b.ts\nABSENT migrations/0001_auth.sql\n')], ['src/a b.ts']);
  const shas = parseShaVerifyOutput(`${'a'.repeat(64)}  src/a b.ts\nMISSING  gone.ts\n`);
  assert.equal(shas.get('src/a b.ts'), 'a'.repeat(64));
  assert.equal(shas.get('gone.ts'), null);
});

test('sh round-trip: write fixture to disk, exist + sha256 scripts agree with the manifest', (t) => {
  try { execFileSync('sh', ['-c', 'command -v sha256sum']); } catch { t.skip('sh/sha256sum unavailable'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'mock2-mat-'));
  try {
    // materialize server-side = write each file at its path (what
    // writeFileInContainer does through incus; plain fs here)
    for (const f of FIXTURE) {
      mkdirSync(join(dir, dirname(f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content, 'utf8');
    }
    const paths = FIXTURE.map((f) => f.path);
    const existOut = execFileSync('sh', ['-c', buildPathsExistScript(paths, { appDir: dir })], { encoding: 'utf8' });
    assert.equal(parsePathsExistOutput(existOut).size, 27, 'all 27 files must exist');
    const verifyOut = execFileSync('sh', ['-c', buildManifestVerifyScript(paths, { appDir: dir })], { encoding: 'utf8' });
    const shas = parseShaVerifyOutput(verifyOut);
    for (const m of buildComponentManifest(FIXTURE)) {
      assert.equal(shas.get(m.path), m.sha256, `${m.path} must land byte-exact`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the tool result + wiring ----

test('formatMaterializeResult: statuses and hashes, never contents', () => {
  const component = { key: 'proxypilot-auth', name: 'ProxyPilot Auth' };
  const version = { version: 2 };
  const manifest = buildComponentManifest(FIXTURE);
  const statuses = Object.fromEntries(manifest.map((m, i) => [m.path, i === 0 ? 'kept' : i === 1 ? 'verify failed' : 'written']));
  const out = formatMaterializeResult({ component, version, manifest, statuses });
  assert.match(out, /Materialized component proxypilot-auth v2/);
  assert.match(out, /25 written, 1 kept .*, 1 failed/);
  assert.match(out, /\[kept\] migrations\/0001_auth\.sql/);
  assert.match(out, /WARNING: 1 file\(s\) did not land intact/);
  assert.match(out, /Do NOT reconstruct their contents from memory/);
  assert.ok(!out.includes('CREATE TABLE auth_users'), 'contents must never appear in the result');
});

test('runner wiring: materialize_component is offered, described, and named in the tool-mode catalog', () => {
  assert.ok(RUNNER_TOOL_NAMES.includes('materialize_component'));
  assert.ok(RUNNER_TOOL_NAMES.includes('get_component')); // backward compatible
  assert.match(describeRunnerStep(0, [{ name: 'materialize_component', input: { key: 'proxypilot-auth' } }]), /materializing component proxypilot-auth/);
  const section = buildComponentCatalogSection([{ key: 'proxypilot-auth', name: 'A', current_version: 1 }], { access: 'tool' });
  assert.match(section, /materialize_component/);
  assert.match(section, /get_component/);
});
