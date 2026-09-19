// lib/storage/planner.js — device eligibility, OS-device refusal, layout
// validation, the exact command plans, and the sha256 plan token (same plan →
// same token, any change → a different one).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deviceEligibility, resolveByIdDevice, validateLayout, validateDatasetProps, planToken, verifyPlanToken, renderPlanCommands, parseSize,
  planCreateZpool, planCreateDataset, planSetDatasetProps, planDestroyDataset, planSnapshot, planRollback, planDestroySnapshot, planReplaceDisk, planScrub,
  planImportPool, planExportPool, planSetIncusStoragePool, planMoveGuestStorage, planRestoreGuestFromSnapshot, planRollbackGuestDataset, OPS,
} from '../lib/storage/planner.js';
import { fixtureInventory } from './fixtures/storage/load.js';

const ID = {
  nvme: '/dev/disk/by-id/nvme-Samsung_SSD_980_PRO_512GB_S5GXNX0R123456', sda: '/dev/disk/by-id/wwn-0x50014ee2b1111111', sdc: '/dev/disk/by-id/wwn-0x5000c500c3333333',
  sdd: '/dev/disk/by-id/wwn-0x5000c500c4444444', sde: '/dev/disk/by-id/ata-ST2000DM008_ZFL1EEEE', sdf: '/dev/disk/by-id/usb-SanDisk_Cruzer_Glide_4C530001-0:0',
};
const inv = () => fixtureInventory();
const dev = (name) => inv().devices.find((d) => d.name === name);

test('eligibility: the OS device has no override; mounted, in-pool and md/LVM holders are hard; signatures are soft (wipe clears them)', () => {
  const os = deviceEligibility(dev('nvme0n1'), { wipe: true });
  assert.equal(os.eligible, false); assert.match(os.hard[0], /OS device/);
  const inPool = deviceEligibility(dev('sda'), { wipe: true });
  assert.equal(inPool.eligible, false); assert.match(inPool.hard.join(), /member of the imported ZFS pool tank/);
  const md = deviceEligibility(dev('sde'), { wipe: true });
  assert.equal(md.eligible, false); assert.match(md.hard.join(), /md array/);
  const usb = deviceEligibility(dev('sdf'), { wipe: true });
  assert.equal(usb.eligible, false); assert.match(usb.hard.join(), /mounted filesystem \(\/mnt\/usb\)/);
  const blank = deviceEligibility(dev('sdc'));
  assert.equal(blank.eligible, true); assert.equal(blank.needs_wipe, false);
  const old = deviceEligibility(dev('sdd'));
  assert.equal(old.eligible, false); assert.equal(old.hard.length, 0); assert.match(old.soft[0], /importable ZFS pool oldpool/); assert.equal(old.needs_wipe, true);
  assert.equal(deviceEligibility(dev('sdd'), { wipe: true }).eligible, true);
  assert.match(deviceEligibility(dev('sdd'), { wipe: true }).warnings.join(), /SMART reports failure/);
});

test('by-id resolution: only /dev/disk/by-id whole-disk paths', () => {
  assert.match(resolveByIdDevice(inv().devices, '/dev/sdc').error, /must be given as \/dev\/disk\/by-id/);
  assert.match(resolveByIdDevice(inv().devices, '/dev/disk/by-id/wwn-0x50014ee2b1111111-part1').error, /partition of \/dev\/sda/);
  assert.match(resolveByIdDevice(inv().devices, '/dev/disk/by-id/ata-nope').error, /not a known whole disk/);
  assert.equal(resolveByIdDevice(inv().devices, ID.sdc).device.name, 'sdc');
});

test('layouts: minimum widths, duplicates, single = stripe with a warning, explicit vdev groups', () => {
  assert.match(validateLayout({ layout: 'raidz2', devices: ['a', 'b', 'c'] }).error, /raidz2 needs at least 4/);
  assert.match(validateLayout({ layout: 'mirror', devices: ['a'] }).error, /mirror needs at least 2/);
  assert.match(validateLayout({ layout: 'mirror', devices: ['a', 'a'] }).error, /more than once/);
  assert.match(validateLayout({ layout: 'zfsraid', devices: ['a'] }).error, /layout must be one of/);
  const stripe = validateLayout({ layout: 'single', devices: ['a', 'b'] });
  assert.deepEqual(stripe.groups, [['a'], ['b']]); assert.match(stripe.warnings[0], /stripe of 2 devices/);
  const two = validateLayout({ layout: 'mirror', vdevs: [['a', 'b'], ['c', 'd', 'e']] });
  assert.equal(two.groups.length, 2); assert.match(two.warnings[0], /different widths/);
});

