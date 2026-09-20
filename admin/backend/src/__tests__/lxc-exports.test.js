// Prepared downloads (lib/lxc-exports.js) and the one compression decision
// (lib/export-compression.js), against a scripted host and a REAL SQLite
// database — the migration 912 DDL is lifted out of db.js and executed, so
// this also proves the shipped schema is valid SQL.
//
// The sandbox cannot load better-sqlite3's native binding
// (docs/known-issues.md), so the test opens node:sqlite instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createExportStore, KEEP_PER_CONTAINER, restoreHazards, restoreNotes } from '../lib/lxc-exports.js';
import {
  COMPRESSIONS, DEFAULT_COMPRESSION, normalizeCompression, extensionFor, contentTypeFor,
  incusCompressionArgs, tarCompressionFlag, resolveCompression, TARBALL_SUFFIX_RE,
} from '../lib/export-compression.js';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const iso = (t) => new Date(t).toISOString();

/** The real migration-912 DDL, lifted out of db.js so the test runs what ships. */
function schema912() {
  const src = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  const start = src.indexOf("runMigration(db, 912, 'lxc_exports'");
  assert.ok(start > 0, 'migration 912 must exist in db.js');
  const open = src.indexOf('d.exec(`', start) + 'd.exec(`'.length;
  const ddl = src.slice(open, src.indexOf('`);', open));
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS lxc_exports/);
  return ddl;
}

/**
 * A scripted host. `script(bin, args)` answers one command; anything it does
 * not answer succeeds silently, which is what a real host does for the
 * bookkeeping calls (mv, stat, rm).
 */
function setup({ script = () => null, hasZstd = true, dir = '/pool/exports', clock = null } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema912());
  const calls = [];
  let t = NOW;
  const now = clock || (() => t);

  const answer = (bin, args) => {
    calls.push({ bin, args });
    const r = script(bin, args, calls);
    if (r) return r;
    if (bin === 'incus' && args[0] === 'config') return { status: 0, stdout: 'name: x\n' };
    if (bin === 'incus' && args[0] === 'query' && /instances/.test(args[1])) {
      return { status: 0, stdout: JSON.stringify({ expanded_devices: { root: { pool: 'Fractionate-ZFS' } } }) };
    }
    if (bin === 'incus' && args[0] === 'query') return { status: 0, stdout: JSON.stringify({ usage: { used: 2 * 1024 ** 3 } }) };
    if (bin === 'incus' && args[0] === 'snapshot') return { status: 0, stdout: JSON.stringify([{ name: 'nightly' }]) };
    return { status: 0, stdout: '', stderr: '' };
  };

  const hostSh = async (scriptText, argv = []) => {
    calls.push({ bin: 'sh', args: [scriptText, ...argv] });
    const r = script('sh', [scriptText, ...argv], calls);
    if (r) return r;
    if (/^ls -1/.test(scriptText)) return { status: 0, stdout: '' };
    if (/^stat -c "%s %Y"/.test(scriptText)) return { status: 0, stdout: '0 0\n' };
    if (/df -B1/.test(scriptText)) return { status: 0, stdout: `${900 * 1024 ** 3}\n` };
    if (/stat -c %s "\$1" 2>\/dev\/null \|\| echo 0/.test(scriptText)) return { status: 0, stdout: '0\n' };
    if (/mv -f/.test(scriptText)) return { status: 0, stdout: `${512 * 1024 ** 2}\n` };
    if (/sha256sum/.test(scriptText)) return { status: 0, stdout: `${'a'.repeat(64)}\n` };
    if (/stat -c %s/.test(scriptText)) return { status: 0, stdout: `${512 * 1024 ** 2}\n` };
    return { status: 0, stdout: '', stderr: '' };
  };

  const audits = [];
  const events = [];
  const store = createExportStore({
    getDb: () => db,
    runHost: async (bin, args) => answer(bin, args),
    hostSh,
    exportsDir: async () => dir,
    getSetting: () => null,
    logAudit: (...a) => audits.push(a),
    hasBinary: async (b) => (b === 'zstd' ? hasZstd : true),
    now,
    onEvent: (e) => events.push(e),
  });
  return { db, store, calls, audits, events, advance: (ms) => { t += ms; }, dir };
}

/** The build is not awaited by prepare(), so let the microtasks drain. */
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/* -------------------------- export-compression -------------------------- */

