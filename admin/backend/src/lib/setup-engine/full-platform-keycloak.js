import { ensureOwnedGroup, ensureVaultwardenFlow, ensureVaultwardenAccess } from './full-platform-vaultwarden.js';
import { readOpenBao } from './openbao-store.js';
import { callbackFor as baoCallback } from './openbao-logic.js';
import { readVaultwarden } from './vaultwarden-store.js';
import { callbackFor as vaultCallback } from './vaultwarden-logic.js';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { approvedFetch } from '../sso/oidc.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { readPrivate } from './pomerium-runtime.js';
import { KEYCLOAK_ROOT } from './keycloak-logic.js';
import { fail, digest } from './full-platform-store.js';
import { readConfig, readCredential } from '../sso/store.js';
import { readPomerium, pomeriumSecrets } from './pomerium-store.js';
import { secrets as baoSecrets } from './openbao-store.js';
import { secrets as vaultSecrets } from './vaultwarden-store.js';

export function protectedValue(db, id, create) {
  const row = db.prepare('SELECT value FROM setup_full_credentials WHERE id=?').get(id);
  if (row) return JSON.parse(decryptSecret(row.value));
  if (!create) throw fail('The protected setup reference is missing. Restore the matching credentials and encryption key.');
  const value = create();
  db.prepare('INSERT INTO setup_full_credentials VALUES (?,?)').run(id, encryptSecret(JSON.stringify(value)));
  return value;
}
export function storeProtected(db, id, value) {
  db.prepare('INSERT INTO setup_full_credentials VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, encryptSecret(JSON.stringify(value)));
}
export async function keycloakAdmin(k, password, { send = approvedFetch(k.origin), job, username = 'bootstrap-admin' } = {}) {
  const request = async (path, options) => { job?.fence(); const response = await send(k.origin + path, options); job?.fence(); return response; };
  const response = await request('/realms/master/protocol/openid-connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username, password }).toString() });
  if (!response.ok) throw fail('The existing Keycloak bootstrap administrator cannot authenticate. Keep the realm and use the reviewed bootstrap-administrator recovery (Platform overview → Keycloak → Recover bootstrap administrator, or recover_keycloak_bootstrap); no purge is needed.');
  const grant = await response.json();
  if (!grant.access_token) throw fail('Keycloak did not issue a bootstrap access token.');
  const token = grant.access_token;
  const api = async (path, { method = 'GET', body } = {}) => {
    const res = await request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 404) return null;
    if (!res.ok) throw fail(`Keycloak ${method} operation was refused (HTTP ${res.status}); provider response details are withheld.`);
    // Keycloak also returns empty 201 responses (users, flows and clients).
    const bodyText = await res.text();
    if (!bodyText) return {};
    try { return JSON.parse(bodyText); } catch { throw fail('Keycloak returned an invalid API response; details withheld.'); }
  };
  return { api, close: async () => {
    if (grant.refresh_token) await request('/realms/master/protocol/openid-connect/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'admin-cli', refresh_token: grant.refresh_token }).toString() }).catch(() => {});
  } };
}

// Only the host runner reads the existing G2 bootstrap file. No bootstrap
// token, password, client secret or provider response goes into job evidence.
export async function connectManagedKeycloak(db, k, full, { job, root = KEYCLOAK_ROOT, send } = {}) {
  if (k.ownership !== 'managed') throw fail('External Keycloak requires its owner’s explicit client connection flow. No external realm changes were authorized.');
  const identity = JSON.parse(readPrivate(join(root, k.id, 'owner.json')));
  if (identity.id !== k.id || identity.origin !== k.origin || identity.realm !== k.realm) throw fail('Keycloak protected ownership does not match the saved installation.');
  const credentials = JSON.parse(readPrivate(join(root, k.id, 'credentials.json')));
  if (!/^[A-Za-z0-9_-]{43}$/.test(credentials.bootstrap || '')) throw fail('Keycloak bootstrap credentials are unavailable; restore the existing recovery set.');
  const credentialRef = `keycloak-bootstrap-${k.id}`;
  job.fence();
  const prior = db.prepare('SELECT value FROM setup_full_credentials WHERE id=?').get(credentialRef);
  const recorded = prior ? protectedValue(db, credentialRef) : null;
  // After a reviewed bootstrap recovery (3h) the protected reference holds the
  // recovered account; the host file still holds the original, lost one.
  if (recorded && !recorded.recovered && recorded.password !== credentials.bootstrap) throw fail('Recorded bootstrap credentials differ from the host recovery set. No rotation was attempted.');
  if (!prior) storeProtected(db, credentialRef, { password: credentials.bootstrap, installationId: k.id, retired: false });
  // Make the initial credential available even if a later service connection
  // pauses. Persist only its protected reference under this operation's fence.
  db.prepare('UPDATE setup_full_platform SET state_json=? WHERE id=1 AND revision=? AND last_job_id=?').run(JSON.stringify({ ...full.state, identity: { ...full.state.identity, bootstrapRef: credentialRef } }), full.revision, job.id);
  const admin = recorded?.recovered ? await keycloakAdmin(k, recorded.password, { job, send, username: recorded.username }) : await keycloakAdmin(k, credentials.bootstrap, { job, send });
  try { return await reconcileOwnedIdentity(db, k, full, admin.api, job); }
  finally { await admin.close(); }
}

export async function reconcileOwnedIdentity(db, k, full, api, job) {
  const base = `/admin/realms/${encodeURIComponent(k.realm)}`, marker = `ProxyPilot ${k.id}`;
  const realm = await api(base);
  if (realm?.attributes?.['proxypilot.installation'] !== k.id) throw fail('This realm does not carry the managed installation ownership marker. Existing realm settings were preserved.');
  // Keycloak updates this policy as a unit when its entity name is present.
  // Preserve all unrelated passwordless policy fields in that same unit.
  const policy = { ...Object.fromEntries(Object.entries(realm).filter(([key]) => key.startsWith('webAuthnPolicyPasswordless'))), webAuthnPolicyPasswordlessRpId: new URL(k.origin).hostname, webAuthnPolicyPasswordlessUserVerificationRequirement: 'required', webAuthnPolicyPasswordlessResidentKey: 'required' };
  if (Object.entries(policy).some(([key, value]) => digest(realm[key]) !== digest(value))) await api(base, { method: 'PUT', body: policy });
  const policyReadback = await api(base);
  if (Object.entries(policy).some(([key, value]) => digest(policyReadback?.[key]) !== digest(value))) throw fail('Required discoverable-passkey policy was not accepted by Keycloak.');
  const actions = await api(`${base}/authentication/required-actions`);
  const action = actions?.find(a => a.alias === 'webauthn-register-passwordless');
  if (!action) throw fail('The pinned Keycloak release does not expose passwordless enrollment.');
  if (!action.enabled) await api(`${base}/authentication/required-actions/webauthn-register-passwordless`, { method: 'PUT', body: { ...action, enabled: true } });
  const alias = `pp-${k.id}-passkey`, flowPath = `${base}/authentication/flows`;
  let flows = await api(flowPath), flow = flows?.find(f => f.alias === alias);
  if (flow && flow.description !== marker) throw fail('The intended passkey flow belongs to another configuration.');
  if (!flow) { await api(flowPath, { method: 'POST', body: { alias, description: marker, providerId: 'basic-flow', topLevel: true, builtIn: false } }); flows = await api(flowPath); flow = flows?.find(f => f.alias === alias); }
  if (!flow?.id || flow.description !== marker) throw fail('Owned passkey flow was not read back.');
  const executionsPath = `${flowPath}/${encodeURIComponent(alias)}/executions`;
  let executions = await api(executionsPath);
  if (!executions?.length) { await api(`${executionsPath}/execution`, { method: 'POST', body: { provider: 'webauthn-authenticator-passwordless' } }); executions = await api(executionsPath); }
  if (executions?.length !== 1 || executions[0].providerId !== 'webauthn-authenticator-passwordless' || executions[0].authenticationFlow) throw fail('Owned passkey flow has unexpected executions; no authentication flow was replaced.');
  if (executions[0].requirement !== 'REQUIRED') await api(executionsPath, { method: 'PUT', body: { ...executions[0], requirement: 'REQUIRED' } });

  const ensureClient = async (kind, callback, serviceAccount = false, groups = false, options = {}) => {
    // Already reviewed adapter records authorize read-only reuse, not adopting
    // those clients or silently changing their flow, credential or grants.
    const sso = readConfig(db), p = readPomerium(db), b = readOpenBao(db), v = readVaultwarden(db);
    const previous = kind === 'proxypilot' ? sso && [sso.config.clientId, () => readCredential(db, sso.config.clientSecretRef)]
      : kind === 'observer' ? sso && [sso.config.readerClientId, () => readCredential(db, sso.config.readerSecretRef)]
      : kind === 'pomerium' ? p && [p.config.clientId, () => pomeriumSecrets(db, p).client]
      : kind === 'openbao' ? b && [b.config.clientId, () => baoSecrets(db, b).client]
      : v && [v.config.clientId, () => vaultSecrets(db, v).client];
    const clientId = `pp-${k.id}-${kind}`, ref = `keycloak-client-${k.id}-${kind}`;
    if (previous && previous[0] !== clientId) {
      const existing = (await api(`${base}/clients?clientId=${encodeURIComponent(previous[0])}`))?.find(c => c.clientId === previous[0]);
      if (!existing?.id || (await api(`${base}/clients/${existing.id}/client-secret`))?.value !== previous[1]()) throw fail(`The recorded ${kind} connection cannot be reused. Its existing client and credential were preserved.`);
      const reusedRef = `keycloak-reused-${k.id}-${kind}`;
      const credential = protectedValue(db, reusedRef, () => ({ secret: previous[1]() }));
      if (credential.secret !== previous[1]()) throw fail(`The recorded ${kind} credential changed; no automatic rotation is permitted.`);
      return { id: existing.clientId, uuid: existing.id, ref: reusedRef, reused: true };
    }
    const secret = protectedValue(db, ref, () => ({ secret: randomBytes(32).toString('base64url') })).secret;
    const wanted = { clientId, protocol: 'openid-connect', enabled: true, publicClient: false, bearerOnly: false, standardFlowEnabled: !serviceAccount, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: serviceAccount, fullScopeAllowed: false, redirectUris: callback ? [callback] : [], webOrigins: callback ? [new URL(callback).origin] : [], attributes: { 'proxypilot.installation': k.id, 'pkce.code.challenge.method': 'S256', 'id.token.signed.response.alg': 'RS256', ...(options.tokenLifetime ? { 'access.token.lifespan': options.tokenLifetime } : {}) }, ...(options.flow ? { authenticationFlowBindingOverrides: { browser: options.flow } } : {}), ...(kind === 'proxypilot' ? { authenticationFlowBindingOverrides: { browser: flow.id } } : {}) };
    const listPath = `${base}/clients?clientId=${encodeURIComponent(clientId)}`;
    let matches = await api(listPath), client = matches?.find(c => c.clientId === clientId);
    if (!client) { await api(`${base}/clients`, { method: 'POST', body: { ...wanted, secret } }); matches = await api(listPath); client = matches?.find(c => c.clientId === clientId); }
    if (!client?.id || client.attributes?.['proxypilot.installation'] !== k.id) throw fail(`The ${kind} client is not owned by this installation.`);
    for (const [field, value] of Object.entries(wanted)) {
      if (field === 'attributes') { if (Object.entries(value).some(([a, v]) => client.attributes?.[a] !== v)) throw fail(`The ${kind} client attributes differ from the reviewed connection.`); }
      else if (digest(client[field]) !== digest(value)) throw fail(`The ${kind} client ${field} differs. Existing configuration was preserved.`);
    }
    const actual = await api(`${base}/clients/${client.id}/client-secret`);
    if (actual?.value !== secret) throw fail(`The ${kind} client credential differs; retry will not rotate it.`);
    if (groups) {
      const mpath = `${base}/clients/${client.id}/protocol-mappers/models`, mapperName = `pp-${k.id}-groups`;
      const mapper = { name: mapperName, protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper', config: { 'claim.name': 'groups', 'full.path': 'true', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true' } };
      let mappers = await api(mpath), existing = mappers?.find(m => m.name === mapperName);
      if (!existing) { await api(mpath, { method: 'POST', body: mapper }); mappers = await api(mpath); existing = mappers?.find(m => m.name === mapperName); }
      if (!existing || existing.protocolMapper !== mapper.protocolMapper || Object.entries(mapper.config).some(([a, v]) => existing.config?.[a] !== v)) throw fail(`The ${kind} group mapper was not verified.`);
    }
    job.fence(); return { id: clientId, uuid: client.id, ref };
  };
  const clients = { proxypilot: await ensureClient('proxypilot', `${full.config.publicOrigin}/api/auth/sso/callback`), observer: await ensureClient('observer', null, true) };
  // The observer retains only the three existing G3 read roles. No unrestricted
  // administration credential is retained as an automation identity.
  if (!clients.observer.reused) {
  const management = (await api(`${base}/clients?clientId=realm-management`))?.find(c => c.clientId === 'realm-management');
  const observer = await api(`${base}/clients/${clients.observer.uuid}/service-account-user`);
  if (!management?.id || !observer?.id) throw fail('The read-only observer identity could not be read back.');
  const rolePath = `${base}/users/${observer.id}/role-mappings/clients/${management.id}`;
  const wantedRoles = await Promise.all(['view-realm', 'view-clients', 'view-users'].map(role => api(`${base}/clients/${management.id}/roles/${role}`)));
  const assigned = await api(rolePath);
  if (!Array.isArray(assigned) || assigned.some(r => !wantedRoles.some(w => w?.id === r.id))) throw fail('The observer has unexpected management privileges. Existing grants were preserved.');
  const absent = wantedRoles.filter(w => w?.id && !assigned.some(a => a.id === w.id));
  if (absent.length) await api(rolePath, { method: 'POST', body: absent });
  const scopePath = `${base}/clients/${clients.observer.uuid}/scope-mappings/clients/${management.id}`;
  const scoped = await api(scopePath);
  if (!Array.isArray(scoped) || scoped.some(r => !wantedRoles.some(w => w?.id === r.id))) throw fail('The observer role scope contains unexpected management privileges.');
  const unscoped = wantedRoles.filter(w => w?.id && !scoped.some(s => s.id === w.id));
  if (unscoped.length) await api(scopePath, { method: 'POST', body: unscoped });
  const readback = await api(rolePath);
  const scopeReadback = await api(scopePath);
  if (wantedRoles.some(w => !w?.id || !readback?.some(a => a.id === w.id) || !scopeReadback?.some(a => a.id === w.id))) throw fail('The read-only observer grants could not be verified.');
  }
  if (full.config.services.pomerium.mode !== 'skip') clients.pomerium = await ensureClient('pomerium', `${full.config.services.pomerium.url}/oauth2/callback`);
  const groups = {};
  const bao = readOpenBao(db);
  if (bao && full.config.services.openbao.mode !== 'skip') {
    clients.openbao = await ensureClient('openbao', baoCallback(bao), false, true);
    if (!clients.openbao.reused) groups.openbao = (await ensureOwnedGroup(api, base, k, `pp-${k.id}-openbao`)).id;
  }
  const vault = readVaultwarden(db);
  if (vault && full.config.services.vaultwarden.mode !== 'skip') {
    if (vault.config.clientId !== `pp-${k.id}-vaultwarden`) {
      clients.vaultwarden = await ensureClient('vaultwarden', vaultCallback(vault));
    } else {
    const flowId = await ensureVaultwardenFlow(api, base, k, vault.config.clientId, vault.config.accessRole);
    clients.vaultwarden = await ensureClient('vaultwarden', vaultCallback(vault), false, false, { flow: flowId, tokenLifetime: '600' });
    groups.vaultwarden = (await ensureVaultwardenAccess(api, base, k, clients.vaultwarden, vault.config.accessRole)).group;
    }
  }
  return { clients, groups, flow: alias, issuer: `${k.origin}/realms/${k.realm}`, policy: 'discoverable passkeys with required user verification', bootstrapRef: `keycloak-bootstrap-${k.id}` };
}
