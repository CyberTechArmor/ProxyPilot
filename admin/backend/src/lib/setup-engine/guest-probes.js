// Setup engine — the guest probes, shared by the host runner and the backend's
// in-process executor (lib/setup-engine/deploy-op.js). Pure: every function here builds a shell
// script for `incus exec <guest> -- sh` or parses its output; nothing runs.
// The scripts print marker lines only, so silence is never read as success,
// and none of them prints a secret: the one value the credential check needs
// (the active master key, to classify the stored rows) is read into memory by
// its own script and never lands in a job row, an event or a log.
//
// The classifier and the master-key rules are the gate-one modules the deploy
// uses (admin/backend/src/mock2/auth-data-logic.js, readiness-logic.js),
// imported from the checkout the runner ships in — so the runner and the
// deploy agree, by construction, on what "the credential reads back" means.

import { authDataProbeScript, parseAuthDataProbe, normalizeDataGuard } from '../../mock2/auth-data-logic.js';
import { masterKeyRowsCode, DEV_MASTER_SECRET_LITERAL } from '../../mock2/readiness-logic.js';
import { verificationState } from './logic.js';

export const DEFAULT_UNIT = 'mock2-dev.service';
export const UNIT_RE = /^[A-Za-z0-9@._-]+\.service$/;

function unitOrThrow(unit) {
  const u = String(unit || DEFAULT_UNIT);
  if (!UNIT_RE.test(u)) throw new Error(`unit '${u}' is not a .service name`);
  return u;
}

function portOrThrow(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`port '${port}' is not a port`);
  return p;
}

// ── unit ────────────────────────────────────────────────────────────────

export function unitStatusScript(unit) {
  const u = unitOrThrow(unit);
  return [
    `if systemctl cat '${u}' >/dev/null 2>&1; then echo UNIT_LOADED:yes; else echo UNIT_LOADED:no; fi`,
    `echo "UNIT_ENABLED:$(systemctl is-enabled '${u}' 2>/dev/null || echo unknown)"`,
    `echo "UNIT_ACTIVE:$(systemctl is-active '${u}' 2>/dev/null || echo unknown)"`,
    '',
  ].join('\n');
}

export function parseUnitStatus(stdout) {
  const get = (k) => (String(stdout || '').match(new RegExp(`^${k}:(\\S+)`, 'm')) || [])[1] || null;
  const loaded = get('UNIT_LOADED');
  return {
    observed: loaded != null,
    loaded: loaded === 'yes' ? true : loaded === 'no' ? false : null,
    enabled: get('UNIT_ENABLED'),
    active: get('UNIT_ACTIVE'),
    isActive: get('UNIT_ACTIVE') === 'active',
  };
}

export function startUnitScript(unit) {
  const u = unitOrThrow(unit);
  return [
    'systemctl daemon-reload >/dev/null 2>&1 || true',
    `systemctl start '${u}' 2>&1; echo START_RC:$?`,
    `echo "UNIT_ACTIVE:$(systemctl is-active '${u}' 2>/dev/null || echo unknown)"`,
    '',
  ].join('\n');
}

export function parseStartUnit(stdout) {
  const m = String(stdout || '').match(/^START_RC:(\d+)/m);
  return { observed: !!m, rc: m ? Number(m[1]) : null, active: (String(stdout || '').match(/^UNIT_ACTIVE:(\S+)/m) || [])[1] || null };
}

// ── port ────────────────────────────────────────────────────────────────

// Same rule as the deploy's serving probe (deploy-logic servingProbeScript):
// the root answers with anything but 000 or a 5xx.
export function portProbeScript(port, tries = 15) {
  const p = portOrThrow(port);
  const n = Math.max(1, Math.min(60, Number(tries) || 15));
  return [
    'last="000"', 'i=0',
    `while [ $i -lt ${n} ]; do`,
    `  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${p}/" 2>/dev/null)`,
    '  [ -n "$code" ] && last="$code"',
    '  if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then echo "PORT_SERVING:$code"; exit 0; fi',
    '  i=$((i+1)); sleep 1',
    'done',
    'echo "PORT_NOT_SERVING:$last"',
    '',
  ].join('\n');
}

