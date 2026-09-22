// Run after npm run build. Uses only a disposable API/SQLite fixture.
// CHROMIUM_EXECUTABLE_PATH may select an installed browser. Backend already
// declares playwright-core and axe-core; optional Lighthouse is run separately.
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const dir = mkdtempSync(join(tmpdir(), 'g1-browser-'));
const output = resolve(process.env.G1_EVIDENCE_DIR || join(dir, 'evidence')); mkdirSync(output, { recursive: true });
let server, browser;
async function boot(port = '') {
  const child = fork(new URL('../../backend/src/__tests__/helpers/platform-api-fixture.js', import.meta.url), [], { env: { ...process.env, PLATFORM_TEST_DB: join(dir, 'state.db'), PLATFORM_TEST_PORT: String(port), PROXYPILOT_AGENT_SOCKET: join(dir, 'absent.sock'), JWT_SECRET: 'g1-disposable-browser-verification-secret' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  const info = await Promise.race([once(child, 'message').then(([m]) => m), once(child, 'exit').then(([c]) => { throw new Error(`fixture ${c}: ${errors}`); })]);
  return { ...info, child, stop: async () => { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } };
}
try {
  server = await boot();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=9222'] });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  await context.addCookies([{ name: 'pp_token', value: server.tokens.admin, url: server.url }, { name: 'pp_csrf', value: 'g1-browser-csrf', url: server.url }]);
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${server.url}/platform-setup`); await page.getByRole('heading', { name: 'Platform Setup', exact: true }).waitFor();
  await page.getByRole('group', { name: 'Keycloak choice' }).getByRole('radio', { name: 'Install', exact: true }).check();
  await page.getByLabel('Keycloak origin', { exact: true }).fill('https://identity.example.com');
  await page.getByLabel('Keycloak realm', { exact: true }).fill('proxypilot');
  await page.getByRole('group', { name: 'Infisical with Agent Proxy choice' }).getByRole('radio', { name: 'Connect existing', exact: true }).check();
  await page.getByLabel('Infisical with Agent Proxy origin', { exact: true }).fill('https://secrets.example.com');
  await page.getByLabel('Agent Proxy origin', { exact: true }).fill('https://agent.example.com');
  await page.getByRole('button', { name: 'Run available checks' }).click(); await page.getByText('Setup runner', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: '2. Review and save' }).click();
  assert.equal(await page.getByRole('button', { name: 'Review Keycloak changes' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Activate login — unavailable' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Save reviewed plan' }).click();
  await page.getByRole('status').filter({ hasText: 'Saved plan · revision 1' }).waitFor();
  await page.reload(); await page.getByLabel('Keycloak origin', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Keycloak origin', { exact: true }).inputValue(), 'https://identity.example.com');
  const port = new URL(server.url).port; await server.stop(); server = null; server = await boot(port);
  await page.reload(); await page.getByLabel('Agent Proxy origin', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Agent Proxy origin', { exact: true }).inputValue(), 'https://agent.example.com');
  const audits = [];
  for (const width of [360, 375, 390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const step of ['1. Choose services', '2. Review and save']) {
      await page.getByRole('button', { name: step, exact: true }).click();
      await page.waitForFunction(label => [...document.querySelectorAll('button[aria-current=step]')].some(b => b.textContent === label), step);
      await page.addStyleTag({ content: 'html, body { overflow-x: visible !important; }' });
      const result = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, shortButtons: [...document.querySelectorAll('main button')].filter(b => b.textContent.match(/Save reviewed|Run available|Reopen saved|View events|Refresh jobs|Choose services|Review and save/)).filter(b => b.getBoundingClientRect().height < 44).map(b => b.textContent) }));
      assert.equal(result.scrollWidth, result.clientWidth, `${width} ${step} overflow`); assert.deepEqual(result.shortButtons, []);
      audits.push({ width, step, ...result });
      if ([360, 1280].includes(width)) {
        await page.locator('h1').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `${width}-${step[0]}.png`) });
        const target = step.startsWith('1') ? page.getByLabel('Agent Proxy origin', { exact: true }) : page.getByRole('button', { name: 'Save reviewed plan' });
        await target.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `${width}-${step[0]}-form.png`) });
      }
    }
  }
  await page.getByRole('button', { name: 'Review Keycloak changes', exact: true }).click();
  await page.getByRole('region', { name: 'Reviewed Keycloak changes' }).waitFor();
  for (const width of [360, 375, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Apply Keycloak installation', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    assert.ok(await page.getByRole('button', { name: 'Apply Keycloak installation' }).evaluate(el => el.getBoundingClientRect().height >= 44));
    if ([360,1280].includes(width)) await page.getByRole('region', { name: 'Reviewed Keycloak changes' }).screenshot({path:join(output, `${width}-keycloak-review.png`)});
  }
  await page.getByRole('button', { name: 'Apply Keycloak installation', exact: true }).click();
  await page.getByRole('status').filter({hasText:'Runner unavailable'}).waitFor();
  await page.reload();
  await page.getByRole('heading', {name:'Set up Keycloak',exact:true}).waitFor();
  await page.getByText('runner_unavailable:',{exact:false}).first().waitFor();
  // Inspect persisted engine states and server-redacted events in the real UI.
  await page.getByRole('button', { name: 'View events for example-succeeded' }).click();
  await page.getByRole('region', { name: 'Selected job events' }).waitFor();
  assert.match(await page.getByRole('region', { name: 'Selected job events' }).innerText(), /\[redacted\]/);
  assert.ok(!(await page.locator('body').innerText()).includes('must-not-appear'));
  assert.match(await page.locator('body').innerText(), /Pending: credential use verified/);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addScriptTag({ content: readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8') });
  const axe = await page.evaluate(async () => window.axe.run(document.querySelector('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const serious = axe.violations.filter(v => ['serious', 'critical'].includes(v.impact));
  assert.deepEqual(serious.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  // Real Lighthouse, using the browser's authenticated cookie context.
  let lighthouseScore = null;
  if (process.env.G1_LIGHTHOUSE_MODULE) {
    const { default: lighthouse } = await import(process.env.G1_LIGHTHOUSE_MODULE);
    const result = await lighthouse(`${server.url}/platform-setup`, { port: 9222, onlyCategories: ['accessibility'], output: 'json', logLevel: 'error', formFactor: 'mobile', screenEmulation: { mobile: true, width: 360, height: 800, deviceScaleFactor: 1, disabled: false }, extraHeaders: { Cookie: `pp_token=${server.tokens.admin}; pp_csrf=g1-browser-csrf` }, disableStorageReset: true });
    lighthouseScore = result.lhr.categories.accessibility.score * 100;
    writeFileSync(join(output, 'lighthouse.json'), result.report);
    assert.ok(lighthouseScore >= 90, `Lighthouse mobile accessibility ${lighthouseScore}`);
  }
  const userContext = await browser.newContext();
  await userContext.addCookies([{ name: 'pp_token', value: server.tokens.user, url: server.url }]);
  const nonAdmin = await userContext.newPage(); await nonAdmin.goto(`${server.url}/platform-setup`);
  await nonAdmin.waitForURL(`${server.url}/`); assert.equal(await nonAdmin.getByRole('link', { name: 'Platform Setup', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  const evidence = { audits, axeViolations: axe.violations.map(v => v.id), lighthouseScore, apiRestart: 'passed', nonAdmin: 'passed', errors };
  writeFileSync(join(output, 'results.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally { if (browser) await browser.close(); if (server) await server.stop(); rmSync(dir, { recursive: true, force: true }); }
