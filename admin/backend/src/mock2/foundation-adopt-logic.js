// Mock2 application foundation — ADOPTION of an existing project, the PURE half
// (2026-10, user decision 2026-10-25). No I/O, no native modules (risk R9).
//
// A project created before the foundation (projects.foundation_version IS NULL)
// keeps its native in-guest PostgreSQL and is never rewritten on its own. This
// is the explicit, planned, resumable step that moves one onto the foundation
// so it ends up exactly like a new foundation project — with a rollback.
//
//   plan     read-only probes (host + guest) → facts → { plan, blockers,
//            plan_token }. A plan with blockers has no usable token.
//   confirm  the person (editor + sudo) sends the token back with
//            acknowledge_downtime; the host recomputes the facts from FRESH
//            probes and the token must match (PLAN_STALE otherwise), like the
//            storage plan/confirm pattern in lib/storage.
//   run      twelve durable steps (ADOPT_STEPS), each recorded in
//            mock2_foundation_adoptions (migration 566), each idempotent, so a
//            failed or interrupted run resumes at its failed step; any run —
//            failed or succeeded — can be rolled back to the step-1 snapshot.
//
// Nothing is deleted: the rollback snapshot, the native data directory and the
// dump stay until a person removes them (a later, separate action).
//
// This module decides: the steps, the blockers and their plain next steps, the
// token, the guest scripts (sh -c, inputs as positional args or on stdin —
// never a secret in argv) and their parsers, the package.json merge and the
// projection of a run. foundation-adopt-service.js runs it.
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'node:crypto';
import { FOUNDATION_VERSION, FOUNDATION_CLI, LOCAL_EMBEDDINGS_WARNING, componentSecretName, isValidSecretName } from './foundation-contract.js';
import { FOUNDATION_GUEST_CONFIG, DEFAULT_LAYOUT, foundationPgExecPrefix } from './foundation-stack-logic.js';
import { sourceEngineHits, packageEngineHits, describeEngineHits } from './database-exception-logic.js';
import { FOUNDATION_NODE_IMPORT, FOUNDATION_PACKAGE_IMPORTS, FOUNDATION_DEPENDENCIES } from './scaffold-foundation.js';

export const ADOPT_AUDIT = Object.freeze({
  start: 'MOCK2_FOUNDATION_ADOPT_START',
  rollback: 'MOCK2_FOUNDATION_ADOPT_ROLLBACK',
  resume: 'MOCK2_FOUNDATION_ADOPT_RESUME',
});

export const ADOPTION_STATES = Object.freeze(['running', 'succeeded', 'failed', 'rolling_back', 'rolled_back']);
export const STEP_STATES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);
export const APP_DIR = '/srv/app';
export const APP_UNIT = 'mock2-dev.service';
export const DUMP_ROOT = '/var/lib/mock2-adopt';
export const SNAPSHOT_PREFIX = 'pre-foundation-';
export const PRE_ROLLBACK_PREFIX = 'pre-rollback-';
// Disk the foundation's images and Docker itself take in the guest (measured
// on a Debian 13 guest: Docker ~0.3 GB, PostgreSQL/pgvector ~0.45 GB,
// SeaweedFS ~0.1 GB, the local embedding server + model ~1.6 GB), rounded up.
export const IMAGE_ALLOWANCE_BYTES = 3 * 1024 ** 3;

// retry: 'safe'    — idempotent; a resume runs it again as it is.
//        'checked' — re-checks its own precondition first and refuses (offering
//                    the rollback) when the state is not one it can continue from.
export const ADOPT_STEPS = Object.freeze([
  { name: 'snapshot', label: 'Snapshot the guest', retry: 'safe', summary: 'Snapshot the guest as pre-foundation-<adoption id>. This is the rollback point.' },
  { name: 'stop_app', label: 'Stop the app', retry: 'safe', summary: 'Hold the project\'s checkout lock for the whole run (taken when you confirm) and stop the app. Downtime starts here.' },
  { name: 'dump_database', label: 'Dump the database', retry: 'safe', summary: 'Dump the native "app" database to a root-only file in the guest and record its size, sha256 and the row count of every table.' },
  { name: 'stop_native_database', label: 'Stop the old database', retry: 'safe', summary: 'Stop and disable the native PostgreSQL service and check that its port is free. Its data directory is left untouched for the rollback.' },
  { name: 'docker_ready', label: 'Make the guest Docker-ready', retry: 'safe', summary: 'Make the guest Docker-ready with the same five settings as new foundation guests (security.nesting and the syscall intercepts), then restart it.' },
  { name: 'install_runtime', label: 'Install Docker', retry: 'safe', summary: 'Install Docker, Docker Compose and the PostgreSQL client in the guest.' },
  { name: 'start_foundation', label: 'Start the foundation', retry: 'safe', summary: 'Mark the project as a foundation project, write the deployment master key and start the foundation stack (PostgreSQL + pgvector, storage, embeddings) with the features you chose.' },
  { name: 'restore_database', label: 'Restore and verify the data', retry: 'checked', summary: 'Restore the dump into the foundation PostgreSQL as role app, enable pgvector, and check every table\'s row count against the dump. Any difference stops the run.' },
  { name: 'move_secrets', label: 'Move the secrets', retry: 'safe', summary: 'Move the installed components\' secrets from /etc/environment into the platform\'s encrypted store, remove those lines and the DATABASE_URL line, and deliver the secrets sealed to the app database.' },
  { name: 'install_foundation_module', label: 'Add the foundation module', retry: 'safe', summary: 'Add the platform-owned foundation/ module and the package.json entries a new foundation app has, as one platform commit pushed to the project repository.' },
  { name: 'deploy', label: 'Deploy and check health', retry: 'safe', summary: 'Deploy through the normal deploy path (now a foundation deploy), then check that the app serves and that the foundation reports its database ready.' },
  { name: 'done', label: 'Finish', retry: 'safe', summary: 'Release the checkout lock. The snapshot, the native data directory and the dump are kept so the rollback stays available.' },
]);
export const STEP_NAMES = Object.freeze(ADOPT_STEPS.map((s) => s.name));
export const stepIndex = (name) => STEP_NAMES.indexOf(name);
export const stepRetry = (name) => ADOPT_STEPS.find((s) => s.name === name)?.retry || 'safe';
export const stepLabel = (name) => ADOPT_STEPS.find((s) => s.name === name)?.label || String(name || '');

