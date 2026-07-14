// Mock2 declared-egress pure decision layer (extends ADR-005 to egress; ADR-010 fence).
//
// Stub-first (risk R9): imports ONLY egress-logic.js — no better-sqlite3, Incus,
// or nftables. The DB store (egress-grants.js), the reconcile wiring
// (firewall.js), and the host-reachability probe (network.js) are the host-acting
// shells and are exercised on an enabled host, not here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProtocol,
  isIpv4,
  isEgressHost,
  isEgressPort,
  grantKey,
  parseDeclaredEgress,
  renderEgressGrantRules,
  EGRESS_LOG_PREFIX_GRANT,
} from '../mock2/egress-logic.js';

test('normalizeProtocol: TLS/LDAPS/HTTPS collapse to tcp; udp stays; junk → null', () => {
  assert.equal(normalizeProtocol('tcp'), 'tcp');
  assert.equal(normalizeProtocol('TCP'), 'tcp');
  assert.equal(normalizeProtocol('tls'), 'tcp');
  assert.equal(normalizeProtocol('ldaps'), 'tcp');
  assert.equal(normalizeProtocol('https'), 'tcp');
  assert.equal(normalizeProtocol('udp'), 'udp');
  assert.equal(normalizeProtocol(''), 'tcp');       // empty defaults to tcp
  assert.equal(normalizeProtocol(undefined), 'tcp');
  assert.equal(normalizeProtocol('sctp'), null);    // unknown → null (dropped upstream)
});

test('isIpv4: strict dotted-quad only', () => {
  assert.equal(isIpv4('192.168.10.5'), true);
  assert.equal(isIpv4('10.0.0.1'), true);
  assert.equal(isIpv4('256.1.1.1'), false);
  assert.equal(isIpv4('1.2.3'), false);
  assert.equal(isIpv4('example.com'), false);
});

test('isEgressHost: IPv4 literal or an RFC-1123 hostname, no scheme/port/path', () => {
  assert.equal(isEgressHost('192.168.10.5'), true);
  assert.equal(isEgressHost('ldap.corp.example.com'), true);
  assert.equal(isEgressHost('dc01.internal'), true);
  assert.equal(isEgressHost('ldaps://host:636'), false);   // scheme + port
  assert.equal(isEgressHost('host name'), false);          // whitespace
  assert.equal(isEgressHost('host/path'), false);          // slash
  assert.equal(isEgressHost(''), false);
  assert.equal(isEgressHost('singlelabel'), false);        // no dot → not a FQDN
});

test('isEgressPort: 1..65535 integers only', () => {
  assert.equal(isEgressPort(636), true);
  assert.equal(isEgressPort(1), true);
  assert.equal(isEgressPort(65535), true);
  assert.equal(isEgressPort(0), false);
  assert.equal(isEgressPort(70000), false);
  assert.equal(isEgressPort('abc'), false);
});

test('grantKey: stable host|port|protocol identity, case-insensitive host + proto', () => {
  assert.equal(grantKey({ host: 'DC01.Internal', port: 636, protocol: 'LDAPS' }), 'dc01.internal|636|tcp');
  assert.equal(
    grantKey({ host: '192.168.10.5', port: 636, protocol: 'tcp' }),
    grantKey({ host: '192.168.10.5', port: '636', protocol: 'tls' }),
  );
});

test('parseDeclaredEgress: reads the egress list-of-maps, validates, dedupes', () => {
  const yaml = [
    'run:',
    '  start: node server.js',
    'egress:',
    '  - host: 192.168.10.5',
    '    port: 636',
    '    protocol: ldaps',
    '    reason: ADP directory (LDAPS)',
    '  - host: ldap.corp.example.com',
    '    port: 389',
    '    protocol: tcp',
    '  - host: 192.168.10.5      # duplicate of the first entry',
    '    port: 636',
    '    protocol: tls',
    'ports:',
    '  web: 3000',
  ].join('\n');
  const out = parseDeclaredEgress(yaml);
  assert.equal(out.length, 2);                          // the duplicate collapsed
  assert.deepEqual(out[0], { host: '192.168.10.5', port: 636, protocol: 'tcp', reason: 'ADP directory (LDAPS)' });
  assert.deepEqual(out[1], { host: 'ldap.corp.example.com', port: 389, protocol: 'tcp', reason: '' });
});

test('parseDeclaredEgress: no egress block → []; invalid entries dropped, never guessed', () => {
  assert.deepEqual(parseDeclaredEgress('run:\n  start: node x.js\n'), []);
  const bad = [
    'egress:',
    '  - host: not a host',       // whitespace
    '    port: 636',
    '  - host: 10.0.0.9',
    '    port: 99999',            // out of range
    '  - host: 10.0.0.9',
    '    port: 636',
    '    protocol: sctp',         // unknown protocol
  ].join('\n');
  assert.deepEqual(parseDeclaredEgress(bad), []);
});

test('parseDeclaredEgress: a non-indented line ends the block', () => {
  const yaml = 'egress:\n  - host: 10.0.0.5\n    port: 636\nname: after\n  port: ignored';
  const out = parseDeclaredEgress(yaml);
  assert.equal(out.length, 1);
  assert.equal(out[0].host, '10.0.0.5');
});

test('renderEgressGrantRules: emits a grant-log + accept per grant with a resolved IPv4 ip', () => {
  const rules = renderEgressGrantRules('10.200.6.0/24', 7, [
    { host: '192.168.10.5', ip: '192.168.10.5', port: 636, protocol: 'tcp', reason: 'ldaps' },
  ]);
  assert.equal(rules.length, 2);
  assert.match(rules[0], new RegExp(`log prefix "${EGRESS_LOG_PREFIX_GRANT} p7: "`));
  assert.match(rules[0], /ip saddr 10\.200\.6\.0\/24 ip daddr 192\.168\.10\.5 tcp dport 636/);
  assert.match(rules[1], /ip saddr 10\.200\.6\.0\/24 ip daddr 192\.168\.10\.5 tcp dport 636 accept/);
});

test('renderEgressGrantRules: an IP-literal host needs no resolved ip; unresolved hostnames are skipped', () => {
  // Host is already an IPv4 → usable even without an explicit ip field.
  const literal = renderEgressGrantRules('10.200.6.0/24', 7, [{ host: '10.0.0.9', port: 389, protocol: 'tcp' }]);
  assert.equal(literal.length, 2);
  assert.match(literal[1], /ip daddr 10\.0\.0\.9 tcp dport 389 accept/);
  // A hostname with no resolved ip cannot be turned into a rule → skipped, no throw.
  const unresolved = renderEgressGrantRules('10.200.6.0/24', 7, [{ host: 'ldap.example.com', port: 389, protocol: 'tcp' }]);
  assert.deepEqual(unresolved, []);
});