export function parsePortProbe(stdout) {
  const s = String(stdout || '');
  let m = s.match(/^PORT_SERVING:(\d{3})/m);
  if (m) return { observed: true, responding: true, code: Number(m[1]) };
  m = s.match(/^PORT_NOT_SERVING:(\d{3})/m);
  if (m) return { observed: true, responding: false, code: Number(m[1]) };
  return { observed: false, responding: null, code: null };
}

// ── application health ──────────────────────────────────────────────────

// ROOT, HEALTH and LOGIN, as the readiness probe asks them. Healthy means:
// the root and the login page answer below 500, and /api/health — when the
// app has one — answers 2xx. A 404 on /api/health is "no such endpoint",
// not a failure; a 5xx or no answer is.
export function healthScript(port) {
  const p = portOrThrow(port);
  const lines = ['set -u'];
  for (const [key, path] of [['ROOT', '/'], ['HEALTH', '/api/health'], ['LOGIN', '/login']]) {
    lines.push(`C=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${p}${path}" 2>/dev/null)`, `echo "${key}:\${C:-000}"`);
  }
  lines.push('');
  return lines.join('\n');
}

export function parseHealth(stdout) {
  const codes = {};
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/^(ROOT|HEALTH|LOGIN):(\d{3})$/);
    if (m) codes[m[1]] = Number(m[2]);
  }
  if (codes.ROOT == null) return { observed: false, healthy: null, codes, why: 'the health probe produced no output' };
  const below500 = (c) => c != null && c !== 0 && c < 500;
  const problems = [];
  if (!below500(codes.ROOT)) problems.push(`the root answered ${codes.ROOT}`);
  if (codes.HEALTH != null && codes.HEALTH !== 404 && !(codes.HEALTH >= 200 && codes.HEALTH < 300)) problems.push(`/api/health answered ${codes.HEALTH}`);
  if (codes.LOGIN != null && codes.LOGIN !== 404 && !below500(codes.LOGIN)) problems.push(`/login answered ${codes.LOGIN}`);
  return { observed: true, healthy: problems.length === 0, codes, why: problems.join('; ') || null, hasAuth: codes.LOGIN != null && codes.LOGIN !== 404 };
}

// ── the protected credential (R4) ───────────────────────────────────────

// The active key is read by its own script so the row classification can
// run on the host; the value stays in memory and is never returned in any
// result object below (only whether it is set, and whether it is the
// development literal).
export function activeKeyScript(envFile = '/etc/environment') {
  const f = String(envFile || '/etc/environment');
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(f)) throw new Error('environment file must be an absolute path');
  return `sed -n 's/^AUTH_MASTER_SECRET=//p' '${f}' 2>/dev/null | head -1 | sed -e 's/^"//' -e 's/"$//'\n`;
}

export function credentialProbeScript(guard) {
  const g = normalizeDataGuard(guard);
  if (!g) throw new Error('the data guard is not valid (table, secret_column, nonce_column, schema)');
  return authDataProbeScript(g);
}

// credentialVerdict({ guard, envKey, probeStdout }) →
//   { verified: true|false|null, code, detail } with the gate-one codes:
//   200 every stored row decrypts under the active key (verified)
//   204 nothing stored (verified vacuously — there is nothing to read back)
//   404 a row does not decrypt (NOT verified: the key and the rows disagree)
//   500 the probe could not run (unknown: deferred, never "verified")
export function credentialVerdict({ guard, envKey = '', probeStdout = '' } = {}) {
  const g = normalizeDataGuard(guard);
  if (!g) return { verified: null, code: null, detail: 'no data guard recorded for this app; the credential check was not run' };
  const probe = parseAuthDataProbe(probeStdout);
  const code = masterKeyRowsCode({ probe, envKey, legacyDefault: g.legacy_default || DEV_MASTER_SECRET_LITERAL });
  const keyState = !envKey ? 'unset' : envKey === (g.legacy_default || DEV_MASTER_SECRET_LITERAL) ? 'development-default' : 'set';
  if (code === 200) return { verified: true, code, detail: `${probe.detail}; every row decrypts under the active key (${keyState}); target ${probe.target || '?'}`, keyState };
  if (code === 204) return { verified: true, code, detail: `${probe.detail}; nothing stored to read back (${keyState})`, keyState, vacuous: true };
  if (code === 404) return { verified: false, code, detail: `${probe.detail}; at least one row does not decrypt under the active key (${keyState})`, keyState };
  return { verified: null, code, detail: `the credential probe could not run: ${probe.detail}`, keyState };
}

