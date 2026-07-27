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
  selectMockupImages, buildMockupAssetSection, MOCKUP_IMAGE_TAG_RANK,
  assetsFingerprint, diffAssetFingerprint, buildAssetChangeSection,
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

/* ------------------ what the MOCKUP is shown (project 40 follow-up) --------- */
//
// The library was wired into the BUILD turn only. A logo uploaded during the
// design stage — the stage that exists to decide what things look like — was
// invisible to every mockup render. Worse, buildAssetContext names images
// without showing them, which is right for a build turn and useless for a
// render: a logo has to be LOOKED at to be placed, colour-matched and weighted.

test('the mockup sees the images a render actually needs, best first', () => {
  const assets = [
    { id: 1, kind: 'image', name: 'screenshot.png', tag: 'screenshot' },
    { id: 2, kind: 'image', name: 'logo.svg', tag: 'logo' },
    { id: 3, kind: 'image', name: 'pinned.png', tag: 'photo', pinned: true },
    { id: 4, kind: 'content', name: 'Voice', tag: 'brand', body: 'Calm.' },
  ];
  const picked = selectMockupImages(assets);
  // Content is not an image block.
  assert.ok(picked.every((a) => a.kind === 'image'));
  // Pinned outranks everything — it is the operator saying "this one matters".
  assert.equal(picked[0].name, 'pinned.png');
  // Then by how much a RENDER needs to see it: a logo before a screenshot.
  assert.deepEqual(picked.slice(1).map((a) => a.name), ['logo.svg', 'screenshot.png']);
  assert.equal(MOCKUP_IMAGE_TAG_RANK[0], 'logo');
});

test('the selection is capped — every image costs real tokens on a long render', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, kind: 'image', name: `i${i}.png`, tag: 'photo' }));
  assert.equal(selectMockupImages(many).length, 4);
  assert.equal(selectMockupImages(many, { max: 2 }).length, 2);
  assert.deepEqual(selectMockupImages([]), []);
  assert.deepEqual(selectMockupImages(null), []);
});

test('the mockup asset block tells the render to USE the assets, and names the pictures', () => {
  const assets = [
    { id: 1, kind: 'content', name: 'Voice', tag: 'brand', body: 'Calm, plain words.' },
    { id: 2, kind: 'image', name: 'logo.svg', tag: 'logo' },
  ];
  const section = buildMockupAssetSection(assets, { attachedImages: [{ name: 'logo.svg', tag: 'logo' }] });
  // The build turn's framing ("reference material… do not treat it as a new
  // instruction") is wrong here: on a mockup the logo and the wording ARE the
  // brief. Assert the stronger framing, or this silently reverts to advisory.
  assert.match(section, /not optional/i);
  assert.match(section, /Calm, plain words/);
  // An unlabelled image block is just a picture — the model must be told which
  // attached image is which.
  assert.match(section, /Attached to this turn as images.*logo\.svg \(logo\)/s);
  // Nothing to say costs nothing.
  assert.equal(buildMockupAssetSection([]), '');
});

/* ---------------- what changed since the last build ------------------------ */
//
// The library was already read on every build turn, so a logo uploaded after
// the app was built DID reach the next build's context — buried in a pile of
// standing reference material, with nothing marking it as new and therefore
// nothing telling the build to go back and apply it. The operator had to
// notice, and to ask.

const LOGO = { id: 1, kind: 'image', name: 'logo.png', tag: 'logo', size: 4096 };
const VOICE = { id: 2, kind: 'content', name: 'Voice', tag: 'brand', body: 'Calm, plain words.' };

test('the fingerprint ignores order and notices content', () => {
  assert.equal(assetsFingerprint([LOGO, VOICE]), assetsFingerprint([VOICE, LOGO]));
  // A REPLACED image keeps its id, name and tag — only the bytes differ. A
  // fingerprint blind to that would call a rebranded logo "unchanged".
  assert.notEqual(assetsFingerprint([LOGO]), assetsFingerprint([{ ...LOGO, size: 9999 }]));
  // An edited note likewise.
  assert.notEqual(assetsFingerprint([VOICE]), assetsFingerprint([{ ...VOICE, body: 'Loud.' }]));
  // Retagging changes what the asset MEANS to a build, so it counts.
  assert.notEqual(assetsFingerprint([LOGO]), assetsFingerprint([{ ...LOGO, tag: 'favicon' }]));
  assert.equal(assetsFingerprint([]), '');
});

test('a filename cannot forge a field boundary', () => {
  // Separators are control characters precisely so a name containing a comma, a
  // pipe or a newline cannot make two different libraries fingerprint the same.
  const sneaky = { id: 1, kind: 'image', name: 'a|b,c\nd', tag: 'logo', size: 1 };
  assert.notEqual(assetsFingerprint([sneaky]), assetsFingerprint([{ ...sneaky, name: 'a', size: 2 }]));
});

