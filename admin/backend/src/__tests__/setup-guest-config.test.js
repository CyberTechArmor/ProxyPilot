// A-17.8: the guest configuration verbs — config keys, resources, devices,
// the address pin, port forwards and egress — and their pre-mutation
// snapshots as durable runner jobs. What is proved here, and how:
//   * the pure layer (config-logic): the kind registry, strict parameter
//     validation (allowlisted keys and value shapes, the device policy's
//     roots and ports, the risk acknowledgement, never a command / argv /
//     option string, never a secret-looking value), the FIXED argv each step
//     renders, the read-back verdicts and the reference-only prior state;
//   * the reserved-ports refresh — the one host script of the group — under
//     the sandbox's REAL `sh` against a temp file;
//   * every kind through the real executor over a scripted host (the
//     setup-engine store on node:sqlite): the read before, the snapshot
//     taken and read back BEFORE the first write (a failed or foreign
//     snapshot = nothing changed), the per-step read-backs (exit 0 is never
//     the proof), partial application reported, identity binding, the
//     shared firewall lease (waited for, contended, taken over from a dead
//     holder, lost mid-sequence), the claim and both leases heart-beaten
//     through a long command while the runner's actual reconcile runs,
//     interruption before and after the first write (resumed by re-reading,
//     the snapshot reused by name + timestamp, nothing replayed blindly),
//     the boot sweep's honest record, an explicit retry reusing the snapshot,
//     runner-required refusing rather than executing in the backend;
//   * the actual callers: mock2/ops.js runGuestConfig with its HTTP mapping,
//     and the MCP tools set_lxc_resources / add_lxc_device /
//     remove_lxc_device / set_lxc_egress / set_port_forward over a fake ctx
//     with the real store, executor and the real services / forwards schema;
//   * the runner's host channel handed a rendered argv verbatim.
// The REST route (`/containers/:name/resize`) and the two tools in
// routes/mcp.js import the native database module and are covered by the
// source ratchet in immediate-repairs.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_JOB_KINDS as KINDS_FROM_CONFIG, FIREWALL_KINDS, SNAPSHOT_KINDS, HOST_FIREWALL_LOCK, CONFIG_KEY_ALLOWLIST, PROXYPILOT_BIN, validateConfigParams,
  configSetArgv, rootSizeOverrideArgv, deviceAddArgv, deviceRemoveArgv, networkPinOverrideArgv, networkPinSetArgv, forwardDeviceAddArgv, firewallAddArgv, firewallRemoveArgv, firewallListArgv,
  egressArgv, egressListArgv, reservedWriteArgv, reservedRemoveArgv, reservedReadArgv, sysctlApplyArgv, reservedPlan, reservedRangesFromRows, RESERVED_WRITE_SCRIPT,
  configKeyVerdict, deviceVerdict, networkVerdict, ruleVerdict, egressVerdict, recordedDevice, priorConfig, parseCliJson, shortGuestName, loadDevicePolicy,
} from '../lib/setup-engine/config-logic.js';
import { runConfigOperation } from '../lib/setup-engine/config-op.js';
import { ownerIdentity, parseJson, validateRunnerJob, reconcileDecision, RUNNER_JOB_KINDS, MUTATING_JOB_KINDS, EXCLUSIVE_JOB_KINDS, CONFIG_JOB_KINDS } from '../lib/setup-engine/logic.js';
import { ensureSetupEngineSchema, getJob, listEvents, readLock, acquireLock, createJob, claimNextJob, checkpoint, runnerHeartbeat, listJobs, releaseLock } from '../lib/setup-engine/store.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { submitRunnerJob, runSubmittedJob, resultFromJob } from '../lib/setup-engine/orchestrator.js';
import { sweepSetupEngineOnBoot } from '../lib/setup-engine/backend.js';
import { retryPlan } from '../lib/setup-engine/logic.js';
import { configureContainerLockStore } from '../mock2/container-lock.js';
import { runGuestConfig, resolveConfigPlan, lifecycleHttpStatus } from '../mock2/ops.js';
import { createExtendedHandlers } from '../routes/mcp-tools/index.js';
import { createConfirmationStore } from '../lib/mcp-ext/logic.js';
import { lxcContainerDetail, MCP_TOOLS } from '../lib/mcp-logic.js';
import { hostGuestExec } from '../../../../cli/src/commands/setup-runner.js';
import { reservedPortsBody, RESERVED_PORTS_HEADER } from '../lib/l4-reserved-ports.js';
import { scriptedGuest, LOGIN } from './helpers/scripted-guest.js';

const T0 = Date.parse('2026-09-26T12:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const OTHER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 301, instance: 'oooo' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const DEAD = ownerIdentity({ kind: 'runner', host: 'pp', pid: 999, instance: 'dead' });
const DEAD_BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 998, instance: 'gone' });
const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '99999999-8888-7777-6666-555555555555';
const TOKEN = 'tok-9f8e7d6c5b4a-never-on-a-record';
const IDENTITY = { uuid: UUID_A, created_at: '2026-09-01T10:00:00Z' };

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); return d; }
function tmp() { return mkdtempSync(join(tmpdir(), 'pp-config-')); }
const inst = (over = {}) => ({
  name: 'pp-x', status: 'Running', created_at: '2026-09-01T10:00:00Z',
  config: { 'volatile.uuid': UUID_A, 'limits.cpu': '2', 'limits.memory': '2048MB', 'user.api_token': TOKEN },
  devices: { data: { type: 'disk', source: '/srv/shares/data', path: '/data', 'raw.mount.options': TOKEN } },
  expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' }, eth0: { type: 'nic', network: 'incusbr0' }, data: { type: 'disk', source: '/srv/shares/data', path: '/data' } },
  snapshots: [], state: { network: { eth0: { addresses: [{ family: 'inet', address: '10.10.10.5', scope: 'global' }] } } },
  ...over,
});

// The scripted host: `incus …` and `proxypilot --json firewall …` as argv
// arrays over a state; `sh -c`, `cat` and `rm` are REAL (the reserved-ports
// drop-in is a temp file), `sysctl` reads and applies that file.
function scriptedHost(state) {
  const calls = [];
  const byName = (n) => state.instances.find((i) => i.name === n) || null;
  state.rules = state.rules || []; state.egress = state.egress || []; state.sysctl = state.sysctl ?? '';
  const real = (argv) => { const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' }); return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' }; };
  const json = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
  return {
    calls,
    host: async (argv) => {
      calls.push(argv);
      assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === 'string'), 'argv arrays only');
      if (state.hook) { const h = state.hook; const r = await h(argv); if (r) return r; }
      if (argv[0] === 'sh' || argv[0] === 'cat' || argv[0] === 'rm') return real(argv);
      if (argv[0] === 'sysctl') {
        if (argv[1] === '-n') return { code: 0, stdout: `${state.sysctl}\n`, stderr: '' };
        if (state.sysctlFails) return { code: 1, stdout: '', stderr: 'sysctl: permission denied' };
        const f = argv[2]; const body = existsSync(f) ? readFileSync(f, 'utf8') : '';
        const m = /net\.ipv4\.ip_local_reserved_ports = (.*)/.exec(body); state.sysctl = m ? m[1].trim() : (f === '/etc/sysctl.conf' ? '' : state.sysctl);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === PROXYPILOT_BIN) {
        assert.equal(argv[1], '--json'); assert.equal(argv[2], 'firewall');
        const verb = argv[3];
        if (verb === 'list') return json(state.rules);
        if (verb === 'add-service-l4') {
          const opt = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : null; };
          const id = opt('--id');
          if (state.rules.some((r) => r.id === id)) return { code: 1, stdout: '', stderr: `a rule with id ${id} already exists` };
          if (state.fwAddFails) return { code: 1, stdout: '', stderr: 'Error: panic mode is active' };
          state.rules.push({ id, port_start: Number(opt('--port')), port_end: opt('--port-end') ? Number(opt('--port-end')) : null, proto: opt('--proto'), reason: opt('--reason'), service: opt('--service'), enabled: !state.fwAddDisabled, source: 'service-l4' });
          return json({ ok: true, action: 'add-service-l4', reconcile: { applied: true, checksum: 'c1', rejection: null } });
        }
        if (verb === 'remove-service-l4') { const n = state.rules.length; state.rules = state.rules.filter((r) => r.id !== argv[4]); return n === state.rules.length ? json({ ok: true, action: 'remove-service-l4', rule: { id: argv[4] }, already_absent: true }) : json({ ok: true, action: 'remove-service-l4' }); }
        if (verb === 'egress' && argv[4] === 'list') return json({ services: { dns: {}, http: {}, smtp: {} }, entries: state.egress });
        if (verb === 'egress') {
          const [, , , , action, container, service] = argv;
          if (state.egressFails) return { code: 1, stdout: '', stderr: 'Error: reconcile rejected' };
          let e = state.egress.find((x) => x.container === container);
          if (action === 'allow') { if (!e) { e = { container, allow: [], reason: null }; state.egress.push(e); } if (!e.allow.includes(service)) e.allow.push(service); const ri = argv.indexOf('--reason'); if (ri > 0) e.reason = argv[ri + 1]; }
          else { if (!e) return { code: 1, stdout: '', stderr: 'no egress entry for container' }; if (!state.egressDenySilent) { e.allow = e.allow.filter((s) => s !== service); if (!e.allow.length) state.egress = state.egress.filter((x) => x !== e); } }
          return json({ action: `egress-${action}`, payload: { container, service }, reconcile: { applied: true, checksum: 'c2', rejection: null } });
        }
        return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
      }
      if (argv[0] !== 'incus') return { code: 127, stdout: '', stderr: 'not incus' };
      const verb = argv[1];
      if (verb === 'list') { const i = byName(argv[2]); return { code: 0, stdout: JSON.stringify(i ? [i] : []), stderr: '' }; }
      if (verb === 'snapshot' && argv[2] === 'create') {
        const i = byName(argv[3]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' };
        if (state.snapshotFails) return { code: 1, stdout: '', stderr: 'Error: Failed creating instance snapshot: no space left' };
        if (i.snapshots.some((s) => s.name === argv[4])) return { code: 1, stdout: '', stderr: 'Error: Snapshot already exists' };
        i.snapshots.push({ name: argv[4], created_at: `2026-09-26T12:0${i.snapshots.length}:00Z` }); return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'config' && argv[2] === 'set') {
        const i = byName(argv[3]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' };
        if (state.configSetFails === argv[4]) return { code: 1, stdout: '', stderr: `Error: Invalid value for ${argv[4]}` };
        if (state.configSetSilent !== argv[4]) i.config[argv[4]] = argv[5];
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'config' && argv[2] === 'device') {
        const sub = argv[3]; const i = byName(argv[4]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' };
        i.devices = i.devices || {};
        if (sub === 'override') {
          const dev = argv[5]; const [k, v] = argv[6].split('=');
          if (i.devices[dev]) return { code: 1, stdout: '', stderr: `Error: The device already exists` };
          if (state.overrideFails) return { code: 1, stdout: '', stderr: `Error: device '${dev}' doesn't exist` };
          i.devices[dev] = { ...(i.expanded_devices?.[dev] || { type: dev === 'root' ? 'disk' : 'nic' }), [k]: v }; return { code: 0, stdout: '', stderr: '' };
        }
        if (sub === 'set') { const dev = argv[5]; if (!i.devices[dev]) return { code: 1, stdout: '', stderr: 'Error: Device not found' }; i.devices[dev][argv[6]] = argv[7]; return { code: 0, stdout: '', stderr: '' }; }
        if (sub === 'add') {
          const dev = argv[5];
          if (i.devices[dev]) return { code: 1, stdout: '', stderr: `Error: The device already exists` };
          if (state.deviceAddFails) return { code: 1, stdout: '', stderr: 'Error: Failed to start device: bind failed' };
          if (state.deviceAddSilent) return { code: 0, stdout: '', stderr: '' };
          i.devices[dev] = { type: argv[6], ...Object.fromEntries(argv.slice(7).map((kv) => { const j = kv.indexOf('='); return [kv.slice(0, j), kv.slice(j + 1)]; })) };
          return { code: 0, stdout: '', stderr: '' };
        }
        if (sub === 'remove') { const dev = argv[5]; if (!i.devices[dev]) return { code: 1, stdout: '', stderr: 'Error: Device not found' }; if (state.deviceRemoveSilent) return { code: 0, stdout: '', stderr: '' }; delete i.devices[dev]; return { code: 0, stdout: '', stderr: '' }; }
      }
      return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
    },
  };
}
const exec = (h, g = scriptedGuest({})) => ({ guest: g.guest, host: h.host });
function clock(start = T0) { const c = { t: start }; c.nowMs = () => c.t; c.sleep = async (ms) => { c.t += ms; }; c.tick = (ms) => { c.t += ms; }; return c; }
// heartbeat: false — a runner heartbeat stamped with the fake clock would read as a live runner to a caller on the real clock.
const runAll = (d, ex, c, opts = {}) => runOnce({ db: d, owner: opts.owner || RUNNER, exec: ex, reviewLogin: async () => LOGIN, nowMs: c.nowMs, sleep: c.sleep, keepAliveMs: opts.keepAliveMs || 60_000, reservedPortsPath: opts.reservedPortsPath || null, heartbeat: false, log: () => {} }, { reconcileFirst: false, ...opts });
const READS = (a) => (a[0] === 'incus' && a[1] === 'list') || (a[0] === PROXYPILOT_BIN && (a[3] === 'list' || (a[3] === 'egress' && a[4] === 'list'))) || a[0] === 'cat' || (a[0] === 'sysctl' && a[1] === '-n');
const mutations = (h) => h.calls.filter((a) => !READS(a));
const submit = (d, kind, params, extra = {}) => submitRunnerJob(d, { kind, app: params.container, params, nowMs: T0, ...extra });
const cps = (d, id) => listEvents(d, id).filter((e) => e.kind === 'checkpoint').map((e) => e.phase);
const noSecretIn = (d, ids) => { for (const id of ids) { const dump = JSON.stringify(getJob(d, id)) + JSON.stringify(listEvents(d, id)); assert.equal(dump.includes(TOKEN), false, `a guest value leaked into job ${id}: ${dump.slice(0, 200)}`); } };
function deadJob(d, { kind, params, cp, id = 'dead-1', owner = DEAD }) {
  createJob(d, { id, kind, app: params.container, plan: { steps: [], params }, nowMs: T0 - 100_000 });
  const c = claimNextJob(d, { owner, kinds: [kind], nowMs: T0 - 99_000 });
  checkpoint(d, { id, owner, epoch: c.epoch, phase: cp.phase, checkpoint: cp, nowMs: T0 - 98_000 });
  return getJob(d, id);
}

