// GlyphField in a real browser: it draws, it moves, it holds still under
// prefers-reduced-motion and `paused`, it follows the theme, it never blocks
// the content above it and it does not widen a phone screen.
//   node tests/glyph-field.browser.mjs
// PLAYWRIGHT_CORE overrides the playwright-core entry, BROWSER_EXE the browser.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE || '../../backend/node_modules/playwright-core/index.mjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.BROWSER_ARTIFACTS || '/tmp/proxypilot-glyph-field';
mkdirSync(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/tmp/chromium', headless: true, args: ['--no-sandbox'] });

async function open({ width = 1280, height = 800, query = '', reducedMotion = 'no-preference' } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${origin}/tests/glyph-field-fixture.html?${query}`);
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas');
    return c && c.width > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0);
  });
  return page;
}

// Lit pixel count, a cheap hash of the pixels and the colour of the most opaque one.
const snapshot = (page) => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0, hash = 0, best = -1, rgb = null;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) lit++;
    hash = (hash * 31 + d[i + 3]) | 0;
    if (d[i + 3] > best) { best = d[i + 3]; rgb = [d[i], d[i + 1], d[i + 2]]; }
  }
  return { lit, hash, rgb, total: d.length / 4 };
});

try {
  // Desktop, Midnight: draws, decorative, below the content, animates.
  let page = await open({ width: 1600, height: 1000 });
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const card = document.querySelector('main > div');
    const r = card.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ariaHidden: c.getAttribute('aria-hidden'),
      pointerEvents: getComputedStyle(c).pointerEvents,
      cardOnTop: card.contains(hit),
      sized: c.width === Math.round(c.clientWidth * Math.min(devicePixelRatio, 2)) && c.clientWidth === innerWidth,
    };
  });
  assert.deepEqual(canvas, { ariaHidden: 'true', pointerEvents: 'none', cardOnTop: true, sized: true });
  const first = await snapshot(page);
  assert.ok(first.lit > first.total * 0.02, `glyphs drawn (${first.lit} lit px)`);
  assert.ok(first.rgb[0] > 128, `light glyphs on Midnight (${first.rgb})`);
  await page.screenshot({ path: `${output}/midnight-1600.png` });
  await page.waitForTimeout(600);
  const moved = await snapshot(page);
  assert.notEqual(moved.hash, first.hash, 'the field animates');

  // Theme switch re-colours the glyphs without a reload.
  await page.evaluate(() => window.__setTheme('office'));
  await page.waitForTimeout(300);
  const office = await snapshot(page);
  assert.ok(office.rgb[0] < 128, `dark glyphs on Office (${office.rgb})`);
  await page.screenshot({ path: `${output}/office-1600.png` });
  assert.deepEqual(page.errors, []);
  await page.close();

  // Reduced motion and paused: one still frame.
  for (const [label, options] of [['reduced motion', { reducedMotion: 'reduce' }], ['paused', { query: 'paused=1' }]]) {
    page = await open(options);
    const a = await snapshot(page);
    await page.waitForTimeout(700);
    const b = await snapshot(page);
    assert.ok(a.lit > 0, `${label}: still frame is drawn`);
    assert.equal(b.hash, a.hash, `${label}: no motion`);
    assert.deepEqual(page.errors, []);
    await page.close();
  }

  // Full coverage on a width that is not a whole number of mask tiles
  // (360px = 23 samples): glyphs reach both edges.
  page = await open({ width: 360, height: 740, query: 'coverage=1' });
  const edges = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const strip = (x) => c.getContext('2d').getImageData(x, 0, 12, c.height).data.filter((v, i) => i % 4 === 3 && v > 0).length;
    return { left: strip(0), right: strip(c.width - 12) };
  });
  assert.ok(edges.left > 0 && edges.right > 0, `glyphs at both edges ${JSON.stringify(edges)}`);
  await page.close();

  // Phones: no horizontal scroll, field fills the screen.
  for (const width of [360, 375, 768]) {
    page = await open({ width, height: 740, query: 'theme=latte' });
    const fit = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      fills: document.querySelector('canvas').clientWidth === innerWidth,
    }));
    assert.deepEqual(fit, { overflow: false, fills: true }, `${width}px`);
    await page.screenshot({ path: `${output}/latte-${width}.png` });
    await page.close();
  }
  console.log(`glyph-field browser check passed; screenshots in ${output}`);
} finally {
  await browser.close();
  await server.close();
}
