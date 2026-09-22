// One exclusive lock per container, shared by every platform operation that
// changes what a guest runs or stores: the deploy (which stops the app, mints
// its secrets and swaps its unit), the project database restore, the container
// snapshot restore, and the secret mint the retry path runs before a deploy.
// The operation that does the work holds the lock for its whole lifetime; the
// request that asked for it does not. The check is server-side, so it covers
// the dashboard, the CLI and MCP alike.
//
// Two ways in. withContainerLock(name, holder, fn) QUEUES behind the current
// holder — a deploy is idempotent, so a queued deploy simply runs after the
// one in flight. { wait: false } REFUSES with ContainerBusyError when the lock
// is held: a destructive restore must not start minutes later, under a state
// its operator never looked at, so it is rejected before making any change.
//
// Two layers (docs/core/setup-engine-requirements.md R1):
//
//   in-process   the promise chain below serializes callers inside this
//                backend, exactly as before;
//   persistent   when configureContainerLockStore() has been called (index.js,
//                after the database is open), the operation ALSO holds a lease
//                row in setup_locks and a job row in setup_jobs, renewed while
//                it runs. A lease held by another live owner (the host runner
//                recovering this app) refuses the same way a busy in-process
//                lock does. A lease whose owner is DEAD — a backend that
//                restarted mid-deploy — is a recorded condition
//                (ContainerLockStaleError): nothing here takes it, because
//                what the dead holder left (an app it stopped) has to be
//                looked at first; the boot sweep and the host runner do that
//                (lib/setup-engine/backend.js, the runner's reconcile).
//
// fn receives a job handle: { id, checkpoint(phase, data, message),
// generated(resource) } — the deploy writes its checkpoint BEFORE it stops
// the app, so a reconciler knows the app was stopped. Existing callers that
// ignore the argument keep working.

import { acquireLock, renewLock, releaseLock, createJob, startJob, checkpoint as storeCheckpoint, recordGenerated, finishJob, fenceJob, appendEvent, recordProgress } from '../lib/setup-engine/store.js';
import { sanitizeReason } from '../lib/setup-engine/logic.js';

const locks = new Map(); // container → { chain, holder, since, waiting }

// The persistent backing, absent until configured: { getDb, owner, leaseMs, renewMs }.
let store = null;

export class ContainerBusyError extends Error {
  constructor(container, holder) {
    super(`${holder} is in progress for container ${container}`);
    this.name = 'ContainerBusyError';
    this.code = 'CONTAINER_BUSY';
    this.container = container;
    this.holder = holder;
  }
}

export class ContainerLockStaleError extends Error {
  constructor(container, verdict) {
    super(`a previous ${verdict.operation} for container ${container} did not finish (holder ${verdict.holder}, since ${verdict.since}); recovery is required before another operation — see the setup jobs for this app`);
    this.name = 'ContainerLockStaleError';
    this.code = 'CONTAINER_LOCK_STALE';
    this.container = container;
    this.holder = verdict.holder;
    this.operation = verdict.operation;
    this.since = verdict.since;
    this.jobId = verdict.jobId || null;
  }
}

// configureContainerLockStore({ getDb, owner, leaseMs, renewMs }) — index.js
// calls this once the main database is open. Passing null disables it (tests).
// Accepted config: getDb, owner, leaseMs, renewMs, and for the legacy
// in-process executor (mock2/deploy.js) optional overrides env, guestExec,
// reviewLogin (tests inject a scripted guest and a fixed login).
export function configureContainerLockStore(config) {
  store = config && typeof config.getDb === 'function' && config.owner ? { leaseMs: 30_000, renewMs: 10_000, ...config } : null;
}

export function containerLockStoreConfigured() {
  return !!store;
}

// containerLockStore() → { getDb, owner } while configured (deploy.js asks it
// whether a runner can be handed the job), else null.
export function containerLockStore() {
  return store ? { getDb: store.getDb, owner: store.owner, env: store.env || null, guestExec: store.guestExec || null, hostExec: store.hostExec || null, reviewLogin: store.reviewLogin || null, inputsDir: store.inputsDir || null, configureRoutes: store.configureRoutes || null, renderDeps: store.renderDeps || null, reservedPortsPath: store.reservedPortsPath || null } : null;
}

// containerLockHolder(name) → { holder, since, waiting } | null
export function containerLockHolder(name) {
  const l = locks.get(String(name || ''));
  return l ? { holder: l.holder, since: l.since, waiting: l.waiting } : null;
}

const noopJob = Object.freeze({ id: null, checkpoint: () => 0, generated: () => 0, fence: () => {}, event: () => {}, progress: () => 0, persistent: false });

