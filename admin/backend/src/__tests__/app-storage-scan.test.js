// The read-only storage collector, run for real (`node -e PROGRAM b64`)
// against real temp directories: it never follows a symlink, never descends
// into another filesystem, counts unreadable folders, stops honestly at its
// budget (partial = "at least"), counts a hard-linked file once, reads only
// the release marker and .git link files, and writes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, linkSync, chmodSync, chownSync, readdirSync, lstatSync, rmdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCAN_PROGRAM, scanArgv, scanScript, parseScanOutput, encodeScanInput, DESCRIBE_RELEASES_SOURCE } from '../lib/app-storage/scan-program.js';
import { makeRoot, cleanupRoot, holdOpen, age, DAY } from './helpers/app-storage-world.js';

function scan(input, opts = {}) {
  const [bin, ...args] = scanArgv(input);
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
  const parsed = parseScanOutput({ code: r.status, stdout: r.stdout });
  assert.equal(parsed.ok, true, `collector failed: ${r.stderr}`);
  return parsed.facts;
}
const byPath = (facts) => new Map(facts.items.map((it) => [it.path, it]));
function write(p, bytes = 1000, content = null) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content ?? Buffer.alloc(bytes, 120)); return p; }

/** Everything about a tree that a write would change (content hashes are not needed: sizes, inodes, mtimes, ctimes). */
function treeState(root) {
  const out = [];
  const walk = (p) => {
    const st = lstatSync(p);
    out.push([p, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode, st.nlink]);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  };
  walk(root);
  return JSON.stringify(out);
}

test('depth 0 is one item, depth 1 is one item per child; sizes add up; empty fields are dropped', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  write(join(root, 'a/one.bin'), 5000);
  write(join(root, 'a/sub/two.bin'), 3000);
  write(join(root, 'b.txt'), 10);
  const facts = scan({ roots: [{ path: root, depth: 1, role: 'x' }, { path: join(root, 'a/sub'), depth: 0, role: 'y' }] });
  const items = byPath(facts);
  assert.deepEqual([...items.keys()].sort(), [join(root, 'a'), join(root, 'a/sub'), join(root, 'b.txt')].sort());
  const a = items.get(join(root, 'a'));
  assert.equal(a.type, 'dir');
  assert.equal(a.files, 1, 'a/sub is its own item and is not walked again inside a');
  assert.equal(a.nested, 1);
  assert.ok(a.logicalBytes >= 5000 && a.allocatedBytes > 0);
  assert.equal(items.get(join(root, 'a/sub')).files, 1);
  assert.equal(items.get(join(root, 'b.txt')).type, 'file');
  assert.equal(items.get(join(root, 'b.txt')).logicalBytes, 10);
  assert.equal(facts.roots[0].children, 2);
  assert.equal('partial' in a, false);
});

test('symlinks are never followed: a link is reported with its target, the target tree is not counted', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  write(join(root, 'outside/huge.bin'), 200_000);
  mkdirSync(join(root, 'scan'));
  symlinkSync(join(root, 'outside'), join(root, 'scan/link-to-dir'));
  symlinkSync('/nonexistent/target', join(root, 'scan/dangling'));
  mkdirSync(join(root, 'scan/real'));
  symlinkSync(join(root, 'outside'), join(root, 'scan/real/inner-link'));
  const facts = scan({ roots: [{ path: join(root, 'scan'), depth: 1, role: 'temp' }] });
  const items = byPath(facts);
  const link = items.get(join(root, 'scan/link-to-dir'));
  assert.equal(link.type, 'link');
  assert.equal(link.linkTarget, join(root, 'outside'));
  assert.equal(link.linkTargetExists, true);
  assert.ok(link.logicalBytes < 1000, 'only the link itself is counted');
  assert.equal(items.get(join(root, 'scan/dangling')).linkTargetExists ?? false, false);
  const real = items.get(join(root, 'scan/real'));
  assert.equal(real.links, 1);
  assert.ok(real.logicalBytes < 10_000, 'the link inside a walked folder is not followed');
});