export const ADOPT_CODES = Object.freeze({
  // blockers (preflight)
  NOT_LEGACY_PROJECT: 'NOT_LEGACY_PROJECT',
  NOT_ONLINE: 'NOT_ONLINE',
  GUEST_UNREACHABLE: 'GUEST_UNREACHABLE',
  GUEST_NOT_CONTAINER: 'GUEST_NOT_CONTAINER',
  GUEST_HAS_CUSTOM_VOLUMES: 'GUEST_HAS_CUSTOM_VOLUMES',
  CHECKOUT_LOCK_HELD: 'CHECKOUT_LOCK_HELD',
  DEPLOY_RUNNING: 'DEPLOY_RUNNING',
  ADOPTION_RUNNING: 'ADOPTION_RUNNING',
  ADOPTION_UNFINISHED: 'ADOPTION_UNFINISHED',
  NOT_MOCK2_APP: 'NOT_MOCK2_APP',
  APP_USES_SQLITE: 'APP_USES_SQLITE',
  APP_USES_OTHER_ENGINE: 'APP_USES_OTHER_ENGINE',
  NO_NATIVE_DATABASE: 'NO_NATIVE_DATABASE',
  NOT_ENOUGH_DISK: 'NOT_ENOUGH_DISK',
  REPO_DIVERGED: 'REPO_DIVERGED',
  PACKAGE_JSON_UNCOMMITTED: 'PACKAGE_JSON_UNCOMMITTED',
  SECRET_NAME_UNSUPPORTED: 'SECRET_NAME_UNSUPPORTED',
  FOUNDATION_STACK_PRESENT: 'FOUNDATION_STACK_PRESENT',
  FOUNDATION_DIR_PRESENT: 'FOUNDATION_DIR_PRESENT',
  // request refusals
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',               // 404
  INVALID_REQUEST: 'INVALID_REQUEST',                   // 400
  ACKNOWLEDGE_DOWNTIME_REQUIRED: 'ACKNOWLEDGE_DOWNTIME_REQUIRED', // 400
  PLAN_STALE: 'PLAN_STALE',
  PLAN_BLOCKED: 'PLAN_BLOCKED',
  ADOPTION_BUSY: 'ADOPTION_BUSY',
  NO_ADOPTION: 'NO_ADOPTION',                           // 404
  NOT_ROLLBACKABLE: 'NOT_ROLLBACKABLE',
  NOT_RESUMABLE: 'NOT_RESUMABLE',
  ROLLBACK_REPO_MOVED: 'ROLLBACK_REPO_MOVED',
  SNAPSHOT_MISSING: 'SNAPSHOT_MISSING',
  // step outcomes
  RESTORE_TARGET_NOT_EMPTY: 'RESTORE_TARGET_NOT_EMPTY',
  ROW_COUNT_MISMATCH: 'ROW_COUNT_MISMATCH',
  LOCK_LOST: 'LOCK_LOST',
  INTERRUPTED: 'INTERRUPTED',
});

export function adoptRefusal(code, message, { status = 409, options = [], ...extra } = {}) {
  return { ok: false, status, code, message, options, ...extra };
}

const ADOPTION_ID_RE = /^fa_[a-f0-9]{16}$/;
export const isValidAdoptionId = (id) => ADOPTION_ID_RE.test(String(id || ''));
export function newAdoptionId(randomHex) {
  const hex = String(randomHex || '').toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 16);
  if (hex.length !== 16) throw new Error('an adoption id needs 16 hex characters');
  return `fa_${hex}`;
}
export function snapshotNameFor(id) {
  if (!isValidAdoptionId(id)) throw new Error(`invalid adoption id: ${id}`);
  return `${SNAPSHOT_PREFIX}${id}`;
}
export function preRollbackSnapshotNameFor(id) {
  if (!isValidAdoptionId(id)) throw new Error(`invalid adoption id: ${id}`);
  return `${PRE_ROLLBACK_PREFIX}${id}`;
}
export function dumpDirFor(id) {
  if (!isValidAdoptionId(id)) throw new Error(`invalid adoption id: ${id}`);
  return `${DUMP_ROOT}/${id}`;
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// The native database (the legacy guest's own PostgreSQL). `native.port` lets
// the real-database test aim the same scripts at a scratch cluster.
// ---------------------------------------------------------------------------
export const NATIVE_DEFAULT = Object.freeze({ port: null });
function nativeAs(cmd, native = NATIVE_DEFAULT) {
  const port = native?.port == null ? '' : Number(native.port);
  if (port !== '' && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`invalid native port: ${native.port}`);
  const withPort = port === '' ? cmd : cmd.replace(/^(psql|pg_dump)\b/, `$1 -p ${port}`);
  return `su - postgres -c ${sq(withPort)}`;
}

// The tables that are the app's data: ordinary and partitioned tables outside
// the system schemas and the platform's own mock2_foundation schema, and not
// owned by an extension. The same predicate on both sides of the copy.
const USER_TABLES_WHERE = "c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema','mock2_foundation') AND n.nspname !~ '^pg_' "
  + "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')";

export const NATIVE_FACTS_SQL = [
  "SELECT 'DB_SIZE:' || pg_database_size(current_database());",
  `SELECT 'TABLE:' || format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_TABLES_WHERE} ORDER BY 1;`,
].join('\n');

// One exact count per table (query_to_xml runs a count(*) per row of the
// catalog query). Tab-separated, then an end marker so a cut-off answer is
// never read as complete.
export const COUNT_SQL = [
  `SELECT 'ADOPT_COUNT:' || format('%I.%I', n.nspname, c.relname) || chr(9) || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_TABLES_WHERE} ORDER BY 1;`,
  "SELECT 'ADOPT_COUNT_DONE';",
].join('\n');

// After the restore every app table must belong to role app (its migrations
// alter them); --no-owner --role=app makes it so.
export const OWNER_SQL = `SELECT 'ADOPT_NOT_APP_OWNED:' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_TABLES_WHERE} AND pg_get_userbyid(c.relowner) <> 'app';\n`;
export function parseNotAppOwned(stdout) {
  const m = String(stdout || '').match(/^\s*ADOPT_NOT_APP_OWNED:(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

// parseCounts(stdout) → { complete, counts: { 'schema.table': n } }
export function parseCounts(stdout) {
  const counts = {};
  let complete = false;
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === 'ADOPT_COUNT_DONE') { complete = true; continue; }
    const m = line.match(/^\s*ADOPT_COUNT:(.+)\t(\d+)\s*$/);
    if (m) counts[m[1]] = Number(m[2]);
  }
  return { complete, counts };
}

// compareCounts(expected, actual) → { ok, mismatches: [{ table, expected, actual }] }
export function compareCounts(expected = {}, actual = {}) {
  const names = [...new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})])].sort();
  const mismatches = [];
  for (const table of names) {
    const e = Object.hasOwn(expected || {}, table) ? expected[table] : null;
    const a = Object.hasOwn(actual || {}, table) ? actual[table] : null;
    if (e !== a) mismatches.push({ table, expected: e, actual: a });
  }
  return { ok: mismatches.length === 0, mismatches };
}
export function describeMismatches(mismatches = [], max = 8) {
  const list = mismatches.slice(0, max).map((m) => `${m.table}: dump ${m.expected == null ? 'has no such table' : `${m.expected} rows`}, foundation ${m.actual == null ? 'has no such table' : `${m.actual} rows`}`);
  return `${list.join('; ')}${mismatches.length > max ? `; … ${mismatches.length - max} more` : ''}`;
}
export const totalRows = (counts = {}) => Object.values(counts || {}).reduce((a, n) => a + (Number(n) || 0), 0);