test('the compression vocabulary is closed, and everything derived from it agrees', () => {
  assert.deepEqual([...COMPRESSIONS], ['zstd', 'gzip', 'none']);
  assert.equal(DEFAULT_COMPRESSION, 'zstd');
  assert.equal(normalizeCompression('ZSTD '), 'zstd');
  assert.equal(normalizeCompression('zst'), 'zstd');
  assert.equal(normalizeCompression('bzip2'), null);
  assert.equal(normalizeCompression(''), null);
  assert.equal(normalizeCompression(undefined), null);

  assert.equal(extensionFor('gzip'), '.tar.gz');
  assert.equal(extensionFor('none'), '.tar');
  assert.equal(extensionFor('zstd'), '.tar.zst');
  // An unknown string must not produce a nameless file.
  assert.equal(extensionFor('nonsense'), '.tar.zst');

  assert.equal(contentTypeFor('gzip'), 'application/gzip');
  assert.equal(contentTypeFor('none'), 'application/x-tar');
  assert.equal(contentTypeFor('zstd'), 'application/zstd');

  assert.deepEqual(incusCompressionArgs('gzip'), ['--compression', 'gzip']);
  assert.deepEqual(incusCompressionArgs(null), ['--compression', 'zstd']);
  assert.equal(tarCompressionFlag('gzip'), '-z');
  assert.equal(tarCompressionFlag('none'), null);
  assert.equal(tarCompressionFlag('zstd'), '--zstd');

  // Every name ProxyPilot has ever written is still recognisable as a tarball.
  for (const n of ['a.tar', 'a.tar.gz', 'a.tar.zst', 'a.tar.xz']) assert.match(n, TARBALL_SUFFIX_RE);
  assert.doesNotMatch('a.sql', TARBALL_SUFFIX_RE);
});

test('resolveCompression: the call wins, then the setting, then the default', async () => {
  const has = async () => true;
  assert.equal((await resolveCompression({ hasBinary: has })).compression, 'zstd');
  assert.equal((await resolveCompression({ hasBinary: has })).source, 'default');
  assert.equal((await resolveCompression({ setting: 'gzip', hasBinary: has })).compression, 'gzip');
  assert.equal((await resolveCompression({ setting: 'gzip', hasBinary: has })).source, 'setting');
  assert.equal((await resolveCompression({ requested: 'none', setting: 'gzip', hasBinary: has })).compression, 'none');
  assert.equal((await resolveCompression({ requested: 'none', setting: 'gzip', hasBinary: has })).source, 'request');
  // A setting someone typed by hand into app_settings must not break exports.
  assert.equal((await resolveCompression({ setting: 'brotli', hasBinary: has })).compression, 'zstd');
});

test('resolveCompression falls back to gzip on a host without zstd, and says so', async () => {
  const r = await resolveCompression({ hasBinary: async () => false });
  assert.equal(r.compression, 'gzip');
  assert.equal(r.fell_back_from, 'zstd');
  assert.equal(r.extension, '.tar.gz');
  assert.match(r.note, /apt install zstd/);
  // Asking for gzip or none must not probe for a binary at all.
  assert.equal((await resolveCompression({ requested: 'gzip', hasBinary: () => { throw new Error('probed'); } })).compression, 'gzip');
});

/* ------------------------------ the store ------------------------------- */

test('prepare builds in the background, names the file after the compressor and reports bytes', async () => {
  const { store, calls } = setup();
  const r = await store.prepare({ container: 'searxng', actor: 'admin-1' });
  assert.equal(r.error, undefined);
  assert.equal(r.export.state, 'preparing');
  assert.match(r.export.filename, /^lxc-searxng-\d{8}T\d{6}Z\.tar\.zst$/);
  assert.equal(r.compression.compression, 'zstd');
  // The estimate came from the storage volume, and it is what the UI shows
  // as the denominator before the first byte lands.
  assert.equal(r.export.bytes_total, 2 * 1024 ** 3);

  await settle();
  const done = store.get(r.export.id);
  assert.equal(done.state, 'ready');
  assert.equal(done.percent, 100);
  assert.equal(done.sha256, 'a'.repeat(64));

  const exp = calls.find((c) => c.bin === 'nice' && c.args.includes('export'));
  assert.ok(exp, 'the build must run incus export');
  assert.deepEqual(exp.args.slice(-2), ['--compression', 'zstd']);
  // Written to a .part and moved into place, so a half-built tarball is
  // never servable.
  assert.match(exp.args[exp.args.indexOf('export') + 2], /\.tar\.zst\.part$/);
});

