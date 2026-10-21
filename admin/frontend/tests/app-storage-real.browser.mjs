// Application storage against the REAL backend: the real app (providers,
// Layout, api.js, sudo modal, the page) with every /api call forwarded by
// page.route to an in-process Express server that mounts the real
// /api/app-storage routes over the real storage instance and cleanup service
// (app-storage-real-harness.mjs). The guest is WS1's Nodus world of real
// directories; the check runs the real collector; the cleanup runs as a real
// storage_cleanup job whose cleanup program removes real files. Run from
// admin/frontend (needs root, like app-storage-cleanup-e2e.test.js):
//   node tests/app-storage-real.browser.mjs
// Env: BROWSER_EXE (default /opt/pw-browsers/chromium), UI_EVIDENCE_DIR (screenshots).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { startRealBackend, USER, SNAP_OLD, SNAP_NEW } from './app-storage-real-harness.mjs';
import { RELEASE_ROOT, LIVE, ROLLBACK, CANDIDATE, ADOPTED, OLD_JOB, ACTIVE_JOB } from '../../backend/src/__tests__/helpers/app-storage-world.js';
import { formatBytes, formatSize, effectNote } from '../src/components/app-storage/app-storage-model.mjs';
import { CATEGORY_STATUS_LABELS, STATUS_LABELS, SNAPSHOT_ACK, SNAPSHOT_WARNING, POLICY_TEXT } from '../src/components/app-storage/app-storage-text.js';

if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  console.log('skipped: the real cleanup world needs root (as app-storage-cleanup-e2e.test.js)');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const LAYOUT_WIDTHS = [360, 375, 768, 1280];
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true });

