// Unit tests for the reference-file (document) asset logic — the pure half
// of the file/zip upload feature: text sniffing, archive file selection,
// path handling, the summary prompt, and the prompt-context rendering.
//
// Native-free by construction: project-assets-logic.js and lib/zip-extract.js
// import only node built-ins.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  isProbablyText, validateDocumentUpload, pickArchiveTextFiles, docAssetPath,
  buildDocSummaryPrompt, buildAssetContext, normalizeTag, summarize,
  MAX_DOCUMENT_BYTES, detectBuildArtifactArchive,
} from '../mock2/project-assets-logic.js';
import { parseZip, effectiveEntries } from '../lib/zip-extract.js';

test('isProbablyText: source/text accepted, binaries refused', () => {
  assert.equal(isProbablyText(Buffer.from('export const x: number = 1;\n')), true);
  assert.equal(isProbablyText(Buffer.from('# Heading\n\nSome *markdown*.')), true);
  assert.equal(isProbablyText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x00])), false); // PNG-ish w/ NULs
  assert.equal(isProbablyText(Buffer.alloc(0)), false);
});

test('validateDocumentUpload: size and content gates', () => {
  assert.equal(validateDocumentUpload({ name: 'a.ts', buffer: Buffer.from('ok') }).ok, true);
  assert.equal(validateDocumentUpload({ name: 'a.bin', buffer: Buffer.from([0, 1, 2]) }).error, 'NOT_TEXT');
  assert.equal(validateDocumentUpload({ name: 'big.txt', buffer: Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61) }).error, 'TOO_LARGE');
  assert.equal(validateDocumentUpload({ name: 'x.txt', buffer: Buffer.alloc(0) }).error, 'EMPTY');
});

// In-memory zip helper (same shape as the zip-extract suite's).
function makeZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const data = Buffer.from(f.data || '', 'utf-8');
    const method = f.dir ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const chunk = Buffer.concat([local, nameBuf, comp]); locals.push(chunk);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((((f.dir ? 0o040000 : 0o100000) | (f.dir ? 0o755 : 0o644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf])); offset += chunk.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('archive ingestion: wrapper stripped, deps/binaries skipped, text selected', () => {
  const zip = makeZip([
    { name: 'site/', dir: true },
    { name: 'site/index.html', data: '<h1>Home</h1>' },
    { name: 'site/src/app.ts', data: 'export const app = 1;' },
    { name: 'site/logo.png', data: 'PNGBYTES' },
    { name: 'site/node_modules/pkg/index.js', data: 'skip me' },
  ]);
  const { entries } = parseZip(zip, { maxZipBytes: 1e7, maxExtractedBytes: 1e7, maxEntries: 100 });
  const stripped = effectiveEntries(entries, true);
  const pick = pickArchiveTextFiles(stripped);
  assert.deepEqual(pick.selected.map((e) => e.path).sort(), ['index.html', 'src/app.ts']);
  assert.equal(pick.skipped.binaryExt, 1);
  assert.equal(pick.skipped.dirs, 1);
});

test('archive ingestion: file-count and total-byte caps are enforced and reported', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    path: `f${i}.txt`, isDirectory: false, uncompressedSize: 100,
  }));
  const capped = pickArchiveTextFiles(entries, { maxFiles: 3 });
  assert.equal(capped.selected.length, 3);
  assert.equal(capped.skipped.overFileCap, 7);
  const total = pickArchiveTextFiles(entries, { maxTotalBytes: 250 });
  assert.equal(total.selected.length, 2);
  assert.equal(total.skipped.overTotalCap, 8);
});

test('docAssetPath: keeps structure, strips hostile segments', () => {
  assert.equal(docAssetPath('src/pages/index.html'), 'src/pages/index.html');
  assert.equal(docAssetPath('../../etc/passwd'), 'etc/passwd');
  assert.equal(docAssetPath(''), 'document.txt');
});

test('normalizeTag: document kind gets a document fallback', () => {
  assert.equal(normalizeTag('website', 'document'), 'website');
  assert.equal(normalizeTag('logo', 'document'), 'reference-file'); // image tag on a doc
  assert.equal(normalizeTag(null, 'document'), 'reference-file');
});

test('summary prompt asks for the brief + where-to-find index within the cap', () => {
  const p = buildDocSummaryPrompt({ name: 'api.ts', text: 'export function login() {}' });
  assert.ok(p.includes('"api.ts"'));
  assert.ok(p.includes('where to find things'));
  assert.ok(p.includes('export function login()'));
});

test('prompt context: documents render summary + state/assets path, never full content', () => {
  const ctx = buildAssetContext([
    { id: 1, kind: 'document', name: 'src/api.ts', body: 'Auth API client. login() ~line 10.', tag: 'reference-file', size: 4096, pinned: false },
    { id: 2, kind: 'document', name: 'spec.md', body: '', tag: 'spec', size: 1024, pinned: false },
  ]);
  assert.ok(ctx.includes('state/assets/src/api.ts'));
  assert.ok(ctx.includes('Auth API client. login() ~line 10.'));
  assert.ok(ctx.includes('full content readable in the project at state/assets/'));
  // No summary yet → an honest placeholder, not silence.
  assert.ok(ctx.includes('(summary pending — read the file if needed)'));
  // The counts surface documents distinctly.
  assert.equal(summarize([{ kind: 'document' }, { kind: 'image' }]).documents, 1);
});

// ---- dist-vs-source detection (operator report: a dist zip read as "the
// source didn't upload" when the build honestly said the source wasn't there) ----

test('detectBuildArtifactArchive: flags a Vite dist/ (hashed bundles, no source)', () => {
  const warning = detectBuildArtifactArchive([
    'index.html', 'favicon.svg',
    'assets/index-CkX8WY30.js', 'assets/index-_WXy9k7H.css',
  ]);
  assert.ok(warning, 'expected a warning for a dist-shaped archive');
  assert.match(warning, /compiled production build/i);
  assert.match(warning, /SOURCE zip/);
});

test('detectBuildArtifactArchive: silent for source zips and plain site exports', () => {
  // Real source: bundle-like names may exist, but src/ + package.json win.
  assert.equal(detectBuildArtifactArchive([
    'package.json', 'vite.config.ts', 'index.html',
    'src/main.tsx', 'src/App.tsx', 'assets/logo-abcdef12.css',
  ]), null);
  // A plain website export (no hashed bundles at all) is fine.
  assert.equal(detectBuildArtifactArchive(['index.html', 'about.html', 'style.css']), null);
  assert.equal(detectBuildArtifactArchive([]), null);
});
