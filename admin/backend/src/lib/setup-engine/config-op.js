// Setup engine — the guest configuration verbs as ONE operation (A-17.8),
// over the host executor's argv channel: `incus config …` and the firewall
// CLI, rendered by config-logic.js from a validated plan, never a shell
// string and never a command from the request.
//
//   query      `incus list <name> --format json`: the guest exists and is the
//              one the operator confirmed (params.expect) and the one an
//              interrupted attempt bound (the prior checkpoint's target);
//              the PRIOR state of what the job changes is recorded
//   preflight  every step read once: a refusal is answered before any
//              snapshot or lease; a request whose whole state holds ends
//              with nothing issued and no snapshot (nothing to protect)
//   protect    the pre-mutation snapshot the plan names (the MCP verbs):
//              taken, or REUSED when this job's earlier attempt / the retry's
//              origin recorded it and it is still there with the same
//              created_at; read back present BEFORE anything is changed; a
//              snapshot that fails prevents the change; the coverage stated.
//              After a write has begun (a resumed attempt, a retry of an
//              origin that issued) the ORIGINAL snapshot's identity must be
//              verifiable before any remaining write: missing, replaced or
//              unrecorded → the completed changes are read back and the
//              remaining ones are NOT issued (`failed at protect`); no
//              replacement snapshot is ever taken and presented as the
//              original pre-change point
//   lease      the firewall kinds take the host-wide `@host/firewall` lease
//              after the guest's (waited for, a dead holder taken over,
//              contended → nothing issued); renewed before every command
//   steps      one per resource: each step READS its own state first and
//              issues its fixed command only when the state does not hold,
//              then reads it back — so a resumed or retried job converges
//              without replaying blindly; the first mutation is preceded by
//              the mandatory `issuing` checkpoint; a step is `done` only when
//              its command succeeded (or was tolerated by name) AND its
//              read-back holds; a step that fails stops the sequence and the
//              record says what was applied. A forward's row in
//              `service_l4_forwards` is the job's first step (under the
//              leases, through the store the executor hands it); the
//              firewall's SAVED configuration (the `rule` / `egress` step)
//              and the APPLIED policy (the `reconcile` step: the recorded
//              reconcile against the desired checksum) are two steps; the
//              reserved UDP ranges are recomputed from the authoritative
//              rows at execution time, never carried in the plan
//   settle     a forward_apply that failed definitively after its row was
//              written rolls back — ONLY the row, the device and the rule
//              this operation CREATED (its fenced generated records, its
//              own attempts' and those of the origins it retries that did
//              not complete), never a change that was there before it —
//              as the job's own disposition, fenced at every write; a row
//              that can no longer be written (superseded on its port) is
//              refused with this id's orphans removed, never a success
//              without a row; a policy the reconcile could not apply is
//              reported unresolved, not rolled back
//   verify     the whole requested state read back, or `failed` naming the
//              step: exit 0 is never the proof
//
// The record carries references only: allowlisted keys and values, a
// device's addresses and paths, a snapshot's name and timestamp, the
// forward's ports, the egress service — nothing a script printed, nothing
// that looks like a secret (the validator refuses such a plan).

import {
  validateConfigParams, FIREWALL_KINDS, HOST_FIREWALL_LOCK, configOutcomeStep, configVerification, snapshotCoverageNote,
  configSetArgv, rootSizeOverrideArgv, rootSizeSetArgv, deviceAddArgv, deviceRemoveArgv, networkPinOverrideArgv, networkPinSetArgv,
  forwardDeviceAddArgv, forwardDeviceRemoveArgv, forwardDeviceName, forwardRuleId, forwardListen, forwardConnect, firewallAddArgv, firewallRemoveArgv, firewallListArgv,
  firewallStatusArgv, firewallDryRunArgv, firewallReconcileArgv, forwardRuleVerdict, reconcileEvidence, firewallCliResult,
  egressArgv, egressListArgv, reservedReadArgv, reservedWriteArgv, reservedRemoveArgv, sysctlApplyArgv, sysctlReadArgv, reservedPlan,
  priorConfig, priorRootSize, priorPin, recordedDevice, configKeyVerdict, rootSizeVerdict, deviceVerdict, networkVerdict, egressVerdict, parseCliJson,
} from './config-logic.js';
import { instanceListArgv, instanceIdentity, identityMatches } from './lifecycle-logic.js';
import { parseInstanceList, snapshotCoverage } from './restore-logic.js';
import { createSnapshotWithFallback } from './restore-snapshot-op.js';
import { hostArgv, noopJob, tailOf } from './op-kit.js';
import { CheckpointNotPersistedError } from './lifecycle-op.js';
import { SharedLeaseLostError } from './setup-op.js';
import { sanitizeReason } from './logic.js';
import { RESERVED_PORTS_PATH } from '../l4-reserved-ports.js';

export const FIREWALL_LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 500;
const TIMEOUTS = Object.freeze({ list: 30_000, incus: 60_000, snapshot: 30 * 60_000, firewall: 60_000, sysctl: 10_000 });

