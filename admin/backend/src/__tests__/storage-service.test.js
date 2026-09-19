// lib/storage/service.js through the MCP family (routes/mcp-tools/storage.js)
// and directly: the plan/confirm flow end to end against a scripted host —
// dry_run issues the plan + token, confirm without the token is refused, the
// token runs the exact argv with {{stamp}} substituted, a changed host state
// invalidates the token, the ledger and settings follow, secrets stay out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStorageService } from '../lib/storage/service.js';
import { createExtendedHandlers } from '../routes/mcp-tools/index.js';
import { createConfirmationStore } from '../lib/mcp-ext/logic.js';
import { MCP_TOOLS } from '../lib/mcp-logic.js';
import { fakeHost, fakeSettings, fx } from './fixtures/storage/load.js';
import { parseZfsList } from '../lib/storage/parse.js';

const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
const parse = (r) => JSON.parse(r.content[0].text);
const AUTH = { id: 7, created_by: 'admin-1' };
const SDC = '/dev/disk/by-id/wwn-0x5000c500c3333333';
const SDD = '/dev/disk/by-id/wwn-0x5000c500c4444444';

function fakeDb() {
  const ops = []; const ledger = [];
  return {
    ops, ledger,
    db: { prepare(sql) { return { run: (...a) => { if (/INSERT INTO storage_ops/.test(sql)) ops.push(a); if (/INSERT INTO mcp_ledger/.test(sql)) ledger.push(a); return { changes: 1 }; }, get: () => undefined, all: () => [] }; }, exec() {}, pragma() { return 1; } },
  };
}

function setup({ script, settings = {} } = {}) {
  const host = fakeHost({ script });
  const st = fakeSettings({ 'storage.managed': JSON.stringify({ pool: 'tank', incus_pool: 'zfs', datasets: { incus: 'tank/incus', backups: 'tank/backups', exports: 'tank/exports' } }), ...settings });
  const db = fakeDb();
  const audit = [];
  const svc = createStorageService({ host, getDb: () => db.db, getSetting: st.getSetting, setSetting: st.setSetting, logAudit: (...a) => audit.push(a), now: () => Date.parse('2026-09-19T10:00:00Z') });
  const confirmations = createConfirmationStore();
  const ctx = {
    getDb: () => db.db, logAudit: (...a) => audit.push(a), getSetting: st.getSetting, setSetting: st.setSetting, toolResult, uuidv4: () => 'u', policy: POLICY, confirmations,
    runHostCapture: async () => ({ status: 0, stdout: '', stderr: '' }), LXC_PREFIX: 'pp-', storage: () => svc,
  };
  const { handlers } = createExtendedHandlers(ctx);
  return { host, svc, st, db, audit, handlers, settings: st };
}

test('service: plan → token → apply runs the exact argv; missing / stale token refused; ledger and audit written', async () => {
  const { host, svc, db, audit } = setup();
  const p = await svc.plan('zfs_snapshot', { dataset: 'tank/exports', name: 'keep2' });
  assert.equal(p.plan.op, 'zfs_snapshot'); assert.match(p.plan_token, /^[0-9a-f]{64}$/); assert.deepEqual(p.commands, ['zfs snapshot tank/exports@keep2']);
  assert.equal(host.calls.length, 0);
  const noConfirm = await svc.apply('zfs_snapshot', { dataset: 'tank/exports', name: 'keep2' }, { plan_token: p.plan_token });
  assert.equal(noConfirm.refused, true);
  const noToken = await svc.apply('zfs_snapshot', { dataset: 'tank/exports', name: 'keep2' }, { confirm: true });
  assert.match(noToken.error, /missing or malformed/); assert.equal(db.ops.at(-1)[7], 'refused');
  const stale = await svc.apply('zfs_snapshot', { dataset: 'tank/exports', name: 'keep3' }, { confirm: true, plan_token: p.plan_token });
  assert.match(stale.error, /does not match the current plan/); assert.equal(stale.plan_token.length, 64);
  assert.equal(host.calls.length, 0);
  const ok = await svc.apply('zfs_snapshot', { dataset: 'tank/exports', name: 'keep2' }, { confirm: true, plan_token: p.plan_token, actor: 'admin-1', via: 'test' });
  assert.equal(ok.ok, true);
  assert.deepEqual(host.calls.map((c) => c.argv), [['zfs', 'snapshot', 'tank/exports@keep2']]);
  assert.equal(db.ops.at(-1)[3], 'zfs_snapshot'); assert.equal(db.ops.at(-1)[7], 'ok'); assert.equal(db.ops.at(-1)[5], p.plan_token);
  assert.equal(audit.at(-1)[1], 'STORAGE_ZFS_SNAPSHOT');
});

