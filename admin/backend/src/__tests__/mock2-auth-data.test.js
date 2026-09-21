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
  // Every connection part the app uses is parsed and passed; the password rides a private password file, never argv or the environment.
  assert.match(s, /q\(\) \{ PGPASSFILE="\$PF" psql -X -w -v ON_ERROR_STOP=1 -tA -F '\|' --pset footer=off -h "\$\{PGHOST_:-127\.0\.0\.1\}" -p "\$PGPORT_" -U "\$PGUSER_" -d "\$DB" -c "\$1" 2>&1; \}/);
  assert.match(s, /out=\$\(q "SELECT secret_ciphertext, secret_nonce FROM public\.auth_connections WHERE provider = 'ldaps' AND secret_ciphertext <> ''"\); ec=\$\?/);
  assert.doesNotMatch(s, /PGPASSWORD/, 'the password is not put in the environment');
  assert.match(s, /umask 077; PF=\$\(mktemp 2>\/dev\/null\) \|\| \{ echo "ERR:could not create a private password file"; echo "PROBE:error"; exit 0; \}/);
  assert.match(s, /trap 'rm -f "\$PF"' EXIT/, 'the password file is removed however the probe ends');
  assert.match(s, /printf '\*:\*:\*:%s:%s\\n' "\$\(esc "\$PGUSER_"\)" "\$\(esc "\$PGPASS_"\)" > "\$PF"/);
  // Row-level security is read before the rows, and stops the probe when policies apply to the app's role.
  assert.match(s, /rls=\$\(q "SELECT CASE WHEN NOT c\.relrowsecurity THEN 'off' WHEN r\.rolsuper OR r\.rolbypassrls THEN 'bypass' WHEN c\.relowner = r\.oid AND NOT c\.relforcerowsecurity THEN 'owner' ELSE 'on' END FROM pg_class c, pg_roles r WHERE c\.oid = 'public\.auth_connections'::regclass AND r\.rolname = current_user"\); ec=\$\?/);
  assert.match(s, /echo "RLS:\$rls"\ncase "\$rls" in on\) echo "PROBE:rls"; exit 0;; esac\nout=\$\(q /);
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
    // Parse the flags the way psql would, whatever their order; answer the
    // row-security query from STUB_RLS and report, for the rows query, what
    // the connection would have been — including the password file's first
    // line, its mode, its path, and whether PGPASSWORD leaked into the env.
    writeFileSync(join(dir, 'psql'), [
      '#!/bin/sh',
      'while [ $# -gt 0 ]; do case "$1" in -h) h=$2; shift;; -p) p=$2; shift;; -U) U=$2; shift;; -d) d=$2; shift;; -c) c=$2; shift;; -w) w=1;; esac; shift; done',
      'case "$c" in *relrowsecurity*) echo "${STUB_RLS:-off}"; exit 0;; esac',
      // printf, not echo: dash's echo rewrites backslash escapes, which is exactly what the file must carry verbatim.
      `printf '%s\\n' "CONNECT h=$h p=$p U=$U d=$d w=\${w:-0} pf=$(sed -n 1p "$PGPASSFILE") mode=$(stat -c %a "$PGPASSFILE") env=\${PGPASSWORD:-unset} file=$PGPASSFILE"`,
      '',
    ].join('\n'));
    chmodSync(join(dir, 'psql'), 0o755);
    const run = (url, extraEnv = {}) => {
      // The script sources /etc/environment; point it at a scratch file instead.
      const env = join(dir, 'environment'); writeFileSync(env, url ? `DATABASE_URL="${url}"\n` : '');
      const script = authDataProbeScript(GUARD).replace('. /etc/environment', `. ${env}`);
      const r = spawnSync('sh', ['-c', script], { env: { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: dir, ...extraEnv }, encoding: 'utf8' });
      return r.stdout;
    };
    const { existsSync } = await import('node:fs');
    // Default URL when none is set.
    const dflt = run('');
    assert.match(dflt, /TARGET:127\.0\.0\.1:5432\/app schema=public/);
    assert.match(dflt, /RLS:off\n/);
    assert.match(dflt, /CONNECT h=127\.0\.0\.1 p=5432 U=app d=app w=1 pf=\*:\*:\*:app:app mode=600 env=unset file=/);
    assert.match(dflt, /PROBE:ok/);
    const pf = /file=(\S+)/.exec(dflt)[1];
    assert.equal(existsSync(pf), false, 'the password file is gone once the probe exits');
    // Another port and a percent-encoded password reach psql exactly, through the file.
    const out = run('postgres://svc:p%40ss@localhost:5433/appdb?sslmode=disable');
    assert.match(out, /TARGET:localhost:5433\/appdb schema=public/);
    assert.match(out, /CONNECT h=localhost p=5433 U=svc d=appdb w=1 pf=\*:\*:\*:svc:p@ss mode=600 env=unset/);
    assert.doesNotMatch(out, /p%40ss/);
    // A colon or backslash in the password is escaped the way libpq reads the file.
    assert.match(run('postgres://svc:a%3Ab%5Cc@localhost:5432/app'), /pf=\*:\*:\*:svc:a\\:b\\\\c mode=600/);
    // A socket directory via ?host= is honoured; a remote host is refused before any connection.
    assert.match(run('postgres://app:app@/app?host=/run/postgresql'), /CONNECT h=\/run\/postgresql p=5432 U=app d=app/);
    const remote = run('postgres://app:app@db.example.net:5432/app');
    assert.match(remote, /PROBE:remote/); assert.doesNotMatch(remote, /CONNECT/);
    // Row-level security that applies to the app's role stops the probe before the rows are read.
    const rls = run('', { STUB_RLS: 'on' });
    assert.match(rls, /RLS:on\nPROBE:rls\n/); assert.doesNotMatch(rls, /CONNECT/);
    for (const v of ['bypass', 'owner']) assert.match(run('', { STUB_RLS: v }), new RegExp(`RLS:${v}\\n[^\\n]*CONNECT `), `${v} still reads the rows`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the row-security expression, executed: FORCE ROW LEVEL SECURITY subjects the owner unless the role independently bypasses', async (t) => {
  // The CASE the probe sends to PostgreSQL is evaluated here, as SQL, over
  // every combination of the five flags it reads — the same CASE/NOT/AND/OR
  // semantics — so the owner-under-FORCE case is proven, not pattern-matched.
  let DatabaseSync = null;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older Node */ }
  if (!DatabaseSync) { t.skip('node:sqlite not available'); return; }
  const m = /rls=\$\(q "SELECT (CASE .*? END) FROM pg_class c, pg_roles r WHERE/.exec(authDataProbeScript(GUARD));
  assert.ok(m, 'the probe reads the row-security standing before the rows');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE c (relrowsecurity INTEGER, relforcerowsecurity INTEGER, relowner INTEGER); CREATE TABLE r (oid INTEGER, rolsuper INTEGER, rolbypassrls INTEGER)');
  const q = db.prepare(`SELECT ${m[1]} AS v FROM c, r`);
  const seen = new Set();
  for (let bits = 0; bits < 32; bits++) {
    const rls = bits & 1, force = (bits >> 1) & 1, owner = (bits >> 2) & 1, sup = (bits >> 3) & 1, bypass = (bits >> 4) & 1;
    db.exec('DELETE FROM c; DELETE FROM r');
    db.prepare('INSERT INTO c VALUES (?, ?, ?)').run(rls, force, owner ? 10 : 20);
    db.prepare('INSERT INTO r VALUES (10, ?, ?)').run(sup, bypass);
    const expected = !rls ? 'off' : (sup || bypass) ? 'bypass' : (owner && !force) ? 'owner' : 'on';
    const got = q.get().v;
    assert.equal(got, expected, `rls=${rls} force=${force} owner=${owner} super=${sup} bypassrls=${bypass}`);
    seen.add(got);
  }
  assert.deepEqual([...seen].sort(), ['bypass', 'off', 'on', 'owner']);
  // The review's case, spelled out: owner of a FORCEd table with no bypass → on (the probe defers); with BYPASSRLS → bypass.
  db.exec('DELETE FROM c; DELETE FROM r; INSERT INTO c VALUES (1, 1, 10); INSERT INTO r VALUES (10, 0, 0)');
  assert.equal(q.get().v, 'on');
  db.exec('UPDATE r SET rolbypassrls = 1');
  assert.equal(q.get().v, 'bypass');
  db.exec('UPDATE r SET rolbypassrls = 0; UPDATE c SET relforcerowsecurity = 0');
  assert.equal(q.get().v, 'owner');
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
  // Row-level security in force for the app's role is its own state; the finding rides along otherwise.
  const rls = parseAuthDataProbe('TARGET:127.0.0.1:5432/app schema=public\nDB:app\nRLS:on\nPROBE:rls\n');
  assert.equal(rls.state, 'rls'); assert.equal(rls.rls, 'on'); assert.match(rls.detail, /row-level security is enabled .* for the app's own role/);
  assert.equal(parseAuthDataProbe('DB:app\nRLS:owner\nPROBE:ok\n').rls, 'owner');
  assert.equal(parseAuthDataProbe('DB:app\nRLS:owner\nPROBE:ok\n').state, 'empty');
  assert.equal(parseAuthDataProbe('DB:app\nERR:ERROR:  relation "public.auth_connections" does not exist\nPROBE:error\n').state, 'no_table', 'the row-security query fails the same way on a missing table');
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

test('decideMasterSecretMint: row-level security in force defers, with the remedy named and no secret changed', () => {
  const probe = parseAuthDataProbe('DB:app\nRLS:on\nPROBE:rls\n');
  for (const newlyProvisioned of [false, true]) {
    const d = decideMasterSecretMint({ probe, newlyProvisioned, writersStopped: true, classification: classify(probe) });
    assert.equal(d.mint, 'defer'); assert.equal(d.fresh, false);
    assert.match(d.reason, /row-level security/); assert.match(d.reason, /BYPASSRLS/);
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
