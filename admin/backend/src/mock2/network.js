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
