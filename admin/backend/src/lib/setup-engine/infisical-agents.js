// Per-agent Infisical projects (docs/features/agents.md § Infisical). The free
// edition lets only its built-in Admin role use the Agent Proxy, so an agent
// identity is always Admin of some project. Here that project is the agent's
// OWN: it holds only that agent's credentials, so a compromised agent can read
// its own values but nothing of any other agent or of ProxyPilot's project.
// The managed Agent Proxy identity joins each agent project as Viewer so it can
// substitute the values. Changes are made as the Infisical administrator
// (password from OpenBao when kept there, else typed for that one request);
// ProxyPilot keeps only names and IDs (infisical_agents), never a value.
import { z } from 'zod';
import { readInfisical } from './infisical-store.js';
import { createInfisicalClient, requireOk } from './infisical-api.js';
import { infisicalError as fail } from './infisical-logic.js';
import { protectedValue } from './full-platform-keycloak.js';
import { infisicalAdminVault } from './infisical-admin-vault.js';
import { localEdge } from './local-edge.js';

export const INFISICAL_AGENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS infisical_agents(
  name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL, identity_id TEXT NOT NULL,
  client_id TEXT NOT NULL, client_secret_id TEXT, credentials_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
export const AGENT_ENV = 'agent', AGENT_PATH = '/';

const agentName = z.string().regex(/^[a-z][a-z0-9-]{1,29}$/, 'Agent names are 2–30 lower-case letters, digits or dashes, starting with a letter.');
const keyName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Credential names are up to 64 upper-case letters, digits or underscores, starting with a letter (for example OPENAI_API_KEY).');
// The sites the proxy may put this credential into: host[:port][/path], comma
// separated, no scheme (Infisical's own grammar; it re-validates).
const hostPattern = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9*.:\-/,\[\] ]+$/, 'Sites are host[:port][/path] entries without https://, comma separated.').refine(v => !v.includes('://'), 'Leave out https:// in the site.');
const password = z.string().min(12).max(256).optional();
export const createSchema = z.object({ name: agentName, description: z.string().max(200).default(''), password, reviewed: z.literal(true) }).strict();
export const credentialSchema = z.object({ value: z.string().min(1).max(16384), hostPattern, surfaces: z.array(z.enum(['header', 'query', 'path', 'body'])).min(1).max(4).default(['header']), password, reviewed: z.literal(true) }).strict();
export const authoritySchema = z.object({ password }).strict();
export const parseName = v => agentName.parse(v);
export const parseKey = v => keyName.parse(v);

export const projectSlug = name => `pp-agent-${name}`;
export const placeholderFor = (name, key) => `pp-placeholder-${name}-${key.toLowerCase()}`;
export const serviceName = key => `pp-${key.toLowerCase().replace(/_/g, '-')}`;

const table = db => !!db.prepare("SELECT name FROM sqlite_master WHERE name='infisical_agents'").get();
const rowOf = (db, name) => table(db) ? db.prepare('SELECT * FROM infisical_agents WHERE name=?').get(name) : null;
const mustRow = (db, name) => { const row = rowOf(db, name); if (!row) throw fail(`No Infisical agent named ${name} is registered.`); return row; };
const view = row => row && { name: row.name, description: row.description, projectId: row.project_id, clientId: row.client_id, credentials: JSON.parse(row.credentials_json), createdAt: row.created_at, updatedAt: row.updated_at };
const provisionOf = (db, r) => { try { return protectedValue(db, `full-infisical-provision-${r.credential_ref}`); } catch { return null; } };

const contextOf = db => { const r = readInfisical(db); return { r, s: r ? provisionOf(db, r) : null }; };
const isReady = ({ r, s }) => !!(r?.config?.basic && r.config.mode === 'install' && r.identities?.proxy && s?.complete && s.email);
export function infisicalAgentsState(db, { context = contextOf } = {}) {
  const { r, s } = context(db), ready = isReady({ r, s });
  return { ready, reason: ready ? null : 'Finish Infisical with the Agent Proxy first.', origin: r?.config?.origin || null, proxyOrigin: r?.config?.proxyOrigin || null,
    environment: AGENT_ENV, administrator: s?.email || null, passwordInOpenBao: !!s?.passwordInOpenBao,
    agents: table(db) ? db.prepare('SELECT * FROM infisical_agents ORDER BY name').all().map(view) : [] };
}

