import { isIP } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { render } from './render.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const ROUTE = /^[A-Za-z0-9-]{1,100}$/;
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const BRIDGE = /^[A-Za-z0-9_.-]{1,15}$/;
const INCUS_GATE_DIR = '/etc/systemd/system/incus.service.d';
const INCUS_GATE_FILE = `${INCUS_GATE_DIR}/proxypilot-ingress.conf`;
const INCUS_GATE = `[Unit]\nRequires=proxypilot-firewall-reconcile.service\nAfter=proxypilot-firewall-reconcile.service\n\n[Service]\nExecStartPre=/usr/local/bin/proxypilot firewall ingress boot-check\n`;

// On reboot Incus must not start protected guests before the firewall's
// boot-time reconcile succeeds. Installing this dependency does not restart
// Incus or any guest in the current boot.
export function ensureIngressBootGate({ dir = INCUS_GATE_DIR, file = INCUS_GATE_FILE,
  reload = () => spawnSync('systemctl', ['daemon-reload'], { encoding: 'utf8', timeout: 15000 }) } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== INCUS_GATE)
    throw new Error('Incus boot dependency differs from the owned ingress gate');
  if (!fs.existsSync(file)) {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, INCUS_GATE, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temp, file);
  }
  const result = reload();
  if (result.status !== 0) throw new Error('systemd did not load the Incus firewall boot dependency');
  return file;
}

export function checkIngressRuleset(state, { check = ruleset => {
  const dir = fs.existsSync('/run') ? '/run/proxypilot' : os.tmpdir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `ingress-check-${process.pid}-${Date.now()}.nft`);
  fs.writeFileSync(file, ruleset, { mode: 0o600, flag: 'wx' });
  try { return spawnSync('nft', ['-c', '-f', file], { encoding: 'utf8', timeout: 15000 }); }
  finally { fs.unlinkSync(file); }
} } = {}) {
  const result = check(render(state));
  if (result.status !== 0) throw new Error(`nft rejected the proposed ingress fence: ${String(result.stderr || result.error?.message || 'unknown error').slice(0, 240)}`);
}

export async function bootCheckIngress({ read = null,
  nft = (family, table) => spawnSync('nft', ['list', 'table', family, table], { encoding:'utf8', timeout:15000 }) } = {}) {
  read ||= (await import('./state.js')).readState;
  const entries = read().protected_upstreams;
  if (!Array.isArray(entries) || !entries.length) throw new Error('Incus ingress boot gate has no recorded protected upstreams');
  const bridge = nft('bridge','proxypilot_ingress'), inet = nft('inet','proxypilot');
  if (bridge.status !== 0 || inet.status !== 0) throw new Error('Incus ingress boot gate has no live nftables fence');
  for (const entry of entries) {
    const tag = `pp-ingress-${entry.route_id}`;
    if (!bridge.stdout.includes(entry.mac) || !bridge.stdout.includes(tag) ||
        !inet.stdout.includes(entry.ipv4) || !inet.stdout.includes(entry.ipv6) || !inet.stdout.includes(tag))
      throw new Error(`Incus ingress boot gate lacks the exact fence for ${entry.route_id}`);
  }
  return { protected_upstreams: entries.length };
}

export function ingressGuestSnapshot(instance, runtime, { container, routeId, targetIp, port }) {
  if (!NAME.test(container) || !ROUTE.test(routeId) || isIP(targetIp) !== 4 || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('invalid protected upstream request');
  if (instance?.name !== `pp-${container}` || instance?.type !== 'container' || instance?.status !== 'Running')
    throw new Error('the exact managed LXC guest must be running');
  const uuid = instance.config?.['volatile.uuid'];
  const nic = instance.expanded_devices?.eth0;
  const bridge = nic?.network;
  const mac = String(nic?.hwaddr || instance.config?.['volatile.eth0.hwaddr'] || '').toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid || '') ||
      nic?.type !== 'nic' || !BRIDGE.test(bridge || '') || !MAC.test(mac))
    throw new Error('managed guest UUID, bridge or stable NIC identity is unavailable');
  const addresses = runtime?.network?.eth0?.addresses || [];
  const global = addresses.filter(a => a.scope === 'global');
  const ipv4 = global.filter(a => a.family === 'inet' && isIP(a.address) === 4).map(a => a.address);
  const ipv6 = global.filter(a => a.family === 'inet6' && isIP(a.address) === 6).map(a => a.address);
  if (ipv4.length !== 1 || ipv4[0] !== targetIp || ipv6.length !== 1)
    throw new Error('managed guest IPv4/IPv6 addresses do not match one stable NIC snapshot');
  return { route_id: routeId, container, uuid, bridge, mac, ipv4: targetIp, ipv6: ipv6[0], port };
}

