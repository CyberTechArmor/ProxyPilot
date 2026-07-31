// Zip inspection + staged extraction for the "upload a site as a
// zip" flows (static sites and LXC app drops).
//
// Hand-rolled central-directory parser, same spirit as the minimal
// ustar writer in lib/backup-pack.js: the subset of the format we
// accept is small and predictable (stored/deflate entries, no
// encryption, no zip64), and owning the parser means every byte we
// act on has been validated here — nothing is delegated to a
// library that might "helpfully" honor absolute paths or symlinks.
//
// Threat model (why the checks below exist):
//   - zip-slip: entry names like `../../etc/passwd` or `/etc/passwd`
//     must never influence where bytes land. Every name is validated
//     before any fs call, and extraction re-resolves against the
//     target root as a belt-and-braces check.
//   - symlink smuggling: a zip can carry a symlink entry pointing
//     outside the target, then a later entry writing "through" it.
//     We reject symlink entries outright — none of the intended
//     payloads (built site bundles, app drops) legitimately need them.
//   - zip bombs: both the declared uncompressed sizes (checked before
//     any inflate) and the actual inflated byte counts (checked while
//     extracting) are capped, as is the entry count.
//
// All functions are pure or fs-local (no DB, no exec) so tests can
// drive them with in-memory zip buffers.

import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import {
  mkdir, rename, rm, stat, writeFile, chmod, copyFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// Central limits. Env-overridable so operators with unusual payloads
// aren't stuck, but the defaults are deliberately conservative for a
// "here is my dist/ folder" workflow.
export const ZIP_LIMITS = {
  maxZipBytes: parseInt(process.env.PROXYPILOT_ZIP_UPLOAD_LIMIT_BYTES || String(256 * 1024 * 1024), 10),
  maxExtractedBytes: parseInt(process.env.PROXYPILOT_ZIP_EXTRACT_LIMIT_BYTES || String(1024 * 1024 * 1024), 10),
  maxEntries: parseInt(process.env.PROXYPILOT_ZIP_MAX_ENTRIES || String(20000), 10),
};

// Typed error so routes can map failures to stable HTTP codes +
// user-facing messages without string-matching.
export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code; // BAD_ZIP | PATH_VIOLATION | TOO_LARGE | UNSUPPORTED
  }
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
const S_IFDIR = 0x4000;

// ── Entry-name validation ───────────────────────────────────────────
//
// Returns the normalized (forward-slash, no trailing slash) path or
// throws ZipError(PATH_VIOLATION). Directory-ness is carried
// separately by the caller.
export function validateEntryName(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw new ZipError('PATH_VIOLATION', 'Zip entry has an empty name');
  }
  if (rawName.length > 1024) {
    throw new ZipError('PATH_VIOLATION', 'Zip entry name is too long');
  }
  // Control chars (incl. NUL and newline) break the downstream
  // shell/list plumbing and have no place in a file name.
  for (let i = 0; i < rawName.length; i++) {
    const c = rawName.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new ZipError('PATH_VIOLATION', 'Zip entry name contains control characters');
    }
  }
  if (rawName.includes('\\')) {
    throw new ZipError('PATH_VIOLATION', `Zip entry uses backslash separators: ${rawName}`);
  }
  if (rawName.startsWith('/')) {
    throw new ZipError('PATH_VIOLATION', `Zip entry has an absolute path: ${rawName}`);
  }
  // Windows drive prefixes (C:foo) — never legitimate in our payloads.
  if (/^[a-zA-Z]:/.test(rawName)) {
    throw new ZipError('PATH_VIOLATION', `Zip entry has a drive-prefixed path: ${rawName}`);
  }
  const name = rawName.replace(/\/+$/, '');
  const segments = name.split('/');
  if (segments.length > 64) {
    throw new ZipError('PATH_VIOLATION', `Zip entry is nested too deep: ${rawName}`);
  }
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ZipError('PATH_VIOLATION', `Zip entry has an unsafe path segment: ${rawName}`);
    }
  }
  return name;
}

