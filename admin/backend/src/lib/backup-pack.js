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
// KDF: argon2id by default (RFC 9106 / OWASP recommended).
// Operators on hosts where the argon2 native module won't build
// can pin scrypt via PROXYPILOT_BACKUP_KDF=scrypt.  See
// lib/backup-kdf.js for the dispatcher.  v1 backups (pre this
// commit) all use scrypt; the decrypt path handles both.
//
// Cipher: AES-256-GCM.  Authenticated encryption matters here
// (operator backups land on third-party storage); a malleable
// stream cipher would let an attacker who can write to the bucket
// re-frame the contents without detection.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  freshKey, SCRYPT_PARAMS, ARGON2ID_PARAMS,
} from './backup-kdf.js';
import { spawnHostSync, hasHostBinary } from './host-exec.js';

const MAGIC = 'PPBACKUP';
const VERSION = 2; // v2: argon2id default; v1 (scrypt) still readable

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

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

// Split a path into (prefix, name) per ustar rules: name must fit
// in 100 bytes, prefix in 155 bytes; reconstructed path is
// prefix+'/'+name. We split on the last '/' that keeps both halves
// within their fields. Throws for anything that can't be expressed
// — GNU `LongLink` extension would handle the leftovers but isn't
// portable, and our backup paths shouldn't realistically exceed
// the 256-byte ustar ceiling.
function splitTarPath(fullName) {
  const bytes = Buffer.byteLength(fullName);
  if (bytes <= 100) return { prefix: '', name: fullName };
  if (bytes > 100 + 1 + 155) {
    throw new Error(
      `tar entry path too long for ustar (>256 bytes): ${fullName}`,
    );
  }
  // Walk the slashes from right to left; pick the deepest split
  // such that the right half fits in 100 and the left in 155.
  let lastValid = -1;
  for (let i = fullName.length - 1; i >= 0; i -= 1) {
    if (fullName.charCodeAt(i) !== 0x2f) continue; // '/'
    const right = fullName.slice(i + 1);
    const left = fullName.slice(0, i);
    if (Buffer.byteLength(right) <= 100 && Buffer.byteLength(left) <= 155) {
      lastValid = i;
      break;
    }
  }
  if (lastValid < 0) {
    throw new Error(
      `tar entry path cannot be split into prefix+name within ustar limits: ${fullName}`,
    );
  }
  return {
    prefix: fullName.slice(0, lastValid),
    name: fullName.slice(lastValid + 1),
  };
}

