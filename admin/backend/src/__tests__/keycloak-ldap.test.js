import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb as fpDb, approved, apiFixture } from './helpers/full-platform-fixture.js';
import { readFullPlatform, approvalDeps } from '../lib/setup-engine/full-platform-store.js';
approvalDeps.check = async () => null;
import { storeProtected } from '../lib/setup-engine/full-platform-keycloak.js';
import { KEYCLOAK_LDAP_SCHEMA, ldapLinkSchema, ldapRemoveSchema, queueLdap, ldapState, readLdap } from '../lib/setup-engine/keycloak-ldap.js';
import { runOnce } from '../lib/setup-engine/executor.js';
import { getJob } from '../lib/setup-engine/store.js';
import { validateRunnerJob } from '../lib/setup-engine/logic.js';

const ADMIN_PW = 'permanent-admin-password-xyz', BIND_PW = 'directory-bind-secret-abc', OWNER = 'runner@ldap-test#1:a', UPT = 'org.keycloak.storage.UserStorageProvider';
const user = { id: 'admin', username: 'Alice' };
const input = (over = {}) => ({ revision: 0, adminPassword: ADMIN_PW, reviewed: true, connectionUrl: 'ldaps://dc1.corp.example.com:636', vendor: 'ad', bindDn: 'CN=svc-keycloak,OU=Service,DC=corp,DC=example,DC=com', bindPassword: BIND_PW, usersDn: 'OU=Staff,DC=corp,DC=example,DC=com', ...over });

// Stage B finished: permanent administrator verified, bootstrap retired.
function makeDb({ stageB = true } = {}) {
  const db = fpDb(); db.exec(KEYCLOAK_LDAP_SCHEMA); approved(db);
  const k = db.prepare('SELECT * FROM setup_keycloak').get(), full = readFullPlatform(db), ref = `keycloak-bootstrap-${k.id}`;
  storeProtected(db, ref, { installationId: k.id, retired: true });
  db.prepare('UPDATE setup_full_platform SET state_json=?').run(JSON.stringify({ ...full.state, identity: { bootstrapRef: ref }, administrator: { username: 'alice' }, administratorVerified: stageB }));
  return { db, k };
}
const withDb = async (fn, opts) => { const { db, k } = makeDb(opts); try { await fn(db, k); } finally { db.close(); } };

