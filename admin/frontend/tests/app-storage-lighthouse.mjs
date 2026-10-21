// Lighthouse accessibility (its default mobile emulation) on the Application
// storage pages, against the real app with the fixture API of
// app-storage-harness.mjs served by a vite middleware (Lighthouse opens its own
// tab, so page.route would not reach it). Lighthouse is not a project
// dependency; install it anywhere and pass the directory. Run from admin/frontend:
//   npm install --prefix /tmp/lh lighthouse@12 && node tests/app-storage-lighthouse.mjs /tmp/lh
// Exits 1 when a page scores under MIN.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { createWorld, USER } from './app-storage-harness.mjs';

const LH = process.argv[2];
if (!LH) throw new Error('Pass the directory where lighthouse is installed');
const MIN = 90;
const PORT = 9334;
const { default: lighthouse } = await import(join(LH, 'node_modules/lighthouse/core/index.js'));
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const world = createWorld();
const server = await createServer({
  root, configFile: `${root}/vite.config.js`, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'app-storage-fixture-api',
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith('/api/')) return next();
        let raw = '';
        for await (const part of req) raw += part;
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        const out = world.handle(req.method, req.url, body, req.headers);
        res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out.body));
      });
    },
  }],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'pp-app-storage-lighthouse-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium',
  headless: true, viewport: { width: 1280, height: 800 }, args: [`--remote-debugging-port=${PORT}`, '--no-proxy-server'],
});
const results = {};
try {
  await ctx.addCookies([{ name: 'pp_csrf', value: 'storage-csrf', url: origin }]);
  const page = await ctx.newPage();
  await page.goto(`${origin}/login`);
  await page.evaluate((user) => { localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('mock2HintDismissed', '1'); }, USER);
  const pages = {
    overview: `${origin}/storage/applications`,
    detail: `${origin}/storage/applications?target=application:1`,
    rules: `${origin}/storage/applications?target=application:1&tab=rules`,
    'past-cleanups': `${origin}/storage/applications?target=application:1&tab=history`,
  };
  for (const [name, url] of Object.entries(pages)) {
    const { lhr } = await lighthouse(url, { port: PORT, onlyCategories: ['accessibility'], output: 'json', logLevel: 'error' });
    if (new URL(lhr.finalDisplayedUrl).pathname !== new URL(url).pathname) throw new Error(`${name}: landed on ${lhr.finalDisplayedUrl}`);
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
console.log(JSON.stringify({ app_storage_lighthouse_accessibility: low.length ? 'failed' : 'passed', min: MIN, pages: Object.keys(results).length }));
if (low.length) process.exitCode = 1;
