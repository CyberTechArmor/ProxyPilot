// Tests for admin/backend/src/lib/l4-diagnose.js — the host-side
// reachability diagnostic. Drives the public diagnose function with
// a fake db + a fake execHost that returns canned `incus`/`ss`/
// `iptables-save` output, asserting on the per-forward summary +
// next_step the route layer surfaces to operators.

import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseServiceL4Forwards } from '../lib/l4-diagnose.js';

function fakeDb(forwards) {
  return {
    prepare: () => ({ all: () => forwards }),
  };
}

// Builds an execHost stub keyed by command-substring → response.
// Each match returns { stdout, stderr } or throws on `error: true`.
function execHostFromMap(map) {
  return async (cmd) => {
    for (const [needle, response] of map) {
      if (cmd.includes(needle)) {
        if (response.error) {
          const err = new Error(response.stderr || 'execHost stub error');
          err.stdout = response.stdout || '';
          err.stderr = response.stderr || '';
          throw err;
        }
        return { stdout: response.stdout || '', stderr: response.stderr || '' };
      }
    }
    return { stdout: '', stderr: '' };
  };
}

test('diagnose: happy path — device present, firewall present, listener present', async () => {
  const forwards = [{
    id: 'fw-tcp', proto: 'tcp',
    listen_port: 7881, listen_port_end: null,
    connect_port: 7881, connect_port_end: null,
    description: 'LiveKit RTC TCP', enabled: 1,
  }];
  const execHost = execHostFromMap([
    ['incus list', { stdout: JSON.stringify([{
      state: { network: { eth0: { addresses: [{ family: 'inet', scope: 'global', address: '10.185.17.131' }] } } }
    }]) }],
    ['incus config device show', { stdout: `ppl4-fw-tcp:\n  type: proxy\n  listen: tcp:0.0.0.0:7881\n  connect: tcp:10.185.17.131:7881\n` }],
    ['ss -tlnp', { stdout: 'LISTEN 0 4096 0.0.0.0:7881 0.0.0.0:* users:(("livekit-server",pid=2371,fd=4))' }],
    ['iptables-save', { stdout: '-A FORWARD -p tcp -m tcp --dport 7881 -m comment --comment "service-l4-fw-tcp" -j ACCEPT' }],
  ]);

  const r = await diagnoseServiceL4Forwards({
    db: fakeDb(forwards), serviceId: 'svc1', lxcName: 'pp-MEET',
    bridgeIp: '10.185.17.131', execHost,
  });
  assert.equal(r.forwards.length, 1);
  const fw = r.forwards[0];
  assert.equal(fw.checks.bridgeIp.matches, true);
  assert.equal(fw.checks.incusDevice.present, true);
  assert.equal(fw.checks.firewall.present, true);
  assert.equal(fw.checks.lxcListener.listening, true);
  assert.equal(fw.ok, true);
  assert.match(fw.next_step, /security group/);
});

test('diagnose: missing UDP proxy device produces actionable next_step', async () => {
  const forwards = [{
    id: 'fw-udp', proto: 'udp',
    listen_port: 50000, listen_port_end: 60000,
    connect_port: 50000, connect_port_end: 60000,
    description: 'WebRTC media', enabled: 1,
  }];
  const execHost = execHostFromMap([
    ['incus list', { stdout: JSON.stringify([{
      state: { network: { eth0: { addresses: [{ family: 'inet', scope: 'global', address: '10.185.17.131' }] } } }
    }]) }],
    // device show returns ONLY the TCP device — UDP missing
    ['incus config device show', { stdout: `ppl4-fw-tcp:\n  type: proxy\n  listen: tcp:0.0.0.0:7881\n  connect: tcp:10.185.17.131:7881\n` }],
    ['ss -ulnp', { stdout: '' }],
    ['iptables-save', { stdout: '' }],
  ]);

  const r = await diagnoseServiceL4Forwards({
    db: fakeDb(forwards), serviceId: 'svc1', lxcName: 'pp-MEET',
    bridgeIp: '10.185.17.131', execHost,
  });
  const fw = r.forwards[0];
  assert.equal(fw.checks.incusDevice.present, false);
  assert.equal(fw.ok, false);
  assert.match(fw.next_step, /Reconcile/i);
});

