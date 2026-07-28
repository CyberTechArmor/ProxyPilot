// Mock2 UI interaction checks — the EXECUTOR (orchestrator-side Playwright).
// Runs the state/ui-checks.json checks a deployed commit's diff warrants
// against the LIVE app (post-deploy, invoked by the browser smoke connector in
// smoke.js). This is the rendered-DOM layer the change-69 regression proved
// necessary: it logs in as the declared role (seeded test-fixture users from
// the spec), asserts the per-role state of interactive controls
// (enabled/disabled), that typed input actually persists into the control
// (type → assert value), and that flow steps like "Replace → secret enables"
// work — and it fails on ANY console error raised while the page loads/runs.
//
// Playwright is imported lazily so a default install never loads it; when it is
// missing the caller receives { unavailable: true } and (with the default
// SMOKE_REQUIRE_TRIGGERED) the cycle FAILS VISIBLY — never a silent pass.
//
// Terminology (risk R7): nothing here is named "agent".

import { existsSync } from 'node:fs';
import { stepShape } from './ui-check-logic.js';
import { selectorPrefixes, diagnoseSelector, diagnosisDetail } from './selector-diagnosis-logic.js';

const NAV_TIMEOUT_MS = 15000;
const STEP_TIMEOUT_MS = 5000;

// Common system-Chromium locations, probed when SMOKE_BROWSER_EXECUTABLE is
// not set. update.sh/install.sh install `chromium` via apt, which lands at one
// of these — so the connector works out of the box with playwright-core (which
// ships NO bundled browser).
const CHROMIUM_CANDIDATES = Object.freeze([
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium', '/opt/pw-browsers/chromium',
]);

// The Chromium executable the connector would launch: the operator's explicit
// SMOKE_BROWSER_EXECUTABLE, else the first system candidate present, else null
// (a full `playwright` install can still use its own bundled revision).
export function resolveBrowserExecutable(env = process.env) {
  const exe = String(env.SMOKE_BROWSER_EXECUTABLE || '').trim();
  if (exe) return exe;
  for (const c of CHROMIUM_CANDIDATES) {
    try { if (existsSync(c)) return c; } catch { /* keep probing */ }
  }
  return null;
}

// Chromium launch options. SMOKE_BROWSER_EXECUTABLE (or an auto-detected
// system Chromium) points playwright at a real binary — playwright-core ships
// no browser, and full playwright refuses to launch when its pinned revision
// is absent even though a compatible binary exists.
export function launchOptions(env = process.env) {
  const exe = resolveBrowserExecutable(env);
  return {
    headless: true,
    // Low-memory VPS discipline: /dev/shm is tiny in containers (Chromium
    // crashes writing to it) and there is no GPU; a hard launch timeout keeps
    // a wedged browser from hanging the caller.
    args: ['--disable-dev-shm-usage', '--disable-gpu'],
    timeout: 30000,
    ...(exe ? { executablePath: exe } : {}),
  };
}

// Load the Playwright chromium driver: playwright-core first (a plain npm dep,
// no browser download — we launch the system Chromium above), else the full
// playwright package (its bundled browser also works). Returns null when
// neither is installed; callers report `unavailable` loudly.
export async function loadChromium() {
  try { return (await import('playwright-core')).chromium; } catch { /* try full */ }
  try { return (await import('playwright')).chromium; } catch { return null; }
}

