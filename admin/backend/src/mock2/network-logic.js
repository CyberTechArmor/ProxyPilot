// Mock2 network isolation — the PURE decision layer (Phase M4, ADR-010).
//
// Every M4 decision that can be made without better-sqlite3, Incus, or nftables
// lives here so it is unit-testable at the module boundary (stub-first, risk R9)
// — the same split the module already uses for domain-logic.js / project-logic.js
// / slug.js. This file imports NOTHING native; the host-acting shells
// (network.js, firewall.js, egress.js, port-check.js) each import their pure
// helpers from here.
//
// Contents:
//   * per-project bridge naming + /24 subnet derivation + gateway
//   * the nftables fence renderer (`table inet mock2`) + its plan builder
//   * the firewall egress-log parser (what each bridge reached)
//   * the manifest port-drift comparator
//
// EGRESS MODEL (post-squid): each project bridge reaches the internet directly
// via the bridge's own Incus NAT (ipv4.nat=true, network.js). The nftables fence
// (a) blocks lateral movement to RFC1918 / link-local ranges (other bridges, the
// host LAN, the control plane) and (b) LOGS every new outbound connection to the
// kernel log so operators can still see where each container's traffic goes. The
// old squid filtering proxy — which enforced a per-project HOSTNAME allowlist and
// sourced the traffic log — was removed (it was unreliable and heavy). Hostname
// allowlisting is not enforceable at the IP layer, so egress is now monitor-style
// (log, don't block by host); the firewall log replaces squid's access log.
//
// Terminology (risk R7): nothing here is named "agent".

// Private / link-local destination ranges a project bridge must NOT reach: this
// is what preserves isolation now that egress is NAT'd — a container may reach
// the public internet but not other project bridges, the host's LAN, or the
// control plane. Blocked (and logged) in the forward chain before the general
// egress accept.
export const PRIVATE_DEST_RANGES = Object.freeze([
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
]);

// Kernel-log prefixes the fence stamps on egress connections. The traffic-log
// parser keys off these; keep them short (the kernel truncates long prefixes).
export const EGRESS_LOG_PREFIX_OK = 'mock2-egress-ok';
export const EGRESS_LOG_PREFIX_DENY = 'mock2-egress-deny';

// ---- per-project bridge naming + subnet ----

export function bridgeNameForProject(id) {
  return `m2br${Number(id)}`;
}

// Per-project /24 out of 10.200.0.0 – 10.255.255.0 — no collision with the
// shared bridge (10.0.100.0/24), the VPN subnet (10.100.0.0/24), or common LANs.
// 56 × 256 = 14 336 distinct subnets before wrap (far past dev-plane scale, Q5),
// and a pure function of the id so it needs no allocator. Widen the block range
// here if a deployment ever needs more.
export function bridgeCidrForProject(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error(`bridgeCidrForProject: bad project id ${id}`);
  const block = 200 + (Math.floor((n - 1) / 256) % 56); // 200..255
  const third = (n - 1) % 256; // 0..255
  return `10.${block}.${third}.0/24`;
}