// ── 1. the pure layer ─────────────────────────────────────────────────────

test('registry: the seven configuration kinds are runner jobs, mutating and exclusive; the two modules agree; the firewall and snapshot subsets are named', () => {
  assert.deepEqual([...KINDS_FROM_CONFIG], ['config_set', 'device_add', 'device_remove', 'network_pin', 'forward_apply', 'forward_remove', 'egress_set']);
  assert.deepEqual([...CONFIG_JOB_KINDS], [...KINDS_FROM_CONFIG], 'logic.js carries its own copy (the import cycle forbids a spread); it must match');
  for (const k of KINDS_FROM_CONFIG) { assert.ok(RUNNER_JOB_KINDS.includes(k)); assert.ok(MUTATING_JOB_KINDS.includes(k)); assert.ok(EXCLUSIVE_JOB_KINDS.includes(k), `${k} is refused, never queued behind`); }
  assert.deepEqual([...FIREWALL_KINDS], ['forward_apply', 'forward_remove', 'egress_set']); assert.equal(HOST_FIREWALL_LOCK, '@host/firewall');
  assert.deepEqual([...SNAPSHOT_KINDS], ['config_set', 'device_add', 'device_remove', 'network_pin']);
  assert.deepEqual(Object.keys(CONFIG_KEY_ALLOWLIST).sort(), ['boot.autostart', 'limits.cpu', 'limits.memory', 'security.nesting', 'security.privileged']);
  const mcpPolicy = JSON.parse(readFileSync(new URL('../lib/mcp-policy/lxc-config-allowlist.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(mcpPolicy.keys).sort(), Object.keys(CONFIG_KEY_ALLOWLIST).sort(), 'the runner allowlist names exactly the MCP policy\'s keys');
  const pol = loadDevicePolicy();
  assert.ok(pol.disk_source_roots.includes('/srv/shares')); assert.ok(pol.reserved_listen_ports.includes(443));
});

test('validation is strict: allowlisted keys and shapes, the risk acknowledgement, the device policy, ports and widths; never a command, an argv, an option or a value that looks like a secret', () => {
  const ok = (k, p) => assert.deepEqual(validateConfigParams(k, p), { ok: true }, `${k} ${JSON.stringify(p)}`);
  const bad = (k, p, re) => assert.match(validateConfigParams(k, p).reason, re, `${k} ${JSON.stringify(p)}`);
  ok('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MB' }], rootSize: '20GiB', snapshot: { name: 'pp-mcp-pre-resources-x' }, expect: IDENTITY, retryOf: 'job-1' });
  ok('config_set', { container: 'pp-x', changes: [{ key: 'security.privileged', value: 'true' }], acknowledgeRisk: true });
  ok('config_set', { container: 'pp-x', changes: [{ key: 'limits.memory', value: '1.5gb' }] });
  ok('device_add', { container: 'pp-x', device: 'shared', deviceType: 'disk', props: { source: '/srv/shares/media', path: '/mnt/media', readonly: 'true' }, snapshot: { name: 's' } });
  ok('device_add', { container: 'pp-x', device: 'web', deviceType: 'proxy', props: { listen: 'tcp:0.0.0.0:8080', connect: 'tcp:127.0.0.1:80' } });
  ok('device_remove', { container: 'pp-x', device: 'shared' });
  ok('network_pin', { container: 'pp-x', ip: '10.10.10.5', previous: '10.10.10.5', snapshot: { name: 'pp-mcp-pre-network-x' } });
  ok('forward_apply', { container: 'pp-x', forward: { id: 'f1', proto: 'udp', listen: 50000, listenEnd: 50100, connect: 50000, connectEnd: 50100, description: 'media' }, bridgeIp: '10.10.10.5', serviceTag: 'x', reserved: [[50000, 50100]] });
  ok('forward_remove', { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 7881, connect: 7881 }, reserved: [] });
  ok('egress_set', { container: 'pp-x', action: 'allow', service: 'smtp', reason: 'mail relay' });
  bad('config_set', { container: '../x', changes: [] }, /guest name/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], argv: ['incus'] }, /never carries a command/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], options: ['-x'] }, /never carries a command/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'raw.lxc', value: 'lxc.mount.entry=/ host none bind' }] }, /not on the configuration allowlist/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.memory', value: '4 GB; rm -rf /' }] }, /not an accepted value/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.cpu', value: '8' }] }, /given twice/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'security.privileged', value: 'true' }] }, /requires acknowledgeRisk: true/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], rootSize: '20' }, /rootSize/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], snapshot: { name: 'bad name' } }, /snapshot name/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], snapshot: { name: 's', created_at: 'x' } }, /not a plan field/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], device: 'x' }, /carries no device/);
  bad('config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], expect: { name: 'pp-x' } }, /not an identity field/);
  bad('device_add', { container: 'pp-x', device: 'root', deviceType: 'disk', props: { source: '/srv/shares/a', path: '/a' } }, /managed by ProxyPilot/);
  bad('device_add', { container: 'pp-x', device: 'ppl4-abc', deviceType: 'proxy', props: { listen: 'tcp:0.0.0.0:8080', connect: 'tcp:127.0.0.1:80' } }, /managed by ProxyPilot/);
  bad('device_add', { container: 'pp-x', device: 'etc', deviceType: 'disk', props: { source: '/etc', path: '/mnt/etc' } }, /under one of/);
  bad('device_add', { container: 'pp-x', device: 'esc', deviceType: 'disk', props: { source: '/srv/shares/../../etc', path: '/mnt/x' } }, /under one of/);
  bad('device_add', { container: 'pp-x', device: 'r', deviceType: 'disk', props: { source: '/srv/shares/a', path: '/' } }, /mount point/);
  bad('device_add', { container: 'pp-x', device: 'r', deviceType: 'disk', props: { source: '/srv/shares/a', path: '/a', shift: 'maybe' } }, /props\.shift/);
  bad('device_add', { container: 'pp-x', device: 'r', deviceType: 'disk', props: { source: '/srv/shares/a', path: '/a', pool: 'default' } }, /not a disk property/);
  bad('device_add', { container: 'pp-x', device: 'web', deviceType: 'proxy', props: { listen: 'tcp:0.0.0.0:3001', connect: 'tcp:127.0.0.1:80' } }, /reserved on this host/);
  bad('device_add', { container: 'pp-x', device: 'web', deviceType: 'proxy', props: { listen: 'tcp:0.0.0.0:80', connect: 'tcp:127.0.0.1:80' } }, /outside 1024/);
  bad('device_add', { container: 'pp-x', device: 'web', deviceType: 'proxy', props: { listen: 'tcp:10.0.0.1:8080', connect: 'tcp:127.0.0.1:80' } }, /address must be 0\.0\.0\.0/);
  bad('device_add', { container: 'pp-x', device: 'web', deviceType: 'proxy', props: { listen: 'tcp:0.0.0.0:8080', connect: 'udp:127.0.0.1:80' } }, /same protocol/);
  bad('device_add', { container: 'pp-x', device: 'web', deviceType: 'nic', props: {} }, /deviceType/);
  bad('device_remove', { container: 'pp-x', device: 'eth0' }, /managed by ProxyPilot/);
  bad('device_remove', { container: 'pp-x', device: 'ppcert-x' }, /managed by ProxyPilot/);
  bad('network_pin', { container: 'pp-x', ip: '10.10.10' }, /IPv4/);
  bad('network_pin', { container: 'pp-x', ip: '10.10.10.5', previous: 'x' }, /previous/);
  bad('forward_apply', { container: 'pp-x', forward: { id: 'f1', proto: 'sctp', listen: 1, connect: 1 }, bridgeIp: '10.0.0.1', reserved: [] }, /proto/);
  bad('forward_apply', { container: 'pp-x', forward: { id: 'f1', proto: 'udp', listen: 50000, listenEnd: 50100, connect: 50000, connectEnd: 50050 }, bridgeIp: '10.0.0.1', reserved: [] }, /same width/);
  bad('forward_apply', { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 80, connect: 80, description: '-x' }, bridgeIp: '10.0.0.1', reserved: [] }, /description/);
  bad('forward_apply', { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 80, connect: 80 }, reserved: [] }, /bridgeIp/);
  bad('forward_apply', { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 80, connect: 80 }, bridgeIp: '10.0.0.1', reserved: [[50100, 50000]] }, /reserved entry/);
  bad('forward_apply', { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 80, connect: 80 }, bridgeIp: '10.0.0.1', reserved: [], snapshot: { name: 's' } }, /carries no snapshot/);
  bad('forward_remove', { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 80, connect: 80 }, bridgeIp: '10.0.0.1', reserved: [] }, /carries no bridgeIp/);
  bad('egress_set', { container: 'pp-x', action: 'block', service: 'dns' }, /action/);
  bad('egress_set', { container: 'pp-x', action: 'allow', service: 'dns; rm' }, /service/);
  bad('egress_set', { container: 'pp-x', action: 'allow', service: 'dns', reason: 'x'.repeat(201) }, /reason/);
  bad('egress_set', { container: 'pp-x', action: 'allow', service: 'dns', snapshot: { name: 's' } }, /carries no snapshot/);
  bad('egress_set', { container: 'pp-x', action: 'allow', service: 'dns', reason: 'AUTH_MASTER_SECRET=abcdefghijklmnop' }, /looks like a secret/);
  bad('forward_apply', { container: 'pp-x', forward: { id: 'f1', proto: 'tcp', listen: 80, connect: 80, description: 'API_SECRET_KEY=abcdefghijklmnop' }, bridgeIp: '10.0.0.1', reserved: [] }, /looks like a secret/);
  // validateRunnerJob delegates: a configuration job with a command never becomes a queued job.
  assert.match(validateRunnerJob({ kind: 'config_set', app: 'pp-x', plan: { params: { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], command: 'x' } } }).reason, /never carries a command/);
  assert.equal(validateRunnerJob({ kind: 'egress_set', app: 'pp-x', plan: { params: { container: 'pp-x', action: 'deny', service: 'smtp' } } }).ok, true);
  assert.match(submitRunnerJob(db(), { kind: 'config_set', app: 'pp-x', params: { container: 'pp-x', changes: [{ key: 'user.x', value: 'y' }] }, nowMs: T0 }).error, /allowlist/);
});