// Take the persistent lease + create the job row for one operation. Returns
// the handle fn receives, plus release(status, outcome, reason).
function openPersistent(key, label, { kind, plan, configRefs, requestedBy, via }) {
  const db = store.getDb();
  const owner = store.owner;
  const verdict = acquireLock(db, { app: key, owner, operation: label, leaseMs: store.leaseMs });
  if (!verdict.ok) {
    if (verdict.reason === 'stale') throw new ContainerLockStaleError(key, verdict);
    throw new ContainerBusyError(key, `${verdict.operation} (${verdict.holder})`);
  }
  const epoch = Number(verdict.lock.epoch);
  const row = createJob(db, { kind: kind || label, app: key, plan: plan || {}, configRefs: configRefs || {}, requestedBy: requestedBy || null, via: via || 'system' });
  startJob(db, { id: row.id, owner, leaseMs: store.leaseMs });
  db.prepare(`UPDATE setup_locks SET job_id = ? WHERE app = ? AND owner = ? AND epoch = ?`).run(row.id, key, owner, epoch);
  const timer = setInterval(() => {
    try {
      const d = store.getDb();
      renewLock(d, { app: key, owner, epoch, leaseMs: store.leaseMs });
      d.prepare(`UPDATE setup_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner = ? AND epoch = 1 AND status = 'running'`)
        .run(new Date(Date.now() + store.leaseMs).toISOString(), new Date().toISOString(), row.id, owner);
    } catch { /* a missed renewal only shortens the lease */ }
  }, store.renewMs);
  timer.unref?.();
  const handle = {
    id: row.id,
    _timer: timer,
    persistent: true,
    checkpoint: (phase, data = {}, message = null) => {
      try { return storeCheckpoint(store.getDb(), { id: row.id, owner, epoch: 1, phase, checkpoint: data, message }); } catch { return 0; }
    },
    generated: (resource) => {
      try { return recordGenerated(store.getDb(), { id: row.id, owner, epoch: 1, resource }); } catch { return 0; }
    },
    // The fence: renew the job lease; stop when ownership moved (FencedError)
    // or, at a safe point, when a cancel was requested (CancelledError).
    fence: (opts = {}) => fenceJob(store.getDb(), { id: row.id, owner, epoch: 1, safe: !!opts.safe, leaseMs: store.leaseMs }),
    event: (kind, message, data = null) => {
      try { appendEvent(store.getDb(), { jobId: row.id, kind, message, data }); } catch { /* */ }
    },
    progress: (data) => {
      try { return recordProgress(store.getDb(), { id: row.id, owner, epoch: 1, progress: data }); } catch { return 0; }
    },
  };
  const release = (status, outcome, reason, verification = null) => {
    clearInterval(timer);
    try {
      const d = store.getDb();
      finishJob(d, { id: row.id, owner, epoch: 1, status, outcome, reason, verification });
      releaseLock(d, { app: key, owner, epoch });
    } catch { /* the lease expires on its own; the boot sweep records it */ }
  };
  return { handle, release };
}

// withContainerLock(name, holder, fn, { wait, job }) → fn's result. `holder` is
// a short label for the operation ('deploy', 'restore_project_db', …) that a
// refused caller is told about. `job` describes the persisted record:
// { kind, plan, configRefs, requestedBy, via } — references only, never a
// secret value (the store redacts anyway).
export async function withContainerLock(name, holder, fn, { wait = true, job = null } = {}) {
  const key = String(name || '');
  const label = String(holder || 'operation');
  const current = locks.get(key);
  if (current && !wait) throw new ContainerBusyError(key, current.holder);
  const entry = current || { chain: Promise.resolve(), holder: label, since: Date.now(), waiting: 0 };
  if (current) entry.waiting += 1;
  const run = entry.chain.catch(() => {}).then(async () => {
    if (current) entry.waiting -= 1;
    entry.holder = label;
    entry.since = Date.now();
    if (!store) return fn(noopJob);
    const { handle, release } = openPersistent(key, label, job || {});
    let result;
    try {
      result = await fn(handle);
    } catch (e) {
      if (e?.code === 'CANCELLED') release('cancelled', 'cancelled', sanitizeReason(e.message));
      else if (e?.code === 'FENCED') { clearInterval(handle._timer); /* the new owner's record, not ours */ }
      else release('failed', 'threw', sanitizeReason(e?.message || String(e)));
      throw e;
    }
    // An operation reports its own outcome in its result when it can
    // ({ ok, error, deferred }); otherwise a normal return is success.
    const verification = result && typeof result === 'object' && result.verification ? result.verification : null;
    if (result && typeof result === 'object' && result.ok === false) {
      release('failed', result.step ? `failed at ${result.step}` : 'failed', sanitizeReason(result.error || 'failed'), verification);
    } else if (result && typeof result === 'object' && result.deferred) {
      release('deferred', 'deferred', sanitizeReason(result.reason || result.error || 'deferred'), verification);
    } else {
      release('succeeded', verification?.state || 'completed', null, verification);
    }
    return result;
  });
  entry.chain = run;
  locks.set(key, entry);
  try {
    return await run;
  } finally {
    if (locks.get(key) === entry && entry.chain === run) locks.delete(key);
  }
}
