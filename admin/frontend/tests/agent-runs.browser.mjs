// A6 browser journeys against the UI harness (agent-runs-harness.mjs): the real
// app, routers, stores, A5 coordinator and A6 service; a scripted supervisor;
// fixture sessions and sudo. Run from admin/frontend:
//   node tests/agent-runs.browser.mjs
// BROWSER_EXE overrides the Chromium path; BROWSER_ARTIFACTS keeps screenshots
// and writes report.json there.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { createRunCoordinator } from '../../backend/src/lib/operational-run-coordinator.js';
import { guideWith, baseRules, pngFrame } from '../../backend/src/__tests__/helpers/agent-runs-world.js';
import { startHarness, SUDO_PASSWORD, SUDO_TOTP } from './agent-runs-harness.mjs';

const artifacts = process.env.BROWSER_ARTIFACTS;
if (artifacts) mkdirSync(artifacts, { recursive: true });
const journeyFilterSource = process.env.AGENT_RUN_JOURNEY_FILTER || '';
const journeyFilter = journeyFilterSource ? new RegExp(journeyFilterSource) : null;
const report = { filter: journeyFilterSource || null, skipped: [], journeys: [], layout: [], started_at: new Date().toISOString() };
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium', headless: true });
const WAIT = { timeout: 30000 };
let h;
const contexts = [];
const shell404 = /\/api\/(branding|lxc\/containers\/snapshot-export-queue)$/;