// ── Central-directory parse ─────────────────────────────────────────
//
// parseZip(buf) → { entries, totalUncompressedBytes }
//
// entries: [{ path, isDirectory, mode, method, compressedSize,
//             uncompressedSize, localHeaderOffset }]
// Directory entries are kept (they matter for wrapper detection) but
// carry no data. Symlinks, encrypted entries, zip64 and unknown
// compression methods are rejected here, before any extraction.
export function parseZip(buf, limits = ZIP_LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new ZipError('BAD_ZIP', 'File is too small to be a zip archive');
  }
  if (buf.length > limits.maxZipBytes) {
    throw new ZipError('TOO_LARGE', `Zip exceeds the ${Math.floor(limits.maxZipBytes / (1024 * 1024))} MB upload limit`);
  }

  // Locate the End Of Central Directory record: scan backwards over
  // the maximum possible trailing comment.
  let eocd = -1;
  const scanFloor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) {
    throw new ZipError('BAD_ZIP', 'Not a zip archive (missing end-of-central-directory record)');
  }

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError('UNSUPPORTED', 'Zip64 archives are not supported — re-zip with a smaller archive');
  }
  if (totalEntries > limits.maxEntries) {
    throw new ZipError('TOO_LARGE', `Zip contains ${totalEntries} entries (limit ${limits.maxEntries})`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipError('BAD_ZIP', 'Corrupt zip: central directory overruns the file');
  }

  const entries = [];
  let totalUncompressedBytes = 0;
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDIR_SIG) {
      throw new ZipError('BAD_ZIP', 'Corrupt zip: bad central directory entry');
    }
    const versionMadeBy = buf.readUInt16LE(off + 4);
    const gpFlags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const externalAttrs = buf.readUInt32LE(off + 38);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const rawName = buf.slice(off + 46, off + 46 + nameLen).toString('utf-8');
    off += 46 + nameLen + extraLen + commentLen;

    if (gpFlags & 0x0001) {
      throw new ZipError('UNSUPPORTED', `Zip entry is encrypted: ${rawName}`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError('UNSUPPORTED', `Zip entry uses an unsupported compression method (${method}): ${rawName}`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipError('UNSUPPORTED', 'Zip64 entries are not supported');
    }

    const path = validateEntryName(rawName);
    // Unix mode only when the entry was made on a Unix-ish host;
    // otherwise the high external-attr bytes are meaningless.
    const madeOnUnix = (versionMadeBy >> 8) === 3;
    const mode = madeOnUnix ? (externalAttrs >>> 16) : 0;
    if ((mode & S_IFMT) === S_IFLNK) {
      throw new ZipError('PATH_VIOLATION', `Zip contains a symlink entry (not allowed): ${rawName}`);
    }
    const isDirectory = rawName.endsWith('/') || (mode & S_IFMT) === S_IFDIR;
    if (!isDirectory) totalUncompressedBytes += uncompressedSize;

    entries.push({
      path, isDirectory, mode, method,
      compressedSize, uncompressedSize, localHeaderOffset,
    });
  }

  if (totalUncompressedBytes > limits.maxExtractedBytes) {
    throw new ZipError('TOO_LARGE', `Zip would extract to ${Math.ceil(totalUncompressedBytes / (1024 * 1024))} MB (limit ${Math.floor(limits.maxExtractedBytes / (1024 * 1024))} MB)`);
  }
  const fileEntries = entries.filter((e) => !e.isDirectory);
  if (fileEntries.length === 0) {
    throw new ZipError('BAD_ZIP', 'Zip contains no files');
  }
  // Duplicate paths (case-sensitive) — later entries would silently
  // clobber earlier ones; surface it instead.
  const seen = new Set();
  for (const e of fileEntries) {
    if (seen.has(e.path)) {
      throw new ZipError('BAD_ZIP', `Zip contains duplicate entry: ${e.path}`);
    }
    seen.add(e.path);
  }

  return { entries, totalUncompressedBytes };
}

// ── Wrapper-folder detection ────────────────────────────────────────
//
// A zip of a build output is often `dist/index.html`, `dist/assets/…`
// — a single top-level folder wrapping everything. Serving that
// as-is would put the site at site.com/dist/, so callers offer (and
// default to) stripping the wrapper. Returns the wrapper directory
// name, or null when files live at the zip root or there are
// multiple top-level entries.
export function detectWrapperDir(entries) {
  const topLevel = new Set();
  let rootFiles = 0;
  for (const e of entries) {
    const firstSeg = e.path.split('/')[0];
    topLevel.add(firstSeg);
    if (!e.isDirectory && !e.path.includes('/')) rootFiles++;
  }
  if (rootFiles > 0 || topLevel.size !== 1) return null;
  return [...topLevel][0];
}

