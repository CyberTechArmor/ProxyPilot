// The design-quality craft layer (operator: "function A-, form B — get form
// closer to reference quality"):
//   A. the FOUR flagship themes exist and each carries a complete
//      art-direction contract (register, named palette with roles, a
//      display/UI type pairing with rules, signature details);
//   B. the contract rides applyDesignPreset — and the admin toggle
//      (design_art_direction) genuinely removes it;
//   C. an EXPLORE turn must declare its own art direction — same toggle;
//   D. the design review's taste rubric is present and gate-able
//      (design_taste_rubric).
// Pure-layer only (native-free, stub-first — risk R9).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DESIGN_PRESETS, getDesignPreset, applyDesignPreset, applyExploreDesign } from '../mock2/design-presets.js';
import { buildReviewPrompt } from '../mock2/design-review-logic.js';

const FLAGSHIPS = ['portal-blue', 'folio-warm', 'folio-light', 'folio-dark'];
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// ---- A. the flagship four ----

test('all four flagship themes exist with complete art-direction contracts', () => {
  for (const key of FLAGSHIPS) {
    const p = getDesignPreset(key);
    assert.ok(p, `${key} exists`);
    const ad = p.artDirection;
    assert.ok(ad, `${key} carries artDirection`);
    assert.ok(String(ad.register).length > 10, `${key} names its register`);
    assert.ok(Array.isArray(ad.namedPalette) && ad.namedPalette.length >= 5, `${key} has a named palette`);
    for (const c of ad.namedPalette) {
      assert.ok(c.name && HEX_RE.test(c.hex) && String(c.role).length > 4, `${key} palette entry ${c.name} is complete`);
    }
    assert.ok(ad.fontPairing?.display && ad.fontPairing?.ui && String(ad.fontPairing.rules).length > 20, `${key} pairing has rules`);
    assert.ok(Array.isArray(ad.signature) && ad.signature.length >= 2, `${key} has signature details`);
  }
});

test('the three Folio registers pair a serif display with a sans UI; Portal is deliberately single-face', () => {
  for (const key of ['folio-warm', 'folio-light', 'folio-dark']) {
    const t = getDesignPreset(key).tokens.typography;
    assert.match(t.headingFamily, /Georgia/i, `${key} display serif`);
    assert.match(t.fontFamily, /Inter|sans/i, `${key} sans UI`);
  }
  const portal = getDesignPreset('portal-blue');
  assert.match(portal.artDirection.fontPairing.rules, /single/i);
});

test('flagship keys are unique and present in the master list', () => {
  const keys = DESIGN_PRESETS.map((p) => p.key);
  for (const key of FLAGSHIPS) assert.ok(keys.includes(key), key);
});

// ---- B. the contract rides the themed prompt, gated ----

test('applyDesignPreset carries the craft contract when on, and drops it when off', () => {
  const on = applyDesignPreset('BASE', 'folio-warm');
  assert.match(on, /Art direction \(craft contract/);
  assert.match(on, /rust #a74f36/);
  assert.match(on, /Georgia ONLY for display moments/);
  assert.match(on, /Signature details/);
  assert.match(on, /Base design theme \(binding as a BASE\)/, 'the token base section still rides');

  const off = applyDesignPreset('BASE', 'folio-warm', { artDirection: false });
  assert.doesNotMatch(off, /Art direction \(craft contract/);
  assert.match(off, /Base design theme \(binding as a BASE\)/, 'tokens are not gated — only the contract is');
});

test('a preset without an artDirection block is unchanged by the toggle', () => {
  const p = DESIGN_PRESETS.find((x) => !x.artDirection);
  assert.ok(p, 'non-flagship presets still exist');
  assert.equal(applyDesignPreset('BASE', p.key), applyDesignPreset('BASE', p.key, { artDirection: false }));
});

// ---- C. explore turns must declare their own ----

test('an explore turn is told to DECLARE its art direction before using it — unless toggled off', () => {
  const on = applyExploreDesign('BASE');
  assert.match(on, /DECLARE your art direction/);
  assert.match(on, /signature detail/i);
  const off = applyExploreDesign('BASE', { artDirection: false });
  assert.doesNotMatch(off, /DECLARE your art direction/);
  assert.match(off, /EXPLORE a new look/, 'the explore framing itself is not gated');
});

// ---- D. the review taste rubric ----

test('the review prompt grades TASTE by default, and the toggle removes exactly that', () => {
  const on = buildReviewPrompt();
  assert.match(on, /TASTE \(grade against/);
  assert.match(on, /register coherence/);
  const off = buildReviewPrompt({ tasteRubric: false });
  assert.doesNotMatch(off, /TASTE \(grade against/);
  for (const always of [/FIDELITY/, /CRAFT/, /RESTRAINT/, /STRICT JSON/]) {
    assert.match(off, always, 'the rest of the rubric is untouched');
  }
});
