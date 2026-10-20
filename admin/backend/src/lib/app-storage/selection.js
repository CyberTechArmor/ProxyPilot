// Application storage — the cleanup SELECTION, pure (DESIGN §3.1, §3.3).
//
// A cleanup request names item ids only; every path, identity and action
// comes from the stored check. This module decides whether a request may be
// approved against that check, copies the approved items out of it (the
// cleanup row's selection), estimates what they hold, and names the
// directories each item may be removed from (the cleanup program refuses
// anything outside them). Nothing here reads a clock, a database or a disk.

import path from 'node:path';

export const CHECK_MAX_AGE_MS = 60 * 60 * 1000;
export const MAX_IDS = 5000;
export const SCOPES = Object.freeze(['items', 'categories', 'all-eligible']);
export const SEPARATE_CATEGORIES = Object.freeze(['snapshots', 'exports']);
// Data-farthest first: what is most obviously regenerable goes first, so a
// stop condition met half-way leaves the more valuable categories untouched.
export const REMOVAL_ORDER = Object.freeze(['temp', 'caches', 'logs', 'history', 'test_reports', 'archives', 'workspaces', 'releases']);
export const FILE_ACTIONS = Object.freeze(['remove', 'remove-release', 'vacuum-journal']);
export const NOTHING_SELECTED = 'Nothing was selected, so nothing was changed.';
export const ALL_ELIGIBLE_SCOPE_TEXT = 'Every item marked "Can be cleaned up" in this check, in every category except Snapshots and Exports.';
export const HOST_TRANSFER_ROOT = '/var/lib/proxypilot/application-release-transfers';
export const MIN_JOURNAL_BYTES = 16 * 1024 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const ATTEMPT_RE = /^[a-f0-9-]{36}-[1-9][0-9]*$/;
const BUNDLE_RE = /^[a-f0-9-]{36}-[1-9][0-9]*\.bundle$/;
const RELEASE_RE = /^[a-f0-9]{40}-p[1-9][0-9]*-[a-f0-9-]{36}$/;
const REPORT_RE = /^(test-results|playwright-report|coverage|\.nyc_output)$/;
const ANY_NAME = /^[^/\0]{1,255}$/;
const DATABASE_DIRS = Object.freeze(['/var/lib/postgresql', '/var/lib/mysql', '/var/lib/redis', '/var/lib/mongodb']);

export class SelectionError extends Error {
  constructor(code, status, message, details = null) {
    super(message);
    this.name = 'SelectionError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
    // NOT_ELIGIBLE: the offending ids with their reasons, where the route
    // reads them (error.items; contract-changes.md, WS3 item 5).
    if (details?.items) this.items = details.items;
  }
}

export const isSnapshotItem = item => item?.kind === 'snapshot' || item?.category === 'snapshots' || item?.action === 'delete-snapshot';
export const isExportItem = item => item?.kind === 'export' || item?.category === 'exports' || item?.action === 'delete-export';
const isFileItem = item => !isSnapshotItem(item) && !isExportItem(item);
const itemsOf = check => (Array.isArray(check?.items) ? check.items : []);
const checkIdOf = check => check?.checkId ?? check?.id ?? null;
const finishedAtOf = check => check?.finishedAt ?? check?.finished_at ?? check?.startedAt ?? check?.started_at ?? null;

// scopeItemIds(check, { scope, categories }) → the ids a scope stands for.
// "All eligible" is every eligible item outside Snapshots and Exports;
// selected categories are every eligible item in them. Restore points and
// copies are never part of a scope: they have their own explicit selection.
export function scopeItemIds(check, { scope = 'all-eligible', categories = [] } = {}) {
  const wanted = new Set(categories);
  return itemsOf(check)
    .filter(item => item.status === 'eligible' && isFileItem(item) && !SEPARATE_CATEGORIES.includes(item.category))
    .filter(item => scope === 'all-eligible' || (scope === 'categories' && wanted.has(item.category)))
    .map(item => item.id);
}

export const snapshotItemIds = check => itemsOf(check).filter(item => item.status === 'eligible' && isSnapshotItem(item)).map(item => item.id);

