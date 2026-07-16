// Design-system CATALOG — the pure decision layer (design-systems-logic.js):
// the built-in catalog, key normalization, body resolution (framework body vs.
// vendored seed body, with the never-blank fallback), and the API shapes the
// Concept-stage selector renders.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_DESIGN_SYSTEMS, DEFAULT_DESIGN_SYSTEM_KEY,
  normalizeDesignSystemKey, isDesignSystemKey, catalogEntry,
  resolveDesignSystemBody, publicDesignSystemShape, designSystemCatalog,
} from '../mock2/design-systems-logic.js';

// ---- catalog invariants ----

test('catalog: has the two built-ins with unique keys and required fields', () => {
  const keys = BUILTIN_DESIGN_SYSTEMS.map((d) => d.key);
  assert.deepEqual([...keys].sort(), ['clarity-clinical', 'default']);
  assert.equal(new Set(keys).size, keys.length);
  for (const e of BUILTIN_DESIGN_SYSTEMS) {
    assert.ok(e.label && e.summary, 'label + summary present');
    assert.ok(['dark', 'light'].includes(e.theme), 'theme is dark|light');
    assert.ok(e.source === 'framework' || e.source.startsWith('seed:'), 'source is framework|seed:*');
  }
  // The default is the framework-backed dark theme; clarity-clinical is a light seed.
  assert.equal(catalogEntry('default').source, 'framework');
  assert.equal(catalogEntry('clarity-clinical').theme, 'light');
  assert.ok(catalogEntry('clarity-clinical').source.startsWith('seed:'));
});

// ---- normalization ----

test('normalizeDesignSystemKey: known keys pass, everything else defaults', () => {
  assert.equal(normalizeDesignSystemKey('clarity-clinical'), 'clarity-clinical');
  assert.equal(normalizeDesignSystemKey(' Default '), 'default');
  assert.equal(normalizeDesignSystemKey('CLARITY-CLINICAL'), 'clarity-clinical');
  assert.equal(normalizeDesignSystemKey(null), DEFAULT_DESIGN_SYSTEM_KEY);
  assert.equal(normalizeDesignSystemKey(''), DEFAULT_DESIGN_SYSTEM_KEY);
  assert.equal(normalizeDesignSystemKey('nonsense'), DEFAULT_DESIGN_SYSTEM_KEY);
});

test('isDesignSystemKey: strict membership (pre-normalization), rejects unknown', () => {
  assert.equal(isDesignSystemKey('clarity-clinical'), true);
  assert.equal(isDesignSystemKey(' default '), true);
  assert.equal(isDesignSystemKey('studio'), false);
  assert.equal(isDesignSystemKey(null), false);
});

// ---- body resolution ----

test('resolveDesignSystemBody: default resolves to the framework body', () => {
  const fw = '# framework dark system';
  assert.equal(
    resolveDesignSystemBody({ key: 'default', frameworkDesignSystem: fw, seedBodies: {} }),
    fw,
  );
  // A NULL/unknown key behaves as default too.
  assert.equal(
    resolveDesignSystemBody({ key: null, frameworkDesignSystem: fw }),
    fw,
  );
});

test('resolveDesignSystemBody: seed-backed key resolves to its seed body', () => {
  const body = '# Clarity Clinical light theme';
  const out = resolveDesignSystemBody({
    key: 'clarity-clinical',
    frameworkDesignSystem: '# dark',
    seedBodies: { 'clarity-clinical.md': body },
  });
  assert.equal(out, body);
});

test('resolveDesignSystemBody: missing/blank seed falls back to the framework body (never blank)', () => {
  const fw = '# framework dark system';
  // seed absent entirely
  assert.equal(
    resolveDesignSystemBody({ key: 'clarity-clinical', frameworkDesignSystem: fw, seedBodies: {} }),
    fw,
  );
  // seed present but blank
  assert.equal(
    resolveDesignSystemBody({ key: 'clarity-clinical', frameworkDesignSystem: fw, seedBodies: { 'clarity-clinical.md': '   ' } }),
    fw,
  );
});

// ---- API shapes ----

test('publicDesignSystemShape: flags the selected entry', () => {
  const clarity = catalogEntry('clarity-clinical');
  assert.equal(publicDesignSystemShape(clarity, 'clarity-clinical').selected, true);
  assert.equal(publicDesignSystemShape(clarity, 'default').selected, false);
  // An unknown selection normalizes to default → clarity is not selected.
  assert.equal(publicDesignSystemShape(clarity, 'garbage').selected, false);
  assert.equal(publicDesignSystemShape(catalogEntry('default'), null).selected, true);
});

test('designSystemCatalog: reports selected_key + one option per built-in, exactly one selected', () => {
  const cat = designSystemCatalog('clarity-clinical');
  assert.equal(cat.selected_key, 'clarity-clinical');
  assert.equal(cat.options.length, BUILTIN_DESIGN_SYSTEMS.length);
  assert.equal(cat.options.filter((o) => o.selected).length, 1);
  assert.equal(cat.options.find((o) => o.selected).key, 'clarity-clinical');

  // NULL selection → default is the one selected.
  const def = designSystemCatalog(null);
  assert.equal(def.selected_key, 'default');
  assert.equal(def.options.filter((o) => o.selected).length, 1);
  assert.equal(def.options.find((o) => o.selected).key, 'default');
});
