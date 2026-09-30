// A7 browser journeys against the UI harness (agent-runs-harness.mjs): the live
// view and dashboard takeover, the agent-control prompt, decisions after a run,
// resume, practice runs, the Review tab with the model summary, and layout at
// six widths. The signalling path is real (the dashboard's own Neko client →
// the live WebSocket route → the A7 service → the launcher → the scripted
// supervisor's relay); only the browser's WebRTC is stubbed (a canvas video
// and an open data channel that records the bytes it is given). Run from
// admin/frontend:   node tests/agent-runs-a7.browser.mjs
// BROWSER_EXE overrides the Chromium path; BROWSER_ARTIFACTS keeps screenshots
// and writes report-a7.json there.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { startHarness, SUDO_PASSWORD, SUDO_TOTP } from './agent-runs-harness.mjs';
import { authorizePilotSelfReview } from '../../backend/src/lib/operational-pilot-review.js';

const artifacts = process.env.BROWSER_ARTIFACTS;
if (artifacts) mkdirSync(artifacts, { recursive: true });
const report = { journeys: [], layout: [], started_at: new Date().toISOString() };
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium', headless: true });
const WAIT = { timeout: 30000 };
const contexts = [];
const shell404 = /\/api\/(branding|lxc\/containers\/snapshot-export-queue)$/;
const applied = [];
const h = await startHarness({ world: { serviceOptions: { fixtures: { apply: async (mode) => { applied.push(mode); } } } } });

// WebRTC stand-in: Neko's offer is "answered", a canvas becomes the video
// track, and the data channel records what the page sends (as byte arrays).
function stubWebRtc() {
  window.__liveInput = [];
  class Channel { constructor() { this.readyState = 'open'; this.binaryType = 'arraybuffer'; }
    send(buffer) { window.__liveInput.push([...new Uint8Array(buffer)]); } close() {} }
  window.RTCPeerConnection = class {
    constructor(config) { window.__pcConfig = config; this.connectionState = 'new'; }
    async setRemoteDescription(d) { this.remote = d; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(d) {
      this.local = d;
      setTimeout(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1280; canvas.height = 720;
        const g = canvas.getContext('2d');
        let n = 0;
        const draw = () => { g.fillStyle = '#1e3a8a'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#f8fafc'; g.fillRect(360, 200, 560, 360);
          g.fillStyle = '#0f172a'; g.font = '40px sans-serif'; g.fillText(`demo.fractionate.ai · frame ${n += 1}`, 380, 260); };
        draw(); setInterval(draw, 250);
        const stream = canvas.captureStream(8);
        this.ontrack?.({ track: stream.getVideoTracks()[0], streams: [stream] });
        this.ondatachannel?.({ channel: new Channel() });
        this.connectionState = 'connected';
        this.onconnectionstatechange?.();
      }, 30);
    }
    async addIceCandidate() {}
    close() { this.connectionState = 'closed'; }
  };
}

