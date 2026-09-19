// ZFS storage — preflight. The PURE layer, two jobs:
//
//   1. INSTALL readiness. Can this host install and run the storage stack at
//      all, and what is already in place? Drives the Storage page's install
//      panel and the storage_preflight tool, and gates install_storage_toolchain.
//   2. DEVICE safety. The checks an operator would otherwise be told to SSH in
//      and run by hand before wiping a disk: is it an mdadm member, is it named
//      in /etc/fstab, does an EFI boot entry point at it, is its swap active.
//      lsblk alone does not answer these: an mdadm array that is merely stopped
//      still leaves a superblock, and an fstab line for a disk that failed to
//      mount leaves no trace in the mount table at all. Wiping either one
//      breaks the next boot, so the planner treats both as hard refusals.
//
// Native-free: text and parsed inventory in, plain objects out.

/* ------------------------------- helpers -------------------------------- */

const PASS = 'pass'; const WARN = 'warn'; const FAIL = 'fail'; const UNKNOWN = 'unknown';

function check(id, label, status, detail, remedy = null, blocking = false) {
  return { id, label, status, detail, remedy, blocking };
}

/* -------------------------------- fstab ---------------------------------- */

/**
 * /etc/fstab → [{ spec, target, fstype, options, line }], comments dropped.
 * `spec` keeps its original form: UUID=…, PARTUUID=…, LABEL=…, /dev/… .
 */
export function parseFstab(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [spec, target, fstype, options] = line.split(/\s+/);
    if (!spec || !target) continue;
    out.push({ spec, target, fstype: fstype || null, options: options || '', line });
  }
  return out;
}

/** Every identifier a device and its partitions can be named by in fstab. */
export function deviceIdentifiers(device) {
  const ids = new Set();
  const add = (v) => { if (v) ids.add(String(v)); };
  add(device.path);
  for (const l of device.by_id || []) add(l);
  for (const p of device.partitions || []) {
    add(p.path);
    for (const l of p.by_id || []) add(l);
    if (p.uuid) { add(`UUID=${p.uuid}`); add(`/dev/disk/by-uuid/${p.uuid}`); }
    if (p.partuuid) { add(`PARTUUID=${p.partuuid}`); add(`/dev/disk/by-partuuid/${p.partuuid}`); }
    if (p.label) { add(`LABEL=${p.label}`); add(`/dev/disk/by-label/${p.label}`); }
  }
  return [...ids];
}

/** fstab entries that name this device or one of its partitions. */
export function fstabReferences(entries, device) {
  const ids = new Set(deviceIdentifiers(device).map((s) => s.toLowerCase()));
  return (entries || []).filter((e) => ids.has(String(e.spec).toLowerCase()));
}

/* -------------------------------- mdstat --------------------------------- */

/**
 * /proc/mdstat → [{ name, state, level, members: [kernel names] }].
 * Only assembled arrays appear here; a stopped array leaves nothing, which is
 * why mdadm --examine is checked as well.
 */
export function parseMdstat(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^(md\d+)\s*:\s*(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const members = (m[4].match(/([A-Za-z0-9_.+-]+)\[\d+\]/g) || []).map((s) => s.replace(/\[\d+\]$/, ''));
    out.push({ name: m[1], state: m[2], level: m[3], members });
  }
  return out;
}

/** `mdadm --examine --scan <dev>` style output → true when a RAID superblock was found. */
export function hasRaidSuperblock(output, status) {
  if (status !== 0) return false;
  return /^\s*ARRAY\s/m.test(String(output || '')) || /Magic\s*:\s*a92b4efc/.test(String(output || ''));
}

/* ------------------------------ efibootmgr -------------------------------- */

/**
 * `efibootmgr -v` → [{ id, name, partuuid }] for entries that boot from a disk
 * partition. The PARTUUID inside HD(...) is what ties an entry to a device.
 */
export function parseEfiBootEntries(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^Boot([0-9A-Fa-f]{4})\*?\s+(.*)$/);
    if (!m) continue;
    const rest = m[2];
    const hd = rest.match(/HD\([^,]+,[^,]+,([0-9a-fA-F-]{36}|[0-9a-fA-F]{8,}),/);
    out.push({ id: m[1], name: rest.split('\t')[0].trim(), partuuid: hd ? hd[1].toLowerCase() : null, active: raw.includes('*') });
  }
  return out;
}

/** EFI boot entries whose partition lives on this device. */
export function efiEntriesForDevice(entries, device) {
  const partuuids = new Set((device.partitions || []).map((p) => (p.partuuid || '').toLowerCase()).filter(Boolean));
  return (entries || []).filter((e) => e.partuuid && partuuids.has(e.partuuid));
}

/* ---------------------------- device risk map ----------------------------- */