function idList(name, value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_IDS || value.some(id => typeof id !== 'string' || !ID_RE.test(id))) {
    throw new SelectionError('INVALID_REQUEST', 400, `${name} must be a list of at most ${MAX_IDS} item ids from the storage check.`);
  }
  return [...new Set(value)];
}

// normalizeRequest(request) → { items, snapshots, exports, acknowledgeSnapshotLoss, scope } or throws INVALID_REQUEST.
export function normalizeRequest(request = {}) {
  const scope = request.scope == null ? 'items' : request.scope;
  if (!SCOPES.includes(scope)) throw new SelectionError('INVALID_REQUEST', 400, `scope must be one of ${SCOPES.join(', ')}.`);
  if (request.acknowledgeSnapshotLoss != null && typeof request.acknowledgeSnapshotLoss !== 'boolean') throw new SelectionError('INVALID_REQUEST', 400, 'acknowledgeSnapshotLoss must be true or false.');
  return {
    items: idList('items', request.items),
    snapshots: idList('snapshots', request.snapshots),
    exports: idList('exports', request.exports),
    acknowledgeSnapshotLoss: request.acknowledgeSnapshotLoss === true,
    scope,
  };
}

// checkFreshness({ check, latest, targetKey, now, maxAgeMs }) → null when the
// check may be acted on, else the SelectionError. It must be the target's
// latest finished (complete or partial) check and at most an hour old.
export function checkFreshness({ check, latest = null, targetKey = null, now, maxAgeMs = CHECK_MAX_AGE_MS }) {
  const when = finishedAtOf(check);
  const stale = message => new SelectionError('CHECK_STALE', 409, message, { checkId: checkIdOf(check), checkedAt: when });
  if (!check) return new SelectionError('CHECK_STALE', 409, 'Run a new storage check first; this check was not found.');
  if (targetKey && check.target?.key && check.target.key !== targetKey) return stale('Run a new storage check first; this check belongs to another application.');
  if (!['complete', 'partial'].includes(check.status)) return stale(check.status === 'running' ? 'Wait for the storage check to finish, then review it.' : 'Run a new storage check first; this one did not finish.');
  const ms = Date.parse(when || '');
  if (!Number.isFinite(ms) || now - ms > maxAgeMs || ms - now > 5 * 60 * 1000) return stale(`Run a new storage check first; this one is from ${when || 'an unknown time'}.`);
  if (latest && checkIdOf(latest) !== checkIdOf(check)) return stale(`Run a new storage check first; this one is from ${when}.`);
  return null;
}

function locationProblem(item) {
  if (!['guest', 'host'].includes(item.location)) return 'This item has no usable location.';
  const paths = item.kind === 'group' ? (Array.isArray(item.members) ? item.members.map(m => m?.path) : []) : [item.path];
  if (!paths.length) return 'This group has no members.';
  if (paths.some(x => typeof x !== 'string' || !path.isAbsolute(x) || path.normalize(x) !== x || x === '/' || x.endsWith('/'))) return 'This item has no usable location.';
  return null;
}

