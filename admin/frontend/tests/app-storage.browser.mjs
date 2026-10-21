// Application storage journeys on the real app (providers, Layout, api.js,
// sudo modal, the page and its components); only HTTP responses are
// fixtures (page.route('**/api/**') → tests/app-storage-harness.mjs, shaped
// like DESIGN §2.6 / §6). Run from admin/frontend:
//   node tests/app-storage.browser.mjs
// Env: BROWSER_EXE (default /opt/pw-browsers/chromium), UI_EVIDENCE_DIR (screenshots).
import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { createWorld, USER } from './app-storage-harness.mjs';
import { CHECK_ID, CLEANUP_ID, NEW_CHECK_ID, nodusCheck } from './fixtures/app-storage-fixture.mjs';
import { ALL_ELIGIBLE_SCOPE, SNAPSHOT_ACK, SNAPSHOT_WARNING } from '../src/components/app-storage/app-storage-text.js';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const WIDTHS = [360, 375, 768, 1280, 1920];
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
// One clock for the reference check and every world, so item ids match.
const NOW = Date.now();
const ref = nodusCheck(NOW);
const byLabel = (label) => ref.items.find((i) => i.label === label);
const ELIGIBLE_FILES = ref.items.filter((i) => i.status === 'eligible' && !['snapshots', 'exports'].includes(i.category));
const ALL_CHECKBOXES = ref.items.filter((i) => i.status === 'eligible' && i.kind !== 'pseudo');

// Isolated render of the Releases tab panel with a fake client, to follow its "Storage" link.
const LINKS_HTML = `${root}/__app-storage-links.html`;
const LINKS_JSX = `${root}/__app-storage-links.jsx`;
writeFileSync(LINKS_HTML, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__app-storage-links.jsx"></script></body></html>');
writeFileSync(LINKS_JSX, `import React from 'react'; import { createRoot } from 'react-dom/client'; import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ApplicationReleases from './src/components/mock2/ApplicationReleases.jsx'; import './src/index.css';
const client = { listApplications: async () => ({ applications: [{ id: 1, name: 'Nodus', profile: { revision: 6, sourceDir: '/opt/nodus', serviceName: 'nodus.service', remoteBranch: 'main' }, candidates: [] }] }), mock2ListGitConnectors: async () => [], listApplicationReleaseJobs: async () => ({ jobs: [] }), getApplicationReleaseJob: async () => ({}) };
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p>; }
createRoot(document.getElementById('root')).render(<MemoryRouter><Where /><Routes><Route path="*" element={<main style={{ padding: 16 }}><ApplicationReleases containerName="nodus" client={client} /></main>} /></Routes></MemoryRouter>);`);

const server = await createServer({ root, configFile: `${root}/vite.config.js`, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [];
const ok = (msg) => { passed.push(msg); };

async function newPage(world) {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'pp_csrf', value: 'storage-csrf', url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((user) => { localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('mock2HintDismissed', '1'); }, USER);
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const res = world.handle(req.method(), req.url(), body, req.headers());
    await route.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.body) });
  });
  return { page, context, errors };
}

