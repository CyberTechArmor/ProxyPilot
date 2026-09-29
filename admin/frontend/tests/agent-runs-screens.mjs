// Screens for the A6 design record (docs/plans/assets/a6/). The real app against
// the UI harness (agent-runs-harness.mjs, toggles on), with one change: the
// scripted supervisor's `view` answers with real screenshots of the local demo
// site (demo/server.mjs) at the page each step reached, so the Browser pane
// shows what an agent run on demo.fractionate.ai looks like. Illustration only:
// the journeys in agent-runs.browser.mjs are the proof. Run from admin/frontend:
//   npm run demo:build && node tests/agent-runs-screens.mjs [outDir]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { setOperationsToggle } from '../../backend/src/lib/operations-toggles.js';
import { startHarness, SUDO_PASSWORD, SUDO_TOTP } from './agent-runs-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] || fileURLToPath(new URL('../../../docs/plans/assets/a6', import.meta.url));
if (!existsSync(`${root}/../frontend/dist-demo/index.html`)) throw new Error('Run npm run demo:build first');
mkdirSync(out, { recursive: true });
const WAIT = { timeout: 30000 };
const FRAME = { width: 1024, height: 640 };
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium', headless: true });

// The demo site on a loopback port, with its public fixture account.
const demoPort = 4191;
const demo = spawn(process.execPath, ['demo/server.mjs'], { cwd: root, stdio: 'ignore',
  env: { ...process.env, DEMO_HOST: '127.0.0.1', DEMO_PORT: String(demoPort) } });
const demoOrigin = `http://127.0.0.1:${demoPort}`;
for (let i = 0; ; i += 1) {
  try { if ((await fetch(demoOrigin)).ok) break; } catch { /* not up yet */ }
  if (i > 50) throw new Error('demo server did not start');
  await new Promise(done => setTimeout(done, 100));
}

async function demoFrames() {
  const ctx = await browser.newContext({ viewport: FRAME });
  const page = await ctx.newPage();
  const snap = async () => (await page.screenshot({ type: 'png' })).toString('base64');
  const frames = { none: await snap() };
  await page.goto(demoOrigin);
  const enter = page.getByRole('button', { name: /Enter the demo/ });
  await enter.waitFor(WAIT);
  await page.waitForTimeout(400);
  frames.open_landing = await snap();
  await enter.click();
  await page.locator('#demo-email').waitFor(WAIT);
  await page.waitForTimeout(400);
  frames.open_login = await snap();
  await page.locator('#demo-email').fill('demo@fractionate.ai');
  await page.locator('#demo-password').fill('welcome-demo');
  await page.locator('form button[type="submit"]').click();
  await page.getByRole('heading', { name: /Welcome in/ }).waitFor(WAIT);
  await page.waitForTimeout(400);
  frames.submit_bound_fixture = frames.read_session = frames.read_workspace = await snap();
  await page.locator('#files-heading').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  frames.read_files = await snap();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await enter.waitFor(WAIT);
  await page.waitForTimeout(400);
  frames.sign_out = await snap();
  await ctx.close();
  return frames;
}
const frames = await demoFrames();

async function harness(options) {
  const h = await startHarness({ toggles: true, delayMs: 900, ...options });
  const { f, users, p } = h.world;
  // An administrator turned the three toggles on; the administrator also runs agents here.
  for (const name of ['operations', 'agents_metadata', 'agent_runs']) setOperationsToggle(f.db, name, true, users.admin, '127.0.0.1');
  f.store.grant(users.owner, p.id, users.admin.id, f.store.get(users.owner, p.id).revision, { role: 'operator' });
  const client = h.world.supervisor.client;
  const request = client.request.bind(client);
  const pageOf = new Map();
  client.request = async (method, params) => {
    const reply = await request(method, params);
    if (method === 'action') pageOf.set(params.attempt_id, params.action);
    if (method === 'view') return { png_base64: frames[pageOf.get(params.attempt_id) ?? 'none'], ...FRAME };
    return reply;
  };
  return h;
}

