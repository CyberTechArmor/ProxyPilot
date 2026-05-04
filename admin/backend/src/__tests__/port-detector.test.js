// Unit tests for lib/port-detector.js. The orchestrator
// (`detectServicePorts`) talks to a real LXC via execHost, so the
// tests inject a stub that returns canned bodies — the assertions
// cover the parsing + range-collapse + compose-ps shapes the route
// layer in Phase 5 will rely on.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProcNet,
  collapseRanges,
  parseComposePs,
  detectServicePorts,
} from '../lib/port-detector.js';

// /proc/net/tcp body: header line + three rows. Rows 1+2 are LISTEN
// (state 0A); row 3 is ESTABLISHED (state 01) and must be ignored.
//   row 1: 0.0.0.0:8080  → anyHost
//   row 2: 127.0.0.1:5432 → loopbackOnly
//   row 3: 10.0.0.5:50000 ESTABLISHED → ignored (state 01)
const SAMPLE_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0
   1: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000     0        0 0 1 1 0
   2: 050000A0:C350 0100007F:0050 01 00000000:00000000 00:00000000     0        0 0 1 1 0
`;

// /proc/net/udp body: header + UDP "states" don't matter for binding,
// so every row counts. Two binds: 0.0.0.0:7880 and 0.0.0.0:50000.
// 0x1EC8 = 7880, 0xC350 = 50000.
const SAMPLE_UDP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
   0: 00000000:1EC8 00000000:0000 07 00000000:00000000 00:00000000 00000000   0  0 1 1 0
   1: 00000000:C350 00000000:0000 07 00000000:00000000 00:00000000 00000000   0  0 1 1 0
`;

test('parseProcNet: TCP keeps only LISTEN rows and splits loopback', () => {
  const { anyHost, loopbackOnly } = parseProcNet(SAMPLE_TCP, { proto: 'tcp' });
  assert.deepEqual([...anyHost].sort((a, b) => a - b), [8080]);
  assert.deepEqual([...loopbackOnly].sort((a, b) => a - b), [5432]);
});

test('parseProcNet: UDP accepts all rows regardless of state', () => {
  const { anyHost, loopbackOnly } = parseProcNet(SAMPLE_UDP, { proto: 'udp' });
  assert.deepEqual([...anyHost].sort((a, b) => a - b), [7880, 50000]);
  assert.equal(loopbackOnly.size, 0);
});

test('parseProcNet: empty / malformed body returns empty sets', () => {
  assert.equal(parseProcNet('', { proto: 'tcp' }).anyHost.size, 0);
  assert.equal(parseProcNet(null, { proto: 'tcp' }).anyHost.size, 0);
  assert.equal(parseProcNet('garbage\n', { proto: 'tcp' }).anyHost.size, 0);
});

test('collapseRanges: short runs stay individual', () => {
  // Threshold defaults to 8; a run of 5 should NOT collapse.
  assert.deepEqual(collapseRanges([1, 2, 3, 4, 5]), [
    { port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }, { port: 5 },
  ]);
});

test('collapseRanges: long contiguous runs collapse to a range', () => {
  // 10 contiguous ports → one range chip.
  const ports = [];
  for (let p = 50000; p <= 50009; p++) ports.push(p);
  assert.deepEqual(collapseRanges(ports), [
    { port: 50000, port_end: 50009 },
  ]);
});

test('collapseRanges: mixed runs handled per segment', () => {
  // 50000-50009 collapses; 7880, 8080 stay individual.
  const ports = [7880, 8080];
  for (let p = 50000; p <= 50009; p++) ports.push(p);
  assert.deepEqual(collapseRanges(ports), [
    { port: 7880 },
    { port: 8080 },
    { port: 50000, port_end: 50009 },
  ]);
});

test('collapseRanges: dedupes input', () => {
  assert.deepEqual(collapseRanges([80, 80, 443]), [{ port: 80 }, { port: 443 }]);
});

test('parseComposePs: handles per-line JSON output (modern compose)', () => {
  const stdout = [
    '{"Name":"meet-web-1","Service":"web","State":"running","Health":"healthy"}',
    '{"Name":"meet-livekit-1","Service":"livekit","State":"running","Health":"starting"}',
  ].join('\n');
  const rows = parseComposePs(stdout);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'meet-web-1', service: 'web', state: 'running', health: 'healthy' });
  assert.deepEqual(rows[1], { name: 'meet-livekit-1', service: 'livekit', state: 'running', health: 'starting' });
});

test('parseComposePs: handles array JSON output (older compose)', () => {
  const stdout = JSON.stringify([
    { Name: 'a', Service: 'a', State: 'running', Health: '' },
    { Name: 'b', Service: 'b', State: 'exited', Health: '' },
  ]);
  const rows = parseComposePs(stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'a');
  assert.equal(rows[0].health, null);
  assert.equal(rows[1].state, 'exited');
});

test('detectServicePorts: parses TCP+UDP, collapses, returns structured result', async () => {
  // Stub execHost: returns the appropriate body based on whether the
  // command mentions /proc/net/tcp vs /proc/net/udp. Ignores the
  // compose-detection probes (returns failure → no compose block).
  const execHost = async (cmd) => {
    if (cmd.includes('docker compose version')) {
      const err = new Error('docker not found');
      err.stderr = 'sh: 1: docker: not found';
      throw err;
    }
    if (cmd.includes('/proc/net/tcp')) return { stdout: SAMPLE_TCP, stderr: '' };
    if (cmd.includes('/proc/net/udp')) return { stdout: SAMPLE_UDP, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const result = await detectServicePorts({ incusName: 'pp-meet', execHost });
  assert.equal(result.compose, null, 'no compose stack detected');
  assert.equal(result.scanError, null);
  // 8080/tcp + 7880/udp + 50000/udp (all single ports — no contiguous
  // run reaches the default threshold of 8).
  const protoPorts = result.ports.map((p) => `${p.proto}/${p.port}${p.port_end ? '-' + p.port_end : ''}`);
  assert.deepEqual(protoPorts.sort(), ['tcp/8080', 'udp/50000', 'udp/7880']);
  // Loopback-only TCP set surfaces 5432 so the UI can grey-chip it.
  assert.deepEqual(result.loopbackOnly.tcp, [5432]);
});
