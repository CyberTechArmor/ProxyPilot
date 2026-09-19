// lib/storage/parse.js — the pure parsers behind list_disks / zpool_status /
// zfs_list, against captured tool output. The Go agent produces the same
// shape; these fixtures are the contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLsblk, parseSmartctl, smartVerdict, parseFindmnt, parseByIdMap, parseZpoolList, parseZpoolStatus, parseZpoolStatusJson, parseZpoolImport,
  parseZfsList, parseZfsSnapshots, classifySnapshotName, resolveOsDisks, buildDeviceInventory, parseIncusStoragePools, parseIncusInstances, incusInstanceDataset,
} from '../lib/storage/parse.js';
import { fx, fixtureDevices } from './fixtures/storage/load.js';

test('parseLsblk: whole disks only, partitions vs holders, string and numeric sizes, contains chain', () => {
  const disks = parseLsblk(fx('lsblk.json'));
  assert.deepEqual(disks.map((d) => d.name), ['nvme0n1', 'sda', 'sdb', 'sdc', 'sdd', 'sde', 'sdf']); // loop0 dropped
  const nvme = disks[0];
  assert.equal(nvme.size_bytes, 512110190592);
  assert.equal(nvme.transport, 'nvme');
  assert.equal(nvme.rotational, false);
  assert.equal(nvme.partitions.length, 3);
  assert.deepEqual(nvme.partitions[0].mountpoints, ['/boot/efi']);
  assert.equal(nvme.partitions[2].fstype, 'LVM2_member');
  assert.deepEqual(nvme.partitions[2].holders.map((h) => h.name), ['dm-0', 'dm-1']);
  assert.ok(nvme.contains.includes('dm-0') && nvme.contains.includes('nvme0n1p2'));
  const sdc = disks.find((d) => d.name === 'sdc');
  assert.equal(sdc.size_bytes, 4000787030016); // string size in old util-linux
  assert.equal(sdc.rotational, true);
  assert.equal(sdc.partitions.length, 0);
  const sde = disks.find((d) => d.name === 'sde');
  assert.equal(sde.partitions[0].holders[0].type, 'raid1');
  const sdf = disks.find((d) => d.name === 'sdf');
  assert.equal(sdf.removable, true);
});

test('parseSmartctl: ATA counters, NVMe wear, permission denied, verdicts', () => {
  const ok = parseSmartctl(fx('smartctl-sata-ok.json'));
  assert.equal(ok.available, true); assert.equal(ok.healthy, true); assert.equal(ok.temperature_c, 34); assert.equal(ok.power_on_hours, 31234);
  assert.equal(ok.reallocated_sectors, 0); assert.equal(ok.pending_sectors, 0);
  assert.deepEqual(smartVerdict(ok), { level: 'ok', reason: 'SMART passed' });
  const warn = parseSmartctl(fx('smartctl-sata-warn.json'));
  assert.equal(warn.reallocated_sectors, 12); assert.equal(warn.pending_sectors, 3);
  assert.equal(smartVerdict(warn).level, 'warn'); assert.match(smartVerdict(warn).reason, /12 reallocated sectors, 3 pending sectors/);
  const fail = parseSmartctl(fx('smartctl-sata-fail.json'));
  assert.equal(fail.healthy, false); assert.equal(smartVerdict(fail).level, 'fail');
  const nvme = parseSmartctl(fx('smartctl-nvme.json'));
  assert.equal(nvme.percentage_used, 7); assert.equal(nvme.media_errors, 0); assert.equal(nvme.available_spare, 100); assert.equal(nvme.healthy, true); assert.equal(nvme.temperature_c, 38);
  assert.equal(smartVerdict(nvme).level, 'ok');
  const perm = parseSmartctl(fx('smartctl-permission.json'));
  assert.equal(perm.available, false); assert.equal(perm.error, 'permission_denied');
  assert.equal(smartVerdict(perm).level, 'unknown');
  assert.equal(parseSmartctl('garbage').available, false);
});

test('parseFindmnt / parseByIdMap: OS mounts, btrfs subvolume suffix, by-id preference order', () => {
  const m = parseFindmnt(fx('findmnt.txt'));
  assert.deepEqual(m[0], { target: '/', source: '/dev/mapper/vg0-root', fstype: 'ext4' });
  assert.deepEqual(parseFindmnt('/ /dev/sda2[/@] btrfs')[0].source, '/dev/sda2');
  const ids = parseByIdMap(fx('by-id.txt'));
  assert.deepEqual(ids['/dev/sda'], ['/dev/disk/by-id/wwn-0x50014ee2b1111111', '/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1AAAAAA']);
  assert.deepEqual(ids['/dev/nvme0n1'], ['/dev/disk/by-id/nvme-Samsung_SSD_980_PRO_512GB_S5GXNX0R123456', '/dev/disk/by-id/nvme-eui.0025385b21b4c3a1']);
});

