// Mock2 guidance release — selection, verification and rendering, shared by the
// offline sync script (scripts/sync-mock2-guidance.mjs, which writes the vendored
// seed) and the runtime live path (mock2/live-guidance.js, which writes the data
// dir cache). One implementation, so the vendored and the live guidance cannot
// drift in which files they carry, how they are checked, or how the pinned
// constitution block is rendered.
//
// Pure: no fs, no network, no DB. Bytes come in through a caller-supplied
// reader; strings go out. Integrity: every selected file is checked against the
// release.json it was listed in (sha256 + byte count). That proves the set is
// complete and arrived intact; it does not prove who wrote the release — the
// site is the operator's own (docs/mock2/standards-and-cpr.md).

import { createHash } from 'node:crypto';

export const GUIDANCE_FAMILY = 'mock2-core';
export const GUIDANCE_SCOPE = 'guidance';
export const PINNED_MARKER = '<!-- BEGIN PINNED MOCK2 GUIDANCE -->';
export const PINNED_END = '<!-- END PINNED MOCK2 GUIDANCE -->';
export const REQUIRED_GUIDANCE = Object.freeze([
  'constitution.md', 'CPR-v1.1-current.md', 'Relay-Recording.md', 'Universal-Integration.md',
  'Universal-Integration-New-App-Prompt.md', 'Universal-Integration-Existing-App-Prompt.md', 'stack.versions.json',
]);

// The release source of the governing constitution (rendered into the pinned
// block and shipped as .mock2/standards/constitution.md).
export const CONSTITUTION_SOURCE = 'core/claude/CLAUDE.md';
// Fetch limits for the live path: a selected file may not declare or deliver
// more than MAX_GUIDANCE_FILE_BYTES, and a release may not select more than
// MAX_GUIDANCE_ENTRIES files (30 today).
export const MAX_GUIDANCE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_GUIDANCE_ENTRIES = 200;

const SAFE_SRC = /^[a-zA-Z0-9_./-]+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Throws unless the release names the mock2-core family and a plain x.y.z version. */
export function validateReleaseIdentity(release) {
  if (!release || typeof release !== 'object' || release.name !== GUIDANCE_FAMILY || !SEMVER.test(String(release.version || ''))) {
    throw new Error('Invalid release identity');
  }
  if (!Array.isArray(release.files)) throw new Error('Invalid release: no files list');
  return release;
}

/** The release entries ProxyPilot carries as guidance. */
export function selectGuidanceEntries(release) {
  return release.files.filter((f) => f && typeof f.src === 'string' && (
    f.src === CONSTITUTION_SOURCE || f.src === 'core/mock2/profiles/profile-cpr.md'
    || f.src === 'core/mock2/templates/repo/.mock2/capacity.md'
    || f.src.startsWith('core/cpr/') || f.src.startsWith('core/claude/rules/')));
}

/** Throws on a source path that could leave the release root. */
export function assertSafeSource(src) {
  if (!SAFE_SRC.test(src) || src.split('/').includes('..')) throw new Error('Invalid source path');
  return src;
}

/** Where a release source file lands in a project (and in the bundle). */
export function guidancePathFor(src) {
  const relative = src === CONSTITUTION_SOURCE ? 'constitution.md'
    : src.startsWith('core/claude/rules/') ? src.slice('core/claude/'.length)
      : src.startsWith('core/mock2/profiles/') ? 'profile-cpr.md' : src.slice('core/cpr/'.length);
  return src === 'core/mock2/templates/repo/.mock2/capacity.md' ? '.mock2/capacity.md' : `.mock2/standards/${relative}`;
}