function makeTarHeader(fullName, size, mtime, { typeflag = 0x30 } = {}) {
  const { prefix, name } = splitTarPath(fullName);
  const h = Buffer.alloc(512, 0);
  asciiPad(name, 100).copy(h, 0);
  Buffer.from(octal(0o0644, 8), 'ascii').copy(h, 100);  // mode
  Buffer.from(octal(0, 8), 'ascii').copy(h, 108);       // uid
  Buffer.from(octal(0, 8), 'ascii').copy(h, 116);       // gid
  Buffer.from(octal(size, 12), 'ascii').copy(h, 124);   // size
  Buffer.from(octal(Math.floor(mtime / 1000), 12), 'ascii').copy(h, 136); // mtime
  // Checksum field: pre-fill with 8 spaces so the computed sum
  // treats those bytes as 0x20 — required by the spec, otherwise
  // a verifying reader can't reproduce the value we write below.
  Buffer.from('        ', 'ascii').copy(h, 148);
  h[156] = typeflag; // 0x30 '0' = normal file, 0x35 '5' = directory
  Buffer.from('ustar\0', 'ascii').copy(h, 257);
  Buffer.from('00', 'ascii').copy(h, 263);
  if (prefix) asciiPad(prefix, 155).copy(h, 345);
  // Checksum = unsigned sum of all 512 header bytes (with the
  // checksum field treated as 8 spaces, which we wrote above).
  // Field layout per POSIX 1003.1: 6-digit zero-padded octal,
  // followed by NUL, followed by space — exactly 8 bytes.
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i];
  const sumOct = sum.toString(8).padStart(6, '0');
  Buffer.from(sumOct, 'ascii').copy(h, 148); // 6 chars at 148-153
  h[154] = 0;     // NUL terminator
  h[155] = 0x20;  // trailing space
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

  const iv = crypto.randomBytes(IV_BYTES);
  // freshKey: argon2id by default, scrypt when pinned via env.
  // The KDF spec lands in the header alongside the salt so the
  // decrypt path can reproduce the key without operator
  // intervention later.  Pinning to scrypt is also how this
  // module stays test-runnable in environments where the
  // argon2 native module won't build.
  const { key, salt, kdf, kdf_params } = await freshKey(passphrase, SALT_BYTES);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = {
    magic: MAGIC,
    version: VERSION,
    kdf,
    kdf_params,
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

// ── file-tree collectors ────────────────────────────────────────────
//
// Reusable helpers that walk a directory and turn it into a flat
// {path: Buffer} map suitable for pack().  All readers tolerate
// per-file unreadability and per-directory absence — backups
// should never fail because one obscure file's perms are wrong.
//
// Two safety rails matter:
//   * SKIP_DIR_NAMES: directories we never want in a backup
//     (cache trees, VCS internals, the dashboard's own
//     node_modules — never restore-relevant).
//   * MAX_FILE_BYTES: hard cap on individual file size in a tier
//     that's supposed to be small.  Caddy sometimes leaves multi-
//     GB log files in /var/lib/caddy that no operator wants in
//     their nightly backup.

const SKIP_DIR_NAMES = new Set([
  'node_modules', '__pycache__', '.git', '.cache',
  // `tmp` directories anywhere in /etc are almost always reload-
  // staging dirs that get blown away on restart; archiving them
  // creates restore-time churn for no value.
  'tmp',
]);

// Walk `dir` recursively, returning { relPath: Buffer } where
// relPath is rooted at `archivePrefix` (e.g. 'caddy', 'wireguard').
// Symbolic links are followed for files (we want their target
// content) and skipped for directories (would create infinite
// recursion on /etc/letsencrypt → /var/lib/letsencrypt loops).
export function collectDirAsEntries(rootDir, archivePrefix, opts = {}) {
  const out = {};
  const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024; // 256 MiB per file
  if (!fs.existsSync(rootDir)) return out;

  const stack = [{ abs: rootDir, rel: '' }];
  while (stack.length) {
    const { abs, rel } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — tolerate
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.env') {
        // Hidden files are case-by-case.  We skip dot-files in
        // arbitrary subtrees but keep '.env' specifically because
        // it's the one operators DO want backed up.  Dot-dirs
        // also fall through to SKIP_DIR_NAMES below if listed.
      }
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      try {
        if (ent.isDirectory()) {
          stack.push({ abs: childAbs, rel: childRel });
          continue;
        }
        if (ent.isSymbolicLink()) {
          // Follow link to file; reject if it resolves to a dir
          // (infinite recursion guard).
          const realStat = fs.statSync(childAbs);
          if (realStat.isDirectory()) continue;
          if (realStat.size > maxBytes) continue;
          out[`${archivePrefix}/${childRel}`] = fs.readFileSync(childAbs);
          continue;
        }
        if (!ent.isFile()) continue;
        const stat = fs.statSync(childAbs);
        if (stat.size > maxBytes) continue;
        out[`${archivePrefix}/${childRel}`] = fs.readFileSync(childAbs);
      } catch {
        // Per-file failures don't fail the backup — the manifest
        // just won't list the file we couldn't read.
      }
    }
  }
  return out;
}

// ── shell-out collectors (full tier only) ──────────────────────────
//
// These shell to docker / incus to capture per-volume tarballs and
// per-instance exports.  Each helper returns { added: {...},
// errors: [...] } so the caller can include the errors in the
// manifest's notes field rather than failing the whole tier when
// one volume is unreadable.