// stripWrapper(entries, wrapper) → entries re-rooted below the
// wrapper folder (the wrapper's own directory entry is dropped).
export function stripWrapper(entries, wrapper) {
  const prefix = `${wrapper}/`;
  const out = [];
  for (const e of entries) {
    if (e.path === wrapper) continue; // the wrapper dir itself
    if (!e.path.startsWith(prefix)) {
      throw new ZipError('BAD_ZIP', `Entry outside wrapper folder: ${e.path}`);
    }
    out.push({ ...e, path: e.path.slice(prefix.length) });
  }
  return out;
}

// effectiveEntries(parsed.entries, stripWrapperFlag) — the entry list
// as it will land on disk, honoring the wrapper option.
export function effectiveEntries(entries, doStrip) {
  const wrapper = detectWrapperDir(entries);
  if (doStrip && wrapper) return stripWrapper(entries, wrapper);
  return entries;
}

// ── Conflict detection ──────────────────────────────────────────────
//
// findConflicts(entries, existsKind) — existsKind(path) returns
// 'file' | 'dir' | null for a path relative to the target root.
//
// A conflict is anything the apply step will rename to `.old`:
//   - zip file over existing file (the common case);
//   - zip file over existing directory (the dir moves to `.old`);
//   - zip directory over existing *file* (the file moves to `.old`
//     so the directory can be created).
// Existing directory + zip directory is a merge, not a conflict —
// per the feature contract, conflicts apply to files, not to
// directories that simply already exist.
export function findConflicts(entries, existsKind) {
  const conflicts = new Set();
  const impliedDirs = new Set();
  for (const e of entries) {
    // Every ancestor dir the extraction will need.
    const segs = e.path.split('/');
    const upto = e.isDirectory ? segs.length : segs.length - 1;
    for (let i = 1; i <= upto; i++) {
      impliedDirs.add(segs.slice(0, i).join('/'));
    }
    if (e.isDirectory) continue;
    if (existsKind(e.path)) conflicts.add(e.path); // file or dir in the way
  }
  for (const d of impliedDirs) {
    if (existsKind(d) === 'file') conflicts.add(d);
  }
  return [...conflicts].sort();
}

// Every path findConflicts will ask existsKind about — lets remote
// backends (the LXC flow) answer the whole set with one batched
// existence check instead of one exec per path.
export function collectCandidatePaths(entries) {
  const set = new Set();
  for (const e of entries) {
    const segs = e.path.split('/');
    const upto = e.isDirectory ? segs.length : segs.length - 1;
    for (let i = 1; i <= upto; i++) set.add(segs.slice(0, i).join('/'));
    if (!e.isDirectory) set.add(e.path);
  }
  return [...set];
}

// Local-fs existsKind for the static-site flow.
export function fsExistsKind(targetDir) {
  return (relPath) => {
    const full = join(targetDir, relPath);
    if (!existsSync(full)) return null;
    try {
      // lstat semantics not needed — symlinks inside the site dir are
      // operator-made; treat whatever the path is as its stat kind.
      const s = statSyncSafe(full);
      if (!s) return null;
      return s.isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  };
}

import { statSync } from 'node:fs';
function statSyncSafe(p) {
  try { return statSync(p); } catch { return null; }
}

// ── Extraction ──────────────────────────────────────────────────────
//
// extractEntryData(buf, entry) — inflate (or copy) one entry's bytes,
// verifying the actual size against the declared one so a lying
// header can't blow past the bomb cap.
export function extractEntryData(buf, entry, limits = ZIP_LIMITS) {
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIG) {
    throw new ZipError('BAD_ZIP', `Corrupt zip: bad local header for ${entry.path}`);
  }
  // Local name/extra lengths can differ from the central directory's
  // (extra fields especially) — always use the local ones to find data.
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new ZipError('BAD_ZIP', `Corrupt zip: entry data overruns the file: ${entry.path}`);
  }
  const raw = buf.slice(dataStart, dataEnd);
  let data;
  if (entry.method === 0) {
    data = raw;
  } else {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(limits.maxExtractedBytes, entry.uncompressedSize) });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /output length/i.test(err?.message || '')) {
        throw new ZipError('TOO_LARGE', `Zip entry inflates past its declared size: ${entry.path}`);
      }
      throw new ZipError('BAD_ZIP', `Corrupt zip entry (inflate failed): ${entry.path}`);
    }
  }
  if (data.length !== entry.uncompressedSize) {
    throw new ZipError('BAD_ZIP', `Zip entry size mismatch (declared ${entry.uncompressedSize}, got ${data.length}): ${entry.path}`);
  }
  return data;
}

