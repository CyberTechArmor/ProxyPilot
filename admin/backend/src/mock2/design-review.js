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
  checkDesignAdherence,
} from './design-review-logic.js';
import { MOCKUP_CURRENT } from './concept-logic.js';
import { callStepTurn, stepSystemPrompt } from './harness-steps.js';
import { buildRunnerReady } from './runner.js';
import { insertLedgerEntry } from './quotas.js';
import { costCentsForUsage } from './quota-logic.js';
import { effectivePrice } from './connectors.js';
import { insertMessage } from './chats.js';
import { saveChatImages } from './chat-images.js';
import { enqueueBuild, drainBuildQueue } from './build-queue.js';
import { getDesignReviewSetting } from './settings.js';
import { ensureReviewAccount, getReviewLogin, REVIEW_EMAIL } from './review-account.js';

const APP_DIR = '/srv/app';
const MOBILE = { width: 390, height: 780 };
const DESKTOP = { width: 1280, height: 800 };
const MAX_PATHS = 4; // × (mobile + desktop on the first two) ≤ 6 shots per review
const NAV_TIMEOUT_MS = 20000;
const LOGIN_TIMEOUT_MS = 12000;
const SETTLE_MS = 700;

// Navigate for a screenshot. waitUntil 'networkidle' looked right but HANGS on
// apps that poll (a ticking TimeClock fetching /api/dashboard every second
// never goes idle) — domcontentloaded + a short settle is what actually
// finishes everywhere.
async function gotoSettled(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

// Best-effort login, bounded — fixture users may have been deleted (New-6's
// users table was wiped and re-bootstrapped); an unauthenticated shot of the
// login page is still useful, so never let a dead login stall the capture.
// Sign in with the OPERATOR's app account (annotate dialog): generic
// selectors against the scaffold's standard sign-in form. Bounded and
// best-effort like tryLogin — a failed login just leaves the signed-out
// detection to tell the truth. Credentials are used in-memory only: never
// logged, never stored.
async function tryOperatorLogin(page, baseUrl, creds) {
  if (!creds?.email || !creds?.password) return;
  try {
    await Promise.race([
      (async () => {
        await page.goto(new URL('/login', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.locator('input[type="email"], input[name="email"], input[name="username"]').first().fill(String(creds.email), { timeout: 5000 });
        await page.locator('input[type="password"]').first().fill(String(creds.password), { timeout: 5000 });
        await page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 5000 });
        await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('operator login timed out')), LOGIN_TIMEOUT_MS)),
    ]);
  } catch { /* signed-out detection + the dialog hint still tell the truth */ }
}

async function tryLogin(page, baseUrl, spec) {
  if (!spec?.login || !Object.keys(spec.login.users || {}).length) return;
  const role = spec.login.users.admin ? 'admin' : Object.keys(spec.login.users)[0];
  try {
    await Promise.race([
      loginAs(page, baseUrl, spec.login, role),
      new Promise((_, reject) => setTimeout(() => reject(new Error('login timed out')), LOGIN_TIMEOUT_MS)),
    ]);
  } catch { /* unauth shots still useful */ }
}

