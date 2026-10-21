// The cleanup's removal against a writer who swaps directories for links
// mid-removal (review H1/H2). The writer is simulated deterministically by
// the two --require hooks in helpers/: one swaps an inner directory for a
// link to protected data at the moment its entries are listed, the other
// swaps the item's parent for a link to /etc around the quarantine rename.
// Protected data must stay untouched and the result must be honest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLEANUP_PROGRAM } from '../lib/app-storage/cleanup-program.js';
import { applicationGuestScript } from '../lib/setup-engine/application-deploy-op.js';

const skip = process.platform !== 'linux' || (typeof process.getuid === 'function' && process.getuid() !== 0);
const CLEANUP_ID = 'cln_00000000-0000-4000-8000-0000000000aa';
const hook = name => new URL(`./helpers/${name}`, import.meta.url).pathname;
const identity = x => { const st = fs.lstatSync(x); return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, type: st.isDirectory() ? 'dir' : 'file', ...(st.isDirectory() ? {} : { size: st.size }) }; };
function world(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-race-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
function run(data, { require: req = null, env = {} } = {}) {
  const r = spawnSync(process.execPath, [...(req ? ['--require', req] : []), '-e', CLEANUP_PROGRAM, Buffer.from(JSON.stringify(data)).toString('base64')], { encoding: 'utf8', env: { ...process.env, ...env } });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: r.stdout, stderr: r.stderr }; }
}
const quarantined = dir => fs.readdirSync(dir).filter(n => n.startsWith('.pp-cleanup-'));

test('a directory swapped for a link while its entries are listed: the protected data behind the link stays, the result is a failure', { skip }, t => {
  const base = world(t);
  const protectedDir = path.join(base, 'var/lib/postgresql/17/main'); // the stand-in for a database directory
  fs.mkdirSync(protectedDir, { recursive: true }); fs.writeFileSync(path.join(protectedDir, 'canary'), 'database file');
  const root = path.join(base, 'cache'); // an approved root (~service/.cache)
  const item = path.join(root, 'item');
  fs.mkdirSync(path.join(item, 'inner'), { recursive: true }); fs.writeFileSync(path.join(item, 'inner', 'junk'), 'x');
  const out = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], entries: [{ path: item, identity: identity(item) }], checkInUse: true },
    { require: hook('race-swap-readdir.cjs'), env: { SWAP_DIR_SUFFIX: '/inner', SWAP_NTH: '2', SWAP_TARGET: protectedDir, SWAP_MARK: path.join(base, 'swapped') } });
  assert.equal(fs.existsSync(path.join(base, 'swapped')), true, 'the race happened');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(fs.readdirSync(protectedDir), ['canary'], 'nothing behind the link was removed');
  assert.equal(fs.readFileSync(path.join(protectedDir, 'canary'), 'utf8'), 'database file');
  assert.equal(out.results[0].status, 'failed', 'the removal began and was stopped: a failure, not a success');
  assert.equal(out.results[0].code, 'CHANGED_DURING_REMOVAL');
  // What is left sits in quarantine inside the approved root; finishing it
  // unlinks the link (never follows it) and removes the moved directory.
  assert.equal(quarantined(root).length, 1);
  const fin = run({ action: 'finish-quarantine', cleanupId: CLEANUP_ID, approvedRoots: [root] });
  assert.equal(fin.ok, true); assert.equal(fin.failed.length, 0, JSON.stringify(fin));
  assert.deepEqual(quarantined(root), []);
  assert.deepEqual(fs.readdirSync(protectedDir), ['canary']);
});

