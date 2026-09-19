// ZFS storage management — the host layer.
//
// Everything that touches the host goes through here, argv-only (no shell
// re-parse of caller input; the few `sh -c` scripts take their inputs as
// positional parameters). Discovery prefers the host agent
// (cmd/agent/methods/storage.go: storage.list_disks / storage.zpool_status /
// storage.zfs_list) and falls back to the same commands through
// runHostCapture (nsenter into the host namespaces from the dashboard
// container) whenever the agent is unreachable, does not know the method
// yet, or lacks the privilege for a part of it (smartctl, zpool import
// scanning). Mutations always run through runHostCapture: the agent unit is
// unprivileged by design.

import { parseFstab, parseMdstat, parseEfiBootEntries, parseOsRelease, hasRaidSuperblock, deviceRisks, parseAptCandidate } from './preflight.js';
import {
  LSBLK_COLUMNS, ZPOOL_LIST_COLUMNS, ZFS_LIST_COLUMNS, ZFS_SNAPSHOT_COLUMNS,
  parseLsblk, parseSmartctl, parseFindmnt, parseByIdMap, parseZpoolList, parseZpoolStatus, parseZpoolStatusJson, parseZpoolImport,
  parseZfsList, parseZfsSnapshots, buildDeviceInventory, parseIncusStoragePools, parseIncusInstances,
} from './parse.js';

const OS_MOUNTS = ['/', '/boot', '/boot/efi', '/boot/firmware'];
const BIG = 8 * 1024 * 1024;

export const REPLICATION_CONF_DIR = process.env.PROXYPILOT_STORAGE_CONF_DIR || '/etc/proxypilot/storage';
export const REPLICATION_STATE_DIR = process.env.PROXYPILOT_STORAGE_STATE_DIR || '/var/lib/proxypilot/storage';
export const SANOID_CONF = process.env.PROXYPILOT_SANOID_CONF || '/etc/sanoid/sanoid.conf';
export const REPLICATE_BIN = process.env.PROXYPILOT_STORAGE_REPLICATE_BIN || '/usr/local/sbin/proxypilot-storage-replicate';
export const RESTORE_HELPER = process.env.PROXYPILOT_STORAGE_RESTORE_BIN || '/usr/local/sbin/proxypilot-storage-restore-guest';