let h;
const contexts = [];
async function as(role, { width = 1280, height = 860, theme = 'dark', scale = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  contexts.push(ctx);
  await ctx.addCookies([{ name: 'pp_harness_user', value: role, url: h.origin }, { name: 'pp_csrf', value: 'a6-csrf', url: h.origin }]);
  const u = h.world.users[role];
  await ctx.addInitScript(({ user, theme }) => {
    localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('mock2HintDismissed', '1'); localStorage.setItem('pp-theme', theme);
  }, { user: { id: u.id, username: u.username, role: u.role === 'admin' ? 'admin' : 'user' }, theme });
  return ctx.newPage();
}
const runsUrl = (runId) => `${h.origin}/operational-projects/${h.world.p.id}?section=${encodeURIComponent('Agent runs')}${runId ? `&run=${runId}` : ''}`;
// The app scrolls inside its own container, so a whole-screen shot grows the
// viewport to the content's height first (capped), then restores it.
const shot = async (page, name, { full = true, maxHeight = 3200 } = {}) => {
  await page.waitForTimeout(250);
  const size = page.viewportSize();
  if (full) {
    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight,
      ...[...document.querySelectorAll('main, main *')].filter(n => n.scrollHeight > n.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(n).overflowY))
        .map(n => n.scrollHeight + n.getBoundingClientRect().top)));
    await page.setViewportSize({ width: size.width, height: Math.min(Math.max(height, size.height), maxHeight) });
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 82 });
  if (full) await page.setViewportSize(size);
  console.log(`${out}/${name}.jpg`);
};
const liveFrame = page => page.getByRole('img', { name: /Live browser frame/ }).waitFor(WAIT);
async function startRun(page) {
  await page.goto(runsUrl());
  await page.getByRole('button', { name: 'Start run' }).click();
  await page.getByRole('button', { name: 'Back to agent runs' }).waitFor(WAIT);
  return new URL(page.url()).searchParams.get('run');
}
async function openApproval(page) {
  await page.getByRole('region', { name: 'Approval needed' }).waitFor(WAIT);
  await page.getByRole('button', { name: 'Review and approve' }).click();
  const digest = (await page.getByRole('dialog').getByTestId('approval-digest').innerText()).replace(/\s+/g, '');
  await page.getByLabel('Approval digest, at least the first 12 characters').fill(digest.slice(0, 12));
  await page.getByRole('dialog').getByText('Matches the digest shown (12 characters).').waitFor(WAIT);
}
async function approve(page) {
  await page.getByRole('button', { name: 'Approve submit' }).click();
  // Sudo lasts a while, so only the first approval of a session asks for it.
  await page.waitForTimeout(500);
  if (await page.getByRole('dialog').filter({ hasText: 'Confirm with password' }).isVisible().catch(() => false)) {
    await page.locator('#sudo-password').fill(SUDO_PASSWORD);
    await page.locator('#sudo-totp').fill(SUDO_TOTP);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  }
  await page.getByText('Approved. The agent may now submit the bound credential.').waitFor(WAIT);
}
const settle = async () => {
  const id = h.world.f.db.prepare(`SELECT id FROM ops_agent_runs WHERE state IN ('prepared','starting','running','cancelling') ORDER BY started_at DESC LIMIT 1`).get()?.id;
  if (id) await h.world.service.settled(id);
};
async function done() { for (const ctx of contexts.splice(0)) await ctx.close(); await settle().catch(() => {}); }

try {
  h = await harness();
  // Desktop, dark: live run waiting for approval, the approval dialog, the result.
  let page = await as('operator');
  await startRun(page);
  await liveFrame(page);
  await page.getByRole('region', { name: 'Approval needed' }).waitFor(WAIT);
  await page.waitForTimeout(1200);
  await shot(page, '01-run-live-desktop');
  await openApproval(page);
  await shot(page, '02-approval-dialog-desktop', { full: false });
  await approve(page);
  await page.getByTestId('run-result').filter({ hasText: 'Signed in and verified' }).waitFor(WAIT);
  await shot(page, '03-run-result-desktop');
  await page.goto(runsUrl());
  await page.getByText('Runs').first().waitFor(WAIT);
  await shot(page, '04-runs-overview-desktop');
  await done();

  // The Operations page an administrator sees: the toggles and the Agent inbox.
  page = await as('operator');
  await startRun(page);
  await page.getByRole('region', { name: 'Approval needed' }).waitFor(WAIT);
  const admin = await as('admin');
  await admin.goto(`${h.origin}/operational-projects`);
  await admin.getByText('Pending approvals (1)').waitFor(WAIT);
  await shot(admin, '05-operations-settings-and-inbox-desktop');
  await admin.goto(`${h.origin}/operational-projects/${h.world.p.id}?section=Agents`);
  await admin.getByText('Hard rules enforced by code').click();
  await admin.getByText('Needs a person\'s approval').waitFor(WAIT);
  await shot(admin, '06-profile-consent-and-rules-desktop');
  await page.getByRole('button', { name: 'Stop run' }).click();
  await page.getByTestId('run-result').filter({ hasText: 'Stopped' }).waitFor(WAIT);
  await done();

  // Phone (375 px), dark: the Browser pane comes first; the dialog is full-screen.
  page = await as('operator', { width: 375, height: 812, scale: 2 });
  await startRun(page);
  await liveFrame(page);
  await page.getByRole('region', { name: 'Approval needed' }).waitFor(WAIT);
  await page.waitForTimeout(1200);
  await page.getByRole('img', { name: /Live browser frame/ }).evaluate(n => n.scrollIntoView({ block: 'center' }));
  await shot(page, '07-run-live-phone', { full: false });
  await openApproval(page);
  await shot(page, '08-approval-dialog-phone', { full: false });
  await approve(page);
  await page.getByTestId('run-result').filter({ hasText: 'Signed in and verified' }).waitFor(WAIT);
  await done();

  // A help request: the agent's browser was taken over on the host.
  Object.assign(h.world.supervisor.scenario, { takeover: 'open_login' });
  page = await as('operator', { width: 768 });
  await startRun(page);
  await page.getByRole('note').filter({ hasText: 'A person needs to decide: Taken over' }).waitFor(WAIT);
  await shot(page, '09-help-taken-over-tablet');
  Object.assign(h.world.supervisor.scenario, { takeover: null });
  await done();

  // Light theme, desktop.
  page = await as('operator', { theme: 'light' });
  await startRun(page);
  await liveFrame(page);
  await page.getByRole('region', { name: 'Approval needed' }).waitFor(WAIT);
  await page.waitForTimeout(1200);
  await shot(page, '10-run-live-light-desktop');
  await page.getByRole('button', { name: 'Stop run' }).click();
  await page.getByTestId('run-result').filter({ hasText: 'Stopped' }).waitFor(WAIT);
  await done();
  await h.close();

  // What the live dashboard shows today: toggles on, no supervisor configured (A8).
  h = await harness({ execution: false });
  page = await as('operator');
  await page.goto(runsUrl());
  await page.getByText(/not connected|unavailable/i).first().waitFor(WAIT);
  await shot(page, '11-execution-unavailable-desktop');
  await done();
} finally {
  for (const ctx of contexts.splice(0)) await ctx.close();
  await h?.close();
  await browser.close();
  demo.kill();
}
