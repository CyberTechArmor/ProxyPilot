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

export const HOLDER_KINDS = Object.freeze(['backend', 'runner', 'cli']);
export const DEFAULT_LEASE_MS = 30_000;
export const JOB_STATUS = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'deferred', 'refused', 'recovery_required', 'cancelled']);
export const TERMINAL_STATUS = Object.freeze(['succeeded', 'failed', 'deferred', 'refused', 'recovery_required', 'cancelled']);
export const VIA = Object.freeze(['ui', 'cli', 'mcp', 'runner', 'system']);

// Job kinds the HOST RUNNER may execute. A job whose kind is not here is never
// claimed by it — the browser-facing API can only ask for one of these, and
// none of them takes a command, a path outside the guest, or a value that is
// a secret.
export const RUNNER_JOB_KINDS = Object.freeze(['recover_app', 'verify_app', 'probe']);
// Job kinds the BACKEND records for the operations it still executes itself
// (they hold the same lock; the runner recovers them when the backend dies).
export const BACKEND_JOB_KINDS = Object.freeze(['deploy', 'restore_project_db', 'restore_snapshot', 'retry-secrets', 'credential_migration']);

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
    if (SECRET_KEY_RE.test(k) && !/_(name|names|path|paths|ref|refs|present|count|set|key_names|keys)$/i.test(k) && !/^(has_|is_|n_)/i.test(k)) {
      out[k] = v == null ? v : REDACTED;
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

export const VERIFY_STATES = Object.freeze(['unconfigured', 'configured', 'port_responding', 'app_healthy', 'credential_verified', 'recovery_required']);

// verificationState(obs) → { state, label, facts, next }. Each fact is
// true / false / null (not checked). The ladder is monotonic: a higher rung
// counts only when every rung below it holds. A rung that FAILED (false)
// below the top means recovery is required; a rung that was not checked
// (null) simply caps the state — "port responding" is never promoted to
// "application healthy" because the health check did not run.
export function verificationState({ unitConfigured = null, unitActive = null, portResponding = null, appHealthy = null, credentialVerified = null, deferredReason = null } = {}) {
  const facts = { unitConfigured, unitActive, portResponding, appHealthy, credentialVerified };
  const rungs = [
    ['configured', unitConfigured],
    ['port_responding', unitActive === false ? false : portResponding],
    ['app_healthy', appHealthy],
    ['credential_verified', credentialVerified],
  ];
  let state = 'unconfigured';
  let next = 'configure the application unit';
  for (const [name, fact] of rungs) {
    if (fact === true) { state = name; next = nextStep(name); continue; }
    if (fact === false) return { state: 'recovery_required', label: LABELS.recovery_required, facts, failedAt: name, next: recoveryStep(name), deferredReason: deferredReason || null };
    // null: not checked — stop climbing, keep what is proven.
    next = `${nextStep(state)} (${name.replace(/_/g, ' ')} was not checked${deferredReason ? `: ${deferredReason}` : ''})`;
    break;
  }
  return { state, label: LABELS[state], facts, failedAt: null, next, deferredReason: deferredReason || null };
}

const LABELS = Object.freeze({
  unconfigured: 'not configured',
  configured: 'configured (unit present; not verified running)',
  port_responding: 'running: port responding (not verified healthy)',
  app_healthy: 'application healthy (credential not verified)',
  credential_verified: 'application healthy and the protected credential reads back',
  recovery_required: 'recovery required',
});

function nextStep(state) {
  switch (state) {
    case 'configured': return 'start the unit and probe the port';
    case 'port_responding': return 'run the application health check';
    case 'app_healthy': return 'read the protected credential back through the application';
    case 'credential_verified': return 'nothing — verified';
    default: return 'configure the application unit';
  }
}
function recoveryStep(rung) {
  switch (rung) {
    case 'configured': return 'the unit is missing or invalid: redeploy, or restore the unit file from the last checkpoint';
    case 'port_responding': return 'the unit is not serving: read its journal (journalctl -u mock2-dev.service), start it, and re-verify';
    case 'app_healthy': return 'the process answers but the application is failing: read its log, check the database and the environment file, re-verify';
    case 'credential_verified': return 'the application runs but cannot read its protected credential: the active key does not match the stored rows — restore the recovery set (database + environment) together, or set the key the rows were written under';
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
  const disruptive = cp.app_stopped === true || cp.disruptive === true;
  if (runnerKinds.includes(job.kind) && cp.resumable === true && canAct) {
    return { action: 'resume', reason: `owner ${job.owner} is gone; checkpoint '${cp.phase || job.phase || '?'}' is resumable` };
  }
  if (!disruptive) {
    return { action: 'record_interrupted', reason: `owner ${job.owner} is gone; no disruptive step had begun (last phase '${job.phase || cp.phase || 'start'}')`, releaseLock: !!lock && lock.owner === job.owner };
  }
  if (!canAct) {
    return { action: 'record_recovery_required', reason: `owner ${job.owner} is gone after '${cp.phase || job.phase}' with the application stopped; no runner can act — recovery required` };
  }
  return { action: 'recover', reason: `owner ${job.owner} is gone after '${cp.phase || job.phase}' with the application stopped` };
}

// recoveryJobFrom(job) → the queued recover_app job a reconciler creates for
// a dead deploy/restore. Carries REFERENCES only (container, port, unit,
// guard table names) — the checkpoint is where the deploy put them, and it
// never held a value.
export function recoveryJobFrom(job, { nowIso }) {
  const cp = parseJson(job.checkpoint_json) || {};
  const refs = parseJson(job.config_refs_json) || {};
  const params = {
    container: cp.container || job.app,
    webPort: Number(cp.webPort || refs.webPort) || 3000,
    unit: cp.unit || refs.unit || 'mock2-dev.service',
    guard: refs.guard || null,
    environmentFile: refs.environmentFile || '/etc/environment',
    origin: { jobId: job.id, kind: job.kind, phase: cp.phase || job.phase || null },
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
    reuse: generated.map((g) => ({ kind: g.kind, name: g.name, where: g.where || null })),
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
  if (p.container && p.container !== job.app) return { ok: false, reason: 'plan container differs from the job app' };
  if (p.webPort != null && !(Number.isInteger(p.webPort) && p.webPort > 0 && p.webPort < 65536)) return { ok: false, reason: 'webPort must be a port' };
  if (p.unit != null && !/^[A-Za-z0-9@._-]+\.service$/.test(String(p.unit))) return { ok: false, reason: 'unit must be a .service name' };
  if (p.command != null || p.script != null || p.argv != null) return { ok: false, reason: 'a runner job never carries a command' };
  const flat = JSON.stringify(plan);
  if (flat !== JSON.stringify(redact(plan))) return { ok: false, reason: 'the plan carries a value that looks like a secret; plans carry references only' };
  return { ok: true };
}

export function parseJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return null; }
}