test('the parent swapped for a link to /etc around the quarantine rename: nothing in /etc is renamed or removed', { skip }, t => {
  const base = world(t);
  const etc = path.join(base, 'etc'); // the stand-in for /etc
  fs.mkdirSync(etc); fs.writeFileSync(path.join(etc, 'settings'), 'system file');
  const root = path.join(base, 'home', '.cache'); // an approved root owned by the service user
  const item = path.join(root, 'settings'); // the user names their cache entry like the target
  fs.mkdirSync(item, { recursive: true }); fs.writeFileSync(path.join(item, 'blob'), 'cache');
  const out = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], entries: [{ path: item, identity: identity(item) }], checkInUse: true },
    { require: hook('race-swap-rename.cjs'), env: { SWAP_TARGET: etc, SWAP_MARK: path.join(base, 'swapped') } });
  assert.equal(fs.existsSync(path.join(base, 'swapped')), true, 'the race happened');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(fs.readdirSync(etc), ['settings'], 'no .pp-cleanup-* entry appears in /etc');
  assert.equal(fs.readFileSync(path.join(etc, 'settings'), 'utf8'), 'system file');
  // The rename happened inside the directory that was opened and checked, so
  // the approved item itself is what was removed.
  const r = out.results[0];
  assert.ok(['removed', 'refused'].includes(r.status), JSON.stringify(r));
  if (r.status === 'removed') assert.equal(fs.existsSync(item), false);
  assert.deepEqual(quarantined(root), []);
});

test('a link anywhere on the way to the item, or a missing /proc, refuses before anything changes', { skip }, t => {
  const base = world(t);
  const real = path.join(base, 'real'); fs.mkdirSync(path.join(real, 'item'), { recursive: true });
  fs.symlinkSync(real, path.join(base, 'link'));
  const item = path.join(base, 'link', 'item');
  const out = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [path.join(base, 'link')], entries: [{ path: item, identity: identity(item) }] });
  assert.equal(out.results[0].status, 'refused'); assert.equal(out.results[0].code, 'SYMLINK_IN_PATH');
  assert.equal(fs.existsSync(path.join(real, 'item')), true);
  // Without a usable /proc/self/fd the remover fails closed.
  const noProc = path.join(base, 'no-proc.cjs');
  fs.writeFileSync(noProc, "const fs=require('node:fs');const s=fs.statSync;fs.statSync=function(p,...r){if(String(p).startsWith('/proc/self/fd/'))throw Object.assign(new Error('ENOENT'),{code:'ENOENT'});return s.call(this,p,...r)};");
  const target = path.join(base, 'real', 'item');
  const refused = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [real], entries: [{ path: target, identity: identity(target) }] }, { require: noProc });
  assert.equal(refused.results[0].status, 'refused'); assert.equal(refused.results[0].code, 'NO_PROCFS');
  assert.equal(fs.existsSync(target), true);
});

test('a parked entry (renamed, then found not to be the checked one) is reported with its name', { skip }, t => {
  const base = world(t);
  const root = path.join(base, 'tmp'); fs.mkdirSync(root);
  const item = path.join(root, 'work'); fs.mkdirSync(item);
  const id = identity(item);
  // The hook swaps the item for another directory between the checks and the
  // rename, and recreates the original name, so the renamed inode is not the
  // checked one and the name is taken: it is parked, never removed.
  const swap = path.join(base, 'swap.cjs');
  fs.writeFileSync(swap, `const fs=require('node:fs');const r=fs.renameSync;let n=0;fs.renameSync=function(a,b){n++;if(n===1){const s=String(a);const m=/^\\/proc\\/self\\/fd\\/(\\d+)\\/(.+)$/.exec(s);const dir=m?fs.readlinkSync('/proc/self/fd/'+m[1]):require('node:path').dirname(s);const name=m?m[2]:require('node:path').basename(s);r.call(fs,dir+'/'+name,dir+'/'+name+'.orig');fs.mkdirSync(dir+'/'+name);const out=r.call(fs,a,b);fs.mkdirSync(dir+'/'+name);return out}return r.call(fs,a,b)};`);
  const out = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], entries: [{ path: item, identity: id }] }, { require: swap });
  const r = out.results[0];
  assert.equal(r.status, 'refused'); assert.equal(r.code, 'CHANGED_SINCE_CHECK');
  assert.match(r.parked, /\/\.pp-cleanup-hold-cln_[a-f0-9-]+-\d+$/);
  assert.equal(fs.existsSync(r.parked), true, 'the parked entry is left for a person to look at');
  assert.equal(fs.existsSync(`${item}.orig`), true, 'the checked directory was never removed');
});

