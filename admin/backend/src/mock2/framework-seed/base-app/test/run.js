'use strict';
// End-to-end acceptance tests against an in-process server instance.
const assert = require('assert');
const http = require('http');
const JSZip = require('jszip');
const path = require('path');
const fs = require('fs');

// Fresh DB per run — in an ISOLATED temp directory so the acceptance suite can
// NEVER delete or overwrite the production data/ (db.json, secret.key).
const os = require('os');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'credportal-test-'));
process.env.APP_DATA_DIR = DATA;
process.env.ACCESS_TTL_MS = '600000';
// The base template refuses to build emailed links from request headers; the
// canonical origin is configured, exactly as a real deployment must.
process.env.APP_BASE_URL = 'https://portal.test.local';
delete process.env.APP_MASTER_KEY; // ensure a fresh key is generated in the temp dir
for (const f of ['db.json', 'secret.key']) { try { fs.unlinkSync(path.join(DATA, f)); } catch (_) {} }

const { server } = require('../server');
const ldap = require('../lib/ldap');
let base;

function req(method, p, body, cookies) {
  return new Promise((resolve, reject) => {
    const data = (body !== undefined && body !== null) ? JSON.stringify(body) : null;
    const u = new URL(base + p);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cookies ? { Cookie: cookies } : {}) }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = {}; try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, data: json, cookies: extractCookies(res.headers['set-cookie']) });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
