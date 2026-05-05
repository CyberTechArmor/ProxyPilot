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

// reconcileReservedPorts is harder to test fully without a live
// sysctl, but we can drive its file-write behaviour by pointing
// PROXYPILOT_L4_RESERVED_PORTS_PATH at a tmpdir and stubbing execHost.
test('reconcileReservedPorts: writes drop-in and invokes sysctl when ranges exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pp-l4-reserved-'));
  const path = join(dir, '99-proxypilot-l4-reserved.conf');
  process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH = path;
  try {
    const mod = await import(`../lib/l4-reserved-ports.js?t=${Date.now()}`);
    const fakeRows = [{ proto: 'udp', listen_port: 50000, listen_port_end: 60000, enabled: 1 }];
    const fakeDb = {
      prepare: () => ({ all: () => fakeRows }),
    };
    let captured = null;
    const fakeExec = async (cmd) => { captured = cmd; return { stdout: '', stderr: '' }; };
    const result = await mod.reconcileReservedPorts({ db: fakeDb, execHost: fakeExec });
    assert.equal(result.value, '50000-60000');
    assert.equal(result.changed, true);
    assert.equal(result.applied, true);
    const body = await readFile(path, 'utf-8');
    assert.match(body, /net\.ipv4\.ip_local_reserved_ports = 50000-60000/);
    assert.match(body, /Managed by ProxyPilot/);
    assert.match(captured, /sysctl -p/);
    assert.match(captured, /99-proxypilot-l4-reserved\.conf/);
  } finally {
    delete process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH;
    await rm(dir, { recursive: true, force: true });
  }
});

test('reconcileReservedPorts: idempotent — second call with same state is a no-op', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pp-l4-reserved-'));
  const path = join(dir, '99-proxypilot-l4-reserved.conf');
  process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH = path;
  try {
    const mod = await import(`../lib/l4-reserved-ports.js?t=${Date.now()}-idem`);
    const fakeRows = [{ proto: 'udp', listen_port: 50000, listen_port_end: 60000, enabled: 1 }];
    const fakeDb = { prepare: () => ({ all: () => fakeRows }) };
    let calls = 0;
    const fakeExec = async () => { calls++; return { stdout: '', stderr: '' }; };
    await mod.reconcileReservedPorts({ db: fakeDb, execHost: fakeExec });
    const r2 = await mod.reconcileReservedPorts({ db: fakeDb, execHost: fakeExec });
    assert.equal(r2.changed, false, 'second call must not write');
    assert.equal(calls, 1, 'sysctl must only run on the first (changing) call');
  } finally {
    delete process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH;
    await rm(dir, { recursive: true, force: true });
  }
});

test('reconcileReservedPorts: removes drop-in when no ranges remain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pp-l4-reserved-'));
  const path = join(dir, '99-proxypilot-l4-reserved.conf');
  process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH = path;
  try {
    // Pre-seed an old drop-in so the test exercises the unlink path.
    await writeFile(path, '# stale\n');
    const mod = await import(`../lib/l4-reserved-ports.js?t=${Date.now()}-empty`);
    const fakeDb = { prepare: () => ({ all: () => [] }) };
    const fakeExec = async () => ({ stdout: '', stderr: '' });
    const r = await mod.reconcileReservedPorts({ db: fakeDb, execHost: fakeExec });
    assert.equal(r.value, '');
    assert.equal(r.changed, true);
    await assert.rejects(() => access(path));
  } finally {
    delete process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH;
    await rm(dir, { recursive: true, force: true });
  }
});