test('the release job removes build workspaces through the same remover: a swapped inner directory never reaches protected data', { skip }, t => {
  const base = world(t); fs.chmodSync(base, 0o755);
  for (let d = base; d !== '/'; d = path.dirname(d)) { try { fs.chmodSync(d, fs.statSync(d).mode & 0o7755); } catch { /* not ours */ } }
  const protectedDir = path.join(base, 'var/lib/nodus'); fs.mkdirSync(protectedDir, { recursive: true }); fs.writeFileSync(path.join(protectedDir, 'data'), 'keep');
  const root = path.join(base, 'releases'); fs.mkdirSync(path.join(root, '.staging'), { recursive: true, mode: 0o755 }); fs.chmodSync(root, 0o755); fs.chmodSync(path.join(root, '.staging'), 0o711);
  const live = path.join(root, `${'1'.repeat(40)}-p1-11111111-1111-4111-8111-111111111111`); fs.mkdirSync(live); fs.writeFileSync(path.join(live, '.proxypilot-release.json'), JSON.stringify({ sha: '1'.repeat(40) }));
  const sourceDir = path.join(base, 'current'); fs.symlinkSync(live, sourceDir);
  const old = path.join(root, '.staging', '22222222-2222-4222-8222-222222222222-1'); fs.mkdirSync(path.join(old, 'inner'), { recursive: true }); fs.writeFileSync(path.join(old, 'inner', 'junk'), 'x');
  const data = { action: 'release_cleanup', profile: { releaseRoot: root, sourceDir, preservePaths: [], envFiles: [] }, retention: { keepReleases: 2 }, sweepStages: true, stage: path.join(root, '.staging', '33333333-3333-4333-8333-333333333333-1'), previousLive: null };
  const r = spawnSync('sh', ['-c', `NODE_OPTIONS='--require ${hook('race-swap-readdir.cjs')}' ${applicationGuestScript(data).trim()}`], { encoding: 'utf8', env: { ...process.env, SWAP_DIR_SUFFIX: '/22222222-2222-4222-8222-222222222222-1/inner', SWAP_NTH: '2', SWAP_TARGET: protectedDir, SWAP_MARK: path.join(base, 'swapped') } });
  assert.equal(fs.existsSync(path.join(base, 'swapped')), true, 'the race happened');
  assert.equal(fs.readFileSync(path.join(protectedDir, 'data'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(protectedDir), ['data']);
  assert.equal(fs.existsSync(live), true);
  // The workspace that changed while it was removed is reported and left;
  // the job goes on (one stuck folder never fails every later validation).
  const answer = JSON.parse(r.stdout);
  assert.equal(answer.ok, true, r.stdout);
  assert.deepEqual(answer.cleanup.kept.map(k => [path.basename(k.path), k.code]), [['22222222-2222-4222-8222-222222222222-1', 'CHANGED_DURING_REMOVAL']]);
});

test('open files are re-read for every entry of a small batch: a process that starts working in a later entry keeps it', { skip }, t => {
  const base = world(t);
  const root = path.join(base, 'tmp'); fs.mkdirSync(root);
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  fs.mkdirSync(first); fs.writeFileSync(path.join(first, 'f'), 'x'); fs.mkdirSync(second);
  const pidFile = path.join(base, 'worker.pid');
  // Once the first entry's file is removed, a process starts working inside the second.
  const hookFile = path.join(base, 'late-worker.cjs');
  fs.writeFileSync(hookFile, `const fs=require('node:fs'),cp=require('node:child_process');const u=fs.unlinkSync;let done=false;fs.unlinkSync=function(...a){const r=u.apply(this,a);if(!done){done=true;cp.spawnSync('sh',['-c','cd "$1" && (sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$2")','sh',${JSON.stringify(second)},${JSON.stringify(pidFile)}])}return r};`);
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } });
  const out = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], checkInUse: true, entries: [{ path: first, identity: identity(first) }, { path: second, identity: identity(second) }] }, { require: hookFile });
  assert.equal(fs.existsSync(pidFile), true, 'the late worker started');
  assert.equal(out.results[0].status, 'removed');
  assert.equal(out.results[1].status, 'refused'); assert.equal(out.results[1].code, 'IN_USE');
  assert.equal(fs.existsSync(second), true);
});

