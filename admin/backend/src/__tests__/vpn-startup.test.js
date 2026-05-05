// Tests for admin/backend/src/lib/vpn-startup.js — the boot-time
// migration of an out-of-safe-range WG listen port (or a drifted
// firewall rule) to the safe-range default.
//
// All state goes through `proxypilot --json vpn status` (the CLI
// owns the only DB that has vpn_config + firewall.json), so the test
// stub simulates that JSON envelope based on the command shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { autoHealVpnListenPort } from '../lib/vpn-startup.js';

// Build an execHost that responds to:
//   * `... vpn status`             → returns `statusPayload` JSON
//   * `... vpn server set-listen-port --port N` → returns `setPortPayload`
//                                                    with `--port N` echoed
//
// Both responses are emitted as stdout so the parser path matches
// what the real CLI does in --json mode. setPortCalls captures every
// invocation for assertion.
function makeStub({ statusPayload, setPortPayload = (port) => ({
  ok: true, listen_port: port, endpoint: `h:${port}`,
}) }) {
  const setPortCalls = [];
  // shellSingleQuote wraps each argv in '…' so the resulting command
  // string is `'/usr/local/bin/proxypilot' '--json' 'vpn' 'status'` —
  // we detect intent by stripping the quotes-between-args and matching
  // on substrings of the joined argv.
  const argvLike = (cmd) => cmd.replace(/'\s+'/g, ' ').replace(/'/g, '');
  const exec = async (cmd) => {
    const flat = argvLike(cmd);
    if (flat.includes('vpn status')) {
      return { stdout: JSON.stringify(statusPayload), stderr: '' };
    }
    if (flat.includes('vpn server set-listen-port')) {
      const m = flat.match(/--port\s+(\d+)/);
      const port = m ? Number(m[1]) : NaN;
      setPortCalls.push({ cmd, port });
      const payload = typeof setPortPayload === 'function' ? setPortPayload(port) : setPortPayload;
      if (payload.ok === false) {
        const err = new Error('CLI ok=false');
        err.stdout = JSON.stringify(payload);
        throw err;
      }
      return { stdout: JSON.stringify(payload), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, setPortCalls };
}

test('auto-heal: skips when vpn is not enabled', async () => {
  const { exec, setPortCalls } = makeStub({
    statusPayload: { ok: true, enabled: false },
  });
  const r = await autoHealVpnListenPort({ execHost: exec, log: () => {}, errLog: () => {} });
  assert.equal(setPortCalls.length, 0);
  assert.match(r.skipped, /not enabled/);
});

test('auto-heal: no-op when listen port AND firewall rule are aligned in safe range', async () => {
  const { exec, setPortCalls } = makeStub({
    statusPayload: {
      ok: true, enabled: true, listen_port: 49500,
      base_wireguard_rule: { enabled: true, scope: 'public', port_start: 49500, port_end: null },
    },
  });
  const r = await autoHealVpnListenPort({ execHost: exec, log: () => {}, errLog: () => {} });
  assert.equal(setPortCalls.length, 0, 'CLI must not fire when state is clean');
  assert.match(r.skipped, /already in safe range/);
  assert.equal(r.currentPort, 49500);
});

test('auto-heal: realigns drifted firewall rule even when listen_port is in safe range', async () => {
  // The exact prod failure mode: previous setListenPort moved
  // listen_port to 49000 but the rule stayed at 51820. Handshakes
  // on :49000 get dropped, VPN never establishes, vpn-only SSH on
  // :22 is unreachable.
  const { exec, setPortCalls } = makeStub({
    statusPayload: {
      ok: true, enabled: true, listen_port: 49000,
      base_wireguard_rule: { enabled: true, scope: 'public', port_start: 51820, port_end: null },
    },
    setPortPayload: { ok: true, listen_port: 49000, endpoint: 'h:49000', realigned: true },
  });
  const r = await autoHealVpnListenPort({ execHost: exec, log: () => {}, errLog: () => {} });
  assert.equal(setPortCalls.length, 1);
  assert.equal(setPortCalls[0].port, 49000, 'should realign to the existing safe-range port');
  assert.equal(r.migrated, true);
  assert.equal(r.from, 49000);
  assert.equal(r.to, 49000);
  assert.equal(r.realigned, true);
});

test('auto-heal: migrates 51820 → 49000 when listen_port is outside safe range', async () => {
  const { exec, setPortCalls } = makeStub({
    statusPayload: {
      ok: true, enabled: true, listen_port: 51820,
      base_wireguard_rule: { enabled: true, scope: 'public', port_start: 51820, port_end: null },
    },
  });
  const r = await autoHealVpnListenPort({ execHost: exec, log: () => {}, errLog: () => {} });
  assert.equal(setPortCalls.length, 1);
  assert.equal(setPortCalls[0].port, 49000, 'should migrate to the safe-range default');
  assert.equal(r.migrated, true);
  assert.equal(r.from, 51820);
  assert.equal(r.to, 49000);
});

test('auto-heal: migrates a port inside the WebRTC range (50000-60000)', async () => {
  const { exec, setPortCalls } = makeStub({
    statusPayload: {
      ok: true, enabled: true, listen_port: 55555,
      base_wireguard_rule: { enabled: true, scope: 'public', port_start: 55555, port_end: null },
    },
  });
  const r = await autoHealVpnListenPort({ execHost: exec, log: () => {}, errLog: () => {} });
  assert.equal(setPortCalls.length, 1);
  assert.equal(setPortCalls[0].port, 49000);
  assert.equal(r.migrated, true);
  assert.equal(r.from, 55555);
  assert.equal(r.to, 49000);
});

test('auto-heal: surfaces CLI ok=false without throwing', async () => {
  const { exec } = makeStub({
    statusPayload: {
      ok: true, enabled: true, listen_port: 51820,
      base_wireguard_rule: { enabled: true, scope: 'public', port_start: 51820, port_end: null },
    },
    setPortPayload: { ok: false, error: 'wg-quick refused to restart' },
  });
  const r = await autoHealVpnListenPort({ execHost: exec, log: () => {}, errLog: () => {} });
  assert.equal(r.migrated, false);
  assert.match(r.error, /refused/);
  assert.equal(r.from, 51820);
});

test('auto-heal: surfaces vpn status error gracefully', async () => {
  const exec = async () => {
    const err = new Error('cli not found');
    err.stderr = 'proxypilot: command not found';
    throw err;
  };
  const r = await autoHealVpnListenPort({ execHost: exec, log: () => {}, errLog: () => {} });
  assert.match(r.skipped, /vpn status failed/);
});

test('auto-heal: handles missing base_wireguard_rule (treats as no-drift)', async () => {
  // Fresh install where firewall.scan hasn't run: vpn_config exists,
  // base-wireguard rule isn't in the state file yet. Don't realign
  // (nothing to realign against); just no-op if listen_port is OK.
  const { exec, setPortCalls } = makeStub({
    statusPayload: {
      ok: true, enabled: true, listen_port: 49000,
      base_wireguard_rule: null,
    },
  });
  const r = await autoHealVpnListenPort({ execHost: exec, log: () => {}, errLog: () => {} });
  assert.equal(setPortCalls.length, 0);
  assert.match(r.skipped, /already in safe range/);
});
