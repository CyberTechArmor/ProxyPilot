// MOTION — the design system's fourth axis.
//
// It did not exist. DEFAULT_TOKENS carried colour, type, radius, spacing and
// shadow, the only motion in a generated app was a skeleton shimmer, and the
// one motion-shaped rule in the platform stylesheet DISABLED animation. So a
// build had no approved way to make anything move, and a build that animated
// anyway was inventing vocabulary the adherence gate counted against it.
//
// These assert the whole chain: a mockup can demonstrate motion, approval
// extracts it, the bridge carries it into the shell, and the shell's classes
// consume it — with the same names at every step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDesignTokens, renderDesignTokensCss, buildTokenBridgeCss, TOKEN_BRIDGE_TARGETS,
} from '../mock2/concept-logic.js';
import { MOCKUP_MOTION, MOCKUP_BASE_CSS, mockupMotionCss } from '../mock2/mockup-template.js';
import { PLATFORM_CSS } from '../mock2/scaffold-platform.js';
import { DESIGN_PRESETS, parseDesignDoc, DESIGN_DOC_FORMAT } from '../mock2/design-presets.js';

// The four classes a screen SELECTS instead of writing its own keyframes.
const UTILITIES = ['.enter', '.enter-fade', '.stagger', '.press', '.pulse-once'];

test('the design system has a vocabulary for movement at all', () => {
  const css = renderDesignTokensCss();
  for (const v of ['--app-dur-fast', '--app-dur-base', '--app-dur-slow',
    '--app-ease-standard', '--app-ease-entrance', '--app-ease-exit']) {
    assert.ok(css.includes(`${v}:`), `the approved stylesheet must define ${v}`);
  }
  // And the mockup can demonstrate it, or an approved design would never have
  // motion to extract in the first place.
  assert.match(MOCKUP_BASE_CSS, /==motion==/);
  for (const u of UTILITIES) assert.ok(MOCKUP_BASE_CSS.includes(`${u} `) || MOCKUP_BASE_CSS.includes(`${u}{`) || MOCKUP_BASE_CSS.includes(`${u}:`) || MOCKUP_BASE_CSS.includes(`${u} >`) || MOCKUP_BASE_CSS.includes(`${u} > *`), `the mockup base CSS must ship ${u}`);
});

test('the shell speaks the same motion vocabulary as the mockup', () => {
  // The whole point of the bridge: an approved design that slowed its motion
  // down must reach the shell too, not stop at the edge of the screens the
  // build wrote. Same class names on both sides, so what a mockup showed is
  // what the app can select.
  for (const u of UTILITIES) {
    assert.ok(PLATFORM_CSS.includes(u), `the app shell must ship ${u}`);
    assert.ok(mockupMotionCss().includes(u), `the mockup must ship ${u}`);
  }
  for (const t of ['--app-dur-fast', '--app-dur-base', '--app-dur-slow',
    '--app-ease-standard', '--app-ease-entrance', '--app-ease-exit']) {
    assert.ok(TOKEN_BRIDGE_TARGETS.includes(t), `the bridge must carry ${t}`);
  }
  const bridged = buildTokenBridgeCss(':root{--dur-base:250ms;--ease-entrance:linear;}');
  assert.match(bridged, /--app-dur-base: var\(--dur-base, 200ms\);/);
  assert.match(bridged, /--app-ease-entrance: var\(--ease-entrance, cubic-bezier\(0,0,0,1\)\);/);
  // A design that defines NO motion narrows the bridge rather than blanking it.
  assert.doesNotMatch(buildTokenBridgeCss(':root{--bg:#fff;}'), /--app-dur-/);
});

test('every shell utility degrades under prefers-reduced-motion', () => {
  // Motion that cannot be turned off is not a design token, it is a hazard.
  const reduced = PLATFORM_CSS.slice(PLATFORM_CSS.indexOf('prefers-reduced-motion'));
  assert.ok(reduced.length > 0, 'the shell must carry a reduced-motion block');
  assert.match(reduced, /animation-duration:\.01ms !important/);
  assert.match(reduced, /transition-duration:\.01ms !important/);
  // The mockup's copy is scoped to its own classes rather than *, so name them.
  const mReduced = mockupMotionCss().slice(mockupMotionCss().indexOf('prefers-reduced-motion'));
  for (const u of UTILITIES) assert.ok(mReduced.includes(u.slice(1)), `${u} must be neutralised under reduced motion`);
});

