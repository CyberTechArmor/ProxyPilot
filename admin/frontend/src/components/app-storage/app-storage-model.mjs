// Application storage — pure model (no React, no fetch). The pages keep their
// state in these shapes and the backend suite tests them directly
// (admin/backend/src/__tests__/app-storage-ui-model.test.js).
//
// Contract: DESIGN §2.3 (categories, statuses), §2.4 (accounting, estimate),
// §2.6 (check result), §3.1 (selection semantics), §3.4 (policy document).
//
// Selection rules:
// - Nothing is selected by default; a selection belongs to one check
//   (`selection.checkId`) and is empty again when a new check replaces it.
// - Only items with status "eligible" ("Can be cleaned up") can be selected.
// - Files, snapshots and exports are three separate lists. "All that can be
//   cleaned up" covers every eligible item in every category except Snapshots
//   and Exports; snapshots are chosen on their own and need an explicit
//   acknowledgement before a request can be built.
// - The request always names the final explicit ids; an empty selection
//   builds no request at all.

import {
  ALL_ELIGIBLE_SCOPE, CATEGORY_LABELS, CATEGORY_ORDER, ESTIMATE_NOTES, NOTHING_SELECTED, ACK_REQUIRED, FIGURE_LABELS,
} from './app-storage-text.js';

export { ALL_ELIGIBLE_SCOPE, NOTHING_SELECTED };

export const SEPARATE_CATEGORIES = new Set(['snapshots', 'exports']);
export const TERMINAL_CHECK_STATUSES = new Set(['complete', 'partial', 'failed']);
export const TERMINAL_CLEANUP_STATUSES = new Set(['succeeded', 'partial', 'failed', 'refused', 'cancelled']);
export const GROUP_MEMBER_LIMIT = 50;
export const CHECK_MAX_AGE_MS = 60 * 60 * 1000;
export const TARGET_KEY_RE = /^(application|project):([1-9][0-9]*)$/;

/* --------------------------------- targets -------------------------------- */

export function parseTargetKey(key) {
  const m = TARGET_KEY_RE.exec(String(key ?? ''));
  return m ? { kind: m[1], id: m[2], key: `${m[1]}:${m[2]}` } : null;
}

export function targetKeyOf(kind, id) {
  return parseTargetKey(`${kind}:${id}`)?.key ?? null;
}

export function storageHref(kind, id) {
  const key = targetKeyOf(kind, id);
  return key ? `/storage/applications?target=${encodeURIComponent(key)}` : '/storage/applications';
}

/* ------------------------------- check items ------------------------------- */

/** Which selection list an item belongs to: 'items' | 'snapshots' | 'exports'. */
export function listOf(item) {
  if (item?.category === 'snapshots' || item?.kind === 'snapshot') return 'snapshots';
  if (item?.category === 'exports' || item?.kind === 'export') return 'exports';
  return 'items';
}

/** Only "Can be cleaned up" items carry a checkbox. */
export function canSelect(item) {
  return Boolean(item) && item.status === 'eligible' && item.kind !== 'pseudo' && typeof item.id === 'string' && item.id.length > 0;
}

const INDEX = new WeakMap();
function itemIndex(check) {
  if (!check || typeof check !== 'object') return new Map();
  let idx = INDEX.get(check);
  if (!idx) {
    idx = new Map((Array.isArray(check.items) ? check.items : []).filter((i) => i && i.id).map((i) => [i.id, i]));
    INDEX.set(check, idx);
  }
  return idx;
}

export function itemById(check, id) {
  return itemIndex(check).get(id) ?? null;
}

const bytesOf = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const order = (key) => {
  const i = CATEGORY_ORDER.indexOf(key);
  return i < 0 ? CATEGORY_ORDER.length : i;
};