// ── the ladder ──────────────────────────────────────────────────────────

// verificationFromObservations({ unit, port, health, credential }) → the R4
// state. Each observation may be missing (not run): a missing rung caps the
// state, a failed rung is recovery required.
export function verificationFromObservations({ unit = null, port = null, health = null, credential = null, credentialUse = null } = {}, { pendingRungs = [] } = {}) {
  const facts = {
    pendingRungs,
    unitConfigured: unit ? unit.loaded : null,
    unitActive: unit && unit.observed ? unit.isActive : null,
    portResponding: port && port.observed ? port.responding : null,
    appHealthy: health && health.observed ? health.healthy : null,
    credentialDecryptable: credential ? credential.verified : null,
    credentialUseVerified: credentialUse ? credentialUse.verified : null,
    deferredReason: credential && credential.verified == null ? credential.detail : (credentialUse && credentialUse.verified == null ? credentialUse.detail : null),
  };
  // The unit being inactive at the moment of the status read is not a
  // failure when the port then answered (a restart race); the port decides.
  if (facts.unitActive === false && facts.portResponding === true) facts.unitActive = true;
  const v = verificationState(facts);
  return {
    ...v,
    observations: {
      unit: unit ? { loaded: unit.loaded, enabled: unit.enabled, active: unit.active } : null,
      port: port ? { responding: port.responding, code: port.code } : null,
      health: health ? { healthy: health.healthy, codes: health.codes, why: health.why } : null,
      credential: credential ? { verified: credential.verified, code: credential.code, detail: credential.detail, keyState: credential.keyState || null } : null,
      credentialUse: credentialUse ? { verified: credentialUse.verified, outcome: credentialUse.outcome || null, detail: credentialUse.detail } : null,
    },
  };
}

// ── the application-owned credential check (R4, top rung) ────────────────
//
// Signs in to the app as the platform's review account and reads the LDAPS
// settings the app's own code path serves: masterKey (current / rekeyed /
// legacy / unreadable / none) and masterKeyInventory (total, current,
// legacy, unreadable, complete). Only the application decrypting the stored
// credential with the key its process loaded reaches `verified`. The login
// travels to curl through a private temporary file inside the guest, never
// through argv, and never lands in a job row: this script is built by the
// executor from a login it holds in memory.
export function credentialUseScript(port, login) {
  const p = portOrThrow(port);
  if (!login || !login.email || !login.password) throw new Error('credentialUseScript needs a login');
  const base = `http://127.0.0.1:${p}`;
  const creds = JSON.stringify({ email: String(login.email), password: String(login.password) });
  if (/PP_CRED_EOF/.test(creds)) throw new Error('login text collides with the heredoc delimiter');
  return [
    'umask 077', 'JAR=$(mktemp)', 'CRED=$(mktemp)', "trap 'rm -f \"$JAR\" \"$CRED\"' EXIT INT TERM",
    `cat > "$CRED" <<'PP_CRED_EOF'`, creds, 'PP_CRED_EOF',
    `C=$(curl -sS -o /dev/null -c "$JAR" -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' --data-binary @"$CRED" "${base}/api/auth/login" 2>/dev/null)`,
    'echo "SIGNIN:${C:-000}"',
    `BODY=$(curl -sS -b "$JAR" -w '\\nLDAPS:%{http_code}' --max-time 10 "${base}/api/admin/ldaps" 2>/dev/null)`,
    'echo "$BODY"', '',
  ].join('\n');
}

