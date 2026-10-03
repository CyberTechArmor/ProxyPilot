import test from 'node:test';
import assert from 'node:assert/strict';
import { requestBrowserRuntime } from '../lib/browser-runtime-install.js';

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