// runConfigOperation({ kind, params, exec, job, prior, reuse, deps, log }) →
//   { ok: true, step, instanceState, identity, snapshot, previous, applied, warnings, verification, alreadyInState?, resumedAfterIssue? }
//   { ok: false, step, error, refused?, notFound?, contended?, partial?, protection?, rollback?, applied, snapshot, verification? }
// `prior` is this job's own checkpoint from an interrupted attempt; `reuse`
// the resources the retry's origin chain recorded (a snapshot by name +
// created_at); deps: hostLease { acquire, takeover, renew, release },
// forwardStore { get, insert, delete, reservedRanges } (fenced at the
// database boundary), originWriteBegun (a write had begun somewhere in the
// retry chain), owned (the changes this operation created, as the engine
// recorded them), sleep, nowMs, reservedPortsPath.
export async function runConfigOperation({ kind, params, exec, job = noopJob(), prior = null, reuse = [], deps = {}, log = () => {} }) {
  const v = validateConfigParams(kind, params);
  if (!v.ok) return { ok: false, step: 'validate', refused: true, error: v.reason };
  const host = hostArgv(exec);
  if (!host) return { ok: false, step: 'executor', error: 'this executor offers no host command channel; a guest configuration needs the host runner' };
  const p = params;
  const name = String(p.container);
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs || (() => Date.now());
  const reservedPath = deps.reservedPortsPath || RESERVED_PORTS_PATH;
  const report = (key, label) => { try { job.onStep?.(key, label); } catch { /* */ } };
  const fail = (step, error, extra = {}) => ({ ok: false, step, error: sanitizeReason(error, 800), ...extra });
  const mark = (phase, data, message, { required = false } = {}) => {
    let changes;
    try { changes = job.checkpoint(phase, data, message); } catch (e) { if (required) throw new CheckpointNotPersistedError(phase, e?.message || String(e)); return; }
    if (required && job.id && !(Number(changes) > 0)) { job.fence({ safe: false }); throw new CheckpointNotPersistedError(phase, 'the checkpoint changed no row'); }
  };
  // Every command — reads included — goes through `run`: once the shared
  // firewall lease is held it is renewed first at the epoch this job holds
  // it, and a renewal that changes no row stops the job before its next
  // command (the executor's fence does the same for the claim and the
  // guest's lease on every command).
  let lease = null; let held = false; let issuedUnderLease = 0;
  const run = async (argv, opts) => {
    if (held && !lease.renew(HOST_FIREWALL_LOCK)) throw new SharedLeaseLostError(HOST_FIREWALL_LOCK, `after ${issuedUnderLease} command(s)`);
    if (held) issuedUnderLease += 1;
    return host(argv, opts);
  };
  const list = async () => {
    const r = await run(instanceListArgv(name), { timeoutMs: TIMEOUTS.list });
    if (r.code !== 0) return { error: `incus list failed: ${tailOf(r, 300)}` };
    let parsed; try { parsed = JSON.parse(r.stdout || '[]'); } catch { return { error: 'incus list returned something that is not JSON' }; }
    if (!Array.isArray(parsed)) return { error: 'incus list returned something that is not a JSON list' };
    return { instance: parseInstanceList(r.stdout, name) };
  };
  const resumed = !!(prior && prior.config === true);
  const issuedBefore = resumed && prior.issued === true;
  // A write has begun — by this job's interrupted attempt, by an earlier
  // attempt of this job that recorded it, or anywhere in the chain of
  // origins this job retries — so the ORIGINAL snapshot must still be
  // verifiable before anything further is written. The flag follows the
  // intent, not the attempt: every checkpoint of the chain carries it.
  const writeBegun = issuedBefore || (resumed && prior.writeBegun === true) || deps.originWriteBegun === true;
  let issuedAny = issuedBefore;
  // What this operation created (the engine's fenced generated records:
  // this job's own attempts and the origins it retries that did not
  // complete), extended as this attempt creates; the only changes its
  // rollback may remove. Never inferred from an id or an observed state.
  const ownedList = Array.isArray(deps.owned) ? deps.owned.map((g) => ({ kind: g.kind, name: g.name, where: g.where || null })) : [];
  const owned = (g) => !!g && ownedList.some((o) => o.kind === g.kind && o.name === g.name);
  const needsInstance = kind !== 'egress_set';
  const warnings = [];
  if (FIREWALL_KINDS.includes(kind) && kind !== 'egress_set' && !deps.forwardStore) return { ok: false, step: 'executor', error: 'this executor offers no forward store; a forward job writes its row under the leases' };

  // 1) read and bind.
  job.fence({ safe: true });
  let inst = null; let identity = null;
  if (needsInstance) {
    report('query', `Reading ${name}…`);
    const q = await list();
    if (q.error) return fail('query', q.error);
    inst = q.instance;
    if (!inst) return fail('query', `${name} does not exist; nothing was changed`, { notFound: true, instanceState: 'absent' });
    identity = instanceIdentity(inst);
    const m1 = identityMatches(p.expect || null, identity);
    if (!m1.ok) return fail('target', `${name} is not the guest this request was confirmed for (${m1.why}); refusing — nothing was changed. Look at it again and submit a new request`, { refused: true, instanceState: inst.status || null, identity });
    if (resumed && prior.target) {
      const m2 = identityMatches(prior.target, identity);
      if (!m2.ok) return fail('target', `${name} changed since this job's interrupted attempt bound it (${m2.why}); refusing to continue — nothing further was issued`, { refused: true, instanceState: inst.status || null, identity });
    }
  }
  const previous = resumed && prior.previous ? prior.previous : priorState(kind, p, inst);
  const cp = (extra = {}) => ({ config: true, resumable: true, disruptive: false, kind, container: name, target: identity, previous, writeBegun: writeBegun || issuedAny, ...extra });
  try {
    mark('validated', cp({ issued: issuedBefore, snapshot: prior?.snapshot || null, applied: prior?.applied || null }), `${kind} of ${name} validated${p.expect ? ' against the confirmed identity' : ''}${resumed ? ' (resumed)' : ''}`, { required: true });
  } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; return fail('checkpoint', `${e.message}; nothing was changed`, { notIssued: true, instanceState: inst?.status || null, identity }); }

  // 2) every step read FIRST: a refusal (a device that exists with other
  // properties, a remove of a device that is not there) is answered before
  // any snapshot is taken or any lease waited for, and a request whose
  // whole state already holds ends here with nothing issued and no
  // snapshot — there is nothing to protect.
  const instance = async () => { const r = await list(); if (r.error) throw new ReadBackError(r.error); return r.instance; };
  const steps = buildSteps(kind, p, { name, run, instance, reservedPath, store: deps.forwardStore || null });
  const applied = resumed && prior.applied && typeof prior.applied === 'object' ? { ...prior.applied } : {};
  let stopped = null;
  let allHold = true;
  try {
    for (const step of steps) {
      const before = await step.check();
      if (before.ok) {
        const already = step.refuseAlready ? step.refuseAlready(before, { issuedBefore }) : null;
        if (already) { stopped = { step: step.key, refused: true, notFound: !!before.notFound, error: already }; break; }
        continue;
      }
      allHold = false;
      const refusal = step.refuse ? step.refuse(before, { issuedBefore }) : null;
      if (refusal) { stopped = { step: step.key, refused: true, notFound: !!before.notFound, error: refusal }; break; }
    }
  } catch (e) {
    if (e instanceof ReadBackError) return fail('query', `${name}: could not be read: ${e.message}`, { instanceState: inst?.status || null, identity });
    throw e;
  }
  if (stopped) {
    mark('verified', cp({ issued: issuedBefore, snapshot: prior?.snapshot || null, applied, refused: stopped.step }), `${name}: ${stopped.error}`);
    return fail(stopped.step, stopped.error, { refused: true, notFound: !!stopped.notFound, issued: issuedBefore, applied, snapshot: prior?.snapshot || null, previous, instanceState: inst?.status || null, identity });
  }
  if (allHold && !issuedBefore) {
    for (const step of steps) if (!applied[step.key]) applied[step.key] = { state: 'already', issued: false };
    const summary = summarize(applied);
    mark('verified', cp({ issued: false, snapshot: null, applied }), `${name}: ${summary}; nothing to issue`);
    job.event?.('step', `${name}: every requested state already holds; nothing was issued and no snapshot was taken`, null, 'already_done');
    log(kind, `${name}: ${summary}`);
    return { ok: true, step: configOutcomeStep(kind), instanceState: inst?.status || null, identity, snapshot: null, previous, applied, ...collect(kind, applied), alreadyInState: true, resumedAfterIssue: false, verification: configVerification(kind, true, { container: name, label: `${name}: ${summary}`, facts: { applied: Object.fromEntries(Object.entries(applied).map(([k, a]) => [k, a.state])) } }) };
  }

  // 3) the pre-mutation snapshot. Before the first write it is taken (or
  // reused); after a write has begun the ORIGINAL must be verifiable, and
  // nothing further is written when it is not.
  let snapshot = null;
  let protection = null;
  if (p.snapshot) {
    report('protect', writeBegun ? 'Verifying the pre-change snapshot…' : 'Taking the pre-change snapshot…');
    const want = String(p.snapshot.name);
    const recorded = (prior?.snapshot && prior.snapshot.name === want ? prior.snapshot : null) || reuse.find((g) => g.kind === 'snapshot' && g.where === name && g.name === want) || null;
    const found = (inst.snapshots || []).find((s) => s && s.name === want) || null;
    const coverage = snapshotCoverage(inst);
    if (found && recorded && recorded.created_at && recorded.created_at === found.created_at) {
      snapshot = { name: want, created_at: found.created_at || null, reused: true, verified: true, coverage };
      job.event?.('reuse', `pre-change snapshot ${want} from the previous attempt still exists with its recorded timestamp and is reused`, { name: want });
    } else if (writeBegun) {
      // A write began under the original snapshot. Its identity cannot be
      // verified now: the completed changes are read back below, the
      // remaining ones are not issued, and no replacement is taken.
      // A recorded name without a timestamp is not an identity: it can
      // certify nothing, so it is `unverifiable`, never a wildcard.
      const state = !found ? (recorded ? 'missing' : 'unverifiable') : recorded?.created_at ? 'replaced' : 'unverifiable';
      snapshot = { name: want, created_at: recorded?.created_at || null, reused: false, verified: false, [state]: true, ...(found ? { onGuest: { created_at: found.created_at || null } } : {}), coverage };
      protection = { state, snapshot: want, detail: state === 'replaced' ? `snapshot ${want} on ${name} is not the one this change recorded (timestamp ${found.created_at}, recorded ${recorded.created_at})` : state === 'missing' ? `the pre-change snapshot ${want} recorded for this change is no longer on ${name}` : recorded ? `the pre-change snapshot ${want} was recorded for this change without a timestamp; the one on ${name} cannot be certified as it` : `no pre-change snapshot identity was recorded for the write that began` };
      job.event?.('step', `${protection.detail}; the changes already applied are read back, the remaining ones are NOT issued, and no replacement snapshot is taken`, { snapshot: want, state }, 'protect');
    } else if (found) {
      return fail('protect', `snapshot ${want} already exists on ${name}${recorded ? (recorded.created_at ? ` with a different timestamp than the one this job recorded (${recorded.created_at})` : ' and this job recorded it without a timestamp, so it cannot be certified') : ' and was not taken by this request'}; refusing to change ${name} behind a pre-change snapshot of unknown content — delete it or submit a new request`, { refused: true, instanceState: inst.status || null, identity });
    } else {
      const c = await createSnapshotWithFallback(host, name, want, { timeoutMs: TIMEOUTS.snapshot });
      if (!c.ok) return fail('protect', `refusing to change ${name} without its pre-change snapshot: ${c.error}`, { instanceState: inst.status || null, identity });
      const again = await list();
      if (again.error) return fail('protect', `the pre-change snapshot ${want} was issued but the guest could not be read back: ${again.error}`, { instanceState: null, identity });
      const now = again.instance && (again.instance.snapshots || []).find((s) => s && s.name === want);
      if (!now) return fail('protect', `the pre-change snapshot ${want} was reported created but is not on the instance; refusing to continue`, { instanceState: again.instance?.status || null, identity });
      inst = again.instance;
      snapshot = { name: want, created_at: now.created_at || null, reused: false, verified: true, coverage };
      job.generated({ kind: 'snapshot', name: want, where: name, created_at: snapshot.created_at });
    }
    snapshot.covers = snapshotCoverageNote(coverage);
    mark('protect', cp({ issued: issuedBefore, snapshot, applied: prior?.applied || null, ...(protection ? { protection } : {}) }), `pre-change snapshot ${want}${snapshot.reused ? ' reused' : protection ? ` ${protection.state}` : ''} (${snapshot.created_at || 'no timestamp'})`);
  }
  const mutate = !protection;

  // 4) the shared firewall lease.
  lease = FIREWALL_KINDS.includes(kind) ? deps.hostLease || null : null;
  if (lease) {
    report('lease', 'Waiting for the host firewall lease…');
    const started = nowMs(); let contended = null;
    for (;;) {
      const got = lease.acquire(HOST_FIREWALL_LOCK, kind);
      if (got.ok) { held = true; break; }
      if (got.reason === 'stale') {
        const t = lease.takeover(HOST_FIREWALL_LOCK, kind, `taking over the dead holder ${got.holder}'s firewall lease (${kind} is idempotent)`);
        if (t.ok) { held = true; job.event?.('step', `took over the host firewall lease of dead holder ${got.holder}`, null, 'lease'); break; }
      }
      if (nowMs() - started >= FIREWALL_LOCK_WAIT_MS) { contended = got.holder || 'another job'; break; }
      await sleep(LOCK_POLL_MS);
    }
    if (!held) return fail('lease', `the host firewall lease is held by ${contended} (${Math.round(FIREWALL_LOCK_WAIT_MS / 1000)} s waited); nothing was changed — submit it again when it is free`, { contended: true, refused: true, instanceState: inst?.status || null, identity });
  }

  // 5) the steps: read again (the state may have moved), issue when needed, read back.
  let current = null; let issuedThisStep = false;
  let rollback = null;
  try {
    for (const step of steps) {
      current = step; issuedThisStep = false;
      job.fence({ safe: !issuedAny });
      report(step.key, step.label);
      const before = await step.check();
      if (before.ok) {
        // The state already holds. Before any command it is somebody else's
        // doing (a remove whose device is not there is refused, not
        // claimed); after an interrupted issue it is this job's work.
        const already = step.refuseAlready ? step.refuseAlready(before, { issuedBefore }) : null;
        if (already) { stopped = { step: step.key, refused: true, notFound: !!before.notFound, error: already }; break; }
        // A resource present after an interrupted attempt that had begun
        // writing, with no record of this step and no ownership record, may
        // have been created by that attempt just before its record was
        // persisted: `present` with ownership uncertain — never claimed as
        // pre-existing, never removed by the settlement (R-057).
        const rec = applied[step.key];
        const uncertain = issuedBefore && !rec && !!step.creates && !owned(step.creates);
        applied[step.key] = { state: rec?.issued ? 'done' : uncertain ? 'present' : 'already', observed: before.observed, issued: false, ...(step.creates ? (uncertain ? { owned: null, ownership: 'uncertain', detail: `present after an interrupted attempt that had begun writing, with no record of this step: whether that attempt created it is not recorded` } : { owned: owned(step.creates) }) : {}), ...(before.extra || {}) };
        continue;
      }
      const refusal = step.refuse ? step.refuse(before, { issuedBefore }) : null;
      if (refusal) { stopped = { step: step.key, refused: true, notFound: !!before.notFound, error: refusal }; break; }
      if (!mutate) {
        // The original snapshot could not be verified: this step needs a
        // write and does not get one.
        applied[step.key] = { state: 'not_run', observed: before.observed, issued: false, detail: `not issued: ${protection.detail}` };
        stopped = { step: 'protect', protection: true, error: `${protection.detail}; the remaining change (${step.key}) was NOT issued — the changes already applied are on this record with their prior values (previous); revert them from those values, or submit a new request deliberately (it takes a fresh snapshot of the guest as it is now, not the original pre-change point)` };
        break;
      }
      if (!issuedAny) {
        try {
          mark('issuing', cp({ issued: true, snapshot, applied }), `issuing ${kind} for ${name} (${step.key})`, { required: true });
        } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; stopped = { step: 'checkpoint', notIssued: true, error: `${e.message}; nothing was changed` }; break; }
        issuedAny = true;
        job.fence({ safe: false });
      }
      const r = await step.issue(before);
      issuedThisStep = true;
      // A change this command CREATED (it succeeded and was not tolerated
      // by name — a resource already there is somebody else's) is recorded
      // as this operation's before its read-back, in the fenced progress
      // record: the only evidence its rollback may act on.
      if (step.creates && r.code === 0 && !r.tolerated && !owned(step.creates)) { ownedList.push(step.creates); job.generated(step.creates); }
      const after = await step.check();
      // Done only when the command succeeded (or was tolerated by name) AND
      // the state reads back: a saved configuration behind a nonzero exit is
      // recorded with the exit, never as done.
      const ok = after.ok && r.code === 0;
      const detail = ok ? null : `${step.label} exited ${r.code}${r.code === 124 ? ' (timed out)' : ''}${tailOf(r, 200) ? `: ${tailOf(r, 200)}` : ''}; reads ${after.observed} afterwards`;
      applied[step.key] = { state: ok ? 'done' : 'failed', observed: after.observed, issued: true, exit: r.code, ...(r.tolerated ? { tolerated: true } : {}), ...(r.saved ? { saved: true } : {}), ...(r.superseded ? { superseded: true } : {}), ...(r.reconcile ? { reconcile: r.reconcile } : {}), ...(step.creates ? { owned: owned(step.creates) } : {}), ...(detail ? { detail } : {}), ...(after.extra || {}) };
      // The step's outcome is REQUIRED on the record before anything acts on
      // it: a checkpoint that changes no row means the claim moved (the
      // fence raises FencedError) or the outcome is unrecorded — in either
      // case no cleanup follows from it.
      try {
        mark('applied', cp({ issued: true, snapshot, applied }), `${step.key}: ${applied[step.key].state}`, { required: true });
      } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; stopped = { step: 'checkpoint', unrecorded: true, error: `${e.message}; the outcome of ${step.key} (${applied[step.key].state}) could not be recorded — no rollback is attempted from an unrecorded outcome; retry it (every step re-reads before it issues)` }; break; }
      if (!ok) {
        if (step.required === false) { warnings.push(`${step.key}: ${detail}`); continue; }
        stopped = { step: step.key, error: detail, refused: !!r.superseded, superseded: !!r.superseded };
        break;
      }
    }
    // The forward's disposition, the job's own: a definite failure after its
    // row was written rolls the row and this attempt's host resources back;
    // a row that could not be written (superseded) leaves this id's orphans
    // removed — never host resources without an authoritative row.
    if (kind === 'forward_apply' && stopped && !stopped.notIssued && stopped.step !== 'checkpoint' && (issuedAny || stopped.superseded)) {
      rollback = await settleForward({ p, name, run, instance, applied, store: deps.forwardStore, owned, job, report });
    }
  } catch (e) {
    if (e instanceof SharedLeaseLostError || e?.code === 'SHARED_LEASE_LOST') {
      // The step under way: its command may have been issued and its
      // read-back not done — `unverified`, never `done`; the steps after it
      // were not run. A retry re-reads every step before it issues.
      job.event?.('step', e.message, { lease: e.lease, issued: issuedUnderLease }, current?.key || 'lease');
      if (current) applied[current.key] = { state: issuedThisStep ? 'unverified' : 'failed', leaseLost: true, issued: issuedThisStep, detail: `${e.message}${issuedThisStep ? '; the command had been issued and its read-back was not done under the lease' : ''}` };
      const notRunAfter = steps.filter((s) => !applied[s.key]).map((s) => s.key);
      if (held) { try { lease.release(HOST_FIREWALL_LOCK); } catch { /* */ } held = false; }
      return fail('lease', `${e.message}; ${name}: ${kind} was not completed by this job — retry it (every step re-reads before it issues)`, { leaseLost: true, lease: e.lease, issued: issuedAny, applied, notRun: notRunAfter, snapshot, previous, instanceState: inst?.status || null, identity, partial: Object.values(applied).some((a) => a.state === 'done'), verification: configVerification(kind, false, { container: name, label: e.message, failedAt: current?.key || 'lease' }) });
    }
    if (e instanceof ReadBackError) {
      if (held) { try { lease.release(HOST_FIREWALL_LOCK); } catch { /* */ } held = false; }
      return fail(current?.key || 'verify', `${name}: the guest could not be read back during ${current?.key || kind}: ${e.message}; not claiming ${configOutcomeStep(kind)}`, { issued: issuedAny, applied, snapshot, previous, instanceState: null, identity, verification: configVerification(kind, false, { container: name, label: e.message, failedAt: current?.key || 'verify' }) });
    }
    if (held) { try { lease.release(HOST_FIREWALL_LOCK); } catch { /* */ } held = false; }
    throw e;
  } finally {
    if (held) { try { lease.release(HOST_FIREWALL_LOCK); } catch { /* */ } }
  }

  // 6) the verdict.
  const notRun = steps.filter((s) => !applied[s.key]).map((s) => s.key);
  const failedSteps = Object.entries(applied).filter(([k, a]) => a.state === 'failed' && steps.find((s) => s.key === k)?.required !== false).map(([k]) => k);
  const ok = !stopped && failedSteps.length === 0 && notRun.length === 0;
  if (ok && protection) warnings.push(`${protection.detail}; no further change was needed — the completed changes were read back only`);
  const summary = summarize(applied);
  const partial = !ok && (Object.values(applied).some((a) => a.state === 'done') || rollback?.unresolvedOwnership?.length > 0);
  const extras = collect(kind, applied);
  mark('verified', cp({ issued: issuedAny, snapshot, applied, ok, ...(rollback ? { rollback } : {}), ...(protection ? { protection } : {}) }), ok ? `${name}: ${summary}; verified` : `${name}: ${summary}; ${stopped?.error || 'not verified'}`);
  log(kind, `${name}: ${summary}${warnings.length ? `; ${warnings.join('; ')}` : ''}`);
  if (!ok) {
    const error = stopped?.error ? `${stopped.error}${partial && !stopped.protection ? ` (applied before it: ${Object.entries(applied).filter(([k, a]) => k !== 'rollback' && (a.state === 'done' || a.state === 'already')).map(([k]) => k).join(', ')})` : ''}${notRun.length ? `; not run: ${notRun.join(', ')}` : ''}${rollback ? `; ${rollback.summary}` : ''}${snapshot && !stopped.protection ? `; pre-change snapshot ${snapshot.name}` : ''}` : `${name}: ${summary}`;
    return fail(stopped?.step || failedSteps[0] || 'verify', error, {
      refused: !!stopped?.refused, notFound: !!stopped?.notFound, notIssued: !!stopped?.notIssued, superseded: !!stopped?.superseded, issued: issuedAny, partial, applied, notRun, snapshot, previous, instanceState: inst?.status || null, identity, ...extras,
      ...(protection ? { protection } : {}), ...(rollback ? { rollback } : {}),
      ...(warnings.length ? { warnings } : {}),
      verification: configVerification(kind, false, { container: name, label: `${name}: ${summary}`, failedAt: stopped?.step || failedSteps[0] || 'verify', ...(rollback?.unresolvedOwnership?.length ? { next: `ownership unresolved after an interrupted attempt: ${rollback.unresolvedOwnership.join(', ')} — read the guest ('incus list ${name} --format json') and the firewall ('proxypilot --json firewall list'), decide whether each belongs to forward ${p.forward?.id}, remove it by hand if it does, then retry` } : {}), facts: { applied: Object.fromEntries(Object.entries(applied).map(([k, a]) => [k, a.state])), ...(rollback?.unresolvedOwnership?.length ? { unresolvedOwnership: rollback.unresolvedOwnership } : {}) } }),
    });
  }
  return {
    ok: true, step: configOutcomeStep(kind), instanceState: inst?.status || null, identity, snapshot, previous, applied, ...extras,
    alreadyInState: !issuedAny && !issuedBefore, resumedAfterIssue: issuedBefore,
    ...(warnings.length ? { warnings } : {}),
    verification: configVerification(kind, true, { container: name, label: `${name}: ${summary}`, facts: { applied: Object.fromEntries(Object.entries(applied).map(([k, a]) => [k, a.state])) } }),
  };
}