test('parseZpoolList / parseZpoolStatus: capacity, health, scan states, vdev tree, error columns, logs class', () => {
  const list = parseZpoolList(fx('zpool-list.txt'));
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'tank'); assert.equal(list[0].capacity_pct, 30); assert.equal(list[0].fragmentation_pct, 7); assert.equal(list[0].health, 'ONLINE'); assert.equal(list[0].ashift, 12);
  assert.equal(list[1].health, 'DEGRADED'); assert.equal(list[1].capacity_pct, 81);
  const st = parseZpoolStatus(fx('zpool-status.txt'));
  assert.equal(st.length, 2);
  const tank = st[0];
  assert.equal(tank.state, 'ONLINE');
  assert.equal(tank.scan.function, 'scrub'); assert.equal(tank.scan.state, 'finished'); assert.equal(tank.scan.errors, 0); assert.equal(tank.scan.repaired, '0B');
  assert.match(tank.scan.last_end, /^2026-09-1[34]T/);
  assert.equal(tank.vdevs.length, 1); assert.equal(tank.vdevs[0].type, 'mirror'); assert.equal(tank.vdevs[0].devices.length, 2);
  assert.equal(tank.vdevs[0].devices[0].path, '/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1AAAAAA-part1');
  assert.match(tank.errors, /No known data errors/);
  const data = st[1];
  assert.equal(data.state, 'DEGRADED');
  assert.match(data.status, /label is missing/); assert.match(data.action, /zpool replace/);
  assert.equal(data.scan.state, 'in_progress'); assert.equal(data.scan.percent, 13.85); assert.equal(data.scan.to_go, '01:59:12');
  const raidz = data.vdevs.find((v) => v.type === 'raidz1');
  assert.equal(raidz.devices.length, 3);
  assert.equal(raidz.devices[1].cksum_errors, 2);
  assert.equal(raidz.devices[2].state, 'FAULTED'); assert.equal(raidz.devices[2].name, '17915845734211201414'); assert.match(raidz.devices[2].note, /was \/dev/);
  const logs = data.vdevs.find((v) => v.class === 'logs');
  assert.equal(logs.type, 'single'); assert.equal(logs.devices[0].path, '/dev/disk/by-id/nvme-eui.000000000000001');
  assert.match(data.errors, /3 data errors/);
});

test('parseZpoolStatusJson: OpenZFS 2.3 JSON → the same shape', () => {
  const j = { pools: { tank: { name: 'tank', state: 'ONLINE', error_count: 0, scan_stats: { function: 'SCRUB', state: 'FINISHED', end_time: 1757809443, errors: 0 }, vdevs: { tank: { name: 'tank', vdev_type: 'root', vdevs: { 'mirror-0': { name: 'mirror-0', vdev_type: 'mirror', state: 'ONLINE', class: 'normal', read_errors: 0, write_errors: 0, checksum_errors: 0, vdevs: { '/dev/sda1': { name: '/dev/sda1', path: '/dev/sda1', state: 'ONLINE', read_errors: 0, write_errors: 0, checksum_errors: 1 } } } } } } } } };
  const [p] = parseZpoolStatusJson(j);
  assert.equal(p.name, 'tank'); assert.equal(p.scan.state, 'finished'); assert.equal(p.scan.function, 'scrub'); assert.equal(p.scan.last_end, '2025-09-14T00:24:03.000Z');
  assert.equal(p.vdevs[0].type, 'mirror'); assert.equal(p.vdevs[0].class, 'data'); assert.equal(p.vdevs[0].devices[0].cksum_errors, 1);
});

test('parseZpoolImport: importable pools with their member names; empty scan', () => {
  const imp = parseZpoolImport(fx('zpool-import.txt'));
  assert.deepEqual(imp, [{ name: 'oldpool', id: '5555555555555555555', state: 'ONLINE', status: null, action: 'The pool can be imported using its name or numeric identifier.', devices: ['ata-ST4000VN008-2DR166_ZDH1DDDD'] }]);
  assert.deepEqual(parseZpoolImport('no pools available to import\n'), []);
});

test('parseZfsList / parseZfsSnapshots: properties, encryption, volumes, snapshot kinds and clones', () => {
  const ds = parseZfsList(fx('zfs-list.txt'));
  assert.equal(ds.length, 9);
  const web = ds.find((d) => d.name === 'tank/incus/containers/pp-web');
  assert.equal(web.pool, 'tank'); assert.equal(web.compression, 'zstd'); assert.equal(web.compress_ratio, 1.8); assert.equal(web.mountpoint, '/var/lib/incus/storage-pools/zfs/containers/pp-web'); assert.equal(web.quota_bytes, null);
  const db = ds.find((d) => d.name === 'tank/incus/containers/pp-db');
  assert.equal(db.quota_bytes, 107374182400); assert.equal(db.recordsize_bytes, 16384);
  const sec = ds.find((d) => d.name === 'tank/secure');
  assert.equal(sec.encryption, 'aes-256-gcm'); assert.equal(sec.keystatus, 'available'); assert.equal(sec.keylocation, 'prompt');
  const vol = ds.find((d) => d.name === 'tank/vol1');
  assert.equal(vol.type, 'volume'); assert.equal(vol.volsize_bytes, 10737418240);
  assert.equal(ds[0].creation, '2025-09-13T21:46:40.000Z');
  const snaps = parseZfsSnapshots(fx('zfs-snapshots.txt'));
  assert.equal(snaps.length, 8);
  assert.deepEqual(snaps.map((s) => s.kind), ['sanoid', 'incus', 'sanoid', 'sanoid', 'sanoid', 'proxypilot', 'syncoid', 'manual']);
  assert.deepEqual(snaps[4].clones, ['tank/incus/containers/pp-db-clone']);
  assert.equal(snaps[7].holds, 1);
  // createtxg is the canonical ordering: two snapshots can share a creation second
  assert.deepEqual(snaps.map((s) => s.createtxg), [920, 930, 940, 950, 910, 925, 935, 900]);
  assert.equal(snaps[0].dataset, 'tank/incus/containers/pp-web'); assert.equal(snaps[0].snapshot, 'autosnap_2026-09-18_00:00:01_daily');
  assert.equal(classifySnapshotName('pp-premove-x'), 'proxypilot');
});

