// Backup unpacker — inverse of lib/backup-pack.
//
// Three operations, all standalone so callers can pick the level
// of work they need:
//
//   parseHeader(buf)     — pull the JSON header off a .ppbackup
//                          buffer.  No decryption, no auth-tag
//                          verification.  Cheap; useful for the
//                          UI's pre-passphrase verification path.
//
//   decrypt(buf, pass)   — header parse + scrypt-derive key +
//                          AES-GCM verify + auth-tag check +
//                          gunzip.  Returns the inner tar bytes.
//                          Throws if the passphrase is wrong (the
//                          GCM tag mismatch is the proof point).
//
//   readTar(tarBuf)      — walk the inner tar and return
//                          { name: Buffer } for every entry.
//
//   verifyManifest(tar)  — parse manifest.json + recompute every
//                          listed file's sha256 + size; return
//                          { ok, mismatches: [{path, expected,
//                                              actual}] }.
//                          The Mode C dry-run lives on top of this.
//
// All four functions are pure (no DB, no S3, no fs).  Mode A's
// extract-to-disk lives in lib/restore — it builds on these.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

const TAG_BYTES = 16;

export function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 + 1 + TAG_BYTES) {
    throw new Error('parseHeader: buffer too small to be a .ppbackup');
  }
  const headerLen = buf.readUInt32BE(0);
  if (headerLen <= 0 || headerLen > 64 * 1024) {
    throw new Error(`parseHeader: implausible header length ${headerLen}`);
  }
  const start = 4;
  const end = start + headerLen;
  if (end + TAG_BYTES > buf.length) {
    throw new Error('parseHeader: truncated buffer (header overruns body)');
  }
  let header;
  try {
    header = JSON.parse(buf.slice(start, end).toString('utf-8'));
  } catch (err) {
    throw new Error(`parseHeader: header is not valid JSON: ${err?.message || err}`);
  }
  if (header?.magic !== 'PPBACKUP') {
    throw new Error(`parseHeader: bad magic ${JSON.stringify(header?.magic)}; not a .ppbackup`);
  }
  return {
    header,
    headerEnd: end,
    ciphertextStart: end,
    ciphertextEnd: buf.length - TAG_BYTES,
    tagStart: buf.length - TAG_BYTES,
  };
}

// decrypt — header parse + KDF + GCM verify + gunzip.  Returns the
// inner tar bytes.  The passphrase is used once and dropped.
//
// Async because scrypt is exposed as both sync (block-the-loop)
// and async (callback-based) in node:crypto; we use the async form
// to avoid stalling the event loop on a 50 ms KDF run.
export async function decrypt(buf, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('decrypt: passphrase is required');
  }
  const { header, ciphertextStart, ciphertextEnd, tagStart } = parseHeader(buf);

  // Validate the bits of the header we know how to handle.  A
  // future kdf=argon2id will trip these; bumping this list is
  // the explicit migration step.
  if (header.kdf !== 'scrypt') {
    throw new Error(`decrypt: unsupported KDF ${header.kdf}`);
  }
  if (header.cipher !== 'aes-256-gcm') {
    throw new Error(`decrypt: unsupported cipher ${header.cipher}`);
  }
  if (header.body_compression !== 'gzip') {
    throw new Error(`decrypt: unsupported body compression ${header.body_compression}`);
  }
  if (header.tag_position !== 'trailing') {
    throw new Error(`decrypt: unsupported tag_position ${header.tag_position}`);
  }

  const salt = Buffer.from(header.salt_b64, 'base64');
  const iv = Buffer.from(header.iv_b64, 'base64');
  const params = header.kdf_params || {};
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(passphrase, 'utf-8'),
      salt,
      params.keyLen || 32,
      {
        N: params.N || 32768,
        r: params.r || 8,
        p: params.p || 1,
        maxmem: 256 * 1024 * 1024,
      },
      (err, derived) => err ? reject(err) : resolve(derived),
    );
  });

  const ct = buf.slice(ciphertextStart, ciphertextEnd);
  const tag = buf.slice(tagStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let compressed;
  try {
    compressed = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    // GCM auth failures throw a generic 'Unsupported state' /
    // 'unable to authenticate data' error.  Surface a more
    // operator-facing message — wrong passphrase or corrupted
    // artifact are the only realistic causes.
    throw new Error(
      `decrypt: AES-GCM auth failed (wrong passphrase, or backup is corrupt): ${err?.message || err}`,
    );
  }
  return zlib.gunzipSync(compressed);
}

// readTar — walk a buffer of POSIX (ustar) tar bytes and return
// { 'archive/path': Buffer } for every regular file entry.
// Reconstructs the full path from prefix[155] + '/' + name[100]
// when the prefix field is populated, matching what backup-pack
// emits for paths > 100 bytes.
export function readTar(tarBuf) {
  const out = {};
  let off = 0;
  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.slice(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive
    const name = header.slice(0, 100).toString('utf-8').replace(/\0+$/, '');
    const prefix = header.slice(345, 500).toString('utf-8').replace(/\0+$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeOct = header.slice(124, 136).toString('ascii').replace(/[^0-7]/g, '');
    const size = parseInt(sizeOct, 8);
    const typeflag = header[156];
    const dataStart = off + 512;
    if (typeflag === 0x30 || typeflag === 0) {
      // '0' or NUL = regular file; some archives leave typeflag
      // unset, which POSIX treats as 'normal file'.
      out[fullName] = tarBuf.slice(dataStart, dataStart + size);
    }
    const padded = size + ((512 - (size % 512)) % 512);
    off = dataStart + padded;
  }
  return out;
}

// verifyManifest — Mode C's heart.  Caller decrypts + readTar's
// the .ppbackup; we walk manifest.json and assert every listed
// file's sha256 + size matches the actual entry in the tar.
//
// Returns { ok, mismatches, missing, extra } so the UI / restore
// log can surface a clear per-file diff.  ok=true requires zero
// mismatches AND zero missing AND zero extras (a manifest claiming
// a file that isn't in the tar, or a tar entry not listed in the
// manifest, are both signals of tampering or a botched pack).
export function verifyManifest(entries) {
  const manifestBuf = entries['manifest.json'];
  if (!manifestBuf) {
    return {
      ok: false,
      error: 'manifest.json missing from archive',
      mismatches: [],
      missing: [],
      extra: [],
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf-8'));
  } catch (err) {
    return {
      ok: false,
      error: `manifest.json not valid JSON: ${err?.message || err}`,
      mismatches: [],
      missing: [],
      extra: [],
    };
  }

  const declared = new Map(); // path → {size, sha256}
  for (const f of manifest.files || []) {
    declared.set(f.path, { size: f.size, sha256: f.sha256 });
  }

  const mismatches = [];
  const missing = [];
  for (const [path, decl] of declared.entries()) {
    const present = entries[path];
    if (!present) {
      missing.push(path);
      continue;
    }
    const actualSha = crypto.createHash('sha256').update(present).digest('hex');
    if (present.length !== decl.size || actualSha !== decl.sha256) {
      mismatches.push({
        path,
        expected: { size: decl.size, sha256: decl.sha256 },
        actual: { size: present.length, sha256: actualSha },
      });
    }
  }

  const extra = [];
  for (const path of Object.keys(entries)) {
    if (path === 'manifest.json') continue; // manifest excluded by design
    if (!declared.has(path)) extra.push(path);
  }

  return {
    ok: mismatches.length === 0 && missing.length === 0 && extra.length === 0,
    manifest,
    file_count: declared.size,
    mismatches,
    missing,
    extra,
  };
}
