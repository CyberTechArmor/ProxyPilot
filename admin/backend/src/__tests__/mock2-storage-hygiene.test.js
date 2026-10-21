import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSeedFiles } from '../mock2/template.js';

test('the Dev Studio scaffold keeps generated test output, caches and check state out of checkpoints', () => {
  const gitignore = buildSeedFiles({ id: 1, name: 'probe' }, { webPort: 3000 }).find(f => f.path === '.gitignore').content.split('\n');
  for (const entry of ['.env', 'node_modules/', 'dist/', '*.log', 'test-results/', 'playwright-report/', 'coverage/', '.cache/', '/.mock2/cache/', '/.mock2/evidence/']) assert.ok(gitignore.includes(entry), entry);
});

test('the bare-repo seed removes its temporary worktree when a step fails', { skip: process.platform === 'win32' }, t => {
  const src = fs.readFileSync(new URL('../mock2/provision.js', import.meta.url), 'utf8');
  const fnText = src.slice(src.indexOf('function buildSeedScript'), src.indexOf('function setStatus'));
  const buildSeedScript = new Function(`return (${fnText})`)();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-trap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
  const script = buildSeedScript({ repoPath: path.join(dir, 'repos', '1.git'), projectName: 'probe' });
  assert.match(script, /WT="\$\(mktemp -d\)"\n# .*\ntrap 'rm -rf "\$WT"' EXIT/);
  // A payload that is not a tarball: the extract step fails under set -e.
  const r = spawnSync('sh', ['-c', script], { input: 'not-a-tarball', env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(tmp), [], 'the temporary worktree is gone after the failure');
});