test('a missing binary refuses BEFORE the plan exists: create_zpool never wipes a disk it cannot then make a pool on', async () => {
  // The host has no ZFS yet. The old behaviour handed out a plan whose step 1
  // was `wipefs -a` and whose step 2 was `zpool create`: apply blanked the
  // disk and then failed. A missing tool is now a refusal.
  const { host, svc, db } = setup();
  host.hasBinary = async (bin) => bin !== 'zpool';
  const p = await svc.plan('create_zpool', { name: 'p1', devices: [SDC] });
  assert.equal(p.plan, undefined);
  assert.match(p.error, /zpool is not installed/);
  assert.match(p.error, /install-storage\.sh/);
  assert.match(p.error, /Nothing was touched/);
  assert.equal(host.calls.length, 0, 'not a single command ran');

  // apply re-plans, so it is refused on the same grounds and never wipes.
  const r = await svc.apply('create_zpool', { name: 'p1', devices: [SDC] }, { confirm: true, plan_token: 'a'.repeat(64) });
  assert.equal(r.refused, true);
  assert.match(r.error, /zpool is not installed/);
  assert.ok(!host.calls.some((c) => c.argv[0] === 'wipefs'), 'the disk was never wiped');
  assert.equal(db.ops.at(-1)[7], 'refused');

  // the zfs-only verbs are refused on their own binary, and incus verbs on theirs
  host.hasBinary = async (bin) => bin !== 'zfs';
  assert.match((await svc.plan('zfs_snapshot', { dataset: 'tank/exports' })).error, /zfs is not installed/);
  host.hasBinary = async (bin) => bin !== 'incus';
  assert.match((await svc.plan('move_guest_storage', { guests: ['pp-legacy'], pool: 'zfs', stop: true })).error, /incus is not installed/);
  // with everything present the plan is produced as before
  host.hasBinary = async () => true;
  assert.ok((await svc.plan('create_zpool', { name: 'p1', devices: [SDC] })).plan);
});

test('service: {{stamp}} is substituted at apply time, a failing step stops the plan and reports it, ignore_failure steps continue', async () => {
  const { host, svc } = setup({ script: (argv) => (argv[0] === 'zpool' && argv[1] === 'labelclear' ? { status: 1, stderr: 'no labels' } : argv[0] === 'wipefs' ? { status: 2, stderr: 'wipefs: sdd busy' } : null) });
  const p = await svc.plan('destroy_dataset', { dataset: 'tank/exports' });
  const r = await svc.apply('destroy_dataset', { dataset: 'tank/exports' }, { confirm: true, plan_token: p.plan_token });
  assert.equal(r.ok, true);
  assert.equal(r.stamp, '20260919T100000Z');
  assert.equal(host.calls[0].argv[3], 'tank/exports@pp-predestroy-20260919T100000Z');
  assert.equal(host.calls[1].argv[5], '/tank/backups/destroyed/tank_exports@pp-predestroy-20260919T100000Z.zfs');
  assert.deepEqual(host.calls[2].argv, ['zfs', 'destroy', '-r', 'tank/exports']);
  host.calls.length = 0;
  const w = await svc.plan('create_zpool', { name: 'p2', devices: [SDD], wipe: true, managed: false });
  const f = await svc.apply('create_zpool', { name: 'p2', devices: [SDD], wipe: true, managed: false }, { confirm: true, plan_token: w.plan_token });
  assert.equal(f.ok, false);
  assert.equal(f.failed.id, 's2'); assert.match(f.failed.error, /exit 2: wipefs: sdd busy/);
  assert.equal(host.calls.length, 2); // labelclear (ignored failure) + wipefs; zpool create never ran
  assert.ok(!host.calls.some((c) => c.argv[1] === 'create'));
});

