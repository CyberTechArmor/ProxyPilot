// Setup engine — the guest configuration verbs as ONE operation (A-17.8),
// over the host executor's argv channel: `incus config …` and the firewall
// CLI, rendered by config-logic.js from a validated plan, never a shell
// string and never a command from the request.
//
//   query      `incus list <name> --format json`: the guest exists and is the
//              one the operator confirmed (params.expect) and the one an
//              interrupted attempt bound (the prior checkpoint's target);
//              the PRIOR state of what the job changes is recorded
//   protect    the pre-mutation snapshot the plan names (the MCP verbs):
//              taken, or REUSED when this job's earlier attempt / the retry's
//              origin recorded it and it is still there with the same
//              created_at; read back present BEFORE anything is changed; a
//              snapshot that fails prevents the change; the coverage stated
//   lease      the firewall kinds take the host-wide `@host/firewall` lease
//              after the guest's (waited for, a dead holder taken over,
//              contended → nothing issued); renewed before every command
//   steps      one per resource: each step READS its own state first and
//              issues its fixed command only when the state does not hold,
//              then reads it back — so a resumed or retried job converges
//              without replaying blindly; the first mutation is preceded by
//              the mandatory `issuing` checkpoint; a step that does not read
//              back stops the sequence and the record says what was applied
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
  egressArgv, egressListArgv, reservedReadArgv, reservedWriteArgv, reservedRemoveArgv, sysctlApplyArgv, sysctlReadArgv, reservedPlan,
  priorConfig, priorRootSize, priorPin, recordedDevice, configKeyVerdict, rootSizeVerdict, deviceVerdict, networkVerdict, ruleVerdict, egressVerdict, parseCliJson,
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
//   { ok: false, step, error, refused?, notFound?, contended?, partial?, applied, snapshot, verification? }
// `prior` is this job's own checkpoint from an interrupted attempt; `reuse`
// the resources the retry's origin recorded (a snapshot by name +
// created_at); deps: hostLease { acquire, takeover, renew, release },
// sleep, nowMs, reservedPortsPath.
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
  const needsInstance = kind !== 'egress_set';
  const warnings = [];

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
  const cp = (extra = {}) => ({ config: true, resumable: true, disruptive: false, kind, container: name, target: identity, previous, ...extra });
  try {
    mark('validated', cp({ issued: issuedBefore, snapshot: prior?.snapshot || null, applied: prior?.applied || null }), `${kind} of ${name} validated${p.expect ? ' against the confirmed identity' : ''}${resumed ? ' (resumed)' : ''}`, { required: true });
  } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; return fail('checkpoint', `${e.message}; nothing was changed`, { notIssued: true, instanceState: inst?.status || null, identity }); }

  // 2) every step read FIRST: a refusal (a device that exists with other
  // properties, a remove of a device that is not there) is answered before
  // any snapshot is taken or any lease waited for, and a request whose
  // whole state already holds ends here with nothing issued and no
  // snapshot — there is nothing to protect.
  const instance = async () => { const r = await list(); if (r.error) throw new ReadBackError(r.error); return r.instance; };
  const steps = buildSteps(kind, p, { name, run, instance, reservedPath });
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

  // 3) the pre-mutation snapshot.
  let snapshot = null;
  if (p.snapshot) {
    report('protect', 'Taking the pre-change snapshot…');
    const want = String(p.snapshot.name);
    const recorded = (prior?.snapshot && prior.snapshot.name === want ? prior.snapshot : null) || reuse.find((g) => g.kind === 'snapshot' && g.where === name && g.name === want) || null;
    const found = (inst.snapshots || []).find((s) => s && s.name === want) || null;
    const coverage = snapshotCoverage(inst);
    if (found) {
      if (recorded && (!recorded.created_at || recorded.created_at === found.created_at)) {
        snapshot = { name: want, created_at: found.created_at || null, reused: true, coverage };
        job.event?.('reuse', `pre-change snapshot ${want} from the previous attempt still exists with its recorded timestamp and is reused`, { name: want });
      } else if (issuedBefore) {
        snapshot = { name: want, created_at: found.created_at || null, reused: false, replaced: true, coverage };
        warnings.push(`the pre-change snapshot ${want} on the guest is not the one the interrupted attempt recorded (timestamp ${found.created_at}); the attempt's change was already issued`);
      } else {
        return fail('protect', `snapshot ${want} already exists on ${name}${recorded ? ` with a different timestamp than the one this job recorded (${recorded.created_at})` : ' and was not taken by this request'}; refusing to change ${name} behind a pre-change snapshot of unknown content — delete it or submit a new request`, { refused: true, instanceState: inst.status || null, identity });
      }
    } else if (issuedBefore) {
      snapshot = { name: want, created_at: recorded?.created_at || null, reused: false, missing: true, coverage };
      warnings.push(`the pre-change snapshot ${want} recorded by the interrupted attempt is no longer on the guest; the attempt's change was already issued`);
    } else {
      const c = await createSnapshotWithFallback(host, name, want, { timeoutMs: TIMEOUTS.snapshot });
      if (!c.ok) return fail('protect', `refusing to change ${name} without its pre-change snapshot: ${c.error}`, { instanceState: inst.status || null, identity });
      const again = await list();
      if (again.error) return fail('protect', `the pre-change snapshot ${want} was issued but the guest could not be read back: ${again.error}`, { instanceState: null, identity });
      const now = again.instance && (again.instance.snapshots || []).find((s) => s && s.name === want);
      if (!now) return fail('protect', `the pre-change snapshot ${want} was reported created but is not on the instance; refusing to continue`, { instanceState: again.instance?.status || null, identity });
      inst = again.instance;
      snapshot = { name: want, created_at: now.created_at || null, reused: false, coverage };
      job.generated({ kind: 'snapshot', name: want, where: name, created_at: snapshot.created_at });
    }
    snapshot.covers = snapshotCoverageNote(coverage);
    mark('protect', cp({ issued: issuedBefore, snapshot, applied: prior?.applied || null }), `pre-change snapshot ${want}${snapshot.reused ? ' reused' : snapshot.missing ? ' missing' : ''} (${snapshot.created_at || 'no timestamp'})`);
  }

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
  let issuedAny = issuedBefore;
  let current = null; let issuedThisStep = false;
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
        applied[step.key] = { state: issuedBefore && applied[step.key]?.issued ? 'done' : 'already', observed: before.observed, issued: false, ...(before.extra || {}) };
        continue;
      }
      const refusal = step.refuse ? step.refuse(before, { issuedBefore }) : null;
      if (refusal) { stopped = { step: step.key, refused: true, notFound: !!before.notFound, error: refusal }; break; }
      if (!issuedAny) {
        try {
          mark('issuing', cp({ issued: true, snapshot, applied }), `issuing ${kind} for ${name} (${step.key})`, { required: true });
        } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; stopped = { step: 'checkpoint', notIssued: true, error: `${e.message}; nothing was changed` }; break; }
        issuedAny = true;
        job.fence({ safe: false });
      }
      const r = await step.issue(before);
      issuedThisStep = true;
      const after = await step.check();
      const detail = after.ok ? null : `${step.label} exited ${r.code}${r.code === 124 ? ' (timed out)' : ''}${tailOf(r, 200) ? `: ${tailOf(r, 200)}` : ''}; reads ${after.observed} afterwards`;
      applied[step.key] = { state: after.ok ? 'done' : 'failed', observed: after.observed, issued: true, exit: r.code, ...(r.tolerated ? { tolerated: true } : {}), ...(r.reconcile ? { reconcile: r.reconcile } : {}), ...(detail ? { detail } : {}), ...(after.extra || {}) };
      mark('applied', cp({ issued: true, snapshot, applied }), `${step.key}: ${applied[step.key].state}`);
      if (!after.ok) {
        if (step.required === false) { warnings.push(`${step.key}: ${detail}`); continue; }
        stopped = { step: step.key, error: detail };
        break;
      }
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
  const summary = summarize(applied);
  const partial = !ok && Object.values(applied).some((a) => a.state === 'done');
  const extras = collect(kind, applied);
  mark('verified', cp({ issued: issuedAny, snapshot, applied, ok }), ok ? `${name}: ${summary}; verified` : `${name}: ${summary}; ${stopped?.error || 'not verified'}`);
  log(kind, `${name}: ${summary}${warnings.length ? `; ${warnings.join('; ')}` : ''}`);
  if (!ok) {
    const error = stopped?.error ? `${stopped.error}${partial ? ` (applied before it: ${Object.entries(applied).filter(([, a]) => a.state === 'done' || a.state === 'already').map(([k]) => k).join(', ')})` : ''}${notRun.length ? `; not run: ${notRun.join(', ')}` : ''}${snapshot ? `; pre-change snapshot ${snapshot.name}` : ''}` : `${name}: ${summary}`;
    return fail(stopped?.step || failedSteps[0] || 'verify', error, {
      refused: !!stopped?.refused, notFound: !!stopped?.notFound, notIssued: !!stopped?.notIssued, issued: issuedAny, partial, applied, notRun, snapshot, previous, instanceState: inst?.status || null, identity, ...extras,
      ...(warnings.length ? { warnings } : {}),
      verification: configVerification(kind, false, { container: name, label: `${name}: ${summary}`, failedAt: stopped?.step || failedSteps[0] || 'verify', facts: { applied: Object.fromEntries(Object.entries(applied).map(([k, a]) => [k, a.state])) } }),
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

// buildSteps(kind, p, io) → [{ key, label, required?, check() → { ok, observed, extra?, … }, issue(before) → result, refuse?(before) }]
function buildSteps(kind, p, { name, run, instance, reservedPath }) {
  const incus = (argv) => run(argv, { timeoutMs: TIMEOUTS.incus });
  const fw = (argv) => run(argv, { timeoutMs: TIMEOUTS.firewall });
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
      const f = p.forward; const dev = forwardDeviceName(f.id); const rule = forwardRuleId(f.id);
      const props = apply ? { listen: forwardListen(f), connect: forwardConnect(f, p.bridgeIp) } : null;
      const plan = reservedPlan(p.reserved);
      return [
        {
          key: 'device', label: apply ? `add proxy device ${dev} (${props.listen} → ${props.connect})` : `remove proxy device ${dev}`,
          check: async () => { const v = deviceVerdict(await instance(), dev, apply ? { present: true, type: 'proxy', props } : { present: false }); return { ok: v.ok, observed: v.observed, device: v.device }; },
          refuse: (before, { issuedBefore }) => (apply && before.device && !issuedBefore ? `proxy device ${dev} already exists on ${name} ${before.observed}; it is never replaced — remove the forward and add it again` : null),
          issue: async () => { const r = await incus(apply ? forwardDeviceAddArgv(name, f, p.bridgeIp) : forwardDeviceRemoveArgv(name, f.id)); if (r.code !== 0 && (apply ? /already exists|conflict/i : /not found|doesn't exist|does not exist/i).test(r.stderr || '')) return { ...r, code: 0, tolerated: true }; return r; },
        },
        {
          key: 'rule', label: apply ? `add firewall rule ${rule}` : `remove firewall rule ${rule}`,
          check: async () => { const r = await fw(firewallListArgv()); const list = r.code === 0 ? parseCliJson(r.stdout) : null; const v = ruleVerdict(list, rule, { present: apply }); return { ok: v.ok, observed: v.observed }; },
          issue: async () => { const r = await fw(apply ? firewallAddArgv(f, p.serviceTag || null) : firewallRemoveArgv(f.id)); const text = `${r.stdout || ''}\n${r.stderr || ''}`; if (r.code !== 0 && (apply ? /already exists/i : /not found|NOT_FOUND|already_absent/i).test(text)) return { ...r, code: 0, tolerated: true }; return r; },
        },
        {
          key: 'reserved', label: `refresh the reserved UDP port ranges (${plan.value || 'none'})`, required: false,
          check: async () => {
            const r = await run(reservedReadArgv(reservedPath), { timeoutMs: TIMEOUTS.sysctl });
            const body = r.code === 0 ? String(r.stdout || '') : '';
            const s = await run(sysctlReadArgv(), { timeoutMs: TIMEOUTS.sysctl });
            const live = s.code === 0 ? String(s.stdout || '').trim() : null;
            const fileOk = body === plan.body;
            const liveOk = live != null && live === plan.value;
            return { ok: fileOk && liveOk, observed: `${fileOk ? 'drop-in current' : plan.body ? 'drop-in differs' : 'drop-in present'}, kernel ${live == null ? 'unreadable' : live === '' ? '(none)' : live}`, extra: { value: plan.value, file: fileOk, live: liveOk } };
          },
          issue: async () => {
            const w = plan.body ? await run(reservedWriteArgv(plan.body, reservedPath), { timeoutMs: TIMEOUTS.sysctl }) : await run(reservedRemoveArgv(reservedPath), { timeoutMs: TIMEOUTS.sysctl });
            if (w.code !== 0) return w;
            return run(sysctlApplyArgv(plan.body ? reservedPath : '/etc/sysctl.conf'), { timeoutMs: TIMEOUTS.sysctl });
          },
        },
      ];
    }
    case 'egress_set': return [{
      key: 'egress', label: `${p.action} egress ${p.service}`,
      check: async () => { const r = await fw(egressListArgv()); const listing = r.code === 0 ? parseCliJson(r.stdout) : null; const v = egressVerdict(listing, name, p.service, p.action); return { ok: v.ok, observed: v.observed, extra: { allow: v.allow } }; },
      issue: async () => { const r = await fw(egressArgv(name, p.action, p.service, p.reason || null)); const j = parseCliJson(r.stdout); if (j && j.reconcile) r.reconcile = { applied: j.reconcile.applied ?? null, checksum: j.reconcile.checksum ?? null, rejection: j.reconcile.rejection ?? null }; if (r.code !== 0 && p.action === 'deny' && /no egress entry/i.test(`${r.stdout}\n${r.stderr}`)) return { ...r, code: 0, tolerated: true }; return r; },
    }];
    default: return [];
  }
}

function summarize(applied) {
  return Object.entries(applied).map(([k, a]) => `${k} ${a.state}${a.state === 'already' ? ' (nothing issued)' : ''}`).join(', ') || 'nothing recorded';
}

// The kind-specific extras a result carries beside `applied`.
function collect(kind, applied) {
  if (kind === 'forward_apply' || kind === 'forward_remove') return { reserved: applied.reserved ? { state: applied.reserved.state, value: applied.reserved.value ?? null, file: applied.reserved.file ?? null, live: applied.reserved.live ?? null, ...(applied.reserved.detail ? { detail: applied.reserved.detail } : {}) } : null };
  if (kind === 'egress_set') return { allow: applied.egress?.allow || [], reconcile: applied.egress?.reconcile || null };
  return {};
}
