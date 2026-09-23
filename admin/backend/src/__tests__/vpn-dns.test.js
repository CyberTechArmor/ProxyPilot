// VPN DNS: the resolver VPN peers use (cli/src/core/vpn/dns.js), the firewall
// line that admits it, and the backend's derivation of the names it answers
// (lib/setup-engine/platform-vpn-dns.js) + the push to the host CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDnsServer, parseQuery, nameMatches, normalizeNames, upstreamsFrom, writeDnsConfig, readDnsConfig } from '../../../../cli/src/core/vpn/dns.js';
import { render } from '../../../../cli/src/core/firewall/render.js';
import { makeDb, driveStages } from './helpers/full-platform-fixture.js';
import { vpnDnsManaged, vpnDnsView, setVpnDnsExtra, recordVpnDnsPush } from '../lib/setup-engine/platform-vpn-dns.js';
import { recordVpnNetworks } from '../lib/setup-engine/platform-networks.js';

const query = (name, type = 1, id = 0x4242) => {
  const h = Buffer.alloc(12); h.writeUInt16BE(id, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4);
  const t = Buffer.alloc(4); t.writeUInt16BE(type, 0); t.writeUInt16BE(1, 2);
  return Buffer.concat([h, ...name.split('.').flatMap((l) => [Buffer.from([l.length]), Buffer.from(l)]), Buffer.from([0]), t]);
};
const rcode = (m) => m.readUInt16BE(2) & 0xf, answers = (m) => m.readUInt16BE(6), lastIp = (m) => [...m.subarray(m.length - 4)].join('.');

async function harness(names) {
  // A fake upstream that marks what it forwarded (RCODE 3) so forwarding is observable.
  const up = dgram.createSocket('udp4'), seen = [];
  up.on('message', (m, r) => { seen.push(parseQuery(m)?.name); const o = Buffer.from(m); o.writeUInt16BE(0x8183, 2); up.send(o, r.port, r.address); });
  await new Promise((r) => up.bind(0, '127.0.0.1', r));
  const upTcp = net.createServer((s) => s.on('data', (d) => { const m = d.subarray(2); seen.push(parseQuery(m)?.name); const o = Buffer.from(m); o.writeUInt16BE(0x8183, 2); const l = Buffer.alloc(2); l.writeUInt16BE(o.length); s.end(Buffer.concat([l, o])); }));
  await new Promise((r) => upTcp.listen(up.address().port, '127.0.0.1', r));
  const srv = await startDnsServer({ address: '127.0.0.1', port: 0, answerAddress: '10.100.0.1', names: () => names, upstreams: () => ['127.0.0.1'], upstreamPort: up.address().port });
  const udp = (buf) => new Promise((res) => { const c = dgram.createSocket('udp4'); c.on('message', (m) => { c.close(); res(m); }); c.send(buf, srv.udp, '127.0.0.1'); });
  const tcp = (buf) => new Promise((res) => { const s = net.connect(srv.tcp, '127.0.0.1', () => { const l = Buffer.alloc(2); l.writeUInt16BE(buf.length); s.write(Buffer.concat([l, buf])); }); let got = Buffer.alloc(0); s.on('data', (d) => { got = Buffer.concat([got, d]); if (got.length >= 2 + got.readUInt16BE(0)) { s.destroy(); res(got.subarray(2)); } }); });
  return { udp, tcp, seen, close: async () => { await srv.close(); up.close(); await new Promise((r) => upTcp.close(r)); } };
}

test('resolver: configured names answer the VPN address over UDP and TCP; AAAA is empty; everything else is forwarded', async () => {
  const h = await harness(['recovery.fractionate.ai', '*.apps.example.com']);
  try {
    let m = await h.udp(query('recovery.fractionate.ai'));
    assert.equal(rcode(m), 0); assert.equal(answers(m), 1); assert.equal(lastIp(m), '10.100.0.1'); assert.equal(m.readUInt16BE(0), 0x4242);
    m = await h.udp(query('RECOVERY.fractionate.ai', 28));
    assert.equal(rcode(m), 0); assert.equal(answers(m), 0, 'no public IPv6 around the tunnel');
    m = await h.udp(query('a.apps.example.com')); assert.equal(lastIp(m), '10.100.0.1');
    m = await h.udp(query('apps.example.com')); assert.equal(rcode(m), 3, '*.suffix covers subdomains only; the apex is forwarded');
    m = await h.udp(query('example.org')); assert.equal(rcode(m), 3);
    m = await h.tcp(query('recovery.fractionate.ai')); assert.equal(lastIp(m), '10.100.0.1');
    m = await h.tcp(query('example.net')); assert.equal(rcode(m), 3);
    assert.deepEqual(h.seen, ['apps.example.com', 'example.org', 'example.net']);
  } finally { await h.close(); }
});

