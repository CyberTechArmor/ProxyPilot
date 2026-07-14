// Mock2 Phase M4 tests — the network-isolation pure decision layer.
//
// Stub-first (risk R9 / docs/known-issues.md): imports ONLY network-logic.js,
// which has NO native (better-sqlite3), Express, Incus, or nftables imports. The
// real bridge/fence host round-trip and the cross-table nftables matrix (risk R2)
// are exercised by scripts/mock2-m4-verify.sh on an enabled host — see
// docs/mock2/README.md.
//
// Egress model (post-squid): the bridge NATs out; the fence logs each new
// outbound connection and blocks lateral movement to private ranges.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bridgeNameForProject,
  bridgeCidrForProject,
  gatewayForCidr,
  buildFenceEntries,
  renderMock2Nft,
  subnetPrefixForCidr,
  parseNftEgressLog,
  computePortDrift,
  PRIVATE_DEST_RANGES,
  EGRESS_LOG_PREFIX_OK,
  EGRESS_LOG_PREFIX_DENY,
} from '../mock2/network-logic.js';
import { EGRESS_LOG_PREFIX_GRANT } from '../mock2/egress-logic.js';
import { buildContainerSetupScript } from '../mock2/template.js';

// ---- per-project bridge naming + subnet ----

test('bridgeNameForProject: m2br<id>', () => {
  assert.equal(bridgeNameForProject(1), 'm2br1');
  assert.equal(bridgeNameForProject('42'), 'm2br42');
});

test('bridgeCidrForProject: deterministic, collision-free /24s', () => {
  assert.equal(bridgeCidrForProject(1), '10.200.0.0/24');
  assert.equal(bridgeCidrForProject(2), '10.200.1.0/24');
  assert.equal(bridgeCidrForProject(256), '10.200.255.0/24');
  assert.equal(bridgeCidrForProject(257), '10.201.0.0/24');
  // Never collides with the shared bridge (10.0.100.0/24) or the VPN
  // (10.100.0.0/24) — the block starts at 10.200.
  for (const id of [1, 50, 300, 5000]) {
    assert.ok(/^10\.(2[0-5]\d)\./.test(bridgeCidrForProject(id)), `id ${id} in the 10.200+ block`);
  }
});

test('bridgeCidrForProject: distinct subnets for the first several hundred ids', () => {
  const seen = new Set();
  for (let id = 1; id <= 600; id++) {
    const c = bridgeCidrForProject(id);
    assert.ok(!seen.has(c), `duplicate subnet ${c} at id ${id}`);
    seen.add(c);
  }
});

test('bridgeCidrForProject: rejects a bad id', () => {
  assert.throws(() => bridgeCidrForProject(0));
  assert.throws(() => bridgeCidrForProject(-3));
});

test('gatewayForCidr: first host of the /24', () => {
  assert.equal(gatewayForCidr('10.200.5.0/24'), '10.200.5.1');
  assert.equal(gatewayForCidr('10.201.0.0/24'), '10.201.0.1');
  assert.equal(gatewayForCidr('not-a-cidr'), null);
});

// ---- fence plan + nft render ----

const activeProject = (over = {}) => ({
  id: 7, lifecycle: 'active', bridge_cidr: '10.200.6.0/24',
  container_ip: '10.200.6.15', web_port: 3000, ...over,
});

test('buildFenceEntries: only active projects with a full upstream are fenced', () => {
  const rows = [
    activeProject(),                                       // in
    activeProject({ id: 8, lifecycle: 'provisioning' }),  // out (not active)
    activeProject({ id: 9, container_ip: null }),         // out (no IP)
    activeProject({ id: 10, web_port: null }),            // out (no web port)
    activeProject({ id: 11, lifecycle: 'archived' }),     // out
  ];
  const entries = buildFenceEntries(rows);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: 7, cidr: '10.200.6.0/24', gateway: '10.200.6.1', containerIp: '10.200.6.15', webPort: 3000, egress: [],
  });
});