test('in a large batch open files are re-read once the last read is 2 s old, and not before', { skip }, t => {
  // 25 entries (more than the per-entry refresh of a small batch). While the
  // first entry is removed a process starts working inside the last one;
  // the hook moves the program's clock 3 s forward at that moment, or holds
  // it still (so the run never depends on how fast this machine is).
  const runBatch = clockJump => {
    const base = world(t);
    const root = path.join(base, 'tmp'); fs.mkdirSync(root);
    const entries = [];
    for (let i = 0; i < 25; i += 1) { const d = path.join(root, `e${String(i).padStart(2, '0')}`); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f'), 'x'); entries.push({ path: d, identity: identity(d) }); }
    const last = entries[24].path, pidFile = path.join(base, 'worker.pid');
    const hookFile = path.join(base, 'late-worker-clock.cjs');
    fs.writeFileSync(hookFile, `const fs=require('node:fs'),cp=require('node:child_process');const now=Date.now,t0=now();let off=0;Date.now=()=>${clockJump ? 'now()+off' : 't0'};const u=fs.unlinkSync;let done=false;fs.unlinkSync=function(...a){const r=u.apply(this,a);if(!done){done=true;cp.spawnSync('sh',['-c','cd "$1" && (sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$2")','sh',${JSON.stringify(last)},${JSON.stringify(pidFile)}]);off+=${clockJump}}return r};`);
    t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } });
    const out = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], checkInUse: true, entries }, { require: hookFile });
    assert.equal(fs.existsSync(pidFile), true, 'the late worker started');
    return { out, last };
  };
  const stale = runBatch(3000);
  assert.equal(stale.out.results[24].status, 'refused', 'the read became 2 s old, so it was taken again');
  assert.equal(stale.out.results[24].code, 'IN_USE');
  assert.equal(fs.existsSync(stale.last), true);
  const fresh = runBatch(0);
  assert.equal(fresh.out.results[24].status, 'removed', 'within 2 s the batch keeps its one read (cheap for 100 000 entries)');
});

test('the seal freezes the build tree through the same walker: a link swapped in mid-freeze never changes a protected file', { skip }, t => {
  const base = world(t); fs.chmodSync(base, 0o755);
  const protectedFile = path.join(base, 'etc-shadow'); fs.writeFileSync(protectedFile, 'secret'); fs.chmodSync(protectedFile, 0o600);
  const root = path.join(base, 'releases'); fs.mkdirSync(path.join(root, '.staging'), { recursive: true }); fs.chmodSync(root, 0o755);
  const stage = path.join(root, '.staging', '44444444-4444-4444-8444-444444444444-1');
  fs.mkdirSync(path.join(stage, 'dist'), { recursive: true }); fs.writeFileSync(path.join(stage, 'dist', 'victim'), 'built'); fs.chmodSync(path.join(stage, 'dist', 'victim'), 0o644);
  const data = { action: 'seal', profile: { sourceDir: path.join(base, 'current'), releaseRoot: root, preservePaths: [], envFiles: [] }, retention: null, stage, release: path.join(root, 'sealed'), sha: 'a'.repeat(40), treeSha: 'b'.repeat(40), marker: { sha: 'a'.repeat(40) } };
  const r = spawnSync('sh', ['-c', `NODE_OPTIONS='--require ${hook('race-swap-lstat.cjs')}' ${applicationGuestScript(data).trim()}`], { encoding: 'utf8', env: { ...process.env, SWAP_DIR_SUFFIX: '/dist/victim', SWAP_TARGET: protectedFile, SWAP_MARK: path.join(base, 'swapped') } });
  assert.equal(fs.existsSync(path.join(base, 'swapped')), true, 'the race happened');
  assert.equal(fs.statSync(protectedFile).mode & 0o7777, 0o600, 'the protected file keeps its mode');
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'secret');
  assert.equal(JSON.parse(r.stdout).ok, false, 'the seal stops rather than freeze through the link');
  assert.equal(fs.existsSync(path.join(root, 'sealed')), false, 'nothing was sealed');
});

