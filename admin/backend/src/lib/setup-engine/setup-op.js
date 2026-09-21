// Setup engine — the post-launch / post-start guest setup as ONE operation
// (`guest_setup`, platform ledger A-17.7), over the host executor's argv
// channel and the contained guest executor:
//
//   query          `incus list <name> --format json`: the guest exists, is
//                  Running, and is the guest this setup was bound to
//                  (params.expect — the identity the create / start job read
//                  back; refused, nothing run, on a mismatch)
//   network_nat    the fixed host commands, under the host-wide lease
//   await_address  `incus list` until a host-reachable IPv4 or the bound wait
//   dns            the resolv.conf script in the guest
//   ── checkpoint (init_issued) ──
//   init_script    the operator's script, read by reference and verified by
//                  sha256, issued ONCE; its exit code and output tail recorded
//                  here and in the guest (`/var/log/pp-init-<job>.{log,rc}`)
//   routes         delegated to the backend as a `configure_routes` job,
//                  recorded `pending` on this record until that job lands
//
// Every phase writes its state to the record before the next one starts, so
// a record read at any moment says what was done, what was not, and why.
// A phase that fails after the guest is Running does not undo anything: the
// guest stays usable and the record ends `setup_partial`, naming the phase.
// A resumed job (its owner died) repeats the idempotent phases and READS the
// init script's recorded result; it never runs the script again. A retry
// (retryOf) never repeats an init the first attempt issued or completed: it
// KEEPS that attempt's result on its own record (`notRepeated` beside it),
// so a retry of a failed init is still a failed setup. An init whose
// completion is unknown HOLDS the guest's lease (executor) until an operator
// establishes the writer stopped and acknowledges the job.
//
// Nothing a script prints reaches the record: the phases carry states, exit
// codes and the log's reference; the log itself stays in the guest, 0600.

import {
  validateSetupParams, SETUP_PHASES, GUEST_PHASES, HOST_NETWORK_LOCK, DEFAULT_RESOLVERS, DEFAULT_ADDRESS_TIMEOUT_MS, DEFAULT_INIT_TIMEOUT_MS,
  ipForwardArgv, networkListArgv, bridgeNatArgv, dockerUserCheckArgv, dockerUserInsertArgv, masqueradeCheckArgv, masqueradeAppendArgv, managedBridges,
  hostReachableIpv4, dnsScript, parseDns, initScriptWrapper, initResultReadScript, initKillScript, parseInitResult, parseInitKillReport, phaseTable, setupOutcome, phaseSummary, initLogPath,
} from './setup-logic.js';
import { instanceListArgv, instanceIdentity, identityMatches } from './lifecycle-logic.js';
import { parseInstanceList } from './restore-logic.js';
import { hostArgv, noopJob, tailOf, containedGuest, uncontainedGuest, ContainmentUnavailableError } from './op-kit.js';
import { CheckpointNotPersistedError } from './lifecycle-op.js';
import { sanitizeReason } from './logic.js';

export const NAT_LOCK_WAIT_MS = 20_000;

// Thrown when a shared lease this job held (the host network lease) is no
// longer this owner's at this epoch: the job issues nothing further under it.
export class SharedLeaseLostError extends Error {
  constructor(name, detail) { super(`the ${name} lease is no longer this job's${detail ? ` (${detail})` : ''}; no further command is issued under it`); this.name = 'SharedLeaseLostError'; this.code = 'SHARED_LEASE_LOST'; this.lease = name; }
}
const NAT_LOCK_POLL_MS = 500;
const ADDRESS_POLL_MS = 1000;

