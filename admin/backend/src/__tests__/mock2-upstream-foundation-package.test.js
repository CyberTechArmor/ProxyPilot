// The drafted mock2-core 1.39.0 amendment package (docs/mock2/upstream/
// 2026-10-foundation/). Nothing here publishes anything; these checks keep the
// package self-consistent and in step with ProxyPilot's own foundation
// contract, and keep the seed from claiming an upstream version that does not
// exist. Pure file reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

import guidance from '../mock2/framework-seed/upstream-guidance.json' with { type: 'json' };
import { STACK } from '../mock2/foundation-contract.js';

const PKG = new URL('../../../../docs/mock2/upstream/2026-10-foundation/', import.meta.url);
const read = (p) => readFileSync(new URL(p, PKG), 'utf8');
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, PKG))).digest('hex');
const readme = read('README.md');
const registry = JSON.parse(read('files/core/cpr/stack.versions.json'));

// README file table rows: | `path` | base | result | form |
const rows = [...readme.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \| `([0-9a-f]{64})` \| ([^|]+) \|$/gm)]
  .map(([, path, base, result, form]) => ({ path, base, result, form: form.trim() }));

test('the package says it is a draft and names its base release', () => {
  assert.match(readme, /\*\*Not published\.\*\*/);
  assert.match(readme, /mock2-core 1\.38\.0 → 1\.39\.0/);
  assert.match(readme, /Base: mock2-core \*\*1\.38\.0\*\*/);
  assert.match(readme, /> 1\.39\.0: The application foundation stack\./);
  assert.match(readme, /## Order to apply/);
});

test('the file table, the patch and the full copies describe the same change', () => {
  assert.equal(rows.length, 14);
  const patch = read('mock2-core-1.39.0.patch');
  const patched = [...patch.matchAll(/^\+\+\+ b\/(\S+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(patched, rows.map((r) => r.path).sort(), 'every listed file is in the patch, and nothing else');
  assert.deepEqual([...patch.matchAll(/^--- a\/(\S+)$/gm)].map((m) => m[1]).sort(), patched);
  for (const r of rows) {
    assert.notEqual(r.base, r.result, `${r.path} must change`);
    const full = `files/${r.path}`;
    if (r.form.includes('full')) {
      assert.ok(existsSync(new URL(full, PKG)), `${full} missing`);
      assert.equal(sha(full), r.result, `${full} must be the patch result the table names`);
    } else {
      assert.ok(!existsSync(new URL(full, PKG)), `${full} is listed as diff only`);
    }
  }
});

test('stack.versions.json: pgvector is required and the foundation pins match ProxyPilot\'s contract', () => {
  const s = registry.systems;
  assert.equal(s.pgvector.optional, false);
  assert.equal(s.pgvector.image, STACK.postgres.image);
  const [pgvectorVersion, pgMajor] = STACK.postgres.image.split(':')[1].split('-pg');
  assert.equal(s.pgvector.selected, pgvectorVersion);
  assert.equal(s.postgresql.selected.split('.')[0], pgMajor);
  assert.equal(s.seaweedfs.image, STACK.storage.image);
  assert.equal(s.seaweedfs.selected, STACK.storage.image.split(':')[1]);
  assert.equal(s['text-embeddings-inference'].image, STACK.embeddings.image);
  assert.equal(`cpu-${s['text-embeddings-inference'].selected}`, STACK.embeddings.image.split(':')[1]);
  assert.equal(s['local-embedding-model'].selected, STACK.embeddings.model);
  assert.equal(s['local-embedding-model'].dimensions, STACK.embeddings.dimensions);
  assert.equal(s['openai-embeddings'].optional, true);
  assert.ok(Number.isInteger(s['openai-embeddings'].dimensions) && s['openai-embeddings'].selected);
  for (const k of ['docker-engine', 'docker-compose', 'seaweedfs', 'text-embeddings-inference', 'local-embedding-model']) {
    assert.equal(s[k].optional, false, `${k} runs or is part of the foundation stack`);
  }
  const evidence = registry.compatibility.find((c) => c.id === 'foundation-stack-2026-10-24');
  assert.equal(evidence.status, 'pending-evidence', 'no stack run is claimed');
  assert.equal(evidence.evidence, null);
});

test('Stack-Version-Table.md is the table generated from stack.versions.json', () => {
  const lines = [
    '# Selected stack baseline', '',
    `Baseline \`${registry.baselineId}\`; reviewed ${registry.reviewedOn}; next review ${registry.reviewDue}.`, '',
    'Generated from `stack.versions.json`. Exact selected versions are defaults for new PRO applications; existing stacks retain their recorded lines under the patch policy. See `Stack-Versions.md` for compatibility evidence and scope.',
    '', '| System | Selected version | Channel | Applicability |', '| --- | --- | --- | --- |',
    ...Object.entries(registry.systems).map(([name, v]) => `| ${name} | ${v.selected} | ${v.channel} | ${v.optional ? 'When used' : 'PRO baseline'} |`),
    '', '## Compatibility evidence', '',
    ...registry.compatibility.map((c) => `- \`${c.id}\`: **${c.status}**. ${c.scope}`),
  ];
  assert.equal(read('files/core/cpr/Stack-Version-Table.md'), `${lines.join('\n')}\n`);
});

test('the drafted standards text carries the new rules where the loopholes were', () => {
  const profile = read('files/core/mock2/profiles/profile-cpr.md');
  assert.match(profile, /It is the profile of every new PRO application/);
  assert.match(profile, /An agent never records\n`Profile: none`, a stack deviation or a database deviation for a new application/);
  assert.match(profile, /`DATABASE_URL` is required/);
  const ai = read('files/core/cpr/AI-Data-Standards.md');
  assert.match(ai, /## Readiness is a real operation/);
  assert.match(ai, /verified by size and sha256 on the target/);
  const patch = read('mock2-core-1.39.0.patch');
  assert.match(patch, /^\+### W\.6 The application foundation stack$/m);
  for (const entry of ['database', 'object_storage', 'embeddings', 'vector_search']) {
    assert.match(patch, new RegExp(`^\\+\\| \`${entry}\` \\|`, 'm'), `catalog entry ${entry}`);
  }
  assert.match(patch, /^\+\*Narrowed in 1\.39\.0:\* SQLite is refused for any server role/m);
  assert.match(patch, /^\+if\(!\/\^postgres\(\?:ql\)\?:/m, 'server.ts.tpl refuses a non-PostgreSQL DATABASE_URL');
});

test('standards-version.json never claims an upstream version that does not exist', () => {
  const sv = JSON.parse(readFileSync(new URL('../mock2/framework-seed/standards-version.json', import.meta.url), 'utf8'));
  assert.equal(sv.version, guidance.version, 'version is the pinned upstream release');
  assert.equal(sv.source_version, guidance.version);
  const amendment = sv.local_amendments.find((a) => a.id === 'proxypilot-app-foundation-2026-10-24');
  assert.ok(amendment, 'the local amendment is recorded');
  assert.equal(amendment.proposed_upstream.to, '1.39.0');
  assert.equal(amendment.proposed_upstream.status, 'drafted-not-published');
  assert.notEqual(sv.version, amendment.proposed_upstream.to);
  assert.ok(existsSync(new URL(`../../../../${amendment.package}`, import.meta.url)), amendment.package);
});
