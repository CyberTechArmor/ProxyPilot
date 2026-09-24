// API contract: Infisical v0.165.15 tagged routes, documented in the FP guide.
import { z } from 'zod';
import { protectedValue, storeProtected } from './full-platform-keycloak.js';
import { infisicalSecrets } from './infisical-store.js';
import { encryptSecret } from '../secrets.js';
import { requireOk, verifyInfisicalIdentities, scopeQuery, sameBuiltinRole } from './infisical-api.js';
import { BUILTIN_ROLES, desiredProxiedService, TEST_ENV, TEST_PATH, infisicalIdentitiesSchema, infisicalError as fail } from './infisical-logic.js';

export const personalSchema = z.object({ revision: z.number().int().positive(), email: z.string().email().max(254), password: z.string().min(12).max(256), reviewed: z.literal(true) }).strict();
export const personalRef = r => `full-infisical-personal-${r.credential_ref}`;
const uuid = value => z.string().uuid().parse(value);
const jwt = value => { try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url')); } catch { throw fail('Infisical issued an unsupported authority token.'); } };

export async function provisionManagedInfisical(db, r, api, { job, now = Date.now(), ensureProxySecret = null }) {
  if (!r.config.basic || r.config.mode !== 'install') throw fail('Automatic organization provisioning is limited to the owned basic installation.');
  const ref = `full-infisical-provision-${r.credential_ref}`;
  const s = protectedValue(db, ref, () => ({ identities: {}, owner: r.credential_ref }));
  if (s.owner !== r.credential_ref) throw fail('Infisical provisioning ownership differs. No existing organization was adopted.');
  const persist = () => { job.fence(); storeProtected(db, ref, s); };
  let input;
  if (db.prepare('SELECT id FROM setup_full_credentials WHERE id=?').get(personalRef(r))) input = protectedValue(db, personalRef(r));
  if (input?.expiresAt < now) { db.prepare('DELETE FROM setup_full_credentials WHERE id=?').run(personalRef(r)); input = null; }
  try {
  if (s.complete && r.identities) return { ready: true };
  if (s.retirementAttempted && r.identities && s.token && !s.personalAuthority && [401, 403].includes((await api('/api/v1/identities/details', { token: s.token })).status)) {
    await verifyInfisicalIdentities(r, infisicalSecrets(db, r), api);
    delete s.token; delete s.tokenExpiresAt;
    for (const i of Object.values(s.identities)) delete i.clientSecret;
    s.complete = true; persist(); return { ready: true };
  }
  const initialized = requireOk(await api('/api/v1/admin/config'), 'Infisical initialization').config?.initialized;
  if (initialized !== true) {
    if (!input) return { ready: false, action: 'Choose the Infisical administrator’s personal password. This edition uses its local human login; Keycloak human SSO is not enabled.' };
    if (s.organizationId) throw fail('A previously initialized Infisical instance is now empty. Restore its matching data and protected keys; no second organization was created.');
    s.bootstrapAttempted = true; persist();
    const result = requireOk(await api('/api/v1/admin/bootstrap', { method: 'POST', body: { email: input.email, password: input.password, organization: `ProxyPilot ${r.credential_ref.slice(-12)}` } }), 'Owned Infisical bootstrap');
    s.organizationId = uuid(result.organization?.id); s.bootstrapIdentityId = uuid(result.identity?.id); s.userId = uuid(result.user?.id); s.email = input.email;
    s.originalToken = result.identity?.credentials?.token;
    if (!s.originalToken) throw fail('Infisical bootstrap did not return its one-time authority. Recover administration without resetting the service.');
    persist();
  }
  if (!s.organizationId) throw fail('This Infisical instance is already initialized without this installation’s bootstrap receipt. Restore the matching protected Infisical set; existing organizations and users were preserved.');
  const request = async (path, options = {}) => api(path, { ...options, token: options.token || s.token });
  // Upstream bootstrap creates an unrestricted token. Replace it immediately
  // with a 15-minute token, revoke the original, and retain no refresh token.
  if (s.originalToken && s.token && [401, 403].includes((await api('/api/v1/identities/details', { token: s.originalToken })).status)) {
    delete s.originalToken; persist();
  }
  if (s.originalToken) {
    const authPath = `/api/v1/auth/token-auth/identities/${s.bootstrapIdentityId}`;
    requireOk(await api(authPath, { method: 'PATCH', token: s.originalToken, body: { accessTokenTTL: 900, accessTokenMaxTTL: 900, accessTokenNumUsesLimit: 0 } }), 'Bound bootstrap token lifetime');
    if (!s.token || s.tokenExpiresAt <= now) {
      const grant = requireOk(await api(`${authPath}/tokens`, { method: 'POST', token: s.originalToken, body: { name: `ProxyPilot ${r.credential_ref}` } }), 'Temporary provisioning token');
      if (grant.expiresIn > 900 || grant.expiresIn < 30) throw fail('Infisical did not issue the bounded provisioning authority.');
      s.token = grant.accessToken; s.tokenExpiresAt = now + grant.expiresIn * 1000; persist();
    }
    const originalId = uuid(jwt(s.originalToken).identityAccessTokenId);
    requireOk(await request(`/api/v1/auth/token-auth/tokens/${originalId}/revoke`, { method: 'POST' }), 'Original bootstrap token retirement');
    if (![401, 403].includes((await api('/api/v1/identities/details', { token: s.originalToken })).status)) throw fail('Original Infisical bootstrap token retirement was not verified.');
    delete s.originalToken; persist();
  }
  if (!s.token || s.tokenExpiresAt <= now) {
    if (!input) return { ready: false, action: 'Fresh Infisical administration is required to resume the saved connection. Re-enter the same personal credential; users and machine credentials are retained.' };
    if (input.email !== s.email) throw fail('Resume as the recorded Infisical administrator. No account is selected by an unverified matching email.');
    const attempt = await api('/api/v3/auth/login', { method: 'POST', body: { email: input.email, password: input.password } });
    // Infisical answers 400 "Invalid credentials" for a password that differs
    // from the one the account was created with (the email matched above).
    if (attempt.status === 400) throw fail(`Infisical refused the sign-in for ${input.email}${attempt.error ? ` ("${String(attempt.error).slice(0, 120)}")` : ''}: the password does not match the one this Infisical account was created with. Enter that original password, or start Infisical over with Platform overview → Manage Infisical → Reset Infisical data (a verified backup is kept) and choose a new one.`);
    const login = requireOk(attempt, 'Fresh Infisical administrator login');
    const selected = requireOk(await api('/api/v3/auth/select-organization', { method: 'POST', token: login.accessToken, body: { organizationId: s.organizationId } }), 'Recorded organization administration');
    if (selected.isMfaEnabled || !selected.token) throw fail('Infisical requires its interactive MFA ceremony. Complete the owner-authorized handoff in Infisical; no MFA bypass is attempted.');
    if (jwt(selected.token).userId !== s.userId) throw fail('The fresh Infisical administrator differs from the recorded bootstrap identity.');
    s.token = selected.token; s.tokenExpiresAt = Math.min(jwt(selected.token).exp * 1000, now + 900_000); s.personalAuthority = true; persist();
  }
  const owned = `ProxyPilot ${r.credential_ref}`, slug = `proxypilot-${r.credential_ref.slice(-12)}`;
  {
    let projects = requireOk(await request('/api/v1/projects'), 'Owned project inventory').projects;
    let project = projects?.find(p => p.slug === slug);
    if (!project) {
      // /api/v1/projects lists only projects the CALLER belongs to. A resume
      // under the personal login cannot see the project the bootstrap
      // identity created on the first run, and creating it again fails with
      // "slug already exists". Find it organization-wide, then join it as the
      // organization admin, before the ownership checks below.
      // Prefer the project id recorded on the first run; otherwise page through
      // the organization's projects unfiltered (its `search` matches names,
      // not slugs) and match the slug exactly.
      let existing = s.projectId ? { id: s.projectId } : null;
      for (let offset = 0; !existing && offset < 1000; offset += 100) {
        const page = requireOk(await request(`/api/v1/organization-admin/projects?${new URLSearchParams({ offset: String(offset), limit: '100' })}`), 'Organization project inventory').projects || [];
        existing = page.find(p => p.slug === slug) || null;
        if (page.length < 100) break;
      }
      if (existing) {
        if (existing.orgId && existing.orgId !== s.organizationId || s.projectId && s.projectId !== existing.id) throw fail('The intended Infisical project is not this installation’s recorded resource.');
        requireOk(await request(`/api/v1/organization-admin/projects/${uuid(existing.id)}/grant-admin-access`, { method: 'POST', body: {} }), 'Administrator access to the owned project');
        projects = requireOk(await request('/api/v1/projects'), 'Owned project inventory').projects;
        project = projects?.find(p => p.slug === slug);
        if (!project) throw fail('The owned Infisical project exists but is still not visible to this administrator after joining it.');
      }
    }
    if (!project) project = requireOk(await request('/api/v1/projects', { method: 'POST', body: { projectName: 'ProxyPilot', slug, projectDescription: owned, type: 'secret-manager', shouldCreateDefaultEnvs: false } }), 'Dedicated project creation').project;
    if (project?.orgId !== s.organizationId || project.description !== owned || s.projectId && s.projectId !== project.id) throw fail('The intended Infisical project is not this installation’s recorded resource.');
    s.projectId = uuid(project.id); persist();
    project = requireOk(await request(`/api/v1/projects/${s.projectId}`), 'Owned project readback').project;
    if (!project.environments?.some(e => e.slug === TEST_ENV)) requireOk(await request(`/api/v1/projects/${s.projectId}/environments`, { method: 'POST', body: { name: 'ProxyPilot connection checks', slug: TEST_ENV } }), 'Owned environment creation');
    const folderQuery = new URLSearchParams({ projectId: s.projectId, environment: TEST_ENV, path: '/' });
    const folders = requireOk(await request(`/api/v2/folders?${folderQuery}`), 'Owned folder inventory').folders;
    const folder = folders?.find(f => f.name === TEST_PATH.slice(1));
    if (folder && folder.description !== owned) throw fail('The intended secret folder belongs to a different configuration.');
    if (!folder) requireOk(await request('/api/v2/folders', { method: 'POST', body: { projectId: s.projectId, environment: TEST_ENV, name: TEST_PATH.slice(1), path: '/', description: owned } }), 'Owned secret folder');
    const kinds = ['workload', ...(r.config.agentMode === 'skip' ? [] : ['proxy', 'agent'])];
    for (const kind of kinds) {
      const name = `${slug}-${kind}`;
      let list = requireOk(await request(`/api/v1/identities?orgId=${s.organizationId}`), 'Identity inventory').identities;
      let identity = list?.find(i => i.identity?.name === name)?.identity;
      if (!identity) identity = requireOk(await request('/api/v1/identities', { method: 'POST', body: { name, organizationId: s.organizationId, role: 'no-access', metadata: [{ key: 'proxypilot', value: r.credential_ref }] } }), 'Scoped identity creation').identity;
      const detail = requireOk(await request(`/api/v1/identities/${uuid(identity?.id)}`), 'Identity ownership').identity;
      if (!detail?.metadata?.some(m => m.key === 'proxypilot' && m.value === r.credential_ref) || s.identities[kind]?.identityId && s.identities[kind].identityId !== identity.id) throw fail('A machine identity name collides with an unowned identity.');
      s.identities[kind] = { ...s.identities[kind], identityId: identity.id }; persist();
    }
    for (const kind of kinds) {
      // Built-in project role (free edition: custom roles are Enterprise-only).
      const i = s.identities[kind], roleSlug = BUILTIN_ROLES[kind];
      const membershipPath = `/api/v1/projects/${s.projectId}/memberships/identities/${i.identityId}`;
      const body = { roles: [{ role: roleSlug, isTemporary: false }] };
      const membership = await request(membershipPath);
      if (membership.status === 404) requireOk(await request(membershipPath, { method: 'POST', body }), 'Project membership (built-in role)');
      else if (!sameBuiltinRole(requireOk(membership, 'Project membership readback'), roleSlug)) requireOk(await request(membershipPath, { method: 'PATCH', body }), 'Project membership role update');
      if (!sameBuiltinRole(requireOk(await request(membershipPath), 'Project membership readback'), roleSlug)) throw fail(`The ${kind} identity must hold exactly the built-in ${roleSlug} project role and nothing else.`);
      const uaPath = `/api/v1/auth/universal-auth/identities/${i.identityId}`;
      let response = await request(uaPath);
      if (response.status === 404) response = await request(uaPath, { method: 'POST', body: { accessTokenTTL: 300, accessTokenMaxTTL: 300, accessTokenNumUsesLimit: 0, accessTokenPeriod: 0 } });
      const ua = requireOk(response, 'Scoped Universal Auth').identityUniversalAuth;
      if (ua.accessTokenTTL !== 300 || ua.accessTokenMaxTTL !== 300 || ua.accessTokenPeriod) throw fail('Existing machine-token lifetime differs from the reviewed 300-second profile.');
      i.clientId = uuid(ua.clientId);
      if (!i.clientSecret) {
        if (i.secretAttempted) throw fail('Machine secret issuance was interrupted before its protected receipt. Recover that issued credential through the owner; no new secret was generated.');
        const issued = requireOk(await request(`${uaPath}/client-secrets`), 'Machine credential inventory').clientSecretData;
        if (issued?.length) throw fail('This identity already has an unrecorded credential. It was not replaced.');
        i.secretAttempted = true; persist();
        i.clientSecret = requireOk(await request(`${uaPath}/client-secrets`, { method: 'POST', body: { description: owned, numUsesLimit: 0, ttl: 0 } }), 'Machine credential issuance').clientSecret; persist();
      }
    }
    if (r.config.agentMode !== 'skip') {
      const listed = requireOk(await request(`/api/v1/proxied-services?${scopeQuery(s.projectId)}`), 'Static Agent Proxy capability').services;
      if (!listed?.length) { if (ensureProxySecret) await ensureProxySecret(s.projectId, s.token); requireOk(await request('/api/v1/proxied-services', { method: 'POST', body: desiredProxiedService(r.config, s.projectId) }), 'Owned proxied destination'); }
    }
    const inputIdentities = infisicalIdentitiesSchema.parse({ expectedRevision: r.revision, organizationId: s.organizationId, projectId: s.projectId, ...Object.fromEntries(kinds.map(k => [k, { identityId: s.identities[k].identityId, clientId: s.identities[k].clientId, clientSecret: s.identities[k].clientSecret }])), reviewed: true });
    const identities = { organizationId: s.organizationId, projectId: s.projectId, ...Object.fromEntries(kinds.map(k => [k, { identityId: inputIdentities[k].identityId, clientId: inputIdentities[k].clientId }])) };
    const values = Object.fromEntries(kinds.map(k => [k, inputIdentities[k].clientSecret]));
    await verifyInfisicalIdentities({ ...r, identities }, values, api);
    job.fence();
    db.prepare('UPDATE setup_infisical_credentials SET value=? WHERE id=?').run(encryptSecret(JSON.stringify(values)), r.credential_ref);
    db.prepare('UPDATE setup_infisical SET identities_json=? WHERE id=1 AND revision=? AND last_job_id=?').run(JSON.stringify(identities), r.revision, job.id);
    if (!s.personalAuthority) {
      s.retirementAttempted = true; persist();
      requireOk(await request(`/api/v1/auth/token-auth/identities/${s.bootstrapIdentityId}`, { method: 'DELETE' }), 'Bootstrap authentication retirement');
      if (![401, 403].includes((await api('/api/v1/identities/details', { token: s.token })).status)) throw fail('Infisical bootstrap authority retirement was not verified.');
    }
    delete s.token; delete s.tokenExpiresAt;
    for (const i of Object.values(s.identities)) delete i.clientSecret;
    s.complete = true; persist();
    return { ready: true };
  }
  } finally {
    job.fence(); db.prepare('DELETE FROM setup_full_credentials WHERE id=?').run(personalRef(r)); input = null;
    if (s.originalToken) {
      // A failed lifetime reduction must not silently leave the original
      // unrestricted grant available. Keep an explicit recovery receipt when
      // its revocation cannot be observed; the operation cannot pass.
      try {
        await api(`/api/v1/auth/token-auth/tokens/${uuid(jwt(s.originalToken).identityAccessTokenId)}/revoke`, { method: 'POST', token: s.token || s.originalToken });
        if ([401, 403].includes((await api('/api/v1/identities/details', { token: s.originalToken })).status)) delete s.originalToken;
      } finally { persist(); }
    }
    // No personal password/refresh token becomes a lasting automation credential.
    if (s.personalAuthority) { delete s.token; delete s.tokenExpiresAt; delete s.personalAuthority; persist(); }
  }
}