// Make a sandbox temp directory rooted under os.tmpdir() with mode
// 0o700.  Caller is responsible for cleaning it up (best-effort
// finally block).
export function mkdtempSandbox(prefix = 'pp-backup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// docker volume export — tar the volume's contents using a
// throwaway alpine container.  Returns the bytes of the tar.gz.
// Returns null + an error string when docker is unavailable or the
// volume is missing (caller decides how strict to be).
//
// All shell-outs go through spawnHostSync so the dashboard
// container can drive the host's docker / incus daemons via
// nsenter.  Pre-this-fix the bare spawnSync('docker', ...) call
// looked for docker in the dashboard container's PATH (where it
// isn't) and silently skipped every volume — full-tier backups
// landed with zero docker-volumes/ entries inside the artifact.
export function exportDockerVolume(volumeName) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(volumeName)) {
    return { ok: false, error: `unsafe docker volume name: ${volumeName}` };
  }
  if (!hasHostBinary('docker')) {
    return { ok: false, error: 'docker not available on this host' };
  }
  const r = spawnHostSync('docker', [
    'run', '--rm', '-v', `${volumeName}:/source:ro`,
    'alpine:3.20', 'sh', '-c', 'tar -cz -C /source . 2>/dev/null',
  ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 * 1024, timeout: 30 * 60_000 });
  if (r.status !== 0) {
    return {
      ok: false,
      error: (r.stderr ?? Buffer.from('')).toString('utf-8').trim() || 'docker run failed',
    };
  }
  return { ok: true, bytes: r.stdout };
}

export function listDockerVolumes() {
  if (!hasHostBinary('docker')) return { ok: false, names: [], error: 'docker unavailable' };
  const r = spawnHostSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], {
    encoding: 'utf-8', timeout: 30_000,
  });
  if (r.status !== 0) {
    return { ok: false, names: [], error: r.stderr?.trim() || 'docker volume ls failed' };
  }
  return {
    ok: true,
    names: r.stdout.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

// `incus export <name> <path>` writes a tarball to disk on the
// HOST (because it runs there via nsenter).  We then `cat` the
// resulting file back into the dashboard container so the
// caller can read it normally.  Same cross-namespace dance as
// snapshot-s3-export.exportSnapshotToTmp().
export function exportIncusInstance(instanceName, sandboxDir) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(instanceName)) {
    return { ok: false, error: `unsafe incus instance name: ${instanceName}` };
  }
  if (!hasHostBinary('incus')) {
    return { ok: false, error: 'incus not available on this host' };
  }
  const hostOut = `/tmp/pp-incus-export-${process.pid}-${Date.now()}-${instanceName}.tar.gz`;
  const r = spawnHostSync('incus', ['export', instanceName, hostOut, '--compression', 'gzip'], {
    encoding: 'utf-8', timeout: 60 * 60_000,
  });
  if (r.status !== 0) {
    spawnHostSync('rm', ['-f', hostOut], { encoding: 'utf-8' });
    return { ok: false, error: r.stderr?.trim() || 'incus export failed' };
  }
  try {
    const cat = spawnHostSync('cat', [hostOut], {
      encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 * 1024,
    });
    spawnHostSync('rm', ['-f', hostOut], { encoding: 'utf-8' });
    if (cat.status !== 0) {
      throw new Error((cat.stderr?.toString?.() || 'cat failed').trim());
    }
    // sandboxDir is for caller's housekeeping; we return the
    // bytes directly rather than writing through it (the caller
    // composes the archive in-memory).
    return { ok: true, bytes: cat.stdout };
  } catch (err) {
    spawnHostSync('rm', ['-f', hostOut], { encoding: 'utf-8' });
    return { ok: false, error: `cross-namespace copy failed: ${err?.message || err}` };
  }
}

