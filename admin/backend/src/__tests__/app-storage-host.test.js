// Host-side storage facts: the moved readVolumeUsedBytes (same read, same
// null on failure, now shared with routes/lxc.js), the ZFS figures, the disk
// limit, per-snapshot bytes, exports and host-side leftovers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readVolumeUsedBytes, parseZfsGet, parseSizeString, diskLimitOf, measureHost, exportsFor, zfsGetArgv, hostScanPlan, backendExec, HOST_TRANSFER_ROOT } from '../lib/app-storage/host-measures.js';
import { makeRoot, cleanupRoot, buildNodusGuest, nodusTarget, scriptedExec, databases } from './helpers/app-storage-world.js';

test('readVolumeUsedBytes runs `incus query …/state` as argv and returns used bytes or null', async () => {
  const calls = [];
  const host = async (argv, opts) => { calls.push([argv, opts]); return { code: 0, stdout: JSON.stringify({ usage: { used: 1234 } }) }; };
  assert.equal(await readVolumeUsedBytes('Storage', 'container/pp-nodus/snapshots/s1', { host }), 1234);
  assert.deepEqual(calls[0][0], ['incus', 'query', '/1.0/storage-pools/Storage/volumes/container/pp-nodus/snapshots/s1/state']);
  assert.equal(calls[0][1].timeoutMs, 5000);
  assert.equal(await readVolumeUsedBytes('Storage', 'x', { host: async () => ({ code: 0, stdout: '{"used":"99"}' }) }), 99);
  // 0 is a real figure: a fresh snapshot holds nothing of its own yet.
  assert.equal(await readVolumeUsedBytes('Storage', 'x', { host: async () => ({ code: 0, stdout: '{"usage":{"used":0}}' }) }), 0);
  assert.equal(await readVolumeUsedBytes('Storage', 'x', { host: async () => ({ code: 0, stdout: '{"usage":{"used":"0"}}' }) }), 0);
  assert.equal(await readVolumeUsedBytes('Storage', 'x', { host: async () => ({ code: 0, stdout: '{"usage":{"used":-1}}' }) }), null);
  assert.equal(await readVolumeUsedBytes('Storage', 'x', { host: async () => ({ code: 0, stdout: '{"usage":{}}' }) }), null);
  assert.equal(await readVolumeUsedBytes('Storage', 'x', { host: async () => ({ code: 1, stdout: '' }) }), null);
  assert.equal(await readVolumeUsedBytes('Storage', 'x', { host: async () => ({ code: 0, stdout: 'not json' }) }), null);
  assert.equal(await readVolumeUsedBytes('Storage', 'x', { host: async () => { throw new Error('boom'); } }), null);
  assert.equal(await readVolumeUsedBytes(null, 'x', { host }), null);
  assert.equal(calls.length, 1, 'no lookup without a pool');
});

