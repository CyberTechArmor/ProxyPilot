// Storage accounting (pure): totals for a check, per-category summaries and
// the recoverable estimate of a selection. Every figure says how precise it
// is: `exact` (measured now), `at-least` (a walk stopped at its budget) or
// `estimate` (what is left unattributed, what a journal vacuum frees, what
// deleting every snapshot returns).

import { CATEGORIES, SEPARATE_CATEGORIES, worsePrecision } from './categories.js';

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Decimal units, one decimal: 10.4 GB, 850 MB, 12 KB, 0 B (the dashboard's spelling). */
export function formatBytes(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let x = v;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i += 1; }
  const s = i === 0 ? String(Math.round(x)) : x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
  return `${s} ${units[i]}`;
}

/** Items that sit on the guest's root filesystem (what `df /` counts). */
function onRootFs(it, rootDev) {
  if (it.location !== 'guest' || it.memoryBacked || it.crossesDevice) return false;
  if (['pseudo', 'snapshot', 'export'].includes(it.kind)) return false;
  if (rootDev == null || it.dev == null) return true;
  return Number(it.dev) === Number(rootDev);
}

/**
 * totals = { guest: { totalBytes, usedBytes, availableBytes } (statfs '/' in
 * the guest: what the guest sees, = "referenced" on ZFS), usageBytes (Incus
 * root usage, = ZFS "used"), limit, dataset, memoryBacked, measuredBytes,
 * unattributedBytes, precision }
 */
/**
 * Where each "used" figure comes from, in plain words, so a page can say
 * which one it shows (they differ: the container's own filesystem view, the
 * pool's view including snapshots, the dataset).
 */
export const FIGURE_SOURCES = Object.freeze({
  'container-df': "What the container's own filesystem reports (as df shows it inside the container)",
  'shared-host-df': 'The host filesystem this container shares with other containers and the host itself; it is not this container\'s own use',
  'incus-root-usage': 'Space the container takes on its storage pool, including its snapshots (as Incus reports it)',
  'zfs-dataset': "The container's ZFS dataset: used includes snapshots, referenced is what the container sees",
  'monitor-sample': 'The latest 15-minute reading of the space the container takes on its storage pool, including its snapshots',
});

/** Storage drivers whose containers see the shared host filesystem in statfs('/'). */
export const SHARED_FS_DRIVERS = Object.freeze(['dir', 'btrfs']);

export function computeTotals({ facts = null, host = null, items = [] } = {}) {
  const rootFs = facts?.fs?.find((f) => f.path === '/') || null;
  // On a dir or btrfs pool, statfs('/') inside the container is the whole host
  // filesystem: shown as such, and never used to estimate what is unmeasured.
  const shared = !!rootFs && SHARED_FS_DRIVERS.includes(String(host?.poolDriver || '').toLowerCase());
  const guestSource = shared ? 'shared-host-df' : 'container-df';
  const guest = rootFs ? { totalBytes: n(rootFs.totalBytes), usedBytes: Math.max(0, n(rootFs.totalBytes) - n(rootFs.freeBytes)), availableBytes: n(rootFs.availBytes), precision: 'exact', shared, source: guestSource, label: FIGURE_SOURCES[guestSource] } : null;
  const memSeen = new Set();
  const memoryBacked = [];
  for (const f of facts?.fs || []) {
    if (!['tmpfs', 'ramfs'].includes(f.fstype) || memSeen.has(f.mount)) continue;
    memSeen.add(f.mount);
    memoryBacked.push({ mount: f.mount, usedBytes: Math.max(0, n(f.totalBytes) - n(f.freeBytes)), totalBytes: n(f.totalBytes) });
  }
  let measured = 0; let precision = 'exact';
  for (const it of items) {
    if (!onRootFs(it, facts?.rootDev)) continue;
    measured += n(it.allocatedBytes);
    if (it.precision === 'at-least') precision = 'at-least';
  }
  const d = host?.dataset || null;
  return {
    guest,
    sharedHostFilesystem: shared,
    usageBytes: host?.usageBytes ?? null,
    usageSource: host?.usageBytes != null ? 'incus-root-usage' : null,
    usageLabel: host?.usageBytes != null ? FIGURE_SOURCES['incus-root-usage'] : null,
    limit: host?.limit || { bytes: null, source: null },
    dataset: d ? { name: host.datasetName || null, usedBytes: d.usedBytes, referencedBytes: d.referencedBytes, snapshotsBytes: d.snapshotsBytes, datasetBytes: d.datasetBytes, logicalUsedBytes: d.logicalUsedBytes, compressRatio: d.compressRatio, availableBytes: d.availableBytes, precision: 'exact', source: 'zfs-dataset', label: FIGURE_SOURCES['zfs-dataset'] } : null,
    memoryBacked,
    measuredBytes: facts ? measured : null,
    measuredPrecision: facts ? precision : null,
    unattributedBytes: guest && !shared ? Math.max(0, guest.usedBytes - measured) : null,
    unattributedPrecision: guest && !shared ? 'estimate' : null,
  };
}