// Run one step against a page. Returns { ok, detail } and never throws.
async function runStep(page, step) {
  const s = stepShape(step);
  const loc = page.locator(s.selector).first();
  try {
    switch (s.kind) {
      case 'expect_visible': {
        try {
          await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
          return { ok: true, detail: `${s.selector} visible` };
        } catch (err) {
          // "Timeout 5000ms exceeded" is not a diagnosis. A compound selector
          // carries its own bisection: report the deepest prefix that IS on
          // the page, so `[data-legal-footer] .legal-link` says whether the
          // slot is missing or merely empty. Project 47 spent three cycles and
          // $10.28 on that distinction.
          //
          // Failure path ONLY — a passing run pays nothing — and wrapped so a
          // diagnosis that throws still yields the original error.
          let extra = '';
          try {
            // Probe each prefix ONCE, then let the pure layer read the result.
            const present = new Set();
            for (const p of selectorPrefixes(s.selector).slice(0, -1)) {
              // eslint-disable-next-line no-await-in-loop
              if (await page.locator(p).first().count() === 0) break;
              present.add(p);
            }
            extra = diagnosisDetail(s.selector, diagnoseSelector(s.selector, (p) => present.has(p)));
          } catch { /* the original error is still worth reporting */ }
          const base = String(err?.message || err).split('\n')[0].slice(0, 200);
          return { ok: false, detail: extra ? `${s.selector}: ${base} — ${extra}` : `${s.selector}: ${base}` };
        }
      }
      case 'expect_enabled': {
        await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        const enabled = await loc.isEnabled();
        const readonly = await loc.evaluate((el) => !!(el.readOnly || el.getAttribute('aria-disabled') === 'true')).catch(() => false);
        return enabled && !readonly
          ? { ok: true, detail: `${s.selector} enabled` }
          : { ok: false, detail: `${s.selector} is ${enabled ? 'readonly/aria-disabled' : 'disabled'} — expected an enabled control` };
      }
      case 'expect_disabled': {
        await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        const enabled = await loc.isEnabled();
        const readonly = await loc.evaluate((el) => !!(el.readOnly || el.getAttribute('aria-disabled') === 'true')).catch(() => false);
        return !enabled || readonly
          ? { ok: true, detail: `${s.selector} disabled` }
          : { ok: false, detail: `${s.selector} is enabled — expected a disabled control for this role` };
      }
      case 'expect_absent': {
        // Absent OR present-but-hidden both pass: what is asserted is that the
        // user is not OFFERED the thing (the base app hides #admin-link with
        // the `hidden` attribute rather than omitting it), not which mechanism
        // withheld it. A shorter timeout than the others on purpose — this is
        // waiting for something NOT to appear, so the full step timeout is dead
        // wall-clock on every passing run.
        try {
          await loc.waitFor({ state: 'hidden', timeout: 2000 });
          return { ok: true, detail: `${s.selector} is not offered` };
        } catch {
          return { ok: false, detail: `${s.selector} IS visible — this role must not be offered it` };
        }
      }
      case 'expect_no_scroll': {
        // A SCROLLBAR NEEDS BOTH: content that overflows AND an overflow mode
        // that scrolls rather than spills or clips.
        //
        // Overflowing content alone is not a scrollbar, and getting this wrong
        // would have been catastrophic for the one case this step exists for.
        // The build that motivated it fixed its scrollbar with
        // `#panel-todos { overflow: visible }`; measured in a real browser,
        // that element still reports scrollHeight 120 against clientHeight 60.
        // Comparing those alone would have told a build that had CORRECTLY
        // removed the scrollbar that it was still there — punishing the fix.
        // `overflow: hidden` is the same story: clipped, unscrollable, no bar.
        //
        // 2px of tolerance on the overflow itself, because sub-pixel layout
        // rounding makes an exact comparison flap on real pages.
        // AND THE PAGE IS NOT AN ELEMENT EITHER. The root element's overflow
        // propagates to the VIEWPORT (and <body>'s propagates when the root is
        // `visible`), so on `body`, `html` or `:root` the element's own
        // computed value describes nothing at all. Measured here: a page with
        // 3000px of content reports `overflow-y: visible` on all three while
        // window.scrollTo(0, 500) really moves it 500px. Under the element rule
        // that reads as "does not scroll" — a check that CANNOT FAIL, which is
        // the one thing a removal check must never be, since this step kind is
        // accepted as falsifying evidence. On the viewport, `visible` behaves
        // as `auto`, so it counts as scrollable.
        await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        const m = await loc.evaluate((el) => {
          const scrollable = (v) => v === 'auto' || v === 'scroll';
          const doc = el.ownerDocument;
          if (el === doc.documentElement || el === doc.body) {
            const rootCs = getComputedStyle(doc.documentElement);
            const bodyCs = doc.body ? getComputedStyle(doc.body) : rootCs;
            const eff = (a) => (rootCs[a] !== 'visible' ? rootCs[a] : bodyCs[a]);
            const oy = eff('overflowY');
            const ox = eff('overflowX');
            const se = doc.scrollingElement || doc.documentElement;
            return {
              y: scrollable(oy) || oy === 'visible' ? se.scrollHeight - se.clientHeight : 0,
              x: scrollable(ox) || ox === 'visible' ? se.scrollWidth - se.clientWidth : 0,
              overflowY: oy,
              overflowX: ox,
            };
          }
          const cs = getComputedStyle(el);
          return {
            y: scrollable(cs.overflowY) ? el.scrollHeight - el.clientHeight : 0,
            x: scrollable(cs.overflowX) ? el.scrollWidth - el.clientWidth : 0,
            overflowY: cs.overflowY,
            overflowX: cs.overflowX,
          };
        });
        if (m.y <= 2 && m.x <= 2) return { ok: true, detail: `${s.selector} does not scroll` };
        const parts = [];
        if (m.y > 2) parts.push(`${m.y}px of hidden height (overflow-y: ${m.overflowY})`);
        if (m.x > 2) parts.push(`${m.x}px of hidden width (overflow-x: ${m.overflowX})`);
        return { ok: false, detail: `${s.selector} still scrolls — ${parts.join(', ')}` };
      }
      case 'expect_text': {
        await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        const text = (await loc.textContent()) || '';
        return text.includes(s.contains)
          ? { ok: true, detail: `${s.selector} contains "${s.contains}"` }
          : { ok: false, detail: `${s.selector} text "${text.slice(0, 80)}" does not contain "${s.contains}"` };
      }
      case 'fill': {
        await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        // fill() throws on a disabled/readonly control — exactly the change-69
        // failure mode (an admin who cannot type into #adp-client-id).
        await loc.fill(s.value, { timeout: STEP_TIMEOUT_MS });
        if (s.expectValue) {
          const got = await loc.inputValue().catch(() => null);
          if (got !== s.value) return { ok: false, detail: `${s.selector} did not keep typed input (got "${String(got).slice(0, 60)}") — value must persist` };
        }
        return { ok: true, detail: `${s.selector} accepted typed input` };
      }
      case 'click': {
        await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        const enabled = await loc.isEnabled();
        if (!enabled) return { ok: false, detail: `${s.selector} is disabled — expected a clickable control` };
        await loc.click({ timeout: STEP_TIMEOUT_MS });
        return { ok: true, detail: `${s.selector} clicked` };
      }
      default:
        return { ok: false, detail: `unknown step kind "${s.kind}"` };
    }
  } catch (err) {
    return { ok: false, detail: `${s.kind} ${s.selector}: ${String(err?.message || err).split('\n')[0].slice(0, 200)}` };
  }
}

