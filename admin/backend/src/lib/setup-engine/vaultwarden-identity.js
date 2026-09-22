import { readConfig } from '../sso/store.js';
import { reader, validateRealmSettings } from '../sso/oidc.js';
import { fail, callbackFor, flowAlias, digest } from './vaultwarden-logic.js';
export async function verifyClient(db, r, { getReader = reader } = {}) {
  const g3 = readConfig(db);
  if (!g3 || g3.config.connectionId !== r.config.connectionId) throw fail('The existing read-only Keycloak observer for this provider is required.');
  try {
    const get = await getReader(db, g3), realm = await get(''), clients = await get(`/clients?clientId=${encodeURIComponent(r.config.clientId)}`), c = clients?.find(x => x.clientId === r.config.clientId);
    if (!c || c.protocol !== 'openid-connect' || !c.enabled || c.publicClient || c.bearerOnly || !c.standardFlowEnabled || c.implicitFlowEnabled || c.directAccessGrantsEnabled || c.serviceAccountsEnabled || c.fullScopeAllowed !== false) throw fail('Use a dedicated confidential authorization-code client, with full scope, implicit/direct grants and service accounts disabled.');
    if (JSON.stringify(c.redirectUris) !== JSON.stringify([callbackFor(r)]) || JSON.stringify(c.webOrigins) !== JSON.stringify([r.config.origin]) || c.attributes?.['pkce.code.challenge.method'] !== 'S256' || c.attributes?.['access.token.lifespan'] !== '600' || c.attributes?.['id.token.signed.response.alg'] && c.attributes['id.token.signed.response.alg'] !== 'RS256') throw fail('Keycloak requires the exact callback/origin, S256 PKCE, RS256 and a dedicated 600-second access-token lifespan.');
    const flows = await get('/authentication/flows'), flow = flows?.find(x => x.id === c.authenticationFlowBindingOverrides?.browser);
    if (!flow || flow.alias !== flowAlias(r) || flow.builtIn || !flow.topLevel) throw fail('Bind only this client to the reviewed dedicated Vaultwarden browser flow.');
    const e = (await get(`/authentication/flows/${encodeURIComponent(flow.alias)}/executions`))?.filter(x => x.requirement !== 'DISABLED') || [];
    // Required passkey, then conditional denial of users without the selected
    // client role. Never an ALTERNATIVE authorization branch that can be skipped.
    if (e.length !== 4 || e[0].providerId !== 'webauthn-authenticator-passwordless' || e[0].requirement !== 'REQUIRED' || e[0].level !== 0 || e[0].authenticationFlow ||
      !e[1].authenticationFlow || e[1].requirement !== 'CONDITIONAL' || e[1].level !== 0 ||
      e[2].providerId !== 'conditional-user-role' || e[2].requirement !== 'REQUIRED' || e[2].level !== 1 ||
      e[3].providerId !== 'deny-access-authenticator' || e[3].requirement !== 'REQUIRED' || e[3].level !== 1) throw fail('Dedicated flow must require the existing passwordless authenticator, then conditionally deny users without the selected client role.');
    const condition = await get(`/authentication/config/${encodeURIComponent(e[2].authenticationConfig || '')}`);
    if (condition?.config?.condUserRole !== `${r.config.clientId}.${r.config.accessRole}` || condition.config.negate !== 'true') throw fail('The deny condition must negate exactly the selected Vaultwarden client role.');
    const roles = await get(`/clients/${encodeURIComponent(c.id)}/roles`);
    if (!roles?.some(x => x.name === r.config.accessRole && !x.composite)) throw fail('Create the selected dedicated non-composite client role and assign only the reviewed users/group.');
    const actions = await get('/authentication/required-actions');
    // Reuse the existing G3 validator for the realm's stable RP/UV/discoverable
    // policy and required action, while supplying this client's exact ceremony.
    const issues = validateRealmSettings({ ...g3.config, realm: realm.realm, keycloakOrigin: new URL(r.config.issuer).origin, clientId: r.config.clientId, redirectUri: callbackFor(r) }, realm, c, [e[0]], actions);
    if (issues.length) throw fail('The existing Keycloak passwordless policy is not verified. Restore its accepted RP ID, required user verification and discoverable credentials; this guide does not change it.');
    const scopes = await get(`/clients/${encodeURIComponent(c.id)}/optional-client-scopes`);
    const defaults = await get(`/clients/${encodeURIComponent(c.id)}/default-client-scopes`);
    if (!['profile', 'email', 'offline_access'].every(n => [...(scopes || []), ...(defaults || [])].some(x => x.name === n))) throw fail('Assign the documented profile, email and offline_access scopes to this dedicated client.');
    return { clientId: c.clientId, callback: callbackFor(r), role: `${r.config.clientId}.${r.config.accessRole}`, flow: flow.alias, readOnly: true,
      fingerprint: digest([c, e, condition.config, realm.webAuthnPolicyPasswordlessRpId, realm.webAuthnPolicyPasswordlessResidentKey, realm.webAuthnPolicyPasswordlessUserVerificationRequirement]) };
  } catch (e) { if (e.vaultwardenSafe) throw e; throw fail('Read-only Keycloak verification failed. Existing clients, realm policy and ProxyPilot recovery were not changed.'); }
}
