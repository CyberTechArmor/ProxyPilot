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

// normalizeDataGuard(g) → { table, secret_column, nonce_column, filter,
// legacy_default } or null. Identifiers are plain SQL identifiers; the filter
// is a bounded, semicolon-free expression (it is interpolated into a psql -c).
export function normalizeDataGuard(g) {
  if (!g || typeof g !== 'object') return null;
  const table = String(g.table || '').trim();
  const secretColumn = String(g.secret_column || '').trim();
  const nonceColumn = String(g.nonce_column || '').trim();
  const filter = String(g.filter || '').trim().slice(0, 200);
  const legacyDefault = typeof g.legacy_default === 'string' ? g.legacy_default.slice(0, 200) : '';
  if (![table, secretColumn, nonceColumn].every((s) => IDENT_RE.test(s))) return null;
  if (filter && (!FILTER_RE.test(filter) || filter.includes(';'))) return null;
  return { table, secret_column: secretColumn, nonce_column: nonceColumn, filter, legacy_default: legacyDefault };
}

// authDataProbeScript(guard) → the shell that lists the stored secrets. Runs
// psql as the postgres user against the in-container database, the way
// run_project_sql and the restore path do. Every outcome is a PROBE: line.
export function authDataProbeScript(guard) {
  const where = [guard.filter, `${guard.secret_column} <> ''`].filter(Boolean).join(' AND ');
  const sql = `SELECT ${guard.secret_column}, ${guard.nonce_column} FROM ${guard.table} WHERE ${where}`;
  return [
    'command -v psql >/dev/null 2>&1 || { echo "PROBE:nopsql"; exit 0; }',
    `out=$(su - postgres -c "psql -X -tA -F '|' -d app -c \\"${sql}\\"" 2>&1); ec=$?`,
    'if [ "$ec" -eq 0 ]; then printf \'%s\\n\' "$out" | sed -e \'/^$/d\' -e \'s/^/ROW:/\'; echo "PROBE:ok"; else printf \'%s\\n\' "$out" | head -3 | sed \'s/^/ERR:/\'; echo "PROBE:error"; fi',
    '',
  ].join('\n');
}

// parseAuthDataProbe(stdout) → { state, rows, detail }.
//   state: 'no_table' | 'no_database' | 'empty' | 'rows' | 'unknown'
export function parseAuthDataProbe(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trimEnd());
  const rows = [];
  const errs = [];
  let probe = null;
  for (const l of lines) {
    if (l.startsWith('ROW:')) {
      const body = l.slice(4);
      const i = body.indexOf('|');
      if (i > 0) rows.push({ ciphertext: body.slice(0, i), nonce: body.slice(i + 1) });
    } else if (l.startsWith('ERR:')) errs.push(l.slice(4).trim());
    else if (l.startsWith('PROBE:')) probe = l.slice(6).trim();
  }
  if (probe === 'ok') return rows.length ? { state: 'rows', rows, detail: `${rows.length} stored credential(s)` } : { state: 'empty', rows: [], detail: 'no stored credentials' };
  if (probe === 'error') {
    const text = errs.join(' ');
    if (/relation .* does not exist/i.test(text)) return { state: 'no_table', rows: [], detail: 'the credentials table does not exist yet' };
    if (/database .* does not exist/i.test(text)) return { state: 'no_database', rows: [], detail: 'the application database does not exist yet' };
    return { state: 'unknown', rows: [], detail: text || 'psql failed without output' };
  }
  if (probe === 'nopsql') return { state: 'unknown', rows: [], detail: 'psql is not available in the container' };
  return { state: 'unknown', rows: [], detail: 'the probe produced no result' };
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

// decideMasterSecretMint({ probe, envHasKey, classification }) →
//   { fresh, mint: 'ok' | 'existing' | 'defer', reason }
//   fresh: storage confirmed new (safe to disable the legacy bridge)
//   mint:  ok — mint a new key now; existing — a key is already set (never
//          overwritten); defer — do not change the key, reason says why
export function decideMasterSecretMint({ probe, envHasKey = false, classification = null } = {}) {
  const state = probe?.state || 'unknown';
  if (state === 'unknown') {
    return { fresh: false, mint: 'defer', reason: `the app's stored credentials could not be read (${probe?.detail || 'no detail'}), so the key is left as it is` };
  }
  if (state === 'no_table' || state === 'no_database' || state === 'empty') {
    return { fresh: true, mint: 'ok', reason: `fresh storage: ${probe.detail}` };
  }
  if (envHasKey) {
    return { fresh: false, mint: 'existing', reason: 'a master secret is already set in the environment; it is never overwritten' };
  }
  const c = classification || { total: 0, current: 0, legacy: 0, unknown: 0 };
  if (c.total > 0 && c.unknown === 0 && c.current === 0) {
    return { fresh: false, mint: 'ok', reason: `${c.legacy} stored credential(s) are under the development default; the component's legacy bridge re-encrypts them under the new key on first use` };
  }
  return { fresh: false, mint: 'defer', reason: `${c.unknown} of ${c.total} stored credential(s) are encrypted under a key that is neither in the environment nor the development default — set AUTH_MASTER_SECRET to that key first (set_project_env), then redeploy` };
}
