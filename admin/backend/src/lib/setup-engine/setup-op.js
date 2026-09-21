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
// (retryOf) skips an init the first attempt issued or completed.

import {
  validateSetupParams, SETUP_PHASES, GUEST_PHASES, HOST_NETWORK_LOCK, DEFAULT_RESOLVERS, DEFAULT_ADDRESS_TIMEOUT_MS, DEFAULT_INIT_TIMEOUT_MS,
  ipForwardArgv, networkListArgv, bridgeNatArgv, dockerUserCheckArgv, dockerUserInsertArgv, masqueradeCheckArgv, masqueradeAppendArgv, managedBridges,
  hostReachableIpv4, dnsScript, parseDns, initScriptWrapper, initResultReadScript, initKillScript, parseInitResult, parseInitKill, phaseTable, setupOutcome,
} from './setup-logic.js';
import { instanceListArgv, instanceIdentity, identityMatches } from './lifecycle-logic.js';
import { parseInstanceList } from './restore-logic.js';
import { hostArgv, noopJob, tailOf, containedGuest, ContainmentUnavailableError } from './op-kit.js';
import { CheckpointNotPersistedError } from './lifecycle-op.js';
import { sanitizeReason } from './logic.js';

export const NAT_LOCK_WAIT_MS = 20_000;
const NAT_LOCK_POLL_MS = 500;
const ADDRESS_POLL_MS = 1000;

// runGuestSetupOperation({ params, exec, job, prior, priorPhases, deps, log })
//   → { ok, step, status, outcome, phases, address, warnings, followUp?, verification }
//   { ok: false, step, error, refused?, notFound? }   (nothing run yet)
// deps: readInput(ref) → { content, sha256, bytes } | null; consumeInput(ref);
//       hostLease { acquire(name, operation), takeover(name, operation, reason), release(name) };
//       sleep(ms); nowMs().
// `prior` is this job's own checkpoint from an interrupted attempt;
// `priorPhases` the phase table of the job this one retries.
export async function runGuestSetupOperation({ params, exec, job = noopJob(), prior = null, priorPhases = null, deps = {}, log = () => {} }) {
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
      record('init_script', await initPhase({ p, job, guest, deps, prior, priorPhases, phases, mark, report, containmentRefused, nowMs }));
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
  const followUp = phases.routes?.state === 'pending'
    ? { kind: 'configure_routes', params: { container: name, serviceName: String(p.serviceName), ip: address.ip, services: p.services, origin: { jobId: job.id || null, kind: 'guest_setup', createJobId: p.origin?.jobId || null } } }
    : null;
  mark('finished', { setup: true, resumable: true, disruptive: false, phases, address, init_issued: phases.init_script?.state ? ['done', 'failed', 'timed_out', 'uncertain'].includes(phases.init_script.state) || prior?.init_issued === true : prior?.init_issued === true }, `guest setup ${verdict.outcome}`);
  const summary = Object.entries(phases).map(([k, v]) => `${k}: ${v.state}${v.state !== 'done' && v.detail ? ` (${String(v.detail).slice(0, 120)})` : ''}`).join('; ');
  log('guest_setup', `${name}: ${summary}`);
  return {
    ok: verdict.status === 'succeeded', step: verdict.outcome, status: verdict.status, outcome: verdict.outcome, uncertain: verdict.status === 'recovery_required', partial: verdict.failed,
    phases, address, identity, ...(warnings.length ? { warnings } : {}), followUp,
    error: verdict.status === 'succeeded' ? undefined : `${name}: ${summary}`,
    verification: {
      state: verdict.status === 'recovery_required' ? 'recovery_required' : 'not_applicable',
      outcome: verdict.outcome,
      label: verdict.status === 'succeeded' ? `guest setup complete: ${summary}` : `guest setup ${verdict.outcome}: ${summary}`,
      failedAt: verdict.failed.length ? verdict.failed[0] : null,
      next: verdict.status === 'recovery_required' ? `read /var/log/pp-init-${job.id || '<job>'}.log and .rc in ${name}; run the script again only deliberately (a new setup request), never through a retry` : verdict.failed.length ? `the guest is running; retry the setup (POST /api/setup/jobs/${job.id || '<job>'}/retry) to redo the phases named — a retry never repeats an issued init script` : null,
      facts: { phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v.state])), address: address?.ip || null },
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
  try {
    const out = { state: 'done', ipForward: false, bridges: [], notes: [] };
    const fwd = await host(ipForwardArgv(), { timeoutMs: 10_000 });
    out.ipForward = fwd.code === 0;
    if (fwd.code !== 0) out.notes.push(`ip_forward: ${tailOf(fwd, 120) || `exit ${fwd.code}`}`);
    const nl = await host(networkListArgv(), { timeoutMs: 15_000 });
    if (nl.code !== 0) { out.notes.push(`incus network list: ${tailOf(nl, 120) || `exit ${nl.code}`}`); }
    else {
      const b = managedBridges(nl.stdout);
      if (b.error) out.notes.push(b.error);
      if (b.rejected.length) out.notes.push(`bridge name(s) not accepted for a command: ${b.rejected.join(', ')}`);
      for (const bridge of b.bridges) {
        const entry = { name: bridge, nat: false, dockerUser: [] };
        const nat = await host(bridgeNatArgv(bridge), { timeoutMs: 15_000 });
        entry.nat = nat.code === 0;
        if (nat.code !== 0) out.notes.push(`${bridge} ipv4.nat: ${tailOf(nat, 120) || `exit ${nat.code}`}`);
        for (const dir of ['in', 'out']) {
          const c = await host(dockerUserCheckArgv(bridge, dir), { timeoutMs: 10_000 });
          if (c.code === 0) { entry.dockerUser.push(`${dir}:present`); continue; }
          const i = await host(dockerUserInsertArgv(bridge, dir), { timeoutMs: 10_000 });
          entry.dockerUser.push(`${dir}:${i.code === 0 ? 'added' : 'unavailable'}`);
        }
        out.bridges.push(entry);
      }
    }
    const mc = await host(masqueradeCheckArgv(), { timeoutMs: 10_000 });
    if (mc.code === 0) out.masquerade = 'present';
    else { const ma = await host(masqueradeAppendArgv(), { timeoutMs: 10_000 }); out.masquerade = ma.code === 0 ? 'added' : 'unavailable'; if (ma.code !== 0) out.notes.push(`MASQUERADE: ${tailOf(ma, 120) || `exit ${ma.code}`}`); }
    if (!out.ipForward || out.bridges.some((b) => !b.nat)) { out.state = 'failed'; out.detail = `NAT could not be ensured: ${out.notes.join('; ') || 'a host command failed'}`; }
    else if (out.notes.length) warnings.push(`NAT: ${out.notes.join('; ')}`);
    return out;
  } finally {
    if (held) { try { lease.release(HOST_NETWORK_LOCK); } catch { /* */ } }
  }
}