// interpretCredentialUse(stdout) → { verified: true|false|null, outcome, detail, masterKey }
// with the distinct outcomes of logic.js CREDENTIAL_USE_OUTCOMES.
export function interpretCredentialUse(stdout) {
  const s = String(stdout || '');
  const signin = Number((s.match(/^SIGNIN:(\d{3})/m) || [])[1] || 0);
  const code = Number((s.match(/^LDAPS:(\d{3})/m) || [])[1] || 0);
  if (!s.includes('SIGNIN:') || signin === 0) return { verified: null, outcome: 'unreachable', detail: 'the application did not answer the sign-in; the application-owned credential check could not run' };
  if (signin >= 400) return { verified: null, outcome: 'no_verification_credentials', detail: `the review account could not sign in (HTTP ${signin}); the application-owned credential check could not run` };
  if (code === 0) return { verified: null, outcome: 'unreachable', detail: 'the application did not answer the LDAPS settings read' };
  if (code !== 200) return { verified: false, outcome: 'failed', detail: `the application refused the LDAPS settings read (HTTP ${code})` };
  let body;
  try {
    const jsonText = s.slice(s.indexOf('SIGNIN:')).split('\n').slice(1).join('\n').replace(/\nLDAPS:\d{3}\s*$/, '').trim();
    body = JSON.parse(jsonText);
  } catch { return { verified: false, outcome: 'failed', detail: 'the LDAPS settings answered but not with JSON the check understands' }; }
  const inv = body?.masterKeyInventory || {};
  const key = body?.masterKey || null;
  const total = Number(inv.total || 0);
  if (total === 0 && (!body?.configured || key === 'none')) return { verified: null, outcome: 'no_protected_credentials', detail: 'no stored credential to read back through the application (LDAPS not configured, inventory empty)', masterKey: key };
  const unreadable = Number(inv.unreadable || 0);
  const legacy = Number(inv.legacy || 0);
  if ((key === 'current' || key === 'rekeyed') && inv.complete === true && unreadable === 0 && legacy === 0 && Number(inv.current || 0) === total) {
    return { verified: true, outcome: 'verified', detail: `the application read its LDAPS credential back under its loaded key (masterKey ${key}, inventory ${inv.current}/${total} current)`, masterKey: key };
  }
  return { verified: false, outcome: 'failed', detail: `the running application cannot use its credential as stored (masterKey ${key || 'unknown'}, inventory current ${inv.current ?? '?'}/${total}, legacy ${legacy}, unreadable ${unreadable})`, masterKey: key };
}

// ── the migration runner (migration-aware checkpoints) ──────────────────
//
// What `npm run migrate` actually runs decides how an interrupted migration
// may be retried. The platform's own runner (scripts/migrate.mjs) applies
// migrations/*.sql in order, one transaction per file, ledgered in a
// `_migrations` table: a retry resumes at the first unapplied file and a
// half-applied file was rolled back. Anything else is unknown, and an
// interrupted unknown migration is a recovery-required condition, not a
// retry.
export function migrateScriptClassScript(appDir) {
  const d = String(appDir || '/srv/app');
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(d)) throw new Error('appDir must be an absolute path');
  return `grep -o '"migrate"[[:space:]]*:[[:space:]]*"[^"]*"' '${d}/package.json' 2>/dev/null | head -1 | sed 's/^/MIGRATE_SCRIPT:/'\n[ -d '${d}/migrations' ] && echo "MIGRATIONS_DIR:yes" || echo "MIGRATIONS_DIR:no"\n`;
}

export function classifyMigrateScript(stdout, contractMigrate = null) {
  const s = String(stdout || '');
  const m = s.match(/^MIGRATE_SCRIPT:"migrate"\s*:\s*"([^"]*)"/m);
  const script = m ? m[1] : null;
  const dir = /^MIGRATIONS_DIR:yes/m.test(s);
  const cmd = script || contractMigrate || null;
  if (!cmd) return { command: null, ledger: null, retry: 'none', note: 'no migration command' };
  if (/scripts\/migrate\.mjs/.test(cmd)) return { command: cmd, ledger: '_migrations', perFileTransaction: true, retry: 'resume', note: 'the platform migration runner: ledgered, one transaction per file, idempotent — a retry resumes at the first unapplied file', migrationsDir: dir };
  if (/drizzle-kit migrate|drizzle-orm\/migrator|prisma migrate deploy|knex migrate:latest/.test(cmd)) return { command: cmd, ledger: 'framework', perFileTransaction: null, retry: 'resume', note: 'a ledgered framework migrator; retries resume at the first unapplied migration', migrationsDir: dir };
  return { command: cmd, ledger: null, perFileTransaction: null, retry: 'unknown', note: 'an unrecognised migration command: its idempotency is not established, so an interrupted migration is recovery-required rather than retried', migrationsDir: dir };
}

