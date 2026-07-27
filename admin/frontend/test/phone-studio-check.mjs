// Drive the REAL built ProxyPilot SPA at phone width and prove the panel bar is
// on the Details page — in BOTH stages. Operator report: "the mobile flightdeck
// navbar is not showing on the details page".
import { chromium } from '/tmp/pp-wired/node_modules/playwright-core/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4599';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const fails = [];

const page = await (await b.newContext({
  serviceWorkers: 'block', viewport: { width: 390, height: 780 },
})).newPage();
page.on('pageerror', (e) => console.log('   [pageerror]', String(e).split('\n')[0].slice(0, 160)));

await page.goto(`${BASE}/projects/7`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// The workspace's own bottom bar, to prove the page rendered as a phone studio.
const bar = () => page.locator('.grid.border-t');
const barLabels = async () => {
  const n = await bar().count();
  if (!n) return null;
  return (await bar().first().innerText()).split('\n').map((s) => s.trim()).filter(Boolean);
};

// The assets modal blocks the page on a fresh project — on a PHONE too, which
// is the thing to prove. Radix makes the rest of the page inert while it is up,
// so it must be answered before anything else can be driven.
const modal = page.getByRole('dialog');
const modalUp = await modal.isVisible().catch(() => false);
console.log('assets modal on mobile:', modalUp);
if (process.env.EXPECT_MODAL === '1') {
  if (!modalUp) fails.push('assets modal did not show on mobile');
  else {
    const title = await modal.innerText();
    if (!/load logos, assets, or context/i.test(title)) fails.push('modal is not the assets question');
    // Both answers must be reachable at 390px.
    for (const name of [/Not now/i, /Add assets|Add more/i]) {
      const btn = modal.getByRole('button', { name });
      if (!(await btn.isVisible().catch(() => false))) fails.push(`modal button missing: ${name}`);
      else {
        const h = Math.round((await btn.boundingBox())?.height || 0);
        if (h < 44) fails.push(`modal button under 44px: ${name} = ${h}`);
      }
    }
    const spill = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (spill) fails.push('modal causes horizontal scroll');
  }
}
// The whole "yes" path: the question opens the LIBRARY over the chat, and
// "Add to chat" hands back to the composer. Pointing at a panel behind the
// modal makes the operator go find it — on a phone that panel is a different
// screen entirely.
if (modalUp && process.env.EXPECT_MODAL === '1') {
  await modal.getByRole('button', { name: /Add assets|Add more/i }).click();
  await page.waitForTimeout(800);
  const lib = page.getByRole('dialog');
  const libText = await lib.innerText().catch(() => '');
  if (!/Logos, assets and context/i.test(libText)) fails.push('the library did not open over the chat');
  const addToChat = lib.getByRole('button', { name: /Add to chat/i });
  if (!(await addToChat.isVisible().catch(() => false))) fails.push('no "Add to chat" way out of the library');
  else {
    const h = Math.round((await addToChat.boundingBox())?.height || 0);
    if (h < 44) fails.push(`"Add to chat" under 44px: ${h}`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) {
      fails.push('the library modal scrolls sideways');
    }
    await addToChat.click();
    await page.waitForTimeout(800);
    if (await page.getByRole('dialog').isVisible().catch(() => false)) fails.push('"Add to chat" did not close the library');
    // The cursor must land where the prompt goes — that is the whole reason to
    // come back from the library.
    const focused = await page.evaluate(() => document.activeElement?.tagName || '');
    if (focused !== 'TEXTAREA') fails.push(`focus went to ${focused || 'nothing'}, not the composer`);
  }
  console.log('assets library flow: opened, added, handed back to the composer');
} else if (modalUp) {
  await modal.getByRole('button', { name: /Not now/i }).click();
  await page.waitForTimeout(600);
}

console.log('workspace bar:', JSON.stringify(await barLabels()));
if (!(await barLabels() || []).includes('Details')) fails.push('workspace bar missing');

// Tap Details, exactly as the operator does.
await page.getByRole('button', { name: 'Project details' }).click();
await page.waitForTimeout(1200);

const after = await barLabels();
console.log('details bar:  ', JSON.stringify(after));

const onDetails = await page.locator('text=Live URL').count();
console.log('on the details page:', onDetails > 0);
if (!onDetails) fails.push('did not reach details');
if (!after || !after.includes('Preview')) fails.push('panel bar missing on details');

// It must be ON SCREEN at the bottom, not below the fold.
const geom = await page.evaluate(() => {
  const el = document.querySelector('.grid.border-t');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, onScreen: r.bottom <= window.innerHeight + 1 && r.top < window.innerHeight };
});
console.log('bar geometry: ', JSON.stringify(geom));
if (!geom?.onScreen) fails.push('bar not on screen');

// And it must take you back.
if (after?.includes('Preview')) {
  await page.getByRole('button', { name: /^Preview$/ }).click();
  await page.waitForTimeout(1200);
  const backOnDetails = await page.locator('text=Live URL').count();
  console.log('tapping Preview leaves details:', backOnDetails === 0);
  if (backOnDetails > 0) fails.push('bar does not navigate back');
}

// No sideways scroll anywhere in this flow.
const h = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
console.log('horizontal:  ', JSON.stringify(h));
if (h.sw > h.cw) fails.push(`horizontal scroll ${h.sw}>${h.cw}`);

await b.close();
console.log(fails.length ? `\nFAIL — ${fails.join(', ')}` : '\nPASS');
process.exit(fails.length ? 1 : 0);