// validateCleanupRequest({ check, latest, request, targetKey, now }) →
//   { ok: true, empty: true, message }                    nothing selected
//   { ok: true, empty: false, scope, items, snapshots, exports, acknowledgeSnapshotLoss }
// or throws a SelectionError: INVALID_REQUEST 400, CHECK_STALE 409,
// NOT_ELIGIBLE 409 (details.items: [{ id, reason }]), SNAPSHOT_ACK_REQUIRED 400.
export function validateCleanupRequest({ check, latest = null, request = {}, targetKey = null, now, maxAgeMs = CHECK_MAX_AGE_MS }) {
  const r = normalizeRequest(request);
  if (!r.items.length && !r.snapshots.length && !r.exports.length) return { ok: true, empty: true, message: NOTHING_SELECTED };
  const stale = checkFreshness({ check, latest, targetKey, now, maxAgeMs });
  if (stale) throw stale;
  const byId = new Map(itemsOf(check).map(item => [item.id, item]));
  const bad = [];
  const pick = (ids, want) => ids.map(id => {
    const item = byId.get(id);
    if (!item) { bad.push({ id, reason: 'Not part of this storage check.' }); return null; }
    const label = item.label || item.path || id;
    if (want === 'file' && !isFileItem(item)) { bad.push({ id, label, reason: 'Restore points and copies are selected separately.' }); return null; }
    if (want === 'snapshot' && !isSnapshotItem(item)) { bad.push({ id, label, reason: 'Only restore points can be selected here.' }); return null; }
    if (want === 'export' && !isExportItem(item)) { bad.push({ id, label, reason: 'Only downloadable copies can be selected here.' }); return null; }
    if (item.status !== 'eligible') { bad.push({ id, label, reason: item.reason ? `Not eligible: ${item.reason}` : 'This item cannot be cleaned up.' }); return null; }
    if (want === 'file') {
      if (!FILE_ACTIONS.includes(item.action)) { bad.push({ id, label, reason: 'This item has no cleanup action.' }); return null; }
      if (item.action !== 'vacuum-journal') { const problem = locationProblem(item); if (problem) { bad.push({ id, label, reason: problem }); return null; } }
    }
    if (want === 'snapshot' && (item.action !== 'delete-snapshot' || !SNAPSHOT_NAME_RE.test(String(snapshotNameOf(item) || '')) || typeof item.identity?.createdAt !== 'string')) { bad.push({ id, label, reason: 'This restore point is not identified well enough to delete.' }); return null; }
    if (want === 'export' && (item.action !== 'delete-export' || !Number.isInteger(Number(exportIdOf(item))))) { bad.push({ id, label, reason: 'This copy is not identified well enough to delete.' }); return null; }
    return item;
  }).filter(Boolean);
  const items = pick(r.items, 'file');
  const snapshots = pick(r.snapshots, 'snapshot');
  const exports = pick(r.exports, 'export');
  if (bad.length) throw new SelectionError('NOT_ELIGIBLE', 409, `${bad.length === 1 ? 'One selected item' : `${bad.length} selected items`} cannot be cleaned up; run a new check or remove ${bad.length === 1 ? 'it' : 'them'} from the selection.`, { items: bad });
  if (snapshots.length && !r.acknowledgeSnapshotLoss) throw new SelectionError('SNAPSHOT_ACK_REQUIRED', 400, 'Deleting a snapshot removes the option to restore to that point. Confirm that you understand before deleting snapshots.');
  return { ok: true, empty: false, scope: r.scope, items, snapshots, exports, acknowledgeSnapshotLoss: r.acknowledgeSnapshotLoss };
}

export const snapshotNameOf = item => item?.name ?? item?.identity?.name ?? item?.snapshot ?? null;
export const exportIdOf = item => item?.identity?.exportId ?? item?.exportId ?? null;

const orderOf = item => { const i = REMOVAL_ORDER.indexOf(item.category); return i === -1 ? REMOVAL_ORDER.length : i; };
const copy = value => (value == null ? value : JSON.parse(JSON.stringify(value)));

// resolveSelection(validated) → the entries stored on the cleanup row,
// copied out of the check (never the request): files in removal order, then
// snapshots, then exports.
export function resolveSelection(validated) {
  const entry = item => ({
    id: item.id, category: item.category, label: item.label || item.path || item.id, kind: item.kind, action: item.action,
    location: item.location || 'guest', path: item.path ?? null, identity: copy(item.identity) || null,
    ...(item.kind === 'group' ? { members: (item.members || []).map(m => ({ path: m.path, identity: copy(m.identity) || null })) } : {}),
    logicalBytes: Number(item.logicalBytes) || 0, allocatedBytes: Number(item.allocatedBytes) || 0,
    precision: item.precision || 'exact', memoryBacked: item.memoryBacked === true,
    ...(item.action === 'vacuum-journal' ? { targetBytes: Number(item.targetBytes) || null, recoverableBytes: Number.isFinite(Number(item.recoverableBytes)) ? Number(item.recoverableBytes) : null } : {}),
    ...(isSnapshotItem(item) ? { name: snapshotNameOf(item) } : {}),
    ...(isExportItem(item) ? { exportId: Number(exportIdOf(item)) } : {}),
  });
  const files = validated.items.map((item, index) => ({ item, index })).sort((a, b) => (orderOf(a.item) - orderOf(b.item)) || (a.index - b.index)).map(x => entry(x.item));
  return [...files, ...validated.snapshots.map(entry), ...validated.exports.map(entry)];
}

