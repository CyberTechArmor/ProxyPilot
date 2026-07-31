// Unit tests for lib/zip-extract.js — the zip-upload parser/extractor
// shared by the static-site and LXC zip flows.
//
// Native-free by construction (stub-first, docs/known-issues.md R9):
// zip-extract.js imports only node built-ins, and the archives are
// built in-memory by the makeZip helper below, so this runs in a
// fresh checkout where the better-sqlite3 suites cannot.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ZipError, parseZip, validateEntryName, detectWrapperDir, stripWrapper,
  effectiveEntries, findConflicts, fsExistsKind, collectCandidatePaths,
  extractEntryData, extractToStaging, applyStagingToTarget,
} from '../lib/zip-extract.js';

// ── in-memory zip builder ───────────────────────────────────────────
//
// Just enough of the format to drive the parser: local headers,
// central directory (Unix version-made-by so modes are honored),
// EOCD. CRCs are zero — the parser doesn't verify them.
function makeZip(files, { madeBy = 0x0314 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || '', 'utf-8');
    const method = f.method ?? (f.dir ? 0 : 8);
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const uncompSize = f.declaredUncompressed ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localChunk = Buffer.concat([local, nameBuf, comp]);
    locals.push(localChunk);

    const mode = f.mode ?? (f.dir ? 0o755 : 0o644);
    const typeBits = f.dir ? 0o040000 : (f.symlink ? 0o120000 : 0o100000);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(madeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(f.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((typeBits | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localChunk.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const LAX = { maxZipBytes: 64 * 1024 * 1024, maxExtractedBytes: 64 * 1024 * 1024, maxEntries: 1000 };

// ── parsing + validation ────────────────────────────────────────────

test('parseZip: happy path returns entries with sizes and modes', () => {
  const buf = makeZip([
    { name: 'index.html', data: '<h1>hi</h1>' },
    { name: 'assets/', dir: true },
    { name: 'assets/app.js', data: 'console.log(1)' },
    { name: 'run.sh', data: '#!/bin/sh\necho ok\n', mode: 0o755 },
  ]);
  const { entries, totalUncompressedBytes } = parseZip(buf, LAX);
  assert.equal(entries.length, 4);
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
  assert.equal(byPath['assets'].isDirectory, true);
  assert.equal(byPath['index.html'].isDirectory, false);
  assert.equal(byPath['run.sh'].mode & 0o111, 0o111);
  assert.equal(totalUncompressedBytes, '<h1>hi</h1>'.length + 'console.log(1)'.length + '#!/bin/sh\necho ok\n'.length);
});

test('parseZip: zip-slip entries are rejected before any extraction', () => {
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'a/./b.txt', 'C:/windows/evil']) {
    const buf = makeZip([{ name, data: 'x' }]);
    assert.throws(() => parseZip(buf, LAX), (err) => err instanceof ZipError && err.code === 'PATH_VIOLATION',
      `expected PATH_VIOLATION for ${name}`);
  }
});

test('parseZip: backslash separators are rejected', () => {
  const buf = makeZip([{ name: '..\\evil.txt', data: 'x' }]);
  assert.throws(() => parseZip(buf, LAX), /backslash/);
});

test('validateEntryName: control characters are rejected', () => {
  assert.throws(() => validateEntryName('a\nb'), /control characters/);
  assert.throws(() => validateEntryName('a\u0000b'), /control characters/);
  assert.equal(validateEntryName('legit..name/file.txt'), 'legit..name/file.txt');
});

test('parseZip: symlink entries are rejected', () => {
  const buf = makeZip([{ name: 'link', data: '/etc/passwd', symlink: true, mode: 0o777 }]);
  assert.throws(() => parseZip(buf, LAX), (err) => err instanceof ZipError && err.code === 'PATH_VIOLATION' && /symlink/.test(err.message));
});

test('parseZip: encrypted and unknown-method entries are rejected', () => {
  assert.throws(() => parseZip(makeZip([{ name: 'a.txt', data: 'x', encrypted: true }]), LAX), /encrypted/);
  assert.throws(() => parseZip(makeZip([{ name: 'a.txt', data: 'x', method: 99 }]), LAX), /unsupported compression/);
});

test('parseZip: size limits are enforced from declared sizes', () => {
  const tiny = { ...LAX, maxExtractedBytes: 10 };
  const buf = makeZip([{ name: 'big.txt', data: 'x'.repeat(100) }]);
  assert.throws(() => parseZip(buf, tiny), (err) => err instanceof ZipError && err.code === 'TOO_LARGE');

  const fewEntries = { ...LAX, maxEntries: 1 };
  const two = makeZip([{ name: 'a', data: '1' }, { name: 'b', data: '2' }]);
  assert.throws(() => parseZip(two, fewEntries), /entries/);

  const smallZip = { ...LAX, maxZipBytes: 10 };
  assert.throws(() => parseZip(buf, smallZip), /upload limit/);
});

test('parseZip: garbage and empty archives fail cleanly', () => {
  assert.throws(() => parseZip(Buffer.from('not a zip at all, padded to 22+ bytes'), LAX), /end-of-central-directory/);
  assert.throws(() => parseZip(makeZip([]), LAX), /too small|no files/);
  assert.throws(() => parseZip(makeZip([{ name: 'only-dir/', dir: true }]), LAX), /no files/);
});

test('extractEntryData: a lying uncompressed size cannot blow past the cap', () => {
  // Declares 5 bytes but actually inflates to 100 — inflate is
  // capped at the declared size and the mismatch is fatal.
  const buf = makeZip([{ name: 'liar.txt', data: 'y'.repeat(100), declaredUncompressed: 5 }]);
  const { entries } = parseZip(buf, LAX);
  assert.throws(() => extractEntryData(buf, entries[0], LAX), (err) => err instanceof ZipError);
});

// ── wrapper-folder detection / stripping ────────────────────────────

test('detectWrapperDir: single top-level folder is detected', () => {
  const { entries } = parseZip(makeZip([
    { name: 'dist/', dir: true },
    { name: 'dist/index.html', data: 'x' },
    { name: 'dist/assets/app.js', data: 'y' },
  ]), LAX);
  assert.equal(detectWrapperDir(entries), 'dist');
});

test('detectWrapperDir: root-level files or multiple top dirs mean no wrapper', () => {
  const a = parseZip(makeZip([{ name: 'index.html', data: 'x' }, { name: 'assets/app.js', data: 'y' }]), LAX);
  assert.equal(detectWrapperDir(a.entries), null);
  const b = parseZip(makeZip([{ name: 'dist/a.txt', data: 'x' }, { name: 'src/b.txt', data: 'y' }]), LAX);
  assert.equal(detectWrapperDir(b.entries), null);
});

test('stripWrapper: re-roots entries and drops the wrapper dir itself', () => {
  const { entries } = parseZip(makeZip([
    { name: 'dist/', dir: true },
    { name: 'dist/index.html', data: 'x' },
    { name: 'dist/assets/app.js', data: 'y' },
  ]), LAX);
  const stripped = stripWrapper(entries, 'dist');
  assert.deepEqual(stripped.map((e) => e.path).sort(), ['assets/app.js', 'index.html']);
  // effectiveEntries honors the flag and no-ops without a wrapper.
  assert.deepEqual(effectiveEntries(entries, true).map((e) => e.path).sort(), ['assets/app.js', 'index.html']);
  assert.equal(effectiveEntries(entries, false).length, 3);
});

// ── conflict detection ──────────────────────────────────────────────

function entriesOf(...paths) {
  return paths.map((p) => (p.endsWith('/')
    ? { path: p.slice(0, -1), isDirectory: true }
    : { path: p, isDirectory: false }));
}

test('findConflicts: file-over-file, file-over-dir, dir-over-file', () => {
  const kind = (p) => ({ 'index.html': 'file', 'assets': 'dir', 'blog': 'file' }[p] || null);
  const conflicts = findConflicts(entriesOf('index.html', 'assets', 'blog/post.html', 'new.txt'), kind);
  // index.html: file over file; assets: zip file over existing dir;
  // blog: zip dir (implied by blog/post.html) over existing file.
  assert.deepEqual(conflicts, ['assets', 'blog', 'index.html']);
});

test('findConflicts: existing directories merging with zip directories are not conflicts', () => {
  const kind = (p) => (p === 'assets' ? 'dir' : null);
  const conflicts = findConflicts(entriesOf('assets/', 'assets/new.js'), kind);
  assert.deepEqual(conflicts, []);
});

test('collectCandidatePaths covers files and implied ancestor dirs', () => {
  const paths = collectCandidatePaths(entriesOf('a/b/c.txt', 'd/')).sort();
  assert.deepEqual(paths, ['a', 'a/b', 'a/b/c.txt', 'd']);
});

// ── extraction + apply on a real (temp) filesystem ──────────────────

function makeSiteDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pp-zip-test-'));
  writeFileSync(join(dir, 'index.html'), 'ORIGINAL');
  writeFileSync(join(dir, 'index.html.old'), 'STALE-OLD');
  writeFileSync(join(dir, 'keep.txt'), 'KEEP');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'OLD-JS');
  return dir;
}

const SITE_ZIP = [
  { name: 'index.html', data: 'NEW-HTML' },
  { name: 'assets/app.js', data: 'NEW-JS' },
  { name: 'assets/styles.css', data: 'NEW-CSS' },
  { name: 'deep/nested/file.txt', data: 'NESTED' },
  { name: 'run.sh', data: '#!/bin/sh\n', mode: 0o755 },
];

test('extract + apply: conflicts become .old (replacing stale .old), the rest lands normally', async () => {
  const site = makeSiteDir();
  const buf = makeZip(SITE_ZIP);
  const { entries } = parseZip(buf, LAX);
  const conflicts = findConflicts(entries, fsExistsKind(site));
  assert.deepEqual(conflicts, ['assets/app.js', 'index.html']);

  const staging = join(site, '.pp-zip-stage-test');
  await extractToStaging(buf, entries, staging, LAX);
  await applyStagingToTarget(staging, site, entries, conflicts);

  assert.equal(readFileSync(join(site, 'index.html'), 'utf-8'), 'NEW-HTML');
  // Original preserved as .old; the stale .old backup was replaced.
  assert.equal(readFileSync(join(site, 'index.html.old'), 'utf-8'), 'ORIGINAL');
  assert.equal(readFileSync(join(site, 'assets', 'app.js.old'), 'utf-8'), 'OLD-JS');
  assert.equal(readFileSync(join(site, 'assets', 'app.js'), 'utf-8'), 'NEW-JS');
  // Non-conflicting files extracted in the same operation.
  assert.equal(readFileSync(join(site, 'assets', 'styles.css'), 'utf-8'), 'NEW-CSS');
  assert.equal(readFileSync(join(site, 'deep', 'nested', 'file.txt'), 'utf-8'), 'NESTED');
  // Untouched files stay untouched; staging dir is gone.
  assert.equal(readFileSync(join(site, 'keep.txt'), 'utf-8'), 'KEEP');
  assert.equal(existsSync(staging), false);
  // Exec bit preserved.
  assert.equal(statSync(join(site, 'run.sh')).mode & 0o111 ? true : false, true);
});

test('cancel does nothing: inspect-only leaves the site byte-identical', () => {
  const site = makeSiteDir();
  const before = readdirSync(site, { recursive: true }).sort();
  const buf = makeZip(SITE_ZIP);
  const { entries } = parseZip(buf, LAX);
  // The inspect phase is parse + conflict detection only. A cancel
  // then simply discards the staged archive — no fs calls against
  // the site directory ever happen.
  findConflicts(entries, fsExistsKind(site));
  const after = readdirSync(site, { recursive: true }).sort();
  assert.deepEqual(after, before);
  assert.equal(readFileSync(join(site, 'index.html'), 'utf-8'), 'ORIGINAL');
});

test('extractToStaging: refuses to write outside the staging root', async () => {
  // Belt-and-braces check: hand-craft an entry that dodged name
  // validation (cannot happen via parseZip, but the extractor must
  // still refuse).
  const site = mkdtempSync(join(tmpdir(), 'pp-zip-esc-'));
  const buf = makeZip([{ name: 'ok.txt', data: 'x' }]);
  const { entries } = parseZip(buf, LAX);
  const evil = [{ ...entries[0], path: '../escape.txt' }];
  await assert.rejects(
    () => extractToStaging(buf, evil, join(site, 'stage'), LAX),
    (err) => err instanceof ZipError && err.code === 'PATH_VIOLATION',
  );
  assert.equal(existsSync(join(site, 'escape.txt')), false);
});