// Sign in as the recorded Infisical administrator for this request only.
export async function adminSession(db, { password: typed } = {}, { api: injected, vault = infisicalAdminVault, context = contextOf } = {}) {
  const { r, s } = context(db);
  if (!isReady({ r, s })) throw fail('Finish Infisical with the Agent Proxy first.');
  const api = injected || createInfisicalClient(r.config.origin, { edge: localEdge(db) });
  const password = typed || (s.passwordInOpenBao ? await vault(db, { email: s.email, origin: r.config.origin, fresh: false }) : null);
  if (!password) throw fail(`Enter the Infisical administrator password for ${s.email} (it is used for this change only), or keep it in OpenBao so ProxyPilot reads it there.`);
  const login = await api('/api/v3/auth/login', { method: 'POST', body: { email: s.email, password } });
  if (login.status === 400) throw fail(`Infisical refused the administrator sign-in for ${s.email}: the password does not match.`);
  const first = requireOk(login, 'Infisical administrator sign-in');
  const selected = requireOk(await api('/api/v3/auth/select-organization', { method: 'POST', token: first.accessToken, body: { organizationId: r.identities.organizationId } }), 'Infisical organization');
  if (selected.isMfaEnabled || !selected.token) throw fail('The Infisical administrator has two-factor authentication on, which ProxyPilot cannot complete. Make this change in Infisical itself.');
  const token = selected.token;
  let claims = null; try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { /* checked below */ }
  if (!claims || claims.userId !== s.userId) throw fail('The Infisical sign-in is not the recorded administrator. Nothing was changed.');
  return { r, s, call: (path, options = {}) => api(path, { ...options, token }) };
}
const ok = (res, label) => requireOk(res, label);
const accepted = (res, label) => { if (![200, 204].includes(res.status)) requireOk(res, label); return res.body; };

