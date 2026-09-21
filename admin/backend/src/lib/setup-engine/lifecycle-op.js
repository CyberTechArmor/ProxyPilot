// Setup engine — the Incus lifecycle and snapshot verbs as ONE operation
// (A-17.2 … A-17.5), over the HOST executor: argv arrays to `incus`, rendered
// by lifecycle-logic.js from a validated plan, never a shell string and never
// a command from the request.
//
//   query      `incus list <name> --format json`: the guest (or its snapshot)
//              exists — or, for a create, does not — and its identity is what
//              the operator confirmed (params.expect) and what an interrupted
//              attempt bound (the prior checkpoint's target). Refused, nothing
//              issued, on any mismatch.
//   done?      an idempotent kind whose end state already holds finishes here
//   ── checkpoint (issued) ──
//   issue      the one fixed command (a delete stops a running guest first)
//   verify     `incus list` again: the state the kind promises, read back —
//              Running / Stopped / absent / snapshot present or absent. A
//              command that returned 0 but left the resource elsewhere is a
//              failure, not a success.
//
// Every record lives in the engine's database on the host: a job that deletes
// a guest or a snapshot keeps its evidence after the resource is gone.

import {
  LIFECYCLE_PROFILE, validateLifecycleParams, lifecycleArgv, instanceListArgv, rootSizeArgv, snapshotNoteArgv, cleanupArgv,
  instanceIdentity, snapshotIdentity, identityMatches, stateVerdict, alreadyDone, lifecycleOutcomeStep, lifecycleVerification, setupFollowUpFor,
} from './lifecycle-logic.js';
import { parseInstanceList } from './restore-logic.js';
import { createSnapshotWithFallback } from './restore-snapshot-op.js';
import { hostArgv, noopJob, tailOf } from './op-kit.js';
import { sanitizeReason } from './logic.js';

const TIMEOUTS = Object.freeze({
  instance_start: 120_000, instance_stop: 180_000, instance_restart: 180_000, instance_delete: 300_000,
  instance_create: 15 * 60_000, snapshot_create: 30 * 60_000, snapshot_delete: 5 * 60_000,
});

