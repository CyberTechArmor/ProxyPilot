// Mock2 per-project managed bridge — host operations (Phase M4, ADR-010).
//
// Until M4 every project container shared one Incus bridge (M2/M3). M4 gives
// each project its OWN managed bridge `m2br<id>` with its own /24, so the
// nftables fence (firewall.js) and the filtering egress proxy (egress.js) can
// key deny/allow rules on a per-project source subnet — the enforcement the
// runner's safety story rests on (04-phased-plan §M4). The container's NIC is
// pinned to this bridge at launch (`incus launch … --network m2br<id>`), so
// eth0 is on the project subnet from birth; the bridge is torn down on archive
// and on delete.
//
// NAT is left ON (ensureNetworkNat would NAT it anyway — risk R2 — and the fence
// is the firewall's default-deny in FRONT of the NAT path, not NAT-off). DHCP is
// left ON so Incus's dnsmasq assigns the container address and serves DNS on the
// gateway (the container's resolver, allowed through the fence to the gateway
// only). The CLI's createNetwork REST pattern (cli/src/lxc/networking.js, survey
// §4/§13) is the reference; here we shell to the `incus network` CLI through the
// nsenter-aware runner (mock2/host.js, risk R3).
//
// The naming/subnet helpers are re-exported from the pure network-logic.js so a
// stub-first test can import them without pulling in any host machinery
// (risk R9). New host artifacts (the bridges) exist only on an enabled host
// (ADR-001) — a disabled host never imports this file.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh } from './host.js';
import { bridgeNameForProject, bridgeCidrForProject, gatewayForCidr } from './network-logic.js';

export { bridgeNameForProject, bridgeCidrForProject, gatewayForCidr };

// A shape guard for the shell — our derivation only ever produces m2br<int> and
// 10.x.y.0/24, but validate before interpolating so a corrupted stored value
// can never inject into a host command.
const SAFE_CIDR = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
const SAFE_NAME = /^m2br\d+$/;

// createProjectBridge — idempotent managed-bridge create. Returns
// { ok, existed, error }. "already exists" is success (a retried provision or a
// boot reconcile re-asserting the plan). Never throws.
export async function createProjectBridge({ name, cidr }) {
  if (!SAFE_NAME.test(String(name))) return { ok: false, error: `unsafe bridge name ${name}` };
  if (!SAFE_CIDR.test(String(cidr))) return { ok: false, error: `unsafe bridge cidr ${cidr}` };
  const gateway = gatewayForCidr(cidr);
  const prefix = String(cidr).split('/')[1] || '24';
  const r = await sh(
    `incus network create ${name} ipv4.address=${gateway}/${prefix} ipv4.nat=true ipv4.dhcp=true ipv6.address=none 2>&1`,
    { timeoutMs: 30000 },
  );
  if (r.code === 0) return { ok: true, existed: false };
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (/already exists/i.test(out)) return { ok: true, existed: true };
  return { ok: false, error: out.trim().slice(-400) };
}

// ensureHostEgress() — make the host actually forward + NAT the mock2 bridges
// out to the internet.
//
// Incus's ipv4.nat=true masquerades the bridge subnet, but two host-level things
// must also be true for a container's packets to reach the internet, and neither
// is guaranteed:
//   1. IPv4 forwarding must be enabled (net.ipv4.ip_forward=1). Incus usually
//      sets this, but a reboot / hardened sysctl can leave it off.
//   2. When ProxyPilot runs in Docker, dockerd sets the filter FORWARD chain
//      policy to DROP and only accepts its OWN bridges — so a non-Docker bridge
//      like m2br* is dropped when it tries to route out (this is the classic
//      "libvirt/incus bridge can't reach the internet on a Docker host"). Docker
//      provides the DOCKER-USER chain, evaluated BEFORE its drop, specifically
//      for user rules; an ACCEPT there for the m2br* interfaces lets them
//      forward. It does not weaken Docker's isolation of its own containers.
//
// Previously egress went to a host-side proxy (squid) that the container reached
// on the gateway (an INPUT to the host), so the FORWARD path never mattered.
// Now that egress is direct NAT it does. Idempotent + best-effort: everything is
// guarded (`-C` before `-I`, `|| true`) and a host without iptables/Docker just
// gets the sysctl. Never throws.
export async function ensureHostEgress() {
  // 1) IPv4 forwarding (runtime + persist so a reboot keeps it).
  await sh(
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true; '
    + "printf 'net.ipv4.ip_forward=1\\n' > /etc/sysctl.d/99-proxypilot-mock2.conf 2>/dev/null || true",
    { timeoutMs: 8000 },
  ).catch(() => {});

  // 2) If Docker's FORWARD drop is in play, allow the m2br* bridges through the
  //    DOCKER-USER hook. -i (traffic FROM a bridge, i.e. egress) is the one that
  //    matters; -o (return path) is added for completeness. Idempotent.
  const dockerUser = `
    if command -v iptables >/dev/null 2>&1 && iptables -t filter -L DOCKER-USER >/dev/null 2>&1; then
      iptables -C DOCKER-USER -i m2br+ -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i m2br+ -j ACCEPT
      iptables -C DOCKER-USER -o m2br+ -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -o m2br+ -j ACCEPT
      echo docker-user-applied
    fi
  `;
  const r = await sh(dockerUser, { timeoutMs: 12000 }).catch(() => ({ stdout: '' }));
  return { ok: true, dockerUser: /docker-user-applied/.test(r.stdout || '') };
}

// deleteProjectBridge — tear the bridge down (archive + delete). Tolerant: a
// missing bridge is success. The container MUST be gone first (Incus refuses to
// delete a network with instances attached) — the callers destroy it before
// calling this. Never throws.
export async function deleteProjectBridge(name) {
  if (!SAFE_NAME.test(String(name))) return { ok: false, error: `unsafe bridge name ${name}` };
  const r = await sh(`incus network delete ${name} 2>&1`, { timeoutMs: 30000 });
  if (r.code === 0) return { ok: true };
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (/not found|does not exist|doesn't exist/i.test(out)) return { ok: true, existed: false };
  return { ok: false, error: out.trim().slice(-400) };
}
