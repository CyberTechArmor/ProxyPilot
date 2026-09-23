import { fail } from './full-platform-store.js';

export async function ensureOwnedGroup(api, base, k, name) {
  let groups = await api(`${base}/groups?search=${encodeURIComponent(name)}&exact=true`);
  let group = groups?.find(g => g.name === name && g.path === `/${name}`);
  if (!group) {
    await api(`${base}/groups`, { method: 'POST', body: { name, attributes: { 'proxypilot.installation': [k.id] } } });
    groups = await api(`${base}/groups?search=${encodeURIComponent(name)}&exact=true`);
    group = groups?.find(g => g.name === name && g.path === `/${name}`);
  }
  if (!group?.id) throw fail('The owned access group could not be created or read back.');
  const detail = await api(`${base}/groups/${group.id}`);
  if (detail?.attributes?.['proxypilot.installation']?.[0] !== k.id) throw fail('An access group name belongs to another configuration. Its memberships were preserved.');
  return detail;
}

export async function ensureVaultwardenFlow(api, base, k, clientId, accessRole = 'vault-user') {
  const alias = `pp-vaultwarden-${clientId}`, description = `ProxyPilot ${k.id}`, flowsPath = `${base}/authentication/flows`;
  let list = await api(flowsPath), flow = list?.find(f => f.alias === alias);
  if (!flow) { await api(flowsPath, { method: 'POST', body: { alias, description, providerId: 'basic-flow', topLevel: true, builtIn: false } }); list = await api(flowsPath); flow = list?.find(f => f.alias === alias); }
  if (!flow?.id || flow.description !== description || !flow.topLevel || flow.builtIn) throw fail('The Vaultwarden authentication flow is not owned by this installation.');
  const ep = `${flowsPath}/${encodeURIComponent(alias)}/executions`;
  let executions = await api(ep);
  const unexpected = executions?.filter(e => !['webauthn-authenticator-passwordless', 'conditional-user-role', 'deny-access-authenticator'].includes(e.providerId) && !e.authenticationFlow);
  if (!Array.isArray(executions) || unexpected.length) throw fail('The owned Vaultwarden flow has unexpected executions.');
  if (!executions.some(e => e.providerId === 'webauthn-authenticator-passwordless')) await api(`${ep}/execution`, { method: 'POST', body: { provider: 'webauthn-authenticator-passwordless' } });
  const subAlias = `${alias}-deny-unmapped`;
  executions = await api(ep);
  let sub = executions.find(e => e.authenticationFlow && e.displayName === subAlias);
  if (!sub) { await api(`${ep}/flow`, { method: 'POST', body: { alias: subAlias, description, type: 'basic-flow', provider: 'basic-flow' } }); executions = await api(ep); sub = executions.find(e => e.authenticationFlow && e.displayName === subAlias); }
  if (!sub) throw fail('The Vaultwarden deny subflow was not read back.');
  // The flows collection lists top-level flows only in Keycloak 26.7.4.
  // Resolve the child through the ID on the owned parent's execution.
  const child = sub.flowId && await api(`${flowsPath}/${sub.flowId}`);
  if (child?.description !== description || child.alias !== subAlias || child.topLevel || child.builtIn) throw fail('The Vaultwarden deny subflow has different ownership.');
  const subPath = `${flowsPath}/${encodeURIComponent(subAlias)}/executions`;
  for (const provider of ['conditional-user-role', 'deny-access-authenticator']) {
    const current = await api(subPath);
    if (!current.some(e => e.providerId === provider)) await api(`${subPath}/execution`, { method: 'POST', body: { provider } });
  }
  executions = await api(ep);
  if (executions.length !== 4 || executions[0].providerId !== 'webauthn-authenticator-passwordless' || executions[1].displayName !== subAlias || executions[2].providerId !== 'conditional-user-role' || executions[3].providerId !== 'deny-access-authenticator') throw fail('Vaultwarden authentication execution order differs from the reviewed required-passkey/deny flow.');
  for (let i = 0; i < executions.length; i++) {
    const requirement = i === 1 ? 'CONDITIONAL' : 'REQUIRED';
    if (executions[i].requirement !== requirement) await api(ep, { method: 'PUT', body: { ...executions[i], requirement } });
  }
  executions = await api(ep);
  const condition = executions[2], config = { condUserRole: `${clientId}.${accessRole}`, negate: 'true' };
  if (!condition.authenticationConfig) await api(`${base}/authentication/executions/${condition.id}/config`, { method: 'POST', body: { alias: `${alias}-role`, config } });
  const refreshed = (await api(ep))[2];
  const actual = refreshed.authenticationConfig && await api(`${base}/authentication/config/${refreshed.authenticationConfig}`);
  if (actual?.config?.condUserRole !== config.condUserRole || actual.config.negate !== 'true') throw fail('The Vaultwarden deny condition differs from the owned role.');
  return flow.id;
}

export async function ensureVaultwardenAccess(api, base, k, client, accessRole = 'vault-user') {
  const cp = `${base}/clients/${client.uuid}`, rolePath = `${cp}/roles/${accessRole}`;
  let role = await api(rolePath);
  const description = `ProxyPilot ${k.id}`;
  if (!role) { await api(`${cp}/roles`, { method: 'POST', body: { name: accessRole, description, composite: false } }); role = await api(rolePath); }
  if (!role?.id || role.description !== description || role.composite) throw fail('The Vaultwarden role does not match this owned installation.');
  const group = await ensureOwnedGroup(api, base, k, `pp-${k.id}-vaultwarden`);
  const groupRoles = `${base}/groups/${group.id}/role-mappings/clients/${client.uuid}`;
  const assigned = await api(groupRoles);
  if (assigned.some(r => r.id !== role.id)) throw fail('The owned vault access group has unexpected client-role grants.');
  if (!assigned.some(r => r.id === role.id)) await api(groupRoles, { method: 'POST', body: [role] });
  const allScopes = await api(`${base}/client-scopes`);
  for (const name of ['profile', 'email', 'offline_access']) {
    const scope = allScopes?.find(s => s.name === name && s.protocol === 'openid-connect');
    if (!scope) throw fail(`The standard ${name} scope is unavailable in Keycloak.`);
    const path = `${cp}/${name === 'offline_access' ? 'optional' : 'default'}-client-scopes`;
    const current = await api(path);
    if (!current.some(s => s.id === scope.id)) await api(`${path}/${scope.id}`, { method: 'PUT' });
  }
  return { group: group.id, role: role.id };
}