test('a hard-linked file written through its other name while the seal copies it stops the seal; the outside file is left as its owner wrote it', { skip }, t => {
  const base = world(t); fs.chmodSync(base, 0o755);
  const store = path.join(base, 'home'); fs.mkdirSync(store); fs.chownSync(store, 65534, 65534);
  const outside = path.join(store, 'shared.js'); fs.writeFileSync(outside, 'original'); fs.chownSync(outside, 65534, 65534); fs.chmodSync(outside, 0o600);
  const root = path.join(base, 'releases'); fs.mkdirSync(path.join(root, '.staging'), { recursive: true }); fs.chmodSync(root, 0o755);
  const stage = path.join(root, '.staging', '55555555-5555-4555-8555-555555555555-1');
  fs.mkdirSync(path.join(stage, 'node_modules'), { recursive: true }); fs.linkSync(outside, path.join(stage, 'node_modules', 'shared.js'));
  const data = { action: 'seal', profile: { sourceDir: path.join(base, 'current'), releaseRoot: root, preservePaths: [], envFiles: [] }, retention: null, stage, release: path.join(root, 'sealed'), sha: 'a'.repeat(40), treeSha: 'b'.repeat(40), marker: { sha: 'a'.repeat(40) } };
  const r = spawnSync('sh', ['-c', `NODE_OPTIONS='--require ${hook('race-write-during-copy.cjs')}' ${applicationGuestScript(data).trim()}`], { encoding: 'utf8', env: { ...process.env, WRITE_TARGET: outside, SWAP_MARK: path.join(base, 'written') } });
  assert.equal(fs.existsSync(path.join(base, 'written')), true, 'the race happened');
  assert.deepEqual(JSON.parse(r.stdout), { ok: false, code: 'CHANGED_DURING_FREEZE' });
  const st = fs.statSync(outside);
  assert.deepEqual([st.uid, st.mode & 0o7777], [65534, 0o600], 'the outside file keeps its owner and mode');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original changed');
  assert.deepEqual(fs.readdirSync(path.join(stage, 'node_modules')), ['shared.js'], 'the half-made copy is removed');
  assert.equal(fs.existsSync(path.join(root, 'sealed')), false, 'nothing was sealed');
});

test('a release marker swapped for a link between the look and the read is never read through the link', { skip }, t => {
  const base = world(t); fs.chmodSync(base, 0o755);
  const root = path.join(base, 'releases'); fs.mkdirSync(root); fs.chmodSync(root, 0o755);
  const mk = (c, s) => { const d = path.join(root, `${c.repeat(40)}-p1-11111111-1111-4111-8111-11111111111${c}`); fs.mkdirSync(d); fs.chmodSync(d, 0o755); fs.writeFileSync(path.join(d, '.proxypilot-release.json'), JSON.stringify({ sha: c.repeat(40) })); const at = new Date(Date.UTC(2026, 9, 20, 12, 0, s)); fs.utimesSync(d, at, at); return d; };
  const old = mk('a', 1), live = mk('b', 2);
  const sourceDir = path.join(base, 'current'); fs.symlinkSync(live, sourceDir);
  // A file elsewhere that claims to be the previous release's marker.
  const forged = path.join(base, 'forged.json'); fs.writeFileSync(forged, JSON.stringify({ sha: 'f'.repeat(40) }));
  const out = run({ action: 'live', sourceDir, profile: { releaseRoot: root, sourceDir, preservePaths: [], envFiles: [] }, previousLive: { sha: 'f'.repeat(40), path: null } },
    { require: hook('race-swap-lstat.cjs'), env: { SWAP_DIR_SUFFIX: `${path.basename(old)}/.proxypilot-release.json`, SWAP_TARGET: forged } });
  assert.equal(out.ok, true, JSON.stringify(out));
  const seen = (out.releases?.sealed || []).find(r => r.path === old);
  assert.notEqual(seen?.sha, 'f'.repeat(40), 'the forged marker behind the link is never read');
  assert.notEqual(out.releases?.rollback, old, 'so the forged sha never makes it the rollback release');
});

// A tree `depth` folders deep under dir/name, built without long paths.
function deepTree(dir, name, depth) {
  const top = path.join(dir, name); fs.mkdirSync(top, { recursive: true });
  const r = spawnSync(process.execPath, ['-e', "const fs=require('fs');process.chdir(process.argv[1]);for(let i=0;i<Number(process.argv[2]);i++){fs.mkdirSync('d');process.chdir('d')}fs.writeFileSync('f','leaf')", top, String(depth)]);
  assert.equal(r.status, 0, String(r.stderr));
  return top;
}
const runLimited = (data, fdLimit) => {
  const r = spawnSync('sh', ['-c', `ulimit -n ${fdLimit}; exec "$0" -e "$1" "$2"`, process.execPath, CLEANUP_PROGRAM, Buffer.from(JSON.stringify(data)).toString('base64')], { encoding: 'utf8', maxBuffer: 1 << 24 });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: r.stdout, stderr: r.stderr }; }
};
// Node's own rmSync recurses (and overflows on these trees): rm -rf cleans up.
function deepWorld(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-race-deep-'));
  t.after(() => spawnSync('rm', ['-rf', '--', base]));
  return base;
}

