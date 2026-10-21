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
  assert.match(SAFE_GIT_SOURCE, /core\.fsmonitor=false/); assert.equal(SAFE_GIT_SOURCE.includes('safe.directory=*'), false, 'never widened to every directory');
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

// A planted clean filter (run by `git status` on a changed file) that records who ran it.
function filterRepo(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-safe-filter-')); fs.chmodSync(parent, 0o777);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'repo'); fs.mkdirSync(dir); fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
  execFileSync('git', ['init', '-q', dir]); git(dir, 'add', '.');
  git(dir, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'f');
  const marker = path.join(parent, 'RAN_AS');
  git(dir, 'config', 'filter.x.clean', `sh -c 'id -u > ${marker}; cat'`);
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
  // Same size, new content and time: status must hash it, through the filter.
  const later = new Date(Date.now() + 5000); fs.writeFileSync(path.join(dir, 'f.txt'), 'b\n'); fs.utimesSync(path.join(dir, 'f.txt'), later, later);
  return { dir, marker };
}
const ranAs = marker => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null);

test('a planted filter driver never runs as root: config owned by the service user runs git as that user (or not at all)', { skip }, t => {
  // The plant works: plain root git runs it as root.
  const proof = filterRepo(t);
  spawnSync('git', ['-C', proof.dir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(ranAs(proof.marker), '0', 'plain git as root runs the planted filter as root');
  // Work tree and .git owned by root, the config written by the service user.
  const a = filterRepo(t);
  fs.chmodSync(path.join(a.dir, '.git', 'config'), 0o644); execFileSync('chown', ['65534:65534', path.join(a.dir, '.git', 'config')]);
  safeGit(cp, fs, a.dir, ['status', '--porcelain']);
  assert.notEqual(ranAs(a.marker), '0', 'never as root');
  assert.ok([null, '65534'].includes(ranAs(a.marker)), `as the config's owner or not at all (${ranAs(a.marker)})`);
  // The whole repository owned by the service user: git (and its filter) run as that user.
  const b = filterRepo(t);
  execFileSync('chown', ['-R', '65534:65534', b.dir]);
  const rb = safeGit(cp, fs, b.dir, ['status', '--porcelain']);
  assert.equal(rb.status, 0, rb.stderr); assert.equal(ranAs(b.marker), '65534');
});

test('all owned by root but the config writable by others: git is not run, and the trim removes nothing', { skip }, t => {
  const c = filterRepo(t);
  fs.chmodSync(path.join(c.dir, '.git', 'config'), 0o666);
  const r = safeGit(cp, fs, c.dir, ['status', '--porcelain']);
  assert.equal(r.unsafe, true); assert.match(r.reason, /writable/);
  assert.equal(ranAs(c.marker), null, 'the filter never ran');
  const g = filterRepo(t);
  fs.chmodSync(path.join(g.dir, '.git'), 0o777);
  assert.equal(safeGit(cp, fs, g.dir, ['rev-parse', 'HEAD']).unsafe, true, 'a world-writable .git as well');
  // The release seal's trim over such a repository keeps the entry ("unknown").
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-safe-trim-')); fs.chmodSync(parent, 0o755);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'releases'); fs.mkdirSync(path.join(root, '.staging'), { recursive: true }); fs.chmodSync(root, 0o755);
  const stage = path.join(root, '.staging', '55555555-5555-4555-8555-555555555555-1'); fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'app.js'), 'x\n'); fs.writeFileSync(path.join(stage, '.gitignore'), 'test-results/\n');
  execFileSync('git', ['init', '-q', stage]); git(stage, 'add', '.');
  git(stage, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'f');
  fs.mkdirSync(path.join(stage, 'test-results')); fs.writeFileSync(path.join(stage, 'test-results', 'x'), 'x');
  const sha = git(stage, 'rev-parse', 'HEAD'), treeSha = git(stage, 'rev-parse', 'HEAD^{tree}');
  // The seal's freeze makes .git/config 0444; a writable-by-others config is
  // simulated by a hook that re-opens it to others right after the freeze.
  const reopen = path.join(parent, 'reopen.cjs');
  fs.writeFileSync(reopen, `const fs=require('node:fs');const l=fs.lstatSync;const cfg=${JSON.stringify(path.join(stage, '.git', 'config'))};fs.lstatSync=function(p,...r){if(String(p)===cfg)fs.chmodSync(cfg,0o666);return l.call(this,p,...r)};`);
  const sealed = spawnSync('sh', ['-c', `NODE_OPTIONS='--require ${reopen}' ${applicationGuestScript({ action: 'seal', profile: { sourceDir: path.join(parent, 'current'), releaseRoot: root, preservePaths: [], envFiles: [] }, retention: { trimBeforeSeal: ['test-results'] }, stage, release: path.join(root, 'sealed'), sha, treeSha, marker: { sha, treeSha } }).trim()}`], { encoding: 'utf8' });
  const answer = JSON.parse(sealed.stdout);
  assert.equal(fs.existsSync(path.join(stage, 'test-results', 'x')) || fs.existsSync(path.join(root, 'sealed', 'test-results', 'x')), true, 'nothing was trimmed');
  assert.ok(answer.ok === false || answer.trim?.kept?.some(k => k.path === 'test-results' && k.reason === 'unknown'), sealed.stdout);
});

