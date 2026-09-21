// Setup engine — the pure logic of the two restores and the retry-path mint
// (milestone A-13, A-14, A-15). Nothing here touches a guest or a database:
// scripts are BUILT here and their output PARSED here; the operations in
// restore-db-op.js / restore-snapshot-op.js run them.
//
// Database restore, the guarantees this module carries:
//   * only the plain-SQL pg_dump format our own tools write is supported
//     (dump_project_db, the deploy's protected copy, the restore's own
//     pre-restore copy); a custom-format archive or anything else is refused
//     by name (dumpHeaderVerdict);
//   * a dump and an environment copy form a RECOVERY SET only when a job
//     record of THIS app recorded them together (bindRecoverySet): a file
//     name alone binds nothing;
//   * compatibility of the dump with the keys it will be read under is
//     ESTABLISHED before anything is stopped, by decrypting the dump's own
//     protected rows in memory under the key that will be in force after
//     the restore (the environment copy's, or the current configuration's)
//     — or it is not, and the restore refuses; there is no "assume".
//
// Snapshot restore: an Incus instance snapshot covers the root disk; a
// custom storage volume attached as a disk device is outside it
// (snapshotCoverage). The restore refuses such a guest unless the caller
// accepts a partial restore by name, and then says what was not restored.

import { classifyRows } from '../../mock2/auth-data-logic.js';

export const DB_DUMPS_DIR = '/var/backups/proxypilot-db';
export const DUMP_NAME_RE = /^app-[A-Za-z0-9._-]{1,80}\.sql$/;
export const ENV_COPY_NAME_RE = /^environment\.pre-[A-Za-z0-9-]{1,80}$/;
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64').toString('utf8');

// recoverySetOf(dumpName) → what kind of copy the name says it is. The
// name is a HINT for the operator's reading; the binding is bindRecoverySet.
export function recoverySetOf(dumpName) {
  const n = String(dumpName || '');
  let m = n.match(/^app-pre-deploy-([A-Za-z0-9-]+)\.sql$/);
  if (m) return { kind: 'pre_deploy', jobId: m[1] };
  m = n.match(/^app-pre-restore-([A-Za-z0-9-]+)\.sql$/);
  if (m) return { kind: 'pre_restore', jobId: m[1] };
  return { kind: 'manual', jobId: null };
}

// protectedCopiesOf(jobRow) → { dumpPath, dumpSha256, dumpBytes, envCopyPath }
// from the job record that took them (a deploy's checkpoint.recovery.protected,
// or a restore's progress.result.protected). Null when the job recorded none.
export function protectedCopiesOf(job) {
  if (!job) return null;
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const cp = parse(job.checkpoint_json) || {};
  const prog = parse(job.progress_json) || {};
  const p = cp.recovery?.protected || prog.result?.protected || prog.protected || null;
  if (!p) return null;
  return {
    dumpPath: p.dbDump?.path || null,
    dumpSha256: p.dbDump?.sha256 || null,
    dumpBytes: p.dbDump?.bytes ?? null,
    envCopyPath: p.envCopy || null,
  };
}