/** Categories in the fixed order with their items (largest first). */
/**
 * Categories in the fixed order with their items (largest first). Sizes are
 * split by where they live (WS1, contract 2026-10-21 §5): `allocatedBytes`,
 * `logicalBytes` and `eligibleBytes` are disk only; `memoryBytes` and
 * `eligibleMemoryBytes` are memory-backed items (such as /tmp); a host-wide
 * item shared by all applications (`sharedHost`) is counted in neither and
 * shown as `sharedHostBytes`. A check without the split is split here from
 * its items. On a pool that shares the host's disk the "not measured
 * individually" remainder is left out (it is the host's, not this container's).
 */
export function categoryRows(check) {
  const hidePseudo = Boolean(check?.totals?.sharedHostFilesystem);
  const items = (Array.isArray(check?.items) ? check.items : []).filter((i) => !(hidePseudo && i?.kind === 'pseudo'));
  const summaries = new Map((Array.isArray(check?.categories) ? check.categories : []).map((c) => [c.key, c]));
  const keys = new Set([...summaries.keys(), ...items.map((i) => i.category)]);
  const sum = (list, k = 'allocatedBytes') => list.reduce((n, i) => n + bytesOf(i[k]), 0);
  return [...keys].filter(Boolean).sort((a, b) => order(a) - order(b)).map((key) => {
    const own = items.filter((i) => i.category === key).sort((a, b) => bytesOf(b.allocatedBytes) - bytesOf(a.allocatedBytes));
    const s = summaries.get(key) ?? {};
    const eligible = own.filter(canSelect);
    const split = s.memoryBytes != null;
    const counted = own.filter((i) => !i.sharedHost);
    const disk = counted.filter((i) => !i.memoryBacked);
    const memory = counted.filter((i) => i.memoryBacked);
    const pseudoHidden = hidePseudo && (s.itemCount ?? 0) > own.length;
    return {
      key,
      label: s.label || CATEGORY_LABELS[key] || key,
      status: displayStatus(s.status || (own.length ? summarizeStatus(own) : 'empty'), own),
      allocatedBytes: split ? bytesOf(s.allocatedBytes) : sum(disk),
      logicalBytes: split ? bytesOf(s.logicalBytes) : sum(disk, 'logicalBytes'),
      memoryBytes: split ? bytesOf(s.memoryBytes) : sum(memory),
      sharedHostBytes: s.sharedHostBytes != null ? bytesOf(s.sharedHostBytes) : sum(own.filter((i) => i.sharedHost)),
      count: s.count ?? own.reduce((n, i) => n + (Number(i.files) || 0), 0),
      itemCount: pseudoHidden || s.itemCount == null ? own.length : s.itemCount,
      eligibleCount: eligible.length,
      eligibleBytes: split ? bytesOf(s.eligibleBytes) : sum(eligible.filter((i) => !i.memoryBacked)),
      eligibleMemoryBytes: s.eligibleMemoryBytes != null ? bytesOf(s.eligibleMemoryBytes) : sum(eligible.filter((i) => i.memoryBacked)),
      newestMtimeMs: s.newestMtimeMs ?? (own.reduce((m, i) => Math.max(m, Number(i.newestMtimeMs) || 0), 0) || null),
      precision: s.precision ?? (own.some((i) => i.precision === 'at-least') ? 'at-least' : 'exact'),
      separate: SEPARATE_CATEGORIES.has(key),
      items: own,
    };
  });
}

// "Some can be cleaned up" only when something in the category can be;
// a mix of protected and needs-a-look items reads "Needs a look".
function displayStatus(status, items) {
  if (status !== 'mixed' && status !== 'eligible') return status;
  if (items.some(canSelect)) return status;
  return items.some((i) => i.status === 'investigate') ? 'investigate' : 'protected';
}

function summarizeStatus(items) {
  const s = new Set(items.map((i) => i.status));
  if (s.size === 1) return [...s][0];
  if (s.has('eligible')) return 'mixed';
  return s.has('investigate') ? 'investigate' : 'protected';
}

/**
 * 'files' | 'folders' | 'entries' for a group: the check's own `memberKind`
 * (WS1, ws/check-fixes f7807cb6) when present, else from its members' kind.
 */
