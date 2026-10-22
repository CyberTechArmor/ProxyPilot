import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  assert.equal(provenance.runtime_scope, guidance.runtime_scope || 'none');
  assert.equal(provenance.git_host_operations, 'not_performed_by_seed');
  for (const file of guidance.runtime_files || []) {
    assert.ok(file.path === '.mock2/git-readiness.md' || /^\.mock2\/bin\/git-readiness(?:-[A-Za-z]+)*\.mjs$/.test(file.path));
    const actual = emitted.find(f => f.path === file.path);
    assert.ok(actual, file.path);
    assert.equal(createHash('sha256').update(actual.content).digest('hex'), file.sha256);
    assert.ok(provenance.runtime_files.some(f => f.path === file.path && f.sha256 === file.sha256));
  }
  assert.ok(!emitted.some(f => f.path.startsWith('.mock2/features/relay/')));
});

test('seeded Git readiness CLI inspects an ordinary local folder without initializing or contacting a remote', () => {
  assert.ok(guidance.runtime_files?.length, 'canonical readiness slice must be adopted');
  const root = mkdtempSync(join(tmpdir(), 'pp-seed-readiness-'));
  try {
    for (const {path, content} of mock2StandardsSeedFiles({name:'Local only'})) {
      mkdirSync(dirname(join(root,path)), {recursive:true});
      writeFileSync(join(root,path),content);
    }
    const before = readdirSync(root).sort();
    const inspected = spawnSync(process.execPath, ['.mock2/bin/git-readiness.mjs','--inspect'], {
      cwd:root, encoding:'utf8', timeout:30_000,
      env:{...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0'},
    });
    assert.equal(inspected.status,0,inspected.stderr || inspected.stdout);
    const result = JSON.parse(inspected.stdout);
    assert.equal(result.schema,'mock2-project-git-readiness@1');
    assert.deepEqual(readdirSync(root).sort(),before,'inspection must not create a repository or setup files');
    assert.ok(!readdirSync(root).includes('.git'));
    assert.equal(result.host.schema,'mock2-git-readiness@1');
  } finally { rmSync(root,{recursive:true,force:true}); }
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
