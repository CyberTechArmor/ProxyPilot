// A container always shares the host kernel. Workloads needing host-equivalent
// container privileges must be reprovisioned in a VM, never toggled in place.
export function unsafeGuestConfig(config = {}) {
  if (['true', '1'].includes(String(config['security.privileged']))) return 'Privileged containers are disabled; provision a VM and migrate the application';
  if (Object.keys(config).some(k => k.startsWith('raw.') && String(config[k] || '').trim())) return 'Raw hypervisor/container configuration is not supported by the isolation policy';
  return null;
}

export function profileIsolationError(profile) {
  if (!profile || typeof profile.config !== 'object' || !profile.devices || Array.isArray(profile.devices)) return 'Cannot verify the launch profile';
  const bad = unsafeGuestConfig(profile.config);
  if (bad) return bad;
  for (const [name, device] of Object.entries(profile.devices)) {
    if (device.type === 'nic' && (device.network || device.nictype === 'bridged')) continue;
    if (device.type === 'disk' && device.path === '/' && device.pool && !device.source) continue;
    return `Profile device ${name} is not a managed root disk or bridged NIC; use an isolated profile without host mounts or passthrough`;
  }
  return null;
}

export function guestIsolation(instance) {
  const config = instance?.expanded_config || instance?.config || {};
  const devices = instance?.expanded_devices || instance?.devices || {};
  const hostDevices = Object.entries(devices).filter(([, d]) =>
    (d.type === 'disk' && d.path !== '/' && !d.pool) || ['unix-char','unix-block','pci','gpu','usb','unix-hotplug'].includes(d.type)
  ).map(([name]) => name);
  const privileged = ['true','1'].includes(String(config['security.privileged']));
  const raw = Object.keys(config).filter(k => k.startsWith('raw.') && config[k]);
  const vm = instance?.type === 'virtual-machine';
  return {
    type: vm ? 'virtual-machine' : 'container',
    boundary: vm ? 'guest-kernel' : 'shared-host-kernel',
    privileged, host_devices: hostDevices, raw_config_keys: raw,
    migration_required: !vm && (privileged || raw.length > 0),
    review_required: hostDevices.length > 0 || raw.length > 0,
  };
}

export function sizeBytes(size) {
  const m = /^(\d+)(MB|MiB|GB|GiB|TB|TiB)$/.exec(String(size || ''));
  if (!m) return null;
  const units = { MB: 1e6, MiB: 2**20, GB: 1e9, GiB: 2**30, TB: 1e12, TiB: 2**40 };
  const value = Number(m[1]) * units[m[2]];
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