test('the fixed commands: one argv per step, rendered from the plan alone; the firewall CLI by its path; the guest\'s short name for egress', () => {
  assert.deepEqual(configSetArgv('pp-x', 'limits.cpu', '4'), ['incus', 'config', 'set', 'pp-x', 'limits.cpu', '4']);
  assert.deepEqual(rootSizeOverrideArgv('pp-x', '20GiB'), ['incus', 'config', 'device', 'override', 'pp-x', 'root', 'size=20GiB']);
  assert.deepEqual(deviceAddArgv('pp-x', 'shared', 'disk', { path: '/mnt/media', source: '/srv/shares/media', readonly: 'true' }), ['incus', 'config', 'device', 'add', 'pp-x', 'shared', 'disk', 'source=/srv/shares/media', 'path=/mnt/media', 'readonly=true'], 'properties in their fixed order');
  assert.deepEqual(deviceRemoveArgv('pp-x', 'shared'), ['incus', 'config', 'device', 'remove', 'pp-x', 'shared']);
  assert.deepEqual(networkPinOverrideArgv('pp-x', '10.10.10.5'), ['incus', 'config', 'device', 'override', 'pp-x', 'eth0', 'ipv4.address=10.10.10.5']);
  assert.deepEqual(networkPinSetArgv('pp-x', '10.10.10.5'), ['incus', 'config', 'device', 'set', 'pp-x', 'eth0', 'ipv4.address', '10.10.10.5']);
  const f = { id: 'f1', proto: 'udp', listen: 50000, listenEnd: 50100, connect: 50000, connectEnd: 50100, description: 'media' };
  assert.deepEqual(forwardDeviceAddArgv('pp-x', f, '10.10.10.5'), ['incus', 'config', 'device', 'add', 'pp-x', 'ppl4-f1', 'proxy', 'listen=udp:0.0.0.0:50000-50100', 'connect=udp:10.10.10.5:50000-50100']);
  assert.deepEqual(firewallAddArgv(f, 'x'), [PROXYPILOT_BIN, '--json', 'firewall', 'add-service-l4', '--id', 'service-l4-f1', '--port', '50000', '--proto', 'udp', '--reason', 'media', '--port-end', '50100', '--service', 'x']);
  assert.deepEqual(firewallAddArgv({ id: 'f2', proto: 'tcp', listen: 7881, connect: 7881 }), [PROXYPILOT_BIN, '--json', 'firewall', 'add-service-l4', '--id', 'service-l4-f2', '--port', '7881', '--proto', 'tcp', '--reason', 'service-l4 tcp/7881']);
  assert.deepEqual(firewallRemoveArgv('f1'), [PROXYPILOT_BIN, '--json', 'firewall', 'remove-service-l4', 'service-l4-f1']);
  assert.deepEqual(firewallListArgv(), [PROXYPILOT_BIN, '--json', 'firewall', 'list']);
  assert.deepEqual(egressArgv('pp-x', 'allow', 'smtp', 'mail'), [PROXYPILOT_BIN, '--json', 'firewall', 'egress', 'allow', 'x', 'smtp', '--reason', 'mail']);
  assert.deepEqual(egressArgv('pp-x', 'deny', 'smtp', 'ignored'), [PROXYPILOT_BIN, '--json', 'firewall', 'egress', 'deny', 'x', 'smtp']);
  assert.deepEqual(egressListArgv(), [PROXYPILOT_BIN, '--json', 'firewall', 'egress', 'list']);
  assert.equal(shortGuestName('pp-mail'), 'mail'); assert.equal(shortGuestName('other'), 'other');
  const w = reservedWriteArgv('body\n', '/etc/sysctl.d/99-x.conf');
  assert.deepEqual(w.slice(0, 4), ['sh', '-c', RESERVED_WRITE_SCRIPT, 'sh']); assert.equal(Buffer.from(w[4], 'base64').toString('utf8'), 'body\n'); assert.equal(w[5], '/etc/sysctl.d/99-x.conf');
  assert.deepEqual(reservedRemoveArgv('/p'), ['rm', '-f', '/p']); assert.deepEqual(reservedReadArgv('/p'), ['cat', '/p']); assert.deepEqual(sysctlApplyArgv('/p'), ['sysctl', '-p', '/p']);
  assert.deepEqual(reservedPlan([[50000, 50100], [50050, 50200], [7000, 7010]]), { value: '7000-7010,50000-50200', body: reservedPortsBody('7000-7010,50000-50200') }, 'the same coalesced rendering the reconciler uses');
  assert.deepEqual(reservedPlan([]), { value: '', body: '' });
  assert.deepEqual(reservedRangesFromRows([{ proto: 'udp', listen_port: 50000, listen_port_end: 50100, enabled: 1 }, { proto: 'tcp', listen_port: 1, listen_port_end: 10, enabled: 1 }, { proto: 'udp', listen_port: 5, listen_port_end: null, enabled: 1 }, { proto: 'udp', listen_port: 9000, listen_port_end: 9100, enabled: 0 }]), [[50000, 50100]]);
});

test('read-backs and prior state: verdicts compare what the guest and the firewall report; a recorded device carries references only', () => {
  const i = inst();
  assert.deepEqual(configKeyVerdict(i, 'limits.cpu', '2'), { key: 'limits.cpu', expected: '2', observed: '2', ok: true });
  assert.equal(configKeyVerdict(i, 'limits.cpu', '4').ok, false); assert.equal(configKeyVerdict(i, 'boot.autostart', 'true').observed, null);
  assert.deepEqual(priorConfig(i, ['limits.cpu', 'boot.autostart']), { 'limits.cpu': '2', 'boot.autostart': null });
  assert.deepEqual(recordedDevice(i.devices.data), { type: 'disk', source: '/srv/shares/data', path: '/data' }, 'an unknown property (it could carry anything) is not recorded');
  assert.equal(deviceVerdict(i, 'data', { present: true, type: 'disk', props: { source: '/srv/shares/data', path: '/data' } }).ok, true);
  const other = deviceVerdict(i, 'data', { present: true, type: 'disk', props: { source: '/srv/shares/other', path: '/data' } });
  assert.equal(other.ok, false); assert.match(other.observed, /other properties \(source=\/srv\/shares\/data\)/);
  assert.deepEqual(deviceVerdict(i, 'nope', { present: false }), { ok: true, observed: 'absent', expected: 'absent', device: null });
  assert.equal(networkVerdict(i, '10.10.10.5').ok, false); assert.equal(networkVerdict({ devices: { eth0: { 'ipv4.address': '10.10.10.5' } } }, '10.10.10.5').ok, true);
  assert.deepEqual(ruleVerdict([{ id: 'service-l4-f1', enabled: true }], 'service-l4-f1', { present: true }), { ok: true, observed: 'present', expected: 'present' });
  assert.equal(ruleVerdict([{ id: 'service-l4-f1', enabled: false }], 'service-l4-f1', { present: true }).ok, false);
  assert.equal(ruleVerdict(null, 'x', { present: false }).observed, 'unreadable');
  assert.deepEqual(egressVerdict({ entries: [{ container: 'x', allow: ['dns'] }] }, 'pp-x', 'dns', 'allow'), { ok: true, observed: 'present', expected: 'present', allow: ['dns'] });
  assert.equal(egressVerdict({ entries: [] }, 'pp-x', 'dns', 'deny').ok, true); assert.equal(egressVerdict({ entries: [] }, 'pp-x', 'dns', 'deny').observed, 'no entry');
  assert.deepEqual(parseCliJson('warning: x\n{"ok":true}\n'), { ok: true }); assert.equal(parseCliJson(''), null);
});

test('the reserved-ports drop-in under REAL sh: written atomically at 0644 with the reconciler\'s exact body, idempotent on a second run, removed with rm when nothing is reserved', () => {
  const dir = tmp(); const path = join(dir, 'sysctl.d', '99-proxypilot-l4-reserved.conf');
  try {
    const plan = reservedPlan([[50000, 60000]]);
    const w = spawnSync('sh', reservedWriteArgv(plan.body, path).slice(1), { encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    assert.equal(readFileSync(path, 'utf8'), plan.body); assert.equal(readFileSync(path, 'utf8').startsWith(RESERVED_PORTS_HEADER), true);
    assert.equal((statSync(path).mode & 0o777).toString(8), '644');
    const again = spawnSync('sh', reservedWriteArgv(plan.body, path).slice(1), { encoding: 'utf8' });
    assert.equal(again.status, 0); assert.equal(readFileSync(path, 'utf8'), plan.body);
    assert.deepEqual(readdirClean(join(dir, 'sysctl.d')), ['99-proxypilot-l4-reserved.conf'], 'no temp file left behind');
    const rm = spawnSync('rm', reservedRemoveArgv(path).slice(1), { encoding: 'utf8' }); assert.equal(rm.status, 0); assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
function readdirClean(d) { return spawnSync('ls', ['-A', d], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort(); }

// ── 2. every kind through the executor ────────────────────────────────────

test('config_set: the keys and the root size are set one by one, each read back; the prior values are on the record, the lease released, no guest value leaks; a second run finds every value in place and issues nothing', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  const sub = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MB' }], rootSize: '30GiB', expect: IDENTITY });
  assert.ok(sub.job, sub.error);
  const out = await runAll(d, exec(h), c);
  assert.equal(out.ran[0].status, 'succeeded', getJob(d, sub.job.id).reason);
  assert.deepEqual(mutations(h), [['incus', 'config', 'set', 'pp-x', 'limits.cpu', '4'], ['incus', 'config', 'set', 'pp-x', 'limits.memory', '4096MB'], ['incus', 'config', 'device', 'override', 'pp-x', 'root', 'size=30GiB']]);
  assert.deepEqual(h.calls[0], ['incus', 'list', 'pp-x', '--format', 'json'], 'read before');
  const row = getJob(d, sub.job.id);
  assert.equal(row.outcome, 'configured'); assert.match(row.reason, /config:limits\.cpu done, config:limits\.memory done, root\.size done/);
  const r = resultFromJob(row);
  assert.equal(r.ok, true); assert.equal(r.step, 'configured'); assert.equal(r.instanceState, 'Running');
  assert.deepEqual(r.previous, { config: { 'limits.cpu': '2', 'limits.memory': '2048MB' }, rootSize: null });
  assert.deepEqual(Object.fromEntries(Object.entries(r.applied).map(([k, a]) => [k, a.state])), { 'config:limits.cpu': 'done', 'config:limits.memory': 'done', 'root.size': 'done' });
  assert.equal(r.snapshot, null, 'no snapshot was asked for (the dashboard contract)');
  assert.equal(readLock(d, 'pp-x'), null, 'lease released');
  assert.deepEqual(cps(d, sub.job.id), ['validated', 'issuing', 'applied', 'applied', 'applied', 'verified']);
  assert.equal(st.instances[0].devices.root.size, '30GiB');
  noSecretIn(d, [sub.job.id]);
  // Already in place: nothing issued.
  h.calls.length = 0;
  const again = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], rootSize: '30GiB' }, { nowMs: T0 + 5 });
  await runAll(d, exec(h), c);
  assert.deepEqual(mutations(h), []); const r2 = resultFromJob(getJob(d, again.job.id));
  assert.equal(r2.ok, true); assert.equal(r2.alreadyInState, true); assert.match(getJob(d, again.job.id).reason, /already in that state; nothing issued/);
  assert.deepEqual(cps(d, again.job.id), ['validated', 'verified'], 'no issuing checkpoint when nothing is issued');
});

test('config_set with the snapshot: taken and read back BEFORE the first write (recorded as generated, the coverage naming the custom volume); a snapshot that fails changes nothing; a snapshot already there that this request did not take is refused', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst({ expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' }, vol: { type: 'disk', pool: 'default', source: 'vol1', path: '/var/lib/data' } } })] }; const h = scriptedHost(st);
  const sub = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'security.nesting', value: 'true' }], snapshot: { name: 'pp-mcp-pre-security_nesting-20260926-120000' }, expect: IDENTITY });
  await runAll(d, exec(h), c);
  const row = getJob(d, sub.job.id); assert.equal(row.status, 'succeeded', row.reason);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-security_nesting-20260926-120000'], ['incus', 'config', 'set', 'pp-x', 'security.nesting', 'true']], 'the snapshot first, the write second');
  const r = resultFromJob(row);
  assert.deepEqual({ name: r.snapshot.name, created_at: r.snapshot.created_at, reused: r.snapshot.reused }, { name: 'pp-mcp-pre-security_nesting-20260926-120000', created_at: '2026-09-26T12:00:00Z', reused: false });
  assert.match(r.snapshot.covers, /root disk and configuration only — the attached custom volume\(s\) vol are NOT covered; it never restores ProxyPilot's own database rows/);
  assert.deepEqual(parseJson(row.progress_json).generated.map((g) => [g.kind, g.name, g.created_at]), [['snapshot', 'pp-mcp-pre-security_nesting-20260926-120000', '2026-09-26T12:00:00Z']]);
  assert.deepEqual(cps(d, sub.job.id), ['validated', 'protect', 'issuing', 'applied', 'verified']);
  // The snapshot fails: nothing is written, the record says so.
  st.snapshotFails = true; h.calls.length = 0;
  const fails = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'boot.autostart', value: 'true' }], snapshot: { name: 'pp-mcp-pre-boot' } }, { nowMs: T0 + 5 });
  await runAll(d, exec(h), c);
  const f = getJob(d, fails.job.id); assert.equal(f.status, 'failed'); assert.match(f.reason, /refusing to change pp-x without its pre-change snapshot: .*no space left/);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-boot']]); assert.equal(st.instances[0].config['boot.autostart'], undefined);
  assert.equal(resultFromJob(f).step, 'protect'); assert.deepEqual(cps(d, fails.job.id), ['validated']);
  // A snapshot under the planned name that this request did not take: refused, nothing written.
  st.snapshotFails = false; st.instances[0].snapshots.push({ name: 'pp-mcp-pre-boot', created_at: '2026-09-20T00:00:00Z' }); h.calls.length = 0;
  const foreign = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'boot.autostart', value: 'true' }], snapshot: { name: 'pp-mcp-pre-boot' } }, { nowMs: T0 + 6 });
  await runAll(d, exec(h), c);
  const g = getJob(d, foreign.job.id); assert.equal(g.status, 'refused', g.reason); assert.match(g.reason, /already exists on pp-x and was not taken by this request; refusing/);
  assert.deepEqual(mutations(h), []);
  noSecretIn(d, [sub.job.id, fails.job.id, foreign.job.id]);
});