test('create_zpool: refuses the OS device, in-pool and signature devices without wipe; the plan is the exact argv with the defaults', () => {
  assert.match(planCreateZpool(inv(), { name: 'p1', devices: [ID.nvme] }).error, /OS device/);
  assert.match(planCreateZpool(inv(), { name: 'p1', devices: [ID.sda, ID.sdc], layout: 'mirror' }).error, /member of the imported ZFS pool tank/);
  const soft = planCreateZpool(inv(), { name: 'p1', devices: [ID.sdd] });
  assert.match(soft.error, /importable ZFS pool oldpool/); assert.match(soft.error, /pass wipe: true/);
  assert.match(planCreateZpool(inv(), { name: 'tank', devices: [ID.sdc] }).error, /already exists/);
  assert.match(planCreateZpool(inv(), { name: 'oldpool', devices: [ID.sdc] }).error, /importable/);
  assert.match(planCreateZpool(inv(), { name: 'mirror', devices: [ID.sdc] }).error, /reserved/);
  const r = planCreateZpool(inv(), { name: 'p1', devices: [ID.sdc] });
  assert.ok(r.plan, r.error);
  const create = r.plan.steps.find((s) => s.argv[1] === 'create');
  assert.deepEqual(create.argv, ['zpool', 'create', '-o', 'ashift=12', '-O', 'compression=zstd', '-O', 'atime=off', '-O', 'xattr=sa', '-O', 'acltype=posixacl', '-O', 'dnodesize=auto', 'p1', ID.sdc]);
  assert.equal(create.stdin, null);
  assert.deepEqual(r.plan.steps.filter((s) => s.argv[0] === 'zfs').map((s) => s.argv[2]), ['p1/incus', 'p1/backups', 'p1/exports']);
  assert.deepEqual(r.plan.managed_datasets, { incus: 'p1/incus', backups: 'p1/backups', exports: 'p1/exports' });
  assert.ok(!r.plan.steps.some((s) => s.argv[0] === 'wipefs'));
  assert.match(r.plan.warnings[0], /no redundancy/);
  // wipe: true adds labelclear + wipefs for the device that needs it, and only that one.
  const w = planCreateZpool(inv(), { name: 'p2', layout: 'mirror', devices: [ID.sdc, ID.sdd], wipe: true, managed: false });
  assert.ok(w.plan, w.error);
  assert.deepEqual(w.plan.steps.slice(0, 2).map((s) => s.argv), [['zpool', 'labelclear', '-f', ID.sdd], ['wipefs', '-a', ID.sdd]]);
  assert.deepEqual(w.plan.steps[2].argv.slice(-3), ['mirror', ID.sdc, ID.sdd]);
  assert.ok(!w.plan.managed_datasets);
  assert.match(w.plan.warnings.join(), /SMART reports failure/);
  assert.match(renderPlanCommands(w.plan)[2], /^zpool create -o ashift=12/);
});

test('create_zpool encryption: passphrase never enters the plan; key files are referenced by path only', () => {
  const p = planCreateZpool(inv(), { name: 'enc', devices: [ID.sdc], encryption: { keyformat: 'passphrase' } });
  const create = p.plan.steps.find((s) => s.argv[1] === 'create');
  assert.ok(create.argv.includes('encryption=on') && create.argv.includes('keyformat=passphrase') && create.argv.includes('keylocation=prompt'));
  assert.equal(create.stdin, 'passphrase');
  assert.ok(!JSON.stringify(p.plan).includes('hunter2'));
  const f = planCreateZpool(inv(), { name: 'enc', devices: [ID.sdc], encryption: { keyformat: 'raw', keylocation: 'file:///root/keys/enc.key' } });
  assert.ok(f.plan.steps.find((s) => s.argv[1] === 'create').argv.includes('keylocation=file:///root/keys/enc.key'));
  assert.match(planCreateZpool(inv(), { name: 'enc', devices: [ID.sdc], encryption: { keyformat: 'raw' } }).error, /keylocation/);
  assert.match(planCreateZpool(inv(), { name: 'enc', devices: [ID.sdc], encryption: { keyformat: 'raw', keylocation: 'file:///etc/../x' } }).error, /keylocation/);
});