test('service: encrypted pool takes the passphrase on stdin at apply only, never in the plan; managed setting recorded after create', async () => {
  const { host, svc, settings } = setup({ settings: { 'storage.managed': '' } });
  assert.equal(svc.managed(), null);
  const params = { name: 'vault', devices: [SDC], encryption: { keyformat: 'passphrase' } };
  const p = await svc.plan('create_zpool', params);
  assert.ok(!JSON.stringify(p).includes('correct horse'));
  const noPass = await svc.apply('create_zpool', params, { confirm: true, plan_token: p.plan_token });
  assert.equal(noPass.ok, false); assert.match(noPass.failed.error, /passphrase/);
  const r = await svc.apply('create_zpool', params, { confirm: true, plan_token: p.plan_token, secrets: { passphrase: 'correct horse battery' } });
  assert.equal(r.ok, true);
  const create = host.calls.find((c) => c.argv[1] === 'create');
  assert.equal(create.input, 'correct horse battery\n');
  assert.ok(!JSON.stringify(r.results).includes('correct horse'));
  assert.deepEqual(JSON.parse(settings.getSetting('storage.managed')), { pool: 'vault', incus_pool: null, datasets: { incus: 'vault/incus', backups: 'vault/backups', exports: 'vault/exports' } });
});

test('service: backup policy and replication plans write host files from the plan (token covers content) and store settings only on success', async () => {
  const { host, svc, settings } = setup();
  const p = await svc.plan('set_backup_policy', { class: 'guests', retention: { hourly: 48 } });
  assert.equal(p.plan.steps[0].stdin, 'content'); assert.match(p.plan.steps[0].content, /hourly = 48/);
  assert.deepEqual(p.plan.steps[1].argv, ['systemctl', 'enable', '--now', 'sanoid.timer']);
  const r = await svc.apply('set_backup_policy', { class: 'guests', retention: { hourly: 48 } }, { confirm: true, plan_token: p.plan_token });
  assert.equal(r.ok, true);
  assert.equal(host.calls[0].argv[4], '/etc/sanoid/sanoid.conf'); assert.match(host.calls[0].input, /\[tank\/incus\]/);
  assert.equal(JSON.parse(settings.getSetting('storage.backup_policy')).classes.guests.hourly, 48);
  const view = svc.policyView(await svc.inventory());
  assert.equal(view.datasets.find((d) => d.dataset === 'tank/incus/containers/pp-web').retention.hourly, 48);
  // replication
  const rp = await svc.plan('set_replication_target', { name: 'offsite', sources: ['tank/incus'], target: 'backup@nas:tank/pp', ssh_key_path: '/root/.ssh/pp_repl', schedule: 'daily' });
  assert.equal(rp.plan.steps[0].argv[4], '/etc/proxypilot/storage/replication-offsite.conf');
  assert.match(rp.plan.steps[0].content, /PP_REPL_SSH_KEY='\/root\/.ssh\/pp_repl'/);
  assert.deepEqual(rp.plan.steps[3].argv, ['systemctl', 'enable', '--now', 'proxypilot-syncoid@offsite.timer']);
  const rr = await svc.apply('set_replication_target', { name: 'offsite', sources: ['tank/incus'], target: 'backup@nas:tank/pp', ssh_key_path: '/root/.ssh/pp_repl', schedule: 'daily' }, { confirm: true, plan_token: rp.plan_token });
  assert.equal(rr.ok, true);
  const stored = JSON.parse(settings.getSetting('storage.replication'));
  assert.deepEqual(Object.keys(stored.offsite).sort(), ['enabled', 'kind', 'name', 'recursive', 'schedule', 'sources', 'target']);
  assert.ok(!JSON.stringify(stored).includes('pp_repl'));
  const run = await svc.plan('run_replication', { name: 'offsite' });
  assert.deepEqual(run.plan.steps[0].argv, ['/usr/local/sbin/proxypilot-storage-replicate', 'offsite']);
  const bg = await svc.plan('run_replication', { name: 'offsite', wait: false });
  assert.deepEqual(bg.plan.steps[0].argv, ['systemctl', 'start', '--no-block', 'proxypilot-syncoid@offsite.service']);
  const rm = await svc.plan('set_replication_target', { name: 'offsite', remove: true });
  assert.equal(rm.plan.steps[1].argv[0], 'rm');
  await svc.apply('set_replication_target', { name: 'offsite', remove: true }, { confirm: true, plan_token: rm.plan_token });
  assert.deepEqual(JSON.parse(settings.getSetting('storage.replication')), {});
  assert.match((await svc.plan('run_replication', { name: 'offsite' })).error, /no replication job/);
});