test('read-back is the proof: a key whose write exits 0 but does not read back fails at that step, the keys after it are not run, what was applied before it is reported (partial); a write that exits nonzero is the same, with the exit on the record', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()], configSetSilent: 'limits.memory' }; const h = scriptedHost(st);
  const sub = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MB' }, { key: 'boot.autostart', value: 'true' }] });
  await runAll(d, exec(h), c);
  const row = getJob(d, sub.job.id); assert.equal(row.status, 'failed'); assert.equal(row.outcome, 'failed at config:limits.memory');
  assert.match(row.reason, /set limits\.memory=4096MB exited 0; reads limits\.memory=2048MB afterwards \(applied before it: config:limits\.cpu\); not run: config:boot\.autostart/);
  const r = resultFromJob(row);
  assert.equal(r.partial, true); assert.deepEqual(r.notRun, ['config:boot.autostart']);
  assert.deepEqual(Object.fromEntries(Object.entries(r.applied).map(([k, a]) => [k, a.state])), { 'config:limits.cpu': 'done', 'config:limits.memory': 'failed' });
  assert.equal(parseJson(row.verification_json).state, 'recovery_required'); assert.equal(parseJson(row.verification_json).failedAt, 'config:limits.memory');
  assert.deepEqual(mutations(h).map((a) => a[4]), ['limits.cpu', 'limits.memory'], 'nothing after the failed key');
  st.configSetSilent = null; st.configSetFails = 'boot.autostart'; h.calls.length = 0;
  const two = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'boot.autostart', value: 'true' }] }, { nowMs: T0 + 5 });
  await runAll(d, exec(h), c);
  const t = getJob(d, two.job.id); assert.equal(t.status, 'failed'); assert.match(t.reason, /exited 1: Error: Invalid value for boot\.autostart; reads \(unset\) afterwards/);
  assert.equal(resultFromJob(t).applied['config:boot.autostart'].exit, 1);
});

test('identity: a guest of another identity under the confirmed name is refused with nothing issued (no snapshot either); a missing guest is not found', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst({ config: { 'volatile.uuid': UUID_B }, created_at: '2026-09-25T00:00:00Z' })] }; const h = scriptedHost(st);
  const sub = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }], snapshot: { name: 'pp-mcp-pre-limits_cpu' }, expect: IDENTITY });
  await runAll(d, exec(h), c);
  const row = getJob(d, sub.job.id); assert.equal(row.status, 'refused'); assert.match(row.reason, /not the guest this request was confirmed for \(uuid 99999999… differs from the confirmed 11111111…\)/);
  assert.deepEqual(mutations(h), []); assert.equal(resultFromJob(row).step, 'target');
  const gone = submit(d, 'device_remove', { container: 'pp-gone', device: 'data' });
  await runAll(d, exec(h), c);
  assert.equal(getJob(d, gone.job.id).status, 'failed'); assert.equal(resultFromJob(getJob(d, gone.job.id)).notFound, true);
});

test('device_add / device_remove: added and read back with every planned property; a device that exists with other properties is refused, never replaced; a remove of a device that is not there is refused before any command; the removed device\'s reference-only properties are recorded', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  const add = submit(d, 'device_add', { container: 'pp-x', device: 'media', deviceType: 'disk', props: { source: '/srv/shares/media', path: '/mnt/media', readonly: 'true' }, snapshot: { name: 'pp-mcp-pre-device-1' }, expect: IDENTITY });
  await runAll(d, exec(h), c);
  const a = getJob(d, add.job.id); assert.equal(a.status, 'succeeded', a.reason);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-device-1'], ['incus', 'config', 'device', 'add', 'pp-x', 'media', 'disk', 'source=/srv/shares/media', 'path=/mnt/media', 'readonly=true']]);
  assert.deepEqual(st.instances[0].devices.media, { type: 'disk', source: '/srv/shares/media', path: '/mnt/media', readonly: 'true' });
  assert.deepEqual(resultFromJob(a).previous, { device: null });
  // Exists with other properties: refused (no snapshot taken either — the refusal is at the step's read, after the protect? no: the snapshot is the plan's; here it was taken first). Assert what happened.
  h.calls.length = 0;
  const clash = submit(d, 'device_add', { container: 'pp-x', device: 'media', deviceType: 'disk', props: { source: '/srv/shares/other', path: '/mnt/media' } }, { nowMs: T0 + 5 });
  await runAll(d, exec(h), c);
  const cl = getJob(d, clash.job.id); assert.equal(cl.status, 'refused'); assert.match(cl.reason, /already exists on pp-x present with other properties \(source=\/srv\/shares\/media\); a device is never replaced/);
  assert.deepEqual(mutations(h), []);
  // Exists exactly as planned: nothing issued, said so.
  const same = submit(d, 'device_add', { container: 'pp-x', device: 'media', deviceType: 'disk', props: { source: '/srv/shares/media', path: '/mnt/media', readonly: 'true' } }, { nowMs: T0 + 6 });
  await runAll(d, exec(h), c);
  assert.equal(getJob(d, same.job.id).status, 'succeeded'); assert.equal(resultFromJob(getJob(d, same.job.id)).alreadyInState, true); assert.deepEqual(mutations(h), []);
  // A write that exits 0 without adding: failed at verify.
  st.deviceAddSilent = true;
  const silent = submit(d, 'device_add', { container: 'pp-x', device: 'ghost', deviceType: 'proxy', props: { listen: 'tcp:0.0.0.0:8080', connect: 'tcp:127.0.0.1:80' } }, { nowMs: T0 + 7 });
  await runAll(d, exec(h), c);
  assert.equal(getJob(d, silent.job.id).status, 'failed'); assert.match(getJob(d, silent.job.id).reason, /exited 0; reads absent afterwards/);
  st.deviceAddSilent = false;
  // Remove: the device with its unknown property recorded by its references only; a second remove is refused as not there.
  h.calls.length = 0;
  const rm = submit(d, 'device_remove', { container: 'pp-x', device: 'data', snapshot: { name: 'pp-mcp-pre-device-2' }, expect: IDENTITY }, { nowMs: T0 + 8 });
  await runAll(d, exec(h), c);
  const r = getJob(d, rm.job.id); assert.equal(r.status, 'succeeded', r.reason);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-device-2'], ['incus', 'config', 'device', 'remove', 'pp-x', 'data']]);
  assert.deepEqual(resultFromJob(r).previous, { device: { type: 'disk', source: '/srv/shares/data', path: '/data' } });
  noSecretIn(d, [rm.job.id, add.job.id]);
  h.calls.length = 0;
  const twice = submit(d, 'device_remove', { container: 'pp-x', device: 'data' }, { nowMs: T0 + 9 });
  await runAll(d, exec(h), c);
  const t = getJob(d, twice.job.id); assert.equal(t.status, 'refused'); assert.match(t.reason, /device data does not exist on pp-x; nothing was done/); assert.deepEqual(mutations(h), []);
});

test('network_pin: the override, or the set when eth0 is already instance-level; the previous reservation and the live address on the record; read back; the same pin again issues nothing', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  const pin = submit(d, 'network_pin', { container: 'pp-x', ip: '10.10.10.5', previous: '10.10.10.5', snapshot: { name: 'pp-mcp-pre-network-1' }, expect: IDENTITY });
  await runAll(d, exec(h), c);
  const a = getJob(d, pin.job.id); assert.equal(a.status, 'succeeded', a.reason);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-network-1'], ['incus', 'config', 'device', 'override', 'pp-x', 'eth0', 'ipv4.address=10.10.10.5']]);
  assert.deepEqual(resultFromJob(a).previous, { pin: null, address: '10.10.10.5' });
  assert.equal(st.instances[0].devices.eth0['ipv4.address'], '10.10.10.5');
  // Instance-level already: override says "already exists", the set applies.
  h.calls.length = 0;
  const re = submit(d, 'network_pin', { container: 'pp-x', ip: '10.10.10.9', previous: '10.10.10.5' }, { nowMs: T0 + 5 });
  await runAll(d, exec(h), c);
  assert.equal(getJob(d, re.job.id).status, 'succeeded', getJob(d, re.job.id).reason);
  assert.deepEqual(mutations(h), [['incus', 'config', 'device', 'override', 'pp-x', 'eth0', 'ipv4.address=10.10.10.9'], ['incus', 'config', 'device', 'set', 'pp-x', 'eth0', 'ipv4.address', '10.10.10.9']]);
  assert.deepEqual(resultFromJob(getJob(d, re.job.id)).previous, { pin: '10.10.10.5', address: '10.10.10.5' });
  h.calls.length = 0;
  const same = submit(d, 'network_pin', { container: 'pp-x', ip: '10.10.10.9' }, { nowMs: T0 + 6 });
  await runAll(d, exec(h), c);
  assert.equal(resultFromJob(getJob(d, same.job.id)).alreadyInState, true); assert.deepEqual(mutations(h), []);
});

