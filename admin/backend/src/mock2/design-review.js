// Mock2 DESIGN REVIEW — the native half (browsers, containers, model calls).
// The pure decision layer (prompt, parse, lint, composition) lives in
// design-review-logic.js so it is unit-testable without a container.
//
// What runs here:
//   captureAppScreens  — screenshot the DEPLOYED app (mobile + desktop) via the
//                        same chromium the smoke connector uses, logging in with
//                        the ui-checks fixture users when a login block exists,
//                        and run axe-core per page (fail-open when absent).
//   runDesignReview    — screenshots + approved mockup + design tokens → vision
//                        critique (strict JSON) + deterministic extras (axe,
//                        rogue-color lint) → chat message; optionally composes
//                        the findings into a queued quick "polish" build.
//   captureOneScreenshot — a single JPEG for the annotate-on-screenshot dialog.
//
// NEVER a gate: a review failure is logged and swallowed — builds ship on the
// gate battery, not on taste.
//
// Terminology (risk R7): nothing here is named "agent".

import { createRequire } from 'node:module';
import { sh, b64 } from './host.js';
import { loadChromium, launchOptions, loginAs } from './ui-checks.js';
import { resolveBrowserTarget } from './smoke.js';
import { parseUiChecks, UI_CHECKS_PATH } from './ui-check-logic.js';
import {
  buildReviewPrompt, parseReviewReply, rogueCssColors, reviewChatMessage, composePolishInstruction,
} from './design-review-logic.js';
import { MOCKUP_CURRENT } from './concept-logic.js';
import { callModelTurn } from './model-client.js';
import { buildRunnerReady } from './runner.js';
import { insertLedgerEntry } from './quotas.js';
import { costCentsForUsage, effectivePrice } from './usage-logic.js';
import { insertMessage } from './chats.js';
import { enqueueBuild, drainBuildQueue } from './build-queue.js';
import { getDesignReviewSetting } from './settings.js';

const APP_DIR = '/srv/app';
const MOBILE = { width: 390, height: 780 };
const DESKTOP = { width: 1280, height: 800 };
const MAX_PATHS = 4; // × (mobile + desktop on the first two) ≤ 6 shots per review
const NAV_TIMEOUT_MS = 20000;

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readContainerFile(containerName, relPath) {
  const r = await containerSh(containerName, `cat '${APP_DIR}/${relPath}' 2>/dev/null`);
  return r.code === 0 ? (r.stdout || '') : '';
}

// axe-core source, loaded lazily from node_modules; null when not installed
// (older install that hasn't re-run npm install) — the review runs without it.
let axeSourceCache;
function loadAxeSource() {
  if (axeSourceCache !== undefined) return axeSourceCache;
  try {
    const require = createRequire(import.meta.url);
    const { readFileSync } = require('node:fs');
    axeSourceCache = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  } catch { axeSourceCache = null; }
  return axeSourceCache;
}

// The paths worth shooting: '/' always, '/login', plus the pages the project's
// own ui-checks spec exercises (they are the screens the builds touched).
function pathsToShoot(spec) {
  const paths = ['/', '/login'];
  for (const chk of spec?.checks || []) {
    if (chk.page && !paths.includes(chk.page)) paths.push(chk.page);
  }
  return paths.slice(0, MAX_PATHS);
}