test('buildFenceEntries: derives the subnet when bridge_cidr is not stored', () => {
  const entries = buildFenceEntries([activeProject({ id: 3, bridge_cidr: null })]);
  assert.equal(entries[0].cidr, bridgeCidrForProject(3));
  assert.equal(entries[0].gateway, '10.200.2.1');
});

test('renderMock2Nft: dedicated table, NAT+logged egress, web-port-only inbound, gateway-only host access', () => {
  const nft = renderMock2Nft(buildFenceEntries([activeProject()]));
  // Dedicated table (not inet proxypilot) with the idempotent add+flush pair.
  assert.match(nft, /add table inet mock2/);
  assert.match(nft, /flush table inet mock2/);
  assert.match(nft, /table inet mock2 \{/);
  // Inbound to the declared web port is allowed; everything else to the
  // container is dropped (Postgres 5432 etc. stay internal).
  assert.match(nft, /ip daddr 10\.200\.6\.15 tcp dport 3000 accept/);
  assert.match(nft, /ip daddr 10\.200\.6\.15 drop/);
  // Egress: lateral movement to private ranges is blocked + logged, then the rest
  // is logged and accepted (the bridge NAT carries it out). No proxy hole.
  assert.match(nft, new RegExp(`ip saddr 10\\.200\\.6\\.0\\/24 ip daddr \\{ ${PRIVATE_DEST_RANGES.join(', ').replace(/[.]/g, '\\.')} \\} ct state new log prefix "${EGRESS_LOG_PREFIX_DENY} p7: "`));
  // deny-private REJECTS (not drops) so a policy-blocked connection fails fast
  // with "connection refused", distinguishable from a host-down timeout.
  assert.match(nft, /ip saddr 10\.200\.6\.0\/24 ip daddr \{ [^}]*10\.0\.0\.0\/8[^}]*\} reject with icmpx type admin-prohibited comment "mock2 p7 deny-private"/);
  assert.match(nft, new RegExp(`ip saddr 10\\.200\\.6\\.0\\/24 ct state new log prefix "${EGRESS_LOG_PREFIX_OK} p7: "`));
  assert.match(nft, /ip saddr 10\.200\.6\.0\/24 accept comment "mock2 p7 egress"/);
  assert.doesNotMatch(nft, /3128/);   // squid proxy hole is gone
  // Host access limited to DNS + DHCP on the OWN gateway; the control plane is
  // denied (no rule permits :3001, and a catch-all host-deny closes the subnet).
  assert.match(nft, /ip saddr 10\.200\.6\.0\/24 ip daddr 10\.200\.6\.1 udp dport 53 accept/);
  assert.match(nft, /ip saddr 10\.200\.6\.0\/24 drop comment "mock2 p7 deny-host"/);
  assert.doesNotMatch(nft, /3001/);
});

test('renderMock2Nft: forward + input hooks run before NAT (priority -10)', () => {
  const nft = renderMock2Nft(buildFenceEntries([activeProject()]));
  assert.match(nft, /hook forward priority -10/);
  assert.match(nft, /hook input priority -10/);
});

test('renderMock2Nft: no active bridges renders a placeholder, not an empty ruleset', () => {
  const nft = renderMock2Nft([]);
  assert.match(nft, /# \(no active project bridges\)/);
  assert.match(nft, /table inet mock2/);
});

test('renderMock2Nft: two projects cannot reach each other (private-range block + container drop)', () => {
  const a = activeProject({ id: 1, bridge_cidr: '10.200.0.0/24', container_ip: '10.200.0.5' });
  const b = activeProject({ id: 2, bridge_cidr: '10.200.1.0/24', container_ip: '10.200.1.5' });
  const nft = renderMock2Nft(buildFenceEntries([a, b]));
  // Each bridge's egress to any private range (which includes the OTHER bridge's
  // 10.200.x.0/24, inside 10.0.0.0/8) is rejected — so A can never reach B.
  assert.match(nft, /ip saddr 10\.200\.0\.0\/24 ip daddr \{ [^}]*10\.0\.0\.0\/8[^}]*\} reject with icmpx type admin-prohibited comment "mock2 p1 deny-private"/);
  assert.match(nft, /ip saddr 10\.200\.1\.0\/24 ip daddr \{ [^}]*10\.0\.0\.0\/8[^}]*\} reject with icmpx type admin-prohibited comment "mock2 p2 deny-private"/);
  // And B's container port is doubly covered by B's daddr-drop.
  assert.match(nft, /ip daddr 10\.200\.1\.5 drop/);
});

