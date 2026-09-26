import { validateBrowserAction } from './operational-worker-boundary.js';

// A second, browser-level restriction. The selected worker host must separately
// deny egress at the OS boundary; Playwright routing alone is not that boundary.
export const SYNTHETIC_ORIGIN = 'https://demo.fractionate.ai';
const PATHS = new Set(['/', '/workspace', '/api/config', '/api/session', '/api/files']);
const ASSET = /^\/assets\/[a-zA-Z0-9_.-]+$/;
const fail = code => { const error = new Error(code); error.code = code; throw error; };

export function permitsSyntheticRequest(rawUrl, method) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.origin !== SYNTHETIC_ORIGIN || url.username || url.password ||
      url.search || url.hash) return false;
  if (method === 'GET') return PATHS.has(url.pathname) || ASSET.test(url.pathname);
  // Login remains A4-only: A3 has no credential broker or submission authority.
  if (method === 'POST') return url.pathname === '/api/logout';
  return false;
}

async function fixedJson(page, path) {
  return page.evaluate(async fixedPath => {
    const response = await fetch(fixedPath, {method:'GET',credentials:'same-origin',redirect:'manual',cache:'no-store'});
    if (!response.ok || response.type === 'opaqueredirect' ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      throw new Error('BROWSER_READBACK_FAILED');
    return response.json();
  }, path);
}

export async function createSyntheticSignInBrowserBroker({browser, reserveAction}) {
  if (typeof browser?.newContext !== 'function' || typeof reserveAction !== 'function')
    fail('BROWSER_BOUNDARY_UNAVAILABLE');
  const context = await browser.newContext({acceptDownloads:false,serviceWorkers:'block'});
  let page, busy = false, closed = false, actions = 0, closePromise;
  const deadline = Date.now() + 300_000;
  const shutdown = () => {
    clearTimeout(timer);
    if (!closePromise) { closed = true; closePromise = context.close(); }
    return closePromise;
  };
  const timer = setTimeout(() => { void shutdown().catch(() => {}); }, 300_000);
  try {
    if (typeof context.route !== 'function' || typeof context.routeWebSocket !== 'function' ||
        typeof context.newPage !== 'function') fail('BROWSER_BOUNDARY_UNAVAILABLE');
    await context.route('**/*', route => permitsSyntheticRequest(route.request().url(), route.request().method())
      ? route.fallback() : route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', socket => socket.close());
    context.on('page', candidate => { if (page && candidate !== page) void candidate.close(); });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(10_000);
  } catch (error) {
    await shutdown();
    throw error;
  }
  return {
    async perform(request) {
      validateBrowserAction(request);
      if (closed) fail('BROWSER_CLOSED');
      if (busy) fail('BROWSER_BUSY');
      if (Date.now() >= deadline) fail('BROWSER_DEADLINE');
      if (actions >= 20) fail('ACTION_LIMIT');
      if (request.action === 'submit_bound_fixture') fail('CREDENTIAL_BROKER_UNAVAILABLE');
      busy = true;
      try {
        await reserveAction(request);
        if (closed || Date.now() >= deadline) fail('BROWSER_DEADLINE');
        actions++;
        switch (request.action) {
          case 'open_landing': {
            const response = await page.goto(`${SYNTHETIC_ORIGIN}/`, {waitUntil:'domcontentloaded'});
            if (!response?.ok() || page.url() !== `${SYNTHETIC_ORIGIN}/`) fail('BROWSER_NAVIGATION_FAILED');
            return {at:'landing'};
          }
          case 'open_login':
            await page.getByRole('button', {name:'Sign in'}).first().click();
            await page.getByRole('dialog', {name:'Sign in to your workspace'}).waitFor();
            return {at:'login_dialog'};
          case 'read_workspace': {
            const response = await page.goto(`${SYNTHETIC_ORIGIN}/workspace`, {waitUntil:'domcontentloaded'});
            if (!response?.ok() || page.url() !== `${SYNTHETIC_ORIGIN}/workspace`) fail('BROWSER_NAVIGATION_FAILED');
            return {at:'workspace'};
          }
          case 'read_session': {
            const data = await fixedJson(page, '/api/session');
            return {untrusted_page_claim_authenticated:data?.authenticated === true && data?.email === 'demo@fractionate.ai'};
          }
          case 'read_files': {
            const data = await fixedJson(page, '/api/files');
            return {untrusted_page_claim_sample_present:Array.isArray(data?.files) && data.files.some(file =>
              file?.id === 'sample-metrics' && file?.name === 'sample-metrics.csv')};
          }
          case 'sign_out':
            await page.getByRole('button', {name:'Sign out'}).click();
            return {untrusted_page_claim_signed_out:(await fixedJson(page, '/api/session'))?.authenticated === false};
          default:
            fail('INVALID_BROWSER_ACTION');
        }
      } finally { busy = false; }
    },
    async close() { await shutdown(); },
  };
}
