// Loop-device integration test for the whole ZFS storage cycle — real zpool /
// zfs / sanoid / syncoid commands against 4 × 512 MB loop devices, so it runs
// in CI (.github/workflows/storage-integration.yml) and in a dev VM with no
// real disks. It never touches a real device: every command goes through the
// same service the dashboard and MCP use, and the planner only ever sees the
// by-id links this test creates for its loop devices.
//
// Skipped unless: PROXYPILOT_STORAGE_INTEGRATION=1, running as root, and
// zpool + zfs + losetup are installed with the zfs module loadable. The
// syncoid / sanoid parts skip individually when those binaries are absent.
//
//   sudo env PROXYPILOT_STORAGE_INTEGRATION=1 node --test src/__tests__/storage-loop.integration.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENABLED = process.env.PROXYPILOT_STORAGE_INTEGRATION === '1';
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', ...opts });
const have = (bin) => run('sh', ['-c', `command -v ${bin}`]).status === 0;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const prereq = ENABLED && isRoot && have('zpool') && have('zfs') && have('losetup') && (existsSync('/sys/module/zfs') || run('modprobe', ['zfs']).status === 0);
const skipReason = !ENABLED ? 'set PROXYPILOT_STORAGE_INTEGRATION=1 to run' : !isRoot ? 'needs root' : 'needs zpool/zfs/losetup and the zfs kernel module';

const POOL = `pptest${process.pid % 1000}`;
const POOL2 = `${POOL}b`;
const REPL = 'looptest';
// `ids` are the whole-disk by-id links the planner accepts; `links` is every
// symlink the test made (whole-disk AND -partN), for cleanup only. Keeping the
// two apart matters: a -partN path must stay refused as "not a whole disk".
const state = { dir: null, loops: [], links: [], ids: [], unitsInstalled: [], svc: null, settings: null };
const REPO = new URL('../../../../', import.meta.url).pathname;

function cleanup() {
  const q = (bin, args) => run(bin, args);
  q('zpool', ['destroy', '-f', POOL2]); q('zpool', ['destroy', '-f', POOL]);
  q('systemctl', ['disable', '--now', `proxypilot-syncoid@${REPL}.timer`]);
  for (const l of state.links) { try { rmSync(l); } catch { /* */ } }
  for (const d of state.loops) q('losetup', ['-d', d]);
  for (const u of state.unitsInstalled) { try { rmSync(u, { recursive: true, force: true }); } catch { /* */ } }
  q('systemctl', ['daemon-reload']);
  if (state.dir) rmSync(state.dir, { recursive: true, force: true });
}

