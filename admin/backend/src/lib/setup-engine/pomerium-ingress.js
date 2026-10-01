import { isIP } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digest, POMERIUM_ROOT, pomeriumError as fail } from './pomerium-logic.js';
import { atomicPrivate, readPrivate } from './pomerium-runtime.js';

const PP_BIN = process.env.PROXYPILOT_BIN || '/usr/local/bin/proxypilot';
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const IFACE = /^[A-Za-z0-9_.-]{1,15}$/;

async function hostJson(run, bin, args) {
  let r;
  try { r = await run(bin, args); }
  catch { throw fail(`The persistent host ingress fence cannot be inspected at ${bin} ${args[0]}; no policy may be applied.`); }
  if (r.status !== 0 || r.stdoutTruncated || r.stdoutComplete === false)
    throw fail(`The persistent host ingress fence cannot be inspected at ${bin} ${args[0]}; no policy may be applied.`);
  try { return JSON.parse(r.stdout); } catch { throw fail('Host ingress inspection returned invalid JSON.'); }
}

export function ingressSnapshot(instance, runtime, route) {
  const name = `pp-${route.lxc_container_name}`;
  if (instance?.name !== name || instance?.type !== 'container' || instance?.status !== 'Running')
    throw fail('The reviewed managed LXC identity is not running.');
  const nic = instance.expanded_devices?.eth0;
  const uuid = instance.config?.['volatile.uuid'];
  const mac = String(nic?.hwaddr || instance.config?.['volatile.eth0.hwaddr'] || '').toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid || '') || nic?.type !== 'nic' ||
      !IFACE.test(nic.network || '') || !MAC.test(mac))
    throw fail('Managed LXC UUID, bridge, or stable MAC could not be read.');
  const addresses = (runtime?.network?.eth0?.addresses || []).filter(a => a.scope === 'global');
  const v4 = addresses.filter(a => a.family === 'inet' && isIP(a.address) === 4).map(a => a.address);
  const v6 = addresses.filter(a => a.family === 'inet6' && isIP(a.address) === 6).map(a => a.address);
  if (v4.length !== 1 || v4[0] !== route.target_ip || v6.length !== 1)
    throw fail('Managed LXC address set changed; the IPv4/IPv6 fence cannot be bound.');
  return { route_id: route.id, container: route.lxc_container_name, uuid, bridge: nic.network,
    mac, ipv4: v4[0], ipv6: v6[0], port: route.target_port };
}

