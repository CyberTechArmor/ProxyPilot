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
import {
  loadChromium, launchOptions, loginAs, apiSignIn, firstVisible, gotoStable,
  revealSignInForm, waitForSignInToLand, AUTOMATION_CONTEXT,
} from './ui-checks.js';
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
import { densityFindings, colorOnlyFindings, signalsPromptBlock, signalsChatLines } from './design-signals-logic.js';
import {
  DESIGN_FINDINGS_PATH, parseFindingsLedger, renderFindingsLedger, mergeFindings, ledgerDelta,
} from './design-findings-logic.js';
import { listNewElements, promotionInviteMessage } from './design-promote.js';
import { ensureReviewAccount, getReviewLogin, REVIEW_EMAIL } from './review-account.js';
import { startScreenJob, updateScreenJob, finishScreenJob } from './screen-job.js';

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
        // The API door first — it does not care which of the sign-in page's
        // three forms happens to be showing, or how the build restyled them.
        if (await apiSignIn(page, baseUrl, creds)) return;
        // Fall back to the form, aimed at the VISIBLE controls. `.first()` here
        // used to fill #bootstrap-email/#bootstrap-password (hidden on most
        // projects) and POST to /auth/bootstrap/superadmin, which is why every
        // review screenshot was of the gate.
        await gotoStable(page, new URL('/login', baseUrl).toString());
        // Settle first, then open the sign-in door: a fresh app SHOWS the
        // create-administrator form, and it is one click behind #to-login.
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
        await revealSignInForm(page);
        await firstVisible(page, 'input[type="email"], input[name="email"], input[name="username"]').fill(String(creds.email), { timeout: 5000 });
        await firstVisible(page, 'input[type="password"]').fill(String(creds.password), { timeout: 5000 });
        await firstVisible(page, 'button[type="submit"], input[type="submit"]').click({ timeout: 5000 });
        await waitForSignInToLand(page);
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

// Written with the payload on STDIN rather than inlined: a ledger is small, but
// so was every other file that later grew past the argv limit.
async function writeContainerFile(containerName, relPath, content, { timeoutMs = 30000 } = {}) {
  // ENCODED payload on stdin — the container's script decodes it. Decoding on
  // the host as well writes four bytes of garbage; see base-app-upgrade.js.
  const script = `d="${APP_DIR}/${relPath}"; mkdir -p "$(dirname "$d")"; base64 -d > "$d"`;
  const r = await sh(
    `incus exec ${containerName} -- sh -c "$(printf '%s' '${b64(script)}' | base64 -d)"`,
    { timeoutMs, input: b64(content) },
  );
  return r.code === 0;
}

