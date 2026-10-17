// Real app, providers, API client and Framework versions page; only HTTP responses
// are fixtures. The Live guidance card: shows the active guidance and the last
// check, toggles the live_guidance setting through the API (with CSRF), and fits
// 360–1920 px without horizontal overflow or small touch targets.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const user = { id: 'browser-admin', username: 'admin', role: 'admin', permissions: [] };
const now = new Date().toISOString();
const version = { id: 7, version: 7, changelog: 'Live guidance — Mock2 1.23.3 from https://mock2.fractionate.ai', reverted_from_version: null, source: 'git_sync', source_git_commit: 'mock2-core@1.23.3', created_by: 1, created_at: now };
let live = { setting: 'on', status: { enabled: true, active_origin: 'site', active_version: '1.23.3', active_site: 'https://mock2.fractionate.ai', last_check_at: '2026-10-18T06:00:00.000Z', last_result: 'updated', last_error: null } };
const writes = [];
const server = await createServer({ root, configFile: root + '/vite.config.js', server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'framework-live-guidance-fixture',
  configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith('/api/')) return next();
      const url = new URL(req.url, 'http://test');
      let value = {}; let status = 200;
      if (req.method === 'POST' && url.pathname === '/api/mock2/settings/live-guidance') {
        let raw = ''; for await (const part of req) raw += part;
        const body = JSON.parse(raw);
        writes.push({ body, csrf: req.headers['x-csrf-token'] });
        live = { setting: body.setting, status: { ...live.status, enabled: body.setting === 'on' } };
        value = live;
      } else if (url.pathname === '/api/auth/verify') value = { user };
      else if (url.pathname === '/api/mock2/status') value = { enabled: true };
      else if (url.pathname === '/api/mock2/framework/versions') value = { versions: [version] };
      else if (url.pathname === '/api/mock2/framework/current') value = { version: { ...version, constitution_md: '# c', skills_json: '[]', gates_json: '[]', design_system_md: '# d', project_template_ref: 'builtin' } };
      else if (url.pathname === '/api/mock2/settings/framework-auto-adopt') value = { setting: 'on' };
      else if (url.pathname === '/api/mock2/settings/live-guidance') value = live;
      else if (url.pathname === '/api/user/version') value = { version: 'browser-test' };
      else if (url.pathname === '/api/user/version/check') value = { updateAvailable: false };
      else if (url.pathname === '/api/notifications') value = { notifications: [], unread_count: 0 };
      else if (req.method !== 'GET') { status = 404; value = { error: 'Unexpected test mutation' }; }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'pp_csrf=browser-csrf; Path=/' });
      res.end(JSON.stringify(value));
    });
  },
}] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE, args: process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [], headless: true });
const artifacts = process.env.BROWSER_ARTIFACTS;
if (artifacts) mkdirSync(artifacts, { recursive: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(({ user }) => { localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('mock2HintDismissed', '1'); }, { user });
  await page.goto(origin + '/projects/framework');
  await page.getByText('Live guidance', { exact: true }).waitFor();
  await page.getByText(/Active: Mock2 1\.23\.3 \(standards site\)/).waitFor();
  await page.getByText(/last check 2026-10-18 06:00 updated/).waitFor();
  // Two switches on the page, in order: Automatic adoption, then Live guidance.
  assert.equal(await page.getByRole('switch').count(), 2);
  const toggle = page.getByRole('switch').nth(1);
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await page.addStyleTag({ content: 'html,body,main>div {overflow-x:visible !important}' });
  async function widthCheck(width, label) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('main').evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
    const overflow = await page.locator('main').evaluate((e) => [document.documentElement, e, ...e.querySelectorAll('div')].filter((n) => n.clientWidth && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'hidden').map((n) => ({ tag: n.tagName, cls: n.className, width: n.clientWidth, scroll: n.scrollWidth })));
    assert.deepEqual(overflow, [], `${label} overflow at ${width}`);
    if (width < 640) {
      const box = await toggle.boundingBox();
      assert(box.height >= 44 && box.width >= 44, 'Live guidance switch is a small touch target');
    }
    if (artifacts) await page.screenshot({ path: `${artifacts}/live-guidance-${label}-${width}.png`, fullPage: true });
  }
  for (const width of [360, 375, 390, 768, 1280, 1920]) await widthCheck(width, 'on');
  await page.setViewportSize({ width: 375, height: 812 });
  await toggle.click();
  await page.getByText('Live guidance off', { exact: true }).first().waitFor();
  assert.deepEqual(writes.at(-1), { body: { setting: 'off' }, csrf: 'browser-csrf' });
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await widthCheck(360, 'off');
  assert.deepEqual(errors, []);
  console.log('Framework versions: Live guidance card shows the active guidance, toggles the setting, and fits 360–1920 px.');
} finally {
  await browser.close(); await server.close();
}
