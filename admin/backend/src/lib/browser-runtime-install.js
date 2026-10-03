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
