// Explicit, offline-only refresh from a previously acquired authoritative release.
// No network, installer execution, application migration, or live file writes.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = resolve(root, 'admin/backend/src/mock2/framework-seed');
const repoPrefix = 'core/mock2/templates/repo/';
const gitEntry = `${repoPrefix}.mock2/bin/git-readiness.mjs`;
const gitGuide = `${repoPrefix}.mock2/git-readiness.md`;
const gitModule = /^core\/mock2\/templates\/repo\/\.mock2\/bin\/git-readiness(?:-[A-Za-z]+)*\.mjs$/;

// Pure acquisition step: all release identities, bytes and import dependencies
// are checked before the caller writes any generated platform files.
export function buildPinnedGuidance(source) {
  const sourceRoot = realpathSync(resolve(source));
  const release = JSON.parse(readFileSync(resolve(source, 'release.json'), 'utf8'));
  if (release.name !== 'mock2-core' || !/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error('Invalid release identity');
  if (!Array.isArray(release.files)) throw new Error('Invalid release file list');
  const bySource = new Map();
  for (const file of release.files) {
    if (!file || typeof file.src !== 'string') throw new Error('Invalid release file list');
    const prior = bySource.get(file.src);
    // One canonical source may install to several user/project destinations.
    if (prior && (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes)) throw new Error(`Conflicting release file identity: ${file.src}`);
    bySource.set(file.src,file);
  }
  function verifiedFile(f) {
    if (!f || !/^[a-zA-Z0-9_./-]+$/.test(f.src) || f.src.split('/').includes('..')) throw new Error('Invalid source path');
    const physical = realpathSync(resolve(sourceRoot, f.src));
    if (!physical.startsWith(sourceRoot + sep)) throw new Error(`Source escapes release: ${f.src}`);
    const bytes = readFileSync(physical);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== f.sha256 || bytes.length !== f.bytes) throw new Error(`Release hash/size mismatch: ${f.src}`);
    return { source: f.src, sha256: hash, content: bytes.toString('utf8') };
  }
  const entries = [...bySource.values()].filter(f => f.src === 'core/claude/CLAUDE.md' || f.src === 'core/mock2/profiles/profile-cpr.md' || f.src === 'core/mock2/templates/repo/.mock2/capacity.md' || f.src.startsWith('core/cpr/') || f.src.startsWith('core/claude/rules/'));
  const files = entries.map(f => {
    const verified = verifiedFile(f);
    const relative = f.src === 'core/claude/CLAUDE.md' ? 'constitution.md'
      : f.src.startsWith('core/claude/rules/') ? f.src.slice('core/claude/'.length)
        : f.src.startsWith('core/mock2/profiles/') ? 'profile-cpr.md' : f.src.slice('core/cpr/'.length);
    const path = f.src === 'core/mock2/templates/repo/.mock2/capacity.md' ? '.mock2/capacity.md' : `.mock2/standards/${relative}`;
    return { path, ...verified };
  });
  for (const required of ['constitution.md', 'CPR-v1.1-current.md', 'Relay-Recording.md', 'Universal-Integration.md', 'Universal-Integration-New-App-Prompt.md', 'Universal-Integration-Existing-App-Prompt.md', 'stack.versions.json']) {
    if (!files.some(f => f.path === `.mock2/standards/${required}`)) throw new Error(`Missing required guidance: ${required}`);
  }
  const runtimeFiles = [];
  if (bySource.has(gitEntry) || bySource.has(gitGuide)) {
    if (!bySource.has(gitEntry) || !bySource.has(gitGuide)) throw new Error('Incomplete canonical Git readiness slice');
    const pending = [gitEntry], visited = new Set();
    while (pending.length) {
      const name = pending.shift();
      if (visited.has(name)) continue;
      if (!gitModule.test(name) || !bySource.has(name)) throw new Error(`Unsupported Git readiness dependency: ${name}`);
      const file = verifiedFile(bySource.get(name)); visited.add(name);
      // The reviewed portable slice uses only static ESM imports and Node builtins.
      // Never acquire an arbitrary application, package or runtime through an import.
      if (/\b(?:import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\(/.test(file.content)) throw new Error(`Unsupported dynamic dependency: ${name}`);
      const dependencies = [];
      const remainder = file.content.replace(/(?:\bimport\s+(?:[^;]*?\sfrom\s*)?|\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+)['"]([^'"\n]+)['"]/g,
        (_declaration, specifier) => { dependencies.push(specifier); return ' '; });
      // This is deliberately a bounded canonical-slice extractor, not a JS
      // parser: refuse syntax we did not extract instead of dropping a dependency.
      if (/\bimport\b(?!\s*\.\s*meta\b)/.test(remainder) || /\bexport\s*(?:\*|\{)[^;]*\bfrom\b/.test(remainder)) throw new Error(`Unsupported module declaration: ${name}`);
      for (const specifier of dependencies) {
        if (specifier.startsWith('node:')) continue;
        if (!specifier.startsWith('./')) throw new Error(`Unsupported Git readiness import: ${specifier}`);
        const dependency = posix.normalize(posix.join(posix.dirname(name), specifier));
        if (!gitModule.test(dependency)) throw new Error(`Unsupported Git readiness dependency: ${dependency}`);
        pending.push(dependency);
      }
      runtimeFiles.push({path:name.slice(repoPrefix.length), ...file});
    }
    const guide = verifiedFile(bySource.get(gitGuide));
    runtimeFiles.push({path:'.mock2/git-readiness.md', ...guide});
  }
  if (files.some(f => f.source.endsWith('/mock2-git-readiness.md')) && !runtimeFiles.length) throw new Error('Git readiness guidance requires its canonical tool slice');
  return { family: 'mock2-core', version: release.version, updated: release.updated,
    scope: 'guidance', files, runtime_files:runtimeFiles,
    runtime_scope: runtimeFiles.length ? 'git-readiness-local-inspection' : 'none' };
}

// The ProxyPilot-generated header above the pinned upstream text. It is not
// part of the hashed upstream bytes; it states what the pinned guidance does and
// does not supersede (constitution §2 is a platform contract).
export function pinnedGuidanceHeader(version) {
  return [
    `# Governing Mock2 guidance: ${version}`,
    '',
    'The following pinned guidance supersedes historical general-workflow wording above.',
    'It does not supersede §2 above: the stack and the application foundation are a platform contract.',
    'New Dev Studio applications use profile `cpr` with the foundation (PostgreSQL + pgvector, the foundation storage and embeddings adapters, secrets encrypted in the database); no SQLite or other engine without the person\'s recorded request.',
    'ProxyPilot\'s concrete identity, authorization, private-data and execution contracts remain binding.',
    'Load the applicable rules and CPR documents from .mock2/standards/ before dependent work.',
    'This guidance adoption does not install Relay runtime/producers or migrate existing integrations.',
    'The additive Git readiness slice supports local inspection; host installation, remote credentials, synchronization and deployment remain host-owned operations.',
    'Canonical application-intake setup commands apply only when that client runtime is installed.',
  ].join('\n');
}

export function syncPinnedGuidance(source) {
  const bundle = buildPinnedGuidance(source);
  const { version, updated, files } = bundle;
  // All inputs validated before any output is written.
  writeFileSync(resolve(seed, 'upstream-guidance.json'), JSON.stringify(bundle, null, 2) + '\n');
  const marker = '<!-- BEGIN PINNED MOCK2 GUIDANCE -->';
  const old = readFileSync(resolve(seed, 'constitution.md'), 'utf8');
  const original = old.includes(marker) ? old.slice(0, old.indexOf(marker)).trimEnd() : old.trimEnd();
  const current = files.find(f => f.path.endsWith('/constitution.md')).content;
  writeFileSync(resolve(seed, 'constitution.md'), `${original}\n\n${marker}\n${pinnedGuidanceHeader(version)}\n\n${current}\n<!-- END PINNED MOCK2 GUIDANCE -->\n`);
  const metadataPath = resolve(seed, 'standards-version.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  Object.assign(metadata, { version, source_version: version, family: 'mock2-core', synced: updated, adoption_scope: 'guidance', runtime_scope:bundle.runtime_scope });
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  console.log(`Pinned ${files.length} hash-verified Mock2 ${version} guidance files and ${bundle.runtime_files.length} Git readiness files; no application, installer or provider execution performed.`);
  return bundle;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/sync-mock2-guidance.mjs <source-directory>');
  syncPinnedGuidance(process.argv[2]);
}