// ---------------------------------------------------------------------------
// The read-only guest probe (plan and confirm). Prints markers only: file
// contents never cross except package.json (base64); /etc/environment
// contributes its KEY NAMES, never a value.
// ---------------------------------------------------------------------------
const ENGINE_GREP_RE = 'sqlite|libsql|sql\\.js|pglite|mysql|mongoose|mongodb|typeorm|sequelize|knex|prisma|@aws-sdk/client-s3|@aws-sdk/lib-storage|minio|DATABASE_URL';
const GREP_INCLUDES = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', '.env*'].map((g) => `--include=${sq(g)}`).join(' ');
const GREP_EXCLUDES = ['node_modules', 'dist', 'build', 'coverage', '.git', 'state', 'foundation'].map((d) => `--exclude-dir=${d}`).join(' ');

export function adoptProbeScript({ appDir = APP_DIR, native = NATIVE_DEFAULT } = {}) {
  return [
    'set +e',
    `A=${sq(appDir)}`,
    'echo "PROBE:v1"',
    'if [ -f "$A/package.json" ]; then echo "PKG:$(base64 -w0 < "$A/package.json")"; else echo "PKG:missing"; fi',
    'if [ -f "$A/mock2.yaml" ] && grep -qE "^run:" "$A/mock2.yaml" && grep -qE "^[[:space:]]+start:[[:space:]]*[^[:space:]#]" "$A/mock2.yaml"; then echo "MANIFEST:yes"; else echo "MANIFEST:no"; fi',
    'if [ -e "$A/foundation" ]; then echo "FOUNDATION_DIR:yes"; else echo "FOUNDATION_DIR:no"; fi',
    'h=$(git -C "$A" rev-parse HEAD 2>/dev/null) || h=none; echo "GIT_HEAD:$h"',
    'r=$(git -C "$A" ls-remote origin refs/heads/main 2>/dev/null | cut -f1); echo "GIT_REMOTE:${r:-none}"',
    'if [ -n "$r" ] && [ "$h" != none ]; then',
    '  if [ "$r" = "$h" ] || git -C "$A" merge-base --is-ancestor "$r" "$h" 2>/dev/null; then echo "GIT_REMOTE_IN_HEAD:yes"; echo "GIT_AHEAD:$(git -C "$A" rev-list --count "$r..$h" 2>/dev/null || echo 0)"; else echo "GIT_REMOTE_IN_HEAD:no"; fi',
    'fi',
    'git -C "$A" status --porcelain 2>/dev/null | head -n 50 | while IFS= read -r l; do printf "GIT_DIRTY:%s\\n" "$(printf "%s" "$l" | cut -c4-)"; done',
    "[ -f /etc/environment ] && sed -n 's/^[[:space:]]*\\(export[[:space:]]\\+\\)\\?\\([A-Za-z_][A-Za-z0-9_]*\\)[[:space:]]*=.*/ENV_KEY:\\2/p' /etc/environment",
    'echo "DISK_FREE:$(df -B1 --output=avail / 2>/dev/null | tail -n1 | tr -d " ")"',
    `if [ -e ${sq(DEFAULT_LAYOUT.composeFile)} ]; then echo "STACK_PRESENT:yes"; else echo "STACK_PRESENT:no"; fi`,
    `grep -rnIE ${sq(ENGINE_GREP_RE)} ${GREP_INCLUDES} ${GREP_EXCLUDES} "$A" 2>/dev/null | head -n 300 | while IFS= read -r l; do printf "ENGINE:%s\\n" "$(printf "%s" "$l" | base64 -w0)"; done`,
    'if ! id postgres >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then echo "NATIVE:no_server"; else',
    `  out=$(printf '%s\\n' ${sq("SELECT 'HASDB:' || count(*) FROM pg_database WHERE datname = 'app';")} | ${nativeAs('psql -X -At -v ON_ERROR_STOP=1 -d postgres', native)} 2>&1); rc=$?`,
    '  if [ $rc -ne 0 ]; then echo "NATIVE:unreachable"',
    '  elif ! printf "%s\\n" "$out" | grep -q "^HASDB:1$"; then echo "NATIVE:no_database"',
    `  else printf '%s\\n' ${sq(NATIVE_FACTS_SQL)} | ${nativeAs('psql -X -At -v ON_ERROR_STOP=1 -d app', native)} 2>/dev/null | grep -E '^(TABLE|DB_SIZE):'; echo "NATIVE:ok"; fi`,
    'fi',
    'echo "PROBE:end"',
    '',
  ].join('\n');
}

