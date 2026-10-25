// Application foundation panel (components/mock2/ProjectFoundation.jsx) in a
// real browser over a mocked API (tests/foundation-panel-harness.mjs): every
// initial state at 360/375/768/1280 (MOBILE_FIRST pre-merge checklist — no
// horizontal scroll with the overflow guard off, 44px targets on phones), and
// the journeys end to end at phone width: the STORAGE_HAS_OBJECTS refusal →
// copy (verified, with progress) and → start fresh, the embeddings switch with
// re-embed progress, a FOUNDATION_JOB_RUNNING refusal → cancel, the sudo
// prompt on a write, and the database exception dialog. Moving a
// pre-foundation project onto the foundation: the check dialog at every
// width, a blocked check, check → confirm with sudo → running → succeeded →
// the normal cards → roll back, a failure → roll back, a failure → resume,
// PLAN_STALE → checked again, and viewers read-only. Presentation proof
// only: no backend route, guest, Docker stack or provider is involved.
//
//   node tests/foundation-panel.browser.mjs
// Env: PLAYWRIGHT_CORE (path to playwright-core's index.mjs; default: the
// backend's copy, else the global `playwright` package), BROWSER_EXE (Chromium
// binary), BROWSER_ARTIFACTS (screenshot directory, default
// .artifacts/foundation-panel).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import * as contract from '../../backend/src/mock2/foundation-contract.js';
import { ADOPT_FAIL_DETAIL, ADOPT_SECRETS, ADOPT_STEPS, createWorld } from './foundation-panel-harness.mjs';
import { STALE_TEXT } from '../src/components/mock2/foundation-adopt-logic.js';

async function loadChromium() {
  if (process.env.PLAYWRIGHT_CORE) return (await import(process.env.PLAYWRIGHT_CORE)).chromium;
  try { return (await import('../../backend/node_modules/playwright-core/index.mjs')).chromium; } catch { /* not installed */ }
  return createRequire(import.meta.url)('playwright').chromium;
}
const chromium = await loadChromium();
const artifacts = process.env.BROWSER_ARTIFACTS || '.artifacts/foundation-panel';
mkdirSync(artifacts, { recursive: true });

const vite = await createServer({ root: new URL('..', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || undefined, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Console errors count too, except the network-level 4xx lines the stubbed
// refusals produce and the dev server's HMR client, which cannot reach its
// websocket from the sandboxed browser (environment, not the panel).
const NOISE = /Failed to load resource|\[vite\]|WebSocket connection to/;
page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });

let world = createWorld('default');
const seen = [];
await page.route('**/api/**', async (route) => {
  const r = route.request();
  let body = null;
  try { body = r.postData() ? JSON.parse(r.postData()) : null; } catch { body = null; }
  seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  const out = world.handle(r.method(), r.url(), body);
  return route.fulfill({ status: out.status, json: out.body });
});
await page.route('**/foundation-test*', async (route) => route.fulfill({
  contentType: 'text/html',
  body: await vite.transformIndexHtml('/foundation-test', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Application foundation fixture</title></head><body><div id="root"></div><script type="module" src="/tests/foundation-panel-fixture.jsx"></script></body></html>'),
}));

const unguard = () => page.addStyleTag({ content: 'html,body{overflow-x:visible!important}' });
const noHorizontalScroll = async (label) => {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.equal(sw, cw, `${label}: horizontal scroll (${sw} > ${cw})`);
};
// Every visible control in the panel and in an open dialog: 44×44 on a phone.
// The base dialog's own corner X is the shared primitive's; every dialog here
// also has a 44px Cancel.
const touchTargets = async (label) => {
  const small = await page.evaluate(() => {
    const roots = [document.querySelector('[data-foundation-panel]'), ...document.querySelectorAll('[role="dialog"]')].filter(Boolean);
    const out = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll('button, a[href], label:has(input), label[data-foundation-path-style], label[data-foundation-adopt-feature]')) {
        if (el.offsetParent === null || el.getAttribute('role') === 'switch') continue;
        if (el.matches('button.absolute.right-4.top-4')) continue;
        if (el.tagName === 'BUTTON' && el.closest('label')) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    }
    return out;
  });
  assert.deepEqual(small, [], `${label}: touch targets under 44px`);
};
const WIDTHS = [[360, 640], [375, 812], [768, 1024], [1280, 900]];
const report = [];
const open = async (caseName, { opts = {}, query = '', width = 360, height = 640, theme = 'midnight' } = {}) => {
  world = createWorld(caseName, opts);
  seen.length = 0;
  await page.setViewportSize({ width, height });
  await page.addInitScript((t) => { try { localStorage.setItem('pp-theme', t); } catch { /* blocked */ } }, theme);
  await page.goto(`${origin}/foundation-test${query}`);
  await page.locator('[data-foundation-panel="ready"], [data-foundation-panel="legacy"]').waitFor({ timeout: 15000 });
  await unguard();
};
const card = (name) => page.locator(`[data-foundation-card="${name}"]`);
const dialog = (name) => page.locator(`[data-foundation-dialog="${name}"]`);
const moveButton = () => page.getByRole('button', { name: 'Move onto the application foundation' });
const adoption = (state) => page.locator(`[data-foundation-adoption="${state}"]`);
const writes = () => world.calls.map((c) => `${c.method} ${c.path.replace('/api/mock2/projects/7', '')}`);
// Open the move dialog and run its check; resolves once the plan (or the
// blockers) are on screen.
const checkProject = async () => {
  await moveButton().click();
  await dialog('adopt').waitFor();
  await dialog('adopt').getByRole('button', { name: 'Check this project' }).click();
  await dialog('adopt').locator('[data-foundation-adopt-facts], [data-foundation-adopt-blockers]').first().waitFor();
};
// Whole page for the panel states; the viewport while a dialog is open (a
// fixed, full-screen dialog is what a phone shows).
const shot = async (name) => page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: (await page.locator('[role="dialog"]').count()) === 0 });
// Wait for every FINITE animation (dialog fades/zooms); a busy spinner's
// animation is infinite and never finishes.
const settle = () => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((x) => Number.isFinite(x.effect?.getComputedTiming?.().endTime))
  .map((x) => x.finished.catch(() => null))));
