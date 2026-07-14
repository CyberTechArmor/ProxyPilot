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
import { isIpv4, isEgressHost, isEgressPort } from './egress-logic.js';

export { bridgeNameForProject, bridgeCidrForProject, gatewayForCidr };

// resolveEgressHost(host) — turn a declared egress host into a routable IPv4, as
// seen FROM THE HOST. An IPv4 literal passes through; a hostname is resolved with
// `getent ahostsv4` on the host (through the nsenter-aware runner), so the IP the
// fence allows is the one the HOST would route to — not whatever the backend
// container's resolver returns (they can differ). Returns { ip, error }; ip is
// null on a resolution failure (never throws). The fence rules are IP-based, so a
// grant with no resolvable IP is never wired.
export async function resolveEgressHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!isEgressHost(h)) return { ip: null, error: 'invalid host' };
  if (isIpv4(h)) return { ip: h, error: null };
  // getent ahostsv4 prints "<ip> <flags> <name>" lines; take the first IPv4.
  const r = await sh(`getent ahostsv4 '${h}' 2>/dev/null | head -n1`, { timeoutMs: 8000 }).catch(() => null);
  const ip = String(r?.stdout || '').trim().split(/\s+/)[0] || '';
  if (!isIpv4(ip)) return { ip: null, error: 'no A record (from host)' };
  return { ip, error: null };
}

// probeHostReachable(host, port, timeoutMs) — can THE HOST route to host:port?
// The acceptance gate (#5): before wiring a grant into the fence, confirm the
// ProxyPilot HOST itself can reach the directory — if it can't, that is the
// blocker to report, not something to build around. The container's egress NATs
// through the host, so reachability MUST be measured from the host namespace —
// hence a bash `/dev/tcp` connect run through the nsenter-aware runner (not a
// Node socket, which would test the backend container's namespace instead).
// bash's own connect diagnostics are parsed into a stable status the grant stores
// in `reachable`:
//   'ok'          — handshake completed (host routes to it; the fence can carry it)
//   'refused'     — reached the host, port closed (routing works; app/port issue)
//   'timeout'     — no response in the budget (host-down or filtered upstream)
//   'unreachable' — no route to host / network unreachable
//   'dns_fail'    — the hostname did not resolve from the host
// Never throws. Returns { reachable, ip }.
export async function probeHostReachable(host, port, timeoutMs = 5000) {
  if (!isEgressPort(port)) return { reachable: 'unreachable', ip: null, error: 'invalid port' };
  const { ip, error } = await resolveEgressHost(host);
  if (!ip) return { reachable: 'dns_fail', ip: null, error };
  const secs = Math.max(1, Math.ceil((Number(timeoutMs) || 5000) / 1000));
  // `timeout` returns 124 on expiry; bash prints "Connection refused" /
  // "No route to host" / "Network is unreachable" / "timed out" to stderr.
  const probe = `timeout ${secs} bash -c 'exec 3<>/dev/tcp/${ip}/${Number(port)}' 2>&1; echo "RC=$?"`;
  const r = await sh(probe, { timeoutMs: (secs + 3) * 1000 }).catch((e) => ({ stdout: '', stderr: String(e?.message || '') }));
  const out = `${r?.stdout || ''}${r?.stderr || ''}`;
  const rc = (out.match(/RC=(\d+)/) || [])[1];
  let reachable;
  if (rc === '0') reachable = 'ok';
  else if (/connection refused/i.test(out)) reachable = 'refused';
  else if (/no route to host|network is unreachable|host is unreachable/i.test(out)) reachable = 'unreachable';
  else if (rc === '124' || /timed out|timeout/i.test(out)) reachable = 'timeout';
  else reachable = 'unreachable';
  return { reachable, ip };
}

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
