import { readFileSync } from 'node:fs';
import { safeRemover, SAFE_REMOVE_SOURCE } from './safe-remove.js';

export const APPLICATION_RELEASE_RETENTION = Object.freeze(JSON.parse(readFileSync(
  new URL('../mcp-policy/application-release-retention.json', import.meta.url), 'utf8',
)).targets);

// ── host side (pure) ────────────────────────────────────────────────────

const TRIM_ENTRY_RE = /^[A-Za-z0-9._/-]{1,200}$/;
// A relative path inside a staged tree that a seal may discard: normalized,
// no `.`/`..` segment, nothing under `.git`.
export function validTrimEntry(entry) {
  if (typeof entry !== 'string' || !TRIM_ENTRY_RE.test(entry) || entry.startsWith('/') || entry.endsWith('/')) return false;
  return entry.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
}

// normalizeReleaseRetention(entry) → { keepReleases, trimBeforeSeal, workspaces } | null.
// Accepts the static JSON shape ({ keepReleases, trimBuildCache }) and the
// storage policy shape ({ keepReleases, trimBeforeSeal, workspaces? }).
// `.cache` is first when present so its historical refusal runs first.
export function normalizeReleaseRetention(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const listed = Array.isArray(entry.trimBeforeSeal) ? entry.trimBeforeSeal : (entry.trimBuildCache === true ? ['.cache'] : []);
  const trim = [...new Set(listed.filter(validTrimEntry))].slice(0, 20);
  trim.sort((a, b) => (a === '.cache' ? -1 : b === '.cache' ? 1 : 0));
  // `workspaces` is a boolean or the policy rule ({ enabled, abandonedAfterHours }).
  const workspaces = entry.workspaces && typeof entry.workspaces === 'object' ? entry.workspaces.enabled !== false : entry.workspaces !== false;
  return { keepReleases: entry.keepReleases, trimBeforeSeal: trim, workspaces };
}

// The static opt-in (Nodus), normalized. Unlisted targets → null (unchanged).
export function staticReleaseRetention(targetId) {
  return Object.hasOwn(APPLICATION_RELEASE_RETENTION, String(targetId)) ? normalizeReleaseRetention(APPLICATION_RELEASE_RETENTION[targetId]) : null;
}

// resolveReleaseRetention(source, targetId) → the retention a release job
// applies. `source` is a function (the storage policy's
// effectiveReleaseRetention, which itself falls back to the static JSON) or
// absent (the static JSON). A source that throws is the caller's to handle:
// the deploy op then applies no retention at all rather than guess.
export async function resolveReleaseRetention(source, targetId) {
  if (typeof source !== 'function') return staticReleaseRetention(targetId);
  return normalizeReleaseRetention(await source(targetId));
}

const SHA_RE = /^[a-f0-9]{40}$/;
// What a stored release looks like to the guest when nothing identifies the
// rollback release (the check shows this as the reason the releases are kept).
export const ROLLBACK_UNKNOWN_REASON = 'The previous release could not be identified, so no release is removed until the next deployment records it.';

// releaseContextFromApplication(app, { root, previousLive }) → the facts the
// guest's describeReleases decides the release roles from:
//   previousLive  { sha, path } | null from the deploy history
//                 (lib/app-storage/release-history.js previousLiveRelease)
//   previousSha, rollback
//                 that release's sha and folder (under the release root). When
//                 `previousLive` is supplied (null included) it is the one
//                 answer: the history already reads the live record's
//                 previousSha and skips a release rolled back from. Only a
//                 caller with no history source gets the live record's own
//                 previousSha (previousLive undefined).
//   liveVerifiedAt, validated [{ sha, path, validatedAt }]
//                 the passed validations, for the waiting candidate
//   pending       folders whose validation has no result yet (recorded as not
//                 passed while it runs): kept, never removed by the cap
// Nothing here decides a role: describeReleases is the one definition.
export function releaseContextFromApplication(app, { root = null, previousLive = undefined } = {}) {
  const live = app?.live || null;
  const under = x => typeof x === 'string' && x.startsWith('/') && !x.includes('/../') && (!root || x.startsWith(`${root}/`));
  const candidates = Array.isArray(app?.candidates) ? app.candidates : [];
  const folderOf = sha => { const c = candidates.find(x => x?.sha === sha); const p = c?.live?.releasePath || c?.validation?.releasePath; return under(p) && p !== live?.releasePath ? p : null; };
  const supplied = previousLive !== undefined;
  const history = supplied && previousLive && SHA_RE.test(previousLive.sha || '') && previousLive.sha !== live?.sha ? { sha: previousLive.sha, path: under(previousLive.path) && previousLive.path !== live?.releasePath ? previousLive.path : null } : null;
  const recorded = !supplied && live && SHA_RE.test(live.previousSha || '') && live.previousSha !== live.sha ? live.previousSha : null;
  const previousSha = history ? history.sha : recorded;
  const rollback = history ? (history.path || folderOf(history.sha)) : (recorded ? folderOf(recorded) : null);
  const validated = candidates
    .filter(c => c?.validation?.passed === true && SHA_RE.test(c.sha || '') && under(c.validation.releasePath))
    .map(c => ({ sha: c.sha, path: c.validation.releasePath, validatedAt: c.validation.validatedAt || c.checkpointAt || null }));
  const pending = candidates
    .filter(c => c?.validation && c.validation.passed !== true && under(c.validation.releasePath))
    .map(c => c.validation.releasePath);
  return { previousSha, rollback, previousLive: supplied ? history : null, liveVerifiedAt: live?.verifiedAt || null, validated, pending };
}

