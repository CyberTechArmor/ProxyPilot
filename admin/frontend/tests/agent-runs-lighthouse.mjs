// Lighthouse accessibility (its default mobile emulation) on the A6 pages,
// against the UI harness (agent-runs-harness.mjs) with a run waiting for
// approval. Lighthouse is not a project dependency; install it anywhere and pass
// the directory. Run from admin/frontend:
//   npm install --prefix /tmp/lh lighthouse@12 && node tests/agent-runs-lighthouse.mjs /tmp/lh
// Lighthouse opens its tab in the browser's default context, so the browser is a
// persistent context (Playwright's Chromium, with a debugging port) holding the
// harness session cookie. Exits 1 when a page scores under MIN.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { startHarness } from './agent-runs-harness.mjs';
import { authorizePilotSelfReview } from '../../backend/src/lib/operational-pilot-review.js';

const LH = process.argv[2];
if (!LH) throw new Error('Pass the directory where lighthouse is installed');
const MIN = 90;
const PORT = 9333;
const { default: lighthouse } = await import(join(LH, 'node_modules/lighthouse/core/index.js'));
const h = await startHarness();
const profile = mkdtempSync(join(tmpdir(), 'pp-a6-lighthouse-'));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium',
  headless: true, viewport: { width: 1280, height: 800 }, args: [`--remote-debugging-port=${PORT}`, '--no-proxy-server'] });
const results = {};
try {
  await ctx.addCookies([{ name: 'pp_harness_user', value: 'operator', url: h.origin }, { name: 'pp_csrf', value: 'a6-csrf', url: h.origin }]);
  const page = await ctx.newPage();
  const u = h.world.users.operator;
  await page.goto(`${h.origin}/login`);
  await page.evaluate(user => localStorage.setItem('user', JSON.stringify(user)), { id: u.id, username: u.username, role: 'user' });
  const base = `${h.origin}/operational-projects/${h.world.p.id}`;
  const runs = `${base}?section=${encodeURIComponent('Agent runs')}`;
  await page.goto(runs);
  await page.getByRole('button', { name: 'Start run' }).click();
  await page.getByRole('region', { name: 'Approval needed' }).waitFor({ timeout: 30000 });
  const run = new URL(page.url()).searchParams.get('run');
  const pages = {
    'operations-and-inbox': `${h.origin}/operational-projects`,
    'agent-runs-overview': runs,
    'run-deck-browser': `${runs}&run=${run}&panel=browser`,
    'run-deck-activity': `${runs}&run=${run}&panel=activity`,
    'run-deck-details': `${runs}&run=${run}&panel=details`,
    'agents-section': `${base}?section=Agents`,
  };
  const { f, users } = h.world, owner = users.owner;
  const pilot = f.store.create(owner, { name: 'Pilot guide review' });
  f.store.site(owner, pilot.id, f.store.get(owner, pilot.id).revision, { site_origin: 'https://demo.fractionate.ai' });
  f.store.saveDraft(owner, pilot.id, 1, { title: 'Demo guide', instructions: 'Open the demo sign-in dialog.' });
  const submitted = f.store.submit(owner, pilot.id, 2, {}).submission;
  authorizePilotSelfReview(f.db, { owner_id: owner.id, project_id: pilot.id, submission_id: submitted.id,
    content_hash: submitted.content_hash }, { now: () => submitted.submitted_at });
  pages['pilot-guide-exception'] = `${h.origin}/operational-projects/${pilot.id}?section=Guide`;
  for (const [name, url] of Object.entries(pages)) {
    if (name === 'pilot-guide-exception') {
      await ctx.addCookies([{ name: 'pp_harness_user', value: 'owner', url: h.origin }]);
      await page.evaluate(user => localStorage.setItem('user', JSON.stringify(user)),
        { id: owner.id, username: owner.username, role: 'user' });
    }
    const { lhr } = await lighthouse(url, { port: PORT, onlyCategories: ['accessibility'], output: 'json', logLevel: 'error' });
    if (new URL(lhr.finalDisplayedUrl).pathname !== new URL(url).pathname) throw new Error(`${name}: landed on ${lhr.finalDisplayedUrl}`);
    results[name] = { score: Math.round(lhr.categories.accessibility.score * 100), form_factor: lhr.configSettings.formFactor,
      failing: Object.values(lhr.audits).filter(a => a.score === 0 && a.scoreDisplayMode === 'binary').map(a => a.id) };
    console.log(name, JSON.stringify(results[name]));
  }
} finally {
  await ctx.close();
  await h.close();
  rmSync(profile, { recursive: true, force: true });
}
const low = Object.entries(results).filter(([, r]) => r.score < MIN).map(([name]) => name);
console.log(JSON.stringify({ a6_lighthouse_accessibility: low.length ? 'failed' : 'passed', min: MIN, pages: Object.keys(results).length }));
if (low.length) process.exitCode = 1;
