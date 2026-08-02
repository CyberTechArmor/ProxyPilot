// Mock2 mockup screenshots — render the CURRENT mockup HTML in the same
// headless chromium the smoke/design-review passes use and photograph it, so
// the design stage can LOOK at what the Builder is looking at.
//
// Deliberately independent of the design_review setting: that switch governs
// the after-BUILD critique pass, and the operator keeps it off while still
// wanting the DESIGN conversation to see its own render — it is how "the
// sidebar icons are huge" needs no further explanation, and how layout
// breakage that clean-looking HTML hides (overlaps, clipped labels, oversized
// glyphs) becomes visible to the model that is about to revise it.
//
// Bounded and fail-open everywhere: a missing browser, a hung render, or a
// crashed page returns [] and the design turn proceeds exactly as before —
// looking at the mockup must never cost the conversation.
//
// Terminology (risk R7): nothing here is named "agent".

import { loadChromium, launchOptions } from './ui-checks.js';

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 780 };
const SETTLE_MS = 500;          // let fonts/first paint land after DOMContentLoaded
const CONTENT_TIMEOUT_MS = 10000;
const TOTAL_BUDGET_MS = 25000;  // hard ceiling for the whole capture

// captureMockupShots(html) → [{ media_type, data (base64 JPEG), width }].
// Desktop first (it is the register mockups are mostly judged in), then
// mobile. The mockup is a self-contained document (inline styles, no external
// assets — its own render contract), so page.setContent needs no network.
export async function captureMockupShots(html, { viewports = [DESKTOP, MOBILE], quality = 70 } = {}) {
  const doc = String(html || '');
  if (!doc.trim()) return [];
  const chromium = await loadChromium();
  if (!chromium) return [];
  let browser = null;
  const work = (async () => {
    browser = await chromium.launch(launchOptions());
    const shots = [];
    for (const vp of viewports) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      try {
        await page.setContent(doc, { waitUntil: 'domcontentloaded', timeout: CONTENT_TIMEOUT_MS });
        await page.waitForTimeout(SETTLE_MS);
        const buf = await page.screenshot({ type: 'jpeg', quality, fullPage: false });
        shots.push({ media_type: 'image/jpeg', data: buf.toString('base64'), width: vp.width });
      } catch (e) {
        // One viewport failing must not lose the other's shot.
        console.warn(`[mock2] mockup shot at ${vp.width}px failed:`, e?.message);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    return shots;
  })();
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => setTimeout(() => reject(new Error('mockup screenshot timed out')), TOTAL_BUDGET_MS)),
    ]);
  } catch (e) {
    console.warn('[mock2] mockup screenshot failed:', e?.message);
    return [];
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
  }
}
