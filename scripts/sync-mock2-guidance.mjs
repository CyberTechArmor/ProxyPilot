// Explicit, offline-only refresh from a previously acquired authoritative release.
// No network, installer execution, application migration, or live file writes.
// Selection, hash/size verification and the pinned-constitution rendering live in
// admin/backend/src/mock2/guidance-release-logic.js, which the runtime live path
// (mock2/live-guidance.js) uses too, so the vendored seed and live guidance match.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGuidanceBundle, serializeBundle, renderPinnedConstitution, renderStandardsVersion,
} from '../admin/backend/src/mock2/guidance-release-logic.js';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/sync-mock2-guidance.mjs <source-directory> [seed-directory]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The optional second argument writes into another directory (a copy of the seed),
// so the output can be compared without touching the checkout.
const seed = resolve(process.argv[3] || resolve(root, 'admin/backend/src/mock2/framework-seed'));
const release = JSON.parse(readFileSync(resolve(source, 'release.json'), 'utf8'));
const bundle = await buildGuidanceBundle(release, (src) => readFileSync(resolve(source, src)));
// All inputs validated before any output is written.
writeFileSync(resolve(seed, 'upstream-guidance.json'), serializeBundle(bundle));
writeFileSync(resolve(seed, 'constitution.md'), renderPinnedConstitution(readFileSync(resolve(seed, 'constitution.md'), 'utf8'), bundle));
const metadataPath = resolve(seed, 'standards-version.json');
writeFileSync(metadataPath, renderStandardsVersion(JSON.parse(readFileSync(metadataPath, 'utf8')), release));
console.log(`Pinned ${bundle.files.length} hash-verified Mock2 ${release.version} guidance files; no application or runtime installed.`);
