import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CLEANUP_PROGRAM, cleanupProgramArgv, cleanupProgramScript, parseProgramOutput, quarantinePattern } from '../lib/app-storage/cleanup-program.js';

// The real program, run the way the host runner runs it, against real
// directories. The sandbox runs as root (release roots must be root-owned).
const skip = process.platform === 'win32';
const CLEANUP_ID = 'cln_11111111-1111-4111-8111-111111111111';
const run = data => {
  const r = spawnSync('node', ['-e', CLEANUP_PROGRAM, Buffer.from(JSON.stringify(data)).toString('base64')], { encoding: 'utf8' });
  return { ...parseProgramOutput({ stdout: r.stdout, stderr: r.stderr, code: r.status }), status: r.status };
};
const identity = file => { const s = fs.lstatSync(file); return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, size: s.size, type: s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : 'file' }; };
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cleanup-program-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'root'); fs.mkdirSync(root);
  const outside = path.join(parent, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'important'), 'keep me');
  const tree = path.join(root, 'tree'); fs.mkdirSync(path.join(tree, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'a.txt'), 'x'.repeat(8192)); fs.writeFileSync(path.join(tree, 'deep', 'b.txt'), 'y');
  return { parent, root, outside, tree };
}
const remove = (f, entries, extra = {}) => run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [f.root], entries, ...extra });

test('a directory is renamed into quarantine, removed without following links, and its bytes reported', { skip }, t => {
  const f = fixture(t);
  fs.symlinkSync(f.outside, path.join(f.tree, 'link-out'), 'dir');
  fs.symlinkSync(path.join(f.outside, 'important'), path.join(f.tree, 'deep', 'file-link'));
  const r = remove(f, [{ path: f.tree, identity: identity(f.tree) }]);
  assert.equal(r.ok, true);
  assert.equal(r.results[0].status, 'removed', JSON.stringify(r));
  assert.ok(r.results[0].bytes >= 8192, 'allocated bytes observed during removal');
  assert.equal(fs.existsSync(f.tree), false);
  assert.equal(fs.readFileSync(path.join(f.outside, 'important'), 'utf8'), 'keep me', 'the link target outside the tree is kept');
  assert.deepEqual(fs.readdirSync(f.root), [], 'no quarantine entry is left behind');
});

test('a path through a symlink is refused and nothing is removed', { skip }, t => {
  const f = fixture(t);
  const via = path.join(f.root, 'via'); fs.symlinkSync(f.outside, via, 'dir');
  const target = path.join(via, 'important');
  const r = remove(f, [{ path: target, identity: identity(path.join(f.outside, 'important')) }]);
  assert.equal(r.results[0].status, 'refused'); assert.equal(r.results[0].code, 'SYMLINK_IN_PATH');
  assert.equal(fs.readFileSync(path.join(f.outside, 'important'), 'utf8'), 'keep me');
});

test('an item replaced after the check (or replaced by a link) is refused', { skip }, t => {
  const f = fixture(t);
  const seen = identity(f.tree);
  fs.rmSync(f.tree, { recursive: true }); fs.mkdirSync(f.tree); fs.writeFileSync(path.join(f.tree, 'new'), 'fresh data');
  const r = remove(f, [{ path: f.tree, identity: seen }]);
  assert.equal(r.results[0].code, 'CHANGED_SINCE_CHECK');
  assert.equal(fs.readFileSync(path.join(f.tree, 'new'), 'utf8'), 'fresh data');
  const before = identity(f.tree);
  fs.rmSync(f.tree, { recursive: true }); fs.symlinkSync(f.outside, f.tree, 'dir');
  const linked = remove(f, [{ path: f.tree, identity: before }]);
  assert.equal(linked.results[0].code, 'CHANGED_SINCE_CHECK');
  assert.equal(fs.readFileSync(path.join(f.outside, 'important'), 'utf8'), 'keep me');
  const file = path.join(f.root, 'log.1'); fs.writeFileSync(file, 'abc');
  const fileId = identity(file); fs.appendFileSync(file, 'more');
  assert.equal(remove(f, [{ path: file, identity: fileId }]).results[0].code, 'CHANGED_SINCE_CHECK', 'a file that grew since the check stays');
  assert.equal(remove(f, [{ path: file, identity: { type: 'file' } }]).results[0].code, 'CHANGED_SINCE_CHECK', 'no identity, no removal');
});

