// Tests for admin/backend/src/lib/vpn-startup.js — the boot-time
// migration of an out-of-safe-range WG listen port to the safe-range
// default. We stub the host CLI invocation so the test never spawns
// `proxypilot vpn server set-listen-port` for real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { autoHealVpnListenPort } from '../lib/vpn-startup.js';

function fakeDb(row) {
  return {
    prepare: () => ({ get: () => row }),
  };
}

test('auto-heal: skips when vpn_config is missing', async () => {
  const r = await autoHealVpnListenPort({
    db: fakeDb(null),
    execHost: async () => { throw new Error('should not be called'); },
    log: () => {},
    errLog: () => {},
  });
  assert.equal(r.skipped, 'vpn not enabled');
});

test('auto-heal: no-op when listen port already in safe range AND firewall rule aligned', async () => {
  let cliInvoked = false;
  const r = await autoHealVpnListenPort({
    db: fakeDb({ id: 1, endpoint: 'h:49500', listen_port: 49500 }),
    execHost: async (cmd) => {
      if (cmd.includes('vpn server set-listen-port')) cliInvoked = true;
      // Firewall state read returns an aligned rule; nothing to do.
      if (cmd.includes('firewall.json')) {
        return { stdout: JSON.stringify({
          base: [{ id: 'base-wireguard', port_start: 49500, port_end: null, proto: 'udp' }],
        }), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    log: () => {},
    errLog: () => {},
  });
  assert.equal(cliInvoked, false, 'CLI must not be invoked when port AND rule are aligned');
  assert.match(r.skipped, /already in safe range/);
  assert.equal(r.currentPort, 49500);
});

test('auto-heal: realigns the firewall rule when it drifted from listen_port', async () => {
  // The exact failure case from prod: a previous setListenPort moved
  // listen_port to 49000 but the base-wireguard rule stayed at 51820.
  // VPN never establishes; SSH on vpn-only is unreachable.
  let cliCmd = null;
  const r = await autoHealVpnListenPort({
    db: fakeDb({ id: 1, endpoint: 'h:49000', listen_port: 49000 }),
    execHost: async (cmd) => {
      if (cmd.includes('firewall.json')) {
        return { stdout: JSON.stringify({
          base: [{ id: 'base-wireguard', port_start: 51820, port_end: null, proto: 'udp' }],
        }), stderr: '' };
      }
      if (cmd.includes('vpn server set-listen-port')) {
        cliCmd = cmd;
        return { stdout: JSON.stringify({
          ok: true, listen_port: 49000, endpoint: 'h:49000', realigned: true,
        }), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    log: () => {},
    errLog: () => {},
  });
  assert.ok(cliCmd, 'CLI must be invoked when firewall rule drifted');
  assert.match(cliCmd, /--port 49000/, 'should target the existing safe-range port, not the default');
  assert.equal(r.migrated, true);
});

test('auto-heal: migrates 51820 → 49000 via CLI', async () => {
  let captured = null;
  const r = await autoHealVpnListenPort({
    db: fakeDb({ id: 1, endpoint: 'vpn.example.com:51820', listen_port: 51820 }),
    execHost: async (cmd) => {
      captured = cmd;
      return {
        stdout: JSON.stringify({
          ok: true, listen_port: 49000, endpoint: 'vpn.example.com:49000', unchanged: false,
        }),
        stderr: '',
      };
    },
    log: () => {},
    errLog: () => {},
  });
  assert.match(captured, /vpn server set-listen-port/);
  assert.match(captured, /--port 49000/);
  assert.equal(r.migrated, true);
  assert.equal(r.from, 51820);
  assert.equal(r.to, 49000);
  assert.equal(r.endpoint, 'vpn.example.com:49000');
});

test('auto-heal: also migrates ports inside the WebRTC range (50000-60000)', async () => {
  // The exact failure case from prod: WG defaulted to 51820, MEET's
  // L4 forward wants 50000-60000 contiguous, conflict.
  const r = await autoHealVpnListenPort({
    db: fakeDb({ id: 1, endpoint: 'h:55555', listen_port: 55555 }),
    execHost: async () => ({
      stdout: JSON.stringify({ ok: true, listen_port: 49000, endpoint: 'h:49000' }),
      stderr: '',
    }),
    log: () => {},
    errLog: () => {},
  });
  assert.equal(r.migrated, true);
  assert.equal(r.from, 55555);
  assert.equal(r.to, 49000);
});

test('auto-heal: surfaces CLI ok=false without throwing', async () => {
  const r = await autoHealVpnListenPort({
    db: fakeDb({ id: 1, endpoint: 'h:51820', listen_port: 51820 }),
    execHost: async () => ({
      stdout: JSON.stringify({ ok: false, error: 'wg-quick refused to restart' }),
      stderr: '',
    }),
    log: () => {},
    errLog: () => {},
  });
  assert.equal(r.migrated, false);
  assert.match(r.error, /refused/);
  assert.equal(r.from, 51820);
});

test('auto-heal: surfaces CLI throw without crashing boot', async () => {
  const r = await autoHealVpnListenPort({
    db: fakeDb({ id: 1, endpoint: 'h:51820', listen_port: 51820 }),
    execHost: async () => {
      const e = new Error('exec failed');
      e.stderr = 'wg0 not found';
      throw e;
    },
    log: () => {},
    errLog: () => {},
  });
  assert.equal(r.migrated, false);
  assert.ok(r.error, 'error message must be set');
  assert.equal(r.from, 51820);
});