// Options every automation browser context uses.
//
// Service workers are BLOCKED. install.js reloads the page when a freshly
// installed worker takes control, and every context here is brand new — so
// that reload lands in the middle of whatever the check was doing: an
// in-flight goto aborts, a filled form is wiped before submit, an evaluate's
// execution context is destroyed. It produced exactly the intermittent
// "signed in? no" and "check crashed" results that made builds look flaky.
// The PWA's own behaviour is covered by the app's e2e suite, where a reload is
// the thing under test rather than noise on top of everything else.
//
// EXPORTED because design-review.js opens its own contexts and needs the same
// options. It was not, and design-review.js used the bare name anyway — so
// every capture threw `AUTOMATION_CONTEXT is not defined` at its first
// newContext and the design review has not run since. One definition, because
// two copies of "why service workers are blocked" is how they diverge.
export const AUTOMATION_CONTEXT = Object.freeze({ serviceWorkers: 'block' });

// The first VISIBLE match, not simply the first match.
//
// The platform sign-in page carries THREE forms — #form-bootstrap (create the
// first administrator), #form-login, #form-setup — and shows exactly one,
// chosen at runtime from /api/auth/bootstrap/status. `locator(sel).first()`
// therefore resolves to a hidden control on most projects: on a fresh app it
// picks the create-administrator fields, so "signing in" POSTed to
// /auth/bootstrap/superadmin and the browser never left the gate. That is the
// mechanism behind "the ai can never see past the login screen" — the seeded
// account was fine, the selector was aimed at the wrong form.
export function firstVisible(page, selector) {
  return page.locator(selector).locator('visible=true').first();
}