// ── guest side ──────────────────────────────────────────────────────────
//
// The functions below are SERIALIZED into the contained guest programs (the
// release program in application-deploy-op.js and the storage cleanup
// program), so they reference nothing outside their own parameters except
// safeRemover (safe-remove.js), which RELEASE_CLEANUP_SOURCE embeds first:
// every removal goes through that one fd-relative remover. All paths
// come from the saved profile, the owning job and the stored cleanup row; the
// guest lease fences the whole operation.

// describeReleases(fs, p, a) → the release root's roles as the guest sees
// them NOW. This is the ONE definition of the roles; the storage check, the
// storage cleanup and the release job's retention all read its output.
//   live      realpath of the profile's sourceDir (always kept, counted)
//   candidate a.release, the release being validated (kept, never counted)
//   backing   release-root children that physically hold a preserved or env
//             path, through any symlink chain (kept, never counted)
//   rollback  the release that ran before live: a.rollback (its recorded
//             folder) when sealed, else the sealed release whose marker names
//             a.previousSha, else a.previousLive (deploy history: its folder,
//             else its sha) — never chosen by folder time (kept, counted).
//             null when the previous release is known but not a sealed
//             release here (for example the adopted original).
//   rollbackUnknown  true when nothing identifies the previous release; then
//             every sealed release is in `protect` and nothing is removed
//   waiting   the newest passed validation (a.validated) made after the live
//             release was recorded (a.liveVerifiedAt), sealed, not live and
//             not the rollback (kept, never counted)
//   pending   a.pending: sealed releases whose validation has no result yet
//             (kept, never counted, never removed by the cap)
//   protect   waiting + pending + a.protect (+ every sealed release when
//             rollbackUnknown)
//   sealed    recognised sealed releases, newest first
export function describeReleases(fs, p, a) {
  const refuse = code => { throw new Error(code); };
  const root = p.resolve(a.profile.releaseRoot || '');
  if (!a.profile.releaseRoot || root === p.parse(root).root || p.dirname(root) === p.parse(root).root) refuse('UNSAFE_RETENTION_ROOT');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root || rootStat.uid !== 0 || (rootStat.mode & 0o022)) refuse('UNSAFE_RETENTION_ROOT');
  if (!fs.lstatSync(a.profile.sourceDir).isSymbolicLink()) refuse('RETENTION_REQUIRES_SYMLINK_LAYOUT');
  const live = fs.realpathSync(a.profile.sourceDir);
  if (p.dirname(live) !== root) refuse('LIVE_RELEASE_OUTSIDE_ROOT');
  const candidate = a.release || null;
  if (candidate && p.dirname(candidate) !== root) refuse('CANDIDATE_RELEASE_OUTSIDE_ROOT');
  // A release can hold actual model/data directories used by newer releases.
  // Protect their resolved backing roots, including indirect symlink chains.
  const backing = new Set();
  for (const preserve of [...(a.profile.preservePaths || []), ...(a.profile.envFiles || [])]) {
    if (!fs.existsSync(preserve)) continue;
    const resolved = fs.realpathSync(preserve);
    const relative = p.relative(root, resolved);
    if (relative && !relative.startsWith('..' + p.sep) && relative !== '..' && !p.isAbsolute(relative)) backing.add(p.join(root, relative.split(p.sep)[0]));
  }
  const markerSha = file => {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(4096);
      const n = fs.readSync(fd, buffer, 0, 4096, 0);
      const sha = JSON.parse(buffer.subarray(0, n).toString('utf8')).sha;
      return /^[a-f0-9]{40}$/.test(sha || '') ? sha : null;
    } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
  };
  const sealed = [];
  for (const name of fs.readdirSync(root)) {
    if (!/^[a-f0-9]{40}-p[1-9][0-9]*-[a-f0-9-]{36}$/.test(name)) continue;
    const file = p.join(root, name);
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) continue;
    const marker = p.join(file, '.proxypilot-release.json');
    let mstat = null;
    try { mstat = fs.lstatSync(marker); } catch { mstat = null; }
    if (!mstat || !mstat.isFile() || mstat.isSymbolicLink()) continue;
    sealed.push({ path: file, name, mtimeMs: stat.mtimeMs, sha: markerSha(marker) });
  }
  sealed.sort((x, y) => (y.mtimeMs - x.mtimeMs) || (x.name < y.name ? 1 : x.name > y.name ? -1 : 0));
  const protect = new Set((Array.isArray(a.protect) ? a.protect : []).filter(x => typeof x === 'string' && p.dirname(x) === root));
  const isSealed = x => sealed.some(r => r.path === x);
  const shaOk = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
  const bySha = sha => (sealed.find(r => r.sha === sha && r.path !== live && r.path !== candidate) || {}).path || null;
  const history = a.previousLive && typeof a.previousLive === 'object' && shaOk(a.previousLive.sha) ? a.previousLive : null;
  let rollback = null;
  if (typeof a.rollback === 'string' && a.rollback !== live && isSealed(a.rollback)) rollback = a.rollback;
  if (!rollback && shaOk(a.previousSha)) rollback = bySha(a.previousSha);
  if (!rollback && history) rollback = (typeof history.path === 'string' && history.path !== live && history.path !== candidate && isSealed(history.path)) ? history.path : bySha(history.sha);
  // Known: the live record or the deploy history names the previous release
  // (even when it is not a sealed release here). Unknown: keep everything.
  const rollbackUnknown = !rollback && !shaOk(a.previousSha) && !history;
  const liveAt = Date.parse(a.liveVerifiedAt || '');
  const atOf = v => Date.parse(v.validatedAt || '') || 0;
  const waiting = ((Array.isArray(a.validated) ? a.validated : [])
    .filter(v => v && typeof v.path === 'string' && p.dirname(v.path) === root && v.path !== live && v.path !== rollback && isSealed(v.path))
    .filter(v => !Number.isFinite(liveAt) || atOf(v) > liveAt)
    .sort((x, y) => atOf(y) - atOf(x))[0] || {}).path || null;
  if (waiting) protect.add(waiting);
  const pending = (Array.isArray(a.pending) ? a.pending : []).filter(x => typeof x === 'string' && p.dirname(x) === root && x !== live && isSealed(x));
  for (const x of pending) protect.add(x);
  if (rollbackUnknown) for (const r of sealed) if (r.path !== live) protect.add(r.path);
  return { root, live, candidate, backing, protect, rollback, rollbackUnknown, waiting, pending, sealed };
}

