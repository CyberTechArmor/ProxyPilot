import test from 'node:test';
import assert from 'node:assert/strict';
import { browserMaintenanceStatus, requestBrowserMaintenance, requestBrowserRuntime } from '../lib/browser-runtime-install.js';

test('runtime operations use a dedicated fixed host RPC without commands or flags', async () => {
  for (const operation of ['install', 'recover', 'rollback']) {
    let request;
    const result = await requestBrowserRuntime({ operation, requestedBy: 'admin', call: async (...args) => { request = args; return { id: 'operation-id' }; } });
    assert.equal(result.id, 'operation-id');
    assert.equal(request[0], 'browser.runtime_request');
    assert.deepEqual(request[1], { operation, requested_by: 'admin' });
  }
});
test('unknown operations fail before host contact; host refusal is not hidden', async () => {
  await assert.rejects(requestBrowserRuntime({ operation: 'shell', call: () => assert.fail('host contacted') }), /Unknown/);
  await assert.rejects(requestBrowserRuntime({ operation: 'install', requestedBy: 'admin', call: async () => { throw new Error('runtime busy'); } }), /runtime busy/);
});

test('maintenance is a typed opt-in and read-only status uses no update request', async () => {
  for (const enabled of [false, true]) {
    let request;
    await requestBrowserMaintenance({ enabled, requestedBy: 'admin', call: async (...args) => { request = args; return { id: 'operation-id' }; } });
    assert.deepEqual(request.slice(0, 2), ['browser.runtime_request', { operation: enabled ? 'maintenance-enable' : 'maintenance-disable', requested_by: 'admin' }]);
  }
  for (const enabled of [undefined, null, 0, 1, 'true']) {
    await assert.rejects(requestBrowserMaintenance({ enabled, call: () => assert.fail('host contacted') }), /boolean/);
  }
  let request;
  await browserMaintenanceStatus({ call: async (...args) => { request = args; return { enabled: false }; } });
  assert.deepEqual(request.slice(0, 2), ['browser.maintenance_status', {}]);
});
