// UI contract fixtures exercise the real component, API client and styles.
// They do not prove the runtime's public-network fence or provider readiness.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '../../backend/node_modules/playwright-core/index.mjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = '/__website-review-fixture.jsx';
const fixture = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WebsiteReviews} from '/src/components/operational-projects/WebsiteReviews.jsx';
import {operationsApi} from '/src/lib/api.js';
import {ThemeProvider} from '/src/context/ThemeContext.jsx';
import '/src/index.css';
function Fixture(){const[p,setP]=useState(null);async function refresh(){const r=await operationsApi.get('/fixture-project');setP(r.project);}useEffect(()=>{window.__refreshProject=refresh;refresh();},[]);return <main className="p-4 md:p-8 mx-auto max-w-6xl">{p&&<WebsiteReviews base="/fixture-project" project={p} onChanged={refresh}/>}</main>}
createRoot(document.getElementById('root')).render(<ThemeProvider><Fixture/></ThemeProvider>);`;
const vite = await createServer({ root, logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-dev-runtime', 'lucide-react'] }, server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
  name: 'website-review-ui-fixture', resolveId(id) { if (id === entry) return id; }, load(id) { if (id === entry) return fixture; },
  configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url !== '/__website-review-fixture') return next();
    res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, `<html lang="en"><head><title>Website review fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
  }); },
}] });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 900 } });
await context.addCookies([{ name: 'pp_csrf', value: 'website-review-ui-fixture', url: origin }]);
await context.addInitScript(() => localStorage.setItem('pp-theme', 'office'));
const page = await context.newPage(); page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000);
const errors = [], requests = [], external = [], report = { fixture_only: true, source_commit: process.env.SOURCE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), journeys: [], layout: [] };
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) external.push(r.url()); });
const guide = { id: '10000000-0000-4000-8000-000000000001', version_number: 1, content_hash: 'a'.repeat(64) };
let project = { id: 'fixture-project', own_role: 'owner', revision: 1, archived_at: null, current_version: { ...guide } };
const agentId = '20000000-0000-4000-8000-000000000001', runId = '30000000-0000-4000-8000-000000000001';
const limits = { max_pages: 3, max_seconds: 120, max_tokens: 20000, max_usd: 0.05 };
const statement = "Send this review agent's approved guide and public page content to the model provider";
let agents = [], runs = [], bridge = true, conflict = false, deny = false, freshMismatch = false, nextResult = 'completed';
function readiness(a) {
  const checks = [
    { kind: 'guide', state: project.current_version?.id === a.guide_version_id && project.current_version?.content_hash === a.guide_hash ? 'ready' : 'blocked', code: 'STALE_CONFIGURATION', next_action: 'select_current_approved_guide' },
    { kind: 'consent', state: a.model_consent ? 'ready' : 'blocked', code: 'MODEL_CONSENT_REQUIRED', next_action: 'owner_model_consent' },
    { kind: 'provider', state: bridge ? 'ready' : 'blocked', code: 'REVIEW_MODEL_BRIDGE_UNAVAILABLE', next_action: 'review_existing_provider_configuration' },
  ].map(c => c.state === 'ready' ? { ...c, code: 'READY', next_action: null } : c);
  return { contract_version: 'website-review.v1', can_start: checks.every(c => c.state === 'ready'), checks,
    pins: { agent_revision: a.revision + (freshMismatch ? 1 : 0), project_revision: project.revision, guide_version_id: a.guide_version_id, guide_hash: a.guide_hash },
    capabilities: { workflow: 'public_website_review', strategy: 'http_extract_v1', read_only: true, credential_binding_required: false, javascript_rendering: false, supported_content: ['text/html', 'text/plain'], limits, model: 'gpt-6-luna', max_model_calls: 1 } };
}
function makeRun(a, state = 'reviewing') {
  const at = '2026-10-02T10:00:00.000Z';
  return { id: runId, agent_id: a.id, project_id: project.id, user_id: 'fixture-owner', state, created_at: at, updated_at: at,
    pins: { agent_revision: a.revision, guide_version_id: a.guide_version_id, guide_hash: a.guide_hash, url: a.url, objective: a.objective, task_hash: 'b'.repeat(64), limits },
    sources: [{ id: 1, url: a.url, title: 'Public city garden guide', excerpt: 'A public community garden guide describes opening hours and seasonal plants. <script>fetch("https://private.invalid")</script>', content_hash: 'c'.repeat(64), excerpt_hash: 'd'.repeat(64), extracted_at: at }],
    activity: [{ at, kind: 'extraction_started' }, { at, kind: 'page_extracted', url: a.url }, { at, kind: 'model_reserved' }], result: null };
}
function complete(r) {
  r.state = 'completed'; r.result = { review: { summary: 'The public garden guide explains opening hours and seasonal planting, but it does not give clear accessibility information.', findings: ['Opening hours are stated.', 'Accessibility details are missing.'], limitations: ['HTML/text extraction cannot inspect interactive maps.'], citations: [{ source_id: 1, url: r.pins.url }] }, model: 'gpt-6-luna', usage: { prompt_tokens: 850, completion_tokens: 220 }, settled_usd: 0.003, price_table_revision: 'fixture-price-v1', receipt: { run_id: r.id, signature: 'fixture-signature'.repeat(10) }, scope: 'Public HTML/text extraction; no login, browser JavaScript or website writes.' };
}
await page.route('**/api/**', async route => {
  const r = route.request(), path = new URL(r.url()).pathname, method = r.method(), body = r.postDataJSON();
  requests.push({ path, method, body, headers: r.headers() });
  const answer = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (method !== 'GET') assert.equal(r.headers()['x-csrf-token'], 'website-review-ui-fixture');
  if (deny) return answer({ error: 'Project access revoked', code: 'ACCESS_DENIED' }, 403);
  const base = '/api/operational-projects/fixture-project';
  if (path === base) return answer({ project });
  if (path === base + '/website-review-agents') {
    if (method === 'GET') return answer({ agents });
    assert.equal(method, 'POST'); assert.equal(project.own_role, 'owner');
    assert.deepEqual(Object.keys(body).sort(), ['guide_hash', 'guide_version_id', 'limits', 'name', 'objective', 'url']);
    assert.equal(body.guide_version_id, guide.id); assert.equal(body.guide_hash, guide.content_hash);
    agents = [{ ...body, id: agentId, revision: 1, model_consent: false, workflow_type: 'public_website_review', strategy: 'http_extract_v1', credential_binding_required: false }];
    return answer({ agent: agents[0] }, 201);
  }
  if (path === base + `/website-review-agents/${agentId}`) {
    if (method === 'GET') return answer({ agent: agents[0] });
    assert.equal(method, 'PATCH'); assert.equal(r.headers()['if-match'], `"${agents[0].revision}"`);
    if (conflict) { conflict = false; agents[0].revision++; return answer({ error: 'Revision conflict' }, 412); }
    agents[0] = { ...agents[0], ...body, revision: agents[0].revision + 1, model_consent: false }; return answer({ agent: agents[0] });
  }
  if (path === base + `/website-review-agents/${agentId}/model-consent`) {
    assert.equal(method, 'PUT'); assert.equal(project.own_role, 'owner'); assert.equal(r.headers()['if-match'], `"${agents[0].revision}"`);
    assert.deepEqual(body, body.enabled ? { enabled: true, reviewed_statement: statement } : { enabled: false });
    agents[0].model_consent = body.enabled; agents[0].revision++; return answer({ agent: agents[0] });
  }
  if (path === base + `/website-review-agents/${agentId}/readiness`) return answer({ readiness: readiness(agents[0]) });
  if (path === base + '/website-review-runs') {
    if (method === 'GET') return answer({ runs });
    assert.equal(method, 'POST'); assert.equal(agents[0].model_consent, true);
    assert.deepEqual(body, { agent_id: agentId, agent_revision: agents[0].revision, guide_version_id: guide.id, guide_hash: guide.content_hash });
    assert.equal(requests.at(-2).path, base + `/website-review-agents/${agentId}/readiness`, 'Start must recheck readiness immediately before its POST');
    runs = [makeRun(agents[0])]; return answer({ run: runs[0] }, 202);
  }
  if (path === base + `/website-review-runs/${runId}/cancel`) {
    assert.equal(method, 'POST'); assert.deepEqual(body, {});
    runs[0].state = 'cancelled'; runs[0].result = { code: 'CANCELLED', message: 'The review was cancelled. No further website requests or review publication will occur.', model_spend: 'may_be_reserved' }; return answer({ run: runs[0] });
  }
  if (path === base + `/website-review-runs/${runId}`) {
    if (nextResult === 'completed') complete(runs[0]);
    if (nextResult === 'unsupported') { runs[0].state = 'blocked'; runs[0].sources = []; runs[0].result = { code: 'CLIENT_RENDER_REQUIRED', message: 'This page requires browser rendering. The current review strategy extracts HTML/text; choose a server-rendered page.', model_spend: 'not_requested' }; }
    return answer({ run: runs[0] });
  }
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
});
const button = name => page.getByRole('button', { name, exact: true });
const starts = () => requests.filter(r => r.method === 'POST' && r.path.endsWith('/website-review-runs'));
async function consent() { await page.getByRole('checkbox', { name: `I reviewed: ${statement}.` }).check(); await button('Give model consent').click(); await page.getByText('Ready to start', { exact: true }).waitFor(); }
async function reload() { await page.reload(); await page.getByRole('heading', { name: 'Public website reviews', exact: true }).waitFor(); await page.getByText('Loading website reviews…', { exact: true }).waitFor({ state: 'hidden' }); }
try {
  await page.goto(origin + '/__website-review-fixture', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Public website reviews', exact: true }).waitFor({ timeout: 90000 });
  await page.getByText('No website review agents yet.', { exact: true }).waitFor();
  await button('New review agent').click();
  assert.equal(await page.getByRole('heading', { name: 'New review agent', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.getByLabel('Review agent name', { exact: true }).fill('Garden accessibility review');
  await page.getByLabel('Public website URL', { exact: true }).fill('https://public.example.org/garden');
  await page.getByLabel('Review objective', { exact: true }).fill('Assess practical visitor information and accessibility against the approved guide.');
  await button('Save review agent').click(); await page.getByRole('heading', { name: 'Garden accessibility review' }).waitFor();
  assert.equal(starts().length, 0); assert.equal(requests.filter(r => r.path.endsWith('/model-consent')).length, 0);
  assert.equal(await button('Give model consent').isDisabled(), true); assert.equal(await button('Start website review').isDisabled(), true);
  report.journeys.push('Save pins the approved guide; Save neither grants consent nor starts a review.');
  await consent(); assert.equal(starts().length, 0);
  await button('Edit review agent').click(); await page.getByLabel('Review objective', { exact: true }).fill('Compare clear visitor information with the guide.');
  await button('Save review agent').click(); await page.getByText('Model consent: not given', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox').isChecked(), false); assert.equal(await button('Start website review').isDisabled(), true);
  report.journeys.push('Editing resets consent and readiness; the exact reviewed statement requires a separate owner action.');
  await consent(); freshMismatch = true;
  await button('Start website review').click(); await page.getByRole('alert').filter({ hasText: 'Readiness changed' }).waitFor(); assert.equal(starts().length, 0);
  freshMismatch = false; await button('Refresh reviews').click(); await page.getByText('Ready to start', { exact: true }).waitFor();
  report.journeys.push('A fresh readiness response with a different agent revision cannot start a review.');
  await button('Start website review').click(); await page.getByRole('heading', { name: 'Review result · reviewing' }).waitFor();
  await page.getByRole('heading', { name: 'Cited model review' }).waitFor();
  await page.getByText('$0.003000', { exact: true }).waitFor(); await page.getByText('850', { exact: true }).waitFor();
  assert.equal(starts().length, 1);
  report.journeys.push('Explicit Start sends exact saved revision and guide pins; completed review shows citations, tokens, cost and receipt.');
  await page.getByText('Sources and extraction evidence (1)', { exact: true }).click(); await page.getByText('Provider receipt', { exact: true }).click();
  assert.equal(await page.locator('iframe,img').count(), 0); assert.equal(await page.locator('script[src*="private.invalid"]').count(), 0);
  await page.getByText('Content SHA-256:', { exact: false }).waitFor();
  const layouts = {};
  for (const width of [360, 375, 390, 768, 1280, 1536, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['office', 'latte', 'midnight']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'midnight'); document.documentElement.style.overflowX = 'visible'; document.body.style.overflowX = 'visible'; }, theme);
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, boxes: [...document.querySelectorAll('button,h2,h3,input,textarea')].map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }), buttons: [...document.querySelectorAll('button')].map(el => ({ name: el.textContent.trim(), height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width })) }));
      assert.equal(layout.scrollWidth, layout.width, `${width}/${theme} must not overflow with CSS overflow guards disabled`);
      if (width < 640) for (const b of layout.buttons) assert.ok(b.height >= 44 && b.width >= 44, `${b.name} must meet the phone touch target`);
      if (layouts[width]) assert.deepEqual(layout.boxes, layouts[width], `Theme ${theme} must change color only at ${width}`); else layouts[width] = layout.boxes;
      report.layout.push({ width, theme, horizontal_overflow: false });
      if (process.env.BROWSER_ARTIFACTS) { mkdirSync(process.env.BROWSER_ARTIFACTS, { recursive: true }); await page.screenshot({ path: `${process.env.BROWSER_ARTIFACTS}/website-review-${theme}-${width}.png`, fullPage: true, animations: 'disabled' }); }
    }
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await button('Edit review agent').click(); await page.getByLabel('Review agent name', { exact: true }).fill('Retained local edit'); conflict = true;
  await button('Save review agent').click(); await page.getByRole('alert').filter({ hasText: 'Revision conflict' }).waitFor();
  assert.equal(await page.getByLabel('Review agent name', { exact: true }).inputValue(), 'Retained local edit'); assert.equal(await button('Save review agent').isDisabled(), true);
  await button('Reload saved configuration').click(); await page.getByLabel('Review agent name', { exact: true }).fill('Garden accessibility review');
  await button('Cancel editing').click(); report.journeys.push('CAS conflict preserves local input and requires explicit reload before another save.');
  bridge = false; await button('Refresh reviews').click(); await page.getByText('REVIEW_MODEL_BRIDGE_UNAVAILABLE', { exact: true }).waitFor(); assert.equal(await button('Start website review').isDisabled(), true);
  bridge = true; await button('Refresh reviews').click(); await page.getByText('Ready to start', { exact: true }).waitFor();
  nextResult = 'active'; await button('Start website review').click(); await page.getByRole('heading', { name: 'Review result · reviewing' }).waitFor(); await button('Cancel website review').click();
  await page.getByText('Model spending may remain reserved; an accepted call may still settle. This result does not confirm zero cost.', { exact: true }).waitFor(); assert.equal(await button('Cancel website review').count(), 0);
  report.journeys.push('Unavailable runtime bridge is honest; cancellation preserves accepted-call spending uncertainty.');
  nextResult = 'unsupported'; await button('Start website review').click(); await page.getByText('CLIENT_RENDER_REQUIRED', { exact: true }).waitFor(); await page.getByText('The model was not requested for this run.', { exact: true }).waitFor();
  report.journeys.push('Client-rendered page refusal shows the fixed typed outcome without a fabricated review.');
  project.current_version = null; await page.evaluate(() => window.__refreshProject()); await page.getByText('No current approved guide.', { exact: false }).waitFor(); assert.equal(await button('New review agent').isDisabled(), true);
  project.current_version = { ...guide }; project.own_role = 'viewer'; await reload(); assert.equal(await button('New review agent').count(), 0); assert.equal(await button('Give model consent').count(), 0); assert.equal(await button('Start website review').count(), 0);
  project.own_role = 'editor'; agents[0].model_consent = false; await reload(); assert.equal(await button('Give model consent').count(), 0); assert.equal(await button('Edit review agent').count(), 1);
  project.own_role = 'owner'; project.archived_at = '2026-10-02T12:00:00Z'; await reload(); assert.equal(await button('New review agent').count(), 0); assert.equal(await button('Start website review').count(), 0);
  project.archived_at = null; await reload(); deny = true; await button('Refresh reviews').click(); await page.getByRole('alert').filter({ hasText: 'your access has changed' }).waitFor(); assert.equal(await page.getByRole('heading', { name: 'Garden accessibility review' }).count(), 0); assert.equal(await button('New review agent').count(), 0);
  report.journeys.push('Missing guide, viewer/editor restrictions, archival and revoked access clear or disable the relevant controls.');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  if (process.env.BROWSER_ARTIFACTS) writeFileSync(`${process.env.BROWSER_ARTIFACTS}/website-review-ui-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) { if (process.env.BROWSER_ARTIFACTS) { mkdirSync(process.env.BROWSER_ARTIFACTS, { recursive: true }); await page.screenshot({ path: `${process.env.BROWSER_ARTIFACTS}/website-review-failure.png`, fullPage: true }); } throw e; }
finally { await browser.close(); await vite.close(); }