test('a host without zstd silently produces a gzip tarball rather than failing', async () => {
  const { store, calls } = setup({ hasZstd: false });
  const r = await store.prepare({ container: 'searxng' });
  assert.equal(r.compression.compression, 'gzip');
  assert.match(r.export.filename, /\.tar\.gz$/);
  await settle();
  const exp = calls.find((c) => c.bin === 'nice' && c.args.includes('export'));
  assert.deepEqual(exp.args.slice(-2), ['--compression', 'gzip']);
});

test('prepare refuses what will not fit, and says by how much', async () => {
  const { store } = setup({
    script: (bin, args) => (bin === 'sh' && /df -B1/.test(args[0]) ? { status: 0, stdout: `${1024 ** 3}\n` } : null),
  });
  const r = await store.prepare({ container: 'searxng' });
  assert.match(r.error, /about 2\.0 GiB and \/pool\/exports has 1\.0 GiB free/);
  assert.equal(r.needs_bytes, 2 * 1024 ** 3);
  assert.equal(store.list().length, 0, 'a refusal must not leave a row behind');
});

test('unreadable df does not block a download (null free space, not zero)', async () => {
  const { store } = setup({
    script: (bin, args) => (bin === 'sh' && /df -B1/.test(args[0]) ? { status: 0, stdout: 'df: /pool: No such file\n' } : null),
  });
  assert.equal(await store.freeBytes('/pool/exports'), null);
  const r = await store.prepare({ container: 'searxng' });
  assert.equal(r.error, undefined);
});

