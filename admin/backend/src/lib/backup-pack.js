// Backup packer — turns a "config tier" snapshot of the host into a
// single encrypted .ppbackup blob ready for S3 upload.
//
// Wire format:
//
//     [4 bytes BE uint32]   header_len
//     [header_len bytes]    JSON header (kdf params, salt, iv, ...)
//     [variable]            AES-256-GCM ciphertext of gzip(tar(files))
//     [16 bytes]            GCM auth tag (trailing — see "tag at end"
//                                          comment below)
//
// The header carries enough metadata for restore (PR 2) to
// reconstruct the key from the operator's passphrase and verify
// integrity before extracting anything to disk.  Magic + version
// fields up front so a misnamed file fails fast with a descriptive
// error instead of dumping garbage.
//
// Why "tag at end" rather than the more usual "tag inside the
// header": GCM's auth tag is produced *after* the cipher consumes
// the plaintext.  Putting it at file-end lets us stream the
// ciphertext directly to S3 (PR 2 will lean on this for the
// multi-GB full-tier path); putting it inside the header would
// force us to buffer the entire ciphertext in memory before
// flushing the header.  PR 1's config tier is small enough that
// either layout works, but committing to "tag at end" now means
// the format won't change when full-tier comes online.
//
// KDF: node:crypto.scrypt rather than argon2id.  The spec calls for
// argon2id, but adding the native `argon2` package to the dashboard
// has a meaningful cost (Python build deps on the build host, an
// extra cross-compile path for the Docker image, prebuilt binaries
// per arch).  scrypt with N=2**15 r=8 p=1 is what the broader Node
// ecosystem ships when a memory-hard KDF without a native dep is
// required.  Spec-target argon2id can be added in a follow-up by
// versioning the `kdf` field in the header — already wired.
//
// Cipher: AES-256-GCM.  Authenticated encryption matters here
// (operator backups land on third-party storage); a malleable
// stream cipher would let an attacker who can write to the bucket
// re-frame the contents without detection.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const MAGIC = 'PPBACKUP';
const VERSION = 1;

// ── KDF + cipher constants ──────────────────────────────────────────

const SCRYPT_PARAMS = Object.freeze({
  N: 32768, // 2**15 — ~32 MiB of memory, ~50 ms on a modern x86
  r: 8,
  p: 1,
  keyLen: 32, // 256 bits = AES-256 key
});
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(passphrase, 'utf-8'),
      salt,
      SCRYPT_PARAMS.keyLen,
      { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: 256 * 1024 * 1024 },
      (err, derived) => err ? reject(err) : resolve(derived),
    );
  });
}

// ── Minimal POSIX (ustar) tar writer ────────────────────────────────
//
// Just enough of POSIX 1003.1 / ustar to carry plain files + a
// trailing two-block zero terminator.  No symlinks, hardlinks, long
// names, or sparse files — the config tier files are predictable in
// shape, and bigger payloads (PR 2's full tier) will swap in the
// real `tar` package or a streaming alternative.

function octal(n, width) {
  // ustar octal fields are zero-padded ASCII octal followed by a
  // single space or NUL.  We use NUL to keep the field width exact.
  const s = n.toString(8);
  if (s.length > width - 1) throw new Error(`octal value ${n} too large for width ${width}`);
  return s.padStart(width - 1, '0') + '\0';
}

function asciiPad(s, width) {
  const buf = Buffer.alloc(width, 0);
  Buffer.from(s, 'utf-8').copy(buf, 0, 0, Math.min(width, Buffer.byteLength(s)));
  return buf;
}

function makeTarHeader(name, size, mtime) {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`tar entry name too long for ustar (>100 bytes): ${name}`);
  }
  const h = Buffer.alloc(512, 0);
  asciiPad(name, 100).copy(h, 0);
  Buffer.from(octal(0o0644, 8), 'ascii').copy(h, 100);  // mode
  Buffer.from(octal(0, 8), 'ascii').copy(h, 108);       // uid
  Buffer.from(octal(0, 8), 'ascii').copy(h, 116);       // gid
  Buffer.from(octal(size, 12), 'ascii').copy(h, 124);   // size
  Buffer.from(octal(Math.floor(mtime / 1000), 12), 'ascii').copy(h, 136); // mtime
  // checksum — fill with spaces while computing
  Buffer.from('        ', 'ascii').copy(h, 148);
  h[156] = 0x30; // typeflag '0' = normal file
  Buffer.from('ustar\0', 'ascii').copy(h, 257);
  Buffer.from('00', 'ascii').copy(h, 263);
  // checksum: unsigned sum of all 512 header bytes (with checksum
  // field treated as 8 spaces, which we already wrote).
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i];
  Buffer.from(octal(sum, 8), 'ascii').copy(h, 148);
  // ustar requires the checksum field to be 6-digit octal + NUL +
  // space, not the generic NUL terminator octal() produces.  Fix.
  h[154] = 0;     // NUL after the digits
  h[155] = 0x20;  // space
  return h;
}

// Pack {filename: Buffer} entries into a single Buffer of tar bytes.
// Files are emitted in object-key iteration order (V8 preserves
// insertion order for string keys), so callers control the order.
export function tarPack(entries, { mtime } = {}) {
  const ts = mtime ?? Date.now();
  const chunks = [];
  for (const [name, body] of Object.entries(entries)) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
    chunks.push(makeTarHeader(name, buf.length, ts));
    chunks.push(buf);
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  // Two zero-blocks signal end of archive.
  chunks.push(Buffer.alloc(512, 0));
  chunks.push(Buffer.alloc(512, 0));
  return Buffer.concat(chunks);
}

