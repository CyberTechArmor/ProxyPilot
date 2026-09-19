// lib/storage/preflight.js — the checks that must run BEFORE anything is
// installed or any disk is taken. Two halves: install readiness, and the
// per-device safety facts the block layer cannot show (an unassembled mdadm
// superblock, an /etc/fstab line, an EFI boot entry, active swap).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFstab, deviceIdentifiers, fstabReferences, parseMdstat, hasRaidSuperblock, parseEfiBootEntries,
  efiEntriesForDevice, deviceRisks, parseOsRelease, installPreflight, REQUIRED_PACKAGES,
} from '../lib/storage/preflight.js';
import { deviceEligibility } from '../lib/storage/planner.js';
import { fixtureDevices } from './fixtures/storage/load.js';

const FSTAB = `# /etc/fstab
UUID=4c9b5458-8004-426b-a7cb-ee944f17ad64 /          ext4  defaults      0 1
UUID=2383-1531                            /boot/efi  vfat  umask=0077    0 1
UUID=388d3e7f-f8ae-42d3-9c72-2e81e925c20a none       swap  sw            0 0
/dev/sdf1                                 /mnt/usb   ext4  defaults,noauto 0 0
`;

const MDSTAT = `Personalities : [raid1]
md0 : active raid1 sde1[1] sdg1[0]
      1953382464 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`;

const EFI = `BootCurrent: 0001
Timeout: 1 seconds
BootOrder: 0001,0002
Boot0001* ubuntu	HD(1,GPT,2383a1b2-0000-4000-8000-000000000001,0x800,0x100000)/File(\\EFI\\ubuntu\\shimx64.efi)
Boot0002* rescue	HD(1,GPT,1ba1ed85-0000-4000-8000-000000000002,0x800,0x100000)/File(\\EFI\\BOOT\\BOOTX64.EFI)
`;

test('fstab: parsed, and every way a device can be named there is matched', () => {
  const rows = parseFstab(FSTAB);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].spec, 'UUID=4c9b5458-8004-426b-a7cb-ee944f17ad64');
  assert.equal(rows[0].target, '/');
  const { devices } = fixtureDevices();
  const osDisk = devices.find((d) => d.name === 'nvme0n1');
  const ids = deviceIdentifiers(osDisk);
  assert.ok(ids.includes('UUID=1A2B-3C4D'));
  assert.ok(ids.includes('/dev/disk/by-uuid/ddd') === false);
  assert.ok(ids.includes('/dev/nvme0n1'));
  // the USB disk is named by device path in fstab even though it is noauto
  const usb = devices.find((d) => d.name === 'sdf');
  assert.deepEqual(fstabReferences(rows, usb).map((r) => r.target), ['/mnt/usb']);
  assert.equal(fstabReferences(rows, devices.find((d) => d.name === 'sdc')).length, 0);
});

test('mdstat and mdadm --examine: an assembled array and a superblock with no array', () => {
  const md = parseMdstat(MDSTAT);
  assert.equal(md.length, 1);
  assert.deepEqual(md[0], { name: 'md0', state: 'active', level: 'raid1', members: ['sde1', 'sdg1'] });
  assert.equal(parseMdstat('Personalities : [raid1]\nunused devices: <none>\n').length, 0);
  assert.equal(hasRaidSuperblock('ARRAY /dev/md/0 metadata=1.2 UUID=abc', 0), true);
  assert.equal(hasRaidSuperblock('          Magic : a92b4efc\n', 0), true);
  assert.equal(hasRaidSuperblock('mdadm: No md superblock detected on /dev/sdc.', 1), false);
  assert.equal(hasRaidSuperblock('ARRAY something', 1), false, 'a non-zero exit is never a member');
});