export async function observeIngressGuest(input, { request = null } = {}) {
  const incus = request || (await import('../../incus/client.js')).incusRequest;
  const name = `pp-${input.container}`;
  const [instance, runtime] = await Promise.all([
    incus('GET', `/1.0/instances/${name}`),
    incus('GET', `/1.0/instances/${name}/state`),
  ]);
  return ingressGuestSnapshot(instance.metadata, runtime.metadata, input);
}

export async function protectIngress(input, { request = null, read = null, write = null,
  apply = null, bootGate = ensureIngressBootGate, auditRecord = null, validate = checkIngressRuleset } = {}) {
  if (!read || !write) {
    const state = await import('./state.js');
    read ||= state.readState; write ||= state.writeState;
  }
  apply ||= (await import('./reconcile.js')).reconcile;
  auditRecord ||= (await import('../../db/audit.js')).audit;
  const entry = await observeIngressGuest(input, { request });
  if (entry.uuid !== input.expectedUuid || entry.mac !== String(input.expectedMac || '').toLowerCase())
    throw new Error('managed guest identity changed after ingress review');
  const state = read();
  const existing = (state.protected_upstreams || []).find(e => e.route_id === entry.route_id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry))
    throw new Error('protected upstream identity changed; do not replace the fence while a route can use it');
  if (!existing) {
    state.protected_upstreams = [...(state.protected_upstreams || []), entry];
    validate(state);
    write(state);
  }
  bootGate();
  const result = await apply({ actor: 'pomerium-ingress' });
  if (!result.ok || !result.applied) throw new Error('host firewall did not reconcile the protected upstream');
  if (!existing) auditRecord({ subsystem: 'firewall', action: 'ingress-protect', resource: entry.route_id, after: entry });
  return { entry, checksum: result.checksum, already_recorded: !!existing };
}

export async function recordedIngress(routeId, { read = null } = {}) {
  if (!ROUTE.test(routeId)) throw new Error('invalid route id');
  read ||= (await import('./state.js')).readState;
  return (read().protected_upstreams || []).find(e => e.route_id === routeId) || null;
}

export async function removeIngress(routeId, { read = null, write = null, apply = null,
  validate = checkIngressRuleset, auditRecord = null, removeBootGate = removeIngressBootGate } = {}) {
  if (!ROUTE.test(routeId)) throw new Error('invalid route id');
  if (!read || !write) { const state = await import('./state.js'); read ||= state.readState; write ||= state.writeState; }
  apply ||= (await import('./reconcile.js')).reconcile;
  auditRecord ||= (await import('../../db/audit.js')).audit;
  const state = read(), before = (state.protected_upstreams || []).find(e => e.route_id === routeId);
  if (!before) throw new Error('no recorded ingress fence for this route');
  state.protected_upstreams = state.protected_upstreams.filter(e => e.route_id !== routeId);
  validate(state);
  write(state);
  const result = await apply({ actor: 'pomerium-ingress-remove' });
  if (!result.ok || !result.applied) throw new Error('host firewall did not reconcile ingress removal');
  if (!state.protected_upstreams.length) removeBootGate();
  auditRecord({ subsystem:'firewall',action:'ingress-remove',resource:routeId,before,after:null });
  return { removed:true, route_id:routeId, checksum:result.checksum, remaining:state.protected_upstreams.length };
}

export function removeIngressBootGate({ file = INCUS_GATE_FILE,
  reload = () => spawnSync('systemctl', ['daemon-reload'], { encoding:'utf8', timeout:15000 }) } = {}) {
  if (!fs.existsSync(file)) return;
  if (fs.readFileSync(file,'utf8') !== INCUS_GATE) throw new Error('Incus ingress boot dependency differs from the owned file');
  fs.unlinkSync(file);
  if (reload().status !== 0) throw new Error('systemd did not reload after ingress boot dependency removal');
}
