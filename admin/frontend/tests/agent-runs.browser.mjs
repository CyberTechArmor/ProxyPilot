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
import { guideWith, baseRules } from '../../backend/src/__tests__/helpers/agent-runs-world.js';
import { startHarness, SUDO_PASSWORD, SUDO_TOTP } from './agent-runs-harness.mjs';

const artifacts = process.env.BROWSER_ARTIFACTS;
if (artifacts) mkdirSync(artifacts, { recursive: true });
const report = { journeys: [], layout: [], started_at: new Date().toISOString() };
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium', headless: true });
const WAIT = { timeout: 30000 };
let h;
const contexts = [];
const shell404 = /\/api\/(branding|lxc\/containers\/snapshot-export-queue)$/;

async function as(role, { width = 1280, theme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  contexts.push(ctx);
  await ctx.addCookies([{ name: 'pp_harness_user', value: role, url: h.origin }, { name: 'pp_csrf', value: 'a6-csrf', url: h.origin }]);
  const u = h.world.users[role];
  await ctx.addInitScript(({ user, theme }) => {
    localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('mock2HintDismissed', '1'); localStorage.setItem('pp-theme', theme);
  }, { user: { id: u.id, username: u.username, role: 'user' }, theme });
  const page = await ctx.newPage();
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
  await page.getByRole('button', { name: 'Back to agent runs' }).waitFor(WAIT);
  return new URL(page.url()).searchParams.get('run');
}
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
const result = (page, label) => page.getByTestId('run-result').filter({ hasText: label }).waitFor(WAIT);
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
    await viewer.getByText('Agent runs are not available to you: Agent runs need run access: owner, operator, editor or reviewer.').waitFor(WAIT);
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
    assert.equal(await outsider.getByRole('heading', { name: 'Agent runs' }).count(), 0);
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
    await page.getByRole('button', { name: 'Back to agent runs' }).click();
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
      [{ outcome: 'timeout' }, 'Timed out', false, true],
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
      if (help) await page.getByRole('note').filter({ hasText: `A person needs to decide: ${label}` }).waitFor(WAIT);
      else assert.equal(await page.getByRole('note').filter({ hasText: 'A person needs to decide' }).count(), 0, label);
      report.result_classes.push({ label, help });
      await settleAll();
    }
    // A restart while a run is active: fenced, never resumed, needs a person.
    resetScenario({ holds: new Set(['open_login']) });
    const runId = await startFromUi(page);
    await page.getByTestId('step-2').filter({ hasText: 'in progress' }).waitFor(WAIT);
    await createRunCoordinator({ db: h.world.f.db, launcher: h.world.supervisor.launcher, verifyTeardown: h.world.supervisor.verifyTeardown }).recover();
    await result(page, 'Interrupted');
    await page.getByRole('note').filter({ hasText: 'A person needs to decide: Interrupted' }).waitFor(WAIT);
    await page.getByText('Error: COORDINATOR_RESTART').waitFor(WAIT);
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
      await page.goto(`${h.origin}/operational-projects`);
      await page.getByText('Pending approvals (1)').waitFor(WAIT);
      await layoutCheck(page, `inbox-${theme}`);
      await page.goto(runsUrl());
      await page.getByText('Runs').first().waitFor(WAIT);
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
report.passed = report.journeys.every(j => j.passed);
report.finished_at = new Date().toISOString();
if (artifacts) writeFileSync(`${artifacts}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ a6_browser_journeys: report.passed ? 'passed' : 'failed', journeys: report.journeys.length,
  layout_checks: report.layout.length }));
if (!report.passed) process.exitCode = 1;
