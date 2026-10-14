// GlyphField — an ambient background of drifting monospace glyphs, in the
// style of the Claude desktop app's new-session screen: a grid of random
// base64-looking characters that only shows through slowly morphing "clouds",
// with a few characters re-rolled every second.
//
// The module has two layers:
//   - pure, DOM-free math (seeded PRNG, 3D simplex noise, grid sizing, the
//     cloud mask, scrambling) — unit-tested in test/glyph-field.test.mjs
//     (tests/glyph-field.browser.mjs drives the renderer in Chromium);
//   - mountGlyphField(canvas, options), a framework-free renderer that paints
//     that math onto a <canvas>. The React wrapper is
//     components/ui/glyph-field.jsx; plain pages can call this directly.
//
// Nothing here touches the DOM at import time.

export const GLYPH_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const BLANK = 255; // glyph index for an empty cell (gaps inside the "strings")
const BLANK_RATIO = 0.06;
const FEATURE_PX = 420; // cloud size in CSS px at scale 1
const MASK_PX = 16; // cloud-mask sample spacing in CSS px
const MIN_ALPHA = 0.02; // below this a mask sample counts as dark

export const GLYPH_FIELD_DEFAULTS = Object.freeze({
  charset: GLYPH_CHARSET,
  fontFamily: '"JetBrains Mono", "Fira Code", Consolas, ui-monospace, monospace',
  fontSize: 11, // CSS px
  lineHeight: 1.35,
  coverage: 0.4, // 0..1 — how much of the area the clouds cover
  intensity: 0.42, // 0..1 — opacity of the brightest glyphs
  softness: 0.2, // width of the cloud edge fade, in mask units
  scale: 1, // cloud size multiplier
  speed: 1, // cloud evolution speed multiplier (0 freezes the clouds)
  scramble: 0.05, // fraction of glyphs re-rolled per second
  fps: 20, // frame cap; the motion is slow, so 60fps only costs battery
  maxDpr: 2,
  paused: false,
  seed: undefined, // number for a reproducible field; random per mount otherwise
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// mulberry32: tiny, fast, seedable PRNG returning floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 3D simplex noise (Stefan Gustavson's public-domain reference), with the
// permutation table shuffled by `rand` so a seed gives a reproducible field.
// Returns values in roughly [-1, 1].
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);
const F3 = 1 / 3;
const G3 = 1 / 6;

export function createNoise3D(rand = Math.random) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  const grad = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    grad[i] = (perm[i] % 12) * 3;
  }

  return function noise3D(x, y, z) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;

    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = grad[ii + perm[jj + perm[kk]]];
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = grad[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = grad[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = grad[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * n;
  };
}

export function gridSize(width, height, cellWidth, cellHeight) {
  if (!(width > 0 && height > 0 && cellWidth > 0 && cellHeight > 0)) return { cols: 0, rows: 0 };
  return { cols: Math.ceil(width / cellWidth), rows: Math.ceil(height / cellHeight) };
}

// Mask level (0..1) a cell must clear to show. Calibrated against the mask's
// value distribution so `coverage` ≈ the fraction of the area with glyphs;
// 0 and 1 are exact (nothing / everything).
export function coverageThreshold(coverage) {
  const c = clamp(Number(coverage) || 0, 0, 1);
  if (c === 0) return 2;
  if (c === 1) return -1;
  return 0.75 - 0.5 * c;
}

function randomGlyph(rand, glyphCount) {
  return rand() < BLANK_RATIO ? BLANK : Math.floor(rand() * glyphCount);
}

// A cols×rows field of glyph indices plus a fixed per-cell brightness, so some
// characters read brighter than their neighbours. Cells that overlap
// `previous` keep their glyph and shade, so a resize does not reshuffle the
// whole screen. Pass `previous` only when the charset is unchanged.
export function createField(cols, rows, glyphCount, rand, previous = null) {
  if (glyphCount < 1 || glyphCount >= BLANK) throw new RangeError('charset must have 1-254 glyphs');
  const size = cols * rows;
  const glyphs = new Uint8Array(size);
  const shade = new Float32Array(size);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (previous && c < previous.cols && r < previous.rows) {
        const j = r * previous.cols + c;
        glyphs[i] = previous.glyphs[j];
        shade[i] = previous.shade[j];
      } else {
        glyphs[i] = randomGlyph(rand, glyphCount);
        shade[i] = 0.35 + 0.65 * rand();
      }
    }
  }
  return { cols, rows, glyphs, shade };
}

