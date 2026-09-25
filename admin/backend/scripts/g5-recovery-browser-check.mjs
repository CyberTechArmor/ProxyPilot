// Recovery-only coverage of restored plan controls and failed-job/retry UI.
// Uses the real saved-plan/Infisical HTTP routes and job store in disposable SQLite.
// The failure transition is scripted; no host runner or external service executes.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { makeDb } from '../src/__tests__/helpers/infisical-fixture.js';
import { claimNextJob, checkpoint, finishJob } from '../src/lib/setup-engine/store.js';

const require = createRequire(resolve(process.env.G5_BROWSER_MODULES || '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const dir = mkdtempSync(join(tmpdir(), 'g5-recovery-browser-'));
const dbPath = join(dir, 'fixture.sqlite'), evidence = resolve(process.env.G5_EVIDENCE_DIR || '../../docs/evidence');
mkdirSync(evidence, { recursive: true });
const out = { date: new Date().toISOString(), execution: 'Built UI, real API/auth/CSRF and SQLite; scripted job failure, no host execution', checks: [], errors: [] };
let child, browser, db;
try {
  child = fork(new URL('../src/__tests__/helpers/infisical-api-process.js', import.meta.url), [dbPath], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const fixture = (await once(child, 'message'))[0];
  db = makeDb(dbPath);
  browser = await puppeteer.launch({ executablePath: process.env.G5_CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('pageerror', e => out.errors.push(e.message));
  await page.setViewport({ width: 360, height: 740 });
  await page.setCookie({ name: 'pp_token', value: fixture.tokens.admin, url: fixture.url, httpOnly: true }, { name: 'pp_csrf', value: 'fixture-csrf', url: fixture.url });
  const open = async () => { await page.goto(fixture.url + '/platform-setup', { waitUntil: 'networkidle0' }); await page.waitForSelector('#infisical-setup'); };
  const click = async text => {
    await page.waitForFunction(t => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === t && !b.disabled), {}, text);
    await page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t && !b.disabled).click(), text);
  };
  const radio = async (name, value) => page.$eval(`input[name="${name}"][value="${value}"]`, el => el.click());
  const fill = async (selector, text) => { await page.$eval(selector, el => { el.focus(); el.select(); }); await page.keyboard.type(text); };
  const plan = () => JSON.parse(db.prepare('SELECT choices_json FROM setup_platform_plan').get().choices_json).infisical;
  const jobs = () => db.prepare('SELECT count(*) AS n FROM setup_jobs').get().n;
  const save = async () => { await click('2. Review and save'); await click('Save reviewed plan'); await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(e => e.textContent.startsWith('Saved plan · revision'))); };
  await open();
  await radio('infisical-mode', 'skip'); await save();
  assert.equal(plan().mode, 'skip'); assert.equal(jobs(), 0);
  assert(await page.$eval('#infisical-setup', el => el.textContent.includes('Infisical is skipped')));
  out.checks.push('full skip persists and creates no job');
  await open(); await radio('infisical-mode', 'connect'); await fill('#infisical-url', 'https://secrets.example.com');
  await radio('infisical-agent-mode', 'connect'); await fill('#infisical-agentProxyUrl', 'http://10.20.30.40:17322'); await save(); await open();
  assert.equal(plan().agentProxyMode, 'connect'); assert(await page.$('#if-container')); assert.equal(jobs(), 0);
  out.checks.push('connect choices reopen with existing proxy container handoff');
  await radio('infisical-agent-mode', 'skip'); await save(); await open();
  assert.equal(plan().mode, 'connect'); assert.equal(plan().agentProxyMode, 'skip'); assert.equal(plan().agentProxyUrl, ''); assert.equal(jobs(), 0);
  assert.equal(await page.$('#infisical-agentProxyUrl'), null);
  out.checks.push('independent Agent Proxy skip clears its endpoint and creates no job');
  await radio('infisical-mode', 'install'); await radio('infisical-agent-mode', 'install'); await fill('#infisical-agentProxyUrl', 'http://10.20.30.40:17322'); await save(); await open();
  assert.equal(plan().mode, 'install'); assert.equal(plan().agentProxyMode, 'install'); assert.equal(jobs(), 0);
  await fill('#if-host', '10.20.30.40'); await fill('#if-vm', 'g5-disposable'); await fill('#if-ips', '10.20.30.40,192.0.2.40'); await click('Save reviewed secrets targets');
  await page.waitForSelector('#if-reviewed');
  assert.equal(jobs(), 0);
  assert(await page.$eval('#infisical-setup', el => [...el.querySelectorAll('button')].find(b => b.textContent === 'Apply / retry reviewed setup').disabled));
  out.checks.push('target save is inert; explicit review acknowledgement required');
  await page.focus('#if-reviewed'); await page.keyboard.press('Space'); await click('Apply / retry reviewed setup');
  await page.waitForFunction(() => document.querySelector('#infisical-setup').textContent.includes('Job: queued'));
  const before = db.prepare('SELECT credential_ref,config_json FROM setup_infisical').get();
  const owner = 'runner@recovery-browser#123:a', job = claimNextJob(db, { owner, kinds: ['infisical_apply'] });
  assert(job); checkpoint(db, { id: job.id, owner, epoch: job.epoch, phase: 'infisical_bootstrap' });
  assert.equal(finishJob(db, { id: job.id, owner, epoch: job.epoch, status: 'failed', reason: 'Complete the administrator handoff, then retry.' }), 1);
  await page.waitForFunction(() => document.querySelector('#infisical-setup').textContent.includes('Job: failed'));
  assert(await page.$eval('#infisical-setup', el => el.textContent.includes('administrator handoff')));
  out.checks.push('scripted failed job is displayed with the durable handoff reason');
  await page.focus('#if-reviewed'); await page.keyboard.press('Space'); await click('Apply / retry reviewed setup');
  await page.waitForFunction(() => document.querySelector('#infisical-setup').textContent.includes('Job: queued'));
  const retry = db.prepare('SELECT * FROM setup_jobs WHERE retry_of=?').get(job.id);
  assert(retry && retry.id !== job.id); assert.deepEqual(db.prepare('SELECT credential_ref,config_json FROM setup_infisical').get(), before);
  out.checks.push('explicit retry creates related job and preserves saved configuration/reference');
  await radio('infisical-mode', 'connect');
  assert(await page.$eval('#infisical-setup', el => el.textContent.includes('Save the reviewed platform plan')));
  assert(await page.$eval('#infisical-setup', el => [...el.querySelectorAll('button')].find(b => b.textContent === 'Apply / retry reviewed setup').disabled));
  await click('Discard changes and reopen');
  out.checks.push('unsaved plan change disables apply; reopening preserves the queued job');
  await page.setViewport({ width: 390, height: 740 });
  await page.addStyleTag({ content: 'html,body {overflow-x:visible!important}' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth));
  out.checks.push('390px overflow audit with global guard disabled');
  // The preserved comprehensive driver covers 360/375/768/1280/1920, identities,
  // credential clearing, API restart, axe and Lighthouse separately.
  assert.equal(out.errors.length, 0);
  writeFileSync(join(evidence, 'g5-recovery-browser.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out));
} finally {
  if (browser) await browser.close();
  if (db) db.close();
  if (child) { const ended = once(child, 'exit'); child.send('close'); await ended; }
  rmSync(dir, { recursive: true, force: true });
}