test('a walk never descends into another filesystem (a tmpfs mounted inside is not counted)', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  const mnt = join(root, 'data/mnt');
  mkdirSync(mnt, { recursive: true });
  write(join(root, 'data/local.bin'), 4000);
  const m = spawnSync('mount', ['-t', 'tmpfs', '-o', 'size=8m', 'none', mnt]);
  if (m.status !== 0) { t.skip('mounting a tmpfs is not permitted here'); return; }
  t.after(() => spawnSync('umount', [mnt]));
  write(join(mnt, 'big.bin'), 2_000_000);
  const facts = scan({ roots: [{ path: join(root, 'data'), depth: 0, role: 'x' }, { path: mnt, depth: 0, role: 'y' }, { path: join(root, 'other'), depth: 0, role: 'z' }], statfs: [mnt] });
  const items = byPath(facts);
  const data = items.get(join(root, 'data'));
  assert.ok(data.logicalBytes < 1_000_000, 'the mounted filesystem is not walked from its parent');
  const inner = items.get(mnt);
  assert.equal(inner.mountPoint, true);
  assert.equal(inner.crossesDevice, true, 'a mount point item is reported, not walked');
  assert.equal(inner.memoryBacked, true);
  assert.equal(facts.fs[0].fstype, 'tmpfs');
});

test('unreadable folders are counted and listed (the collector run as an unprivileged user)', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  chmodSync(root, 0o755);
  write(join(root, 'tree/ok/a.bin'), 1000);
  write(join(root, 'tree/secret/b.bin'), 1000);
  for (const p of [join(root, 'tree'), join(root, 'tree/ok'), join(root, 'tree/ok/a.bin')]) chmodSync(p, lstatSync(p).isDirectory() ? 0o755 : 0o644);
  chmodSync(join(root, 'tree/secret'), 0o700);
  chownSync(join(root, 'tree/secret'), 0, 0);
  const nobody = spawnSync('node', ['-e', 'process.exit(0)'], { uid: 65534, gid: 65534 });
  if (nobody.status !== 0 || process.getuid?.() !== 0) { t.skip('cannot run as an unprivileged user here'); return; }
  const facts = scan({ roots: [{ path: join(root, 'tree'), depth: 0, role: 'x' }] }, { uid: 65534, gid: 65534 });
  const tree = byPath(facts).get(join(root, 'tree'));
  assert.equal(tree.inaccessible, 1);
  assert.deepEqual(tree.inaccessiblePaths, [join(root, 'tree/secret')]);
  assert.equal(tree.files, 1);
});

test('the entry budget stops the walk honestly: the current item and every later one are partial', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  for (let i = 0; i < 40; i += 1) write(join(root, `a/f${i}`), 10);
  for (let i = 0; i < 5; i += 1) write(join(root, `b/f${i}`), 10);
  write(join(root, 'c.txt'), 10);
  const facts = scan({ roots: [{ path: join(root, 'a'), depth: 0 }, { path: join(root, 'b'), depth: 0 }, { path: join(root, 'c.txt'), depth: 0 }], budget: { ms: 60_000, entries: 20 } });
  const items = byPath(facts);
  assert.equal(facts.budgetExceeded, true);
  assert.equal(items.get(join(root, 'a')).partial, true);
  assert.ok(items.get(join(root, 'a')).files < 40, 'sizes of a partial item are a lower bound');
  assert.equal(items.get(join(root, 'b')).partial, true, 'later items are not walked and say so');
  assert.equal(items.get(join(root, 'b')).files ?? 0, 0);
  assert.equal(items.get(join(root, 'c.txt')).type, 'file', 'later items still carry their identity');
});

test('a hard-linked file is counted once: the first root that reaches it, the later one records shared bytes', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  write(join(root, 'data/note.bin'), 50_000);
  mkdirSync(join(root, 'copy'));
  linkSync(join(root, 'data/note.bin'), join(root, 'copy/note-link.bin'));
  const facts = scan({ roots: [{ path: join(root, 'data'), depth: 0 }, { path: join(root, 'copy'), depth: 0 }] });
  const items = byPath(facts);
  assert.ok(items.get(join(root, 'data')).allocatedBytes >= 50_000);
  const copy = items.get(join(root, 'copy'));
  assert.ok(copy.sharedBytes >= 50_000);
  assert.ok(copy.allocatedBytes < 50_000);
});