test('too deep to remove safely is a plain refusal before anything changes: depth 1500 under 256 file descriptors, and 12000 (which used to overflow the stack)', { skip }, t => {
  const base = deepWorld(t);
  const root = path.join(base, 'tmp'); fs.mkdirSync(root);
  const a = deepTree(root, 'fd-bound', 1500);
  const limited = runLimited({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], entries: [{ path: a, identity: identity(a) }] }, 256);
  assert.deepEqual([limited.results?.[0]?.status, limited.results?.[0]?.code], ['refused', 'TOO_DEEP'], JSON.stringify(limited).slice(0, 300));
  const b = deepTree(root, 'stack-bound', 12000);
  const deep = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], entries: [{ path: b, identity: identity(b) }] });
  assert.deepEqual([deep.results?.[0]?.status, deep.results?.[0]?.code], ['refused', 'TOO_DEEP'], JSON.stringify(deep).slice(0, 300));
  assert.deepEqual(fs.readdirSync(root).sort(), ['fd-bound', 'stack-bound'], 'nothing was renamed or removed');
  // Within the limit (here 256 descriptors less a reserve) the iterative walk removes it.
  const c = deepTree(root, 'ok', 200);
  const fine = runLimited({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], entries: [{ path: c, identity: identity(c) }] }, 256);
  assert.equal(fine.results?.[0]?.status, 'removed', JSON.stringify(fine).slice(0, 300));
  assert.equal(fs.existsSync(c), false);
});

test('a quarantined tree that cannot be finished is set aside once and reported, not retried on every resume', { skip }, t => {
  const base = deepWorld(t);
  const root = path.join(base, 'tmp'); fs.mkdirSync(root);
  deepTree(root, `.pp-cleanup-${CLEANUP_ID}-0`, 1500);
  const first = runLimited({ action: 'finish-quarantine', cleanupId: CLEANUP_ID, approvedRoots: [root] }, 256);
  assert.equal(first.failed.length, 1); assert.equal(first.failed[0].code, 'TOO_DEEP');
  assert.match(first.failed[0].parked, /\/\.pp-cleanup-hold-cln_[a-f0-9-]+-0$/);
  const again = runLimited({ action: 'finish-quarantine', cleanupId: CLEANUP_ID, approvedRoots: [root] }, 256);
  assert.deepEqual([again.removed.length, again.failed.length], [0, 0], 'the set-aside tree is not tried again');
});

test('the release job reports a workspace too deep to remove and goes on with the validation', { skip }, t => {
  const base = deepWorld(t); fs.chmodSync(base, 0o755);
  const root = path.join(base, 'releases'); fs.mkdirSync(path.join(root, '.staging'), { recursive: true, mode: 0o755 }); fs.chmodSync(root, 0o755); fs.chmodSync(path.join(root, '.staging'), 0o711);
  const live = path.join(root, `${'1'.repeat(40)}-p1-11111111-1111-4111-8111-111111111111`); fs.mkdirSync(live); fs.writeFileSync(path.join(live, '.proxypilot-release.json'), JSON.stringify({ sha: '1'.repeat(40) }));
  const sourceDir = path.join(base, 'current'); fs.symlinkSync(live, sourceDir);
  deepTree(path.join(root, '.staging'), '22222222-2222-4222-8222-222222222222-1', 12000);
  const data = { action: 'release_cleanup', profile: { releaseRoot: root, sourceDir, preservePaths: [], envFiles: [] }, retention: { keepReleases: 2 }, sweepStages: true, stage: path.join(root, '.staging', '33333333-3333-4333-8333-333333333333-1'), previousLive: null };
  const r = spawnSync('sh', ['-c', applicationGuestScript(data)], { encoding: 'utf8' });
  const answer = JSON.parse(r.stdout);
  assert.equal(answer.ok, true, r.stdout);
  assert.deepEqual(answer.cleanup.kept.map(k => k.code), ['TOO_DEEP']);
});

