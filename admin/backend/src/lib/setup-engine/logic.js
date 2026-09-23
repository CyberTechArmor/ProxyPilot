import { jobSchema as vaultwardenJobSchema, VAULTWARDEN_APP } from './vaultwarden-logic.js';
import { jobSchema as openbaoJobSchema, OPENBAO_APP } from './openbao-logic.js';
import { infisicalJobSchema, INFISICAL_APP } from './infisical-logic.js';
import { pomeriumJobSchema, POMERIUM_APP } from './pomerium-logic.js';
// Setup engine — the PURE decision layer (docs/core/setup-engine-requirements.md
// R1, R2, R4). No I/O, no database, no clock of its own: every function takes
// the rows and the time it needs and returns a decision, so store.js (the SQL
// half), the backend's container lock, the host runner and the suite all
// drive the same rules.
//
// Vocabulary:
//   lock     one exclusive lease per app (an Incus guest name), held by the
//            OPERATION that does the work — never by the request that asked.
//            A lease expires; an expired lease with a dead holder is a
//            RECORDED condition ("stale"), never a free lock. Only a reconciler
//            takes it over, and the takeover bumps the epoch.
//   epoch    the fencing token. Every write a worker makes on a job or lock
//            carries the epoch it acquired; a write with an old epoch changes
//            nothing, so a stale worker cannot touch a target whose ownership
//            moved (R2 "prevent duplicate execution and stale workers").
//   job      a persisted operation: identity, approved plan, progress,
//            checkpoints and recoverable configuration REFERENCES (paths,
//            names, ports — never values). The checkpoint written before a
//            disruptive step is what a reconciler reads after a crash.
//   state    the verification ladder (R4): configured → port responding →
//            application healthy → credential verified; recovery required is
//            the recorded failure to climb it. Nothing is "recovered" because
//            a port opened.

import { keycloakJobSchema, KEYCLOAK_APP } from './keycloak-logic.js';
import { validateLifecycleParams } from './lifecycle-logic.js';
import { validateSetupParams } from './setup-logic.js';
import { validateConfigParams } from './config-logic.js';

export const HOLDER_KINDS = Object.freeze(['backend', 'runner', 'cli']);

// Thrown by a job's fence when its owner or epoch moved: the executor stops
// before its next guest command and writes nothing more (its writes would
// change nothing anyway).
export class FencedError extends Error {
  constructor(jobId) {
    super(`job ${jobId}: ownership moved (heartbeat changed nothing); stopping without touching the target`);
    this.name = 'FencedError';
    this.code = 'FENCED';
  }
}

// Thrown by a job's fence when a cancel was requested and the operation is
// at a safe point (before its disruptive step). After the disruptive step a
// cancel is NOT honoured mid-way: the operation finishes starting the app,
// and the cancel is recorded as declined with the reason.
export class CancelledError extends Error {
  constructor(jobId, by) {
    super(`job ${jobId}: cancelled${by ? ` by ${by}` : ''} at a safe checkpoint`);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}
export const DEFAULT_LEASE_MS = 30_000;
export const JOB_STATUS = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'deferred', 'refused', 'recovery_required', 'cancelled']);
export const TERMINAL_STATUS = Object.freeze(['succeeded', 'failed', 'deferred', 'refused', 'recovery_required', 'cancelled']);
export const VIA = Object.freeze(['ui', 'cli', 'mcp', 'runner', 'system']);

