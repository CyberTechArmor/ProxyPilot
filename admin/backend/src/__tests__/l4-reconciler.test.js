// Unit tests for lib/l4-reconciler.js. Network/Incus calls are
// stubbed via execHost; these cover the pure planning + parsing
// helpers plus the orchestrator's diff logic.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderIncusEndpoint,
  planServiceL4Forward,
  parseIncusDeviceShow,
  reconcileServiceL4Forwards,
  applyServiceL4Plan,
  removeServiceL4Plan,
} from '../lib/l4-reconciler.js';

test('renderIncusEndpoint: single-port and range shapes', () => {
  assert.equal(
    renderIncusEndpoint({ proto: 'tcp', start: 80, end: null, address: '0.0.0.0' }),
    'tcp:0.0.0.0:80'
  );
  assert.equal(
    renderIncusEndpoint({ proto: 'tcp', start: 80, end: 80, address: '10.0.0.5' }),
    'tcp:10.0.0.5:80'
  );
  assert.equal(
    renderIncusEndpoint({ proto: 'udp', start: 50000, end: 60000, address: '0.0.0.0' }),
    'udp:0.0.0.0:50000-60000'
  );
});

test('planServiceL4Forward: maps DB row to Incus + firewall ids', () => {
  const plan = planServiceL4Forward(
    {
      id: 'fw-meet-rtc',
      proto: 'udp',
      listen_port: 50000,
      listen_port_end: 60000,
      connect_port: 50000,
      connect_port_end: 60000,
      description: 'WebRTC media',
    },
    { bridgeIp: '10.0.42.7', lxcName: 'meet-lxc-01' }
  );
  assert.equal(plan.incusName, 'pp-meet-lxc-01');
  assert.equal(plan.deviceName, 'ppl4-fw-meet-rtc');
  assert.equal(plan.ruleId, 'service-l4-fw-meet-rtc');
  assert.equal(plan.listen, 'udp:0.0.0.0:50000-60000');
  assert.equal(plan.connect, 'udp:10.0.42.7:50000-60000');
});

test('planServiceL4Forward: passes through pp- prefix without doubling', () => {
  const plan = planServiceL4Forward(
    {
      id: 'fw-1',
      proto: 'tcp',
      listen_port: 7881,
      listen_port_end: null,
      connect_port: 7881,
      connect_port_end: null,
    },
    { bridgeIp: '10.0.42.7', lxcName: 'pp-meet-lxc-01' }
  );
  assert.equal(plan.incusName, 'pp-meet-lxc-01');
});

test('parseIncusDeviceShow: extracts proxy devices, ignores others', () => {
  const text = `
eth0:
  name: eth0
  network: incusbr0
  type: nic
ppl4-fw-meet-rtc:
  type: proxy
  listen: udp:0.0.0.0:50000-60000
  connect: udp:10.0.42.7:50000-60000
ppl4-fw-meet-tcp:
  type: proxy
  listen: tcp:0.0.0.0:7881
  connect: tcp:10.0.42.7:7881
root:
  path: /
  pool: default
  type: disk
`;
  const devices = parseIncusDeviceShow(text);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].name, 'ppl4-fw-meet-rtc');
  assert.equal(devices[0].listen, 'udp:0.0.0.0:50000-60000');
  assert.equal(devices[1].name, 'ppl4-fw-meet-tcp');
});

test('parseIncusDeviceShow: empty input returns empty list', () => {
  assert.deepEqual(parseIncusDeviceShow(''), []);
  assert.deepEqual(parseIncusDeviceShow(null), []);
});

// In-memory SQLite stub for the reconciler. Implements only the
// subset (.prepare(...).all(...)) the function actually uses.
function makeDbStub(rows) {
  return {
    prepare() {
      return {
        all() { return rows; },
      };
    },
  };
}