test('reads only the release marker and .git link files; resolves declared paths; reports open paths; writes nothing', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  const rel = join(root, 'releases/' + 'a'.repeat(40) + '-p1-' + '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12));
  write(join(rel, 'app.js'), 100);
  write(join(rel, '.proxypilot-release.json'), 0, JSON.stringify({ sha: 'a'.repeat(40), treeSha: 'b'.repeat(40), artifactDigest: 'c'.repeat(64), secret: 'not-copied' }));
  write(join(root, 'releases/big-marker/.proxypilot-release.json'), 5000);
  write(join(root, 'etc/app.env'), 0, 'PASSWORD=hunter2-never-read\n');
  write(join(root, 'work/w48/.git'), 0, 'gitdir: /nowhere/.git/worktrees/w48\n');
  mkdirSync(join(root, 'work/busy'), { recursive: true });
  symlinkSync(rel, join(root, 'live'));
  age(join(root, 'work'), Date.now() - 3 * DAY);
  const release = holdOpen(join(root, 'work/busy'));
  t.after(release);
  const before = treeState(root);
  // Give the holder a moment to exist in /proc.
  spawnSync('sleep', ['0.2']);
  const facts = scan({
    roots: [{ path: join(root, 'releases'), depth: 1, marker: true }, { path: join(root, 'etc/app.env'), depth: 0 }, { path: join(root, 'work'), depth: 1, gitLinks: true }],
    resolve: [join(root, 'live'), join(root, 'missing')], procScan: true, journal: false,
  });
  const after = treeState(root);
  assert.equal(after, before, 'nothing in the tree changed');
  const items = byPath(facts);
  assert.deepEqual(items.get(rel).marker, { present: true, sha: 'a'.repeat(40), treeSha: 'b'.repeat(40), artifactDigest: 'c'.repeat(64) });
  assert.deepEqual(items.get(join(root, 'releases/big-marker')).marker, { present: true, unreadable: true }, 'a marker over 4 KiB is not read');
  assert.equal(JSON.stringify(facts).includes('hunter2'), false, 'an env file is measured, never read');
  assert.equal(JSON.stringify(facts).includes('not-copied'), false, 'only known marker fields are kept');
  assert.deepEqual(items.get(join(root, 'work/w48')).gitLink, { target: '/nowhere/.git/worktrees/w48', exists: false });
  assert.equal(items.get(join(root, 'work/busy')).inUse, true);
  assert.equal(items.get(join(root, 'work/w48')).inUse ?? false, false);
  assert.equal(facts.resolved[join(root, 'live')].realpath, rel);
  assert.equal(facts.resolved[join(root, 'live')].isLink, true);
  assert.equal(facts.resolved[join(root, 'missing')].exists, false);
});

test('match filters children, maxChildren caps a huge folder, tracked paths come from git ls-files', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  for (const n of ['unit.service', 'unit.service.pre-job1', 'other.pre-job2']) write(join(root, 'sys', n), 10);
  for (let i = 0; i < 12; i += 1) write(join(root, `many/f${i}`), 1);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  write(join(repo, 'coverage/keep.json'), 10);
  write(join(repo, 'test-results/x.png'), 10);
  execFileSync('git', ['-C', repo, 'add', 'coverage/keep.json']);
  const facts = scan({ roots: [{ path: join(root, 'sys'), depth: 1, match: '\\.pre-' }, { path: join(root, 'many'), depth: 1 }], maxChildren: 5, tracked: [{ repo, paths: ['coverage', 'test-results'] }] });
  const names = facts.items.map((it) => it.name);
  assert.deepEqual(names.filter((n) => n.includes('pre-')).sort(), ['other.pre-job2', 'unit.service.pre-job1']);
  assert.equal(names.includes('unit.service'), false);
  assert.equal(facts.roots[1].children, 5);
  assert.equal(facts.roots[1].omitted, 7);
  assert.deepEqual(facts.tracked[repo], { ok: true, paths: ['coverage/keep.json'] });
});