class ReadBackError extends Error { constructor(m) { super(m); this.name = 'ReadBackError'; this.code = 'READ_BACK'; } }

// The prior state a job records for reversal — references only.
function priorState(kind, p, inst) {
  switch (kind) {
    case 'config_set': return { config: priorConfig(inst, (p.changes || []).map((c) => c.key)), ...(p.rootSize != null ? { rootSize: priorRootSize(inst) } : {}) };
    case 'device_add': return { device: recordedDevice((inst?.devices || {})[p.device]) };
    case 'device_remove': return { device: recordedDevice((inst?.devices || {})[p.device]) };
    case 'network_pin': return { pin: priorPin(inst), address: p.previous || null };
    case 'forward_apply': case 'forward_remove': return { device: recordedDevice((inst?.devices || {})[forwardDeviceName(p.forward.id)]) };
    default: return null;
  }
}

// The forward row as the store holds it, compared with the plan (references only).
function rowVerdict(row, f, serviceId) {
  if (!row) return { ok: false, observed: 'absent' };
  const want = { service_id: serviceId, proto: f.proto, listen_port: Number(f.listen), listen_port_end: f.listenEnd != null ? Number(f.listenEnd) : null, connect_port: Number(f.connect), connect_port_end: f.connectEnd != null ? Number(f.connectEnd) : null };
  const mismatched = Object.keys(want).filter((k) => (row[k] ?? null) !== want[k]).map((k) => `${k}=${row[k] ?? '(unset)'}`);
  if (mismatched.length) return { ok: false, observed: `present with other fields (${mismatched.join(', ')})`, other: true };
  return { ok: Number(row.enabled ?? 1) === 1, observed: Number(row.enabled ?? 1) === 1 ? 'present' : 'present but disabled' };
}

