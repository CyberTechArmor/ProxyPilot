// Design presets (design-presets.js) — the base look chosen at project
// creation. Pure layer only (risk R9): preset token hygiene, seed files, the
// prompt binding, and the template.js seeding hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESIGN_PRESETS, DESIGN_PRESET_AI, getDesignPreset, normalizeDesignPresetKey,
  publicDesignPresets, buildDesignPresetSeedFiles, applyDesignPreset,
} from '../mock2/design-presets.js';
import { parseDesignTokens, renderDesignTokensCss, DESIGN_TOKENS_PATH, DESIGN_CSS_PATH } from '../mock2/concept-logic.js';
import { buildSeedFiles } from '../mock2/template.js';

test('every preset survives the extractor sanitizers unchanged', () => {
  assert.ok(DESIGN_PRESETS.length >= 4);
  for (const p of DESIGN_PRESETS) {
    // parseDesignTokens sanitizes every field with defaults on failure — a
    // preset whose values round-trip identically is inside the safe grammar.
    const r = parseDesignTokens(JSON.stringify(p.tokens));
    assert.equal(r.ok, true, `${p.key} parses`);
    assert.deepEqual(r.tokens, p.tokens, `${p.key} tokens are sanitizer-clean`);
    // And the stylesheet renders with the preset's own values in it.
    const css = renderDesignTokensCss(p.tokens);
    assert.ok(css.includes(p.tokens.colors.primary), `${p.key} css carries primary`);
  }
  // Keys are unique.
  assert.equal(new Set(DESIGN_PRESETS.map((p) => p.key)).size, DESIGN_PRESETS.length);
});

test('normalizeDesignPresetKey: valid keys pass, everything else is the ai sentinel', () => {
  assert.equal(normalizeDesignPresetKey('midnight-ops'), 'midnight-ops');
  assert.equal(normalizeDesignPresetKey('  midnight-ops  '), 'midnight-ops');
  assert.equal(normalizeDesignPresetKey('nope'), DESIGN_PRESET_AI);
  assert.equal(normalizeDesignPresetKey(''), DESIGN_PRESET_AI);
  assert.equal(normalizeDesignPresetKey(null), DESIGN_PRESET_AI);
  assert.equal(getDesignPreset(DESIGN_PRESET_AI), null);
});

test('buildDesignPresetSeedFiles: token doc + stylesheet for a preset, nothing for ai', () => {
  const files = buildDesignPresetSeedFiles('editorial-warm');
  assert.deepEqual(files.map((f) => f.path), [DESIGN_TOKENS_PATH, DESIGN_CSS_PATH]);
  const tokens = JSON.parse(files[0].content);
  assert.equal(tokens.colors.primary, getDesignPreset('editorial-warm').tokens.colors.primary);
  assert.ok(files[1].content.includes(tokens.colors.primary));
  assert.deepEqual(buildDesignPresetSeedFiles(DESIGN_PRESET_AI), []);
  assert.deepEqual(buildDesignPresetSeedFiles(undefined), []);
});

test('applyDesignPreset: binds the palette; no preset leaves the design system alone', () => {
  const base = '# Locked design system\ncontent';
  const bound = applyDesignPreset(base, 'forest-ledger');
  assert.ok(bound.startsWith(base));
  assert.match(bound, /Chosen base design preset \(binding\): Forest Ledger/);
  assert.ok(bound.includes(getDesignPreset('forest-ledger').tokens.colors.primary));
  assert.equal(applyDesignPreset(base, null), base);
  assert.equal(applyDesignPreset(base, 'unknown'), base);
});

test('buildSeedFiles: a preset project is seeded styled; no preset stays as before', () => {
  const withPreset = buildSeedFiles({ name: 'X', design_preset: 'slate-pro' });
  const tok = withPreset.find((f) => f.path === DESIGN_TOKENS_PATH);
  const css = withPreset.find((f) => f.path === DESIGN_CSS_PATH);
  assert.ok(tok && css, 'preset seeds tokens + stylesheet');
  assert.ok(css.content.includes(getDesignPreset('slate-pro').tokens.colors.primary));
  const without = buildSeedFiles({ name: 'X' });
  assert.equal(without.some((f) => f.path === DESIGN_TOKENS_PATH), false);
  assert.equal(without.some((f) => f.path === DESIGN_CSS_PATH), false);
});

test('publicDesignPresets: picker shape with tokens for swatches', () => {
  const list = publicDesignPresets();
  assert.equal(list.length, DESIGN_PRESETS.length);
  for (const p of list) {
    assert.ok(p.key && p.name && p.description);
    assert.ok(p.tokens?.colors?.primary);
  }
});
