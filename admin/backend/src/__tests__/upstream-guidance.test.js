import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import guidance from '../mock2/framework-seed/upstream-guidance.json' with { type: 'json' };
import { mock2StandardsSeedFiles } from '../mock2/template.js';

test('new project guidance is byte-identical to the pinned source, with unique safe paths', () => {
  const emitted = mock2StandardsSeedFiles({ name: 'Example' });
  assert.equal(new Set(emitted.map(f => f.path)).size, emitted.length);
  for (const file of guidance.files) {
    assert.ok(file.path === '.mock2/capacity.md' || file.path.startsWith('.mock2/standards/'));
    assert.ok(!file.path.split('/').includes('..'));
    const actual = emitted.find(f => f.path === file.path);
    assert.ok(actual, file.path);
    assert.equal(createHash('sha256').update(actual.content).digest('hex'), file.sha256, file.path);
  }
  assert.equal(emitted.find(f => f.path === '.mock2/standards/VERSION').content.trim(), guidance.version);
  const provenance = JSON.parse(emitted.find(f => f.path.endsWith('/PROVENANCE.json')).content);
  assert.equal(provenance.scope, 'guidance');
  assert.equal(provenance.relay_runtime, 'not_installed_by_guidance_seed');
  assert.ok(!emitted.some(f => f.path.startsWith('.mock2/features/relay/')));
});

test('running framework instructions contain the pinned constitution while retaining platform boundaries', () => {
  const text = readFileSync(new URL('../mock2/framework-seed/constitution.md', import.meta.url), 'utf8');
  const canonical = guidance.files.find(f => f.path === '.mock2/standards/constitution.md');
  assert.ok(text.includes(canonical.content));
  assert.match(text, /## 7a\. No silent simulation/);
  assert.match(text, /concrete identity, authorization, private-data and execution contracts remain binding/);
  for (const path of ['Universal-Integration-New-App-Prompt.md', 'Universal-Integration-Existing-App-Prompt.md', 'Relay-Recording.md', 'stack.versions.json']) {
    assert.ok(guidance.files.some(f => f.path.endsWith('/' + path)), path);
  }
});