// measureSignals(page) — DENSITY and REDUNDANT STATUS CODING, in the page.
//
// Two properties that separate a considered interface from a generated one and
// that the review was previously being asked to eyeball from a JPEG. See
// design-signals-logic.js for what the numbers mean; this only counts.
//
//   facts    — visible leaf text nodes and controls inside the FIRST viewport.
//              Above-the-fold on purpose: what someone sees before deciding
//              whether this screen is worth their time.
//   colorOnly — elements carrying a saturated status colour with no word, no
//              glyph and no accessible name beside it. Colour as the only
//              channel fails the colourblind reader, the printed copy and the
//              person searching the page for "overdue".
//
// Runs entirely in the page and returns plain numbers, so nothing here can
// throw into the capture loop with anything but a rejected promise.
async function measureSignals(page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const visible = (el, r) => r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;

    let facts = 0;
    let controls = 0;
    const CONTROL = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"]';
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      if (el.matches(CONTROL)) { controls++; facts++; continue; }
      // A LEAF with its own text is one fact. Counting containers too would
      // score a deeply-nested empty layout as dense.
      if (el.children.length === 0 && (el.textContent || '').trim().length > 0) facts++;
    }

    // ---- status colour without a second channel ----
    const rgb = (v) => {
      const m = String(v || '').match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      if (p.length >= 4 && p[3] === 0) return null;    // transparent is not a signal
      return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255 };
    };
    // Saturated, mid-lightness, and in a hue people read as a status. Neutrals,
    // near-black text and the page's own accent-tinted surfaces are excluded by
    // the saturation and lightness bounds rather than by a palette list, so this
    // does not need to know the app's design.
    const isStatusColor = (c) => {
      if (!c) return false;
      const max = Math.max(c.r, c.g, c.b);
      const min = Math.min(c.r, c.g, c.b);
      const l = (max + min) / 2;
      if (l < 0.18 || l > 0.78) return false;
      const d = max - min;
      if (d < 0.22) return false;                       // grey
      const s = d / (1 - Math.abs(2 * l - 1));
      if (s < 0.35) return false;
      let h = 0;
      if (max === c.r) h = 60 * (((c.g - c.b) / d) % 6);
      else if (max === c.g) h = 60 * ((c.b - c.r) / d + 2);
      else h = 60 * ((c.r - c.g) / d + 4);
      if (h < 0) h += 360;
      // red/orange/amber (0–65) and green (95–165). Blues and purples are
      // brand accents far more often than they are statuses.
      return (h <= 65) || (h >= 95 && h <= 165);
    };

    let statusTotal = 0;
    let colorOnly = 0;
    const examples = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) continue;
      if (r.width > 240 || r.height > 120) continue;    // a page-wide banner is not a status chip
      const style = getComputedStyle(el);
      const coloured = isStatusColor(rgb(style.backgroundColor)) || isStatusColor(rgb(style.color))
        || isStatusColor(rgb(style.borderTopColor));
      if (!coloured) continue;
      statusTotal++;
      const text = (el.textContent || '').trim();
      const named = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt');
      // A glyph counts as the second channel: an svg, an icon-font span, or a
      // literal symbol/emoji (arrows, dingbats, and the emoji planes).
      const glyph = el.querySelector('svg,img,use,[class*="icon"]')
        || /[←-➿⬀-⯿]/u.test(text)
        || /[\u{1F300}-\u{1FAFF}]/u.test(text);
      if (!text && !named && !glyph) {
        colorOnly++;
        if (examples.length < 4) {
          const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
          examples.push(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`);
        }
      }
    }
    return { facts, controls, statusTotal, colorOnly, examples };
  });
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
  const densityMeasurements = [];
  const signalMeasurements = [];
  let authed = false;
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ ...AUTOMATION_CONTEXT, viewport: MOBILE, deviceScaleFactor: 1 });
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
        // Density + redundant status coding, measured rather than eyeballed
        // from a JPEG. See design-signals-logic.js for what they mean and why
        // they are advisory. Both are read at the width currently set.
        try {
          const s = await measureSignals(page);
          if (s) {
            densityMeasurements.push({ path, width: MOBILE.width, facts: s.facts, controls: s.controls });
            signalMeasurements.push({ path, width: MOBILE.width, total: s.statusTotal, colorOnly: s.colorOnly, examples: s.examples });
          }
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
          // Density is a different question at each width — a screen can be
          // right on a phone and be three cards adrift on a laptop, which is
          // the shape a mobile-first build produces by default.
          try {
            const s = await measureSignals(page);
            if (s) densityMeasurements.push({ path, width: DESKTOP.width, facts: s.facts, controls: s.controls });
          } catch { /* advisory */ }
        }
      } catch (err) {
        console.warn(`[mock2] design-review screenshot failed for ${path}:`, err?.message);
      }
    }
    return { shots, axe: axeViolations, overflows: overflowFindings, density: densityMeasurements, signals: signalMeasurements, detail: null, authenticated: authed };
  } catch (err) {
    return { shots, axe: axeViolations, overflows: overflowFindings, density: densityMeasurements, signals: signalMeasurements, detail: `browser error: ${err?.message || err}`, authenticated: authed };
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
    const context = await browser.newContext({ ...AUTOMATION_CONTEXT, viewport: { width: w, height: Math.round(w * 2) }, deviceScaleFactor: 1 });
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

  // Progress from here on. Two minutes of a browser driving the app used to
  // show nothing at all, on the one surface that IS a picture of the app.
  startScreenJob(project.id, 'review');

  // Make sure there is an account to sign in WITH before opening the browser.
  // This is the fix for "the ai can never see past the login screen": the
  // platform provisions its own fixture-domain admin instead of depending on
  // the build model having written fixture users.
  let reviewLogin = null;
  try {
    updateScreenJob(project.id, { phase: 'signing-in', message: 'Signing in as the screen account…' });
    const acct = await ensureReviewAccount(project);
    reviewLogin = acct.login;
    if (!acct.ok && acct.state !== 'no-auth') {
      console.warn(`[mock2] design review: no review account for project ${project.id} (${acct.state}: ${acct.reason})`);
    }
  } catch (e) {
    console.warn('[mock2] design review: review-account provisioning failed:', e?.message);
  }

  updateScreenJob(project.id, { phase: 'capturing', message: 'Screenshotting the app at phone and laptop width…' });
  const capture = await captureAppScreens({ containerName, webPort: project.web_port || 3000, reviewLogin });
  if (!capture.shots.length) {
    finishScreenJob(project.id, { ok: false, message: capture.detail || 'Could not screenshot the app.' });
    return { ok: false, error: capture.detail || 'Could not capture any screenshots of the app.' };
  }
  updateScreenJob(project.id, {
    phase: 'reading', shots: capture.shots.length,
    message: `Reading ${capture.shots.length} screenshot(s) against the approved design…`,
  });

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
    // The MARKUP too. Reading only stylesheets is how a build that shipped 328
    // lines of HTML and no CSS measured as "nothing to judge" — in the gate and
    // here alike. The platform's own pages are excluded; they are not the
    // build's work.
    const htmlList = await containerSh(containerName,
      `for f in ${APP_DIR}/public/*.html; do case "$f" in *login.html|*admin.html|*profile.html) ;; *) cat "$f" 2>/dev/null;; esac; done`);
    const appHtml = htmlList.stdout || '';
    adherence = checkDesignAdherence({ designCss, appCss, appHtml });
  } catch { /* advisory */ }

  // Density and status-coding: measured in the capture above, judged here.
  // Advisory by construction — a focused create form SHOULD be sparse, and a
  // colour-only dot beside a label can be fine — so they are handed to the
  // critique as evidence and reported to the operator, never gated on.
  const signals = {
    density: densityFindings(capture.density || []),
    colorOnly: colorOnlyFindings(capture.signals || []),
  };

  const model = String(process.env.MOCK2_REVIEW_MODEL || '').trim() || ready.model;
  const userText = [
    `Screens shot (in order, mobile ${MOBILE.width}px first; the first two paths also have a ${DESKTOP.width}px desktop shot): ${capture.shots.map((s) => `${s.path}@${s.width}`).join(', ')}.`,
    (capture.overflows || []).length
      ? `DETERMINISTIC FINDING — horizontal overflow at ${MOBILE.width}px (a defect; include a fix in your findings): ${capture.overflows.map((o) => `${o.page} overflows by ${o.over_px}px (${o.elements.join(', ') || 'container'})`).join('; ')}.`
      : 'No horizontal overflow detected at mobile width.',
    signalsPromptBlock(signals),
    tokensJson ? `Design tokens:\n${tokensJson.slice(0, 4000)}` : 'No design tokens file.',
    mockupHtml ? `Approved mockup HTML (the visual contract):\n${mockupHtml.slice(0, 120000)}` : 'No approved mockup — judge craft and consistency on their own.',
  ].join('\n\n');
  const res = await callStepTurn('design-review', {
    connector: ready.connector, apiKey: ready.apiKey, model,
    system: stepSystemPrompt('design-review', buildReviewPrompt(), {}), tools: [],
    transcript: [{ role: 'user', text: userText, images: capture.shots.map((s) => ({ media_type: s.media_type, data: s.data })) }],
    effort: 'high', thinking: null, timeoutMs: 240000,
  });
  if (!res.ok) {
    finishScreenJob(project.id, { ok: false, message: `The screen check could not read the app: ${res.error || 'the model call failed'}.` });
    return { ok: false, error: `review model call failed: ${res.error || 'unknown'}` };
  }
  try {
    const u = res.usage || {};
    const cost = costCentsForUsage({
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
      cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
    }, effectivePrice(ready.connector.id, model));
    insertLedgerEntry({ projectId: project.id, cycleId: null, connectorId: ready.connector.id, model: res.modelUsed || model, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents: cost, wallClockMs: 0, step: 'design-review', userId: initiatedBy ?? null });
  } catch (e) { console.warn('[mock2] design-review ledger write failed:', e?.message); }

  const review = parseReviewReply(res.text) || { summary: '', findings: [] };
  updateScreenJob(project.id, { phase: 'writing', message: 'Writing the findings…' });

  // Persist the critique as project state before it becomes a chat message.
  //
  // This is the whole difference between a review and a diary. Until now every
  // finding lived exactly as long as the message it was posted in: the auto
  // review runs with apply=false, so the next build started from the same
  // mockup knowing nothing about what the last look at the running app found.
  // The ledger merges by finding rather than by review, so a defect raised
  // three times reads as one defect the app keeps shipping, and one that stops
  // appearing resolves itself.
  //
  // Best-effort throughout: a project whose container cannot be written to
  // still gets its critique posted. Losing the ledger must never lose the
  // review.
  let ledgerNote = '';
  try {
    const before = parseFindingsLedger(await readContainerFile(containerName, DESIGN_FINDINGS_PATH, { timeoutMs: 15000 }));
    const after = mergeFindings(before, review.findings, { cycleId: null });
    if (await writeContainerFile(containerName, DESIGN_FINDINGS_PATH, renderFindingsLedger(after))) {
      ledgerNote = ledgerDelta(before, after);
    }
  } catch (e) {
    console.warn('[mock2] design findings ledger update failed:', e?.message);
  }

  let message = reviewChatMessage({ review, axe: capture.axe, rogue, adherence, trigger, screenshotCount: capture.shots.length });
  // Measured, not eyeballed: how much a screen puts in front of someone before
  // they scroll, and whether any status is carried by colour alone.
  const signalLines = signalsChatLines(signals);
  if (signalLines.length) message = `${message}\n${signalLines.join('\n')}`;
  // The loop, made visible. Without this line the operator reads the same
  // findings after each build with no way to tell whether anything moved.
  if (ledgerNote) message = `${message}\n\n${ledgerNote}`;

  // What this build DESIGNED, offered while the operator is already looking at
  // the screens it appears on. Without a promotion path the approved vocabulary
  // is frozen at the mockup, so a good new element is measured as drift forever
  // and there is no mechanism by which it could become anything else.
  try {
    const invite = promotionInviteMessage((await listNewElements(project)).candidates);
    if (invite) message = `${message}\n\n${invite}`;
  } catch (e) {
    console.warn('[mock2] new-element invite failed:', e?.message);
  }
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
  finishScreenJob(project.id, {
    ok: true,
    message: `Screen check finished — ${capture.shots.length} screenshot(s) and ${review.findings.length} finding(s) are in the chat.`,
  });

  let queued = null;
  if (apply) {
    const instruction = composePolishInstruction({ review, axe: capture.axe, rogue, adherence });
    if (instruction) {
      queued = enqueueBuild({ projectId: project.id, instruction, buildMode: 'quick', label: 'Polish pass fixes', initiatedBy });
      drainBuildQueue(project.id).catch((e) => console.warn('[mock2] polish drain failed:', e?.message));
    }
  }
  return { ok: true, findings: review.findings, summary: review.summary, axe: capture.axe, rogue, adherence, signals, message, queued };
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

// afterBuildReview — the WHOLE post-build "look at what shipped" chain, in one
// place because it has to fire from more than one terminal path.
//
// It used to live inline in screen-plan's onRequestClosed, which only runs when
// a REQUEST closes as 'succeeded'. A build that ends in pending_verification
// never closes its request — it waits for the operator's checklist — so it was
// never served-checked, never given a reviewer account, and never reviewed.
// That is how an app that looked nothing like its mockup shipped with no
// review at all; and the smoke-spec backstop (a malformed check file keeps the
// deploy and completes as pending verification) routes MORE builds down that
// path, so leaving the trigger where it was would have made this worse.
//
// Three steps, in order, each best-effort:
//   1. is the app actually serving? deploy it if not,
//   2. is there an account to look at it WITH?
//   3. screenshot it and critique it against the approved mockup.
//
// Idempotent enough to be called twice: maybeAutoDesignReview holds a per-
// project in-flight guard, and steps 1 and 2 are no-ops when already true.
export async function afterBuildReview(projectId, { reason = 'build close' } = {}) {
  const id = Number(projectId);
  if (!Number.isFinite(id)) return { ok: false, skipped: 'no_project' };
  const { getProject } = await import('./projects.js');

  // Not mid-stream: a project with another build queued is about to change
  // again, and critiquing a half-finished state wastes a model call and
  // confuses the chat. The guard lives HERE rather than at one call site, so
  // both terminal paths behave the same way.
  try {
    const { listBuildQueue } = await import('./build-queue.js');
    if (listBuildQueue(id).some((q) => q.status === 'queued' || q.status === 'started')) {
      console.log(`[mock2] auto design review deferred for project ${id}: build queue still busy`);
      return { ok: false, skipped: 'queue_busy' };
    }
  } catch { /* a queue read failure must not skip the review */ }

  try {
    const { ensureServing } = await import('./deploy.js');
    const serving = await ensureServing(getProject(id), { reason });
    if (serving.redeployed) {
      insertMessage({
        projectId: id, kind: 'system',
        body: serving.serving
          ? 'The app was not answering after the build, so it was deployed automatically — it is live now.'
          : `The app is not answering after the build and the automatic deploy did not fix it: ${serving.error || 'unknown'}. Press Deploy to retry, or open the build log.`,
      });
    }
  } catch (e) { console.warn('[mock2] post-build serving check failed:', e?.message); }

  let readyLogin = null;
  try {
    const { ensureReviewAccount } = await import('./review-account.js');
    readyLogin = (await ensureReviewAccount(getProject(id)))?.login || null;
  } catch (e) { console.warn('[mock2] post-build review-account check failed:', e?.message); }

  // Is the app actually WORKING, or merely listening?
  //
  // ensureServing above asks for `/` and accepts anything below 500 — which on
  // a gated app is the redirect to /login, and a dead database, a failed
  // migration and a 500ing app all produce exactly that. This asks the app's
  // own health endpoint, checks the sign-in page RENDERS, and — with the
  // fixture credentials — makes one SIGNED-IN request, which is the question
  // the redirect was hiding. A failure here is reported and never blocks: the
  // deploy already happened, and the operator needs to know, not be stopped.
  try {
    const { verifyAppReady } = await import('./readiness.js');
    const { readinessChatMessage, readinessLogLines } = await import('./readiness-logic.js');
    const ready = await verifyAppReady(getProject(id), { authed: readyLogin });
    for (const line of readinessLogLines(ready)) console.log(`[mock2] project ${id} ${line}`);
    const message = readinessChatMessage(ready);
    if (message) insertMessage({ projectId: id, kind: 'system', body: message });
  } catch (e) { console.warn('[mock2] post-build readiness check failed:', e?.message); }

  // THE APP IS LIVE AND HAS NO ADMINISTRATOR — say so, HERE, at the end.
  //
  // The first account belongs to the operator and the build may not create it.
  // The only thing that ever announced that was the sign-in page itself, which
  // an operator sees mid-build if they happen to look: "there is limited time
  // from seeing the create super admin first user, then when the app finishes
  // I'm unable to log in". Nothing was expiring — but nothing told them at the
  // moment they could act, either, so it read as a window they had missed.
  //
  // Posted once per build close, only while the door is genuinely open, and
  // only when the app answered — an unreachable app is the readiness check's
  // story to tell, not this one's.
  try {
    const { readAppAccess } = await import('./app-access.js');
    const { firstAdminInviteMessage } = await import('./app-access-logic.js');
    const project = getProject(id);
    const state = await readAppAccess(project);
    const invite = firstAdminInviteMessage({ project, state });
    if (invite) insertMessage({ projectId: id, kind: 'system', body: invite });
  } catch (e) { console.warn('[mock2] first-admin invite check failed:', e?.message); }

  console.log(`[mock2] auto design review starting for project ${id} (${reason})`);
  return maybeAutoDesignReview(getProject(id));
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