export function createStorageHost({ runHostCapture, agentCall = null, useAgent = true, agentTimeoutMs = 60000, logger = console } = {}) {
  if (typeof runHostCapture !== 'function') throw new Error('createStorageHost needs runHostCapture');

  async function exec(argv, { timeoutMs = 120000, input = null, maxCapture = BIG } = {}) {
    const [bin, ...args] = argv;
    const r = await runHostCapture(bin, args, { timeoutMs, input, maxCapture });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!r.timedOut, error: r.error || null };
  }
  const sh = (script, args = [], opts = {}) => exec(['sh', '-c', script, 'sh', ...args], opts);

  let agentKnown = null; // null = untested, false = unreachable/unknown method
  async function viaAgent(method, params = {}) {
    if (!useAgent || typeof agentCall !== 'function' || agentKnown === false) return null;
    try {
      const r = await agentCall(method, params, { timeoutMs: agentTimeoutMs, maxResponseBytes: BIG });
      agentKnown = true;
      return r;
    } catch (e) {
      if (e?.code === 'method_not_found' || /ENOENT|ECONNREFUSED|timed out|closed connection/.test(String(e?.message || ''))) agentKnown = false;
      else logger.warn?.(`[storage] agent ${method} failed, falling back: ${e?.message || e}`);
      return null;
    }
  }

  /* ------------------------------ discovery ------------------------------ */

  async function hasBinary(name) {
    const r = await sh('command -v "$1" >/dev/null 2>&1', [name], { timeoutMs: 10000 });
    return r.status === 0;
  }

  async function lsblk() {
    const includeLoop = process.env.PROXYPILOT_STORAGE_INCLUDE_LOOP === '1';
    const r = await exec(['lsblk', '-J', '-b', '-o', LSBLK_COLUMNS.join(',')], { timeoutMs: 30000 });
    if (r.status !== 0) {
      // Older util-linux lacks MOUNTPOINTS.
      const r2 = await exec(['lsblk', '-J', '-b', '-o', LSBLK_COLUMNS.filter((c) => c !== 'MOUNTPOINTS').join(',')], { timeoutMs: 30000 });
      if (r2.status !== 0) throw new Error(`lsblk failed: ${(r2.stderr || r.stderr).trim().slice(-300)}`);
      return parseLsblk(r2.stdout, { includeLoop });
    }
    return parseLsblk(r.stdout, { includeLoop });
  }

  async function byIdMap() {
    const r = await sh('for l in /dev/disk/by-id/*; do [ -e "$l" ] || continue; printf "%s %s\\n" "$l" "$(readlink -f "$l")"; done', [], { timeoutMs: 30000 });
    return parseByIdMap(r.stdout);
  }

  async function osMounts() {
    const out = [];
    for (const t of OS_MOUNTS) {
      const r = await exec(['findmnt', '-rno', 'TARGET,SOURCE,FSTYPE', '-T', t], { timeoutMs: 10000 });
      if (r.status === 0) for (const m of parseFindmnt(r.stdout)) if (m.target === t && !out.some((x) => x.target === m.target)) out.push(m);
    }
    const sw = await exec(['swapon', '--noheadings', '--raw', '--show=NAME'], { timeoutMs: 10000 });
    if (sw.status === 0) for (const line of sw.stdout.split('\n')) { const s = line.trim(); if (s.startsWith('/dev/')) out.push({ target: 'swap', source: s, fstype: 'swap' }); }
    return out;
  }

  async function smartFor(paths) {
    const out = {};
    if (!(await hasBinary('smartctl'))) { for (const p of paths) out[p] = { available: false, error: 'smartctl is not installed (apt-get install smartmontools)' }; return out; }
    for (const p of paths) {
      const r = await exec(['smartctl', '-j', '-a', p], { timeoutMs: 30000 });
      out[p] = r.stdout.trim().startsWith('{') ? parseSmartctl(r.stdout) : { available: false, error: (r.stderr || r.stdout).trim().slice(-200) || `smartctl exit ${r.status}` };
    }
    return out;
  }

  async function zpoolImportScan() {
    const r = await exec(['zpool', 'import', '-d', '/dev/disk/by-id'], { timeoutMs: 120000 });
    // Exit 1 with "no pools available to import" is the normal empty case.
    return parseZpoolImport(r.stdout);
  }

  async function zpoolList() {
    const r = await exec(['zpool', 'list', '-H', '-p', '-o', ZPOOL_LIST_COLUMNS.join(',')], { timeoutMs: 30000 });
    if (r.status !== 0) {
      const r2 = await exec(['zpool', 'list', '-H', '-p', '-o', ZPOOL_LIST_COLUMNS.slice(0, 9).join(',')], { timeoutMs: 30000 });
      if (r2.status !== 0) return { error: (r2.stderr || r.stderr).trim().slice(-300), pools: [] };
      return { pools: parseZpoolList(r2.stdout) };
    }
    return { pools: parseZpoolList(r.stdout) };
  }

  async function zpoolStatus() {
    const j = await exec(['zpool', 'status', '-j', '--json-int'], { timeoutMs: 30000 });
    if (j.status === 0 && j.stdout.trim().startsWith('{')) {
      try { return parseZpoolStatusJson(j.stdout); } catch { /* fall through to text */ }
    }
    const r = await exec(['zpool', 'status', '-P', '-p', '-v'], { timeoutMs: 30000 });
    return r.status === 0 ? parseZpoolStatus(r.stdout) : [];
  }

  async function zfsList() {
    const r = await exec(['zfs', 'list', '-H', '-p', '-t', 'filesystem,volume', '-o', ZFS_LIST_COLUMNS.join(',')], { timeoutMs: 60000 });
    if (r.status !== 0) return { error: r.stderr.trim().slice(-300), datasets: [] };
    return { datasets: parseZfsList(r.stdout) };
  }

  async function zfsSnapshots(dataset = null) {
    const argv = ['zfs', 'list', '-H', '-p', '-t', 'snapshot', '-o', ZFS_SNAPSHOT_COLUMNS.join(','), '-s', 'creation'];
    if (dataset) argv.push('-r', dataset);
    const r = await exec(argv, { timeoutMs: 120000 });
    if (r.status !== 0) return { error: r.stderr.trim().slice(-300), snapshots: [] };
    return { snapshots: parseZfsSnapshots(r.stdout) };
  }

  /** Whole-disk inventory. Agent first; smartctl / import scan filled in through nsenter where the agent could not. */
  async function listDisks({ smart = true, poolStatus = null } = {}) {
    const warnings = [];
    const status = poolStatus || await zpoolStatus();
    const agent = await viaAgent('storage.list_disks', { smart, include_loop: process.env.PROXYPILOT_STORAGE_INCLUDE_LOOP === '1' });
    if (agent && Array.isArray(agent.devices)) {
      const devices = agent.devices;
      for (const w of agent.warnings || []) warnings.push(String(w));
      const needSmart = smart ? devices.filter((d) => !d.smart?.available && /permission|not collected|not installed/i.test(d.smart?.error || '')).map((d) => d.path) : [];
      if (needSmart.length) {
        const filled = await smartFor(needSmart);
        for (const d of devices) if (filled[d.path]) d.smart = filled[d.path];
      }
      let importable = agent.importable;
      if (!Array.isArray(importable)) importable = await zpoolImportScan();
      const inv = buildDeviceInventory({ lsblk: devices.map((d) => ({ ...d, contains: d.contains || [] })), byId: Object.fromEntries(devices.flatMap((d) => [[d.path, d.by_id || []], ...(d.partitions || []).map((p) => [p.path, p.by_id || []])])), smart: Object.fromEntries(devices.map((d) => [d.path, d.smart])), mounts: agent.mounts || await osMounts(), importable, pools: status });
      return { devices: inv, importable, warnings, source: 'agent' };
    }
    const [disks, byId, mounts, importable] = await Promise.all([lsblk(), byIdMap(), osMounts(), zpoolImportScan()]);
    const smartMap = smart ? await smartFor(disks.map((d) => d.path)) : {};
    const devices = buildDeviceInventory({ lsblk: disks, byId, smart: smartMap, mounts, importable, pools: status });
    return { devices, importable, warnings, source: 'nsenter' };
  }

  async function pools() {
    const agent = await viaAgent('storage.zpool_status');
    if (agent && Array.isArray(agent.list) && Array.isArray(agent.status)) return { list: agent.list, status: agent.status, error: agent.error || null, source: 'agent' };
    const [l, s] = await Promise.all([zpoolList(), zpoolStatus()]);
    return { list: l.pools, status: s, error: l.error || null, source: 'nsenter' };
  }

  async function datasets() {
    const agent = await viaAgent('storage.zfs_list');
    if (agent && Array.isArray(agent.datasets) && Array.isArray(agent.snapshots)) return { datasets: agent.datasets, snapshots: agent.snapshots, error: agent.error || null, source: 'agent' };
    const [d, s] = await Promise.all([zfsList(), zfsSnapshots()]);
    return { datasets: d.datasets, snapshots: s.snapshots, error: d.error || s.error || null, source: 'nsenter' };
  }

  /* -------------------------------- incus -------------------------------- */

  async function incusStoragePools() {
    const r = await exec(['incus', 'storage', 'list', '--format', 'json'], { timeoutMs: 30000 });
    return r.status === 0 ? parseIncusStoragePools(r.stdout) : [];
  }

  async function incusInstances() {
    let r = await exec(['incus', 'list', '--all-projects', '--format', 'json'], { timeoutMs: 60000, maxCapture: 64 * 1024 * 1024 });
    if (r.status !== 0) r = await exec(['incus', 'list', '--format', 'json'], { timeoutMs: 60000, maxCapture: 64 * 1024 * 1024 });
    return r.status === 0 ? parseIncusInstances(r.stdout) : [];
  }

  async function incusDefaultProfileRoot() {
    const r = await exec(['incus', 'query', '/1.0/profiles/default'], { timeoutMs: 30000 });
    if (r.status !== 0) return null;
    try {
      const j = JSON.parse(r.stdout);
      const root = Object.entries(j.devices || {}).find(([, d]) => d && d.type === 'disk' && d.path === '/');
      return root ? { name: root[0], pool: root[1].pool || null } : null;
    } catch { return null; }
  }

  async function incusSnapshotForm() {
    const r = await exec(['incus', 'snapshot', 'create', '--help'], { timeoutMs: 15000 });
    return r.status === 0 && !/unknown command/i.test(r.stderr) ? 'sub' : 'legacy';
  }

  /* ------------------------------ host files ----------------------------- */

  async function readFile(path, { maxBytes = 512 * 1024 } = {}) {
    const r = await sh('test -f "$1" && head -c "$2" -- "$1"', [path, String(maxBytes)], { timeoutMs: 15000 });
    return r.status === 0 ? r.stdout : null;
  }

  async function listDir(path) {
    const r = await sh('test -d "$1" && ls -1 -- "$1"', [path], { timeoutMs: 15000 });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  }

  async function unitState(unit) {
    const r = await exec(['systemctl', 'show', unit, '-p', 'ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec,Result,ExecMainStatus'], { timeoutMs: 15000 });
    if (r.status !== 0) return { unit, present: false };
    const out = { unit, present: true };
    for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i)] = line.slice(i + 1); }
    if (out.UnitFileState === '' || out.UnitFileState == null) out.present = false;
    return out;
  }

  async function toolchain() {
    const names = ['zpool', 'zfs', 'smartctl', 'sanoid', 'syncoid', 'wipefs', 'lsblk', 'incus'];
    const out = {};
    for (const n of names) out[n] = await hasBinary(n);
    const mod = await sh('test -d /sys/module/zfs', [], { timeoutMs: 5000 });
    out.zfs_module_loaded = mod.status === 0;
    let version = null;
    if (out.zfs) { const v = await exec(['zfs', 'version'], { timeoutMs: 10000 }); version = v.status === 0 ? v.stdout.trim().split('\n')[0] : null; }
    out.zfs_version = version;
    const [sanoidTimer, scrubTpl, syncoidTpl] = await Promise.all([unitState('sanoid.timer'), unitState('proxypilot-zfs-scrub@.timer'), unitState('proxypilot-syncoid@.service')]);
    out.sanoid_timer = sanoidTimer;
    out.scrub_timer_installed = !!scrubTpl.present;
    out.syncoid_unit_installed = !!syncoidTpl.present;
    out.replicate_helper = (await sh('test -x "$1"', [REPLICATE_BIN], { timeoutMs: 5000 })).status === 0;
    out.restore_helper = (await sh('test -x "$1"', [RESTORE_HELPER], { timeoutMs: 5000 })).status === 0;
    return out;
  }

  /* ---------------------------- host preflight --------------------------- */

  /**
   * The host-wide facts that decide whether a disk is safe to take. lsblk
   * cannot answer any of them: a stopped md array still has a superblock, an
   * fstab line for a disk that failed to mount leaves no trace in the mount
   * table, and an EFI boot entry lives in NVRAM.
   */
  async function safetyFacts(devices = []) {
    const [fstabTxt, mdstatTxt, efiRes, swapRes] = await Promise.all([
      readFile('/etc/fstab', { maxBytes: 64 * 1024 }),
      readFile('/proc/mdstat', { maxBytes: 64 * 1024 }),
      exec(['efibootmgr', '-v'], { timeoutMs: 15000 }),
      exec(['swapon', '--noheadings', '--raw', '--show=NAME'], { timeoutMs: 10000 }),
    ]);
    // mdadm --examine per whole disk and partition: the only way to see a
    // superblock belonging to an array that is not currently assembled.
    const raid = {};
    if (await hasBinary('mdadm')) {
      const targets = devices.flatMap((d) => [d.path, ...(d.partitions || []).map((p) => p.path)]);
      for (const t of targets) {
        // eslint-disable-next-line no-await-in-loop
        const r = await exec(['mdadm', '--examine', t], { timeoutMs: 15000 });
        raid[t] = hasRaidSuperblock(r.stdout, r.status);
      }
    }
    const swaps = (swapRes.status === 0 ? swapRes.stdout : '').split('\n').map((s) => s.trim()).filter((s) => s.startsWith('/dev/'));
    return {
      fstab: parseFstab(fstabTxt || ''),
      mdstat: parseMdstat(mdstatTxt || ''),
      efi: efiRes.status === 0 ? parseEfiBootEntries(efiRes.stdout) : [],
      raid, swaps,
      mdadm_checked: Object.keys(raid).length > 0,
      efi_checked: efiRes.status === 0,
    };
  }

  /** Per-device hard reasons and warnings from safetyFacts. */
  async function risksFor(devices) {
    const facts = await safetyFacts(devices);
    return { risks: deviceRisks({ devices, ...facts }), facts };
  }

  /**
   * A real ping, not an inference: agentReachable() is null until something
   * has called the agent, and the preflight's other reads go through nsenter.
   * The agent writes the install request, so a wrong answer here either
   * blocks a valid install or lets a doomed request through.
   */
  async function agentPing() {
    if (typeof agentCall !== 'function') return false;
    try { await agentCall('agent.ping', {}, { timeoutMs: 5000 }); agentKnown = true; return true; } catch { return false; }
  }

  /**
   * Does apt offer this package at all? On Debian and Ubuntu the ZFS packages
   * live in a component that is not enabled by default, so the answer is no on
   * a stock host and the install would die at the first apt-get.
   */
  async function aptCandidate(pkg) {
    const r = await exec(['apt-cache', 'policy', pkg], { timeoutMs: 20000 });
    if (r.status !== 0) return null;
    return parseAptCandidate(r.stdout);
  }

  async function osRelease() {
    return parseOsRelease(await readFile('/etc/os-release', { maxBytes: 16 * 1024 }) || '');
  }

  /** Is the root update runner in place? Privileged work is requested through it. */
  async function runnerState() {
    const [pathUnit, svc] = await Promise.all([unitState('proxypilot-update.path'), unitState('proxypilot-update.service')]);
    const sourceDir = (await readFile('/var/lib/proxypilot/update/source-dir', { maxBytes: 4096 }) || '').trim() || null;
    let scriptPresent = false;
    if (sourceDir) scriptPresent = (await sh('test -f "$1/scripts/install-storage.sh"', [sourceDir], { timeoutMs: 10000 })).status === 0;
    return {
      present: !!pathUnit.present && !!svc.present,
      enabled: /enabled/.test(pathUnit.UnitFileState || '') || /active|waiting/.test(pathUnit.ActiveState || ''),
      source_dir: sourceDir, script_present: scriptPresent,
    };
  }

  return {
    exec, sh, hasBinary, listDisks, pools, datasets, zfsSnapshots, zpoolImportScan, smartFor,
    safetyFacts, risksFor, osRelease, runnerState, agentPing, aptCandidate,
    incusStoragePools, incusInstances, incusDefaultProfileRoot, incusSnapshotForm,
    readFile, listDir, unitState, toolchain, agentReachable: () => agentKnown,
  };
}