/**
 * Fold the host-wide reads into per-device risk. `raid` is
 * { [devicePath]: bool } from mdadm --examine, `mdstat` from parseMdstat,
 * `fstab` from parseFstab, `efi` from parseEfiBootEntries, `swaps` the list of
 * active swap device paths.
 *
 * Returns { [device.name]: { hard: [...], warnings: [...], details } }.
 * `hard` entries are merged into deviceEligibility's hard list, so a device
 * named in fstab or carrying RAID metadata can never be taken by a plan.
 */
export function deviceRisks({ devices = [], fstab = [], mdstat = [], raid = {}, efi = [], swaps = [] } = {}) {
  const out = {};
  const mdMembers = new Map();
  for (const md of mdstat) for (const m of md.members) mdMembers.set(m, md);
  for (const d of devices) {
    const hard = []; const warnings = [];
    const kernelNames = [d.name, ...(d.contains || [])];

    const assembled = kernelNames.map((n) => mdMembers.get(n)).find(Boolean);
    if (assembled) hard.push(`is a member of the assembled md array ${assembled.name} (${assembled.level}, ${assembled.state}) — stop it with mdadm first`);

    const raidPaths = [d.path, ...(d.partitions || []).map((p) => p.path)].filter((p) => raid[p]);
    if (raidPaths.length && !assembled) hard.push(`carries an mdadm RAID superblock on ${raidPaths.join(', ')} — the array is not assembled, but wiping is still destructive to it`);

    const refs = fstabReferences(fstab, d);
    if (refs.length) hard.push(`is referenced in /etc/fstab (${refs.map((r) => `${r.spec} → ${r.target}`).join('; ')}) — remove those lines first or the next boot fails`);

    const boots = efiEntriesForDevice(efi, d);
    if (boots.length) warnings.push(`an EFI boot entry points at this disk (${boots.map((b) => `Boot${b.id} ${b.name}`).join(', ')}); wiping removes that boot path`);

    const activeSwap = (d.partitions || []).map((p) => p.path).filter((p) => swaps.includes(p));
    if (activeSwap.length) hard.push(`has active swap on ${activeSwap.join(', ')} — swapoff first`);

    out[d.name] = { hard, warnings, fstab: refs, efi: boots, md: assembled || null, raid_superblock: raidPaths, active_swap: activeSwap };
  }
  return out;
}

/* ---------------------------- install preflight --------------------------- */

export const REQUIRED_PACKAGES = Object.freeze(['zfsutils-linux', 'smartmontools', 'sanoid']);
export const SUPPORTED_DISTROS = Object.freeze(['debian', 'ubuntu']);

/** /etc/os-release → { id, id_like, version_id, pretty_name }. */
export function parseOsRelease(text) {
  const kv = {};
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return { id: (kv.ID || '').toLowerCase() || null, id_like: (kv.ID_LIKE || '').toLowerCase() || null, version_id: kv.VERSION_ID || null, pretty_name: kv.PRETTY_NAME || null };
}

/**
 * The install readiness report.
 *   toolchain  host.toolchain()
 *   os         parseOsRelease(...)
 *   runner     { present, enabled, source_dir, script_present }
 *   agent      bool
 *   apt        bool
 */