function fakeKeycloak(k, { conn = true, auth = true } = {}) {
  const components = new Map(), calls = [], realmId = 'realm-uuid-1'; let seq = 0, logouts = 0;
  const res = (body, status = 200, headers = {}) => new Response([201, 204].includes(status) ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const send = async (url, options = {}) => {
    const u = new URL(url), method = options.method || 'GET', path = u.pathname, body = options.body && String(options.headers?.['Content-Type']).includes('json') ? JSON.parse(options.body) : null;
    calls.push({ method, path, query: u.search, body: options.body ? String(options.body) : '' });
    if (path === '/realms/master/protocol/openid-connect/token') { const p = new URLSearchParams(options.body); return p.get('username') === 'alice' && p.get('password') === ADMIN_PW ? res({ access_token: 'tok', refresh_token: 'refresh' }) : res({ error: 'invalid_grant' }, 401); }
    if (path === '/realms/master/protocol/openid-connect/logout') { logouts++; return res({}, 204); }
    if (options.headers?.Authorization !== 'Bearer tok') return res({}, 401);
    const base = `/admin/realms/${k.realm}`;
    if (path === base) return res({ id: realmId, realm: k.realm, attributes: { 'proxypilot.installation': k.id } });
    if (path === `${base}/testLDAPConnection`) return (body.action === 'testConnection' ? conn : auth) && body.bindCredential === BIND_PW ? res({}, 204) : res({ errorMessage: 'LDAP: error code 49 - 80090308: secret provider detail' }, 400);
    if (path === `${base}/components` && method === 'GET') return res([...components.values()].filter(c => (!u.searchParams.get('type') || c.providerType === u.searchParams.get('type')) && (!u.searchParams.get('parent') || c.parentId === u.searchParams.get('parent'))).map(c => ({ ...c, config: { ...c.config, ...(c.config.bindCredential ? { bindCredential: ['**********'] } : {}) } })));
    if (path === `${base}/components` && method === 'POST') { const id = `comp-${++seq}`; components.set(id, { ...body, id }); return res({}, 201, { Location: `https://identity.example.com${base}/components/${id}` }); }
    const m = path.match(new RegExp(`^${base}/components/([^/]+)$`));
    if (m) { const c = components.get(m[1]); if (!c) return res({ error: 'Could not find component' }, 404);
      if (method === 'GET') return res(c);
      if (method === 'PUT') { components.set(c.id, { ...body, id: c.id }); return res({}, 204); }
      if (method === 'DELETE') { components.delete(c.id); for (const [id, x] of components) if (x.parentId === c.id) components.delete(id); return res({}, 204); } }
    if (/\/user-storage\/[^/]+\/sync$/.test(path)) return res({ ignored: false, added: 3, updated: 1, removed: 0, failed: 0, status: '3 imported users, 1 updated users' });
    if (/\/user-storage\/[^/]+\/mappers\/[^/]+\/sync$/.test(path)) return res({ ignored: false, added: 1, updated: 0, removed: 0, failed: 0 });
    return res({}, 404);
  };
  return { send, calls, components, realmId, logouts: () => logouts, foreign: (name, extra = {}) => { const id = `foreign-${++seq}`; components.set(id, { id, name, providerId: 'ldap', providerType: UPT, parentId: realmId, config: { bindCredential: ['theirs'], editMode: ['WRITABLE'] }, ...extra }); return id; } };
}
const run = (db, kc) => runOnce({ db, owner: OWNER, exec: {}, keycloakLdapDeps: { send: kc.send } }, { max: 1, kinds: ['keycloak_ldap'], reconcileFirst: false });
const secretFree = (db, extra = []) => {
  const text = JSON.stringify([db.prepare('SELECT * FROM setup_jobs').all(), db.prepare('SELECT * FROM setup_job_events').all(), db.prepare('SELECT * FROM setup_keycloak_ldap').all(), db.prepare('SELECT * FROM audit').all(), ldapState(db), ...extra]);
  for (const s of [ADMIN_PW, BIND_PW, 'secret provider detail']) assert(!text.includes(s), `leaked ${s}`);
};
const refsLeft = db => db.prepare("SELECT count(*) n FROM setup_full_credentials WHERE id LIKE 'keycloak-ldap-%'").get().n;
const steps = kc => kc.calls.filter(c => !c.path.includes('/protocol/openid-connect/')).map(c => `${c.method} ${c.path.replace(/^\/admin\/realms\/[^/]+/, '')}${c.method === 'POST' && c.path.endsWith('testLDAPConnection') ? ':' + JSON.parse(c.body).action : ''}`);

test('LDAP-1 schema refuses plain ldap:// without StartTLS, unknown fields, half a group and a missing review', () => {
  assert(ldapLinkSchema.safeParse(input()).success);
  assert(ldapLinkSchema.safeParse(input({ connectionUrl: 'ldap://dc1.corp.example.com', startTls: true })).success);
  const plain = ldapLinkSchema.safeParse(input({ connectionUrl: 'ldap://dc1.corp.example.com' }));
  assert(!plain.success); assert.match(plain.error.issues[0].message, /unencrypted/);
  assert(!ldapLinkSchema.safeParse(input({ startTls: true })).success, 'StartTLS on ldaps:// is refused');
  for (const url of ['https://dc1.example.com', 'ldaps://user:pw@dc1.example.com', 'ldaps://dc1.example.com/dc=x', 'dc1.example.com']) assert(!ldapLinkSchema.safeParse(input({ connectionUrl: url })).success, url);
  assert(!ldapLinkSchema.safeParse(input({ editMode: 'WRITABLE' })).success, 'unknown fields (edit mode) are refused');
  assert(!ldapLinkSchema.safeParse(input({ groupsDn: 'OU=Groups,DC=corp,DC=example,DC=com' })).success);
  assert(!ldapLinkSchema.safeParse(input({ userFilter: 'objectClass=person' })).success);
  assert(!ldapLinkSchema.safeParse(input({ reviewed: false })).success);
  assert(!ldapRemoveSchema.safeParse({ revision: 1, adminPassword: 'x', reviewed: true, bindPassword: 'y' }).success);
  const empties = ldapLinkSchema.parse(input({ usernameAttribute: '', userFilter: '', groupsDn: '', groupName: '', displayName: '' }));
  assert.equal(empties.usernameAttribute, undefined); assert.equal(empties.displayName, 'Directory');
});

test('LDAP-2 refused before stage B; validator keeps job params secret-free', () => withDb(db => {
  assert.throws(() => queueLdap(db, input(), user, 'link'), /stage B/); assert.equal(ldapState(db).ready, false); assert.equal(refsLeft(db), 0);
  assert.equal(validateRunnerJob({ kind: 'keycloak_ldap', app: 'pp-keycloak-ldap', plan: { params: { revision: 1, operation: 'link' } } }).ok, true);
  assert.equal(validateRunnerJob({ kind: 'keycloak_ldap', app: 'pp-keycloak-ldap', plan: { params: { revision: 1, operation: 'link', bindPassword: 'x' } } }).ok, false);
  assert.equal(validateRunnerJob({ kind: 'keycloak_ldap', app: 'pp-keycloak-ldap', plan: { params: { revision: 1, operation: 'purge' } } }).ok, false);
}, { stageB: false }));

test('LDAP-3 link runs test → create → group mapper → sync in order, READ_ONLY, logs out and deletes the protected copies', () => withDb(async (db, k) => {
  const kc = fakeKeycloak(k);
  const q = queueLdap(db, input({ groupsDn: 'OU=Groups,DC=corp,DC=example,DC=com', groupName: 'Platform Users' }), user, 'link');
  assert.equal(ldapState(db).state, 'pending'); assert.equal(refsLeft(db), 2); assert.deepEqual(Object.keys(q.job.plan.params).sort(), ['operation', 'revision']);
  const out = await run(db, kc); assert.equal(out.ran[0].status, 'succeeded', JSON.stringify(getJob(db, q.job.id)));
  assert.deepEqual(steps(kc), ['GET ', 'POST /testLDAPConnection:testConnection', 'POST /testLDAPConnection:testAuthentication', 'GET /components', 'POST /components', 'GET /components', 'POST /components', 'POST /user-storage/comp-1/sync', 'POST /user-storage/comp-1/mappers/comp-2/sync']);
  const provider = kc.components.get('comp-1'), mapper = kc.components.get('comp-2');
  assert.equal(provider.parentId, kc.realmId); assert.deepEqual(provider.config.editMode, ['READ_ONLY']); assert.deepEqual(provider.config.bindCredential, [BIND_PW], 'Keycloak holds the bind password');
  assert.deepEqual(provider.config.usernameLDAPAttribute, ['sAMAccountName']); assert.deepEqual(provider.config.uuidLDAPAttribute, ['objectGUID']); assert.deepEqual(provider.config.syncRegistrations, ['false']); assert.deepEqual(provider.config.trustEmail, ['false']); assert.deepEqual(provider.config.pagination, ['true']);
  assert.equal(mapper.providerId, 'group-ldap-mapper'); assert.equal(mapper.parentId, 'comp-1'); assert.deepEqual(mapper.config.mode, ['READ_ONLY']); assert.deepEqual(mapper.config['groups.ldap.filter'], ['(cn=Platform Users)']); assert.deepEqual(mapper.config['user.roles.retrieve.strategy'], ['LOAD_GROUPS_BY_MEMBER_ATTRIBUTE']);
  assert.equal(kc.logouts(), 1); assert.equal(refsLeft(db), 0);
  const s = ldapState(db); assert.equal(s.state, 'linked'); assert.equal(s.componentId, 'comp-1'); assert.deepEqual(s.sync.users, { added: 3, updated: 1, removed: 0, failed: 0 }); assert.equal(s.sync.groups.added, 1); assert.equal(s.config.bindPassword, undefined);
  secretFree(db, [q]);
  // Update: the recorded provider is PUT; a foreign provider with another name is untouched.
  const foreign = kc.foreign('Corporate AD'); kc.calls.length = 0;
  queueLdap(db, input({ revision: 1, displayName: 'Directory' }), user, 'link'); await run(db, kc);
  assert(steps(kc).includes('PUT /components/comp-1')); assert(steps(kc).includes('DELETE /components/comp-2'), 'the group mapping was turned off');
  assert.deepEqual(kc.components.get(foreign).config.editMode, ['WRITABLE']); assert.equal(refsLeft(db), 0); assert.equal(ldapState(db).groupMapped, false);
  assert.throws(() => queueLdap(db, input({ revision: 2, vendor: 'other' }), user, 'link'), /fresh link/);
  secretFree(db);
}));

test('LDAP-4 a failed test names the step, changes nothing and still deletes the protected copies', () => withDb(async (db, k) => {
  const kc = fakeKeycloak(k, { auth: false });
  const q = queueLdap(db, input(), user, 'link'); await run(db, kc);
  const job = getJob(db, q.job.id); assert.equal(job.status, 'failed'); assert.match(job.reason, /Authentication test failed/);
  assert.equal(kc.components.size, 0); assert.equal(refsLeft(db), 0); assert.equal(kc.logouts(), 1); assert.equal(ldapState(db).state, 'failed');
  secretFree(db);
  const kc2 = fakeKeycloak(k, { conn: false }), q2 = queueLdap(db, input({ revision: 1 }), user, 'link'); await run(db, kc2);
  assert.match(getJob(db, q2.job.id).reason, /Connection test failed.*trusts the directory/); assert.equal(refsLeft(db), 0);
  const q3 = queueLdap(db, input({ revision: 2, adminPassword: 'wrong-password' }), user, 'link'); await run(db, kc2);
  assert.match(getJob(db, q3.job.id).reason, /refused the administrator sign-in/); assert.equal(refsLeft(db), 0);
  secretFree(db);
}));

test('LDAP-5 never adopts or changes a same-named provider ProxyPilot did not create', () => withDb(async (db, k) => {
  const kc = fakeKeycloak(k), foreign = kc.foreign('Directory');
  const q = queueLdap(db, input(), user, 'link'); await run(db, kc);
  assert.equal(getJob(db, q.job.id).status, 'failed'); assert.match(getJob(db, q.job.id).reason, /did not create/);
  assert.deepEqual(kc.components.get(foreign).config, { bindCredential: ['theirs'], editMode: ['WRITABLE'] }); assert.equal(kc.components.size, 1);
  assert(!kc.calls.some(c => ['PUT', 'DELETE'].includes(c.method))); assert.equal(refsLeft(db), 0); assert.equal(readLdap(db).component_id, null);
  // A crash between create and record: our own marker is adopted, not duplicated.
  kc.components.clear(); kc.components.set('orphan', { id: 'orphan', name: 'Directory', providerId: 'ldap', providerType: UPT, parentId: kc.realmId, config: { 'proxypilot.installation': [k.id] } });
  queueLdap(db, input({ revision: 1 }), user, 'link'); await run(db, kc);
  assert.equal(readLdap(db).component_id, 'orphan'); assert.equal([...kc.components.values()].filter(c => c.providerType === UPT).length, 1);
}));

test('LDAP-6 remove deletes only the recorded provider (and needs one)', () => withDb(async (db, k) => {
  const kc = fakeKeycloak(k);
  assert.throws(() => queueLdap(db, { revision: 0, adminPassword: ADMIN_PW, reviewed: true }, user, 'remove'), /no directory link/);
  queueLdap(db, input(), user, 'link'); await run(db, kc);
  const foreign = kc.foreign('Corporate AD'); kc.calls.length = 0;
  const q = queueLdap(db, { revision: 1, adminPassword: ADMIN_PW, reviewed: true }, user, 'remove'); assert.equal(refsLeft(db), 1);
  await run(db, kc); assert.equal(getJob(db, q.job.id).status, 'succeeded');
  assert.deepEqual(kc.calls.filter(c => c.method === 'DELETE').map(c => c.path.split('/').pop()), ['comp-1']);
  assert(kc.components.has(foreign)); assert(!kc.components.has('comp-1')); assert.equal(refsLeft(db), 0);
  const s = ldapState(db); assert.equal(s.state, 'not_configured'); assert.equal(s.componentId, null); assert.equal(s.config.connectionUrl, 'ldaps://dc1.corp.example.com:636');
  secretFree(db);
}));

test('LDAP-7 HTTP: fresh local proof required; response and audit never carry the passwords', () => withDb(async db => {
  const f = await apiFixture(db);
  try {
    assert.equal((await f.request('/full/ldap', { method: 'POST', body: input() })).status, 403, 'no local proof');
    const session = db.prepare("SELECT id FROM sessions WHERE user_id='admin' AND sudo_until IS NOT NULL").get();
    db.prepare("INSERT INTO sso_session_context(session_id,user_id,origin,method,authenticated_at,local_proof_at) VALUES (?,'admin',?,'local',?,?)").run(session.id, f.url.replace('http:', 'https:'), Date.now(), Date.now());
    const bad = await f.request('/full/ldap', { method: 'POST', body: input({ connectionUrl: 'ldap://dc1.corp.example.com' }) });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /unencrypted/);
    const ok = await f.request('/full/ldap', { method: 'POST', body: input() }); assert.equal(ok.status, 202, JSON.stringify(ok.body));
    const read = await f.request('/full/ldap'); assert.equal(read.status, 200); assert.equal(read.body.state, 'pending'); assert.equal(read.body.administrator, 'alice');
    assert.equal((await f.request('/full/ldap', { method: 'POST', body: input({ revision: 1 }) })).status, 409, 'one operation at a time');
    assert.equal((await f.request('/full/ldap', { who: 'user' })).status, 403);
    assert(db.prepare("SELECT count(*) n FROM audit WHERE action='KEYCLOAK_LDAP_LINK_REQUESTED'").get().n === 1);
    secretFree(db, [ok.body, read.body, bad.body]);
  } finally { await f.close(); }
}));

test('runner validation accepts the reviewed Keycloak bootstrap recovery operation', async () => {
  const { validateRunnerJob } = await import('../lib/setup-engine/logic.js');
  const job = operation => ({ kind: 'full_platform_apply', app: 'pp-full-platform', plan_json: JSON.stringify({ params: { revision: 3, operation } }) });
  assert.equal(validateRunnerJob(job('keycloak_recovery')).ok,true);assert.equal(validateRunnerJob(job('retire')).ok,true);assert.equal(validateRunnerJob(job('anything_else')).ok,false);
});
