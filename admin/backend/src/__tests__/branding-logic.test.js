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