// Navigate, tolerating the service worker's one-shot reload.
//
// install.js reloads the page when a newly installed worker takes control,
// which aborts an in-flight goto with ERR_ABORTED. On a fresh browser context
// — which is what every check and every screenshot uses — that is the FIRST
// navigation, so the abort is not an edge case. Retry the abort; a navigation
// that keeps failing still throws, so a genuinely dead page fails honestly.
export async function gotoStable(page, url, { waitUntil = 'domcontentloaded' } = {}) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil, timeout: NAV_TIMEOUT_MS });
      return;
    } catch (err) {
      last = err;
      if (!/ERR_ABORTED|context was destroyed|Target closed|frame was detached/i.test(String(err?.message || err))) throw err;
      await page.waitForTimeout(400).catch(() => undefined);
    }
  }
  throw last;
}

// Sign in through the API rather than the form, from inside the page so the
// httpOnly session cookies land in the browser context that will do the
// screenshotting. No selectors, no guessing which form is showing, no
// dependence on the build model having left the markup alone.
//
// Only the platform auth component serves /api/auth/login; anything else
// answers 404 and the caller falls back to driving the form. Returns true only
// on a real success — never throws.
// The service worker reloads the page out from under this on a FRESH browser
// context: install.js reloads once on `controllerchange`, which is precisely
// when a first-ever visit installs the worker — and every capture context is
// brand new. A reload mid-evaluate destroys the execution context, the fetch
// result is lost, and the sign-in looks like it failed when the cookies were
// in fact set. Settling first makes it rare; retrying makes it not matter.
export async function apiSignIn(page, baseUrl, creds) {
  if (!creds?.email || !creds?.password) return false;
  const payload = { email: String(creds.email), password: String(creds.password) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Must be ON the origin first: fetch() needs a same-origin document for
      // the Set-Cookie to be stored against it.
      await gotoStable(page, new URL('/login', baseUrl).toString());
      // Let the service worker install and do its one reload before we run
      // anything that a navigation would kill.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      const ok = await page.evaluate(async ({ email, password }) => {
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ email, password }),
          });
          return res.ok;
        } catch { return false; }
      }, payload);
      if (ok) return true;
      // A clean `false` is a real rejection (bad password, no such endpoint) —
      // only a destroyed context is worth retrying, and that arrives as a throw.
      return false;
    } catch {
      await page.waitForTimeout(400).catch(() => undefined);
    }
  }
  return false;
}

// Open the sign-in door before typing into it.
//
// firstVisible() picks the form that is SHOWING — but on an app whose operator
// has not created their administrator yet, the form showing is "create the
// first administrator", and it is the correct one to show. The sign-in form is
// one click away behind #to-login. Without this, filling the visible fields
// POSTs to /auth/bootstrap/superadmin and the reviewer never gets in.
//
// A no-op on any page without that control, so a build that restyled or
// replaced the sign-in page is unaffected.
export async function revealSignInForm(page) {
  try {
    const link = page.locator('#to-login');
    if (await link.isVisible({ timeout: 1000 })) {
      await link.click({ timeout: 2000 });
      await page.waitForTimeout(200);
    }
  } catch { /* not the platform sign-in page; carry on with what is visible */ }
}

