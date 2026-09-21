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

test('normalizeDataGuard: plain identifiers, a schema (public by default) and a bounded, semicolon-free filter', () => {
  assert.deepEqual(GUARD, { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce', filter: "provider = 'ldaps'", legacy_default: DEV });
  assert.equal(normalizeDataGuard({ table: 'a', secret_column: 'b', nonce_column: 'c', schema: 'auth' }).schema, 'auth');
  assert.equal(normalizeDataGuard({ table: 'a', secret_column: 'b', nonce_column: 'c', schema: 'bad schema' }), null);
  assert.equal(normalizeDataGuard({ table: 'auth_connections; DROP TABLE x', secret_column: 'a', nonce_column: 'b' }), null);
  assert.equal(normalizeDataGuard({ table: 'a', secret_column: 'b', nonce_column: 'c', filter: "provider = 'x'; DELETE FROM a" }), null);
  assert.equal(normalizeDataGuard({ table: 'a', secret_column: 'b', nonce_column: 'c', filter: 'x = 1' }).filter, 'x = 1');
  assert.equal(normalizeDataGuard(null), null);
});

test('authDataProbeScript: connects exactly as the app does (user, password via env, host or socket, port, database, schema), never prints the URL, refuses remote hosts, gates rows on exit 0', () => {
  const s = authDataProbeScript(GUARD);
  assert.match(s, /command -v psql/);
  assert.match(s, /\. \/etc\/environment/);
  assert.match(s, /DATABASE_URL:-postgres:\/\/app:app@127\.0\.0\.1:5432\/app/);
  // Every connection part the app uses is parsed and passed; the password rides the command's own environment, not argv.
  assert.match(s, /PGPASSWORD="\$PGPASS_" psql -X -v ON_ERROR_STOP=1 -tA -F '\|' --pset footer=off -h "\$\{PGHOST_:-127\.0\.0\.1\}" -p "\$PGPORT_" -U "\$PGUSER_" -d "\$DB" -c "SELECT secret_ciphertext, secret_nonce FROM public\.auth_connections WHERE provider = 'ldaps' AND secret_ciphertext <> ''"/);
  assert.match(s, /PGPORT_=5432;;/, 'default port when the URL has none');
  assert.match(s, /\*host=\*\) H=\$\{QUERY#\*host=\}; PGHOST_=\$\{H%%&\*\};;/, 'libpq-style socket-directory override honoured');
  assert.match(s, /case "\$PGHOST_" in ""\|127\.0\.0\.1\|localhost\|::1\|\/\*\) ;; \*\) echo "PROBE:remote"; exit 0;; esac/, 'loopback and socket paths only');
  assert.doesNotMatch(s, /su - postgres/, 'never the superuser over the default socket');
  assert.match(s, /echo "TARGET:\$\{PGHOST_:-127\.0\.0\.1\}:\$\{PGPORT_\}\/\$\{DB\} schema=public"/);
  assert.doesNotMatch(s, /echo "\$URL"|echo \$URL|printf '%s\\n' "\$URL"|echo "\$PGPASS_"|echo \$PGPASS_|TARGET:[^\n]*PGPASS|TARGET:[^\n]*PGUSER/, 'neither the URL, the password nor the user is printed');
  assert.match(s, /if \[ "\$ec" -eq 0 \]; then printf '%s\\n' "\$out" \| sed -e '\/\^\$\/d' -e 's\/\^\/ROW:\/'; echo "PROBE:ok"; else/);
  assert.match(s, /PROBE:error/); assert.match(s, /PROBE:nopsql/);
  // A custom schema is qualified too.
  assert.match(authDataProbeScript(normalizeDataGuard({ table: 't', secret_column: 'c', nonce_column: 'n', schema: 'auth' })), /FROM auth\.t WHERE/);
});

test('the probe shell parses a URL the way the app would (executed locally with a stub psql)', async () => {
  // Run the generated shell with a fake psql that prints what it was asked to
  // connect to, so the parsing itself — not just the text — is verified.
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'pp-probe-'));
  try {
    // Parse the flags the way psql would, whatever their order.
    writeFileSync(join(dir, 'psql'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -h) h=$2; shift;; -p) p=$2; shift;; -U) U=$2; shift;; -d) d=$2; shift;; esac; shift; done\necho "CONNECT h=$h p=$p U=$U d=$d pw=$PGPASSWORD"\n');
    chmodSync(join(dir, 'psql'), 0o755);
    const run = (url) => {
      // The script sources /etc/environment; point it at a scratch file instead.
      const env = join(dir, 'environment'); writeFileSync(env, url ? `DATABASE_URL="${url}"\n` : '');
      const script = authDataProbeScript(GUARD).replace('. /etc/environment', `. ${env}`);
      const r = spawnSync('sh', ['-c', script], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' });
      return r.stdout;
    };
    // Default URL when none is set.
    assert.match(run(''), /TARGET:127\.0\.0\.1:5432\/app schema=public/);
    assert.match(run(''), /CONNECT h=127\.0\.0\.1 p=5432 U=app d=app pw=app/);
    // Another port and a percent-encoded password reach psql exactly.
    const out = run('postgres://svc:p%40ss@localhost:5433/appdb?sslmode=disable');
    assert.match(out, /TARGET:localhost:5433\/appdb schema=public/);
    assert.match(out, /CONNECT h=localhost p=5433 U=svc d=appdb pw=p@ss/);
    assert.doesNotMatch(out, /p%40ss/);
    // A socket directory via ?host= is honoured; a remote host is refused before any connection.
    assert.match(run('postgres://app:app@/app?host=/run/postgresql'), /CONNECT h=\/run\/postgresql p=5432 U=app d=app/);
    const remote = run('postgres://app:app@db.example.net:5432/app');
    assert.match(remote, /PROBE:remote/); assert.doesNotMatch(remote, /CONNECT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseAuthDataProbe: no table, no database, empty, rows, remote, and the unknowns — with the database named', () => {
  assert.equal(parseAuthDataProbe('DB:app\nERR:ERROR:  relation "auth_connections" does not exist\nPROBE:error\n').state, 'no_table');
  assert.match(parseAuthDataProbe('DB:app\nERR:ERROR:  relation "auth_connections" does not exist\nPROBE:error\n').detail, /database app/);
  // The exact target (host:port/db schema) is carried into the detail when the probe printed it.
  const t = parseAuthDataProbe('TARGET:localhost:5433/appdb schema=public\nDB:appdb\nPROBE:ok\n');
  assert.equal(t.target, 'localhost:5433/appdb schema=public'); assert.match(t.detail, /localhost:5433\/appdb/);
  assert.equal(parseAuthDataProbe('DB:other\nERR:psql: error: connection to server failed: FATAL:  database "other" does not exist\nPROBE:error\n').state, 'no_database');
  const empty = parseAuthDataProbe('DB:app\nPROBE:ok\n');
  assert.equal(empty.state, 'empty'); assert.equal(empty.database, 'app');
  const two = parseAuthDataProbe('DB:app\nROW:AAAA|BBBB\nROW:CCCC|DDDD\nPROBE:ok\n');
  assert.equal(two.state, 'rows');
  assert.deepEqual(two.rows, [{ ciphertext: 'AAAA', nonce: 'BBBB' }, { ciphertext: 'CCCC', nonce: 'DDDD' }]);
  assert.equal(parseAuthDataProbe('PROBE:remote\n').state, 'unknown');
  assert.match(parseAuthDataProbe('PROBE:remote\n').detail, /non-local host/);
  assert.equal(parseAuthDataProbe('PROBE:nopsql\n').state, 'unknown');
  assert.equal(parseAuthDataProbe('DB:app\nERR:psql: error: connection refused\nPROBE:error\n').state, 'unknown');
  assert.equal(parseAuthDataProbe('DB:app\nERR:ERROR:  column "secret_nonce" does not exist\nPROBE:error\n').state, 'unknown', 'an unexpected schema is not "no table"');
  assert.equal(parseAuthDataProbe('').state, 'unknown');
  // Rows without a PROBE:ok line (a killed probe) are not an answer.
  assert.equal(parseAuthDataProbe('DB:app\nROW:AAAA|BBBB\n').state, 'unknown');
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

const probeOf = (rowsList) => parseAuthDataProbe(`DB:app\n${rowsList.map((r) => `ROW:${r.ciphertext}|${r.nonce}`).join('\n')}${rowsList.length ? '\n' : ''}PROBE:ok\n`);
const classify = (probe) => classifyRows(probe.rows, { legacy: [DEV] });

test('decision: only a POSITIVELY newly provisioned container with nothing stored is fresh', () => {
  for (const state of ['no_table', 'no_database', 'empty']) {
    const d = decideMasterSecretMint({ probe: { state, detail: 'x' }, newlyProvisioned: true });
    assert.equal(d.fresh, true); assert.equal(d.mint, 'ok');
  }
  // The same probe results on a container NOT identified as newly provisioned are never fresh.
  for (const state of ['no_table', 'no_database', 'empty']) {
    assert.equal(decideMasterSecretMint({ probe: { state, detail: 'x' } }).fresh, false);
  }
});

test('decision: data on a supposedly new container is a contradiction — defer, change nothing', () => {
  const probe = probeOf([encrypt('{"host":"ldap"}', DEV)]);
  const d = decideMasterSecretMint({ probe, newlyProvisioned: true, classification: classify(probe) });
  assert.equal(d.fresh, false); assert.equal(d.mint, 'defer'); assert.match(d.reason, /reported as newly provisioned, yet/);
});

test('decision: a missing table or database on an EXISTING app is investigated, not initialised', () => {
  for (const state of ['no_table', 'no_database']) {
    const d = decideMasterSecretMint({ probe: { state, detail: 'the credentials table does not exist in database app' }, writersStopped: true });
    assert.equal(d.fresh, false); assert.equal(d.mint, 'defer'); assert.match(d.reason, /schema the key protects is missing/);
  }
});

test('decision: an existing app with the correct database and no rows may initialise — only with writers stopped', () => {
  const probe = probeOf([]);
  assert.equal(decideMasterSecretMint({ probe }).mint, 'defer');
  assert.match(decideMasterSecretMint({ probe }).reason, /after it stops the app/);
  const d = decideMasterSecretMint({ probe, writersStopped: true });
  assert.equal(d.mint, 'ok'); assert.equal(d.fresh, false); assert.match(d.reason, /read while the app is stopped/);
});

test('decision: NEW component files + EXISTING database with a legacy-encrypted credential → not fresh, mint through the bridge (writers stopped)', () => {
  // The review\'s case: "nothing kept" yet data exists. The empty legacy list
  // must NOT be written (fresh=false) and the mint may proceed only because
  // every row is under the development default the bridge knows, and only
  // once the deploy has stopped the app.
  const probe = probeOf([encrypt('{"host":"ldap"}', DEV)]);
  assert.equal(decideMasterSecretMint({ probe, classification: classify(probe) }).mint, 'defer');
  const d = decideMasterSecretMint({ probe, writersStopped: true, classification: classify(probe) });
  assert.equal(d.fresh, false); assert.equal(d.mint, 'ok'); assert.match(d.reason, /development default/);
});

test('decision: existing database under a custom or unknown key → defer and say why', () => {
  const custom = encrypt('{"host":"ldap"}', CUSTOM);
  const probe = probeOf([custom]);
  const d = decideMasterSecretMint({ probe, writersStopped: true, classification: classify(probe) });
  assert.equal(d.fresh, false); assert.equal(d.mint, 'defer'); assert.match(d.reason, /neither in the environment nor the development default/);
  const mixed = probeOf([custom, encrypt('{"host":"ldap"}', DEV)]);
  assert.equal(decideMasterSecretMint({ probe: mixed, writersStopped: true, classification: classify(mixed) }).mint, 'defer');
});

test('decision: a key already in the environment is never overwritten; an unreadable, remote or wrong database defers and changes nothing', () => {
  const probe = probeOf([encrypt('{"host":"ldap"}', MINTED)]);
  const d = decideMasterSecretMint({ probe, envHasKey: true, writersStopped: true, classification: classifyRows(probe.rows, { current: MINTED, legacy: [DEV] }) });
  assert.equal(d.mint, 'existing'); assert.equal(d.fresh, false);
  for (const detail of ['psql is not available in the container', 'DATABASE_URL points at a non-local host, which the in-container probe cannot vouch for', 'ERROR:  column "secret_nonce" does not exist']) {
    const u = decideMasterSecretMint({ probe: { state: 'unknown', detail }, newlyProvisioned: true, writersStopped: true });
    assert.equal(u.mint, 'defer'); assert.equal(u.fresh, false); assert.match(u.reason, /could not be read/); assert.match(u.reason, /left as they are/);
  }
});

test('nothing sensitive leaves the classifier: reasons carry counts and wording, never ciphertext, plaintext or keys', () => {
  const row = encrypt('{"host":"ldap","bindPassword":"hunter2"}', CUSTOM);
  const probe = probeOf([row]);
  const d = decideMasterSecretMint({ probe, writersStopped: true, classification: classify(probe) });
  // Plain substring checks: base64 ciphertext can start with regex metacharacters.
  assert.doesNotMatch(d.reason, /hunter2/); assert.ok(!d.reason.includes(row.ciphertext.slice(0, 12))); assert.ok(!d.reason.includes(CUSTOM));
  assert.ok(!(probe.detail || '').includes(row.ciphertext.slice(0, 12)));
});