const decode64 = (s) => { try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; } };
const S3_DIRECT_RE = /(?:^|[^A-Za-z0-9_$.])(?:from|require|import)\s*\(?\s*['"`](@aws-sdk\/client-s3|@aws-sdk\/lib-storage|minio)['"`]/;

// parseProbe(stdout, { appDir }) → the guest facts.
export function parseProbe(stdout, { appDir = APP_DIR } = {}) {
  const s = String(stdout || '');
  const lines = s.split('\n').map((l) => l.replace(/\r$/, ''));
  const one = (k) => { const l = lines.find((x) => x.startsWith(`${k}:`)); return l == null ? null : l.slice(k.length + 1).trim(); };
  const many = (k) => lines.filter((x) => x.startsWith(`${k}:`)).map((x) => x.slice(k.length + 1));
  const complete = lines.includes('PROBE:v1') && lines.includes('PROBE:end');
  const pkgRaw = one('PKG');
  const pkg = pkgRaw == null || pkgRaw === 'missing' ? { present: false, text: null } : { present: true, text: decode64(pkgRaw) };
  const prefix = `${String(appDir).replace(/\/+$/, '')}/`;
  const engineLines = many('ENGINE').map(decode64).map((l) => {
    const m = l.match(/^(.*?):(\d+):(.*)$/);
    if (!m) return null;
    const path = m[1].startsWith(prefix) ? m[1].slice(prefix.length) : m[1];
    return { path, line: Number(m[2]), text: m[3] };
  }).filter(Boolean);
  const engineHits = [];
  const s3Direct = [];
  for (const e of engineLines) {
    for (const h of sourceEngineHits(e.path, e.text)) engineHits.push({ ...h, line: e.line });
    const s3 = e.text.match(S3_DIRECT_RE);
    if (s3 && /\.(?:[cm]?[jt]sx?)$/i.test(e.path)) s3Direct.push({ path: e.path, line: e.line, name: s3[1] });
  }
  const native = one('NATIVE') || 'unknown';
  const sizeRaw = (lines.find((x) => /^DB_SIZE:\d+$/.test(x.trim())) || '').trim().slice('DB_SIZE:'.length);
  const head = one('GIT_HEAD');
  const remote = one('GIT_REMOTE');
  const inHead = one('GIT_REMOTE_IN_HEAD');
  const freeRaw = one('DISK_FREE');
  return {
    complete,
    pkg,
    manifest: one('MANIFEST') === 'yes',
    foundationDir: one('FOUNDATION_DIR') === 'yes',
    stackPresent: one('STACK_PRESENT') === 'yes',
    git: {
      head: SHA_RE.test(head || '') ? head : null,
      remote: SHA_RE.test(remote || '') ? remote : null,
      remoteInHead: inHead === 'yes' ? true : inHead === 'no' ? false : null,
      ahead: Number(one('GIT_AHEAD')) || 0,
      dirty: many('GIT_DIRTY').map((p) => p.trim()).filter(Boolean),
    },
    envKeys: [...new Set(many('ENV_KEY').map((k) => k.trim()).filter((k) => ENV_KEY_RE.test(k)))].sort(),
    diskFreeBytes: /^\d+$/.test(freeRaw || '') ? Number(freeRaw) : null,
    engineHits,
    s3Direct,
    native: {
      state: ['ok', 'no_server', 'unreachable', 'no_database'].includes(native) ? native : 'unknown',
      sizeBytes: /^\d+$/.test(sizeRaw) ? Number(sizeRaw) : null,
      tables: [...new Set(many('TABLE').map((t) => t.trim()).filter(Boolean))].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// package.json: the entries a NEW foundation app has (scaffold.js packageJson):
// start/dev load the foundation bootstrap with --import, the `foundation`
// script, the '#foundation' alias, the foundation's S3 SDK dependencies.
// Additive; an existing equal entry is kept; a conflicting one is refused.
// ---------------------------------------------------------------------------
function withImport(script, kind) {
  const s = String(script || '').trim();
  if (s.includes(FOUNDATION_NODE_IMPORT)) return { ok: true, value: script };
  const patterns = kind === 'start'
    ? [/^(node)\s+(.+)$/]
    : [/^(tsx\s+watch)\s+(.+)$/, /^(tsx)\s+(.+)$/, /^(node)\s+(.+)$/];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return { ok: true, value: `${m[1]} ${FOUNDATION_NODE_IMPORT} ${m[2]}` };
  }
  return { ok: false, error: `the "${kind}" script (${s.slice(0, 120) || 'empty'}) is not one the platform can load the foundation bootstrap into — it must start with ${kind === 'start' ? '"node "' : '"tsx watch ", "tsx " or "node "'}` };
}

// mergeFoundationPackageJson(source) → { ok, changed, content, error }
export function mergeFoundationPackageJson(source) {
  let pkg;
  try { pkg = JSON.parse(String(source || '')); } catch { return { ok: false, error: 'package.json is not valid JSON' }; }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return { ok: false, error: 'package.json is not an object' };
  const scripts = { ...(pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) };
  if (typeof scripts.start !== 'string' || !scripts.start.trim()) return { ok: false, error: 'package.json has no "start" script (the deployed unit runs it)' };
  const start = withImport(scripts.start, 'start');
  if (!start.ok) return { ok: false, error: start.error };
  scripts.start = start.value;
  if (typeof scripts.dev === 'string' && scripts.dev.trim()) {
    const dev = withImport(scripts.dev, 'dev');
    if (!dev.ok) return { ok: false, error: dev.error };
    scripts.dev = dev.value;
  }
  const cli = `node ${FOUNDATION_CLI}`;
  if (scripts.foundation === undefined) scripts.foundation = cli;
  else if (scripts.foundation !== cli) return { ok: false, error: `package.json already has a "foundation" script (${String(scripts.foundation).slice(0, 80)}); the platform uses that name for "${cli}"` };
  const imports = { ...(pkg.imports && typeof pkg.imports === 'object' ? pkg.imports : {}) };
  for (const [k, v] of Object.entries(FOUNDATION_PACKAGE_IMPORTS)) {
    if (imports[k] === undefined) imports[k] = v;
    else if (imports[k] !== v) return { ok: false, error: `package.json "imports" already maps ${k} elsewhere (${String(JSON.stringify(imports[k])).slice(0, 80)}); the platform owns that alias` };
  }
  const dependencies = { ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}) };
  for (const [k, v] of Object.entries(FOUNDATION_DEPENDENCIES)) if (dependencies[k] === undefined) dependencies[k] = v;
  const out = { ...pkg, scripts, imports, dependencies };
  const content = `${JSON.stringify(out, null, 2)}\n`;
  let same = false;
  try { same = JSON.stringify(JSON.parse(String(source))) === JSON.stringify(out); } catch { same = false; }
  return { ok: true, changed: !same, content, error: null };
}

function pkgFacts(text) {
  try {
    const p = JSON.parse(String(text || ''));
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false };
    const deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
    return { ok: true, hasPg: typeof (p.dependencies || {}).pg === 'string', hasPgAnywhere: typeof deps.pg === 'string' };
  } catch { return { ok: false }; }
}

// ---------------------------------------------------------------------------
// Facts → secrets, blockers, warnings, plan, token
// ---------------------------------------------------------------------------

// The component secret keys present in /etc/environment (names only).
export function secretsToMove(facts) {
  const env = new Set(facts?.guest?.envKeys || []);
  return [...new Set((facts?.components?.secretKeys || []).filter((k) => env.has(k)))].sort();
}

export function guestConfigFacts(instance) {
  const cfg = instance?.config || {};
  const out = {};
  for (const k of Object.keys(FOUNDATION_GUEST_CONFIG)) out[k] = cfg[k] == null ? null : String(cfg[k]);
  return out;
}

function holderText(holder) {
  if (!holder) return 'Someone';
  if (holder.type === 'cycle') return `A build (cycle ${holder.id})`;
  if (holder.type === 'user') return 'A person working on the project';
  return 'Another project operation';
}

const GiB = 1024 ** 3;
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 'an unknown amount';
  if (v >= GiB) return `${(v / GiB).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${Math.max(1, Math.round(v / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
}
export function diskNeeded(dbBytes) {
  return 2 * Math.max(0, Number(dbBytes) || 0) + IMAGE_ALLOWANCE_BYTES;
}
export function downtimeEstimate(dbBytes) {
  const gb = Math.max(0, Number(dbBytes) || 0) / GiB;
  const lo = 10 + Math.ceil(gb * 3);
  const hi = 25 + Math.ceil(gb * 8);
  const known = Number.isFinite(Number(dbBytes)) && dbBytes != null;
  return `About ${lo}–${hi} minutes. The app stops at step 2 and serves again when the deploy in step 11 finishes. `
    + 'Most of that time is installing Docker, downloading the foundation images (about 3 GB the first time) and restarting the guest; '
    + `copying the database (${known ? formatBytes(dbBytes) : 'its size could not be read'}) is included.`;
}

// adoptionBlockers(facts) → [{ code, message, next_step }]. `message` says
// what is wrong and ends with the plain next step; `next_step` is that step
// alone. Guest checks run only when the guest was probed.
export function adoptionBlockers(facts) {
  const out = [];
  const add = (code, problem, next) => out.push({ code, message: `${problem} ${next}`, next_step: next });
  const p = facts?.project;
  if (!p) return [{ code: ADOPT_CODES.PROJECT_NOT_FOUND, message: 'Project not found.', next_step: 'Open the project from Dev Studio again.' }];
  if (p.foundation_version) add(ADOPT_CODES.NOT_LEGACY_PROJECT, 'This project already runs on the application foundation, so there is nothing to adopt.', 'Nothing to do: manage it under Build → Application foundation.');
  const a = facts.adoption;
  if (a && (a.state === 'running' || a.state === 'rolling_back')) add(ADOPT_CODES.ADOPTION_RUNNING, `An adoption is already ${a.state === 'running' ? 'running' : 'rolling back'} for this project.`, 'Wait for it to finish, then plan again.');
  else if (a && a.state === 'failed') add(ADOPT_CODES.ADOPTION_UNFINISHED, `An earlier adoption stopped at "${a.step || 'an unknown step'}".`, 'Resume it or roll it back first, then plan again.');
  if (p.lifecycle !== 'active' || !p.container_name) {
    add(ADOPT_CODES.NOT_ONLINE, `The project is ${p.lifecycle || 'not online'}.`, 'Wake it (or rehydrate it) so its guest is running, then plan again.');
  }
  if (facts.lock?.holder) add(ADOPT_CODES.CHECKOUT_LOCK_HELD, `${holderText(facts.lock.holder)} holds the project's checkout lock.`, 'Wait for it to finish (or release the checkout), then plan again.');
  const busy = facts.busy || {};
  if (busy.deploy || busy.provisioning || busy.baseAppDeploying || busy.setupLease) {
    add(ADOPT_CODES.DEPLOY_RUNNING, `A ${busy.provisioning ? 'provisioning job' : 'deploy or guest operation'} is running for this project's guest.`, 'Wait for it to finish, then plan again.');
  }
  if (p.foundation_version || p.lifecycle !== 'active' || !p.container_name) return out;

  const inst = facts.instance;
  if (inst === null) {
    add(ADOPT_CODES.GUEST_UNREACHABLE, `Incus does not report the guest ${p.container_name}.`, `Check that it exists and is running (Incus → ${p.container_name}), then plan again.`);
    return out;
  }
  if (inst) {
    if (inst.type && inst.type !== 'container') add(ADOPT_CODES.GUEST_NOT_CONTAINER, `The guest is a ${inst.type}; the foundation runs Docker inside a container guest only.`, 'This project cannot be adopted as it is: keep it on its native stack.');
    if (String(inst.status || '').toLowerCase() !== 'running') add(ADOPT_CODES.NOT_ONLINE, `The guest is ${String(inst.status || 'not running').toLowerCase()}.`, 'Wake the project, then plan again.');
    if ((inst.customVolumes || 0) > 0) add(ADOPT_CODES.GUEST_HAS_CUSTOM_VOLUMES, `The guest has ${inst.customVolumes} custom storage volume(s) attached, which the rollback snapshot would not cover.`, 'Detach them (or move their data into the guest) first, then plan again.');
  }
  const g = facts.guest;
  if (!g || !g.complete) {
    add(ADOPT_CODES.GUEST_UNREACHABLE, 'The guest did not answer the read-only checks.', 'Check that it is running and reachable (Incus → exec), then plan again.');
    return out;
  }
  if (!g.pkg.present) add(ADOPT_CODES.NOT_MOCK2_APP, `There is no package.json in ${APP_DIR}, so this is not the Mock2 TypeScript app shape the foundation module plugs into.`, 'Build the app first (a quick update deploys the base app), then plan again.');
  else {
    const pf = pkgFacts(g.pkg.text);
    if (!pf.ok) add(ADOPT_CODES.NOT_MOCK2_APP, 'package.json does not parse.', 'Fix it in a build (it is the app\'s own file), then plan again.');
    else {
      if (!pf.hasPg) add(ADOPT_CODES.NOT_MOCK2_APP, 'package.json does not depend on "pg", so the app does not use the PostgreSQL client the Mock2 scaffold uses.', 'Move its data access to PostgreSQL through Drizzle and pg first, then plan again.');
      const merge = mergeFoundationPackageJson(g.pkg.text);
      if (!merge.ok) add(ADOPT_CODES.NOT_MOCK2_APP, `${merge.error}.`, 'Restore the scaffold\'s script (or rename the entry) in a build, then plan again.');
    }
  }
  if (!g.manifest) add(ADOPT_CODES.NOT_MOCK2_APP, 'mock2.yaml has no run contract (run: … start:), so the deploy would not know how to start the app.', 'Restore the run block in a build, then plan again.');
  const engines = [...(g.pkg.present ? packageEngineHits('package.json', g.pkg.text) : []), ...(g.engineHits || [])];
  const sqlite = engines.filter((h) => h.family === 'sqlite');
  const other = engines.filter((h) => h.family !== 'sqlite');
  if (sqlite.length) {
    add(ADOPT_CODES.APP_USES_SQLITE, `The app uses SQLite (${describeEngineHits(sqlite, 6)}). Its data would not move with the PostgreSQL copy, so it cannot be adopted yet.`, 'Move that data access to PostgreSQL (Drizzle + pg, the "app" database) in a build, deploy it, then plan again.');
  }
  if (other.length) {
    add(ADOPT_CODES.APP_USES_OTHER_ENGINE, `The app uses another database engine or ORM (${describeEngineHits(other, 6)}); PostgreSQL through Drizzle is the only database on the foundation.`, 'Move that code to Drizzle + pg in a build first, then plan again.');
  }
  if (g.native.state !== 'ok') {
    const why = {
      no_server: 'PostgreSQL is not installed in the guest',
      unreachable: 'the native PostgreSQL server did not answer (is the postgresql service running?)',
      no_database: 'the native PostgreSQL has no database named "app"',
    }[g.native.state] || 'the native PostgreSQL could not be checked';
    add(ADOPT_CODES.NO_NATIVE_DATABASE, `There is no native database to move: ${why}.`, 'Start the service (systemctl start postgresql in the guest) or deploy the app once so it creates the "app" database, then plan again.');
  }
  if (g.native.state === 'ok') {
    const needed = diskNeeded(g.native.sizeBytes);
    if (g.diskFreeBytes == null) add(ADOPT_CODES.NOT_ENOUGH_DISK, 'The guest\'s free disk space could not be read.', 'Check the guest (df -h /), then plan again.');
    else if (g.diskFreeBytes < needed) add(ADOPT_CODES.NOT_ENOUGH_DISK, `The guest has ${formatBytes(g.diskFreeBytes)} free and the adoption needs about ${formatBytes(needed)} (twice the database for the dump and the copy, plus about 3 GB for Docker and the foundation images).`, 'Free space or grow the guest\'s disk (Dev Studio → project → Resources), then plan again.');
  }
  if (g.git.head == null) add(ADOPT_CODES.NOT_MOCK2_APP, `${APP_DIR} is not a git working copy with a commit, so the platform commit has nowhere to go.`, 'Check the project repository (a rehydrate re-clones it), then plan again.');
  if (g.git.remote && g.git.remoteInHead === false) add(ADOPT_CODES.REPO_DIVERGED, 'The project repository has commits the guest\'s working copy does not have (for example a push from VS Code).', 'Bring the guest up to date (a build pulls them, or rehydrate), then plan again.');
  if ((g.git.dirty || []).includes('package.json')) add(ADOPT_CODES.PACKAGE_JSON_UNCOMMITTED, 'package.json has uncommitted changes in the guest; the platform commit would carry them.', 'Commit or discard them (a build checkpoint commits), then plan again.');
  if (g.foundationDir) add(ADOPT_CODES.FOUNDATION_DIR_PRESENT, 'The app already has a foundation/ directory, which the platform owns on a foundation project and would overwrite.', 'Rename it in a build, then plan again.');
  if (g.stackPresent) add(ADOPT_CODES.FOUNDATION_STACK_PRESENT, `The guest already has ${DEFAULT_LAYOUT.composeFile}, but the project is not a foundation project.`, 'Inspect the guest (an earlier manual attempt?) and remove the stack directory only if it holds nothing you need, then plan again.');
  const bad = secretsToMove(facts).filter((k) => !isValidSecretName(componentSecretName(k)));
  if (bad.length) add(ADOPT_CODES.SECRET_NAME_UNSUPPORTED, `The component secret(s) ${bad.join(', ')} cannot be kept in the foundation's secret store (names must be upper-case letters, digits and underscores, starting with a letter).`, 'Rename the key in the component, then plan again.');
  return out;
}

