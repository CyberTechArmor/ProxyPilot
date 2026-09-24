// Per-agent Infisical projects (infisical-agents.js), against a scripted Infisical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { INFISICAL_AGENTS_SCHEMA, createAgent, setCredential, removeCredential, rotateAgent, removeAgent, infisicalAgentsState, projectSlug, placeholderFor, createSchema, credentialSchema } from '../lib/setup-engine/infisical-agents.js';

const ORG = '11111111-1111-4111-8111-111111111111', USER = '22222222-2222-4222-8222-222222222222', PROXY = '33333333-3333-4333-8333-333333333333';
const r = { credential_ref: 'if-ref-0123456789ab', config: { basic: true, mode: 'install', origin: 'https://secure.example.com', proxyOrigin: 'http://192.0.2.10:17322' }, identities: { organizationId: ORG, proxy: { identityId: PROXY } } };
const s = { complete: true, email: 'admin@example.com', userId: USER, passwordInOpenBao: false };
const jwt = claims => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';

function fakeInfisical({ password = 'the-admin-password' } = {}) {
  const st = { projects: new Map(), identities: new Map(), members: [], secrets: new Map(), services: new Map(), clientSecrets: new Map(), seq: 0, logins: 0 };
  const id = () => `00000000-0000-4000-8000-${String(++st.seq).padStart(12, '0')}`;
  const ok = body => ({ status: 200, body });
  st.api = async (path, { method = 'GET', body, token } = {}) => {
    const u = new URL(path, 'https://x'), p = u.pathname;
    if (p === '/api/v3/auth/login') { st.logins++; return body.password === password ? ok({ accessToken: 'first' }) : { status: 400, body: null, error: 'Invalid credentials' }; }
    if (p === '/api/v3/auth/select-organization') return ok({ token: jwt({ userId: USER }), isMfaEnabled: false });
    assert.equal(token, jwt({ userId: USER }), 'every change is made as the administrator');
    let m;
    if (p === '/api/v1/projects' && method === 'POST') { if ([...st.projects.values()].some(x => x.slug === body.slug)) return { status: 400, body: null }; const pr = { id: id(), ...body, environments: [] }; st.projects.set(pr.id, pr); return ok({ project: pr }); }
    if ((m = p.match(/^\/api\/v1\/projects\/([^/]+)\/environments$/))) { st.projects.get(m[1]).environments.push(body.slug); return ok({}); }
    if ((m = p.match(/^\/api\/v1\/projects\/([^/]+)\/memberships\/identities\/([^/]+)$/))) { st.members.push({ project: m[1], identity: m[2], roles: body.roles.map(x => x.role) }); return ok({}); }
    if ((m = p.match(/^\/api\/v1\/projects\/([^/]+)$/)) && method === 'DELETE') { st.projects.delete(m[1]); for (const [k, v] of st.secrets) if (v.projectId === m[1]) st.secrets.delete(k); for (const [k, v] of st.services) if (v.projectId === m[1]) st.services.delete(k); return ok({}); }
    if (p === '/api/v1/identities' && method === 'POST') { const i = { id: id(), ...body }; st.identities.set(i.id, i); return ok({ identity: i }); }
    if ((m = p.match(/^\/api\/v1\/identities\/([^/]+)$/)) && method === 'DELETE') { st.identities.delete(m[1]); return ok({}); }
    if ((m = p.match(/^\/api\/v1\/auth\/universal-auth\/identities\/([^/]+)$/))) return ok({ identityUniversalAuth: { clientId: 'client-' + m[1], ...body } });
    if ((m = p.match(/^\/api\/v1\/auth\/universal-auth\/identities\/([^/]+)\/client-secrets$/))) { const cs = { id: id(), identity: m[1], secret: 'secret-' + st.seq, revoked: false }; st.clientSecrets.set(cs.id, cs); return ok({ clientSecret: cs.secret, clientSecretData: { id: cs.id } }); }
    if ((m = p.match(/client-secrets\/([^/]+)\/revoke$/))) { st.clientSecrets.get(m[1]).revoked = true; return ok({}); }
    if ((m = p.match(/^\/api\/v4\/secrets\/([^/]+)$/))) {
      const scope = method === 'GET' ? Object.fromEntries(u.searchParams) : body, k = `${scope.projectId}/${scope.environment}${scope.secretPath}${m[1]}`;
      if (method === 'GET') return st.secrets.has(k) ? ok({ secret: { secretKey: m[1] } }) : { status: 404, body: null };
      if (method === 'POST') { if (st.secrets.has(k)) return { status: 400, body: null }; st.secrets.set(k, { projectId: scope.projectId, value: body.secretValue }); return ok({ secret: {} }); }
      if (method === 'PATCH') { st.secrets.get(k).value = body.secretValue; return ok({ secret: {} }); }
      if (method === 'DELETE') { st.secrets.delete(k); return ok({ secret: {} }); }
    }
    if (p === '/api/v1/proxied-services' && method === 'POST') { const sv = { id: id(), ...body }; st.services.set(sv.id, sv); return ok({ service: sv }); }
    if ((m = p.match(/^\/api\/v1\/proxied-services\/([^/]+)$/))) { if (method === 'DELETE') { st.services.delete(m[1]); return ok({}); } Object.assign(st.services.get(m[1]), body); return ok({ service: st.services.get(m[1]) }); }
    throw Error('unscripted ' + method + ' ' + path);
  };
  st.deps = { api: st.api, context: () => ({ r, s }), vault: async () => { throw Error('no vault in this test'); } };
  return st;
}
const database = () => { const db = new DatabaseSync(':memory:'); db.exec(INFISICAL_AGENTS_SCHEMA); return db; };
const pw = 'the-admin-password';