test('the guest script runs from / and says NO_NODE without Node.js; outputs are parsed safely', () => {
  const script = scanScript({ roots: [] });
  assert.match(script, /^cd \/ \|\| exit 70\n/);
  assert.match(script, /command -v node .* echo NO_NODE; exit 127;/);
  assert.ok(script.includes(encodeScanInput({ roots: [] })));
  const r = spawnSync('sh', ['-c', script.replace('command -v node', 'command -v node-not-installed-here')], { encoding: 'utf8' });
  assert.equal(r.status, 127);
  assert.equal(parseScanOutput({ code: r.status, stdout: r.stdout }).code, 'NO_NODE');
  assert.match(parseScanOutput({ code: r.status, stdout: r.stdout }).reason, /Node\.js is not installed/);
  const run = spawnSync('sh', [], { input: script, encoding: 'utf8' });
  assert.equal(parseScanOutput({ code: run.status, stdout: run.stdout }).ok, true);
  assert.equal(parseScanOutput({ code: 0, stdout: 'garbage' }).code, 'SCAN_FAILED');
  assert.equal(parseScanOutput({ code: 124, stdout: '' }).code, 'TIMEOUT');
  assert.equal(parseScanOutput({ code: 0, stdout: '{}', stdoutTruncated: true }).code, 'OUTPUT_TOO_LARGE');
  assert.ok(SCAN_PROGRAM.length < 100_000, 'the program fits in one argv entry');
  // No write primitive appears in the program.
  const WRITE_RE = /\bfs\.(write|append|rm|unlink|rename|mkdir|mkdtemp|chmod|chown|lchown|truncate|ftruncate|copyFile|cp|utimes|lutimes|symlink|link|open(?!Sync\(f,fs\.constants\.O_RDONLY))\w*/g;
  // describeReleases (the shared release-role definition) is checked apart:
  // it runs over the read-only fs view, and its one open is a 4 KiB marker read.
  assert.ok(SCAN_PROGRAM.includes(DESCRIBE_RELEASES_SOURCE));
  const writes = SCAN_PROGRAM.replace(DESCRIBE_RELEASES_SOURCE, '').match(WRITE_RE) || [];
  assert.deepEqual(writes, [], 'no filesystem write primitive appears in the program');
  assert.deepEqual(DESCRIBE_RELEASES_SOURCE.match(WRITE_RE) || [], ['fs.openSync'], 'describeReleases only opens (the marker)');
  assert.match(DESCRIBE_RELEASES_SOURCE, /fs\.openSync\(file, 'r'\)/);
  assert.match(SCAN_PROGRAM, /describeReleases\(roFs,p,a\.releases\)/, 'it is given the read-only view');
  assert.equal((SCAN_PROGRAM.match(/describeReleases\(/g) || []).length, 2, 'defined once, called once');
  assert.match(SCAN_PROGRAM, /fs\.openSync\(f,fs\.constants\.O_RDONLY\|\(fs\.constants\.O_NOFOLLOW\|\|0\)\|\(fs\.constants\.O_NONBLOCK\|\|0\)\)/, 'the one open is read-only, never follows a link and never blocks');
});

test('statfs and the journal size are reported', () => {
  const facts = scan({ roots: [], statfs: ['/'], journal: true });
  assert.equal(facts.fs.length, 1);
  assert.ok(facts.fs[0].totalBytes > 0 && facts.fs[0].availBytes >= 0);
  assert.ok(facts.journal && 'bytes' in facts.journal);
  assert.equal(typeof facts.rootDev, 'number');
});

test('an unprivileged root in a /run-like folder: directories that vanish mid-walk are skipped, not fatal', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  mkdirSync(join(root, 'gone'));
  rmdirSync(join(root, 'gone'));
  const facts = scan({ roots: [{ path: join(root, 'gone'), depth: 0 }, { path: join(root, 'gone'), depth: 1 }] });
  assert.equal(facts.items.length, 0);
  assert.equal(facts.roots[0].exists, false);
});

/* ---- git in a repository the service user may own (review finding 3) ---- */

function fsmonitorRepo(root, owner = null) {
  // The reviewer's proof of concept: a repository whose core.fsmonitor runs a command.
  const repo = join(root, 'app');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  write(join(repo, 'coverage/keep.json'), 10);
  execFileSync('git', ['-C', repo, 'add', 'coverage/keep.json']);
  const marker = join(root, 'PWNED');
  execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', `touch ${marker}; echo`]);
  if (owner != null) execFileSync('chown', ['-R', `${owner}:${owner}`, repo]);
  return { repo, marker };
}

test('the tracked-path test never runs the repository\'s core.fsmonitor (root-owned repository)', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  const { repo, marker } = fsmonitorRepo(root);
  const facts = scan({ roots: [], tracked: [{ repo, paths: ['coverage', 'test-results'] }] });
  assert.equal(existsSync(marker), false, 'the planted command did not run');
  assert.deepEqual(facts.tracked[repo], { ok: true, paths: ['coverage/keep.json'] });
});