test('forward_apply / forward_remove: the proxy device, the firewall rule and the reserved-ports drop-in (REAL sh) applied under the guest\'s lease and the shared firewall lease, each read back; a present device or rule is tolerated, never re-added; the remove mirrors it and the drop-in goes when nothing is reserved', async (t) => {
  const d = db(); const c = clock(); const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, '99-proxypilot-l4-reserved.conf');
  const st = { instances: [{ ...inst(), devices: {} }] }; const h = scriptedHost(st);
  const f = { id: 'f1', proto: 'udp', listen: 50000, listenEnd: 50100, connect: 50000, connectEnd: 50100, description: 'media' };
  const locksSeen = [];
  st.hook = async (argv) => { if (argv[0] === PROXYPILOT_BIN && argv[3] === 'add-service-l4') locksSeen.push({ guest: readLock(d, 'pp-x')?.owner || null, fw: readLock(d, HOST_FIREWALL_LOCK)?.owner || null }); return null; };
  const sub = submit(d, 'forward_apply', { container: 'pp-x', forward: f, bridgeIp: '10.10.10.5', serviceTag: 'x', reserved: [[50000, 50100]], expect: IDENTITY });
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  const row = getJob(d, sub.job.id); assert.equal(row.status, 'succeeded', row.reason);
  const m = mutations(h);
  assert.deepEqual(m[0], ['incus', 'config', 'device', 'add', 'pp-x', 'ppl4-f1', 'proxy', 'listen=udp:0.0.0.0:50000-50100', 'connect=udp:10.10.10.5:50000-50100']);
  assert.deepEqual(m[1], firewallAddArgv(f, 'x'));
  assert.deepEqual(m[2].slice(0, 4), ['sh', '-c', RESERVED_WRITE_SCRIPT, 'sh']); assert.equal(m[2][5], path);
  assert.deepEqual(m[3], ['sysctl', '-p', path]); assert.equal(m.length, 4);
  assert.equal(readFileSync(path, 'utf8'), reservedPortsBody('50000-50100')); assert.equal(st.sysctl, '50000-50100');
  assert.deepEqual(locksSeen, [{ guest: RUNNER, fw: RUNNER }], 'both leases held through the firewall write');
  assert.equal(readLock(d, HOST_FIREWALL_LOCK), null); assert.equal(readLock(d, 'pp-x'), null);
  const r = resultFromJob(row);
  assert.deepEqual(Object.fromEntries(Object.entries(r.applied).map(([k, a]) => [k, a.state])), { device: 'done', rule: 'done', reserved: 'done' });
  assert.deepEqual(r.reserved, { state: 'done', value: '50000-50100', file: true, live: true });
  assert.deepEqual(st.rules.map((x) => [x.id, x.port_start, x.port_end, x.proto, x.reason, x.service]), [['service-l4-f1', 50000, 50100, 'udp', 'media', 'x']]);
  // A second apply of the same forward: everything present, nothing issued.
  h.calls.length = 0;
  const again = submit(d, 'forward_apply', { container: 'pp-x', forward: f, bridgeIp: '10.10.10.5', serviceTag: 'x', reserved: [[50000, 50100]] }, { nowMs: T0 + 5 });
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  assert.equal(resultFromJob(getJob(d, again.job.id)).alreadyInState, true); assert.deepEqual(mutations(h), []);
  // The firewall refuses: the device is on the record as done, the rule failed, the job fails at the rule (partial), the reserved step not run.
  st.fwAddFails = true; h.calls.length = 0;
  const f2 = { id: 'f2', proto: 'tcp', listen: 7881, connect: 7881 };
  const fails = submit(d, 'forward_apply', { container: 'pp-x', forward: f2, bridgeIp: '10.10.10.5', reserved: [[50000, 50100]] }, { nowMs: T0 + 6 });
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  const fr = resultFromJob(getJob(d, fails.job.id));
  assert.equal(fr.ok, false); assert.equal(fr.step, 'rule'); assert.equal(fr.partial, true); assert.deepEqual(fr.notRun, ['reserved']); assert.match(fr.error, /panic mode/);
  assert.equal(st.instances[0].devices['ppl4-f2'].type, 'proxy', 'the device the record says is applied is there');
  st.fwAddFails = false;
  // Remove f2 (device present, rule absent → tolerated), then f1 with nothing left to reserve: the drop-in is removed and the kernel value cleared.
  h.calls.length = 0;
  const rm2 = submit(d, 'forward_remove', { container: 'pp-x', forward: f2, reserved: [[50000, 50100]] }, { nowMs: T0 + 7 });
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  assert.equal(getJob(d, rm2.job.id).status, 'succeeded', getJob(d, rm2.job.id).reason);
  assert.deepEqual(mutations(h), [['incus', 'config', 'device', 'remove', 'pp-x', 'ppl4-f2']], 'the absent rule is not removed again; the drop-in is current');
  h.calls.length = 0;
  const rm1 = submit(d, 'forward_remove', { container: 'pp-x', forward: f, reserved: [] }, { nowMs: T0 + 8 });
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  assert.equal(getJob(d, rm1.job.id).status, 'succeeded', getJob(d, rm1.job.id).reason);
  assert.deepEqual(mutations(h), [['incus', 'config', 'device', 'remove', 'pp-x', 'ppl4-f1'], firewallRemoveArgv('f1'), ['rm', '-f', path], ['sysctl', '-p', '/etc/sysctl.conf']]);
  assert.equal(existsSync(path), false); assert.equal(st.sysctl, ''); assert.deepEqual(st.rules, []); assert.deepEqual(st.instances[0].devices, {});
  // A sysctl that fails is a warning on a still-successful forward (the reconciler's contract), with the reserved step's state truthful.
  st.sysctlFails = true; h.calls.length = 0;
  const warn = submit(d, 'forward_apply', { container: 'pp-x', forward: f, bridgeIp: '10.10.10.5', reserved: [[50000, 50100]] }, { nowMs: T0 + 9 });
  await runAll(d, exec(h), c, { reservedPortsPath: path });
  const w = resultFromJob(getJob(d, warn.job.id));
  assert.equal(w.ok, true, JSON.stringify(w)); assert.equal(w.reserved.state, 'failed'); assert.match(w.warnings[0], /reserved: .*permission denied/);
});

test('egress_set: allow then deny through the firewall CLI, the entry read back each time, the reconcile summary on the record; a deny of a service not allowed issues nothing; a CLI that reports the change but the read-back disagrees is a failure', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  const allow = submit(d, 'egress_set', { container: 'pp-x', action: 'allow', service: 'smtp', reason: 'mail relay' });
  await runAll(d, exec(h), c);
  const a = getJob(d, allow.job.id); assert.equal(a.status, 'succeeded', a.reason);
  assert.deepEqual(mutations(h), [[PROXYPILOT_BIN, '--json', 'firewall', 'egress', 'allow', 'x', 'smtp', '--reason', 'mail relay']]);
  const r = resultFromJob(a); assert.deepEqual(r.allow, ['smtp']); assert.deepEqual(r.reconcile, { applied: true, checksum: 'c2', rejection: null });
  assert.ok(!h.calls.some((x) => x[0] === 'incus'), 'egress needs no guest read');
  assert.equal(readLock(d, HOST_FIREWALL_LOCK), null);
  h.calls.length = 0;
  const denyOther = submit(d, 'egress_set', { container: 'pp-x', action: 'deny', service: 'dns' }, { nowMs: T0 + 5 });
  await runAll(d, exec(h), c);
  assert.equal(resultFromJob(getJob(d, denyOther.job.id)).alreadyInState, true); assert.deepEqual(mutations(h), []);
  h.calls.length = 0;
  const deny = submit(d, 'egress_set', { container: 'pp-x', action: 'deny', service: 'smtp' }, { nowMs: T0 + 6 });
  await runAll(d, exec(h), c);
  assert.equal(getJob(d, deny.job.id).status, 'succeeded'); assert.deepEqual(st.egress, []); assert.deepEqual(resultFromJob(getJob(d, deny.job.id)).allow, []);
  st.egress = [{ container: 'x', allow: ['dns'] }]; st.egressDenySilent = true; h.calls.length = 0;
  const silent = submit(d, 'egress_set', { container: 'pp-x', action: 'deny', service: 'dns' }, { nowMs: T0 + 7 });
  await runAll(d, exec(h), c);
  const s = getJob(d, silent.job.id); assert.equal(s.status, 'failed'); assert.match(s.reason, /deny egress dns exited 0.*; reads present afterwards/);
});

// ── 3. locks, the shared lease, the executor policy, the keep-alive ───────

test('exclusive, never queued behind: refused at submission on a held or stale lease and an open mutating job, refused at claim, refused (cancelled) with no executor under runner-required; a lifecycle verb is refused while a configuration job is open', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  acquireLock(d, { app: 'pp-x', owner: OTHER, operation: 'deploy', jobId: 'dep', nowMs: T0 });
  const busy = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }] });
  assert.equal(busy.code, 'CONTAINER_BUSY'); assert.match(busy.error, /deploy .* is in progress for pp-x — the config set was refused before any change/);
  releaseLock(d, { app: 'pp-x', owner: OTHER, epoch: 1 });
  // Refused at claim: the lease appeared between submission and claim.
  const sub = submit(d, 'device_remove', { container: 'pp-x', device: 'data' });
  acquireLock(d, { app: 'pp-x', owner: OTHER, operation: 'restore_snapshot', jobId: 'rs', nowMs: T0 + 1 });
  const out = await runAll(d, exec(h), c);
  assert.equal(out.ran[0].status, 'refused'); assert.equal(out.ran[0].outcome, 'lock_held'); assert.deepEqual(mutations(h), []);
  releaseLock(d, { app: 'pp-x', owner: OTHER, epoch: 1 });
  // An open configuration job refuses a lifecycle verb and another config job.
  const open = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }] }, { nowMs: T0 + 2 });
  assert.ok(open.job);
  assert.equal(submit(d, 'instance_stop', { container: 'pp-x' }, { nowMs: T0 + 3 }).code, 'CONTAINER_BUSY');
  assert.equal(submit(d, 'egress_set', { container: 'pp-x', action: 'allow', service: 'dns' }, { nowMs: T0 + 3 }).code, 'CONTAINER_BUSY');
  await runAll(d, exec(h), c);
  // No executor: refused, cancelled on the record, nothing run in the backend.
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'runner-required' }, guestExec: exec(h), hostExec: h.host });
  try {
    h.calls.length = 0;
    const r = await runGuestConfig({ kind: 'config_set', containerName: 'pp-x', changes: [{ key: 'limits.cpu', value: '8' }] });
    assert.equal(r.ok, false); assert.equal(r.step, 'runner_unavailable'); assert.equal(r.refused, true); assert.equal(r.queued, undefined);
    assert.equal(getJob(d, r.jobId).status, 'cancelled'); assert.equal(getJob(d, r.jobId).outcome, 'runner_unavailable');
    assert.deepEqual(h.calls, [], 'the backend executed nothing'); assert.equal(st.instances[0].config['limits.cpu'], '4');
    assert.equal(lifecycleHttpStatus(r), 503);
  } finally { configureContainerLockStore(null); }
});