// bindRecoverySet({ app, dumpName, envCopyName, originJob }) → the binding
// verdict. With an environment copy, the pair must be what one job of THIS
// app recorded together; without one, the dump alone is bound to the app by
// the directory it lives in (the guest's own), and compatibility with the
// current configuration must be established separately.
export function bindRecoverySet({ app, dumpName, envCopyName = null, originJob = null }) {
  if (!DUMP_NAME_RE.test(String(dumpName || ''))) return { ok: false, reason: `dump name must match ${DUMP_NAME_RE} (a dump made by dump_project_db, a deploy's pre-deploy copy, or a restore's pre-restore copy)` };
  if (envCopyName == null || envCopyName === '') return { ok: true, mode: 'current_configuration', origin: null, expectedSha256: null, reason: 'no environment copy: the dump must decrypt under the CURRENT configuration' };
  if (!ENV_COPY_NAME_RE.test(String(envCopyName))) return { ok: false, reason: `environment copy name must match ${ENV_COPY_NAME_RE}` };
  if (!originJob) return { ok: false, reason: `no job of ${app} recorded ${dumpName} together with ${envCopyName}: they are not a recovery set of this app (a file name alone binds nothing)` };
  if (String(originJob.app) !== String(app)) return { ok: false, reason: `job ${originJob.id} belongs to ${originJob.app}, not ${app}` };
  const rec = protectedCopiesOf(originJob);
  const base = (p) => String(p || '').split('/').pop();
  if (!rec || base(rec.dumpPath) !== dumpName || base(rec.envCopyPath) !== envCopyName) {
    return { ok: false, reason: `job ${originJob.id} of ${app} did not record ${dumpName} and ${envCopyName} as one recovery set (it recorded ${rec ? `${base(rec.dumpPath) || 'no dump'} + ${base(rec.envCopyPath) || 'no environment copy'}` : 'no protected copies'})` };
  }
  return { ok: true, mode: 'recovery_set', origin: originJob.id, expectedSha256: rec.dumpSha256 || null, expectedBytes: rec.dumpBytes ?? null, reason: `recovery set recorded by job ${originJob.id}` };
}

// dumpHeaderVerdict(head) → { ok, format, dumpedFrom, dumpedBy, reason }.
// Plain pg_dump output starts with the two comment lines; a custom-format
// archive starts with the PGDMP magic. Only plain is supported.
export function dumpHeaderVerdict(head) {
  const h = String(head || '');
  if (h.startsWith('PGDMP')) return { ok: false, format: 'custom', reason: 'a pg_dump custom-format archive (PGDMP); only plain SQL dumps are supported (dump_project_db writes plain SQL)' };
  if (!/^--\s*\n-- PostgreSQL database dump\s*\n/.test(h)) return { ok: false, format: 'unknown', reason: 'not a pg_dump plain-SQL dump (the "-- PostgreSQL database dump" header is missing)' };
  const from = (h.match(/^-- Dumped from database version ([0-9.]+)/m) || [])[1] || null;
  const by = (h.match(/^-- Dumped by pg_dump version ([0-9.]+)/m) || [])[1] || null;
  return { ok: true, format: 'plain', dumpedFrom: from, dumpedBy: by, reason: `plain SQL dump${from ? ` from PostgreSQL ${from}` : ''}` };
}

// serverCompatible(dumpedFrom, serverVersion) → { ok, reason }. A plain dump
// restores into the same or a NEWER major; an older server is refused.
export function serverCompatible(dumpedFrom, serverVersion) {
  const major = (v) => { const m = String(v || '').match(/^(\d+)/); return m ? Number(m[1]) : null; };
  const a = major(dumpedFrom); const b = major(serverVersion);
  if (a == null || b == null) return { ok: true, reason: 'server version not compared (unknown)' };
  if (b < a) return { ok: false, reason: `the dump comes from PostgreSQL ${dumpedFrom} but the guest runs ${serverVersion}: a dump does not restore into an older major` };
  return { ok: true, reason: `PostgreSQL ${dumpedFrom} → ${serverVersion}` };
}

// parseCopyRows(block, { secretColumn, nonceColumn }) → [{ ciphertext, nonce }]
// from one `COPY schema.table (cols…) FROM stdin;` block of a plain dump.
// Rows are tab-separated, `\N` is NULL, `\.` ends the block. The two columns
// hold base64, which carries no tab or backslash, so no further unescaping.
export function parseCopyRows(block, { secretColumn, nonceColumn }) {
  const lines = String(block || '').split('\n');
  const head = lines.findIndex((l) => /^COPY /.test(l));
  if (head < 0) return { rows: [], found: false, reason: 'no COPY block' };
  const m = lines[head].match(/^COPY\s+\S+\s+\(([^)]*)\)\s+FROM stdin;/);
  if (!m) return { rows: [], found: false, reason: 'COPY line without a column list' };
  const cols = m[1].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const si = cols.indexOf(secretColumn); const ni = cols.indexOf(nonceColumn);
  if (si < 0 || ni < 0) return { rows: [], found: true, reason: `columns ${secretColumn}/${nonceColumn} are not in the COPY column list` };
  const rows = [];
  for (const l of lines.slice(head + 1)) {
    if (l === '\\.') break;
    if (!l) continue;
    const f = l.split('\t');
    const c = f[si]; const n = f[ni];
    if (!c || c === '\\N' || !n || n === '\\N' || c === '') continue;
    rows.push({ ciphertext: c, nonce: n });
  }
  return { rows, found: true, reason: `${rows.length} protected row(s) in the dump` };
}