// Screenshot the deployed app. Returns { shots, axe, detail } — shots are
// JPEG base64 (cheaper tokens than PNG at review fidelity). Never throws.
export async function captureAppScreens({ containerName, webPort = 3000, paths = null, withAxe = true }) {
  const chromium = await loadChromium();
  if (!chromium) return { shots: [], axe: [], detail: 'playwright-core is not installed (rerun update.sh / npm install)' };
  const baseUrl = await resolveBrowserTarget(containerName, webPort);
  const specText = await readContainerFile(containerName, UI_CHECKS_PATH);
  const parsed = specText ? parseUiChecks(specText) : { ok: false };
  const spec = parsed.ok ? parsed.spec : null;
  const targets = paths?.length ? paths.slice(0, MAX_PATHS) : pathsToShoot(spec);
  const axeSource = withAxe ? loadAxeSource() : null;

  let browser = null;
  const shots = [];
  const axeViolations = [];
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 1 });
    const page = await context.newPage();
    // Authenticated pages need a session — log in with the spec's first fixture
    // role when one exists; without a spec the login/bootstrap pages still shoot.
    if (spec?.login && Object.keys(spec.login.users || {}).length) {
      const role = spec.login.users.admin ? 'admin' : Object.keys(spec.login.users)[0];
      try { await loginAs(page, baseUrl, spec.login, role); } catch { /* unauth shots still useful */ }
    }
    for (let i = 0; i < targets.length; i++) {
      const path = targets[i];
      try {
        await page.setViewportSize(MOBILE);
        await page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
        const mobileShot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
        shots.push({ path, width: MOBILE.width, media_type: 'image/jpeg', data: mobileShot.toString('base64') });
        if (axeSource) {
          try {
            await page.addScriptTag({ content: axeSource });
            const res = await page.evaluate(async () => {
              // eslint-disable-next-line no-undef
              const r = await axe.run(document, { resultTypes: ['violations'] });
              return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help }));
            });
            for (const v of res || []) axeViolations.push({ page: path, ...v });
          } catch { /* axe is advisory */ }
        }
        // Desktop shot for the first two paths only (layout collapse is the
        // mobile question; desktop verifies the wide arrangement).
        if (i < 2) {
          await page.setViewportSize(DESKTOP);
          await page.waitForTimeout(250);
          const deskShot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
          shots.push({ path, width: DESKTOP.width, media_type: 'image/jpeg', data: deskShot.toString('base64') });
        }
      } catch (err) {
        console.warn(`[mock2] design-review screenshot failed for ${path}:`, err?.message);
      }
    }
    return { shots, axe: axeViolations, detail: null };
  } catch (err) {
    return { shots, axe: axeViolations, detail: `browser error: ${err?.message || err}` };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}

