// Project icons — the pure half (selection, manifest, head links).
//
// WHY: the operator uploads their logo, the mockup is now shown it, and the
// built app still shipped the scaffold's generic blue circle as its favicon,
// its home-screen icon and its manifest icon. Everywhere the app was seen
// OUTSIDE its own pages — the browser tab, the phone home screen, the install
// prompt, the task switcher — it was anonymous.
//
// Native-free: project-icons-logic.js imports nothing, so this runs in a fresh
// checkout where the six better-sqlite3 suites cannot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectIconAsset, buildManifest, iconHeadLinks, applyIconLinks,
  iconExt, ICON_TAG_PREFERENCE, MAX_ICON_ASPECT, MAX_ICON_BYTES,
  ICON_BLOCK_START, ICON_BLOCK_END,
} from '../mock2/project-icons-logic.js';

const img = (over = {}) => ({ id: 1, kind: 'image', name: 'logo.png', tag: 'logo', size: 4096, width: 512, height: 512, ...over });

test('a purpose-built favicon beats a full logo when both exist', () => {
  // A wordmark scaled into a 192px square is usually illegible; a favicon was
  // drawn for exactly this size.
  assert.deepEqual([...ICON_TAG_PREFERENCE], ['favicon', 'logo']);
  const r = selectIconAsset([
    img({ id: 1, name: 'logo.svg', tag: 'logo' }),
    img({ id: 2, name: 'fav.png', tag: 'favicon' }),
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.asset.name, 'fav.png');
  assert.equal(r.href, '/app-icon.png');
  assert.equal(r.mime, 'image/png');
});

test('an untagged image is never assumed to be the logo', () => {
  // Tags are a fixed vocabulary precisely so the platform does not have to
  // guess which of five screenshots is the brand.
  const r = selectIconAsset([img({ tag: 'screenshot' }), img({ id: 2, tag: null })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /tagged Logo or Favicon/);
  assert.equal(selectIconAsset([]).ok, false);
  assert.match(selectIconAsset([]).reason, /no images/);
});

test('a wordmark is DECLINED with a reason, not used badly', () => {
  // Masked into a circle, a 4:1 mark becomes a smear — worse than the
  // scaffold's honest placeholder. The operator gets a sentence they can act on.
  const r = selectIconAsset([img({ name: 'wordmark.png', width: 1200, height: 200 })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /1200x200/);
  assert.match(r.reason, /square mark/);
  // Just inside the limit is fine.
  assert.equal(selectIconAsset([img({ width: 512, height: Math.round(512 / MAX_ICON_ASPECT) + 1 })]).ok, true);
});

test('an SVG has no dimensions and is judged on format alone', () => {
  const r = selectIconAsset([img({ name: 'mark.svg', width: null, height: null })]);
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/svg+xml');
  assert.equal(iconExt('MARK.SVG'), '.svg');
  assert.equal(iconExt('noext'), '');
});

test('an oversized or unsupported file falls through to the next candidate', () => {
  const r = selectIconAsset([
    img({ id: 1, name: 'huge.png', size: MAX_ICON_BYTES + 1 }),
    img({ id: 2, name: 'ok.png' }),
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.asset.name, 'ok.png');
  // And when nothing survives, every rejection is reported — one useless
  // sentence beats none, several beat one.
  const none = selectIconAsset([img({ name: 'huge.png', size: MAX_ICON_BYTES + 1 }), img({ id: 2, name: 'thing.bmp' })]);
  assert.equal(none.ok, false);
  assert.match(none.reason, /too large/);
  assert.match(none.reason, /not an icon format/);
});

test('the manifest keeps the scaffold mark as a fallback behind the real one', () => {
  const m = JSON.parse(buildManifest({ name: 'Clinic Check-In', icon: { href: '/app-icon.svg', mime: 'image/svg+xml' } }));
  assert.equal(m.icons[0].src, '/app-icon.svg');
  // A manifest whose ONLY icon 404s shows nothing at all, which is worse than a
  // generic square.
  assert.equal(m.icons.at(-1).src, '/icon.svg');
  assert.equal(m.name, 'Clinic Check-In');
  assert.equal(m.short_name.length <= 12, true);
});

test('only an SVG claims maskable — a raster is letterboxed, not mutilated', () => {
  // `maskable` promises the mark has enough padding to survive a circular crop.
  // We cannot verify that of a raster we did not make, and the failure mode is
  // the logo's edges being cut off on every Android home screen.
  const raster = JSON.parse(buildManifest({ icon: { href: '/app-icon.png', mime: 'image/png' } }));
  assert.equal(raster.icons[0].purpose, 'any');
  assert.equal(raster.icons[0].sizes, '512x512');
  const svg = JSON.parse(buildManifest({ icon: { href: '/app-icon.svg', mime: 'image/svg+xml' } }));
  assert.equal(svg.icons[0].purpose, 'any maskable');
  assert.equal(svg.icons[0].sizes, 'any');
});

test('no logo still rewrites the manifest — a RENAME must move the home-screen label', () => {
  const m = JSON.parse(buildManifest({ name: 'Renamed App', icon: null }));
  assert.equal(m.name, 'Renamed App');
  assert.equal(m.icons.length, 1);
  assert.equal(m.icons[0].src, '/icon.svg');
});

test('iOS ignores the manifest, so the apple-touch-icon link is not optional', () => {
  const links = iconHeadLinks({ href: '/app-icon.png', mime: 'image/png' });
  assert.match(links, /rel="icon" href="\/app-icon\.png" type="image\/png"/);
  assert.match(links, /rel="apple-touch-icon" href="\/app-icon\.png"/);
});

test('re-branding REPLACES the icon links instead of appending a second set', () => {
  const page = '<html><head><title>x</title></head><body></body></html>';
  const once = applyIconLinks(page, { href: '/app-icon.png', mime: 'image/png' });
  assert.ok(once.includes(ICON_BLOCK_START) && once.includes(ICON_BLOCK_END));
  assert.ok(once.indexOf(ICON_BLOCK_START) < once.indexOf('</head>'));

  const twice = applyIconLinks(once, { href: '/app-icon.svg', mime: 'image/svg+xml' });
  assert.equal(twice.split(ICON_BLOCK_START).length - 1, 1, 'exactly one icon block');
  assert.match(twice, /app-icon\.svg/);
  assert.doesNotMatch(twice, /app-icon\.png/);
  // Idempotent: applying the same icon twice changes nothing, so the caller can
  // skip the container write.
  assert.equal(applyIconLinks(twice, { href: '/app-icon.svg', mime: 'image/svg+xml' }), twice);
});

test('a page with no head is left alone rather than guessed at', () => {
  // A build is free to replace a page entirely; mangling it to insert a link
  // would be the platform breaking what the build wrote.
  assert.equal(applyIconLinks('<p>fragment</p>', { href: '/a.png', mime: 'image/png' }), '<p>fragment</p>');
  assert.equal(applyIconLinks('', { href: '/a.png', mime: 'image/png' }), '');
});