// Gateway (host side of the bridge) — the first host in the /24 (final octet 1).
export function gatewayForCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\/\d{1,2}$/.exec(String(cidr || ''));
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}.1`;
}

// ---- nftables fence (`table inet mock2`) ----

// buildFenceEntries(projects) — the per-project fence plan: one entry per LIVE
// project that has a bridge subnet, a container IP, and a declared web port.
// A project missing any of those (provisioning, archived, stopped, mid-launch)
// contributes nothing until the container is up and reconcile runs again.
export function buildFenceEntries(projects = []) {
  const entries = [];
  for (const p of projects) {
    if (!p || p.lifecycle !== 'active') continue;
    const cidr = p.bridge_cidr || (p.id ? bridgeCidrForProject(p.id) : null);
    const gateway = cidr ? gatewayForCidr(cidr) : null;
    if (!cidr || !gateway || !p.container_ip || !p.web_port) continue;
    entries.push({ id: Number(p.id), cidr, gateway, containerIp: p.container_ip, webPort: Number(p.web_port) });
  }
  return entries;
}

// renderMock2Nft(entries) — the full nft ruleset for `table inet mock2`. The
// add+flush pair makes `nft -f -` idempotent, scoped to OUR table so nothing
// else is flushed (see firewall.js for why a dedicated table).
//
// forward hook: established pass, inbound only to each declared web port, deny
// every other inbound to a container (Postgres 5432 etc. stay internal); then
// egress — block (and log) any attempt to reach a private/link-local range
// (other bridges, host LAN, control plane), and LOG + accept everything else so
// the bridge's Incus NAT carries it to the internet. input hook: each bridge may
// reach ONLY its own gateway for DNS / DHCP-renew, deny the rest (the control
// plane — host :3001, the main bridge, every other host IP).
export function renderMock2Nft(entries = []) {
  const fwd = [];
  const inp = [];
  const privateSet = `{ ${PRIVATE_DEST_RANGES.join(', ')} }`;
  for (const e of entries) {
    const tag = `mock2 p${e.id}`;
    // Inbound to the container: only the declared web port.
    fwd.push(`    ip daddr ${e.containerIp} tcp dport ${e.webPort} accept comment "${tag} web"`);
    fwd.push(`    ip daddr ${e.containerIp} drop comment "${tag} deny-inbound"`);
    // Egress: block + log lateral movement to private ranges, then log + allow
    // internet egress (Incus NAT masquerades it). The log rules match only
    // ct state new so a connection is recorded once, not per packet.
    fwd.push(`    ip saddr ${e.cidr} ip daddr ${privateSet} ct state new log prefix "${EGRESS_LOG_PREFIX_DENY} p${e.id}: " comment "${tag} deny-private-log"`);
    fwd.push(`    ip saddr ${e.cidr} ip daddr ${privateSet} drop comment "${tag} deny-private"`);
    fwd.push(`    ip saddr ${e.cidr} ct state new log prefix "${EGRESS_LOG_PREFIX_OK} p${e.id}: " comment "${tag} egress-log"`);
    fwd.push(`    ip saddr ${e.cidr} accept comment "${tag} egress"`);
    // Host-bound: only the bridge's own gateway, only for DNS + DHCP renew.
    inp.push(`    ip saddr ${e.cidr} ip daddr ${e.gateway} udp dport 53 accept comment "${tag} dns"`);
    inp.push(`    ip saddr ${e.cidr} ip daddr ${e.gateway} tcp dport 53 accept comment "${tag} dns"`);
    inp.push(`    ip saddr ${e.cidr} ip daddr ${e.gateway} udp dport 67 accept comment "${tag} dhcp"`);
    inp.push(`    ip saddr ${e.cidr} drop comment "${tag} deny-host"`);
  }
  const fwdBody = fwd.length ? fwd.join('\n') : '    # (no active project bridges)';
  const inpBody = inp.length ? inp.join('\n') : '    # (no active project bridges)';
  return `# Generated by ProxyPilot Mock2 (Phase M4, ADR-010). Do not edit by hand.
# A dedicated table so the CLI firewall's \`flush table inet proxypilot\` can
# never clobber it, and so a disabled host has no Mock2 nftables state at all.
add table inet mock2
flush table inet mock2