test('the shared firewall lease: a live holder is waited for and the job is refused (contended) with nothing issued; a dead holder is taken over; a lease taken over between two commands stops the job before its next write, with the count issued on the record and nothing further issued', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  // Live holder for longer than the wait.
  acquireLock(d, { app: HOST_FIREWALL_LOCK, owner: OTHER, operation: 'egress_set', jobId: 'o-1', leaseMs: 120_000, nowMs: T0 });
  const cont = submit(d, 'egress_set', { container: 'pp-x', action: 'allow', service: 'dns' });
  await runAll(d, exec(h), c);
  const cr = getJob(d, cont.job.id); assert.equal(cr.status, 'refused', cr.reason); assert.match(cr.reason, /host firewall lease is held by .*oooo.* \(20 s waited\); nothing was changed/);
  assert.deepEqual(mutations(h), []); assert.equal(readLock(d, HOST_FIREWALL_LOCK).owner, OTHER, 'the holder is untouched');
  assert.equal(readLock(d, 'pp-x'), null); assert.equal(lifecycleHttpStatus(resultFromJob(cr)), 409);
  // Dead holder: taken over, recorded, the job runs.
  c.tick(200_000); h.calls.length = 0;
  const over = submit(d, 'egress_set', { container: 'pp-x', action: 'allow', service: 'dns' }, { nowMs: c.nowMs() });
  await runAll(d, exec(h), c);
  assert.equal(getJob(d, over.job.id).status, 'succeeded', getJob(d, over.job.id).reason);
  assert.ok(listEvents(d, over.job.id).some((e) => e.kind === 'lock_takeover' && e.phase === 'egress_set'), 'the takeover is on the record');
  assert.ok(listEvents(d, over.job.id).some((e) => /took over the host firewall lease of dead holder/.test(e.message)));
  assert.equal(readLock(d, HOST_FIREWALL_LOCK), null, 'released when done');
  // Lost mid-sequence: after the device is added, another owner takes the lease over (as if this one had lapsed); the firewall write is refused.
  h.calls.length = 0; st.instances[0].devices = {};
  st.hook = async (argv) => {
    if (argv[0] === 'incus' && argv[3] === 'add') {
      d.prepare(`UPDATE setup_locks SET lease_expires_at = ? WHERE app = ?`).run(new Date(c.nowMs() - 1).toISOString(), HOST_FIREWALL_LOCK);
      assert.ok(acquireLock(d, { app: HOST_FIREWALL_LOCK, owner: OTHER, operation: 'forward_apply', jobId: 'o-2', leaseMs: 60_000, nowMs: c.nowMs() }).ok === false, 'a stale lease is not simply acquired');
      const t = d.prepare(`UPDATE setup_locks SET owner = ?, epoch = epoch + 1, lease_expires_at = ? WHERE app = ?`).run(OTHER, new Date(c.nowMs() + 60_000).toISOString(), HOST_FIREWALL_LOCK);
      assert.equal(t.changes, 1);
    }
    return null;
  };
  const f = { id: 'f9', proto: 'tcp', listen: 7881, connect: 7881 };
  const lost = submit(d, 'forward_apply', { container: 'pp-x', forward: f, bridgeIp: '10.10.10.5', reserved: [] }, { nowMs: c.nowMs() });
  await runAll(d, exec(h), c);
  const lr = getJob(d, lost.job.id); assert.equal(lr.status, 'failed'); assert.equal(lr.outcome, 'failed at lease');
  assert.match(lr.reason, /@host\/firewall lease is no longer this job's \(after 2 command\(s\)\); no further command is issued under it; pp-x: forward_apply was not completed by this job — retry it/);
  assert.deepEqual(mutations(h), [['incus', 'config', 'device', 'add', 'pp-x', 'ppl4-f9', 'proxy', 'listen=tcp:0.0.0.0:7881', 'connect=tcp:10.10.10.5:7881']], 'the firewall rule was never written');
  const r = resultFromJob(lr); assert.equal(r.leaseLost, true);
  assert.deepEqual({ state: r.applied.device.state, issued: r.applied.device.issued, lost: r.applied.device.leaseLost }, { state: 'unverified', issued: true, lost: true }, 'the device command was issued and its read-back not done under the lease: never "done"');
  assert.deepEqual(r.notRun, ['rule', 'reserved']); assert.equal(r.applied.rule, undefined);
  assert.ok(listEvents(d, lost.job.id).some((e) => e.kind === 'step' && /no longer this job's \(after 2 command\(s\)\)/.test(e.message)), 'the loss is an event on the job');
  assert.equal(readLock(d, HOST_FIREWALL_LOCK).owner, OTHER, 'the new owner\'s lease is untouched'); assert.deepEqual(st.rules, []);
});

test('the job CLAIM, the guest\'s lease and the shared lease are heart-beaten through ONE long command (real timer keep-alive, the runner\'s actual reconcile from another owner, the clock past the lease period three times): nothing is recorded interrupted, every lock stays this owner\'s, the job completes; a claim the reconciler ended under the command stops the job before its next write and revives nothing', async () => {
  const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
  const iso = (ms) => new Date(ms).toISOString();
  const live = (row, c) => !!row && !!row.lease_expires_at && Date.parse(row.lease_expires_at) > c.nowMs();
  {
    const d = db(); const c = clock(); const probes = []; let id = null;
    const st = { instances: [inst()] }; const h = scriptedHost(st);
    st.hook = async (argv) => {
      if (argv[0] === PROXYPILOT_BIN && argv[3] === 'egress' && argv[4] === 'allow') {
        for (let i = 0; i < 3; i += 1) { c.tick(22_000); await sleepReal(80); const r = reconcile({ db: d, owner: OTHER, nowMs: c.nowMs() }); const j = getJob(d, id); probes.push({ tick: i, reconcile: [r.requeued, r.interrupted, r.recoveryQueued].flat(), job: { status: j.status, owner: j.owner, live: live(j, c) }, guest: { owner: readLock(d, 'pp-x')?.owner || null, live: live(readLock(d, 'pp-x'), c) }, fw: { owner: readLock(d, HOST_FIREWALL_LOCK)?.owner || null, live: live(readLock(d, HOST_FIREWALL_LOCK), c) } }); }
      }
      return null;
    };
    const sub = submit(d, 'egress_set', { container: 'pp-x', action: 'allow', service: 'http' }); id = sub.job.id;
    const out = await runAll(d, exec(h), c, { keepAliveMs: 20 });
    assert.equal(probes.length, 3);
    for (const p of probes) {
      assert.deepEqual(p.reconcile, [], `tick ${p.tick}: the other runner's reconcile touched nothing: ${JSON.stringify(p)}`);
      assert.deepEqual(p.job, { status: 'running', owner: RUNNER, live: true }, `tick ${p.tick}: the claim is this runner's and live`);
      assert.deepEqual(p.guest, { owner: RUNNER, live: true }, `tick ${p.tick}`); assert.deepEqual(p.fw, { owner: RUNNER, live: true }, `tick ${p.tick}`);
    }
    assert.equal(out.ran[0].status, 'succeeded', getJob(d, id).reason); assert.deepEqual(st.egress, [{ container: 'x', allow: ['http'], reason: null }]);
    assert.equal(readLock(d, 'pp-x'), null); assert.equal(readLock(d, HOST_FIREWALL_LOCK), null);
  }
  {
    const d = db(); const c = clock(); let id = null; let recon = null;
    const st = { instances: [inst()] }; const h = scriptedHost(st);
    st.hook = async (argv) => {
      if (argv[0] === 'incus' && argv[2] === 'set' && argv[4] === 'limits.cpu') {
        d.prepare(`UPDATE setup_jobs SET lease_expires_at = ? WHERE id = ?`).run(iso(c.nowMs() - 1), id);
        recon = reconcile({ db: d, owner: OTHER, nowMs: c.nowMs() });
        await sleepReal(120);
      }
      return null;
    };
    const sub = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MB' }] }); id = sub.job.id;
    const out = await runAll(d, exec(h), c, { keepAliveMs: 20, max: 1 });
    assert.deepEqual(recon.requeued, [id], 'the reconciler requeued the resumable job under the command');
    assert.equal(out.ran[0].status, 'fenced', JSON.stringify(out.ran[0]));
    assert.deepEqual(mutations(h), [['incus', 'config', 'set', 'pp-x', 'limits.cpu', '4']], 'the second key was never written by the fenced worker');
    const row = getJob(d, id); assert.equal(row.status, 'queued', 'the reconciler\'s record stands; the fenced worker revived nothing');
    assert.ok(!listEvents(d, id).some((e) => /lease_lost|not completed/.test(e.message || '')), 'no outcome of its own');
  }
});

// ── 4. interruption: resumed by re-reading, nothing replayed blindly ───────

test('interrupted BEFORE the first write: the dead owner\'s job is requeued by the runner\'s reconcile and runs; interrupted AFTER the first write: the resumed job reuses the recorded snapshot (name + timestamp), reads the applied key as done, writes only the key that is not there; a guest recreated meanwhile is refused; a recorded snapshot that is gone is a warning, not a second snapshot', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  const params = { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MB' }], snapshot: { name: 'pp-mcp-pre-resources-1' }, expect: IDENTITY };
  // Before the first write (the validated checkpoint only).
  deadJob(d, { kind: 'config_set', params, cp: { phase: 'validated', config: true, resumable: true, disruptive: false, issued: false, target: IDENTITY, container: 'pp-x', kind: 'config_set' }, id: 'dead-before' });
  const rec = reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  assert.deepEqual(rec.requeued, ['dead-before']);
  await runAll(d, exec(h), c);
  const b = getJob(d, 'dead-before'); assert.equal(b.status, 'succeeded', b.reason);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-resources-1'], ['incus', 'config', 'set', 'pp-x', 'limits.cpu', '4'], ['incus', 'config', 'set', 'pp-x', 'limits.memory', '4096MB']]);
  // After the first write: cpu applied, memory not; the snapshot recorded with its timestamp.
  st.instances = [inst({ config: { 'volatile.uuid': UUID_A, 'limits.cpu': '4', 'limits.memory': '2048MB' }, snapshots: [{ name: 'pp-mcp-pre-resources-2', created_at: '2026-09-26T11:00:00Z' }] })]; h.calls.length = 0;
  const params2 = { ...params, snapshot: { name: 'pp-mcp-pre-resources-2' } };
  deadJob(d, { kind: 'config_set', params: params2, cp: { phase: 'applied', config: true, resumable: true, disruptive: false, issued: true, target: IDENTITY, container: 'pp-x', kind: 'config_set', snapshot: { name: 'pp-mcp-pre-resources-2', created_at: '2026-09-26T11:00:00Z', reused: false }, applied: { 'config:limits.cpu': { state: 'done', issued: true } } }, id: 'dead-after' });
  assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: T0 }).requeued, ['dead-after']);
  await runAll(d, exec(h), c);
  const a = getJob(d, 'dead-after'); assert.equal(a.status, 'succeeded', a.reason); assert.match(a.reason, /resumed after an interrupted attempt/); assert.match(a.reason, /pre-change snapshot pp-mcp-pre-resources-2 \(reused\)/);
  assert.deepEqual(mutations(h), [['incus', 'config', 'set', 'pp-x', 'limits.memory', '4096MB']], 'no second snapshot, the applied key not re-issued');
  const ar = resultFromJob(a); assert.equal(ar.snapshot.reused, true); assert.equal(ar.applied['config:limits.cpu'].state, 'done'); assert.equal(ar.applied['config:limits.cpu'].issued, false); assert.equal(ar.applied['config:limits.memory'].state, 'done');
  assert.ok(listEvents(d, 'dead-after').some((e) => e.kind === 'reuse' && /still exists with its recorded timestamp and is reused/.test(e.message)));
  // The guest was recreated under the name since the dead attempt bound it.
  st.instances = [inst({ config: { 'volatile.uuid': UUID_B }, created_at: '2026-09-26T11:30:00Z' })]; h.calls.length = 0;
  deadJob(d, { kind: 'config_set', params: { ...params, expect: undefined, snapshot: undefined }, cp: { phase: 'issuing', config: true, resumable: true, disruptive: false, issued: true, target: IDENTITY, container: 'pp-x', kind: 'config_set' }, id: 'dead-recreated' });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  await runAll(d, exec(h), c);
  const rc = getJob(d, 'dead-recreated'); assert.equal(rc.status, 'refused'); assert.match(rc.reason, /changed since this job's interrupted attempt bound it/); assert.deepEqual(mutations(h), []);
  // The recorded snapshot is gone after the issue: a warning, the job converges, no new snapshot.
  st.instances = [inst({ config: { 'volatile.uuid': UUID_A, 'limits.cpu': '4', 'limits.memory': '2048MB' } })]; h.calls.length = 0;
  deadJob(d, { kind: 'config_set', params: params2, cp: { phase: 'applied', config: true, resumable: true, disruptive: false, issued: true, target: IDENTITY, container: 'pp-x', kind: 'config_set', snapshot: { name: 'pp-mcp-pre-resources-2', created_at: '2026-09-26T11:00:00Z' }, applied: { 'config:limits.cpu': { state: 'done', issued: true } } }, id: 'dead-gone' });
  reconcile({ db: d, owner: RUNNER, nowMs: T0 });
  await runAll(d, exec(h), c);
  const g = getJob(d, 'dead-gone'); assert.equal(g.status, 'succeeded', g.reason); assert.match(g.reason, /no longer on the guest; the attempt's change was already issued/);
  assert.deepEqual(mutations(h), [['incus', 'config', 'set', 'pp-x', 'limits.memory', '4096MB']]); assert.equal(resultFromJob(g).snapshot.missing, true);
  noSecretIn(d, ['dead-before', 'dead-after', 'dead-recreated', 'dead-gone']);
});

test('the boot sweep (a dead in-process backend, nothing to act) records an issued configuration interrupted with the honest reason and releases the lease; an explicit retry (retryOf) revalidates and REUSES the origin\'s snapshot by name and timestamp, never taking a second one', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst({ snapshots: [{ name: 'pp-mcp-pre-device-7', created_at: '2026-09-26T11:00:00Z' }] })] }; const h = scriptedHost(st);
  const params = { container: 'pp-x', device: 'media', deviceType: 'disk', props: { source: '/srv/shares/media', path: '/mnt/media' }, snapshot: { name: 'pp-mcp-pre-device-7' }, expect: IDENTITY };
  createJob(d, { id: 'b-1', kind: 'device_add', app: 'pp-x', plan: { steps: [], params }, nowMs: T0 - 100_000 });
  const claimed = claimNextJob(d, { owner: DEAD_BACKEND, kinds: ['device_add'], nowMs: T0 - 99_000 });
  acquireLock(d, { app: 'pp-x', owner: DEAD_BACKEND, operation: 'device_add', jobId: 'b-1', nowMs: T0 - 99_000 });
  checkpoint(d, { id: 'b-1', owner: DEAD_BACKEND, epoch: claimed.epoch, phase: 'issuing', checkpoint: { config: true, resumable: true, disruptive: false, issued: true, target: IDENTITY, container: 'pp-x', kind: 'device_add', snapshot: { name: 'pp-mcp-pre-device-7', created_at: '2026-09-26T11:00:00Z' } }, nowMs: T0 - 98_000 });
  d.prepare(`UPDATE setup_jobs SET progress_json = ? WHERE id = 'b-1'`).run(JSON.stringify({ generated: [{ kind: 'snapshot', name: 'pp-mcp-pre-device-7', where: 'pp-x', created_at: '2026-09-26T11:00:00Z' }] }));
  const swept = sweepSetupEngineOnBoot(d, { owner: BACKEND, nowMs: T0 });
  assert.deepEqual(swept.interrupted, ['b-1']);
  const row = getJob(d, 'b-1'); assert.equal(row.status, 'failed'); assert.equal(row.outcome, 'interrupted');
  assert.match(row.reason, /the device_add command had been issued and may have taken effect — a retry re-reads the guest and finishes or re-issues the same command against the same identity/);
  assert.equal(readLock(d, 'pp-x'), null, 'the lease is released: an idempotent command holds nothing');
  assert.equal(reconcileDecision({ job: { ...row, status: 'running', lease_expires_at: '2020-01-01T00:00:00Z' }, nowMs: T0, canAct: true }).action, 'resume', 'with a runner it is resumed');
  // The retry: the same plan, the origin's generated snapshot revalidated and reused.
  const plan = retryPlan(row);
  assert.deepEqual(plan.reuse, [{ kind: 'snapshot', name: 'pp-mcp-pre-device-7', where: 'pp-x', created_at: '2026-09-26T11:00:00Z' }]);
  const retry = createJob(d, { kind: 'device_add', app: 'pp-x', plan, retryOf: 'b-1', nowMs: T0 });
  await runAll(d, exec(h), c);
  const rr = getJob(d, retry.id); assert.equal(rr.status, 'succeeded', rr.reason);
  assert.deepEqual(mutations(h), [['incus', 'config', 'device', 'add', 'pp-x', 'media', 'disk', 'source=/srv/shares/media', 'path=/mnt/media']], 'no second snapshot');
  assert.equal(resultFromJob(rr).snapshot.reused, true);
  // The origin's snapshot replaced under its name since: refused, nothing written.
  st.instances[0].snapshots = [{ name: 'pp-mcp-pre-device-7', created_at: '2026-09-26T11:59:00Z' }]; delete st.instances[0].devices.media; h.calls.length = 0;
  const retry2 = createJob(d, { kind: 'device_add', app: 'pp-x', plan, retryOf: 'b-1', nowMs: T0 + 1 });
  await runAll(d, exec(h), c);
  const r2 = getJob(d, retry2.id); assert.equal(r2.status, 'refused'); assert.match(r2.reason, /with a different timestamp than the one this job recorded/); assert.deepEqual(mutations(h), []);
});