// Did the login actually take? Navigating to '/' is the only honest test: the
// auth gate 302s page navigations to /login, and a sign-in form is a sign-in
// form whatever the route is called. Cheap enough to run twice.
async function isSignedIn(page, baseUrl) {
  try {
    await gotoSettled(page, new URL('/', baseUrl).toString());
    if (/\/login(?:[/?#]|$)/.test(page.url())) return false;
    return (await page.locator('input[type="password"]').count()) === 0;
  } catch {
    return false;
  }
}

// Get INTO the app, by whichever door opens.
//
// 1. The project's own ui-checks fixture users, when the build wrote them —
//    they carry the right ROLE for the screens under review.
// 2. The platform's review account (review-account.js) — always available on
//    an app with the auth component, because the platform creates it rather
//    than hoping the model did. This is what stopped every review from being a
//    critique of the sign-in page.
//
// Returns true when the capture is authenticated.
async function establishSession(page, baseUrl, spec, reviewLogin) {
  await tryLogin(page, baseUrl, spec);
  if (await isSignedIn(page, baseUrl)) return true;
  if (!reviewLogin?.email || !reviewLogin?.password) return false;
  await tryOperatorLogin(page, baseUrl, reviewLogin);
  return isSignedIn(page, baseUrl);
}

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readContainerFile(containerName, relPath, { timeoutMs = 60000 } = {}) {
  const r = await containerSh(containerName, `cat '${APP_DIR}/${relPath}' 2>/dev/null`, { timeoutMs });
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
export async function captureAppScreens({ containerName, webPort = 3000, paths = null, withAxe = true, reviewLogin = null }) {
  const chromium = await loadChromium();
  if (!chromium) return { shots: [], axe: [], overflows: [], detail: 'playwright-core is not installed (rerun update.sh / npm install)' };
  const baseUrl = await resolveBrowserTarget(containerName, webPort);
  const specText = await readContainerFile(containerName, UI_CHECKS_PATH);
  const parsed = specText ? parseUiChecks(specText) : { ok: false };
  const spec = parsed.ok ? parsed.spec : null;
  const targets = paths?.length ? paths.slice(0, MAX_PATHS) : pathsToShoot(spec);
  const axeSource = withAxe ? loadAxeSource() : null;

  let browser = null;
  const shots = [];
  const axeViolations = [];
  const overflowFindings = [];
  let authed = false;
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 1 });
    const page = await context.newPage();
    // Authenticated pages need a session. Fixture users first (right role),
    // then the platform's own review account — see establishSession.
    authed = await establishSession(page, baseUrl, spec, reviewLogin);
    for (let i = 0; i < targets.length; i++) {
      const path = targets[i];
      try {
        await page.setViewportSize(MOBILE);
        await gotoSettled(page, new URL(path, baseUrl).toString());
        const mobileShot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
        shots.push({ path, width: MOBILE.width, media_type: 'image/jpeg', data: mobileShot.toString('base64') });
        // Deterministic overflow check (operator-reported: scrolling strip in
        // the header, admin text overflow): any page that scrolls horizontally
        // at mobile width is a defect — record the offenders for the critique
        // and the polish queue.
        try {
          const of = await page.evaluate(() => {
            const doc = document.documentElement;
            const over = doc.scrollWidth - doc.clientWidth;
            if (over <= 1) return null;
            const bad = [];
            for (const el of document.querySelectorAll('body *')) {
              const r = el.getBoundingClientRect();
              if (r.right > doc.clientWidth + 1 && !el.children.length) {
                bad.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.') : ''}`);
                if (bad.length >= 5) break;
              }
            }
            return { over, elements: [...new Set(bad)] };
          });
          if (of) overflowFindings.push({ page: path, width: MOBILE.width, over_px: of.over, elements: of.elements });
        } catch { /* advisory */ }
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
    return { shots, axe: axeViolations, overflows: overflowFindings, detail: null, authenticated: authed };
  } catch (err) {
    return { shots, axe: axeViolations, overflows: overflowFindings, detail: `browser error: ${err?.message || err}`, authenticated: authed };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}

// One screenshot for the annotate dialog. Returns { ok, buffer, error }.
// Hard ceiling for one annotate screenshot end-to-end. The independent legs
// (app address, login fixtures, browser launch) run in PARALLEL, so the
// worst case is max(30s launch, 15s reads) + login 12s + nav 20s + shot 20s
// — the 90s ceiling only fires when a step genuinely wedges, and the error
// then NAMES the stage so a stuck install can be diagnosed from the dialog.
const CAPTURE_DEADLINE_MS = 90000;

export async function captureOneScreenshot({
  containerName, webPort = 3000, path = '/', width = 390, onStage = null, operatorLogin = null,
  projectId = null,
}) {
  let browser = null;
  let stage = 'starting';
  const t0 = Date.now();
  // Every stage transition is logged with elapsed ms, so a wedged install's
  // journal shows exactly where the time went even when the dialog only
  // shows the timeout.
  const mark = (s) => {
    stage = s;
    console.log(`[mock2] screenshot ${containerName}: ${s} (+${Date.now() - t0}ms)`);
    try { onStage?.(s); } catch { /* advisory */ }
  };
  const work = (async () => {
    // The driver import lives INSIDE the deadline: a broken/slow node_modules
    // used to hang here BEFORE any timeout applied — the route then never
    // answered and the dialog sat on its generic client abort (user report).
    mark('loading the browser driver');
    const chromium = await loadChromium();
    if (!chromium) throw new Error('playwright-core is not installed (rerun update.sh / npm install)');
    mark('resolving the app address + launching the browser');
    const [baseUrl, specText, launched] = await Promise.all([
      resolveBrowserTarget(containerName, webPort),
      readContainerFile(containerName, UI_CHECKS_PATH, { timeoutMs: 15000 }).catch(() => ''),
      chromium.launch(launchOptions()),
    ]);
    browser = launched;
    const parsed = specText ? parseUiChecks(specText) : { ok: false };
    const spec = parsed.ok ? parsed.spec : null;
    const w = Math.min(1600, Math.max(320, Number(width) || 390));
    mark('opening a page');
    const context = await browser.newContext({ viewport: { width: w, height: Math.round(w * 2) }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    if (operatorLogin) {
      mark('signing in with the provided account');
      await tryOperatorLogin(page, baseUrl, operatorLogin);
    } else {
      // Same ladder as the review: fixture users, then the platform's own
      // reviewer account. Annotating the app's real screens beats annotating
      // the sign-in page, and the operator should not have to hand over their
      // password to get one.
      mark('signing in');
      let reviewLogin = null;
      try { reviewLogin = projectId ? getReviewLogin(projectId) : null; } catch { reviewLogin = null; }
      await establishSession(page, baseUrl, spec, reviewLogin);
    }
    // Paths are operator-clicked UI values, but sanitize anyway: same-origin only.
    const safePath = String(path || '/').startsWith('/') ? String(path) : '/';
    mark(`loading ${safePath}`);
    await gotoSettled(page, new URL(safePath, baseUrl).toString());
    // Signed-out detection: the auth gate redirects page navigations to
    // /login, and fixture logins only exist once a full build has written
    // state/ui-checks.json. The shot is still returned (annotating the
    // sign-in page is legitimate) — the dialog just says what it shows.
    let signedOut = false;
    try {
      signedOut = /\/login(?:[/?#]|$)/.test(page.url())
        || (safePath !== '/login' && (await page.locator('input[type="password"]').count()) > 0);
    } catch { signedOut = false; }
    mark('capturing the page');
    const buf = await page.screenshot({ type: 'png', fullPage: true, timeout: 20000 });
    mark('done');
    return { ok: true, buffer: buf, signedOut };
  })();
  let result;
  try {
    result = await Promise.race([
      work,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`the screenshot timed out after ${Math.round(CAPTURE_DEADLINE_MS / 1000)}s while ${stage} — the app or container may be busy; try Refresh`)),
        CAPTURE_DEADLINE_MS,
      )),
    ]);
  } catch (err) {
    console.warn(`[mock2] app screenshot failed (${containerName} ${path}):`, err?.message);
    result = { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
  // Cleanup rides the WORK promise, not this function's return: on a deadline
  // the launch may still be mid-flight — close the browser whenever it lands
  // so an abandoned capture can't leak a Chromium.
  void work.catch(() => {}).finally(async () => {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  });
  return result;
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

  // Make sure there is an account to sign in WITH before opening the browser.
  // This is the fix for "the ai can never see past the login screen": the
  // platform provisions its own fixture-domain admin instead of depending on
  // the build model having written fixture users.
  let reviewLogin = null;
  try {
    const acct = await ensureReviewAccount(project);
    reviewLogin = acct.login;
    if (!acct.ok && acct.state !== 'no-auth') {
      console.warn(`[mock2] design review: no review account for project ${project.id} (${acct.state}: ${acct.reason})`);
    }
  } catch (e) {
    console.warn('[mock2] design review: review-account provisioning failed:', e?.message);
  }

  const capture = await captureAppScreens({ containerName, webPort: project.web_port || 3000, reviewLogin });
  if (!capture.shots.length) {
    return { ok: false, error: capture.detail || 'Could not capture any screenshots of the app.' };
  }

  // The visual contract + tokens ride the critique; both optional (older projects).
  const mockupHtml = await readContainerFile(containerName, MOCKUP_CURRENT);
  const tokensJson = await readContainerFile(containerName, 'state/design-tokens.json');

  // Deterministic extras over the app's OWN stylesheets (never base.css/
  // design.css — those ARE the system):
  //   rogue     — colors written outside the token set.
  //   adherence — does the build actually consume the approved design, or has
  //               it declared a parallel one? This is the check that would have
  //               caught a build referencing zero approved variables while
  //               hand-writing 18KB of its own CSS.
  let rogue = [];
  let adherence = null;
  try {
    const cssList = await containerSh(containerName,
      `for f in ${APP_DIR}/public/*.css; do case "$f" in *base.css|*design.css) ;; *) cat "$f" 2>/dev/null;; esac; done`);
    const appCss = cssList.stdout || '';
    if (tokensJson) rogue = rogueCssColors(appCss, tokensJson);
    const designCss = await readContainerFile(containerName, 'state/design.css');
    adherence = checkDesignAdherence({ designCss, appCss });
  } catch { /* advisory */ }

  const model = String(process.env.MOCK2_REVIEW_MODEL || '').trim() || ready.model;
  const userText = [
    `Screens shot (in order, mobile ${MOBILE.width}px first; the first two paths also have a ${DESKTOP.width}px desktop shot): ${capture.shots.map((s) => `${s.path}@${s.width}`).join(', ')}.`,
    (capture.overflows || []).length
      ? `DETERMINISTIC FINDING — horizontal overflow at ${MOBILE.width}px (a defect; include a fix in your findings): ${capture.overflows.map((o) => `${o.page} overflows by ${o.over_px}px (${o.elements.join(', ') || 'container'})`).join('; ')}.`
      : 'No horizontal overflow detected at mobile width.',
    tokensJson ? `Design tokens:\n${tokensJson.slice(0, 4000)}` : 'No design tokens file.',
    mockupHtml ? `Approved mockup HTML (the visual contract):\n${mockupHtml.slice(0, 120000)}` : 'No approved mockup — judge craft and consistency on their own.',
  ].join('\n\n');
  const res = await callStepTurn('design-review', {
    connector: ready.connector, apiKey: ready.apiKey, model,
    system: stepSystemPrompt('design-review', buildReviewPrompt(), {}), tools: [],
    transcript: [{ role: 'user', text: userText, images: capture.shots.map((s) => ({ media_type: s.media_type, data: s.data })) }],
    effort: 'high', thinking: null, timeoutMs: 240000,
  });
  if (!res.ok) return { ok: false, error: `review model call failed: ${res.error || 'unknown'}` };
  try {
    const u = res.usage || {};
    const cost = costCentsForUsage({
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
      cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
    }, effectivePrice(ready.connector.id, model));
    insertLedgerEntry({ projectId: project.id, cycleId: null, connectorId: ready.connector.id, model: res.modelUsed || model, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents: cost, wallClockMs: 0, step: 'design-review', userId: initiatedBy ?? null });
  } catch (e) { console.warn('[mock2] design-review ledger write failed:', e?.message); }

  const review = parseReviewReply(res.text) || { summary: '', findings: [] };
  let message = reviewChatMessage({ review, axe: capture.axe, rogue, adherence, trigger, screenshotCount: capture.shots.length });
  // Honesty: a capture that never got past the gate only ever sees the sign-in
  // page — say so up front, or the findings read as "the entire app is
  // missing" (user report). This should now be rare: the platform provisions
  // its own review account above, so the remaining causes are a real narrow
  // set (a custom sign-in form the generic selectors miss, an app with no auth
  // component whose '/' still gates) — and the banner names them so the
  // operator can act instead of guessing.
  if (!capture.authenticated) {
    message = `Heads-up: this review could not get past the SIGN-IN page, so the findings below describe the sign-in gate, not the app's screens. The platform keeps its own reviewer account (\`${REVIEW_EMAIL}\`) for this; when it cannot sign in, the usual cause is a sign-in form whose email/password inputs are not standard \`input[type="email"]\` / \`input[type="password"]\` fields inside a form with a submit button.

${message}`;
  }
  // Attach the screenshots the critique is ABOUT. Findings like "the card grid
  // does not collapse at mobile width" are unverifiable as prose — the operator
  // has to see the shot. They are already captured and already sent to the
  // model; not storing them was the only reason they were invisible in chat.
  // Each is labelled with its path and width so a desktop/mobile pair reads as
  // a pair (the chat lightbox arrows between them).
  let attachments = null;
  try {
    attachments = saveChatImages(project.id, capture.shots.map((sh) => ({
      data: sh.data,
      media_type: sh.media_type,
      name: `${sh.path === '/' ? 'home' : String(sh.path).replace(/^\/+/, '').replace(/[^a-z0-9._-]+/gi, '-')}-${sh.width}px.jpg`,
    })));
  } catch (e) {
    // A storage failure must not lose the written critique — post it anyway.
    console.warn('[mock2] design review: could not store screenshots:', e?.message);
    attachments = null;
  }
  try { insertMessage({ projectId: project.id, kind: 'system', body: message, attachments }); } catch { /* best effort */ }

  let queued = null;
  if (apply) {
    const instruction = composePolishInstruction({ review, axe: capture.axe, rogue, adherence });
    if (instruction) {
      queued = enqueueBuild({ projectId: project.id, instruction, buildMode: 'quick', label: 'Polish pass fixes', initiatedBy });
      drainBuildQueue(project.id).catch((e) => console.warn('[mock2] polish drain failed:', e?.message));
    }
  }
  return { ok: true, findings: review.findings, summary: review.summary, axe: capture.axe, rogue, adherence, message, queued };
}

// The after-build hook (fire-and-forget from the request-close chain): honors
// the dashboard toggle, posts findings to the chat, never blocks or fails the
// close. In-process re-entrancy guard so back-to-back closes don't stack
// browser sessions.
//
// VISIBILITY (this used to be the bug). Every path out of here was silent: a
// review that could not capture a screenshot, or ran with no build connector
// ready, or threw, produced NOTHING — no chat message, no marker, nothing an
// operator could see. A build then shipped with zero design feedback and
// looked, from the outside, exactly like a build that was reviewed and found
// clean. Now the only silent outcomes are the two that mean "nothing to say":
// the toggle is off, and a review already in flight for this project.
const autoReviewRunning = new Set();

// Skip/failure reasons worth telling the operator about, in the words they
// need to act on. Anything unmapped falls through with the raw detail.
function autoReviewNote(reason, detail) {
  const base = 'Design review (after build) did not run';
  if (reason === 'inactive') return `${base} — the project is not online, so its screens could not be opened.`;
  if (reason === 'no_runner') return `${base} — no build model connector is ready. Connect one to get design feedback on each build.`;
  if (reason === 'no_shots') return `${base} — the app could not be screenshotted${detail ? ` (${detail})` : ''}. The build itself is unaffected.`;
  return `${base}${detail ? ` — ${detail}` : '.'}`;
}

export async function maybeAutoDesignReview(project) {
  const note = (body) => {
    try { if (project?.id) insertMessage({ projectId: project.id, kind: 'system', body }); } catch { /* best effort */ }
  };
  try {
    if (getDesignReviewSetting() !== 'on') return { ok: false, skipped: 'setting_off' };
    if (!project?.id) return { ok: false, skipped: 'no_project' };
    if (project.lifecycle !== 'active') {
      console.warn(`[mock2] auto design review skipped for project ${project.id}: lifecycle ${project.lifecycle}`);
      note(autoReviewNote('inactive'));
      return { ok: false, skipped: 'inactive' };
    }
    // Already running: the in-flight pass will post. Genuinely nothing to say.
    if (autoReviewRunning.has(project.id)) return { ok: false, skipped: 'already_running' };
    autoReviewRunning.add(project.id);
    try {
      const res = await runDesignReview({ project, trigger: 'auto', apply: false });
      if (!res?.ok) {
        const detail = res?.error || 'unknown';
        console.warn(`[mock2] auto design review produced nothing for project ${project.id}: ${detail}`);
        const reason = /no build model connector/i.test(detail) ? 'no_runner'
          : /screenshot/i.test(detail) ? 'no_shots' : null;
        note(autoReviewNote(reason, reason === 'no_shots' ? null : detail));
      }
      return res;
    } finally {
      autoReviewRunning.delete(project.id);
    }
  } catch (e) {
    console.warn('[mock2] auto design review failed:', e?.message);
    note(autoReviewNote(null, e?.message || 'unexpected error'));
    return { ok: false, error: e?.message || 'unexpected error' };
  }
}
