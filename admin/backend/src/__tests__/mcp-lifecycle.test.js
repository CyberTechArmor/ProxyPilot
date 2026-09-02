// MCP archive / pin / host-usage tools — the pure layer (lib/mcp-logic.js)
// and the injectable orchestrator (lib/project-lifecycle.js) against a fake
// Incus. Native-free: no better-sqlite3, no nsenter.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MCP_TOOLS, MCP_SERVER_INSTRUCTIONS,
  normalizeProjectFilters, filterProjectSummaries, containerStatusWord,
  lifecycleRefusal, parseArchiveState,
  parseProcLoadavg, parseProcMeminfo, parseDfOutput, pickStoragePool, parseProfileRootPool,
  parsePoolResources, parseStorageInfoText, containerUsageRow, summarizeContainers,
  buildHostUsage, perProjectUsage, validateHostUsage, reclaimDelta,
} from '../lib/mcp-logic.js';
import { archiveProject, unarchiveProject } from '../lib/project-lifecycle.js';

const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/project-lifecycle-allowlist.json', import.meta.url), 'utf8'));
const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));

/* ------------------------------ catalog -------------------------------- */

test('the archive/pin/usage tools are advertised with confirm gates matching the policy', () => {
  for (const name of ['set_project_lifecycle', 'set_project_pinned', 'get_host_usage', 'reclaim_report']) {
    assert.ok(byName.has(name), `${name} missing from MCP_TOOLS`);
    assert.ok(POLICY.tools[name], `${name} missing from the policy allowlist`);
  }
  assert.deepEqual(byName.get('set_project_lifecycle').inputSchema.required, ['project_id', 'action', 'confirm']);
  assert.deepEqual(byName.get('set_project_pinned').inputSchema.required, ['project_id', 'pinned', 'confirm']);
  assert.equal(byName.get('get_host_usage').inputSchema.required, undefined);
  assert.equal(POLICY.tools.get_host_usage.gate, 'none');
  assert.equal(POLICY.tools.set_project_lifecycle.gate, 'confirm');
  // No bulk verb, by design.
  assert.ok(!byName.has('archive_all_projects'));
  assert.ok(POLICY.explicitly_absent.archive_all_unpinned);
  // list_projects grew the two filters; get_project stays id-only.
  assert.deepEqual(Object.keys(byName.get('list_projects').inputSchema.properties).sort(), ['lifecycle', 'pinned']);
  assert.match(MCP_SERVER_INSTRUCTIONS, /get_host_usage/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /lifecycle: "active", pinned: false/);
});

/* ---------------------------- list filters ----------------------------- */

const ROWS = [
  { id: 1, name: 'RecapShare', lifecycle: 'active', pinned: true },
  { id: 2, name: 'notes', lifecycle: 'active', pinned: true },
  { id: 3, name: 'scratch', lifecycle: 'active', pinned: false },
  { id: 4, name: 'old-thing', lifecycle: 'archived', pinned: false },
  { id: 5, name: 'idle', lifecycle: 'stopped', pinned: false },
];

test('list_projects filters: no filter is the current behaviour', () => {
  assert.deepEqual(normalizeProjectFilters({}), { lifecycle: 'all', pinned: null });
  assert.deepEqual(normalizeProjectFilters(), { lifecycle: 'all', pinned: null });
  assert.equal(filterProjectSummaries(ROWS, normalizeProjectFilters({})).length, ROWS.length);
});

test('list_projects filters: lifecycle + pinned combine, and the archive candidates exclude pinned projects', () => {
  const f = normalizeProjectFilters({ lifecycle: 'active', pinned: false });
  assert.deepEqual(filterProjectSummaries(ROWS, f).map((r) => r.name), ['scratch']);
  assert.deepEqual(filterProjectSummaries(ROWS, normalizeProjectFilters({ lifecycle: 'archived' })).map((r) => r.id), [4]);
  assert.deepEqual(filterProjectSummaries(ROWS, normalizeProjectFilters({ pinned: true })).map((r) => r.id), [1, 2]);
  assert.deepEqual(filterProjectSummaries(ROWS, normalizeProjectFilters({ lifecycle: 'stopped' })).map((r) => r.id), [5]);
  assert.deepEqual(filterProjectSummaries(ROWS, normalizeProjectFilters({ lifecycle: 'ALL ' })).length, 5);
});

