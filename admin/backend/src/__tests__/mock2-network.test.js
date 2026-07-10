// Mock2 Phase M4 tests — the network-isolation pure decision layer.
//
// Stub-first (risk R9 / docs/known-issues.md): imports ONLY network-logic.js,
// which has NO native (better-sqlite3), Express, Incus, nftables, or squid
// imports. The real bridge/fence/proxy host round-trip and the cross-table
// nftables matrix (risk R2) are exercised by scripts/mock2-m4-verify.sh on an
// enabled host — see docs/mock2/README.md.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bridgeNameForProject,
  bridgeCidrForProject,
  gatewayForCidr,
  buildFenceEntries,
  renderMock2Nft,
  DEFAULT_EGRESS_ALLOWLIST,
  isAllowlistHost,
  normalizeAllowlistHost,
  buildEgressPlan,
  renderSquidAcl,
  computePortDrift,
  EGRESS_PROXY_PORT,
} from '../mock2/network-logic.js';
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
    id: 7, cidr: '10.200.6.0/24', gateway: '10.200.6.1', containerIp: '10.200.6.15', webPort: 3000,
  });
});

test('buildFenceEntries: derives the subnet when bridge_cidr is not stored', () => {
  const entries = buildFenceEntries([activeProject({ id: 3, bridge_cidr: null })]);
  assert.equal(entries[0].cidr, bridgeCidrForProject(3));
  assert.equal(entries[0].gateway, '10.200.2.1');
});