// ── containment of a job's transient processes ──────────────────────────
//
// Every script a job runs in the guest is placed in a CGROUP that belongs to
// the job, so everything it spawns — marked or not, in its session or in a
// new one it made with setsid() — stays findable and killable as a group.
// Sessions and markers are not containment: a child that calls setsid()
// leaves its parent's session, and a marker only names the shell that
// carried it. A cgroup follows every descendant.
//
// Mechanism, chosen by what the guest has, in this order:
//   systemd   a transient scope unit per script (systemd-run --scope), the
//             right form on a systemd guest (every Incus guest ProxyPilot
//             provisions): the scope's cgroup is the containment, and
//             `systemctl kill --kill-whom=all` is the reaper.
//   cgroup2   a raw cgroup under the unified hierarchy (cgroup.kill).
//   cgroup1   a raw cgroup under the pids controller (freeze-less kill loop).
// If NONE is available the script prints CONTAINMENT:none to stderr, runs
// nothing, and exits 97: the operation refuses rather than running under
// weaker containment. There is no silent fallback to sessions.
//
// Cleanup (reapStaleWritersScript) targets OTHER jobs only: it reads the
// units and cgroups recorded under RUN_DIR/<jobId>.*, kills each as a group,
// waits, counts live survivors (zombies do not count), and removes what is
// empty. The current job's own groups and everything outside them — the
// application's own service lives in systemd's cgroup for its unit, never
// in ours — are untouched. What remains alive is reported as
// STALE_WRITERS:<n>, and a non-zero count is a recovery-required condition.
export const CONTAINMENT_RUN_DIR = '/run/mock2-deploy';
export const CONTAINMENT_UNAVAILABLE_RC = 97;
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// The cgroup roots, in preference order; tests point these at a temp tree.
export const CGROUP_ROOTS = Object.freeze({ v2: '/sys/fs/cgroup', v1pids: '/sys/fs/cgroup/pids' });

export function containedScript(jobId, body, { runDir = CONTAINMENT_RUN_DIR, cgroupV2Root = CGROUP_ROOTS.v2, cgroupV1Root = CGROUP_ROOTS.v1pids, allowSystemd = true } = {}) {
  const id = String(jobId || 'adhoc');
  if (!JOB_ID_RE.test(id)) throw new Error('job id must be a plain identifier');
  for (const pth of [runDir, cgroupV2Root, cgroupV1Root]) if (!/^\/[A-Za-z0-9._\/-]+$/.test(pth)) throw new Error('containment paths must be absolute');
  const b64 = Buffer.from(String(body), 'utf8').toString('base64');
  return [
    `: ${'mock2_deploy_marker'} job=${id}`,
    `RUN='${runDir}'; ID='${id}'`,
    `mkdir -p "$RUN" 2>/dev/null || true`,
    `T=$(mktemp "$RUN/$ID.XXXXXX" 2>/dev/null || mktemp)`,
    `printf '%s' '${b64}' | base64 -d > "$T"`,
    `N=$(date +%s%N 2>/dev/null || echo $$)`,
    // systemd: a transient scope per script.
    allowSystemd
      // A probe scope first: a systemd that is present but cannot start a
      // scope (no bus yet) falls through to a raw cgroup instead of failing
      // the body with an unrelated error.
      ? `if [ -d /run/systemd/system ] && command -v systemd-run >/dev/null 2>&1 && systemd-run --scope --quiet --unit="mock2-deploy-probe-$$-$N" true >/dev/null 2>&1; then U="mock2-deploy-$ID-$N"; echo "$U.scope" >> "$RUN/$ID.units"; echo "CONTAINMENT:systemd $U.scope" >&2; exec systemd-run --scope --quiet --unit="$U" --property=KillMode=control-group sh -c ': mock2_deploy_marker job='"$ID"'; . "$1"; rc=$?; rm -f "$1"; exit $rc' sh "$T"; fi`
      : ': no systemd path in this build',
    // raw cgroup: v2 (cgroup.kill) first, then v1 pids.
    `G=''; KIND=''`,
    `if [ -f '${cgroupV2Root}/cgroup.controllers' ] && mkdir -p '${cgroupV2Root}/mock2-deploy/'"$ID" 2>/dev/null && echo $$ > '${cgroupV2Root}/mock2-deploy/'"$ID/cgroup.procs" 2>/dev/null; then G='${cgroupV2Root}/mock2-deploy/'"$ID"; KIND=cgroup2; fi`,
    `if [ -z "$G" ] && [ -d '${cgroupV1Root}' ] && mkdir -p '${cgroupV1Root}/mock2-deploy/'"$ID" 2>/dev/null && echo $$ > '${cgroupV1Root}/mock2-deploy/'"$ID/cgroup.procs" 2>/dev/null; then G='${cgroupV1Root}/mock2-deploy/'"$ID"; KIND=cgroup1; fi`,
    `if [ -z "$G" ]; then echo "CONTAINMENT:none" >&2; rm -f "$T"; exit ${CONTAINMENT_UNAVAILABLE_RC}; fi`,
    `grep -qx "$G" "$RUN/$ID.cgroups" 2>/dev/null || echo "$G" >> "$RUN/$ID.cgroups"`,
    `echo "CONTAINMENT:$KIND $G" >&2`,
    `: mock2_deploy_marker job=$ID; . "$T"; rc=$?; rm -f "$T"; exit $rc`,
    '',
  ].join('\n');
}