test('mandatory checkpoints: a store that rejects the issuing checkpoint issues nothing; a fenced job (its claim moved) writes nothing and touches no target', async () => {
  const d = db(); const c = clock();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  const sub = submit(d, 'config_set', { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }] });
  const job = claimNextJob(d, { owner: RUNNER, kinds: ['config_set'], nowMs: T0 });
  let n = 0;
  const handle = { id: job.id, fence: () => {}, checkpoint: (phase) => { n += 1; if (phase === 'issuing') throw new Error('disk I/O error'); return 1; }, generated: () => 1, event: () => {}, progress: () => 1, onStep: null };
  const r = await runConfigOperation({ kind: 'config_set', params: { container: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }] }, exec: exec(h), job: handle });
  assert.equal(r.ok, false); assert.equal(r.step, 'checkpoint'); assert.equal(r.notIssued, true); assert.match(r.error, /'issuing' checkpoint could not be persisted \(disk I\/O error\); refusing to issue/);
  assert.deepEqual(mutations(h), []); assert.equal(st.instances[0].config['limits.cpu'], '2');
  void sub;
});

// ── 5. the callers ────────────────────────────────────────────────────────

test('the ops layer: resolveConfigPlan binds the digest to the exact change; an invalid request never reaches the store; runGuestConfig submits and observes; the HTTP mapping', async (t) => {
  const d = db();
  const st = { instances: [inst()] }; const h = scriptedHost(st);
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(h), hostExec: h.host, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const a = resolveConfigPlan(d, { kind: 'config_set', containerName: 'pp-x', changes: [{ key: 'limits.cpu', value: 4 }], snapshot: 'pp-mcp-pre-x', expect: IDENTITY });
  const b = resolveConfigPlan(d, { kind: 'config_set', containerName: 'pp-x', changes: [{ key: 'limits.cpu', value: '8' }], snapshot: 'pp-mcp-pre-x', expect: IDENTITY });
  assert.equal(a.ok, true); assert.notEqual(a.digest, b.digest); assert.deepEqual(a.params.changes, [{ key: 'limits.cpu', value: '4' }]); assert.deepEqual(a.plan.expect, IDENTITY);
  assert.match(resolveConfigPlan(d, { kind: 'device_add', containerName: 'pp-x', device: 'x', deviceType: 'disk', props: { source: '/etc', path: '/x' } }).error, /under one of/);
  assert.match(resolveConfigPlan(d, { kind: 'egress_set', containerName: 'pp-x', action: 'allow', service: 'dns', retryOf: 'nope' }).error, /no such job/);
  const bad = await runGuestConfig({ kind: 'config_set', containerName: 'pp-x', changes: [{ key: 'user.x', value: 'y' }] });
  assert.equal(bad.code, 'INVALID'); assert.equal(listJobs(d).length, 0, 'no job row for an invalid plan'); assert.equal(lifecycleHttpStatus(bad), 400);
  const out = await runGuestConfig({ kind: 'config_set', containerName: 'pp-x', changes: [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '8192MB' }], requestedBy: 'admin', via: 'ui' });
  assert.equal(out.ok, true, out.error); assert.equal(out.step, 'configured'); assert.ok(out.jobId); assert.deepEqual(out.previous.config, { 'limits.cpu': '2', 'limits.memory': '2048MB' });
  assert.equal(getJob(d, out.jobId).via, 'ui'); assert.equal(getJob(d, out.jobId).requested_by, 'admin');
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'lease', refused: true, contended: true }), 409);
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'protect', refused: true }), 409);
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'protect' }), 500, 'a snapshot that failed is a 500, not a conflict');
  assert.equal(lifecycleHttpStatus({ ok: false, step: 'query', notFound: true }), 404);
  // Busy: a lifecycle job open on the guest refuses the configuration.
  const busy = submitRunnerJob(d, { kind: 'instance_stop', app: 'pp-x', params: { container: 'pp-x' } });
  const refused = await runGuestConfig({ kind: 'network_pin', containerName: 'pp-x', ip: '10.10.10.5' });
  assert.equal(refused.code, 'CONTAINER_BUSY'); assert.equal(lifecycleHttpStatus(refused), 409); void busy;
});

const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
const LXC_POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/lxc-command-allowlist.json', import.meta.url), 'utf8'));
const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return { error: r.content[0].text, isError: !!r.isError }; } };
const AUTH = { id: 7, created_by: 'admin-1', name: 'test key', scope_json: null };

// The MCP context: the real node:sqlite database (the services / forwards /
// ledger tables the tools read and write), the guest read from the scripted
// state, a host channel that records what the TOOL itself issues.
function mcpCtx(d, state) {
  d.exec(`CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, runtime TEXT, type TEXT, status TEXT, is_admin INTEGER DEFAULT 0, target_ip TEXT, lxc_container_name TEXT);
    CREATE TABLE IF NOT EXISTS service_l4_forwards (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, proto TEXT NOT NULL CHECK (proto IN ('tcp','udp')), listen_port INTEGER NOT NULL, listen_port_end INTEGER, connect_port INTEGER NOT NULL, connect_port_end INTEGER, description TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(proto, listen_port, listen_port_end));
    CREATE TABLE IF NOT EXISTS mcp_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, token_id INTEGER, actor TEXT, tool TEXT NOT NULL, subject_type TEXT, subject_id TEXT, project_id INTEGER, args_json TEXT, outcome TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0, confirmation_used INTEGER NOT NULL DEFAULT 0, snapshot TEXT, summary TEXT, detail_json TEXT, duration_ms INTEGER);`);
  const confirmations = createConfirmationStore();
  const hostCalls = [];
  let n = 0;
  const ctx = {
    getDb: () => d, logAudit: () => {}, getSetting: () => null, setSetting: () => {}, toolResult, uuidv4: () => `fwd-${(n += 1)}`, policy: POLICY, confirmations,
    runHostCapture: async (bin, args) => { hostCalls.push([bin, ...args]); return { status: 0, stdout: '', stderr: '' }; },
    runInContainer: async () => ({ status: 0, stdout: '', stderr: '' }), readContainerStartup: async () => null, agentCall: async () => { throw new Error('no agent'); }, publicBaseUrl: () => 'https://pp.test',
    LXC_PREFIX: 'pp-', LXC_NAME_REGEX: /^[a-zA-Z0-9][a-zA-Z0-9-]*$/, LXC_CMD_POLICY: LXC_POLICY, LXC_LIST_CAPTURE_CAP: 1 << 24,
    validLxcFilePath: (p) => p, validTargetDir: (p) => (String(p || '').startsWith('/') ? String(p) : null),
    takeLxcSnapshot: async () => { throw new Error('the config verbs never call takeLxcSnapshot'); }, fetchLxcInstance: async (nm) => { const i = state.instances.find((x) => x.name === nm); return i ? { instance: i } : { notFound: true }; },
    lxcContainerDetail, lxcReachableAddress: () => null,
    defaultSnapshotName: (dt, p = 'pp-mcp') => `${p}-20260926-120000`, validSnapshotName: (s) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(s || '')) ? String(s) : null), snapshotArgv: (v, i, s) => ['snapshot', v, i, s], resolveSnapshotCliForm: async () => 'subcommand',
    verifiedContainerWrite: async () => ({}), takeUploadTicket: async () => { throw new Error('no ticket'); },
    findOrCreateLxcService: (dbx, name, ip) => { const ex = dbx.prepare(`SELECT * FROM services WHERE lxc_container_name = ? AND is_admin = 0`).get(name); if (ex) return ex; dbx.prepare(`INSERT INTO services (id, name, target_ip, lxc_container_name) VALUES (?, ?, ?, ?)`).run(`svc-${name}`, name, ip, name); return dbx.prepare(`SELECT * FROM services WHERE id = ?`).get(`svc-${name}`); },
    syncLxcServiceUpstream: async () => ({}), regenerateDomainCaddyConfig: async () => {}, ensureCaddyStructure: async () => {},
    assertRoutesShareSslStance: () => {}, caddyAdapt: async () => {}, caddyReload: async () => {}, normalizePathPrefix: (v) => v || '/',
    validDomainName: (s) => s, normalizePort: (p) => Number(p) || null, validIpv4: (s) => s, ROUTE_SELECT: 'SELECT 1', routeView: (r) => r, certInfoForDomain: async () => ({}), recentErrorsForDomain: async () => null,
    caddyAccessLogPath: (x) => x, summarizeAccessLog: () => ({}), getStaticSite: () => null, staticSiteDomains: () => [], SERVICES_DATA_DIR: '/data/services', walkDocroot: async () => ({ files: [] }),
    mock2Enabled: () => true, mock2Modules: async () => ({}), projectContainerName: () => 'pp-x', requireActiveProject: () => ({ project: { id: 1, name: 'demo' } }),
    liveBuildGuard: () => null, commitProjectPaths: async () => ({}), readProjectText: async () => ({ error: 'x' }), M2_APP_DIR: '/srv/app', projectUrl: () => null, projectSummary: (p) => p,
    appendProjectChangeRecord: async () => ({ appended: true, seq: 1 }),
    selfUpdateInstalled: async () => ({ reachable: false }), selfUpdateStart: async () => { throw new Error('off'); }, selfUpdateStatus: async () => ({ status: 'idle' }), SELF_UPDATE_POLICY: { enabled: true },
    mintMcpToken: () => 'ppmcp_' + 'a'.repeat(64), hashMcpToken: (tk) => `h:${tk}`, MCP_TOOL_NAMES: () => MCP_TOOLS.map((x) => x.name), dbPath: '/tmp/pp.db', listBackupsRunning: null,
  };
  const ledger = () => d.prepare(`SELECT * FROM mcp_ledger ORDER BY id`).all();
  return { ctx, ledger, confirmations, hostCalls };
}
function mcpStore(d, h) { configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(h), hostExec: h.host, reviewLogin: async () => LOGIN }); }

