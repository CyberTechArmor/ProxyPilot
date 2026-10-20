import { readFileSync } from 'node:fs';

export const APPLICATION_RELEASE_RETENTION = Object.freeze(JSON.parse(readFileSync(
  new URL('../mcp-policy/application-release-retention.json', import.meta.url), 'utf8',
)).targets);

// Serialized into the contained guest program. All paths come from the saved
// profile and the owning job, and the guest lease fences the whole operation.
export function cleanupReleaseArtifacts(fs, p, a) {
  const refuse = message => { throw new Error(message); };
  const root = p.resolve(a.profile.releaseRoot || '');
  if (!a.profile.releaseRoot || root === p.parse(root).root || p.dirname(root) === p.parse(root).root) refuse('UNSAFE_RETENTION_ROOT');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root || rootStat.uid !== 0 || (rootStat.mode & 0o022)) refuse('UNSAFE_RETENTION_ROOT');
  if (!fs.lstatSync(a.profile.sourceDir).isSymbolicLink()) refuse('RETENTION_REQUIRES_SYMLINK_LAYOUT');
  const live = fs.realpathSync(a.profile.sourceDir);
  if (p.dirname(live) !== root) refuse('LIVE_RELEASE_OUTSIDE_ROOT');
  const keep = new Set([live]);
  if (a.release) {
    if (p.dirname(a.release) !== root) refuse('CANDIDATE_RELEASE_OUTSIDE_ROOT');
    keep.add(a.release);
  }
  // A release can hold actual model/data directories used by newer releases.
  // Protect their resolved backing roots, including indirect symlink chains.
  const shared = new Set();
  for (const preserve of [...(a.profile.preservePaths || []), ...(a.profile.envFiles || [])]) {
    if (!fs.existsSync(preserve)) continue;
    const resolved = fs.realpathSync(preserve);
    const relative = p.relative(root, resolved);
    if (relative && !relative.startsWith('..' + p.sep) && relative !== '..' && !p.isAbsolute(relative)) {
      const backing = p.join(root, relative.split(p.sep)[0]);
      shared.add(backing); keep.add(backing);
    }
  }
  const keepCount = a.retention?.keepReleases;
  if (!Number.isInteger(keepCount) || keepCount < 2 || keepCount > 20) refuse('INVALID_RELEASE_RETENTION');
  const stageRoot = p.join(root, '.staging');
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
  const releases = fs.readdirSync(root).filter(name => /^[a-f0-9]{40}-p[1-9][0-9]*-[a-f0-9-]{36}$/.test(name)).map(name => p.join(root, name)).filter(file => {
    const stat = fs.lstatSync(file);
    const marker = p.join(file, '.proxypilot-release.json');
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022) && fs.existsSync(marker) && fs.lstatSync(marker).isFile() && !fs.lstatSync(marker).isSymbolicLink();
  }).sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  for (const release of releases) {
    if ([...keep].filter(file => !shared.has(file)).length >= keepCount) break;
    keep.add(release);
  }
  for (const release of releases) {
    if (keep.has(release)) continue;
    // Read back the live pointer immediately before each destructive command.
    if (fs.realpathSync(a.profile.sourceDir) !== live) refuse('LIVE_RELEASE_CHANGED_DURING_CLEANUP');
    fs.rmSync(release, { recursive: true, force: false });
    out.releasesRemoved += 1;
  }
  return out;
}
