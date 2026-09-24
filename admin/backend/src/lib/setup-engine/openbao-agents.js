// Connect an agent (docs/features/openbao-agents.md): each agent or machine
// gets its own OpenBao AppRole whose policy reads ONLY <kv>/agents/<name>/*.
// It is never an administrator. Credentials are values the person enters
// in the dashboard; each one is written under that agent's path, which is what
// "assigning" means. ProxyPilot keeps only names (this table), never a value,
// secret_id or token; every change uses a transient root token that is revoked
// and proved revoked (withTransientRoot).
import { isIP } from 'node:net';
import { z } from 'zod';
import { readOpenBao } from './openbao-store.js';
import { autoCustody, namesFor, fail } from './openbao-logic.js';
import { requireReady } from './openbao-api.js';
import { reachableStatus, withTransientRoot } from './openbao-custody.js';

export const AGENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS openbao_agents(
  name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', cidrs_json TEXT NOT NULL DEFAULT '[]',
  credentials_json TEXT NOT NULL DEFAULT '[]', secret_id_accessor TEXT, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;

const agentName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'Agent names are 2–40 lower-case letters, digits or dashes, starting with a letter.');
const keyName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'Credential names are up to 64 letters, digits, dots, dashes or underscores, starting with a letter.');
const cidr = z.string().refine(v => { const [ip, bits, extra] = v.split('/'); return extra === undefined && isIP(ip) === 4 && /^\d{1,2}$/.test(bits ?? '') && Number(bits) >= 8 && Number(bits) <= 32; }, 'Use IPv4 CIDR ranges between /8 and /32, for example 10.100.0.7/32.');
export const createSchema = z.object({ name: agentName, description: z.string().max(200).default(''), cidrs: z.array(cidr).max(8).default([]), reviewed: z.literal(true) }).strict();
export const credentialSchema = z.object({ value: z.string().min(1).max(16384), description: z.string().max(200).default(''), reviewed: z.literal(true) }).strict();
export const parseName = v => agentName.parse(v);
export const parseKey = v => keyName.parse(v);

export const AGENT_TOKEN_TTL = 3600, AGENT_TOKEN_MAX_TTL = 14400;
export function agentNames(b, name) {
  const n = namesFor(b);
  return { kv: `${n.prefix}-kv`, approle: n.approle, policy: `${n.prefix}-agent-${name}`, role: `agent-${name}`, path: `agents/${name}` };
}
// Read-only on its own path; token self-management only. Nothing else.
export function agentPolicy(b, name) {
  const a = agentNames(b, name);
  return [[`${a.kv}/data/${a.path}/*`, '"read"'], [`${a.kv}/metadata/${a.path}/*`, '"read", "list"'],
    ['auth/token/lookup-self', '"read"'], ['auth/token/renew-self', '"update"'], ['auth/token/revoke-self', '"update"']]
    .map(([p, c]) => `path "${p}" { capabilities = [${c}] }\n`).join('');
}
export const agentRole = (b, name, cidrs = []) => ({ bind_secret_id: true, secret_id_num_uses: 0, secret_id_ttl: 0, token_policies: [agentNames(b, name).policy], token_no_default_policy: true, token_ttl: AGENT_TOKEN_TTL, token_max_ttl: AGENT_TOKEN_MAX_TTL, token_type: 'service', ...(cidrs.length ? { secret_id_bound_cidrs: cidrs, token_bound_cidrs: cidrs } : {}) });

const view = row => row && { name: row.name, description: row.description, cidrs: JSON.parse(row.cidrs_json), credentials: JSON.parse(row.credentials_json), createdAt: row.created_at, updatedAt: row.updated_at };
const table = db => !!db.prepare("SELECT name FROM sqlite_master WHERE name='openbao_agents'").get();
const rowOf = (db, name) => table(db) ? db.prepare('SELECT * FROM openbao_agents WHERE name=?').get(name) : null;
const mustRow = (db, name) => { const row = rowOf(db, name); if (!row) throw fail(`No agent named ${name} is registered.`); return row; };