test('resolveOsDisks: LVM root on an NVMe partition, /boot, EFI and swap all map to the same whole disk; ZFS root maps to pool members', () => {
  const disks = parseLsblk(fx('lsblk.json'));
  const os = resolveOsDisks({ mounts: parseFindmnt(fx('findmnt.txt')), devices: disks, pools: [] });
  assert.deepEqual(Object.keys(os), ['nvme0n1']);
  assert.equal(os.nvme0n1, 'backs /');
  // ZFS root: the pool's members become OS disks.
  const devices = disks.map((d) => ({ ...d, by_id: parseByIdMap(fx('by-id.txt'))[d.path] || [], partitions: d.partitions.map((p) => ({ ...p, by_id: parseByIdMap(fx('by-id.txt'))[p.path] || [] })) }));
  const os2 = resolveOsDisks({ mounts: [{ target: '/', source: 'tank/ROOT/debian', fstype: 'zfs' }], devices, pools: parseZpoolStatus(fx('zpool-status.txt')) });
  assert.deepEqual(Object.keys(os2).sort(), ['sda', 'sdb']);
  assert.match(os2.sda, /zfs pool tank/);
});

test('buildDeviceInventory: os tag, in_pool, importable, signatures, mounted, holders, smart verdicts', () => {
  const { devices } = fixtureDevices();
  const by = Object.fromEntries(devices.map((d) => [d.name, d]));
  assert.equal(by.nvme0n1.os, true); assert.equal(by.nvme0n1.mounted, true); assert.ok(by.nvme0n1.mounted_at.includes('/'));
  assert.deepEqual(by.nvme0n1.member_of, ['lvm']); assert.equal(by.nvme0n1.has_holders, true);
  assert.equal(by.sda.os, false); assert.equal(by.sda.in_pool, 'tank'); assert.equal(by.sda.mounted, false); assert.ok(by.sda.signatures.includes('zfs_member'));
  assert.equal(by.sdb.in_pool, 'tank'); assert.equal(by.sdb.smart_verdict.level, 'warn');
  assert.equal(by.sdc.in_pool, null); assert.deepEqual(by.sdc.signatures, []); assert.equal(by.sdc.importable_pool, null); assert.equal(by.sdc.smart.error, 'permission_denied');
  assert.deepEqual(by.sdd.importable_pool, { name: 'oldpool', id: '5555555555555555555', state: 'ONLINE' }); assert.equal(by.sdd.smart_verdict.level, 'fail');
  assert.deepEqual(by.sde.member_of, ['mdadm']); assert.equal(by.sde.has_holders, true);
  assert.equal(by.sdf.mounted, true); assert.deepEqual(by.sdf.mounted_at, ['/mnt/usb']); assert.equal(by.sdf.removable, true);
  assert.equal(by.sda.by_id[0], '/dev/disk/by-id/wwn-0x50014ee2b1111111');
});

test('incus parsers: storage pools with sources, instances with their root pool and dataset', () => {
  const pools = parseIncusStoragePools(fx('incus-storage.json'));
  assert.deepEqual(pools.map((p) => [p.name, p.driver, p.source, p.used_by_count]), [['default', 'dir', '/var/lib/incus/storage-pools/default', 2], ['zfs', 'zfs', 'tank/incus', 2]]);
  const inst = parseIncusInstances(fx('incus-list.json'));
  assert.deepEqual(inst.map((i) => [i.name, i.status, i.pool]), [['pp-web', 'Running', 'zfs'], ['pp-db', 'Stopped', 'zfs'], ['pp-legacy', 'Running', 'default']]);
  assert.equal(incusInstanceDataset('tank/incus', inst[0]), 'tank/incus/containers/pp-web');
  assert.equal(incusInstanceDataset('tank/incus', { name: 'vm1', type: 'virtual-machine' }), 'tank/incus/virtual-machines/vm1');
  assert.deepEqual(parseIncusInstances('nope'), []);
});