export function groupMemberNoun(item) {
  if (['files', 'folders', 'entries'].includes(item?.memberKind)) return item.memberKind;
  const kinds = new Set((Array.isArray(item?.members) ? item.members : []).map((m) => m?.kind).filter(Boolean));
  if (kinds.size === 1) {
    const [k] = kinds;
    if (k === 'file') return 'files';
    if (k === 'directory' || k === 'dir') return 'folders';
  }
  return 'entries';
}

/** An item's hint, unless it only repeats the "Uses memory, not disk" chip. */
export function itemHint(item) {
  const hint = typeof item?.hint === 'string' ? item.hint.trim() : '';
  if (!hint) return null;
  if (item.memoryBacked && /^uses memory, not disk\.?$/i.test(hint)) return null;
  return hint;
}

/** Members of a group item: the first `limit` and how many more there are. */
export function groupMembers(item, limit = GROUP_MEMBER_LIMIT) {
  const all = Array.isArray(item?.members) ? item.members : [];
  const total = Number.isFinite(Number(item?.memberCount)) ? Math.max(Number(item.memberCount), all.length) : all.length;
  const shown = all.slice(0, limit);
  return { shown, total, hidden: Math.max(0, total - shown.length) };
}

/* -------------------------------- selection -------------------------------- */

export function emptySelection(checkId = null) {
  // `categories`: categories chosen with their "Select all" control (for the
  // recorded scope only; the request always carries the explicit ids).
  return { checkId: checkId ?? null, items: [], snapshots: [], exports: [], categories: [], acknowledged: false };
}

/** The selection for this check: the given one if it belongs to it, else empty. */
export function selectionFor(check, selection) {
  const id = check?.checkId ?? null;
  if (!selection || selection.checkId !== id) return emptySelection(id);
  return selection;
}

/** Add (on=true) or remove ids; ids that cannot be selected are ignored. */
export function setSelected(check, selection, ids, on) {
  const sel = selectionFor(check, selection);
  const next = { ...sel, items: [...sel.items], snapshots: [...sel.snapshots], exports: [...sel.exports], categories: [...(sel.categories || [])] };
  for (const id of ids || []) {
    const item = itemById(check, id);
    if (!canSelect(item)) continue;
    const list = next[listOf(item)];
    const at = list.indexOf(id);
    if (on && at < 0) list.push(id);
    if (!on && at >= 0) list.splice(at, 1);
    if (!on) next.categories = next.categories.filter((k) => k !== item.category);
  }
  if (!next.snapshots.length) next.acknowledged = false;
  return next;
}

export const selectItem = (check, sel, id) => setSelected(check, sel, [id], true);
export const deselectItem = (check, sel, id) => setSelected(check, sel, [id], false);
export const toggleItem = (check, sel, id) => setSelected(check, sel, [id], !isSelected(selectionFor(check, sel), id));
export const selectMany = (check, sel, ids) => setSelected(check, sel, ids, true);

export function isSelected(selection, id) {
  if (!selection) return false;
  return selection.items.includes(id) || selection.snapshots.includes(id) || selection.exports.includes(id);
}

/** Ids of every "Can be cleaned up" item in one category. */
export function categoryIds(check, key) {
  return (check?.items || []).filter((i) => i.category === key && canSelect(i)).map((i) => i.id);
}

export function selectCategory(check, sel, key) {
  const ids = categoryIds(check, key);
  const next = setSelected(check, sel, ids, true);
  return ids.length && !next.categories.includes(key) ? { ...next, categories: [...next.categories, key] } : next;
}
export const deselectCategory = (check, sel, key) => setSelected(check, sel, categoryIds(check, key), false);

/** Every "Can be cleaned up" item in every category except Snapshots and Exports. */
export function allEligibleIds(check) {
  return (check?.items || [])
    .filter((i) => canSelect(i) && listOf(i) === 'items' && !SEPARATE_CATEGORIES.has(i.category))
    .map((i) => i.id);
}

export const selectAllEligible = (check, sel) => setSelected(check, sel, allEligibleIds(check), true);