// runGuestSetupOperation({ params, exec, job, prior, priorPhases, priorAcknowledged, deps, log })
//   → { ok, step, status, outcome, completion, hold, phases, address, warnings, followUp?, verification }
//   { ok: false, step, error, refused?, notFound? }   (nothing run yet)
// deps: readInput(ref) → { content, sha256, bytes } | null; consumeInput(ref);
//       hostLease { acquire(name, operation), takeover(name, operation, reason),
//                   renew(name) → boolean (still this owner at its epoch), release(name) };
//       sleep(ms); nowMs().
// `prior` is this job's own checkpoint from an interrupted attempt;
// `priorPhases` the phase table of the job this one retries, and
// `priorAcknowledged` whether that job's uncertain init was acknowledged.
export async function runGuestSetupOperation({ params, exec, job = noopJob(), prior = null, priorPhases = null, priorAcknowledged = false, deps = {}, log = () => {} }) {
  const v = validateSetupParams(params);
  if (!v.ok) return { ok: false, step: 'validate', refused: true, error: v.reason };
  const host = hostArgv(exec);
  if (!host) return { ok: false, step: 'executor', error: 'this executor offers no host command channel; a guest setup needs the host runner' };
  const p = params;
  const name = String(p.container);
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs || (() => Date.now());
  const report = (key, label) => { try { job.onStep?.(key, label); } catch { /* */ } };
  const fail = (step, error, extra = {}) => ({ ok: false, step, error: sanitizeReason(error, 800), ...extra });
  const mark = (phase, data, message, { required = false } = {}) => {
    let changes;
    try { changes = job.checkpoint(phase, data, message); } catch (e) { if (required) throw new CheckpointNotPersistedError(phase, e?.message || String(e)); return; }
    if (required && job.id && !(Number(changes) > 0)) { job.fence({ safe: false }); throw new CheckpointNotPersistedError(phase, 'the checkpoint changed no row'); }
  };
  const list = async () => {
    const r = await host(instanceListArgv(name), { timeoutMs: 30_000 });
    if (r.code !== 0) return { error: `incus list failed: ${tailOf(r, 300)}` };
    let parsed; try { parsed = JSON.parse(r.stdout || '[]'); } catch { return { error: 'incus list returned something that is not JSON' }; }
    if (!Array.isArray(parsed)) return { error: 'incus list returned something that is not a JSON list' };
    return { instance: parseInstanceList(r.stdout, name) };
  };
  const resumed = !!(prior && prior.setup === true);
  const phases = phaseTable(p.phases, resumed ? prior.phases : null);
  const warnings = [];
  let address = resumed && prior.address ? prior.address : null;
  const record = (ph, data) => { phases[ph] = data; try { job.progress?.({ phases, ...(address ? { address } : {}) }); } catch { /* the finish carries it */ } };

  // 1) the guest, and the binding.
  job.fence({ safe: true });
  report('query', `Reading ${name}…`);
  const q = await list();
  if (q.error) return fail('query', q.error);
  const inst = q.instance;
  if (!inst) return fail('query', `${name} does not exist; nothing was set up`, { notFound: true, instanceState: 'absent' });
  const identity = instanceIdentity(inst);
  const m = identityMatches(p.expect || null, identity);
  if (!m.ok) return fail('target', `${name} is not the guest this setup was bound to (${m.why}); refusing — nothing was run. Submit a new setup for the guest that is there`, { refused: true, instanceState: inst.status || null, identity });
  if (resumed && prior.target) {
    const m2 = identityMatches(prior.target, identity);
    if (!m2.ok) return fail('target', `${name} changed since this job's interrupted attempt bound it (${m2.why}); refusing to continue — nothing further was run`, { refused: true, instanceState: inst.status || null, identity });
  }
  const running = String(inst.status || '').toLowerCase() === 'running';
  if (!running && p.phases.some((ph) => GUEST_PHASES.includes(ph) || ph === 'await_address')) return fail('query', `${name} reads ${inst.status || 'unknown'}, not Running; a guest setup needs a running guest — nothing was run`, { refused: true, instanceState: inst.status || null, identity });
  try {
    mark('validated', { setup: true, resumable: true, disruptive: false, target: identity, container: name, phases: prior?.phases || null, init_issued: prior?.init_issued === true }, `guest setup of ${name} validated${p.expect ? ' against the bound identity' : ''}${resumed ? ' (resumed)' : ''}`, { required: true });
  } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; return fail('checkpoint', `${e.message}; nothing was run`, { notIssued: true, instanceState: inst.status || null, identity }); }

  const contained = containedGuest({ exec, container: name, job });
  // The one script that runs OUTSIDE the job's containment: the kill that
  // stops and inspects the init attempt's writer group must not be a member
  // of the group it kills and counts (op-kit uncontainedGuest).
  const killGuest = uncontainedGuest({ exec, container: name, job });
  let containmentRefused = null;
  const guest = async (phase, script, timeoutMs) => {
    if (containmentRefused) throw containmentRefused;
    try { return await contained.guest(phase, script, timeoutMs); } catch (e) { if (e instanceof ContainmentUnavailableError || e?.code === 'CONTAINMENT_UNAVAILABLE') { containmentRefused = e; } throw e; }
  };

  for (const phase of p.phases) {
    job.fence({ safe: phase !== 'init_script' });
    if (phase === 'network_nat') {
      report('network_nat', 'Ensuring NAT and forwarding on the host…');
      mark('network_nat', { setup: true, resumable: true, disruptive: false, phases }, 'network_nat');
      record('network_nat', await natPhase({ host, deps, job, sleep, nowMs, warnings }));
      continue;
    }
    if (phase === 'await_address') {
      report('await_address', 'Waiting for the guest to hold an address…');
      mark('await_address', { setup: true, resumable: true, disruptive: false, phases }, 'await_address');
      const timeoutMs = Number(p.addressTimeoutMs) || DEFAULT_ADDRESS_TIMEOUT_MS;
      const started = nowMs();
      let found = null; let polls = 0; let lastError = null;
      for (;;) {
        polls += 1;
        const r = await list();
        if (r.error) lastError = r.error; else if (r.instance) { found = hostReachableIpv4(r.instance); if (found) break; }
        if (nowMs() - started >= timeoutMs) break;
        await sleep(ADDRESS_POLL_MS);
      }
      if (found) { address = { ip: found.address, interface: found.interface }; record('await_address', { state: 'done', ip: found.address, interface: found.interface, waitedMs: nowMs() - started, polls }); mark('await_address', { address }, `address ${found.address} on ${found.interface}`); }
      else record('await_address', { state: 'failed', detail: `no host-reachable IPv4 address within ${Math.round(timeoutMs / 1000)} s${lastError ? ` (${lastError})` : ''}; the guest is running without one — check its network device and the bridge's DHCP`, waitedMs: nowMs() - started, polls });
      continue;
    }
    if (phase === 'dns') {
      report('dns', 'Configuring public resolvers in the guest…');
      mark('dns', { setup: true, resumable: true, disruptive: false, phases }, 'dns');
      try {
        const r = await guest('dns', dnsScript({ resolvers: p.resolvers || DEFAULT_RESOLVERS }), 15_000);
        const verdict = parseDns(r.stdout);
        if (r.code === 0 && (verdict === 'written' || verdict === 'unchanged')) record('dns', { state: 'done', result: verdict, resolvers: p.resolvers || [...DEFAULT_RESOLVERS] });
        else record('dns', { state: 'failed', detail: `resolv.conf could not be written (${verdict || 'no marker'}; exit ${r.code}${tailOf(r, 200) ? `: ${tailOf(r, 200)}` : ''})` });
      } catch (e) {
        if (e === containmentRefused) record('dns', { state: 'refused', detail: `containment_unavailable: ${e.message}` }); else throw e;
      }
      continue;
    }
    if (phase === 'init_script') {
      record('init_script', await initPhase({ p, job, guest, killGuest, deps, prior, priorPhases, priorAcknowledged, phases, mark, report, containmentRefused, nowMs }));
      if (phases.init_script.state !== 'done' && phases.init_script.state !== 'skipped') log('guest_setup', `${name}: init script ${phases.init_script.state}`);
      continue;
    }
    if (phase === 'routes') {
      if (!address?.ip) { record('routes', { state: 'skipped', detail: 'no host-reachable address was found; routes need an upstream — set the address (or wait for one) and retry the setup' }); continue; }
      record('routes', { state: 'pending', detail: 'queued for the backend (configure_routes)', ip: address.ip });
      continue;
    }
  }

  const verdict = setupOutcome(phases);
  const hold = verdict.completion === 'uncertain';
  const followUp = phases.routes?.state === 'pending'
    ? { kind: 'configure_routes', params: { container: name, serviceName: String(p.serviceName), ip: address.ip, services: p.services, origin: { jobId: job.id || null, kind: 'guest_setup', createJobId: p.origin?.jobId || null } } }
    : null;
  mark('finished', { setup: true, resumable: true, disruptive: false, phases, address, init_issued: phases.init_script?.state ? ['done', 'failed', 'timed_out', 'uncertain'].includes(phases.init_script.state) || prior?.init_issued === true : prior?.init_issued === true }, `guest setup ${verdict.outcome}`);
  try { job.progress?.({ phases, completion: verdict.completion, ...(address ? { address } : {}) }); } catch { /* the finish carries it */ }
  const summary = phaseSummary(phases);
  log('guest_setup', `${name}: ${summary}`);
  const logRef = initLogPath(job.id || 'adhoc');
  return {
    ok: verdict.status === 'succeeded', step: verdict.outcome, status: verdict.status, outcome: verdict.outcome, completion: verdict.completion, uncertain: verdict.status === 'recovery_required', hold, partial: verdict.failed, pending: verdict.pending,
    phases, address, identity, ...(warnings.length ? { warnings } : {}), followUp,
    error: verdict.status === 'succeeded' ? undefined : `${name}: ${summary}`,
    verification: {
      state: verdict.status === 'recovery_required' ? 'recovery_required' : 'not_applicable',
      outcome: verdict.outcome,
      label: verdict.completion === 'complete' ? `guest setup complete: ${summary}` : verdict.completion === 'pending' ? `guest setup pending (${verdict.pending.join(', ')}): ${summary}` : `guest setup ${verdict.outcome}: ${summary}`,
      failedAt: verdict.failed.length ? verdict.failed[0] : null,
      next: hold ? `the guest's lease is held: establish that the init script's writer has stopped (read ${logRef.replace(/\.log$/, '.rc')} and the recorded pid in ${name}), then acknowledge job ${job.id || '<job>'} with writerStopped: true; the script is never run again by a resume or a retry — run it again only through a new setup request` : verdict.failed.length ? `the guest is running; retry the setup (POST /api/setup/jobs/${job.id || '<job>'}/retry) to redo the phases named — a retry never repeats an issued init script and keeps its recorded result` : null,
      facts: { phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v.state])), completion: verdict.completion, address: address?.ip || null },
    },
  };
}

