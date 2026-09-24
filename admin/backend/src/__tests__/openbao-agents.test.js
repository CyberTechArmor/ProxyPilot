// Connect an agent: per-agent AppRole on OpenBao, read-only on its own path (openbao-agents.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AGENTS_SCHEMA, agentsState, createAgent, setCredential, removeCredential, rotateAgent, removeAgent, agentPolicy, agentNames, createSchema } from '../lib/setup-engine/openbao-agents.js';

const bao = { credential_ref: 'bao-ref-0123456789ab', bootstrap_complete: 1, config: { mode: 'install', basic: true, custody: 'auto', origin: 'https://openbao.example.com' } };

// A small OpenBao: ACL policies, AppRole roles/secret IDs, and one KV v2 mount.
function fakeBao() {
  const s = { policies: new Map(), roles: new Map(), secrets: new Map(), kv: new Map(), roots: 0, seq: 0 };
  s.api = async (path, { method = 'GET', body, token } = {}) => {
    assert.equal(token, 'transient-root');
    const u = new URL(path, 'http://x'), p = u.pathname;
    let m;
    if ((m = p.match(/^\/v1\/sys\/policies\/acl\/(.+)$/))) {
      if (method === 'GET') return s.policies.has(m[1]) ? { status: 200, body: { data: { policy: s.policies.get(m[1]) } } } : { status: 404, body: null };
      if (method === 'PUT') { s.policies.set(m[1], body.policy); return { status: 204, body: null }; }
      if (method === 'DELETE') { s.policies.delete(m[1]); return { status: 204, body: null }; }
    }
    if ((m = p.match(/^\/v1\/auth\/[^/]+\/role\/([^/]+)(\/.*)?$/))) {
      const [, role, rest = ''] = m;
      if (!rest && method === 'GET') return s.roles.has(role) ? { status: 200, body: { data: s.roles.get(role) } } : { status: 404, body: null };
      if (!rest && method === 'POST') { s.roles.set(role, body); return { status: 204, body: null }; }
      if (!rest && method === 'DELETE') { s.roles.delete(role); for (const [k, v] of s.secrets) if (v.role === role) s.secrets.delete(k); return { status: 204, body: null }; }
      if (rest === '/role-id') return { status: 200, body: { data: { role_id: 'role-id-' + role } } };
      if (rest === '/secret-id') { const n = ++s.seq; s.secrets.set('acc-' + n, { role, secret: 'secret-' + n }); return { status: 200, body: { data: { secret_id: 'secret-' + n, secret_id_accessor: 'acc-' + n } } }; }
      if (rest === '/secret-id-accessor/destroy') { s.secrets.delete(body.secret_id_accessor); return { status: 204, body: null }; }
    }
    if ((m = p.match(/^\/v1\/[^/]+-kv\/data\/(.+)$/)) && method === 'POST') { s.kv.set(m[1], body.data); return { status: 200, body: {} }; }
    if ((m = p.match(/^\/v1\/[^/]+-kv\/metadata\/(.+)$/))) {
      if (u.searchParams.get('list') === 'true') { const prefix = m[1]; const keys = [...s.kv.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)); return keys.length ? { status: 200, body: { data: { keys } } } : { status: 404, body: null }; }
      if (method === 'DELETE') { s.kv.delete(m[1]); return { status: 204, body: null }; }
    }
    throw Error('unscripted ' + method + ' ' + path);
  };
  s.deps = { read: () => bao, reach: async () => ({ api: s.api }), ready: async () => ({}), root: async (_db, _b, _api, fn) => { s.roots++; return fn('transient-root'); } };
  return s;
}
const database = () => { const db = new DatabaseSync(':memory:'); db.exec(AGENTS_SCHEMA); db.exec("CREATE TABLE IF NOT EXISTS setup_openbao(id INTEGER PRIMARY KEY)"); return db; };