// What the page shows: the agents and exactly how one signs in and reads.
export function agentsState(db) {
  const b = readOpenBao(db), ready = autoCustody(b) && !!b?.bootstrap_complete;
  const agents = table(db) ? db.prepare('SELECT * FROM openbao_agents ORDER BY name').all().map(view) : [];
  return { ready, reason: ready ? null : 'Finish OpenBao with automatic custody first.', origin: b?.config?.origin || null,
    approle: b ? namesFor(b).approle : null, kv: b ? `${namesFor(b).prefix}-kv` : null, tokenMinutes: AGENT_TOKEN_TTL / 60, agents };
}

async function withRoot(db, fn, { read = readOpenBao, reach = reachableStatus, ready = requireReady, root = withTransientRoot } = {}) {
  const b = read(db);
  if (!autoCustody(b) || !b.bootstrap_complete) throw fail('Agents are registered in OpenBao, which is not installed here with automatic custody yet. Finish OpenBao first.');
  const { api } = await reach(db, b);
  await ready(api, b);
  return root(db, b, api, token => fn({ b, token, call: (path, options = {}) => api(path, { ...options, token }) }));
}
const accepted = (res, label) => { if (![200, 204].includes(res.status)) throw fail(`${label} was not accepted by OpenBao (HTTP ${res.status}). Nothing else was changed.`); return res.body; };