const lastCall = (path) => [...world.calls].reverse().find((c) => c.path.endsWith(path));
// A dialog at phone width is the full screen, has no sideways overflow, and
// its submit can be reached and pressed.
const dialogFits = async (name, label) => {
  // Measure after the open animation (zoom-in-95) has finished.
  await settle();
  const m = await dialog(name).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, overflow: el.scrollWidth - el.clientWidth };
  });
  assert(m.overflow <= 0, `${label}: dialog content wider than the dialog`);
  if (m.vw < 640) {
    assert(Math.abs(m.w - m.vw) <= 1 && Math.abs(m.h - m.vh) <= 1, `${label}: dialog is not full-screen below sm (${m.w}×${m.h} in ${m.vw}×${m.vh})`);
  }
};

try {
  // ---- 1. every initial state, at each width ----
  const STATES = [
    ['default', {}], ['storage_off', {}], ['external', {}], ['missing_credentials', {}],
    ['job_running', { opts: { advanceJobs: false } }], ['starting', {}], ['legacy', {}],
    ['viewer', { caseName: 'default', query: '?viewer=1' }],
    // A move onto the foundation on record: under way, stopped, finished.
    ['adopting', { caseName: 'legacy', legacy: true, query: '?project=legacy', opts: { adopt: { initial: 'running', advance: false } } }],
    ['adopt_failed', { caseName: 'legacy', legacy: true, query: '?project=legacy', opts: { adopt: { initial: 'failed' } } }],
    ['adopted', { caseName: 'default', opts: { adopt: { initial: 'succeeded' } } }],
  ];
  for (const [name, o] of STATES) {
    await open(o.caseName || name, { opts: o.opts, query: o.query });
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(80);
      await noHorizontalScroll(`${name} @${width}`);
      if (width < 640) await touchTargets(`${name} @${width}`);
      await shot(`state-${name}-${width}`);
    }
    await page.setViewportSize({ width: 360, height: 640 });
    const text = await page.locator('[data-foundation-panel]').innerText();
    if (name === 'legacy' || o.legacy) {
      assert.match(text, /This project predates the application foundation\./);
      assert.equal(await page.locator('[data-foundation-card]').count(), 0);
    } else {
      assert.match(await card('database').innerText(), /PostgreSQL 18 \+ pgvector/);
      assert.equal(await card('database').locator('button').count(), 0, 'the database has no switch');
    }
    if (name === 'default') {
      await assert.doesNotReject(page.locator('[data-foundation-warning="local-embeddings"]').waitFor());
      assert.equal((await page.locator('[data-foundation-warning="local-embeddings"]').innerText()).trim(), contract.LOCAL_EMBEDDINGS_WARNING);
      assert.match(await card('storage').innerText(), /Bundled SeaweedFS/);
      assert.match(await card('storage').innerText(), /Ready/);
      for (const b of ['Switch provider', 'Turn off']) assert.equal(await card('storage').getByRole('button', { name: b }).count(), 1, b);
      assert.equal(await page.getByRole('button', { name: 'Check now' }).count(), 1);
    }
    if (name === 'storage_off') {
      assert.match(await card('storage').innerText(), /Off\. Uploads and downloads are unavailable\. Nothing was deleted\./);
      assert.equal(await card('storage').getByRole('button', { name: 'Turn on' }).count(), 1);
      assert.equal(await card('storage').getByRole('button', { name: 'Turn off' }).count(), 0);
    }
    if (name === 'external') {
      const t = await card('storage').innerText();
      assert.match(t, /External S3/);
      assert.match(t, /4f1c9a7e2b\.r2\.cloudflarestorage\.com · bucket invoices-prod · folder app\//);
      assert.match(t, /Access keys\s+Saved/);
      assert.equal(await page.locator('[data-foundation-warning]').count(), 0, 'no local warning for OpenAI');
      assert.match(await card('embeddings').innerText(), /OpenAI[\s\S]*text-embedding-3-small[\s\S]*1,536/);
    }
    if (name === 'missing_credentials') {
      assert.match(await card('storage').innerText(), /Needs credentials/);
      assert.match(await card('embeddings').innerText(), /Needs credentials/);
      assert.equal(await card('storage').getByRole('button', { name: 'Add access keys' }).count(), 1);
      assert.equal(await card('embeddings').getByRole('button', { name: 'Add API key' }).count(), 1);
      for (const f of ['storage', 'embeddings']) assert.doesNotMatch(await card(f).innerText(), /\bReady\b/, `${f} must not read as ready without credentials`);
    }
    if (name === 'job_running') {
      const s = await card('storage').locator('[data-foundation-job]').innerText();
      assert.match(s, /Copying files to the new storage/);
      assert.match(s, /482 of 1,204 files · 700 MB of 1\.8 GB/);
      assert.match(await card('embeddings').locator('[data-foundation-job]').innerText(), /120 of 318 items/);
      assert.equal(await card('storage').getByRole('button', { name: 'Switch provider' }).isDisabled(), true);
      assert.equal(await page.getByRole('progressbar').count(), 2);
    }
    if (name === 'starting') {
      assert.match(await card('storage').innerText(), /Starting/);
      assert.match(await card('embeddings').innerText(), /Degraded[\s\S]*answered slowly/);
    }
    if (name === 'viewer') {
      assert.equal(await page.locator('[data-foundation-card] button').count(), 0, 'a viewer gets no switches');
      assert.equal(await page.getByRole('button', { name: 'Check now' }).count(), 0);
      assert.match(text, /Only project editors can change these\./);
      assert.match(text, /Local embeddings \(bge-small/);
    }
    if (name === 'legacy') {
      assert.equal(await moveButton().count(), 1, 'an editor is offered the move');
      assert.match(text, /You see a check first, and the move can be rolled back\./);
    }
    if (name === 'adopting') {
      const block = page.locator('[data-foundation-adoption="running"]');
      assert.match(await block.innerText(), /Moving onto the application foundation[\s\S]*2 of 6 steps done[\s\S]*so far/);
      assert.equal(await block.locator('[data-adopt-step]').count(), 6);
      assert.equal(await block.locator('[data-adopt-step="install_stack"]').getAttribute('data-state'), 'running');
      assert.match(await block.locator('[data-adopt-detail]').innerText(), /Starting PostgreSQL, file storage and embeddings/);
      assert.equal(await moveButton().count(), 0, 'no second move while one runs');
      assert.equal(await page.locator('[data-foundation-panel] button').count(), 0, 'nothing to press while it runs');
      assert.equal(await page.getByRole('progressbar').count(), 1);
    }
    if (name === 'adopt_failed') {
      const block = page.locator('[data-foundation-adoption="failed"]');
      assert.match(await block.locator('[data-foundation-adopt-error]').innerText(), /Copying the database failed: row counts differ/);
      assert.equal(await block.getByRole('button', { name: 'Resume' }).count(), 1);
      assert.equal(await block.getByRole('button', { name: 'Roll back' }).count(), 1);
      assert.equal(await moveButton().count(), 0, 'resume or roll back first');
    }
    if (name === 'adopted') {
      const block = page.locator('[data-foundation-adoption="succeeded"]');
      assert.match(await block.innerText(), /Moved onto the foundation[\s\S]*You can still roll back/);
      assert.equal(await block.getByRole('button', { name: 'Roll back' }).count(), 1);
      assert.equal(await card('storage').count(), 1, 'the normal cards are there');
    }
    report.push({ state: name, widths: WIDTHS.map(([w]) => w), ok: true });
  }

  // Legacy from the project row: no foundation call at all. Legacy from a 404.
  await open('default', { query: '?project=legacy' });
  assert.equal(seen.filter((s) => s.endsWith('/foundation')).length, 0, 'a legacy project row does not read the foundation');
  assert.match(await page.locator('[data-foundation-panel="legacy"]').innerText(), /predates the application foundation/);
  await open('default', { opts: { legacy404: true } });
  assert.match(await page.locator('[data-foundation-panel="legacy"]').innerText(), /predates the application foundation/);

  // Light theme reference shot.
  await open('default', { theme: 'office', width: 375, height: 812 });
  await shot('state-default-375-light');

  // ---- 2. Turn off bundled storage that holds files → refused → copy (verified) ----
  await open('has_objects', { width: 375, height: 812 });
  await card('storage').getByRole('button', { name: 'Turn off' }).click();
  await dialog('off').waitFor();
  const offText = await dialog('off').innerText();
  for (const d of contract.DEPENDENT_CAPABILITIES.storage) assert(offText.includes(d), `turn-off lists "${d}"`);
  assert.match(offText, /No data is deleted\./);
  await dialogFits('off', 'turn off @375');
  await shot('flow-storage-off-confirm-375');
  await dialog('off').getByRole('button', { name: 'Turn off' }).click();
  await page.locator('[data-foundation-refusal="STORAGE_HAS_OBJECTS"]').waitFor();
  assert.match(await dialog('off').innerText(), /still holds 1,204 files/);
  assert.equal(await dialog('off').getByRole('button', { name: 'Turn off' }).count(), 0, 'the refused action is not offered again');
  await shot('flow-storage-off-refused-375');
  await dialog('off').getByRole('button', { name: 'Copy everything (verified)' }).click();
  await dialog('storage').waitFor();
  await dialogFits('storage', 'storage switch @375');
  assert.equal(await dialog('storage').locator('[data-foundation-mode]').count(), 1, 'the copy/fresh choice is shown');
  assert.equal(await dialog('storage').getByRole('radio', { name: /Copy everything to the new storage \(verified\)/ }).isChecked(), true, 'the chosen option is preselected');
  assert.equal(await dialog('storage').getByRole('radio', { name: /Bundled SeaweedFS/ }).isDisabled(), true);
  for (const id of ['#fs-key-id', '#fs-secret']) {
    assert.equal(await dialog('storage').locator(id).getAttribute('type'), 'password');
    assert.equal(await dialog('storage').locator(id).inputValue(), '', 'secrets are never prefilled');
  }
  await dialog('storage').locator('#fs-endpoint').fill('https://4f1c9a7e2b.r2.cloudflarestorage.com');
  await dialog('storage').locator('#fs-region').fill('auto');
  await dialog('storage').locator('#fs-bucket').fill('invoices-prod');
  await dialog('storage').locator('[data-foundation-path-style]').click();
  assert.equal(await dialog('storage').getByRole('switch').getAttribute('aria-checked'), 'true', 'tapping the row toggles path-style');
  await dialog('storage').locator('#fs-key-id').fill('AKIAEXAMPLE');
  await dialog('storage').locator('#fs-secret').fill('example-secret');
  await dialog('storage').getByRole('button', { name: 'Start the copy' }).click();
  assert.match(await dialog('storage').innerText(), /Tick the box to confirm\./, 'the acknowledgement is required');
  assert.equal(world.calls.filter((c) => c.path.endsWith('/foundation/storage')).length, 1, 'nothing sent without the acknowledgement');
  await dialog('storage').getByText(/Existing files stay in the preserved bundled storage\. Turning bundled storage back on brings them back\./).click();
  await shot('flow-storage-copy-form-375');
  await dialog('storage').getByRole('button', { name: 'Start the copy' }).click();
  await dialog('storage').waitFor({ state: 'detached' });
  await card('storage').locator('[data-foundation-job]').waitFor();
  assert.deepEqual(lastCall('/foundation/storage').body, {
    action: 'switch', provider: 'external',
    config: { endpoint: 'https://4f1c9a7e2b.r2.cloudflarestorage.com', region: 'auto', bucket: 'invoices-prod', prefix: '', force_path_style: true },
    credentials: { access_key_id: 'AKIAEXAMPLE', secret_access_key: 'example-secret' },
    mode: 'copy', acknowledge: true,
  });
  await shot('flow-storage-copy-running-375');
  await card('storage').getByText('All files copied and verified. The new storage is in use.').waitFor({ timeout: 20000 });
  assert.match(await card('storage').innerText(), /External S3/);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await noHorizontalScroll('after copy @375');
  await shot('flow-storage-copy-done-375');

  // ---- 3. Switch with an unknown object count → refused in the dialog → start fresh ----
  await open('has_objects', { opts: { hideCount: true }, width: 360, height: 640 });
  await card('storage').getByRole('button', { name: 'Switch provider' }).click();
  await dialog('storage').waitFor();
  assert.equal(await dialog('storage').locator('[data-foundation-mode]').count(), 0, 'no choice asked before the server says so');
  await dialog('storage').locator('#fs-endpoint').fill('https://s3.eu-central-1.amazonaws.com');
  await dialog('storage').locator('#fs-bucket').fill('invoices-files');
  await dialog('storage').locator('#fs-key-id').fill('AKIAEXAMPLE');
  await dialog('storage').locator('#fs-secret').fill('example-secret');
  await dialog('storage').getByRole('button', { name: 'Switch storage' }).click();
  await dialog('storage').locator('[data-foundation-mode]').waitFor();
  assert.match(await dialog('storage').innerText(), /This storage holds 1,204 files\. Choose to copy them \(verified\) or to start fresh\./);
  assert.equal(await dialog('storage').locator('#fs-endpoint').inputValue(), 'https://s3.eu-central-1.amazonaws.com', 'the form survives the refusal');
  await dialogFits('storage', 'storage refusal @360');
  await shot('flow-storage-refused-in-dialog-360');
  await dialog('storage').getByRole('radio', { name: /Start fresh/ }).check();
  await dialog('storage').locator('#fs-ack').check();
  await dialog('storage').getByRole('button', { name: 'Switch storage' }).click();
  await dialog('storage').waitFor({ state: 'detached' });
  const fresh = lastCall('/foundation/storage').body;
  assert.equal(fresh.mode, 'fresh');
  assert.equal(fresh.acknowledge, true);
  await page.waitForFunction(() => /External S3/.test(document.querySelector('[data-foundation-card="storage"]')?.innerText || ''));

  // ---- 4. Embeddings switch dialog → re-embed progress ----
  await open('default', { width: 360, height: 640 });
  await card('embeddings').getByRole('button', { name: 'Switch provider' }).click();
  await dialog('embeddings').waitFor();
  await dialogFits('embeddings', 'embeddings switch @360');
  assert.match(await dialog('embeddings').innerText(), /keeps using the current index until the new one passes its checks/);
  assert.equal(await dialog('embeddings').locator('input[value="openai"]').isChecked(), true);
  assert.equal(await dialog('embeddings').locator('#em-model').inputValue(), 'text-embedding-3-small');
  assert.equal(await dialog('embeddings').locator('#em-dims').inputValue(), '1536');
  assert.equal(await dialog('embeddings').locator('#em-key').inputValue(), '');
  await shot('flow-embeddings-dialog-360');
  await dialog('embeddings').locator('input[value="openai_compatible"]').check();
  assert.equal(await dialog('embeddings').locator('#em-base').count(), 1, 'compatible asks for a base URL');
  await shot('flow-embeddings-compatible-360');
  await dialog('embeddings').locator('input[value="local"]').check();
  assert.match(await dialog('embeddings').innerText(), /Local embeddings \(bge-small, 384 dimensions\)/);
  await dialog('embeddings').locator('input[value="openai"]').check();
  await dialog('embeddings').getByRole('button', { name: 'Switch and re-embed' }).click();
  assert.match(await dialog('embeddings').innerText(), /Enter the OpenAI API key\./);
  await dialog('embeddings').locator('#em-key').fill('sk-example');
  await dialog('embeddings').getByRole('button', { name: 'Switch and re-embed' }).click();
  await card('embeddings').locator('[data-foundation-job]').waitFor();
  assert.deepEqual(lastCall('/foundation/embeddings').body, { action: 'switch', provider: 'openai', config: { model: 'text-embedding-3-small', dimensions: 1536 }, credentials: { api_key: 'sk-example' } });
  assert.match(await card('embeddings').innerText(), /Re-embedding into a new index/);
  await shot('flow-embeddings-reembed-360');
  await card('embeddings').getByText('The new index passed its checks and is in use.').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('[data-foundation-warning]').count(), 0, 'the local warning goes once OpenAI is in use');
  assert.match(await card('embeddings').innerText(), /OpenAI/);

  // ---- 5. A job the read did not list → FOUNDATION_JOB_RUNNING → cancel it ----
  await open('job_running', { opts: { hideJobs: true, advanceJobs: false }, width: 375, height: 812 });
  await card('embeddings').getByRole('button', { name: 'Switch provider' }).click();
  await dialog('embeddings').locator('#em-key').fill('sk-example');
  await dialog('embeddings').getByRole('button', { name: 'Switch and re-embed' }).click();
  await page.locator('[data-foundation-refusal="FOUNDATION_JOB_RUNNING"]').waitFor();
  assert.deepEqual(await page.locator('[data-foundation-refusal="FOUNDATION_JOB_RUNNING"] button').allInnerTexts(), ['Show its progress', 'Cancel the running job']);
  await shot('flow-job-running-refused-375');
  await dialog('embeddings').getByRole('button', { name: 'Cancel the running job' }).click();
  await dialog('embeddings').waitFor({ state: 'detached' });
  assert.equal(world.calls.at(-1).path, '/api/mock2/projects/7/foundation/jobs/job_s1/cancel');

  // "Show its progress": the job belongs to storage, so the storage card shows it.
  await open('job_running', { opts: { hideJobs: true, advanceJobs: false }, width: 375, height: 812 });
  await card('embeddings').getByRole('button', { name: 'Switch provider' }).click();
  await dialog('embeddings').locator('#em-key').fill('sk-example');
  await dialog('embeddings').getByRole('button', { name: 'Switch and re-embed' }).click();
  await dialog('embeddings').getByRole('button', { name: 'Show its progress' }).click();
  await dialog('embeddings').waitFor({ state: 'detached' });
  await card('storage').locator('[data-foundation-job]').waitFor();
  assert.match(await card('storage').locator('[data-foundation-job]').innerText(), /482 of 1,204 files/);
  assert.equal(await card('embeddings').locator('[data-foundation-job]').count(), 0);

  // Cancel from the progress block.
  await open('job_running', { opts: { advanceJobs: false }, width: 375, height: 812 });
  await card('storage').locator('[data-foundation-job]').getByRole('button', { name: 'Cancel' }).click();
  await card('storage').getByText('Cancelled. Nothing was switched; the current one stays in use.').waitFor();
  await card('storage').getByRole('button', { name: 'Dismiss' }).click();
  assert.equal(await card('storage').locator('[data-foundation-job]').count(), 0);

  // ---- 6. A write behind sudo: the real SudoModal opens, then the call is retried ----
  await open('default', { opts: { sudoOnce: true }, width: 375, height: 812 });
  await card('embeddings').getByRole('button', { name: 'Turn off' }).click();
  const embOff = await dialog('off').innerText();
  for (const d of contract.DEPENDENT_CAPABILITIES.embeddings) assert(embOff.includes(d), `turn-off lists "${d}"`);
  assert.match(embOff, /No data is deleted\. Stored vectors stay in the database/);
  await dialog('off').getByRole('button', { name: 'Turn off' }).click();
  await page.locator('#sudo-password').waitFor();
  await page.locator('#sudo-password').fill('password');
  await page.locator('#sudo-totp').fill('123456');
  await settle();
  await shot('flow-sudo-375');
  await page.locator('#sudo-totp').press('Enter');
  await dialog('off').waitFor({ state: 'detached' });
  await page.waitForFunction(() => /Off\. Search is unavailable/.test(document.querySelector('[data-foundation-card="embeddings"]')?.innerText || ''));
  assert.deepEqual(world.calls.map((c) => `${c.method} ${c.path.replace('/api/mock2/projects/7', '')}`), [
    'POST /foundation/embeddings', 'POST /api/auth/sudo', 'POST /foundation/embeddings',
  ]);
  await card('embeddings').getByRole('button', { name: 'Turn on' }).click();
  await page.waitForFunction(() => !/Off\. Search is unavailable/.test(document.querySelector('[data-foundation-card="embeddings"]')?.innerText || ''));

  // ---- 7. Database exception: collapsed by default; record in own words; clear ----
  await open('default', { width: 360, height: 640 });
  const toggle = page.getByRole('button', { name: /Database exception/ });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByText('This app must use PostgreSQL.', { exact: false }).count(), 0, 'collapsed by default');
  await toggle.click();
  assert.match(await page.locator('[data-foundation-exception]').innerText(), /This app must use PostgreSQL\. Record an exception only when you explicitly asked for SQLite\./);
  await page.getByRole('button', { name: 'Record an exception' }).click();
  await dialog('exception').waitFor();
  await dialogFits('exception', 'exception @360');
  await dialog('exception').locator('#ex-text').fill('SQLite');
  await dialog('exception').getByRole('button', { name: 'Record exception' }).click();
  assert.match(await dialog('exception').innerText(), /Write at least 10 characters\./);
  assert.match(await dialog('exception').innerText(), /Tick the box to confirm\./);
  const words = 'Please use SQLite for this app. It runs offline on one laptop and must not need a database server.';
  await dialog('exception').locator('#ex-text').fill(words);
  await dialog('exception').locator('#ex-ack').check();
  await shot('flow-exception-dialog-360');
  await dialog('exception').getByRole('button', { name: 'Record exception' }).click();
  await dialog('exception').waitFor({ state: 'detached' });
  assert.deepEqual(lastCall('/database-exception').body, { engine: 'sqlite', request_text: words, acknowledge: true });
  assert.match(await page.locator('[data-foundation-exception]').innerText(), /SQLite exception recorded[\s\S]*It runs offline on one laptop[\s\S]*recorded by thomas/);
  await noHorizontalScroll('exception recorded @360');
  await touchTargets('exception recorded @360');
  await shot('flow-exception-recorded-360');
  await page.getByRole('button', { name: 'Clear the exception' }).click();
  await dialog('exception-clear').getByRole('button', { name: 'Clear exception' }).click();
  await page.getByText('None recorded. The app uses PostgreSQL.').waitFor();
  assert.equal(world.calls.at(-1).method, 'DELETE');

  // ---- 8. Add API key on missing credentials opens the dialog on the provider in use ----
  await open('missing_credentials', { width: 768, height: 1024 });
  await card('embeddings').getByRole('button', { name: 'Add API key' }).click();
  assert.equal(await dialog('embeddings').locator('input[value="openai"]').isChecked(), true);
  assert.match(await dialog('embeddings').innerText(), /OpenAI \(in use\)/);
  await dialogFits('embeddings', 'add key @768');
  await shot('flow-add-api-key-768');
  await page.keyboard.press('Escape');
  await card('storage').getByRole('button', { name: 'Add access keys' }).click();
  assert.equal(await dialog('storage').locator('#fs-bucket').inputValue(), 'invoices-prod', 'non-secret config is kept');
  assert.equal(await dialog('storage').locator('#fs-secret').inputValue(), '');
  assert.doesNotMatch(await dialog('storage').innerText(), /Saved — leave empty/, 'no "saved" claim without has_secret');

  // Check now posts the probes and re-renders from their answer.
  await open('starting', { width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.waitForFunction(() => /Ready/.test(document.querySelector('[data-foundation-card="storage"]')?.innerText || ''));

  // ---- 9. Move onto the foundation: the check dialog fits at every width ----
  for (const [width, height] of WIDTHS) {
    await open('legacy', { query: '?project=legacy', opts: { adopt: {} }, width, height });
    await moveButton().click();
    await dialog('adopt').waitFor();
    await dialogFits('adopt', `adopt intro @${width}`);
    if (width < 640) await touchTargets(`adopt intro @${width}`);
    await dialog('adopt').getByRole('button', { name: 'Check this project' }).click();
    await dialog('adopt').locator('[data-foundation-adopt-facts]').waitFor();
    await dialogFits('adopt', `adopt plan @${width}`);
    if (width < 640) await touchTargets(`adopt plan @${width}`);
    await noHorizontalScroll(`adopt plan @${width}`);
    const confirmButton = dialog('adopt').getByRole('button', { name: 'Move this project' });
    await confirmButton.scrollIntoViewIfNeeded();
    assert(await confirmButton.isVisible(), `adopt plan @${width}: the confirm button can be reached`);
    await dialog('adopt').locator('[data-foundation-adopt-plan-steps]').scrollIntoViewIfNeeded();
    await shot(`flow-adopt-plan-${width}`);
    await page.keyboard.press('Escape');
    await dialog('adopt').waitFor({ state: 'detached' });
  }
  // A wide desktop keeps the sheet; and the Lighthouse fixture's
  // ?open=adopt-plan really opens the check by itself.
  await open('legacy', { query: '?project=legacy&open=adopt-plan', opts: { adopt: {} }, width: 1920, height: 1080 });
  await dialog('adopt').locator('[data-foundation-adopt-facts]').waitFor();
  await dialogFits('adopt', 'adopt plan @1920');
  await noHorizontalScroll('adopt plan @1920');
  assert((await dialog('adopt').evaluate((el) => el.getBoundingClientRect().width)) <= 577, 'a sheet, not full width, on a desktop');
  await page.keyboard.press('Escape');

  // ---- 10. A blocked check: plain reasons with their next step, no confirm; check again ----
  await open('legacy', { query: '?project=legacy', opts: { adopt: { blockedChecks: 1 } }, width: 375, height: 812 });
  await checkProject();
  const blockers = dialog('adopt').locator('[data-foundation-adopt-blockers]');
  await blockers.waitFor();
  assert.deepEqual(await blockers.locator('[data-foundation-blocker]').evaluateAll((els) => els.map((e) => e.getAttribute('data-foundation-blocker'))), ['BUILD_RUNNING', 'INSUFFICIENT_DISK']);
  const blockedText = await blockers.innerText();
  assert.match(blockedText, /A build is running on this project\.\s+Wait for it to finish, then check again\./);
  assert.match(blockedText, /The host has 0\.8 GB free; the move needs 1\.9 GB\.\s+Free up space on the host/);
  assert.equal(await dialog('adopt').getByRole('button', { name: 'Move this project' }).count(), 0, 'no confirm while blocked');
  assert.equal(await dialog('adopt').locator('#adopt-ack').count(), 0);
  await dialogFits('adopt', 'adopt blocked @375');
  await touchTargets('adopt blocked @375');
  await shot('flow-adopt-blocked-375');
  await dialog('adopt').getByRole('button', { name: 'Check again' }).click();
  await dialog('adopt').locator('[data-foundation-adopt-facts]').waitFor();
  assert.equal(await dialog('adopt').getByRole('button', { name: 'Move this project' }).count(), 1, 'once clear, the move can be confirmed');
  assert.deepEqual(writes(), ['POST /foundation/adopt/plan', 'POST /foundation/adopt/plan']);

  // ---- 11. Check → confirm (downtime acknowledged, sudo) → running → succeeded → the normal cards → roll back ----
  await open('legacy', { query: '?project=legacy', opts: { sudoOnce: true, adopt: {} }, width: 360, height: 640 });
  assert.equal(seen.filter((s) => s.endsWith('/foundation')).length, 0, 'a legacy project row is not read before the move');
  await checkProject();
  const planText = await dialog('adopt').innerText();
  assert.deepEqual(await dialog('adopt').locator('[data-foundation-adopt-plan-steps] li').allInnerTexts(), ADOPT_STEPS.map((s) => s.summary));
  assert.match(planText, /App offline\s+about 4 minutes/);
  assert.match(planText, /Database\s+412 MB · 37 tables/);
  assert.match(planText, /Disk\s+18\.4 GB free · 1\.9 GB needed/);
  assert.deepEqual(await dialog('adopt').locator('[data-foundation-adopt-secrets] li').allInnerTexts(), [...ADOPT_SECRETS]);
  assert.match(planText, /The native PostgreSQL is stopped and kept, not removed\./);
  assert.match(planText, /A snapshot of the project is taken first, so the move can be rolled back\. Nothing is deleted\./);
  assert(planText.includes(contract.LOCAL_EMBEDDINGS_WARNING), 'the local-embeddings note is shown while embeddings are on');
  const switches = dialog('adopt').getByRole('switch');
  assert.deepEqual(await switches.evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked'))), ['true', 'true'], 'both features on by default');
  await dialog('adopt').locator('[data-foundation-adopt-feature="adopt-embeddings"]').click();
  assert.equal(await dialog('adopt').locator('#adopt-embeddings').getAttribute('aria-checked'), 'false', 'tapping the row toggles it');
  const embOffText = await dialog('adopt').locator('[data-foundation-adopt-feature="adopt-embeddings"]').innerText();
  for (const d of contract.DEPENDENT_CAPABILITIES.embeddings) assert(embOffText.includes(d), `embeddings off lists "${d}"`);
  assert(!(await dialog('adopt').innerText()).includes(contract.LOCAL_EMBEDDINGS_WARNING), 'no local note while embeddings are off');
  await dialog('adopt').getByRole('button', { name: 'Move this project' }).click();
  assert.match(await dialog('adopt').innerText(), /Tick the box to confirm the downtime\./);
  assert.deepEqual(writes(), ['POST /foundation/adopt/plan'], 'nothing sent without the acknowledgement');
  await dialog('adopt').getByText('I understand the app is offline for about 4 minutes during the move.').click();
  await shot('flow-adopt-confirm-360');
  await dialog('adopt').getByRole('button', { name: 'Move this project' }).click();
  await page.locator('#sudo-password').waitFor();
  await page.locator('#sudo-password').fill('password');
  await page.locator('#sudo-totp').fill('123456');
  await settle();
  await page.locator('#sudo-totp').press('Enter');
  await dialog('adopt').waitFor({ state: 'detached' });
  assert.deepEqual(writes(), ['POST /foundation/adopt/plan', 'POST /foundation/adopt', 'POST /api/auth/sudo', 'POST /foundation/adopt']);
  assert.deepEqual(lastCall('/foundation/adopt').body, { plan_token: 'plan_1', acknowledge_downtime: true, features: { storage: 'on', embeddings: 'off' } });
  await adoption('running').waitFor();
  assert.equal(await adoption('running').locator('[data-adopt-step]').count(), ADOPT_STEPS.length);
  assert.equal(await moveButton().count(), 0);
  await noHorizontalScroll('adopt running @360');
  await touchTargets('adopt running @360');
  await shot('flow-adopt-running-360');
  // Polled every few seconds; the step list moves on by itself.
  await page.waitForFunction(() => document.querySelector('[data-adopt-step="install_stack"]')?.getAttribute('data-state') === 'running', null, { timeout: 15000 });
  await page.locator('[data-foundation-panel="ready"]').waitFor({ timeout: 30000 });
  assert(seen.some((s) => s === 'GET /api/mock2/projects/7/foundation'), 'the foundation is read again after the move');
  assert.match(await card('database').innerText(), /PostgreSQL 18 \+ pgvector/);
  assert.match(await card('embeddings').innerText(), /Off\. Search is unavailable/, 'the feature choice carried through');
  assert.match(await adoption('succeeded').innerText(), /Moved onto the foundation[\s\S]*Took \d+ s[\s\S]*You can still roll back/);
  assert.equal(await adoption('succeeded').locator('[data-adopt-step]').count(), 0, 'a short confirmation, not the step list');
  await noHorizontalScroll('adopted @360');
  await touchTargets('adopted @360');
  await shot('flow-adopt-done-360');
  await adoption('succeeded').getByRole('button', { name: 'Roll back' }).click();
  await dialog('adopt-rollback').waitFor();
  await dialogFits('adopt-rollback', 'roll back @360');
  assert.match(await dialog('adopt-rollback').innerText(), /Anything the app saved after the move is not in that snapshot\. Nothing is deleted\./);
  await dialog('adopt-rollback').getByRole('button', { name: 'Roll back' }).click();
  await dialog('adopt-rollback').waitFor({ state: 'detached' });
  await adoption('rolling_back').waitFor();
  await page.locator('[data-foundation-panel="legacy"]').waitFor({ timeout: 20000 });
  await adoption('rolled_back').waitFor();
  assert.match(await adoption('rolled_back').innerText(), /The project is back as it was before the move\. Nothing was deleted\./);
  assert.equal(await moveButton().count(), 1, 'after a roll back the move is offered again');
  assert.equal(writes().at(-1), 'POST /foundation/adopt/rollback');

  // ---- 12. A failure: the error, Resume and Roll back; roll back ----
  await open('legacy', { query: '?project=legacy', opts: { adopt: { failAt: 'copy_database' } }, width: 768, height: 1024 });
  await checkProject();
  await dialog('adopt').locator('#adopt-ack').check();
  await dialog('adopt').getByRole('button', { name: 'Move this project' }).click();
  await dialog('adopt').waitFor({ state: 'detached' });
  await adoption('failed').waitFor({ timeout: 20000 });
  const failedBlock = adoption('failed');
  assert.match(await failedBlock.locator('[data-foundation-adopt-error]').innerText(), /Copying the database failed: row counts differ in invoices/);
  assert.equal(await failedBlock.locator('[data-adopt-step="copy_database"]').getAttribute('data-state'), 'failed');
  // The step's detail says what the error says, so it is shown once.
  assert((await failedBlock.locator('[data-foundation-adopt-error]').innerText()).toLowerCase().includes(ADOPT_FAIL_DETAIL.toLowerCase().slice(0, -1)));
  assert.equal(await failedBlock.locator('[data-adopt-detail]').count(), 0, 'the error is not repeated under its step');
  assert.equal(await moveButton().count(), 0);
  await noHorizontalScroll('adopt failed @768');
  await shot('flow-adopt-failed-768');
  await failedBlock.getByRole('button', { name: 'Roll back' }).click();
  await dialog('adopt-rollback').waitFor();
  await dialogFits('adopt-rollback', 'roll back @768');
  assert.doesNotMatch(await dialog('adopt-rollback').innerText(), /saved after the move/);
  await dialog('adopt-rollback').getByRole('button', { name: 'Roll back' }).click();
  await adoption('rolled_back').waitFor({ timeout: 20000 });
  assert.equal(writes().at(-1), 'POST /foundation/adopt/rollback');
  assert.equal(await moveButton().count(), 1);

  // A failure → Resume continues from the failed step and finishes.
  await open('legacy', { query: '?project=legacy', opts: { adopt: { initial: 'failed' } }, width: 1280, height: 900 });
  await adoption('failed').getByRole('button', { name: 'Resume' }).click();
  await adoption('running').waitFor();
  assert.equal(writes().at(-1), 'POST /foundation/adopt/resume');
  assert.equal(await adoption('running').locator('[data-adopt-step="copy_database"]').getAttribute('data-state'), 'running');
  await page.locator('[data-foundation-panel="ready"]').waitFor({ timeout: 30000 });
  await adoption('succeeded').waitFor();
  await noHorizontalScroll('resumed @1280');
  await shot('flow-adopt-resumed-1280');

  // ---- 13. PLAN_STALE: checked again by itself; confirm again with the new plan ----
  await open('legacy', { query: '?project=legacy', opts: { adopt: { stale: 1 } }, width: 375, height: 812 });
  await checkProject();
  assert.match(await dialog('adopt').innerText(), /App offline\s+about 4 minutes/);
  await dialog('adopt').locator('#adopt-ack').check();
  await dialog('adopt').getByRole('button', { name: 'Move this project' }).click();
  await dialog('adopt').locator('[data-foundation-adopt-stale]').waitFor();
  assert.equal((await dialog('adopt').locator('[data-foundation-adopt-stale]').innerText()).trim(), STALE_TEXT);
  assert.match(await dialog('adopt').innerText(), /App offline\s+about 5 minutes/, 'the new plan is shown');
  assert.equal(await dialog('adopt').locator('#adopt-ack').isChecked(), false, 'the new downtime must be acknowledged again');
  assert.deepEqual(writes(), ['POST /foundation/adopt/plan', 'POST /foundation/adopt', 'POST /foundation/adopt/plan']);
  await dialogFits('adopt', 'adopt stale @375');
  await shot('flow-adopt-stale-375');
  await dialog('adopt').getByText('I understand the app is offline for about 5 minutes during the move.').click();
  await dialog('adopt').getByRole('button', { name: 'Move this project' }).click();
  await dialog('adopt').waitFor({ state: 'detached' });
  assert.equal(lastCall('/foundation/adopt').body.plan_token, 'plan_2');
  await adoption('running').waitFor();

  // ---- 14. Viewers: the note and the move's progress, read-only ----
  await open('legacy', { query: '?project=legacy&viewer=1', opts: { adopt: {} }, width: 375, height: 812 });
  assert.equal(await moveButton().count(), 0, 'a viewer is not offered the move');
  assert.match(await page.locator('[data-foundation-panel]').innerText(), /Only project editors can move it onto the foundation\./);
  await open('legacy', { query: '?project=legacy&viewer=1', opts: { adopt: { initial: 'running', advance: false } }, width: 375, height: 812 });
  await adoption('running').waitFor();
  assert.equal(await page.locator('[data-foundation-panel] button').count(), 0);
  await open('legacy', { query: '?project=legacy&viewer=1', opts: { adopt: { initial: 'failed' } }, width: 375, height: 812 });
  await adoption('failed').waitFor();
  assert.match(await adoption('failed').innerText(), /Copying the database failed/);
  assert.equal(await page.locator('[data-foundation-panel] button').count(), 0, 'no Resume, Roll back or Move for a viewer');
  await noHorizontalScroll('adopt viewer @375');
  await shot('state-adopt-viewer-375');
  await open('default', { query: '?viewer=1', opts: { adopt: { initial: 'succeeded' } }, width: 375, height: 812 });
  await adoption('succeeded').waitFor();
  assert.equal(await adoption('succeeded').locator('button').count(), 0);

  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  writeFileSync(`${artifacts}/report.json`, JSON.stringify({ ok: true, report }, null, 2));
  console.log(`foundation panel: ${report.length} states × ${WIDTHS.length} widths + 15 journeys (6 adoption) passed; screenshots in ${artifacts}`);
} finally {
  await browser.close();
  await vite.close();
}