// compatibilityVerdict({ guard, rows, key, legacy }) → { established, detail,
// classification }. Established when every protected row in the dump opens
// under the key that will be in force after the restore (or a known legacy
// default the app's bridge can read); a row nothing opens means the restore
// would land credentials the application cannot use — refused, never
// assumed.
export function compatibilityVerdict({ guard, rows, key, legacy = [] }) {
  if (!guard) return { established: true, detail: 'not applicable: the app has no protected credential rows', classification: null };
  if (!rows || !rows.length) return { established: true, detail: 'the dump carries no protected credential rows', classification: { total: 0, current: 0, legacy: 0, unknown: 0 } };
  if (!key) return { established: false, detail: `${rows.length} protected row(s) in the dump but no key is configured to read them under`, classification: null };
  const c = classifyRows(rows, { current: key, legacy: (legacy || []).filter(Boolean) });
  if (c.unknown > 0) return { established: false, detail: `${c.unknown} of ${c.total} protected row(s) in the dump open under neither the key that will be in force nor a known legacy default: the restored credentials would be unusable`, classification: c };
  return { established: true, detail: `${c.total} protected row(s) open under the key that will be in force (${c.current} current, ${c.legacy} legacy)`, classification: c };
}

// ── guest scripts and their parsers ─────────────────────────────────────

const absRe = /^\/[A-Za-z0-9._\/-]+$/;
function checkPaths(...paths) { for (const p of paths) if (p != null && !absRe.test(String(p))) throw new Error('paths must be absolute'); }

// The key line of an environment file, by name, without echoing the file.
const keyOf = (file, key) => `sed -n 's/^\\(export \\)\\{0,1\\}${key}=//p' '${file}' 2>/dev/null | head -1 | sed "s/^[\\"']//; s/[\\"']\\$//"`;

