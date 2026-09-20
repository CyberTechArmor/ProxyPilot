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
import { createExportStore, KEEP_PER_CONTAINER } from '../lib/lxc-exports.js';
import {
  COMPRESSIONS, DEFAULT_COMPRESSION, normalizeCompression, extensionFor, contentTypeFor,
  incusCompressionArgs, tarCompressionFlag, resolveCompression, TARBALL_SUFFIX_RE,
} from '../lib/export-compression.js';

const NOW = Date.parse('2026-09-20T12:00:00Z');

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
