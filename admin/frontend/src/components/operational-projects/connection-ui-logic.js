// Display rules only. The broker still validates authority and scope on every write.
export function connectionAssignmentState(connection) {
  if (connection.status === 'revoked' || connection.readiness?.code === 'CONNECTION_REVOKED') return { selectable: false, label: 'Access revoked', reason: 'The owner must restore or replace this connection before assignment.' };
  if (connection.readiness?.code === 'POLICY_REVALIDATION_REQUIRED') return { selectable: false, label: 'Policy review needed', reason: 'Restored policy requires independent revalidation before assignment, testing or rotation.' };
  if (connection.adapter_id !== 'synthetic-ledger-v1') return { selectable: false, label: 'Service unavailable', reason: 'This setup supports the synthetic ledger API only.' };
  if (!connection.rights?.includes('assign')) return { selectable: false, label: 'Assignment permission needed', reason: 'Ask the connection owner for an explicit assignment grant. Permission to use it does not grant permission to assign it.' };
  if (connection.assignable_to_agent === false) return { selectable: false, label: 'Assignment unavailable', reason: 'The broker has not granted assignment to this agent. Ask the connection owner to check the project and agent grant.' };
  return { selectable: true, label: 'You can assign', reason: 'Select a scope, save the draft, then confirm the assignment separately.' };
}

export function connectionStatus(connection) {
  if (connection.status === 'revoked' || connection.readiness?.code === 'CONNECTION_REVOKED') return { label: 'Revoked', tone: 'muted' };
  if (connection.readiness?.code === 'POLICY_REVALIDATION_REQUIRED') return { label: 'Blocked', tone: 'muted' };
  if (['VERIFIED', 'READY', 'SYNTHETIC_ONLY'].includes(connection.readiness?.code)) return { label: connection.readiness.code === 'SYNTHETIC_ONLY' ? 'Development only' : 'Verified', tone: 'ready' };
  return { label: 'Check needed', tone: 'muted' };
}

export function refreshConnectionSelections(selections, connections) {
  return selections.flatMap(previous => {
    const current = connections.find(connection => connection.id === previous.id && connectionAssignmentState(connection).selectable);
    return current ? [{ ...current, allowedOperations: previous.allowedOperations.filter(value => current.operations.includes(value)), allowedResources: previous.allowedResources.filter(value => current.resources.includes(value)) }] : [];
  });
}

export function operationLabel(value) {
  return ({ 'item.read': 'Read permitted items', 'item.set_state': 'Update permitted item state', enrolled: 'Credential enrolled', rotated: 'Credential rotated', tested: 'Connection tested', assigned: 'Agent assigned', revoked: 'Connection revoked', unassigned: 'Agent access removed' })[value] || String(value || 'Activity').replaceAll('_', ' ');
}
