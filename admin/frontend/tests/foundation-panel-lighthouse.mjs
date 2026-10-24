// Lighthouse accessibility (its default mobile emulation) on the application
// foundation panel fixture, with the mocked API of foundation-panel-harness.mjs
// served by a vite middleware (Lighthouse opens its own tab, so page.route
// would not reach it). `?case=` on the page URL picks the API state. Lighthouse
// is not a project dependency; install it anywhere and pass the directory. Run
// from admin/frontend:
//   npm install --prefix /tmp/lh lighthouse@12 && node tests/foundation-panel-lighthouse.mjs /tmp/lh
// Exits 1 when a state scores under MIN (MOBILE_FIRST pre-merge checklist: 90).
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createWorld } from './foundation-panel-harness.mjs';

const LH = process.argv[2];
if (!LH) throw new Error('Pass the directory where lighthouse is installed');
const MIN = 90;
const PORT = 9335;
const { default: lighthouse } = await import(join(LH, 'node_modules/lighthouse/core/index.js'));
async function loadChromium() {
  if (process.env.PLAYWRIGHT_CORE) return (await import(process.env.PLAYWRIGHT_CORE)).chromium;
  try { return (await import('../../backend/node_modules/playwright-core/index.mjs')).chromium; } catch { /* not installed */ }
  return createRequire(import.meta.url)('playwright').chromium;
}
const chromium = await loadChromium();
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Application foundation</title></head><body><div id="root"></div><script type="module" src="/tests/foundation-panel-fixture.jsx"></script></body></html>';
let world = createWorld('default');
const server = await createServer({
  root, configFile: `${root}/vite.config.js`, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'foundation-fixture',
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url.startsWith('/foundation-test')) {
          const q = new URL(req.url, 'http://x').searchParams;
          world = createWorld(q.get('case') || 'default', { advanceJobs: false });
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(await vite.transformIndexHtml(req.url, PAGE));
          return;
        }
        if (!req.url.startsWith('/api/')) return next();
        let raw = '';
        for await (const part of req) raw += part;
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        const out = world.handle(req.method, req.url, body);
        res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out.body));
      });
    },
  }],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'pp-foundation-lighthouse-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.BROWSER_EXE || undefined,
  headless: true, viewport: { width: 1280, height: 800 }, args: [`--remote-debugging-port=${PORT}`, '--no-proxy-server'],
});
const results = {};
try {
  const pages = {
    default: '?case=default',
    missing_credentials: '?case=missing_credentials',
    job_running: '?case=job_running',
    storage_off: '?case=storage_off',
    viewer: '?case=external&viewer=1',
    legacy: '?case=legacy',
  };
  for (const [name, q] of Object.entries(pages)) {
    const url = `${origin}/foundation-test${q}`;
    const { lhr } = await lighthouse(url, { port: PORT, onlyCategories: ['accessibility'], output: 'json', logLevel: 'error' });
    results[name] = {
      score: Math.round(lhr.categories.accessibility.score * 100), form_factor: lhr.configSettings.formFactor,
      failing: Object.values(lhr.audits).filter((a) => a.score === 0 && a.scoreDisplayMode === 'binary').map((a) => a.id),
      nodes: Object.values(lhr.audits).filter((a) => a.score === 0 && a.scoreDisplayMode === 'binary')
        .flatMap((a) => (a.details?.items || []).map((i) => `${a.id}: ${i.node?.snippet?.slice(0, 160)} ${i.node?.explanation?.split('\n')[1]?.trim() || ''}`)),
    };
    console.log(name, JSON.stringify(results[name]));
  }
} finally {
  await ctx.close();
  await server.close();
  rmSync(profile, { recursive: true, force: true });
}
const low = Object.entries(results).filter(([, r]) => r.score < MIN).map(([name]) => name);
console.log(JSON.stringify({ foundation_panel_lighthouse_accessibility: low.length ? 'failed' : 'passed', min: MIN, pages: Object.keys(results).length }));
if (low.length) process.exitCode = 1;
