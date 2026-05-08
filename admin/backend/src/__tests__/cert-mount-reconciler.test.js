// Unit tests for lib/cert-mount-reconciler.js. Incus calls are
// stubbed via the execHost injection seam; the DB layer is a tiny
// in-memory stub that implements only the SELECT shapes the
// reconciler issues — same approach the L4 reconciler test uses to
// keep the test suite free of a native sqlite dependency.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDeviceFromShow,
  inspectIncusDevice,
  reconcileServiceCertMounts,
} from '../lib/cert-mount-reconciler.js';

function makeDbStub(rows) {
  return {
    prepare(sql) {
      return {
        all(arg) {
          if (/WHERE id = \?/.test(sql)) return rows.filter((r) => r.id === arg);
          if (/WHERE service_id = \?/.test(sql)) return rows.filter((r) => r.service_id === arg);
          return rows.slice();
        },
      };
    },
  };
}

const DEVICE_SHOW_OK = `eth0:
  name: eth0
  network: incusbr0
  type: nic
meet-tls:
  type: disk
  source: /var/lib/caddy/.local/share/caddy/certificates/acme-v02/example.com
  path: /var/meet-tls
  readonly: "true"
root:
  path: /
  pool: default
  type: disk
`;

const DEVICE_SHOW_DRIFTED = `meet-tls:
  type: disk
  source: /tmp/operator-pointed-here-instead
  path: /var/meet-tls
  readonly: "true"
`;

const DEVICE_SHOW_NO_DEVICE = `eth0:
  name: eth0
  type: nic
root:
  path: /
  type: disk
`;

test('parseDeviceFromShow: extracts source/path for the named device', () => {
  const dev = parseDeviceFromShow(DEVICE_SHOW_OK, 'meet-tls');
  assert.equal(dev.exists, true);
  assert.equal(dev.type, 'disk');
  assert.equal(
    dev.source,
    '/var/lib/caddy/.local/share/caddy/certificates/acme-v02/example.com'
  );
  assert.equal(dev.path, '/var/meet-tls');
  assert.equal(dev.readonly, true);
});

test('parseDeviceFromShow: returns exists:false when device absent', () => {
  const dev = parseDeviceFromShow(DEVICE_SHOW_NO_DEVICE, 'meet-tls');
  assert.equal(dev.exists, false);
});

test('inspectIncusDevice: returns containerMissing when incus says container not found', async () => {
  const execHost = async () => {
    const e = new Error('failed');
    e.stderr = 'Error: Instance not found';
    throw e;
  };
  const r = await inspectIncusDevice('coturn-lxc', 'meet-tls', { execHost });
  assert.equal(r.exists, false);
  assert.equal(r.containerMissing, true);
});

test('reconcileServiceCertMounts: matched when source equals row.cert_dir', async () => {
  const db = makeDbStub([
    {
      id: 'm1',
      service_id: 's1',
      hostname: 'example.com',
      cert_dir: '/var/lib/caddy/.local/share/caddy/certificates/acme-v02/example.com',
      container_name: 'coturn',
      device_name: 'meet-tls',
      target_path: '/var/meet-tls',
      readonly: 1,
    },
  ]);
  const calls = [];
  const execHost = async (cmd) => {
    calls.push(cmd);
    if (cmd.startsWith('incus config device show')) {
      return { stdout: DEVICE_SHOW_OK };
    }
    throw new Error(`unexpected: ${cmd}`);
  };
  const { results } = await reconcileServiceCertMounts({ db, execHost });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'matched');
  assert.equal(calls.some((c) => c.includes('device add')), false);
});

test('reconcileServiceCertMounts: created when device is missing', async () => {
  const db = makeDbStub([
    {
      id: 'm2',
      service_id: 's1',
      hostname: 'example.com',
      cert_dir: '/var/lib/caddy/.local/share/caddy/certificates/acme-v02/example.com',
      container_name: 'coturn',
      device_name: 'meet-tls',
      target_path: '/var/meet-tls',
      readonly: 1,
    },
  ]);
  let added = false;
  const execHost = async (cmd) => {
    if (cmd.startsWith('incus config device show')) {
      return { stdout: DEVICE_SHOW_NO_DEVICE };
    }
    if (cmd.startsWith('incus config device add')) {
      assert.match(cmd, /coturn/);
      assert.match(cmd, /meet-tls/);
      assert.match(cmd, /disk/);
      assert.match(cmd, /readonly=true/);
      added = true;
      return { stdout: '' };
    }
    throw new Error(`unexpected: ${cmd}`);
  };
  const { results } = await reconcileServiceCertMounts({ db, execHost });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'created');
  assert.equal(added, true);
});

test('reconcileServiceCertMounts: drifted when source mismatches; never overwrites', async () => {
  const db = makeDbStub([
    {
      id: 'm3',
      service_id: 's1',
      hostname: 'example.com',
      cert_dir: '/var/lib/caddy/.local/share/caddy/certificates/acme-v02/example.com',
      container_name: 'coturn',
      device_name: 'meet-tls',
      target_path: '/var/meet-tls',
      readonly: 1,
    },
  ]);
  let addCalled = false;
  const execHost = async (cmd) => {
    if (cmd.startsWith('incus config device show')) {
      return { stdout: DEVICE_SHOW_DRIFTED };
    }
    if (cmd.startsWith('incus config device add')) {
      addCalled = true;
      return { stdout: '' };
    }
    throw new Error(`unexpected: ${cmd}`);
  };
  const { results } = await reconcileServiceCertMounts({ db, execHost });
  assert.equal(results[0].action, 'drifted');
  assert.equal(results[0].drift.kind, 'wrong_source');
  assert.equal(results[0].drift.incus_source, '/tmp/operator-pointed-here-instead');
  assert.equal(addCalled, false, 'must not silently overwrite operator drift');
});

test('reconcileServiceCertMounts: missing when target container is gone', async () => {
  const db = makeDbStub([
    {
      id: 'm4',
      service_id: 's1',
      hostname: 'example.com',
      cert_dir: '/some/dir',
      container_name: 'ghost-lxc',
      device_name: 'meet-tls',
      target_path: '/var/meet-tls',
      readonly: 1,
    },
  ]);
  const execHost = async (cmd) => {
    if (cmd.startsWith('incus config device show')) {
      const e = new Error('failed');
      e.stderr = 'Error: Instance not found';
      throw e;
    }
    throw new Error(`unexpected: ${cmd}`);
  };
  const { results } = await reconcileServiceCertMounts({ db, execHost });
  assert.equal(results[0].action, 'missing');
  assert.equal(results[0].drift.kind, 'container_missing');
});

test('reconcileServiceCertMounts: mountId scoping returns just one row', async () => {
  const db = makeDbStub([
    {
      id: 'm-a', service_id: 's1', hostname: 'a.com', cert_dir: '/x',
      container_name: 'c1', device_name: 'meet-tls', target_path: '/var/meet-tls',
      readonly: 1,
    },
    {
      id: 'm-b', service_id: 's1', hostname: 'b.com', cert_dir: '/y',
      container_name: 'c2', device_name: 'meet-tls', target_path: '/var/meet-tls',
      readonly: 1,
    },
  ]);
  const execHost = async (cmd) => {
    if (cmd.startsWith('incus config device show')) {
      return { stdout: DEVICE_SHOW_NO_DEVICE };
    }
    if (cmd.startsWith('incus config device add')) {
      return { stdout: '' };
    }
    throw new Error(`unexpected: ${cmd}`);
  };
  const { results } = await reconcileServiceCertMounts({ db, mountId: 'm-a', execHost });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'm-a');
});