export function listIncusInstances() {
  if (!hasHostBinary('incus')) return { ok: false, names: [], error: 'incus unavailable' };
  const r = spawnHostSync('incus', ['list', '-f', 'csv', '-c', 'n'], {
    encoding: 'utf-8', timeout: 30_000,
  });
  if (r.status !== 0) {
    return { ok: false, names: [], error: r.stderr?.trim() || 'incus list failed' };
  }
  return {
    ok: true,
    names: r.stdout.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

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

// packConfigPlusDataTier — config tier + per-host config trees +
// per-service file roots + ACME cert tree.  Still in-memory; the
// total typically lands in the 10-100 MB range on a healthy
// install.  Anything larger should be on the full tier.
//
// Layout under the archive:
//   proxypilot.db.json              ← config tier
//   .env                            ← config tier
//   cve-inbox/                      ← config tier
//   caddy/                          ← /etc/caddy
//   wireguard/                      ← /etc/wireguard
//   caddy-acme/                     ← /var/lib/caddy/.local/share/caddy
//   services/                       ← /opt/proxypilot/data/services
export async function packConfigPlusDataTier({
  db,
  passphrase,
  envPath,
  cveInboxDir,
  caddyDir = '/etc/caddy',
  wireguardDir = '/etc/wireguard',
  caddyAcmeDir = '/var/lib/caddy/.local/share/caddy',
  servicesDir,
  installDir,
  // scopeFilter: { all, service_names, ... } from
  // lib/backup-scope.resolveScope().  When .all is true we pack
  // every services/<name>/ subdir; otherwise we filter the
  // collector output to only those names.
  scopeFilter = { all: true },
  meta = {},
}) {
  const dbDump = dumpSqliteAsJson(db);
  const envBody = readEnv(envPath);
  const cveEntries = readCveInbox(cveInboxDir);
  const resolvedServicesDir = servicesDir
    ?? path.join(installDir || '/opt/proxypilot', 'data', 'services');

  const allServiceEntries = collectDirAsEntries(resolvedServicesDir, 'services');
  const serviceEntries = scopeFilter?.all === false
    ? filterServiceEntries(allServiceEntries, scopeFilter.service_names || [])
    : allServiceEntries;

  const entries = {
    'proxypilot.db.json': dbDump,
    '.env': envBody,
    ...cveEntries,
    // Caddy + WireGuard + ACME certs are always full-host —
    // scope filtering doesn't apply to them.  An operator who
    // wants per-service caddy fragment scoping should ask for
    // a follow-up that walks /etc/caddy/sites/<name> the same
    // way services/ is walked.
    ...collectDirAsEntries(caddyDir, 'caddy'),
    ...collectDirAsEntries(wireguardDir, 'wireguard'),
    ...collectDirAsEntries(caddyAcmeDir, 'caddy-acme'),
    ...serviceEntries,
  };

  return pack({
    entries,
    passphrase,
    meta: {
      tier: 'config_plus_data',
      scope_all: scopeFilter?.all !== false,
      scope_service_count: scopeFilter?.service_names?.length || 0,
      ...meta,
    },
  });
}

// filterServiceEntries — keep only services/<name>/... entries
// whose <name> is in the allowlist.  Pure; no fs.
function filterServiceEntries(entries, serviceNames) {
  const allowed = new Set(serviceNames);
  if (allowed.size === 0) return {};
  const out = {};
  for (const [archivePath, body] of Object.entries(entries)) {
    // Path shape under collectDirAsEntries(_, 'services'):
    //   'services/<name>/<rest...>'
    const m = archivePath.match(/^services\/([^/]+)/);
    if (m && allowed.has(m[1])) {
      out[archivePath] = body;
    }
  }
  return out;
}

// packFullTier — config_plus_data tier + per-volume docker tarballs
// + per-instance incus exports.  Returns the same shape as the
// other tier helpers + a `notes` array carrying per-collector
// errors so the caller can persist them in the backups row's
// manifest_json without aborting the whole backup over one
// missing volume.
//
// PR 2 implementation note: this builds the entire artifact in
// memory before encrypting + uploading.  That works for small-to-
// medium installs (a few GB total) but multi-GB installs will
// pressure the dashboard process.  A streaming variant — temp
// file based, hashed in chunks, encrypted via crypto.createCipher
// transform pipe to S3 — is a follow-up.  The wire format already
// supports it (auth tag at file-end).
export async function packFullTier({
  db,
  passphrase,
  envPath,
  cveInboxDir,
  caddyDir,
  wireguardDir,
  caddyAcmeDir,
  servicesDir,
  installDir,
  // scopeFilter takes precedence over the legacy
  // dockerVolumeAllowlist + incusInstanceAllowlist args, which
  // are kept for back-compat with any external callers.  When
  // scopeFilter.all is true we honor the legacy allowlists; when
  // it's false the per-service name lists drive selection.
  scopeFilter = { all: true },
  dockerVolumeAllowlist,
  incusInstanceAllowlist,
  meta = {},
}) {
  const allServiceEntries = collectDirAsEntries(
    servicesDir ?? path.join(installDir || '/opt/proxypilot', 'data', 'services'),
    'services',
  );
  const serviceEntries = scopeFilter?.all === false
    ? filterServiceEntries(allServiceEntries, scopeFilter.service_names || [])
    : allServiceEntries;

  const baseEntries = {
    'proxypilot.db.json': dumpSqliteAsJson(db),
    '.env': readEnv(envPath),
    ...readCveInbox(cveInboxDir),
    ...collectDirAsEntries(caddyDir || '/etc/caddy', 'caddy'),
    ...collectDirAsEntries(wireguardDir || '/etc/wireguard', 'wireguard'),
    ...collectDirAsEntries(caddyAcmeDir || '/var/lib/caddy/.local/share/caddy', 'caddy-acme'),
    ...serviceEntries,
  };

  const notes = [];

  // Resolve the actual allowlist for each shell-out collector.
  // Scope-driven names win when the operator chose specific
  // services; legacy explicit allowlists otherwise.
  const dockerWanted = scopeFilter?.all === false
    ? (scopeFilter.docker_container_names || [])
    : (dockerVolumeAllowlist || null);
  const incusWanted = scopeFilter?.all === false
    ? (scopeFilter.incus_instance_names || [])
    : (incusInstanceAllowlist || null);

  // Docker volumes ---
  const volumes = listDockerVolumes();
  if (!volumes.ok) {
    notes.push({ stage: 'docker-volumes', error: volumes.error });
  } else {
    const wanted = dockerWanted
      ? volumes.names.filter((n) => dockerWanted.includes(n))
      : volumes.names;
    for (const v of wanted) {
      const r = exportDockerVolume(v);
      if (!r.ok) {
        notes.push({ stage: 'docker-volume', name: v, error: r.error });
        continue;
      }
      baseEntries[`docker-volumes/${v}.tar.gz`] = r.bytes;
    }
  }

  // Incus instances ---
  let sandbox;
  try {
    const inst = listIncusInstances();
    if (!inst.ok) {
      notes.push({ stage: 'incus-list', error: inst.error });
    } else {
      const wanted = incusWanted
        ? inst.names.filter((n) => incusWanted.includes(n))
        : inst.names;
      if (wanted.length > 0) sandbox = mkdtempSandbox('pp-fullbk-');
      for (const name of wanted) {
        const r = exportIncusInstance(name, sandbox);
        if (!r.ok) {
          notes.push({ stage: 'incus-export', name, error: r.error });
          continue;
        }
        baseEntries[`incus-exports/${name}.tar.gz`] = r.bytes;
      }
    }
  } finally {
    if (sandbox) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  const result = await pack({
    entries: baseEntries,
    passphrase,
    meta: { tier: 'full', ...meta, collector_notes: notes },
  });
  return { ...result, notes };
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
