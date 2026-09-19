// Shared loaders for the storage tests: fixture text → parsed inventory, and a
// scripted fake host that records every argv the service would run.
import { readFileSync } from 'node:fs';
import {
  parseLsblk, parseSmartctl, parseFindmnt, parseByIdMap, parseZpoolList, parseZpoolStatus, parseZpoolImport, parseZfsList, parseZfsSnapshots,
  buildDeviceInventory, parseIncusStoragePools, parseIncusInstances, parseIncusProfileRoot,
} from '../../../lib/storage/parse.js';

export const fx = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

export function fixtureDevices({ smart = true } = {}) {
  const lsblk = parseLsblk(fx('lsblk.json'));
  const byId = parseByIdMap(fx('by-id.txt'));
  const mounts = parseFindmnt(fx('findmnt.txt'));
  const importable = parseZpoolImport(fx('zpool-import.txt'));
  const pools = parseZpoolStatus(fx('zpool-status.txt'));
  const smartMap = smart ? {
    '/dev/nvme0n1': parseSmartctl(fx('smartctl-nvme.json')), '/dev/sda': parseSmartctl(fx('smartctl-sata-ok.json')), '/dev/sdb': parseSmartctl(fx('smartctl-sata-warn.json')),
    '/dev/sdc': parseSmartctl(fx('smartctl-permission.json')), '/dev/sdd': parseSmartctl(fx('smartctl-sata-fail.json')),
  } : {};
  return { devices: buildDeviceInventory({ lsblk, byId, smart: smartMap, mounts, importable, pools }), importable, pools, mounts };
}

/** The full inventory shape lib/storage/service.js builds, from fixtures. */
export function fixtureInventory(overrides = {}) {
  const d = fixtureDevices();
  const datasets = parseZfsList(fx('zfs-list.txt'));
  const snapshots = parseZfsSnapshots(fx('zfs-snapshots.txt'));
  const incusPools = parseIncusStoragePools(fx('incus-storage.json'));
  const instances = parseIncusInstances(fx('incus-list.json')).map((i) => ({ ...i, dataset: i.pool === 'zfs' ? `tank/incus/containers/${i.name}` : null }));
  return {
    collected_at: '2026-09-19T10:00:00.000Z', source: { disks: 'nsenter', pools: 'nsenter', datasets: 'nsenter' },
    devices: d.devices, importable: d.importable, pools: parseZpoolList(fx('zpool-list.txt')), poolStatus: d.pools, datasets, snapshots,
    incusPools, instances, defaultProfileRoot: { device: 'root', name: 'root', pool: 'default', used_by: [{ name: 'pp-web', project: 'default' }, { name: 'pp-db', project: 'default' }, { name: 'pp-legacy', project: 'default' }] }, incusSnapshotForm: 'sub', incusSources: ['tank/incus'],
    managed: { pool: 'tank', incus_pool: 'zfs', datasets: { incus: 'tank/incus', backups: 'tank/backups', exports: 'tank/exports' }, mountpoints: { backups: '/tank/backups', exports: '/tank/exports', incus: 'legacy' }, present: true },
    backupsDir: '/tank/backups', restoreHelper: '/usr/local/sbin/proxypilot-storage-restore-guest', warnings: [],
    ...overrides,
  };
}

/**
 * A fake lib/storage/host.js: discovery answers from the fixtures, exec is
 * scripted — `script(argv)` may return { status, stdout, stderr } or nothing
 * (→ success with empty output). Every exec is recorded in `calls`.
 */
export function fakeHost({ script = () => null, managedSettings = null } = {}) {
  const calls = [];
  const d = fixtureDevices();
  const host = {
    calls,
    async exec(argv, opts = {}) { calls.push({ argv, input: opts.input ?? null }); const r = script(argv, opts) || {}; return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false, error: null }; },
    async sh(s, args = []) { return host.exec(['sh', '-c', s, 'sh', ...args]); },
    async hasBinary() { return true; },
    async listDisks() { return { devices: d.devices, importable: d.importable, warnings: [], source: 'fake' }; },
    async pools() { return { list: parseZpoolList(fx('zpool-list.txt')), status: d.pools, error: null, source: 'fake' }; },
    async datasets() { return { datasets: parseZfsList(fx('zfs-list.txt')), snapshots: parseZfsSnapshots(fx('zfs-snapshots.txt')), error: null, source: 'fake' }; },
    async zfsSnapshots() { return { snapshots: parseZfsSnapshots(fx('zfs-snapshots.txt')) }; },
    async zpoolImportScan() { return d.importable; },
    async smartFor() { return {}; },
    async incusStoragePools() { return parseIncusStoragePools(fx('incus-storage.json')); },
    async incusInstances() { return parseIncusInstances(fx('incus-list.json')); },
    async incusDefaultProfileRoot() { return parseIncusProfileRoot({ devices: { root: { type: 'disk', path: '/', pool: 'default' } }, used_by: ['/1.0/instances/pp-web', '/1.0/instances/pp-db', '/1.0/instances/pp-legacy'] }); },
    async incusSnapshotForm() { return 'sub'; },
    async readFile() { return null; },
    async listDir() { return []; },
    async unitState(unit) { return { unit, present: false }; },
    async safetyFacts() { return { fstab: [], mdstat: [], efi: [], raid: {}, swaps: [], mdadm_checked: false, efi_checked: false }; },
    async risksFor(devs) { return { risks: Object.fromEntries((devs || []).map((d) => [d.name, { hard: [], warnings: [] }])), facts: null }; },
    async osRelease() { return { id: 'ubuntu', id_like: 'debian', version_id: '24.04', pretty_name: 'Ubuntu 24.04 LTS' }; },
    async runnerState() { return { present: true, enabled: true, source_dir: '/root/ProxyPilot', script_present: true }; },
    async agentPing() { return true; },
    async aptCandidate() { return '2.2.2-1'; },
    async kernelState() { return { running: '6.12.107+deb13-amd64', built_for: ['6.12.107+deb13-amd64'], built_for_running: true, reboot_target: null, secure_boot: false }; },
    async toolchain() { return { zpool: true, zfs: true, smartctl: true, sanoid: true, syncoid: true, wipefs: true, lsblk: true, incus: true, zfs_module_loaded: true }; },
    agentReachable: () => false,
  };
  return host;
}

export function fakeSettings(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getSetting: (k) => (m.has(k) ? m.get(k) : null), setSetting: (k, v) => m.set(k, v), map: m };
}
