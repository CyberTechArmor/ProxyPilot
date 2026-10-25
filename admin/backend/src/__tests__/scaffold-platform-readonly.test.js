// The generated app's read-only SQL module (src/platform/readonly.ts) on the
// application foundation and off it. The module RUNS here (Node type
// stripping, a scripted database): the connection string it publishes for a
// socket DATABASE_URL, byte-identical output for TCP URLs, and the fixed
// reporting role the foundation's pg_hba admits. The real stack is proven by
// foundation-stack.docker.test.js (FOUNDATION_E2E=1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STACK, FOUNDATION_DATABASE_URL } from '../mock2/foundation-contract.js';
import { PLATFORM_MODULE_VERSION } from '../mock2/scaffold-platform.js';
import { materializeReadonly, runReadonly } from './helpers/platform-readonly.js';

function withApp(opts, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-ro-'));
  try { materializeReadonly(dir, opts); return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The connection string as the module computed it BEFORE the foundation
// change, copied verbatim — the reference for "TCP URLs are unchanged".
function legacyStrings(databaseUrl, role = 'app_readonly', password = 'pw') {
  let u = null;
  try { u = new URL(databaseUrl); } catch { u = null; }
  const host = u?.hostname ?? '127.0.0.1';
  const port = u?.port ?? '5432';
  const database = (u?.pathname ?? '/app').replace(/^\//, '');
  return {
    url: `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${port}/${database}`,
    odbc: `Driver={PostgreSQL Unicode};Server=${host};Port=${port};Database=${database};Uid=${role};Pwd=${password};sslmode=prefer;`,
  };
}

test('the platform version moved, so existing projects receive the new readonly.ts', () => {
  assert.equal(PLATFORM_MODULE_VERSION, 'mock2-platform-v12');
});

test('TCP DATABASE_URLs: the connection string is byte-identical to before', () => {
  withApp({ foundation: false }, (dir) => {
    for (const url of [
      'postgres://app:app@127.0.0.1:5432/app',
      'postgres://app:s3cret@db.internal.example:6543/reports',
      'postgresql://app@[::1]:5432/app',
      'postgres://app:app@localhost/app',
      'not a url at all',
    ]) {
      const out = runReadonly(dir, 'parts', { DATABASE_URL: url });
      assert.deepEqual({ url: out.url, odbc: out.odbc }, legacyStrings(url), url);
    }
  });
  // The same holds in a foundation app pointed at another server.
  withApp({ foundation: true }, (dir) => {
    const url = 'postgres://app:app@10.0.0.5:5432/app';
    const out = runReadonly(dir, 'parts', { DATABASE_URL: url });
    assert.deepEqual({ url: out.url, odbc: out.odbc }, legacyStrings(url));
  });
});

test('a Unix-socket DATABASE_URL publishes the guest\'s 127.0.0.1:5432, never an empty host', () => {
  assert.equal(new URL(FOUNDATION_DATABASE_URL).hostname, '', 'the bug: the socket URL has no host');
  withApp({ foundation: true }, (dir) => {
    const out = runReadonly(dir, 'parts', { DATABASE_URL: FOUNDATION_DATABASE_URL });
    assert.equal(out.url, `postgres://app_readonly:pw@${STACK.postgres.listen}:${STACK.postgres.port}/${STACK.postgres.database}`);
    assert.equal(out.odbc, 'Driver={PostgreSQL Unicode};Server=127.0.0.1;Port=5432;Database=app;Uid=app_readonly;Pwd=pw;sslmode=prefer;');
    for (const [url, db] of [
      ['postgres://app@/app', 'app'],                                    // no host part
      ['postgres://localhost/reports?host=/var/run/postgresql', 'reports'], // host= wins over the host part
      ['postgres:///?host=/run/x&user=app', 'app'],                      // no database in the path
    ]) {
      const o = runReadonly(dir, 'parts', { DATABASE_URL: url });
      assert.equal(o.url, `postgres://app_readonly:pw@127.0.0.1:5432/${db}`, url);
      assert.doesNotMatch(o.url, /@:/);
      assert.doesNotMatch(o.odbc, /Server=;/);
    }
    // The portable compose's port override moves the published port; garbage does not.
    assert.equal(runReadonly(dir, 'parts', { DATABASE_URL: FOUNDATION_DATABASE_URL, MOCK2_FOUNDATION_PG_PORT: '15432' }).url, 'postgres://app_readonly:pw@127.0.0.1:15432/app');
    assert.equal(runReadonly(dir, 'parts', { DATABASE_URL: FOUNDATION_DATABASE_URL, MOCK2_FOUNDATION_PG_PORT: '5432; x' }).url, 'postgres://app_readonly:pw@127.0.0.1:5432/app');
  });
});

test('on the foundation only app_readonly is admitted: another READONLY_DB_ROLE is reported, not silently broken', () => {
  withApp({ foundation: true }, (dir) => {
    const env = { DATABASE_URL: FOUNDATION_DATABASE_URL, READONLY_DB_ROLE: 'reporting' };
    const en = runReadonly(dir, 'enable', env);
    assert.equal(en.error.code, 'READONLY_ROLE_NOT_ADMITTED');
    assert.equal(en.error.privilege, true, 'a configuration answer: the route maps it to 409 with the message');
    assert.match(en.error.message, /one role only, "app_readonly"/);
    assert.match(en.error.message, /READONLY_DB_ROLE is set to "reporting"/);
    assert.deepEqual(en.queries, [], 'nothing is created or altered');

    const st = runReadonly(dir, 'status', { ...env, RO_FAKE_ROLES: JSON.stringify({ reporting: true, app_readonly: false }) });
    assert.deepEqual(st.result, { enabled: false, role: 'reporting', schema: 'api_read', code: 'READONLY_ROLE_NOT_ADMITTED', message: en.error.message });
    // A credential issued under the fixed name before the setting changed is
    // still reachable: the switch shows it on, so it can be turned off …
    assert.equal(runReadonly(dir, 'status', { ...env, RO_FAKE_ROLES: JSON.stringify({ app_readonly: true }) }).result.enabled, true);
    // … and off closes the one TCP path whatever READONLY_DB_ROLE says.
    const off = runReadonly(dir, 'disable', { ...env, RO_FAKE_ROLES: JSON.stringify({ reporting: true, app_readonly: true }) });
    assert.deepEqual(off.queries.filter((q) => /ALTER ROLE/.test(q)), ['ALTER ROLE "reporting" WITH NOLOGIN', 'ALTER ROLE "app_readonly" WITH NOLOGIN']);
  });
  // The default name issues normally on the foundation.
  withApp({ foundation: true }, (dir) => {
    const en = runReadonly(dir, 'enable', { DATABASE_URL: FOUNDATION_DATABASE_URL });
    assert.equal(en.error, undefined, JSON.stringify(en.error));
    assert.equal(en.result.role, 'app_readonly');
    assert.match(en.result.url, /^postgres:\/\/app_readonly:[A-Za-z0-9_-]{32}@127\.0\.0\.1:5432\/app$/);
    assert.ok(en.queries.some((q) => /^CREATE ROLE "app_readonly" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '/.test(q)));
    assert.deepEqual(runReadonly(dir, 'disable', { DATABASE_URL: FOUNDATION_DATABASE_URL, RO_FAKE_ROLES: '{"app_readonly":true}' }).queries.filter((q) => /ALTER ROLE/.test(q)), ['ALTER ROLE "app_readonly" WITH NOLOGIN']);
  });
  // Off the foundation (no foundation/ runtime, or a TCP DATABASE_URL), the
  // setting is honoured as before.
  for (const [foundation, url] of [[false, FOUNDATION_DATABASE_URL], [true, 'postgres://app:app@127.0.0.1:5432/app']]) {
    withApp({ foundation }, (dir) => {
      const en = runReadonly(dir, 'enable', { DATABASE_URL: url, READONLY_DB_ROLE: 'reporting' });
      assert.equal(en.error, undefined, JSON.stringify(en.error));
      assert.equal(en.result.role, 'reporting');
      assert.ok(en.queries.some((q) => /^CREATE ROLE "reporting"/.test(q)));
      assert.equal(runReadonly(dir, 'status', { DATABASE_URL: url, READONLY_DB_ROLE: 'reporting', RO_FAKE_ROLES: '{"reporting":true}' }).result.code, undefined);
    });
  }
});

test('a missing CREATEROLE: the foundation says the platform grants it; elsewhere the DBA statement', () => {
  withApp({ foundation: true }, (dir) => {
    const f = runReadonly(dir, 'enable', { DATABASE_URL: FOUNDATION_DATABASE_URL, RO_FAKE_DENY: '1' });
    assert.equal(f.error.code, 'DB_PRIVILEGE');
    assert.match(f.error.message, /ProxyPilot grants it CREATEROLE/);
    assert.match(f.error.message, /next bring-up/);
    const legacy = runReadonly(dir, 'enable', { DATABASE_URL: 'postgres://app:app@127.0.0.1:5432/app', RO_FAKE_DENY: '1' });
    assert.equal(legacy.error.code, 'DB_PRIVILEGE');
    assert.match(legacy.error.message, /ALTER ROLE <app_role> CREATEROLE;/);
  });
});