test('ZFS storage cycle on loop devices: create → snapshot → rollback → policy → replicate → destroy/stream → scrub → export/import', { skip: prereq ? false : skipReason, timeout: 20 * 60 * 1000 }, async (t) => {
  process.env.PROXYPILOT_STORAGE_INCLUDE_LOOP = '1';
  state.dir = mkdtempSync(join(tmpdir(), 'pp-storage-'));
  process.env.PROXYPILOT_STORAGE_CONF_DIR = join(state.dir, 'conf');
  process.env.PROXYPILOT_STORAGE_STATE_DIR = join(state.dir, 'state');
  process.env.PROXYPILOT_SANOID_CONF = join(state.dir, 'sanoid.conf');
  process.env.PROXYPILOT_STORAGE_REPLICATE_BIN = join(state.dir, 'replicate.sh');
  copyFileSync(join(REPO, 'scripts/storage-replicate.sh'), process.env.PROXYPILOT_STORAGE_REPLICATE_BIN); chmodSync(process.env.PROXYPILOT_STORAGE_REPLICATE_BIN, 0o755);
  t.after(cleanup);

  // 4 × 512 MB backing files → loop devices → by-id links the planner accepts.
  mkdirSync('/dev/disk/by-id', { recursive: true });
  for (let i = 0; i < 4; i += 1) {
    const f = join(state.dir, `disk${i}.img`);
    assert.equal(run('truncate', ['-s', '512M', f]).status, 0);
    // -P: partition scanning, because ZFS partitions a whole disk it is given
    // (GPT with -part1 + a small -part9) and then waits for <path>-part1 to
    // appear. udev writes no by-id links for loop devices, so the test
    // pre-creates the whole-disk link and a (briefly dangling) -part1 link.
    const lo = run('losetup', ['-P', '--find', '--show', f]);
    assert.equal(lo.status, 0, lo.stderr);
    const dev = lo.stdout.trim();
    state.loops.push(dev);
    const link = `/dev/disk/by-id/pp-test-loop-${POOL}-${i}`;
    symlinkSync(dev, link); state.links.push(link); state.ids.push(link);
    for (const n of [1, 9]) { symlinkSync(`${dev}p${n}`, `${link}-part${n}`); state.links.push(`${link}-part${n}`); }
  }
  const ids = state.ids;
  assert.equal(ids.length, 4, 'four whole-disk by-id links');

  const { createStorageHost } = await import('../lib/storage/host.js');
  const { createStorageService } = await import('../lib/storage/service.js');
  const { runHostCapture } = await import('../lib/lxc-zip.js');
  const { fakeSettings } = await import('./fixtures/storage/load.js');
  state.settings = fakeSettings();
  const svc = createStorageService({ host: createStorageHost({ runHostCapture, useAgent: false }), getSetting: state.settings.getSetting, setSetting: state.settings.setSetting });
  const applyOk = async (op, params, extra = {}) => {
    const p = await svc.plan(op, params);
    assert.ok(p.plan, `${op}: ${p.error}`);
    const r = await svc.apply(op, params, { confirm: true, plan_token: p.plan_token, actor: 'test', via: 'integration', ...extra });
    assert.equal(r.ok, true, `${op} failed: ${JSON.stringify(r.failed)}\n${JSON.stringify(r.results, null, 1)}`);
    return r;
  };

  await t.test('inventory sees the loop devices as blank, eligible, non-OS disks', async () => {
    const inv = await svc.inventory({ smart: false, incus: false });
    const loops = inv.devices.filter((d) => state.loops.includes(d.path));
    assert.equal(loops.length, 4);
    for (const d of loops) { assert.equal(d.os, false); assert.equal(d.size_bytes, 512 * 1024 * 1024); assert.ok(d.by_id.some((l) => ids.includes(l)), `${d.path} lacks its by-id link`); }
    assert.ok(inv.devices.some((d) => d.os), 'the real OS disk is tagged os: true');
  });

  await t.test('create_zpool (mirror) creates the pool and the managed datasets; the token must match; OS disk refused', async () => {
    const os = inv0(await svc.inventory({ smart: false, incus: false }));
    if (os) assert.match((await svc.plan('create_zpool', { name: POOL, devices: [os.by_id[0] || '/dev/disk/by-id/none'] })).error || '', /OS device|must be given as|not a known/);
    // a partition of a loop disk is not a whole disk, even as a by-id path
    assert.match((await svc.plan('create_zpool', { name: POOL, devices: [`${ids[0]}-part1`] })).error || '', /partition of|not a known whole disk/);
    const params = { name: POOL, layout: 'mirror', devices: [ids[0], ids[1]] };
    const p = await svc.plan('create_zpool', params);
    assert.ok(p.plan, p.error);
    const stale = await svc.apply('create_zpool', { ...params, compression: 'lz4' }, { confirm: true, plan_token: p.plan_token });
    assert.equal(stale.refused, true);
    const r = await svc.apply('create_zpool', params, { confirm: true, plan_token: p.plan_token });
    assert.equal(r.ok, true, JSON.stringify(r.failed));
    const list = run('zpool', ['list', '-H', '-o', 'name,health', POOL]);
    assert.match(list.stdout, new RegExp(`^${POOL}\\s+ONLINE`));
    assert.match(run('zfs', ['list', '-H', '-o', 'name', '-r', POOL]).stdout, new RegExp(`${POOL}/incus\\n${POOL}/backups\\n${POOL}/exports`.replace(/\n/g, '[\\s\\S]*')));
    assert.equal(svc.managed().pool, POOL);
    assert.equal(run('zfs', ['get', '-H', '-o', 'value', 'compression', POOL]).stdout.trim(), 'zstd');
    // the two loop disks are now pool members, refused for another pool
    const again = await svc.plan('create_zpool', { name: `${POOL}x`, devices: [ids[0]] });
    assert.match(again.error, /member of the imported ZFS pool/);
  });

  const guestDs = `${POOL}/incus/containers/fake-guest`;
  await t.test('datasets: create, write, snapshot, rollback restores the data', async () => {
    await applyOk('create_dataset', { name: `${POOL}/incus/containers` });
    await applyOk('create_dataset', { name: guestDs, props: { compression: 'lz4', recordsize: '16K' } });
    const mp = run('zfs', ['get', '-H', '-o', 'value', 'mountpoint', guestDs]).stdout.trim();
    writeFileSync(join(mp, 'hello.txt'), 'v1\n');
    run('sync', []);
    await applyOk('zfs_snapshot', { dataset: guestDs, name: 'v1' });
    writeFileSync(join(mp, 'hello.txt'), 'v2\n');
    run('sync', []);
    await applyOk('zfs_snapshot', { dataset: guestDs, name: 'v2' });
    assert.match((await svc.plan('zfs_rollback', { snapshot: `${guestDs}@v1` })).error, /newer snapshot/);
    await applyOk('zfs_rollback', { snapshot: `${guestDs}@v1`, destroy_newer: true });
    assert.equal(readFileSync(join(mp, 'hello.txt'), 'utf8'), 'v1\n');
    assert.ok(!run('zfs', ['list', '-H', '-t', 'snapshot', '-o', 'name', '-r', guestDs]).stdout.includes('@v2'));
    await applyOk('set_dataset_props', { dataset: guestDs, props: { quota: '100M' } });
    assert.equal(run('zfs', ['get', '-H', '-p', '-o', 'value', 'quota', guestDs]).stdout.trim(), String(100 * 1024 * 1024));
  });

  await t.test('backup policy renders sanoid.conf onto the host', async () => {
    const r = await applyOk('set_backup_policy', { class: 'guests', retention: { hourly: 6 } });
    const conf = readFileSync(process.env.PROXYPILOT_SANOID_CONF, 'utf8');
    assert.match(conf, new RegExp(`\\[${POOL}/incus\\]`)); assert.match(conf, /hourly = 6/);
    assert.equal(r.results[0].ok, true);
    if (have('sanoid')) {
      const s = run('sanoid', ['--configdir', state.dir, '--take-snapshots', '--verbose'], { env: { ...process.env, PATH: process.env.PATH } });
      // sanoid needs sanoid.defaults.conf next to its config; when the package ships one, copy it in and retry
      if (s.status !== 0 && existsSync('/etc/sanoid/sanoid.defaults.conf')) { copyFileSync('/etc/sanoid/sanoid.defaults.conf', join(state.dir, 'sanoid.defaults.conf')); run('sanoid', ['--configdir', state.dir, '--take-snapshots']); }
      const snaps = run('zfs', ['list', '-H', '-t', 'snapshot', '-o', 'name', '-r', guestDs]).stdout;
      if (snaps.includes('autosnap_')) console.log('sanoid took snapshots under the rendered policy');
    }
  });

  await t.test('replication to a second local pool through the syncoid wrapper', async (tt) => {
    await applyOk('create_zpool', { name: POOL2, layout: 'single', devices: [ids[2]], managed: false });
    for (const u of ['proxypilot-syncoid@.service', 'proxypilot-syncoid@.timer']) { const dst = `/etc/systemd/system/${u}`; if (!existsSync(dst)) { copyFileSync(join(REPO, 'deploy', u), dst); state.unitsInstalled.push(dst); } }
    state.unitsInstalled.push(`/etc/systemd/system/proxypilot-syncoid@${REPL}.timer.d`);
    const haveSystemd = run('systemctl', ['is-system-running']).status !== null && !/not|offline/.test(run('systemctl', ['is-system-running']).stdout);
    const params = { name: REPL, sources: [`${POOL}/incus`], target: `${POOL2}/repl`, schedule: 'hourly' };
    const p = await svc.plan('set_replication_target', params);
    assert.ok(p.plan, p.error);
    const r = await svc.apply('set_replication_target', params, { confirm: true, plan_token: p.plan_token });
    if (!haveSystemd) { assert.equal(r.results[0].ok, true, 'config file written'); tt.diagnostic('no systemd: timer steps not verified'); } else assert.equal(r.ok, true, JSON.stringify(r.failed));
    assert.match(readFileSync(join(process.env.PROXYPILOT_STORAGE_CONF_DIR, `replication-${REPL}.conf`), 'utf8'), new RegExp(`PP_REPL_TARGET='${POOL2}/repl'`));
    if (!have('syncoid')) { tt.diagnostic('syncoid not installed: run_replication skipped'); return; }
    run('zfs', ['create', `${POOL2}/repl`]);
    const rr = await applyOk('run_replication', { name: REPL });
    assert.equal(rr.results[0].ok, true, rr.results[0].stderr);
    assert.equal(run('zfs', ['list', '-H', '-o', 'name', `${POOL2}/repl/incus/containers/fake-guest`]).status, 0, 'replicated dataset exists on the second pool');
    const status = await svc.replicationStatus();
    assert.equal(status[0].name, REPL); assert.ok(status[0].last_success_at, 'wrapper recorded a success');
    const fresh = await svc.freshness();
    assert.equal(fresh.replication[0].status, 'ok');
  });

  await t.test('destroy_dataset streams a fresh snapshot first; zfs receive brings it back', async () => {
    const r = await applyOk('destroy_dataset', { dataset: `${POOL}/exports` });
    const stream = r.plan.stream_file.replaceAll('{{stamp}}', r.stamp);
    assert.ok(existsSync(stream), `stream file ${stream}`);
    assert.notEqual(run('zfs', ['list', '-H', '-o', 'name', `${POOL}/exports`]).status, 0);
    const back = run('sh', ['-c', `zfs receive ${POOL}/exports < "${stream}"`]);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(run('zfs', ['list', '-H', '-o', 'name', `${POOL}/exports`]).status, 0);
  });

  await t.test('scrub and freshness', async () => {
    await applyOk('zpool_scrub', { pool: POOL, action: 'start' });
    await new Promise((r) => setTimeout(r, 3000));
    const fresh = await svc.freshness();
    const pool = fresh.pools.find((p) => p.name === POOL);
    assert.ok(['ok', 'running'].includes(pool.scrub.status), JSON.stringify(pool.scrub));
    assert.equal(pool.healthy, true);
  });

  await t.test('export_pool then import_pool through by-id', async () => {
    await applyOk('export_pool', { pool: POOL2 });
    assert.notEqual(run('zpool', ['list', '-H', POOL2]).status, 0);
    const inv = await svc.inventory({ smart: false, incus: false });
    assert.ok(inv.importable.some((p) => p.name === POOL2), `importable: ${JSON.stringify(inv.importable)}`);
    const dev = inv.devices.find((d) => d.path === state.loops[2]);
    assert.equal(dev.importable_pool?.name, POOL2);
    assert.match((await svc.plan('create_zpool', { name: 'x', devices: [ids[2]] })).error, /importable ZFS pool/);
    await applyOk('import_pool', { pool: POOL2 });
    assert.equal(run('zpool', ['list', '-H', POOL2]).status, 0);
  });

  await t.test('replace_disk resilvers onto the spare loop device', async () => {
    const st = (await svc.inventory({ smart: false, incus: false })).poolStatus.find((p) => p.name === POOL);
    const old = st.vdevs[0].devices[0].name;
    await applyOk('replace_disk', { pool: POOL, old_device: old, new_device: ids[3] });
    let done = false;
    for (let i = 0; i < 30 && !done; i += 1) { await new Promise((r) => setTimeout(r, 1000)); const s = run('zpool', ['status', '-P', POOL]).stdout; done = !/replacing|resilver in progress/.test(s) && s.includes(ids[3]); }
    assert.ok(done, run('zpool', ['status', '-P', POOL]).stdout);
  });

  function inv0(inv) { return inv.devices.find((d) => d.os) || null; }
});
