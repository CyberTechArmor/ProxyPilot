// Design presets (design-presets.js) — the base look chosen at project
// creation. Pure layer only (risk R9): preset token hygiene, seed files, the
// prompt binding, and the template.js seeding hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESIGN_PRESETS, DESIGN_PRESET_AI, DEFAULT_DESIGN_PRESET, getDesignPreset,
  normalizeDesignPresetKey, publicDesignPresets, buildDesignPresetSeedFiles, applyDesignPreset,
  parseDesignDoc, DESIGN_DOC_FORMAT, setCustomPresets,
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

// Project creation no longer shows a picker: an omitted preset means "the
// built-in base look". That only holds if the default names a REAL built-in
// preset that seeds files — an 'ai'-shaped or stale default would silently
// hand every new project an unstyled base app.
test('DEFAULT_DESIGN_PRESET is a real built-in preset that seeds a styled base app', () => {
  assert.notEqual(DEFAULT_DESIGN_PRESET, DESIGN_PRESET_AI);
  const preset = getDesignPreset(DEFAULT_DESIGN_PRESET);
  assert.ok(preset, `${DEFAULT_DESIGN_PRESET} resolves to a preset`);
  assert.ok(
    DESIGN_PRESETS.some((p) => p.key === DEFAULT_DESIGN_PRESET),
    'the default is built-in, not a deletable custom upload',
  );
  assert.equal(normalizeDesignPresetKey(DEFAULT_DESIGN_PRESET), DEFAULT_DESIGN_PRESET);
  const files = buildDesignPresetSeedFiles(DEFAULT_DESIGN_PRESET);
  assert.deepEqual(files.map((f) => f.path), [DESIGN_TOKENS_PATH, DESIGN_CSS_PATH]);
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
  // The theme binds as a BASE the model extends complementarily — the strict
  // "EXACTLY these tokens" wording was deliberately retired (it flattened
  // mockups); the core-palette guardrail stays.
  assert.match(bound, /Base design theme \(binding as a BASE\): Forest Ledger/);
  assert.match(bound, /extend it complementarily/i);
  assert.match(bound, /Never replace the core palette/);
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

/* ---- a preset is a LOOK, not a palette (components, motion, references) ---- */

test('a preset carries the components that make the look, not only its colours', () => {
  // Tokens alone are a palette. What makes a look a look is the components —
  // the card, the row, the chip — and a preset that could not carry them meant
  // every project re-derived the same house style from scratch, however much
  // was learned building the last one.
  const doc = {
    format: DESIGN_DOC_FORMAT, name: 'House', key: 'house',
    tokens: { colors: DESIGN_PRESETS[0].tokens.colors },
    components_css: '.house-card { background: var(--app-surface); border-radius: var(--app-radius-lg); }',
  };
  const parsed = parseDesignDoc(doc);
  assert.equal(parsed.ok, true, parsed.error);
  assert.match(parsed.data.componentsCss, /house-card/);

  // And the block reaches a project seeded from it — otherwise it is stored
  // and never applied, which is worse than not storing it.
  setCustomPresets([{ ...parsed.data }]);
  try {
    const seeded = buildDesignPresetSeedFiles('house').find((f) => f.path === DESIGN_CSS_PATH);
    assert.match(seeded.content, /house-card/, 'the component block must reach state/design.css');
    assert.match(seeded.content, /--app-surface:/, 'and it still carries the rendered tokens');
    assert.ok(seeded.content.indexOf('--app-surface:') < seeded.content.indexOf('house-card'),
      'components come AFTER the tokens they are written on');
  } finally { setCustomPresets([]); }
});

test('an uploaded component block cannot phone home or ship an app', () => {
  // A preset's CSS is served to every user of every app seeded from it. The two
  // things that turn a stylesheet into a network request are refused outright
  // rather than stripped: silently altering someone's stylesheet is how they
  // end up debugging a look they did not write.
  const base = { format: DESIGN_DOC_FORMAT, name: 'Xy', key: 'xy', tokens: { colors: DESIGN_PRESETS[0].tokens.colors } };
  assert.match(parseDesignDoc({ ...base, components_css: '@import url("//evil/x.css");' }).error, /@import/);
  assert.match(parseDesignDoc({ ...base, components_css: '.a{background:url(https://evil/x.png)}' }).error, /remote URL/);
  assert.match(parseDesignDoc({ ...base, components_css: '.a{}<script>x</script>' }).error, /markup, not CSS/);
  assert.match(parseDesignDoc({ ...base, components_css: '.a{}'.repeat(40_000) }).error, /the limit is/);
  // A local asset reference is fine — that is an ordinary design.
  assert.equal(parseDesignDoc({ ...base, components_css: '.a{background:url(/assets/x.png)}' }).ok, true);
});

test('a preset with no component block is still a valid preset', () => {
  // Every design document written before this existed must keep working.
  const r = parseDesignDoc({ format: DESIGN_DOC_FORMAT, name: 'Plain', key: 'plain', tokens: { colors: DESIGN_PRESETS[0].tokens.colors } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.componentsCss, '');
  setCustomPresets([{ ...r.data }]);
  try {
    const seeded = buildDesignPresetSeedFiles('plain').find((f) => f.path === DESIGN_CSS_PATH);
    assert.ok(seeded.content.length > 100);
    assert.doesNotMatch(seeded.content, /==preset-components==/);
  } finally { setCustomPresets([]); }
});