test('outside the approved roots, or the root itself, is refused', { skip }, t => {
  const f = fixture(t);
  const elsewhere = path.join(f.parent, 'elsewhere'); fs.mkdirSync(elsewhere);
  assert.equal(remove(f, [{ path: elsewhere, identity: identity(elsewhere) }]).results[0].code, 'OUTSIDE_APPROVED_ROOTS');
  assert.equal(remove(f, [{ path: f.root, identity: identity(f.root) }]).results[0].code, 'OUTSIDE_APPROVED_ROOTS');
  assert.equal(remove(f, [{ path: `${f.root}/../outside`, identity: identity(f.outside) }]).results[0].code, 'INVALID_PATH');
  assert.equal(fs.existsSync(elsewhere), true); assert.equal(fs.existsSync(f.root), true);
  assert.equal(run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: ['/'], entries: [{ path: '/etc', identity: identity('/etc') }] }).code, 'NO_APPROVED_ROOTS', '/ is never an approved root');
  assert.equal(run({ action: 'remove', cleanupId: '../x', approvedRoots: [f.root], entries: [{ path: f.tree }] }).code, 'INVALID_CLEANUP_ID');
});

test('one refusal does not stop the other entries; a vanished entry reports gone', { skip }, t => {
  const f = fixture(t);
  const other = path.join(f.root, 'other'); fs.mkdirSync(other);
  const missing = path.join(f.root, 'missing');
  const r = remove(f, [{ path: f.tree, identity: { ...identity(f.tree), ino: 1 } }, { path: other, identity: identity(other) }, { path: missing, identity: { dev: 1, ino: 1 } }]);
  assert.deepEqual(r.results.map(x => x.status), ['refused', 'removed', 'gone']);
  assert.equal(fs.existsSync(f.tree), true); assert.equal(fs.existsSync(other), false);
});

