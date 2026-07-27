// DENSITY and REDUNDANT STATUS CODING — the two things that separate a
// considered interface from a generated one, and that nothing was measuring.
//
// The gate battery answers "can this app be used": overflow, dead controls,
// token adherence. Nothing answered "is this screen any good to read", so the
// review was asked to eyeball density and colour-coding from a JPEG — which is
// the one thing a vision model is least reliable at and a browser is exact at.
//
// Native-free (risk R9): the in-page probe lives in design-review.js; every
// judgement about what the numbers MEAN is here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DENSITY_FLOOR, EMPTY_CEILING, isSparseByDesign,
  densityFindings, colorOnlyFindings, signalsPromptBlock, signalsChatLines,
} from '../mock2/design-signals-logic.js';

test('an airy dashboard is named, and an empty one is named differently', () => {
  // "Your dashboard is airy" and "your dashboard is empty" are different news:
  // the first is a design note, the second means the route is not rendering.
  const findings = densityFindings([
    { path: '/', width: 1280, facts: 6 },
    { path: '/reports', width: 1280, facts: EMPTY_CEILING },
    { path: '/staff', width: 1280, facts: DENSITY_FLOOR.desktop + 5 },
  ]);
  assert.deepEqual(findings.map((f) => f.code), ['low-density', 'screen-empty']);
  assert.match(findings[0].detail, /6 fact\(s\)/);
  assert.match(findings[0].detail, /about 18/, 'the number it is being held to is stated');
  assert.match(findings[1].detail, /not a sparse screen, it is an empty one/);
  // Never above medium: this is a reading of the screen, not a defect.
  for (const f of findings) assert.ok(['low', 'medium'].includes(f.severity));
});

test('density is judged per width, because a screen can be right on one and adrift on the other', () => {
  // A mobile-first build produces exactly this: correct on a phone, three cards
  // adrift of the fold on a laptop.
  const same = 10;
  const findings = densityFindings([
    { path: '/', width: 390, facts: same },
    { path: '/', width: 1280, facts: same },
  ]);
  assert.equal(findings.length, 1, 'the same count passes at 390 and fails at 1280');
  assert.match(findings[0].detail, /1280px/);
  assert.ok(DENSITY_FLOOR.mobile < DENSITY_FLOOR.desktop);
});

test('a screen that is SUPPOSED to be sparse is left alone', () => {
  // A sign-in page with 18 facts above the fold would be a defect of its own.
  for (const p of ['/login', '/signin', '/sign-in', '/register', '/reset/abc', '/onboarding']) {
    assert.equal(isSparseByDesign(p), true, `${p} is sparse by design`);
    assert.deepEqual(densityFindings([{ path: p, width: 1280, facts: 2 }]), []);
  }
  assert.equal(isSparseByDesign('/loginhistory'), false, 'a prefix is not a match');
  assert.equal(isSparseByDesign('/'), false);
});

test('colour as the only status channel is reported; a single dot is not', () => {
  // Three separate people are failed by colour-only status: the colourblind
  // reader, the person reading a screenshot, and the person searching the page
  // for "overdue". One coloured element beside a label is not that — it is a
  // dot next to a word, and flagging it would make this noise.
  assert.deepEqual(colorOnlyFindings([{ path: '/', colorOnly: 1, total: 6 }]), []);
  const f = colorOnlyFindings([{ path: '/shifts', colorOnly: 4, total: 9, examples: ['span.dot', 'i.state'] }]);
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'colour-only-status');
  assert.equal(f[0].severity, 'medium');
  assert.match(f[0].detail, /span\.dot/, 'naming the element is what makes it fixable');
  assert.match(f[0].detail, /glyph and a word/);
});

test('the critique is handed evidence, and told it is already true', () => {
  const clean = signalsPromptBlock({ density: [], colorOnly: [] });
  assert.match(clean, /measured clean/);
  const block = signalsPromptBlock({
    density: densityFindings([{ path: '/', width: 1280, facts: 5 }]),
    colorOnly: colorOnlyFindings([{ path: '/', colorOnly: 3 }]),
  });
  assert.match(block, /DETERMINISTIC MEASUREMENTS/);
  assert.match(block, /already true of the running app/);
  assert.match(block, /rather than repeating them/, 'or the critique just reads the list back');
});

test('a systemic problem does not produce twelve identical chat lines', () => {
  const many = densityFindings(Array.from({ length: 12 }, (_, i) => ({ path: `/p${i}`, width: 1280, facts: 4 })));
  const lines = signalsChatLines({ density: many, colorOnly: [] });
  assert.equal(lines.length, 5, '4 findings + the "and N more" line');
  assert.match(lines[4], /8 more/);
  assert.deepEqual(signalsChatLines({ density: [], colorOnly: [] }), [], 'clean says nothing');
  // Accessibility first when both are present.
  const mixed = signalsChatLines({ density: many, colorOnly: colorOnlyFindings([{ path: '/x', colorOnly: 5 }]) });
  assert.match(mixed[0], /colour-only-status/);
});

test('the measurements are actually taken and actually used', () => {
  // A pure judgement layer fed by nothing judges nothing.
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock2', 'design-review.js'),
    'utf8',
  );
  assert.match(src, /async function measureSignals/);
  assert.match(src, /densityMeasurements\.push/);
  assert.match(src, /signalMeasurements\.push/);
  // Both widths: density is a different question at each.
  assert.match(src, /width: MOBILE\.width, facts: s\.facts/);
  assert.match(src, /width: DESKTOP\.width, facts: s\.facts/);
  // And the results reach both the critique and the operator.
  assert.match(src, /signalsPromptBlock\(signals\)/);
  assert.match(src, /signalsChatLines\(signals\)/);
});

test('the probe counts LEAVES, not containers', () => {
  // Counting every visible element would score a deeply-nested empty layout as
  // dense — which is precisely the shape being caught.
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock2', 'design-review.js'),
    'utf8',
  );
  const fn = src.slice(src.indexOf('async function measureSignals'), src.indexOf('// axe-core source'));
  assert.match(fn, /el\.children\.length === 0 && \(el\.textContent \|\| ''\)\.trim\(\)\.length > 0/);
  // Above the fold on purpose: what someone sees before deciding whether the
  // screen is worth their time.
  assert.match(fn, /r\.top < vh/);
  // A transparent colour is not a signal, and a page-wide banner is not a chip.
  assert.match(fn, /p\[3\] === 0/);
  assert.match(fn, /r\.width > 240 \|\| r\.height > 120/);
});