// Wait for a submitted sign-in to actually land.
//
// The scaffold's submit handler is an XHR followed by location.assign('/') —
// so at the moment of the click there is no navigation and no in-flight
// request yet, and waitForLoadState('networkidle') RETURNS IMMEDIATELY on the
// already-idle page. The caller then asks "am I signed in?" while the login
// POST is still in flight, sees the sign-in page, and reports a failed login
// on a successful one. Wait for the URL to leave /login instead.
export async function waitForSignInToLand(page, timeout = 8000) {
  await page.waitForURL((u) => !/\/login(?:[/?#]|$)/.test(String(u)), { timeout }).catch(() => undefined);
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
}

// Log in as a role using the spec's login block + seeded test-fixture users.
// Exported for the design-review pass (authenticated screenshots).
//
// The API path is tried first when the block is the platform's own (see
// withPlatformLogin): it cannot be defeated by a restyled login page. A
// spec-declared block still drives the real form — that IS the thing under
// test — but against the visible controls.
export async function loginAs(page, baseUrl, login, role) {
  const user = login.users[role];
  if (login.via === 'api' && await apiSignIn(page, baseUrl, { email: user.username, password: user.password })) return;
  await gotoStable(page, new URL(login.path, baseUrl).toString());
  // Settle BEFORE typing: the service worker's one-shot reload would otherwise
  // wipe the fields between fill() and click().
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await revealSignInForm(page);
  await firstVisible(page, login.user_field).fill(user.username, { timeout: STEP_TIMEOUT_MS });
  await firstVisible(page, login.pass_field).fill(user.password, { timeout: STEP_TIMEOUT_MS });
  await firstVisible(page, login.submit).click({ timeout: STEP_TIMEOUT_MS });
  await waitForSignInToLand(page);
}

// runUiChecks({ baseUrl, spec, checks }) → { ok, unavailable?, results, detail }.
// Each check runs in a FRESH browser context (no session bleed between roles).
// Console errors ('console' type error + 'pageerror') collected on every page a
// check visits fail that check. Never throws.
export async function runUiChecks({ baseUrl, spec, checks }) {
  const chromium = await loadChromium();
  if (!chromium) {
    return { ok: false, unavailable: true, results: [], detail: 'ui-checks: playwright-core is not installed (npm install in admin/backend, or rerun update.sh) — or disable the browser connector explicitly' };
  }
  let browser = null;
  const results = [];
  try {
    browser = await chromium.launch(launchOptions());
    for (const chk of checks) {
      const result = { id: chk.id, name: chk.name, role: chk.role, page: chk.page, ok: false, steps: [], consoleErrors: [] };
      let context = null;
      try {
        context = await browser.newContext(AUTOMATION_CONTEXT);
        const page = await context.newPage();
        // ANY console error fails the check — a JS exception, a console.error
        // from page code, or a failed script/CSS/API load. The one exception is
        // the browser's automatic favicon probe: a missing favicon is noise,
        // not a UI regression.
        page.on('console', (msg) => {
          if (msg.type() !== 'error') return;
          const src = String(msg.location()?.url || '');
          if (/failed to load resource/i.test(msg.text()) && /favicon\.ico(\?|$)/i.test(src)) return;
          // Carry the failing URL — "Failed to load resource: 404" without the
          // resource is undiagnosable (req: a smoke failure nobody could act on).
          result.consoleErrors.push(`${msg.text()}${src ? ` [${src}]` : ''}`.slice(0, 300));
        });
        page.on('pageerror', (err) => { result.consoleErrors.push(String(err?.message || err).slice(0, 300)); });

        if (chk.role) await loginAs(page, baseUrl, spec.login, chk.role);
        await gotoStable(page, new URL(chk.page, baseUrl).toString());
        await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);

        for (const step of chk.steps) {
          const r = await runStep(page, step);
          result.steps.push({ ...stepShape(step), ok: r.ok, detail: r.detail });
          if (!r.ok) break; // later steps usually depend on earlier ones
        }
        result.ok = result.steps.every((s) => s.ok) && result.consoleErrors.length === 0;
      } catch (err) {
        result.detail = `check crashed: ${String(err?.message || err).split('\n')[0].slice(0, 200)}`;
        result.ok = false;
      } finally {
        try { if (context) await context.close(); } catch { /* ignore */ }
      }
      results.push(result);
    }
    return { ok: results.every((r) => r.ok), results };
  } catch (err) {
    return { ok: false, results, detail: `ui-checks runner error: ${err?.message || err}` };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}
