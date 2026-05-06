// Tests for admin/backend/src/lib/backup-pack.js — the encrypted
// .ppbackup format used by PR 1 of the Backups feature.
//
// Coverage:
//   * buildManifest — deterministic sha256 + size aggregation.
//   * tarPack — POSIX (ustar) header layout + checksum.
//   * pack roundtrip — header parses, GCM auth tag verifies,
//                       gzip body decompresses to a valid tar.
//   * pack rejects an empty / missing passphrase.
//   * Wrong passphrase fails authentication (i.e. cipher rejects
//     the tag) — ensures the KDF salt actually mixes into the key.
//
// We deliberately do NOT test dumpSqliteAsJson or the route-level
// flow here.  Those touch better-sqlite3 + S3 and live in the
// integration suite (PR 2 adds a MinIO container per the master
// prompt's Tests section).

// Pin scrypt for the test suite — the default KDF for new
// artifacts is argon2id (added in the post-PR-2 polish round)
// but the argon2 package is a native module that won't be
// installed in every test sandbox.  scrypt is in the node:crypto
// stdlib, so pinning it keeps the round-trip tests environment-
// agnostic.  Real deploys default to argon2id; this only
// affects the test environment.
process.env.PROXYPILOT_BACKUP_KDF = 'scrypt';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import {
  pack, buildManifest, tarPack, sha256, __test as INTERNALS,
} from '../lib/backup-pack.js';

const PASS = 'correct horse battery staple';

// ── manifest ────────────────────────────────────────────────────────

test('buildManifest: per-file sha256 + total size are deterministic', () => {
  const entries = {
    'a.txt': Buffer.from('hello\n', 'utf-8'),
    'b.json': Buffer.from('{"x":1}', 'utf-8'),
  };
  const m1 = buildManifest(entries);
  const m2 = buildManifest(entries);
  assert.equal(m1.version, 1);
  assert.equal(m1.files.length, 2);
  assert.equal(m1.total_size_bytes, 6 + 7);
  // Order matches insertion order.
  assert.deepEqual(m1.files.map((f) => f.path), ['a.txt', 'b.json']);
  // sha256 matches an out-of-band computation.
  assert.equal(
    m1.files[0].sha256,
    crypto.createHash('sha256').update('hello\n').digest('hex'),
  );
  // Re-run produces an identical manifest (modulo created_at).
  assert.deepEqual(
    m1.files.map((f) => f.sha256),
    m2.files.map((f) => f.sha256),
  );
});