// selectionEstimate(entries, check) → what the selection should return,
// always an estimate: deduped allocated bytes of file items (memory-backed
// apart), the journal above its limit, each snapshot's own bytes (about the
// dataset's snapshot total when every snapshot is selected) and export sizes.
export function selectionEstimate(entries, check = null) {
  const seen = new Set();
  const out = { bytes: 0, diskBytes: 0, memoryBytes: 0, snapshotBytes: 0, exportBytes: 0, precision: 'estimate', notes: [] };
  let snapshotCount = 0;
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.action === 'delete-snapshot') { out.snapshotBytes += e.allocatedBytes; snapshotCount += 1; continue; }
    if (e.action === 'delete-export') { out.exportBytes += e.allocatedBytes || e.logicalBytes; continue; }
    const bytes = e.action === 'vacuum-journal' ? (e.recoverableBytes ?? Math.max(0, e.allocatedBytes - (e.targetBytes || 0))) : e.allocatedBytes;
    if (e.memoryBacked) out.memoryBytes += bytes; else out.diskBytes += bytes;
  }
  const allSnapshots = snapshotItemIds(check);
  const held = Number(check?.totals?.dataset?.snapshotsBytes);
  if (snapshotCount && allSnapshots.length && snapshotCount >= allSnapshots.length && Number.isFinite(held) && held > out.snapshotBytes) {
    out.snapshotBytes = held;
    out.notes.push('All snapshots are selected, so about all the space snapshots hold is returned.');
  }
  out.bytes = out.diskBytes + out.memoryBytes + out.snapshotBytes + out.exportBytes;
  const fileSelected = entries.some(e => isFileItem(e));
  const snapshotsHold = (Number.isFinite(held) && held > 0) || itemsOf(check).some(isSnapshotItem);
  if (fileSelected && snapshotsHold && snapshotCount < Math.max(1, allSnapshots.length)) out.notes.push('Space held by snapshots is only returned after those snapshots are deleted.');
  if (out.memoryBytes > 0) out.notes.push('Some selected items use memory, not disk; removing them frees memory.');
  return out;
}

// ── where an item may be removed from ───────────────────────────────────

const inside = (root, x) => x === root || x.startsWith(root === '/' ? '/' : `${root}/`);
const releaseRootOf = target => (target?.kind === 'application' ? (target.profile?.releaseRoot || `/var/lib/proxypilot/application-releases/${target.id}`) : null);
const homesOf = target => {
  const homes = new Set(['/root']);
  for (const h of [target?.serviceHome, target?.serviceUser?.home, ...(Array.isArray(target?.homes) ? target.homes : [])]) {
    if (typeof h === 'string' && path.isAbsolute(h) && path.normalize(h) === h && h !== '/' && h.split('/').length >= 3) homes.add(h);
  }
  return [...homes];
};