export function installPreflight({ toolchain = {}, os = {}, runner = {}, agent = false, apt = false } = {}) {
  const checks = [];
  const distroOk = SUPPORTED_DISTROS.includes(os.id) || SUPPORTED_DISTROS.some((d) => (os.id_like || '').includes(d));

  checks.push(apt
    ? check('platform.apt', 'apt is available', PASS, 'apt-get found on the host')
    : check('platform.apt', 'apt is available', FAIL, 'apt-get was not found', 'The installer is apt based. Install zfsutils-linux, smartmontools and sanoid with this distribution\'s package manager, then re-run the preflight.', true));

  checks.push(distroOk
    ? check('platform.distro', 'Supported distribution', PASS, os.pretty_name || os.id || 'debian-like')
    : check('platform.distro', 'Supported distribution', WARN, os.pretty_name || os.id || 'unknown', 'install-storage.sh targets Debian and Ubuntu. It may still work, but package names are not guaranteed.'));

  checks.push(agent
    ? check('platform.agent', 'Host agent reachable', PASS, 'proxypilot-agent answers on its socket')
    : check('platform.agent', 'Host agent reachable', FAIL, 'the agent did not answer', 'systemctl restart proxypilot-agent on the host. The install request is written by the agent, so nothing can be requested without it.', true));

  checks.push(runner.present && runner.enabled
    ? check('platform.runner', 'Root update runner installed', PASS, 'proxypilot-update.path is enabled, so privileged requests are picked up')
    : check('platform.runner', 'Root update runner installed', FAIL, runner.present ? 'proxypilot-update.path is installed but not enabled' : 'proxypilot-update.path is not installed',
      'Run install.sh or update.sh once on the host. It installs the root runner that performs privileged work; without it the dashboard cannot install anything.', true));

  checks.push(runner.script_present
    ? check('platform.script', 'Installer script present', PASS, `${runner.source_dir || 'the recorded checkout'}/scripts/install-storage.sh`)
    : check('platform.script', 'Installer script present', FAIL, runner.source_dir ? `scripts/install-storage.sh not found under ${runner.source_dir}` : 'no ProxyPilot checkout is recorded',
      'Update ProxyPilot so the checkout carries scripts/install-storage.sh, then re-run the preflight.', true));

  const zfsReady = !!toolchain.zpool && !!toolchain.zfs;
  checks.push(zfsReady
    ? check('zfs.tools', 'ZFS user tools', PASS, toolchain.zfs_version || 'zpool and zfs found')
    : check('zfs.tools', 'ZFS user tools', FAIL, 'zpool and zfs are not installed', 'Install the storage toolchain. Nothing on this page can create or read a pool until they are present.'));

  checks.push(toolchain.zfs_module_loaded
    ? check('zfs.module', 'ZFS kernel module', PASS, 'the zfs module is loaded')
    : check('zfs.module', 'ZFS kernel module', zfsReady ? FAIL : WARN, 'the zfs module is not loaded',
      'The installer loads it. On a distribution kernel that needs DKMS the build runs at install time, and a reboot may be required before the module appears.'));

  checks.push(toolchain.smartctl
    ? check('tools.smartctl', 'SMART tools', PASS, 'smartctl found, drive health is collected')
    : check('tools.smartctl', 'SMART tools', WARN, 'smartctl is not installed', 'Without it every drive shows SMART as unknown. The installer adds smartmontools.'));

  checks.push(toolchain.sanoid
    ? check('tools.sanoid', 'Snapshot retention', PASS, 'sanoid found')
    : check('tools.sanoid', 'Snapshot retention', WARN, 'sanoid is not installed', 'Scheduled snapshots and their pruning need it. The installer adds sanoid.'));

  checks.push(toolchain.syncoid
    ? check('tools.syncoid', 'Replication', PASS, 'syncoid found')
    : check('tools.syncoid', 'Replication', WARN, 'syncoid is not installed', 'Off-host replication needs it. It ships with the sanoid package.'));

  const unitsOk = !!toolchain.scrub_timer_installed && !!toolchain.syncoid_unit_installed;
  checks.push(unitsOk
    ? check('proxypilot.units', 'ProxyPilot units', PASS, 'the scrub and replication units are installed')
    : check('proxypilot.units', 'ProxyPilot units', WARN, 'the scrub and replication systemd units are missing', 'The installer adds them. Monthly scrubs and scheduled replication depend on them.'));

  const helpersOk = !!toolchain.replicate_helper && !!toolchain.restore_helper;
  checks.push(helpersOk
    ? check('proxypilot.helpers', 'ProxyPilot helpers', PASS, 'the replication and guest-restore helpers are installed')
    : check('proxypilot.helpers', 'ProxyPilot helpers', WARN, 'the helper scripts are missing', 'The installer adds them. Running a replication job or restoring a guest from a ZFS snapshot needs them.'));

  const blockingFailures = checks.filter((c) => c.blocking && c.status === FAIL);
  const summary = { pass: checks.filter((c) => c.status === PASS).length, warn: checks.filter((c) => c.status === WARN).length, fail: checks.filter((c) => c.status === FAIL).length };
  const missing = [];
  if (!toolchain.zpool || !toolchain.zfs) missing.push('zfsutils-linux');
  if (!toolchain.smartctl) missing.push('smartmontools');
  if (!toolchain.sanoid || !toolchain.syncoid) missing.push('sanoid');
  // An unloaded module is work to do even when every package is present: the
  // installer runs modprobe, and a DKMS build may simply not have finished.
  // Leaving it out of install_needed contradicted `ready`, which requires it.
  const moduleLoaded = !!toolchain.zfs_module_loaded;
  const needed = missing.length > 0 || !unitsOk || !helpersOk || !moduleLoaded;

  return {
    checks,
    summary,
    can_install: blockingFailures.length === 0,
    blocked_by: blockingFailures.map((c) => ({ id: c.id, detail: c.detail, remedy: c.remedy })),
    ready: zfsReady && moduleLoaded && unitsOk && helpersOk,
    install_needed: needed,
    missing_packages: missing,
    reinstall_only: missing.length === 0 && needed,
    module_loaded: moduleLoaded,
    script: 'scripts/install-storage.sh',
  };
}
