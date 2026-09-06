// Platform branding validation — the /api/branding PUT must accept only small
// image data URIs and a bounded name, and clearing a field ('' → default
// branding) must be a first-class operation, not an error.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBrandingPatch, publicBranding,
  BRANDING_NAME_MAX, BRANDING_LOGO_MAX_CHARS, BRANDING_FAVICON_MAX_CHARS,
} from '../lib/branding-logic.js';

const png = (chars = 100) => `data:image/png;base64,${'A'.repeat(chars)}`;

test('a normal rebrand validates: name + logo + favicon', () => {
  const r = validateBrandingPatch({ name: '  TagArmor Edge  ', logo: png(), favicon: png() });
  assert.equal(r.ok, true);
  assert.equal(r.patch.name, 'TagArmor Edge');
  assert.match(r.patch.logo, /^data:image\/png/);
});

test('partial patches touch only the fields sent', () => {
  const r = validateBrandingPatch({ name: 'Edge' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.patch), ['name']);
});

test('empty string clears a field (back to default branding)', () => {
  const r = validateBrandingPatch({ name: '', logo: '', favicon: '' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { name: '', logo: '', favicon: '' });
});

test('an empty body is a client bug, not a no-op', () => {
  assert.equal(validateBrandingPatch({}).ok, false);
  assert.equal(validateBrandingPatch({ other: 'x' }).ok, false);
});

test('the name is bounded', () => {
  assert.equal(validateBrandingPatch({ name: 'x'.repeat(BRANDING_NAME_MAX) }).ok, true);
  assert.equal(validateBrandingPatch({ name: 'x'.repeat(BRANDING_NAME_MAX + 1) }).ok, false);
});

test('images must be image data URIs — not URLs, not HTML, not scripts', () => {
  for (const bad of [
    'https://example.com/logo.png',
    'data:text/html;base64,AAAA',
    'data:image/png;base64,AAA A', // whitespace inside base64
    '<svg onload=alert(1)>',
    'data:application/octet-stream;base64,AAAA',
  ]) {
    assert.equal(validateBrandingPatch({ logo: bad }).ok, false, bad);
  }
  for (const good of ['png', 'jpeg', 'webp', 'gif', 'svg+xml', 'x-icon', 'vnd.microsoft.icon']) {
    assert.equal(validateBrandingPatch({ favicon: `data:image/${good};base64,QUJD` }).ok, true, good);
  }
});

test('size caps hold: logo ~300 KB, favicon ~150 KB', () => {
  assert.equal(validateBrandingPatch({ logo: png(BRANDING_LOGO_MAX_CHARS) }).ok, false);
  assert.equal(validateBrandingPatch({ favicon: png(BRANDING_FAVICON_MAX_CHARS) }).ok, false);
  assert.equal(validateBrandingPatch({ favicon: png(1000) }).ok, true);
});

test('publicBranding: unset/blank fields come back null for clean fallbacks', () => {
  assert.deepEqual(publicBranding({}), { name: null, logo: null, favicon: null });
  assert.deepEqual(publicBranding({ name: ' Edge ', logo: '', favicon: null }),
    { name: 'Edge', logo: null, favicon: null });
});

// ---- the installed-app icon ----
//
// A PWA installer reads icons from the manifest and apple-touch-icon, neither
// of which can carry inline data, so the stored data URI has to become bytes
// at a URL and the manifest has to point there — and ONLY there, or the
// installer picks the bigger stock rocket over the operator's mark.

import { decodeDataUri, brandedManifest, withInstalledAppHint } from '../lib/branding-logic.js';

const BASE = Object.freeze({
  name: 'ProxyPilot Admin', short_name: 'ProxyPilot', start_url: '/',
  icons: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
});
const realPng = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;

test('decodeDataUri turns a stored image back into typed bytes', () => {
  const r = decodeDataUri(realPng);
  assert.equal(r.mime, 'image/png');
  assert.equal(r.buffer.toString(), 'not really a png');
  assert.equal(decodeDataUri('data:image/svg+xml;base64,PHN2Zz4=').mime, 'image/svg+xml');
});

test('decodeDataUri rejects anything that is not an image data URI', () => {
  assert.equal(decodeDataUri(''), null);
  assert.equal(decodeDataUri(null), null);
  assert.equal(decodeDataUri('https://example.com/logo.png'), null);
  assert.equal(decodeDataUri('data:text/html;base64,PGI+'), null);
});

test('stock branding serves the built manifest untouched', () => {
  assert.equal(brandedManifest(BASE, { name: null, logo: null, favicon: null }), BASE);
  assert.equal(brandedManifest(BASE, {}), BASE);
});

test('a custom name installs under that name, with a launcher-length short_name', () => {
  const m = brandedManifest(BASE, { name: 'TagArmor Edge Console' });
  assert.equal(m.name, 'TagArmor Edge Console');
  assert.equal(m.short_name, 'TagArmor Edg');
  assert.deepEqual(m.icons, BASE.icons, 'no custom mark → stock icons stay');
  assert.equal(brandedManifest(BASE, { name: 'Edge' }).short_name, 'Edge');
});

test('a custom favicon replaces the stock icons entirely', () => {
  const m = brandedManifest(BASE, { favicon: realPng }, '/api/branding/icon');
  assert.equal(m.name, BASE.name, 'name untouched when only the mark is set');
  assert.deepEqual(m.icons.map((i) => i.src), ['/api/branding/icon', '/api/branding/icon']);
  assert.deepEqual(m.icons.map((i) => i.purpose), ['any', 'maskable']);
  assert.ok(m.icons.every((i) => i.type === 'image/png' && i.sizes === 'any'));
});

test('the logo stands in for the icon when no favicon was uploaded', () => {
  const m = brandedManifest(BASE, { logo: 'data:image/svg+xml;base64,PHN2Zz4=' });
  assert.equal(m.icons[0].type, 'image/svg+xml');
  assert.notEqual(m, BASE);
});

test('brandedManifest never mutates the base it was given', () => {
  const before = JSON.stringify(BASE);
  brandedManifest(BASE, { name: 'X', favicon: realPng });
  assert.equal(JSON.stringify(BASE), before);
});

test('the served manifest names itself as a related webapp for install detection', () => {
  const m = withInstalledAppHint(BASE, 'https://edge.example.com/manifest.webmanifest');
  assert.equal(m.prefer_related_applications, false);
  assert.deepEqual(m.related_applications, [{ platform: 'webapp', url: 'https://edge.example.com/manifest.webmanifest' }]);
  assert.equal(m.name, BASE.name);
  assert.equal(withInstalledAppHint(BASE, null), BASE, 'no host known → untouched');
});