// The NAT phase. Idempotent; under the host-wide lease so two setups never
// interleave their iptables writes. A live holder is waited for (bounded),
// a dead one taken over; a lease still held when the wait elapses is
// recorded `skipped (contended)` and the retry redoes it.
async function natPhase({ host, deps, job, sleep, nowMs, warnings }) {
  const lease = deps.hostLease || null;
  let held = false; let contended = null;
  if (lease) {
    const started = nowMs();
    for (;;) {
      const got = lease.acquire(HOST_NETWORK_LOCK, 'network_nat');
      if (got.ok) { held = true; break; }
      if (got.reason === 'stale') {
        const t = lease.takeover(HOST_NETWORK_LOCK, 'network_nat', `taking over the dead holder ${got.holder}'s network lease (NAT is idempotent)`);
        if (t.ok) { held = true; job.event?.('step', `took over the host network lease of dead holder ${got.holder}`, null, 'network_nat'); break; }
      }
      if (nowMs() - started >= NAT_LOCK_WAIT_MS) { contended = got.holder || 'another job'; break; }
      await sleep(NAT_LOCK_POLL_MS);
    }
    if (!held) return { state: 'skipped', contended: true, detail: `the host network lease is held by ${contended} (${Math.round(NAT_LOCK_WAIT_MS / 1000)} s waited); NAT was not re-checked by this job — the holder ensures the same rules; retry to re-check` };
  }
  // Every command under the lease RENEWS it first and checks it is still
  // this job's at its epoch: a sequence of individually bounded commands can
  // outlive one lease period, and a lease another job took over meanwhile
  // must stop this one before its next write — never after.
  let issued = 0;
  const natHost = async (argv, opts) => {
    if (held && !lease.renew(HOST_NETWORK_LOCK)) throw new SharedLeaseLostError(HOST_NETWORK_LOCK, `after ${issued} command(s)`);
    issued += 1;
    return host(argv, opts);
  };
  try {
    const out = { state: 'done', ipForward: false, bridges: [], notes: [] };
    const fwd = await natHost(ipForwardArgv(), { timeoutMs: 10_000 });
    out.ipForward = fwd.code === 0;
    if (fwd.code !== 0) out.notes.push(`ip_forward: ${tailOf(fwd, 120) || `exit ${fwd.code}`}`);
    const nl = await natHost(networkListArgv(), { timeoutMs: 15_000 });
    if (nl.code !== 0) { out.notes.push(`incus network list: ${tailOf(nl, 120) || `exit ${nl.code}`}`); }
    else {
      const b = managedBridges(nl.stdout);
      if (b.error) out.notes.push(b.error);
      if (b.rejected.length) out.notes.push(`bridge name(s) not accepted for a command: ${b.rejected.join(', ')}`);
      for (const bridge of b.bridges) {
        const entry = { name: bridge, nat: false, dockerUser: [] };
        const nat = await natHost(bridgeNatArgv(bridge), { timeoutMs: 15_000 });
        entry.nat = nat.code === 0;
        if (nat.code !== 0) out.notes.push(`${bridge} ipv4.nat: ${tailOf(nat, 120) || `exit ${nat.code}`}`);
        for (const dir of ['in', 'out']) {
          const c = await natHost(dockerUserCheckArgv(bridge, dir), { timeoutMs: 10_000 });
          if (c.code === 0) { entry.dockerUser.push(`${dir}:present`); continue; }
          const i = await natHost(dockerUserInsertArgv(bridge, dir), { timeoutMs: 10_000 });
          entry.dockerUser.push(`${dir}:${i.code === 0 ? 'added' : 'unavailable'}`);
        }
        out.bridges.push(entry);
      }
    }
    const mc = await natHost(masqueradeCheckArgv(), { timeoutMs: 10_000 });
    if (mc.code === 0) out.masquerade = 'present';
    else { const ma = await natHost(masqueradeAppendArgv(), { timeoutMs: 10_000 }); out.masquerade = ma.code === 0 ? 'added' : 'unavailable'; if (ma.code !== 0) out.notes.push(`MASQUERADE: ${tailOf(ma, 120) || `exit ${ma.code}`}`); }
    if (!out.ipForward || out.bridges.some((b) => !b.nat)) { out.state = 'failed'; out.detail = `NAT could not be ensured: ${out.notes.join('; ') || 'a host command failed'}`; }
    else if (out.notes.length) warnings.push(`NAT: ${out.notes.join('; ')}`);
    return out;
  } catch (e) {
    if (e instanceof SharedLeaseLostError || e?.code === 'SHARED_LEASE_LOST') {
      job.event?.('step', e.message, { lease: e.lease, issued }, 'network_nat');
      return { state: 'failed', leaseLost: true, issued, detail: `${e.message}; NAT was not completed by this job — retry the setup` };
    }
    throw e;
  } finally {
    if (held) { try { lease.release(HOST_NETWORK_LOCK); } catch { /* */ } }
  }
}