test('a build tree too deep to freeze is refused at the seal with TOO_DEEP: depth 12000 (which overflowed the old recursion) and 1500 under 256 file descriptors; 200 deep is sealed', { skip }, t => {
  const base = deepWorld(t); fs.chmodSync(base, 0o755);
  const root = path.join(base, 'releases'); fs.mkdirSync(path.join(root, '.staging'), { recursive: true }); fs.chmodSync(root, 0o755); fs.chmodSync(path.join(root, '.staging'), 0o711);
  const sealAt = (name, depth, fdLimit) => {
    const stage = path.join(root, '.staging', name); fs.mkdirSync(stage, { mode: 0o755 });
    spawnSync('git', ['init', '-q', stage]); fs.writeFileSync(path.join(stage, 'app.js'), 'source');
    spawnSync('git', ['-C', stage, 'add', 'app.js']); spawnSync('git', ['-C', stage, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const rev = x => spawnSync('git', ['-C', stage, 'rev-parse', x], { encoding: 'utf8' }).stdout.trim();
    const sha = rev('HEAD'), treeSha = rev('HEAD^{tree}');
    deepTree(stage, 'dist', depth);
    const release = path.join(root, `sealed-${name}`);
    const data = { action: 'seal', profile: { sourceDir: path.join(base, 'current'), releaseRoot: root, preservePaths: [], envFiles: [] }, retention: null, stage, release, sha, treeSha, marker: { sha, treeSha } };
    const r = spawnSync('sh', ['-c', `${fdLimit ? `ulimit -n ${fdLimit}; ` : ''}${applicationGuestScript(data).trim()}`], { encoding: 'utf8', maxBuffer: 1 << 24 });
    let answer; try { answer = JSON.parse(r.stdout); } catch { answer = { raw: r.stdout, stderr: r.stderr }; }
    return { answer, release };
  };
  const deep = sealAt('stack', 12000, null);
  assert.deepEqual([deep.answer.ok, deep.answer.code], [false, 'TOO_DEEP'], JSON.stringify(deep.answer).slice(0, 300));
  assert.equal(fs.existsSync(deep.release), false, 'nothing was sealed');
  const limited = sealAt('fds', 1500, 256);
  assert.deepEqual([limited.answer.ok, limited.answer.code], [false, 'TOO_DEEP'], JSON.stringify(limited.answer).slice(0, 300));
  const fine = sealAt('fine', 200, 256);
  assert.equal(fine.answer.ok, true, JSON.stringify(fine.answer).slice(0, 300));
  let leaf = path.join(fine.release, 'dist'); for (let i = 0; i < 200; i += 1) leaf = path.join(leaf, 'd');
  const st = fs.lstatSync(path.join(leaf, 'f'));
  assert.deepEqual([st.uid, st.mode & 0o7777], [0, 0o444], 'the deepest file is frozen');
});

test('reclaimed bytes count a file only when its last link goes', { skip }, t => {
  const base = world(t);
  const root = path.join(base, 'tmp'); fs.mkdirSync(root);
  const keeper = path.join(base, 'kept-elsewhere'); fs.writeFileSync(keeper, Buffer.alloc(64 * 1024, 1));
  const item = path.join(root, 'item'); fs.mkdirSync(item);
  fs.linkSync(keeper, path.join(item, 'hardlink')); fs.writeFileSync(path.join(item, 'own'), Buffer.alloc(32 * 1024, 2));
  const blocks = f => fs.lstatSync(f).blocks * 512;
  const expected = blocks(item) + blocks(path.join(item, 'own'));
  const out = run({ action: 'remove', cleanupId: CLEANUP_ID, approvedRoots: [root], entries: [{ path: item, identity: identity(item) }] });
  assert.equal(out.results[0].status, 'removed');
  assert.equal(out.results[0].bytes, expected, 'the hard-linked file still holds its blocks elsewhere');
  assert.equal(fs.readFileSync(keeper).length, 64 * 1024);
});
