// The data half of "is it safe to change this app's master secret?" — pure.
//
// "No component files were kept" is not "no data": an app can have brand-new
// component files and an EXISTING PostgreSQL holding an LDAPS credential
// encrypted under some earlier key (files rebuilt, storage restored or
// attached). Before the platform disables the legacy bridge or mints a new
// master secret it reads the stored credentials from the app's own database
// and classifies them:
//
//   no table / no database / no rows → fresh storage: empty legacy list and a
//                                       new secret are safe
//   rows, all under the development default → existing data the component's
//                                       bridge migrates: mint, keep the bridge
//   rows under a key that is neither in the environment nor the development
//     default, or a probe that could not run → UNCERTAIN: defer and say why
//
// The cipher scheme is the auth component's own (crypto.ts): AES-256-GCM,
// key = sha256("enc:" + master secret), tag appended to the ciphertext.
import { createHash, createDecipheriv } from 'node:crypto';

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const FILTER_RE = /^[A-Za-z0-9_ =<>!'().,]*$/;

// normalizeDataGuard(g) → { table, schema, secret_column, nonce_column,
// filter, legacy_default } or null. Identifiers are plain SQL identifiers; the filter
// is a bounded, semicolon-free expression (it is interpolated into a psql -c).
export function normalizeDataGuard(g) {
  if (!g || typeof g !== 'object') return null;
  const table = String(g.table || '').trim();
  const secretColumn = String(g.secret_column || '').trim();
  const nonceColumn = String(g.nonce_column || '').trim();
  const filter = String(g.filter || '').trim().slice(0, 200);
  const legacyDefault = typeof g.legacy_default === 'string' ? g.legacy_default.slice(0, 200) : '';
  const schema = String(g.schema || 'public').trim();
  if (![table, secretColumn, nonceColumn, schema].every((s) => IDENT_RE.test(s))) return null;
  if (filter && (!FILTER_RE.test(filter) || filter.includes(';'))) return null;
  return { table, schema, secret_column: secretColumn, nonce_column: nonceColumn, filter, legacy_default: legacyDefault };
}

// authDataProbeScript(guard) → the shell that lists the stored secrets. It
// connects EXACTLY as the app does: DATABASE_URL from the container
// environment (the same file the unit reads), falling back to the scaffold
// default, split into user, password, host (or a socket directory), port and
// database — every part the app uses, so a second local PostgreSQL on another
// port or socket can never be probed by mistake. The password reaches psql
// through PGPASSWORD in that one command's environment, never argv, and
// neither the URL nor the password is ever printed; the target line names
// host, port and database only. A non-local TCP host is reported as remote
// and treated as unknown. psql runs with -X and ON_ERROR_STOP and its exit
// status decides: empty output is an empty query ONLY when psql exited 0.
// The table is schema-qualified (guard.schema, 'public' by default), so a
// changed search_path cannot redirect the query. Every outcome is a PROBE:
// line, so silence is never mistaken for success.
export function authDataProbeScript(guard) {
  const schema = guard.schema || 'public';
  const where = [guard.filter, `${guard.secret_column} <> ''`].filter(Boolean).join(' AND ');
  const sql = `SELECT ${guard.secret_column}, ${guard.nonce_column} FROM ${schema}.${guard.table} WHERE ${where}`;
  return [
    'command -v psql >/dev/null 2>&1 || { echo "PROBE:nopsql"; exit 0; }',
    `URL=$( (set -a; . /etc/environment 2>/dev/null; set +a; printf '%s' "\${DATABASE_URL:-postgres://app:app@127.0.0.1:5432/app}") )`,
    // user:pass@host:port/db?query → parts, by parameter expansion (no echo of the URL).
    'REST=${URL#*://}',
    'case "$REST" in *@*) AUTH=${REST%%@*}; HP=${REST#*@};; *) AUTH=""; HP=$REST;; esac',
    'case "$HP" in */*) DBQ=${HP#*/}; HP=${HP%%/*};; *) DBQ="";; esac',
    'case "$DBQ" in *\\?*) DB=${DBQ%%\\?*}; QUERY=${DBQ#*\\?};; *) DB=$DBQ; QUERY="";; esac',
    'case "$AUTH" in *:*) PGUSER_=${AUTH%%:*}; PGPASS_=${AUTH#*:};; *) PGUSER_=$AUTH; PGPASS_="";; esac',
    'case "$HP" in *:*) PGHOST_=${HP%:*}; PGPORT_=${HP##*:};; *) PGHOST_=$HP; PGPORT_=5432;; esac',
    // libpq-style ?host=/run/postgresql overrides the host (a socket directory).
    'case "$QUERY" in *host=*) H=${QUERY#*host=}; PGHOST_=${H%%&*};; esac',
    // percent-decode the password and user (a URL-encoded @ or : is common).
    // Percent-decoding in plain sh (dash's printf has no \xHH, so go through octal).
    'dec() { s=$1; o=; while [ -n "$s" ]; do case "$s" in %[0-9A-Fa-f][0-9A-Fa-f]*) x=${s#%}; x=${x%"${x#??}"}; o="$o$(printf "\\\\$(printf \'%03o\' $((0x$x)))")"; s=${s#???};; *) o="$o${s%"${s#?}"}"; s=${s#?};; esac; done; printf \'%s\' "$o"; }',
    'PGUSER_=$(dec "$PGUSER_"); PGPASS_=$(dec "$PGPASS_")',
    'case "$PGHOST_" in ""|127.0.0.1|localhost|::1|/*) ;; *) echo "PROBE:remote"; exit 0;; esac',
    '[ -n "$DB" ] || { echo "ERR:no database name in DATABASE_URL"; echo "PROBE:error"; exit 0; }',
    '[ -n "$PGUSER_" ] || { echo "ERR:no user in DATABASE_URL"; echo "PROBE:error"; exit 0; }',
    'echo "TARGET:${PGHOST_:-127.0.0.1}:${PGPORT_}/${DB} schema=' + schema + '"',
    'echo "DB:$DB"',
    `out=$(PGPASSWORD="$PGPASS_" psql -X -v ON_ERROR_STOP=1 -tA -F '|' --pset footer=off -h "\${PGHOST_:-127.0.0.1}" -p "$PGPORT_" -U "$PGUSER_" -d "$DB" -c "${sql}" 2>&1); ec=$?`,
    `if [ "$ec" -eq 0 ]; then printf '%s\\n' "$out" | sed -e '/^$/d' -e 's/^/ROW:/'; echo "PROBE:ok"; else printf '%s\\n' "$out" | head -3 | sed 's/^/ERR:/'; echo "PROBE:error"; fi`,
    '',
  ].join('\n');
}

// parseAuthDataProbe(stdout) → { state, rows, detail, database }.
//   state: 'no_table' | 'no_database' | 'empty' | 'rows' | 'unknown'
// rows carry ciphertext only — never a plaintext, never a key — and the
// details are counts and psql's error wording, safe for the project chat.
export function parseAuthDataProbe(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trimEnd());
  const rows = [];
  const errs = [];
  let probe = null;
  let database = null;
  let target = null;
  for (const l of lines) {
    if (l.startsWith('ROW:')) {
      const body = l.slice(4);
      const i = body.indexOf('|');
      if (i > 0) rows.push({ ciphertext: body.slice(0, i), nonce: body.slice(i + 1) });
    } else if (l.startsWith('ERR:')) errs.push(l.slice(4).trim());
    else if (l.startsWith('DB:')) database = l.slice(3).trim();
    else if (l.startsWith('TARGET:')) target = l.slice(7).trim();
    else if (l.startsWith('PROBE:')) probe = l.slice(6).trim();
  }
  const dbName = target || database || 'app';
  if (probe === 'remote') return { state: 'unknown', rows: [], database, target, detail: 'DATABASE_URL points at a non-local host, which the in-container probe cannot vouch for' };
  if (probe === 'ok') {
    return rows.length
      ? { state: 'rows', rows, database, target, detail: `${rows.length} stored credential(s) in database ${dbName}` }
      : { state: 'empty', rows: [], database, target, detail: `no stored credentials in database ${dbName}` };
  }
  if (probe === 'error') {
    const text = errs.join(' ');
    if (/relation .* does not exist/i.test(text)) return { state: 'no_table', rows: [], database, target, detail: `the credentials table does not exist in database ${dbName}` };
    if (/database .* does not exist/i.test(text)) return { state: 'no_database', rows: [], database, target, detail: `database ${dbName} does not exist` };
    return { state: 'unknown', rows: [], database, target, detail: text || 'psql failed without output' };
  }
  if (probe === 'nopsql') return { state: 'unknown', rows: [], database, target, detail: 'psql is not available in the container' };
  return { state: 'unknown', rows: [], database, target, detail: 'the probe produced no result' };
}