test('list_projects filters: bad values are refused, not ignored', () => {
  assert.match(normalizeProjectFilters({ lifecycle: 'running' }).error, /lifecycle must be one of/);
  assert.match(normalizeProjectFilters({ pinned: 'yes' }).error, /pinned must be a boolean/);
});

test('containerStatusWord collapses Incus states to running | stopped | none', () => {
  assert.equal(containerStatusWord('Running'), 'running');
  assert.equal(containerStatusWord('Stopped'), 'stopped');
  assert.equal(containerStatusWord('Frozen'), 'stopped');
  assert.equal(containerStatusWord(null), 'none');
  assert.equal(containerStatusWord(''), 'none');
});

/* ------------------------------ refusals ------------------------------- */

const P = { id: 45, name: 'scratch', lifecycle: 'active' };

test('archive refuses a pinned project, naming it, and points at the unpin path', () => {
  const why = lifecycleRefusal({ project: P, action: 'archive', pinned: true }, POLICY);
  assert.match(why, /scratch \(project 45\) is pinned/);
  assert.match(why, /unpin it in the UI/);
  assert.match(why, /never archived silently/);
});

test('archive refuses with a running or queued build and names the stop tool', () => {
  const running = lifecycleRefusal({ project: P, action: 'archive', latestCycle: { id: 9, status: 'running' } }, POLICY);
  assert.match(running, /A build is running/);
  assert.match(running, /interrupt_project_build \(cycle 9\)/);
  const queuedCycle = lifecycleRefusal({ project: P, action: 'archive', latestCycle: { id: 10, status: 'queued' } }, POLICY);
  assert.match(queuedCycle, /interrupt_project_build/);
  const queued = lifecycleRefusal({ project: P, action: 'archive', latestCycle: { id: 8, status: 'succeeded' }, queuedBuilds: 2 }, POLICY);
  assert.match(queued, /2 build\(s\) are queued/);
  assert.match(queued, /cancel_queued_build/);
  // A finished cycle is not a live one.
  assert.equal(lifecycleRefusal({ project: P, action: 'archive', latestCycle: { id: 8, status: 'succeeded' } }, POLICY), null);
});

test('the transition table comes from the policy file', () => {
  assert.match(lifecycleRefusal({ project: { ...P, lifecycle: 'archived' }, action: 'archive' }, POLICY), /already archived/);
  assert.match(lifecycleRefusal({ project: { ...P, lifecycle: 'provisioning' }, action: 'archive' }, POLICY), /Cannot archive .* while it is provisioning/);
  assert.equal(lifecycleRefusal({ project: { ...P, lifecycle: 'stopped' }, action: 'archive' }, POLICY), null);
  assert.match(lifecycleRefusal({ project: P, action: 'unarchive' }, POLICY), /not archived/);
  assert.match(lifecycleRefusal({ project: { ...P, lifecycle: 'archived' }, action: 'unarchive', containerStatus: 'none' }, POLICY), /archived from the UI/);
  assert.equal(lifecycleRefusal({ project: { ...P, lifecycle: 'archived' }, action: 'unarchive', containerStatus: 'stopped' }, POLICY), null);
  assert.match(lifecycleRefusal({ project: P, action: 'delete' }, POLICY), /action must be/);
  assert.equal(lifecycleRefusal({ project: null, action: 'archive' }, POLICY), 'Project not found');
});

test('parseArchiveState tolerates garbage', () => {
  assert.equal(parseArchiveState(null), null);
  assert.equal(parseArchiveState('nope'), null);
  assert.equal(parseArchiveState('[1]')?.previous_lifecycle, undefined);
  assert.deepEqual(parseArchiveState('{"snapshot":"s"}'), { snapshot: 's' });
});

/* --------------------------- fake Incus host --------------------------- */

