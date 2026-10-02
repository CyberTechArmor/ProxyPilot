// Mobile accessibility gate for the real full dashboard website-review page.
// Run with LIGHTHOUSE_DIR (or argv[2]) pointing at an existing Lighthouse12
// installation; SOURCE_COMMIT identifies the exact tested source. The shared
// harness uses real routes/store/service with scripted session/HTTP/model data.
// Lighthouse snapshots inspect the actual open form, saved agent and result.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { startWebsiteReviewHarness, CSRF, WEBSITE } from './website-review-integrated-harness.mjs';

const installed = process.env.LIGHTHOUSE_DIR || process.argv[2];
assert(installed, 'Set LIGHTHOUSE_DIR or pass the existing Lighthouse installation directory');
assert(/^[a-f0-9]{40}$/.test(process.env.SOURCE_COMMIT || ''), 'Set SOURCE_COMMIT to the exact tested Git commit');
const { startFlow } = await import(pathToFileURL(join(installed, 'node_modules/lighthouse/core/index.js')).href);
const { default: puppeteer } = await import(pathToFileURL(join(installed, 'node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js')).href);
const minimum = 90, port = Number(process.env.LIGHTHOUSE_PORT || 9345);
const artifacts = process.env.BROWSER_ARTIFACTS;
if (artifacts) mkdirSync(artifacts, { recursive: true });
const report = { source_commit: process.env.SOURCE_COMMIT, minimum, real_full_dashboard: true, form_factor: 'mobile', viewport: { width: 375, height: 900 }, scripted_fixtures: ['session identity', 'DNS/HTTP public pages', 'model adapter'], scores: [], page_errors: [], outbound: [] };
const profile = mkdtempSync(join(tmpdir(), 'pp-website-lighthouse-'));
let h, context, connected, page;
try {
  h = await startWebsiteReviewHarness();
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.BROWSER_EXE || '/usr/bin/chromium', headless: true, viewport: report.viewport, isMobile: true, hasTouch: true, args: ['--no-sandbox', '--no-proxy-server', `--remote-debugging-port=${port}`] });
  await context.addCookies([{ name: 'pp_review_fixture_session', value: 'owner', url: h.origin }, { name: 'pp_csrf', value: CSRF, url: h.origin }]);
  await context.addInitScript(() => { localStorage.setItem('mock2HintDismissed', '1'); localStorage.setItem('pp-theme', 'office'); });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith(h.origin) && !url.startsWith('data:')) { report.outbound.push(url); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', error => report.page_errors.push(error.message));
  const url = `${h.origin}/operational-projects/${h.project.id}?section=Website%20reviews`;
  await page.goto(url);
  await page.getByRole('heading', { name: 'Public website reviews', exact: true }).waitFor({ timeout: 90000 });
  connected = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const tabs = await connected.pages(), current = tabs.find(tab => tab.url() === page.url());
  assert(current, 'Lighthouse attaches to the authenticated full dashboard tab');
  const flow = await startFlow(current, { name: 'Public website review mobile accessibility', config: { extends: 'lighthouse:default', settings: { onlyCategories: ['accessibility'], formFactor: 'mobile', screenEmulation: { disabled: true } } } });
  async function snapshot(name) {
    await flow.snapshot({ name });
    const results = await flow.createFlowResult(), lhr = results.steps.at(-1).lhr;
    const score = Math.round(lhr.categories.accessibility.score * 100);
    const failures = Object.values(lhr.audits).filter(audit => audit.score === 0 && audit.scoreDisplayMode === 'binary').map(audit => ({ id: audit.id, title: audit.title, details: audit.details }));
    assert.equal(lhr.configSettings.formFactor, 'mobile');
    assert.equal(new URL(lhr.finalDisplayedUrl).pathname, new URL(url).pathname, 'audit stays on the actual project page');
    report.scores.push({ name, score, form_factor: lhr.configSettings.formFactor, failures });
    console.log(`${name}: ${score}`);
    if (artifacts) { writeFileSync(`${artifacts}/${name}.lhr.json`, JSON.stringify(lhr, null, 2)); await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true }); }
    assert(score >= minimum, `${name}: mobile accessibility ${score} is below ${minimum}`);
  }
  await page.getByRole('button', { name: 'New review agent', exact: true }).click();
  await page.getByLabel('Review agent name').fill('Public museum reader');
  await page.getByLabel('Public website URL').fill(WEBSITE);
  await page.getByLabel('Review objective').fill('Summarize the public museum website');
  await snapshot('website-review-new-agent-mobile');
  await page.getByRole('button', { name: 'Save review agent', exact: true }).click();
  await page.getByRole('button', { name: 'Give model consent', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: /I reviewed:/ }).check();
  await page.getByRole('button', { name: 'Give model consent', exact: true }).click();
  await page.getByText('Ready to start', { exact: true }).waitFor();
  assert.equal(h.transport.length, 0); assert.equal(h.modelCalls.length, 0);
  await snapshot('website-review-saved-agent-mobile');
  const [start] = await Promise.all([page.waitForResponse(response => response.url() === `${h.origin}/api/operational-projects/${h.project.id}/website-review-runs` && response.request().method() === 'POST'), page.getByRole('button', { name: 'Start website review', exact: true }).click()]);
  assert.equal(start.status(), 202);
  const result = page.getByRole('region', { name: 'Website review result' });
  await result.getByRole('heading', { name: /Review result.*queued/ }).waitFor();
  await h.executeNext();
  await result.getByRole('heading', { name: 'Cited model review', exact: true }).waitFor();
  await result.getByText('Immutable run guide and agent pins', { exact: true }).click();
  await result.getByText('Sources and extraction evidence (2)', { exact: true }).click();
  await result.getByRole('heading', { name: /Source 2.*Museum learning/ }).waitFor();
  await snapshot('website-review-completed-evidence-mobile');
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.outbound, []);
  console.log(`PASS website mobile accessibility: ${report.scores.length} actual dashboard states, minimum ${minimum}`);
} finally {
  if (artifacts) { writeFileSync(`${artifacts}/website-review-lighthouse-report.json`, JSON.stringify(report, null, 2)); if (page) writeFileSync(`${artifacts}/website-review-lighthouse-final.html`, await page.content().catch(() => 'Page closed')); }
  connected?.disconnect(); await context?.close(); await h?.close();
  const target = resolve(profile);
  assert.equal(dirname(target), resolve(tmpdir())); assert(basename(target).startsWith('pp-website-lighthouse-'));
  rmSync(target, { recursive: true, force: true });
}