// Raw-binary upload (assets, documents): the body is bytes, not JSON, and the
// filename rides in a header. Kept separate from req() so req() can keep its
// "no body means no body" rule — see the keep-alive note in BASE-APP-MIGRATION.
function rawUpload(p, buf, cookies, extra = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const headers = Object.assign({ 'Content-Length': buf.length }, cookies ? { Cookie: cookies } : {}, extra);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { let json = {}; try { json = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, data: json }); });
    });
    r.on('error', reject);
    r.end(buf);
  });
}
// Fetches a non-JSON response and keeps the headers + raw bytes, so a test can
// assert on Content-Type and the security headers rather than just the status.
function rawGet(p, cookies) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: cookies ? { Cookie: cookies } : {} }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
// Same as req(), but lets a test forge request headers (host spoofing,
// X-Forwarded-For rotation) to prove the server does not trust them.
function reqWithHeaders(method, p, body, cookies, extra = {}) {
  return new Promise((resolve, reject) => {
    const data = (body !== undefined && body !== null) ? JSON.stringify(body) : null;
    const u = new URL(base + p);
    const headers = Object.assign({ 'Content-Type': 'application/json' }, cookies ? { Cookie: cookies } : {}, extra);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = {}; try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, data: json, cookies: extractCookies(res.headers['set-cookie']) });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function extractCookies(arr) {
  if (!arr) return null;
  return arr.map(c => c.split(';')[0]).join('; ');
}
function rawReq(method, p, body, cookies, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const u = new URL(base + p);
    const headers = Object.assign({}, cookies ? { Cookie: cookies } : {}, extraHeaders || {});
    if (data) headers['Content-Length'] = data.length;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function merge(a, b) {
  const map = {};
  (a || '').split('; ').concat((b || '').split('; ')).forEach(kv => { const i = kv.indexOf('='); if (i > 0) map[kv.slice(0, i)] = kv.slice(i + 1); });
  return Object.entries(map).filter(([k]) => k).map(([k, v]) => `${k}=${v}`).join('; ');
}

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); } catch (e) { console.log('  \x1b[31m✗ ' + name + '\x1b[0m\n    ' + e.message); process.exitCode = 1; } }

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  console.log('\nAuth/RBAC acceptance tests\n');

  let adminCookies, mgrCookies, physCookies;

  await test('setup required before any admin exists', async () => {
    const r = await req('GET', '/api/setup/status');
    assert.strictEqual(r.data.needsSetup, true);
  });

  await test('super admin setup creates admin + session, and cannot run twice', async () => {
    const r = await req('POST', '/api/setup', { username: 'admin', password: 'Sup3rSecret!', email: 'admin@org.io', displayName: 'Root Admin' });
    assert.strictEqual(r.status, 201);
    assert.ok(r.data.user.permissions.includes('ldap.manage'));
    adminCookies = r.cookies;
    const again = await req('POST', '/api/setup', { username: 'x', password: 'yyyyyyyy' });
    assert.strictEqual(again.status, 409);
    const st = await req('GET', '/api/setup/status');
    assert.strictEqual(st.data.needsSetup, false);
  });

  await test('local auth success + failure', async () => {
    const ok = await req('POST', '/api/auth/login', { login: 'admin', password: 'Sup3rSecret!' });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.data.code, 'OK');
    const bad = await req('POST', '/api/auth/login', { login: 'admin', password: 'nope' });
    assert.strictEqual(bad.status, 401); assert.strictEqual(bad.data.code, 'INVALID_CREDENTIALS');
  });

  await test('authenticated local user can change password', async () => {
    const bad = await req('POST', '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'NewSup3rSecret!' }, adminCookies);
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(bad.data.code, 'INVALID_CREDENTIALS');
    const changed = await req('POST', '/api/auth/change-password', { currentPassword: 'Sup3rSecret!', newPassword: 'NewSup3rSecret!' }, adminCookies);
    assert.strictEqual(changed.status, 200);
    const oldLogin = await req('POST', '/api/auth/login', { login: 'admin', password: 'Sup3rSecret!' });
    assert.strictEqual(oldLogin.status, 401);
    const newLogin = await req('POST', '/api/auth/login', { login: 'admin', password: 'NewSup3rSecret!' });
    assert.strictEqual(newLogin.status, 200);
  });

  await test('LDAP fallback: local miss -> LDAP success provisions user', async () => {
    // configure ldap + inject a fake adapter via monkeypatch on module
    const store = require('../lib/store');
    store.get().ldapConfig = { enabled: true, host: 'ldap.test', port: 389, baseDN: 'dc=t', bindDN: 'cn=svc', userFilter: '(uid=%u)', defaultRoles: ['staff'] };
    store.save();
    const auth = require('../lib/auth');
    const fake = { authenticate: async (cfg, u, p) => (u === 'ldapuser' && p === 'ldappass') ? { ok: true, dn: 'uid=ldapuser,dc=t', profile: { displayName: 'Lydia Directory', email: 'lydia.directory@org.io' } } : { ok: false, code: 'INVALID_CREDENTIALS' } };
    const res = await auth.authenticate('ldapuser', 'ldappass', { ldap: fake });
    assert.strictEqual(res.ok, true); assert.strictEqual(res.provider, 'ldap');
    const user = require('../lib/users').findByLogin('ldapuser');
    assert.strictEqual(user.displayName, 'Lydia Directory');
    assert.strictEqual(user.email, 'lydia.directory@org.io');
    const bad = await auth.authenticate('ldapuser', 'wrong', { ldap: fake });
    assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, 'INVALID_CREDENTIALS');
  });

  await test('LDAP connection test returns structured failure for unreachable host', async () => {
    const r = await ldap.connectionTest({ host: '127.0.0.1', port: 3899, useTLS: false });
    assert.strictEqual(r.status, 'error');
    assert.ok(['CONNECT_FAILED', 'TIMEOUT'].includes(r.code));
    assert.ok(typeof r.reason === 'string');
  });

  await test('admin can create a manager user and a physician user', async () => {
    const mgr = await req('POST', '/api/admin/users', { username: 'mgr', email: 'mgr@org.io', password: 'Managerpass1', displayName: 'Casey Manager', roles: ['manager'] }, adminCookies);
    assert.strictEqual(mgr.status, 201);
    const phys = await req('POST', '/api/admin/users', { username: 'doc', email: 'doc@org.io', password: 'Doctorpass1', displayName: 'Dr Doc', roles: ['physician'] }, adminCookies);
    assert.strictEqual(phys.status, 201);
    mgrCookies = (await req('POST', '/api/auth/login', { login: 'mgr', password: 'Managerpass1' })).cookies;
    physCookies = (await req('POST', '/api/auth/login', { login: 'doc', password: 'Doctorpass1' })).cookies;
  });

  await test('admin reset link forces password change and signs user in', async () => {
    const doc = (await req('GET', '/api/admin/users', null, adminCookies)).data.users.find(u => u.username === 'doc');
    const issued = await req('POST', `/api/admin/users/${doc.id}/password-reset`, undefined, adminCookies);
    assert.strictEqual(issued.status, 200);
    assert.strictEqual(issued.data.code, 'OK');
    assert.ok(issued.data.link.includes('reset='));
    assert.strictEqual(issued.data.emailed, false);
    const oldLogin = await req('POST', '/api/auth/login', { login: 'doc', password: 'Doctorpass1' });
    assert.strictEqual(oldLogin.status, 401);
    assert.strictEqual(oldLogin.data.code, 'PASSWORD_RESET_REQUIRED');
    const token = new URL(issued.data.link).searchParams.get('reset');
    const changed = await req('POST', '/api/auth/reset', { token, newPassword: 'NewDoctorpass1' });
    assert.strictEqual(changed.status, 200);
    assert.strictEqual(changed.data.code, 'OK');
    physCookies = changed.cookies;
    const me = await req('GET', '/api/auth/me', null, physCookies);
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.data.user.username, 'doc');
  });

  await test('admin OTP email link signs user in once', async () => {
    const doc = (await req('GET', '/api/admin/users', null, adminCookies)).data.users.find(u => u.username === 'doc');
    const issued = await req('POST', `/api/admin/users/${doc.id}/login-link`, undefined, adminCookies);
    assert.strictEqual(issued.status, 200);
    assert.strictEqual(issued.data.code, 'OK');
    assert.ok(issued.data.link.includes('otp='));
    const token = new URL(issued.data.link).searchParams.get('otp');
    const login = await req('POST', '/api/auth/otp', { token });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.data.user.username, 'doc');
    const replay = await req('POST', '/api/auth/otp', { token });
    assert.strictEqual(replay.status, 400);
    assert.strictEqual(replay.data.code, 'INVALID_TOKEN');
  });

  await test('login screen OTP request emails one-time sign-in link', async () => {
    const store = require('../lib/store');
    const mailer = require('../lib/mailer');
    store.get().smtpConfig = { enabled: true, host: 'smtp.test', fromEmail: 'no-reply@org.io' };
    store.save();
    const originalSendMail = mailer.sendMail;
    let sent;
    mailer.sendMail = async (cfg, msg) => { sent = msg; return { ok: true, code: 'OK' }; };
    try {
      const issued = await req('POST', '/api/auth/otp/request', { login: 'doc' });
      assert.strictEqual(issued.status, 200);
      assert.strictEqual(issued.data.code, 'OK');
      assert.ok(sent && sent.text.includes('/?otp='));
      const link = sent.text.match(/https?:\/\/\S+\/\?otp=\S+/)[0];
      const token = new URL(link).searchParams.get('otp');
      const login = await req('POST', '/api/auth/otp', { token });
      assert.strictEqual(login.status, 200);
      assert.strictEqual(login.data.user.username, 'doc');
    } finally {
      mailer.sendMail = originalSendMail;
    }
  });

  await test('RBAC: physician cannot view users; manager can', async () => {
    const p = await req('GET', '/api/admin/users', null, physCookies);
    assert.strictEqual(p.status, 403); assert.strictEqual(p.data.code, 'FORBIDDEN');
    const m = await req('GET', '/api/admin/users', null, mgrCookies);
    assert.strictEqual(m.status, 200);
  });

  await test('RBAC: manager cannot manage roles (no roles.manage)', async () => {
    const r = await req('POST', '/api/admin/roles', { key: 'x', label: 'X' }, mgrCookies);
    assert.strictEqual(r.status, 403);
  });

  await test('permission override flips effective access', async () => {
    // deny portal.view for physician, then allow again
    const off = await req('PUT', '/api/admin/overrides', { roleKey: 'physician', permKey: 'portal.view', allowed: false }, adminCookies);
    assert.strictEqual(off.status, 200);
    const rbac = require('../lib/rbac');
    assert.strictEqual(rbac.isAllowed('physician', 'portal.view'), false);
    const on = await req('PUT', '/api/admin/overrides', { roleKey: 'physician', permKey: 'users.view', allowed: true }, adminCookies);
    assert.strictEqual(on.status, 200);
    assert.strictEqual(rbac.isAllowed('physician', 'users.view'), true);
    // clear overrides
    await req('PUT', '/api/admin/overrides', { roleKey: 'physician', permKey: 'portal.view', allowed: null }, adminCookies);
    await req('PUT', '/api/admin/overrides', { roleKey: 'physician', permKey: 'users.view', allowed: null }, adminCookies);
  });

  await test('protected roles cannot be deleted or edited', async () => {
    const del = await req('DELETE', '/api/admin/roles/admin', null, adminCookies);
    assert.strictEqual(del.status, 409); assert.strictEqual(del.data.code, 'ROLE_PROTECTED');
    const edit = await req('PATCH', '/api/admin/roles/admin', { label: 'Hacked' }, adminCookies);
    assert.strictEqual(edit.status, 409);
  });

  await test('roles assigned to users cannot be deleted', async () => {
    const r = await req('DELETE', '/api/admin/roles/physician', null, adminCookies);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.data.code, 'ROLE_IN_USE');
  });

  await test('self-deactivation is prevented', async () => {
    const me = await req('GET', '/api/auth/me', null, adminCookies);
    const r = await req('PATCH', `/api/admin/users/${me.data.user.id}/active`, { active: false }, adminCookies);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.data.code, 'SELF_DEACTIVATION');
  });

  await test('deactivated user is blocked (ACCOUNT_DEACTIVATED) on access and login', async () => {
    const doc = (await req('GET', '/api/admin/users', null, adminCookies)).data.users.find(u => u.username === 'doc');
    const de = await req('PATCH', `/api/admin/users/${doc.id}/active`, { active: false }, adminCookies);
    assert.strictEqual(de.status, 200);
    // existing session now blocked
    const me = await req('GET', '/api/auth/me', null, physCookies);
    assert.strictEqual(me.status, 403); assert.strictEqual(me.data.code, 'ACCOUNT_DEACTIVATED');
    // login blocked
    const login = await req('POST', '/api/auth/login', { login: 'doc', password: 'Doctorpass1' });
    assert.strictEqual(login.status, 403); assert.strictEqual(login.data.code, 'ACCOUNT_DEACTIVATED');
  });

  await test('reactivation restores access automatically via existing session', async () => {
    const doc = (await req('GET', '/api/admin/users', null, adminCookies)).data.users.find(u => u.username === 'doc');
    const re = await req('PATCH', `/api/admin/users/${doc.id}/active`, { active: true }, adminCookies);
    assert.strictEqual(re.status, 200);
    // same original session cookie now works again (no manual login)
    const me = await req('GET', '/api/auth/me', null, physCookies);
    assert.strictEqual(me.status, 200); assert.strictEqual(me.data.user.username, 'doc');
  });

  await test('team can download a provider packet bundle', async () => {
    const doc = (await req('GET', '/api/admin/users', null, adminCookies)).data.users.find(u => u.username === 'doc');
    const upload = await rawReq('POST', '/api/files', Buffer.from('%PDF-1.4\n'), physCookies, { 'Content-Type': 'application/pdf', 'X-Filename': 'credential.pdf', 'X-Dockey': 'credential' });
    assert.strictEqual(upload.status, 201);
    const downloaded = await rawReq('GET', `/api/providers/${doc.id}/packet`, null, mgrCookies);
    assert.strictEqual(downloaded.status, 200);
    assert.strictEqual(downloaded.headers['content-type'], 'application/zip');
    assert.match(downloaded.headers['content-disposition'], /attachment; filename="Dr-Doc-credentialing-packet\.zip"/);
    assert.strictEqual(downloaded.body.subarray(0, 2).toString(), 'PK');
    const bundle = await JSZip.loadAsync(downloaded.body);
    assert.ok(bundle.file('credentialing-packet.pdf'));
    assert.ok(bundle.file('files/credential.pdf'));
    assert.ok(downloaded.body.length > 1000);
  });

  await test('refresh rotates tokens and preserves session', async () => {
    const rf = await req('POST', '/api/auth/refresh', undefined, mgrCookies);
    assert.strictEqual(rf.status, 200); assert.strictEqual(rf.data.code, 'OK');
    const merged = merge(mgrCookies, rf.cookies);
    const me = await req('GET', '/api/auth/me', null, merged);
    assert.strictEqual(me.status, 200);
  });

  await test('audit log captures auth + admin mutations', async () => {
    const a = await req('GET', '/api/admin/audit', null, adminCookies);
    assert.strictEqual(a.status, 200);
    const actions = a.data.events.map(e => e.action);
    for (const need of ['setup.completed', 'login.success', 'user.deactivated', 'user.activated', 'permission.override'])
      assert.ok(actions.includes(need), 'missing audit action ' + need);
  });

  /* ---- security regressions (ProxyPilot base-template hardening) ---- */

  await test('SECURITY: set-password requires proof — no takeover of a provisioned account', async () => {
    // Provision an account that has never logged in (mustSetPassword, no password).
    const created = await req('POST', '/api/admin/users',
      { username: 'newhire', email: 'newhire@example.com', roles: ['physician'], mustSetPassword: true }, adminCookies);
    assert.strictEqual(created.status, 201);

    // THE ORIGINAL HOLE: knowing only the username used to be enough to claim
    // the account and be handed a session. It must now be refused outright.
    const takeover = await req('POST', '/api/auth/set-password', { login: 'newhire', newPassword: 'AttackerPass1' });
    assert.strictEqual(takeover.status, 400);
    assert.strictEqual(takeover.data.code, 'PROOF_REQUIRED');
    assert.ok(!takeover.cookies, 'no session may be issued without proof');

    // A wrong/forged token is likewise refused, and never says which part failed.
    const badToken = await req('POST', '/api/auth/set-password', { token: 'not-a-real-token', newPassword: 'AttackerPass1' });
    assert.strictEqual(badToken.status, 400);
    assert.strictEqual(badToken.data.code, 'INVALID_REQUEST');

    // The legitimate path: an admin-issued single-use link carries the proof.
    const issued = await req('POST', `/api/admin/users/${created.data.user.id}/password-reset`, undefined, adminCookies);
    assert.strictEqual(issued.status, 200);
    const token = new URL(issued.data.link).searchParams.get('reset');
    const ok = await req('POST', '/api/auth/set-password', { token, newPassword: 'RealNewPass1' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.code, 'OK');
    assert.ok(ok.cookies, 'a valid token does issue a session');

    // Single use: the same token cannot be replayed.
    const replay = await req('POST', '/api/auth/set-password', { token, newPassword: 'ThirdPass1' });
    assert.strictEqual(replay.status, 400);
  });

  await test('SECURITY: emailed links use the canonical origin, not the Host header', async () => {
    // Ask for a reset while forging the host headers an attacker controls.
    const target = (await req('GET', '/api/admin/users', null, adminCookies)).data.users.find(u => u.username === 'newhire');
    const issued = await reqWithHeaders('POST', `/api/admin/users/${target.id}/password-reset`, undefined, adminCookies, {
      'X-Forwarded-Host': 'evil.example.net', Host: 'evil.example.net'
    });
    assert.strictEqual(issued.status, 200);
    const link = String(issued.data.link || '');
    assert.ok(!link.includes('evil.example.net'), 'emailed link must never adopt a forged host: ' + link);
    assert.ok(link.startsWith(process.env.APP_BASE_URL), 'link must use APP_BASE_URL: ' + link);
  });

  await test('SECURITY: X-Forwarded-For is ignored unless TRUSTED_PROXY is set', async () => {
    // With TRUSTED_PROXY unset (the default in this suite), a spoofed XFF must
    // not mint a fresh rate-limit identity. Exhaust the login limiter from one
    // socket while rotating the header, and it must still trip.
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await reqWithHeaders('POST', '/api/auth/login', { login: 'nobody-xff', password: 'wrong' }, null,
        { 'X-Forwarded-For': `10.0.0.${i}` });
      if (r.status === 429) limited = true;
    }
    assert.ok(limited, 'rate limit must not be bypassable by rotating X-Forwarded-For');
  });

  await test('SECURITY: session rows are pruned instead of growing forever', async () => {
    const sessionLib = require('../lib/session');
    const store = require('../lib/store');
    const db = store.get();
    const before = db.sessions.length;
    // A long-settled revoked session is dead weight and must be collected.
    db.sessions.push({ id: 'stale-1', familyId: 'f', userId: 'u', refreshHash: 'x',
      createdAt: 1, lastUsedAt: 1, absoluteExpiry: 1, idleExpiry: 1, revoked: true, revokedAt: 1 });
    sessionLib.prune(db);
    assert.ok(!db.sessions.find(s => s.id === 'stale-1'), 'expired/revoked sessions must be pruned');
    assert.ok(db.sessions.length >= before - 1);
  });


  /* ---------------- Branding, legal pages & assets ---------------- */

  await test("legal pages and branding are readable with NO session", async () => {
    // The sign-in screen renders these before anyone has authenticated, so an
    // auth guard creeping onto these routes must fail the suite loudly.
    const b = await req("GET", "/api/branding");
    assert.strictEqual(b.status, 200);
    assert.ok(b.data.branding.orgName, "public branding must carry an org name");
    assert.strictEqual(b.data.branding.legal.length, 2);
    for (const slug of ["privacy", "terms"]) {
      const pg = await req("GET", "/api/legal/" + slug);
      assert.strictEqual(pg.status, 200, slug + " must be public");
      assert.ok(pg.data.page.body.length > 200, slug + " must ship real default copy");
      assert.ok(!/\{\{ORG\}\}/.test(pg.data.page.body), "placeholders must be substituted on read");
    }
    const missing = await req("GET", "/api/legal/nope");
    assert.strictEqual(missing.status, 404);
  });

  await test("copyright notice always carries the CURRENT year", async () => {
    const brandingLib = require("../lib/branding");
    const year = new Date().getFullYear();
    const now = (await req("GET", "/api/branding")).data.branding;
    assert.ok(now.copyright.includes(String(year)), "notice must name the current year");
    assert.strictEqual(now.year, year);
    // A year rolling over must not need a redeploy: the notice is computed on
    // read, so asking for a future date yields that year, not a stored one.
    const future = new Date(Date.UTC(year + 3, 5, 1));
    assert.ok(brandingLib.copyrightNotice(brandingLib.raw(), future).includes(String(year + 3)));
    // With a start year in the past it becomes a range ending in the current year.
    brandingLib.updateIdentity({ copyrightStartYear: 2019 }, "test");
    const ranged = (await req("GET", "/api/branding")).data.branding.copyright;
    assert.ok(ranged.includes("2019–" + year), "expected a range, got: " + ranged);
    brandingLib.updateIdentity({ copyrightStartYear: null }, "test");
  });

  await test("branding edits require the branding.manage permission", async () => {
    const anon = await req("PUT", "/api/admin/branding", { orgName: "Pwned" });
    assert.strictEqual(anon.status, 401);
    // A physician has no administration rights at all.
    const phys = await req("PUT", "/api/admin/branding", { orgName: "Pwned" }, physCookies);
    assert.strictEqual(phys.status, 403);
    const pg = await req("PUT", "/api/admin/branding/pages/privacy", { body: "gone" }, physCookies);
    assert.strictEqual(pg.status, 403);
    const assets = await req("GET", "/api/admin/branding/assets", null, physCookies);
    assert.strictEqual(assets.status, 403);
    assert.strictEqual((await req("GET", "/api/branding")).data.branding.orgName !== "Pwned", true);
  });

  await test("admin can edit the legal pages and restore the standard text", async () => {
    const edited = await req("PUT", "/api/admin/branding/pages/terms",
      { title: "Terms of Service", body: "## Custom\nOur own terms for {{ORG}}." }, adminCookies);
    assert.strictEqual(edited.status, 200);
    const pub = await req("GET", "/api/legal/terms");
    assert.strictEqual(pub.data.page.title, "Terms of Service");
    assert.ok(pub.data.page.body.includes("Our own terms for"));
    assert.ok(!pub.data.page.body.includes("{{ORG}}"), "the org placeholder must be substituted");
    assert.strictEqual(pub.data.page.isDefault, false);
    assert.ok(pub.data.page.updatedAt, "an edited page records when it changed");

    const restored = await req("POST", "/api/admin/branding/pages/terms/reset", undefined, adminCookies);
    assert.strictEqual(restored.status, 200);
    const back = await req("GET", "/api/legal/terms");
    assert.strictEqual(back.data.page.title, "Terms & Conditions");
    assert.strictEqual(back.data.page.isDefault, true);
  });

  await test("renaming the organisation updates the legal copy and the notice", async () => {
    const r = await req("PUT", "/api/admin/branding", { orgName: "Northwind Health", legalName: "Northwind Health LLC", rightsMark: "®" }, adminCookies);
    assert.strictEqual(r.status, 200);
    const b = (await req("GET", "/api/branding")).data.branding;
    assert.ok(b.copyright.includes("Northwind Health LLC®"), "got: " + b.copyright);
    const privacy = await req("GET", "/api/legal/privacy");
    assert.ok(privacy.data.page.body.includes("Northwind Health LLC"), "default copy must follow the rename");
    const bad = await req("PUT", "/api/admin/branding", { rightsMark: "(c)" }, adminCookies);
    assert.strictEqual(bad.status, 400);
    const blank = await req("PUT", "/api/admin/branding", { orgName: "   " }, adminCookies);
    assert.strictEqual(blank.status, 400);
  });

  await test("logo upload serves publicly, favicon falls back to it, delete clears both", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const up = await rawUpload("/api/admin/branding/assets", png, adminCookies,
      { "Content-Type": "image/png", "X-Filename": "logo.png", "X-Asset-Kind": "logo" });
    assert.strictEqual(up.status, 201);
    const id = up.data.asset.id;

    // Public projection points at it, and the favicon INHERITS the logo.
    const b = (await req("GET", "/api/branding")).data.branding;
    assert.strictEqual(b.logoUrl, "/api/branding/assets/" + id);
    assert.strictEqual(b.faviconUrl, b.logoUrl, "favicon must fall back to the logo");

    // Served with no session, with the fixed type and the anti-XSS headers.
    const img = await rawGet("/api/branding/assets/" + id);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers["content-type"], "image/png");
    assert.strictEqual(img.headers["x-content-type-options"], "nosniff");
    assert.ok(/sandbox/.test(img.headers["content-security-policy"] || ""), "assets must be served sandboxed");
    assert.strictEqual(img.body.length, png.length);
    // /favicon.ico resolves without a <link> hint or a session.
    assert.strictEqual((await rawGet("/favicon.ico")).status, 200);

    // Only allowlisted types are storable.
    const bad = await rawUpload("/api/admin/branding/assets", Buffer.from("<script>alert(1)</script>"), adminCookies,
      { "Content-Type": "text/html", "X-Filename": "evil.html" });
    assert.strictEqual(bad.status, 415);

    // Deleting the logo must clear the pointer, or the favicon fallback would
    // resolve to a permanent 404.
    const del = await req("DELETE", "/api/admin/branding/assets/" + id, null, adminCookies);
    assert.strictEqual(del.status, 200);
    const after = (await req("GET", "/api/branding")).data.branding;
    assert.strictEqual(after.logoUrl, null);
    assert.strictEqual(after.faviconUrl, null);
    assert.strictEqual((await rawGet("/api/branding/assets/" + id)).status, 404);
    assert.strictEqual((await rawGet("/favicon.ico")).status, 404);
  });

  await test("app context is editable and exposed publicly", async () => {
    const r = await req("PUT", "/api/admin/branding", { appContext: {
      summary: "Collects and reviews physician credentialing documents.",
      audience: "Physicians and the credentialing team.",
      features: [{ title: "Upload documents", detail: "Against a guided checklist." }, { title: "", detail: "dropped" }]
    } }, adminCookies);
    assert.strictEqual(r.status, 200);
    const ctx = (await req("GET", "/api/branding")).data.branding.appContext;
    assert.strictEqual(ctx.features.length, 1, "capabilities without a title are dropped");
    assert.strictEqual(ctx.features[0].title, "Upload documents");
    assert.ok(ctx.updatedAt, "editing stamps when the description last changed");
  });

  console.log(`\n${passed} checks passed.${process.exitCode ? ' (with failures)' : ''}\n`);
  server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