// parseContainment(stderr) → { kind, ref } | null from the CONTAINMENT line.
export function parseContainment(stderr) {
  const m = String(stderr || '').match(/^CONTAINMENT:(systemd|cgroup2|cgroup1|none)(?: (\S+))?/m);
  return m ? { kind: m[1], ref: m[2] || null } : null;
}

// reapStaleWritersScript(currentJobId) → kills every group another job
// recorded (scope units, cgroups), then the legacy marker scripts that carry
// no job id or another one, waits, and reports live survivors as
// `STALE_WRITERS:<n>`. Records whose groups are empty are removed.
export function reapStaleWritersScript(currentJobId, { runDir = CONTAINMENT_RUN_DIR } = {}) {
  const id = String(currentJobId || 'adhoc');
  if (!JOB_ID_RE.test(id)) throw new Error('job id must be a plain identifier');
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(runDir)) throw new Error('runDir must be an absolute path');
  return [
    `RUN='${runDir}'; CUR='${id}'; me=$$`,
    // A killed process nobody has reaped yet is a zombie, not a writer.
    'alive() { st=$(sed -E "s/^[^)]*\\) //" /proc/$1/stat 2>/dev/null | cut -d" " -f1); [ -n "$st" ] && [ "$st" != "Z" ] && [ "$st" != "X" ]; }',
    'others() { for f in "$RUN"/*."$1"; do [ -e "$f" ] || continue; b=$(basename "$f" ".$1"); [ "$b" = "$CUR" ] && continue; echo "$f"; done; }',
    'live_in() { c=0; for p in $(cat "$1" 2>/dev/null); do [ "$p" = "$me" ] && continue; alive "$p" && c=$((c + 1)); done; echo $c; }',
    // 1) systemd scopes of other jobs.
    'for f in $(others units); do for u in $(cat "$f" 2>/dev/null); do systemctl kill --signal=KILL --kill-whom=all "$u" >/dev/null 2>&1 || true; done; done',
    // 2) raw cgroups of other jobs: cgroup.kill where the kernel has it, a kill loop otherwise.
    'for f in $(others cgroups); do for g in $(cat "$f" 2>/dev/null); do [ -d "$g" ] || continue; if [ -f "$g/cgroup.kill" ]; then echo 1 > "$g/cgroup.kill" 2>/dev/null || true; else for p in $(cat "$g/cgroup.procs" 2>/dev/null); do [ "$p" = "$me" ] || kill -9 "$p" 2>/dev/null || true; done; fi; done; done',
    // 3) legacy marker scripts (pre-containment deploys) that are not ours.
    `for p in $(pgrep -f mock2_deploy_marker 2>/dev/null); do [ "$p" = "$me" ] && continue; c=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null); case "$c" in *"job=$CUR"*) ;; *) kill -9 "$p" 2>/dev/null || true;; esac; done`,
    'sleep 1',
    'n=0',
    // Count what is still alive in each group; drop the records of empty ones.
    'for f in $(others units); do left=0; for u in $(cat "$f" 2>/dev/null); do cg=$(systemctl show -p ControlGroup --value "$u" 2>/dev/null); if [ -n "$cg" ] && [ -f "/sys/fs/cgroup$cg/cgroup.procs" ]; then left=$((left + $(live_in "/sys/fs/cgroup$cg/cgroup.procs"))); elif systemctl is-active --quiet "$u" 2>/dev/null; then left=$((left + 1)); fi; done; n=$((n + left)); [ "$left" -eq 0 ] && rm -f "$f"; done',
    'for f in $(others cgroups); do left=0; for g in $(cat "$f" 2>/dev/null); do [ -d "$g" ] || continue; l=$(live_in "$g/cgroup.procs"); left=$((left + l)); [ "$l" -eq 0 ] && rmdir "$g" 2>/dev/null; done; n=$((n + left)); [ "$left" -eq 0 ] && rm -f "$f"; done',
    `for p in $(pgrep -f mock2_deploy_marker 2>/dev/null); do [ "$p" = "$me" ] && continue; alive "$p" || continue; c=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null); case "$c" in *"job=$CUR"*) ;; *) n=$((n + 1));; esac; done`,
    'echo "STALE_WRITERS:$n"',
    '',
  ].join('\n');
}