test('diagnose: bridge IP drift is detected and named', async () => {
  const forwards = [{
    id: 'fw1', proto: 'tcp',
    listen_port: 7881, listen_port_end: null,
    connect_port: 7881, connect_port_end: null,
    description: null, enabled: 1,
  }];
  // Cached bridgeIp != actual IP from `incus list`
  const execHost = execHostFromMap([
    ['incus list', { stdout: JSON.stringify([{
      state: { network: { eth0: { addresses: [{ family: 'inet', scope: 'global', address: '10.185.17.200' }] } } }
    }]) }],
    ['incus config device show', { stdout: '' }],
    ['ss -tlnp', { stdout: '' }],
    ['iptables-save', { stdout: '' }],
  ]);

  const r = await diagnoseServiceL4Forwards({
    db: fakeDb(forwards), serviceId: 'svc1', lxcName: 'pp-MEET',
    bridgeIp: '10.185.17.131', execHost,
  });
  const fw = r.forwards[0];
  assert.equal(fw.checks.bridgeIp.matches, false);
  assert.equal(fw.checks.bridgeIp.expected, '10.185.17.131');
  assert.equal(fw.checks.bridgeIp.actual, '10.185.17.200');
  assert.equal(fw.ok, false);
  assert.match(fw.next_step, /doesn't match/);
});

test('diagnose: UDP range with no live listener is reported as expected', async () => {
  // LiveKit's UDP/50000-60000 only opens sockets on demand — a
  // diagnose run between calls should NOT mark this as broken.
  const forwards = [{
    id: 'fw-udp', proto: 'udp',
    listen_port: 50000, listen_port_end: 60000,
    connect_port: 50000, connect_port_end: 60000,
    description: 'WebRTC media', enabled: 1,
  }];
  const execHost = execHostFromMap([
    ['incus list', { stdout: JSON.stringify([{
      state: { network: { eth0: { addresses: [{ family: 'inet', scope: 'global', address: '10.185.17.131' }] } } }
    }]) }],
    ['incus config device show', { stdout: 'ppl4-fw-udp:\n  type: proxy\n  listen: udp:0.0.0.0:50000-60000\n  connect: udp:10.185.17.131:50000-60000\n' }],
    ['ss -ulnp', { stdout: '' }], // no listener
    ['iptables-save', { stdout: '-A FORWARD -p udp -m udp --dport 50000:60000 -m comment --comment "service-l4-fw-udp" -j ACCEPT' }],
  ]);

  const r = await diagnoseServiceL4Forwards({
    db: fakeDb(forwards), serviceId: 'svc1', lxcName: 'pp-MEET',
    bridgeIp: '10.185.17.131', execHost,
  });
  const fw = r.forwards[0];
  assert.equal(fw.ok, true, 'UDP range with no listener is fine — daemon allocates on demand');
  assert.match(fw.next_step, /WebRTC|on demand|allocates/);
  assert.match(fw.next_step, /security group/);
});

test('diagnose: missing firewall rule names the rule id', async () => {
  const forwards = [{
    id: 'fw-tcp', proto: 'tcp',
    listen_port: 7881, listen_port_end: null,
    connect_port: 7881, connect_port_end: null,
    description: null, enabled: 1,
  }];
  const execHost = execHostFromMap([
    ['incus list', { stdout: JSON.stringify([{
      state: { network: { eth0: { addresses: [{ family: 'inet', scope: 'global', address: '10.185.17.131' }] } } }
    }]) }],
    ['incus config device show', { stdout: 'ppl4-fw-tcp:\n  type: proxy\n  listen: tcp:0.0.0.0:7881\n  connect: tcp:10.185.17.131:7881\n' }],
    ['ss -tlnp', { stdout: 'LISTEN 0 4096 0.0.0.0:7881 0.0.0.0:* users:(("svc",pid=1,fd=2))' }],
    ['iptables-save', { stdout: '' }], // rule absent
  ]);

  const r = await diagnoseServiceL4Forwards({
    db: fakeDb(forwards), serviceId: 'svc1', lxcName: 'pp-MEET',
    bridgeIp: '10.185.17.131', execHost,
  });
  const fw = r.forwards[0];
  assert.equal(fw.checks.firewall.present, false);
  assert.equal(fw.checks.firewall.ruleId, 'service-l4-fw-tcp');
  assert.equal(fw.ok, false);
  assert.match(fw.next_step, /service-l4-fw-tcp/);
});