// The (directory, name) rules per category. An item must sit within
// `maxDepth` levels below `dir` (1 = a direct child) and its own name must
// match `name`. A root itself is never an item.
export function removalRules(item, target) {
  const releaseRoot = releaseRootOf(target);
  const rules = [];
  const add = (dir, name, maxDepth = 1, extra = {}) => { if (dir) rules.push({ dir, name, maxDepth, ...extra }); };
  switch (item?.category) {
    case 'temp': add('/tmp', ANY_NAME); add('/var/tmp', ANY_NAME); break;
    case 'caches':
      for (const home of homesOf(target)) { add(`${home}/.npm`, ANY_NAME); add(`${home}/.cache`, ANY_NAME); }
      {
        const m = /^(\/home\/[A-Za-z0-9._-]+)\/(?:\.npm|\.cache)\/[^/]+$/.exec(String(item.path || ''));
        if (m) { add(`${m[1]}/.npm`, ANY_NAME); add(`${m[1]}/.cache`, ANY_NAME); }
      }
      add('/var/cache/apt/archives', /\.deb$/);
      if (target?.kind === 'project') add('/srv/app/.mock2', /^cache$/);
      break;
    case 'logs': add('/var/log', ANY_NAME, 2, { notUnder: ['/var/log/journal'] }); break;
    case 'history':
      add('/var/backups/proxypilot-db', /^app-[A-Za-z0-9._-]{1,120}\.sql$/);
      add('/etc/systemd/system', /^[A-Za-z0-9@._-]+\.pre-[A-Za-z0-9-]{1,80}$/);
      add('/etc', /^environment\.pre-[A-Za-z0-9-]{1,80}$/);
      add('/run/mock2-deploy', /^[A-Za-z0-9-]{1,64}\.[A-Za-z0-9.]{1,40}$/);
      break;
    case 'test_reports':
      if (target?.kind === 'project') { add('/srv/app', REPORT_RE); add('/srv/app/.mock2/evidence', ANY_NAME); }
      else {
        const dir = typeof item?.path === 'string' ? path.dirname(item.path) : null;
        if (dir && dir !== '/' && dir.split('/').length >= 2 && !(releaseRoot && inside(releaseRoot, dir))) add(dir, REPORT_RE);
      }
      break;
    case 'workspaces': if (releaseRoot) add(`${releaseRoot}/.staging`, ATTEMPT_RE); break;
    case 'archives':
      if (item?.location === 'host') add(HOST_TRANSFER_ROOT, /^bundle-[A-Za-z0-9]{1,40}$/);
      else if (releaseRoot) add(`${releaseRoot}/.staging`, BUNDLE_RE);
      break;
    case 'releases': if (releaseRoot && item?.action === 'remove-release') add(releaseRoot, RELEASE_RE); break;
    default: break;
  }
  return rules;
}

// approvedRootsFor(item, target) → the directories the cleanup program may
// remove this item from (empty: it may not be removed at all).
export function approvedRootsFor(item, target) { return [...new Set(removalRules(item, target).map(rule => rule.dir))]; }

// Paths no cleanup ever removes, nor removes a parent of: declared data and
// settings, database directories, the live source pointer, a project's
// state and source history.
function protectedPaths(target) {
  const out = [...DATABASE_DIRS];
  if (target?.kind === 'application') {
    for (const x of [...(target.profile?.preservePaths || []), ...(target.profile?.envFiles || [])]) if (typeof x === 'string' && path.isAbsolute(x)) out.push(path.normalize(x));
    if (typeof target.profile?.sourceDir === 'string') out.push(target.profile.sourceDir);
  }
  if (target?.kind === 'project') out.push('/srv/app/state', '/srv/app/data', '/srv/repo.git');
  return out;
}

function onePathAllowed(p, item, target, rules) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p || p === '/' || p.endsWith('/') || p.includes('\0')) return 'The item has no usable location.';
  const rule = rules.find(r => {
    if (p === r.dir || !inside(r.dir, p)) return false;
    const rel = p.slice(r.dir.length + 1).split('/');
    if (rel.length > r.maxDepth || !r.name.test(rel[rel.length - 1])) return false;
    return !(r.notUnder || []).some(x => inside(x, p));
  });
  if (!rule) return 'Outside the locations this cleanup may change.';
  const caches = item.category === 'caches';
  for (const q of protectedPaths(target)) {
    // A cache under the service user's home is allowed even when that home is
    // a preserved data path (DESIGN §2.3 rule 6); nothing else inside data.
    if (inside(q, p) && !(caches && homesOf(target).includes(q))) return 'Inside data or settings that are never cleaned up.';
    if (inside(p, q)) return 'Contains data or settings that are never cleaned up.';
  }
  return null;
}

// pathAllowed(item, target) → { ok: true, roots } | { ok: false, reason }.
// Every member of a group must pass.
export function pathAllowed(item, target) {
  const rules = removalRules(item, target);
  if (!rules.length) return { ok: false, reason: 'This kind of item is never removed by a cleanup.' };
  const paths = item.kind === 'group' ? (item.members || []).map(m => m?.path) : [item.path];
  if (!paths.length) return { ok: false, reason: 'This group has no members.' };
  for (const p of paths) { const reason = onePathAllowed(p, item, target, rules); if (reason) return { ok: false, reason }; }
  return { ok: true, roots: [...new Set(rules.map(r => r.dir))] };
}
