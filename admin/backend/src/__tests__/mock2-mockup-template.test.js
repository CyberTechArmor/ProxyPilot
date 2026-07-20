// Mockup base template (part 2): light-first token stylesheet, dark via
// [data-theme="dark"], stage palette complete, seed design system rewritten —
// and the legacy near-black + neon-green theme gone from both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOCKUP_TOKENS, MOCKUP_BASE_CSS, MOCKUP_THEME_TOGGLE_JS, mockupTokenCss } from '../mock2/mockup-template.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const SEED = resolve(__dir, '..', 'mock2', 'framework-seed', 'design-system.md');

const LEGACY = /#(?:22c55e|16a34a|4ade80|070b11|0a0f18|0d1420|0f1621)\b/i;

// WCAG relative-luminance contrast — the tables claim "computed AA"; hold them to it.
function lum(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

test('token stylesheet: light reference in :root, dark in [data-theme="dark"], stage palette complete', () => {
  const css = mockupTokenCss();
  assert.match(css, /\/\* ==tokens== /);
  assert.match(css, /:root \{/);
  assert.match(css, /\[data-theme="dark"\] \{/);
  // Light values in :root, dark values in the dark block, ordered light-first.
  assert.ok(css.indexOf(':root') < css.indexOf('[data-theme="dark"]'));
  assert.match(css, /--bg: #F6F8F8/);
  assert.match(css, /--bg: #101617/);
  // No pure black anywhere, no legacy theme.
  assert.doesNotMatch(css, /#000\b|#000000\b/i);
  assert.doesNotMatch(css, LEGACY);
  // All six stages tokenized in BOTH themes — no stage can fall through.
  for (const k of ['ideation', 'mvp', 'testing', 'iterating', 'rollout', 'maintenance']) {
    const hits = css.match(new RegExp(`--stage-${k}-bg:`, 'g')) || [];
    assert.equal(hits.length, 2, `stage ${k} must be defined in both themes`);
  }
  // Base CSS routes through tokens: outside the ==tokens== blocks, zero hex.
  const afterTokens = MOCKUP_BASE_CSS.slice(MOCKUP_BASE_CSS.indexOf('==/tokens=='));
  assert.doesNotMatch(afterTokens, /#[0-9a-fA-F]{3,8}\b/);
  // Toggle flips data-theme on the root element.
  assert.match(MOCKUP_THEME_TOGGLE_JS, /dataset\.theme/);
  assert.match(MOCKUP_BASE_CSS, /\.theme-toggle/);
});

test('token pairings hold WCAG AA (computed, both themes, stage badges included)', () => {
  for (const mode of ['light', 'dark']) {
    const t = MOCKUP_TOKENS[mode];
    for (const key of ['text-1', 'text-2', 'text-3']) {
      assert.ok(ratio(t[key], t['surface-1']) >= 4.5, `${mode} ${key} vs surface-1`);
      assert.ok(ratio(t[key], t.bg) >= 4.5, `${mode} ${key} vs bg`);
    }
    assert.ok(ratio(t['accent-on'], t.accent) >= 4.5, `${mode} accent-on vs accent`);
    for (const key of ['danger', 'warn', 'ok']) {
      assert.ok(ratio(t[key], t['surface-1']) >= 4.5, `${mode} ${key} vs surface-1`);
    }
    for (const [name, s] of Object.entries(MOCKUP_TOKENS.stages)) {
      assert.ok(ratio(s[mode].text, s[mode].bg) >= 4.5, `${mode} stage ${name} badge text vs badge bg`);
    }
  }
});

test('seed design system v2: legacy theme retired, precedence + required specs present', () => {
  const md = readFileSync(SEED, 'utf8');
  assert.doesNotMatch(md, LEGACY);
  // The refusal rule is gone — the system is a default, never a veto.
  assert.doesNotMatch(md, /honor the system and say so/);
  assert.match(md, /never a veto/);
  // The explicit override line the stage instructions carry.
  assert.match(md, /Ignore any pre-existing theme, brand colors, or prior mockup styling/);
  assert.match(md, /Light is the reference theme;\s*\n?render light first/);
  // The defect-class specs: canonical list row, bars, bands, stage palette,
  // one metric, metric formatting, sample-data integrity, acceptance checks.
  assert.match(md, /Stage badge \| Identity \| Headline metric \| Position \| Lead/);
  assert.match(md, /min-width: 0/);
  assert.match(md, /--fill/);
  assert.match(md, /Site → POD → Region → All org/);
  assert.match(md, /Promote to next level/);
  assert.match(md, /no stage falls through to a default color/);
  assert.match(md, /One metric per item/);
  assert.match(md, /value → unit → descriptor/);
  assert.match(md, /exactly ONE lifecycle stage/);
  assert.match(md, /Acceptance checks/);
  assert.match(md, /Spec Ops Hub/);
  // Mechanics carried from v1 (mobile-first, self-contained, inventory contract).
  assert.match(md, /360\/375px/);
  assert.match(md, /inventory is the contract/);
});