async function as(role, { width = 1280, height = 900, theme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  contexts.push(ctx);
  await ctx.addCookies([{ name: 'pp_harness_user', value: role, url: h.origin }, { name: 'pp_csrf', value: 'a6-csrf', url: h.origin }]);
  const u = h.world.users[role];
  await ctx.addInitScript(({ user, theme }) => {
    localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('mock2HintDismissed', '1'); localStorage.setItem('pp-theme', theme);
  }, { user: { id: u.id, username: u.username, role: u.role === 'admin' ? 'admin' : 'user' }, theme });
  const page = await ctx.newPage(); page.setDefaultNavigationTimeout(90000);
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('response', r => { if (r.status() >= 500 || (r.status() === 404 && r.url().includes('/api/') && !shell404.test(r.url()) && !r.url().includes('/operational-projects/'))) page.errors.push(`${r.status()} ${r.url()}`); });
  return page;
}
const runsUrl = (runId) => `${h.origin}/operational-projects/${h.world.p.id}?section=${encodeURIComponent('Agent runs')}${runId ? `&run=${runId}` : ''}`;
const shot = async (page, name) => { if (artifacts) await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true }); };
function resetScenario(extra = {}) {
  for (const action of [...h.world.supervisor.scenario.holds]) h.world.supervisor.release(action);
  Object.assign(h.world.supervisor.scenario, { outcome: 'signed_in', choices: [], modelError: null, actionErrors: {},
    holds: new Set(), takeover: null, delayMs: 350, ...extra });
}
const activeRun = () => h.world.f.db.prepare(`SELECT id FROM ops_agent_runs WHERE state IN ('prepared','starting','running','cancelling') ORDER BY started_at DESC LIMIT 1`).get()?.id;
const latestRun = () => h.world.f.db.prepare('SELECT id FROM ops_agent_runs ORDER BY started_at DESC LIMIT 1').get()?.id;
async function settleAll() {
  const id = activeRun();
  if (id) await h.world.service.settled(id);
  const end = Date.now() + 20000;
  while (activeRun() && Date.now() < end) await new Promise(done => setTimeout(done, 50));
  assert.equal(activeRun(), undefined, 'a run is still active');
}
async function journey(name, fn) {
  if (journeyFilter && !journeyFilter.test(name)) { report.skipped.push(name); return; }
  const started = Date.now();
  try { await fn(); report.journeys.push({ name, passed: true, seconds: Math.round((Date.now() - started) / 100) / 10 }); console.log(`ok - ${name}`); }
  catch (error) { report.journeys.push({ name, passed: false, error: error.message }); console.log(`not ok - ${name}\n  ${error.stack}`); throw error; }
  finally { for (const ctx of contexts.splice(0)) await ctx.close(); resetScenario(); await settleAll().catch(() => {}); }
}
async function startFromUi(page) {
  await page.goto(runsUrl());
  const start = page.getByRole('button', { name: 'Start run' });
  await start.waitFor(WAIT);
  await start.click();
  await page.getByRole('button', { name: 'Back to demo sign-in runs' }).waitFor(WAIT);
  return new URL(page.url()).searchParams.get('run');
}
// The run deck: a phone shows one panel at a time behind the bottom bar.
const panelButton = (page, name) => page.getByRole('navigation', { name: 'Run panels' }).getByRole('button', { name: new RegExp(`^${name}`) });
const views = runId => h.world.supervisor.calls.filter(c => c.method === 'view' && c.params?.run_id === runId).length;
const feedEnd = page => page.getByTestId('activity-scroller').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
const approvalCard = page => page.getByRole('region', { name: 'Approval needed' });
async function digestShown(page) { return (await page.getByRole('dialog').getByTestId('approval-digest').innerText()).replace(/\s+/g, ''); }
async function sudoIfAsked(page) {
  const sudo = page.getByRole('dialog').filter({ hasText: 'Confirm with password' });
  if (await sudo.isVisible().catch(() => false)) {
    await page.locator('#sudo-password').fill(SUDO_PASSWORD);
    await page.locator('#sudo-totp').fill(SUDO_TOTP);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  }
}
async function approveInUi(page, { prefix = 12 } = {}) {
  await approvalCard(page).waitFor(WAIT);
  await page.getByRole('button', { name: 'Review and approve' }).click();
  const digest = await digestShown(page);
  await page.getByLabel('Approval digest, at least the first 12 characters').fill(digest.slice(0, prefix));
  await page.getByRole('button', { name: 'Approve submit' }).click();
  await page.waitForTimeout(300);
  await sudoIfAsked(page);
  await page.getByText('Approved. The agent may now submit the bound credential.').waitFor(WAIT);
  return digest;
}
const showPanel = async (page, name) => {
  const context = page.getByRole('tablist', { name: 'Run context panels' });
  if (page.viewportSize().width>=1024) {await context.waitFor(WAIT);await context.getByRole('tab', { name, exact: true }).click();}
  else await panelButton(page, name).click();
};
const result = async (page, label) => {
  await showPanel(page,'Details');
  await page.getByTestId('run-result').filter({ hasText: label }).waitFor(WAIT);
};
// Every visible disabled control must say why: aria-describedby naming visible text.
async function deadControls(page, scope = 'main') {
  return page.locator(scope).evaluate(root => [...root.querySelectorAll('button:disabled')].filter(b => b.offsetParent).map(b => {
    const ids = (b.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const text = ids.map(id => document.getElementById(id)?.innerText?.trim() || '').join(' ');
    return text ? null : b.innerText.trim();
  }).filter(Boolean));
}
async function layoutCheck(page, label, { dialog = false } = {}) {
  for (const width of [360, 375, 390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const scope = dialog ? '[role="dialog"]' : 'main';
    const overflow = await page.evaluate(sel => {
      const root = document.querySelector(sel);
      const nodes = [document.documentElement, ...(root ? [root, ...root.querySelectorAll('*')] : [])];
      const bad = nodes.filter(n => n.clientWidth && n.scrollWidth > n.clientWidth + 1 && !['hidden', 'auto', 'scroll'].includes(getComputedStyle(n).overflowX));
      return { page: document.documentElement.scrollWidth > document.documentElement.clientWidth, nodes: bad.slice(0, 5).map(n => `${n.tagName}.${String(n.className).slice(0, 60)}`) };
    }, scope);
    assert.equal(overflow.page, false, `${label}: page scrolls horizontally at ${width}`);
    assert.deepEqual(overflow.nodes, [], `${label}: overflow at ${width}`);
    let small = [];
    if (width < 640) small = await page.locator(`${scope} button, ${scope} a[href]`).evaluateAll(els => els.filter(e => e.offsetParent && !e.closest('nav[aria-label="Main navigation"]'))
      .map(e => ({ text: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 40), ...e.getBoundingClientRect().toJSON() }))
      .filter(b => b.height < 44 || b.width < 44).filter(b => b.text !== 'Close').map(b => `${b.text} ${Math.round(b.width)}x${Math.round(b.height)}`));
    assert.deepEqual(small, [], `${label}: touch targets under 44px at ${width}`);
    report.layout.push({ label, width, overflow: false, small_targets: 0 });
    if (artifacts && [360, 768, 1280].includes(width)) await page.screenshot({ path: `${artifacts}/${label}-${width}.png`, fullPage: true });
  }
}

h = await startHarness();
try {
  await journey('roles: run roles may start; a viewer is told why not; an outsider gets 404', async () => {
    for (const role of ['owner', 'operator', 'editor', 'reviewer']) {
      const page = await as(role);
      await page.goto(runsUrl());
      await page.getByRole('button', { name: 'Start run' }).waitFor(WAIT);
      assert.equal(await page.getByRole('button', { name: 'Start run' }).isEnabled(), true, role);
      await page.getByText('Ready. Start pins this profile').waitFor(WAIT);
      assert.deepEqual(page.errors, [], role);
    }
    const viewer = await as('viewer');
    await viewer.goto(runsUrl());
    await viewer.getByText('Demo sign-in runs are not available to you: Agent runs need run access: owner, operator, editor or reviewer.').waitFor(WAIT);
    assert.equal(await viewer.getByRole('button', { name: 'Start run' }).count(), 0);
    await viewer.getByRole('button', { name: 'Agents', exact: true }).click();
    await viewer.getByText('Only the owner can change this.').waitFor(WAIT);
    await viewer.getByText('Hard rules enforced by code').click();
    await viewer.getByText('Needs a person\'s approval').waitFor(WAIT);
    await viewer.getByText('submit_bound_fixture').first().waitFor(WAIT);
    await viewer.goto(`${h.origin}/operational-projects`);
    await viewer.getByText('No approval is waiting for you.').waitFor(WAIT);
    assert.deepEqual(await deadControls(viewer), []);
    const outsider = await as('outsider');
    await outsider.goto(runsUrl());
    await outsider.getByText('Operational record not found').waitFor(WAIT);
    assert.equal(await outsider.getByRole('heading', { name: 'Demo sign-in runs' }).count(), 0);
  });

  await journey('desktop context tabs use keyboard navigation and show the run\'s immutable pinned guide', async () => {
    resetScenario({ holds: new Set(['open_login']) });
    const page = await as('operator');
    await startFromUi(page);
    await page.getByTestId('step-1').waitFor(WAIT);
    const context = page.getByRole('tablist', { name: 'Run context panels' });
    await context.getByRole('tab', { name: 'Activity', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await context.getByRole('tab', { name: 'Guide', selected: true }).waitFor(WAIT);
    const guide = page.getByTestId('pinned-guide');
    await guide.getByRole('heading', { name: h.world.version.title, exact: true }).waitFor(WAIT);
    assert.equal(await guide.locator('pre').innerText(), h.world.version.instructions);
    await guide.getByText('Guide hash', { exact: true }).click();
    await guide.getByText(h.world.version.content_hash, { exact: true }).waitFor(WAIT);
    await context.getByRole('tab', { name: 'Guide', exact: true }).focus();
    await page.keyboard.press('End');
    await context.getByRole('tab', { name: 'Details', selected: true }).waitFor(WAIT);
    await page.getByRole('tab', { name: 'Result', exact: true }).waitFor(WAIT);
    await page.getByRole('button', { name: 'Stop run' }).click();
    await result(page, 'Stopped');
    assert.deepEqual(page.errors, []);
  });

  await journey('start, rule steps, live browser, approval with sudo and the digest, verified result', async () => {
    const page = await as('operator');
    const runId = await startFromUi(page);
    await page.getByTestId('step-1').filter({ hasText: 'Decided by the start rule' }).waitFor(WAIT);
    await page.getByRole('img', { name: /Live browser frame/ }).waitFor(WAIT);
    await approvalCard(page).waitFor(WAIT);
    await shot(page, 'flow-approval-card');
    // The inbox shows the same approval to another run role.
    const reviewer = await as('reviewer');
    await reviewer.goto(`${h.origin}/operational-projects`);
    await reviewer.getByText('Pending approvals (1)').waitFor(WAIT);
    await page.getByRole('button', { name: 'Review and approve' }).click();
    const dialog = page.getByRole('dialog');
    const digest = await digestShown(page);
    const input = page.getByLabel('Approval digest, at least the first 12 characters');
    const approve = page.getByRole('button', { name: 'Approve submit' });
    await input.fill(digest.slice(0, 11));
    await dialog.getByText('Keep typing: 11 of at least 12 characters match.').waitFor(WAIT);
    assert.equal(await approve.isDisabled(), true);
    await input.fill(`${digest.slice(0, 11)}${digest[11] === 'f' ? 'e' : 'f'}`);
    await dialog.getByText('That does not match the digest shown.').waitFor(WAIT);
    assert.equal(await approve.isDisabled(), true);
    assert.deepEqual(await deadControls(page, '[role="dialog"]'), []);
    await shot(page, 'flow-approval-dialog');
    // 13 characters is a correct answer too (A5 lesson).
    await input.fill(digest.slice(0, 13));
    await dialog.getByText('Matches the digest shown (13 characters).').waitFor(WAIT);
    await approve.click();
    await page.getByRole('dialog').filter({ hasText: 'Confirm with password' }).waitFor(WAIT);
    await shot(page, 'flow-sudo');
    await page.locator('#sudo-password').fill(SUDO_PASSWORD);
    await page.locator('#sudo-totp').fill(SUDO_TOTP);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByText('Approved. The agent may now submit the bound credential.').waitFor(WAIT);
    await result(page, 'Signed in and verified');
    await page.getByText(`Teardown receipt: verified · key ${h.world.supervisor.keyId.slice(0, 8)}`).waitFor(WAIT);
    await showPanel(page,'Activity');
    await page.getByText('Approved by omar-operator', { exact: true }).waitFor(WAIT);
    await page.getByText(/Decided by the model, choosing from/).first().waitFor(WAIT);
    await page.getByText('Stop is not available: The run has ended.').waitFor(WAIT);
    await page.getByText('Live view is not available: The browser is gone: the run is not running.').waitFor(WAIT);
    assert.ok(await page.getByRole('img', { name: /Browser frame at step/ }).count() >= 1, 'frames in the activity');
    assert.equal(await page.getByRole('button', { name: 'Review and approve' }).count(), 0);
    const text = await page.locator('main').innerText();
    for (const secret of ['a3r1.', 'Ignore the rules', 'chatcmpl', 'agents/a4-broker']) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(await deadControls(page), []);
    assert.deepEqual(page.errors, []);
    await shot(page, 'flow-result');
    report.flow_run = runId;
  });

  await journey('run deck at 1280×800: the whole frame and the latest activity are in view while an approval is open', async () => {
    resetScenario();
    const page = await as('operator', { height: 800 });
    await startFromUi(page);
    await approvalCard(page).waitFor(WAIT);
    await page.getByRole('img', { name: /Live browser frame/ }).waitFor(WAIT);
    await page.getByText('The agent is paused until approval').waitFor(WAIT);
    await page.waitForTimeout(300);
    const fit = await page.evaluate(() => {
      const viewport = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
      const inside = (r, c) => r.top >= c.top - 1 && r.bottom <= c.bottom + 1 && r.left >= c.left - 1 && r.right <= c.right + 1;
      const column = document.querySelector('[data-testid="activity-scroller"]');
      const items = [...column.querySelectorAll('ol > li')].slice(-4).map(li => li.getBoundingClientRect());
      return { frame: inside(document.querySelector('[data-testid="browser-frame"]').getBoundingClientRect(), viewport),
        items: items.map(r => inside(r, viewport) && inside(r, column.getBoundingClientRect())),
        pageScrolled: document.querySelector('main > .overflow-y-auto').scrollTop };
    });
    assert.deepEqual(fit, { frame: true, items: [true, true, true, true], pageScrolled: 0 });
    report.deck_fit = fit;
    const railPlacement = await page.evaluate(() => {
      const approval = document.querySelector('[data-run-approval]').getBoundingClientRect();
      const browser = document.querySelector('[data-browser-pane]').getBoundingClientRect();
      const context = document.querySelector('[data-run-context]').getBoundingClientRect();
      return { rightOfBrowser: approval.left >= browser.right,
        alignedWithBrowser: Math.abs(approval.top - browser.top) <= 1,
        aboveContext: approval.bottom <= context.top,
        alignedWithContext: Math.abs(approval.left - context.left) <= 1 && Math.abs(approval.right - context.right) <= 1 };
    });
    assert.deepEqual(railPlacement, { rightOfBrowser: true, alignedWithBrowser: true, aboveContext: true, alignedWithContext: true });
    assert.equal(await approvalCard(page).count(), 1, 'one approval card across responsive layouts');
    report.approval_rail_placement = railPlacement;
    // The right-rail card stays before Browser in the DOM; nine fields remain in the dialog.
    assert.equal(await approvalCard(page).getByTestId('approval-digest').count(), 0);
    await approvalCard(page).getByText(/digest [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} …/).waitFor(WAIT);
    assert.deepEqual(await deadControls(page), []);
    // Tab reaches the active context tab; arrow keys expose Guide and Details
    // (verified by the dedicated keyboard journey above).
    await page.getByRole('button', { name: 'Back to demo sign-in runs' }).focus();
    const order = [];
    for (let i = 0; i < 30 && order.at(-1) !== 'context tabs'; i += 1) {
      const where = await page.evaluate(() => {
        const e = document.activeElement;
        if (e.closest('[aria-label="Approval needed"]')) return 'approval';
        if (e.closest('[data-run-header]')) return 'run bar';
        if (e.closest('[data-browser-pane]')) return 'browser';
        if (e.closest('[role="tablist"][aria-label="Run context panels"]')) return 'context tabs';
        return 'other';
      });
      if (order.at(-1) !== where) order.push(where);
      await page.keyboard.press('Tab');
    }
    assert.deepEqual(order, ['run bar', 'approval', 'browser', 'context tabs']);
    report.focus_order = order;
    await shot(page, 'deck-1280x800');
    await page.getByRole('button', { name: 'Stop run' }).click();
    await result(page, 'Stopped');
  });

  await journey('phone panels: one at a time, the choice survives a refresh (&panel=), the banner follows the panel', async () => {
    resetScenario();
    const page = await as('operator', { width: 375, height: 812 });
    const runId = await startFromUi(page);
    await approvalCard(page).waitFor(WAIT);
    assert.equal(await approvalCard(page).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Review and approve' }).count(), 1);
    // Browser is the default while the run is running: the full banner form.
    assert.equal(await panelButton(page, 'Browser').getAttribute('aria-pressed'), 'true');
    assert.equal((await page.getByRole('button', { name: 'Review and approve' }).innerText()).trim(), 'Review and approve');
    await panelButton(page, 'Activity').click();
    assert.equal(await approvalCard(page).isVisible(), true, 'approval remains outside the Activity panel');
    assert.equal(new URL(page.url()).searchParams.get('panel'), 'activity');
    await page.getByTestId('step-1').waitFor(WAIT);
    assert.equal(await page.getByTestId('browser-frame').isVisible(), false);
    assert.equal((await page.getByRole('button', { name: 'Review and approve' }).innerText()).trim(), 'Review');
    await page.reload();
    await page.getByTestId('step-1').waitFor(WAIT);
    assert.equal(await panelButton(page, 'Activity').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('browser-frame').isVisible(), false);
    assert.equal(new URL(page.url()).searchParams.get('run'), runId);
    await panelButton(page, 'Details').click();
    assert.equal(await approvalCard(page).isVisible(), true, 'approval remains outside the Details panel');
    await page.getByRole('button', { name: 'Refresh run' }).waitFor(WAIT);
    await page.reload();
    await page.getByRole('tab', { name: 'Result' }).waitFor(WAIT);
    assert.equal(await page.getByTestId('step-1').isVisible(), false);
    assert.deepEqual(await deadControls(page), []);
    await shot(page, 'phone-details');
    await panelButton(page, 'Browser').click();
    assert.equal(await approvalCard(page).isVisible(), true, 'approval remains visible above the default Browser panel');
    await page.getByTestId('browser-frame').waitFor(WAIT);
    assert.equal(new URL(page.url()).searchParams.get('panel'), 'browser');
    // The reader chose Browser, so it stays after the run ends: Ended, with the last frame.
    await page.getByRole('button', { name: 'Stop run' }).click();
    await page.getByTestId('browser-state').filter({ hasText: 'Ended' }).waitFor(WAIT);
    await panelButton(page, 'Details').click();
    await result(page, 'Stopped');
  });

  await journey('follow-latest: new items keep the feed at the bottom; a reader who scrolled up sees Jump to latest and is not moved', async () => {
    resetScenario();
    const page = await as('operator', { height: 700 });
    await startFromUi(page);
    await approvalCard(page).waitFor(WAIT);
    await page.getByText('The agent is paused until approval').waitFor(WAIT);
    const scroller = page.getByTestId('activity-scroller');
    const size = await scroller.evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    assert.ok(size.scroll > size.client + 40, `the feed overflows its column (${size.scroll} > ${size.client})`);
    assert.ok(await feedEnd(page) < 32, 'following: at the bottom');
    await scroller.evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(200);
    await approveInUi(page);
    const jump = page.getByRole('button', { name: /^Jump to latest \(\d+ new\)$/ });
    await jump.waitFor(WAIT);
    assert.equal(await scroller.evaluate(el => el.scrollTop), 0, 'a reader who scrolled up is not moved');
    report.follow_latest = { jump: await jump.innerText() };
    await jump.click();
    assert.equal(await jump.count(), 0);
    assert.ok(await feedEnd(page) < 32, 'Jump to latest reaches the bottom');
    await page.getByTestId('feed-result').waitFor(WAIT);
    await page.waitForTimeout(300);
    assert.ok(await feedEnd(page) < 32, 'following again: the result arrived at the bottom');
    await result(page, 'Signed in and verified');
  });

  await journey('frames: none before step 1 has finished (no blank first frame); an identical frame is not attached again', async () => {
    resetScenario({ holds: new Set(['open_landing']) });
    const client = h.world.supervisor.client, request = client.request;
    const same = pngFrame(640, 400, [37, 99, 235]);
    client.request = async (method, params) => { const reply = await request.call(client, method, params); return method === 'view' ? { ...reply, png_base64: same } : reply; };
    try {
      const page = await as('operator');
      const runId = await startFromUi(page);
      await page.getByTestId('step-1').filter({ hasText: 'in progress' }).waitFor(WAIT);
      await page.getByTestId('browser-frame').getByText('Starting the browser…').waitFor(WAIT);
      await page.waitForTimeout(3000);
      assert.equal(views(runId), 0, 'no frame is asked for before step 1 has finished');
      assert.equal(await page.getByRole('img', { name: /browser frame/i }).count(), 0);
      h.world.supervisor.release('open_landing');
      await page.getByRole('img', { name: /Live browser frame/ }).waitFor(WAIT);
      await approvalCard(page).waitFor(WAIT);
      const before = views(runId);
      await page.waitForTimeout(4500);
      assert.ok(views(runId) >= before + 2, 'more identical frames arrived');
      assert.equal(await page.getByTestId('activity-scroller').getByRole('img').count(), 1, 'an identical frame is attached once');
      await page.getByRole('button', { name: 'Stop run' }).click();
      await result(page, 'Stopped');
    } finally { client.request = request; }
  });

  await journey('browser state: LIVE, Paused (no frames), Ended with "Last frame · at step N"; Details tabs by keyboard', async () => {
    resetScenario({ holds: new Set(['open_login']) });
    const page = await as('editor');
    const runId = await startFromUi(page);
    const pill = page.getByTestId('browser-state');
    await page.getByRole('img', { name: /Live browser frame/ }).waitFor(WAIT);
    assert.equal((await pill.innerText()).trim(), 'LIVE');
    await page.getByTestId('browser-caption').filter({ hasText: /^At step \d+ · .+ · captured / }).waitFor(WAIT);
    const watch = page.getByRole('switch', { name: 'Watch live (view only)' });
    assert.equal(await watch.getAttribute('aria-checked'), 'true');
    await watch.click();
    await pill.filter({ hasText: 'Paused' }).waitFor(WAIT);
    assert.equal(await watch.getAttribute('aria-checked'), 'false');
    await page.waitForTimeout(500);
    const paused = views(runId);
    await page.waitForTimeout(3000);
    assert.equal(views(runId), paused, 'paused: no frames are asked for');
    await watch.click();
    await pill.filter({ hasText: 'LIVE' }).waitFor(WAIT);
    await page.getByRole('button', { name: 'Stop run' }).click();
    await result(page, 'Stopped');
    await pill.filter({ hasText: 'Ended' }).waitFor(WAIT);
    await page.getByTestId('browser-caption').filter({ hasText: /^Last frame · at step \d+$/ }).waitFor(WAIT);
    await page.getByRole('img', { name: /^Last browser frame at step \d+$/ }).waitFor(WAIT);
    assert.equal(await page.getByRole('switch').count(), 0);
    assert.deepEqual(await deadControls(page), []);
    // Details: Result is selected when the run ends; arrows move between tabs.
    const tab = name => page.getByRole('tab', { name });
    assert.equal(await tab('Result').getAttribute('aria-selected'), 'true');
    await tab('Result').focus();
    // Radix moves focus on a timer after the key, so wait for the selection.
    const selected = async (name, text) => {
      await page.getByRole('tab', { name, selected: true }).waitFor(WAIT);
      assert.equal(await tab(name).evaluate(e => e === document.activeElement && e.matches(':focus-visible')), true, `${name} focused`);
      await page.getByRole('tabpanel').getByText(text).first().waitFor(WAIT);
    };
    // A7 adds Review (the rule-based critique and the model summary) after Result.
    await page.keyboard.press('ArrowRight');
    await selected('Review', 'Model summary');
    await page.keyboard.press('ArrowRight');
    await selected(/^Model calls/, 'No model call: every step was decided by a rule.');
    await page.keyboard.press('ArrowRight');
    await selected(/^Approvals/, 'No approval was requested.');
    await page.keyboard.press('End');
    await selected('Pins', 'Policy digest');
    await page.keyboard.press('Home');
    await selected('Result', 'Teardown receipt: verified');
    await page.keyboard.press('ArrowLeft');
    await selected('Pins', 'Policy digest');
    report.tabs_keyboard = true;
  });

  await journey('stop mid-run: the run is fenced and says why Stop is gone', async () => {
    resetScenario({ holds: new Set(['open_login']) });
    const page = await as('editor');
    await startFromUi(page);
    await page.getByTestId('step-2').filter({ hasText: 'in progress' }).waitFor(WAIT);
    await page.getByRole('button', { name: 'Stop run' }).click();
    await result(page, 'Stopped');
    await page.getByText('Stop is not available: The run has ended.').waitFor(WAIT);
    assert.equal(h.world.supervisor.calls.filter(c => c.params?.action === 'submit_bound_fixture' && c.params.run_id === latestRun()).length, 0);
    assert.deepEqual(page.errors, []);
  });

  await journey('stale approval: a rotated binding closes the control with the reason', async () => {
    const page = await as('operator');
    await startFromUi(page);
    await approvalCard(page).waitFor(WAIT);
    await page.getByRole('button', { name: 'Review and approve' }).click();
    const digest = await digestShown(page);
    const binding = h.world.f.db.prepare("SELECT id,revision FROM ops_agent_credential_bindings WHERE state='active'").get();
    h.world.bindings.rotate(h.world.users.owner, { binding_id: binding.id, expected_revision: binding.revision, vault_version: binding.revision + 1 });
    await page.getByLabel('Approval digest, at least the first 12 characters').fill(digest.slice(0, 12));
    await page.getByRole('button', { name: 'Approve submit' }).click();
    await page.getByRole('dialog').getByText(/The approval is stale/).waitFor(WAIT);
    await page.getByRole('dialog').getByText('Reason: the run, its binding, the guide or the policy changed.').waitFor(WAIT);
    assert.equal(await page.getByRole('button', { name: 'Approve submit' }).count(), 0);
    await shot(page, 'stale-approval');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
    await result(page, 'Approval stale');
  });

  await journey('stale approval: a newly approved guide, then the profile is not ready until reassigned', async () => {
    const page = await as('operator');
    await startFromUi(page);
    await approvalCard(page).waitFor(WAIT);
    h.world.approveGuide(guideWith(baseRules, ' Revised after review.'));
    await page.getByRole('button', { name: 'Review and approve' }).click();
    const digest = await digestShown(page);
    await page.getByLabel('Approval digest, at least the first 12 characters').fill(digest.slice(0, 12));
    await page.getByRole('button', { name: 'Approve submit' }).click();
    await page.getByRole('dialog').getByText(/The approval is stale/).waitFor(WAIT);
    await page.keyboard.press('Escape');
    await result(page, 'Approval stale');
    await page.getByRole('button', { name: 'Back to demo sign-in runs' }).click();
    await page.getByText('The assigned guide is no longer the current approved version.').waitFor(WAIT);
    assert.equal(await page.getByRole('button', { name: 'Start run' }).isDisabled(), true);
    assert.deepEqual(await deadControls(page), []);
    const owner = await as('owner');
    await owner.goto(`${h.origin}/operational-projects/${h.world.p.id}?section=Agents`);
    await owner.getByRole('button', { name: 'Assign current approved guide' }).click();
    await owner.getByText('Current guide assigned.').waitFor(WAIT);
    await page.getByRole('button', { name: 'Refresh runs' }).click();
    await page.getByText('Ready. Start pins this profile').waitFor(WAIT);
  });

  await journey('owner consent: withdrawing it makes Start say why; giving it needs the reviewed statement', async () => {
    const owner = await as('owner');
    await owner.goto(`${h.origin}/operational-projects/${h.world.p.id}?section=Agents`);
    await owner.getByRole('button', { name: 'Withdraw consent' }).click();
    await owner.getByText('Consent withdrawn.').waitFor(WAIT);
    const give = owner.getByRole('button', { name: 'Give consent' });
    assert.equal(await give.isDisabled(), true);
    assert.deepEqual(await deadControls(owner), []);
    const editor = await as('editor');
    await editor.goto(runsUrl());
    await editor.getByText('The owner has not consented to sending this profile\'s guide to the model provider.').waitFor(WAIT);
    assert.equal(await editor.getByRole('button', { name: 'Start run' }).isDisabled(), true);
    await editor.getByRole('button', { name: 'Agents', exact: true }).click();
    await editor.getByText('Only the owner can change this.').waitFor(WAIT);
    assert.equal(await editor.getByRole('button', { name: 'Give consent' }).count(), 0);
    await owner.getByLabel(/I reviewed: Send this profile's approved guide to the model provider/).check();
    await give.click();
    await owner.getByText('Consent given.').waitFor(WAIT);
    await editor.goto(runsUrl());
    await editor.getByText('Ready. Start pins this profile').waitFor(WAIT);
  });

  await journey('an approval racing a stop: the open dialog closes itself with the reason', async () => {
    resetScenario();
    const page = await as('operator');
    const runId = await startFromUi(page);
    await approvalCard(page).waitFor(WAIT);
    await page.getByRole('button', { name: 'Review and approve' }).click();
    const digest = await digestShown(page);
    await page.getByLabel('Approval digest, at least the first 12 characters').fill(digest.slice(0, 12));
    const owner = await as('owner');
    await owner.goto(runsUrl(runId));
    await owner.getByRole('button', { name: 'Stop run' }).click();
    await page.getByRole('dialog').getByText(/This approval is closed \(stale: the run was stopping\)\. Nothing was approved\./).waitFor(WAIT);
    assert.equal(await page.getByRole('button', { name: 'Approve submit' }).count(), 0);
    await page.keyboard.press('Escape');
    await result(page, 'Stopped');
    assert.equal(h.world.supervisor.calls.filter(c => c.params?.action === 'submit_bound_fixture' && c.params.run_id === runId).length, 0);
  });

  await journey('a revoked grant while viewing: the next poll shows the refusal and the live view stops', async () => {
    resetScenario({ holds: new Set(['open_login']) });
    const page = await as('operator');
    const runId = await startFromUi(page);
    await page.getByRole('img', { name: /Live browser frame/ }).waitFor(WAIT);
    const owner = await as('owner');
    await owner.goto(`${h.origin}/operational-projects/${h.world.p.id}?section=Access`);
    const member = owner.locator('li').filter({ hasText: 'omar-operator' });
    await member.getByRole('button', { name: 'Revoke access' }).click();
    await owner.getByText('Access revoked.').waitFor(WAIT);
    await page.getByText(/This run is not available to you: Operational record not found/).waitFor(WAIT);
    assert.equal(await page.getByRole('img', { name: /Live browser frame/ }).count(), 0);
    const viewsBefore = h.world.supervisor.calls.filter(c => c.method === 'view').length;
    await page.waitForTimeout(4500);
    assert.equal(h.world.supervisor.calls.filter(c => c.method === 'view').length, viewsBefore, 'no frames after revocation');
    await owner.goto(runsUrl(runId));
    await owner.getByRole('button', { name: 'Stop run' }).click();
    await result(owner, 'Stopped');
    h.world.f.store.grant(h.world.users.owner, h.world.p.id, h.world.users.operator.id,
      h.world.f.store.get(h.world.users.owner, h.world.p.id).revision, { role: 'operator' });
  });

  await journey('refresh and reconnect during an approval at 360px: durable state returns, then approve', async () => {
    resetScenario();
    const page = await as('reviewer', { width: 360 });
    const runId = await startFromUi(page);
    await approvalCard(page).waitFor(WAIT);
    await page.getByRole('button', { name: 'Review and approve' }).click();
    await page.getByRole('dialog').waitFor(WAIT);
    await page.reload();
    await approvalCard(page).waitFor(WAIT);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.context().setOffline(true);
    await page.waitForTimeout(3500);
    await page.context().setOffline(false);
    // Refresh lives in Details; on a phone that is its own panel.
    await panelButton(page, 'Details').click();
    await page.getByRole('button', { name: 'Refresh run' }).click();
    await approvalCard(page).waitFor(WAIT);
    await page.getByRole('button', { name: 'Review and approve' }).click();
    await layoutCheck(page, 'approval-dialog', { dialog: true });
    await page.setViewportSize({ width: 360, height: 740 });
    const digest = await digestShown(page);
    await page.getByLabel('Approval digest, at least the first 12 characters').fill(digest.slice(0, 12));
    await page.getByRole('button', { name: 'Approve submit' }).click();
    await page.getByRole('dialog').filter({ hasText: 'Confirm with password' }).waitFor(WAIT);
    await sudoIfAsked(page);
    await page.getByText('Approved. The agent may now submit the bound credential.').waitFor(WAIT);
    await result(page, 'Signed in and verified');
    assert.equal(new URL(page.url()).searchParams.get('run'), runId);
  });

  await journey('keyboard only: start, open the approval, type the digest, confirm sudo, finish', async () => {
    resetScenario();
    h.sudoUntil.delete(h.world.users.editor.id);
    const page = await as('editor');
    await page.goto(runsUrl());
    await page.getByRole('button', { name: 'Start run' }).waitFor(WAIT);
    // Reach a control by Tab alone, and require a visible focus indicator on it.
    async function tabTo(name, limit = 80) {
      for (let i = 0; i < limit; i += 1) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => { const e = document.activeElement; return (e?.getAttribute('aria-label') || e?.innerText || '').trim(); });
        if (focused === name) {
          const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement);
            return { visible: document.activeElement.matches(':focus-visible'), shadow: s.boxShadow, outline: s.outlineStyle }; });
          assert.ok(ring.visible && (ring.shadow !== 'none' || ring.outline !== 'none'), `no visible focus on "${name}"`);
          (report.keyboard_focus ??= []).push({ control: name, ...ring });
          return;
        }
      }
      throw new Error(`could not reach "${name}" with Tab`);
    }
    await tabTo('Start run');
    await page.keyboard.press('Enter');
    await approvalCard(page).waitFor(WAIT);
    await tabTo('Review and approve');
    await page.keyboard.press('Enter');
    const digest = await digestShown(page);
    // Keyboard only: Tab until the digest input holds focus, then type.
    for (let i = 0; i < 20 && !(await page.evaluate(() => document.activeElement?.tagName === 'INPUT')); i += 1) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('autocomplete')), 'off');
    await page.keyboard.type(digest.slice(0, 12));
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').filter({ hasText: 'Confirm with password' }).waitFor(WAIT);
    await page.keyboard.type(SUDO_PASSWORD);
    await page.keyboard.press('Tab');
    await page.keyboard.type(SUDO_TOTP);
    await page.keyboard.press('Enter');
    await page.getByText('Approved. The agent may now submit the bound credential.').waitFor(WAIT);
    await result(page, 'Signed in and verified');
  });

  await journey('each result class and help banner; the inbox lists the open help request', async () => {
    const cases = [
      [{ outcome: 'rejected' }, 'Credential rejected', false, true],
      [{ outcome: 'rate_limited' }, 'Rate limited', false, true],
      [{ outcome: 'challenge_required' }, 'Challenge required', true, true],
      [{ outcome: 'unexpected_origin' }, 'Unexpected origin', false, true],
      // A7 decision 6: a timed-out sign-in may have happened, so it needs a
      // person, and the profile waits for their decision (below).
      [{ outcome: 'timeout' }, 'Timed out', true, true],
      [{ outcome: 'unknown' }, 'Account not verified', false, true],
      [{ modelError: 'BUDGET_EXHAUSTED' }, 'Budget exhausted', false, false],
      [{ modelError: 'CALL_UNCERTAIN' }, 'Uncertain model call', true, false],
      [{ actionErrors: { open_login: 'SUPERVISOR_TIMEOUT' } }, 'Uncertain step', true, false],
      [{ takeover: 'open_login' }, 'Taken over', true, false],
    ];
    const page = await as('operator', { width: 768 });
    report.result_classes = [];
    for (const [scenario, label, help, approve] of cases) {
      resetScenario({ delayMs: 60, ...scenario });
      await startFromUi(page);
      if (approve) await approveInUi(page);
      await result(page, label);
      if (help) await page.getByRole('note').filter({ hasText: `Review needed: ${label}` }).waitFor(WAIT);
      else assert.equal(await page.getByRole('note').filter({ hasText: 'Review needed' }).count(), 0, label);
      report.result_classes.push({ label, help });
      await settleAll();
      if (label === 'Timed out') {
        await page.locator('[data-testid^="reconcile-step:"]').getByRole('button', { name: 'It did not happen' }).click();
        const prompt = page.getByRole('dialog').filter({ hasText: 'Confirm it is you' });
        await prompt.waitFor(WAIT);
        await page.locator('#agent-control-password').fill(SUDO_PASSWORD);
        await page.locator('#agent-control-code').fill(SUDO_TOTP);
        await prompt.getByRole('button', { name: 'Confirm', exact: true }).click();
        await page.locator('[data-testid^="reconcile-step:"]').getByText('Decided').waitFor(WAIT);
      }
    }
    // A restart while a run is active: fenced, never resumed, needs a person.
    resetScenario({ holds: new Set(['open_login']) });
    const runId = await startFromUi(page);
    await panelButton(page, 'Activity').click();
    await page.getByTestId('step-2').filter({ hasText: 'in progress' }).waitFor(WAIT);
    await createRunCoordinator({ db: h.world.f.db, launcher: h.world.supervisor.launcher, verifyTeardown: h.world.supervisor.verifyTeardown }).recover();
    // The reader chose Activity, so it stays; the result is its last item, the summary is in Details.
    await page.getByTestId('feed-result').filter({ hasText: 'Result: Interrupted' }).waitFor(WAIT);
    await page.getByText('Error: COORDINATOR_RESTART').waitFor(WAIT);
    await page.getByRole('note').filter({ hasText: 'Review needed: Interrupted' }).waitFor(WAIT);
    await panelButton(page, 'Details').click();
    await result(page, 'Interrupted');
    report.result_classes.push({ label: 'Interrupted', help: true });
    await shot(page, 'help-interrupted');
    await page.goto(`${h.origin}/operational-projects`);
    await page.getByText('Help requests (1)').waitFor(WAIT);
    await page.getByText(/Check the account on the site before you start another run: the coordinator restarted/).waitFor(WAIT);
    await page.getByRole('link', { name: 'Open the run' }).click();
    await result(page, 'Interrupted');
    assert.equal(new URL(page.url()).searchParams.get('run'), runId);
  });

  await journey('layout: overview, run detail with a pending approval, and the inbox at six widths in both themes', async () => {
    resetScenario();
    for (const theme of ['light', 'dark']) {
      const page = await as('owner', { theme });
      const runId = await startFromUi(page);
      await approvalCard(page).waitFor(WAIT);
      await page.getByRole('img', { name: /Live browser frame/ }).waitFor(WAIT);
      await layoutCheck(page, `run-detail-${theme}`);
      for (const name of ['Activity', 'Details']) {
        await page.setViewportSize({ width: 375, height: 900 });
        await panelButton(page, name).click();
        await layoutCheck(page, `run-${name.toLowerCase()}-${theme}`);
        assert.deepEqual(await deadControls(page), [], `run-${name}-${theme}`);
      }
      await page.goto(`${h.origin}/operational-projects`);
      await page.getByText('Pending approvals (1)').waitFor(WAIT);
      await layoutCheck(page, `inbox-${theme}`);
      await page.goto(runsUrl());
      await page.getByRole('heading', { name: 'Run history' }).waitFor(WAIT);
      await layoutCheck(page, `overview-${theme}`);
      await page.goto(`${h.origin}/operational-projects/${h.world.p.id}?section=Agents`);
      await page.getByText('Hard rules enforced by code').click();
      await page.getByText('Needs a person\'s approval').waitFor(WAIT);
      await layoutCheck(page, `agents-${theme}`);
      assert.deepEqual(await deadControls(page), [], `agents-${theme}`);
      await page.goto(runsUrl(runId));
      await page.getByRole('button', { name: 'Stop run' }).click();
      await result(page, 'Stopped');
      assert.deepEqual(page.errors, [], theme);
    }
  });
} finally {
  for (const ctx of contexts.splice(0)) await ctx.close();
  await h.close();
}