// Job kinds the HOST RUNNER may execute. A job whose kind is not here is never
// claimed by it — the browser-facing API can only ask for one of these, and
// none of them takes a command, a path outside the guest, or a value that is
// a secret.
// The Incus lifecycle and snapshot verbs (A-17.2 … A-17.5) are runner jobs
// too; their parameters and fixed commands live in lifecycle-logic.js.
export const LIFECYCLE_JOB_KINDS = Object.freeze(['instance_create', 'instance_start', 'instance_stop', 'instance_restart', 'instance_delete', 'snapshot_create', 'snapshot_delete']);
// The post-launch / post-start guest setup (A-17.7) is a runner job too; its
// phases, parameters and scripts live in setup-logic.js. (Both lists are
// spelled out here because of the import cycle; the suite checks they agree.)
export const SETUP_JOB_KINDS = Object.freeze(['guest_setup']);
// The guest configuration verbs (A-17.8) — config keys, devices, the
// address pin, port forwards, egress — are runner jobs too; their
// parameters, fixed commands and read-backs live in config-logic.js.
export const CONFIG_JOB_KINDS = Object.freeze(['config_set', 'device_add', 'device_remove', 'network_pin', 'forward_apply', 'forward_remove', 'egress_set']);
export const RUNNER_JOB_KINDS = Object.freeze(['deploy', 'recover_app', 'verify_app', 'probe', 'restore_db', 'restore_snapshot', 'retry_secrets', ...LIFECYCLE_JOB_KINDS, ...SETUP_JOB_KINDS, ...CONFIG_JOB_KINDS, 'keycloak_setup', 'pomerium_apply', 'infisical_apply', 'openbao_apply', 'full_platform_apply', 'vaultwarden_apply']);
// The kinds that MUTATE a guest or its storage: one at a time per app, and an
// exclusive kind is refused (never queued behind) while any of them is open.
export const MUTATING_JOB_KINDS = Object.freeze(['vaultwarden_apply', 'configure_vaultwarden_route', 'openbao_apply', 'full_platform_apply', 'openbao_operator', 'configure_openbao_route', 'infisical_apply', 'configure_infisical_route', 'pomerium_apply', 'configure_pomerium_routes', 'keycloak_setup', 'configure_keycloak_route', 'verify_sso', 'configure_recovery_route', 'deploy', 'recover_app', 'restore_db', 'restore_snapshot', 'retry_secrets', ...LIFECYCLE_JOB_KINDS, ...SETUP_JOB_KINDS, ...CONFIG_JOB_KINDS, 'configure_routes']);
// A restore is destructive, and a lifecycle verb is an operator's immediate
// action on a guest: neither waits for a held lease (it would run minutes
// later under a state its operator never looked at) — refused, and refused
// again rather than queued when no executor is available. A guest setup
// submitted directly (a retry, an operator's request) is the same; queued as
// a FOLLOW-UP of a create / start / restart it waits instead (executor).
export const EXCLUSIVE_JOB_KINDS = Object.freeze(['restore_db', 'restore_snapshot', ...LIFECYCLE_JOB_KINDS, ...SETUP_JOB_KINDS, ...CONFIG_JOB_KINDS]);
// Job kinds the BACKEND records for the operations it still executes itself
// (they hold the same lock; the runner recovers them when the backend dies).
// The two restores and the retry mint moved to the runner (A-13…A-15);
// their pre-move records keep the old kind names in history. `configure_routes`
// (A-17.7) is the backend's by design: ProxyPilot's own route rows and its
// Caddy render, queued by the guest setup and drained by the backend.
export const BACKEND_JOB_KINDS = Object.freeze(['configure_vaultwarden_route', 'configure_openbao_route', 'configure_infisical_route', 'configure_pomerium_routes', 'credential_migration', 'configure_routes', 'configure_keycloak_route', 'verify_sso', 'configure_recovery_route']);
export const LEGACY_BACKEND_JOB_KINDS = Object.freeze(['restore_project_db', 'retry-secrets']);
// A runner is live when its heartbeat is younger than this.
export const RUNNER_LIVE_MS = 30_000;

// ── who may execute (installation policy, never a request parameter) ────
//
// SETUP_EXECUTOR_POLICY in the installation's .env:
//   runner-required   the host runner executes every job; with no live
//                     runner a submission is QUEUED and reported unavailable —
//                     the backend never executes in its own (privileged)
//                     process. install.sh and update.sh write this.
//   backend-allowed   the legacy / development executor: with no live runner
//                     the backend claims and executes queued jobs itself, with
//                     the same code, record and locking rules. The default
//                     when the variable is absent (a checkout with no .env).
export const EXECUTOR_POLICIES = Object.freeze(['runner-required', 'backend-allowed']);
export const EXECUTOR_POLICY_KEY = 'SETUP_EXECUTOR_POLICY';
export function executorPolicy(env = process.env) {
  const raw = String(env?.[EXECUTOR_POLICY_KEY] || '').trim().toLowerCase();
  if (raw === 'runner-required') return { mode: 'runner-required', source: 'env' };
  if (raw === 'backend-allowed') return { mode: 'backend-allowed', source: 'env' };
  if (raw) return { mode: 'runner-required', source: 'env', invalid: raw, note: `unknown ${EXECUTOR_POLICY_KEY} '${raw}': treated as runner-required (the safe reading)` };
  return { mode: 'backend-allowed', source: 'default' };
}

// The application-owned credential check's outcomes — each a distinct fact.
export const CREDENTIAL_USE_OUTCOMES = Object.freeze({
  verified: 'verified',                               // the app read every stored credential back under its loaded key
  failed: 'failed',                                   // the app reports unreadable or legacy rows, or refused the read
  no_protected_credentials: 'no_protected_credentials', // nothing stored to read back (LDAPS not configured, inventory empty)
  no_verification_credentials: 'no_verification_credentials', // no review-account login on this platform for this app
  unreachable: 'unreachable',                         // the app did not answer the sign-in or the settings read
  not_applicable: 'not_applicable',                   // no data guard: the app has no protected credential at all
  superseded: 'superseded',                           // the guest no longer runs the revision this check was queued for
});

export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;

// ── identity ────────────────────────────────────────────────────────────