test('efibootmgr: entries are tied to a device by the PARTUUID inside HD(...)', () => {
  const entries = parseEfiBootEntries(EFI);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'ubuntu');
  assert.equal(entries[1].partuuid, '1ba1ed85-0000-4000-8000-000000000002');
  const dev = { partitions: [{ partuuid: '1BA1ED85-0000-4000-8000-000000000002' }] };
  assert.deepEqual(efiEntriesForDevice(entries, dev).map((e) => e.name), ['rescue']);
  assert.equal(efiEntriesForDevice(entries, { partitions: [] }).length, 0);
});

test('deviceRisks: fstab, assembled arrays, stale superblocks and active swap are HARD; an EFI entry warns', () => {
  const { devices } = fixtureDevices();
  const risks = deviceRisks({
    devices,
    fstab: parseFstab(FSTAB),
    mdstat: parseMdstat(MDSTAT),
    raid: { '/dev/sdd': true },
    efi: parseEfiBootEntries(EFI),
    swaps: ['/dev/mapper/vg0-swap'],
  });
  // the USB disk is in fstab → hard, even though it is noauto and unmounted
  assert.match(risks.sdf.hard.join(), /referenced in \/etc\/fstab/);
  assert.match(risks.sdf.hard.join(), /\/mnt\/usb/);
  // sde1 is a member of the assembled md0 → hard, named through `contains`
  assert.match(risks.sde.hard.join(), /assembled md array md0 \(raid1, active\)/);
  // sdd carries a superblock with no array assembled → still hard
  assert.match(risks.sdd.hard.join(), /mdadm RAID superblock on \/dev\/sdd/);
  assert.ok(!/assembled md array/.test(risks.sdd.hard.join()), 'a stale superblock is not reported as a live array');
  // a blank disk is clean
  assert.deepEqual(risks.sdc.hard, []);
  assert.deepEqual(risks.sdc.warnings, []);
});

test('the planner refuses a disk on its risks, so a plan can never take one that breaks boot', () => {
  const { devices } = fixtureDevices();
  const blank = devices.find((d) => d.name === 'sdc');
  assert.equal(deviceEligibility(blank).eligible, true, 'clean before risks are attached');

  blank.risk = { hard: ['is referenced in /etc/fstab (UUID=abc → /srv) — remove those lines first or the next boot fails'], warnings: [] };
  const withFstab = deviceEligibility(blank, { wipe: true });
  assert.equal(withFstab.eligible, false, 'wipe: true does not override a boot-breaking reference');
  assert.match(withFstab.hard.join(), /\/etc\/fstab/);

  blank.risk = { hard: [], warnings: ['an EFI boot entry points at this disk (Boot0002 rescue); wiping removes that boot path'] };
  const withEfi = deviceEligibility(blank);
  assert.equal(withEfi.eligible, true, 'a boot entry warns, it does not block');
  assert.match(withEfi.warnings.join(), /EFI boot entry/);
});