test('resolver: name rules, upstreams and the config file', () => {
  assert.deepEqual(normalizeNames([' Edge.Example.com. ', 'edge.example.com', '*.apps.example.com']), ['edge.example.com', '*.apps.example.com']);
  for (const bad of ['http://x.example.com', 'x..example.com', '10.0.0.1', 'a*.example.com', 'localhost']) assert.throws(() => normalizeNames([bad]));
  assert.ok(nameMatches('x.y.apps.example.com', ['*.apps.example.com'])); assert.ok(!nameMatches('apps.example.com', ['*.apps.example.com']));
  assert.deepEqual(upstreamsFrom('nameserver 127.0.0.53\nnameserver 10.100.0.1\nnameserver ::1\n'), ['127.0.0.53']);
  assert.deepEqual(upstreamsFrom(''), ['1.1.1.1', '9.9.9.9']);
  const dir = mkdtempSync(join(tmpdir(), 'vpn-dns-')), file = join(dir, 'vpn-dns.json');
  try {
    writeDnsConfig({ managed: ['edge.example.com'] }, file); writeDnsConfig({ extra: ['*.apps.example.com'] }, file);
    assert.deepEqual(readDnsConfig(file).managed, ['edge.example.com']); assert.deepEqual(readDnsConfig(file).extra, ['*.apps.example.com']);
    writeDnsConfig({ managed: [] }, file); assert.deepEqual(readDnsConfig(file).managed, []);
    assert.throws(() => writeDnsConfig({ extra: ['not a host'] }, file)); assert.deepEqual(readDnsConfig(file).extra, ['*.apps.example.com']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('firewall: port 53 on the VPN server address is admitted from the VPN subnet only', () => {
  const rules = render({ base: [], discovered: [], container_egress: [], network: {} });
  assert.match(rules, /ip saddr 10\.100\.0\.0\/24 ip daddr 10\.100\.0\.1 meta l4proto \{ tcp, udp \} th dport 53 accept comment "vpn-dns"/);
});

test('backend: the Full Platform hostnames go to the resolver unless their route refuses VPN sources; extra names are validated', () => { const db = makeDb(); return (async () => {
  try {
    await driveStages(db, { through: 'B' });
    recordVpnNetworks(db, ['10.100.0.0/24']);
    const { managed } = vpnDnsManaged(db);
    assert.deepEqual(managed, ['pilot.example.com', 'recovery.example.com', 'identity.example.com', 'access.example.com', 'secrets.example.com', 'bao.example.com', 'vault.example.com']);
    // A route that admits only a non-VPN address is left out, with the reason.
    db.prepare("INSERT OR IGNORE INTO services (id, name, kind, runtime, target_ip, type, status) VALUES ('vw', 'vw', 'container_service', 'docker', '127.0.0.1', 'proxy', 'active')").run();
    db.prepare("INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size, strip_prefix, ip_allowlist_json) VALUES ('vw-r', 'vw', 'vault.example.com', '/', 18380, 1, 1, 1, '1G', 0, '[\"203.0.113.9\"]')").run();
    let v = vpnDnsManaged(db);
    assert.ok(!v.managed.includes('vault.example.com')); assert.match(v.skipped[0].reason, /203\.0\.113\.9/);
    db.prepare("UPDATE service_http_routes SET ip_allowlist_json='[\"10.100.0.0/24\",\"203.0.113.9\"]' WHERE id='vw-r'").run();
    assert.ok(vpnDnsManaged(db).managed.includes('vault.example.com'));
    assert.throws(() => setVpnDnsExtra(db, ['https://x.example.com']), /not a hostname/);
    assert.deepEqual(setVpnDnsExtra(db, ['App.Example.com', '*.apps.example.com']), ['app.example.com', '*.apps.example.com']);
    recordVpnDnsPush(db, { ok: true, managed: vpnDnsManaged(db).managed, extra: ['app.example.com', '*.apps.example.com'] });
    v = vpnDnsView(db);
    assert.equal(v.address, '10.100.0.1'); assert.equal(v.pushed.in_sync, true); assert.match(v.peer_config, /DNS = 10\.100\.0\.1/);
    setVpnDnsExtra(db, []); assert.equal(vpnDnsView(db).pushed.in_sync, false, 'a change after the last push reads as pending');
  } finally { db.close(); }
})(); });

test('peer configs carry DNS = the VPN resolver (a resolver outside the VPN subnet is left out)', async (t) => {
  let peer;
  try { peer = await import('../../../../cli/src/core/vpn/peer.js'); }
  catch (e) { if (e?.code === 'ERR_MODULE_NOT_FOUND') return t.skip('cli dependencies (better-sqlite3) are not installed here — see vpn-mtu.test.js'); throw e; }
  const base = { peerPrivateKey: 'k'.repeat(44), peerIp: '10.100.0.5', scope: 'admin', mtu: 1280 };
  const withDns = peer.renderClientConfig({ ...base, cfg: { server_public_key: 'p'.repeat(44), endpoint: 'vpn.example.com:49000', dns: '10.100.0.1' } });
  assert.match(withDns, /\nDNS = 10\.100\.0\.1\n/); assert.match(withDns, /AllowedIPs = 10\.100\.0\.0\/24/);
  assert.doesNotMatch(peer.renderClientConfig({ ...base, cfg: { server_public_key: 'p'.repeat(44), endpoint: 'vpn.example.com:49000', dns: '1.1.1.1' } }), /DNS =/);
});