export function masterKeyFor(master) {
  return createHash('sha256').update(`enc:${master}`).digest();
}

// decryptUnderMaster(ciphertext, nonce, master) → plaintext; throws when the
// key does not open it. Identical to the component's decryptSecret.
export function decryptUnderMaster(ciphertext, nonce, master) {
  const raw = Buffer.from(ciphertext, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(0, raw.length - 16);
  const d = createDecipheriv('aes-256-gcm', masterKeyFor(master), Buffer.from(nonce, 'base64'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// classifyRows(rows, { current, legacy }) → counts of rows the CURRENT key
// opens, rows a LEGACY key opens, and rows nothing opens.
export function classifyRows(rows, { current = null, legacy = [] } = {}) {
  const out = { total: 0, current: 0, legacy: 0, unknown: 0 };
  for (const r of rows || []) {
    if (!r || !r.ciphertext) continue;
    out.total += 1;
    const opens = (key) => { try { decryptUnderMaster(r.ciphertext, r.nonce, key); return true; } catch { return false; } };
    if (current && opens(current)) { out.current += 1; continue; }
    if ((legacy || []).some((k) => k && opens(k))) { out.legacy += 1; continue; }
    out.unknown += 1;
  }
  return out;
}

// decideMasterSecretMint({ probe, envHasKey, classification, newlyProvisioned,
// writersStopped }) → { fresh, mint: 'ok' | 'existing' | 'defer', reason }
//
//   fresh: storage POSITIVELY identified as newly provisioned — the platform
//          created this container in this run from the template with no
//          restored, copied or rehydrated data (newlyProvisioned), AND the
//          probe found nothing. Only then is the legacy bridge disabled.
//   mint:  ok — mint a new key now; existing — a key is already set (never
//          overwritten); defer — leave the key alone, reason says why
//
// On an EXISTING app: a missing table or database is not "fresh", it is
// something to investigate (a wrong database name, a schema that has not
// migrated, an incomplete restore); an empty table is fine but only while
// the app is stopped (writersStopped — the deploy stops it before the final
// probe, so a credential saved under the old key between probe and restart
// cannot exist); rows all under the development default migrate through the
// bridge, again only with writers stopped; anything else defers.
export function decideMasterSecretMint({ probe, envHasKey = false, classification = null, newlyProvisioned = false, writersStopped = false } = {}) {
  const state = probe?.state || 'unknown';
  const detail = probe?.detail || 'no detail';
  if (state === 'unknown') {
    return { fresh: false, mint: 'defer', reason: `the app's stored credentials could not be read (${detail}), so the key and the legacy configuration are left as they are` };
  }
  if (envHasKey) {
    return { fresh: false, mint: 'existing', reason: 'a master secret is already set in the environment; it is never overwritten' };
  }
  const nothingStored = state === 'no_table' || state === 'no_database' || state === 'empty';
  if (newlyProvisioned) {
    if (nothingStored) return { fresh: true, mint: 'ok', reason: `newly provisioned storage: ${detail}` };
    return { fresh: false, mint: 'defer', reason: `this project was reported as newly provisioned, yet ${detail} — the data is not new, so nothing is changed until that is understood` };
  }
  if (state === 'no_table' || state === 'no_database') {
    return { fresh: false, mint: 'defer', reason: `${detail} on an existing app — the schema the key protects is missing, so the key and the legacy configuration are left as they are until that is investigated` };
  }
  if (!writersStopped) {
    return { fresh: false, mint: 'defer', reason: 'the app may still be writing; the key is minted by the deploy after it stops the app, never while it runs' };
  }
  if (state === 'empty') {
    return { fresh: false, mint: 'ok', reason: `${detail}, read while the app is stopped` };
  }
  const c = classification || { total: 0, current: 0, legacy: 0, unknown: 0 };
  if (c.total > 0 && c.unknown === 0 && c.current === 0) {
    return { fresh: false, mint: 'ok', reason: `${c.legacy} stored credential(s) are under the development default; the component's legacy bridge re-encrypts them under the new key on first use` };
  }
  return { fresh: false, mint: 'defer', reason: `${c.unknown} of ${c.total} stored credential(s) are encrypted under a key that is neither in the environment nor the development default — set AUTH_MASTER_SECRET to that key first (set_project_env), then redeploy` };
}
