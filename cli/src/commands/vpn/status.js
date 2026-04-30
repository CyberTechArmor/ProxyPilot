import { readVpnConfig, WG_DEFAULT_PORT, WG_DEFAULT_CIDR, WG_DEFAULT_DNS, WG_INTERFACE } from '../../core/vpn/index.js';
import { list as fwList } from '../../core/firewall/index.js';
import { dumpPeers } from '../../core/vpn/status.js';
import * as output from '../../output.js';

/**
 * Surface the persisted VPN server config plus a snapshot of the live
 * wg0 interface. Backend-friendly: emits a single JSON object that the
 * dashboard's server-status card can render without joining across two
 * other commands. The base-wireguard firewall rule state is included
 * so the panel can warn when udp/51820 is closed but the VPN was
 * enabled.
 *
 * `enabled` reflects whether `vpn enable` has been run (the SQLite row
 * exists). The interface might still be down if the systemd unit failed;
 * `interface_up` is the live `wg show` probe.
 */
export async function statusCommand(_opts, globalOpts) {
  try {
    const cfg = readVpnConfig();
    const enabled = !!cfg;

    let baseWgRule = null;
    try {
      const all = fwList('all');
      baseWgRule = all.find(r => r.id === 'base-wireguard') ?? null;
    } catch {
      // Firewall state not initialised yet; non-fatal.
    }

    // `wg show <iface>` exits non-zero (and dumpPeers returns an empty
    // Map) when the interface doesn't exist, so we probe directly with
    // `ip link show` to distinguish "no peers" from "interface down".
    let interfaceUp = false;
    let livePeerCount = 0;
    try {
      const { spawnSync } = await import('node:child_process');
      const link = spawnSync('ip', ['link', 'show', WG_INTERFACE], { encoding: 'utf-8' });
      interfaceUp = link.status === 0;
      if (interfaceUp) {
        const dump = dumpPeers(WG_INTERFACE);
        livePeerCount = dump.size;
      }
    } catch {
      interfaceUp = false;
    }

    const payload = {
      ok: true,
      enabled,
      interface: WG_INTERFACE,
      interface_up: interfaceUp,
      live_peer_count: livePeerCount,
      endpoint: cfg?.endpoint ?? null,
      listen_port: cfg?.listen_port ?? WG_DEFAULT_PORT,
      cidr: cfg?.cidr ?? WG_DEFAULT_CIDR,
      dns: cfg?.dns ?? WG_DEFAULT_DNS,
      default_iface: cfg?.default_iface ?? null,
      server_public_key: cfg?.server_public_key ?? null,
      base_wireguard_rule: baseWgRule
        ? { enabled: !!baseWgRule.enabled, scope: baseWgRule.scope, source_cidrs: baseWgRule.source_cidrs ?? null }
        : null,
    };

    if (globalOpts.json) {
      output.json(payload);
      return;
    }

    if (!enabled) {
      output.info('VPN is not enabled. Run `proxypilot vpn enable --endpoint <host:port>` to set it up.');
      return;
    }
    output.info(`Endpoint        ${payload.endpoint}`);
    output.info(`Listen port     ${payload.listen_port}/udp`);
    output.info(`CIDR            ${payload.cidr}`);
    output.info(`DNS             ${payload.dns}`);
    output.info(`Default iface   ${payload.default_iface}`);
    output.info(`Server pubkey   ${payload.server_public_key}`);
    output.info(`Interface       ${payload.interface_up ? 'up' : 'down'} (${payload.live_peer_count} live peer(s))`);
    if (payload.base_wireguard_rule) {
      output.info(`base-wireguard  ${payload.base_wireguard_rule.enabled ? 'enabled' : 'DISABLED'} (scope=${payload.base_wireguard_rule.scope})`);
    } else {
      output.warn('base-wireguard firewall rule not found — run `proxypilot firewall scan` to refresh');
    }
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn status failed: ${e.message}`);
    process.exitCode = 1;
  }
}