// Register: policy + AppRole, then one secret_id shown once. Existing OpenBao
// objects with these names are refused unless they are exactly ProxyPilot's.
export async function createAgent(db, raw, user, deps) {
  const input = createSchema.parse(raw);
  if (!table(db)) throw fail('The agent registry is not available; restart ProxyPilot so its migration runs.');
  if (rowOf(db, input.name)) throw fail(`An agent named ${input.name} is already registered.`);
  const issued = await withRoot(db, async ({ b, call }) => {
    const a = agentNames(b, input.name), policy = agentPolicy(b, input.name), role = agentRole(b, input.name, input.cidrs);
    const livePolicy = await call(`/v1/sys/policies/acl/${a.policy}`);
    if (livePolicy.status === 200 && livePolicy.body?.data?.policy !== policy) throw fail(`An OpenBao policy named ${a.policy} already exists with different rules. Nothing was overwritten.`);
    const liveRole = await call(`/v1/auth/${a.approle}/role/${a.role}`);
    if (liveRole.status === 200) throw fail(`An OpenBao sign-in role named ${a.role} already exists. Nothing was overwritten.`);
    accepted(await call(`/v1/sys/policies/acl/${a.policy}`, { method: 'PUT', body: { policy } }), 'The agent policy');
    accepted(await call(`/v1/auth/${a.approle}/role/${a.role}`, { method: 'POST', body: role }), 'The agent sign-in role');
    const roleId = accepted(await call(`/v1/auth/${a.approle}/role/${a.role}/role-id`), 'Reading the role ID')?.data?.role_id;
    const secret = accepted(await call(`/v1/auth/${a.approle}/role/${a.role}/secret-id`, { method: 'POST', body: {} }), 'Issuing the secret ID')?.data;
    if (!roleId || !secret?.secret_id) throw fail('OpenBao did not return the agent credentials. Remove the agent and try again.');
    return { roleId, secretId: secret.secret_id, accessor: secret.secret_id_accessor || null };
  }, deps);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO openbao_agents(name,description,cidrs_json,credentials_json,secret_id_accessor,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(input.name, input.description, JSON.stringify(input.cidrs), '[]', issued.accessor, user?.id || null, now, now);
  return { agent: view(rowOf(db, input.name)), roleId: issued.roleId, secretId: issued.secretId };
}

// Assign a credential: write it under the agent's own path (a new version when it exists).
export async function setCredential(db, name, key, raw, deps) {
  parseName(name); parseKey(key); const input = credentialSchema.parse(raw), row = mustRow(db, name);
  await withRoot(db, async ({ b, call }) => {
    const a = agentNames(b, name);
    accepted(await call(`/v1/${a.kv}/data/${a.path}/${key}`, { method: 'POST', body: { data: { value: input.value, description: input.description } } }), 'Storing the credential');
  }, deps);
  const list = JSON.parse(row.credentials_json).filter(c => c.key !== key), now = new Date().toISOString();
  list.push({ key, description: input.description, updatedAt: now }); list.sort((x, y) => x.key.localeCompare(y.key));
  db.prepare('UPDATE openbao_agents SET credentials_json=?,updated_at=? WHERE name=?').run(JSON.stringify(list), now, name);
  return view(rowOf(db, name));
}

// Remove a credential with all its versions.
export async function removeCredential(db, name, key, deps) {
  parseName(name); parseKey(key); const row = mustRow(db, name);
  await withRoot(db, async ({ b, call }) => {
    const a = agentNames(b, name), res = await call(`/v1/${a.kv}/metadata/${a.path}/${key}`, { method: 'DELETE' });
    if (![200, 204, 404].includes(res.status)) accepted(res, 'Removing the credential');
  }, deps);
  const now = new Date().toISOString();
  db.prepare('UPDATE openbao_agents SET credentials_json=?,updated_at=? WHERE name=?').run(JSON.stringify(JSON.parse(row.credentials_json).filter(c => c.key !== key)), now, name);
  return view(rowOf(db, name));
}

// A new secret_id, shown once; the previous one is destroyed.
export async function rotateAgent(db, name, deps) {
  parseName(name); const row = mustRow(db, name);
  const issued = await withRoot(db, async ({ b, call }) => {
    const a = agentNames(b, name);
    const roleId = accepted(await call(`/v1/auth/${a.approle}/role/${a.role}/role-id`), 'Reading the role ID')?.data?.role_id;
    const secret = accepted(await call(`/v1/auth/${a.approle}/role/${a.role}/secret-id`, { method: 'POST', body: {} }), 'Issuing the secret ID')?.data;
    if (!roleId || !secret?.secret_id) throw fail('OpenBao did not return the new secret ID. The previous one still works.');
    if (row.secret_id_accessor) {
      const gone = await call(`/v1/auth/${a.approle}/role/${a.role}/secret-id-accessor/destroy`, { method: 'POST', body: { secret_id_accessor: row.secret_id_accessor } });
      if (![200, 204, 404].includes(gone.status)) accepted(gone, 'Destroying the previous secret ID');
    }
    return { roleId, secretId: secret.secret_id, accessor: secret.secret_id_accessor || null };
  }, deps);
  db.prepare('UPDATE openbao_agents SET secret_id_accessor=?,updated_at=? WHERE name=?').run(issued.accessor, new Date().toISOString(), name);
  return { agent: view(rowOf(db, name)), roleId: issued.roleId, secretId: issued.secretId };
}

// Remove the agent: its sign-in role (which ends its secret IDs), its policy
// and every credential under its path.
export async function removeAgent(db, name, deps) {
  parseName(name); const row = mustRow(db, name);
  await withRoot(db, async ({ b, call }) => {
    const a = agentNames(b, name);
    for (const res of [await call(`/v1/auth/${a.approle}/role/${a.role}`, { method: 'DELETE' })]) if (![200, 204, 404].includes(res.status)) accepted(res, 'Removing the sign-in role');
    const listed = await call(`/v1/${a.kv}/metadata/${a.path}/?list=true`);
    const keys = listed.status === 200 ? listed.body?.data?.keys || [] : JSON.parse(row.credentials_json).map(c => c.key);
    for (const key of keys) { const res = await call(`/v1/${a.kv}/metadata/${a.path}/${key}`, { method: 'DELETE' }); if (![200, 204, 404].includes(res.status)) accepted(res, `Removing credential ${key}`); }
    const res = await call(`/v1/sys/policies/acl/${a.policy}`, { method: 'DELETE' }); if (![200, 204, 404].includes(res.status)) accepted(res, 'Removing the agent policy');
  }, deps);
  db.prepare('DELETE FROM openbao_agents WHERE name=?').run(name);
  return { removed: name };
}
