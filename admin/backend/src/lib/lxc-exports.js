// Prepared downloads: a guest tarball that EXISTS, rather than one rebuilt
// for every click.
//
// The old download button ran `incus export <guest> -` straight into the HTTP
// response. That meant: the work was tied to one request (close the tab and
// it was SIGTERM'd), every download paid the full build again, and the
// browser got no Content-Length — so no native progress bar and no resume.
// For a Docker-in-LXC guest on dir storage the prepare phase alone is
// minutes, which is a long time to hold a browser tab still.
//
// So: build once into a file, in the background, with byte progress read from
// the file as it grows. Then the download is an ordinary static file — served
// with Content-Length and Range, downloadable as many times as anyone likes,
// from any device, and resumable. Deleted when the operator says so, or by
// retention.
//
// The artifacts live in the same directory `export_lxc` writes to (the
// managed ZFS exports dataset when there is one), and `export_lxc` registers
// what it makes here, so the dashboard and MCP show ONE list rather than two
// views of the same directory that disagree.

import { COMPRESSION_SETTING, resolveCompression, extensionFor, incusCompressionArgs, TARBALL_SUFFIX_RE } from './export-compression.js';

/** Keep this many ready artifacts per container; sweep the rest oldest-first. */
export const KEEP_PER_CONTAINER = 3;
/** And expire any artifact older than this, however few there are. */
export const EXPIRE_DAYS = 14;
/** One build at a time: an export is CPU- and disk-heavy, and two of them race for both. */
export const MAX_CONCURRENT = 1;
const PROGRESS_INTERVAL_MS = 2000;
/** A build that has produced nothing for this long is reported as stalled (dir storage prepares silently). */
const STALL_AFTER_MS = 10 * 60 * 1000;

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
const STATES = Object.freeze(['preparing', 'ready', 'failed']);

const iso = (t) => new Date(t).toISOString();

/**
 * createExportStore({ … }) — everything that touches the host is injected, so
 * the whole lifecycle is testable without an Incus.
 *
 *   runHost(bin, args, opts)  → { status, stdout, stderr }   (captured)
 *   hostSh(script, args)      → { status, stdout, stderr }   (shell, captured)
 *   exportsDir()              → the directory to write into
 */
