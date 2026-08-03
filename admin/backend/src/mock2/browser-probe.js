// browser-probe.js — mid-cycle observation of the running app (run-taxonomy fix
// #1/B1). Reuses ui-checks.js's launcher, context, and login so a probe sees
// the SAME app the smoke connector does, but answers a different question: not
// "does this check pass" but "what is actually on this page" — console errors,
// failed requests, whether a selector is visible, and its COMPUTED STYLE. That
// last one is new capability: the smoke check vocabulary (ui-check-logic.js
// STEP_KINDS) has no computed-style assertion at all, and it is exactly what
// would have ended the docs2 `.popover.menu { display:none }` saga (five
// cycles of reasoning about behaviour) on the first probe.
//
// Deliberately separate from ui-checks.js (the smoke EXECUTOR, imported by
// smoke.js) rather than folded into it — this keeps the mid-cycle observation
// path decoupled from the post-deploy smoke path. Login/context/navigation are
// imported, never re-implemented, so there is exactly one login path.

import {
  loadChromium, launchOptions, AUTOMATION_CONTEXT, gotoStable, loginAs,
} from './ui-checks.js';

const NAV_TIMEOUT_MS = 15000;
const MAX_CONSOLE_ERRORS = 20;
const MAX_NETWORK_FAILURES = 20;
const COMPUTED_STYLE_PROPS = ['display', 'visibility', 'opacity', 'position', 'zIndex', 'overflow', 'pointerEvents'];

// runBrowserProbe({ baseUrl, spec, input }) → observation result. `input` is
// the validated shape from probe-logic.browserProbePlan: { target, path, role,
// selectors, domSelector }. `spec` is the parsed state/ui-checks.json (for
// `loginAs`'s login users) — null when the caller has none or `role` is unset.
// Never throws: every failure mode returns a structured result the caller can
// format, matching every other containerSh/runUiChecks consumer's contract.
export async function runBrowserProbe({ baseUrl, spec = null, input = {} }) {
  const { target, path, role = null, selectors = [], domSelector = null } = input;
  const chromium = await loadChromium();
  if (!chromium) {
    return {
      target, path, unavailable: true,
      detail: 'playwright-core is not installed (npm install in admin/backend, or rerun update.sh)',
    };
  }
  let browser = null;
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext(AUTOMATION_CONTEXT);
    try {
      const page = await context.newPage();
      const consoleErrors = [];
      const networkFailures = [];
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const src = String(msg.location()?.url || '');
        if (/failed to load resource/i.test(msg.text()) && /favicon\.ico(\?|$)/i.test(src)) return;
        if (consoleErrors.length < MAX_CONSOLE_ERRORS) {
          consoleErrors.push(`${msg.text()}${src ? ` [${src}]` : ''}`.slice(0, 300));
        }
      });
      page.on('pageerror', (err) => {
        if (consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(String(err?.message || err).slice(0, 300));
      });
      page.on('requestfailed', (req) => {
        if (networkFailures.length < MAX_NETWORK_FAILURES) {
          networkFailures.push(`${req.method()} ${req.url()} → ${req.failure()?.errorText || 'failed'}`.slice(0, 300));
        }
      });
      page.on('response', (res) => {
        if (res.status() >= 400 && networkFailures.length < MAX_NETWORK_FAILURES) {
          networkFailures.push(`${res.request().method()} ${res.url()} → ${res.status()}`.slice(0, 300));
        }
      });

      if (role && spec?.login) {
        try { await loginAs(page, baseUrl, spec.login, role); } catch (e) {
          return { target, path, error: `could not sign in as "${role}": ${e?.message || e}` };
        }
      }
      try {
        await gotoStable(page, new URL(path, baseUrl).toString());
        await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
      } catch (e) {
        return { target, path, error: `navigation failed: ${e?.message || e}` };
      }

      const selectorResults = [];
      for (const selector of selectors) {
        try {
          const loc = page.locator(selector).first();
          const found = (await loc.count()) > 0;
          if (!found) { selectorResults.push({ selector, found: false, visible: false }); continue; }
          const visible = await loc.isVisible().catch(() => false);
          const computed = await loc.evaluate((el, props) => {
            const cs = getComputedStyle(el);
            const out = {};
            for (const p of props) out[p] = cs[p];
            return out;
          }, COMPUTED_STYLE_PROPS).catch(() => null);
          selectorResults.push({ selector, found: true, visible, computed: computed || undefined });
        } catch (e) {
          selectorResults.push({ selector, found: false, visible: false, error: String(e?.message || e).slice(0, 200) });
        }
      }

      let dom = null;
      if (domSelector) {
        try {
          const loc = page.locator(domSelector).first();
          dom = (await loc.count()) > 0 ? await loc.evaluate((el) => el.outerHTML).catch(() => null) : null;
        } catch { dom = null; }
      }

      return { target, path, consoleErrors, networkFailures, selectors: selectorResults, dom };
    } finally {
      try { await context.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    return { target, path, error: `browser probe crashed: ${err?.message || err}` };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}