test('MCP: dry_run issues the plan + token (ledger dry_run), confirm without token refused, token applies (ledger ok, confirmation_used), passphrase redacted, OS device refused, flags gate', async () => {
  const { handlers, db, host, settings } = setup();
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
  for (const n of ['create_zpool', 'destroy_dataset', 'restore_guest_from_snapshot', 'rollback_guest_dataset', 'set_backup_policy']) {
    assert.ok(byName.get(n).inputSchema.properties.plan_token && byName.get(n).inputSchema.properties.confirm && byName.get(n).inputSchema.properties.dry_run, n);
    assert.ok(!byName.get(n).inputSchema.properties.confirmation_token, n);
  }
  const disks = parse(await handlers.list_disks({}, AUTH));
  assert.equal(disks.devices.find((d) => d.name === 'nvme0n1').os, true);
  assert.equal(disks.devices.find((d) => d.name === 'nvme0n1').eligibility_with_wipe, false);
  assert.equal(disks.devices.find((d) => d.name === 'sdc').eligibility.eligible, true);
  const os = await handlers.create_zpool({ name: 'p1', devices: ['/dev/disk/by-id/nvme-Samsung_SSD_980_PRO_512GB_S5GXNX0R123456'], dry_run: true }, AUTH);
  assert.equal(os.isError, true); assert.match(os.content[0].text, /OS device/);
  assert.equal(db.ledger.at(-1)[8], 'refused');
  const dry = parse(await handlers.create_zpool({ name: 'p1', devices: [SDC], dry_run: true }, AUTH));
  assert.equal(dry.dry_run, true); assert.match(dry.plan_token, /^[0-9a-f]{64}$/); assert.equal(dry.commands.length, 5);
  assert.equal(db.ledger.at(-1)[8], 'dry_run'); assert.equal(host.calls.length, 0);
  const bare = await handlers.create_zpool({ name: 'p1', devices: [SDC], confirm: true }, AUTH);
  assert.equal(bare.isError, true); assert.match(bare.content[0].text, /missing or malformed/);
  const wrong = await handlers.create_zpool({ name: 'p1', devices: [SDC], confirm: true, plan_token: 'a'.repeat(64) }, AUTH);
  assert.equal(wrong.isError, true); assert.match(wrong.content[0].text, /does not match/); assert.equal(host.calls.length, 0);
  const done = parse(await handlers.create_zpool({ name: 'p1', devices: [SDC], confirm: true, plan_token: dry.plan_token }, AUTH));
  assert.equal(done.applied, true); assert.equal(done.results.length, 5);
  assert.deepEqual(host.calls[0].argv.slice(0, 2), ['zpool', 'create']);
  const row = db.ledger.at(-1);
  assert.equal(row[8], 'ok'); assert.equal(row[10], 1); // confirmation_used
  assert.equal(JSON.parse(row[7]).plan_token, dry.plan_token);
  // passphrase never reaches the ledger
  const enc = parse(await handlers.create_zpool({ name: 'p9', devices: [SDC], encryption: { keyformat: 'passphrase' }, dry_run: true }, AUTH));
  await handlers.create_zpool({ name: 'p9', devices: [SDC], encryption: { keyformat: 'passphrase' }, confirm: true, plan_token: enc.plan_token, passphrase: 'correct horse battery' }, AUTH);
  assert.ok(!db.ledger.some((r) => String(r[7]).includes('correct horse')));
  assert.match(String(db.ledger.at(-1)[7]), /redacted/);
  // flags: mcp.storage off refuses the writes but not the readers; destroy verbs also sit behind mcp.destructive
  settings.setSetting('feature_flag:mcp.storage', '0');
  const off = await handlers.zfs_snapshot({ dataset: 'tank/exports', dry_run: true }, AUTH);
  assert.equal(off.isError, true); assert.match(off.content[0].text, /mcp.storage/);
  assert.equal(parse(await handlers.zpool_status({}, AUTH)).count, 2);
  settings.setSetting('feature_flag:mcp.storage', '1');
  settings.setSetting('feature_flag:mcp.destructive', '0');
  const destroy = await handlers.destroy_dataset({ dataset: 'tank/exports', dry_run: true }, AUTH);
  assert.match(destroy.content[0].text, /mcp.destructive/);
  assert.ok(!(await handlers.zfs_snapshot({ dataset: 'tank/exports', dry_run: true }, AUTH)).isError);
});

