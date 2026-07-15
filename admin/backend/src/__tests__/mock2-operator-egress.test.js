// Operator-initiated egress grant — pure input validation (the same discipline a
// mock2.yaml-declared entry gets before it reaches the fence renderer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOperatorEgressInput } from '../mock2/egress-logic.js';

test('valid IPv4 host:port normalizes', () => {
  const v = validateOperatorEgressInput({ host: '10.0.1.4', port: 636, protocol: 'TCP' });
  assert.equal(v.ok, true);
  assert.equal(v.host, '10.0.1.4');
  assert.equal(v.port, 636);
  assert.equal(v.protocol, 'tcp');
});

test('valid hostname is accepted and lowercased', () => {
  const v = validateOperatorEgressInput({ host: 'Directory.Corp.Local', port: 636 });
  assert.equal(v.ok, true);
  assert.equal(v.host, 'directory.corp.local');
  assert.equal(v.protocol, 'tcp');
});

test('rejects scheme/path, bad port, bad protocol', () => {
  assert.equal(validateOperatorEgressInput({ host: 'ldaps://10.0.1.4:636', port: 636 }).ok, false);
  assert.equal(validateOperatorEgressInput({ host: '10.0.1.4', port: 0 }).ok, false);
  assert.equal(validateOperatorEgressInput({ host: '10.0.1.4', port: 70000 }).ok, false);
  assert.equal(validateOperatorEgressInput({ host: '10.0.1.4', port: 636, protocol: 'icmp' }).ok, false);
});