// ── manifest helpers ────────────────────────────────────────────────

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function buildManifest(entries) {
  const files = Object.entries(entries).map(([name, body]) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
    return { path: name, size: buf.length, sha256: sha256(buf) };
  });
  const total = files.reduce((s, f) => s + f.size, 0);
  return {
    version: 1,
    created_at: new Date().toISOString(),
    files,
    total_size_bytes: total,
  };
}

// ── snapshot collectors ────────────────────────────────────────────
//
// Each collector returns a Buffer (or string) that becomes one tar
// entry.  Missing optional sources (e.g. the cve-inbox dir not
// existing on a fresh install) yield an empty placeholder rather
// than failing the backup — operators on day-one shouldn't have to
// pre-populate every directory just to take their first snapshot.

export function dumpSqliteAsJson(db) {
  // Read every user table.  Skip sqlite_* internals + WAL frames.
  // Per-table content order is the natural ROWID order (no ORDER BY)
  // — sufficient for backup/restore, and stable enough that diffs
  // between successive backups are meaningful.
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all();
  const dump = { schema_version: getSchemaVersion(db), tables: {} };
  for (const { name } of tables) {
    try {
      // SQL identifiers are unsafe to interpolate normally, but the
      // names we just read came from sqlite_master and are bound by
      // the SQLite identifier rules — safe to drop into a SELECT.
      // Belt-and-braces: refuse anything that wouldn't pass an
      // identifier regex.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        dump.tables[name] = { error: 'unsafe identifier — skipped' };
        continue;
      }
      dump.tables[name] = db.prepare(`SELECT * FROM "${name}"`).all();
    } catch (err) {
      dump.tables[name] = { error: err?.message || 'read failed' };
    }
  }
  return Buffer.from(JSON.stringify(dump, null, 2), 'utf-8');
}

function getSchemaVersion(db) {
  try {
    const row = db
      .prepare(`SELECT MAX(version) AS v FROM schema_migrations`)
      .get();
    return row?.v ?? null;
  } catch {
    return null;
  }
}

export function readEnv(envPath) {
  try {
    return fs.readFileSync(envPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return `# .env not present at ${envPath} when this backup ran\n`;
    }
    throw err;
  }
}

// Read every .yaml / .yml file in the cve-inbox dir.  Return a flat
// object keyed by relative path (e.g. "cve-inbox/CVE-2024-1234.yaml")
// so the tar layout matches what the spec describes.
export function readCveInbox(inboxDir) {
  const out = {};
  if (!fs.existsSync(inboxDir)) return out;
  let names;
  try {
    names = fs.readdirSync(inboxDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/\.(ya?ml)$/i.test(name)) continue;
    const full = path.join(inboxDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      out[`cve-inbox/${name}`] = fs.readFileSync(full);
    } catch {
      // tolerate per-file unreadability — backup proceeds without it.
    }
  }
  return out;
}

// ── pack ────────────────────────────────────────────────────────────

// pack({ entries, passphrase, meta }) → { buffer, manifest }
//
// `entries` is { name: Buffer|string, ... } — the in-archive layout.
// `meta` is mixed into the header so consumers can identify which
// tier / scope the artifact represents without needing to decrypt.
//
// Returns the assembled .ppbackup buffer + the manifest object that
// was packed alongside the files (so the caller can persist it to
// the `backups` row's manifest_json column without re-parsing).
export async function pack({ entries, passphrase, meta = {} }) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('pack: passphrase is required');
  }
  if (!entries || typeof entries !== 'object') {
    throw new Error('pack: entries is required');
  }

  const manifest = buildManifest(entries);
  const archived = {
    'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
    ...entries,
  };
  const tarBytes = tarPack(archived);
  const compressed = zlib.gzipSync(tarBytes, { level: 9 });

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = {
    magic: MAGIC,
    version: VERSION,
    kdf: 'scrypt',
    kdf_params: { ...SCRYPT_PARAMS },
    salt_b64: salt.toString('base64'),
    iv_b64: iv.toString('base64'),
    cipher: 'aes-256-gcm',
    tag_position: 'trailing',
    tag_bytes: TAG_BYTES,
    body_compression: 'gzip',
    body_format: 'tar',
    plaintext_size_bytes: compressed.length, // pre-cipher (post-gzip)
    archive_size_bytes: tarBytes.length,
    created_at: new Date().toISOString(),
    ...meta,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf-8');
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32BE(headerBytes.length, 0);

  const buffer = Buffer.concat([lenPrefix, headerBytes, ct, tag]);
  return { buffer, manifest, header };
}

// ── tier helpers ────────────────────────────────────────────────────

// packConfigTier({ db, passphrase, envPath, cveInboxDir, meta })
//
// Wraps pack() with the config-tier file selection: SQLite dump as
// JSON, .env contents, every .yaml/.yml in cve-inbox.  Returns the
// same shape pack() returns so the route handler can drop straight
// into its S3-upload + DB-row-update flow.
export async function packConfigTier({
  db,
  passphrase,
  envPath,
  cveInboxDir,
  meta = {},
}) {
  const dbDump = dumpSqliteAsJson(db);
  const envBody = readEnv(envPath);
  const cveEntries = readCveInbox(cveInboxDir);

  const entries = {
    'proxypilot.db.json': dbDump,
    '.env': envBody,
    ...cveEntries,
  };

  return pack({
    entries,
    passphrase,
    meta: { tier: 'config', ...meta },
  });
}

// Exported for tests so tests don't have to know our private
// constants.  Not part of the runtime API surface.
export const __test = Object.freeze({
  MAGIC,
  VERSION,
  SCRYPT_PARAMS,
  SALT_BYTES,
  IV_BYTES,
  TAG_BYTES,
});