async function as(role, { width = 1280, height = 900, theme = 'dark', live = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  contexts.push(ctx);
  await ctx.addCookies([{ name: 'pp_harness_user', value: role, url: h.origin }, { name: 'pp_csrf', value: 'a7-csrf', url: h.origin }]);
  const u = h.world.users[role];
  await ctx.addInitScript(({ user, theme }) => {
    localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('mock2HintDismissed', '1'); localStorage.setItem('pp-theme', theme);
  }, { user: { id: u.id, username: u.username, role: 'user' }, theme });
  if (live) await ctx.addInitScript(stubWebRtc);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('response', r => { if (r.status() >= 500 || (r.status() === 404 && r.url().includes('/api/') && !shell404.test(r.url()) && !r.url().includes('/operational-projects/'))) page.errors.push(`${r.status()} ${r.url()}`); });
  return page;
}
const runsUrl = runId => `${h.origin}/operational-projects/${h.world.p.id}?section=${encodeURIComponent('Agent runs')}${runId ? `&run=${runId}` : ''}`;
function resetScenario(extra = {}) {
  for (const action of [...h.world.supervisor.scenario.holds]) h.world.supervisor.release(action);
  Object.assign(h.world.supervisor.scenario, { outcome: 'signed_in', choices: [], modelError: null, actionErrors: {},
    holds: new Set(), takeover: null, delayMs: 250, liveError: null, takeoverError: null, summaryError: null, ...extra });
}
const activeRun = () => h.world.f.db.prepare(`SELECT id FROM ops_agent_runs WHERE state IN ('prepared','starting','running','cancelling') ORDER BY started_at DESC LIMIT 1`).get()?.id;
async function settleAll() {
  const id = activeRun();
  if (id) await h.world.service.settled(id);
  const end = Date.now() + 20000;
  while (activeRun() && Date.now() < end) await new Promise(done => setTimeout(done, 50));
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
  await page.getByRole('button', { name: 'Back to runs' }).waitFor(WAIT);
  return new URL(page.url()).searchParams.get('run');
}
const approvalCard = page => page.getByRole('region', { name: 'Approval needed' });
async function sudoIfAsked(page) {
  const sudo = page.getByRole('dialog').filter({ hasText: 'Confirm with password' });
  if (await sudo.isVisible().catch(() => false)) {
    await page.locator('#sudo-password').fill(SUDO_PASSWORD);
    await page.locator('#sudo-totp').fill(SUDO_TOTP);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  }
}
async function approveInUi(page) {
  await approvalCard(page).waitFor(WAIT);
  await page.getByRole('button', { name: 'Review and approve' }).click();
  const digest = (await page.getByRole('dialog').getByTestId('approval-digest').innerText()).replace(/\s+/g, '');
  await page.getByLabel('Approval digest, at least the first 12 characters').fill(digest.slice(0, 12));
  await page.getByRole('button', { name: 'Approve submit' }).click();
  await page.waitForTimeout(300);
  await sudoIfAsked(page);
  await page.getByText('Approved. The agent may now submit the bound credential.').waitFor(WAIT);
}
// The agent-control prompt: this session's own confirmation, never sudo.
async function confirmItsMe(page) {
  const prompt = page.getByRole('dialog').filter({ hasText: 'Confirm it is you' });
  await prompt.waitFor(WAIT);
  assert.match(await prompt.innerText(), /This is not sudo/);
  await page.locator('#agent-control-password').fill(SUDO_PASSWORD);
  await page.locator('#agent-control-code').fill(SUDO_TOTP);
  await prompt.getByRole('button', { name: 'Confirm', exact: true }).click();
  await prompt.waitFor({ state: 'detached', ...WAIT });
}
const liveBox = page => page.getByTestId('live-browser');
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
    if (artifacts && [360, 768, 1280].includes(width)) await page.screenshot({ path: `${artifacts}/a7-${label}-${width}.png`, fullPage: true });
  }
}
const SIGNALLING = new Set(['client/heartbeat', 'signal/request', 'signal/answer', 'signal/candidate', 'signal/restart', 'signal/video']);