// inspectScript(...) — everything the restore must know BEFORE it stops
// anything, in one read-only pass. Prints marker lines only; the two KEY
// lines carry the base64 of a key value and are consumed in memory by the
// operation, never recorded.
export function inspectScript({ dumpsDir = DB_DUMPS_DIR, dumpName, envCopyPath = null, environmentFile = '/etc/environment', guard = null, guardKey = null, unit = 'mock2-dev.service' }) {
  if (!DUMP_NAME_RE.test(String(dumpName || ''))) throw new Error('dumpName must be a dump name');
  checkPaths(dumpsDir, envCopyPath, environmentFile);
  if (guard && (!IDENT_RE.test(guard.table) || !IDENT_RE.test(guard.schema || 'public') || !IDENT_RE.test(guard.secret_column) || !IDENT_RE.test(guard.nonce_column))) throw new Error('guard identifiers must be plain identifiers');
  if (guardKey != null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(guardKey)) throw new Error('guardKey must be an environment key name');
  if (!/^[A-Za-z0-9@._-]+\.service$/.test(unit)) throw new Error('unit must be a .service name');
  const F = `${dumpsDir}/${dumpName}`;
  const lines = [
    `F='${F}'`,
    `if [ -f "$F" ]; then echo "DUMP:$(wc -c < "$F" | tr -d ' '):$(sha256sum "$F" | cut -d' ' -f1)"; echo "HEAD:$(head -c 600 "$F" | base64 | tr -d '\\n')"; else echo "DUMP:none"; fi`,
    `if command -v psql >/dev/null 2>&1; then v=$(su - postgres -c "psql -X -tAc 'show server_version'" 2>/dev/null | head -1); echo "SERVER:${'${v:-unknown}'}"; else echo "SERVER:nopsql"; fi`,
    `echo "UNIT_ACTIVE:$(systemctl is-active '${unit}' 2>/dev/null || echo unknown)"`,
  ];
  if (guard) {
    const schema = guard.schema || 'public';
    lines.push(`if [ -f "$F" ]; then blk=$(awk 'BEGIN{p=0} /^COPY ${schema}\\.${guard.table} \\(/{p=1} p{print} p&&/^\\\\\\.$/{exit}' "$F" | head -c 4194304 | base64 | tr -d '\\n'); if [ -n "$blk" ]; then echo "COPY:$blk"; else echo "COPY:none"; fi; fi`);
    if (guardKey) {
      lines.push(`k=$(${keyOf(environmentFile, guardKey)}); if [ -n "$k" ]; then echo "KEY_CURRENT:$(printf '%s' "$k" | base64 | tr -d '\\n')"; else echo "KEY_CURRENT:none"; fi`);
      if (envCopyPath) lines.push(`if [ -f '${envCopyPath}' ]; then echo "ENVCOPY:present"; k=$(${keyOf(envCopyPath, guardKey)}); if [ -n "$k" ]; then echo "KEY_COPY:$(printf '%s' "$k" | base64 | tr -d '\\n')"; else echo "KEY_COPY:none"; fi; else echo "ENVCOPY:missing"; fi`);
    }
  }
  if (envCopyPath && !(guard && guardKey)) lines.push(`if [ -f '${envCopyPath}' ]; then echo "ENVCOPY:present"; else echo "ENVCOPY:missing"; fi`);
  lines.push('');
  return lines.join('\n');
}

export function parseInspect(stdout) {
  const s = String(stdout || '');
  const get = (k) => (s.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1] ?? null;
  const dump = get('DUMP');
  let dumpFile = null;
  if (dump && dump !== 'none') { const m = dump.match(/^(\d+):([0-9a-f]{64})$/); dumpFile = m ? { bytes: Number(m[1]), sha256: m[2] } : { bytes: null, sha256: null }; }
  const copy = get('COPY');
  return {
    dump: dumpFile,
    head: get('HEAD') ? unb64(get('HEAD')) : '',
    server: get('SERVER'),
    unitActive: get('UNIT_ACTIVE'),
    copyBlock: copy && copy !== 'none' ? unb64(copy) : null,
    copyPresent: copy != null && copy !== 'none',
    keyCurrent: get('KEY_CURRENT') && get('KEY_CURRENT') !== 'none' ? unb64(get('KEY_CURRENT')) : null,
    envCopy: get('ENVCOPY'),
    keyCopy: get('KEY_COPY') && get('KEY_COPY') !== 'none' ? unb64(get('KEY_COPY')) : null,
  };
}

// protectScript(jobId) — the pre-restore copies. The dump is written to a
// temp name and only becomes the artifact when pg_dump exited 0, the file
// is non-empty and carries the header: an interrupted or failed capture
// leaves nothing under the artifact's name and is reported as none.
export function protectScript(jobId, { dumpsDir = DB_DUMPS_DIR, environmentFile = '/etc/environment' } = {}) {
  const id = String(jobId || '');
  if (!JOB_ID_RE.test(id)) throw new Error('job id must be a plain identifier');
  checkPaths(dumpsDir, environmentFile);
  return [
    `D='${dumpsDir}'; mkdir -p "$D" 2>/dev/null; f="$D/app-pre-restore-${id}.sql"`,
    `if ! command -v pg_dump >/dev/null 2>&1; then echo "PRE_DUMP:none:no pg_dump"; elif su - postgres -c "pg_dump --clean --if-exists app" > "$f.tmp" 2>/dev/null && [ -s "$f.tmp" ] && head -c 64 "$f.tmp" | grep -q 'PostgreSQL database dump'; then mv -f "$f.tmp" "$f" && chmod 600 "$f" && echo "PRE_DUMP:$f:$(wc -c < "$f" | tr -d ' '):$(sha256sum "$f" | cut -d' ' -f1)"; else rm -f "$f.tmp"; echo "PRE_DUMP:none:pg_dump failed or wrote no dump"; fi`,
    `umask 077; if [ -f '${environmentFile}' ]; then cp -p '${environmentFile}' '${environmentFile}.pre-restore-${id}' && chmod 600 '${environmentFile}.pre-restore-${id}' && echo "PRE_ENV:${environmentFile}.pre-restore-${id}"; else echo "PRE_ENV:none:no environment file"; fi`,
    '',
  ].join('\n');
}

