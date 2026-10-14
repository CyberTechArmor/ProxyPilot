import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLANK, GLYPH_CHARSET, GLYPH_FIELD_DEFAULTS, coverageThreshold, createField, createMask, createNoise3D,
  gridSize, mountGlyphField, mulberry32, resolveOptions, scrambleField, shadeMask, smoothstep,
} from '../src/lib/glyph-field.js';

const shadeOptions = { scale: 1, coverage: 0.4, intensity: 0.42, softness: 0.2 };

test('seeded PRNG and noise are reproducible and bounded', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  const n1 = createNoise3D(mulberry32(9)), n2 = createNoise3D(mulberry32(9)), n3 = createNoise3D(mulberry32(10));
  let differs = false;
  for (let i = 0; i < 2000; i++) {
    const x = i * 0.137, y = i * 0.071, z = i * 0.013;
    const v = n1(x, y, z);
    assert.equal(v, n2(x, y, z));
    assert.ok(v >= -1 && v <= 1, `noise ${v} out of range`);
    if (v !== n3(x, y, z)) differs = true;
    // Continuity: a tiny step moves the value only a little (smooth clouds, no flicker).
    assert.ok(Math.abs(n1(x + 0.001, y, z) - v) < 0.02);
  }
  assert.ok(differs, 'a different seed gives a different field');
});

test('grid covers the box and rejects empty sizes', () => {
  assert.deepEqual(gridSize(100, 30, 7, 15), { cols: 15, rows: 2 });
  assert.deepEqual(gridSize(0, 30, 7, 15), { cols: 0, rows: 0 });
  assert.deepEqual(gridSize(100, 30, 0, 15), { cols: 0, rows: 0 });
  assert.deepEqual(gridSize(NaN, 30, 7, 15), { cols: 0, rows: 0 });
});

test('coverage threshold is monotone with exact ends', () => {
  let previous = Infinity;
  for (let c = 0; c <= 1.0001; c += 0.05) {
    const t = coverageThreshold(c);
    assert.ok(t < previous);
    previous = t;
  }
  assert.ok(coverageThreshold(0) > 1, 'nothing clears the bar at 0');
  assert.ok(coverageThreshold(1) + GLYPH_FIELD_DEFAULTS.softness < 0, 'everything is fully lit at 1');
  assert.equal(coverageThreshold(-3), coverageThreshold(0));
  assert.equal(coverageThreshold('nope'), coverageThreshold(0));
  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 2), 1);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
});

test('fields hold valid glyphs and keep overlapping cells on resize', () => {
  const rand = mulberry32(3);
  const small = createField(10, 4, GLYPH_CHARSET.length, rand);
  for (let i = 0; i < small.glyphs.length; i++) {
    assert.ok(small.glyphs[i] < GLYPH_CHARSET.length || small.glyphs[i] === BLANK);
    assert.ok(small.shade[i] >= 0.35 && small.shade[i] <= 1);
  }
  const grown = createField(20, 6, GLYPH_CHARSET.length, rand, small);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 10; c++) {
      assert.equal(grown.glyphs[r * 20 + c], small.glyphs[r * 10 + c]);
      assert.equal(grown.shade[r * 20 + c], small.shade[r * 10 + c]);
    }
  }
  assert.throws(() => createField(2, 2, 0, rand), RangeError);
  assert.throws(() => createField(2, 2, 300, rand), RangeError);
});

test('scramble re-rolls at most the requested cells and reports them', () => {
  const rand = mulberry32(5);
  const field = createField(40, 20, GLYPH_CHARSET.length, rand);
  const before = Uint8Array.from(field.glyphs);
  const touched = scrambleField(field, 25, GLYPH_CHARSET.length, rand);
  assert.equal(touched.length, 25);
  let changed = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === field.glyphs[i]) continue;
    changed++;
    assert.ok(touched.includes(i), `cell ${i} changed but was not reported`);
  }
  assert.ok(changed > 0 && changed <= 25, `changed ${changed}`);
  assert.deepEqual(scrambleField(createField(0, 0, 4, rand), 10, 4, rand), []);
});

test('mask: covers the box, coverage controls area, intensity caps opacity, time moves the clouds', () => {
  const noise = createNoise3D(mulberry32(11));
  const mask = createMask(1920, 1080, 16);
  assert.deepEqual([mask.cols, mask.rows, mask.alpha.length], [120, 68, 120 * 68]);
  assert.equal(createMask(0, 500).alpha.length, 0);
  assert.equal(shadeMask(createMask(0, 500), noise, shadeOptions), 0);

  assert.equal(shadeMask(mask, noise, { ...shadeOptions, coverage: 0 }), 0);
  assert.equal(shadeMask(mask, noise, { ...shadeOptions, coverage: 1 }), 1);
  let previous = -1;
  for (const coverage of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const lit = shadeMask(mask, noise, { ...shadeOptions, coverage });
    assert.ok(lit > previous, `coverage ${coverage} shows more than the step before`);
    // Calibrated: the lit fraction tracks the requested coverage.
    assert.ok(Math.abs(lit - coverage) < 0.15, `coverage ${coverage} lit ${lit.toFixed(3)}`);
    previous = lit;
  }

  shadeMask(mask, noise, { ...shadeOptions, intensity: 0.3, time: 2 });
  assert.ok(Math.max(...mask.alpha) <= 0.3 + 1e-6);
  const still = Float32Array.from(mask.alpha);
  shadeMask(mask, noise, { ...shadeOptions, intensity: 0.3, time: 2 });
  assert.deepEqual(mask.alpha, still, 'same time, same frame');
  shadeMask(mask, noise, { ...shadeOptions, intensity: 0.3, time: 6 });
  assert.notDeepEqual(mask.alpha, still, 'later time, different frame');
});

test('undefined options keep the defaults (React passes unset props as undefined)', () => {
  const resolved = resolveOptions({ speed: undefined, scramble: undefined, coverage: 0, paused: false, fps: 30 });
  assert.equal(resolved.speed, GLYPH_FIELD_DEFAULTS.speed);
  assert.equal(resolved.scramble, GLYPH_FIELD_DEFAULTS.scramble);
  assert.equal(resolved.coverage, 0, 'a deliberate 0 is kept');
  assert.equal(resolved.fps, 30);
  assert.deepEqual(resolveOptions(undefined), { ...GLYPH_FIELD_DEFAULTS });
});

test('mounting without a usable canvas is a no-op controller', () => {
  for (const canvas of [null, undefined, {}, { getContext: () => null }]) {
    const controller = mountGlyphField(canvas);
    assert.doesNotThrow(() => { controller.update({ speed: 2 }); controller.redraw(); controller.destroy(); });
  }
});
