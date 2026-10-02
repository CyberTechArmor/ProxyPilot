import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionAssignmentState, connectionStatus, refreshConnectionSelections } from '../src/components/operational-projects/connection-ui-logic.js';

const connection = { id: 'ledger', name: 'Ledger', adapter_id: 'synthetic-ledger-v1', rights: ['view', 'use', 'assign'], status: 'active', readiness: { code: 'SYNTHETIC_ONLY' }, operations: ['item.read', 'item.set_state'], resources: ['first', 'second'], revision: 1 };

test('visible catalogue states never imply assignment authority from use access or verification', () => {
  assert.equal(connectionAssignmentState(connection).selectable, true);
  for (const changed of [{ rights: ['view', 'use'] }, { status: 'revoked' }, { readiness: { code: 'CONNECTION_REVOKED' } }, { readiness: { code: 'POLICY_REVALIDATION_REQUIRED' } }, { adapter_id: 'browser-v1' }, { assignable_to_agent: false }]) {
    const state = connectionAssignmentState({ ...connection, ...changed });
    assert.equal(state.selectable, false);
    assert(state.reason.length > 0);
  }
  assert.equal(connectionStatus(connection).label, 'Development only');
  assert.equal(connectionStatus({ ...connection, status: 'revoked' }).label, 'Revoked');
  assert.equal(connectionStatus({ ...connection, readiness: { code: 'UNRECOGNIZED' } }).label, 'Check needed');
});

test('catalogue refresh removes inaccessible selections and never widens a chosen scope', () => {
  const chosen = { ...connection, allowedOperations: ['item.read'], allowedResources: ['first'] };
  const refreshed = refreshConnectionSelections([chosen], [{ ...connection, revision: 2, operations: ['item.read', 'item.set_state'], resources: ['first', 'second', 'third'] }]);
  assert.equal(refreshed[0].revision, 2);
  assert.deepEqual(refreshed[0].allowedOperations, ['item.read']);
  assert.deepEqual(refreshed[0].allowedResources, ['first']);
  const narrowed = refreshConnectionSelections([chosen], [{ ...connection, operations: ['item.set_state'], resources: ['second'] }]);
  assert.deepEqual(narrowed[0].allowedOperations, []);
  assert.deepEqual(narrowed[0].allowedResources, []);
  for (const rows of [[], [{ ...connection, rights: ['view', 'use'] }], [{ ...connection, status: 'revoked' }], [{ ...connection, readiness: { code: 'POLICY_REVALIDATION_REQUIRED' } }], [{ ...connection, assignable_to_agent: false }]]) assert.deepEqual(refreshConnectionSelections([chosen], rows), []);
});