test('a duration nobody would choose is rejected, not rendered', () => {
  // These values reach CSS. "4s" is valid CSS and a broken interface; the
  // sanitiser is the only thing between a model's guess and every screen.
  const bad = parseDesignTokens(JSON.stringify({ motion: {
    durationFast: '4s', durationBase: '-200ms', durationSlow: '2000ms',
    easingStandard: 'url(javascript:alert(1))', easingEntrance: 'cubic-bezier(1,2', easingExit: '; color: red',
  } }));
  assert.deepEqual(bad.tokens.motion, {
    durationFast: '120ms', durationBase: '200ms', durationSlow: '320ms',
    easingStandard: 'cubic-bezier(0.2,0,0,1)',
    easingEntrance: 'cubic-bezier(0,0,0,1)',
    easingExit: 'cubic-bezier(0.3,0,1,1)',
  }, 'every unsafe value must fall back to the platform default');

  // And a real design's real values survive untouched.
  const good = parseDesignTokens(JSON.stringify({ motion: {
    durationFast: '90ms', durationBase: '0.4s', durationSlow: '1s',
    easingStandard: 'ease-out', easingEntrance: 'linear', easingExit: 'cubic-bezier(.3,0,1,1)',
  } }));
  assert.equal(good.tokens.motion.durationBase, '0.4s');
  assert.equal(good.tokens.motion.durationSlow, '1s');
  assert.equal(good.tokens.motion.easingStandard, 'ease-out');
  assert.equal(good.tokens.motion.easingExit, 'cubic-bezier(.3,0,1,1)');
});

test('every built-in preset declares its own pace', () => {
  // A preset is a LOOK, and how fast an interface moves is part of one. Left
  // undeclared, every preset would render identical motion and the axis would
  // exist in name only.
  const paces = new Set();
  for (const p of DESIGN_PRESETS) {
    assert.ok(p.tokens.motion, `${p.key} must declare motion`);
    // Round-trips through the sanitiser unchanged, like every other token.
    assert.deepEqual(parseDesignTokens(JSON.stringify(p.tokens)).tokens.motion, p.tokens.motion, `${p.key} motion is sanitizer-clean`);
    assert.ok(renderDesignTokensCss(p.tokens).includes(p.tokens.motion.durationBase), `${p.key} css carries its base duration`);
    paces.add(p.tokens.motion.durationBase);
  }
  assert.ok(paces.size > 1, 'presets must not all move at the same speed');
});

test('a design document written before motion existed still parses', () => {
  // Uploads are operator files. Adding an axis must not invalidate the ones
  // already on disk — they inherit the platform timings.
  const doc = { format: DESIGN_DOC_FORMAT, name: 'Legacy', key: 'legacy', tokens: { colors: DESIGN_PRESETS[0].tokens.colors } };
  const r = parseDesignDoc(doc);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.tokens.motion.durationBase, '200ms');
  // And an upload cannot smuggle CSS in through the new fields.
  const evil = parseDesignDoc({ ...doc, tokens: { ...doc.tokens, motion: { durationBase: '9s', easingStandard: 'red; background: url(x)' } } });
  assert.equal(evil.ok, true);
  assert.equal(evil.data.tokens.motion.durationBase, '200ms');
  assert.equal(evil.data.tokens.motion.easingStandard, 'cubic-bezier(0.2,0,0,1)');
});

test('MOCKUP_MOTION is the single source the mockup CSS is generated from', () => {
  // Same reasoning as MOCKUP_TOKENS: the prompt, the markdown and the checks
  // must not be able to drift from three separately-typed copies.
  const css = mockupMotionCss();
  for (const [k, v] of Object.entries(MOCKUP_MOTION)) assert.ok(css.includes(`--${k}: ${v};`), `${k} must come from MOCKUP_MOTION`);
});

test("REGRESSION: the platform's OWN easings survive its own sanitiser", () => {
  // The first grammar demanded a leading zero, so cubic-bezier(.2,0,0,1) — the
  // exact value the mockup template emits — was rejected and silently replaced
  // with the default. A design system whose sanitiser refuses the design system
  // is a loop that looks like it works.
  const fromMockup = parseDesignTokens(JSON.stringify({ motion: {
    easingStandard: MOCKUP_MOTION['ease-standard'],
    easingEntrance: MOCKUP_MOTION['ease-entrance'],
    easingExit: MOCKUP_MOTION['ease-exit'],
    durationFast: MOCKUP_MOTION['dur-fast'],
    durationBase: MOCKUP_MOTION['dur-base'],
    durationSlow: MOCKUP_MOTION['dur-slow'],
  } })).tokens.motion;
  assert.equal(fromMockup.easingStandard, MOCKUP_MOTION['ease-standard']);
  assert.equal(fromMockup.easingEntrance, MOCKUP_MOTION['ease-entrance']);
  assert.equal(fromMockup.easingExit, MOCKUP_MOTION['ease-exit']);
  assert.equal(fromMockup.durationBase, MOCKUP_MOTION['dur-base']);
  // Same for the design-document upload path, which has its own copy of the grammar.
  const doc = parseDesignDoc({
    format: DESIGN_DOC_FORMAT, name: 'From mockup', key: 'from-mockup',
    tokens: { colors: DESIGN_PRESETS[0].tokens.colors, motion: { easingStandard: MOCKUP_MOTION['ease-standard'] } },
  });
  assert.equal(doc.ok, true, doc.error);
  assert.equal(doc.data.tokens.motion.easingStandard, MOCKUP_MOTION['ease-standard']);
});