test('plan token: deterministic for the same plan, invalidated by any change (parameter or host state)', () => {
  const a = planCreateZpool(inv(), { name: 'p1', devices: [ID.sdc] }).plan;
  const b = planCreateZpool(inv(), { name: 'p1', devices: [ID.sdc] }).plan;
  assert.equal(planToken(a), planToken(b));
  assert.match(planToken(a), /^[0-9a-f]{64}$/);
  const c = planCreateZpool(inv(), { name: 'p1', devices: [ID.sdc], compression: 'lz4' }).plan;
  assert.notEqual(planToken(a), planToken(c));
  // host state moved: the blank disk now carries a signature → plan differs (wipefs step) or refuses
  const changed = inv(); changed.devices.find((d) => d.name === 'sdc').signatures = ['ext4'];
  assert.match(planCreateZpool(changed, { name: 'p1', devices: [ID.sdc] }).error, /ext4 signature/);
  const d = planCreateZpool(changed, { name: 'p1', devices: [ID.sdc], wipe: true }).plan;
  assert.notEqual(planToken(a), planToken(d));
  assert.equal(verifyPlanToken(a, planToken(a)).ok, true);
  assert.match(verifyPlanToken(a, planToken(c)).error, /does not match the current plan/);
  assert.match(verifyPlanToken(a, 'nope').error, /missing or malformed/);
  // the {{stamp}} placeholder keeps time out of the token
  const s1 = planSnapshot(inv(), { dataset: 'tank/backups' }).plan;
  assert.ok(s1.steps[0].argv[2].endsWith('@pp-manual-{{stamp}}'));
  assert.equal(planToken(s1), planToken(planSnapshot(inv(), { dataset: 'tank/backups' }).plan));
});