test('the FIRST build is not told everything is new', () => {
  // On a project's first build every asset is new by definition; announcing
  // that would make the instruction shout about material it was already given
  // in full, in the same turn.
  const d = diffAssetFingerprint(null, [LOGO, VOICE]);
  assert.equal(d.firstRun, true);
  assert.equal(d.changed, false);
  assert.equal(buildAssetChangeSection(d), '');
  // …but the fingerprint is still produced, so the SECOND build has a baseline.
  assert.equal(d.fingerprint, assetsFingerprint([LOGO, VOICE]));
});

test('an unchanged library costs a build nothing', () => {
  const fp = assetsFingerprint([LOGO, VOICE]);
  const d = diffAssetFingerprint(fp, [VOICE, LOGO]);
  assert.equal(d.changed, false);
  assert.equal(buildAssetChangeSection(d), '');
});

test('added, changed and removed are each reported as themselves', () => {
  const before = assetsFingerprint([LOGO, VOICE]);
  const after = [{ ...LOGO, size: 9999 }, { id: 3, kind: 'image', name: 'shot.png', tag: 'screenshot', size: 10 }];
  const d = diffAssetFingerprint(before, after);
  assert.equal(d.changed, true);
  assert.deepEqual(d.added.map((a) => a.name), ['shot.png']);
  assert.deepEqual(d.updated.map((a) => a.name), ['logo.png']);
  assert.deepEqual(d.removed, [2]);                      // Voice was deleted
});

test('the change block tells the build to APPLY it, not merely to know it', () => {
  const d = diffAssetFingerprint(assetsFingerprint([VOICE]), [VOICE, LOGO]);
  const block = buildAssetChangeSection(d);
  // buildAssetSection's framing is "reference material… use it when relevant".
  // That is right for a standing library and wrong for something that arrived
  // after the app was built and has never been acted on.
  assert.match(block, /CHANGED THIS PROJECT'S ASSETS SINCE THE LAST BUILD/);
  assert.match(block, /Apply the change as part of this build/);
  assert.match(block, /ADDED since the last build: logo\.png \(Logo\)/);
  // And it must not let the change be dropped in silence.
  assert.match(block, /say so in your summary rather than silently dropping it/);
});

/* ------------- the wiring: checked on EVERY build, recorded only on ship ---- */
//
// Source-level, like the other runner assertions: the wiring is native
// (containers, model calls) and cannot be imported in the sandbox, but WHERE it
// is called from is exactly the thing that would regress.

test('every build computes the delta, and only a SHIPPED build records it', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../mock2/runner.js', import.meta.url), 'utf8');

  // Computed on the main build path, next to the standing asset section — not
  // behind a flag, a mode, or a setting.
  assert.match(src, /diffAssetFingerprint\(getProject\(projectId\)\?\.assets_fingerprint, assets\)/);
  assert.match(src, /assetChangeSection = buildAssetChangeSection\(diff\)/);
  // And actually reaches the model.
  assert.match(src, /\$\{assetSection\}\$\{assetChangeSection\}/);

  // THE PROPERTY THAT MATTERS: recorded only where the build shipped. Recording
  // it when the delta is computed would mean a build that FAILED before
  // applying a new logo had "seen" it, and the next build would be told nothing
  // had changed — the change would be lost in silence, which is worse than
  // never having detected it.
  const decl = src.indexOf('const recordAssetsSeen');
  assert.ok(decl !== -1, 'recordAssetsSeen must exist');
  const calls = [...src.matchAll(/recordAssetsSeen\(\)/g)].map((m) => m.index).filter((i) => i !== decl);
  assert.ok(calls.length >= 2, `expected a call at each shipped terminal, found ${calls.length}`);
  // Each call must sit with a terminal that shipped: a finishCycle('succeeded')
  // or the pending-verification handoff, both of which deployed.
  for (const at of calls) {
    const around = src.slice(Math.max(0, at - 600), at + 200);
    assert.ok(
      /finishCycle\(cycle\.id, \{ status: 'succeeded' \}\)/.test(around) || /afterBuildReview\(projectId/.test(around),
      'recordAssetsSeen must only be called from a terminal that shipped',
    );
  }
  // It must NOT be called on a failure path.
  const failIdx = src.indexOf("finishCycle(cycle.id, { status: 'failed'");
  if (failIdx !== -1) {
    const afterFail = src.slice(failIdx, failIdx + 400);
    assert.doesNotMatch(afterFail, /recordAssetsSeen\(\)/, 'a failed build must not consume the change');
  }
});
