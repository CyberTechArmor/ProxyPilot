#!/usr/bin/env node
// Verify a mockup HTML file against the design system's acceptance checks
// (framework-seed/design-system.md §7):
//   node scripts/verify-mockup.mjs <file.html> [--screens <outDir>]
//
// Static battery (always): mockup-checks-logic.js — legacy palette, rogue
// hexes, themes+toggle, data-bound bars, canonical list rows, detail bands,
// svg labels, computed AA contrast from the document's own token blocks.
//
// Runtime battery (when Chromium is available — same loader the smoke
// connector uses): renders the file at 1280px and checks computed layout —
// no overlapping .list-row columns, every .value-statement actually
// truncates when overlong, and the theme toggle flips the page background.
// With --screens it also captures list-light / list-dark / detail PNGs.
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMockupChecks } from '../src/mock2/mockup-checks-logic.js';
import { loadChromium, launchOptions } from '../src/mock2/ui-checks.js';

const file = process.argv[2];
if (!file) { console.error('usage: verify-mockup.mjs <file.html> [--screens <outDir>]'); process.exit(2); }
const screensAt = process.argv.includes('--screens') ? process.argv[process.argv.indexOf('--screens') + 1] : null;

const html = readFileSync(resolve(file), 'utf8');
let failures = 0;

// ---- static battery ----
const res = runMockupChecks(html);
for (const x of res.violations) { console.log(`FAIL [static:${x.check}] ${x.detail}`); failures++; }
console.log(`static checks: ${res.ok ? 'ALL PASS' : `${res.violations.length} failure(s)`}`);

// ---- runtime battery ----
const chromium = await loadChromium();
if (!chromium) {
  console.log('runtime checks: SKIPPED (chromium not available — static battery only)');
  process.exit(failures ? 1 : 0);
}
const browser = await chromium.launch(launchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'domcontentloaded' });

  const runtime = await page.evaluate(() => {
    const out = [];
    // 1) No overlapping columns in any .list-row at >= 1280px.
    document.querySelectorAll('.list-row').forEach((row, i) => {
      const cells = [...row.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
      for (let a = 0; a < cells.length - 1; a++) {
        if (cells[a].right - 1 > cells[a + 1].left) {
          out.push(`row ${i + 1}: column ${a + 1} overlaps column ${a + 2} (${Math.round(cells[a].right)} > ${Math.round(cells[a + 1].left)})`);
        }
      }
    });
    // 2) Truncation engages: nowrap + hidden overflow computed on every value
    //    statement, and no statement paints outside its cell.
    document.querySelectorAll('.value-statement').forEach((el, i) => {
      const cs = getComputedStyle(el);
      if (cs.whiteSpace !== 'nowrap' || cs.overflow !== 'hidden' || cs.textOverflow !== 'ellipsis') {
        out.push(`value statement ${i + 1}: truncation styles not applied (${cs.whiteSpace}/${cs.overflow}/${cs.textOverflow})`);
      }
      if (el.getBoundingClientRect().right > el.parentElement.getBoundingClientRect().right + 1) {
        out.push(`value statement ${i + 1}: paints outside its cell`);
      }
    });
    // (Bar fill variance is covered statically via the bound --fill values.)
    return out;
  });
  for (const f of runtime) { console.log(`FAIL [runtime:layout] ${f}`); failures++; }

  // 4) The toggle actually flips every surface (page background changes).
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('.theme-toggle');
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (bgLight === bgDark) { console.log('FAIL [runtime:themes] the theme toggle does not change the page background'); failures++; }

  if (screensAt) {
    mkdirSync(resolve(screensAt), { recursive: true });
    // dark list first (we are in dark after the flip), then back to light, then detail.
    await page.screenshot({ path: resolve(screensAt, 'list-dark.png'), fullPage: true });
    await page.click('.theme-toggle');
    await page.screenshot({ path: resolve(screensAt, 'list-light.png'), fullPage: true });
    const detailName = await page.evaluate(() => document.querySelector('section[data-kind="detail"]')?.dataset.screen || null);
    if (detailName) {
      await page.evaluate((n) => window.showScreen ? window.showScreen(n) : null, detailName);
      await page.screenshot({ path: resolve(screensAt, 'detail-light.png'), fullPage: true });
    }
    console.log(`screens written to ${resolve(screensAt)}`);
  }
  console.log(`runtime checks: ${failures ? `${failures} total failure(s)` : 'ALL PASS'}`);
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