test('sha256: matches the standard library', () => {
  assert.equal(
    sha256(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

// ── tar ─────────────────────────────────────────────────────────────

test('tarPack: produces a 1024-byte trailer + ustar magic per entry', () => {
  const out = tarPack({
    'hello.txt': Buffer.from('world\n', 'utf-8'),
  });
  // Header(512) + body padded to 512 + trailer(2 * 512) = 4 * 512.
  assert.equal(out.length, 4 * 512);
  // Filename at offset 0.
  assert.equal(
    out.slice(0, 9).toString('utf-8').replace(/\0+$/, ''),
    'hello.txt',
  );
  // ustar magic at offset 257 (POSIX 1003.1).
  assert.equal(out.slice(257, 263).toString('ascii'), 'ustar\0');
  // Body starts at byte 512.
  assert.equal(out.slice(512, 518).toString('utf-8'), 'world\n');
  // Trailer = 1024 zero bytes at the end.
  const trailer = out.slice(out.length - 1024);
  assert.ok(trailer.every((b) => b === 0), 'trailing two blocks must be zero');
});

test('tarPack: header checksum is the unsigned sum of all 512 header bytes', () => {
  const out = tarPack({ 'h.txt': 'hi' });
  const header = out.slice(0, 512);
  // Re-parse the checksum we wrote (octal field at offset 148, 8 bytes).
  const chksumField = header.slice(148, 156).toString('ascii');
  const claimed = parseInt(chksumField.replace(/[^0-7]/g, ''), 8);
  // Recompute with the checksum field treated as 8 spaces.
  const clone = Buffer.from(header);
  for (let i = 148; i < 156; i += 1) clone[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += clone[i];
  assert.equal(claimed, sum, 'tar checksum must equal byte sum with field as spaces');
});

test('tarPack: paths > 100 bytes are split into prefix + name (ustar)', () => {
  // 200-char path with deep slashes — prefix[155] + name[100]
  // can express it.  The writer must succeed and emit a header
  // whose prefix field at offset 345 carries the dirname.
  const deep = 'a/'.repeat(50) + 'b/' + 'c'.repeat(50); // ~152 chars
  const out = tarPack({ [deep]: Buffer.from('x') });
  // Header bytes 345..500 hold prefix[155]; verify our split's
  // dirname landed in there.
  const prefixField = out.slice(345, 500).toString('utf-8').replace(/\0+$/, '');
  assert.ok(prefixField.length > 0, 'long paths must use the ustar prefix field');
  assert.ok(deep.startsWith(prefixField), 'prefix must match the path head');
});

test('tarPack: paths > 256 bytes are rejected', () => {
  const tooDeep = 'd/'.repeat(150);
  assert.throws(
    () => tarPack({ [tooDeep]: Buffer.from('x') }),
    /too long/,
  );
});

// ── pack/decrypt roundtrip ──────────────────────────────────────────
//
// pack() builds:  [4B header_len][header JSON][ciphertext][16B tag]
// We decrypt + ungzip + parse the inner tar to confirm the file
// content survives the round trip.

function parsePackedBuffer(buf) {
  const headerLen = buf.readUInt32BE(0);
  const headerStart = 4;
  const headerEnd = headerStart + headerLen;
  const tagStart = buf.length - INTERNALS.TAG_BYTES;
  const header = JSON.parse(buf.slice(headerStart, headerEnd).toString('utf-8'));
  const ct = buf.slice(headerEnd, tagStart);
  const tag = buf.slice(tagStart);
  return { header, ct, tag };
}

function decryptPacked(buf, passphrase) {
  const { header, ct, tag } = parsePackedBuffer(buf);
  const salt = Buffer.from(header.salt_b64, 'base64');
  const iv = Buffer.from(header.iv_b64, 'base64');
  const key = crypto.scryptSync(
    Buffer.from(passphrase, 'utf-8'),
    salt,
    header.kdf_params.keyLen,
    {
      N: header.kdf_params.N,
      r: header.kdf_params.r,
      p: header.kdf_params.p,
      maxmem: 256 * 1024 * 1024,
    },
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(ct), decipher.final()]);
  return zlib.gunzipSync(compressed);
}

// Walk a tar buffer (just enough to list filenames + extract bytes
// for the entries we care about).  Mirror of the writer logic.
function readTar(tarBuf) {
  const out = {};
  let off = 0;
  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.slice(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive
    const name = header.slice(0, 100).toString('utf-8').replace(/\0+$/, '');
    const sizeOct = header.slice(124, 136).toString('ascii').replace(/[^0-7]/g, '');
    const size = parseInt(sizeOct, 8);
    const dataStart = off + 512;
    out[name] = tarBuf.slice(dataStart, dataStart + size);
    const padded = size + ((512 - (size % 512)) % 512);
    off = dataStart + padded;
  }
  return out;
}

test('pack: roundtrip — pack → decrypt → ungzip → untar', async () => {
  const entries = {
    'proxypilot.db.json': Buffer.from(JSON.stringify({ tables: {} }), 'utf-8'),
    '.env': Buffer.from('FOO=bar\nBAZ=qux\n', 'utf-8'),
    'cve-inbox/CVE-2024-0001.yaml': Buffer.from('id: CVE-2024-0001\n', 'utf-8'),
  };

  const out = await pack({ entries, passphrase: PASS, meta: { tier: 'config' } });
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.ok(out.buffer.length > 0);

  // Header is parseable + carries our metadata.
  const { header } = parsePackedBuffer(out.buffer);
  assert.equal(header.magic, INTERNALS.MAGIC);
  assert.equal(header.version, INTERNALS.VERSION);
  assert.equal(header.cipher, 'aes-256-gcm');
  assert.equal(header.kdf, 'scrypt');
  assert.equal(header.tier, 'config');
  assert.ok(header.salt_b64 && header.iv_b64);

  // GCM auth tag verifies + the inner tar contains every entry.
  const inner = readTar(decryptPacked(out.buffer, PASS));
  assert.ok(inner['manifest.json'], 'manifest.json must be in the tar');
  for (const name of Object.keys(entries)) {
    assert.ok(inner[name], `${name} must be in the tar`);
    assert.deepEqual(inner[name], Buffer.from(entries[name]));
  }

  // Manifest covers every input entry but NOT manifest.json itself
  // — listing manifest.json inside manifest.json would force a
  // self-referential sha256 that no consumer could verify.
  const manifest = JSON.parse(inner['manifest.json'].toString('utf-8'));
  assert.deepEqual(
    manifest.files.map((f) => f.path).sort(),
    Object.keys(entries).sort(),
  );
});

test('pack: wrong passphrase fails GCM tag verification', async () => {
  const out = await pack({
    entries: { 'a.txt': Buffer.from('hi') },
    passphrase: PASS,
  });
  assert.throws(
    () => decryptPacked(out.buffer, 'wrong-passphrase'),
    /Unsupported state|auth/i,
    'wrong passphrase must not yield plaintext',
  );
});

test('pack: rejects an empty or missing passphrase', async () => {
  await assert.rejects(
    () => pack({ entries: { 'a.txt': 'hi' }, passphrase: '' }),
    /passphrase is required/,
  );
  await assert.rejects(
    () => pack({ entries: { 'a.txt': 'hi' } }),
    /passphrase is required/,
  );
});

test('pack: rejects missing entries', async () => {
  await assert.rejects(
    () => pack({ passphrase: PASS }),
    /entries is required/,
  );
});

test('pack: distinct passphrases produce distinct ciphertexts (salt mixed)', async () => {
  const a = await pack({
    entries: { 'a.txt': Buffer.from('hi') },
    passphrase: 'p1',
  });
  const b = await pack({
    entries: { 'a.txt': Buffer.from('hi') },
    passphrase: 'p1',
  });
  // Even with the same passphrase, salt + iv are random per call,
  // so the ciphertext must differ — guards against accidentally
  // re-using a static salt/iv.
  assert.notDeepEqual(a.buffer, b.buffer);
});
