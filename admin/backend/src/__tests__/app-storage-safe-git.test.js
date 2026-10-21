// Git over a repository the application's service user can write (review
// HIGH 3, cleanup side): the repository's own fsmonitor/hooks never run, and
// git runs as the repository's owner when that is not root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp, { execFileSync, spawnSync } from 'node:child_process';
import { safeGit, SAFE_GIT_SOURCE } from '../lib/setup-engine/safe-git.js';
import { applicationGuestScript } from '../lib/setup-engine/application-deploy-op.js';

const skip = process.platform !== 'linux' || (typeof process.getuid === 'function' && process.getuid() !== 0) || spawnSync('git', ['--version']).status !== 0;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
function repo(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-safe-git-')); fs.chmodSync(parent, 0o755);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'repo'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'app.js'), 'x\n'); fs.writeFileSync(path.join(dir, '.gitignore'), 'test-results/\n');
  execFileSync('git', ['init', '-q', dir]); git(dir, 'add', '.');
  git(dir, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'f');
  const marker = path.join(parent, 'PWNED');
  // What a compromised service user plants: config that runs a command.
  git(dir, 'config', 'core.fsmonitor', `touch ${marker}; echo`);
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  return { parent, dir, marker };
}

test('the repository fsmonitor never runs through safeGit (ls-files, status), while plain git as root runs it', { skip }, t => {
  const { dir, marker } = repo(t);
  for (const args of [['ls-files', '--', 'test-results'], ['status', '--porcelain', '--untracked-files=no'], ['rev-parse', 'HEAD']]) {
    const r = safeGit(cp, fs, dir, args); assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(fs.existsSync(marker), false, 'no marker: the planted command did not run');
  spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(fs.existsSync(marker), true, 'the same repository does run it under plain git (the proof the plant works)');
  assert.match(SAFE_GIT_SOURCE, /core\.fsmonitor=false/); assert.doesNotMatch(SAFE_GIT_SOURCE, /safe\.directory/);
});

test('git runs as the repository owner when that is not root (no safe.directory widening); a linked work tree is refused', { skip }, t => {
  const { parent, dir } = repo(t);
  execFileSync('chown', ['-R', '65534:65534', dir]);
  const plain = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.notEqual(plain.status, 0, 'root refuses a repository owned by someone else (dubious ownership)');
  const r = safeGit(cp, fs, dir, ['rev-parse', 'HEAD']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^[a-f0-9]{40}/);
  const who = safeGit(cp, fs, dir, ['config', '--get', 'core.fsmonitor']);
  assert.equal(who.status, 0);
  fs.symlinkSync(dir, path.join(parent, 'link'));
  const linked = safeGit(cp, fs, path.join(parent, 'link'), ['rev-parse', 'HEAD']);
  assert.equal(linked.status, 1); assert.equal(linked.unsafe, true);
});

test('sealing with trimBeforeSeal over a repository with a planted fsmonitor never runs it', { skip }, t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-safe-seal-')); fs.chmodSync(parent, 0o755);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'releases'); fs.mkdirSync(path.join(root, '.staging'), { recursive: true }); fs.chmodSync(root, 0o755);
  const stage = path.join(root, '.staging', '11111111-1111-4111-8111-111111111111-1'); fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'app.js'), 'x\n'); fs.writeFileSync(path.join(stage, '.gitignore'), 'test-results/\n');
  execFileSync('git', ['init', '-q', stage]); git(stage, 'add', '.');
  git(stage, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'f');
  const marker = path.join(parent, 'PWNED');
  git(stage, 'config', 'core.fsmonitor', `touch ${marker}; echo`);
  fs.mkdirSync(path.join(stage, 'test-results')); fs.writeFileSync(path.join(stage, 'test-results', 'shot.png'), 'x');
  const sha = git(stage, 'rev-parse', 'HEAD'), treeSha = git(stage, 'rev-parse', 'HEAD^{tree}');
  assert.equal(fs.existsSync(marker), false);
  const release = path.join(root, `${sha}-p1-11111111-1111-4111-8111-111111111111`);
  const sealed = spawnSync('sh', ['-c', applicationGuestScript({ action: 'seal', profile: { sourceDir: path.join(parent, 'current'), releaseRoot: root, preservePaths: [], envFiles: [] }, retention: { trimBeforeSeal: ['test-results'] }, stage, release, sha, treeSha, marker: { sha, treeSha, profileDigest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64) } })], { encoding: 'utf8' });
  assert.equal(JSON.parse(sealed.stdout).ok, true, sealed.stdout);
  assert.deepEqual(JSON.parse(sealed.stdout).trim.removed, ['test-results']);
  assert.equal(fs.existsSync(marker), false, 'the planted fsmonitor never ran as root during the seal');
});