test('datasets: create / set props (allowlist) / destroy with pre-destroy stream / snapshot / rollback guards', () => {
  assert.match(planCreateDataset(inv(), { name: 'tank' }).error, /pool\/child/);
  assert.match(planCreateDataset(inv(), { name: 'nope/x' }).error, /parent dataset nope does not exist/);
  assert.match(planCreateDataset(inv(), { name: 'tank/backups' }).error, /already exists/);
  const c = planCreateDataset(inv(), { name: 'tank/data', props: { compression: 'lz4', quota: '10G', recordsize: '1M' } });
  assert.deepEqual(c.plan.steps[0].argv, ['zfs', 'create', '-o', 'compression=lz4', '-o', 'quota=10G', '-o', 'recordsize=1M', 'tank/data']);
  assert.match(validateDatasetProps({ sharenfs: 'on' }).error, /not settable/);
  assert.match(validateDatasetProps({ quota: 'lots' }).error, /not valid/);
  assert.match(validateDatasetProps({ mountpoint: '/mnt/../etc' }).error, /not valid/);
  assert.equal(parseSize('1.5T'), Math.round(1.5 * 1024 ** 4)); assert.equal(parseSize('none'), null); assert.equal(parseSize('x'), undefined);
  const s = planSetDatasetProps(inv(), { dataset: 'tank/backups', props: { compression: 'zstd-3', atime: 'on' } });
  assert.deepEqual(s.plan.steps[0].argv, ['zfs', 'set', 'compression=zstd-3', 'atime=on', 'tank/backups']);
  assert.equal(s.plan.previous.compression, 'zstd');
  assert.match(planSetDatasetProps(inv(), { dataset: 'tank/incus', props: { mountpoint: '/x' } }).error, /mountpoint cannot be changed/);
  // destroy
  assert.match(planDestroyDataset(inv(), { dataset: 'tank' }).error, /is a pool/);
  assert.match(planDestroyDataset(inv(), { dataset: 'tank/incus/containers/pp-web' }).error, /holds Incus guest storage \(pp-web\)/);
  assert.match(planDestroyDataset(inv(), { dataset: 'tank/incus' }).error, /guest storage|source dataset/);
  const d = planDestroyDataset(inv(), { dataset: 'tank/exports' });
  assert.deepEqual(d.plan.steps.map((x) => x.argv[0]), ['zfs', 'sh', 'zfs']);
  assert.deepEqual(d.plan.steps[0].argv, ['zfs', 'snapshot', '-r', 'tank/exports@pp-predestroy-{{stamp}}']);
  assert.equal(d.plan.steps[1].argv[5], '/tank/backups/destroyed/tank_exports@pp-predestroy-{{stamp}}.zfs');
  assert.deepEqual(d.plan.steps[2].argv, ['zfs', 'destroy', '-r', 'tank/exports']);
  assert.match(d.plan.reversal, /zfs receive tank\/exports/);
  // snapshots
  assert.match(planSnapshot(inv(), { dataset: 'tank/exports', name: 'manual-keep' }).error, /already exists/);
  assert.match(planSnapshot(inv(), { dataset: 'tank/exports', name: 'bad name' }).error, /name:/);
  assert.deepEqual(planSnapshot(inv(), { dataset: 'tank/incus', name: 'x', recursive: true }).plan.steps[0].argv, ['zfs', 'snapshot', '-r', 'tank/incus@x']);
  // rollback
  assert.match(planRollback(inv(), { snapshot: 'tank/backups@pp-mcp-20260918T010000Z' }).error, /1 newer snapshot\(s\) would be destroyed \(syncoid_/);
  const rb = planRollback(inv(), { snapshot: 'tank/backups@pp-mcp-20260918T010000Z', destroy_newer: true });
  assert.deepEqual(rb.plan.steps[0].argv, ['zfs', 'rollback', '-r', 'tank/backups@pp-mcp-20260918T010000Z']);
  assert.deepEqual(planRollback(inv(), { snapshot: 'tank/exports@manual-keep' }).plan.steps[0].argv, ['zfs', 'rollback', 'tank/exports@manual-keep']);
  assert.match(planRollback(inv(), { snapshot: 'tank/incus/containers/pp-web@snapshot-before-upgrade', destroy_newer: true }).error, /use rollback_guest_dataset/);
  assert.match(planDestroySnapshot(inv(), { snapshot: 'tank/incus/containers/pp-db@autosnap_2026-09-17_00:00:01_daily' }).error, /has clones/);
  assert.match(planDestroySnapshot(inv(), { snapshot: 'tank/incus/containers/pp-web@snapshot-before-upgrade' }).error, /Incus snapshot/);
  assert.deepEqual(planDestroySnapshot(inv(), { snapshot: 'tank/exports@manual-keep' }).plan.steps[0].argv, ['zfs', 'destroy', 'tank/exports@manual-keep']);
});

test('the rollback guard orders by createtxg: two snapshots in the same second are still ordered', () => {
  // `creation` is whole seconds, so sanoid's 15-minute snapshot and a manual
  // one taken in the same second compare equal by time. Ordering by createtxg
  // keeps the newer one visible — otherwise a rollback destroys it silently.
  const base = inv();
  const ds = 'tank/exports';
  const at = '2026-09-19T09:00:00.000Z';
  base.snapshots = [
    { name: `${ds}@a`, dataset: ds, snapshot: 'a', pool: 'tank', created_at: at, createtxg: 100, clones: [], kind: 'manual' },
    { name: `${ds}@b`, dataset: ds, snapshot: 'b', pool: 'tank', created_at: at, createtxg: 101, clones: [], kind: 'sanoid' },
  ];
  assert.match(planRollback(base, { snapshot: `${ds}@a` }).error, /1 newer snapshot\(s\) would be destroyed \(b\)/);
  assert.ok(planRollback(base, { snapshot: `${ds}@a`, destroy_newer: true }).plan);
  assert.ok(planRollback(base, { snapshot: `${ds}@b` }).plan, 'the newest snapshot rolls back with nothing to destroy');
  // no createtxg anywhere (an older agent): fall back to creation time
  const noTxg = inv();
  noTxg.snapshots = base.snapshots.map(({ createtxg, ...rest }) => rest);
  assert.ok(planRollback(noTxg, { snapshot: `${ds}@a` }).plan, 'same-second, no txg: nothing is treated as newer');
});

test('pools: replace_disk, scrub with timer, import (force for non-ONLINE), export guards', () => {
  assert.match(planReplaceDisk(inv(), { pool: 'nope', old_device: 'x', new_device: ID.sdc }).error, /not imported/);
  assert.match(planReplaceDisk(inv(), { pool: 'data', old_device: 'sdz', new_device: ID.sdc }).error, /not a member of data/);
  assert.match(planReplaceDisk(inv(), { pool: 'data', old_device: '17915845734211201414', new_device: ID.nvme }).error, /OS device/);
  const rp = planReplaceDisk(inv(), { pool: 'data', old_device: '17915845734211201414', new_device: ID.sdc });
  assert.deepEqual(rp.plan.steps[0].argv, ['zpool', 'replace', 'data', '17915845734211201414', ID.sdc]);
  assert.match(rp.plan.summary, /raidz1 raidz1-0, state FAULTED/);
  const byPath = planReplaceDisk(inv(), { pool: 'tank', old_device: '/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1BBBBBB-part1', new_device: ID.sdc });
  assert.equal(byPath.plan.steps[0].argv[3], '/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1BBBBBB-part1');
  const sc = planScrub(inv(), { pool: 'tank', timer: true });
  assert.deepEqual(sc.plan.steps.map((s) => s.argv), [['zpool', 'scrub', 'tank'], ['systemctl', 'enable', '--now', 'proxypilot-zfs-scrub@tank.timer']]);
  assert.match(planScrub(inv(), { pool: 'data' }).plan.warnings[0], /already in progress \(13.85% done\)/);
  assert.deepEqual(planScrub(inv(), { pool: 'data', action: 'stop' }).plan.steps[0].argv, ['zpool', 'scrub', '-s', 'data']);
  assert.match(planScrub(inv(), { pool: 'data', action: 'status' }).error, /action must be/);
  const im = planImportPool(inv(), { pool: 'oldpool' });
  assert.deepEqual(im.plan.steps[0].argv, ['zpool', 'import', '-d', '/dev/disk/by-id', '5555555555555555555']);
  assert.match(planImportPool(inv(), { pool: 'tank' }).error, /not importable/);
  const degraded = inv(); degraded.importable[0].state = 'DEGRADED';
  assert.match(planImportPool(degraded, { pool: 'oldpool' }).error, /pass force: true/);
  assert.ok(planImportPool(degraded, { pool: 'oldpool', force: true, readonly: true }).plan.steps[0].argv.includes('-f'));
  assert.match(planExportPool(inv(), { pool: 'tank' }).error, /guests are running on tank \(pp-web\)/);
  const stopped = inv(); stopped.instances.forEach((i) => { i.status = 'Stopped'; });
  assert.match(planExportPool(stopped, { pool: 'tank' }).error, /pass force: true/);
  assert.deepEqual(planExportPool(stopped, { pool: 'tank', force: true }).plan.steps[0].argv, ['zpool', 'export', '-f', 'tank']);
  assert.deepEqual(planExportPool(inv(), { pool: 'data' }).plan.steps[0].argv, ['zpool', 'export', 'data']);
});

test('incus binding: set_incus_storage_pool (create vs keep, profile root), move_guest_storage batch with snapshots and verification', () => {
  const keep = planSetIncusStoragePool(inv(), { name: 'zfs', dataset: 'tank/incus' });
  assert.deepEqual(keep.plan.steps.map((s) => s.argv), [['incus', 'profile', 'device', 'set', 'default', 'root', 'pool=zfs'], ['incus', 'storage', 'show', 'zfs']]);
  assert.equal(keep.plan.existing_pools.length, 2);
  assert.match(planSetIncusStoragePool(inv(), { name: 'default', dataset: 'tank/backups' }).error, /already has a storage pool default \(dir/);
  assert.match(planSetIncusStoragePool(inv(), { name: 'zfs2', dataset: 'tank/incus' }).error, /already backs the Incus pool zfs/);
  const fresh = inv(); fresh.incusPools = []; fresh.defaultProfileRoot = null;
  const cr = planSetIncusStoragePool(fresh, { name: 'zfs', dataset: 'tank/backups' });
  assert.deepEqual(cr.plan.steps[0].argv, ['incus', 'storage', 'create', 'zfs', 'zfs', 'source=tank/backups']);
  assert.deepEqual(cr.plan.steps[1].argv, ['incus', 'profile', 'device', 'add', 'default', 'root', 'disk', 'path=/', 'pool=zfs']);
  assert.match(planSetIncusStoragePool(fresh, { name: 'zfs', dataset: 'tank/incus' }).error, /already has child datasets/);
  assert.match(planMoveGuestStorage(inv(), { guests: ['pp-legacy'], pool: 'zfs' }).error, /pp-legacy is running — pass stop: true/);
  assert.match(planMoveGuestStorage(inv(), { guests: ['pp-web'], pool: 'zfs' }).error, /nothing to do/);
  const mv = planMoveGuestStorage(inv(), { guests: ['pp-legacy', 'pp-web'], pool: 'zfs', stop: true });
  assert.deepEqual(mv.plan.steps.map((s) => s.argv), [
    ['incus', 'stop', 'pp-legacy'], ['incus', 'snapshot', 'create', 'pp-legacy', 'pp-premove-{{stamp}}'], ['incus', 'move', 'pp-legacy', '--storage', 'zfs'], ['incus', 'start', 'pp-legacy'], ['incus', 'list', '^pp-legacy$', '--format', 'json'],
  ]);
  assert.equal(mv.plan.steps[4].expect, 'Running');
  assert.match(mv.plan.warnings[0], /pp-web is already on zfs/);
  const legacy = inv(); legacy.incusSnapshotForm = 'legacy';
  assert.deepEqual(planMoveGuestStorage(legacy, { guests: ['pp-legacy'], pool: 'zfs', stop: true }).plan.steps[1].argv, ['incus', 'snapshot', 'pp-legacy', 'pp-premove-{{stamp}}']);
});

test('guest restore vs rollback are different tools: clone-to-new-guest (incus copy or the ZFS helper) vs in-place rollback with Incus-snapshot guard', () => {
  assert.match(planRestoreGuestFromSnapshot(inv(), { guest: 'pp-web', snapshot: 'tank/incus/containers/pp-web@snapshot-before-upgrade', new_name: 'pp-web' }).error, /must differ/);
  assert.match(planRestoreGuestFromSnapshot(inv(), { guest: 'pp-web', snapshot: 'tank/backups@manual', new_name: 'pp-web2' }).error, /not a snapshot of pp-web's dataset/);
  assert.match(planRestoreGuestFromSnapshot(inv(), { guest: 'pp-legacy', snapshot: 'tank/backups@manual', new_name: 'x' }).error, /is the guest on a managed ZFS pool/);
  const viaIncus = planRestoreGuestFromSnapshot(inv(), { guest: 'pp-web', snapshot: 'tank/incus/containers/pp-web@snapshot-before-upgrade', new_name: 'pp-web2', start: true });
  assert.deepEqual(viaIncus.plan.steps[0].argv, ['incus', 'copy', 'pp-web/before-upgrade', 'pp-web2']);
  assert.equal(viaIncus.plan.steps[2].expect, 'Running');
  const viaZfs = planRestoreGuestFromSnapshot(inv(), { guest: 'pp-web', snapshot: 'tank/incus/containers/pp-web@autosnap_2026-09-19_09:00:01_hourly', new_name: 'pp-web3' });
  assert.deepEqual(viaZfs.plan.steps[0].argv, ['/usr/local/sbin/proxypilot-storage-restore-guest', 'tank/incus/containers/pp-web@autosnap_2026-09-19_09:00:01_hourly', 'pp-web3', 'zfs']);
  assert.notEqual(planToken(viaIncus.plan), planToken(viaZfs.plan));
  // rollback in place
  assert.match(planRollbackGuestDataset(inv(), { guest: 'pp-web', snapshot: 'tank/incus/containers/pp-web@autosnap_2026-09-18_00:00:01_daily', destroy_newer: true, stop: true }).error, /Incus snapshots newer than .* exist \(before-upgrade\)/);
  assert.match(planRollbackGuestDataset(inv(), { guest: 'pp-web', snapshot: 'tank/incus/containers/pp-web@autosnap_2026-09-19_09:00:01_hourly' }).error, /1 newer snapshot\(s\)/);
  assert.match(planRollbackGuestDataset(inv(), { guest: 'pp-web', snapshot: 'tank/incus/containers/pp-web@autosnap_2026-09-19_09:45:01_frequently' }).error, /is running — pass stop: true/);
  const rb = planRollbackGuestDataset(inv(), { guest: 'pp-web', snapshot: 'tank/incus/containers/pp-web@autosnap_2026-09-19_09:45:01_frequently', stop: true });
  assert.deepEqual(rb.plan.steps.map((s) => s.argv), [['incus', 'stop', 'pp-web'], ['zfs', 'rollback', 'tank/incus/containers/pp-web@autosnap_2026-09-19_09:45:01_frequently'], ['incus', 'start', 'pp-web'], ['incus', 'list', '^pp-web$', '--format', 'json']]);
  const stopped = planRollbackGuestDataset(inv(), { guest: 'pp-db', snapshot: 'tank/incus/containers/pp-db@autosnap_2026-09-17_00:00:01_daily' });
  assert.deepEqual(stopped.plan.steps.map((s) => s.argv[0]), ['zfs']);
  assert.equal(OPS.length, 18);
});