export function parseStaleWriters(stdout) {
  const m = String(stdout || '').match(/^STALE_WRITERS:(\d+)/m);
  return m ? Number(m[1]) : null;
}

// ── protected copies before the first incompatible mutation ─────────────
//
// Taken while the old application still runs and before the migration: a
// database dump in the directory the existing restore_project_db primitive
// restores from, a copy of the unit file and of the environment file (0600),
// the deployed commit and the migration command. Every line is a marker, so
// a copy that could not be taken is recorded as such, never assumed.
export const DB_DUMPS_DIR = '/var/backups/proxypilot-db';
export function protectedCopiesScript(jobId, { appDir = '/srv/app', unitPath = '/etc/systemd/system/mock2-dev.service', environmentFile = '/etc/environment', dumpsDir = DB_DUMPS_DIR, withDatabase = true } = {}) {
  const id = String(jobId || 'adhoc');
  if (!JOB_ID_RE.test(id)) throw new Error('job id must be a plain identifier');
  for (const pth of [appDir, unitPath, environmentFile, dumpsDir]) if (!/^\/[A-Za-z0-9._\/-]+$/.test(pth)) throw new Error('paths must be absolute');
  return [
    withDatabase
      ? `D='${dumpsDir}'; mkdir -p "$D" 2>/dev/null; f="$D/app-pre-deploy-${id}.sql"; if command -v pg_dump >/dev/null 2>&1; then if su - postgres -c "pg_dump --clean --if-exists app" > "$f.tmp" 2>/dev/null; then mv -f "$f.tmp" "$f" && chmod 600 "$f" && echo "DBDUMP:$f:$(wc -c < "$f" | tr -d ' '):$(sha256sum "$f" | cut -d' ' -f1)"; else rm -f "$f.tmp"; echo "DBDUMP:none:pg_dump failed"; fi; else echo "DBDUMP:none:no pg_dump"; fi`
      : 'echo "DBDUMP:skipped:no migration command"',
    `if [ -f '${unitPath}' ]; then cp -p '${unitPath}' '${unitPath}.pre-${id}' && echo "UNITCOPY:${unitPath}.pre-${id}"; else echo "UNITCOPY:none:no unit yet"; fi`,
    `umask 077; if [ -f '${environmentFile}' ]; then cp -p '${environmentFile}' '${environmentFile}.pre-${id}' && chmod 600 '${environmentFile}.pre-${id}' && echo "ENVCOPY:${environmentFile}.pre-${id}"; else echo "ENVCOPY:none:no environment file"; fi`,
    `git -C '${appDir}' rev-parse HEAD 2>/dev/null | sed 's/^/COMMIT:/'`,
    migrateScriptClassScript(appDir),
  ].join('\n');
}

export function parseProtectedCopies(stdout) {
  const s = String(stdout || '');
  const get = (k) => (s.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1] || null;
  const dump = get('DBDUMP');
  let dbDump = null;
  if (dump && !/^(none|skipped)/.test(dump)) {
    const m = dump.match(/^(\/\S+):(\d+):([0-9a-f]{64})$/);
    dbDump = m ? { path: m[1], bytes: Number(m[2]), sha256: m[3] } : { path: dump.split(':')[0], bytes: null, sha256: null };
  }
  const unit = get('UNITCOPY');
  const env = get('ENVCOPY');
  const commit = get('COMMIT');
  return {
    dbDump,
    dbDumpNote: dump && /^(none|skipped)/.test(dump) ? dump : null,
    unitCopy: unit && !/^none/.test(unit) ? unit : null,
    envCopy: env && !/^none/.test(env) ? env : null,
    commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
  };
}