export function adoptionWarnings(facts) {
  const out = [];
  const add = (code, message) => out.push({ code, message });
  const g = facts?.guest;
  add('LOCAL_EMBEDDINGS', `Embeddings start on the local model. ${LOCAL_EMBEDDINGS_WARNING}`);
  if (g?.s3Direct?.length) add('DIRECT_S3_CLIENT', `App code outside foundation/ imports an S3 client directly (${g.s3Direct.slice(0, 4).map((h) => `${h.path}:${h.line}`).join(', ')}). On the foundation, builds refuse that until the code uses the storage adapter (import { storage } from '#foundation').`);
  const dirty = (g?.git?.dirty || []).filter((p) => p !== 'package.json');
  if (dirty.length) add('DIRTY_WORKTREE', `${dirty.length} uncommitted change(s) in the guest (${dirty.slice(0, 4).join(', ')}${dirty.length > 4 ? ', …' : ''}) are left as they are; the platform commit carries only foundation/ and package.json.`);
  if ((g?.git?.ahead || 0) > 0) add('UNPUSHED_COMMITS', `The guest has ${g.git.ahead} commit(s) the project repository does not have yet; the platform commit's push carries them too.`);
  if ((g?.envKeys || []).includes('DATABASE_URL')) add('DATABASE_URL_REMOVED', 'The DATABASE_URL line in /etc/environment (the native database\'s password URL) is removed; the app unit sets the foundation socket URL, which has no password.');
  add('ROLLBACK_RESTORES_SNAPSHOT', 'A rollback restores the whole guest to the step-1 snapshot. Anything written after it — including app data written after the adoption — is kept only in a second snapshot taken just before the rollback.');
  add('OLD_DATABASE_KEPT', 'The snapshot, the native PostgreSQL data directory and the dump are kept after the adoption, so the rollback stays available. Removing them is a separate, later action.');
  return out;
}