// 'mixed' only when something in it can be cleaned up; protected and
// needs-a-look together read as needing a look.
function categoryStatus(items) {
  if (!items.length) return 'empty';
  const set = new Set(items.map((it) => it.status));
  if (set.size === 1) return items[0].status;
  if (set.has('eligible')) return 'mixed';
  return set.has('investigate') ? 'investigate' : 'protected';
}

const eligibleBytesOf = (it) => (it.kind === 'journal' ? n(it.recoverableBytes) : n(it.allocatedBytes));

/** Per category, in display order. */
export function summarizeCategories(items) {
  return CATEGORIES.map((c) => {
    const list = items.filter((it) => it.category === c.key);
    let precision = 'exact';
    let newest = null;
    for (const it of list) {
      precision = worsePrecision(precision, it.precision);
      if (Number.isFinite(it.newestMtimeMs) && (newest == null || it.newestMtimeMs > newest)) newest = it.newestMtimeMs;
    }
    const eligible = list.filter((it) => it.status === 'eligible');
    // Disk figures are disk only: memory-backed (tmpfs) items are counted apart.
    // A host-wide shared item (a transfer bundle no application name claims) is
    // listed but belongs to no single application: kept out of the totals.
    const own = list.filter((it) => !it.sharedHost);
    const disk = own.filter((it) => !it.memoryBacked);
    const memory = own.filter((it) => it.memoryBacked);
    return {
      key: c.key,
      label: c.label,
      status: categoryStatus(list),
      logicalBytes: disk.reduce((s, it) => s + n(it.logicalBytes), 0),
      allocatedBytes: disk.reduce((s, it) => s + n(it.allocatedBytes), 0),
      memoryBytes: memory.reduce((s, it) => s + n(it.allocatedBytes), 0),
      sharedHostBytes: list.filter((it) => it.sharedHost).reduce((s, it) => s + n(it.allocatedBytes), 0),
      count: list.reduce((s, it) => s + (it.kind === 'group' ? n(it.memberCount) : ['snapshot', 'export', 'journal', 'pseudo'].includes(it.kind) ? 1 : Math.max(1, n(it.files))), 0),
      itemCount: list.length,
      eligibleCount: eligible.length,
      eligibleBytes: eligible.filter((it) => !it.memoryBacked).reduce((s, it) => s + eligibleBytesOf(it), 0),
      eligibleMemoryBytes: eligible.filter((it) => it.memoryBacked).reduce((s, it) => s + eligibleBytesOf(it), 0),
      newestMtimeMs: newest,
      precision,
      separate: SEPARATE_CATEGORIES.includes(c.key),
    };
  });
}

/**
 * The recoverable estimate of a selection (ids from one check):
 * deduped allocated bytes of the selected file items (memory-backed counted
 * apart), journal usage − target, each selected snapshot's own bytes (or the
 * dataset's snapshot-held total, "about", when every snapshot is selected),
 * and export sizes. Notes say what the figure does and does not mean.
 */