test('an agent gets a policy that reads only its own path; the secret ID is returned once and never stored', async () => {
  const db = database(), f = fakeBao();
  const out = await createAgent(db, { name: 'n8n-builder', description: 'Workflow agent', cidrs: ['10.100.0.7/32'], reviewed: true }, { id: 'u1' }, f.deps);
  const a = agentNames(bao, 'n8n-builder');
  assert.equal(out.roleId, 'role-id-agent-n8n-builder'); assert.equal(out.secretId, 'secret-1');
  assert.equal(f.policies.get(a.policy), agentPolicy(bao, 'n8n-builder'));
  assert.match(agentPolicy(bao, 'n8n-builder'), /-kv\/data\/agents\/n8n-builder\/\*" \{ capabilities = \["read"\] \}/);
  assert.doesNotMatch(agentPolicy(bao, 'n8n-builder'), /"create"|"update", "delete"|sudo|path "\*"/, 'no write, no admin');
  const role = f.roles.get(a.role);
  assert.deepEqual(role.token_policies, [a.policy]); assert.equal(role.token_no_default_policy, true);
  assert.deepEqual(role.secret_id_bound_cidrs, ['10.100.0.7/32']); assert.deepEqual(role.token_bound_cidrs, ['10.100.0.7/32']);
  assert(!JSON.stringify(db.prepare('SELECT * FROM openbao_agents').all()).includes('secret-1'), 'the secret ID is not stored');
  assert.equal(f.roots, 1);
  await assert.rejects(createAgent(db, { name: 'n8n-builder', reviewed: true }, null, f.deps), /already registered/);
});

test('credentials are written under the agent path; the registry keeps names only', async () => {
  const db = database(), f = fakeBao();
  await createAgent(db, { name: 'mailer', reviewed: true }, null, f.deps);
  await setCredential(db, 'mailer', 'SMTP_PASSWORD', { value: 'the-real-smtp-password', description: 'Postmark', reviewed: true }, f.deps);
  assert.deepEqual(f.kv.get('agents/mailer/SMTP_PASSWORD'), { value: 'the-real-smtp-password', description: 'Postmark' });
  const listed = agentsState(Object.assign(db, {})).agents;
  assert.deepEqual(listed[0].credentials.map(c => c.key), ['SMTP_PASSWORD']);
  assert(!JSON.stringify(db.prepare('SELECT * FROM openbao_agents').all()).includes('the-real-smtp-password'));
  await removeCredential(db, 'mailer', 'SMTP_PASSWORD', f.deps);
  assert(!f.kv.has('agents/mailer/SMTP_PASSWORD'));
  await assert.rejects(setCredential(db, 'nobody', 'KEY', { value: 'x', reviewed: true }, f.deps), /No agent named nobody/);
  await assert.rejects(setCredential(db, 'mailer', '../escape', { value: 'x', reviewed: true }, f.deps), /Credential names/);
});

test('rotate issues a new secret ID and destroys the previous one; remove deletes role, policy and credentials', async () => {
  const db = database(), f = fakeBao();
  await createAgent(db, { name: 'crawler', reviewed: true }, null, f.deps);
  await setCredential(db, 'crawler', 'API_KEY', { value: 'k', reviewed: true }, f.deps);
  const next = await rotateAgent(db, 'crawler', f.deps);
  assert.equal(next.secretId, 'secret-2'); assert(!f.secrets.has('acc-1'), 'previous secret ID destroyed'); assert(f.secrets.has('acc-2'));
  await removeAgent(db, 'crawler', f.deps);
  const a = agentNames(bao, 'crawler');
  assert(!f.roles.has(a.role) && !f.policies.has(a.policy) && !f.kv.has('agents/crawler/API_KEY'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM openbao_agents').get().n, 0);
});

test('existing OpenBao objects with the same names are never overwritten; input is validated', async () => {
  const db = database(), f = fakeBao(), a = agentNames(bao, 'taken');
  f.policies.set(a.policy, 'path "secret/*" { capabilities = ["read"] }\n');
  await assert.rejects(createAgent(db, { name: 'taken', reviewed: true }, null, f.deps), /different rules/);
  f.policies.delete(a.policy); f.roles.set(a.role, { token_policies: ['other'] });
  await assert.rejects(createAgent(db, { name: 'taken', reviewed: true }, null, f.deps), /sign-in role named agent-taken already exists/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM openbao_agents').get().n, 0);
  for (const bad of [{ name: 'Bad Name', reviewed: true }, { name: 'ok-name', cidrs: ['0.0.0.0/0'], reviewed: true }, { name: 'ok-name', cidrs: ['10.0.0.1'], reviewed: true }, { name: 'ok-name' }])
    assert(!createSchema.safeParse(bad).success, JSON.stringify(bad));
  const notReady = { ...f.deps, read: () => ({ ...bao, bootstrap_complete: 0 }) };
  await assert.rejects(createAgent(database(), { name: 'late', reviewed: true }, null, notReady), /Finish OpenBao first/);
});