export function buildAdoptionPlan(facts) {
  const g = facts?.guest || null;
  const size = g?.native?.sizeBytes ?? null;
  return {
    steps: ADOPT_STEPS.map((s) => ({ name: s.name, label: s.label, summary: s.summary })),
    downtime: downtimeEstimate(size),
    database: { size_bytes: size, tables: g?.native?.state === 'ok' ? g.native.tables.length : null },
    disk: { free_bytes: g?.diskFreeBytes ?? null, needed_bytes: g?.native?.state === 'ok' ? diskNeeded(size) : null },
    secrets_to_move: secretsToMove(facts),
    features: { storage: 'on', embeddings: 'on' },
    warnings: adoptionWarnings(facts),
  };
}

// planTokenOf(facts) → sha256 hex over what the plan IS: the project and its
// guest, the commits, the tables that will be copied, the secrets that will
// move, the guest's current config and the steps. Sizes and free space are
// left out (they move while the app runs); blockers are recomputed anyway.
export function planTokenOf(facts) {
  const g = facts?.guest || {};
  const canon = {
    v: 1,
    version: FOUNDATION_VERSION,
    project: Number(facts?.project?.id),
    container: String(facts?.project?.container_name || ''),
    head: g.git?.head || null,
    remote: g.git?.remote || null,
    tables: [...(g.native?.tables || [])].sort(),
    secrets: secretsToMove(facts),
    config: guestConfigFacts(facts?.instance),
    steps: STEP_NAMES,
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

export function tokensEqual(a, b) {
  const x = String(a || ''); const y = String(b || '');
  return /^[0-9a-f]{64}$/.test(x) && x === y;
}

// ---------------------------------------------------------------------------
// Step scripts (sh -c in the guest)
// ---------------------------------------------------------------------------

export function stopAppScript(unit = APP_UNIT) {
  return [
    'set +e',
    `U=${sq(unit)}`,
    'was=$(systemctl is-enabled "$U" 2>/dev/null); echo "WAS_ENABLED:${was:-unknown}"',
    'systemctl stop "$U" >/dev/null 2>&1',
    'systemctl disable "$U" >/dev/null 2>&1',
    'if systemctl is-active --quiet "$U" 2>/dev/null; then echo "APP_STOPPED:no"; exit 1; fi',
    'echo "APP_STOPPED:yes"',
    '',
  ].join('\n');
}

export function dumpScript(adoptionId, { native = NATIVE_DEFAULT } = {}) {
  const dir = dumpDirFor(adoptionId);
  return [
    'set -eu',
    'umask 077',
    `R=${sq(DUMP_ROOT)}; D=${sq(dir)}`,
    'mkdir -p "$D"; chmod 700 "$R" "$D"',
    // The app is stopped, so nothing writes between the counts and the dump.
    `printf '%s\\n' ${sq(COUNT_SQL)} | ${nativeAs('psql -X -At -v ON_ERROR_STOP=1 -d app', native)} > "$D/counts.txt"`,
    'grep -q "^ADOPT_COUNT_DONE$" "$D/counts.txt"',
    `${nativeAs('pg_dump -Fc app', native)} > "$D/app.dump.tmp"`,
    'mv -f "$D/app.dump.tmp" "$D/app.dump"',
    'chmod 600 "$D/app.dump" "$D/counts.txt"',
    // The archive reads back (TOC) before anything else is changed.
    'pg_restore -l "$D/app.dump" > /dev/null',
    'echo "DUMP_PATH:$D/app.dump"',
    'echo "DUMP_SIZE:$(stat -c %s "$D/app.dump")"',
    'echo "DUMP_SHA256:$(sha256sum "$D/app.dump" | cut -d" " -f1)"',
    'cat "$D/counts.txt"',
    '',
  ].join('\n');
}

export function parseDump(stdout) {
  const s = String(stdout || '');
  const get = (k) => ((s.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1] || '').trim();
  const size = get('DUMP_SIZE');
  const sha = get('DUMP_SHA256');
  const { complete, counts } = parseCounts(s);
  return {
    path: get('DUMP_PATH') || null,
    size_bytes: /^\d+$/.test(size) ? Number(size) : null,
    sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null,
    countsComplete: complete,
    counts,
  };
}

// Is a TCP port listening in the guest? (ss, else /proc/net/tcp{,6}: the port
// in hex, state 0A = LISTEN.)
function portBusyFn(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`invalid port: ${port}`);
  const hex = p.toString(16).toUpperCase().padStart(4, '0');
  return `port_busy() { if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq ':${p}$'; else grep -qiE '^ *[0-9]+: [0-9A-F]+:${hex} [0-9A-F]+:[0-9A-F]+ 0A ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; fi; }`;
}

// Stop and disable the native server; its data directory is not touched. The
// foundation's PostgreSQL publishes the same port on the guest's 127.0.0.1
// (the read-only reporting role), so the port must be free afterwards.
export function stopNativeScript({ port = DEFAULT_LAYOUT.ports.postgres } = {}) {
  return [
    'set +e',
    portBusyFn(port),
    'was=$(systemctl is-enabled postgresql 2>/dev/null); echo "WAS_ENABLED:${was:-unknown}"',
    'systemctl stop postgresql >/dev/null 2>&1',
    'if command -v pg_lsclusters >/dev/null 2>&1; then',
    '  pg_lsclusters -h 2>/dev/null | while read -r ver name cport status rest; do case "$status" in online*) pg_ctlcluster "$ver" "$name" stop >/dev/null 2>&1 ;; esac; done',
    'fi',
    'systemctl disable postgresql >/dev/null 2>&1',
    'i=0; while [ $i -lt 30 ]; do',
    '  up=0',
    '  if command -v pg_lsclusters >/dev/null 2>&1; then pg_lsclusters -h 2>/dev/null | grep -q " online" && up=1; else pgrep -u postgres -x postgres >/dev/null 2>&1 && up=1; fi',
    '  [ $up -eq 0 ] && break',
    '  i=$((i + 1)); sleep 1',
    'done',
    'if [ $up -ne 0 ]; then echo "NATIVE_STOPPED:no"; exit 1; fi',
    'echo "NATIVE_STOPPED:yes"',
    'i=0; while port_busy && [ $i -lt 10 ]; do i=$((i + 1)); sleep 1; done',
    `if port_busy; then echo "PORT_FREE:no:${Number(port)}"; exit 1; fi`,
    `echo "PORT_FREE:yes:${Number(port)}"`,
    '',
  ].join('\n');
}

// Before the stack starts (after the guest restart): the port the foundation's
// PostgreSQL publishes is free, and no native cluster came back.
export function portCheckScript({ port = DEFAULT_LAYOUT.ports.postgres } = {}) {
  return [
    'set +e',
    portBusyFn(port),
    'n=0; if command -v pg_lsclusters >/dev/null 2>&1; then n=$(pg_lsclusters -h 2>/dev/null | grep -c " online"); fi',
    'echo "NATIVE_ONLINE:${n:-0}"',
    `if port_busy; then echo "PORT_FREE:no:${Number(port)}"; else echo "PORT_FREE:yes:${Number(port)}"; fi`,
    '',
  ].join('\n');
}
export function parsePortCheck(stdout) {
  const s = String(stdout || '');
  const free = s.match(/^PORT_FREE:(yes|no):(\d+)$/m) || [];
  const online = Number((s.match(/^NATIVE_ONLINE:(\d+)$/m) || [])[1]);
  return { free: free[1] === 'yes' ? true : free[1] === 'no' ? false : null, port: free[2] ? Number(free[2]) : null, nativeOnline: Number.isFinite(online) ? online : null };
}

// Restore the dump into the foundation PostgreSQL ($1 = the dump in the
// guest). Runs pg_restore INSIDE the postgres service (its version matches the
// server): the extensions first as the superuser (CREATE EXTENSION IF NOT
// EXISTS), then everything else as role app (--no-owner --no-acl
// --role=app), in ONE transaction that stops at the first error.
export function restoreScript(layout = DEFAULT_LAYOUT) {
  const inner = [
    'set -eu',
    'umask 077',
    'D=/tmp/mock2-adopt.dump; T=/tmp/mock2-adopt.toc; X=/tmp/mock2-adopt.ext; L=/tmp/mock2-adopt.rest',
    'trap \'rm -f "$D" "$T" "$X" "$L"\' EXIT',
    'cat > "$D"',
    'pg_restore -l "$D" > "$T"',
    "grep -E '^[0-9]+; [0-9]+ [0-9]+ EXTENSION ' \"$T\" > \"$X\" || true",
    "grep -vE '^[0-9]+; [0-9]+ [0-9]+ (EXTENSION |COMMENT - EXTENSION |SCHEMA - public |COMMENT - SCHEMA public )' \"$T\" > \"$L\" || true",
    'if [ -s "$X" ]; then pg_restore -U postgres -d app --no-owner --no-acl --exit-on-error -L "$X" "$D"; fi',
    'echo "RESTORE_EXTENSIONS:done"',
    'pg_restore -U postgres -d app --no-owner --no-acl --role=app --single-transaction --exit-on-error -L "$L" "$D"',
    'echo "RESTORE:done"',
  ].join('\n');
  return [
    'set -eu',
    'F="$1"',
    '[ -f "$F" ] || { echo "RESTORE:missing" >&2; exit 3; }',
    `${foundationPgExecPrefix(layout)} sh -c ${sq(inner)} < "$F"`,
    '',
  ].join('\n');
}

export const READ_ENVIRONMENT_SCRIPT = 'cat /etc/environment 2>/dev/null || true\n';

// Remove the KEY= lines of the given keys ($@) from /etc/environment; prints
// how many remain (0), never a value.
export function removeEnvironmentKeysScript({ file = '/etc/environment' } = {}) {
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(String(file)) || String(file).includes('..')) throw new Error(`invalid environment file: ${file}`);
  return [
    'set -eu',
    `F=${sq(file)}`,
    '[ -f "$F" ] || { echo "ENV_REMAINING:0"; exit 0; }',
    '[ $# -gt 0 ] || { echo "ENV_REMAINING:0"; exit 0; }',
    'pat=""',
    'for k in "$@"; do case "$k" in ""|*[!A-Za-z0-9_]*) echo "ENV_BAD_KEY" >&2; exit 2;; esac; pat="${pat:+$pat|}$k"; done',
    'T="$F.mock2-adopt-tmp"',
    'umask 022',
    'grep -vE "^[[:space:]]*(export[[:space:]]+)?($pat)[[:space:]]*=" "$F" > "$T" || true',
    'chmod 0644 "$T"; mv -f "$T" "$F"',
    'n=$(grep -cE "^[[:space:]]*(export[[:space:]]+)?($pat)[[:space:]]*=" "$F" || true)',
    'echo "ENV_REMAINING:${n:-0}"',
    '',
  ].join('\n');
}
export function parseEnvRemaining(stdout) {
  const m = String(stdout || '').match(/^ENV_REMAINING:(\d+)$/m);
  return m ? Number(m[1]) : null;
}