// The administrators' toggles, all off at start: only an administrator (with
// sudo) turns them on, each after the one before it; a person sees the result.
h = await startHarness({ toggles: true });
try {
  await journey('toggles: off until an administrator turns them on with sudo; everyone sees the result', async () => {
    const person = await as('operator');
    await person.goto(`${h.origin}/operational-projects`);
    await person.getByText('Operations is not turned on for this installation. An administrator turns it on in Operations settings.').waitFor(WAIT);
    assert.equal(await person.getByRole('link', { name: 'Operations' }).count(), 0, 'no sidebar entry for a person while off');
    assert.equal(await person.getByRole('heading', { name: 'Operations settings' }).count(), 0);
    const admin = await as('admin', { width: 375 });
    await admin.goto(`${h.origin}/operational-projects`);
    await admin.getByText('Operations is not turned on for this installation. Turn it on in Operations settings below.').waitFor(WAIT);
    await admin.locator('summary').filter({hasText:'Operations settings'}).click();
    await admin.getByText('Turn on Operations first.').first().waitFor(WAIT);
    assert.equal(await admin.getByRole('button', { name: 'Turn on Demo sign-in runs' }).isDisabled(), true);
    assert.deepEqual(await deadControls(admin), []);
    await layoutCheck(admin, 'settings-off');
    await admin.setViewportSize({ width: 375, height: 900 });
    await admin.getByRole('button', { name: 'Turn on Operations' }).click();
    await admin.getByRole('dialog').filter({ hasText: 'Confirm with password' }).waitFor(WAIT);
    await sudoIfAsked(admin);
    await admin.getByText('Operations turned on.').waitFor(WAIT);
    await admin.getByRole('button', { name: 'New project', exact: true }).waitFor(WAIT);
    await admin.getByRole('button', { name: 'Turn on Agent metadata' }).click();
    await admin.getByText('Agent metadata turned on.').waitFor(WAIT);
    await admin.getByRole('button', { name: 'Turn on Demo sign-in runs' }).click();
    await admin.getByText('Demo sign-in runs turned on.').waitFor(WAIT);
    await admin.getByRole('heading', { name: 'Demo sign-in inbox' }).waitFor(WAIT);
    await layoutCheck(admin, 'settings-on');
    const audit = h.world.f.db.prepare("SELECT resource_id FROM audit_log WHERE action='OPERATIONS_TOGGLE_CHANGED' ORDER BY rowid").all();
    assert.deepEqual(audit.map(a => a.resource_id), ['operations', 'agents_metadata', 'agent_runs']);
    await person.goto(runsUrl());
    await person.getByRole('button', { name: 'Start run' }).waitFor(WAIT);
    await person.getByRole('link', { name: 'Operations' }).first().waitFor(WAIT);
    // Off again: the person's next request is refused and the page says why.
    await admin.setViewportSize({ width: 1280, height: 900 });
    await admin.getByRole('button', { name: 'Turn off Operations' }).click();
    await admin.getByText('Operations turned off.').waitFor(WAIT);
    await admin.getByText('Operations is not turned on for this installation. Turn it on in Operations settings below.').waitFor(WAIT);
    await person.goto(`${h.origin}/operational-projects`);
    await person.getByText('Operations is not turned on for this installation.', { exact: false }).waitFor(WAIT);
    assert.equal(h.world.supervisor.calls.length, 0);
  });
} finally {
  for (const ctx of contexts.splice(0)) await ctx.close();
  await h.close();
}

