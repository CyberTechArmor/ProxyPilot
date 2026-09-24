import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBasicFlows } from '../lib/setup-engine/infisical-basic-flows.js';

// Stubbed transport: the owned destination, Agent Proxy and Infisical API all
// answer as a healthy free-edition installation would.
function harness(agentRead) {
  const received = { consumer: 0, agent: 0, unauthorized: 0 };
  const r = { config: { testHost: '127.0.0.1', proxyOrigin: 'http://127.0.0.1:17322' }, identities: { projectId: 'p1' } };
  const api = async (_path, { token } = {}) => ({ status: token ? agentRead : 401 });
  const destination = () => ({ received, open: async () => {}, close: async () => {} });
  const send = async (_origin, { path, headers }) => {
    if (path.startsWith('/g5/consumer')) { received.consumer++; return 204; }
    const auth = headers['Proxy-Authorization'];
    if (!auth) return 407;
    const [, scope, token] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    if (token === 'invalid-proxypilot-token' || scope.endsWith('/ungranted-proxypilot')) return 502;
    if (path.includes('/g5/denied')) return 403;
    received.agent++; return 204;
  };
  return { r, deps: { api, destination, send, job: { fence() {} }, sleep: async () => {} } };
}

test('free edition: an Admin agent that can read values is the recorded trade-off, not a failure', async () => {
  const { r, deps } = harness(200);
  const evidence = await verifyBasicFlows(r, { application: 'a' }, { agent: 'agent-token' }, deps);
  assert.equal(evidence.agentValueRead, 'readable_builtin_admin_role');
  assert.equal(evidence.agentProxy, 'placeholder_substitution_and_denials_verified');
});

test('an agent that is refused values is recorded as denied', async () => {
  const { r, deps } = harness(403);
  const evidence = await verifyBasicFlows(r, { application: 'a' }, { agent: 'agent-token' }, deps);
  assert.equal(evidence.agentValueRead, 'denied');
});

test('an unexpected answer to the agent read check fails with its status', async () => {
  const { r, deps } = harness(500);
  await assert.rejects(verifyBasicFlows(r, { application: 'a' }, { agent: 'agent-token' }, deps), /HTTP 500/);
});

test('a failed Agent Proxy check names the step and the status it got', async () => {
  const { r, deps } = harness(200);
  const send = deps.send;
  deps.send = async (origin, options) => options.path.includes('/g5/denied') ? 204 : send(origin, options);
  await assert.rejects(verifyBasicFlows(r, { application: 'a' }, { agent: 'agent-token' }, deps), /site outside the proxied service returned HTTP 204 \(expected 403\)/);
});