test('git gets a clean environment, runs from /, and every command-starting setting is off on its command line', { skip }, t => {
  const { dir } = repo(t);
  const saved = { GIT_DIR: process.env.GIT_DIR, FOO: process.env.FOO };
  process.env.GIT_DIR = '/nonexistent-elsewhere'; process.env.FOO = 'leak';
  try {
    const top = safeGit(cp, fs, dir, ['rev-parse', '--show-toplevel']);
    assert.equal(top.ok, true, top.stderr); assert.equal(top.stdout.trim(), dir, "the caller's GIT_DIR is not inherited");
    const env = safeGit(cp, fs, dir, ['-c', 'alias.envdump=!env; pwd', 'envdump']);
    assert.equal(env.ok, true, env.stderr);
    const lines = env.stdout.split('\n');
    assert.ok(lines.includes('HOME=/nonexistent')); assert.ok(lines.includes('GIT_OPTIONAL_LOCKS=0')); assert.ok(lines.includes('LC_ALL=C'));
    assert.equal(lines.some(l => l.startsWith('FOO=')), false, 'nothing else from the caller');
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  for (const flag of ['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'core.sshCommand=false', 'protocol.allow=never', '--no-pager', "cwd: '/'"]) assert.ok(SAFE_GIT_SOURCE.includes(flag), flag);
  const r = safeGit(cp, fs, dir, ['rev-parse', 'HEAD']);
  assert.deepEqual([r.ok, r.status, r.asUid], [true, 0, 65534], 'read-only git over a root-owned repository runs as nobody, never as root');
  const w = safeGit(cp, fs, dir, ['rev-parse', 'HEAD'], { asRoot: true });
  assert.deepEqual([w.ok, w.asUid], [true, null], 'only an explicit asRoot call over a root-owned, closed repository runs as root');
  fs.chmodSync(path.join(dir, '.git', 'config'), 0o666);
  assert.equal(safeGit(cp, fs, dir, ['rev-parse', 'HEAD'], { asRoot: true }).unsafe, true);
  fs.chmodSync(path.join(dir, '.git', 'config'), 0o644); execFileSync('chown', ['65534:65534', path.join(dir, '.git', 'config')]);
  assert.equal(safeGit(cp, fs, dir, ['rev-parse', 'HEAD'], { asRoot: true }).unsafe, true, 'asRoot refuses a repository someone else can configure');
});

test('a planted filter driver in a root-owned repository (config written during the build, then frozen) never runs as root', { skip }, t => {
  const d = filterRepo(t); // root-owned throughout, config root-owned 0644 with the planted filter
  const r = safeGit(cp, fs, d.dir, ['status', '--porcelain']);
  assert.equal(r.asUid, 65534);
  assert.notEqual(ranAs(d.marker), '0', 'never as root');
  assert.ok([null, '65534'].includes(ranAs(d.marker)), `as nobody or not at all (${ranAs(d.marker)})`);
  // When nobody cannot read the tree the answer is unknown, not a root retry.
  fs.chmodSync(d.dir, 0o700);
  const hidden = safeGit(cp, fs, d.dir, ['ls-files']);
  assert.equal(hidden.ok, false); assert.equal(hidden.asUid, 65534);
});