test('MCP set_lxc_resources / add_lxc_device / remove_lxc_device: dry_run and the confirm gate as before; the job is bound to the guest\'s identity, takes the planned snapshot first and reads every value back; the tool itself issues no incus command; the ledger row names the job and the snapshot; a guest replaced between the read and the job is refused', async (t) => {
  const d = db(); const st = { instances: [inst()] }; const h = scriptedHost(st);
  mcpStore(d, h); t.after(() => configureContainerLockStore(null));
  const { ctx, ledger, hostCalls } = mcpCtx(d, st);
  const tools = createExtendedHandlers(ctx).handlers;
  const dry = parse(await tools.set_lxc_resources({ container: 'x', cpu: 4, memory_mb: 4096, disk_gb: 40, dry_run: true }, AUTH));
  assert.equal(dry.dry_run, true); assert.deepEqual(dry.would.config, [{ key: 'limits.cpu', value: '4' }, { key: 'limits.memory', value: '4096MiB' }]); assert.equal(listJobs(d).length, 0);
  assert.match(parse(await tools.set_lxc_resources({ container: 'x', cpu: 4 }, AUTH)).error, /confirm: true/);
  const done = parse(await tools.set_lxc_resources({ container: 'x', cpu: 4, memory_mb: 4096, disk_gb: 40, confirm: true }, AUTH));
  assert.deepEqual(done.applied, ['limits.cpu=4', 'limits.memory=4096MiB', 'root.size=40GiB'], JSON.stringify(done));
  assert.equal(done.snapshot, 'pp-mcp-pre-resources-20260926-120000'); assert.match(done.snapshot_covers, /root disk and configuration only/); assert.equal(done.verified, true); assert.ok(done.job_id);
  assert.deepEqual(done.previous, { config: { 'limits.cpu': '2', 'limits.memory': '2048MB' }, rootSize: null });
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-resources-20260926-120000'], ['incus', 'config', 'set', 'pp-x', 'limits.cpu', '4'], ['incus', 'config', 'set', 'pp-x', 'limits.memory', '4096MiB'], ['incus', 'config', 'device', 'override', 'pp-x', 'root', 'size=40GiB']]);
  assert.deepEqual(hostCalls, [], 'the tool itself issues nothing on the host');
  const job = getJob(d, done.job_id); assert.equal(job.kind, 'config_set'); assert.equal(job.via, 'mcp'); assert.deepEqual(parseJson(job.plan_json).params.expect, IDENTITY);
  const row = ledger().find((r) => r.tool === 'set_lxc_resources' && r.outcome === 'ok'); assert.ok(row); assert.equal(row.snapshot, done.snapshot); assert.equal(JSON.parse(row.detail_json).job_id, done.job_id);
  noSecretIn(d, [done.job_id]);
  // Devices.
  h.calls.length = 0;
  const add = parse(await tools.add_lxc_device({ container: 'x', device: 'media', type: 'disk', source: '/srv/shares/media', path: '/mnt/media', readonly: true, confirm: true }, AUTH));
  assert.equal(add.added, true, JSON.stringify(add)); assert.equal(add.snapshot, 'pp-mcp-pre-device-20260926-120000'); assert.ok(add.job_id); assert.equal(add.verified, true);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-device-20260926-120000'], ['incus', 'config', 'device', 'add', 'pp-x', 'media', 'disk', 'source=/srv/shares/media', 'path=/mnt/media', 'readonly=true']]);
  assert.match(parse(await tools.add_lxc_device({ container: 'x', device: 'etc', type: 'disk', source: '/etc', path: '/mnt/etc', confirm: true }, AUTH)).error, /disk source must be an absolute host path under one of/);
  assert.match(parse(await tools.add_lxc_device({ container: 'x', device: 'media', type: 'disk', source: '/srv/shares/media', path: '/mnt/media', confirm: true }, AUTH)).error, /already exists on x — remove_lxc_device first/);
  st.instances[0].snapshots = []; h.calls.length = 0;
  const rm = parse(await tools.remove_lxc_device({ container: 'x', device: 'media', confirm: true }, AUTH));
  assert.equal(rm.removed, true, JSON.stringify(rm)); assert.deepEqual(rm.previous, { type: 'disk', source: '/srv/shares/media', path: '/mnt/media', readonly: 'true' }); assert.ok(rm.job_id);
  assert.deepEqual(mutations(h), [['incus', 'snapshot', 'create', 'pp-x', 'pp-mcp-pre-device-20260926-120000'], ['incus', 'config', 'device', 'remove', 'pp-x', 'media']]);
  // Replaced between the tool's read and the job: refused by the job, nothing issued.
  const listing = mcpCtx(d, { instances: [inst({ config: { 'volatile.uuid': UUID_B }, created_at: '2026-09-26T11:59:00Z', snapshots: [] })] });
  h.calls.length = 0;
  const stale = parse(await createExtendedHandlers(listing.ctx).handlers.set_lxc_resources({ container: 'x', cpu: 8, confirm: true }, AUTH));
  assert.match(stale.error, /not the guest this request was confirmed for/); assert.equal(stale.refused, true); assert.deepEqual(mutations(h), []);
  // A refused job under a busy guest: before any change.
  acquireLock(d, { app: 'pp-x', owner: RUNNER, operation: 'deploy', jobId: 'dep', nowMs: Date.now() });
  const busy = parse(await tools.set_lxc_resources({ container: 'x', cpu: 8, confirm: true }, AUTH));
  assert.match(busy.error, /deploy .* is in progress for pp-x — the config set was refused before any change/); assert.deepEqual(mutations(h), []);
});

test('MCP set_port_forward add / remove: the row is the tool\'s (a backend step), the device, rule and drop-in the job\'s (REAL sh for the drop-in); the response keeps its shape with the job id; a definite host failure rolls the row back and names what the host holds; the remove clears the host side and recomputes the reservation', async (t) => {
  const d = db(); const dir = tmp(); const path = join(dir, '99-l4.conf');
  const st = { instances: [{ ...inst(), devices: {} }] }; const h = scriptedHost(st);
  // The store names the drop-in the in-process executor refreshes (a temp file here; the host's /etc/sysctl.d in production).
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(h), hostExec: h.host, reviewLogin: async () => LOGIN, reservedPortsPath: path });
  t.after(() => { configureContainerLockStore(null); rmSync(dir, { recursive: true, force: true }); });
  const { ctx, ledger, hostCalls } = mcpCtx(d, st);
  const tools = createExtendedHandlers(ctx).handlers;
  const dry = parse(await tools.set_port_forward({ container: 'x', protocol: 'udp', listen_port: 50000, listen_port_end: 50100, connect_port: 50000, description: 'media', dry_run: true }, AUTH));
  assert.equal(dry.would.listen, '50000-50100'); assert.equal(d.prepare(`SELECT count(*) AS n FROM service_l4_forwards`).get().n, 0);
  const add = parse(await tools.set_port_forward({ container: 'x', protocol: 'udp', listen_port: 50000, listen_port_end: 50100, connect_port: 50000, description: 'media', confirm: true }, AUTH));
  assert.equal(add.added, true, JSON.stringify(add)); assert.equal(add.forward_id, 'fwd-1'); assert.ok(add.job_id); assert.equal(add.verified, true);
  assert.deepEqual(add.reconcile.applied, [{ id: 'fwd-1', status: 'applied', detail: { incus: 'applied', firewall: 'applied' } }]); assert.deepEqual(add.reconcile.reservedPorts, { state: 'done', value: '50000-50100', file: true, live: true });
  assert.deepEqual(hostCalls, []);
  const m = mutations(h);
  assert.deepEqual(m[0], ['incus', 'config', 'device', 'add', 'pp-x', 'ppl4-fwd-1', 'proxy', 'listen=udp:0.0.0.0:50000-50100', 'connect=udp:10.10.10.5:50000-50100']);
  assert.deepEqual(m[1], [PROXYPILOT_BIN, '--json', 'firewall', 'add-service-l4', '--id', 'service-l4-fwd-1', '--port', '50000', '--proto', 'udp', '--reason', 'media', '--port-end', '50100', '--service', 'x']);
  assert.equal(readFileSync(path, 'utf8'), reservedPortsBody('50000-50100'));
  const job = getJob(d, add.job_id); assert.equal(job.kind, 'forward_apply'); assert.deepEqual(parseJson(job.plan_json).params.reserved, [[50000, 50100]]);
  assert.equal(d.prepare(`SELECT count(*) AS n FROM service_l4_forwards WHERE id = 'fwd-1'`).get().n, 1);
  assert.equal(JSON.parse(ledger().find((r) => r.tool === 'set_port_forward' && r.outcome === 'ok').detail_json).job_id, add.job_id);
  // A definite failure at the firewall: the row is rolled back, the response says what the host holds.
  st.fwAddFails = true; h.calls.length = 0;
  const fail = parse(await tools.set_port_forward({ container: 'x', protocol: 'tcp', listen_port: 7881, connect_port: 7881, confirm: true }, AUTH));
  assert.match(fail.error, /L4 apply failed: .*panic mode.* \(applied before it: device\); not run: reserved \(job .*\) — the forward row was rolled back/);
  assert.equal(fail.applied.device.state, 'done'); assert.equal(fail.applied.rule.state, 'failed'); assert.equal(fail.row_kept, false);
  assert.equal(d.prepare(`SELECT count(*) AS n FROM service_l4_forwards WHERE id = 'fwd-2'`).get().n, 0);
  assert.equal(st.instances[0].devices['ppl4-fwd-2']?.type, 'proxy', 'the device the response names is still on the host for the reconciler');
  st.fwAddFails = false;
  // List, then remove: the row goes, the job clears the host and the reservation.
  const list = parse(await tools.set_port_forward({ container: 'x', action: 'list' }, AUTH)); assert.deepEqual(list.forwards.map((f) => f.id), ['fwd-1']);
  h.calls.length = 0;
  const rm = parse(await tools.set_port_forward({ container: 'x', action: 'remove', forward_id: 'fwd-1', confirm: true }, AUTH));
  assert.equal(rm.removed, true, JSON.stringify(rm)); assert.equal(rm.forward.id, 'fwd-1'); assert.ok(rm.job_id); assert.deepEqual(rm.reconcile.applied, [{ id: 'fwd-1', status: 'removed', detail: { incus: 'done', firewall: 'done' } }]);
  assert.deepEqual(mutations(h), [['incus', 'config', 'device', 'remove', 'pp-x', 'ppl4-fwd-1'], [PROXYPILOT_BIN, '--json', 'firewall', 'remove-service-l4', 'service-l4-fwd-1'], ['rm', '-f', path], ['sysctl', '-p', '/etc/sysctl.conf']]);
  assert.equal(existsSync(path), false); assert.deepEqual(parseJson(getJob(d, rm.job_id).plan_json).params.reserved, []);
  assert.equal(d.prepare(`SELECT count(*) AS n FROM service_l4_forwards`).get().n, 0);
});

test('MCP set_lxc_egress: allow and deny run as jobs under the firewall lease with the entry read back; the response keeps its shape (reconcile, reverse_with) with the job id; the tool issues nothing itself', async (t) => {
  const d = db(); const st = { instances: [inst()] }; const h = scriptedHost(st);
  mcpStore(d, h); t.after(() => configureContainerLockStore(null));
  const { ctx, ledger, hostCalls } = mcpCtx(d, st);
  const tools = createExtendedHandlers(ctx).handlers;
  assert.match(parse(await tools.set_lxc_egress({ container: 'x', action: 'allow', service: 'smtp' }, AUTH)).error, /confirm: true/);
  const allow = parse(await tools.set_lxc_egress({ container: 'x', action: 'allow', service: 'smtp', reason: 'relay', confirm: true }, AUTH));
  assert.equal(allow.applied, true, JSON.stringify(allow)); assert.deepEqual(allow.reconcile, { applied: true, checksum: 'c2', rejection: null }); assert.deepEqual(allow.allow, ['smtp']); assert.ok(allow.job_id);
  assert.equal(allow.reverse_with, 'set_lxc_egress({ container: "x", action: "deny", service: "smtp", confirm: true })');
  assert.deepEqual(mutations(h), [[PROXYPILOT_BIN, '--json', 'firewall', 'egress', 'allow', 'x', 'smtp', '--reason', 'relay']]); assert.deepEqual(hostCalls, []);
  assert.equal(getJob(d, allow.job_id).kind, 'egress_set');
  assert.equal(JSON.parse(ledger().find((r) => r.tool === 'set_lxc_egress' && r.outcome === 'ok').detail_json).job_id, allow.job_id);
  h.calls.length = 0;
  const deny = parse(await tools.set_lxc_egress({ container: 'x', action: 'deny', service: 'smtp', confirm: true }, AUTH));
  assert.equal(deny.applied, true); assert.deepEqual(deny.allow, []); assert.deepEqual(st.egress, []);
  st.egressFails = true; h.calls.length = 0;
  const fails = parse(await tools.set_lxc_egress({ container: 'x', action: 'allow', service: 'dns', confirm: true }, AUTH));
  assert.match(fails.error, /Egress allow failed: .*reconcile rejected/); assert.ok(fails.job_id);
});

// ── 6. the rendered argv reaches the real host channel verbatim ───────────

test('the runner\'s host channel receives the rendered argv as one spawn — no shell between the plan and the process (the reserved-ports write included: sh is the program, the script and its arguments are argv)', async () => {
  const spawned = [];
  const spawnImpl = (bin, args, opts) => { spawned.push([bin, ...args]); return spawn('true', [], opts); };
  const ex = hostGuestExec({ spawnImpl });
  const f = { id: 'f1', proto: 'udp', listen: 50000, listenEnd: 50100, connect: 50000, connectEnd: 50100 };
  for (const argv of [configSetArgv('pp-x', 'limits.memory', '4096MB'), deviceAddArgv('pp-x', 'media', 'disk', { source: '/srv/shares/a b', path: '/mnt/a' }), firewallAddArgv(f, 'x'), egressArgv('pp-x', 'allow', 'smtp', 'mail relay; please'), reservedWriteArgv(reservedPortsBody('50000-50100'), '/etc/sysctl.d/99-proxypilot-l4-reserved.conf')]) {
    const r = await ex.host(argv, { timeoutMs: 5000 });
    assert.equal(r.code, 0);
    assert.deepEqual(spawned[spawned.length - 1], argv, 'spawned verbatim');
  }
  assert.equal(spawned.length, 5);
  assert.equal(spawned[3][8], 'mail relay; please', 'the reason with shell characters is one argument');
});