// runLifecycleOperation({ kind, params, exec, job, prior, log }) →
//   { ok: true, step, instanceState, verified, identity, alreadyInState?, followUp?, verification, ... }
//   { ok: false, step, error, refused?, notFound?, instanceState, verification? }
// `prior` is the checkpoint a previous attempt of THIS job wrote (a resumed
// job after its owner died): its `target` identity and `issued` flag decide
// whether an absent delete target / an existing snapshot is this job's work.
export async function runLifecycleOperation({ kind, params, exec, job = noopJob(), prior = null, log = () => {} }) {
  const v = validateLifecycleParams(kind, params);
  if (!v.ok) return { ok: false, step: 'validate', refused: true, error: v.reason };
  const host = hostArgv(exec);
  if (!host) return { ok: false, step: 'executor', error: 'this executor offers no host command channel; a lifecycle operation needs the host runner' };
  const p = params;
  const prof = LIFECYCLE_PROFILE[kind];
  const name = String(p.container);
  const snap = prof.target === 'snapshot' ? String(p.snapshot) : null;
  const report = (key, label) => { try { job.onStep?.(key, label); } catch { /* */ } };
  // A checkpoint that must be on record before the next step is REQUIRED: a
  // write that throws, or that changes no row (the job was fenced), stops the
  // operation before it issues anything — a record that says `issued: false`
  // must never be reconciled against a command that ran. The checkpoints
  // after the command are best effort (the job's own finish is the record).
  const mark = (phase, data, message, { required = false } = {}) => {
    let changes;
    try { changes = job.checkpoint(phase, data, message); } catch (e) { if (required) throw new CheckpointNotPersistedError(phase, e?.message || String(e)); return; }
    if (required && job.id && !(Number(changes) > 0)) {
      // No row changed: either the job was fenced (the fence says so, as
      // FencedError, and the executor records nothing more) or the store is
      // refusing the write — either way nothing is issued.
      job.fence({ safe: false });
      throw new CheckpointNotPersistedError(phase, 'the checkpoint changed no row');
    }
  };
  const fail = (step, error, extra = {}) => ({ ok: false, step, error: sanitizeReason(error, 800), ...extra });
  const list = async () => {
    const r = await host(instanceListArgv(name), { timeoutMs: 30_000 });
    if (r.code !== 0) return { error: `incus list failed: ${tailOf(r, 300)}` };
    const instance = parseInstanceList(r.stdout, name);
    if (r.stdout && instance === null && !Array.isArray(safeJson(r.stdout))) return { error: 'incus list returned something that is not a JSON list' };
    return { instance };
  };
  const what = prof.target === 'snapshot' ? `snapshot ${snap} of ${name}` : name;
  const resumed = !!(prior && prior.lifecycle === true);
  const issuedBefore = resumed && prior.issued === true;

  // 1) query and bind before anything.
  job.fence({ safe: true });
  report('query', `Reading ${what}…`);
  const q = await list();
  if (q.error) return fail('query', q.error);
  const inst = q.instance;
  let identity = null;
  if (prof.target === 'snapshot') {
    if (!inst) return fail('query', `${name} does not exist; nothing was done`, { notFound: true, instanceState: 'absent' });
    identity = snapshotIdentity(inst, snap);
  } else {
    identity = instanceIdentity(inst);
  }

  if (prof.creates) {
    // A create binds no identity: the resource must not exist unless this
    // job's interrupted attempt already made it.
    const exists = prof.target === 'snapshot' ? !!identity : !!inst;
    if (exists && !issuedBefore) return fail('query', `${what} already exists${prof.target === 'instance' ? ` (status ${inst.status})` : ''}; a create never replaces — nothing was done`, { refused: true, instanceState: prof.target === 'instance' ? inst.status : 'present' });
  } else {
    // Everything else acts on a resource that must exist and must be the one
    // confirmed: by the caller's plan (expect) and by this job's own earlier
    // attempt (prior.target). An absent target is this job's work only when
    // it removes and had already issued.
    const present = prof.target === 'snapshot' ? !!identity : !!inst;
    if (!present) {
      if (prof.removes && issuedBefore) {
        const verdict = stateVerdict(kind, { instance: inst, snapshot: snap });
        mark('verified', { lifecycle: true, resumable: true, disruptive: false, issued: true, target: prior.target || null, container: name }, `${what} is absent after the interrupted ${kind}; verified`);
        log(kind, `${name}: ${what} absent after the interrupted attempt; verified`);
        return { ok: true, step: lifecycleOutcomeStep(kind), instanceState: 'absent', verified: verdict, identity: prior.target || null, resumedAfterIssue: true, verification: lifecycleVerification(kind, verdict, { container: name, snapshot: snap }) };
      }
      return fail('query', `${what} does not exist; nothing was done`, { notFound: true, instanceState: 'absent' });
    }
    const expected = p.expect || null;
    const m1 = identityMatches(expected, identity);
    if (!m1.ok) return fail('target', `${what} is not the resource this request was confirmed for (${m1.why}); refusing — nothing was done. Look at it again and submit a new request`, { refused: true, instanceState: inst.status || null, identity });
    if (resumed && prior.target) {
      const m2 = identityMatches(prior.target, identity);
      if (!m2.ok) return fail('target', `${what} changed since this job's interrupted attempt bound it (${m2.why}); refusing to continue — nothing further was issued`, { refused: true, instanceState: inst.status || null, identity });
    }
  }
  const wasRunning = !!inst && String(inst.status || '').toLowerCase() === 'running';
  try {
    mark('validated', { lifecycle: true, resumable: true, disruptive: false, replay: prof.replay, issued: issuedBefore, target: identity, container: name, wasRunning }, `${kind} of ${what} validated${p.expect ? ' against the confirmed identity' : ''}`, { required: true });
  } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; return fail('checkpoint', `${e.message}; nothing was issued`, { notIssued: true, instanceState: inst?.status || null, identity }); }

  // 2) nothing left to do?
  if (alreadyDone(kind, { instance: inst, snapshot: snap, issued: issuedBefore })) {
    const verdict = stateVerdict(kind, { instance: inst, snapshot: snap });
    const note = issuedBefore ? `${what} is already ${verdict.observed} after the interrupted attempt` : `${what} is already ${verdict.observed}; nothing to issue`;
    mark('verified', { lifecycle: true, resumable: true, disruptive: false, issued: issuedBefore, target: identity, container: name }, note);
    job.event?.('step', note, null, 'already_done');
    log(kind, `${name}: ${note}`);
    return { ok: true, step: lifecycleOutcomeStep(kind), instanceState: verdict.observed, verified: verdict, identity, alreadyInState: !issuedBefore, resumedAfterIssue: issuedBefore, verification: lifecycleVerification(kind, verdict, { container: name, snapshot: snap }), followUp: followUpFor(kind, p, identity) };
  }

  // 3) the boundary: from here a cancel is declined and, for a kind that is
  // never replayed, an interruption ends recovery_required.
  const issueData = { lifecycle: true, replay: prof.replay, resumable: prof.replay === 'idempotent', disruptive: prof.replay === 'never', issued: true, target: identity, container: name, wasRunning };
  try {
    mark('issuing', issueData, `issuing ${kind} for ${what}`, { required: true });
  } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; return fail('checkpoint', `${e.message}; nothing was issued`, { notIssued: true, instanceState: inst?.status || null, identity }); }
  job.fence({ safe: false });

  // A delete stops a running guest first, as a separate fixed command.
  if (kind === 'instance_delete' && wasRunning) {
    report('stop', `Stopping ${name}${p.force ? ' (force)' : ''}…`);
    const s = await host(lifecycleArgv('instance_stop', { container: name, force: p.force === true }), { timeoutMs: TIMEOUTS.instance_stop });
    if (s.code !== 0) {
      const after = await list();
      if (String(after.instance?.status || '').toLowerCase() === 'running') return fail('stop', `could not stop ${name} cleanly (${tailOf(s, 300) || 'timed out'}); the guest was NOT deleted${p.force ? '' : ' — pass force to stop it hard, or stop it yourself first'}`, { instanceState: after.instance?.status || null, identity });
    }
  }

  report('issue', `${kind.replace('_', ' ')} ${what}…`);
  let issue;
  if (kind === 'snapshot_create') {
    const c = await createSnapshotWithFallback(host, name, snap, { timeoutMs: TIMEOUTS.snapshot_create });
    issue = c.ok ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: c.error };
  } else {
    issue = await host(lifecycleArgv(kind, p), { timeoutMs: TIMEOUTS[kind] });
  }

  // 4) verify by reading the resource back. A nonzero exit is a failure
  // whatever the guest reads afterwards: a Running guest after a restart that
  // exited 1 or timed out is no proof a restart happened, and an absent guest
  // after a delete that exited 1 is somebody else's doing. The observed state
  // goes on the record; success is never inferred from it.
  const after = await list();
  if (after.error) return fail(issue.code === 0 ? 'verify' : 'issue', `${kind} exited ${issue.code}; the guest could not be read back afterwards: ${after.error}`, { issued: true, instanceState: null, identity });
  const verdict = stateVerdict(kind, { instance: after.instance, snapshot: snap });
  if (issue.code !== 0) {
    // A failed launch may leave a half-created guest that did not exist when
    // this job validated: removed, and said so.
    let cleanup = null;
    if (kind === 'instance_create' && after.instance && !/already exists|already in use/i.test(issue.stderr || '')) {
      const d = await host(cleanupArgv(name), { timeoutMs: 120_000 });
      const gone = await list();
      cleanup = { attempted: true, removed: !gone.instance, detail: d.code === 0 ? null : tailOf(d, 200) };
      job.event?.('step', cleanup.removed ? `half-created ${name} removed` : `half-created ${name} could NOT be removed: ${cleanup.detail}`, null, 'cleanup');
    }
    return fail('issue', `incus ${kind.replace('_', ' ')} exited ${issue.code}${issue.code === 124 ? ' (timed out)' : ''}: ${tailOf(issue, 300) || 'no output'}; ${what} reads ${verdict.observed} afterwards — not claiming ${lifecycleOutcomeStep(kind)}`, { issued: true, instanceState: verdict.observed, identity, cleanup, verification: lifecycleVerification(kind, { ...verdict, ok: false }, { container: name, snapshot: snap }) });
  }
  if (!verdict.ok) return fail('verify', `incus ${kind.replace('_', ' ')} exited ${issue.code} but ${what} reads ${verdict.observed}, not ${verdict.expected}; not claiming success`, { issued: true, instanceState: verdict.observed, identity, verification: lifecycleVerification(kind, verdict, { container: name, snapshot: snap }) });

  // 5) the best-effort extras a create / snapshot carries, never a failure.
  const warnings = [];
  if (kind === 'instance_create' && p.rootSize) {
    const d = await host(rootSizeArgv(name, p.rootSize), { timeoutMs: 30_000 });
    if (d.code !== 0) warnings.push(`root disk size could not be set (${tailOf(d, 200)}) — the profile default applies`);
  }
  if (kind === 'snapshot_create' && p.note) {
    const n = await host(snapshotNoteArgv(name, snap, p.note), { timeoutMs: 10_000 });
    if (n.code !== 0) warnings.push(`the note could not be recorded on the snapshot (${tailOf(n, 200)})`);
  }
  const finalIdentity = prof.target === 'snapshot' ? snapshotIdentity(after.instance, snap) : instanceIdentity(after.instance);
  if (prof.creates) job.generated({ kind: prof.target, name: prof.target === 'snapshot' ? snap : name, where: name, created_at: finalIdentity?.created_at || null });
  mark('verified', { lifecycle: true, resumable: true, disruptive: false, issued: true, target: prof.removes ? identity : finalIdentity, container: name }, `${what} ${verdict.observed}; verified`);
  log(kind, `${name}: ${what} ${verdict.observed}${warnings.length ? `; ${warnings.join('; ')}` : ''}`);
  return {
    ok: true, step: lifecycleOutcomeStep(kind), instanceState: verdict.observed, verified: verdict, identity: prof.removes ? identity : finalIdentity, wasRunning,
    ...(warnings.length ? { warnings } : {}),
    verification: lifecycleVerification(kind, verdict, { container: name, snapshot: snap }),
    followUp: followUpFor(kind, p, prof.removes ? identity : finalIdentity),
  };
}

// The follow-ups a lifecycle job queues before it reports done (the executor
// persists each as its own job): the guest setup a create carried or the
// NAT / DNS fix-up a start / restart asked for (A-17.7), bound to the guest
// the job read back; then, for a MANAGED application brought up by a start
// or restart, the full ladder. Any other kind, or any other guest, has no
// application to check and says so through its verification. An array, or
// null when there is nothing to queue.
function followUpFor(kind, p, identity) {
  const out = [];
  const setup = setupFollowUpFor(kind, p, identity);
  if (setup) out.push(setup);
  if (p.managed === true && (kind === 'instance_start' || kind === 'instance_restart')) {
    out.push({ kind: 'verify_app', steps: ['unit_status', 'probe_port', 'health_check', 'verify_credential', 'verify_credential_use'], rung: 'credential_use_verified', revision: null });
  }
  return out.length ? out : null;
}

export class CheckpointNotPersistedError extends Error {
  constructor(phase, why) {
    super(`the '${phase}' checkpoint could not be persisted (${why}); refusing to issue a command whose record would not say so`);
    this.name = 'CheckpointNotPersistedError';
    this.code = 'CHECKPOINT_NOT_PERSISTED';
    this.phase = phase;
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return undefined; } }