test('a repository owned by another account is read as that account, never as root with safe.directory=*', (t) => {
  if (process.getuid?.() !== 0) { t.skip('needs root to switch to the owner'); return; }
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  chmodSync(root, 0o755);
  const { repo, marker } = fsmonitorRepo(root, 65534);
  // A git wrapper first on PATH records who runs it and with what, then runs the real git.
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'git.log'); writeFileSync(log, ''); chmodSync(log, 0o666);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf 'uid=%s args=%s home=%s global=%s\\n' "$(id -u)" "$*" "$HOME" "$GIT_CONFIG_GLOBAL" >> ${log}\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const facts = scan({ roots: [], tracked: [{ repo, paths: ['coverage'] }] }, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(existsSync(marker), false, 'the planted command did not run');
  assert.deepEqual(facts.tracked[repo], { ok: true, paths: ['coverage/keep.json'], asUid: 65534 });
  const line = readFileSync(log, 'utf8').trim();
  assert.match(line, /^uid=65534 /, 'git ran as the repository owner');
  assert.match(line, /--no-pager -c core\.fsmonitor=false -c core\.hooksPath=\/dev\/null/);
  assert.match(line, /global=\/dev\/null/);
  assert.equal(line.includes('safe.directory'), false);
  assert.equal(SCAN_PROGRAM.includes('safe.directory'), false);
});

test('a repository that is a link, or git that refuses, leaves tracking unknown rather than guessing', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  const { repo } = fsmonitorRepo(root);
  symlinkSync(repo, join(root, 'link-to-app'));
  write(join(root, 'not-a-repo/x'), 1);
  const facts = scan({ roots: [], tracked: [{ repo: join(root, 'link-to-app'), paths: ['coverage'] }, { repo: join(root, 'not-a-repo'), paths: ['coverage'] }] });
  assert.deepEqual(facts.tracked[join(root, 'link-to-app')], { ok: false, paths: [], reason: 'not a directory' });
  assert.equal(facts.tracked[join(root, 'not-a-repo')].ok, false);
});

test('readSmall never blocks on a FIFO and reads only regular files (marker and .git link)', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  const rel = join(root, 'releases/' + 'a'.repeat(40) + '-p1-' + '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12));
  mkdirSync(rel, { recursive: true });
  execFileSync('mkfifo', [join(rel, '.proxypilot-release.json')]);
  mkdirSync(join(root, 'work/w1'), { recursive: true });
  execFileSync('mkfifo', [join(root, 'work/w1/.git')]);
  const started = Date.now();
  const facts = scan({ roots: [{ path: join(root, 'releases'), depth: 1, marker: true }, { path: join(root, 'work'), depth: 1, gitLinks: true }] }, { timeout: 15_000 });
  assert.ok(Date.now() - started < 10_000, 'the scan did not hang');
  const items = byPath(facts);
  assert.deepEqual(items.get(rel).marker, { present: false, unsafe: true });
  assert.equal(items.get(join(root, 'work/w1')).gitLink, undefined);
  assert.match(SCAN_PROGRAM, /O_NONBLOCK/);
  assert.match(SCAN_PROGRAM, /fs\.fstatSync\(fd\)/);
});