const vite = await createServer({ root, configFile: `${root}/vite.config.js`, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [];
const ok = (msg) => passed.push(msg);

async function shot(page, name) {
  if (!evidence) return;
  const dialog = await page.locator('[role=dialog]').count();
  const tag = dialog ? null : await page.addStyleTag({ content: '#root > div.h-viewport{height:auto !important;overflow:visible !important} main.h-viewport{height:auto !important} main > div.relative{overflow:visible !important}' });
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
  if (tag) await tag.evaluate((n) => n.remove());
}

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
  assert.deepEqual(overflow, [], `${label}: horizontal overflow at ${width}px (real data)`);
  if (width < 640) {
    const small = await page.evaluate(() => [...document.querySelectorAll('main button, [role=dialog] button')]
      .filter((b) => b.offsetParent !== null && b.querySelector('.sr-only')?.textContent !== 'Close')
      .map((b) => { const r = b.getBoundingClientRect(); return { text: (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((b) => b.h < 44 || b.w < 44));
    assert.deepEqual(small, [], `${label}: touch targets under 44px at ${width}px`);
  }
  await shot(page, `real-${label}-${width}`);
}

async function expandAll(page) {
  for (;;) {
    const closed = page.locator('section[data-category] > div > button[aria-expanded="false"]');
    if (!(await closed.count())) break;
    await closed.first().click();
  }
}
const summary = (page) => page.getByTestId('selection-summary').innerText();
const has = (b, rel) => fs.existsSync(b.P(rel));

async function journey(width, { sweep }) {
  const b = await startRealBackend({ jobDelayMs: 2500 });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'pp_csrf', value: 'real-csrf', url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((user) => { localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('mock2HintDismissed', '1'); }, USER);
  // Every /api call goes to the real backend, unchanged (method, headers, body).
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    const response = await route.fetch({ url: `${b.origin}${u.pathname}${u.search}` });
    await route.fulfill({ response });
  });
  try {
    await page.setViewportSize({ width, height: 900 });

    /* ---------------- overview → Request storage check (real check) ---------------- */
    await page.goto(`${origin}/storage/applications`);
    await page.getByRole('heading', { name: 'Application storage', level: 1 }).waitFor();
    const row = page.locator(width >= 1024 ? 'table [data-target="application:1"]' : 'main div[data-target="application:1"]');
    await row.getByText('Not checked yet').waitFor();
    await row.getByRole('button', { name: /Request storage check/ }).click();
    await row.getByRole('button', { name: /Checking/ }).waitFor();
    await row.getByRole('button', { name: /Request storage check/ }).waitFor({ timeout: 30000 });
    const check = b.storage.latestCheck('application:1');
    assert.ok(check && ['complete', 'partial'].includes(check.status), `the real check finished (${check?.status})`);
    const eligibleBytes = check.items.filter((i) => i.status === 'eligible' && !['snapshots', 'exports'].includes(i.category) && i.kind !== 'pseudo').reduce((n, i) => n + (i.allocatedBytes || 0), 0);
    await row.getByText(`${formatBytes(eligibleBytes)} can be cleaned up`, { exact: false }).waitFor();
    assert.equal(b.state.requests.filter((r) => r.path.endsWith('/checks')).length, 1);
    ok(`${width}px: "Request storage check" ran the real collector (${check.items.length} items, status ${check.status}) and the overview shows its result`);
    if (sweep) { for (const w of LAYOUT_WIDTHS) await layoutCheck(page, w, 'overview'); await page.setViewportSize({ width, height: 900 }); ok(`overview on real data: no horizontal scroll at ${LAYOUT_WIDTHS.join('/')} px`); }

    /* ---------------- detail renders the real check ---------------- */
    await row.getByRole('link', { name: /Show storage/ }).click();
    await page.getByRole('heading', { name: 'Nodus', level: 1 }).waitFor();
    const t = check.totals;
    await page.getByText(formatBytes(t.guest.usedBytes), { exact: true }).first().waitFor();
    await page.getByText(formatBytes(t.limit.bytes), { exact: true }).first().waitFor();
    await page.getByText(formatBytes(t.dataset.snapshotsBytes), { exact: true }).first().waitFor();
    for (const n of check.notes || []) await page.getByText(n, { exact: true }).waitFor();
    await expandAll(page);
    for (const cat of check.categories.filter((c) => c.itemCount > 0 && !['snapshots', 'exports'].includes(c.key))) {
      const sec = page.locator(`section[data-category="${cat.key}"]`);
      assert.equal(await sec.count(), 1, `category ${cat.key} is shown`);
      await sec.getByText(cat.label, { exact: true }).first().waitFor();
      await sec.getByText(CATEGORY_STATUS_LABELS[cat.status], { exact: true }).first().waitFor();
    }
    let boxes = 0;
    for (const it of check.items) {
      const el = page.locator(`[data-item="${it.id}"]`);
      assert.equal(await el.count(), 1, `item ${it.label} is listed`);
      await el.getByText(it.reason, { exact: true }).waitFor();
      await el.getByText(STATUS_LABELS[it.status], { exact: true }).first().waitFor();
      await el.getByText(`${formatSize(it.allocatedBytes, it.precision)} on disk`, { exact: false }).first().waitFor();
      const selectable = it.status === 'eligible' && it.kind !== 'pseudo';
      assert.equal(await el.locator('input[type=checkbox]').count(), selectable ? 1 : 0, `${it.label}: checkbox only when it can be cleaned up`);
      if (selectable) { boxes += 1; assert.equal(await el.locator('input[type=checkbox]').isChecked(), false, `${it.label} not preselected`); }
    }
    assert.equal(await summary(page), '0 selected');
    assert.equal(await page.getByRole('button', { name: 'Review cleanup' }).isDisabled(), true);
    ok(`${width}px: the detail renders the real check — header figures, notes, ${check.categories.filter((c) => c.itemCount > 0).length} categories with their statuses, all ${check.items.length} items with status, reason and size; ${boxes} checkboxes, none preselected`);
    if (sweep) { for (const w of LAYOUT_WIDTHS) await layoutCheck(page, w, 'detail'); await page.setViewportSize({ width, height: 900 }); ok(`detail with every category open, on real data: no horizontal scroll at ${LAYOUT_WIDTHS.join('/')} px`); }

    /* ---------------- select → review → deselect one → Clean up → sudo → progress → result ---------------- */
    const group = check.items.find((i) => i.kind === 'group' && i.category === 'temp' && /nodus-embed/.test(i.label));
    const staging = check.items.find((i) => i.path === `${RELEASE_ROOT}/.staging/${OLD_JOB}-1`);
    const bundle = check.items.find((i) => i.path === `${RELEASE_ROOT}/.staging/${OLD_JOB}-1.bundle`);
    const snap = check.items.find((i) => i.kind === 'snapshot' && i.identity?.name === SNAP_OLD.name);
    for (const [name, it] of Object.entries({ group, staging, bundle, snap })) assert.ok(it && it.status === 'eligible', `${name} can be cleaned up in the real check`);
    for (const it of [group, staging, bundle, snap]) await page.locator(`[data-item="${it.id}"] input[type=checkbox]`).check();
    assert.match(await summary(page), /^4 selected/);
    await page.getByText(SNAPSHOT_ACK).first().waitFor();
    await page.getByRole('button', { name: 'Review cleanup' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(SNAPSHOT_WARNING).waitFor();
    for (const it of [group, staging, bundle, snap]) assert.equal(await dialog.locator(`[data-review-item="${it.id}"]`).count(), 1, `${it.label} is in the review`);
    if (sweep) { for (const w of LAYOUT_WIDTHS) await layoutCheck(page, w, 'review'); await page.setViewportSize({ width, height: 900 }); ok(`review dialog on real data: no horizontal scroll at ${LAYOUT_WIDTHS.join('/')} px`); }
    await dialog.getByRole('button', { name: `Remove ${bundle.label} from the cleanup` }).click();
    const go = dialog.getByRole('button', { name: 'Clean up 3 items' });
    await go.waitFor();
    assert.equal(await go.isDisabled(), true, 'disabled until the snapshot warning is acknowledged');
    await dialog.getByRole('checkbox', { name: SNAPSHOT_ACK }).check();
    assert.equal(b.state.requests.filter((r) => r.path.endsWith('/cleanups')).length, 0, 'nothing sent before the button');
    await go.click();
    const sudo = page.getByRole('dialog').filter({ has: page.getByLabel('Password') });
    await sudo.getByLabel('Password').fill('correct horse');
    await sudo.getByLabel('Authenticator Code').fill('123456');
    await sudo.getByRole('button', { name: 'Confirm', exact: true }).click();
    await sudo.waitFor({ state: 'detached' });
    await page.getByRole('dialog').getByText(/Waiting to start…|Cleaning up…/).first().waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('dialog').count(), 1, 'one dialog: no further confirmation after the sudo prompt');
    ok(`${width}px: "Clean up 3 items" → the real 401 sudo_required → the sudo modal → the same POST replayed → the progress view of the queued job`);
    const result = page.getByRole('dialog');
    await result.getByText('Cleanup result').waitFor({ timeout: 30000 });
    const posts = b.state.requests.filter((r) => r.path.endsWith('/cleanups'));
    assert.equal(posts.length, 2, 'the POST, refused for sudo, then replayed once');
    assert.equal(b.state.session.refusals, 1);
    assert.equal(b.state.sudoPosts, 1);
    assert.deepEqual(posts[1].body, { checkId: check.checkId, items: [group.id, staging.id], snapshots: [snap.id], exports: [], acknowledgeSnapshotLoss: true, scope: 'items' });
    assert.equal(posts[1].csrf, 'real-csrf');
    assert.deepEqual(b.state.jobErrors, []);
    assert.equal(b.state.jobs.length, 1);
    const cleanupId = new URL(page.url()).searchParams.get('cleanup');
    const cleanup = await b.storage.cleanupService().getCleanup(cleanupId);
    assert.equal(cleanup.status, 'succeeded', JSON.stringify(cleanup.result));
    await result.getByText('Cleanup finished.', { exact: true }).waitFor();
    const removed = result.getByRole('region', { name: 'Removed' });
    for (const it of [group, staging, snap]) await removed.getByText(it.label, { exact: true }).waitFor();
    assert.equal(await result.getByRole('region', { name: 'Skipped' }).count(), 0, 'nothing skipped');
    assert.equal(await result.getByRole('region', { name: 'Failed' }).count(), 0, 'nothing failed');
    await result.getByText('The application is running and answered its health check.').waitFor();
    const rem = cleanup.result.remaining.guest;
    await result.getByText(`${formatBytes(rem.usedBytes)} used, ${formatBytes(rem.availableBytes)} available`).waitFor();
    const reclaimed = Math.max(0, cleanup.result.reclaimed.guestBytes);
    await result.getByTestId('health').waitFor();
    await result.getByText(reclaimed ? formatBytes(reclaimed) : 'No change measured yet', { exact: true }).waitFor();
    await result.getByText(`Estimated before: ${formatBytes(cleanup.result.estimateBytes)}`).waitFor();
    await result.locator('details > summary').click();
    await result.getByText('Checking that the application is still healthy').waitFor();
    assert.equal(await result.getByText('cleanup:item').count(), 0, 'no phase codes in the event list');
    await layoutCheck(page, width, 'result');
    if (sweep && width !== 360) await layoutCheck(page, 360, 'result');
    await page.setViewportSize({ width, height: 900 });
    ok(`${width}px: the result shows the real outcome — removed (3), nothing skipped or failed, health passed, storage now, space reclaimed and the estimate, plain events`);

    // The files are really gone; what was deselected or protected is untouched.
    for (const m of group.members) assert.equal(has(b, m.path), false, `${m.path} removed`);
    assert.equal(has(b, `${RELEASE_ROOT}/.staging/${OLD_JOB}-1`), false, 'abandoned workspace removed');
    assert.deepEqual(b.state.exec.snapshots.map((s) => s.name), [SNAP_NEW.name], 'only the selected snapshot was deleted');
    assert.equal(has(b, `${RELEASE_ROOT}/.staging/${OLD_JOB}-1.bundle`), true, 'the bundle removed from the review is still there');
    for (const kept of [`${RELEASE_ROOT}/${LIVE}/.proxypilot-release.json`, `${RELEASE_ROOT}/${ROLLBACK}/.proxypilot-release.json`, `${RELEASE_ROOT}/${CANDIDATE}/.proxypilot-release.json`,
      `${RELEASE_ROOT}/${ADOPTED}/voice/models/wespeaker.onnx`, `${RELEASE_ROOT}/${ADOPTED}/embed/models/bge/model_quantized.onnx`, '/var/lib/nodus/handoff/note.md',
      '/etc/nodus/nodus.env', '/var/lib/postgresql/17/main/base/1', `${RELEASE_ROOT}/.staging/${ACTIVE_JOB}-1/package.json`, '/tmp/tsx-989/cache.json']) assert.equal(has(b, kept), true, `${kept} untouched`);
    assert.equal(fs.readFileSync(b.P('/opt/nodus/voice/models/wespeaker.onnx')).length, 26_000, 'the live release still reaches its models');
    const actions = b.audits().map((a) => a.action);
    for (const a of ['STORAGE_CHECK_REQUESTED', 'STORAGE_CLEANUP_APPROVED', 'STORAGE_CLEANUP_FINISHED']) assert.ok(actions.includes(a), a);
    ok(`${width}px: on disk the temp group (${group.members.length} folders) and the workspace are gone, the snapshot is deleted; the deselected bundle, live/rollback/candidate releases, the backing root with its models, data, env file and database are untouched; audit rows written`);

    // Close: the page shows the cleanup's rescan, with nothing selected.
    await result.getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const after = b.storage.latestCheck('application:1');
    assert.equal(after.checkId, cleanup.result.afterCheckId);
    await expandAll(page);
    await page.locator(`[data-item="${after.items.find((i) => i.path === `${RELEASE_ROOT}/.staging/${OLD_JOB}-1.bundle`).id}"]`).waitFor();
    assert.equal(after.items.some((i) => i.kind === 'group' && /nodus-embed/.test(i.label)), false);
    assert.equal(await page.getByText(group.label, { exact: true }).count(), 0, 'the removed group is no longer listed');
    assert.equal(await summary(page), '0 selected');
    await page.getByRole('tab', { name: 'Past cleanups' }).click();
    await page.getByText('Finished', { exact: true }).waitFor();
    ok(`${width}px: after closing, the detail shows the stored rescan (the removed items are gone from it), nothing selected, and the cleanup is in Past cleanups`);

    /* ---------------- rules: a proposed rule turned on with the revision ---------------- */
    await page.getByRole('tab', { name: 'Rules and alerts' }).click();
    assert.equal(await page.getByTestId('policy-source').innerText(), "Kept from Nodus's existing settings");
    const before = b.storage.getPolicy('application:1');
    assert.ok(before.proposedRules.includes('tempFiles'));
    const temp = page.locator('[data-rule="tempFiles"]');
    await temp.getByText('Proposed', { exact: true }).waitFor();
    const eff = before.effects.find((e) => e.rule === 'tempFiles');
    await temp.getByTestId('rule-effect').getByText(POLICY_TEXT.effect(eff.items, formatSize(eff.bytes, 'estimate')), { exact: false }).waitFor();
    if (effectNote(eff)) await temp.getByText(effectNote(eff)).waitFor();
    if (sweep) { for (const w of LAYOUT_WIDTHS) await layoutCheck(page, w, 'rules'); await page.setViewportSize({ width, height: 900 }); ok(`rules and alerts on real data: no horizontal scroll at ${LAYOUT_WIDTHS.join('/')} px`); }
    await temp.getByRole('button', { name: /Turn on/ }).click();
    await temp.getByText('On', { exact: true }).waitFor({ timeout: 10000 });
    const put = b.state.requests.filter((r) => r.method === 'PUT');
    assert.equal(put.length, 1);
    assert.equal(put[0].body.expectedRevision, before.revision);
    assert.equal(put[0].body.policy.rules.tempFiles.enabled, true);
    const now = b.storage.getPolicy('application:1');
    assert.equal(now.revision, before.revision + 1);
    assert.equal(now.source, 'edited');
    assert.equal(now.policy.rules.tempFiles.enabled, true);
    assert.deepEqual(now.proposedRules, before.proposedRules.filter((r) => r !== 'tempFiles'));
    await page.locator('[data-rule="caches"]').getByText('Proposed', { exact: true }).waitFor();
    await temp.getByTestId('rule-effect').waitFor();
    assert.equal(await page.getByTestId('policy-source').innerText(), 'Changed by an administrator');
    ok(`${width}px: rules — Nodus's kept settings, the proposed "Temporary files" rule with its real effects preview; Turn on sent one PUT with expectedRevision ${before.revision}; the backend stored revision ${now.revision} and kept the other proposals proposed`);

    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await context.close();
    await b.close();
  }
}

try {
  await journey(375, { sweep: true });
  await journey(1280, { sweep: false });
  console.log(passed.map((p) => `ok - ${p}`).join('\n'));
  console.log(`\n${passed.length} real-backend journey checks passed.`);
} finally {
  await browser.close();
  await vite.close();
}
