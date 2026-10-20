import { readFileSync } from 'node:fs';

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
  return { keepReleases: entry.keepReleases, trimBeforeSeal: trim, workspaces: entry.workspaces !== false };
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
// releaseContextFromApplication(app, { root }) → { previousSha, rollback,
// protect } for the guest: the rollback release (the previous live
// release's recorded path) and the newest validated candidate still waiting
// to be deployed. Paths outside the release root are ignored; the guest
// re-derives everything it can from the release markers anyway.
export function releaseContextFromApplication(app, { root = null } = {}) {
  const live = app?.live || null;
  const under = x => typeof x === 'string' && x.startsWith('/') && !x.includes('/../') && (!root || x.startsWith(`${root}/`));
  const previousSha = live && SHA_RE.test(live.previousSha || '') && live.previousSha !== live.sha ? live.previousSha : null;
  const candidates = Array.isArray(app?.candidates) ? app.candidates : [];
  let rollback = null;
  if (previousSha) {
    const c = candidates.find(x => x?.sha === previousSha);
    const p = c?.live?.releasePath || c?.validation?.releasePath;
    if (under(p) && p !== live?.releasePath) rollback = p;
  }
  const liveAt = Date.parse(live?.verifiedAt || '');
  const waiting = candidates
    .filter(c => c?.validation?.passed === true && under(c.validation.releasePath) && c.validation.releasePath !== live?.releasePath && c.sha !== live?.sha)
    .filter(c => !Number.isFinite(liveAt) || Date.parse(c.checkpointAt || '') > liveAt)
    .sort((a, b) => (Date.parse(b.checkpointAt || '') || 0) - (Date.parse(a.checkpointAt || '') || 0))[0]?.validation.releasePath || null;
  return { previousSha, rollback, protect: [...new Set([rollback, waiting].filter(Boolean))] };
}

// ── guest side ──────────────────────────────────────────────────────────
//
// The functions below are SERIALIZED into the contained guest programs (the
// release program in application-deploy-op.js and the storage cleanup
// program), so they reference nothing outside their own parameters. All paths
// come from the saved profile, the owning job and the stored cleanup row; the
// guest lease fences the whole operation.

// describeReleases(fs, p, a) → the release root's protected set as the guest
// sees it NOW:
//   live      realpath of the profile's sourceDir (always kept, counted)
//   candidate a.release, the release being validated (kept, never counted)
//   backing   release-root children that physically hold a preserved or env
//             path, through any symlink chain (kept, never counted)
//   protect   a.protect: the recorded rollback and waiting candidate (kept)
//   rollback  a.rollback when it is a sealed release, else the sealed release
//             whose marker names a.previousSha, else the newest other sealed
//             release by mtime (kept, counted)
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
  let rollback = null;
  if (typeof a.rollback === 'string' && a.rollback !== live && isSealed(a.rollback)) rollback = a.rollback;
  if (!rollback && /^[a-f0-9]{40}$/.test(a.previousSha || '')) rollback = (sealed.find(r => r.sha === a.previousSha && r.path !== live && r.path !== candidate) || {}).path || null;
  if (!rollback) rollback = (sealed.find(r => r.path !== live && r.path !== candidate && !backing.has(r.path) && !protect.has(r.path)) || {}).path || null;
  return { root, live, candidate, backing, protect, rollback, sealed };
}

// cleanupReleaseArtifacts(fs, p, a) → { stagesRemoved, bundlesRemoved,
// releasesRemoved }. Counting: the live release and the rollback release are
// counted, then the newest other sealed releases until `keepReleases` are
// kept; the release being validated, the waiting candidate (a.protect) and
// backing roots are kept and never counted. So `keepReleases: 2` keeps live +
// rollback, and the release under validation never pushes the rollback out.
export function cleanupReleaseArtifacts(fs, p, a) {
  const refuse = message => { throw new Error(message); };
  const d = describeReleases(fs, p, a);
  const keepCount = a.retention?.keepReleases;
  if (!Number.isInteger(keepCount) || keepCount < 2 || keepCount > 20) refuse('INVALID_RELEASE_RETENTION');
  const stageRoot = p.join(d.root, '.staging');
  const out = { stagesRemoved: 0, bundlesRemoved: 0, releasesRemoved: 0 };
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
      fs.rmSync(target, { recursive: stat.isDirectory(), force: false });
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
    fs.rmSync(release.path, { recursive: true, force: false });
    out.releasesRemoved += 1;
  }
  return out;
}

// removeSelectedRelease(fs, p, a, remove) → { removed, ...remove(result) }.
// The user-selected removal of ONE release (a.path), with the same
// predicates as the retention above: a recognised sealed release directly in
// the root, and not live, rollback, candidate, waiting candidate or backing
// root as derived now. The live pointer is read back right before `remove`
// (the caller's verified, non-following removal; plain rmSync otherwise).
export function removeSelectedRelease(fs, p, a, remove) {
  const refuse = message => { throw new Error(message); };
  const d = describeReleases(fs, p, a);
  const target = a.path;
  if (typeof target !== 'string' || p.dirname(target) !== d.root) refuse('RELEASE_OUTSIDE_ROOT');
  if (!d.sealed.some(r => r.path === target)) refuse('NOT_A_SEALED_RELEASE');
  if (target === d.live) refuse('RELEASE_IS_LIVE');
  if (target === d.rollback) refuse('RELEASE_IS_ROLLBACK');
  if (target === d.candidate || d.protect.has(target)) refuse('RELEASE_IS_CANDIDATE');
  if (d.backing.has(target)) refuse('RELEASE_HOLDS_SHARED_DATA');
  if (fs.realpathSync(a.profile.sourceDir) !== d.live) refuse('LIVE_RELEASE_CHANGED_DURING_CLEANUP');
  const result = typeof remove === 'function' ? remove(target) : (fs.rmSync(target, { recursive: true, force: false }), {});
  return { removed: target, ...(result || {}) };
}

// The guest-side source both programs embed, in dependency order.
export const RELEASE_CLEANUP_SOURCE = [describeReleases, cleanupReleaseArtifacts, removeSelectedRelease]
  .map(fn => `const ${fn.name}=${fn.toString()};`).join('\n');