// No supervisor configured: every execution control says why, and nothing runs.
h = await startHarness({ execution: false });
try {
  await journey('execution unavailable: Start says why; the inbox says so; nothing launches', async () => {
    const page = await as('operator');
    await page.goto(runsUrl());
    await page.getByText('Execution is unavailable: no worker supervisor is configured on this installation. Runs already recorded stay readable.').waitFor(WAIT);
    assert.equal(await page.getByRole('button', { name: 'Start run' }).isDisabled(), true);
    assert.deepEqual(await deadControls(page), []);
    await layoutCheck(page, 'unavailable');
    await page.goto(`${h.origin}/operational-projects`);
    await page.getByText('Execution is unavailable: no worker supervisor is configured on this installation.').waitFor(WAIT);
    assert.equal(h.world.supervisor.calls.length, 0);
  });
} finally {
  for (const ctx of contexts.splice(0)) await ctx.close();
  await h.close();
  await browser.close();
}
assert(report.journeys.length > 0, 'the requested browser journey filter must match a real journey');
report.passed = report.journeys.every(j => j.passed);
report.finished_at = new Date().toISOString();
if (artifacts) writeFileSync(`${artifacts}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ a6_browser_journeys: report.passed ? 'passed' : 'failed', journeys: report.journeys.length,
  filter: report.filter, skipped: report.skipped, layout_checks: report.layout.length }));
if (!report.passed) process.exitCode = 1;