// ownerIdentity({ kind, host, pid, instance }) → 'backend@host#pid:instance'.
// The instance id is fresh per process start, so a restarted backend is a
// DIFFERENT owner from the one that died — its old leases go stale on their
// own, and the boot sweep recognises them as its predecessor's by kind+host.
export function ownerIdentity({ kind, host, pid, instance }) {
  if (!HOLDER_KINDS.includes(kind)) throw new Error(`unknown holder kind '${kind}'`);
  return `${kind}@${String(host || 'host').replace(/[^A-Za-z0-9._-]/g, '_')}#${Number(pid) || 0}:${String(instance || '').replace(/[^A-Za-z0-9-]/g, '')}`;
}

export function parseOwner(owner) {
  const m = /^(backend|runner|cli)@([^#]+)#(\d+):([A-Za-z0-9-]*)$/.exec(String(owner || ''));
  if (!m) return null;
  return { kind: m[1], host: m[2], pid: Number(m[3]), instance: m[4] };
}

// ── leases ──────────────────────────────────────────────────────────────

export function leaseExpiry(nowMs, leaseMs = DEFAULT_LEASE_MS) {
  return new Date(nowMs + Math.max(1000, Number(leaseMs) || DEFAULT_LEASE_MS)).toISOString();
}

export function leaseExpired(row, nowMs) {
  if (!row || !row.lease_expires_at) return true;
  const t = Date.parse(row.lease_expires_at);
  return !Number.isFinite(t) || t <= nowMs;
}

// lockVerdict({ lock, owner, nowMs }) →
//   { ok: true, reason: 'free' | 'reasserted' }
//   { ok: false, reason: 'held', holder, operation, since }      a live lease
//   { ok: false, reason: 'stale', holder, operation, since, expiredAt }
// A stale lease is refused to an ordinary acquirer: somebody must look at what
// the dead holder left (a reconciler's takeover), and that is recorded.
export function lockVerdict({ lock, owner, nowMs }) {
  if (!lock) return { ok: true, reason: 'free' };
  if (lock.owner === owner) return { ok: true, reason: 'reasserted' };
  const base = { holder: lock.owner, operation: lock.operation, since: lock.acquired_at, jobId: lock.job_id || null };
  if (!leaseExpired(lock, nowMs)) return { ok: false, reason: 'held', ...base };
  return { ok: false, reason: 'stale', ...base, expiredAt: lock.lease_expires_at };
}

// leaseHold({ lock, recordingJob }) → { hold: true, reason } when the stale
// lease records an UNRESOLVED condition: a lifecycle verb (a restart or
// create whose result the record could not establish), or a guest setup
// whose init script's completion is unknown (A-17.7: an unknown writer may
// still be changing the guest). No job kind takes it over — not a recovery,
// not a verification, not a probe, not a retry — because a takeover releases
// the lease when it finishes, and a diagnostic check clearing the condition
// would let a conflicting operation in. Only an operator's acknowledgement
// clears it (for an init: one that establishes the writer stopped). Any
// other stale lease (a dead deploy with a recovery queued) is the
// reconciler's to take over as before.
export function leaseHold({ lock, recordingJob = null }) {
  if (!lock || !lock.stale_since || !lock.recovery_job_id) return { hold: false };
  const j = recordingJob && String(recordingJob.id) === String(lock.recovery_job_id) ? recordingJob : null;
  if (j && LIFECYCLE_JOB_KINDS.includes(j.kind) && j.status === 'recovery_required' && j.outcome === 'interrupted_uncertain') {
    return { hold: true, reason: `an unresolved ${j.kind} (job ${j.id}) left ${lock.app} in an unknown state; the lease is held until an operator acknowledges that job (POST /api/setup/jobs/${j.id}/acknowledge)` };
  }
  if (j && SETUP_JOB_KINDS.includes(j.kind) && j.status === 'recovery_required' && j.outcome === 'init_uncertain') {
    return { hold: true, reason: `the init script of ${lock.app} has an unknown outcome (job ${j.id}); the lease is held until an operator establishes its writer has stopped and acknowledges that job (POST /api/setup/jobs/${j.id}/acknowledge with writerStopped: true)` };
  }
  return { hold: false };
}

// takeoverVerdict({ lock, nowMs }) → whether a reconciler may take a lock over.
// Only a STALE lease may be taken; a live one is somebody's work in progress.
export function takeoverVerdict({ lock, nowMs }) {
  if (!lock) return { ok: false, reason: 'no_lock' };
  if (!leaseExpired(lock, nowMs)) return { ok: false, reason: 'held', holder: lock.owner };
  return { ok: true, reason: 'stale', holder: lock.owner, epoch: Number(lock.epoch) || 0 };
}

// ── redaction ───────────────────────────────────────────────────────────
//
// Job rows and events are readable by every administrator, so nothing that
// could be a secret may land in them. Two nets: a key-name net (any field
// whose name says secret/password/token/…) and a value net (bcrypt hashes,
// ProxyPilot's enc:v1 envelopes, long hex, PEM blocks, URLs with a password,
// KEY=value lines for known secret names).

export const SECRET_KEY_RE = /(secret|password|passwd|pwd|token|api[-_]?key|private[-_]?key|credential|nonce|authorization|cookie|session|master[-_]?key|jwt|vapid|bind_pw)/i;
const SECRET_VALUE_RES = [
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g,                       // bcrypt
  /enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]*/g,                     // lib/secrets.js envelope
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[0-9a-fA-F]{48,}\b/g,                                     // long hex (keys, hashes)
  /([a-z][a-z0-9+.-]*:\/\/[^:\/\s]+:)([^@\/\s]+)(@)/gi,        // URL passwords
  /\b((?:AUTH_)?(?:JWT|MASTER|SESSION|TOTP_ENCRYPTION|API|SECRET|PRIVATE)[A-Z_]*(?:SECRET|KEY|TOKEN)S?)=([^\s'"]+)/g, // KEY=value
];
export const REDACTED = '[redacted]';

export function redactText(text) {
  let s = String(text ?? '');
  s = s.replace(SECRET_VALUE_RES[0], REDACTED);
  s = s.replace(SECRET_VALUE_RES[1], REDACTED);
  s = s.replace(SECRET_VALUE_RES[2], REDACTED);
  s = s.replace(SECRET_VALUE_RES[3], REDACTED);
  s = s.replace(SECRET_VALUE_RES[4], `$1${REDACTED}$3`);
  s = s.replace(SECRET_VALUE_RES[5], `$1=${REDACTED}`);
  return s;
}

// redact(value) → a deep copy with secret-looking keys and values replaced.
// Arrays and plain objects are walked; anything else is stringified through
// redactText when it is a string and left alone otherwise.
export function redact(value, depth = 0) {
  if (depth > 12) return REDACTED;
  if (value == null) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // A key that NAMES a secret is a reference, not a value: secret_column,
    // key_path, token_count, has_password… stay. A key that HOLDS one goes.
    // Only a STRING under such a key is a value that could be the secret; an
    // object is a record about it (walked), a number or boolean a fact.
    if (typeof v === 'string' && SECRET_KEY_RE.test(k) && !/_(name|names|path|paths|ref|refs|present|count|set|key_names|keys|column|columns|table|tables|file|files|dir|kind|state|id|ids)$/i.test(k) && !/^(has_|is_|n_)/i.test(k)) {
      out[k] = REDACTED;
    } else if (typeof v === 'string' && /^(sha256|sha512|digest|fingerprint|[a-z_]*_sha256|[a-z_]*_digest)$/i.test(k) && /^[0-9a-f]{32,128}$/i.test(v)) {
      // A content hash under a key that SAYS it is one is an identity (a
      // protected copy's sha256, revalidated on retry), not a key value.
      out[k] = v;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

// sanitizeReason(text) → a redacted, single-paragraph reason of bounded size.
export function sanitizeReason(text, max = 600) {
  const s = redactText(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── verification ladder (R4) ────────────────────────────────────────────

export const VERIFY_STATES = Object.freeze(['unconfigured', 'configured', 'port_responding', 'app_healthy', 'credential_decryptable', 'credential_use_verified', 'recovery_required']);

// verificationState(obs) → { state, label, facts, next }. Each fact is
// true / false / null (not checked). The ladder is monotonic: a higher rung
// counts only when every rung below it holds. A rung that FAILED (false)
// below the top means recovery is required; a rung that was not checked
// (null) simply caps the state — "port responding" is never promoted to
// "application healthy" because the health check did not run.
//
// Two credential rungs, deliberately distinct: `credential_decryptable` is
// the platform's classifier opening the stored rows with the configured key
// (evidence about the data and the file); `credential_use_verified` is the
// APPLICATION reading its protected credential back through its own code
// path with the key its process loaded. The first never becomes the second
// by relabelling.
export function verificationState({ unitConfigured = null, unitActive = null, portResponding = null, appHealthy = null, credentialDecryptable = null, credentialUseVerified = null, credentialVerified = undefined, deferredReason = null, pendingRungs = [] } = {}) {
  // `credentialVerified` is the pre-split name for the classifier rung.
  if (credentialVerified !== undefined && credentialDecryptable === null) credentialDecryptable = credentialVerified;
  const facts = { unitConfigured, unitActive, portResponding, appHealthy, credentialDecryptable, credentialUseVerified };
  const rungs = [
    ['configured', unitConfigured],
    ['port_responding', unitActive === false ? false : portResponding],
    ['app_healthy', appHealthy],
    ['credential_decryptable', credentialDecryptable],
    ['credential_use_verified', credentialUseVerified],
  ];
  let state = 'unconfigured';
  let next = 'configure the application unit';
  let pending = [];
  for (const [name, fact] of rungs) {
    if (fact === true) { state = name; next = nextStep(name); continue; }
    if (fact === false) return { state: 'recovery_required', label: LABELS.recovery_required, facts, failedAt: name, next: recoveryStep(name), deferredReason: deferredReason || null, pending: [] };
    // null: not checked — stop climbing, keep what is proven. A rung that a
    // follow-up job WILL check is listed as pending: the state is not final.
    if (pendingRungs.includes(name)) { pending = pendingRungs.filter((r) => rungs.some(([n, f]) => n === r && f == null)); next = `${nextStep(state)} — pending: ${pending.join(', ')}`; break; }
    next = `${nextStep(state)} (${name.replace(/_/g, ' ')} was not checked${deferredReason ? `: ${deferredReason}` : ''})`;
    break;
  }
  return { state, label: LABELS[state], facts, failedAt: null, next, deferredReason: deferredReason || null, pending };
}

const LABELS = Object.freeze({
  unconfigured: 'not configured',
  configured: 'configured (unit present; not verified running)',
  port_responding: 'running: port responding (not verified healthy)',
  app_healthy: 'application healthy (stored credential not checked)',
  credential_decryptable: 'application healthy; the stored credential decrypts under the configured key (not yet read back through the application)',
  credential_use_verified: 'application healthy and the application itself reads its protected credential back',
  recovery_required: 'recovery required',
});

function nextStep(state) {
  switch (state) {
    case 'configured': return 'start the unit and probe the port';
    case 'port_responding': return 'run the application health check';
    case 'app_healthy': return 'classify the stored credential rows under the configured key';
    case 'credential_decryptable': return 'read the protected credential back through the application (sign in as the review account and read the LDAPS settings: masterKey current, inventory complete)';
    case 'credential_use_verified': return 'nothing — verified';
    default: return 'configure the application unit';
  }
}
function recoveryStep(rung) {
  switch (rung) {
    case 'configured': return 'the unit is missing or invalid: redeploy, or restore the unit file from the last checkpoint';
    case 'port_responding': return 'the unit is not serving: read its journal (journalctl -u mock2-dev.service), start it, and re-verify';
    case 'app_healthy': return 'the process answers but the application is failing: read its log, check the database and the environment file, re-verify';
    case 'credential_decryptable': return 'the application runs but the stored credential does not decrypt under the configured key — restore the recovery set (database + environment) together, or set the key the rows were written under; never roll the environment key back on its own';
    case 'credential_use_verified': return 'the stored rows decrypt under the configured key but the running application cannot read the credential: the process did not load that key (an old process, a unit that reads another file) — restart the unit from the current unit file and re-verify';
    default: return 'follow the recovery procedure';
  }
}

// ── reconciliation (R2) ─────────────────────────────────────────────────

// reconcileDecision({ job, lock, nowMs, runnerKinds }) → what to do with ONE
// job whose owner may be dead:
//   { action: 'nothing' }                                   live lease
//   { action: 'resume' }                                    a runner kind with a resumable checkpoint
//   { action: 'recover', reason }                           a disruptive step had begun (app stopped) — recover, verify, record
//   { action: 'record_interrupted', reason }                nothing disruptive had begun — record failure, release
//   { action: 'record_recovery_required', reason }          disruptive step begun but nothing can act (no runner) — record, keep the lock stale
export function reconcileDecision({ job, lock = null, nowMs, canAct = true, runnerKinds = RUNNER_JOB_KINDS } = {}) {
  if (!job || job.status !== 'running') return { action: 'nothing', reason: 'not running' };
  const lease = { lease_expires_at: job.lease_expires_at };
  if (!leaseExpired(lease, nowMs)) return { action: 'nothing', reason: 'lease is live' };
  const cp = parseJson(job.checkpoint_json) || {};
  if (['verify_sso', 'configure_recovery_route'].includes(job.kind)) return { action: 'resume', reason: 'Revalidate the saved SSO reference and resume the idempotent guided step' };
  if (['vaultwarden_apply','configure_vaultwarden_route'].includes(job.kind)) return { action:'resume', reason:'Re-read saved Vaultwarden intent and owned state; never reset data or regenerate credentials.' };
  if (job.kind === 'full_platform_apply') return { action: 'resume', reason: 'Resume the saved Full Platform revision and existing child jobs without replacing resources.' };
  if (job.kind === 'openbao_operator') return { action:'record_uncertain', reason:'OpenBao operator request interrupted. Submitted material was transient. Read service state, then deliberately resubmit; no automatic secret replay.', releaseLock:true, keepStale:false };
  if (['openbao_apply','configure_openbao_route'].includes(job.kind)) return {action:'resume',reason:'Re-read owned OpenBao state; never repeat initialization or regenerate keys.'};
  if (['infisical_apply','configure_infisical_route'].includes(job.kind)) return { action: 'resume', reason: 'Re-read saved Infisical references and verify owned resources before retry.' };
  if (['pomerium_apply','configure_pomerium_routes'].includes(job.kind)) return { action: 'resume', reason: 'Re-read the saved Pomerium intent and resume fail-closed route configuration.' };
  if (job.kind === 'configure_keycloak_route') return { action: 'resume', reason: 'Interrupted Keycloak route step; re-read owned rows and render before reporting success' };
  const disruptive = cp.app_stopped === true || cp.disruptive === true;
  if (cp.setup === true && cp.init_issued === true) {
    // A guest setup whose init script was issued: the resumed job reads the
    // result the guest recorded and never runs the script again; when nobody
    // can act, the record says the outcome is unknown and the lease goes —
    // the guest is running and usable, nothing further is issued.
    if (runnerKinds.includes(job.kind) && canAct) return { action: 'resume', reason: `owner ${job.owner} is gone after the init script was issued; the resumed job reads the guest's recorded result and never runs the script again` };
    return { action: 'record_uncertain', reason: `owner ${job.owner} is gone after the init script was issued and before its result was read; nothing can act now and the script is never replayed`, releaseLock: true, keepStale: false, setup: true };
  }
  if (runnerKinds.includes(job.kind) && cp.resumable === true && !disruptive && canAct) {
    return { action: 'resume', reason: `owner ${job.owner} is gone; checkpoint '${cp.phase || job.phase || '?'}' is resumable` };
  }
  if (disruptive && cp.lifecycle === true) {
    // A lifecycle verb whose command was issued and is never replayed
    // (restart, create): the outcome is unknown to the record, no in-guest
    // recovery applies (there may be no application at all), and nothing is
    // issued again. Recovery required is the recorded outcome; the lease is
    // KEPT stale until an operator acknowledges the record.
    return { action: 'record_uncertain', reason: `owner ${job.owner} is gone after '${cp.phase || job.phase}' with the ${job.kind} command issued and its result unread; it is not replayed`, releaseLock: false, keepStale: true };
  }
  if (!disruptive && cp.unit_swapped === true && !cp.verification_state) {
    // The new unit was started and the owner died before verification: the
    // stopped-app marker is clear, but the verification is unfinished and the
    // recovery references are still needed — verify, do not forget.
    return { action: 'verify', reason: `owner ${job.owner} is gone after '${cp.phase || job.phase}' with the application started but not verified`, releaseLock: !!lock && lock.owner === job.owner };
  }
  if (!disruptive) {
    // An idempotent command (a lifecycle or configuration verb) whose owner
    // died after issuing it may have taken effect: said so, and the retry
    // re-reads the guest and finishes or re-issues — never blindly.
    const issued = cp.issued === true && (cp.lifecycle === true || cp.config === true) ? `; the ${job.kind} command had been issued and may have taken effect — a retry re-reads the guest and finishes or re-issues the same command against the same identity` : '';
    return { action: 'record_interrupted', reason: `owner ${job.owner} is gone; no disruptive step had begun (last phase '${job.phase || cp.phase || 'start'}')${issued}`, releaseLock: !!lock && lock.owner === job.owner };
  }
  if (!canAct) {
    return { action: 'record_recovery_required', reason: `owner ${job.owner} is gone after '${cp.phase || job.phase}' with the application stopped; no runner can act — recovery required` };
  }
  return { action: 'recover', reason: `owner ${job.owner} is gone after '${cp.phase || job.phase}' with the application stopped` };
}

// verifyJobFrom(job) → the queued verify_app job a reconciler creates for a
// dead owner that had started the new unit but not verified it.
export function verifyJobFrom(job, { nowIso }) {
  const spec = recoveryJobFrom(job, { nowIso });
  return { ...spec, kind: 'verify_app', plan: { steps: ['unit_status', 'probe_port', 'health_check', 'verify_credential'], params: spec.plan.params }, reason: `verify ${job.app} after ${job.kind} job ${job.id} was interrupted with the application started but unverified` };
}

// recoveryJobFrom(job) → the queued recover_app job a reconciler creates for
// a dead deploy/restore. Carries REFERENCES only (container, port, unit,
// guard table names) — the checkpoint is where the deploy put them, and it
// never held a value.
export function recoveryJobFrom(job, { nowIso }) {
  const cp = parseJson(job.checkpoint_json) || {};
  const refs = parseJson(job.config_refs_json) || {};
  const rec = cp.recovery || {};
  const params = {
    container: cp.container || rec.container || job.app,
    webPort: Number(cp.webPort || rec.webPort || refs.webPort) || 3000,
    unit: cp.unit || rec.unit || refs.unit || 'mock2-dev.service',
    guard: refs.guard || rec.guard || (parseJson(job.plan_json)?.params?.guard) || null,
    environmentFile: refs.environmentFile || rec.environmentFile || '/etc/environment',
    origin: { jobId: job.id, kind: job.kind, phase: cp.phase || job.phase || null, generatedKeys: rec.generatedKeys || [] },
  };
  return {
    kind: 'recover_app',
    app: job.app,
    plan: { steps: ['start_unit', 'probe_port', 'health_check', 'verify_credential'], params },
    requested_by: 'reconcile',
    via: 'system',
    reason: `recover ${job.app} after ${job.kind} job ${job.id} was interrupted with the application stopped`,
    created_at: nowIso,
  };
}

// ── retry (R2: reuse, never regenerate) ─────────────────────────────────

// retryPlan(job) → the plan for a retry of a finished job: the SAME approved
// plan, plus `reuse`: every resource the first attempt recorded as generated
// (secret NAMES with where they were written, snapshot names, dump files) so
// the retry finds them instead of minting again.
export function retryPlan(job) {
  const plan = parseJson(job.plan_json) || {};
  const progress = parseJson(job.progress_json) || {};
  const generated = Array.isArray(progress.generated) ? progress.generated : [];
  return {
    ...plan,
    retryOf: job.id,
    // Identity travels with the record (sha256 / size / created_at) so a
    // retry can REVALIDATE what it reuses, not merely find it.
    reuse: generated.map((g) => ({ kind: g.kind, name: g.name, where: g.where || null, ...(g.sha256 ? { sha256: g.sha256 } : {}), ...(g.bytes != null ? { bytes: g.bytes } : {}), ...(g.created_at ? { created_at: g.created_at } : {}) })),
  };
}

// ── job validation ──────────────────────────────────────────────────────

// validateRunnerJob(job) → { ok } | { ok: false, reason }. The runner calls
// this before executing anything it claimed; the API calls it before queueing.
export function validateRunnerJob(job) {
  if (!job || !RUNNER_JOB_KINDS.includes(job.kind)) return { ok: false, reason: `kind '${job?.kind}' is not a runner job (one of ${RUNNER_JOB_KINDS.join(', ')})` };
  if (!CONTAINER_NAME_RE.test(String(job.app || ''))) return { ok: false, reason: 'app must be an Incus guest name' };
  const plan = parseJson(job.plan_json) || job.plan || {};
  const p = plan.params || {};
  if (job.kind === 'vaultwarden_apply') return vaultwardenJobSchema.safeParse(p).success && job.app === VAULTWARDEN_APP && Object.keys(plan).every(k => k === 'params') ? {ok:true} : {ok:false,reason:'Vaultwarden jobs carry only a saved revision reference.'};
  if (job.kind === 'full_platform_apply') return job.app === 'pp-full-platform' && Number.isInteger(p?.revision) && p.revision > 0 && Object.keys(p).every(k => ['revision', 'operation'].includes(k)) && (p.operation === undefined || ['administrator', 'retire', 'lifecycle'].includes(p.operation)) && Object.keys(plan).every(k => k === 'params') ? { ok: true } : { ok: false, reason: 'Full Platform jobs carry only an approved revision reference.' };
  if (job.kind === 'openbao_apply') return openbaoJobSchema.safeParse(p).success && job.app === OPENBAO_APP && Object.keys(plan).every(k => k === 'params') ? {ok:true} : {ok:false,reason:'OpenBao jobs carry only a saved revision reference.'};
  if (job.kind === 'infisical_apply') return infisicalJobSchema.safeParse(p).success && job.app === INFISICAL_APP && Object.keys(plan).every(k => k === 'params') ? { ok: true } : { ok: false, reason: 'Infisical jobs carry only a saved revision reference.' };
  if (job.kind === 'pomerium_apply') return pomeriumJobSchema.safeParse(p).success && job.app === POMERIUM_APP && Object.keys(plan).every(k => k === 'params') ? { ok: true } : { ok: false, reason: 'Pomerium jobs carry only a saved revision reference.' };
  if (job.kind === 'keycloak_setup') return keycloakJobSchema.safeParse(p).success && job.app === KEYCLOAK_APP && Object.keys(plan).every(k => k === 'params') ? { ok: true } : { ok: false, reason: 'Keycloak jobs carry only an installation reference and reviewed revision.' };
  if (p.container && p.container !== job.app) return { ok: false, reason: 'plan container differs from the job app' };
  if (p.webPort != null && !(Number.isInteger(p.webPort) && p.webPort > 0 && p.webPort < 65536)) return { ok: false, reason: 'webPort must be a port' };
  if (p.unit != null && !/^[A-Za-z0-9@._-]+\.service$/.test(String(p.unit))) return { ok: false, reason: 'unit must be a .service name' };
  if (p.command != null || p.script != null || p.argv != null) return { ok: false, reason: 'a runner job never carries a command' };
  if (p.appDir != null && !/^\/[A-Za-z0-9._\/-]+$/.test(String(p.appDir))) return { ok: false, reason: 'appDir must be an absolute path inside the guest' };
  if (p.environmentFile != null && !/^\/[A-Za-z0-9._\/-]+$/.test(String(p.environmentFile))) return { ok: false, reason: 'environmentFile must be an absolute path inside the guest' };
  if (job.kind === 'deploy') {
    const v = validateDeployContract(p.contract);
    if (!v.ok) return v;
    if (p.secrets != null) {
      if (!Array.isArray(p.secrets.configs)) return { ok: false, reason: 'secrets.configs must be a list of contract config entries' };
      for (const c of p.secrets.configs) {
        if (!c || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(c.key || ''))) return { ok: false, reason: 'every secret config names an environment key' };
        if ('value' in c || 'default' in c) return { ok: false, reason: 'a secret config carries no value' };
      }
    }
  } else if (job.kind === 'retry_secrets') {
    if (p.contract != null) return { ok: false, reason: 'a retry_secrets job carries no contract' };
    if (!p.secrets || !Array.isArray(p.secrets.configs)) return { ok: false, reason: 'secrets.configs must be a list of contract config entries' };
    for (const c of p.secrets.configs) {
      if (!c || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(c.key || ''))) return { ok: false, reason: 'every secret config names an environment key' };
      if ('value' in c || 'default' in c) return { ok: false, reason: 'a secret config carries no value' };
    }
  } else if (p.contract != null || p.secrets != null) {
    return { ok: false, reason: `a ${job.kind} job carries no contract or secret configuration` };
  }
  if (job.kind === 'restore_db') {
    if (!p.dump || !/^app-[A-Za-z0-9._-]{1,80}\.sql$/.test(String(p.dump.name || ''))) return { ok: false, reason: 'dump.name must be a dump file name (no path)' };
    if (p.dump.sha256 != null && !/^[0-9a-f]{64}$/.test(String(p.dump.sha256))) return { ok: false, reason: 'dump.sha256 must be a hex digest' };
    if (p.envCopy != null) {
      if (!/^environment\.pre-[A-Za-z0-9-]{1,80}$/.test(String(p.envCopy.name || ''))) return { ok: false, reason: 'envCopy.name must be an environment copy name (no path)' };
      if (!/^[A-Za-z0-9-]{1,64}$/.test(String(p.envCopy.originJobId || ''))) return { ok: false, reason: 'envCopy.originJobId must name the job that recorded the recovery set' };
    }
    if (p.dumpsDir != null && !/^\/[A-Za-z0-9._\/-]+$/.test(String(p.dumpsDir))) return { ok: false, reason: 'dumpsDir must be an absolute path inside the guest' };
    if (p.guardKey != null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(p.guardKey))) return { ok: false, reason: 'guardKey must be an environment key name' };
  }
  if (job.kind === 'restore_snapshot') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(p.snapshot || ''))) return { ok: false, reason: 'snapshot must be a snapshot name' };
    if (p.acceptPartial != null && typeof p.acceptPartial !== 'boolean') return { ok: false, reason: 'acceptPartial must be a boolean' };
  }
  if (LIFECYCLE_JOB_KINDS.includes(job.kind)) {
    const lv = validateLifecycleParams(job.kind, p);
    if (!lv.ok) return lv;
  }
  if (SETUP_JOB_KINDS.includes(job.kind)) {
    const sv = validateSetupParams(p);
    if (!sv.ok) return sv;
  }
  if (CONFIG_JOB_KINDS.includes(job.kind)) {
    const cv = validateConfigParams(job.kind, p);
    if (!cv.ok) return cv;
  }
  const flat = JSON.stringify(plan);
  if (flat !== JSON.stringify(redact(plan))) return { ok: false, reason: 'the plan carries a value that looks like a secret; plans carry references only' };
  return { ok: true };
}

// validateDeployContract(contract) → { ok } | { ok: false, reason }. The run
// contract is the app's own mock2.yaml `run:` block, resolved by the server
// from the guest's working tree (or read by the executor from the same file
// when null): guest-scope commands the app declares for itself. They are not
// host commands and never come from the request; what is checked here is
// shape — bounded single-line strings — not content.
export function validateDeployContract(contract) {
  if (contract == null) return { ok: true };
  if (typeof contract !== 'object') return { ok: false, reason: 'contract must be an object' };
  for (const k of ['runtime', 'install', 'migrate', 'build', 'start']) {
    const v = contract[k];
    if (v == null) continue;
    if (typeof v !== 'string' || v.length > 2000 || /[\0\r\n]/.test(v)) return { ok: false, reason: `contract.${k} must be a single line of at most 2000 characters` };
  }
  if (contract.hasContract && !contract.start) return { ok: false, reason: 'a contract with hasContract needs a start command' };
  return { ok: true };
}

// runnerIsLive(runnerRow, nowMs) — a heartbeat younger than RUNNER_LIVE_MS.
export function runnerIsLive(row, nowMs = Date.now(), maxAgeMs = RUNNER_LIVE_MS) {
  if (!row || !row.heartbeat_at) return false;
  const t = Date.parse(row.heartbeat_at);
  return Number.isFinite(t) && nowMs - t < maxAgeMs;
}

export function parseJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return null; }
}