test('os-release parsing, and install preflight blocks only on things that make an install impossible', () => {
  const os = parseOsRelease('PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n');
  assert.deepEqual(os, { id: 'ubuntu', id_like: 'debian', version_id: '24.04', pretty_name: 'Ubuntu 24.04.1 LTS' });

  const bare = { zpool: false, zfs: false, smartctl: false, sanoid: false, syncoid: false, zfs_module_loaded: false, scrub_timer_installed: false, syncoid_unit_installed: false, replicate_helper: false, restore_helper: false };
  const ready = { ...bare, zpool: true, zfs: true, smartctl: true, sanoid: true, syncoid: true, zfs_module_loaded: true, scrub_timer_installed: true, syncoid_unit_installed: true, replicate_helper: true, restore_helper: true, zfs_version: 'zfs-2.2.2' };
  const runner = { present: true, enabled: true, source_dir: '/root/ProxyPilot', script_present: true };

  // a fresh host: nothing installed, but the install CAN proceed
  const fresh = installPreflight({ toolchain: bare, os, runner, agent: true, apt: true });
  assert.equal(fresh.can_install, true);
  assert.equal(fresh.ready, false);
  assert.equal(fresh.install_needed, true);
  assert.deepEqual(fresh.missing_packages, REQUIRED_PACKAGES);
  assert.equal(fresh.reinstall_only, false);
  assert.deepEqual(fresh.blocked_by, []);
  assert.equal(fresh.checks.find((c) => c.id === 'zfs.tools').status, 'fail');
  assert.ok(fresh.checks.every((c) => c.status === 'pass' || c.remedy), 'anything not passing says how to fix it');

  // a ready host needs nothing
  const done = installPreflight({ toolchain: ready, os, runner, agent: true, apt: true });
  assert.equal(done.ready, true);
  assert.equal(done.install_needed, false);
  assert.deepEqual(done.missing_packages, []);
  assert.equal(done.summary.fail, 0);

  // packages present but ProxyPilot's own units missing → re-install, not a package install
  const partial = installPreflight({ toolchain: { ...ready, scrub_timer_installed: false, replicate_helper: false }, os, runner, agent: true, apt: true });
  assert.equal(partial.install_needed, true);
  assert.equal(partial.reinstall_only, true);
  assert.deepEqual(partial.missing_packages, []);

  // every package present but the kernel module not loaded, e.g. a DKMS build
  // awaiting a reboot: `ready` is false, so there IS work to do and the page
  // must not offer the quiet "nothing to install" affordance
  const noModule = installPreflight({ toolchain: { ...ready, zfs_module_loaded: false }, os, runner, agent: true, apt: true });
  assert.equal(noModule.ready, false);
  assert.equal(noModule.install_needed, true, 'an unloaded module is work to do');
  assert.equal(noModule.reinstall_only, true);
  assert.equal(noModule.module_loaded, false);
  assert.deepEqual(noModule.missing_packages, []);
  assert.equal(noModule.checks.find((c) => c.id === 'zfs.module').status, 'fail');

  // the four genuine blockers
  for (const [label, args] of [
    ['no apt', { toolchain: bare, os, runner, agent: true, apt: false }],
    ['no agent', { toolchain: bare, os, runner, agent: false, apt: true }],
    ['no runner', { toolchain: bare, os, runner: { ...runner, present: false, enabled: false }, agent: true, apt: true }],
    ['no script', { toolchain: bare, os, runner: { ...runner, script_present: false }, agent: true, apt: true }],
  ]) {
    const r = installPreflight(args);
    assert.equal(r.can_install, false, label);
    assert.equal(r.blocked_by.length >= 1, true, label);
    assert.ok(r.blocked_by.every((b) => b.remedy), `${label}: a blocker must carry its remedy`);
  }

  // an unsupported distribution warns but does not block: the operator may
  // have the packages by another route
  const arch = installPreflight({ toolchain: bare, os: parseOsRelease('ID=arch\nPRETTY_NAME="Arch Linux"\n'), runner, agent: true, apt: true });
  assert.equal(arch.can_install, true);
  assert.equal(arch.checks.find((c) => c.id === 'platform.distro').status, 'warn');
});

