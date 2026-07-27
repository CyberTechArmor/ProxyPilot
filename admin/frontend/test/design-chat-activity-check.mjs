// The design chat must narrate and follow like the build chat does.
//
// Operator report: during a two-to-five minute mockup render the design stage
// showed ONE muted line that each phase overwrote, and nothing followed the
// growing reply — so the thing being read scrolled out from under the reader.
//
// This drives a live turn whose narration advances and whose reply grows, then
// asserts the two behaviours that were missing:
//   1. the work is shown as an accumulating timeline, not a single line
//   2. the view follows the newest content — unless the reader scrolled up,
//      which must pause it, and returning to the bottom must resume it.
//
// RUN IT AGAINST A FRESH HARNESS. The harness advances its narration on every
// chat poll, and that counter is per PROCESS — reusing one across runs starts
// the second run past the phases this looks for, which reads as a failure of
// the app rather than of the fixture:
//
//   fuser -k 4599/tcp; node test/ui-harness.mjs &   # STAGE=design JOB=live
//   node test/design-chat-activity-check.mjs
import { chromium } from '/tmp/pp-wired/node_modules/playwright-core/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4599';
const WIDTH = Number(process.env.WIDTH || 390);
const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); return ok; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: WIDTH, height: 780 } })).newPage();
await p.goto(`${BASE}/projects/7`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

// Dismiss the assets question if it is up — it is not what this checks.
const modal = p.getByRole('dialog');
if (await modal.isVisible().catch(() => false)) {
  await modal.getByRole('button', { name: /Not now/i }).click();
  await p.waitForTimeout(500);
}

// 1) The timeline. "Working" is its header; the rows are the phases.
await p.waitForTimeout(4000);
const stream = p.locator('ol').filter({ hasText: /Designing the mockup|Thinking|Writing/ }).first();
const rows = await stream.locator('li').count().catch(() => 0);
const text = await stream.innerText().catch(() => '');
console.log(`timeline rows: ${rows}`);
console.log(`timeline text: ${JSON.stringify(text.replace(/\n/g, ' | ').slice(0, 200))}`);
check(rows >= 2, `expected an accumulating timeline, got ${rows} row(s)`);
// Distinct PHASES stack; a refreshed character count must replace its line
// rather than print a near-identical row every poll.
const designingRows = (text.match(/Designing the mockup/g) || []).length;
check(designingRows <= 1, `the growing character count printed ${designingRows} rows instead of refreshing one`);

// The scroll box is the chat's own, not the page. Resolve it defensively: with
// no timeline there is nothing to filter by, and a crash here would hide WHY —
// which is exactly the state this check exists to describe.
const box = rows
  ? p.locator('.overflow-y-auto').filter({ has: stream }).first()
  : p.locator('.overflow-y-auto').first();
const haveBox = await box.count().then((n) => n > 0).catch(() => false);
check(haveBox, 'no scrollable chat box found');
const atBottom = () => (haveBox
  ? box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60).catch(() => false)
  : Promise.resolve(false));

// 2) It follows the newest content while the turn runs.
await p.waitForTimeout(3000);
const following = await atBottom().catch(() => false);
console.log('follows the newest content:', following);
check(following, 'the chat did not stay with the newest content while the turn ran');

// 3) Scrolling up to READ must pause it — a chat that yanks you back is worse
//    than one that never followed.
if (haveBox) {
  await box.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
  });
}
await p.waitForTimeout(3500);
const stayedPut = haveBox ? await box.evaluate((el) => el.scrollTop < 120) : false;
console.log('stays put while reading:', stayedPut);
check(stayedPut, 'scrolling up to read was overridden — the chat fought the reader');

// 4) Returning to the bottom must re-arm it.
if (haveBox) {
  await box.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}
await p.waitForTimeout(3500);
const resumed = await atBottom().catch(() => false);
console.log('resumes when you come back:', resumed);
check(resumed, 'returning to the bottom did not re-arm following');

// Nothing may scroll sideways at phone width.
const h = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
check(h.sw <= h.cw, `horizontal scroll ${h.sw}>${h.cw}`);

await b.close();
console.log(fails.length ? `\nFAIL — ${fails.join('; ')}` : '\nPASS');
process.exit(fails.length ? 1 : 0);