// Register: the agent's own project, environment, identity (org No Access,
// Admin of its own project only), the proxy as Viewer, and one client secret
// shown once.
export async function createAgent(db, raw, user, deps = {}) {
  const input = createSchema.parse(raw);
  if (!table(db)) throw fail('The agent registry is not available; restart ProxyPilot so its migration runs.');
  if (rowOf(db, input.name)) throw fail(`An Infisical agent named ${input.name} is already registered.`);
  const { r, call } = await adminSession(db, input, deps);
  const marker = `ProxyPilot agent ${input.name} (${r.credential_ref})`, slug = projectSlug(input.name);
  const created = await call('/api/v1/projects', { method: 'POST', body: { projectName: `Agent ${input.name}`, slug, projectDescription: marker, type: 'secret-manager', shouldCreateDefaultEnvs: false } });
  if (created.status === 400) throw fail(`An Infisical project with the slug ${slug} already exists. Nothing was overwritten.`);
  const project = ok(created, 'Agent project').project;
  try {
    ok(await call(`/api/v1/projects/${project.id}/environments`, { method: 'POST', body: { name: 'Agent credentials', slug: AGENT_ENV } }), 'Agent environment');
    const identity = ok(await call('/api/v1/identities', { method: 'POST', body: { name: slug, organizationId: r.identities.organizationId, role: 'no-access', metadata: [{ key: 'proxypilot-agent', value: r.credential_ref }] } }), 'Agent identity').identity;
    const member = (identityId, role) => call(`/api/v1/projects/${project.id}/memberships/identities/${identityId}`, { method: 'POST', body: { roles: [{ role, isTemporary: false }] } });
    ok(await member(identity.id, 'admin'), 'Agent project membership');
    ok(await member(r.identities.proxy.identityId, 'viewer'), 'Agent Proxy membership');
    const ua = ok(await call(`/api/v1/auth/universal-auth/identities/${identity.id}`, { method: 'POST', body: { accessTokenTTL: 300, accessTokenMaxTTL: 300, accessTokenNumUsesLimit: 0, accessTokenPeriod: 0 } }), 'Agent Universal Auth').identityUniversalAuth;
    const secret = ok(await call(`/api/v1/auth/universal-auth/identities/${identity.id}/client-secrets`, { method: 'POST', body: { description: marker, numUsesLimit: 0, ttl: 0 } }), 'Agent client secret');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO infisical_agents(name,description,project_id,identity_id,client_id,client_secret_id,credentials_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(input.name, input.description, project.id, identity.id, ua.clientId, secret.clientSecretData?.id || null, '[]', user?.id || null, now, now);
    return { agent: view(rowOf(db, input.name)), clientId: ua.clientId, clientSecret: secret.clientSecret };
  } catch (e) {
    // A half-made agent leaves nothing behind: its project (and memberships) goes.
    await call(`/api/v1/projects/${project.id}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

// Assign a credential: the secret in the agent's project and a proxied service
// that puts it into requests to the named sites in place of the placeholder.
export async function setCredential(db, name, key, raw, deps = {}) {
  parseName(name); parseKey(key); const input = credentialSchema.parse(raw), row = mustRow(db, name);
  const { call } = await adminSession(db, input, deps);
  const scope = { projectId: row.project_id, environment: AGENT_ENV, secretPath: AGENT_PATH };
  const existing = await call(`/api/v4/secrets/${key}?${new URLSearchParams({ ...scope, viewSecretValue: 'false' })}`);
  if (existing.status === 404) ok(await call(`/api/v4/secrets/${key}`, { method: 'POST', body: { ...scope, secretValue: input.value, type: 'shared' } }), 'Storing the credential');
  else { ok(existing, 'Reading the credential'); ok(await call(`/api/v4/secrets/${key}`, { method: 'PATCH', body: { ...scope, secretValue: input.value } }), 'Updating the credential'); }
  const list = JSON.parse(row.credentials_json), prior = list.find(c => c.key === key), placeholder = placeholderFor(name, key);
  const service = { name: serviceName(key), hostPattern: input.hostPattern, isEnabled: true, credentials: [{ secretKey: key, role: 'credential-substitution', placeholderKey: key, placeholderValue: placeholder, substitutionSurfaces: input.surfaces }] };
  const saved = prior?.serviceId
    ? ok(await call(`/api/v1/proxied-services/${prior.serviceId}`, { method: 'PATCH', body: service }), 'Updating the proxied site').service
    : ok(await call('/api/v1/proxied-services', { method: 'POST', body: { ...scope, ...service } }), 'Creating the proxied site').service;
  const now = new Date().toISOString(), next = list.filter(c => c.key !== key);
  next.push({ key, hostPattern: input.hostPattern, surfaces: input.surfaces, placeholder, serviceId: saved?.id || prior?.serviceId || null, updatedAt: now });
  next.sort((a, b) => a.key.localeCompare(b.key));
  db.prepare('UPDATE infisical_agents SET credentials_json=?,updated_at=? WHERE name=?').run(JSON.stringify(next), now, name);
  return view(rowOf(db, name));
}

export async function removeCredential(db, name, key, raw = {}, deps = {}) {
  parseName(name); parseKey(key); const input = authoritySchema.parse(raw), row = mustRow(db, name);
  const { call } = await adminSession(db, input, deps);
  const list = JSON.parse(row.credentials_json), c = list.find(x => x.key === key);
  if (c?.serviceId) { const res = await call(`/api/v1/proxied-services/${c.serviceId}`, { method: 'DELETE' }); if (res.status !== 404) accepted(res, 'Removing the proxied site'); }
  const res = await call(`/api/v4/secrets/${key}`, { method: 'DELETE', body: { projectId: row.project_id, environment: AGENT_ENV, secretPath: AGENT_PATH } });
  if (res.status !== 404) accepted(res, 'Removing the credential');
  const now = new Date().toISOString();
  db.prepare('UPDATE infisical_agents SET credentials_json=?,updated_at=? WHERE name=?').run(JSON.stringify(list.filter(x => x.key !== key)), now, name);
  return view(rowOf(db, name));
}

// A new client secret, shown once; the previous one is revoked.
export async function rotateAgent(db, name, raw = {}, deps = {}) {
  parseName(name); const input = authoritySchema.parse(raw), row = mustRow(db, name);
  const { call } = await adminSession(db, input, deps);
  const base = `/api/v1/auth/universal-auth/identities/${row.identity_id}/client-secrets`;
  const secret = ok(await call(base, { method: 'POST', body: { description: `ProxyPilot agent ${name}`, numUsesLimit: 0, ttl: 0 } }), 'Agent client secret');
  if (row.client_secret_id) { const res = await call(`${base}/${row.client_secret_id}/revoke`, { method: 'POST' }); if (res.status !== 404) accepted(res, 'Revoking the previous client secret'); }
  db.prepare('UPDATE infisical_agents SET client_secret_id=?,updated_at=? WHERE name=?').run(secret.clientSecretData?.id || null, new Date().toISOString(), name);
  return { agent: view(rowOf(db, name)), clientId: row.client_id, clientSecret: secret.clientSecret };
}

// Remove: the agent's project (its secrets and proxied sites) and its identity.
export async function removeAgent(db, name, raw = {}, deps = {}) {
  parseName(name); const input = authoritySchema.parse(raw), row = mustRow(db, name);
  const { call } = await adminSession(db, input, deps);
  for (const [path, label] of [[`/api/v1/projects/${row.project_id}`, 'Removing the agent project'], [`/api/v1/identities/${row.identity_id}`, 'Removing the agent identity']]) {
    const res = await call(path, { method: 'DELETE' }); if (res.status !== 404) accepted(res, label);
  }
  db.prepare('DELETE FROM infisical_agents WHERE name=?').run(name);
  return { removed: name };
}
