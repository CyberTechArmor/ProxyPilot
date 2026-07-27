// The reported flash: the assets modal appears for half a second and vanishes.
// Watches for a WHILE rather than sampling once — a check that looks immediately
// cannot see something that disappears a beat later, which is why the first
// version of this passed on a broken build.
import { chromium } from '/tmp/pp-wired/node_modules/playwright-core/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4599';
const WIDTH = Number(process.env.WIDTH || 390);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: WIDTH, height: 780 } })).newPage();
await p.goto(`${BASE}/projects/7`, { waitUntil: 'domcontentloaded' });

// Sample every 250ms for 6s: appeared-then-vanished is the failure, and it is
// invisible to a single check at either end.
const seen = [];
for (let i = 0; i < 24; i++) {
  await p.waitForTimeout(250);
  seen.push(await p.getByRole('dialog').isVisible().catch(() => false));
}
const appeared = seen.some(Boolean);
const atEnd = seen.slice(-4).every(Boolean);
const flashed = appeared && !atEnd;
console.log(`${WIDTH}px MESSAGES=${process.env.MESSAGES || 'none'} → appeared:${appeared} stillUp:${atEnd} flashed:${flashed}`);
console.log('  timeline:', seen.map((v) => (v ? '#' : '.')).join(''));
await b.close();

const expect = process.env.EXPECT || 'stays';
const ok = expect === 'stays' ? (appeared && atEnd && !flashed) : (!appeared);
console.log(ok ? 'PASS' : `FAIL — expected the modal to ${expect === 'stays' ? 'stay up' : 'never appear'}`);
process.exit(ok ? 0 : 1);