/** No horizontal scroll on the page, in main, or in an open dialog; touch targets on phones. */
async function layoutCheck(page, width, label) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  await page.addStyleTag({ content: 'html,body{overflow-x:visible !important}' });
  const overflow = await page.evaluate(() => {
    const roots = [document.querySelector('main'), ...document.querySelectorAll('[role=dialog]')].filter(Boolean);
    const nodes = [document.documentElement, ...roots.flatMap((r) => [r, ...r.querySelectorAll('*')])];
    return nodes.filter((n) => n.clientWidth && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'hidden')
      .map((n) => ({ tag: n.tagName, cls: String(n.className).slice(0, 80), width: n.clientWidth, scroll: n.scrollWidth }));
  });
  assert.deepEqual(overflow, [], `${label}: horizontal overflow at ${width}px`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: page scrolls sideways at ${width}px`);
  if (width < 640) {
    const small = await page.evaluate(() => [...document.querySelectorAll('main button, main a[class*="h-11"], [role=dialog] button')]
      .filter((b) => b.offsetParent !== null && !b.closest('.sr-only') && b.querySelector('.sr-only')?.textContent !== 'Close')
      .map((b) => { const r = b.getBoundingClientRect(); return { text: (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((b) => b.h < 44 || b.w < 44));
    assert.deepEqual(small, [], `${label}: touch targets under 44px at ${width}px`);
  }
  await shot(page, `${label}-${width}`);
}

/** Evidence screenshot. Without a dialog the Layout's inner scroll area is unclipped so the whole page is captured. */
async function shot(page, name) {
  if (!evidence) return;
  const dialog = await page.locator('[role=dialog]').count();
  const tag = dialog ? null : await page.addStyleTag({ content: '#root > div.h-viewport{height:auto !important;overflow:visible !important} main.h-viewport{height:auto !important} main > div.relative{overflow:visible !important}' });
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
  if (tag) await tag.evaluate((n) => n.remove());
}

const summary = (page) => page.getByTestId('selection-summary').innerText();
const review = (page) => page.getByRole('button', { name: 'Review cleanup' });
async function expandAll(page) {
  for (;;) {
    const closed = page.locator('section[data-category] > div > button[aria-expanded="false"]');
    if (!(await closed.count())) break;
    await closed.first().click();
  }
}

try {
  /* ---------------------------- layout at every width ---------------------------- */
  {
    const world = createWorld(NOW);
    const { page, errors, context } = await newPage(world);
    await page.goto(`${origin}/storage/applications`);
    await page.getByRole('heading', { name: 'Application storage', level: 1 }).waitFor();
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.locator(w >= 1024 ? 'table' : 'main div[data-target="application:1"]').first().waitFor();
      await layoutCheck(page, w, 'overview');
    }
    ok(`overview: no horizontal scroll at ${WIDTHS.join('/')} px, 44 px targets below sm`);

    await page.goto(`${origin}/storage/applications?target=application:1`);
    await page.getByRole('heading', { name: 'Nodus', level: 1 }).waitFor();
    await expandAll(page);
    for (const w of WIDTHS) await layoutCheck(page, w, 'detail');
    ok(`detail with every category open: no horizontal scroll at ${WIDTHS.join('/')} px`);

    await page.getByRole('checkbox', { name: `Select ${byLabel('Release 9d1e7a0c').label}` }).check();
    await page.getByRole('checkbox', { name: `Select ${byLabel('pp-mcp-pre-resources-20261012-0912').label}` }).check();
    await review(page).click();
    await page.getByRole('dialog').getByText('Review cleanup', { exact: true }).waitFor();
    for (const w of WIDTHS) {
      await layoutCheck(page, w, 'review');
      const box = await page.getByRole('dialog').boundingBox();
      if (w < 640) assert.ok(box.width >= w - 1 && box.x <= 1, `review dialog is full screen at ${w}px`);
    }
    ok(`review dialog: full screen below sm, no horizontal scroll at ${WIDTHS.join('/')} px`);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.match(await summary(page), /^2 selected/, 'closing the review keeps the selection');
    assert.equal(world.state.cleanupAttempts, 0, 'closing the review sends nothing');
    ok('375px: the review closes with its X, keeps the selection and sends nothing');

    await page.goto(`${origin}/storage/applications?target=application:1&tab=rules`);
    await page.getByTestId('policy-source').waitFor();
    for (const w of WIDTHS) await layoutCheck(page, w, 'rules');
    ok(`rules and alerts: no horizontal scroll at ${WIDTHS.join('/')} px`);
    assert.deepEqual(errors, [], 'no page errors');
    await context.close();
  }

  /* ------------------------------- behaviour ------------------------------- */
  for (const width of [375, 1280]) {
    const world = createWorld(NOW);
    const { page, errors, context } = await newPage(world);
    await page.setViewportSize({ width, height: 900 });

    // Overview: the sidebar entry and a per-row storage check that polls until done.
    await page.goto(`${origin}/storage/applications`);
    await page.getByRole('heading', { name: 'Application storage', level: 1 }).waitFor();
    if (width >= 768) assert.ok(await page.getByRole('link', { name: 'Application storage' }).isVisible(), 'sidebar entry');
    const scope = page.locator(width >= 1024 ? 'table [data-target="project:7"]' : 'main div[data-target="project:7"]');
    await scope.getByRole('button', { name: /Request storage check/ }).click();
    await scope.getByRole('button', { name: /Checking/ }).waitFor();
    await scope.getByRole('button', { name: /Request storage check/ }).waitFor({ timeout: 15000 });
    assert.deepEqual(world.state.checkRequests.map((r) => r.key), ['project:7']);
    assert.equal(world.state.checkRequests[0].csrf, 'storage-csrf');
    assert.ok(world.state.checkPolls.get('chk_project-7-0') >= 2, 'GET /checks/:id polled until finished');
    await scope.getByText('6.4 GB can be cleaned up', { exact: false }).waitFor();
    const nodusRow = page.locator(width >= 1024 ? 'table [data-target="application:1"]' : 'main div[data-target="application:1"]');
    await nodusRow.getByText('on disk, with snapshots').waitFor();
    await nodusRow.getByText('3.6 GB of files in the container', { exact: false }).waitFor();
    if (width >= 1024) await page.getByRole('columnheader', { name: 'Disk used now' }).waitFor();
    ok(`${width}px: the overview says which "used" is which — disk with snapshots now, files in the container at the last check`);
    ok(`${width}px: overview "Request storage check" shows Checking… and polls GET /checks/:id until finished`);

    // Detail: nothing preselected, Review disabled at 0, protected items have no checkbox.
    await page.goto(`${origin}/storage/applications?target=application:1`);
    await page.getByRole('heading', { name: 'Nodus', level: 1 }).waitFor();
    await page.getByText('/tmp uses memory, not disk', { exact: false }).waitFor();
    await page.getByText('Held by snapshots', { exact: true }).waitFor();
    await page.getByText('Some folders under /tmp:', { exact: false }).waitFor();
    await expandAll(page);
    const boxes = page.locator('main input[type=checkbox]');
    assert.equal(await boxes.count(), ALL_CHECKBOXES.length, 'one checkbox per "Can be cleaned up" item');
    for (const b of await boxes.all()) assert.equal(await b.isChecked(), false, 'nothing preselected');
    for (const label of ['Live release 3c932650', 'Rollback release 62a4fbff', 'Adopted checkout c5adcdaf', '/opt/nodus-w48', 'Database files', 'tsx-989']) {
      assert.equal(await page.locator(`[data-item="${byLabel(label).id}"] input[type=checkbox]`).count(), 0, `no checkbox for ${label}`);
    }
    assert.ok(await page.locator(`[data-item="${byLabel('/opt/nodus-w48').id}"]`).getByText('Needs a look').isVisible());
    assert.ok(await page.locator(`[data-item="${byLabel('/opt/nodus-w48').id}"]`).getByText('A leftover working copy: its .git link no longer resolves.').isVisible());
    assert.equal(await summary(page), '0 selected');
    assert.equal(await review(page).isDisabled(), true, 'Review cleanup disabled at 0');
    await page.getByText('Used by files', { exact: true }).waitFor();
    await page.getByText('Files inside the container.', { exact: true }).waitFor();
    await page.getByText('On disk, with snapshots:', { exact: false }).waitFor();
    for (const label of ['Abandoned browser download', 'tsx-989', 'nodus-embed-* (263 folders)']) {
      assert.equal(await page.locator(`[data-item="${byLabel(label).id}"]`).getByText('Uses memory, not disk', { exact: false }).count(), 1, `${label}: the memory note appears once`);
    }
    for (const sec of await page.locator('section[data-category]').all()) {
      if (await sec.getByText('Some can be cleaned up', { exact: true }).count()) assert.ok(await sec.getByRole('button', { name: /Select all|Clear/ }).count(), 'a "Some can be cleaned up" category has something to select');
    }
    ok(`${width}px: nothing preselected (${ALL_CHECKBOXES.length} checkboxes, all clear), protected / needs-a-look items have none, Review disabled at 0`);

    // Group members: first 50 of 263.
    const group = page.locator(`[data-item="${byLabel('nodus-embed-* (263 folders)').id}"]`);
    await group.getByRole('button', { name: 'Show 50 of 263 folders' }).click();
    assert.equal(await group.locator('ul li').count(), 50);
    await group.getByText('213 more not shown', { exact: false }).waitFor();
    ok(`${width}px: a group expands to its first 50 members`);

    // Select one → review → deselect → count updates; nothing is sent.
    await page.getByRole('checkbox', { name: 'Select Release 9d1e7a0c' }).check();
    assert.equal(await summary(page), '1 selected · about 497 MB can be recovered');
    await review(page).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Clean up 1 item' }).waitFor();
    assert.equal(await dialog.getByTestId('review-estimate').innerText(), 'about 497 MB');
    await dialog.getByText('Space held by snapshots is only returned after those snapshots are deleted.').waitFor();
    await dialog.getByRole('button', { name: 'Remove Release 9d1e7a0c from the cleanup' }).click();
    assert.equal(await dialog.getByRole('button', { name: 'Clean up 0 items' }).isDisabled(), true);
    await dialog.getByText('Nothing is selected.', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await summary(page), '0 selected');
    assert.equal(await page.getByRole('checkbox', { name: 'Select Release 9d1e7a0c' }).isChecked(), false);
    assert.equal(await review(page).isDisabled(), true);
    assert.equal(world.state.cleanupAttempts, 0, 'nothing selected → no request');
    ok(`${width}px: select one → review → remove it there → the page count returns to 0; no request sent`);

    // All that can be cleaned up: excludes snapshots and exports.
    await page.getByText(ALL_ELIGIBLE_SCOPE).waitFor();
    await page.getByRole('button', { name: 'Select everything that can be cleaned up' }).click();
    assert.match(await summary(page), new RegExp(`^${ELIGIBLE_FILES.length} selected · `));
    for (const label of ['pp-mcp-pre-resources-20261012-0912', 'pp-pre-restore-62348a2a-k2j1', 'pp-nodus-20261019.tar.zst']) {
      assert.equal(await page.getByRole('checkbox', { name: `Select ${label}` }).isChecked(), false, `${label} not selected`);
    }
    assert.equal(await page.getByText(SNAPSHOT_ACK).count(), 0, 'no acknowledgement without snapshots');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    assert.equal(await summary(page), '0 selected');
    ok(`${width}px: "Select everything that can be cleaned up" selects ${ELIGIBLE_FILES.length} items and no snapshot or export`);

    // Category select, then clear it.
    await page.locator('section[data-category="caches"]').getByRole('button', { name: /Select all/ }).click();
    assert.match(await summary(page), /^4 selected/);
    await page.locator('section[data-category="caches"]').getByRole('button', { name: /^Clear/ }).click();
    assert.equal(await summary(page), '0 selected');
    ok(`${width}px: a category's "Select all" selects its 4 items and "Clear" deselects them`);

    // Snapshot selection needs the acknowledgement.
    await page.getByRole('checkbox', { name: 'Select Release 9d1e7a0c' }).check();
    await page.getByRole('checkbox', { name: 'Select pp-mcp-pre-resources-20261012-0912' }).check();
    await page.getByText(SNAPSHOT_ACK).first().waitFor();
    assert.match(await summary(page), /^2 selected/);
    await review(page).click();
    await dialog.getByText(SNAPSHOT_WARNING).waitFor();
    const go = dialog.getByRole('button', { name: 'Clean up 2 items' });
    assert.equal(await go.isDisabled(), true, 'disabled until the snapshot warning is acknowledged');
    await dialog.getByRole('checkbox', { name: SNAPSHOT_ACK }).check();
    assert.equal(await go.isDisabled(), false);
    ok(`${width}px: a selected snapshot shows the warning and "Clean up" stays disabled until acknowledged`);

    // The one approval: POST → sudo prompt → replay → progress → result; no other confirmation.
    await go.click();
    const sudo = page.getByRole('dialog').filter({ has: page.getByLabel('Password') });
    await sudo.getByLabel('Password').fill('correct horse');
    await sudo.getByLabel('Authenticator Code').fill('123456');
    await sudo.getByRole('button', { name: 'Confirm', exact: true }).click();
    await sudo.waitFor({ state: 'detached' });
    await page.getByRole('dialog').getByText('Cleanup result').waitFor({ timeout: 15000 });
    assert.equal(await page.getByRole('dialog').count(), 1, 'only the cleanup dialog is open — no extra confirmation');
    assert.equal(world.state.sudoPosts, 1);
    assert.equal(world.state.cleanupAttempts, 2, 'the sudo prompt replays the same POST once');
    assert.equal(world.state.cleanupPosts.length, 1);
    assert.deepEqual(world.state.cleanupPosts[0].body, {
      checkId: CHECK_ID, items: [byLabel('Release 9d1e7a0c').id], snapshots: [byLabel('pp-mcp-pre-resources-20261012-0912').id], exports: [], acknowledgeSnapshotLoss: true, scope: 'items',
    });
    assert.equal(world.state.cleanupPosts[0].csrf, 'storage-csrf');
    assert.ok(world.state.cleanupPolls >= 2, 'GET /cleanups/:id polled until finished');
    assert.equal(new URL(page.url()).searchParams.get('cleanup'), CLEANUP_ID);
    const result = page.getByRole('dialog');
    await result.getByText('Cleanup finished, but some items were skipped or failed.').waitFor();
    await result.getByRole('region', { name: 'Skipped' }).getByText('Changed since the check: it was modified after the storage check, so it was left alone.').waitFor();
    await result.getByRole('region', { name: 'Removed' }).getByText('pp-mcp-pre-resources-20261012-0912').waitFor();
    await result.getByText('The application is running and answered its health check.').waitFor();
    await result.getByText('The filesystem may still be releasing space, or snapshots still hold it; check again in a few minutes.').waitFor();
    await result.getByText('Space reclaimed (measured)').waitFor();
    await result.getByText('Storage now').waitFor();
    await layoutCheck(page, width, 'result');
    ok(`${width}px: "Clean up 2 items" → one sudo prompt → the same POST replayed with the explicit ids → progress → result with skipped reasons, health, reclaimed, settling note`);

    // Run a new check from the result: the dialog closes and the check polls to its end.
    await result.getByRole('button', { name: 'Run a new check' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).searchParams.get('cleanup'), null);
    await page.getByRole('button', { name: /Checking/ }).first().waitFor();
    await page.getByRole('button', { name: 'Request storage check' }).first().waitFor({ timeout: 15000 });
    assert.equal(world.state.latestCheck.checkId, NEW_CHECK_ID);
    assert.equal(await summary(page), '0 selected', 'a new check starts with nothing selected');
    ok(`${width}px: "Run a new check" closes the result, polls the new check and starts with nothing selected`);

    // Past cleanups → View result.
    await page.getByRole('tab', { name: 'Past cleanups' }).click();
    await page.getByRole('button', { name: 'View result' }).click();
    await page.getByRole('dialog').getByText('Cleanup result').waitFor({ timeout: 15000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    ok(`${width}px: a past cleanup reopens its result`);

    // Rules and alerts: proposed state, source badge, effects, Turn on (one PUT with the revision).
    await page.getByRole('tab', { name: 'Rules and alerts' }).click();
    assert.equal(await page.getByTestId('policy-source').innerText(), "Kept from Nodus's existing settings");
    const caches = page.locator('[data-rule="caches"]');
    await caches.getByText('Proposed', { exact: true }).waitFor();
    await caches.getByText('Suggested. Nothing runs until you turn it on; then it runs every 6 hours.').waitFor();
    await page.locator('[data-rule="releases"]').getByText('On', { exact: true }).waitFor();
    await page.locator('[data-rule="tempFiles"]').getByText('Would remove 4 items, about 181 MB, now.', { exact: false }).waitFor();
    await page.getByTestId('alerts-summary').getByText('Warns above 10 GB, or when it grows by 2 GB within 24 hours.').waitFor();
    await page.locator('[data-rule="snapshots"]').getByText('On: it runs whenever a snapshot is taken, and each time ProxyPilot starts.').waitFor();
    assert.equal(await page.getByTestId('policy-changed').innerText(), 'Not changed here yet.');
    assert.equal(await page.getByText('No storage check has run yet').count(), 0, 'no nudge when a check exists');
    await shot(page, `rules-proposed-${width}`);
    await caches.getByRole('button', { name: /Turn on/ }).click();
    await caches.getByText('On', { exact: true }).waitFor();
    assert.equal(world.state.policyPuts.length, 1);
    assert.equal(world.state.policyPuts[0].body.expectedRevision, 1);
    assert.equal(world.state.policyPuts[0].body.policy.rules.caches.enabled, true);
    assert.equal(world.state.policyPuts[0].body.policy.rules.tempFiles.enabled, false, 'other rules unchanged');
    await page.locator('[data-rule="tempFiles"]').getByText('Proposed', { exact: true }).waitFor();
    await page.getByTestId('policy-changed').getByText(/^Last changed just now \(.+\) by user #1\.$/).waitFor();
    // An out-of-range value cannot be saved.
    const keep = page.locator('[data-rule="releases"]').getByLabel('Releases to keep (2 to 20)');
    await keep.fill('1');
    await page.locator('[data-rule="releases"]').getByText('Enter a whole number from 2 to 20.').waitFor();
    assert.equal(await page.locator('[data-rule="releases"]').getByRole('button', { name: /^Save/ }).isDisabled(), true);
    ok(`${width}px: rules show the source badge, On / Proposed, the effects preview; Turn on sends one PUT with expectedRevision; invalid values cannot be saved`);

    assert.deepEqual(world.state.unexpected, [], 'no unexpected API calls');
    assert.deepEqual(errors, [], 'no page errors');
    await context.close();
  }

  /* ------------------------ rules before any check ------------------------ */
  {
    const world = createWorld(NOW, { noCheck: true });
    const { page, errors, context } = await newPage(world);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${origin}/storage/applications?target=application:1&tab=rules`);
    await page.getByTestId('policy-source').waitFor();
    const nudge = page.getByTestId('policy-no-check');
    await nudge.getByText('No storage check has run yet').waitFor();
    await page.locator('[data-rule="tempFiles"]').getByText('No storage check yet, so what this rule would remove is not known.', { exact: false }).waitFor();
    assert.equal(await page.locator('[data-rule="tempFiles"]').getByText('Nothing would be removed now.', { exact: false }).count(), 0, 'no invented effect without a check');
    assert.equal(await page.locator('[data-rule="tempFiles"]').getByRole('button', { name: /Turn on/ }).isDisabled(), false, 'the nudge never blocks');
    for (const w of [360, 375]) await layoutCheck(page, w, 'rules-no-check');
    await page.setViewportSize({ width: 375, height: 812 });
    await nudge.getByRole('button', { name: 'Request storage check' }).click();
    await nudge.waitFor({ state: 'detached', timeout: 15000 });
    await page.locator('[data-rule="tempFiles"]').getByText('Would remove 4 items', { exact: false }).waitFor();
    assert.deepEqual(world.state.checkRequests.map((r) => r.key), ['application:1']);
    assert.deepEqual(errors, []);
    ok('375px: before any check, the rules tab says so and offers "Request storage check" (Turn on stays available); after the check the nudge goes and the real effects show');
    await context.close();
  }

  /* ------------------------ refusal paths from the server ------------------------ */
  {
    const world = createWorld(NOW);
    world.state.sudoArmed = false;
    const base = world.handle;
    let refusal = 'CHECK_STALE';
    world.handle = (method, url, body, headers) => {
      if (method === 'POST' && /\/cleanups$/.test(new URL(url).pathname) && refusal) {
        world.state.cleanupAttempts += 1;
        if (refusal === 'CHECK_STALE') return { status: 409, body: { error: { code: 'CHECK_STALE', message: 'Run a new storage check first; this one is from 21:58.' } } };
        return { status: 409, body: { error: { code: 'NOT_ELIGIBLE', message: 'Some items can no longer be cleaned up.', items: [{ id: body.items[0], reason: 'Now protected: a build is using it.' }] } } };
      }
      return base(method, url, body, headers);
    };
    const { page, errors, context } = await newPage(world);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${origin}/storage/applications?target=application:1`);
    await page.getByRole('heading', { name: 'Nodus', level: 1 }).waitFor();
    await expandAll(page);
    await page.getByRole('checkbox', { name: 'Select Build workspace 6f0c2a11' }).check();
    await page.getByRole('checkbox', { name: 'Select npm downloads' }).check();
    await review(page).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Clean up 2 items' }).click();
    await dialog.getByText('Run a new storage check first; this one is from 21:58.').waitFor();
    await dialog.getByRole('button', { name: 'Run a new check' }).waitFor();
    refusal = 'NOT_ELIGIBLE';
    await dialog.getByRole('button', { name: 'Clean up 2 items' }).click();
    await dialog.getByText('Now protected: a build is using it.').waitFor();
    await dialog.getByRole('button', { name: 'Remove these from the cleanup' }).click();
    await dialog.getByRole('button', { name: 'Clean up 1 item' }).waitFor();
    await layoutCheck(page, 360, 'review-refused');
    assert.equal(world.state.cleanupPosts.length, 0);
    assert.deepEqual(errors, []);
    ok('360px: CHECK_STALE offers "Run a new check"; NOT_ELIGIBLE marks the refused item with its reason and removes it on request');
    await context.close();
  }

  /* ----------------------- link from the Releases tab ----------------------- */
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const w of [360, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.goto(`${origin}/__app-storage-links.html`);
      const link = page.getByRole('link', { name: 'Storage' });
      await link.waitFor();
      const box = await link.boundingBox();
      assert.ok(box.height >= 44, 'Storage link is a 44 px target');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `releases panel overflow at ${w}`);
      await link.click();
      await page.getByTestId('where').getByText('/storage/applications?target=application%3A1', { exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    await page.close();
    ok('Releases tab: the "Storage" button links to /storage/applications?target=application:1 (360 / 1280 px)');
  }

  console.log(passed.map((p) => `ok - ${p}`).join('\n'));
  console.log(`\n${passed.length} journey checks passed.`);
} finally {
  await browser.close();
  await server.close();
  for (const f of [LINKS_HTML, LINKS_JSX]) { try { unlinkSync(f); } catch { /* already gone */ } }
}