test('renderMock2Nft: an approved egress grant punches a scoped allow-hole BEFORE deny-private', () => {
  // The ADP acceptance case: ldaps to a host-LAN directory on :636. The grant
  // carries a resolved ip; it must appear (accept + grant-log) in the ruleset
  // BEFORE the deny-private reject, or the private block would swallow it first.
  const p = activeProject({ egress: [{ host: '192.168.10.5', ip: '192.168.10.5', port: 636, protocol: 'tcp' }] });
  const nft = renderMock2Nft(buildFenceEntries([p]));
  const grantAccept = nft.indexOf('ip daddr 192.168.10.5 tcp dport 636 accept');
  const grantLog = nft.indexOf(`${EGRESS_LOG_PREFIX_GRANT} p7`);
  const denyPrivate = nft.indexOf('mock2 p7 deny-private"');
  assert.ok(grantAccept > 0, 'grant accept rule present');
  assert.ok(grantLog > 0, 'grant log rule present');
  assert.ok(grantAccept < denyPrivate, 'grant allow-hole precedes the deny-private reject');
  assert.ok(grantLog < denyPrivate, 'grant log precedes the deny-private reject');
});

test('renderMock2Nft: an undeclared internal host stays blocked (no grant → deny-private catches it)', () => {
  const nft = renderMock2Nft(buildFenceEntries([activeProject()]));
  // No accept for an arbitrary internal host; the reject rule is the only fate.
  assert.doesNotMatch(nft, /ip daddr 192\.168\.10\.5 tcp dport 636 accept/);
  assert.match(nft, /ip daddr \{ [^}]*192\.168\.0\.0\/16[^}]*\} reject/);
});

// ---- firewall egress log parser ----

test('parseNftEgressLog: keeps only this subnet, parses SRC/DST/DPT/PROTO + denied', () => {
  const prefix = subnetPrefixForCidr('10.200.1.0/24');
  assert.equal(prefix, '10.200.1.');
  const log = [
    '1700000000.123 host kernel: mock2-egress-ok p2: IN=m2br2 OUT=eth0 SRC=10.200.1.5 DST=140.82.112.3 LEN=60 PROTO=TCP SPT=51000 DPT=443 WINDOW=1',
    '1700000001.000 host kernel: mock2-egress-deny p2: IN=m2br2 OUT= SRC=10.200.1.5 DST=192.168.1.10 LEN=60 PROTO=TCP SPT=51001 DPT=22 WINDOW=1',
    '1700000001.500 host kernel: mock2-egress-grant p2: IN=m2br2 OUT=eth0 SRC=10.200.1.5 DST=192.168.10.5 LEN=60 PROTO=TCP SPT=51002 DPT=636 WINDOW=1',
    '1700000002.000 host kernel: mock2-egress-ok p9: IN=m2br9 OUT=eth0 SRC=10.200.9.9 DST=1.1.1.1 PROTO=UDP SPT=5 DPT=53', // different subnet
    'some unrelated kernel line',
  ].join('\n');
  const entries = parseNftEgressLog(log, prefix, 100);
  assert.equal(entries.length, 3);                    // the 10.200.9.9 row + unrelated dropped
  assert.equal(entries[0].client, '10.200.1.5');
  assert.equal(entries[0].method, 'TCP');
  assert.equal(entries[0].url, '140.82.112.3:443');
  assert.equal(entries[0].action, 'OUT');
  assert.equal(entries[0].denied, false);
  assert.equal(entries[0].ts, 1700000000.123);
  assert.equal(entries[1].denied, true);
  assert.equal(entries[1].action, 'BLOCK');
  assert.equal(entries[1].url, '192.168.1.10:22');
  // An approved-grant connection to the declared internal host: action GRANT,
  // NOT denied (a failed one would then be host-down, not policy).
  assert.equal(entries[2].action, 'GRANT');
  assert.equal(entries[2].denied, false);
  assert.equal(entries[2].url, '192.168.10.5:636');
});

