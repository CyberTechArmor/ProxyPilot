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

import { stepShape } from './ui-check-logic.js';

const NAV_TIMEOUT_MS = 15000;
const STEP_TIMEOUT_MS = 5000;

// Chromium launch options. SMOKE_BROWSER_EXECUTABLE lets an operator point at a
// system/pre-provisioned Chromium (e.g. /opt/pw-browsers/chromium or
// /usr/bin/chromium) instead of the revision the installed playwright package
// would download — playwright refuses to launch when its pinned revision is
// absent even though a compatible binary exists.
export function launchOptions(env = process.env) {
  const exe = String(env.SMOKE_BROWSER_EXECUTABLE || '').trim();
  return { headless: true, ...(exe ? { executablePath: exe } : {}) };
}

// Run one step against a page. Returns { ok, detail } and never throws.
async function runStep(page, step) {
  const s = stepShape(step);
  const loc = page.locator(s.selector).first();
  try {
    switch (s.kind) {
      case 'expect_visible': {
        await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        return { ok: true, detail: `${s.selector} visible` };
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

// Log in as a role using the spec's login block + seeded test-fixture users.
async function loginAs(page, baseUrl, login, role) {
  const user = login.users[role];
  await page.goto(new URL(login.path, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.locator(login.user_field).first().fill(user.username, { timeout: STEP_TIMEOUT_MS });
  await page.locator(login.pass_field).first().fill(user.password, { timeout: STEP_TIMEOUT_MS });
  await page.locator(login.submit).first().click({ timeout: STEP_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
}

// runUiChecks({ baseUrl, spec, checks }) → { ok, unavailable?, results, detail }.
// Each check runs in a FRESH browser context (no session bleed between roles).
// Console errors ('console' type error + 'pageerror') collected on every page a
// check visits fail that check. Never throws.
export async function runUiChecks({ baseUrl, spec, checks }) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return { ok: false, unavailable: true, results: [], detail: `ui-checks: playwright not installed (${err?.message || err}) — install it in admin/backend or disable the browser connector explicitly` };
  }
  let browser = null;
  const results = [];
  try {
    browser = await chromium.launch(launchOptions());
    for (const chk of checks) {
      const result = { id: chk.id, name: chk.name, role: chk.role, page: chk.page, ok: false, steps: [], consoleErrors: [] };
      let context = null;
      try {
        context = await browser.newContext();
        const page = await context.newPage();
        // ANY console error fails the check — a JS exception, a console.error
        // from page code, or a failed script/CSS/API load. The one exception is
        // the browser's automatic favicon probe: a missing favicon is noise,
        // not a UI regression.
        page.on('console', (msg) => {
          if (msg.type() !== 'error') return;
          const src = String(msg.location()?.url || '');
          if (/failed to load resource/i.test(msg.text()) && /favicon\.ico(\?|$)/i.test(src)) return;
          result.consoleErrors.push(msg.text().slice(0, 300));
        });
        page.on('pageerror', (err) => { result.consoleErrors.push(String(err?.message || err).slice(0, 300)); });

        if (chk.role) await loginAs(page, baseUrl, spec.login, chk.role);
        await page.goto(new URL(chk.page, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
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