test('routes/lxc.js imports the shared helper instead of keeping its own copy', () => {
  const src = readFileSync(new URL('../routes/lxc.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ readVolumeUsedBytes \} from '\.\.\/lib\/app-storage\/host-measures\.js';/);
  assert.equal(/async function readVolumeUsedBytes\(/.test(src), false);
  assert.ok((src.match(/readVolumeUsedBytes\(pool, `container\//g) || []).length >= 4, 'call sites unchanged');
});

test('ZFS, size strings and the disk limit', () => {
  assert.deepEqual(zfsGetArgv('tank/incus/containers/pp-nodus'), ['zfs', 'get', '-Hp', '-o', 'property,value', 'used,referenced,usedbysnapshots,usedbydataset,logicalused,logicalreferenced,compressratio,refquota,quota,available', 'tank/incus/containers/pp-nodus']);
  const z = parseZfsGet('used\t2956898304\nreferenced\t3155775488\nusedbysnapshots\t0\nusedbydataset\t2956898304\nlogicalused\t6200000000\nlogicalreferenced\t6600000000\ncompressratio\t2.10x\nrefquota\t0\nquota\t236223201280\navailable\t233266216960\n');
  assert.equal(z.usedBytes, 2956898304);
  assert.equal(z.snapshotsBytes, 0);
  assert.equal(z.compressRatio, 2.1);
  assert.equal(z.refquotaBytes, null, 'a zero quota means none');
  assert.equal(z.quotaBytes, 236223201280);
  assert.equal(parseZfsGet(''), null);
  assert.equal(parseSizeString('220GiB'), 220 * 1024 ** 3);
  assert.equal(parseSizeString('10GB'), 10e9);
  assert.equal(parseSizeString('512MiB'), 512 * 1024 ** 2);
  assert.equal(parseSizeString('1234'), 1234);
  assert.equal(parseSizeString('lots'), null);
  assert.equal(parseSizeString(''), null);
  assert.deepEqual(diskLimitOf({ instance: { expanded_devices: { root: { type: 'disk', path: '/', size: '220GiB' } } }, dataset: z }), { bytes: 220 * 1024 ** 3, source: 'root-device' });
  assert.deepEqual(diskLimitOf({ instance: { expanded_devices: { root: { type: 'disk', path: '/' } } }, dataset: { refquotaBytes: 5e9 } }), { bytes: 5e9, source: 'refquota' });
  assert.deepEqual(diskLimitOf({ instance: {}, dataset: null }), { bytes: null, source: null });
});

test('measureHost: dataset, limit, per-snapshot bytes, exports and the host transfer leftovers', async (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  const world = buildNodusGuest(root);
  const target = nodusTarget(world);
  const exec = scriptedExec({ prefix: root, snapshots: [{ name: 'snap0', created_at: '2026-10-18T10:00:00Z' }, { name: 'snap1', created_at: '2026-10-19T10:00:00Z' }], snapshotUsed: { snap0: 40_000_000 } });
  const { mainDb } = databases();
  mainDb.prepare("INSERT INTO lxc_exports (container_name, path, filename, compression, state, bytes_total, created_at) VALUES ('nodus', '/x/a.tar.zst', 'a.tar.zst', 'zstd', 'ready', 1200, '2026-10-19T08:00:00Z')").run();
  mainDb.prepare("INSERT INTO lxc_exports (container_name, path, filename, compression, state, bytes_done, created_at) VALUES ('other', '/x/b.tar.zst', 'b.tar.zst', 'zstd', 'preparing', 10, '2026-10-19T08:00:00Z')").run();
  const host = await measureHost({ target, exec, mainDb });
  assert.equal(host.running, true);
  assert.equal(host.datasetName, 'Fractionate-ZFS/incus/containers/pp-nodus');
  assert.equal(host.dataset.usedBytes, 2956898304);
  assert.deepEqual(host.limit, { bytes: 220 * 1024 ** 3, source: 'root-device' });
  assert.deepEqual(host.snapshots.map((s) => [s.name, s.usedBytes]), [['snap0', 40_000_000], ['snap1', null]]);
  assert.deepEqual(host.exports.map((e) => [e.id, e.state, e.bytes]), [[1, 'ready', 1200]]);
  assert.deepEqual(host.unmeasured, []);
  assert.deepEqual(host.hostFiles.items.map((i) => i.path), [`${HOST_TRANSFER_ROOT}/bundle-app1-a1b2c3`]);
  assert.equal(exec.calls.filter((c) => c[0] === 'guest').length, 0, 'host facts never enter the guest');
});

test('measureHost reports what it could not read instead of failing', async () => {
  const exec = { host: async () => ({ code: 1, stdout: '' }), guest: async () => ({ code: 1, stdout: '' }) };
  const host = await measureHost({ target: { kind: 'project', guest: 'm2-4', repoPath: '/var/lib/proxypilot/mock2/repos/4.git' }, exec, mainDb: null });
  assert.equal(host.running, false);
  assert.deepEqual(host.unmeasured.map((u) => u.area), ['container', 'exports', 'host files']);
  const dirPool = scriptedExec({ prefix: '/nonexistent', guest: 'm2-4', driver: 'dir' });
  const h2 = await measureHost({ target: { kind: 'project', guest: 'm2-4', repoPath: '/nonexistent.git' }, exec: dirPool, listExports: () => [] });
  assert.equal(h2.dataset, null);
  assert.match(h2.unmeasured.find((u) => u.area === 'disk figures').reason, /uses dir, not ZFS/);
  assert.deepEqual(hostScanPlan({ kind: 'project', repoPath: '/var/lib/proxypilot/mock2/repos/4.git' }).roots, [{ path: '/var/lib/proxypilot/mock2/repos/4.git', depth: 0, role: 'host-repo' }]);
  assert.deepEqual(hostScanPlan({ kind: 'project', repoPath: '/etc/../x.git' }).roots, [], 'an odd repo path is not measured');
  assert.equal(exportsFor(null, 'pp-x'), null);
});

test('backendExec refuses anything but argv on the host and a plain guest name', async () => {
  const seen = [];
  const exec = backendExec({ capture: async (bin, args, opts) => { seen.push([bin, args, opts]); return { status: 0, stdout: 'ok', stderr: '' }; } });
  assert.equal((await exec.host('incus list')).code, -1);
  assert.equal((await exec.guest('pp-x; rm -rf /', 'echo')).code, -1);
  assert.equal((await exec.guest('pp-nodus', 'echo hi', { timeoutMs: 5 })).stdout, 'ok');
  assert.deepEqual(seen[0].slice(0, 2), ['incus', ['exec', 'pp-nodus', '--', 'sh']]);
  assert.equal(seen[0][2].input, 'echo hi');
});