export const ADOPT_COMMIT_MESSAGE = `platform: adopt the application foundation (${FOUNDATION_VERSION})`;
// Files on stdin (base64 tar), committed as ONE platform commit of exactly
// foundation/ and package.json, then pushed to the project repository.
export function moduleCommitScript({ appDir = APP_DIR } = {}) {
  return [
    'set -eu',
    `A=${sq(appDir)}`,
    'cd "$A"',
    'base64 -d | tar -xf - -C "$A"',
    'git config --global --add safe.directory "$A" 2>/dev/null || true',
    'git add -- foundation package.json',
    'if git diff --cached --quiet -- foundation package.json; then echo "COMMIT:none"; else',
    `  git -c user.name="ProxyPilot Mock2" -c user.email="mock2@proxypilot.local" commit -q -m ${sq(ADOPT_COMMIT_MESSAGE)} -- foundation package.json`,
    '  echo "COMMIT:made"',
    'fi',
    'echo "HEAD:$(git rev-parse HEAD)"',
    'git push -q origin HEAD:main',
    'echo "PUSH:ok"',
    '',
  ].join('\n');
}
export function parseModuleCommit(stdout) {
  const s = String(stdout || '');
  const head = ((s.match(/^HEAD:([0-9a-f]{40})$/m) || [])[1]) || null;
  return { made: /^COMMIT:made$/m.test(s), head, pushed: /^PUSH:ok$/m.test(s) };
}