// One screenshot for the annotate dialog. Returns { ok, buffer, error }.
export async function captureOneScreenshot({ containerName, webPort = 3000, path = '/', width = 390 }) {
  const chromium = await loadChromium();
  if (!chromium) return { ok: false, error: 'playwright-core is not installed (rerun update.sh / npm install)' };
  const baseUrl = await resolveBrowserTarget(containerName, webPort);
  const specText = await readContainerFile(containerName, UI_CHECKS_PATH);
  const parsed = specText ? parseUiChecks(specText) : { ok: false };
  const spec = parsed.ok ? parsed.spec : null;
  const w = Math.min(1600, Math.max(320, Number(width) || 390));
  let browser = null;
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: { width: w, height: Math.round(w * 2) }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    if (spec?.login && Object.keys(spec.login.users || {}).length) {
      const role = spec.login.users.admin ? 'admin' : Object.keys(spec.login.users)[0];
      try { await loginAs(page, baseUrl, spec.login, role); } catch { /* unauth shot */ }
    }
    // Paths are operator-clicked UI values, but sanitize anyway: same-origin only.
    const safePath = String(path || '/').startsWith('/') ? String(path) : '/';
    await page.goto(new URL(safePath, baseUrl).toString(), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
    const buf = await page.screenshot({ type: 'png', fullPage: true });
    return { ok: true, buffer: buf };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}

// The whole review. trigger: 'manual' (Polish pass) | 'auto' (after build).
// apply=true composes the findings into a queued quick polish build.
// Returns { ok, findings, message, queued, error }. Never throws.
export async function runDesignReview({ project, trigger = 'manual', apply = false, initiatedBy = null }) {
  const containerName = project.container_name;
  if (!containerName || project.lifecycle !== 'active') {
    return { ok: false, error: 'The project is not online.' };
  }
  const ready = buildRunnerReady();
  if (!ready.ok) return { ok: false, error: ready.reason || 'No build model connector is ready.' };

  const capture = await captureAppScreens({ containerName, webPort: project.web_port || 3000 });
  if (!capture.shots.length) {
    return { ok: false, error: capture.detail || 'Could not capture any screenshots of the app.' };
  }

  // The visual contract + tokens ride the critique; both optional (older projects).
  const mockupHtml = await readContainerFile(containerName, MOCKUP_CURRENT);
  const tokensJson = await readContainerFile(containerName, 'state/design-tokens.json');

  // Deterministic extra: rogue colors in the app's own stylesheets (never
  // base.css/design.css — those ARE the system).
  let rogue = [];
  try {
    const cssList = await containerSh(containerName,
      `for f in ${APP_DIR}/public/*.css; do case "$f" in *base.css|*design.css) ;; *) cat "$f" 2>/dev/null;; esac; done`);
    if (tokensJson) rogue = rogueCssColors(cssList.stdout || '', tokensJson);
  } catch { /* advisory */ }

  const model = String(process.env.MOCK2_REVIEW_MODEL || '').trim() || ready.model;
  const userText = [
    `Screens shot (in order, mobile ${MOBILE.width}px first; the first two paths also have a ${DESKTOP.width}px desktop shot): ${capture.shots.map((s) => `${s.path}@${s.width}`).join(', ')}.`,
    tokensJson ? `Design tokens:\n${tokensJson.slice(0, 4000)}` : 'No design tokens file.',
    mockupHtml ? `Approved mockup HTML (the visual contract):\n${mockupHtml.slice(0, 120000)}` : 'No approved mockup — judge craft and consistency on their own.',
  ].join('\n\n');
  const res = await callModelTurn({
    connector: ready.connector, apiKey: ready.apiKey, model,
    system: buildReviewPrompt(), tools: [],
    transcript: [{ role: 'user', text: userText, images: capture.shots.map((s) => ({ media_type: s.media_type, data: s.data })) }],
    maxTokens: 2500, effort: 'high', thinking: null, timeoutMs: 240000,
  });
  if (!res.ok) return { ok: false, error: `review model call failed: ${res.error || 'unknown'}` };
  try {
    const u = res.usage || {};
    const cost = costCentsForUsage({
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
      cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
    }, effectivePrice(ready.connector.id, model));
    insertLedgerEntry({ projectId: project.id, cycleId: null, connectorId: ready.connector.id, model, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents: cost, wallClockMs: 0 });
  } catch (e) { console.warn('[mock2] design-review ledger write failed:', e?.message); }

  const review = parseReviewReply(res.text) || { summary: '', findings: [] };
  const message = reviewChatMessage({ review, axe: capture.axe, rogue, trigger, screenshotCount: capture.shots.length });
  try { insertMessage({ projectId: project.id, kind: 'system', body: message }); } catch { /* best effort */ }

  let queued = null;
  if (apply) {
    const instruction = composePolishInstruction({ review, axe: capture.axe, rogue });
    if (instruction) {
      queued = enqueueBuild({ projectId: project.id, instruction, buildMode: 'quick', label: 'Polish pass fixes', initiatedBy });
      drainBuildQueue(project.id).catch((e) => console.warn('[mock2] polish drain failed:', e?.message));
    }
  }
  return { ok: true, findings: review.findings, summary: review.summary, axe: capture.axe, rogue, message, queued };
}

// The after-build hook (fire-and-forget from the request-close chain): honors
// the dashboard toggle, posts findings to the chat, never blocks or fails the
// close. In-process re-entrancy guard so back-to-back closes don't stack
// browser sessions.
const autoReviewRunning = new Set();
export async function maybeAutoDesignReview(project) {
  try {
    if (getDesignReviewSetting() !== 'on') return;
    if (!project || project.lifecycle !== 'active') return;
    if (autoReviewRunning.has(project.id)) return;
    autoReviewRunning.add(project.id);
    try {
      await runDesignReview({ project, trigger: 'auto', apply: false });
    } finally {
      autoReviewRunning.delete(project.id);
    }
  } catch (e) {
    console.warn('[mock2] auto design review failed:', e?.message);
  }
}
