import crypto from 'node:crypto';

const RFC1918 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
const VPN_CIDR = '10.100.0.0/24';
const LOCALHOST_V4 = '127.0.0.0/8';
const LOCALHOST_V6 = '::1/128';

/**
 * The bridge subnet ProxyPilot LXC containers live on (config.network
 * defaults from cli/src/config.js). Egress rules gate flows from this
 * subnet to host-side services. If the operator changes the bridge
 * CIDR, egress rules must be regenerated — not in scope for this step.
 */
const LXC_BRIDGE_CIDR = '10.0.100.0/24';
// Host's address on the LXC bridge — the only target the
// container_egress chain restricts. External egress (DNS, internet,
// host's other interfaces) falls through to chain default-accept.
const LXC_BRIDGE_GW = '10.0.100.1';
// Bridge interface ProxyPilot creates for LXC containers. Hardcoded to
// match config.network.bridge_name in cli/src/config.js. Trusted at
// input — containers must reach the host's dnsmasq (DHCP UDP 67, DNS
// UDP/TCP 53) on this interface to obtain IPs and resolve names. Without
// this trust the host drops the very first DHCP DISCOVER and containers
// boot with no IPv4 forever. The egress restriction in container_egress
// (forward hook) still gates what containers can send OUT of the bridge.
const LXC_BRIDGE_IFACE = 'pp-br0';

/**
 * Named services the firewall manager knows how to gate. Each entry
 * is a host-side endpoint expressed as ip:port/proto. Allow rules in
 * container_egress reference these by name; the operator never types
 * addresses directly. Adding a service is a code change here, which
 * is intentional — services are part of the ProxyPilot platform, not
 * operator-curated.
 */
export const NAMED_SERVICES = {
  pgbouncer: { dst: '10.0.100.1', port: 6432, proto: 'tcp' },
};

/**
 * Resolve a rule's effective source restriction to a list of nft set
 * elements. `source_cidrs` overrides `scope` when present.
 */
function sourcesFor(rule) {
  if (rule.source_cidrs && rule.source_cidrs.length > 0) {
    return rule.source_cidrs;
  }
  switch (rule.scope) {
    case 'public':         return null; // any source
    case 'lan-only':       return RFC1918;
    case 'vpn-only':       return [VPN_CIDR];
    case 'localhost-only': return [LOCALHOST_V4];
    default:
      throw new Error(`unknown scope: ${rule.scope}`);
  }
}

function portMatch(rule) {
  if (rule.port_end && rule.port_end !== rule.port_start) {
    return `${rule.proto} dport ${rule.port_start}-${rule.port_end}`;
  }
  return `${rule.proto} dport ${rule.port_start}`;
}

