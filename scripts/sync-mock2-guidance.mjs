// Explicit, offline-only refresh from a previously acquired authoritative release.
// No network, installer execution, application migration, or live file writes.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/sync-mock2-guidance.mjs <source-directory>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = resolve(root, 'admin/backend/src/mock2/framework-seed');
const release = JSON.parse(readFileSync(resolve(source, 'release.json'), 'utf8'));
if (release.name !== 'mock2-core' || !/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error('Invalid release identity');
const entries = release.files.filter(f => f.src === 'core/claude/CLAUDE.md' || f.src === 'core/mock2/profiles/profile-cpr.md' || f.src === 'core/mock2/templates/repo/.mock2/capacity.md' || f.src.startsWith('core/cpr/') || f.src.startsWith('core/claude/rules/'));
const files = entries.map(f => {
  if (!/^[a-zA-Z0-9_./-]+$/.test(f.src) || f.src.split('/').includes('..')) throw new Error('Invalid source path');
  const bytes = readFileSync(resolve(source, f.src));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== f.sha256 || bytes.length !== f.bytes) throw new Error(`Release hash/size mismatch: ${f.src}`);
  const relative = f.src === 'core/claude/CLAUDE.md' ? 'constitution.md'
    : f.src.startsWith('core/claude/rules/') ? f.src.slice('core/claude/'.length)
      : f.src.startsWith('core/mock2/profiles/') ? 'profile-cpr.md' : f.src.slice('core/cpr/'.length);
  const path = f.src === 'core/mock2/templates/repo/.mock2/capacity.md' ? '.mock2/capacity.md' : `.mock2/standards/${relative}`;
  return { path, source: f.src, sha256: hash, content: bytes.toString('utf8') };
});
for (const required of ['constitution.md', 'CPR-v1.1-current.md', 'Relay-Recording.md', 'Universal-Integration.md', 'Universal-Integration-New-App-Prompt.md', 'Universal-Integration-Existing-App-Prompt.md', 'stack.versions.json']) {
  if (!files.some(f => f.path === `.mock2/standards/${required}`)) throw new Error(`Missing required guidance: ${required}`);
}
// All inputs validated before any output is written.
const bundle = { family: 'mock2-core', version: release.version, updated: release.updated,
  scope: 'guidance', files };
writeFileSync(resolve(seed, 'upstream-guidance.json'), JSON.stringify(bundle, null, 2) + '\n');
const marker = '<!-- BEGIN PINNED MOCK2 GUIDANCE -->';
const old = readFileSync(resolve(seed, 'constitution.md'), 'utf8');
const original = old.includes(marker) ? old.slice(0, old.indexOf(marker)).trimEnd() : old.trimEnd();
const current = files.find(f => f.path.endsWith('/constitution.md')).content;
writeFileSync(resolve(seed, 'constitution.md'), `${original}\n\n${marker}\n# Governing Mock2 guidance: ${release.version}\n\nThe following pinned guidance supersedes historical general-workflow wording above.\nProxyPilot's concrete identity, authorization, private-data and execution contracts remain binding.\nLoad the applicable rules and CPR documents from .mock2/standards/ before dependent work.\nThis guidance adoption does not install Relay runtime/producers or migrate existing integrations.\n\n${current}\n<!-- END PINNED MOCK2 GUIDANCE -->\n`);
const metadataPath = resolve(seed, 'standards-version.json');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
Object.assign(metadata, { version: release.version, source_version: release.version, family: 'mock2-core', synced: release.updated, adoption_scope: 'guidance' });
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
console.log(`Pinned ${files.length} hash-verified Mock2 ${release.version} guidance files; no application or runtime installed.`);