// The five Docker-ready keys: which differ from what the guest has.
export function configChanges(current = {}) {
  return Object.entries(FOUNDATION_GUEST_CONFIG).filter(([k, v]) => String(current[k] ?? '') !== String(v)).map(([key, value]) => ({ key, value: String(value) }));
}
// Back to the recorded originals: keys to set and keys to unset.
export function configRestore(original = {}, current = {}) {
  const set = []; const unset = [];
  for (const k of Object.keys(FOUNDATION_GUEST_CONFIG)) {
    const o = original[k] == null ? null : String(original[k]);
    const c = current[k] == null ? null : String(current[k]);
    if (o === c) continue;
    if (o == null) unset.push(k); else set.push({ key: k, value: o });
  }
  return { set, unset };
}

// ---------------------------------------------------------------------------
// The run's record → the API projection (never a secret value).
// ---------------------------------------------------------------------------
export function initialSteps() {
  return ADOPT_STEPS.map((s) => ({ name: s.name, state: 'pending', detail: null, started_at: null, finished_at: null }));
}

export function parseJson(text, fallback) {
  try { const v = JSON.parse(String(text ?? '')); return v ?? fallback; } catch { return fallback; }
}

export function normalizeSteps(steps) {
  const byName = new Map((Array.isArray(steps) ? steps : []).map((s) => [s?.name, s]));
  return STEP_NAMES.map((name) => {
    const s = byName.get(name) || {};
    return {
      name,
      state: STEP_STATES.includes(s.state) ? s.state : 'pending',
      detail: s.detail == null ? null : String(s.detail).slice(0, 600),
      started_at: s.started_at || null,
      finished_at: s.finished_at || null,
    };
  });
}

// rollbackAvailable(row, { running, repoMoved }) — a failed run (any step) or
// a finished one, unless its repository has moved on since (later builds).
export function rollbackAvailable(row, { running = false, repoMoved = false } = {}) {
  if (!row || running) return false;
  if (row.state === 'failed') return true;
  if (row.state === 'succeeded') return !repoMoved;
  return false;
}
export function resumeAvailable(row, { running = false } = {}) {
  if (!row || running || row.state !== 'failed') return false;
  const data = parseJson(row.data_json, {});
  return Number(row.resumable) === 1 && !data.rollback_attempted;
}

export function projectAdoption(row, { running = false, repoMoved = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    state: ADOPTION_STATES.includes(row.state) ? row.state : 'failed',
    step: row.step || null,
    steps: normalizeSteps(parseJson(row.steps_json, [])).map((s) => ({ ...s, label: stepLabel(s.name) })),
    error: row.error == null ? null : String(row.error).slice(0, 1000),
    created_at: row.created_at || null,
    finished_at: row.finished_at || null,
    rollback_available: rollbackAvailable(row, { running, repoMoved }),
    resume_available: resumeAvailable(row, { running }),
  };
}
