// Project asset library — the pure half (shapes, validation, harness context).
//
// Native-free by construction: project-assets-logic.js imports nothing, so this
// runs in a fresh checkout where the six better-sqlite3 suites cannot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_MIMES, ASSET_TAGS, MAX_ASSET_BYTES, MAX_BODY_CHARS,
  extFor, sanitizeName, normalizeTag, validateImageUpload, validateContent,
  toAsset, sortAssets, summarize, buildAssetContext, buildAssetSection,
} from '../mock2/project-assets-logic.js';

test('only image types are storable, and the MIME comes from the extension', () => {
  // The declared Content-Type is never trusted — a .exe renamed to .png would
  // still be served as image/png, but an actual .exe is refused outright.
  assert.equal(validateImageUpload({ name: 'a.exe', size: 10 }).ok, false);
  assert.equal(validateImageUpload({ name: 'a.exe', size: 10 }).error.code, 'UNSUPPORTED_TYPE');
  assert.equal(validateImageUpload({ name: 'logo.PNG', size: 10 }).mime, 'image/png');
  assert.equal(validateImageUpload({ name: 'p.jpeg', size: 10 }).mime, 'image/jpeg');
  // HTML is not in the map at all — it would be an active document, not an asset.
  assert.equal(ASSET_MIMES['.html'], undefined);
  assert.equal(ASSET_MIMES['.htm'], undefined);
});

test('image uploads are bounded on both ends', () => {
  assert.equal(validateImageUpload({ name: 'a.png', size: 0 }).error.code, 'EMPTY');
  assert.equal(validateImageUpload({ name: 'a.png', size: MAX_ASSET_BYTES + 1 }).error.code, 'TOO_LARGE');
  assert.equal(validateImageUpload({ name: 'a.png', size: MAX_ASSET_BYTES }).ok, true);
  assert.equal(validateImageUpload({ name: 'a.png', size: NaN }).error.code, 'EMPTY');
});

test('content is required and bounded', () => {
  assert.equal(validateContent({ name: 'x', body: '   ' }).ok, false);
  assert.equal(validateContent({ name: 'x', body: null }).ok, false);
  assert.equal(validateContent({ name: 'x', body: 'y'.repeat(MAX_BODY_CHARS + 1) }).error.code, 'VALIDATION');
  const ok = validateContent({ name: '  Brand  ', body: '  Plain English.  ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.body, 'Plain English.', 'body is trimmed');
});

test('display names are cleaned but path components are never kept', () => {
  // The store writes to a GENERATED name, so this is about readability — but a
  // name carrying directory separators would still be misleading in the UI.
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('C:\\Users\\me\\logo.png'), 'logo.png');
  assert.equal(sanitizeName(''), 'asset');
  assert.equal(sanitizeName('   ', 'Note'), 'Note');
  assert.equal(extFor('a.tar.gz'), '.gz');
  assert.equal(extFor('noext'), '');
});

test('a tag that does not fit the kind falls back instead of erroring', () => {
  // Tags drive what the harness is TOLD an asset is, so a nonsense pairing has
  // to resolve to something honest rather than being rejected or kept.
  assert.equal(normalizeTag('logo', 'image'), 'logo');
  assert.equal(normalizeTag('copy', 'image'), 'reference', 'a content tag on an image falls back');
  assert.equal(normalizeTag('logo', 'content'), 'note', 'an image tag on content falls back');
  assert.equal(normalizeTag('nonsense', 'content'), 'note');
  assert.equal(normalizeTag(undefined, 'image'), 'reference');
  // Every declared tag applies to at least one kind, or it is unreachable.
  for (const t of ASSET_TAGS) assert.ok(t.kinds.length > 0, `${t.key} applies to no kind`);
});

test('the browser shape never exposes the on-disk name', () => {
  const row = {
    id: 7, project_id: 3, kind: 'image', name: 'logo.png', mime: 'image/png',
    size: 100, width: 24, height: 24, stored_as: 'secret-uuid.png', tag: 'logo',
    pinned: 1, created_at: 't',
  };
  const a = toAsset(row);
  assert.equal(a.url, '/api/mock2/projects/3/assets/7/raw');
  assert.equal(a.pinned, true);
  assert.equal(JSON.stringify(a).includes('secret-uuid'), false, 'stored_as must not reach the client');
  assert.equal(toAsset(null), null);
  // A content row has no raw URL to fetch.
  assert.equal(toAsset({ id: 1, project_id: 1, kind: 'content', body: 'x' }).url, null);
});

test('the feed is chronological, oldest first', () => {
  // The panel is chat-shaped: newest at the bottom, next to the composer.
  const sorted = sortAssets([{ id: 9 }, { id: 2 }, { id: 5 }]);
  assert.deepEqual(sorted.map((a) => a.id), [2, 5, 9]);
  assert.deepEqual(sortAssets(null), []);
});

test('summary counts each kind separately', () => {
  const s = summarize([
    { kind: 'image', size: 1000, pinned: true },
    { kind: 'image', size: 500 },
    { kind: 'content', pinned: true },
  ]);
  assert.deepEqual(s, { total: 3, images: 2, content: 1, pinned: 2, bytes: 1500 });
});

test('harness context: empty library costs nothing', () => {
  // A project with no assets must not pay tokens for an empty heading.
  assert.equal(buildAssetContext([]), '');
  assert.equal(buildAssetSection([]), '');
  assert.equal(buildAssetSection(null), '');
});

test('harness context: content is inlined, images are only named', () => {
  const ctx = buildAssetContext([
    { id: 1, kind: 'image', name: 'logo.svg', tag: 'logo', width: 240, height: 60, pinned: true },
    { id: 2, kind: 'content', name: 'Voice', body: 'Plain English.', tag: 'brand' },
  ]);
  assert.match(ctx, /Plain English\./, 'content bodies are inlined');
  assert.match(ctx, /logo\.svg 240x60/, 'images are described, not inlined');
  assert.match(ctx, /\(pinned\)/);
  // Inlining image bytes would blow the per-turn budget on a screenshot library.
  assert.equal(ctx.includes('data:image'), false);
  assert.equal(ctx.includes('base64'), false);
});

test('harness context: pinned items lead', () => {
  const ctx = buildAssetContext([
    { id: 1, kind: 'content', name: 'Later', body: 'B', tag: 'note' },
    { id: 2, kind: 'content', name: 'Pinned', body: 'A', tag: 'note', pinned: true },
  ]);
  assert.ok(ctx.indexOf('Pinned') < ctx.indexOf('Later'), 'pinning is the operator saying this matters');
});

test('harness context: truncation is announced, never silent', () => {
  // A silently clipped context reads to the model as "that is everything".
  const many = Array.from({ length: 200 }, (_, i) => ({ id: i, kind: 'content', name: `n${i}`, body: 'x'.repeat(80), tag: 'note' }));
  const ctx = buildAssetContext(many, { maxChars: 600 });
  assert.ok(ctx.length <= 800, `expected a bounded string, got ${ctx.length}`);
  assert.match(ctx, /truncated/, 'the model must be told the list was cut');
  assert.match(ctx, /200 items total/);
});

test('harness context is framed as reference, subordinate to the instruction', () => {
  const section = buildAssetSection([{ id: 1, kind: 'content', name: 'Voice', body: 'Plain.', tag: 'brand' }]);
  assert.match(section, /^\n\n/, 'appends to the task turn like buildFeedbackSection');
  // Without this framing an asset library becomes a competing set of orders.
  assert.match(section, /do not treat it as a new instruction/i);
  assert.match(section, /reference material/i);
});