test('reconcileServiceL4Forwards: applies new + removes orphans', async () => {
  // Desired state: fw-keep should stay, fw-orphan should go.
  const db = makeDbStub([
    {
      id: 'fw-keep',
      proto: 'tcp',
      listen_port: 7881,
      listen_port_end: null,
      connect_port: 7881,
      connect_port_end: null,
      description: null,
      enabled: 1,
    },
  ]);
  // Live: fw-keep already present + fw-orphan that's no longer in DB.
  const liveDevices = [
    { name: 'ppl4-fw-keep', type: 'proxy', listen: 'tcp:0.0.0.0:7881', connect: 'tcp:10.0.42.7:7881' },
    { name: 'ppl4-fw-orphan', type: 'proxy', listen: 'tcp:0.0.0.0:9000', connect: 'tcp:10.0.42.7:9000' },
  ];

  const calls = [];
  const execHost = async (cmd) => {
    calls.push(cmd);
    if (cmd.includes('incus config device add')) {
      // Simulate "already exists" since fw-keep is already live.
      const err = new Error('add failed');
      err.stderr = 'Error: Device already exists';
      throw err;
    }
    if (cmd.includes('incus config device remove')) {
      return { stdout: '', stderr: '' };
    }
    if (cmd.includes('add-service-l4')) {
      return { stdout: '{"ok":true}', stderr: '' };
    }
    if (cmd.includes('remove-service-l4')) {
      return { stdout: '{"ok":true}', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const result = await reconcileServiceL4Forwards({
    db,
    serviceId: 'svc-meet',
    lxcName: 'meet-lxc-01',
    bridgeIp: '10.0.42.7',
    execHost,
    listIncusDevices: async () => liveDevices,
  });

  // Expect outcomes for both fw-keep (applied) and fw-orphan (removed).
  const byId = Object.fromEntries(result.applied.map((o) => [o.id, o]));
  assert.equal(byId['fw-keep'].status, 'applied');
  assert.equal(byId['fw-orphan'].status, 'removed');

  // Verify the orphan got both removal commands.
  assert.ok(calls.some((c) => c.includes('incus config device remove pp-meet-lxc-01 ppl4-fw-orphan')));
  assert.ok(calls.some((c) => c.includes('remove-service-l4') && c.includes('service-l4-fw-orphan')));
});

test('applyServiceL4Plan: tolerates already-present incus device + firewall row', async () => {
  // CLI args are POSIX-single-quoted in the assembled command, so
  // match against tokens that survive the quoting (the bare flag
  // chars / file path) rather than re-assembled phrases.
  const execHost = async (cmd) => {
    if (cmd.includes('incus config device add')) {
      const err = new Error('exists');
      err.stderr = 'Device already exists';
      throw err;
    }
    if (cmd.includes('add-service-l4')) {
      const err = new Error('exists');
      err.stdout = '{"ok":false,"error":"a rule with id service-l4-x already exists"}';
      throw err;
    }
    return { stdout: '', stderr: '' };
  };
  const plan = planServiceL4Forward(
    { id: 'x', proto: 'tcp', listen_port: 80, listen_port_end: null, connect_port: 80, connect_port_end: null },
    { bridgeIp: '10.0.42.7', lxcName: 'demo' }
  );
  const r = await applyServiceL4Plan(plan, { execHost });
  assert.equal(r.firewall, 'present');
});

test('removeServiceL4Plan: NOT_FOUND on either side is non-fatal', async () => {
  const execHost = async (cmd) => {
    if (cmd.includes('incus config device remove')) {
      const err = new Error('not found');
      err.stderr = "Error: Device doesn't exist";
      throw err;
    }
    if (cmd.includes('remove-service-l4')) {
      const err = new Error('not found');
      err.stdout = '{"ok":true,"already_absent":true}';
      throw err;
    }
    return { stdout: '', stderr: '' };
  };
  // Should NOT throw.
  await removeServiceL4Plan(
    { incusName: 'pp-x', deviceName: 'ppl4-x', ruleId: 'service-l4-x' },
    { execHost }
  );
});