export function allSnapshotIds(check) {
  return (check?.items || []).filter((i) => canSelect(i) && listOf(i) === 'snapshots').map((i) => i.id);
}

export const selectAllSnapshots = (check, sel) => setSelected(check, sel, allSnapshotIds(check), true);

export function clearSelection(check) {
  return emptySelection(check?.checkId ?? null);
}

export function acknowledgeSnapshots(selection, value) {
  return { ...selection, acknowledged: Boolean(value) && selection.snapshots.length > 0 };
}

export function selectedCount(selection) {
  return selection ? selection.items.length + selection.snapshots.length + selection.exports.length : 0;
}

export function needsAcknowledgement(selection) {
  return Boolean(selection) && selection.snapshots.length > 0;
}

/** 'none' | 'some' | 'all' for a category, or 'unavailable' when nothing in it can be selected. */
export function categorySelectionState(check, selection, key) {
  const ids = categoryIds(check, key);
  if (!ids.length) return 'unavailable';
  const n = ids.filter((id) => isSelected(selection, id)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

/**
 * What the final file selection covers, recorded for the audit only:
 * 'all-eligible' when it is exactly every "Can be cleaned up" item outside
 * Snapshots and Exports; 'categories' when it is exactly the categories chosen
 * with their "Select all" control; otherwise 'items'.
 */
export function selectionScope(check, selection) {
  const sel = selectionFor(check, selection);
  const chosen = new Set(sel.items);
  if (!chosen.size) return 'items';
  const all = allEligibleIds(check);
  if (all.length && all.length === chosen.size && all.every((id) => chosen.has(id))) return 'all-eligible';
  const picked = (sel.categories || []).filter((k) => !SEPARATE_CATEGORIES.has(k));
  if (!picked.length) return 'items';
  const covered = new Set(picked.flatMap((k) => categoryIds(check, k)));
  const exact = covered.size === chosen.size && [...covered].every((id) => chosen.has(id));
  return exact ? 'categories' : 'items';
}

/**
 * Build the POST body for the cleanup, or say why none is sent.
 * → { send: false, reason: 'nothing-selected'|'acknowledgement-required'|'no-check', message }
 * → { send: true, body: { checkId, items, snapshots, exports, acknowledgeSnapshotLoss, scope } }
 */
export function cleanupRequest(check, selection) {
  if (!check?.checkId) return { send: false, reason: 'no-check', message: NOTHING_SELECTED };
  const sel = selectionFor(check, selection);
  const keep = (list) => sel[list].filter((id) => {
    const item = itemById(check, id);
    return canSelect(item) && listOf(item) === list;
  });
  const items = keep('items');
  const snapshots = keep('snapshots');
  const exports = keep('exports');
  if (!items.length && !snapshots.length && !exports.length) {
    return { send: false, reason: 'nothing-selected', message: NOTHING_SELECTED };
  }
  if (snapshots.length && !sel.acknowledged) {
    return { send: false, reason: 'acknowledgement-required', message: ACK_REQUIRED };
  }
  return {
    send: true,
    body: {
      checkId: check.checkId,
      items,
      snapshots,
      exports,
      acknowledgeSnapshotLoss: snapshots.length > 0 && sel.acknowledged === true,
      scope: selectionScope(check, { ...sel, items }),
    },
  };
}

/** The selection grouped by category in display order, for the review list. */
export function reviewGroups(check, selection) {
  const sel = selectionFor(check, selection);
  const ids = [...sel.items, ...sel.snapshots, ...sel.exports];
  const groups = new Map();
  for (const id of ids) {
    const item = itemById(check, id);
    if (!item) continue;
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  return [...groups].sort(([a], [b]) => order(a) - order(b)).map(([key, items]) => ({
    key, label: CATEGORY_LABELS[key] || key, items,
  }));
}

/** Recoverable space of one item: an explicit estimate (journal vacuum) or its size on disk. */
export function recoverableBytes(item) {
  if (item?.recoverableBytes != null && Number.isFinite(Number(item.recoverableBytes))) return bytesOf(item.recoverableBytes);
  return bytesOf(item?.allocatedBytes);
}

/**
 * Client-side estimate of the selection (DESIGN §2.4 estimateSelection):
 * disk and memory separately, a precision word and the notes to show.
 */
export function estimateSelection(check, selection) {
  const sel = selectionFor(check, selection);
  let diskBytes = 0; let memoryBytes = 0; let snapshotBytes = 0; let exportBytes = 0;
  let atLeast = false; let estimate = false; let journal = false;
  for (const id of sel.items) {
    const item = itemById(check, id);
    if (!canSelect(item)) continue;
    const b = recoverableBytes(item);
    if (item.memoryBacked) memoryBytes += b; else diskBytes += b;
    if (item.precision === 'at-least') atLeast = true;
    if (item.precision === 'estimate' || item.kind === 'journal' || item.action === 'vacuum-journal') estimate = true;
    if (item.kind === 'journal' || item.action === 'vacuum-journal') journal = true;
  }
  const snapshotsInCheck = allSnapshotIds(check);
  for (const id of sel.snapshots) snapshotBytes += recoverableBytes(itemById(check, id));
  const allSnapshots = snapshotsInCheck.length > 0 && snapshotsInCheck.every((id) => sel.snapshots.includes(id));
  const held = bytesOf(check?.totals?.dataset?.snapshotsBytes);
  if (allSnapshots && held > snapshotBytes) { snapshotBytes = held; estimate = true; }
  // Several snapshots (not all) free at least their own figures together:
  // space they share is in none of them (review 16, WS1 §8).
  const snapshotsTogether = sel.snapshots.length >= 2 && !allSnapshots;
  if (snapshotsTogether) atLeast = true;
  else if (sel.snapshots.length) estimate = true;
  for (const id of sel.exports) exportBytes += recoverableBytes(itemById(check, id));
  diskBytes += snapshotBytes + exportBytes;
  const notes = [];
  const anySnapshotsInCheck = (check?.items || []).some((i) => listOf(i) === 'snapshots');
  if (sel.items.length && anySnapshotsInCheck && !allSnapshots) notes.push(ESTIMATE_NOTES.snapshotsHold);
  if (allSnapshots && sel.snapshots.length) notes.push(ESTIMATE_NOTES.allSnapshots);
  if (snapshotsTogether) notes.push(ESTIMATE_NOTES.snapshotsTogether);
  if (memoryBytes > 0) notes.push(ESTIMATE_NOTES.memory(formatBytes(memoryBytes)));
  if (atLeast) notes.push(ESTIMATE_NOTES.partial);
  if (journal) notes.push(ESTIMATE_NOTES.journal);
  return {
    diskBytes, memoryBytes, snapshotBytes, exportBytes,
    precision: atLeast && !estimate ? 'at-least' : 'about',
    notes,
  };
}

/**
 * A figure's plain label by its source (WS1 FIGURE_SOURCES keys). The
 * server's own labels name tools (df, Incus, ZFS), so an unknown source gets
 * no label rather than those words (review N4).
 */
export function figureLabel(source) {
  return FIGURE_LABELS[source] || null;
}

/** "about 1.4 GB" / "at least 1.4 GB of disk and 1.1 GB of memory". */
export function estimateText(est) {
  if (!est) return '';
  const word = est.precision === 'at-least' ? 'at least' : 'about';
  if (est.memoryBytes > 0 && est.diskBytes > 0) return `${word} ${formatBytes(est.diskBytes)} of disk and ${formatBytes(est.memoryBytes)} of memory`;
  if (est.memoryBytes > 0) return `${word} ${formatBytes(est.memoryBytes)} of memory`;
  return `${word} ${formatBytes(est.diskBytes)}`;
}

/** The selection bar's sentence. */
export function selectionSummary(check, selection) {
  const n = selectedCount(selectionFor(check, selection));
  if (!n) return '0 selected';
  return `${n} selected · ${estimateText(estimateSelection(check, selection))} can be recovered`;
}

/* -------------------------------- formatting ------------------------------- */

/** Decimal units, as operators read disk sizes ("1.4 GB", "820 MB", "12 bytes"). */
export function formatBytes(n) {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v) || v < 0) return '—';
  if (v < 1000) return `${Math.round(v)} ${Math.round(v) === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let x = v / 1000; let i = 0;
  while (x >= 999.5 && i < units.length - 1) { x /= 1000; i += 1; }
  const s = x < 99.95 ? x.toFixed(1).replace(/\.0$/, '') : String(Math.round(x));
  return `${s} ${units[i]}`;
}

/** A size with its precision word: "1.4 GB", "at least 1.4 GB", "about 1.4 GB". */
export function formatSize(bytes, precision) {
  const s = formatBytes(bytes);
  if (s === '—') return s;
  if (precision === 'at-least') return `at least ${s}`;
  if (precision === 'estimate') return `about ${s}`;
  return s;
}

function toMs(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function formatDateTime(v) {
  const t = toMs(v);
  if (t == null) return '—';
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatAge(v, now = Date.now()) {
  const t = toMs(v);
  if (t == null) return '—';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

export function checkIsStale(check, now = Date.now()) {
  const t = toMs(check?.finishedAt ?? check?.startedAt);
  return t != null && now - t > CHECK_MAX_AGE_MS;
}

export const isCheckRunning = (status) => status === 'running' || status === 'queued';

// Job events that are bookkeeping, not something a person needs to read.
const QUIET_EVENT_KINDS = new Set(['created', 'claimed', 'checkpoint', 'heartbeat', 'lease', 'progress', 'fence']);

/** The cleanup job's events worth showing: plain messages only (no phase codes or bookkeeping). */
export function cleanupEvents(job) {
  return (Array.isArray(job?.events) ? job.events : [])
    .filter((e) => e && typeof e.message === 'string' && e.message.trim() && !QUIET_EVENT_KINDS.has(e.kind) && !/^[a-z_]+(:[a-z_]+)+$/.test(e.message.trim()))
    .slice(-20);
}

/**
 * The measured reclaim by kind (WS2's result: reclaimed.guestBytes = files on
 * disk in the container, memoryBytes = memory-backed folders such as /tmp,
 * null when none was cleaned; datasetBytes = the pool, which is where
 * deleted snapshots show). → [{ key: 'disk'|'memory'|'pool', bytes }]
 * Memory is listed when it was measured; the pool when snapshots were
 * deleted or it moved.
 */
export function reclaimedParts(reclaimed, { snapshotsDeleted = false } = {}) {
  const r = reclaimed || {};
  const parts = [];
  const disk = reclaimedFigure(r.guestBytes);
  if (disk != null) parts.push({ key: 'disk', bytes: disk });
  const memory = reclaimedFigure(r.memoryBytes);
  if (memory != null) parts.push({ key: 'memory', bytes: memory });
  const pool = reclaimedFigure(r.datasetBytes);
  if (pool != null && (pool > 0 || snapshotsDeleted)) parts.push({ key: 'pool', bytes: pool });
  return parts;
}

/** Space reclaimed as measured: a negative or missing figure is reported as no change measured yet. */
export function reclaimedFigure(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return null;
  return Math.max(0, Number(bytes));
}
export const isCheckFinished = (status) => TERMINAL_CHECK_STATUSES.has(status);
export const isCleanupFinished = (status) => TERMINAL_CLEANUP_STATUSES.has(status);

/** Header figures: used / available / limit, on disk vs file sizes, snapshot-held, memory-backed. */
export function headerFigures(check) {
  const t = check?.totals || {};
  const cats = (check?.categories || []).filter((c) => !SEPARATE_CATEGORIES.has(c.key));
  const sumCats = (k) => cats.reduce((n, c) => n + bytesOf(c[k]), 0);
  return {
    usedBytes: t.guest?.usedBytes ?? null,
    availableBytes: t.guest?.availableBytes ?? null,
    totalBytes: t.guest?.totalBytes ?? null,
    limitBytes: t.limit?.bytes ?? null,
    onDiskBytes: t.dataset?.usedBytes ?? (cats.length ? sumCats('allocatedBytes') : null),
    fileSizeBytes: t.dataset?.logicalUsedBytes ?? (cats.length ? sumCats('logicalBytes') : null),
    snapshotsBytes: t.dataset?.snapshotsBytes ?? null,
    memoryBacked: Array.isArray(t.memoryBacked) ? t.memoryBacked.filter((m) => m && m.mount) : [],
    unattributedBytes: t.unattributedBytes ?? null,
    // WS1 §6: on a dir/btrfs pool the container sees the host's shared disk.
    sharedHost: Boolean(t.sharedHostFilesystem || t.guest?.shared),
    // The container's own figure on its pool (with snapshots); on a shared
    // host disk it is the "Used" shown (review M10).
    containerUsedBytes: t.usageBytes ?? null,
    usedSource: t.guest?.source ?? null,
    usedSourceLabel: t.guest?.label ?? null,
    onDiskSource: t.dataset?.source ?? null,
    usedPct: t.guest?.usedBytes != null && (t.limit?.bytes || t.guest?.totalBytes)
      ? Math.round((100 * t.guest.usedBytes) / (t.limit?.bytes || t.guest.totalBytes)) : null,
  };
}

/* --------------------------------- policy ---------------------------------- */

export const RULE_KEYS = ['releases', 'snapshots', 'workspaces', 'caches', 'tempFiles', 'testArtifacts', 'logs', 'history'];

// Editable numeric fields per rule with their ranges: the same bounds as the
// backend's policy schema (lib/app-storage/policy.js validatePolicy), so a
// value the form accepts is never refused by the server.
export const RULE_FIELDS = {
  releases: [{ key: 'keepReleases', min: 2, max: 20 }],
  snapshots: [{ key: 'keep', min: 1, max: 1000 }],
  workspaces: [{ key: 'abandonedAfterHours', min: 1, max: 720 }],
  caches: [{ key: 'maxAgeDays', min: 1, max: 3650 }],
  tempFiles: [{ key: 'maxAgeDays', min: 1, max: 3650 }],
  testArtifacts: [{ key: 'maxAgeDays', min: 1, max: 3650 }],
  logs: [{ key: 'rotatedMaxAgeDays', min: 1, max: 3650 }, { key: 'journalMaxMB', min: 16, max: 65536 }],
  history: [{ key: 'keepNewest', min: 1, max: 100 }, { key: 'maxAgeDays', min: 1, max: 3650 }],
};

// Alert thresholds in GB, bounded like the backend (warnBytes 1e8..1e15,
// growthBytes 1e7..1e15, growthWindowHours 1..720).
export const ALERT_LIMITS = { warnGb: { min: 0.1, max: 1e6 }, growthGb: { min: 0.01, max: 1e6 }, growthWindowHours: { min: 1, max: 720 } };

/**
 * 'on' | 'proposed' | 'off'. A rule that is off is "proposed" when the server
 * lists it in `proposedRules` (optional, see contract-changes.md); without
 * that list, while the policy is still the proposal for an existing target
 * (source defaults-existing or preserved).
 */
export function ruleState(rule, source, proposed) {
  if (rule?.enabled) return 'on';
  if (typeof proposed === 'boolean') return proposed ? 'proposed' : 'off';
  return source === 'defaults-existing' || source === 'preserved' ? 'proposed' : 'off';
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** Field values of one rule as editable strings. */
export function ruleForm(policy, ruleKey) {
  const rule = policy?.rules?.[ruleKey] || {};
  return Object.fromEntries((RULE_FIELDS[ruleKey] || []).map((f) => [f.key, rule[f.key] == null ? '' : String(rule[f.key])]));
}

/** Validation messages per field ({} when valid). Whole numbers within the rule's range. */
export function validateRuleForm(ruleKey, form) {
  const errors = {};
  for (const f of RULE_FIELDS[ruleKey] || []) {
    const raw = String(form?.[f.key] ?? '').trim();
    const n = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(n) || n < f.min || (f.max != null && n > f.max)) errors[f.key] = { min: f.min, max: f.max };
  }
  return errors;
}

/** The policy document with one rule's values (and optionally its on/off state) replaced. */
export function withRule(policy, ruleKey, form, enabled) {
  const next = clone(policy) || { version: 1, rules: {}, alerts: {} };
  next.rules = next.rules || {};
  const rule = { ...(next.rules[ruleKey] || {}) };
  for (const f of RULE_FIELDS[ruleKey] || []) {
    if (form && form[f.key] != null && String(form[f.key]).trim() !== '') rule[f.key] = Number(form[f.key]);
  }
  if (enabled != null) rule.enabled = Boolean(enabled);
  next.rules[ruleKey] = rule;
  return next;
}

export function ruleFormChanged(policy, ruleKey, form) {
  const saved = ruleForm(policy, ruleKey);
  return Object.keys(saved).some((k) => String(form?.[k] ?? '').trim() !== saved[k]);
}

export const gbToBytes = (gb) => Math.round(Number(gb) * 1e9);
export const bytesToGb = (b) => (b == null || !Number.isFinite(Number(b)) ? '' : String(Number((Number(b) / 1e9).toFixed(2))));

export function alertsForm(policy) {
  const a = policy?.alerts || {};
  return {
    enabled: a.enabled !== false,
    warnGb: bytesToGb(a.warnBytes),
    growthGb: bytesToGb(a.growthBytes),
    growthWindowHours: a.growthWindowHours == null ? '' : String(a.growthWindowHours),
  };
}

export function validateAlertsForm(form) {
  const errors = {};
  const inRange = (v, { min, max }) => { const raw = String(v ?? '').trim(); const n = Number(raw); return raw !== '' && Number.isFinite(n) && n >= min && n <= max; };
  if (!inRange(form?.warnGb, ALERT_LIMITS.warnGb)) errors.warnGb = { gb: true, ...ALERT_LIMITS.warnGb };
  if (!inRange(form?.growthGb, ALERT_LIMITS.growthGb)) errors.growthGb = { gb: true, ...ALERT_LIMITS.growthGb };
  const h = String(form?.growthWindowHours ?? '').trim();
  if (!/^[0-9]+$/.test(h) || Number(h) < 1 || Number(h) > 720) errors.growthWindowHours = { ...ALERT_LIMITS.growthWindowHours };
  return errors;
}

export function withAlerts(policy, form) {
  const next = clone(policy) || { version: 1, rules: {}, alerts: {} };
  next.alerts = {
    ...(next.alerts || {}),
    enabled: Boolean(form.enabled),
    warnBytes: gbToBytes(form.warnGb),
    growthBytes: gbToBytes(form.growthGb),
    growthWindowHours: Number(form.growthWindowHours),
  };
  return next;
}

export function alertsFormChanged(policy, form) {
  const saved = alertsForm(policy);
  return saved.enabled !== Boolean(form.enabled) || ['warnGb', 'growthGb', 'growthWindowHours'].some((k) => Number(saved[k]) !== Number(form[k]));
}

/**
 * The server's note on an effect, unless it only restates the item count and
 * size the preview already shows ("Would remove 3 items, about 32.8 kB, now.",
 * "Nothing to remove now.").
 */
export function effectNote(effect) {
  const note = typeof effect?.note === 'string' ? effect.note.trim() : '';
  if (!note || /^(would remove \d|nothing to remove|nothing would be removed)/i.test(note)) return null;
  return note;
}

/** The effects-preview entry of one rule (DESIGN §3.6), or null. */
export function effectFor(effects, ruleKey) {
  const list = Array.isArray(effects) ? effects : effects && typeof effects === 'object' ? Object.entries(effects).map(([rule, e]) => ({ rule, ...e })) : [];
  return list.find((e) => e && e.rule === ruleKey) || null;
}