/** Throws unless bytes match the release entry exactly (sha256 and length). Returns the hash. */
export function verifyEntryBytes(entry, bytes) {
  const hash = sha256Hex(bytes);
  if (hash !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Release hash/size mismatch: ${entry.src}`);
  return hash;
}

/**
 * Build the guidance bundle from a release. readBytes(src) returns a Buffer (or a
 * Promise of one) for a release source path. Every input is validated before the
 * bundle is returned; nothing partial is ever returned.
 */
export async function buildGuidanceBundle(release, readBytes) {
  validateReleaseIdentity(release);
  const files = [];
  const targets = new Set();
  for (const f of selectGuidanceEntries(release)) {
    assertSafeSource(f.src);
    const target = guidancePathFor(f.src);
    if (targets.has(target)) throw new Error(`Duplicate guidance target: ${target}`);
    targets.add(target);
    const bytes = await readBytes(f.src, f);
    const hash = verifyEntryBytes(f, bytes);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`Not UTF-8 text: ${f.src}`);
    files.push({ path: target, source: f.src, sha256: hash, content });
  }
  assertRequiredGuidance(files);
  return { family: GUIDANCE_FAMILY, version: release.version, updated: release.updated, scope: GUIDANCE_SCOPE, files };
}

export function assertRequiredGuidance(files) {
  for (const required of REQUIRED_GUIDANCE) {
    if (!files.some((f) => f.path === `.mock2/standards/${required}`)) throw new Error(`Missing required guidance: ${required}`);
  }
}

/**
 * Re-verify a stored bundle against the release.json it came from: same
 * identity, every selected entry present once, every file's content hashing to
 * the release's sha256 and byte count. Used when the runtime loads its cache.
 */
export function verifyBundleAgainstRelease(bundle, release) {
  validateReleaseIdentity(release);
  if (!bundle || bundle.family !== GUIDANCE_FAMILY || bundle.scope !== GUIDANCE_SCOPE || bundle.version !== release.version || !Array.isArray(bundle.files)) {
    throw new Error('Bundle does not match its release');
  }
  const entries = selectGuidanceEntries(release);
  if (entries.length !== bundle.files.length) throw new Error('Bundle file count does not match its release');
  for (const entry of entries) {
    const file = bundle.files.find((f) => f.source === entry.src);
    if (!file || file.path !== guidancePathFor(entry.src) || typeof file.content !== 'string') throw new Error(`Bundle is missing ${entry.src}`);
    const hash = verifyEntryBytes(entry, Buffer.from(file.content, 'utf8'));
    if (file.sha256 !== hash) throw new Error(`Bundle hash mismatch: ${entry.src}`);
  }
  assertRequiredGuidance(bundle.files);
  return bundle;
}

export const serializeBundle = (bundle) => JSON.stringify(bundle, null, 2) + '\n';

/** The canonical constitution text a bundle carries. */
export function bundleConstitution(bundle) {
  const f = bundle.files.find((x) => x.source === CONSTITUTION_SOURCE);
  if (!f) throw new Error('Missing required guidance: constitution.md');
  return f.content;
}

/**
 * The platform constitution with the pinned guidance block (re)rendered for a
 * bundle: everything before the marker is kept; the block is replaced.
 */
export function renderPinnedConstitution(platformConstitution, bundle) {
  const old = String(platformConstitution);
  const original = old.includes(PINNED_MARKER) ? old.slice(0, old.indexOf(PINNED_MARKER)).trimEnd() : old.trimEnd();
  return `${original}\n\n${PINNED_MARKER}\n# Governing Mock2 guidance: ${bundle.version}\n\nThe following pinned guidance supersedes historical general-workflow wording above.\nProxyPilot's concrete identity, authorization, private-data and execution contracts remain binding.\nLoad the applicable rules and CPR documents from .mock2/standards/ before dependent work.\nThis guidance adoption does not install Relay runtime/producers or migrate existing integrations.\n\n${bundleConstitution(bundle)}\n${PINNED_END}\n`;
}

/**
 * Throws before anything is downloaded when a release selects too many files or
 * declares one larger than the cap (the download itself is capped as well).
 */
export function assertFetchLimits(entries, { maxEntries = MAX_GUIDANCE_ENTRIES, maxBytes = MAX_GUIDANCE_FILE_BYTES } = {}) {
  if (entries.length > maxEntries) throw new Error(`Release selects ${entries.length} guidance files (limit ${maxEntries})`);
  for (const e of entries) {
    if (!Number.isInteger(e.bytes) || e.bytes < 0 || e.bytes > maxBytes) throw new Error(`Release entry ${e.src} declares ${e.bytes} bytes (limit ${maxBytes})`);
  }
  return entries;
}

/**
 * True when the release's selected files are exactly the bundle's files (same
 * targets, same sha256): a version-only release that changes no guidance.
 */
export function sameGuidanceContent(entries, bundle) {
  if (!bundle || !Array.isArray(bundle.files) || entries.length !== bundle.files.length) return false;
  const have = new Map(bundle.files.map((f) => [f.path, f.sha256]));
  return entries.every((e) => have.get(guidancePathFor(e.src)) === e.sha256);
}

/** The Mock2 version named in a constitution's pinned block, or null. */
export function pinnedGuidanceVersion(constitution) {
  const text = String(constitution || '');
  const at = text.indexOf(PINNED_MARKER);
  if (at < 0) return null;
  const m = text.slice(at).match(/^# Governing Mock2 guidance: (\d+\.\d+\.\d+)$/m);
  return m ? m[1] : null;
}

/**
 * The seed's platform sections with another constitution's pinned block: used
 * when the published guidance is newer than what this process can render (the
 * live cache is gone), so a platform change still lands without a downgrade.
 */
export function keepPinnedBlock(platformConstitution, publishedConstitution) {
  const old = String(platformConstitution);
  const original = old.includes(PINNED_MARKER) ? old.slice(0, old.indexOf(PINNED_MARKER)).trimEnd() : old.trimEnd();
  const pub = String(publishedConstitution);
  return `${original}\n\n${pub.slice(pub.indexOf(PINNED_MARKER))}`;
}

/** standards-version.json after adopting a release (the vendored seed only). */
export function renderStandardsVersion(metadata, release) {
  return JSON.stringify(Object.assign({ ...metadata }, { version: release.version, source_version: release.version, family: GUIDANCE_FAMILY, synced: release.updated, adoption_scope: GUIDANCE_SCOPE }), null, 2) + '\n';
}

/** Numeric x.y.z compare (-1 / 0 / 1); anything unparseable reads as 0.0.0. */
export function compareGuidanceVersions(a, b) {
  const pa = SEMVER.test(String(a || '')) ? String(a).split('.').map(Number) : [0, 0, 0];
  const pb = SEMVER.test(String(b || '')) ? String(b).split('.').map(Number) : [0, 0, 0];
  for (let i = 0; i < 3; i++) { if (pa[i] > pb[i]) return 1; if (pa[i] < pb[i]) return -1; }
  return 0;
}

/**
 * Where release.json and the files live for a pinned standards source. The
 * source is the manifest URL (`…/manifest.json`, the mcp.standards_source_url
 * setting or the seed default); release.json sits beside it and every file at
 * `<base>/<src>`. Throws on anything but an https manifest URL.
 */
export function releaseLocations(manifestUrl) {
  let u;
  try { u = new URL(String(manifestUrl || '')); } catch { throw new Error('standards source is not a URL'); }
  if (u.protocol !== 'https:' || !u.pathname.endsWith('/manifest.json') || u.username || u.password) {
    throw new Error('standards source must be an https URL ending in /manifest.json');
  }
  u.search = ''; u.hash = '';
  const base = new URL('./', u);
  return {
    site: base.href.replace(/\/$/, ''),
    release: new URL('release.json', base).href,
    file: (src) => new URL(assertSafeSource(src), base).href,
  };
}
