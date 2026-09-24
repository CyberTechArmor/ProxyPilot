import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { testDestination } from './infisical-flows.js';
import { secretPath } from './infisical-api.js';
import { TEST_PORT, TEST_ENV, TEST_PATH, PLACEHOLDER, PROXY_KEY, infisicalError as fail } from './infisical-logic.js';

const request = (url, { method = 'GET', path, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, path, headers, agent: false, timeout: 8000 }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
  req.on('timeout', () => req.destroy()); req.on('error', () => reject(fail('The owned disposable connection check could not reach its destination.'))); req.end();
});

// A short-lived in-process destination checks the actual local service and
// Agent Proxy. The basic installation requires no separately provisioned VM.
// The agent receives a placeholder and its own limited token, never the value.
export async function verifyBasicFlows(r, values, tokens, { api, job, destination = testDestination, send = request, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (![401, 403].includes((await api(secretPath(r.identities.projectId))).status)) throw fail('Unauthenticated secret access was not explicitly denied.');
  // The free edition lets only its built-in Admin role use the Agent Proxy
  // (BUILTIN_ROLES.agent, AGENT_ROLE_RISK), so an agent that can read values
  // directly is the documented trade-off here, not a failure. Record which
  // one Infisical answered; anything else is not a result we can vouch for.
  let agentValueRead = 'not_selected';
  if (tokens.agent) {
    const { status } = await api(secretPath(r.identities.projectId, PROXY_KEY), { token: tokens.agent });
    if (status === 403) agentValueRead = 'denied';
    else if (status === 200) agentValueRead = 'readable_builtin_admin_role';
    else throw fail(`Could not check what the agent identity can read (Infisical answered HTTP ${status}).`);
  }
  const nonce = randomBytes(20).toString('hex'), receipt = destination(values, nonce, { host: r.config.testHost });
  await receipt.open();
  try {
    job.fence();
    const origin = `http://${r.config.testHost}:${TEST_PORT}`;
    const consumer = await send(origin, { method: 'POST', path: `/g5/consumer?nonce=${nonce}`, headers: { Authorization: `Bearer ${values.application}` } });
    if (consumer !== 204 || receipt.received.consumer !== 1) throw fail('The owned consumer did not receive the scoped test credential.');
    if (tokens.agent) {
      const through = (suffix, token, secretPath = TEST_PATH) => send(r.config.proxyOrigin, { path: `${origin}/g5/${suffix}?nonce=${nonce}`, headers: { Authorization: `Bearer ${PLACEHOLDER}`, ...(token ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${r.identities.projectId}:${TEST_ENV}${secretPath}:${token}`).toString('base64')}` } : {}) } });
      let accepted = false;
      for (let attempt = 0; attempt < 15; attempt++) { job.fence(); try { if (await through('allowed', tokens.agent) === 204) { accepted = true; break; } } catch {} await sleep(1000); }
      // Each check names itself and the status it got, so a failure says which
      // step Infisical or the proxy answered differently (no values involved).
      const checks = [
        ['the agent reaching the allowed site', 204, () => accepted ? 204 : through('allowed', tokens.agent)],
        ['a request with no proxy credential', 407, () => through('allowed')],
        ['a request with an invalid token', 502, () => through('allowed', 'invalid-proxypilot-token')],
        ['the agent reaching a site outside the proxied service', 403, () => through('denied', tokens.agent)],
        // Refused either way: 502 (no credential resolved) or 403 (no service on
        // that path, Infisical CLI 0.43.133). The receipt below proves it never arrived.
        ['the agent asking for a secret path it was not given', [403, 502], () => through('allowed', tokens.agent, '/ungranted-proxypilot')],
        ['the agent reaching the allowed site again', 204, () => through('allowed', tokens.agent)],
      ];
      for (const [label, want, run] of checks) {
        let got;
        try { got = await run(); } catch { got = 'no answer'; }
        const allowed = [want].flat();
        if (!allowed.includes(got)) throw fail(`Agent Proxy check failed: ${label} returned ${got === 'no answer' ? 'no answer' : `HTTP ${got}`} (expected ${allowed.join(' or ')}). No credential value is exposed.`);
      }
      if (receipt.received.agent !== 2 || receipt.received.unauthorized) throw fail(`Agent Proxy check failed: the test site received ${receipt.received.agent} substituted request(s) (expected 2)${receipt.received.unauthorized ? ' and an unauthorized one' : ''}. No credential value is exposed.`);
    }
    return { consumer: 'verified', unauthenticatedRead: 'denied', agentValueRead, agentProxy: tokens.agent ? 'placeholder_substitution_and_denials_verified' : 'skipped', destinationReceipt: tokens.agent ? 'real_credential_received' : 'not_selected', execution: 'owned_disposable_local_destination', advancedVmFlows: 'not_tested' };
  } finally { await receipt.close(); }
}
