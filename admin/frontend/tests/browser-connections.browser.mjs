// Fixture evidence only: actual component/central cookie+CSRF API client,
// scripted metadata responses. No production host, credential or website use.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.BROWSER_ARTIFACTS || '/tmp/proxypilot-browser-connections';
mkdirSync(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
// Aborted intercepted requests may fall through during context shutdown.
// Keep them local and fail explicitly instead of reaching Vite's app proxy.
server.middlewares.stack.unshift({ route: '/api', handle: (_req, res) => { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Unintercepted fixture request' })); } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/tmp/chromium', headless: true, args: ['--no-sandbox'] });
const caps = { metadata_available: true, enrollment_available: false, execution_available: false, oauth_authorization_available: false };
const pid = 'e4b21c1e-2137-478b-a1af-c33438e8e000', cid = 'e4b21c1e-2137-478b-a1af-c33438e8e001';
const user = { id: 'e4b21c1e-2137-478b-a1af-c33438e8e002', role: 'user', username: 'fixture' };
const report = { provenance: 'Scripted metadata fixture; not deployed or real-provider evidence', journeys: [], widths: [], axe: [] };
async function fixture(width = 1280, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 640 : 1000 } });
  await context.addCookies([{ name: 'pp_csrf', value: 'fixture-csrf', url: origin }]);
  await context.addInitScript(value => localStorage.setItem('user', JSON.stringify(value)), user);
  const page = await context.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  const state = { rows: [], calls: [], conflict: false, deny: null, unavailable: null, delay: null, history: [], changedUser: false };
  await page.route('**/api/**', async route => {
    const req = route.request(), method = req.method(), path = new URL(req.url()).pathname;
    state.calls.push({ method, path, headers: req.headers(), body: req.postDataJSON() });
    if (path === '/api/auth/verify') return route.fulfill({ json: { user } });
    if (path === '/api/auth/login') { state.changedUser = true; return route.fulfill({ json: { user: { ...user, id: 'second-fixture' } } }); }
    if (state.delay && method !== 'GET') await state.delay;
    if (state.deny) return route.fulfill({ status: state.deny, json: { error: 'Permission refused' } });
    if (state.unavailable) return route.fulfill({ status: state.unavailable, json: { error: 'Retired' } });
    if (path.endsWith('/capabilities')) return route.fulfill({ json: caps });
    if (method !== 'GET' && state.conflict) return route.fulfill({ status: 409, json: { error: 'Revision changed' } });
    if (method === 'POST' && path.endsWith('/browser-connections')) {
      const body = req.postDataJSON();
      const record = { ...body, id: cid, revision: 1, version: 1, status: 'draft', own_rights: ['view_metadata', 'manage_metadata'] };
      state.rows = [record]; state.history = [{ ...record, saved_at: '2026-10-04T11:00:00.000Z' }];
      return route.fulfill({ status: 201, json: { connection: record } });
    }
    if (method === 'PATCH') {
      const record = { ...state.rows[0], ...req.postDataJSON(), revision: state.rows[0].revision + 1, version: state.rows[0].version + 1 };
      state.rows = [record]; state.history.unshift({ ...record, saved_at: '2026-10-04T11:01:00.000Z' });
      return route.fulfill({ json: { connection: record } });
    }
    if (path.endsWith('/revoke')) { state.rows[0] = { ...state.rows[0], revision: state.rows[0].revision + 1, status: 'revoked' }; return route.fulfill({ json: { connection: state.rows[0] } }); }
    if (path.endsWith('/versions')) return route.fulfill({ json: { versions: state.history, next_cursor: null } });
    if (path.endsWith(cid)) return route.fulfill({ json: { connection: state.rows[0] } });
    if (path.endsWith(pid)) return route.fulfill({ json: { project: { id: pid, revision: 8, own_role: 'owner' } } });
    return route.fulfill({ json: { connections: state.changedUser ? [] : state.rows, next_cursor: null } });
  });
  await page.goto(`${origin}/tests/browser-connections-fixture.html`);
  await page.getByRole('button', { name: 'Add connection', exact: true }).waitFor();
  await page.waitForFunction(() => !document.body.textContent.includes('Loading connection plans…'));
  return { context, page, state };
}
async function add(page, name = 'Acme Finance — invoice access') {
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill(name);
  await page.getByLabel('Service address', { exact: true }).fill('https://billing.example');
  await page.getByLabel('Account label', { exact: true }).fill('Finance account');
}
async function checkLayout(page, width) {
  await page.addStyleTag({ content: 'html,body{overflow-x:visible!important}' });
  const dialog = page.getByRole('dialog');
  await dialog.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  const box = await dialog.boundingBox();
  assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `dialog fits ${width}`);
  assert.equal(Math.round(box.width), width < 640 ? width : 600);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  const buttons = await dialog.getByRole('button').all();
  for (const button of buttons) { const size = await button.boundingBox(); assert.ok(size.height >= (width < 640 ? 44 : 36), 'modal action targets'); }
  await dialog.evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: `${output}/connection-dialog-top-${width}.png` });
  await page.getByRole('button', { name: 'Save connection plan' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/connection-dialog-${width}.png` });
  await page.addScriptTag({ content: readFileSync(new URL('../../backend/node_modules/axe-core/axe.min.js', import.meta.url), 'utf8') });
  const axe = await page.evaluate(async () => { const result = await window.axe.run(document.querySelector('[role=dialog]')); return result.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })); });
  report.axe.push({ width, violations: axe }); assert.deepEqual(axe, [], 'dialog axe violations');
  report.widths.push({ width, dialog: box, overflow: false });
}
try {
  for (const width of [360, 375, 390, 768, 1280, 1920]) {
    const { context, page, state } = await fixture(width);
    await add(page); await checkLayout(page, width);
    await page.getByRole('button', { name: 'Save connection plan' }).click();
    await page.getByText('Connection plan saved. No sign-in, OAuth authorization or assignment was created.', { exact: true }).waitFor();
    assert.equal(state.rows.length, 1); assert.equal(state.calls.find(c => c.method === 'POST').headers['if-match'], '"7"');
    assert.equal(state.calls.find(c => c.method === 'POST').headers['x-csrf-token'], 'fixture-csrf');
    assert.deepEqual(Object.keys(state.calls.find(c => c.method === 'POST').body).sort(), ['account_hint', 'kind', 'name', 'origin']);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Connection name', { exact: true }).fill('Retained local edit'); state.conflict = true;
    await page.getByRole('button', { name: 'Save connection plan' }).click(); await page.getByRole('alert').filter({ hasText: 'Your edits are retained' }).waitFor();
    assert.equal(await page.getByLabel('Connection name', { exact: true }).inputValue(), 'Retained local edit');
    assert.equal(await page.getByRole('button', { name: 'Save connection plan' }).isDisabled(), true);
    state.conflict = false; state.rows[0].revision = 2;
    await page.getByRole('button', { name: 'Refresh revision for review' }).click();
    await page.getByRole('alert').filter({ hasText: 'Current revision refreshed' }).waitFor();
    assert.equal(await page.getByLabel('Connection name', { exact: true }).inputValue(), 'Retained local edit');
    await page.getByRole('button', { name: 'Save connection plan' }).click(); await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByText('Retained metadata versions', { exact: true }).waitFor(); assert.equal(state.history.length, 2);
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Revoke plan', exact: true }).click();
    await page.getByText('Plan revoked. Historical metadata versions are retained.', { exact: true }).waitFor(); assert.equal(state.history.length, 2); assert.equal(state.rows[0].status, 'revoked');
    assert.deepEqual(page.errors, []); await context.close();
  }
  report.journeys.push('Six-width completion: create/edit/stale revision/explicit reconciliation/history/revoke; whitelist and central CSRF');
  {
    const { context, page, state } = await fixture(); await add(page);
    const field = page.getByLabel('Connection name', { exact: true }); await field.focus();
    for (let i = 0; i < 16; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true, 'focus stays in dialog'); }
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    // Radix schedules close autofocus after unmount; hidden alone precedes it.
    const opener = await page.getByRole('button', { name: 'Add connection', exact: true }).elementHandle();
    await page.waitForFunction(button => document.activeElement === button, opener, { timeout: 5000 });
    assert.equal(await page.getByRole('button', { name: 'Add connection', exact: true }).evaluate(el => document.activeElement === el), true, 'focus returns to opener');
    assert.equal(state.calls.filter(c => c.method !== 'GET').length, 0);
    await add(page, 'Role loss canary'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Fixture: change role' }).click(); await page.waitForFunction(() => !document.body.textContent.includes('Loading connection plans…'));
    assert.equal(await page.getByRole('button', { name: 'Add connection', exact: true }).isDisabled(), true); await context.close();
  }
  report.journeys.push('Keyboard trap/Escape/focus return/cancel creates no record/current role create refusal');
  {
    const { context, page, state } = await fixture(); await add(page, 'PRIVATE_OLD_IDENTITY');
    let release; state.delay = new Promise(resolve => { release = resolve; });
    await page.getByRole('button', { name: 'Save connection plan' }).click();
    await page.waitForFunction(() => document.body.textContent.includes('Saving…'));
    // The fixture changes AuthContext during an outstanding response. This is
    // deliberately below the modal; it is not a production browser gesture.
    await page.getByRole('button', { name: 'Fixture: change identity', includeHidden: true }).evaluate(el => el.click());
    await page.getByRole('dialog').waitFor({ state: 'hidden' }); release();
    await page.waitForFunction(() => !document.body.textContent.includes('Loading connection plans…'));
    assert.equal(await page.getByText('PRIVATE_OLD_IDENTITY', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Connection plan saved. No sign-in, OAuth authorization or assignment was created.', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Add connection' }).click(); assert.equal(await page.getByLabel('Connection name', { exact: true }).inputValue(), '');
    assert.deepEqual(page.errors, []); await context.close();
  }
  report.journeys.push('Identity switch clears pending private form; old mutation response cannot restore metadata or success notices');
  for (const status of [401, 403, 404]) {
    const { context, page, state } = await fixture(); await add(page, 'PRIVATE_CANARY'); state.deny = status;
    await page.getByRole('button', { name: 'Save connection plan' }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Add connection', exact: true }).isDisabled(), true);
    assert.equal(await page.getByText('PRIVATE_CANARY', { exact: true }).count(), 0);
    await page.getByRole('alert').filter({ hasText: 'Private details have been cleared' }).waitFor(); await context.close();
  }
  report.journeys.push('401/403/404 clear form/list/current context and disable private operations');
  {
    const { context, page, state } = await fixture(); state.unavailable = 410;
    await page.getByRole('button', { name: 'Refresh plans' }).click(); await page.getByRole('alert').filter({ hasText: 'retired' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add connection' }).isDisabled(), true); await context.close();
  }
  report.journeys.push('410 retired capability remains unavailable with no connected badge or public navigation gate');
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await server.close(); }