export async function readIngressGuest(route, run) {
  const name = `pp-${route.lxc_container_name}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(route.lxc_container_name || '')) throw fail('Invalid managed LXC name.');
  const [instance, runtime] = await Promise.all([
    hostJson(run, 'incus', ['query', `/1.0/instances/${name}`]),
    hostJson(run, 'incus', ['query', `/1.0/instances/${name}/state`]),
  ]);
  // incus query prints the metadata itself; HTTP adapters may retain the envelope.
  return ingressSnapshot(instance?.metadata ?? instance, runtime?.metadata ?? runtime, route);
}

export async function recordedHostIngress(entry, run) {
  const state = await hostJson(run, PP_BIN, ['--json', 'firewall', 'ingress', 'show', entry.route_id]);
  const recorded = state.entry;
  if (!recorded || digest(recorded) !== digest(entry)) return { installed: false, reason: 'Recorded host ingress identity is absent or changed.' };
  const [bridge, inet, service, timer, incusRequires, incusAfter] = await Promise.all([
    run('nft', ['list', 'table', 'bridge', 'proxypilot_ingress']),
    run('nft', ['list', 'table', 'inet', 'proxypilot']),
    run('systemctl', ['is-enabled', 'proxypilot-firewall-reconcile.service']),
    run('systemctl', ['is-active', 'proxypilot-firewall-reconcile.timer']),
    run('systemctl', ['show', 'incus.service', '--property=Requires', '--value']),
    run('systemctl', ['show', 'incus.service', '--property=After', '--value']),
  ]);
  const tag = `pp-ingress-${entry.route_id}`;
  const nftReady = bridge.status === 0 && inet.status === 0 &&
    bridge.stdout.includes(entry.mac) && bridge.stdout.includes(tag) &&
    inet.stdout.includes(entry.ipv4) && inet.stdout.includes(entry.ipv6) && inet.stdout.includes(tag);
  if (!nftReady || service.stdout.trim() !== 'enabled' || timer.stdout.trim() !== 'active' ||
      !incusRequires.stdout.includes('proxypilot-firewall-reconcile.service') ||
      !incusAfter.stdout.includes('proxypilot-firewall-reconcile.service'))
    return { installed: false, reason: 'Live nftables rules or boot/timer reconciliation are absent.' };
  return { installed: true, entry, bridge_table: 'bridge/proxypilot_ingress', inet_table: 'inet/proxypilot' };
}

export async function installHostIngress(entry, run) {
  const args = ['--json', 'firewall', 'ingress', 'protect', entry.route_id,
    '--container', entry.container, '--target-ip', entry.ipv4, '--port', String(entry.port),
    '--expected-uuid', entry.uuid, '--expected-mac', entry.mac];
  const result = await hostJson(run, PP_BIN, args);
  if (result.ok !== true) throw fail('Host ingress reconcile failed; route protection remains refused.');
  const observed = await recordedHostIngress(entry, run);
  if (!observed.installed) throw fail(observed.reason);
  return { ...observed, checksum: result.checksum };
}

export async function removeHostIngress(routeId, run) {
  const result = await hostJson(run, PP_BIN, ['--json', 'firewall', 'ingress', 'remove', routeId]);
  if (result.ok !== true || result.removed !== true) throw fail('Host ingress fence removal was not verified.');
  return result;
}

export function ingressCounterPackets(json, chain, tag) {
  const rules = (json.nftables || []).map(x => x.rule).filter(Boolean)
    .filter(x => x.chain === chain && x.comment === tag);
  if (!rules.length) throw fail(`Ingress counter ${chain} is missing; no bypass proof is accepted.`);
  return rules.reduce((n, rule) => n + rule.expr.reduce((m, part) => m + Number(part.counter?.packets || 0), 0), 0);
}

async function counter(run, family, chain, tag) {
  const table = family === 'bridge' ? 'proxypilot_ingress' : 'proxypilot';
  return ingressCounterPackets(await hostJson(run, 'nft', ['-j', 'list', 'table', family, table]), chain, tag);
}

async function command(run, bin, args) {
  const result = await run(bin, args);
  if (result.status !== 0) throw fail(`Ingress proof setup failed at ${bin} ${args[0]}; no policy may be applied.`);
  return result;
}

async function curl(run, prefix, address, port) {
  const url = `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}/`;
  const argv = [...prefix.slice(1), ...(prefix.length ? ['curl'] : []), '--silent', '--show-error', '--noproxy', '*',
    '--connect-timeout', '3', '--max-time', '6', '--output', '/dev/null', '--write-out', '%{http_code}', url];
  return run(prefix[0] || 'curl', argv);
}

export async function readIngressPeer(entry, peer, run) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(peer) || peer === entry.container)
    throw fail('A distinct managed peer guest is required for ingress proof.');
  const item = await hostJson(run, 'incus', ['query', `/1.0/instances/pp-${peer}`]);
  const instance = item?.metadata ?? item;
  if (instance?.name !== `pp-${peer}` || instance?.type !== 'container' ||
      instance?.status !== 'Running' || instance?.expanded_devices?.eth0?.network !== entry.bridge)
    throw fail('The selected proof guest is not a running peer on the same bridge.');
  return instance;
}

async function peerProbe(entry, peer, run, family) {
  await readIngressPeer(entry, peer, run);
  const tag = `pp-ingress-${entry.route_id}`;
  const before = await counter(run, 'bridge', 'switched', tag);
  const probe = await curl(run, ['incus', 'exec', `pp-${peer}`, '--'], family === 6 ? entry.ipv6 : entry.ipv4, entry.port);
  const after = await counter(run, 'bridge', 'switched', tag);
  if (probe.status === 0 || after <= before)
    throw fail(`Same-bridge IPv${family} bypass denial was not independently proved.`);
  return { source: `pp-${peer}`, family, curl_exit: probe.status, fence_packets: after - before };
}

async function routedProbe(entry, run, family) {
  const suffix = randomBytes(4).toString('hex');
  const ns = `ppp${suffix}`, host = `pph${suffix}`, guest = `ppg${suffix}`;
  const seed = parseInt(suffix.slice(0, 4), 16);
  const octet = 20 + (seed % 210), subnet = 18 + Math.floor(seed / 210) % 2;
  const host4 = `198.${subnet}.${octet}.1`, peer4 = `198.${subnet}.${octet}.2`;
  const host6 = `fd7a:7070:${suffix.slice(0, 4)}::1`, peer6 = `fd7a:7070:${suffix.slice(0, 4)}::2`;
  let nsCreated = false, linkCreated = false;
  try {
    await command(run, 'ip', ['netns', 'add', ns]); nsCreated = true;
    await command(run, 'ip', ['link', 'add', host, 'type', 'veth', 'peer', 'name', guest]); linkCreated = true;
    await command(run, 'ip', ['link', 'set', guest, 'netns', ns]);
    await command(run, 'ip', ['addr', 'add', `${host4}/30`, 'dev', host]);
    await command(run, 'ip', ['-6', 'addr', 'add', `${host6}/64`, 'dev', host, 'nodad']);
    await command(run, 'ip', ['link', 'set', host, 'up']);
    await command(run, 'ip', ['netns', 'exec', ns, 'ip', 'addr', 'add', `${peer4}/30`, 'dev', guest]);
    await command(run, 'ip', ['netns', 'exec', ns, 'ip', '-6', 'addr', 'add', `${peer6}/64`, 'dev', guest, 'nodad']);
    await command(run, 'ip', ['netns', 'exec', ns, 'ip', 'link', 'set', 'lo', 'up']);
    await command(run, 'ip', ['netns', 'exec', ns, 'ip', 'link', 'set', guest, 'up']);
    await command(run, 'ip', ['netns', 'exec', ns, 'ip', family === 6 ? '-6' : '-4', 'route', 'add',
      `${family === 6 ? entry.ipv6 : entry.ipv4}/${family === 6 ? 128 : 32}`, 'via', family === 6 ? host6 : host4]);
    const tag = `pp-ingress-${entry.route_id}${family === 6 ? '-v6' : ''}`;
    const before = await counter(run, 'inet', 'protected_upstream_forward', tag);
    const probe = await curl(run, ['ip', 'netns', 'exec', ns], family === 6 ? entry.ipv6 : entry.ipv4, entry.port);
    const after = await counter(run, 'inet', 'protected_upstream_forward', tag);
    if (probe.status === 0 || after <= before)
      throw fail(`Routed IPv${family} bypass denial was not independently proved.`);
    return { source: 'isolated routed network namespace', family, curl_exit: probe.status, fence_packets: after - before };
  } finally {
    let clean = true;
    if (linkCreated) {
      try { clean = (await run('ip', ['link', 'del', host])).status === 0 && clean; }
      catch { clean = false; }
    }
    if (nsCreated) {
      try { clean = (await run('ip', ['netns', 'del', ns])).status === 0 && clean; }
      catch { clean = false; }
    }
    if (!clean) throw fail('Temporary routed proof network cleanup failed; inspect host ip netns and veth state before any policy apply.');
  }
}

function proofPath(entry) { return join(POMERIUM_ROOT, `ingress-proof-${entry.route_id}.json`); }

export async function proveHostIngress(entry, peer, run) {
  const installed = await recordedHostIngress(entry, run);
  if (!installed.installed) throw fail(installed.reason);
  const checks = [];
  for (const family of [4, 6]) checks.push(await peerProbe(entry, peer, run, family));
  for (const family of [4, 6]) checks.push(await routedProbe(entry, run, family));
  const host = await curl(run, [], entry.ipv4, entry.port);
  const status = Number(host.stdout?.trim());
  if (host.status !== 0 || !(status >= 200 && status < 400))
    throw fail('Host Pomerium upstream access did not survive the ingress fence.');
  const evidence = { entry, entry_digest: digest(entry), checked_at: new Date().toISOString(),
    checks, host_upstream: { status }, policy_ready: true };
  atomicPrivate(proofPath(entry), JSON.stringify(evidence) + '\n');
  return evidence;
}

export async function verifiedHostIngress(entry, run, { maxAgeMs = 10 * 60 * 1000 } = {}) {
  const path = proofPath(entry);
  if (!existsSync(path)) throw fail('Independent host ingress proof is absent.');
  let proof;
  try { proof = JSON.parse(readPrivate(path)); } catch { throw fail('Independent host ingress proof cannot be read.'); }
  if (proof.entry_digest !== digest(entry) || proof.policy_ready !== true ||
      !Array.isArray(proof.checks) || proof.checks.length !== 4 ||
      !Number.isFinite(Date.parse(proof.checked_at)) ||
      Date.now() - Date.parse(proof.checked_at) > maxAgeMs || Date.parse(proof.checked_at) > Date.now() + 60000)
    throw fail('Independent host ingress proof is stale or does not match the guest.');
  const installed = await recordedHostIngress(entry, run);
  if (!installed.installed) throw fail(installed.reason);
  return { ...installed, proof };
}