// The init phase. Never runs a script twice: a resumed attempt reads the
// guest's record; a retry skips what its origin issued or completed.
async function initPhase({ p, job, guest, deps, prior, priorPhases, phases, mark, report, containmentRefused, nowMs }) {
  const ref = String(p.initScript.ref);
  const timeoutMs = Number(p.initTimeoutMs) || DEFAULT_INIT_TIMEOUT_MS;
  const jobId = String(job.id || 'adhoc');
  const consume = () => { try { return deps.consumeInput ? !!deps.consumeInput(ref) : false; } catch { return false; } };
  if (prior && prior.init_issued === true) {
    // This job issued the script and its owner died before reading the result.
    report('init_script', 'Reading the recorded result of the interrupted init script…');
    try {
      const r = await guest('init_script_read', initResultReadScript({ jobId }), 20_000);
      const res = parseInitResult(r.stdout);
      consume();
      if (res.recorded && res.rc != null) return { state: res.rc === 0 ? 'done' : 'failed', rc: res.rc, tail: res.tail, resumed: true, script: { ref, sha256: p.initScript.sha256 }, detail: res.rc === 0 ? 'completed before the interruption (result read from the guest)' : `exited ${res.rc} before the interruption (result read from the guest)` };
      return { state: 'uncertain', job: jobId, script: { ref, sha256: p.initScript.sha256 }, detail: res.running ? `the script was issued and is still running in the guest as pid ${res.running}; its result is not recorded yet — nothing was run again` : 'the script was issued and the guest holds no recorded exit code — it may have run, be running, or have died with the runner; nothing was run again', tail: res.tail };
    } catch (e) {
      if (e === containmentRefused) return { state: 'uncertain', job: jobId, script: { ref, sha256: p.initScript.sha256 }, detail: `the script was issued and its result could not be read back (containment unavailable: ${e.message}); nothing was run again` };
      throw e;
    }
  }
  const origin = priorPhases?.init_script || null;
  if (origin && ['done', 'failed', 'timed_out', 'uncertain'].includes(origin.state)) {
    consume();
    return { state: 'skipped', notRepeated: true, script: { ref, sha256: p.initScript.sha256 }, detail: `the init script was ${origin.state === 'done' ? 'completed' : origin.state === 'failed' ? `completed with exit ${origin.rc ?? '?'}` : origin.state === 'timed_out' ? 'issued and timed out' : 'issued with an unknown outcome'} by the attempt this job retries; a retry never repeats it — run it again deliberately with a new setup request` };
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
  if (res.writeFailed) { consume(); return { state: 'failed', script: { ref, sha256: input.sha256 }, detail: 'the script could not be written into the guest (base64 or /tmp unavailable)', rc: null }; }
  const timedOut = r.code === 124 || r.timedOut === true;
  if (timedOut || (!res.recorded && r.code !== 0)) {
    // The executor's timeout killed the exec client (the runner reports 124,
    // the in-process pivot `timedOut`); the script may still run.
    let killed = null;
    try { const k = await guest('init_script_kill', initKillScript({ jobId }), 15_000); killed = parseInitKill(k.stdout); } catch { killed = null; }
    consume();
    return { state: timedOut ? 'timed_out' : 'uncertain', job: jobId, timeoutMs, killed: killed || 'unknown', tail: res.tail || tailOf(r, 400), script: { ref, sha256: input.sha256 }, detail: timedOut ? `the script ran longer than ${Math.round(timeoutMs / 1000)} s and was ${killed === 'gone' ? 'stopped' : killed === 'alive' ? 'signalled but is still alive' : 'signalled (state unknown)'}; finish setup manually in the guest` : `the exec session ended (exit ${r.code}) before the script recorded an exit code; it was ${killed === 'gone' ? 'stopped' : 'signalled'} — nothing was run again` };
  }
  consume();
  if (!res.recorded) return { state: 'uncertain', job: jobId, script: { ref, sha256: input.sha256 }, detail: 'the wrapper printed no exit marker', tail: tailOf(r, 400) };
  return { state: res.rc === 0 ? 'done' : 'failed', rc: res.rc, tail: res.tail, script: { ref, sha256: input.sha256, bytes: input.bytes }, ...(res.rc === 0 ? {} : { detail: `exited ${res.rc}` }) };
}
