// Task continuity — the build chat's task strip, in a real browser at phone,
// tablet and desktop widths (MOBILE_FIRST pre-merge checklist), plus the real
// BuildChat over a stubbed API: reload with a live task, Resume carrying the
// composer text, and a routed send that must clear the composer and open no
// card. Presentation fixture only; no backend, container or model is involved.
//
//   node tests/task-strip.browser.mjs
// Env: BROWSER_EXE (Chromium binary), PLAYWRIGHT_CORE (path to playwright-core's
// index.mjs when admin/backend/node_modules is not installed), BROWSER_ARTIFACTS
// (screenshot directory, default .artifacts/task-strip).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE || '../../backend/node_modules/playwright-core/index.mjs');
const artifacts = process.env.BROWSER_ARTIFACTS || '.artifacts/task-strip';
mkdirSync(artifacts, { recursive: true });

const vite = await createServer({ root: new URL('..', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || undefined, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// ---- the stubbed API (chat view) ----
const KEY = 't12-add-invoice-export';
const shape = (over) => ({
  key: KEY, id: 12, intent: 'build', status: 'interrupted', unfinished: true, goal: 'Add invoice export',
  request_id: 34, last_cycle_id: 88, live: false, resumed: false, can_resume: true,
  last_verified_step: 'Checkpoint 1a2b3c4 committed', next_step: 'Resume from the last checkpoint',
  remaining: ['Run checks'], blockers: [], uncertain: ['Check whether the deploy completed before repeating it'],
  checks: [], completed_steps: [{ step: 'Build started', at: '2026-10-21T10:00:00.000Z' }],
  files: { task_json: `state/tasks/${KEY}/task.json`, handoff_md: `state/tasks/${KEY}/handoff.md` },
  created_at: '2026-10-21T10:00:00.000Z', updated_at: '2026-10-21T10:05:00.000Z', finished_at: null, ...over,
});
let currentTask = null;
const calls = [];
await page.route('**/api/**', async (route) => {
  const r = route.request();
  const p = new URL(r.url()).pathname;
  const answer = (json, status = 200) => route.fulfill({ status, json });
  if (r.method() !== 'GET') calls.push({ method: r.method(), path: p, body: r.postData() ? JSON.parse(r.postData()) : null });
  if (p === '/api/mock2/projects/7/chat') {
    return answer({ messages: [{ id: 1, kind: 'user', body: 'Add invoice export', created_at: '2026-10-21T10:00:00.000Z' }, { id: 2, kind: 'system', body: 'The build stopped when the server restarted.', created_at: '2026-10-21T10:05:00.000Z' }], open_question_ids: [], ask_job: null, current_task: currentTask });
  }
  if (p === '/api/mock2/projects/7/time-summary') return answer({ usage: { total_cost_cents: 123, today: { cost_cents: 5 } } });
  if (p === `/api/mock2/projects/7/tasks/${KEY}/resume`) {
    currentTask = shape({ status: 'active', live: true, resumed: true, uncertain: [] });
    return answer({ routed: { action: 'resume_build', task: currentTask, note: 'Resuming build: Add invoice export' } }, 202);
  }
  if (p === '/api/mock2/projects/7/ask') {
    return answer({ routed: { action: 'answer_required', task: currentTask, note: 'Add invoice export is waiting for your answers before it can continue.' } });
  }
  if (p === '/api/mock2/projects/7/cycles') {
    // A routed build-lane answer that LOOKS like it could carry proposals —
    // the chat must not read them.
    return answer({ routed: { action: 'stop_task', task: null, note: 'Stopped: Add invoice export' }, split_proposal: { instruction: 'x', parts: [{ title: 'never shown', items: ['a'] }] } });
  }
  return answer({});
});
await page.route('**/task-strip-test*', async (route) => route.fulfill({
  contentType: 'text/html',
  body: await vite.transformIndexHtml('/task-strip-test', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task strip fixture</title></head><body><div id="root"></div><script type="module" src="/tests/task-strip-fixture.jsx"></script></body></html>'),
}));

// The index.css overflow guard hides horizontal scroll; the audit runs without it.
const unguard = () => page.addStyleTag({ content: 'html,body{overflow-x:visible!important}' });
const noHorizontalScroll = async (label) => {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.equal(sw, cw, `${label}: horizontal scroll (${sw} > ${cw})`);
};
const WIDTHS = [[360, 640], [375, 812], [768, 1024], [1280, 900]];
const report = [];

try {
  // ---- 1. every state, isolated, at each width ----
  for (const viewer of [false, true]) {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`${origin}/task-strip-test?view=strips${viewer ? '&viewer=1' : ''}`);
    await page.locator('[data-task-strip]').first().waitFor();
    await unguard();
    const cases = await page.locator('[data-case]').evaluateAll((els) => els.map((e) => e.dataset.case));
    assert.deepEqual(cases, ['building', 'resuming', 'investigating', 'interrupted', 'interrupted_plain', 'failed', 'blocked', 'waiting']);
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height });
      await noHorizontalScroll(`strips ${width}${viewer ? ' viewer' : ''}`);
      for (const name of cases) {
        const strip = page.locator(`[data-case="${name}"] [data-task-strip]`);
        const m = await strip.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const buttons = [...el.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => ({ text: b.innerText.trim(), h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width }));
          const line = el.querySelector('.truncate');
          const status = line.querySelector('.font-medium');
          return {
            h: r.height, overflow: el.scrollWidth - el.clientWidth, buttons,
            clipped: line.scrollWidth > line.clientWidth,
            // The status words ("Interrupted:") must never be the part that is cut off.
            statusVisible: status.getBoundingClientRect().right <= line.getBoundingClientRect().right + 0.5,
            title: el.querySelector('[title]')?.getAttribute('title') || '',
          };
        });
        assert(m.overflow <= 0, `${name} @${width}: content wider than the strip`);
        assert(m.statusVisible, `${name} @${width}: the status words are clipped`);
        if (width < 640) {
          for (const b of m.buttons.filter((x) => ['Resume', 'Try again', 'Stop', 'Show'].includes(x.text))) {
            assert(b.h >= 44, `${name} @${width}: "${b.text}" is ${b.h}px tall`);
          }
          // Compact at rest: a live task is one 44px row plus padding; a task
          // with actions adds ONE 44px line for its buttons (they stack rather
          // than squeeze the status); "Will check first" (one line + more on a
          // phone) adds one short line.
          const withActions = !viewer && !['building', 'resuming', 'investigating'].includes(name);
          const limit = (withActions || (viewer && name === 'waiting') ? 88 : 56) + (['interrupted', 'failed'].includes(name) ? 30 : 0);
          assert(m.h <= limit, `${name} @${width}: ${m.h}px tall at rest (limit ${limit})`);
        }
        const actionTexts = m.buttons.map((b) => b.text).filter((t) => ['Resume', 'Try again', 'Stop', 'Show'].includes(t));
        const expected = viewer ? (name === 'waiting' ? ['Show'] : []) : {
          building: [], resuming: [], investigating: [], interrupted: ['Resume', 'Stop'], interrupted_plain: ['Resume', 'Stop'],
          failed: ['Try again'], blocked: ['Resume'], waiting: ['Show'],
        }[name];
        assert.deepEqual(actionTexts, expected, `${name} @${width}${viewer ? ' viewer' : ''}: actions`);
        if (name === 'interrupted' && width === 360) assert(m.clipped, 'a long goal is clipped to one line');
        if (name === 'interrupted') assert.match(m.title, /scheduled monthly email/, 'the full goal is in the tooltip');
        if (width === 360 && !viewer) report.push(`${name}: ${Math.round(m.h)}px at rest, actions ${JSON.stringify(m.buttons.filter((b) => actionTexts.includes(b.text)).map((b) => `${b.text} ${Math.round(b.w)}x${Math.round(b.h)}`))}`);
      }
      await page.screenshot({ path: `${artifacts}/strips-${viewer ? 'viewer-' : ''}${width}.png`, fullPage: true });
    }
    if (viewer) continue;
    // Copy at rest.
    const words = await page.locator('[data-case] [data-task-strip]').evaluateAll((els) => els.map((e) => e.querySelector('.truncate').innerText.trim()));
    assert.deepEqual(words.map((w) => w.split(':')[0]), ['Building', 'Resuming build', 'Investigating', 'Interrupted', 'Interrupted', 'Stopped with an error', 'Blocked', 'Waiting on you']);
    assert.match(words[6], /^Blocked: Over budget/, 'blocked names the first blocker');
    // Expand every expandable strip at 360 and 768: no overflow, details bounded.
    for (const [width, height] of [[360, 1400], [768, 1400]]) {
      await page.setViewportSize({ width, height });
      for (const name of cases) {
        const toggle = page.locator(`[data-case="${name}"] [data-task-toggle]`);
        if (await toggle.count()) { if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click(); }
      }
      await noHorizontalScroll(`expanded ${width}`);
      const interrupted = page.locator('[data-case="interrupted"] [data-task-strip]');
      await interrupted.getByText('Will check first:', { exact: true }).waitFor();
      assert.equal(await interrupted.locator('li').filter({ hasText: 'email job' }).count(), 1, 'expanded lists every uncertain item');
      await page.locator('[data-case="failed"]').getByRole('button', { name: 'Stop this task' }).waitFor();
      await page.screenshot({ path: `${artifacts}/strips-expanded-${width}.png`, fullPage: true });
    }
    // Buttons call through.
    await page.locator('[data-case="interrupted"]').getByRole('button', { name: 'Resume', exact: true }).click();
    await page.locator('[data-case="interrupted"]').getByRole('button', { name: 'Stop', exact: true }).click();
    await page.locator('[data-case="waiting"]').getByRole('button', { name: 'Show', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__actions), [['resume', 'interrupted'], ['stop', 'interrupted'], ['show', 'waiting']]);
  }

  // ---- 2. the real BuildChat ----
  // 2a. A reload while a resumed build is live: the strip says so at once.
  currentTask = shape({ status: 'active', live: true, resumed: true, uncertain: [] });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}/task-strip-test?view=chat`);
  const strip = page.locator('[data-task-strip]');
  await strip.waitFor();
  assert.equal(await strip.getAttribute('data-task-state'), 'resuming');
  assert.match(await strip.innerText(), /Resuming build: Add invoice export/);
  await unguard();
  await noHorizontalScroll('chat live 360');
  await page.screenshot({ path: `${artifacts}/chat-resuming-360.png` });

  // 2b. Interrupted, the person types guidance and presses Resume.
  currentTask = shape({});
  await page.goto(`${origin}/task-strip-test?view=chat`);
  await strip.waitFor();
  assert.equal(await strip.getAttribute('data-task-state'), 'interrupted');
  const composer = page.locator('textarea').last();
  const [s, c] = await Promise.all([strip.boundingBox(), composer.boundingBox()]);
  assert(s.y + s.height <= c.y, 'the strip sits above the composer');
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    await unguard();
    await noHorizontalScroll(`chat interrupted ${width}`);
    await page.screenshot({ path: `${artifacts}/chat-interrupted-${width}.png` });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await composer.fill('Skip the PDF part for now');
  await strip.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByText('Resuming build: Add invoice export').first().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-task-strip]')?.dataset.taskState === 'resuming');
  assert.equal(await composer.inputValue(), '', 'guidance sent → composer cleared');
  const resume = calls.find((x) => x.path.endsWith('/resume'));
  assert.deepEqual(resume.body, { message: 'Skip the PDF part for now' });
  assert(await page.evaluate(() => window.__started) >= 1, 'the parent is told work started');
  await page.screenshot({ path: `${artifacts}/chat-after-resume-375.png` });

  // 2c. Routed sends: the composer clears, the note is shown, no card opens.
  currentTask = shape({ status: 'blocked', can_resume: false, blockers: ['Waiting for answers to open questions'], uncertain: [] });
  await page.goto(`${origin}/task-strip-test?view=chat`);
  await strip.waitFor();
  assert.equal(await strip.getAttribute('data-task-state'), 'waiting');
  await composer.fill('continue');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByText('Add invoice export is waiting for your answers before it can continue.').first().waitFor();
  assert.equal(await composer.inputValue(), '');
  await composer.fill('stop');
  await page.getByRole('button', { name: /Quick update|Queue update/ }).click();
  await page.getByText('Stopped: Add invoice export').first().waitFor();
  assert.equal(await composer.inputValue(), '');
  assert.equal(await page.getByText('never shown').count(), 0, 'a routed answer never opens the split card');
  assert.equal(await page.getByText(/several deliverables/).count(), 0);
  await page.screenshot({ path: `${artifacts}/chat-routed-375.png` });

  // 2d. A viewer sees the strip without buttons.
  currentTask = shape({});
  await page.goto(`${origin}/task-strip-test?view=chat&viewer=1`);
  await strip.waitFor();
  assert.equal(await strip.getByRole('button', { name: /^(Resume|Stop|Try again)$/ }).count(), 0, 'viewers get no task buttons');
  assert.match(await strip.innerText(), /Interrupted: Add invoice export/);

  assert.deepEqual(errors, []);
  console.log(report.join('\n'));
  console.log(`task-strip: ok — screenshots in ${artifacts}`);
} finally {
  await browser.close();
  await vite.close();
}