function comment(rule) {
  const id = rule.id.replace(/"/g, '');
  const reason = (rule.reason ?? '').replace(/"/g, '');
  return `comment "${id}: ${reason}"`;
}

function renderAllowRule(rule) {
  const sources = sourcesFor(rule);
  const port = portMatch(rule);
  if (sources === null) {
    return `    ${port} accept ${comment(rule)}`;
  }
  // nft accepts an inline anonymous set { a, b, c }
  return `    ip saddr { ${sources.join(', ')} } ${port} accept ${comment(rule)}`;
}

/**
 * Render the full nft ruleset for `table inet proxypilot` from state.
 *
 * Layout:
 *   - base_input:        base allowlist + loopback + ct-state + ICMP
 *   - discovered_input:  enabled discovered + manual rules
 *   - container_egress:  per-container egress (placeholder this step)
 *   - nat_postrouting:   NAT (placeholder; populated when VPN lands)
 *
 * The host's main `input` chain is wired into base_input + discovered_input
 * once at install time; this function does NOT touch that chain.
 */
/**
 * Render the container_egress chain body.
 *
 * Default-deny for the LXC bridge to host: any flow from
 * 10.0.100.0/24 destined for the host (the bridge gateway IP plus
 * loopback) is dropped unless an allow rule matches first. Allow
 * rules are per-(container_ip, service) — the container_ip is
 * resolved by ProxyPilot when the container is created (out of scope
 * here; in this step we trust state.container_egress[].container_ip).
 *
 * Until containers register their bridge IP, allow rules use the
 * full bridge CIDR, which is permissive but no worse than today.
 */
/**
 * Render the nat_postrouting chain body.
 *
 * The only consumer today is the VPN module: when enabled, it sets
 * state.nat.vpn_masquerade_iface to the host's default-route interface
 * (e.g. "eth0") and the firewall manager emits a single MASQUERADE
 * line for the VPN subnet. The source CIDR is hard-coded to the VPN
 * subnet so the field can only widen NAT for VPN clients, never for
 * arbitrary sources.
 *
 * If the field is unset, the chain stays empty — same behaviour as
 * before this helper existed.
 */
function renderNatPostrouting(state) {
  const iface = state.nat?.vpn_masquerade_iface;
  if (!iface) return '    # (no NAT rules)';
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(iface)) {
    throw new Error(`invalid vpn_masquerade_iface: ${iface}`);
  }
  return `    oifname "${iface}" ip saddr ${VPN_CIDR} masquerade comment "vpn-masquerade"`;
}

function renderContainerEgress(state) {
  const lines = [];
  for (const entry of state.container_egress ?? []) {
    const src = entry.container_ip ? `${entry.container_ip}/32` : LXC_BRIDGE_CIDR;
    for (const svc of (entry.allow ?? [])) {
      const def = NAMED_SERVICES[svc];
      if (!def) {
        lines.push(`    # unknown service '${svc}' for container '${entry.container}'`);
        continue;
      }
      lines.push(
        `    ip saddr ${src} ip daddr ${def.dst} ${def.proto} dport ${def.port} accept ` +
        `comment "egress: ${entry.container}->${svc}"`,
      );
    }
  }
  // Default-deny tail: bridge → host services that weren't allowed
  // above get dropped. Scoped to `daddr 10.0.100.1` (the host's
  // bridge interface) so external egress — DNS, package mirrors,
  // upstream APIs the LXC's apps depend on — falls through to chain
  // default-accept. Without this scope every LXC outbound packet was
  // dropped, which broke DHCP renewal, container startup scripts,
  // and made Caddy-proxied LXC services time out on any backend that
  // reached out (a 3-4s page-load stall the operator could see).
  // Inter-container traffic on the bridge is unaffected — the Linux
  // bridge handles it before it ever hits this forward-hook chain.
  lines.push(`    ip saddr ${LXC_BRIDGE_CIDR} ip daddr ${LXC_BRIDGE_GW} drop`);
  return lines.join('\n');
}

export function render(state) {
  const enabledBase = state.base.filter(r => r.enabled);
  const enabledDiscovered = state.discovered.filter(r => r.enabled);

  // Loopback, ct state, and ICMP are handled in input_hook before we
  // jump here, so base_input only carries the operator-facing
  // allowlist. Keeping it focused makes diffs and audit reads easier.
  const baseInputBody = enabledBase.length
    ? enabledBase.map(renderAllowRule).join('\n')
    : '    # (no enabled base rules)';

  const discoveredInputBody = enabledDiscovered.length
    ? enabledDiscovered.map(renderAllowRule).join('\n')
    : '    # (no enabled discovered rules)';

  const containerEgressBody = renderContainerEgress(state);
  const natPostroutingBody = renderNatPostrouting(state);

  // The leading `add table` + `flush table` pair makes the apply
  // idempotent: it creates the table on first run and empties every
  // chain on subsequent runs, so the redeclaration below replaces the
  // old ruleset rather than appending to it. nft applies the whole file
  // in one transaction, so the firewall is never half-flushed.
  const ruleset = `# Generated by ProxyPilot firewall manager. Do not edit by hand.
# Source of truth: /var/lib/proxypilot/firewall.json
add table inet proxypilot
flush table inet proxypilot

table inet proxypilot {
  # input_hook is the only chain in our table that's hooked into the
  # network stack. It runs at priority filter-10, i.e. before any
  # filter/input chain the operator may have. We jump into base_input
  # and discovered_input; anything not accepted falls off the end and
  # is dropped by the policy. Loopback, ct established/related, and
  # ICMP rate-limit are pre-jumps so they short-circuit before our
  # allowlist. This gives ProxyPilot default-deny semantics without
  # touching any chain outside its own table.
  chain input_hook {
    type filter hook input priority filter - 10; policy drop;
    iif lo accept
    iif "${LXC_BRIDGE_IFACE}" accept
    ct state established,related accept
    ct state invalid drop
    ip protocol icmp icmp type echo-request limit rate 5/second accept
    ip6 nexthdr icmpv6 icmpv6 type echo-request limit rate 5/second accept
    jump base_input
    jump discovered_input
  }

  chain base_input {
${baseInputBody}
  }

  chain discovered_input {
${discoveredInputBody}
  }

  chain container_egress {
    type filter hook forward priority 0;
${containerEgressBody}
  }

  chain nat_postrouting {
    type nat hook postrouting priority 100;
${natPostroutingBody}
  }
}
`;

  return ruleset;
}

/**
 * Stable checksum of the rendered ruleset. Logged on every reconcile so
 * drift between state and live can be detected without diffing rules
 * directly.
 */
export function checksum(ruleset) {
  return 'sha256:' + crypto.createHash('sha256').update(ruleset).digest('hex');
}