// A guest with a status, a config map and a snapshot list, plus a project
// row store — enough to prove the archive → unarchive round trip restores
// lifecycle, boot.autostart and container status.
function fakeHost({ status = 'Running', autostart = 'true', project } = {}) {
  const guest = { status, config: autostart == null ? {} : { 'boot.autostart': autostart }, snapshots: [] };
  const rows = new Map([[project.id, { ...project }]]);
  const calls = [];
  const deps = {
    incus: async (argv) => {
      calls.push(argv.join(' '));
      const [verb, sub, name, kv] = argv;
      if (verb === 'config' && sub === 'get') return { status: 0, stdout: `${guest.config[argv[3]] ?? ''}\n`, stderr: '' };
      if (verb === 'config' && sub === 'set') {
        const [k, v] = String(kv).split('=');
        guest.config[k] = v;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (verb === 'config' && sub === 'unset') { delete guest.config[argv[3]]; return { status: 0, stdout: '', stderr: '' }; }
      if (verb === 'stop') { guest.status = 'Stopped'; return { status: 0, stdout: '', stderr: '' }; }
      if (verb === 'start') { guest.status = 'Running'; return { status: 0, stdout: '', stderr: '' }; }
      return { status: 1, stdout: '', stderr: `unknown ${verb}` };
    },
    snapshot: async (_name, snapName) => { guest.snapshots.push(snapName); return { name: snapName }; },
    checkpoint: async () => ({ ok: true, detail: 'pushed' }),
    containerStatus: async () => guest.status,
    waitForIp: async () => '10.99.0.5',
    updateProject: (id, patch) => { rows.set(id, { ...rows.get(id), ...patch }); return rows.get(id); },
    now: () => '2026-09-02T10:00:00.000Z',
  };
  return { guest, rows, calls, deps, row: () => rows.get(project.id) };
}

test('archive → unarchive round-trip restores lifecycle, boot.autostart and container status', async () => {
  const project = { id: 45, name: 'scratch', lifecycle: 'active', container_name: 'm2-45', container_ip: '10.99.0.5' };
  const h = fakeHost({ status: 'Running', autostart: 'true', project });

  const a = await archiveProject({ project, pinned: false, latestCycle: null, queuedBuilds: 0, policy: POLICY, containerName: 'm2-45', deps: h.deps });
  assert.equal(a.error, undefined, a.error);
  assert.equal(a.lifecycle, 'archived');
  assert.equal(a.previous_lifecycle, 'active');
  assert.equal(a.container, 'm2-45');
  assert.equal(a.container_status, 'stopped');
  assert.equal(a.container_stopped, true);
  assert.match(a.snapshot, /^pp-mcp-pre-archive-20260902-100000$/);
  assert.equal(a.previous_autostart, 'true');
  assert.equal(a.autostart, 'false');
  assert.match(a.change_summary, /archived via MCP; container stopped; snapshot pp-mcp-pre-archive/);
  // Host state after archive.
  assert.equal(h.guest.status, 'Stopped');
  assert.equal(h.guest.config['boot.autostart'], 'false');
  assert.deepEqual(h.guest.snapshots, [a.snapshot]);
  // Row after archive: lifecycle flipped, state recorded, nothing else lost.
  const archived = h.row();
  assert.equal(archived.lifecycle, 'archived');
  assert.equal(archived.archived_at, '2026-09-02T10:00:00.000Z');
  assert.equal(archived.container_name, 'm2-45');
  assert.equal(archived.container_ip, null);
  const state = parseArchiveState(archived.archive_state_json);
  assert.equal(state.previous_autostart, 'true');
  assert.equal(state.stopped_container, true);
  assert.equal(state.previous_lifecycle, 'active');
  // Order: checkpoint/snapshot happened before the stop, autostart after.
  const stopIdx = h.calls.indexOf('stop m2-45');
  const setIdx = h.calls.findIndex((c) => c.startsWith('config set m2-45 boot.autostart=false'));
  assert.ok(stopIdx > -1 && setIdx > stopIdx);

  const u = await unarchiveProject({ project: archived, policy: POLICY, containerName: 'm2-45', deps: h.deps });
  assert.equal(u.error, undefined, u.error);
  assert.equal(u.lifecycle, 'active');
  assert.equal(u.previous_lifecycle, 'archived');
  assert.equal(u.container_status, 'running');
  assert.equal(u.container_started, true);
  assert.equal(u.autostart, 'true');
  assert.equal(u.snapshot, a.snapshot);
  assert.equal(h.guest.status, 'Running');
  assert.equal(h.guest.config['boot.autostart'], 'true');
  const back = h.row();
  assert.equal(back.lifecycle, 'active');
  assert.equal(back.archived_at, null);
  assert.equal(back.archive_state_json, null);
  assert.equal(back.container_ip, '10.99.0.5');
  assert.equal(back.container_name, 'm2-45');
});

test('archive with stop_container:false leaves the guest running but still forces autostart off; unarchive does not start it', async () => {
  const project = { id: 46, name: 'keepwarm', lifecycle: 'active', container_name: 'm2-46' };
  const h = fakeHost({ status: 'Running', autostart: null, project });
  const a = await archiveProject({ project, pinned: false, stopContainer: false, policy: POLICY, containerName: 'm2-46', deps: h.deps });
  assert.equal(a.error, undefined, a.error);
  assert.equal(a.container_status, 'running');
  assert.equal(a.container_stopped, false);
  assert.equal(a.previous_autostart, '');
  assert.equal(h.guest.config['boot.autostart'], 'false');
  assert.ok(!h.calls.includes('stop m2-46'));

  const u = await unarchiveProject({ project: h.row(), policy: POLICY, containerName: 'm2-46', deps: h.deps });
  assert.equal(u.error, undefined, u.error);
  assert.equal(u.container_started, false);
  assert.equal(u.lifecycle, 'active');
  // Previously unset → unset again, not "true".
  assert.equal(u.autostart, null);
  assert.equal(h.guest.config['boot.autostart'], undefined);
  assert.ok(h.calls.includes('config unset m2-46 boot.autostart'));
});

test('an idle-stopped project archived over MCP goes back to stopped, not active', async () => {
  const project = { id: 47, name: 'idle', lifecycle: 'stopped', container_name: 'm2-47' };
  const h = fakeHost({ status: 'Stopped', autostart: 'true', project });
  const a = await archiveProject({ project, pinned: false, policy: POLICY, containerName: 'm2-47', deps: h.deps });
  assert.equal(a.error, undefined, a.error);
  assert.equal(a.previous_lifecycle, 'stopped');
  assert.equal(a.container_stopped, false);
  assert.equal(a.checkpoint, null, 'no checkpoint into a stopped guest');
  const u = await unarchiveProject({ project: h.row(), policy: POLICY, containerName: 'm2-47', deps: h.deps });
  assert.equal(u.error, undefined, u.error);
  assert.equal(u.lifecycle, 'stopped');
  assert.equal(u.container_status, 'stopped');
  assert.equal(h.guest.config['boot.autostart'], 'true');
});

test('archiveProject refuses pinned / live-build projects without touching the host', async () => {
  const project = { id: 48, name: 'RecapShare', lifecycle: 'active', container_name: 'm2-48' };
  const h = fakeHost({ project });
  const pinned = await archiveProject({ project, pinned: true, policy: POLICY, containerName: 'm2-48', deps: h.deps });
  assert.match(pinned.error, /RecapShare \(project 48\) is pinned/);
  const live = await archiveProject({ project, pinned: false, latestCycle: { id: 3, status: 'running' }, policy: POLICY, containerName: 'm2-48', deps: h.deps });
  assert.match(live.error, /A build is running/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.guest.snapshots, []);
  assert.equal(h.row().lifecycle, 'active');
});

test('archive refuses without a snapshot and leaves the guest as found', async () => {
  const project = { id: 49, name: 'nosnap', lifecycle: 'active', container_name: 'm2-49' };
  const h = fakeHost({ project });
  h.deps.snapshot = async () => ({ error: 'pool full' });
  const r = await archiveProject({ project, pinned: false, policy: POLICY, containerName: 'm2-49', deps: h.deps });
  assert.match(r.error, /Refusing to archive without a snapshot: pool full/);
  assert.equal(h.guest.status, 'Running');
  assert.equal(h.guest.config['boot.autostart'], 'true');
  assert.equal(h.row().lifecycle, 'active');
});

test('a stop that fails archives nothing; an autostart write that fails restarts the guest', async () => {
  const project = { id: 50, name: 'stubborn', lifecycle: 'active', container_name: 'm2-50' };
  const h = fakeHost({ project });
  const realIncus = h.deps.incus;
  h.deps.incus = async (argv, o) => (argv[0] === 'stop' ? { status: 1, stdout: '', stderr: 'Error: shutdown hung', timedOut: false } : realIncus(argv, o));
  const r = await archiveProject({ project, pinned: false, policy: POLICY, containerName: 'm2-50', deps: h.deps });
  assert.match(r.error, /Could not stop m2-50: Error: shutdown hung/);
  assert.match(r.error, /snapshot pp-mcp-pre-archive/);
  assert.equal(h.row().lifecycle, 'active');
  assert.equal(h.guest.config['boot.autostart'], 'true');

  const h2 = fakeHost({ project });
  const real2 = h2.deps.incus;
  h2.deps.incus = async (argv, o) => (argv[0] === 'config' && argv[1] === 'set' ? { status: 1, stdout: '', stderr: 'nope' } : real2(argv, o));
  const r2 = await archiveProject({ project, pinned: false, policy: POLICY, containerName: 'm2-50', deps: h2.deps });
  assert.match(r2.error, /Could not set boot.autostart=false/);
  assert.equal(h2.guest.status, 'Running', 'the stop was undone');
  assert.equal(h2.row().lifecycle, 'active');
});

test('unarchive of a UI-archived project (guest destroyed) is refused and points at Rehydrate', async () => {
  const project = { id: 51, name: 'gone', lifecycle: 'archived', container_name: null, archive_state_json: null };
  const h = fakeHost({ status: null, project });
  h.deps.containerStatus = async () => null;
  const r = await unarchiveProject({ project, policy: POLICY, containerName: 'm2-51', deps: { ...h.deps, containerStatus: async () => 'none' } });
  assert.match(r.error, /archived from the UI/);
  assert.match(r.error, /rehydrate it from the UI/);
});

test('an unreachable incus is an error, never "the guest is gone"', async () => {
  const project = { id: 53, name: 'blind', lifecycle: 'active', container_name: 'm2-53' };
  const h = fakeHost({ project });
  h.deps.containerStatus = async () => null;
  const a = await archiveProject({ project, pinned: false, policy: POLICY, containerName: 'm2-53', deps: h.deps });
  assert.match(a.error, /Could not query incus for m2-53/);
  assert.equal(h.row().lifecycle, 'active');
  const u = await unarchiveProject({ project: { ...project, lifecycle: 'archived' }, policy: POLICY, containerName: 'm2-53', deps: h.deps });
  assert.match(u.error, /Could not query incus/);
  assert.doesNotMatch(u.error, /archived from the UI/);
});

test('archiving a project with no guest on the host records the lifecycle only', async () => {
  const project = { id: 52, name: 'ghost', lifecycle: 'active', container_name: 'm2-52' };
  const h = fakeHost({ project });
  h.deps.containerStatus = async () => 'none';
  const a = await archiveProject({ project, pinned: false, policy: POLICY, containerName: 'm2-52', deps: h.deps });
  assert.equal(a.error, undefined, a.error);
  assert.equal(a.container, null);
  assert.equal(a.container_status, 'none');
  assert.equal(a.snapshot, null);
  assert.deepEqual(h.calls, []);
  assert.equal(h.row().lifecycle, 'archived');
});

/* ----------------------------- host usage ------------------------------ */

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1024000 kB
MemAvailable:    8192000 kB
Buffers:          204800 kB
Cached:          3072000 kB
SwapTotal:       4194304 kB
SwapFree:        4194304 kB
`;

const INCUS_LIST = [
  { name: 'm2-45', status: 'Running', state: { memory: { usage: 512 * 1024 * 1024 }, cpu: { usage: 42e9 }, disk: { root: { usage: 3 * 1024 ** 3 } } } },
  { name: 'm2-46', status: 'Running', state: { memory: { usage: 2048 * 1024 * 1024 }, cpu: { usage: 9e9 } } },
  { name: 'pp-mailcow', status: 'Stopped', state: { memory: { usage: 0 } } },
  { name: 'm2-46', status: 'Running', state: { memory: { usage: 1 } } },   // --all-projects repeat
];

test('host usage parsers read the host files, not guesses', () => {
  assert.deepEqual(parseProcLoadavg('0.52 0.61 0.70 2/512 12345\n'), { load_1m: 0.52, load_5m: 0.61, load_15m: 0.7 });
  assert.deepEqual(parseProcLoadavg(''), { load_1m: null, load_5m: null, load_15m: null });
  const m = parseProcMeminfo(MEMINFO);
  assert.deepEqual(m.memory, { total_mb: 16000, used_mb: 8000, available_mb: 8000, percent_used: 50 });
  assert.deepEqual(m.swap, { total_mb: 4096, used_mb: 0 });
  const d = parseDfOutput('Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/vda1        104857600  52428800  52428800      50% /\n');
  assert.deepEqual(d, { mount: '/', filesystem: '/dev/vda1', total_gb: 100, used_gb: 50, available_gb: 50, percent_used: 50 });
  assert.equal(parseDfOutput('garbage'), null);
  assert.deepEqual(parsePoolResources('{"space":{"total":214748364800,"used":4681064448}}'), { total_gb: 200, used_gb: 4.36 });
  assert.equal(parsePoolResources('not json'), null);
  assert.deepEqual(parseStorageInfoText('info:\n  driver: dir\n  name: default\n  space used: 4681064448B\n  total space: 214748364800B\n'), { total_gb: 200, used_gb: 4.36 });
  assert.deepEqual(parseStorageInfoText('info:\n  space used: 4.36GiB\n  total space: 200.00GiB\n'), { total_gb: 200, used_gb: 4.36 });
  assert.equal(parseProfileRootPool('config: {}\ndevices:\n  eth0:\n    type: nic\n  root:\n    path: /\n    pool: fast\n    type: disk\nname: default\n'), 'fast');
  assert.deepEqual(pickStoragePool([{ name: 'default', driver: 'dir', config: { source: '/var/lib/incus/storage-pools/default' } }, { name: 'fast', driver: 'zfs' }], 'fast'), { name: 'fast', driver: 'zfs', source: null });
  assert.equal(pickStoragePool([{ name: 'a' }, { name: 'default' }]).name, 'default');
  assert.equal(pickStoragePool([]), null);
});

test('container usage: dedupes --all-projects repeats, ranks running guests by memory, caps at 10', () => {
  const row = containerUsageRow(INCUS_LIST[0]);
  assert.deepEqual(row, { name: 'm2-45', status: 'running', memory_mb: 512, cpu_seconds: 42, disk_gb: 3 });
  const s = summarizeContainers(INCUS_LIST);
  assert.equal(s.running, 2);
  assert.equal(s.stopped, 1);
  assert.equal(s.total, 3);
  assert.deepEqual(s.top_by_memory.map((r) => r.name), ['m2-46', 'm2-45']);
  const many = Array.from({ length: 15 }, (_, i) => ({ name: `g${i}`, status: 'Running', state: { memory: { usage: i * 1024 * 1024 } } }));
  assert.equal(summarizeContainers(many).top_by_memory.length, 10);
  assert.equal(summarizeContainers(many).top_by_memory[0].name, 'g14');
});

function usageFixture(overrides = {}) {
  return buildHostUsage({
    takenAt: '2026-09-02T10:00:00.000Z',
    cores: 8,
    loadavg: parseProcLoadavg('1.50 1.20 1.00 3/700 1'),
    meminfo: parseProcMeminfo(MEMINFO),
    disks: [parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 104857600 52428800 52428800 50% /\n')],
    pool: { name: 'default', total_gb: 200, used_gb: 4.36 },
    containers: summarizeContainers(INCUS_LIST),
    ...overrides,
  });
}

test('get_host_usage payload validates against the documented schema', () => {
  const u = usageFixture();
  assert.deepEqual(validateHostUsage(u), []);
  assert.equal(u.cpu.cores, 8);
  assert.equal(u.memory.used_mb, 8000);
  assert.equal(u.containers.running, 2);
  assert.equal(u.incus_pool.name, 'default');
  assert.equal('_rows' in u.containers, false, 'internal rows must not leak into the payload');
  assert.equal(u.per_project, undefined);

  const per = perProjectUsage(
    [{ id: 45, name: 'scratch', lifecycle: 'active', container_name: 'm2-45', pinned: false },
      { id: 99, name: 'archived-ui', lifecycle: 'archived', container_name: null, pinned: true }],
    summarizeContainers(INCUS_LIST)._rows,
  );
  assert.deepEqual(per[0], { project_id: 45, name: 'scratch', lifecycle: 'active', pinned: false, container: 'm2-45', container_status: 'running', memory_mb: 512, disk_gb: 3 });
  assert.equal(per[1].container_status, 'none');
  assert.equal(per[1].memory_mb, 0);
  assert.deepEqual(validateHostUsage(usageFixture({ perProject: per })), []);

  // Degraded hosts still produce a valid shape (nulls, never missing keys).
  const bare = buildHostUsage({ takenAt: '2026-09-02T10:00:00.000Z', cores: null, loadavg: null, meminfo: null, disks: [null], pool: null, containers: null });
  assert.deepEqual(validateHostUsage(bare), []);
  assert.equal(bare.incus_pool, null);
  assert.deepEqual(bare.disk, []);

  // And the validator actually rejects the wrong thing.
  assert.ok(validateHostUsage({}).length > 5);
  assert.match(validateHostUsage({ ...u, containers: { ...u.containers, top_by_memory: Array(11).fill({ name: 'x', memory_mb: 1 }) } }).join(';'), /at most 10/);
  assert.match(validateHostUsage({ ...u, incus_pool: undefined }).join(';'), /incus_pool must be present/);
});

test('reclaim_report delta is before − after, matched by mount, with a readable summary', () => {
  const before = usageFixture();
  const after = usageFixture({
    takenAt: '2026-09-02T10:05:00.000Z',
    loadavg: parseProcLoadavg('0.50 0.90 0.95 1/600 1'),
    meminfo: parseProcMeminfo(MEMINFO.replace('MemAvailable:    8192000 kB', 'MemAvailable:   10240000 kB')),
    containers: summarizeContainers(INCUS_LIST.filter((c) => c.name !== 'm2-46').concat([{ name: 'm2-46', status: 'Stopped', state: {} }])),
  });
  const d = reclaimDelta(before, after);
  assert.equal(d.memory_freed_mb, 2000);
  assert.equal(d.containers_stopped, 1);
  assert.deepEqual(d.load_delta, { load_1m: 1, load_5m: 0.3, load_15m: 0.05 });
  assert.equal(d.disk_freed_gb, 0);
  assert.equal(d.incus_pool_freed_gb, 0);
  assert.equal(d.before_taken_at, before.taken_at);
  assert.match(d.summary, /Memory in use fell by 2000 MB/);
  assert.match(d.summary, /1 container stopped running \(2 → 1 running of 3\)/);
  assert.match(d.summary, /1-minute load dropped by 1/);
  assert.match(d.summary, /frees no disk by design/);

  // Nothing reclaimed reads as such, and unmatched disks are null, not 0.
  const same = reclaimDelta(before, { ...before, disk: [{ mount: '/elsewhere', used_gb: 1 }] });
  assert.equal(same.memory_freed_mb, 0);
  assert.equal(same.disk_freed_gb, null);
  assert.match(same.summary, /did not change/);
  assert.match(same.summary, /no matching mounts/);
});