// extractToStaging(buf, entries, stagingDir) — write every file entry
// under stagingDir, creating directories as needed and preserving the
// Unix permission bits (the exec bit matters for LXC startup
// scripts). Every write re-resolves against the staging root — the
// entry names were validated at parse, this is defense in depth.
export async function extractToStaging(buf, entries, stagingDir, limits = ZIP_LIMITS) {
  const root = resolve(stagingDir);
  await mkdir(root, { recursive: true });
  let written = 0;
  for (const e of entries) {
    const dest = resolve(root, e.path);
    if (dest !== root && !dest.startsWith(root + '/')) {
      throw new ZipError('PATH_VIOLATION', `Refusing to extract outside target: ${e.path}`);
    }
    if (e.isDirectory) {
      await mkdir(dest, { recursive: true });
      continue;
    }
    const data = extractEntryData(buf, e, limits);
    written += data.length;
    if (written > limits.maxExtractedBytes) {
      throw new ZipError('TOO_LARGE', 'Zip exceeds the extracted-size limit');
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
    const permBits = e.mode & 0o777;
    if (permBits & 0o111) {
      // Preserve the exec bit; keep files at least owner-rw so the
      // backend can manage them afterwards.
      await chmod(dest, (permBits | 0o600) & 0o777);
    }
  }
  return { bytesWritten: written };
}

// ── Apply (rename-and-move) ─────────────────────────────────────────
//
// applyStagingToTarget(stagingDir, targetDir, entries, conflicts)
//
// The commit step for the static-site flow. Assumes the staging dir
// holds a fully validated extraction (extractToStaging succeeded).
//   1. For each confirmed conflict: replace any stale `<p>.old`, then
//      rename the live file to `<p>.old`.
//   2. Move every staged file into place (rename; per-file temp +
//      rename fallback when staging sits on another filesystem).
//
// Callers create stagingDir *inside or next to* targetDir so step 2
// is plain rename() — atomic per file.
export async function applyStagingToTarget(stagingDir, targetDir, entries, conflicts) {
  const targetRoot = resolve(targetDir);
  const stagingRoot = resolve(stagingDir);

  for (const relPath of conflicts) {
    const live = resolve(targetRoot, relPath);
    if (!live.startsWith(targetRoot + '/')) {
      throw new ZipError('PATH_VIOLATION', `Refusing conflict rename outside target: ${relPath}`);
    }
    if (!existsSync(live)) continue; // vanished since inspect — nothing to keep
    const old = `${live}.old`;
    await rm(old, { recursive: true, force: true });
    await rename(live, old);
  }

  for (const e of entries) {
    if (e.isDirectory) {
      await mkdir(resolve(targetRoot, e.path), { recursive: true });
      continue;
    }
    const src = resolve(stagingRoot, e.path);
    const dest = resolve(targetRoot, e.path);
    if (!dest.startsWith(targetRoot + '/')) {
      throw new ZipError('PATH_VIOLATION', `Refusing to move outside target: ${e.path}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(src, dest);
    } catch (err) {
      if (err?.code !== 'EXDEV') throw err;
      // Cross-device staging: copy to a temp name in the final dir,
      // then rename into place so readers never see partial bytes.
      const tmp = `${dest}.pp-tmp-${randomUUID()}`;
      await copyFile(src, tmp);
      const s = await stat(src);
      await chmod(tmp, s.mode & 0o777);
      await rename(tmp, dest);
    }
  }
  await rm(stagingRoot, { recursive: true, force: true });
}
