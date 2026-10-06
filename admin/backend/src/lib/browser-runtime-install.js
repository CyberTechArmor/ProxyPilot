import { agentCall } from './agent.js';
import { sanitizeRequestedBy } from './self-update-logic.js';

export async function requestBrowserRuntime({ operation, requestedBy, call = agentCall }) {
  if (!['install', 'recover', 'rollback'].includes(operation)) {
    throw Object.assign(new Error('Unknown browser runtime operation'), { code: 'invalid_params' });
  }
  return call('browser.runtime_request', {
    operation, requested_by: sanitizeRequestedBy(requestedBy),
  }, { timeoutMs: 15000 });
}

export async function browserMaintenanceStatus({ call = agentCall } = {}) {
  return call('browser.maintenance_status', {}, { timeoutMs: 15000 });
}

export async function requestBrowserMaintenance({ enabled, requestedBy, call = agentCall }) {
  if (typeof enabled !== 'boolean') {
    throw Object.assign(new Error('Browser maintenance enabled must be a boolean'), { code: 'invalid_params' });
  }
  return call('browser.runtime_request', {
    operation: enabled ? 'maintenance-enable' : 'maintenance-disable',
    requested_by: sanitizeRequestedBy(requestedBy),
  }, { timeoutMs: 15000 });
}