export function createExportStore({
  getDb, runHost, hostSh, exportsDir, getSetting = () => null, logAudit = () => {},
  hasBinary = null, now = () => Date.now(), lxcPrefix = 'pp-', onEvent = null,
} = {}) {
  if (typeof getDb !== 'function') throw new Error('createExportStore needs getDb');
  if (typeof runHost !== 'function') throw new Error('createExportStore needs runHost');

  const db = () => getDb();
  const incus = (name) => `${lxcPrefix}${name}`;
  const running = new Map();     // id → { startedAt, lastBytes, lastMovedAt }
  const queue = [];              // ids waiting for a slot
  let sweeping = false;

  /* -------------------------------- rows -------------------------------- */

  const view = (r) => (!r ? null : {
    id: r.id,
    container: r.container_name,
    snapshot: r.snapshot_name || null,
    filename: r.filename,
    compression: r.compression,
    state: r.state,
    bytes: r.bytes_done || 0,
    bytes_total: r.bytes_total || null,
    percent: r.state === 'ready' ? 100
      : r.bytes_total ? Math.min(99, Math.round(((r.bytes_done || 0) / r.bytes_total) * 100)) : null,
    stalled: r.state === 'preparing' && stalledFor(r.id),
    sha256: r.sha256 || null,
    error: r.error || null,
    created_at: r.created_at,
    created_by: r.created_by || null,
    ready_at: r.ready_at || null,
    expires_at: r.expires_at || null,
    downloads: r.downloads || 0,
    last_downloaded_at: r.last_downloaded_at || null,
  });

  function stalledFor(id) {
    const live = running.get(id);
    return !!live && now() - live.lastMovedAt > STALL_AFTER_MS;
  }

  const rowById = (id) => db().prepare('SELECT * FROM lxc_exports WHERE id = ?').get(Number(id)) || null;

  function list({ container = null, state = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (container) { where.push('container_name = ?'); params.push(String(container)); }
    if (state) { where.push('state = ?'); params.push(String(state)); }
    const rows = db().prepare(
      `SELECT * FROM lxc_exports${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    ).all(...params, Math.max(1, Math.min(500, Number(limit) || 200)));
    return rows.map(view);
  }

  function get(id) { return view(rowById(id)); }

  /* ------------------------------ estimates ------------------------------ */

  /**
   * How big the guest is, from the storage volume itself. This is the
   * UNCOMPRESSED size, so as a prediction of the tarball it overshoots —
   * which is the right way round for a free-space check.
   */
  async function estimateBytes(container, snapshot = null) {
    const name = incus(container);
    const inst = await runHost('incus', ['query', `/1.0/instances/${name}?recursion=1`], { timeoutMs: 15000 });
    if (inst.status !== 0) return null;
    let pool = null;
    try {
      const j = JSON.parse(inst.stdout || '{}');
      pool = j?.expanded_devices?.root?.pool || j?.devices?.root?.pool || null;
    } catch { return null; }
    if (!pool) return null;
    const vol = snapshot ? `container/${name}/snapshots/${snapshot}` : `container/${name}`;
    const st = await runHost('incus', ['query', `/1.0/storage-pools/${pool}/volumes/${vol}/state`], { timeoutMs: 15000 });
    if (st.status !== 0) return null;
    try {
      const used = JSON.parse(st.stdout || '{}')?.usage?.used;
      return Number.isFinite(Number(used)) && Number(used) > 0 ? Number(used) : null;
    } catch { return null; }
  }

  /** Free space where the tarballs land. null when df says something we cannot read. */
  async function freeBytes(dir) {
    const r = await hostSh('df -B1 --output=avail "$1" 2>/dev/null | tail -1', [dir], { timeoutMs: 15000 });
    const digits = String(r.stdout || '').trim().split(/\s+/).filter((t) => /^\d+$/.test(t));
    return digits.length ? Number(digits.at(-1)) : null;
  }

  /* ------------------------------- prepare ------------------------------- */

  /**
   * Queue a build. Returns the row immediately — the work happens after the
   * response, which is the whole point.
   */
  async function prepare({ container, snapshot = null, compression = null, instanceOnly = false, actor = null, ip = null } = {}) {
    if (!NAME_RE.test(String(container || ''))) return { error: 'invalid container name' };
    if (snapshot != null && !NAME_RE.test(String(snapshot))) return { error: 'invalid snapshot name' };

    const exists = await runHost('incus', ['config', 'show', incus(container)], { timeoutMs: 30000 });
    if (exists.status !== 0) return { error: `no container ${container} on this host` };
    if (snapshot) {
      const snaps = await runHost('incus', ['snapshot', 'list', incus(container), '--format', 'json'], { timeoutMs: 30000 });
      let found = false;
      try { found = (JSON.parse(snaps.stdout || '[]') || []).some((s) => s?.name === snapshot); } catch { /* treat as absent */ }
      if (!found) return { error: `snapshot ${snapshot} does not exist on ${container}` };
    }

    const already = db().prepare(
      `SELECT * FROM lxc_exports WHERE container_name = ? AND IFNULL(snapshot_name,'') = ? AND state = 'preparing'`
    ).get(container, snapshot || '');
    if (already) return { error: `a download of ${container}${snapshot ? `/${snapshot}` : ''} is already being prepared (#${already.id})`, existing: view(already) };

    const dir = await exportsDir();
    const [estimate, free] = await Promise.all([estimateBytes(container, snapshot), freeBytes(dir)]);
    if (estimate != null && free != null && estimate > free) {
      return {
        error: `${container} holds about ${gib(estimate)} and ${dir} has ${gib(free)} free — the tarball will not fit. `
          + 'Delete an older prepared download, free space, or point the exports dataset somewhere with room.',
        needs_bytes: estimate, free_bytes: free,
      };
    }

    const chosen = await resolveCompression({
      requested: compression, setting: getSetting(COMPRESSION_SETTING), hasBinary,
    });
    const stamp = iso(now()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const filename = `lxc-${container}${snapshot ? `-${snapshot}` : ''}-${stamp}${chosen.extension}`;
    const ts = iso(now());
    const info = db().prepare(`
      INSERT INTO lxc_exports (container_name, snapshot_name, path, filename, compression, state, bytes_done, bytes_total, created_at, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, 'preparing', 0, ?, ?, ?, ?)
    `).run(container, snapshot, `${dir}/${filename}`, filename, chosen.compression, estimate, ts, actor,
      iso(now() + EXPIRE_DAYS * 86400000));
    const id = Number(info.lastInsertRowid);
    try { logAudit(actor, 'LXC_EXPORT_PREPARE', 'lxc', container, { id, snapshot, compression: chosen.compression, estimate_bytes: estimate }, ip); } catch { /* best effort */ }
    schedule(id, { instanceOnly });
    return { export: view(rowById(id)), compression: chosen, estimate_bytes: estimate, free_bytes: free };
  }

  const gib = (b) => `${(Number(b) / 1024 ** 3).toFixed(1)} GiB`;

  /* -------------------------------- build -------------------------------- */

  function schedule(id, opts) {
    queue.push({ id, opts });
    pump();
  }

  function pump() {
    while (running.size < MAX_CONCURRENT && queue.length) {
      const next = queue.shift();
      const row = rowById(next.id);
      if (!row || row.state !== 'preparing') continue;
      running.set(next.id, { startedAt: now(), lastBytes: 0, lastMovedAt: now() });
      // Deliberately not awaited: prepare() has already answered.
      build(next.id, next.opts).catch((e) => fail(next.id, e?.message || String(e))).finally(() => {
        running.delete(next.id);
        pump();
      });
    }
  }

  async function build(id, { instanceOnly = false } = {}) {
    const row = rowById(id);
    if (!row) return;
    const part = `${row.path}.part`;
    const temp = row.snapshot_name ? `pp-xport-${id}-${Math.random().toString(36).slice(2, 8)}` : null;
    const tick = setInterval(() => { void poll(id, part); }, PROGRESS_INTERVAL_MS);
    if (typeof tick.unref === 'function') tick.unref();
    try {
      // `incus export` takes an instance, never instance/snapshot, so a
      // snapshot is materialised as a throwaway instance first — instant on
      // a copy-on-write pool, a full copy on dir.
      if (temp) {
        const cp = await runHost('nice', ['-n', '19', 'incus', 'copy', `${incus(row.container_name)}/${row.snapshot_name}`, temp], { timeoutMs: 6 * 3600 * 1000 });
        if (cp.status !== 0) throw new Error(`incus copy failed: ${tail(cp.stderr) || `exit ${cp.status}`}`);
      }
      const argv = ['-n', '19', 'incus', 'export', temp || incus(row.container_name), part, ...incusCompressionArgs(row.compression)];
      if (instanceOnly || temp) argv.push('--instance-only');
      const ex = await runHost('nice', argv, { timeoutMs: 12 * 3600 * 1000 });
      if (ex.status !== 0) throw new Error(`incus export failed: ${tail(ex.stderr) || tail(ex.stdout) || `exit ${ex.status}`}`);

      const mv = await hostSh('mv -f "$1" "$2" && stat -c %s "$2"', [part, row.path], { timeoutMs: 120000 });
      if (mv.status !== 0) throw new Error(`could not finish the tarball: ${tail(mv.stderr) || `exit ${mv.status}`}`);
      const size = Number(String(mv.stdout || '').trim()) || 0;
      const sum = await hostSh('sha256sum "$1" | cut -d" " -f1', [row.path], { timeoutMs: 30 * 60 * 1000 });
      const sha = String(sum.stdout || '').trim();
      const ts = iso(now());
      db().prepare(`UPDATE lxc_exports SET state='ready', bytes_done=?, bytes_total=?, sha256=?, ready_at=?, error=NULL WHERE id=?`)
        .run(size, size, /^[0-9a-f]{64}$/.test(sha) ? sha : null, ts, id);
      emit(id, 'ready');
      void sweep().catch(() => {});
    } finally {
      clearInterval(tick);
      if (temp) await runHost('incus', ['delete', temp, '--force'], { timeoutMs: 300000 }).catch(() => {});
      await hostSh('rm -f "$1"', [part], { timeoutMs: 30000 }).catch(() => {});
    }
  }

  /** Byte progress, read from the file as it grows — the only honest source. */
  async function poll(id, part) {
    const live = running.get(id);
    if (!live) return;
    const r = await hostSh('stat -c %s "$1" 2>/dev/null || echo 0', [part], { timeoutMs: 15000 }).catch(() => null);
    const n = Number(String(r?.stdout || '').trim()) || 0;
    if (n > live.lastBytes) { live.lastBytes = n; live.lastMovedAt = now(); }
    db().prepare('UPDATE lxc_exports SET bytes_done = ? WHERE id = ? AND state = ?').run(n, id, 'preparing');
  }

  function fail(id, message) {
    const row = rowById(id);
    if (!row) return;
    db().prepare(`UPDATE lxc_exports SET state='failed', error=? WHERE id=?`).run(String(message).slice(0, 1000), id);
    emit(id, 'failed');
  }

  function emit(id, kind) { try { onEvent?.({ id, kind, export: get(id) }); } catch { /* best effort */ } }
  const tail = (s) => String(s || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);

  /* ------------------------------- register ------------------------------ */

  /**
   * Record a tarball some other verb already made (export_lxc,
   * delete_lxc_container, delete_project) so every artifact appears in one
   * list and retention reaches all of them.
   */
  function register({ container, snapshot = null, path, compression = 'gzip', sizeBytes = null, sha256 = null, actor = null }) {
    if (!path) return null;
    const filename = String(path).split('/').pop();
    const ts = iso(now());
    const info = db().prepare(`
      INSERT INTO lxc_exports (container_name, snapshot_name, path, filename, compression, state, bytes_done, bytes_total, sha256, created_at, created_by, ready_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)
    `).run(container, snapshot, path, filename, compression, sizeBytes || 0, sizeBytes, sha256, ts, actor, ts,
      iso(now() + EXPIRE_DAYS * 86400000));
    return view(rowById(Number(info.lastInsertRowid)));
  }

  /* -------------------------------- serve -------------------------------- */

  /**
   * What the download route needs. The file lives on the HOST — the backend
   * runs in a container that cannot see the ZFS exports dataset — so the
   * route streams it back through the host rather than opening it directly,
   * and a Range request becomes a `dd` with byte offsets.
   */
  async function openForDownload(id) {
    const row = rowById(id);
    if (!row) return { error: 'no such download' };
    if (row.state !== 'ready') return { error: `download #${id} is ${row.state}${row.error ? `: ${row.error}` : ''}` };
    const st = await hostSh('stat -c %s "$1" 2>/dev/null', [row.path], { timeoutMs: 15000 });
    const size = Number(String(st.stdout || '').trim());
    if (!Number.isFinite(size) || size <= 0) {
      return { error: `the tarball is gone from disk (${row.path}) — delete this row and prepare it again` };
    }
    return { row, path: row.path, filename: row.filename, size, compression: row.compression };
  }

  function countDownload(id) {
    db().prepare('UPDATE lxc_exports SET downloads = downloads + 1, last_downloaded_at = ? WHERE id = ?').run(iso(now()), id);
  }

  /* ------------------------------- delete -------------------------------- */

  async function remove(id, { actor = null, ip = null } = {}) {
    const row = rowById(id);
    if (!row) return { error: 'no such download' };
    if (row.state === 'preparing') return { error: `#${id} is still being prepared — it cannot be deleted mid-build` };
    await hostSh('rm -f "$1" "$1.part"', [row.path], { timeoutMs: 60000 }).catch(() => {});
    db().prepare('DELETE FROM lxc_exports WHERE id = ?').run(id);
    try { logAudit(actor, 'LXC_EXPORT_DELETE', 'lxc', row.container_name, { id, file: row.path }, ip); } catch { /* best effort */ }
    return { deleted: true, id, file: row.path };
  }

  /**
   * Retention. Keeps the newest KEEP_PER_CONTAINER ready artifacts per
   * container and drops anything past EXPIRE_DAYS — a prepared download is a
   * convenience, not the backup of record (that is sanoid + replication).
   * Never touches a build in flight.
   */
  async function sweep({ keep = KEEP_PER_CONTAINER, days = EXPIRE_DAYS, actor = 'retention' } = {}) {
    if (sweeping) return { swept: [], skipped: 'already running' };
    sweeping = true;
    const swept = [];
    let adopted = [];
    try {
      adopted = await adoptOrphans();
      const cutoff = iso(now() - days * 86400000);
      // By created_at, NOT by id. An adopted row gets a fresh id while
      // carrying the file's own (older) date, so ordering by id made
      // "keep the newest 3" mean "keep the 3 most recently INSERTED" —
      // which on the first sweep after adoption deletes a tarball made
      // minutes ago and keeps one from hours before. Caught on the live
      // host doing exactly that.
      const rows = db().prepare(`SELECT * FROM lxc_exports WHERE state = 'ready' ORDER BY container_name, created_at DESC, id DESC`).all();
      const seen = new Map();
      for (const r of rows) {
        const n = (seen.get(r.container_name) || 0) + 1;
        seen.set(r.container_name, n);
        const tooMany = n > keep;
        const tooOld = String(r.created_at) < cutoff;
        if (!tooMany && !tooOld) continue;
        // eslint-disable-next-line no-await-in-loop
        const out = await remove(r.id, { actor });
        if (out.deleted) swept.push({ id: r.id, container: r.container_name, file: r.path, reason: tooMany ? `keeping ${keep} per container` : `older than ${days} days` });
      }
    } finally { sweeping = false; }
    return { swept, adopted, keep, days };
  }

  /**
   * Tarballs in the exports directory that predate this store (export_lxc
   * wrote plenty before there was a table) or that a crash left unrecorded.
   * Retention only reaches rows, and the panel only shows rows, so an
   * unadopted file is a gigabyte nobody can see and nothing will ever
   * delete. Adopting one makes it visible, downloadable and expirable —
   * which is the whole claim of having ONE list.
   *
   * The container name is read back out of the filename this store and
   * export_lxc both write (`lxc-<container>[-<snapshot>]-<stamp>.tar…`);
   * anything that does not parse is left alone, because a file nobody
   * recognises is not ours to delete.
   */
  /** The guests that exist right now, without the prefix. Empty on any trouble. */
  async function liveGuestNames() {
    const r = await runHost('incus', ['list', '--format', 'csv', '-c', 'n'], { timeoutMs: 30000 }).catch(() => null);
    if (!r || r.status !== 0) return [];
    return String(r.stdout || '').split('\n').map((x) => x.trim())
      .filter((x) => x.startsWith(lxcPrefix)).map((x) => x.slice(lxcPrefix.length)).filter(Boolean);
  }

  async function adoptOrphans() {
    const dir = await exportsDir();
    const ls = await hostSh('ls -1 "$1" 2>/dev/null', [dir], { timeoutMs: 30000 }).catch(() => null);
    const names = String(ls?.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (!names.length) return [];
    const known = new Set(db().prepare('SELECT filename FROM lxc_exports').all().map((r) => r.filename));
    const guests = await liveGuestNames();
    const out = [];
    for (const filename of names) {
      if (known.has(filename)) continue;
      if (!TARBALL_SUFFIX_RE.test(filename)) continue;
      // `lxc-<container>[-<snapshot>]-<stamp>.tar…`. Container names contain
      // dashes and so do snapshot names, so the split is ambiguous on the
      // filename alone: prefer the longest name that is actually a guest on
      // this host, and fall back to everything before the stamp (which is
      // what a tarball of an already-deleted guest looks like).
      const m = /^lxc-(.+)-(\d{8}T\d{6}Z)\.tar/.exec(filename);
      if (!m) continue;
      const middle = m[1];
      const guess = guests
        .filter((g) => middle === g || middle.startsWith(`${g}-`))
        .sort((a, b) => b.length - a.length)[0] || middle;
      const snapshot = guess === middle ? null : middle.slice(guess.length + 1);
      if (!NAME_RE.test(guess)) continue;
      const compression = filename.endsWith('.gz') ? 'gzip' : filename.endsWith('.tar') ? 'none' : 'zstd';
      // eslint-disable-next-line no-await-in-loop
      const st = await hostSh('stat -c "%s %Y" "$1/$2" 2>/dev/null', [dir, filename], { timeoutMs: 15000 }).catch(() => null);
      const [sizeStr, mtimeStr] = String(st?.stdout || '').trim().split(/\s+/);
      const size = Number(sizeStr);
      if (!Number.isFinite(size) || size <= 0) continue;
      const created = Number(mtimeStr) > 0 ? iso(Number(mtimeStr) * 1000) : iso(now());
      db().prepare(`
        INSERT INTO lxc_exports (container_name, snapshot_name, path, filename, compression, state, bytes_done, bytes_total, created_at, created_by, ready_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, 'adopted', ?, ?)
      `).run(guess, snapshot, `${dir}/${filename}`, filename, compression, size, size, created, created,
        iso(Date.parse(created) + EXPIRE_DAYS * 86400000));
      out.push({ container: guess, snapshot, filename, bytes: size });
    }
    return out;
  }

  /** For the progress banner: what is building now and what is waiting. */
  function queueStatus() {
    return {
      running: [...running.entries()].map(([id, live]) => ({
        ...get(id), started_at: iso(live.startedAt), bytes: live.lastBytes,
        stalled: now() - live.lastMovedAt > STALL_AFTER_MS,
      })).filter(Boolean),
      queued: queue.map((q) => get(q.id)).filter(Boolean),
      max_concurrent: MAX_CONCURRENT,
    };
  }

  return {
    prepare, list, get, rowById, remove, sweep, register, openForDownload, countDownload,
    queueStatus, estimateBytes, freeBytes, STATES,
  };
}
