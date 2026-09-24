// The Infisical administrator's generated password, kept in OpenBao (infisical-admin-vault.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { infisicalAdminVault, generatePassword, ADMIN_SECRET_PATH } from '../lib/setup-engine/infisical-admin-vault.js';
import { namesFor } from '../lib/setup-engine/openbao-logic.js';

const bao = { credential_ref: 'bao-ref-0123456789ab', bootstrap_complete: 1, config: { mode: 'install', basic: true, custody: 'auto' } };
const kv = `${namesFor(bao).prefix}-kv`, data = `/v1/${kv}/data/${ADMIN_SECRET_PATH}`, meta = `/v1/${kv}/metadata/${ADMIN_SECRET_PATH}`;

// A KV v2 engine with one path; `deleted` marks the latest version soft-deleted.
function engine({ stored = null, version = 0, deleted = false } = {}) {
  const s = { stored, version, deleted, writes: [], roots: 0 };
  s.api = async (path, { method = 'GET', body, token } = {}) => {
    assert.equal(token, 'transient-root');
    if (path === data && method === 'GET') return s.stored && !s.deleted ? { status: 200, body: { data: { data: s.stored, metadata: { version: s.version } } } } : { status: 404, body: null };
    if (path === meta) return s.version ? { status: 200, body: { data: { current_version: s.version } } } : { status: 404, body: null };
    if (path === data && method === 'POST') { s.writes.push(body); if (body.options.cas !== s.version) return { status: 400, body: null }; s.version++; s.stored = body.data; s.deleted = false; return { status: 200, body: {} }; }
    throw Error('unscripted ' + method + ' ' + path);
  };
  s.deps = { read: () => bao, reach: async () => ({ api: s.api }), ready: async () => ({}), root: async (_db, _b, _api, fn) => { s.roots++; return fn('transient-root'); } };
  return s;
}

test('generatePassword: four groups of six, mixed case and digits, never the same twice', () => {
  const a = generatePassword(), b = generatePassword();
  assert.match(a, /^[A-Za-z0-9]{6}(-[A-Za-z0-9]{6}){3}$/);
  assert(/[A-Z]/.test(a) && /[a-z]/.test(a) && /[0-9]/.test(a));
  assert.notEqual(a, b);
});

test('fresh: a new password is written with check-and-set, read back, and returned', async () => {
  const e = engine();
  const password = await infisicalAdminVault(null, { email: 'alice@example.com', origin: 'https://secure.example.com', fresh: true }, e.deps);
  assert.equal(e.writes.length, 1);
  assert.equal(e.writes[0].options.cas, 0, 'creates only when nothing is there');
  assert.deepEqual({ ...e.stored, note: undefined }, { email: 'alice@example.com', password, url: 'https://secure.example.com', note: undefined });
  assert.equal(e.roots, 1, 'one transient root for the whole exchange');
});

test('fresh over an older entry writes the next version; a deleted latest version still counts', async () => {
  const e = engine({ stored: { email: 'old@example.com', password: 'old' }, version: 3, deleted: true });
  const password = await infisicalAdminVault(null, { email: 'alice@example.com', origin: 'https://s', fresh: true }, e.deps);
  assert.equal(e.writes[0].options.cas, 3);
  assert.equal(e.version, 4);
  assert.equal(e.stored.password, password);
});

test('resume: the stored password is returned only for the recorded account; nothing is written', async () => {
  const e = engine({ stored: { email: 'alice@example.com', password: 'stored-generated' }, version: 1 });
  assert.equal(await infisicalAdminVault(null, { email: 'alice@example.com', fresh: false }, e.deps), 'stored-generated');
  await assert.rejects(infisicalAdminVault(null, { email: 'bob@example.com', fresh: false }, e.deps), /belongs to alice@example.com/);
  assert.equal(e.writes.length, 0);
  const empty = engine();
  await assert.rejects(infisicalAdminVault(null, { email: 'alice@example.com', fresh: false }, empty.deps), /No generated Infisical password is stored/);
});

test('refused without automatic custody or before OpenBao bootstrap; OpenBao refusals are labelled', async () => {
  const e = engine();
  for (const b of [{ ...bao, bootstrap_complete: 0 }, { ...bao, config: { ...bao.config, custody: undefined } }, null])
    await assert.rejects(infisicalAdminVault(null, { email: 'a@example.com', fresh: true }, { ...e.deps, read: () => b }), /not installed here with automatic custody/);
  const sealed = Object.assign(new Error('OpenBao is sealed.'), { openbaoSafe: true, status: 409 });
  await assert.rejects(infisicalAdminVault(null, { email: 'a@example.com', fresh: true }, { ...e.deps, ready: async () => { throw sealed; } }), e2 => e2.infisicalSafe && /^OpenBao: OpenBao is sealed/.test(e2.message));
  assert.equal(e.writes.length, 0);
});