export function parseProtect(stdout) {
  const s = String(stdout || '');
  const d = (s.match(/^PRE_DUMP:(.*)$/m) || [])[1] || null;
  const e = (s.match(/^PRE_ENV:(.*)$/m) || [])[1] || null;
  let dbDump = null; let dbDumpNote = null;
  if (d && !/^none/.test(d)) { const m = d.match(/^(\/\S+):(\d+):([0-9a-f]{64})$/); dbDump = m ? { path: m[1], bytes: Number(m[2]), sha256: m[3] } : null; if (!m) dbDumpNote = 'capture reported an unreadable artifact line'; }
  else dbDumpNote = (d || 'no capture line').replace(/^none:?\s*/, '') || 'capture failed';
  return { dbDump, dbDumpNote, envCopy: e && !/^none/.test(e) ? e : null, envCopyNote: e && /^none/.test(e) ? e : null };
}

// verifyArtifactScript(path) → `ARTIFACT:<path>:<bytes>:<sha>` | `ARTIFACT:<path>:missing`.
// A retry REVALIDATES a recorded artifact by identity (size and sha256
// against the record) before it reuses it; existence alone is nothing.
export function verifyArtifactScript(path) {
  checkPaths(path);
  return `p='${path}'; if [ -f "$p" ]; then echo "ARTIFACT:$p:$(wc -c < "$p" | tr -d ' '):$(sha256sum "$p" | cut -d' ' -f1)"; else echo "ARTIFACT:$p:missing"; fi\n`;
}

export function artifactMatches(stdout, { path, sha256, bytes = null }) {
  const m = String(stdout || '').match(/^ARTIFACT:(\S+?):(missing|(\d+):([0-9a-f]{64}))$/m);
  if (!m || m[1] !== path) return { ok: false, reason: 'no artifact line for the recorded path' };
  if (m[2] === 'missing') return { ok: false, reason: `${path} is gone` };
  if (sha256 && m[4] !== sha256) return { ok: false, reason: `${path} is not the recorded artifact (sha256 differs)` };
  if (bytes != null && Number(m[3]) !== Number(bytes)) return { ok: false, reason: `${path} is not the recorded artifact (size differs)` };
  return { ok: true, bytes: Number(m[3]), sha256: m[4] };
}

// restoreScript(dumpName) — the psql restore. ON_ERROR_STOP=0 as before:
// a --clean dump drops and recreates every object it carries; errors are
// counted and the first twenty reported (statement text, never row data).
export function restoreScript({ dumpsDir = DB_DUMPS_DIR, dumpName }) {
  if (!DUMP_NAME_RE.test(String(dumpName || ''))) throw new Error('dumpName must be a dump name');
  checkPaths(dumpsDir);
  return [
    `F='${dumpsDir}/${dumpName}'; T=/tmp/pp-restore.sql`,
    `cp "$F" "$T" && chmod 644 "$T" || { echo "RESTORE_RC:98"; echo "ERRORS:0"; exit 0; }`,
    `out=$(su - postgres -c "psql -X -v ON_ERROR_STOP=0 -q -d app -f $T" 2>&1); rc=$?; rm -f "$T"`,
    `echo "RESTORE_RC:$rc"`,
    `n=$(printf '%s\\n' "$out" | grep -c -E '^(psql:.*ERROR|ERROR)'); echo "ERRORS:$n"`,
    `printf '%s\\n' "$out" | grep -E '^(psql:.*ERROR|ERROR)' | head -n 20 | cut -c1-200 | sed 's/^/ERR:/'`,
    '',
  ].join('\n');
}

