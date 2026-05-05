// Tests for admin/backend/src/lib/l4-reserved-ports.js — the kernel
// ip_local_reserved_ports drop-in writer. Pure unit tests for the
// value builder + tmpfile-based tests for the on-disk reconcile.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';

import { buildReservedPortsValue } from '../lib/l4-reserved-ports.js';

test('buildReservedPortsValue: ignores single-port and TCP forwards', () => {
  const rows = [
    { proto: 'tcp', listen_port: 7881, listen_port_end: null, enabled: 1 },
    { proto: 'udp', listen_port: 53, listen_port_end: null, enabled: 1 },
    { proto: 'udp', listen_port: 53, listen_port_end: 53, enabled: 1 },
  ];
  assert.equal(buildReservedPortsValue(rows), '');
});

test('buildReservedPortsValue: emits a single UDP range', () => {
  const rows = [{ proto: 'udp', listen_port: 50000, listen_port_end: 60000, enabled: 1 }];
  assert.equal(buildReservedPortsValue(rows), '50000-60000');
});

test('buildReservedPortsValue: sorts and coalesces adjacent ranges', () => {
  const rows = [
    { proto: 'udp', listen_port: 60001, listen_port_end: 60100, enabled: 1 },
    { proto: 'udp', listen_port: 50000, listen_port_end: 60000, enabled: 1 },
    { proto: 'udp', listen_port: 40000, listen_port_end: 41000, enabled: 1 },
  ];
  // 50000-60000 and 60001-60100 are adjacent → merge.
  assert.equal(buildReservedPortsValue(rows), '40000-41000,50000-60100');
});

test('buildReservedPortsValue: coalesces overlapping ranges', () => {
  const rows = [
    { proto: 'udp', listen_port: 50000, listen_port_end: 55000, enabled: 1 },
    { proto: 'udp', listen_port: 54000, listen_port_end: 60000, enabled: 1 },
  ];
  assert.equal(buildReservedPortsValue(rows), '50000-60000');
});

test('buildReservedPortsValue: excludes disabled rows', () => {
  const rows = [
    { proto: 'udp', listen_port: 50000, listen_port_end: 60000, enabled: 0 },
    { proto: 'udp', listen_port: 30000, listen_port_end: 31000, enabled: 1 },
  ];
  assert.equal(buildReservedPortsValue(rows), '30000-31000');
});

// reconcileReservedPorts uses execHost for ALL filesystem operations
// (cat / mkdir / mktemp / printf | base64 -d > file / mv / rm) so the
// drop-in lives in the host namespace, not in the backend container's
// local /etc. The tests below drive an in-memory file-system stub
// through a single execHost mock, asserting on the commands issued
// rather than on real on-disk state.
function makeFakeHostFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    exec: async (cmd) => {
      // cat <path>
      const cat = cmd.match(/^cat ([^\s|]+)/);
      if (cat) {
        const p = cat[1].replace(/^'|'$/g, '');
        return { stdout: files[p] || '', stderr: '' };
      }
      // rm -f <path>
      const rm = cmd.match(/^rm -f ([^\s]+)/);
      if (rm) {
        const p = rm[1].replace(/^'|'$/g, '');
        delete files[p];
        return { stdout: '', stderr: '' };
      }
      // mkdir … && t=$(mktemp …) && printf '%s' 'BASE64' | base64 -d > "$t" && chmod … && mv -f "$t" '<path>'
      const writeMatch = cmd.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d.*mv -f "\$t" '([^']+)'/);
      if (writeMatch) {
        const body = Buffer.from(writeMatch[1], 'base64').toString('utf-8');
        files[writeMatch[2]] = body;
        return { stdout: '', stderr: '' };
      }
      // sysctl -p <path>
      if (cmd.startsWith('sysctl -p')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  };
}

test('reconcileReservedPorts: writes drop-in and invokes sysctl when ranges exist', async () => {
  const fs = makeFakeHostFs();
  const path = '/etc/sysctl.d/99-proxypilot-l4-reserved.conf';
  process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH = path;
  try {
    const mod = await import(`../lib/l4-reserved-ports.js?t=${Date.now()}`);
    const fakeDb = {
      prepare: () => ({ all: () => [{ proto: 'udp', listen_port: 50000, listen_port_end: 60000, enabled: 1 }] }),
    };
    let sawSysctl = false;
    const wrapped = async (cmd) => {
      if (cmd.startsWith('sysctl -p') && cmd.includes('99-proxypilot-l4-reserved')) sawSysctl = true;
      return fs.exec(cmd);
    };
    const result = await mod.reconcileReservedPorts({ db: fakeDb, execHost: wrapped });
    assert.equal(result.value, '50000-60000');
    assert.equal(result.changed, true);
    assert.equal(result.applied, true);
    assert.match(fs.files[path], /net\.ipv4\.ip_local_reserved_ports = 50000-60000/);
    assert.match(fs.files[path], /Managed by ProxyPilot/);
    assert.equal(sawSysctl, true, 'must invoke sysctl -p on the new drop-in');
  } finally {
    delete process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH;
  }
});

test('reconcileReservedPorts: idempotent — second call with same state is a no-op', async () => {
  const path = '/etc/sysctl.d/99-proxypilot-l4-reserved.conf';
  process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH = path;
  try {
    const fs = makeFakeHostFs();
    const mod = await import(`../lib/l4-reserved-ports.js?t=${Date.now()}-idem`);
    const fakeDb = {
      prepare: () => ({ all: () => [{ proto: 'udp', listen_port: 50000, listen_port_end: 60000, enabled: 1 }] }),
    };
    let sysctlCalls = 0;
    const wrapped = async (cmd) => {
      if (cmd.startsWith('sysctl -p')) sysctlCalls++;
      return fs.exec(cmd);
    };
    await mod.reconcileReservedPorts({ db: fakeDb, execHost: wrapped });
    const r2 = await mod.reconcileReservedPorts({ db: fakeDb, execHost: wrapped });
    assert.equal(r2.changed, false, 'second call must not write');
    assert.equal(sysctlCalls, 1, 'sysctl must only run on the first (changing) call');
  } finally {
    delete process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH;
  }
});

test('reconcileReservedPorts: removes drop-in when no ranges remain', async () => {
  const path = '/etc/sysctl.d/99-proxypilot-l4-reserved.conf';
  process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH = path;
  try {
    // Pre-seed an old drop-in so the test exercises the rm path.
    const fs = makeFakeHostFs({ [path]: '# stale\n' });
    const mod = await import(`../lib/l4-reserved-ports.js?t=${Date.now()}-empty`);
    const fakeDb = { prepare: () => ({ all: () => [] }) };
    const r = await mod.reconcileReservedPorts({ db: fakeDb, execHost: fs.exec });
    assert.equal(r.value, '');
    assert.equal(r.changed, true);
    assert.equal(fs.files[path], undefined, 'drop-in must be removed when no ranges remain');
  } finally {
    delete process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH;
  }
});