test('renderMock2Nft: dedicated table, default-deny egress, web-port-only inbound, gateway-only host access', () => {
  const nft = renderMock2Nft(buildFenceEntries([activeProject()]));
  // Dedicated table (not inet proxypilot) with the idempotent add+flush pair.
  assert.match(nft, /add table inet mock2/);
  assert.match(nft, /flush table inet mock2/);
  assert.match(nft, /table inet mock2 \{/);
  // Inbound to the declared web port is allowed; everything else to the
  // container is dropped (Postgres 5432 etc. stay internal).
  assert.match(nft, /ip daddr 10\.200\.6\.15 tcp dport 3000 accept/);
  assert.match(nft, /ip daddr 10\.200\.6\.15 drop/);
  // Egress off the bridge is dropped (must use the proxy).
  assert.match(nft, /ip saddr 10\.200\.6\.0\/24 drop comment "mock2 p7 deny-egress"/);
  // Host access limited to DNS + DHCP + the proxy port on the OWN gateway.
  assert.match(nft, /ip saddr 10\.200\.6\.0\/24 ip daddr 10\.200\.6\.1 udp dport 53 accept/);
  assert.match(nft, new RegExp(`ip daddr 10\\.200\\.6\\.1 tcp dport ${EGRESS_PROXY_PORT} accept`));
  // Control plane denied: no rule permits the host's :3001, and a catch-all
  // host-deny closes the subnet.
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

test('renderMock2Nft: two projects cannot reach each other (each bridge egress-denied)', () => {
  const a = activeProject({ id: 1, bridge_cidr: '10.200.0.0/24', container_ip: '10.200.0.5' });
  const b = activeProject({ id: 2, bridge_cidr: '10.200.1.0/24', container_ip: '10.200.1.5' });
  const nft = renderMock2Nft(buildFenceEntries([a, b]));
  assert.match(nft, /ip saddr 10\.200\.0\.0\/24 drop comment "mock2 p1 deny-egress"/);
  assert.match(nft, /ip saddr 10\.200\.1\.0\/24 drop comment "mock2 p2 deny-egress"/);
  // Project A cannot reach B's container port either — B's daddr-drop covers it.
  assert.match(nft, /ip daddr 10\.200\.1\.5 drop/);
});

// ---- egress allowlist + squid ACL ----

test('isAllowlistHost: accepts hostnames + leading-dot suffixes, rejects junk', () => {
  for (const ok of ['registry.npmjs.org', '.npmjs.org', 'api.anthropic.com', 'a.b.c.d']) {
    assert.equal(isAllowlistHost(ok), true, ok);
  }
  for (const bad of ['', 'localhost', 'http://x.com', 'x.com/path', 'x.com:443', 'a b', 'x.com;evil', '10.0.0.1']) {
    assert.equal(isAllowlistHost(bad), false, bad);
  }
});

test('normalizeAllowlistHost: trims + lowercases', () => {
  assert.equal(normalizeAllowlistHost('  Registry.NPMJS.org '), 'registry.npmjs.org');
});

test('DEFAULT_EGRESS_ALLOWLIST: seeds npm + model APIs, all valid', () => {
  assert.ok(DEFAULT_EGRESS_ALLOWLIST.includes('registry.npmjs.org'));
  assert.ok(DEFAULT_EGRESS_ALLOWLIST.includes('api.anthropic.com'));
  for (const h of DEFAULT_EGRESS_ALLOWLIST) assert.equal(isAllowlistHost(h), true, h);
});

test('buildEgressPlan: skips archived/failed, includes provisioning (setup needs the proxy)', () => {
  const allow = new Map([[1, ['registry.npmjs.org']]]);
  const plan = buildEgressPlan([
    { id: 1, lifecycle: 'active', bridge_cidr: '10.200.0.0/24' },
    { id: 2, lifecycle: 'provisioning', bridge_cidr: '10.200.1.0/24' },
    { id: 3, lifecycle: 'archived', bridge_cidr: '10.200.2.0/24' },
    { id: 4, lifecycle: 'failed_provisioning', bridge_cidr: '10.200.3.0/24' },
  ], allow);
  assert.deepEqual(plan.map((p) => p.id), [1, 2]);
  assert.deepEqual(plan[0].hosts, ['registry.npmjs.org']);
  assert.deepEqual(plan[1].hosts, []);
});

test('renderSquidAcl: per-project src+dstdomain allow, union deny tail', () => {
  const acl = renderSquidAcl([
    { id: 1, cidr: '10.200.0.0/24', hosts: ['registry.npmjs.org', '.anthropic.com'] },
    { id: 2, cidr: '10.200.1.0/24', hosts: [] },
  ]);
  assert.match(acl, /acl mock2_p1_src src 10\.200\.0\.0\/24/);
  assert.match(acl, /acl mock2_p1_dst dstdomain registry\.npmjs\.org \.anthropic\.com/);
  assert.match(acl, /http_access allow mock2_p1_src mock2_p1_dst/);
  // Empty allowlist -> no allow line for project 2 (denied by default).
  assert.doesNotMatch(acl, /http_access allow mock2_p2_src/);
  assert.match(acl, /project 2: empty allowlist — all egress denied/);
  // Defence-in-depth deny across both subnets.
  assert.match(acl, /acl mock2_all_src src 10\.200\.0\.0\/24 10\.200\.1\.0\/24/);
  assert.match(acl, /http_access deny mock2_all_src/);
});

test('renderSquidAcl: empty plan -> header only, no deny tail', () => {
  const acl = renderSquidAcl([]);
  assert.match(acl, /Generated by ProxyPilot Mock2/);
  assert.doesNotMatch(acl, /http_access/);
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

// ---- container proxy env injection (template.js, M4) ----

test('buildContainerSetupScript: bakes the egress proxy into the container env', () => {
  const s = buildContainerSetupScript({
    appDir: '/srv/app', webPort: 3000,
    proxyUrl: 'http://10.200.6.1:3128', noProxy: 'localhost,127.0.0.1,::1,10.200.6.0/24',
  });
  assert.match(s, /http_proxy=\$PROXY_URL/);
  assert.match(s, /PROXY_URL="http:\/\/10\.200\.6\.1:3128"/);
  assert.match(s, /01mock2proxy/);                 // apt proxy drop-in
  assert.match(s, /Acquire::https::Proxy/);
  assert.match(s, /NO_PROXY_VAL="localhost,127\.0\.0\.1,::1,10\.200\.6\.0\/24"/);
  assert.match(s, /EnvironmentFile=-\/etc\/environment/); // dev server inherits it
});

test('buildContainerSetupScript: no proxy args -> no proxy block (M2/M3 unchanged)', () => {
  const s = buildContainerSetupScript({ appDir: '/srv/app', webPort: 3000 });
  assert.doesNotMatch(s, /http_proxy=/);
  assert.doesNotMatch(s, /01mock2proxy/);
});

test('buildContainerSetupScript: rejects a malformed proxy URL (no injection)', () => {
  const s = buildContainerSetupScript({
    appDir: '/srv/app', webPort: 3000,
    proxyUrl: 'http://evil"; rm -rf /; echo "', noProxy: 'localhost',
  });
  // A non-matching URL is dropped entirely rather than interpolated.
  assert.doesNotMatch(s, /rm -rf/);
  assert.doesNotMatch(s, /http_proxy=/);
});