table inet mock2 {
  chain forward {
    type filter hook forward priority -10; policy accept;
    ct state established,related accept
    ct state invalid drop
${fwdBody}
  }

  chain input {
    type filter hook input priority -10; policy accept;
    ct state established,related accept
${inpBody}
  }
}
`;
}

// ---- firewall egress log (what each bridge reached) ----

// subnetPrefixForCidr('10.200.1.0/24') -> '10.200.1.' — the client-IP prefix used
// to pick a project's own rows out of the shared kernel egress log. Null on a
// malformed cidr.
export function subnetPrefixForCidr(cidr) {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\/\d{1,2}$/.exec(String(cidr || ''));
  return m ? `${m[1]}.` : null;
}

// parseNftEgressLog(text, subnetPrefix, limit) — PURE parser for the kernel log
// lines the nftables fence emits (stub-first testable, risk R9). Each matching
// line carries our prefix (EGRESS_LOG_PREFIX_OK / _DENY) followed by the packet
// fields nft's `log` statement prints, e.g.
//   "1700000000.123 host kernel: mock2-egress-ok p7: IN=m2br7 OUT=eth0 \
//    SRC=10.200.6.15 DST=140.82.112.3 ... PROTO=TCP SPT=51000 DPT=443 ..."
// We keep only lines whose SRC is in the project's /24 (subnetPrefix like
// '10.200.1.'), map each to the same {ts, client, action, method, url, denied}
// shape the UI already renders, newest last, capped at limit. The firewall only
// sees IP:port (no Host/SNI), so `url` is the destination "IP:port". Best-effort:
// a line that doesn't match the field shape is skipped, never throws.
export function parseNftEgressLog(text, subnetPrefix, limit = 200) {
  const out = [];
  if (!subnetPrefix) return out;
  for (const line of String(text || '').split('\n')) {
    if (line.indexOf(EGRESS_LOG_PREFIX_OK) === -1 && line.indexOf(EGRESS_LOG_PREFIX_DENY) === -1) continue;
    const src = /\bSRC=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(line);
    if (!src || !src[1].startsWith(subnetPrefix)) continue;
    const dst = /\bDST=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(line);
    const dpt = /\bDPT=(\d+)/.exec(line);
    const proto = /\bPROTO=(\w+)/.exec(line);
    const denied = line.indexOf(EGRESS_LOG_PREFIX_DENY) !== -1;
    // A leading "<seconds>.<micros>" from `journalctl -o short-unix`; may be absent.
    const tsM = /^\s*(\d{9,}(?:\.\d+)?)/.exec(line);
    const dest = dst ? dst[1] : '';
    out.push({
      ts: tsM ? Number(tsM[1]) : null,
      client: src[1],
      action: denied ? 'BLOCK' : 'OUT',
      status: null,
      method: proto ? proto[1] : '',            // TCP / UDP
      url: dest ? `${dest}${dpt ? `:${dpt[1]}` : ''}` : '',
      denied,
    });
  }
  const n = Number(limit) > 0 ? Number(limit) : 200;
  return out.slice(-n);
}

// ---- manifest port-drift (ADR-005 inbound half) ----

// Benign OS-plumbing ports a stock Debian/systemd container binds on all
// interfaces that are NOT the app's surface, so they must not raise port_drift
// (they are noise, not an exposed workload — the drift check exists to catch an
// undeclared APP port, ADR-005). systemd-resolved binds LLMNR on tcp+udp/5355
// and multicast DNS on udp/5353; the DHCP client holds udp/68 (v4) and the
// DHCPv6 client udp/546. These are the recurring false positives on the M4
// scan. An app that genuinely wants one of these must still declare it as `web`,
// so ignoring them here changes only the noise, never a routed port.
export const BENIGN_SYSTEM_TCP_PORTS = Object.freeze([5355]);
export const BENIGN_SYSTEM_UDP_PORTS = Object.freeze([68, 546, 5353, 5355]);

// computePortDrift({ declared, tcpAnyHost, udpAnyHost }) → the exposed ports the
// manifest does NOT account for. The declared web port is the only allowed
// publicly-bound TCP listener; every other non-loopback TCP bind is drift, and
// ANY non-loopback UDP bind is drift (the manifest declares no UDP). Loopback
// binds (in-container Postgres on 127.0.0.1:5432, ADR-008) never count, and the
// benign OS-plumbing ports above are filtered out as scan noise.
export function computePortDrift({ declared, tcpAnyHost = [], udpAnyHost = [] }) {
  const w = Number(declared);
  const tcp = tcpAnyHost.filter((p) => Number(p) !== w && !BENIGN_SYSTEM_TCP_PORTS.includes(Number(p)));
  const udp = udpAnyHost.filter((p) => !BENIGN_SYSTEM_UDP_PORTS.includes(Number(p)));
  return { tcp, udp, hasDrift: tcp.length > 0 || udp.length > 0 };
}