export function parseRestore(stdout) {
  const s = String(stdout || '');
  const rc = Number((s.match(/^RESTORE_RC:(\d+)/m) || [])[1]);
  const errors = Number((s.match(/^ERRORS:(\d+)/m) || [])[1]);
  const lines = s.split('\n').filter((l) => l.startsWith('ERR:')).map((l) => l.slice(4));
  return { rc: Number.isFinite(rc) ? rc : null, errors: Number.isFinite(errors) ? errors : null, errorLines: lines };
}

// swapEnvScript(copyPath, environmentFile) — put the recovery set's
// environment in force (the current file was copied by protectScript).
export function swapEnvScript({ envCopyPath, environmentFile = '/etc/environment' }) {
  checkPaths(envCopyPath, environmentFile);
  return `umask 022; cp -p '${envCopyPath}' '${environmentFile}.mock2-tmp' && chmod 0644 '${environmentFile}.mock2-tmp' && mv -f '${environmentFile}.mock2-tmp' '${environmentFile}' && echo "ENV_SWAPPED:yes" || echo "ENV_SWAPPED:no"\n`;
}

// ── snapshot restore ────────────────────────────────────────────────────

// parseInstanceList(stdout, name) → the instance object from `incus list
// <name> --format json`, or null.
export function parseInstanceList(stdout, name) {
  let list;
  try { list = JSON.parse(String(stdout || '[]')); } catch { return null; }
  if (!Array.isArray(list)) return null;
  return list.find((i) => i && i.name === name) || null;
}

// snapshotCoverage(instance) → { root, customVolumes } — what an instance
// snapshot restores (the root disk) and what it does not (custom storage
// volumes attached as disk devices: `pool` + `source`, path other than `/`).
export function snapshotCoverage(instance) {
  const devices = instance?.expanded_devices || instance?.devices || {};
  let root = null; const customVolumes = [];
  for (const [name, d] of Object.entries(devices)) {
    if (!d || d.type !== 'disk') continue;
    if (d.path === '/' || name === 'root') { root = name; continue; }
    if (d.source && d.pool) customVolumes.push({ device: name, pool: d.pool, source: d.source, path: d.path || null });
  }
  return { root, customVolumes };
}

// snapshotPlanVerdict({ instance, snapshot, acceptPartial }) → { ok, reason,
// target, coverage, partial }. Refuses an unknown snapshot and a guest with
// custom volumes unless the caller accepted a partial restore by name.
export function snapshotPlanVerdict({ instance, snapshot, acceptPartial = false }) {
  if (!instance) return { ok: false, reason: 'the guest does not exist' };
  const target = (instance.snapshots || []).find((s) => s && s.name === snapshot) || null;
  if (!target) return { ok: false, reason: `snapshot ${snapshot} does not exist on ${instance.name}` };
  const coverage = snapshotCoverage(instance);
  const partial = coverage.customVolumes.length > 0;
  if (partial && !acceptPartial) {
    return { ok: false, reason: `${instance.name} has ${coverage.customVolumes.length} custom storage volume(s) attached (${coverage.customVolumes.map((v) => `${v.device}: ${v.pool}/${v.source}`).join(', ')}) that an instance snapshot does NOT restore; refusing rather than claiming a complete restore — pass accept_partial: true to restore the root disk only`, coverage, target, partial };
  }
  return { ok: true, reason: partial ? 'root disk only; the attached custom volumes are not restored' : 'the instance snapshot covers the guest', coverage, target, partial };
}