// The init phase. Never runs a script twice: a resumed attempt reads the
// guest's record; a retry keeps what its origin recorded and does not repeat.
// The record carries states, exit codes and the log's reference — never a
// line of the script's output.
async function initPhase({ p, job, guest, killGuest, deps, prior, priorPhases, priorAcknowledged = false, phases, mark, report, containmentRefused, nowMs }) {
  const ref = String(p.initScript.ref);
  const timeoutMs = Number(p.initTimeoutMs) || DEFAULT_INIT_TIMEOUT_MS;
  const jobId = String(job.id || 'adhoc');
  const log = initLogPath(jobId);
  const consume = () => { try { return deps.consumeInput ? !!deps.consumeInput(ref) : false; } catch { return false; } };
  const script = { ref, sha256: p.initScript.sha256 };
  if (prior && prior.init_issued === true) {
    // This job issued the script and its owner died before reading the result.
    report('init_script', 'Reading the recorded result of the interrupted init script…');
    try {
      const r = await guest('init_script_read', initResultReadScript({ jobId }), 20_000);
      const res = parseInitResult(r.stdout);
      consume();
      if (res.recorded && res.rc != null) return { state: res.rc === 0 ? 'done' : 'failed', rc: res.rc, log: res.log || log, logBytes: res.logBytes, resumed: true, script, detail: res.rc === 0 ? 'completed before the interruption (exit code read from the guest)' : `exited ${res.rc} before the interruption (exit code read from the guest); its output is in ${res.log || log} inside the guest` };
      // Completion unknown: the guest's lease is held (executor) until an
      // operator establishes the writer stopped and acknowledges the job.
      const writer = res.running ? { state: 'running', pid: res.running } : res.dead ? { state: 'stopped', pid: res.dead } : { state: 'unknown', pid: null };
      return { state: 'uncertain', hold: true, job: jobId, log, logBytes: res.logBytes, writer, script, detail: res.running ? `the script was issued and its writer is still running in the guest as pid ${res.running}; no exit code is recorded — nothing was run again, and the guest is held until the job is acknowledged` : res.dead ? `the script was issued; its recorded writer (pid ${res.dead}) is gone and no exit code was recorded — what it completed is unknown; nothing was run again, and the guest is held until the job is acknowledged` : 'the script was issued and the guest holds neither an exit code nor a writer pid — what ran is unknown; nothing was run again, and the guest is held until the job is acknowledged' };
    } catch (e) {
      if (e === containmentRefused) return { state: 'uncertain', hold: true, job: jobId, log, writer: { state: 'unknown', pid: null }, script, detail: `the script was issued and its result could not be read back (containment unavailable: ${e.message}); nothing was run again, and the guest is held until the job is acknowledged` };
      throw e;
    }
  }
  const origin = priorPhases?.init_script || null;
  if (origin && ['done', 'failed', 'timed_out', 'uncertain'].includes(origin.state)) {
    // A retry keeps the attempt's result — its state, exit code and log —
    // and records beside it that this job did not repeat it. A failed init
    // stays a failed setup; an uncertain one stays uncertain (acknowledged
    // when the origin was, so no new hold is taken for a resolved condition).
    consume();
    const acknowledged = origin.acknowledged === true || priorAcknowledged === true;
    return {
      ...origin, notRepeated: true, hold: false, acknowledged: origin.state === 'uncertain' ? acknowledged : undefined, script,
      detail: `${origin.state === 'done' ? 'completed' : origin.state === 'failed' ? `exited ${origin.rc ?? '?'}` : origin.state === 'timed_out' ? 'timed out' : `unknown outcome${acknowledged ? ' (acknowledged)' : ''}`} in the attempt this job retries${origin.log ? `; its output is in ${origin.log} inside the guest` : ''}; a retry never repeats an issued init script — run it again deliberately with a new setup request`,
    };
  }
  if (containmentRefused) return { state: 'refused', script: { ref, sha256: p.initScript.sha256 }, detail: `containment_unavailable: ${containmentRefused.message}` };
  let input = null;
  try { input = deps.readInput ? deps.readInput(ref) : null; } catch (e) { return { state: 'refused', script: { ref }, detail: `the script input could not be read: ${e?.message || e}` }; }
  if (!input) return { state: 'refused', script: { ref, sha256: p.initScript.sha256 }, detail: 'the script input is not there (consumed by an earlier run, swept, or never written); nothing was run — submit a new setup request carrying the script' };
  if (input.sha256 !== String(p.initScript.sha256) || input.bytes !== Number(p.initScript.bytes)) return { state: 'refused', script: { ref, sha256: p.initScript.sha256 }, detail: `the script on disk (${input.sha256.slice(0, 12)}…, ${input.bytes} bytes) is not the revision this job was bound to (${String(p.initScript.sha256).slice(0, 12)}…, ${p.initScript.bytes} bytes); nothing was run` };
  report('init_script', 'Running the init script…');
  try {
    mark('init_script', { setup: true, resumable: true, disruptive: false, init_issued: true, phases, script: { ref, sha256: input.sha256, bytes: input.bytes }, issued_at: new Date(nowMs()).toISOString() }, `issuing the init script (${input.sha256.slice(0, 12)}…, ${input.bytes} bytes)`, { required: true });
  } catch (e) { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; return { state: 'refused', script: { ref, sha256: input.sha256 }, detail: `${e.message}; nothing was run` }; }
  job.fence({ safe: false });
  const b64 = Buffer.from(input.content, 'utf8').toString('base64');
  let r;
  try { r = await guest('init_script', initScriptWrapper({ jobId, b64 }), timeoutMs + 5_000); }
  catch (e) {
    if (e === containmentRefused) { consume(); return { state: 'refused', script: { ref, sha256: input.sha256 }, detail: `containment_unavailable: ${e.message}` }; }
    throw e;
  }
  const res = parseInitResult(r.stdout);
  if (res.writeFailed) { consume(); return { state: 'failed', script: { ref, sha256: input.sha256 }, detail: 'the script could not be written into the guest (base64, /tmp or the log directory unavailable)', rc: null }; }
  const timedOut = r.code === 124 || r.timedOut === true;
  if (timedOut || (!res.recorded && r.code !== 0)) {
    // The executor's timeout killed the exec client (the runner reports 124,
    // the in-process pivot `timedOut`); the script may still run — and so
    // may a `setsid()` descendant the recorded pid's session never held. The
    // kill script stops and inspects the attempt's COMPLETE containment
    // group from the records the contained scripts left (its scopes, its
    // cgroups), issued outside that group. Only `gone` — every recorded
    // group empty — is a recorded timeout; a survivor, a missing record or
    // an inspection that could not conclude is an unknown writer and the
    // guest is held until the job is acknowledged. The recorded pid
    // disappearing establishes nothing on its own.
    let kill = { verdict: null, survivors: null, groups: null };
    try { const k = await killGuest(initKillScript({ jobId }), 20_000); kill = parseInitKillReport(k.stdout); } catch { kill = { verdict: null, survivors: null, groups: null }; }
    consume();
    const killed = kill.verdict;
    const stopped = killed === 'gone';
    const why = killed === 'alive' ? `${kill.survivors == null ? 'a writer' : `${kill.survivors} process${kill.survivors === 1 ? '' : 'es'}`} in its containment group ${kill.survivors == null || kill.survivors === 1 ? 'is' : 'are'} still alive after the kill`
      : killed === 'norecord' ? 'its containment record is missing, so the writer group could not be inspected'
        : killed === 'unknown' ? `its writer group could not be inspected conclusively${kill.survivors ? ` (${kill.survivors} still alive where it could be)` : ''}`
          : 'could not be established as stopped';
    const base = { job: jobId, timeoutMs, killed: killed || 'unknown', groups: kill.groups, survivors: kill.survivors, log, script: { ref, sha256: input.sha256 }, writer: { state: stopped ? 'stopped' : killed === 'alive' ? 'running' : 'unknown', pid: null } };
    if (timedOut && stopped) return { ...base, state: 'timed_out', hold: false, detail: `the script ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped — its containment group (${kill.groups ?? '?'} recorded) is empty (its output is in ${log} inside the guest); finish setup manually` };
    return { ...base, state: 'uncertain', hold: true, detail: `${timedOut ? `the script ran longer than ${Math.round(timeoutMs / 1000)} s` : `the exec session ended (exit ${r.code}) before an exit code was recorded`} and its writer ${why}; nothing was run again, and the guest is held until the job is acknowledged (its output is in ${log} inside the guest)` };
  }
  consume();
  if (!res.recorded) return { state: 'uncertain', hold: true, job: jobId, log, writer: { state: 'unknown', pid: null }, script: { ref, sha256: input.sha256 }, detail: 'the wrapper printed no exit marker; what ran is unknown, and the guest is held until the job is acknowledged' };
  return { state: res.rc === 0 ? 'done' : 'failed', rc: res.rc, log: res.log || log, logBytes: res.logBytes, script: { ref, sha256: input.sha256, bytes: input.bytes }, ...(res.rc === 0 ? {} : { detail: `exited ${res.rc}; its output (${res.logBytes != null ? `${res.logBytes} bytes` : 'see the log'}) is in ${res.log || log} inside the guest` }) };
}