test('the service preflight probes the agent rather than assuming it, and the install refuses a blocked host', async () => {
  const { createStorageService } = await import('../lib/storage/service.js');
  const { fakeHost, fakeSettings } = await import('./fixtures/storage/load.js');
  const mk = (over = {}) => {
    const host = fakeHost();
    Object.assign(host, over);
    const st = fakeSettings();
    return { host, svc: createStorageService({ host, getSetting: st.getSetting, setSetting: st.setSetting }) };
  };

  // a host with nothing installed but everything needed to install
  const bare = mk({ toolchain: async () => ({ zpool: false, zfs: false, smartctl: false, sanoid: false, syncoid: false, zfs_module_loaded: false, scrub_timer_installed: false, syncoid_unit_installed: false, replicate_helper: false, restore_helper: false }), hasBinary: async () => true });
  const pf = await bare.svc.preflight();
  assert.equal(pf.can_install, true);
  assert.equal(pf.install_needed, true);
  assert.equal(pf.agent, true);
  assert.ok(pf.checks.length >= 10);

  // a dead agent BLOCKS, and is discovered by a ping rather than inferred
  const dead = mk({ agentPing: async () => false, toolchain: async () => ({ zpool: false, zfs: false }), hasBinary: async () => true });
  const blocked = await dead.svc.preflight();
  assert.equal(blocked.agent, false);
  assert.equal(blocked.can_install, false);
  assert.ok(blocked.blocked_by.some((b) => b.id === 'platform.agent'));
  const r = await dead.svc.installToolchain({ actor: 'admin', via: 'test' });
  assert.equal(r.refused, true);
  assert.match(r.error, /preflight is blocked/);

  // a fully installed host reports nothing to do, and the install says so
  const ready = mk({ hasBinary: async () => true, toolchain: async () => ({ zpool: true, zfs: true, smartctl: true, sanoid: true, syncoid: true, zfs_module_loaded: true, scrub_timer_installed: true, syncoid_unit_installed: true, replicate_helper: true, restore_helper: true, zfs_version: 'zfs-2.2.2' }) });
  const done = await ready.svc.preflight();
  assert.equal(done.ready, true);
  assert.equal(done.install_needed, false);
  const noop = await ready.svc.installToolchain({ actor: 'admin', via: 'test' });
  assert.equal(noop.refused, true);
  assert.equal(noop.already_installed, true);

  // preflight with devices carries the per-disk verdict the page renders
  const withDevices = await bare.svc.preflight({ devices: true });
  assert.ok(Array.isArray(withDevices.devices) && withDevices.devices.length > 0);
  const osDisk = withDevices.devices.find((d) => d.os);
  assert.ok(osDisk, 'the OS disk is identified');
  assert.equal(osDisk.eligibility.eligible, false);
  assert.equal(osDisk.eligibility_with_wipe, false, 'the OS disk is never takeable');
});

test('install status: the update phase model is not shown for an install, and a run with no state yet reads as queued', async () => {
  const { createStorageService } = await import('../lib/storage/service.js');
  const { fakeHost, fakeSettings } = await import('./fixtures/storage/load.js');
  const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  const build = (state, requestPresent) => {
    const host = fakeHost();
    host.readFile = async (p) => (p === '/run/proxypilot-update/request.json' && requestPresent ? '{"id":"x"}' : null);
    const st = fakeSettings();
    const svc = createStorageService({ host, getSetting: st.getSetting, setSetting: st.setSetting });
    // stand in for the runner state the self-update lib would read
    globalThis.__ppUpdateStatus = state;
    return svc;
  };

  // an install run in progress: update.sh's phase list and 7-phase total are
  // meaningless here, so they are dropped rather than rendered as "3 of 7"
  const svc = build(null, false);
  const raw = { id: ID, action: 'storage-install', status: 'running', phase: 'Installing storage toolchain', phase_index: 3, phase_total: 7, phases: [{ index: 0, label: 'Backing up database' }], terminal: false };
  const shaped = { ...raw, is_storage_install: true, phases: [], phase_index: null, phase_total: null };
  assert.deepEqual(shaped.phases, [], 'the update phase list is not carried into an install');
  assert.equal(shaped.phase, 'Installing storage toolchain', 'the phase text is kept');

  // the id has no state and the request is still waiting → queued, not lost
  const queued = await build(null, true).installStatus({ id: ID });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.terminal, false);
  assert.equal(queued.is_storage_install, true);
  assert.match(queued.phase, /Waiting for the host runner/);

  // no state and no pending request → say so plainly instead of timing out
  const lost = await build(null, false).installStatus({ id: ID });
  assert.equal(lost.status, 'unknown');
  assert.equal(lost.terminal, true);
  assert.match(lost.reason, /never recorded this id/);
  delete globalThis.__ppUpdateStatus;
});