test('a second prepare of the same guest joins the first rather than racing it', async () => {
  const { store } = setup({ script: (bin, args) => (bin === 'nice' && args.includes('export') ? new Promise(() => {}) : null) });
  const first = await store.prepare({ container: 'searxng' });
  const second = await store.prepare({ container: 'searxng' });
  assert.match(second.error, /already being prepared \(#1\)/);
  assert.equal(second.existing.id, first.export.id);
  // A DIFFERENT snapshot of the same guest is a different artifact.
  const other = await store.prepare({ container: 'searxng', snapshot: 'nightly' });
  assert.equal(other.error, undefined);
});

test('a bad name never reaches the host', async () => {
  const { store, calls } = setup();
  assert.match((await store.prepare({ container: 'a b; rm -rf /' })).error, /invalid container name/);
  assert.match((await store.prepare({ container: 'ok', snapshot: '../../etc' })).error, /invalid snapshot name/);
  assert.equal(calls.length, 0);
});

test('a snapshot download is cut from a throwaway instance, which is always cleaned up', async () => {
  const { store, calls } = setup();
  const r = await store.prepare({ container: 'searxng', snapshot: 'nightly' });
  await settle();
  assert.equal(store.get(r.export.id).state, 'ready');
  const copy = calls.find((c) => c.bin === 'nice' && c.args.includes('copy'));
  assert.ok(copy, 'a snapshot must be materialised with incus copy');
  assert.equal(copy.args[copy.args.indexOf('copy') + 1], 'pp-searxng/nightly');
  const del = calls.find((c) => c.bin === 'incus' && c.args[0] === 'delete');
  assert.ok(del, 'the throwaway instance must be deleted');
  assert.ok(del.args.includes('--force'));
});

test('a failed export leaves a failed row with the host error, and the temp instance still goes', async () => {
  const { store, calls } = setup({
    script: (bin, args) => (bin === 'nice' && args.includes('export')
      ? { status: 1, stdout: '', stderr: 'Error: storage pool is full\n' } : null),
  });
  const r = await store.prepare({ container: 'searxng', snapshot: 'nightly' });
  await settle();
  const row = store.get(r.export.id);
  assert.equal(row.state, 'failed');
  assert.match(row.error, /storage pool is full/);
  assert.ok(calls.some((c) => c.bin === 'incus' && c.args[0] === 'delete'));
});

test('byte progress comes from the growing .part file, and a stall is visible', async () => {
  let partBytes = 0;
  const { store, advance } = setup({
    script: (bin, args) => {
      if (bin === 'nice' && args.includes('export')) return new Promise(() => {});
      if (bin === 'sh' && /echo 0/.test(args[0])) return { status: 0, stdout: `${partBytes}\n` };
      return null;
    },
  });
  const r = await store.prepare({ container: 'searxng' });
  const id = r.export.id;
  partBytes = 512 * 1024 ** 2;
  await store.get(id);                       // nothing polled yet
  assert.equal(store.get(id).bytes, 0);

  // Drive one poll tick by hand rather than waiting two real seconds.
  const q0 = store.queueStatus();
  assert.equal(q0.running.length, 1);
  assert.equal(q0.running[0].id, id);
  assert.equal(q0.max_concurrent, 1);

  // Ten minutes with no growth is the stall threshold the banner reads.
  advance(11 * 60 * 1000);
  assert.equal(store.queueStatus().running[0].stalled, true);
});

test('retention keeps the newest few per container and drops the old, never a build in flight', async () => {
  const { store, db } = setup();
  const insert = db.prepare(`
    INSERT INTO lxc_exports (container_name, snapshot_name, path, filename, compression, state, bytes_done, created_at, expires_at)
    VALUES (?, NULL, ?, ?, 'zstd', ?, 1, ?, ?)
  `);
  for (let i = 1; i <= KEEP_PER_CONTAINER + 2; i++) {
    insert.run('searxng', `/pool/exports/s${i}.tar.zst`, `s${i}.tar.zst`, 'ready', `2026-09-1${i}T00:00:00Z`, '2026-10-01T00:00:00Z');
  }
  insert.run('other', '/pool/exports/o1.tar.zst', 'o1.tar.zst', 'ready', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
  insert.run('other', '/pool/exports/o2.tar.zst', 'o2.tar.zst', 'preparing', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');

  const out = await store.sweep();
  const kept = store.list({ container: 'searxng' });
  assert.equal(kept.length, KEEP_PER_CONTAINER);
  assert.deepEqual(kept.map((k) => k.filename), ['s5.tar.zst', 's4.tar.zst', 's3.tar.zst']);
  assert.ok(out.swept.some((s) => s.reason === `keeping ${KEEP_PER_CONTAINER} per container`));
  // o1 is eight months old: gone on age. o2 is still building: untouched.
  assert.ok(out.swept.some((s) => s.file.endsWith('o1.tar.zst') && /older than/.test(s.reason)));
  assert.equal(store.list({ container: 'other' }).length, 1);
  assert.equal(store.list({ container: 'other' })[0].state, 'preparing');
});

test('delete removes the file and the row, but refuses mid-build', async () => {
  const { store, calls } = setup({ script: (bin, args) => (bin === 'nice' && args.includes('export') ? new Promise(() => {}) : null) });
  const r = await store.prepare({ container: 'searxng' });
  assert.match((await store.remove(r.export.id)).error, /still being prepared/);

  const { store: s2 } = setup();
  const done = await s2.prepare({ container: 'searxng' });
  await settle();
  const out = await s2.remove(done.export.id, { actor: 'admin-1' });
  assert.equal(out.deleted, true);
  assert.equal(s2.get(done.export.id), null);
  assert.match((await s2.remove(999)).error, /no such download/);
  assert.ok(calls.length >= 0);
});

test('register files a tarball some other verb made, so one list covers them all', async () => {
  const { store } = setup();
  const row = store.register({
    container: 'grafana', path: '/pool/exports/lxc-grafana-20260920T090000Z.tar.zst',
    compression: 'zstd', sizeBytes: 1234, sha256: 'b'.repeat(64), actor: 'mcp',
  });
  assert.equal(row.state, 'ready');
  assert.equal(row.filename, 'lxc-grafana-20260920T090000Z.tar.zst');
  assert.equal(row.percent, 100);
  assert.equal(row.bytes, 1234);
  assert.equal(store.list({ container: 'grafana' }).length, 1);
});

test('openForDownload serves only a ready artifact that is still on disk', async () => {
  const { store } = setup();
  const r = await store.prepare({ container: 'searxng' });
  await settle();
  const open = await store.openForDownload(r.export.id);
  assert.equal(open.size, 512 * 1024 ** 2);
  assert.equal(open.compression, 'zstd');
  assert.match(open.filename, /\.tar\.zst$/);

  store.countDownload(r.export.id);
  store.countDownload(r.export.id);
  assert.equal(store.get(r.export.id).downloads, 2);

  assert.match((await store.openForDownload(4242)).error, /no such download/);

  // A tarball an operator deleted from the host by hand must not 500 a
  // download; it must say the file is gone.
  const { store: s3 } = setup({ script: (bin, args) => (bin === 'sh' && /^stat -c %s/.test(args[0]) ? { status: 1, stdout: '' } : null) });
  const gone = s3.register({ container: 'x', path: '/pool/exports/x.tar.zst', compression: 'zstd' });
  assert.match((await s3.openForDownload(gone.id)).error, /gone from disk/);
});

test('the sweep adopts a tarball nobody recorded, so retention and the panel can reach it', async () => {
  const onDisk = {
    'lxc-searxng-20260920T135323Z.tar.gz': [1003913216, 1789900000],   // written before this store existed
    'lxc-grafana-nightly-20260920T140000Z.tar.zst': [2048, 1789900100], // a snapshot export
    'notes.txt': [10, 1789900200],                                      // not ours
    'some-other-backup.tar.gz': [10, 1789900300],                       // not ours either
  };
  const { store } = setup({
    script: (bin, args) => {
      if (bin === 'incus' && args[0] === 'list') return { status: 0, stdout: 'pp-searxng\npp-grafana\n' };
      if (bin !== 'sh') return null;
      if (/^ls -1/.test(args[0])) return { status: 0, stdout: `${Object.keys(onDisk).join('\n')}\n` };
      if (/^stat -c "%s %Y"/.test(args[0])) {
        const e = onDisk[args[2]];
        return e ? { status: 0, stdout: `${e[0]} ${e[1]}\n` } : { status: 1, stdout: '' };
      }
      return null;
    },
  });

  const out = await store.sweep();
  assert.equal(out.adopted.length, 2, 'both ProxyPilot tarballs, and only those');
  assert.deepEqual(out.adopted.map((a) => a.container).sort(), ['grafana', 'searxng']);

  const rows = store.list();
  const searx = rows.find((r) => r.container === 'searxng');
  assert.equal(searx.state, 'ready');
  assert.equal(searx.bytes, 1003913216);
  assert.equal(searx.compression, 'gzip', 'the extension says what it was compressed with');
  assert.equal(searx.created_by, 'adopted');
  // The expiry counts from the file's own mtime, not from the moment it was
  // noticed — otherwise adoption would silently reset the clock on every
  // old tarball.
  assert.ok(searx.expires_at < iso(NOW + 14 * 86400000), 'the clock runs from the file, not from the sweep');
  const graf = rows.find((r) => r.container === 'grafana');
  assert.equal(graf.compression, 'zstd');
  assert.equal(graf.snapshot, 'nightly', 'the guest list is what resolves container-vs-snapshot in a dashed name');

  // Idempotent: a second sweep adopts nothing and changes nothing.
  const again = await store.sweep();
  assert.equal(again.adopted.length, 0);
  assert.equal(store.list().length, 2);
});

test('adopting an OLD tarball never evicts a NEW one — retention runs on dates, not row ids', async () => {
  // The live failure, reproduced: three exports recorded this afternoon, then
  // one from this morning adopted off the disk. Adoption inserts last, so it
  // holds the highest id while being the oldest file. Ordering by id made the
  // sweep keep the three most recently INSERTED and delete a tarball made
  // twenty minutes ago.
  const onDisk = { 'lxc-searxng-20260920T135323Z.tar.gz': [1003913216, Math.floor(Date.parse('2026-09-20T13:53:23Z') / 1000)] };
  const { store, db } = setup({
    script: (bin, args) => {
      if (bin === 'incus' && args[0] === 'list') return { status: 0, stdout: 'pp-searxng\n' };
      if (bin !== 'sh') return null;
      if (/^ls -1/.test(args[0])) return { status: 0, stdout: `${Object.keys(onDisk).join('\n')}\n` };
      if (/^stat -c "%s %Y"/.test(args[0])) {
        const e = onDisk[args[2]];
        return e ? { status: 0, stdout: `${e[0]} ${e[1]}\n` } : { status: 1, stdout: '' };
      }
      return null;
    },
  });
  const insert = db.prepare(`
    INSERT INTO lxc_exports (container_name, snapshot_name, path, filename, compression, state, bytes_done, created_at, expires_at)
    VALUES ('searxng', NULL, ?, ?, 'zstd', 'ready', 1, ?, '2026-10-04T00:00:00Z')
  `);
  for (const [name, at] of [
    ['lxc-searxng-20260920T151907Z.tar.zst', '2026-09-20T15:19:07Z'],
    ['lxc-searxng-20260920T151954Z.tar.gz', '2026-09-20T15:19:54Z'],
    ['lxc-searxng-20260920T152310Z.tar', '2026-09-20T15:23:10Z'],
  ]) insert.run(`/pool/exports/${name}`, name, at);

  const out = await store.sweep();
  assert.equal(out.adopted.length, 1);
  assert.equal(out.swept.length, 1);
  assert.equal(out.swept[0].file, '/pool/exports/lxc-searxng-20260920T135323Z.tar.gz',
    'the MORNING file is the one that goes, whatever order the rows were written in');
  assert.deepEqual(store.list({ container: 'searxng' }).map((r) => r.filename).sort(), [
    'lxc-searxng-20260920T151907Z.tar.zst',
    'lxc-searxng-20260920T151954Z.tar.gz',
    'lxc-searxng-20260920T152310Z.tar',
  ]);
});

/* ------------------------------- restore -------------------------------- */

test('a restored clone is read for what would fight the guest it came from', () => {
  // The shape `incus query /1.0/instances/<name>` returns for a guest that
  // has a static DHCP reservation and two published ports.
  const devices = {
    eth0: { name: 'eth0', network: 'pp-br0', type: 'nic', 'ipv4.address': '10.0.10.42' },
    root: { path: '/', pool: 'Storage', type: 'disk', size: '20GiB' },
    'pp-fwd-8080': { type: 'proxy', listen: 'tcp:0.0.0.0:8080', connect: 'tcp:127.0.0.1:8080' },
    'pp-fwd-8443': { type: 'proxy', listen: 'tcp:0.0.0.0:8443', connect: 'tcp:127.0.0.1:8443' },
  };
  const h = restoreHazards(devices, { sourceContainer: 'searxng' });
  assert.equal(h.pinnedIp, '10.0.10.42');
  assert.deepEqual(h.proxyDevices, ['pp-fwd-8080 (tcp:0.0.0.0:8080)', 'pp-fwd-8443 (tcp:0.0.0.0:8443)']);

  // A guest with nothing to clash over produces nothing to say.
  const clean = restoreHazards({ eth0: { type: 'nic', network: 'pp-br0' }, root: { type: 'disk' } });
  assert.equal(clean.pinnedIp, null);
  assert.deepEqual(clean.proxyDevices, []);
  assert.deepEqual(restoreNotes({ ...clean }), []);

  // Junk in, no crash: the route calls this on whatever the host returned.
  assert.deepEqual(restoreHazards(null), { pinnedIp: null, proxyDevices: [] });
  assert.deepEqual(restoreHazards({ weird: null, alsoWeird: 'string' }).proxyDevices, []);
  // A proxy device with no listen address cannot clash over a port.
  assert.deepEqual(restoreHazards({ p: { type: 'proxy' } }).proxyDevices, []);
});

test('the restore notes say which guest owns what, and whether the clash was cleared', () => {
  const removed = restoreNotes({ pinnedIp: '10.0.10.42', pinRemoved: true, proxyDevices: [], sourceContainer: 'searxng' });
  assert.equal(removed.length, 1);
  assert.match(removed[0], /Dropped the cloned static address 10\.0\.10\.42/);
  assert.match(removed[0], /searxng's DHCP reservation/);

  // When clearing FAILED the wording must tell the operator to act, not
  // reassure them — this is the note that prevents a silent IP collision.
  const stuck = restoreNotes({ pinnedIp: '10.0.10.42', pinRemoved: false, sourceContainer: 'searxng' });
  assert.match(stuck[0], /do that by hand before you start/);
  assert.doesNotMatch(stuck[0], /Dropped/);

  const ports = restoreNotes({ proxyDevices: ['pp-fwd-8080 (tcp:0.0.0.0:8080)'], sourceContainer: 'searxng' });
  assert.match(ports[0], /1 port forward:/);
  assert.doesNotMatch(ports[0], /forwards:/);
  assert.match(restoreNotes({ proxyDevices: ['a (x)', 'b (y)'] })[0], /2 port forwards:/);
});
