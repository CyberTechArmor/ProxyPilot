// Pure design-token extraction: parsing + sanitising the mockup's tokens and
// rendering a safe stylesheet the build runner reproduces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDesignTokens, renderDesignTokensCss } from '../mock2/concept-logic.js';

test('parseDesignTokens: reads valid tokens', () => {
  const r = parseDesignTokens(JSON.stringify({
    colors: { background: '#0B0B0B', primary: '#4F46E5', text: '#FFFFFF' },
    typography: { fontFamily: 'Inter, sans-serif', baseSize: '15px' },
    radius: { md: '12px' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.tokens.colors.background, '#0b0b0b');
  assert.equal(r.tokens.colors.primary, '#4f46e5');
  assert.equal(r.tokens.typography.fontFamily, 'Inter, sans-serif');
  assert.equal(r.tokens.typography.baseSize, '15px');
  assert.equal(r.tokens.radius.md, '12px');
  // Unspecified tokens fall back to defaults.
  assert.match(r.tokens.colors.success, /^#[0-9a-f]{6}$/);
});

test('parseDesignTokens: tolerates fences and prose, fills defaults', () => {
  const r = parseDesignTokens('Here you go:\n```json\n{ "colors": { "primary": "#ff0000" } }\n```');
  assert.equal(r.ok, true);
  assert.equal(r.tokens.colors.primary, '#ff0000');
});

test('parseDesignTokens: bad JSON → ok:false but a complete default token set', () => {
  const r = parseDesignTokens('not json at all');
  assert.equal(r.ok, false);
  assert.match(r.tokens.colors.background, /^#[0-9a-f]{6}$/);
  assert.ok(r.tokens.typography.fontFamily.length > 0);
});

test('parseDesignTokens: rejects unsafe values (no CSS injection)', () => {
  const r = parseDesignTokens(JSON.stringify({
    colors: { primary: 'red; } body { display:none } .x{color:blue' },   // not a hex → default
    typography: { fontFamily: 'Inter; } * { color: red }' },              // has ; and { → default
    shadow: { card: 'url(javascript:alert(1))' },                         // has : and / → default
  }));
  assert.match(r.tokens.colors.primary, /^#[0-9a-f]{6}$/);          // fell back to a hex
  assert.doesNotMatch(r.tokens.typography.fontFamily, /[{};]/);
  assert.doesNotMatch(r.tokens.shadow.card, /javascript|url\(/);
});

test('renderDesignTokensCss: emits variables + base styles, only safe chars', () => {
  const { tokens } = parseDesignTokens(JSON.stringify({ colors: { primary: '#123456' } }));
  const css = renderDesignTokensCss(tokens);
  assert.match(css, /--app-primary: #123456;/);
  assert.match(css, /:root \{/);
  assert.match(css, /body \{[^}]*var\(--app-bg\)/);
  assert.match(css, /button[^{]*\{[^}]*var\(--app-primary\)/);
  // A rendered stylesheet from adversarial input has no injected rules/scripts.
  const adversarial = renderDesignTokensCss(parseDesignTokens(JSON.stringify({ colors: { primary: '#fff;}bad{x:y' } })).tokens);
  assert.doesNotMatch(adversarial, /bad\{/);
});