export function estimateSelection(check, { items = [], snapshots = [], exports = [] } = {}) {
  const byId = new Map((check?.items || []).map((it) => [it.id, it]));
  const out = { count: 0, bytes: 0, diskBytes: 0, memoryBytes: 0, snapshotBytes: 0, exportBytes: 0, logicalBytes: 0, hardLinkedBytes: 0, precision: 'exact', notes: [], byCategory: [], unknownIds: [], notEligible: [] };
  const seen = new Set();
  const cats = new Map();
  const take = (id, expect) => {
    if (seen.has(id)) return null;
    seen.add(id);
    const it = byId.get(id);
    if (!it) { out.unknownIds.push(id); return null; }
    const ok = expect === 'items' ? !SEPARATE_CATEGORIES.includes(it.category) : it.category === expect;
    if (!ok || it.status !== 'eligible') { out.notEligible.push({ id, label: it.label, reason: it.status !== 'eligible' ? it.reason : 'This entry belongs in another list.' }); return null; }
    return it;
  };
  let anyPartial = false;
  const add = (it, bytes) => {
    out.count += 1;
    if (it.precision === 'at-least') anyPartial = true;
    const c = cats.get(it.category) || { key: it.category, count: 0, bytes: 0 };
    c.count += 1; c.bytes += bytes; cats.set(it.category, c);
    out.precision = worsePrecision(out.precision, it.precision);
  };
  let memorySelected = false; let journalSelected = false; let hardLinked = 0;
  for (const id of items) {
    const it = take(id, 'items'); if (!it) continue;
    const bytes = eligibleBytesOf(it);
    if (it.kind === 'journal') { journalSelected = true; out.precision = worsePrecision(out.precision, 'estimate'); }
    if (Number(it.hardLinkedBytes) > 0) { hardLinked += Number(it.hardLinkedBytes); out.precision = worsePrecision(out.precision, 'estimate'); }
    if (it.memoryBacked) { out.memoryBytes += bytes; memorySelected = true; } else out.diskBytes += bytes;
    out.logicalBytes += it.kind === 'journal' ? bytes : n(it.logicalBytes);
    add(it, bytes);
  }
  const allSnaps = (check?.items || []).filter((it) => it.category === 'snapshots');
  const pickedSnaps = [];
  for (const id of snapshots) { const it = take(id, 'snapshots'); if (it) pickedSnaps.push(it); }
  let snapBytes = pickedSnaps.reduce((s, it) => s + n(it.allocatedBytes), 0);
  const everySnapshot = pickedSnaps.length > 0 && pickedSnaps.length === allSnaps.length;
  const held = n(check?.totals?.dataset?.snapshotsBytes);
  if (everySnapshot && held > snapBytes) {
    snapBytes = held;
    out.notes.push('Every snapshot is selected, so the space all of them hold together is counted (about).');
  }
  if (pickedSnaps.length) out.precision = worsePrecision(out.precision, everySnapshot ? 'estimate' : 'exact');
  for (const it of pickedSnaps) add(it, n(it.allocatedBytes));
  if (everySnapshot && cats.has('snapshots')) cats.get('snapshots').bytes = snapBytes;
  out.snapshotBytes = snapBytes;
  for (const id of exports) { const it = take(id, 'exports'); if (!it) continue; out.exportBytes += n(it.allocatedBytes); add(it, n(it.allocatedBytes)); }
  out.bytes = out.diskBytes + out.memoryBytes + out.snapshotBytes + out.exportBytes;
  out.hardLinkedBytes = hardLinked;
  out.byCategory = CATEGORIES.filter((c) => cats.has(c.key)).map((c) => ({ ...cats.get(c.key), label: c.label }));
  const fileItems = out.count - pickedSnaps.length - (out.byCategory.find((c) => c.key === 'exports')?.count || 0);
  if (fileItems > 0 && allSnaps.length > 0 && !everySnapshot) out.notes.push('Space held by snapshots is only returned after those snapshots are deleted.');
  if (memorySelected) out.notes.push(`Memory, not disk: ${formatBytes(out.memoryBytes)} of this is temporary files held in memory.`);
  if (journalSelected) out.notes.push('The system journal figure is an estimate of what trimming it to its limit frees.');
  if (anyPartial) out.notes.push('Some sizes are lower bounds because their measurement stopped early.');
  if (hardLinked > 0) out.notes.push(`About ${formatBytes(hardLinked)} of this is in files that also exist elsewhere under another name (hard links); that space is freed only when every copy is removed, so the figure is an estimate.`);
  return out;
}