test('parseNftEgressLog: non-egress lines and empty prefix -> no entries', () => {
  assert.equal(subnetPrefixForCidr('not-a-cidr'), null);
  assert.deepEqual(parseNftEgressLog('kernel: something SRC=10.0.0.1 DST=8.8.8.8', null), []);
  // A line without our prefix is skipped even if it has SRC/DST.
  assert.deepEqual(parseNftEgressLog('kernel: OTHER SRC=10.200.1.5 DST=8.8.8.8', '10.200.1.'), []);
});

// ---- manifest port-drift ----

test('computePortDrift: declared web port alone is not drift', () => {
  const d = computePortDrift({ declared: 3000, tcpAnyHost: [3000], udpAnyHost: [] });
  assert.equal(d.hasDrift, false);
});

test('computePortDrift: an undeclared public TCP or any UDP bind is drift', () => {
  const tcp = computePortDrift({ declared: 3000, tcpAnyHost: [3000, 8080], udpAnyHost: [] });
  assert.deepEqual(tcp.tcp, [8080]);
  assert.equal(tcp.hasDrift, true);
  const udp = computePortDrift({ declared: 3000, tcpAnyHost: [3000], udpAnyHost: [10000] });
  assert.deepEqual(udp.udp, [10000]);
  assert.equal(udp.hasDrift, true);
});

test('computePortDrift: loopback-only ports are the caller\'s concern, not ours', () => {
  // Postgres on 127.0.0.1:5432 arrives as loopbackOnly (not tcpAnyHost), so it
  // is never passed here — an anyHost list without it produces no drift.
  const d = computePortDrift({ declared: 3000, tcpAnyHost: [3000], udpAnyHost: [] });
  assert.equal(d.hasDrift, false);
});

test('computePortDrift: benign OS-plumbing ports (LLMNR, mDNS, DHCP) are not drift', () => {
  // systemd/DHCP noise a stock container binds on all interfaces: LLMNR tcp+udp
  // 5355, mDNS udp 5353, DHCP client udp 68, DHCPv6 client udp 546. None is app
  // surface, so the scan must stay quiet.
  const d = computePortDrift({
    declared: 3000,
    tcpAnyHost: [3000, 5355],
    udpAnyHost: [68, 546, 5353, 5355],
  });
  assert.deepEqual(d.tcp, []);
  assert.deepEqual(d.udp, []);
  assert.equal(d.hasDrift, false);
});

test('computePortDrift: a real undeclared port still drifts alongside benign noise', () => {
  // Filtering the OS ports must not mask a genuinely exposed app port.
  const d = computePortDrift({
    declared: 3000,
    tcpAnyHost: [3000, 5355, 8080],
    udpAnyHost: [68, 9999],
  });
  assert.deepEqual(d.tcp, [8080]);
  assert.deepEqual(d.udp, [9999]);
  assert.equal(d.hasDrift, true);
});

// ---- container setup script (template.js, post-squid) ----

test('buildContainerSetupScript: no proxy env — egress is the bridge NAT, apt forced onto IPv4', () => {
  const s = buildContainerSetupScript({ appDir: '/srv/app', webPort: 3000 });
  // No egress proxy is baked in (squid was removed).
  assert.doesNotMatch(s, /http_proxy=/);
  assert.doesNotMatch(s, /01mock2proxy/);
  assert.doesNotMatch(s, /Acquire::http::Proxy/);
  // The bridge is IPv4-only, so apt is still forced onto IPv4.
  assert.match(s, /Acquire::ForceIPv4 "true"/);
  // The dev server unit still inherits any operator-set env.
  assert.match(s, /EnvironmentFile=-\/etc\/environment/);
});