test('each agent gets its own project: the agent is Admin there only, the proxy is Viewer, the client secret is shown once', async () => {
  const db = database(), f = fakeInfisical();
  const out = await createAgent(db, { name: 'crawler', password: pw, reviewed: true }, { id: 'u1' }, f.deps);
  const project = [...f.projects.values()][0];
  assert.equal(project.slug, projectSlug('crawler')); assert.deepEqual(project.environments, ['agent']);
  const identity = [...f.identities.values()][0];
  assert.equal(identity.role, 'no-access', 'no organization rights');
  assert.deepEqual(f.members, [{ project: project.id, identity: identity.id, roles: ['admin'] }, { project: project.id, identity: PROXY, roles: ['viewer'] }]);
  assert.equal(out.clientId, 'client-' + identity.id); assert.match(out.clientSecret, /^secret-/);
  assert(!JSON.stringify(db.prepare('SELECT * FROM infisical_agents').all()).includes(out.clientSecret), 'the client secret is not stored');
  // A second agent lives in a different project: neither can reach the other's.
  await createAgent(db, { name: 'mailer', password: pw, reviewed: true }, null, f.deps);
  assert.equal(f.projects.size, 2);
  const byIdentity = Object.groupBy(f.members.filter(m => m.identity !== PROXY), m => m.identity);
  for (const list of Object.values(byIdentity)) assert.equal(list.length, 1, 'each agent identity is a member of exactly one project');
});

test('a credential becomes a secret in the agent project plus a proxied site; updating reuses both; removing deletes both', async () => {
  const db = database(), f = fakeInfisical();
  await createAgent(db, { name: 'crawler', password: pw, reviewed: true }, null, f.deps);
  await setCredential(db, 'crawler', 'OPENAI_API_KEY', { value: 'sk-real-value', hostPattern: 'api.openai.com', password: pw, reviewed: true }, f.deps);
  const service = [...f.services.values()][0];
  assert.equal(service.hostPattern, 'api.openai.com');
  assert.deepEqual(service.credentials, [{ secretKey: 'OPENAI_API_KEY', role: 'credential-substitution', placeholderKey: 'OPENAI_API_KEY', placeholderValue: placeholderFor('crawler', 'OPENAI_API_KEY'), substitutionSurfaces: ['header'] }]);
  assert.equal([...f.secrets.values()][0].value, 'sk-real-value');
  await setCredential(db, 'crawler', 'OPENAI_API_KEY', { value: 'sk-rotated', hostPattern: 'api.openai.com,api.openai.com:443', password: pw, reviewed: true }, f.deps);
  assert.equal(f.services.size, 1); assert.equal([...f.secrets.values()][0].value, 'sk-rotated');
  const state = infisicalAgentsState(db, { context: () => ({ r, s }) });
  assert.deepEqual(state.agents[0].credentials.map(c => c.key), ['OPENAI_API_KEY']);
  assert(!JSON.stringify(db.prepare('SELECT * FROM infisical_agents').all()).includes('sk-rotated'), 'no value is stored');
  await removeCredential(db, 'crawler', 'OPENAI_API_KEY', { password: pw }, f.deps);
  assert.equal(f.services.size, 0); assert.equal(f.secrets.size, 0);
});

test('rotate revokes the previous client secret; remove deletes the project and the identity', async () => {
  const db = database(), f = fakeInfisical();
  await createAgent(db, { name: 'crawler', password: pw, reviewed: true }, null, f.deps);
  const first = [...f.clientSecrets.values()][0];
  const next = await rotateAgent(db, 'crawler', { password: pw }, f.deps);
  assert(first.revoked); assert.notEqual(next.clientSecret, first.secret);
  await removeAgent(db, 'crawler', { password: pw }, f.deps);
  assert.equal(f.projects.size, 0); assert.equal(f.identities.size, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM infisical_agents').get().n, 0);
});

test('authority: a wrong or missing administrator password changes nothing; the kept password is read from OpenBao', async () => {
  const db = database(), f = fakeInfisical();
  await assert.rejects(createAgent(db, { name: 'crawler', password: 'not-the-password', reviewed: true }, null, f.deps), /password does not match/);
  await assert.rejects(createAgent(db, { name: 'crawler', reviewed: true }, null, f.deps), /Enter the Infisical administrator password/);
  assert.equal(f.projects.size, 0);
  const kept = { ...f.deps, context: () => ({ r, s: { ...s, passwordInOpenBao: true } }), vault: async (_db, a) => { assert.deepEqual(a, { email: s.email, origin: r.config.origin, fresh: false }); return pw; } };
  await createAgent(db, { name: 'crawler', reviewed: true }, null, kept);
  assert.equal(f.projects.size, 1);
});

test('a half-made agent is cleaned up, and input is validated', async () => {
  const db = database(), f = fakeInfisical(), api = f.api;
  f.deps.api = async (path, o) => path === '/api/v1/identities' ? { status: 403, body: null } : api(path, o);
  await assert.rejects(createAgent(db, { name: 'crawler', password: pw, reviewed: true }, null, f.deps), /Agent identity unavailable/);
  assert.equal(f.projects.size, 0, 'its project was removed');
  assert.equal(db.prepare('SELECT count(*) AS n FROM infisical_agents').get().n, 0);
  for (const bad of [{ name: 'Bad', reviewed: true }, { name: 'ok-name' }]) assert(!createSchema.safeParse(bad).success);
  for (const bad of [{ value: 'v', hostPattern: 'https://api.example.com', reviewed: true }, { value: 'v', hostPattern: 'api.example.com', surfaces: ['cookie'], reviewed: true }]) assert(!credentialSchema.safeParse(bad).success, JSON.stringify(bad));
});
