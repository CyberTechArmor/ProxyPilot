// Real full dashboard -> session/CSRF -> Operations router/store -> website
// review service -> bounded public extraction -> cited result. DNS/HTTP and
// model responses are SCRIPTED FIXTURES, not a public-network/provider proof.
// Run `node tests/website-review-integrated.browser.mjs --service-only` for the
// local HTTP/service checks without launching Chromium.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startWebsiteReviewHarness, CSRF, REVIEW_CONSENT, SUMMARY, WEBSITE } from './website-review-integrated-harness.mjs';

const serviceOnly = process.argv.includes('--service-only');
const report = { source_commit: process.env.SOURCE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), real_operations_router: true, real_operations_store: true, real_csrf: true, real_website_review_service: true, scripted_fixtures: ['authenticated session', 'DNS/HTTP public page transport', 'model adapter and readiness'], production_provider_proof: false, journeys: [], layout: [] };
const artifacts = process.env.BROWSER_ARTIFACTS;
if (artifacts) mkdirSync(artifacts, { recursive: true });
const h = await startWebsiteReviewHarness({ useVite: !serviceOnly });
const base = `/api/operational-projects/${h.project.id}`;
let browser, context, page;
const errors = [], outbound = [], consoleMessages = [], failedRequests = [], failedResponses = [];
async function api(path, { method = 'GET', body, revision, role = 'owner', csrf = CSRF } = {}) {
  const res = await fetch(h.origin + path, { method, headers: { Cookie: `pp_review_fixture_session=${role}; pp_csrf=${CSRF}`, 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...(revision ? { 'If-Match': `"${revision}"` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
const startBody = agent => ({ agent_id: agent.id, agent_revision: agent.revision, guide_version_id: agent.guide_version_id, guide_hash: agent.guide_hash });
const savedAgent = () => h.service.listAgents(h.users.owner, h.project.id).agents[0];
const savedRuns = () => h.service.listRuns(h.users.owner, h.project.id).runs;
const noExecution = () => { assert.equal(h.transport.length, 0); assert.equal(h.modelCalls.length, 0); assert.equal(savedRuns().length, 0); assert.equal(h.queued.length, 0); };
async function assertPins(run, agent) {
  assert.equal(run.pins.guide_version_id, h.version.id); assert.equal(run.pins.guide_hash, h.version.content_hash); assert.equal(run.pins.agent_revision, agent.revision);
  assert.equal(run.pins.project_revision, h.f.store.get(h.users.owner, h.project.id).revision); assert.equal(run.pins.url, WEBSITE); assert.equal(run.pins.objective, 'Summarize the public museum website');
  assert.equal(run.pins.workflow, 'public_website_review'); assert.equal(run.pins.strategy, 'http_extract_v1');
}
async function inspectCompletion(run) {
  assert.equal(run.state, 'completed'); assert.equal(run.sources.length, 2); assert.equal(run.result.review.summary, SUMMARY);
  assert.deepEqual(run.result.review.citations, [{ source_id: 1, url: WEBSITE }, { source_id: 2, url: `${WEBSITE}about` }]);
  assert.deepEqual(run.result.usage, { prompt_tokens: 800, completion_tokens: 150 }); assert.equal(run.result.settled_usd, '0.001');
  assert.equal(h.modelCalls.length, 1); assert.equal(h.modelCalls[0].guide_hash, h.version.content_hash);
  assert.deepEqual(h.transport.map(r => r.url), [`${WEBSITE}robots.txt`, WEBSITE, `${WEBSITE}about`]);
  assert.equal(h.modelCalls[0].credential, undefined); assert.equal(h.modelCalls[0].binding_id, undefined);
  assert.throws(() => h.f.db.prepare('UPDATE ops_website_review_runs SET pins_json=? WHERE id=?').run('{}', run.id), /immutable/);
}
async function audit(page, state) {
  for (const width of [360, 375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.addStyleTag({ content: 'html,body{overflow-x:visible!important}' });
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    assert(size.scroll <= size.width, `${state}: horizontal overflow at ${width}: ${size.scroll}`); report.layout.push({ state, ...size });
    if (artifacts) await page.screenshot({ path: `${artifacts}/website-review-integrated-${state}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 900 });
}
try {
  // A real protected mutation rejects a missing/mismatched token before save.
  const input = { name: 'Public museum reader', url: WEBSITE, objective: 'Summarize the public museum website', guide_version_id: h.version.id, guide_hash: h.version.content_hash, limits: { max_pages: 3, max_seconds: 120, max_tokens: 20000, max_usd: 0.05 } };
  assert.equal((await api(`${base}/website-review-agents`, { method: 'POST', body: input, csrf: 'wrong' })).status, 403);
  noExecution();
  if (serviceOnly) {
    let response = await api(`${base}/website-review-agents`, { method: 'POST', body: input }); assert.equal(response.status, 201); let agent = response.data.agent;
    noExecution();
    response = await api(`${base}/website-review-agents/${agent.id}/model-consent`, { method: 'PUT', revision: agent.revision, body: { enabled: true, reviewed_statement: REVIEW_CONSENT } }); assert.equal(response.status, 200); agent = response.data.agent; noExecution();
    assert.equal((await api(`${base}/website-review-runs`, { method: 'POST', body: startBody(agent), role: 'viewer' })).status, 403); noExecution();
    assert.equal((await api(`${base}/website-review-runs`, { method: 'POST', body: { ...startBody(agent), agent_revision: 1 } })).status, 409); noExecution();
    const readiness = (await api(`${base}/website-review-agents/${agent.id}/readiness`)).data.readiness; assert.equal(readiness.can_start, true); assert.equal(readiness.pins.guide_hash, h.version.content_hash);
    response = await api(`${base}/website-review-runs`, { method: 'POST', body: startBody(agent) }); assert.equal(response.status, 202); await assertPins(response.data.run, agent); assert.equal(h.transport.length, 0);
    await h.executeNext(); await inspectCompletion((await api(`${base}/website-review-runs/${response.data.run.id}`, { role: 'viewer' })).data.run);
    report.journeys.push('Real CSRF/role/stale-pin refusals; inert save and consent; explicit Start completes real bounded extraction and cited review');
    h.scenario.providerCode = 'PRICE_UNKNOWN';
    const unavailable = (await api(`${base}/website-review-agents/${agent.id}/readiness`)).data.readiness; assert.equal(unavailable.can_start, false); assert.equal(unavailable.checks.find(c => c.kind === 'provider').code, 'PRICE_UNKNOWN');
    assert.equal((await api(`${base}/website-review-runs`, { method: 'POST', body: startBody(agent) })).data.code, 'PRICE_UNKNOWN'); assert.equal(savedRuns().length, 1); assert.equal(h.transport.length, 3); h.scenario.providerCode = null;
    h.holdNextModel(); const cancelled = (await api(`${base}/website-review-runs`, { method: 'POST', body: startBody(agent) })).data.run; const execution = h.executeNext(); await h.waitForModel();
    const cancellation = await api(`${base}/website-review-runs/${cancelled.id}/cancel`, { method: 'POST', body: {} }); assert.equal(cancellation.data.run.state, 'cancelled'); h.releaseModel(); await execution;
    const after = (await api(`${base}/website-review-runs/${cancelled.id}`)).data.run; assert.equal(after.state, 'cancelled'); assert.equal(after.result.review, undefined); assert.equal(after.result.model_spend, 'may_be_reserved'); assert.equal(h.modelCalls.length, 2);
    report.journeys.push('Unavailable provider prevents Start; cancellation during model await suppresses a late cited result');
  } else {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '../../backend/node_modules/playwright-core/index.mjs');
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width: 375, height: 900 } });
    await context.addCookies([{ name: 'pp_review_fixture_session', value: 'owner', url: h.origin }, { name: 'pp_csrf', value: CSRF, url: h.origin }]);
    await context.addInitScript(() => { localStorage.setItem('mock2HintDismissed', '1'); localStorage.setItem('pp-theme', 'office'); });
    // Fail closed if any test accidentally asks the browser for outbound data.
    await context.route('**/*', route => { if (!route.request().url().startsWith(h.origin) && !route.request().url().startsWith('data:')) { outbound.push(route.request().url()); return route.abort(); } return route.continue(); });
    page = await context.newPage(); page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000); page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() }); });
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() }); });
    await page.goto(`${h.origin}/operational-projects/${h.project.id}?section=Website%20reviews`);
    await page.getByRole('heading', { name: 'Public website reviews', exact: true }).waitFor({ timeout: 90000 });
    await page.getByRole('button', { name: 'Refresh reviews', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New review agent', exact: true }).click();
    await page.getByLabel('Review agent name').fill(input.name); await page.getByLabel('Public website URL').fill(input.url); await page.getByLabel('Review objective').fill(input.objective);
    await audit(page, 'new-agent');
    await page.getByRole('button', { name: 'Save review agent', exact: true }).click();
    await page.getByRole('button', { name: 'Give model consent', exact: true }).waitFor(); noExecution();
    let agent = savedAgent(); assert.equal(agent.model_consent, false); assert.equal(agent.guide_version_id, h.version.id); assert.equal(agent.guide_hash, h.version.content_hash);
    assert.equal(await page.getByRole('button', { name: 'Start website review', exact: true }).isEnabled(), false);
    await page.getByRole('checkbox', { name: /I reviewed:/ }).check(); await page.getByRole('button', { name: 'Give model consent', exact: true }).click();
    await page.getByText('Ready to start', { exact: true }).waitFor(); noExecution(); agent = savedAgent(); assert.equal(agent.revision, 2); assert.equal(agent.model_consent, true);
    report.journeys.push('Full main dashboard navigation, real atomic approved freeform guide, inert settings save and explicit owner consent');
    h.scenario.providerCode = 'PROVIDER_UNAVAILABLE';
    await page.getByRole('button', { name: 'Refresh reviews', exact: true }).click(); await page.getByText('PROVIDER_UNAVAILABLE', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Start website review', exact: true }).isEnabled(), false); noExecution();
    h.scenario.providerCode = null;
    await page.getByRole('button', { name: 'Refresh reviews', exact: true }).click(); await page.getByText('Ready to start', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start website review', exact: true }).click(); await page.getByRole('region', { name: 'Website review result' }).waitFor();
    let run = savedRuns()[0]; assert.equal(run.state, 'queued'); await assertPins(run, agent); assert.equal(h.modelCalls.length, 0); assert.equal(h.transport.length, 0);
    const startRequest = h.requests.find(r => r.method === 'POST' && r.path === `${base}/website-review-runs`); assert.deepEqual(startRequest.body, startBody(agent));
    await h.executeNext(); const result = page.getByRole('region', { name: 'Website review result' });
    await result.getByRole('heading', { name: 'Cited model review', exact: true }).waitFor();
    run = h.service.status(h.users.owner, h.project.id, run.id).run; await inspectCompletion(run);
    await result.getByText(SUMMARY, { exact: true }).waitFor(); await result.getByText('$0.001000', { exact: true }).waitFor();
    assert.equal(await result.locator('dt').filter({ hasText: /^Input tokens$/ }).locator('..').locator('dd').textContent(), '800');
    assert.equal(await result.locator('dt').filter({ hasText: /^Output tokens$/ }).locator('..').locator('dd').textContent(), '150');
    await result.getByText('Sources and extraction evidence (2)', { exact: true }).click(); await result.getByRole('heading', { name: /Source 2.*Museum learning/ }).waitFor();
    for (const source of run.sources) { await result.getByText(`Content SHA-256: ${source.content_hash}`, { exact: true }).waitFor(); assert.equal(await result.getByRole('link', { name: source.url, exact: true }).first().getAttribute('href'), source.url); }
    await result.getByText('Immutable run guide and agent pins', { exact: true }).click(); await result.getByText(h.version.id, { exact: true }).waitFor(); await result.getByText(h.version.content_hash, { exact: true }).waitFor();
    await audit(page, 'completed-evidence'); report.journeys.push('Exact-pin Start traverses real routes/service/extraction and renders cited completion, source hashes, usage and settled cost');
    await page.getByText('Ready to start', { exact: true }).waitFor(); h.holdNextModel();
    await page.getByRole('button', { name: 'Start website review', exact: true }).click(); const cancelled = savedRuns().find(r => r.id !== run.id); const execution = h.executeNext(); await h.waitForModel();
    await result.getByText('The model review is in progress.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel website review', exact: true }).click(); await result.getByText('CANCELLED', { exact: true }).waitFor();
    h.releaseModel(); await execution; const after = h.service.status(h.users.owner, h.project.id, cancelled.id).run;
    assert.equal(after.state, 'cancelled'); assert.equal(after.result.review, undefined); assert.equal(after.result.model_spend, 'may_be_reserved'); assert.equal(after.pins.guide_hash, run.pins.guide_hash);
    assert.equal(await result.getByRole('heading', { name: 'Cited model review', exact: true }).count(), 0); await result.getByText('This result does not confirm zero cost.', { exact: false }).waitFor();
    await audit(page, 'cancelled'); report.journeys.push('Provider-unavailable readiness disables Start; cancellation during model await retains immutable pins and blocks late review publication');
    const writes = h.requests.filter(r => ['POST', 'PUT', 'PATCH'].includes(r.method) && r.path.startsWith(base) && r.status < 400);
    assert(writes.every(r => r.csrf === CSRF)); assert.equal(writes.filter(r => r.path.endsWith('/model-consent'))[0].if_match, '"1"');
    assert.equal(h.requests.some(r => r.method === 'POST' && /\/agent-runs$|\/tasks$|\/task-proposals\/.+\/start$/.test(r.path)), false, 'website journey does not start synthetic/broker work');
    assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
  }
  report.transport_requests = h.transport.length; report.model_calls = h.modelCalls.length;
  console.log(`PASS ${serviceOnly ? 'local service/HTTP checks' : 'full dashboard browser journey'}: ${report.journeys.join('; ')}`);
} finally {
  if (artifacts) {
    writeFileSync(`${artifacts}/website-review-integrated-report.json`, JSON.stringify({ ...report, errors, outbound, consoleMessages, failedRequests, failedResponses }, null, 2));
    if (page) writeFileSync(`${artifacts}/website-review-integrated-final.html`, await page.content().catch(() => 'Page closed'));
  }
  h.releaseModel(); await context?.close(); await browser?.close(); await h.close();
}