// Re-roll `count` randomly chosen cells; returns their indices so a renderer
// repaints only those.
export function scrambleField(field, count, glyphCount, rand) {
  const size = field.glyphs.length;
  const changed = [];
  if (!size) return changed;
  for (let n = 0; n < count; n++) {
    const i = Math.floor(rand() * size);
    field.glyphs[i] = randomGlyph(rand, glyphCount);
    changed.push(i);
  }
  return changed;
}

// The cloud mask is sampled on a coarse grid (one sample per `spacing` CSS px)
// and stretched over the glyphs with bilinear smoothing: the clouds are
// hundreds of pixels wide, so per-glyph sampling would buy nothing.
export function createMask(width, height, spacing = MASK_PX) {
  const { cols, rows } = gridSize(width, height, spacing, spacing);
  return { cols, rows, spacing, alpha: new Float32Array(cols * rows) };
}

// Fill mask.alpha (0..intensity) for `time` (seconds × speed). Returns the
// fraction of samples bright enough to show.
export function shadeMask(mask, noise3D, { time = 0, scale = 1, coverage, intensity, softness }) {
  const { cols, rows, spacing, alpha } = mask;
  const freq = spacing / (FEATURE_PX * Math.max(0.05, scale));
  const lo = coverageThreshold(coverage);
  const hi = lo + Math.max(0.001, softness);
  const peak = clamp(intensity, 0, 1);
  const z = time * 0.06;
  const drift = time * 0.025; // slow sideways drift on top of the morphing
  let lit = 0;
  for (let r = 0; r < rows; r++) {
    const y = (r + 0.5) * freq;
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * freq + drift;
      // Two octaves: broad clouds plus finer ragged edges.
      const n = 0.72 * noise3D(x, y, z) + 0.28 * noise3D(x * 2.3 + 17.1, y * 2.3 + 31.7, z * 1.7);
      const a = smoothstep(lo, hi, n * 0.5 + 0.5) * peak;
      alpha[r * cols + c] = a;
      if (a >= MIN_ALPHA) lit++;
    }
  }
  return alpha.length ? lit / alpha.length : 0;
}

// Defaults plus every option the caller actually set: a React prop passed as
// `undefined` must not wipe out a default.
export function resolveOptions(options = {}) {
  const resolved = { ...GLYPH_FIELD_DEFAULTS };
  for (const [key, value] of Object.entries(options || {})) if (value !== undefined) resolved[key] = value;
  return resolved;
}

function reducedMotionQuery() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)');
  } catch {
    return null;
  }
}