try {
  await journey('A8 demo guide: same-person approval stays disabled until the exact operator exception, then manual publication is audited', async () => {
    const { f, users } = h.world, owner = users.owner;
    const p = f.store.create(owner, { name: 'Same-person demo guide' });
    f.store.site(owner, p.id, f.store.get(owner, p.id).revision, { site_origin: 'https://demo.fractionate.ai' });
    f.store.saveDraft(owner, p.id, 1, { title: 'Pilot guide', instructions: 'Open the demo sign-in dialog.' });
    const submission = f.store.submit(owner, p.id, 2, {}).submission;
    const page = await as('owner', { width: 375, height: 800, live: false });
    const url = `${h.origin}/operational-projects/${p.id}?section=Guide`;
    await page.goto(url);
    const approve = page.getByRole('button', { name: 'Approve and publish' });
    await approve.waitFor(WAIT);
    assert.equal(await approve.isEnabled(), false);
    authorizePilotSelfReview(f.db, { owner_id: owner.id, project_id: p.id, submission_id: submission.id,
      content_hash: submission.content_hash }, { now: () => submission.submitted_at });
    await page.getByRole('button', { name: 'Refresh server state' }).click();
    await page.getByText(/Pilot exception: you may manually approve this exact submitted guide once/).waitFor(WAIT);
    assert.equal(f.store.versions(owner, p.id).versions.length, 0);
    await layoutCheck(page, 'pilot-guide-exception');
    await page.setViewportSize({ width: 375, height: 800 });
    await approve.click();
    await page.getByText('Guide approved and published.', { exact: true }).waitFor(WAIT);
    assert.equal(f.store.get(owner, p.id).current_version.approved_by, owner.id);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ops_project_events WHERE project_id=? AND action='a8_pilot_self_review_used'").get(p.id).n, 1);
    assert.deepEqual(page.errors, []);
  });
  await journey('live view and takeover: confirm it is you once, control the browser, give it back, decide, resume', async () => {
    resetScenario();
    const page = await as('operator');
    const runId = await startFromUi(page);
    await approvalCard(page).waitFor(WAIT);
    await page.locator('[data-testid="live-browser"][data-live-state="live"]').waitFor(WAIT);
    // Relay candidates only, with this viewer's own TURN credential.
    const config = await page.evaluate(() => window.__pcConfig);
    assert.equal(config.iceTransportPolicy, 'relay');
    assert.match(config.iceServers[0].username, /^[0-9]{10}:[0-9a-f]{16}$/);
    // Someone else watching at the same time.
    const other = await as('editor');
    await other.goto(runsUrl(runId));
    await other.locator('[data-testid="live-browser"][data-live-state="live"]').waitFor(WAIT);
    await page.getByRole('button', { name: 'Take over' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Take over this run?' });
    await confirm.waitFor(WAIT);
    assert.match(await confirm.innerText(), /What you type is never recorded/);
    await confirm.getByRole('button', { name: 'Take over' }).click();
    await confirmItsMe(page);
    await page.getByText('You have control of this browser.').waitFor(WAIT);
    await page.locator('[data-testid="live-browser"][data-control="mine"]').waitFor(WAIT);
    await approvalCard(page).waitFor({ state: 'detached', ...WAIT });
    // The other viewer sees who holds it, and why Take over is not offered.
    await other.getByText(/omar-operator has control since/).first().waitFor(WAIT);
    await other.locator('[data-testid="live-browser"][data-control="held"]').waitFor(WAIT);
    assert.deepEqual(await deadControls(other), []);
    // Mouse and keyboard go to the browser over the data channel, nowhere else.
    const box = await liveBox(page).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type('hi');
    await page.keyboard.press('Enter');
    await page.mouse.wheel(0, 240);
    const input = await page.evaluate(() => window.__liveInput);
    const ops = new Set(input.map(b => b[0]));
    for (const op of [0x01, 0x02, 0x03, 0x04, 0x05, 0x06]) assert.ok(ops.has(op), `op ${op} sent`);
    assert.ok(input.some(b => b[0] === 0x03 && b[6] === 0x68), 'the h key');
    const relayed = [...h.world.supervisor.viewers.values()].flatMap(v => v.received.map(m => m.event));
    assert.ok(relayed.every(e => SIGNALLING.has(e)), `only signalling was relayed: ${relayed.join(',')}`);
    assert.equal(JSON.stringify(h.world.supervisor.calls).includes('"hi'), false);
    assert.deepEqual(h.world.supervisor.calls.filter(c => c.method === 'takeover').length, 1);
    await page.getByRole('button', { name: 'Give back and end run' }).click();
    const end = page.getByRole('dialog').filter({ hasText: 'Give the browser back?' });
    await end.getByRole('button', { name: 'Give back and end run' }).click();
    await page.getByTestId('reconcile').waitFor(WAIT);
    assert.equal(h.world.supervisor.calls.find(c => c.method === 'stop' && c.params.run_id === runId).params.reason, 'taken_over');
    // The help request, acknowledged in this session without another prompt.
    await page.getByTestId('reconcile-run').getByRole('button', { name: 'Acknowledge' }).click();
    await page.getByTestId('reconcile-run').getByText('Decided').waitFor(WAIT);
    assert.equal(await page.getByRole('dialog').filter({ hasText: 'Confirm it is you' }).count(), 0);
    // Review: the takeover is counted, never what was typed.
    await page.getByRole('tab', { name: 'Review' }).click();
    const review = await page.getByTestId('run-review').innerText();
    assert.match(review, /omar-operator took over/);
    assert.match(review, /keys, \d+ clicks, \d+ scrolls \(what was typed is never recorded\)/);
    // Resume: a new linked run.
    await page.getByRole('button', { name: 'Resume as a new run' }).click();
    await page.waitForURL(url => new URL(url).searchParams.get('run') !== runId, WAIT);
    await page.getByRole('button', { name: `Resumes run ${runId.slice(0, 8)}` }).waitFor(WAIT);
    await page.getByRole('button', { name: 'Stop run' }).click();
    assert.deepEqual([...page.errors, ...other.errors], []);
  });

  await journey('a timed-out sign-in blocks the profile until a person decides it (360 px)', async () => {
    resetScenario({ outcome: 'timeout' });
    const page = await as('editor', { width: 360, height: 780, live: false });
    const runId = await startFromUi(page);
    await approveInUi(page);
    await page.getByTestId('reconcile').waitFor(WAIT);
    await page.getByText('Blocks the next start').waitFor(WAIT);
    // A8: command completion is useful evidence, never an automatic decision.
    const record = page.getByTestId('supervisor-record');
    await record.getByText(/Supervisor recorded: done\. Reserved at/).waitFor(WAIT);
    await record.getByText(/uncertain site outcome/).waitFor(WAIT);
    const step = h.world.supervisor.calls.filter(c => c.method === 'step_record').at(-1);
    assert.equal(step.params.action, 'submit_bound_fixture');
    assert.equal(step.params.ordinal, 3);
    await layoutCheck(page, 'reconcile');
    await page.goto(runsUrl());
    await page.getByText(/may or may not have happened/).first().waitFor(WAIT);
    assert.equal(await page.getByRole('button', { name: 'Start run' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Open the run to decide' }).click();
    await page.waitForURL(url => new URL(url).searchParams.get('run') === runId, WAIT);
    const item = page.locator('[data-testid^="reconcile-step:"]');
    await item.getByRole('button', { name: 'It happened' }).click();
    await confirmItsMe(page);
    await item.getByText('Decided').waitFor(WAIT);
    await page.goto(runsUrl());
    await page.getByRole('button', { name: 'Start run' }).and(page.locator(':enabled')).waitFor(WAIT);
    assert.deepEqual(page.errors, []);
  });

  await journey('practice run: choose the demo behaviour; the Review tab says it matched; the model summary is shown', async () => {
    resetScenario({ outcome: 'challenge_required' });
    const owner = await as('owner', { live: false });
    await owner.goto(`${h.origin}/operational-projects/${h.world.p.id}?section=Agents`);
    await owner.getByLabel(/I reviewed: Send this profile's finished runs/).check();
    await owner.getByRole('button', { name: 'Allow summaries' }).click();
    await owner.getByText('Model summaries of finished runs: allowed').waitFor(WAIT);
    const page = await as('operator', { width: 375, height: 800, live: false });
    await page.goto(runsUrl());
    await page.getByRole('button', { name: 'Practice run…' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Start a practice run' });
    await dialog.waitFor(WAIT);
    await layoutCheck(page, 'practice-dialog', { dialog: true });
    await page.setViewportSize({ width: 375, height: 800 });
    await dialog.getByLabel(/Extra check/).check();
    await dialog.getByRole('button', { name: 'Start practice run' }).click();
    await page.getByText('Practice: Extra check').first().waitFor(WAIT);
    await approveInUi(page);
    // On a phone the result is in the Activity panel, not shown beside Browser.
    await page.getByTestId('feed-result').waitFor({ state: 'attached', ...WAIT });
    await page.getByRole('navigation', { name: 'Run panels' }).getByRole('button', { name: /^Details/ }).click();
    await page.getByRole('tab', { name: 'Review' }).click();
    await page.getByText(/produced the expected result \(Challenge required\)/).waitFor(WAIT);
    await page.getByTestId('run-summary').getByText(h.world.supervisor.scenario.summaryText).waitFor(WAIT);
    await layoutCheck(page, 'review');
    assert.deepEqual(applied.slice(-2), ['challenge', 'normal']);
    assert.deepEqual([...page.errors, ...owner.errors], []);
  });

  await journey('no live install: a quiet note and still frames, no retry', async () => {
    resetScenario({ liveError: 'LIVE_UNAVAILABLE' });
    const page = await as('operator', { live: false });
    await startFromUi(page);
    await page.getByText('Live video is not set up on this installation; still frames are shown.').waitFor(WAIT);
    await page.getByRole('img', { name: /Live browser frame/ }).waitFor(WAIT);
    assert.equal(await page.getByRole('button', { name: 'Try live video again' }).count(), 0);
    await page.getByRole('button', { name: 'Stop run' }).click();
    assert.deepEqual(page.errors, []);
  });

  await journey('layout: live pane, takeover bar, confirmation and the agent-control prompt at six widths', async () => {
    resetScenario();
    const page = await as('reviewer');
    await startFromUi(page);
    await page.locator('[data-testid="live-browser"][data-live-state="live"]').waitFor(WAIT);
    await layoutCheck(page, 'live-pane');
    assert.deepEqual(await deadControls(page), []);
    // Calls from earlier journeys stay on the scripted supervisor.
    const before = h.world.supervisor.calls.length;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Take over' }).click();
    await layoutCheck(page, 'takeover-confirm', { dialog: true });
    await page.getByRole('dialog').getByRole('button', { name: 'Take over' }).click();
    await page.getByRole('dialog').filter({ hasText: 'Confirm it is you' }).waitFor(WAIT);
    await layoutCheck(page, 'agent-control-prompt', { dialog: true });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByText(/Verification cancelled/).waitFor(WAIT);
    assert.equal(h.world.supervisor.calls.slice(before).some(c => c.method === 'takeover'), false);
    await page.getByRole('button', { name: 'Stop run' }).click();
    assert.deepEqual(page.errors, []);
  });
} finally {
  for (const ctx of contexts.splice(0)) await ctx.close();
  await h.close();
  await browser.close();
  report.finished_at = new Date().toISOString();
  if (artifacts) writeFileSync(`${artifacts}/report-a7.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.journeys.filter(j => j.passed).length}/${report.journeys.length} journeys, ${report.layout.length} layout checks`);
}
