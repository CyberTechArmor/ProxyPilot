// The data half of the master-secret decision: real AES-256-GCM ciphertexts
// under the component's own scheme, every probe state, and the case the
// review asked for — new component files with an EXISTING database holding a
// legacy-encrypted LDAPS credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv } from 'node:crypto';

import {
  normalizeDataGuard, authDataProbeScript, parseAuthDataProbe,
  masterKeyFor, decryptUnderMaster, classifyRows, decideMasterSecretMint,
} from '../mock2/auth-data-logic.js';

const DEV = 'dev-insecure-master-secret-change-me';
const CUSTOM = 'c'.repeat(40);
const MINTED = 'm'.repeat(43);

function encrypt(plaintext, master) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKeyFor(master), nonce);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { ciphertext: Buffer.concat([enc, c.getAuthTag()]).toString('base64'), nonce: nonce.toString('base64') };
}

const GUARD = normalizeDataGuard({ table: 'auth_connections', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce', filter: "provider = 'ldaps'", legacy_default: DEV });

test('normalizeDataGuard: plain identifiers and a bounded, semicolon-free filter', () => {
  assert.deepEqual(GUARD, { table: 'auth_connections', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce', filter: "provider = 'ldaps'", legacy_default: DEV });
  assert.equal(normalizeDataGuard({ table: 'auth_connections; DROP TABLE x', secret_column: 'a', nonce_column: 'b' }), null);
  assert.equal(normalizeDataGuard({ table: 'a', secret_column: 'b', nonce_column: 'c', filter: "provider = 'x'; DELETE FROM a" }), null);
  assert.equal(normalizeDataGuard({ table: 'a', secret_column: 'b', nonce_column: 'c', filter: 'x = 1' }).filter, 'x = 1');
  assert.equal(normalizeDataGuard(null), null);
});

test('authDataProbeScript: runs as postgres against the app database, every outcome is a PROBE line', () => {
  const s = authDataProbeScript(GUARD);
  assert.match(s, /command -v psql/);
  assert.match(s, /su - postgres -c "psql -X -tA -F '\|' -d app -c/);
  assert.match(s, /SELECT secret_ciphertext, secret_nonce FROM auth_connections WHERE provider = 'ldaps' AND secret_ciphertext <> ''/);
  assert.match(s, /PROBE:ok/); assert.match(s, /PROBE:error/); assert.match(s, /PROBE:nopsql/);
});

test('parseAuthDataProbe: no table, no database, empty, rows, and the unknowns', () => {
  assert.equal(parseAuthDataProbe('ERR:ERROR:  relation "auth_connections" does not exist\nPROBE:error\n').state, 'no_table');
  assert.equal(parseAuthDataProbe('ERR:psql: error: connection to server failed: FATAL:  database "app" does not exist\nPROBE:error\n').state, 'no_database');
  assert.equal(parseAuthDataProbe('PROBE:ok\n').state, 'empty');
  const two = parseAuthDataProbe('ROW:AAAA|BBBB\nROW:CCCC|DDDD\nPROBE:ok\n');
  assert.equal(two.state, 'rows');
  assert.deepEqual(two.rows, [{ ciphertext: 'AAAA', nonce: 'BBBB' }, { ciphertext: 'CCCC', nonce: 'DDDD' }]);
  assert.equal(parseAuthDataProbe('PROBE:nopsql\n').state, 'unknown');
  assert.equal(parseAuthDataProbe('ERR:psql: error: connection refused\nPROBE:error\n').state, 'unknown');
  assert.equal(parseAuthDataProbe('').state, 'unknown');
});

test('decryptUnderMaster matches the component scheme; classifyRows tells current, legacy and unknown apart', () => {
  const secret = JSON.stringify({ host: 'ldap.example', port: 636, bindPassword: 'hunter2' });
  const underDev = encrypt(secret, DEV);
  const underCustom = encrypt(secret, CUSTOM);
  const underMinted = encrypt(secret, MINTED);
  assert.equal(decryptUnderMaster(underDev.ciphertext, underDev.nonce, DEV), secret);
  assert.throws(() => decryptUnderMaster(underDev.ciphertext, underDev.nonce, CUSTOM));
  assert.deepEqual(classifyRows([underDev, underCustom, underMinted], { current: MINTED, legacy: [DEV] }), { total: 3, current: 1, legacy: 1, unknown: 1 });
  assert.deepEqual(classifyRows([underDev], { current: null, legacy: [DEV] }), { total: 1, current: 0, legacy: 1, unknown: 0 });
  assert.deepEqual(classifyRows([], { legacy: [DEV] }), { total: 0, current: 0, legacy: 0, unknown: 0 });
});

test('decision: fresh storage → empty bridge and a new key are safe', () => {
  for (const state of ['no_table', 'no_database', 'empty']) {
    const d = decideMasterSecretMint({ probe: { state, detail: 'x' }, envHasKey: false });
    assert.equal(d.fresh, true); assert.equal(d.mint, 'ok');
  }
});

test('decision: NEW component files + EXISTING database with a legacy-encrypted credential → not fresh, mint through the bridge', () => {
  // The review\'s case: "nothing kept" yet data exists. The empty legacy list
  // must NOT be written (fresh=false) and the mint may proceed only because
  // every row is under the development default the bridge knows.
  const row = encrypt('{"host":"ldap"}', DEV);
  const probe = parseAuthDataProbe(`ROW:${row.ciphertext}|${row.nonce}\nPROBE:ok\n`);
  const d = decideMasterSecretMint({ probe, envHasKey: false, classification: classifyRows(probe.rows, { legacy: [DEV] }) });
  assert.equal(d.fresh, false);
  assert.equal(d.mint, 'ok');
  assert.match(d.reason, /development default/);
});

test('decision: existing database under a custom or unknown key → defer and say why', () => {
  const row = encrypt('{"host":"ldap"}', CUSTOM);
  const probe = parseAuthDataProbe(`ROW:${row.ciphertext}|${row.nonce}\nPROBE:ok\n`);
  const d = decideMasterSecretMint({ probe, envHasKey: false, classification: classifyRows(probe.rows, { legacy: [DEV] }) });
  assert.equal(d.fresh, false);
  assert.equal(d.mint, 'defer');
  assert.match(d.reason, /neither in the environment nor the development default/);
  // Mixed: one legacy, one unknown → still defer (a partial rekey strands the rest).
  const dev = encrypt('{"host":"ldap"}', DEV);
  const mixed = parseAuthDataProbe(`ROW:${row.ciphertext}|${row.nonce}\nROW:${dev.ciphertext}|${dev.nonce}\nPROBE:ok\n`);
  assert.equal(decideMasterSecretMint({ probe: mixed, envHasKey: false, classification: classifyRows(mixed.rows, { legacy: [DEV] }) }).mint, 'defer');
});

test('decision: a key already in the environment is never overwritten; an unreadable probe defers', () => {
  const row = encrypt('{"host":"ldap"}', MINTED);
  const probe = parseAuthDataProbe(`ROW:${row.ciphertext}|${row.nonce}\nPROBE:ok\n`);
  const d = decideMasterSecretMint({ probe, envHasKey: true, classification: classifyRows(probe.rows, { current: MINTED, legacy: [DEV] }) });
  assert.equal(d.mint, 'existing'); assert.equal(d.fresh, false);
  const u = decideMasterSecretMint({ probe: { state: 'unknown', detail: 'psql is not available in the container' }, envHasKey: false });
  assert.equal(u.mint, 'defer'); assert.equal(u.fresh, false); assert.match(u.reason, /could not be read/);
});