test('MCP readers: zpool_status, zfs_list filters, list_zfs_snapshots by guest/kind, freshness, policy, toolchain', async () => {
  const { handlers } = setup();
  const st = parse(await handlers.zpool_status({}, AUTH));
  assert.equal(st.pools[1].status.state, 'DEGRADED'); assert.equal(st.importable[0].name, 'oldpool'); assert.equal(st.managed.pool, 'tank');
  assert.equal(parse(await handlers.zfs_list({ dataset: 'tank/incus' }, AUTH)).count, 4);
  const snaps = parse(await handlers.list_zfs_snapshots({ guest: 'pp-web', kind: 'sanoid' }, AUTH));
  assert.equal(snaps.count, 3);
  assert.match(parse(await handlers.list_zfs_snapshots({ guest: 'pp-legacy' }, AUTH)).note, /not on a managed ZFS pool/);
  assert.equal((await handlers.list_zfs_snapshots({ guest: 'ghost' }, AUTH)).isError, true);
  const fr = parse(await handlers.storage_freshness({ alerts: true }, AUTH));
  assert.ok(fr.pools.length === 2 && Array.isArray(fr.alerts) && fr.guests.length === 3);
  assert.ok(fr.alerts.some((a) => a.key === 'storage:pool-health:data'));
  const pol = parse(await handlers.get_backup_policy({}, AUTH));
  assert.equal(pol.policy.classes.guests.daily, 14); assert.match(pol.rendered, /\[tank\/incus\]/);
  const tc = parse(await handlers.storage_toolchain({}, AUTH));
  assert.equal(tc.toolchain.zfs, true);
  const repl = parse(await handlers.replication_status({}, AUTH));
  assert.equal(repl.count, 0);
  const move = parse(await handlers.move_guest_storage({ guests: ['pp-legacy'], pool: 'zfs', stop: true, dry_run: true }, AUTH));
  assert.equal(move.commands[2], 'incus move pp-legacy --storage zfs');
  const incus = parse(await handlers.set_incus_storage_pool({ dry_run: true }, AUTH));
  assert.equal(incus.plan.subject, 'zfs'); assert.equal(incus.plan.existing_pools.length, 2);
  assert.equal(parseZfsList(fx('zfs-list.txt')).length, 9);
});