test('an item a running process works in is refused when in-use checking is on', { skip }, async t => {
  const f = fixture(t);
  const child = spawn('sleep', ['30'], { cwd: f.tree, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(remove(f, [{ path: f.tree, identity: identity(f.tree) }], { checkInUse: true }).results[0].code, 'IN_USE');
  assert.equal(fs.existsSync(f.tree), true);
});

test('finish-quarantine removes only this cleanup\'s quarantine entries under approved roots and recorded parents', { skip }, t => {
  const f = fixture(t);
  // An interrupted removal: renamed into quarantine, the process died.
  const q0 = path.join(f.root, `.pp-cleanup-${CLEANUP_ID}-0`); fs.renameSync(f.tree, q0);
  const sub = path.join(f.root, 'sub'); fs.mkdirSync(sub);
  const q1 = path.join(sub, `.pp-cleanup-${CLEANUP_ID}-1`); fs.mkdirSync(q1); fs.writeFileSync(path.join(q1, 'x'), 'x');
  fs.symlinkSync(f.outside, path.join(q1, 'escape'), 'dir');
  const otherCleanup = path.join(f.root, '.pp-cleanup-cln_22222222-2222-4222-8222-222222222222-0'); fs.mkdirSync(otherCleanup);
  const held = path.join(f.root, `.pp-cleanup-hold-${CLEANUP_ID}-3`); fs.mkdirSync(held);
  const lookalike = path.join(f.root, `.pp-cleanup-${CLEANUP_ID}-x`); fs.mkdirSync(lookalike);
  const r = run({ action: 'finish-quarantine', cleanupId: CLEANUP_ID, approvedRoots: [f.root], parents: [sub, f.outside] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed.map(x => x.name).sort(), [path.basename(q0), path.basename(q1)].sort());
  for (const kept of [otherCleanup, held, lookalike, path.join(f.outside, 'important')]) assert.equal(fs.existsSync(kept), true, kept);
  assert.ok(quarantinePattern(CLEANUP_ID).test(path.basename(q0)));
  assert.equal(quarantinePattern(CLEANUP_ID).test(path.basename(held)), false);
});

test('remove-release applies the release predicates and the identity check', { skip }, t => {
  const f = fixture(t);
  const job = '11111111-1111-4111-8111-111111111111';
  const releaseRoot = path.join(f.parent, 'releases'); fs.mkdirSync(releaseRoot);
  const mk = (n, seconds) => { const dir = path.join(releaseRoot, `${String(n).repeat(40)}-p6-${job}`); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, '.proxypilot-release.json'), JSON.stringify({ sha: String(n).repeat(40) })); const at = new Date(Date.UTC(2026, 9, 20, 12, 0, seconds)); fs.utimesSync(dir, at, at); return dir; };
  const oldest = mk(1, 1), rollback = mk(2, 2), live = mk(3, 3);
  const sourceDir = path.join(f.parent, 'current'); fs.symlinkSync(live, sourceDir, 'dir');
  const profile = { releaseRoot, sourceDir, preservePaths: [], envFiles: [] };
  // Without a recorded previous release or deploy history nothing is removed.
  const unknown = run({ action: 'remove-release', cleanupId: CLEANUP_ID, approvedRoots: [releaseRoot], profile, path: oldest, identity: identity(oldest) });
  assert.equal(unknown.results[0].status, 'refused'); assert.equal(unknown.results[0].code, 'ROLLBACK_UNKNOWN');
  assert.equal(fs.existsSync(oldest), true);
  const base = { action: 'remove-release', cleanupId: CLEANUP_ID, approvedRoots: [releaseRoot], profile, previousLive: { sha: '2'.repeat(40), path: rollback } };
  const refusedLive = run({ ...base, path: live, identity: identity(live) });
  assert.equal(refusedLive.results[0].code, 'RELEASE_IS_LIVE');
  assert.equal(run({ ...base, path: rollback, identity: identity(rollback) }).results[0].code, 'RELEASE_IS_ROLLBACK');
  const ok = run({ ...base, path: oldest, identity: identity(oldest) });
  assert.equal(ok.results[0].status, 'removed', JSON.stringify(ok));
  assert.equal(fs.existsSync(oldest), false);
  for (const kept of [rollback, live]) assert.equal(fs.existsSync(kept), true);
  assert.equal(run({ ...base, path: oldest, identity: identity(rollback) }).results[0].status, 'gone');
  const live2 = run({ action: 'live', sourceDir, profile, statfs: true, previousLive: base.previousLive });
  assert.equal(live2.live, live); assert.equal(live2.releases.rollback, rollback); assert.equal(live2.releases.rollbackUnknown, false);
  assert.equal(run({ action: 'live', sourceDir, profile }).releases.rollbackUnknown, true);
  assert.ok(live2.fs === null || live2.fs.totalBytes > 0);
});

test('the journal vacuum refuses a limit below 16 MiB; unknown actions and bad input fail closed', { skip }, () => {
  assert.equal(run({ action: 'vacuum-journal', targetBytes: 1024 }).code, 'INVALID_JOURNAL_TARGET');
  assert.equal(run({ action: 'rm -rf /' }).code, 'UNKNOWN_ACTION');
  assert.equal(run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: ['/tmp'], entries: [] }).code, 'INVALID_ENTRIES');
  assert.deepEqual(parseProgramOutput({ stdout: 'not json' }), { ok: false, code: 'PROGRAM_RESULT_INVALID' });
  assert.equal(parseProgramOutput({ stdout: '', code: 127, stderr: 'sh: 1: node: not found' }).code, 'NODE_MISSING');
});

test('the guest line and the host argv carry the data as one encoded argument', () => {
  const line = cleanupProgramScript({ action: 'live', sourceDir: "/opt/it's" });
  assert.match(line, /^node -e '/); assert.ok(line.endsWith("'\n"));
  const argv = cleanupProgramArgv({ action: 'measure' }, { node: '/usr/bin/node' });
  assert.equal(argv[0], '/usr/bin/node'); assert.equal(argv[1], '-e'); assert.equal(argv.length, 4);
  assert.deepEqual(JSON.parse(Buffer.from(argv[3], 'base64').toString()), { action: 'measure' });
  assert.ok(CLEANUP_PROGRAM.length < 100 * 1024, 'the program stays far below the 128 KiB argv limit');
  const r = spawnSync('sh', ['-c', line], { encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).ok, true);
});