// buildSteps(kind, p, io) → [{ key, label, required?, check() → { ok, observed, extra?, … }, issue(before) → result, refuse?(before), refuseAlready?(before) }]
function buildSteps(kind, p, { name, run, instance, reservedPath, store }) {
  const incus = (argv) => run(argv, { timeoutMs: TIMEOUTS.incus });
  const fw = (argv) => run(argv, { timeoutMs: TIMEOUTS.firewall });
  // The applied-policy step every firewall kind ends with: the recorded
  // reconcile against the desired ruleset's checksum; a reconcile issued
  // when they differ, `done` only when it reports ok and applied.
  const reconcileStep = () => ({
    key: 'reconcile', label: 'apply the saved firewall configuration (reconcile)',
    check: async () => {
      const st = await fw(firewallStatusArgv()); const dr = await fw(firewallDryRunArgv());
      const ev = reconcileEvidence(st.code === 0 ? parseCliJson(st.stdout) : null, dr.code === 0 ? parseCliJson(dr.stdout) : parseCliJson(dr.stdout));
      return { ok: ev.ok, observed: ev.observed, extra: { desired: ev.desired, last: ev.last ? { checksum: ev.last.ruleset_checksum ?? null, applied: Number(ev.last.applied) === 1, rejection: ev.last.rejection_reason ?? null } : null } };
    },
    issue: async () => { const r = await fw(firewallReconcileArgv()); const j = parseCliJson(r.stdout); r.reconcile = j ? { applied: j.applied === true, checksum: j.checksum ?? null, rejection: j.rejection ? (j.rejection.reason || String(j.rejection)) : null } : null; if (j && !(j.ok === true && j.applied === true) && r.code === 0) return { ...r, code: 1, stderr: `reconcile not applied: ${r.reconcile?.rejection || 'unknown'}` }; return r; },
  });
  // A firewall write the CLI SAVED but could not apply (its JSON carries the
  // rule / payload with a reconcile rejection) is a saved configuration:
  // tolerated here, and the reconcile step then fails on the evidence.
  // (`saved`, not `tolerated`: the write IS this operation's creation.)
  const savedBehindRejection = (r) => { const c = firewallCliResult(r); return c.saved && c.reconcile && !c.reconcile.applied ? { ...r, code: 0, saved: true, reconcile: c.reconcile } : { ...r, ...(c.reconcile ? { reconcile: c.reconcile } : {}) }; };
  switch (kind) {
    case 'config_set': {
      const steps = (p.changes || []).map((c) => ({
        key: `config:${c.key}`, label: `set ${c.key}=${c.value}`,
        check: async () => { const v = configKeyVerdict(await instance(), c.key, c.value); return { ok: v.ok, observed: v.observed == null ? '(unset)' : `${c.key}=${v.observed}` }; },
        issue: () => incus(configSetArgv(name, c.key, c.value)),
      }));
      if (p.rootSize != null) steps.push({
        key: 'root.size', label: `set the root disk size to ${p.rootSize}`,
        check: async () => { const v = rootSizeVerdict(await instance(), p.rootSize); return { ok: v.ok, observed: v.observed == null ? '(unset)' : `size=${v.observed}` }; },
        issue: async () => { const r = await incus(rootSizeOverrideArgv(name, p.rootSize)); if (r.code !== 0 && /already exists|already has|instance-level|already overrid/i.test(r.stderr || '')) return incus(rootSizeSetArgv(name, p.rootSize)); return r; },
      });
      return steps;
    }
    case 'device_add': return [{
      key: 'device', label: `add ${p.deviceType} device ${p.device}`,
      check: async () => { const v = deviceVerdict(await instance(), p.device, { present: true, type: p.deviceType, props: p.props }); return { ok: v.ok, observed: v.observed, device: v.device, mismatched: v.mismatched }; },
      refuse: (before, { issuedBefore }) => (before.device && !issuedBefore ? `device ${p.device} already exists on ${name} ${before.observed}; a device is never replaced — remove it first` : null),
      issue: () => incus(deviceAddArgv(name, p.device, p.deviceType, p.props)),
    }];
    case 'device_remove': return [{
      key: 'device', label: `remove device ${p.device}`,
      check: async () => { const v = deviceVerdict(await instance(), p.device, { present: false }); return { ok: v.ok, observed: v.observed, notFound: v.ok, device: v.device }; },
      refuseAlready: (before, { issuedBefore }) => (issuedBefore ? null : `device ${p.device} does not exist on ${name}; nothing was done`),
      issue: () => incus(deviceRemoveArgv(name, p.device)),
    }];
    case 'network_pin': return [{
      key: 'eth0', label: `pin eth0 to ${p.ip}`,
      check: async () => { const v = networkVerdict(await instance(), p.ip); return { ok: v.ok, observed: v.observed == null ? 'no instance-level reservation' : `ipv4.address=${v.observed}` }; },
      issue: async () => { const r = await incus(networkPinOverrideArgv(name, p.ip)); if (r.code !== 0 && /already exists/i.test(r.stderr || '')) return incus(networkPinSetArgv(name, p.ip)); return r; },
    }];
    case 'forward_apply': case 'forward_remove': {
      const apply = kind === 'forward_apply';
      const f = p.forward; const dev = forwardDeviceName(f.id);
      const props = apply ? { listen: forwardListen(f), connect: forwardConnect(f, p.bridgeIp) } : null;
      return [
        {
          // The authoritative row, under the leases: written before the host
          // for an apply, removed before the host for a remove (the L4
          // reconciler treats the rows as authoritative and sweeps orphans).
          key: 'row', label: apply ? `record forward ${f.id} in service_l4_forwards` : `remove forward ${f.id} from service_l4_forwards`,
          ...(apply ? { creates: { kind: 'forward_row', name: f.id, where: name } } : {}),
          check: async () => { const row = store.get(f.id); if (apply) { const v = rowVerdict(row, f, p.serviceId); return { ok: v.ok, observed: v.observed, other: !!v.other }; } return { ok: !row, observed: row ? 'present' : 'absent' }; },
          refuse: (before) => (apply && before.other ? `forward ${f.id} is recorded ${before.observed}; a row is never rewritten — remove the forward and add it again` : null),
          issue: async () => {
            if (!apply) { store.delete(f.id); return { code: 0, stdout: '', stderr: '' }; }
            const r = store.insert({ id: f.id, service_id: p.serviceId, proto: f.proto, listen_port: f.listen, listen_port_end: f.listenEnd ?? null, connect_port: f.connect, connect_port_end: f.connectEnd ?? null, description: f.description ?? null });
            if (r.ok) return { code: 0, stdout: '', stderr: '' };
            return { code: 2, stdout: '', stderr: r.conflict ? `superseded: ${r.conflict}` : `row not written: ${r.error || 'unknown'}`, superseded: !!r.conflict };
          },
        },
        {
          key: 'device', label: apply ? `add proxy device ${dev} (${props.listen} → ${props.connect})` : `remove proxy device ${dev}`,
          ...(apply ? { creates: { kind: 'proxy_device', name: dev, where: name } } : {}),
          check: async () => { const v = deviceVerdict(await instance(), dev, apply ? { present: true, type: 'proxy', props } : { present: false }); return { ok: v.ok, observed: v.observed, device: v.device }; },
          refuse: (before, { issuedBefore }) => (apply && before.device && !issuedBefore ? `proxy device ${dev} already exists on ${name} ${before.observed}; it is never replaced — remove the forward and add it again` : null),
          issue: async () => { const r = await incus(apply ? forwardDeviceAddArgv(name, f, p.bridgeIp) : forwardDeviceRemoveArgv(name, f.id)); if (r.code !== 0 && (apply ? /already exists|conflict/i : /not found|doesn't exist|does not exist/i).test(r.stderr || '')) return { ...r, code: 0, tolerated: true }; return r; },
        },
        {
          key: 'rule', label: apply ? `save firewall rule ${forwardRuleId(f.id)}` : `remove firewall rule ${forwardRuleId(f.id)}`,
          ...(apply ? { creates: { kind: 'firewall_rule', name: forwardRuleId(f.id), where: name } } : {}),
          check: async () => { const r = await fw(firewallListArgv()); const list = r.code === 0 ? parseCliJson(r.stdout) : null; const v = forwardRuleVerdict(list, f, p.serviceTag || null, { present: apply }); return { ok: v.ok, observed: v.observed, ...(v.mismatched?.length ? { extra: { mismatched: v.mismatched } } : {}) }; },
          issue: async () => { const r = await fw(apply ? firewallAddArgv(f, p.serviceTag || null) : firewallRemoveArgv(f.id)); const text = `${r.stdout || ''}\n${r.stderr || ''}`; if (r.code !== 0 && (apply ? /already exists/i : /not found|NOT_FOUND|already_absent/i).test(text)) return { ...r, code: 0, tolerated: true }; return r.code !== 0 ? savedBehindRejection(r) : { ...r, ...(firewallCliResult(r).reconcile ? { reconcile: firewallCliResult(r).reconcile } : {}) }; },
        },
        reconcileStep(),
        {
          // The reserved UDP ranges: recomputed from the authoritative rows
          // under the lease at the moment of the check and of the write —
          // never an aggregate carried in the plan.
          key: 'reserved', label: 'refresh the reserved UDP port ranges from the rows', required: false,
          check: async () => {
            const plan = reservedPlan(store.reservedRanges());
            const r = await run(reservedReadArgv(reservedPath), { timeoutMs: TIMEOUTS.sysctl });
            const body = r.code === 0 ? String(r.stdout || '') : '';
            const s = await run(sysctlReadArgv(), { timeoutMs: TIMEOUTS.sysctl });
            const live = s.code === 0 ? String(s.stdout || '').trim() : null;
            const fileOk = body === plan.body;
            const liveOk = live != null && live === plan.value;
            return { ok: fileOk && liveOk, observed: `${fileOk ? 'drop-in current' : plan.body ? 'drop-in differs' : 'drop-in present'}, kernel ${live == null ? 'unreadable' : live === '' ? '(none)' : live}`, extra: { value: plan.value, file: fileOk, live: liveOk } };
          },
          issue: async () => {
            const plan = reservedPlan(store.reservedRanges());
            const w = plan.body ? await run(reservedWriteArgv(plan.body, reservedPath), { timeoutMs: TIMEOUTS.sysctl }) : await run(reservedRemoveArgv(reservedPath), { timeoutMs: TIMEOUTS.sysctl });
            if (w.code !== 0) return w;
            return run(sysctlApplyArgv(plan.body ? reservedPath : '/etc/sysctl.conf'), { timeoutMs: TIMEOUTS.sysctl });
          },
        },
      ];
    }
    case 'egress_set': return [
      {
        key: 'egress', label: `${p.action} egress ${p.service} (saved configuration)`,
        check: async () => { const r = await fw(egressListArgv()); const listing = r.code === 0 ? parseCliJson(r.stdout) : null; const v = egressVerdict(listing, name, p.service, p.action); return { ok: v.ok, observed: v.observed, extra: { allow: v.allow } }; },
        issue: async () => { const r = await fw(egressArgv(name, p.action, p.service, p.reason || null)); if (r.code !== 0 && p.action === 'deny' && /no egress entry/i.test(`${r.stdout}\n${r.stderr}`)) return { ...r, code: 0, tolerated: true }; return r.code !== 0 ? savedBehindRejection(r) : { ...r, ...(firewallCliResult(r).reconcile ? { reconcile: firewallCliResult(r).reconcile } : {}) }; },
      },
      reconcileStep(),
    ];
    default: return [];
  }
}

// settleForward — a forward_apply's disposition after a definite failure
// or a superseded row: of the row, the device and the rule this id holds,
// ONLY those this operation created (`owned`: the engine's fenced generated
// records) are removed; a change that was there before it is kept and
// named as such; the reservation is recomputed; a policy the reconcile
// could not apply is reported unresolved. Fenced at every write: the
// store refuses a write once the claim or a lease moved, and a fencing,
// ownership-loss or cancellation error propagates at once — only a host
// read-back failure is best effort (`unknown`). The summary names what
// could not be removed (the L4 reconciler sweeps an orphan device).
async function settleForward({ p, name, run, instance, applied, store, owned, job, report }) {
  const f = p.forward; const dev = forwardDeviceName(f.id); const ruleId = forwardRuleId(f.id);
  const out = { row: null, device: null, rule: null, reconcile: null, reserved: null, unresolved: null, unresolvedOwnership: [], summary: '' };
  const NOT_OURS = 'kept (not created by this operation)';
  // Ownership uncertain (R-057): not removed, and never reported settled.
  const UNSURE = 'unresolved (present after the interrupted attempt; its creation is not recorded) — not removed';
  const unsure = (key) => applied[key]?.ownership === 'uncertain';
  report('rollback', `settling forward ${f.id}…`);
  job.fence({ safe: false });
  const readBack = async (fn) => { try { return await fn(); } catch (e) { if (e instanceof ReadBackError) return { unknown: e.message }; throw e; } };
  // The row: through the fenced store, and only when this operation wrote it.
  const had = !!store.get(f.id);
  out.row = !had ? 'absent' : unsure('row') ? UNSURE : !owned({ kind: 'forward_row', name: f.id }) ? NOT_OURS : store.delete(f.id) > 0 ? 'removed' : 'kept';
  // The device: only when this operation added it.
  const i = await readBack(instance);
  if (i?.unknown) out.device = `unknown: ${sanitizeReason(i.unknown, 120)}`;
  else if (!(i?.devices || {})[dev]) out.device = 'absent';
  else if (unsure('device')) out.device = UNSURE;
  else if (!owned({ kind: 'proxy_device', name: dev })) out.device = NOT_OURS;
  else {
    const r = await run(forwardDeviceRemoveArgv(name, f.id), { timeoutMs: TIMEOUTS.incus });
    const again = await readBack(instance);
    out.device = again?.unknown ? `unknown: ${sanitizeReason(again.unknown, 120)}` : (again?.devices || {})[dev] ? `kept (exit ${r.code})` : 'removed';
  }
  // The rule: only when this operation saved it.
  const l = await run(firewallListArgv(), { timeoutMs: TIMEOUTS.firewall }); const list = l.code === 0 ? parseCliJson(l.stdout) : null;
  if (!Array.isArray(list)) out.rule = 'unreadable';
  else if (!list.some((r) => r && r.id === ruleId)) out.rule = 'absent';
  else if (unsure('rule')) out.rule = UNSURE;
  else if (!owned({ kind: 'firewall_rule', name: ruleId })) out.rule = NOT_OURS;
  else {
    const r = await run(firewallRemoveArgv(f.id), { timeoutMs: TIMEOUTS.firewall }); const c = firewallCliResult(r);
    out.rule = c.saved || r.code === 0 ? 'removed' : `kept (exit ${r.code})`;
    out.reconcile = c.reconcile ? (c.reconcile.applied ? 'applied' : `rejected: ${c.reconcile.rejection || 'unknown'}`) : null;
  }
  out.reserved = reservedPlan(store.reservedRanges()).value || '(none)';
  if (applied.reconcile?.state === 'failed') out.unresolved = `the applied firewall policy is unresolved: ${applied.reconcile.reconcile?.rejection || applied.reconcile.detail || 'the reconcile did not apply'}`;
  const removed = ['row', 'device', 'rule'].filter((k) => out[k] === 'removed');
  const leftovers = ['device', 'rule'].filter((k) => out[k] && /^(kept \(exit|unknown|unreadable)/.test(out[k]));
  out.unresolvedOwnership = ['row', 'device', 'rule'].filter((k) => out[k] === UNSURE);
  const named = { row: `the row of forward ${f.id} in service_l4_forwards`, device: `proxy device ${dev} on ${name}`, rule: `firewall rule ${ruleId}` };
  out.summary = `${removed.length ? 'rolled back' : 'nothing rolled back'}: row ${out.row}, device ${out.device}, rule ${out.rule}${out.reconcile ? ` (reconcile ${out.reconcile})` : ''}${leftovers.length ? ` — ${leftovers.join(' and ')} could not be removed by this job; the L4 reconciler sweeps an orphan device at its next pass, or retry` : ''}${out.unresolvedOwnership.length ? `; ownership unresolved: ${out.unresolvedOwnership.map((k) => named[k]).join(', ')} — decide whether it belongs to forward ${f.id} and remove it by hand if it does, or retry once the forward is wanted; this job removed nothing whose ownership it could not establish` : ''}${out.unresolved ? `; ${out.unresolved}` : ''}`;
  applied.rollback = { state: out.unresolvedOwnership.length ? 'unresolved' : leftovers.length ? 'partial' : removed.length ? 'done' : 'none', ...out };
  job.event?.('step', out.summary, { rollback: out }, 'rollback');
  return out;
}

function summarize(applied) {
  return Object.entries(applied).filter(([k]) => k !== 'rollback').map(([k, a]) => `${k} ${a.state}${a.state === 'already' ? ' (nothing issued)' : ''}`).join(', ') || 'nothing recorded';
}

// The kind-specific extras a result carries beside `applied`.
function collect(kind, applied) {
  if (kind === 'forward_apply' || kind === 'forward_remove') return { reserved: applied.reserved ? { state: applied.reserved.state, value: applied.reserved.value ?? null, file: applied.reserved.file ?? null, live: applied.reserved.live ?? null, ...(applied.reserved.detail ? { detail: applied.reserved.detail } : {}) } : null, row: applied.row ? { state: applied.rollback?.row === 'removed' ? 'rolled_back' : applied.row.state, observed: applied.row.observed ?? null, ...(applied.row.owned != null ? { owned: applied.row.owned } : {}) } : null, firewallPolicy: applied.reconcile ? { state: applied.reconcile.state, observed: applied.reconcile.observed ?? null } : null };
  if (kind === 'egress_set') return { allow: applied.egress?.allow || [], reconcile: applied.reconcile?.reconcile || applied.egress?.reconcile || null, firewallPolicy: applied.reconcile ? { state: applied.reconcile.state, observed: applied.reconcile.observed ?? null } : null };
  return {};
}