// cleanupReleaseArtifacts(fs, p, a) → { stagesRemoved, bundlesRemoved,
// releasesRemoved, rollbackUnknown? }. Counting: the live release and the
// rollback release are counted, then the newest other sealed releases until
// `keepReleases` are kept; the release being validated, the waiting candidate
// and backing roots are kept and never counted. So `keepReleases: 2` keeps
// live + rollback, and the release under validation never pushes the rollback
// out. The cap removes the oldest releases outside the protected set first
// (the release being validated, the waiting candidate, releases whose
// validation has no result yet, backing roots). When the rollback is unknown
// every sealed release is protected and no release is removed (workspaces and
// bundles still are).
export function cleanupReleaseArtifacts(fs, p, a) {
  const refuse = message => { throw new Error(message); };
  const d = describeReleases(fs, p, a);
  const keepCount = a.retention?.keepReleases;
  if (!Number.isInteger(keepCount) || keepCount < 2 || keepCount > 20) refuse('INVALID_RELEASE_RETENTION');
  const stageRoot = p.join(d.root, '.staging');
  const out = { stagesRemoved: 0, bundlesRemoved: 0, releasesRemoved: 0, ...(d.rollbackUnknown ? { rollbackUnknown: true } : {}) };
  // Workspaces are written by the service user while a build runs: removed
  // only through the fd-relative remover, never by path.
  const remover = safeRemover(fs, p);
  const attemptName = /^[a-f0-9-]{36}-[1-9][0-9]*(?:\.bundle)?$/;
  if (fs.existsSync(stageRoot)) {
    const stat = fs.lstatSync(stageRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(stageRoot) !== stageRoot) refuse('UNSAFE_STAGING_ROOT');
    if (a.stage && (p.dirname(a.stage) !== stageRoot || !attemptName.test(p.basename(a.stage)))) refuse('UNSAFE_STAGING_TARGET');
    if (a.bundle && (a.bundle !== a.stage + '.bundle')) refuse('UNSAFE_BUNDLE_TARGET');
    const entries = a.sweepStages ? fs.readdirSync(stageRoot).filter(name => attemptName.test(name) && p.join(stageRoot, name) !== a.stage && p.join(stageRoot, name) !== a.bundle) : [a.stage, a.bundle].filter(Boolean).map(file => p.basename(file));
    for (const entry of entries) {
      const target = p.join(stageRoot, entry);
      if (p.dirname(target) !== stageRoot || !fs.existsSync(target)) continue;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
      remover.removePath(target);
      if (entry.endsWith('.bundle')) out.bundlesRemoved += 1; else out.stagesRemoved += 1;
    }
  }
  const keep = new Set([d.live, ...d.backing, ...d.protect]);
  if (d.candidate) keep.add(d.candidate);
  let counted = 1;
  if (d.rollback) { keep.add(d.rollback); if (!d.backing.has(d.rollback)) counted += 1; }
  for (const release of d.sealed) {
    if (counted >= keepCount) break;
    if (keep.has(release.path)) continue;
    keep.add(release.path); counted += 1;
  }
  for (const release of d.sealed) {
    if (keep.has(release.path)) continue;
    // Read back the live pointer immediately before each destructive command.
    if (fs.realpathSync(a.profile.sourceDir) !== d.live) refuse('LIVE_RELEASE_CHANGED_DURING_CLEANUP');
    remover.removePath(release.path);
    out.releasesRemoved += 1;
  }
  return out;
}