// Paint a GlyphField onto `canvas`, which the caller sizes with CSS (it fills
// whatever box it is given). The glyph colour is the canvas's CSS `color`, so
// a text-* class themes it, and it is re-read when the page theme changes.
// Animation stops while the tab is hidden, while the canvas is off screen,
// under prefers-reduced-motion (one still frame is drawn) and when `paused`.
//
// Per frame this costs one small noise grid and two full-canvas draws: the
// glyphs live on an offscreen sheet (only re-rolled cells are repainted) and
// are cut by the upscaled, inverted mask with `destination-out`. (Bounded on
// purpose: `destination-in` makes Chrome composite a full-canvas layer, which
// costs the whole screen even where the clip leaves nothing to draw.)
export function mountGlyphField(canvas, options = {}) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return { update() {}, redraw() {}, destroy() {} };

  let opts = resolveOptions(options);
  const rand = mulberry32(Number.isFinite(opts.seed) ? opts.seed : Math.floor(Math.random() * 2 ** 32));
  const noise3D = createNoise3D(rand);

  const atlas = document.createElement('canvas'); // one cell per charset glyph
  const sheet = document.createElement('canvas'); // every glyph at its shade
  const maskCanvas = document.createElement('canvas');
  const atlasCtx = atlas.getContext('2d');
  const sheetCtx = sheet.getContext('2d');
  const maskCtx = maskCanvas.getContext('2d');
  let maskImage = null;
  let field = null;
  let mask = null;
  let fieldCharset = '';
  let cellW = 0; // device px
  let cellH = 0;
  let dpr = 1;
  let color = '';
  let time = 0;
  let carry = 0;
  let raf = 0;
  let last = 0;
  let visible = !document.hidden;
  let onScreen = true;
  const reducedQuery = reducedMotionQuery();
  let reduced = !!reducedQuery?.matches;

  function readColor() {
    try { return getComputedStyle(canvas).color || 'rgb(160, 160, 160)'; } catch { return 'rgb(160, 160, 160)'; }
  }

  function buildAtlas() {
    const glyphs = opts.charset;
    const font = `${opts.fontSize * dpr}px ${opts.fontFamily}`;
    atlasCtx.font = font;
    cellW = Math.max(1, Math.round(atlasCtx.measureText('M').width));
    cellH = Math.max(1, Math.round(opts.fontSize * opts.lineHeight * dpr));
    atlas.width = cellW * glyphs.length; // resizing resets the context state
    atlas.height = cellH;
    atlasCtx.font = font;
    atlasCtx.fillStyle = color;
    atlasCtx.textAlign = 'center';
    atlasCtx.textBaseline = 'middle';
    for (let g = 0; g < glyphs.length; g++) atlasCtx.fillText(glyphs[g], g * cellW + cellW / 2, cellH / 2);
  }

  function paintCell(i) {
    const c = i % field.cols;
    const r = (i - c) / field.cols;
    const g = field.glyphs[i];
    sheetCtx.clearRect(c * cellW, r * cellH, cellW, cellH);
    if (g === BLANK) return;
    sheetCtx.globalAlpha = field.shade[i];
    sheetCtx.drawImage(atlas, g * cellW, 0, cellW, cellH, c * cellW, r * cellH, cellW, cellH);
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr);
    color = readColor();
    buildAtlas();
    const width = Math.round(canvas.clientWidth * dpr);
    const height = Math.round(canvas.clientHeight * dpr);
    canvas.width = width;
    canvas.height = height;
    sheet.width = width;
    sheet.height = height;
    const { cols, rows } = gridSize(width, height, cellW, cellH);
    const keep = field && fieldCharset === opts.charset ? field : null;
    field = keep && keep.cols === cols && keep.rows === rows ? keep : createField(cols, rows, opts.charset.length, rand, keep);
    fieldCharset = opts.charset;
    for (let i = 0; i < field.glyphs.length; i++) paintCell(i);
    mask = createMask(canvas.clientWidth, canvas.clientHeight);
    maskCanvas.width = Math.max(1, mask.cols);
    maskCanvas.height = Math.max(1, mask.rows);
    maskImage = maskCtx.createImageData(maskCanvas.width, maskCanvas.height);
  }

  function draw() {
    if (!field) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!field.glyphs.length || !mask.alpha.length) return;
    shadeMask(mask, noise3D, {
      time, scale: opts.scale, coverage: opts.coverage, intensity: opts.intensity, softness: opts.softness,
    });
    const px = maskImage.data;
    for (let i = 0; i < mask.alpha.length; i++) px[i * 4 + 3] = Math.round((1 - mask.alpha[i]) * 255);
    maskCtx.putImageData(maskImage, 0, 0);
    // Both draws are clipped to the tiles that have any cloud in them, so the
    // empty part of the screen costs no pixel work.
    const scale = mask.spacing * dpr;
    ctx.save();
    if (!clipToLitTiles(scale)) {
      ctx.restore();
      return;
    }
    ctx.drawImage(sheet, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(maskCanvas, 0, 0, mask.cols, mask.rows, 0, 0, mask.cols * scale, mask.rows * scale);
    ctx.restore();
  }

  // Clip to one rectangle per horizontal run of lit tiles (4×4 mask samples).
  // A tile counts as lit when any sample in it or bordering it is, because
  // bilinear smoothing bleeds each sample half-way into its neighbours.
  // Returns whether anything is lit.
  function clipToLitTiles(scale) {
    const { cols, rows, alpha } = mask;
    const tile = 4;
    let any = false;
    ctx.beginPath();
    for (let ty = 0; ty < rows; ty += tile) {
      let runStart = -1;
      // One step past the last tile closes a run that reaches the right edge.
      for (let tx = 0; tx < cols + tile; tx += tile) {
        let lit = false;
        for (let r = Math.max(0, ty - 1); tx < cols && r < Math.min(rows, ty + tile + 1) && !lit; r++) {
          for (let c = Math.max(0, tx - 1); c < Math.min(cols, tx + tile + 1); c++) {
            if (alpha[r * cols + c] > 0) { lit = true; break; }
          }
        }
        if (lit && runStart < 0) runStart = tx;
        if (!lit && runStart >= 0) {
          const x = Math.floor(runStart * scale);
          const y = Math.floor(ty * scale);
          ctx.rect(x, y, Math.ceil(Math.min(cols, tx) * scale) - x, Math.ceil(Math.min(rows, ty + tile) * scale) - y);
          runStart = -1;
          any = true;
        }
      }
    }
    if (any) ctx.clip();
    return any;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const interval = 1000 / clamp(opts.fps, 1, 60);
    if (last && now - last < interval) return;
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
    // Keep the remainder so a 24fps cap on a 60Hz display stays near 24fps.
    last = last ? now - ((now - last) % interval) : now;
    time += dt * opts.speed;
    carry += field.glyphs.length * opts.scramble * dt;
    const count = Math.floor(carry);
    carry -= count;
    for (const i of scrambleField(field, count, opts.charset.length, rand)) paintCell(i);
    draw();
  }

  function sync() {
    const run = !opts.paused && !reduced && visible && onScreen && field && field.glyphs.length > 0;
    if (run && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function refresh() {
    layout();
    draw();
    sync();
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
  resizeObserver?.observe(canvas);
  const intersectionObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      sync();
    })
    : null;
  intersectionObserver?.observe(canvas);
  // Theme switches flip classes/data-theme on <html>; re-read the colour then.
  const themeObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(() => {
      if (readColor() !== color) refresh();
    })
    : null;
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  const onVisibility = () => {
    visible = !document.hidden;
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const onReduced = (event) => {
    reduced = event.matches;
    draw();
    sync();
  };
  reducedQuery?.addEventListener?.('change', onReduced);

  refresh();

  return {
    // Replace the options (left-out or undefined ones fall back to the
    // defaults; the seed stays). Cheap when nothing changed, so a wrapper may
    // call it on every render. Also re-reads the colour (a changed text-* class).
    update(next = {}) {
      const merged = { ...resolveOptions(next), seed: opts.seed };
      const changed = Object.keys(merged).some((key) => merged[key] !== opts[key]);
      if (!changed && readColor() === color) return;
      opts = merged;
      refresh();
    },
    redraw: refresh,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      themeObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reducedQuery?.removeEventListener?.('change', onReduced);
      field = null;
      mask = null;
    },
  };
}