// removeSelectedRelease(fs, p, a, remove) → { removed, ...remove(result) }.
// The user-selected removal of ONE release (a.path), with the same
// predicates as the retention above: a recognised sealed release directly in
// the root whose marker still names a.markerSha (when given), and not live,
// rollback, candidate, waiting candidate or backing root as derived now. The
// live pointer is read back right before `remove` (the caller's verified,
// quarantining removal; the fd-relative remover otherwise).
export function removeSelectedRelease(fs, p, a, remove) {
  const refuse = message => { throw new Error(message); };
  const d = describeReleases(fs, p, a);
  const target = a.path;
  if (typeof target !== 'string' || p.dirname(target) !== d.root) refuse('RELEASE_OUTSIDE_ROOT');
  const entry = d.sealed.find(r => r.path === target);
  if (!entry) refuse('NOT_A_SEALED_RELEASE');
  // The release the check saw: its marker still names the same commit.
  if (/^[a-f0-9]{40}$/.test(a.markerSha || '') && entry.sha !== a.markerSha) refuse('CHANGED_SINCE_CHECK');
  if (target === d.live) refuse('RELEASE_IS_LIVE');
  if (target === d.rollback) refuse('RELEASE_IS_ROLLBACK');
  if (d.rollbackUnknown) refuse('ROLLBACK_UNKNOWN');
  if (target === d.candidate || d.protect.has(target)) refuse('RELEASE_IS_CANDIDATE');
  if (d.backing.has(target)) refuse('RELEASE_HOLDS_SHARED_DATA');
  if (fs.realpathSync(a.profile.sourceDir) !== d.live) refuse('LIVE_RELEASE_CHANGED_DURING_CLEANUP');
  const result = typeof remove === 'function' ? remove(target) : safeRemover(fs, p).removePath(target);
  return { removed: target, ...(result || {}) };
}

// The guest-side source both programs embed, in dependency order: the one
// remover first, then the release functions that use it.
export const RELEASE_CLEANUP_SOURCE = [SAFE_REMOVE_SOURCE, ...[describeReleases, cleanupReleaseArtifacts, removeSelectedRelease]
  .map(fn => `const ${fn.name}=${fn.toString()};`)].join('\n');
