// The vendored base application template + the default design brief.
//
// These assert the CONTRACT, not the implementation: that the security fixes
// which made this codebase adoptable are actually present in the tree we ship,
// and that the default design brief reaches the generation AI with its
// precedence intact. A future re-vendor that silently drops one of these fails
// here instead of shipping a hole to every generated project.
//
// Native-free: pure file reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock2', 'framework-seed');
const read = (p) => readFileSync(path.join(SEED, p), 'utf8');

test('the base app template ships with the pieces a project needs', () => {
  for (const f of ['base-app/server.js', 'base-app/package.json', 'base-app/RUNBOOK.md',
    'base-app/test/run.js', 'base-app/lib/util.js', 'base-app/lib/session.js',
    'base-app/public/portal.js', 'base-app/public/app.js']) {
    assert.ok(existsSync(path.join(SEED, f)), `missing ${f}`);
  }
  // Near-zero dependency philosophy: only the two the packet download needs.
  const pkg = JSON.parse(read('base-app/package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['jszip', 'pdf-lib']);
});

test('SECURITY: set-password requires proof of identity (no account takeover)', () => {
  const s = read('base-app/server.js');
  const i = s.indexOf("'/api/auth/set-password'");
  assert.ok(i > 0, 'set-password route present');
  const route = s.slice(i, i + 2400);
  // Must demand a token or the temporary password, and must NOT hand out a
  // session merely because mustSetPassword is still true.
  assert.match(route, /PROOF_REQUIRED/);
  assert.match(route, /verifyReset|verifyLogin/);
  assert.match(route, /verifyPassword/);
  assert.match(route, /RATE_LIMITED/);
});

test('SECURITY: emailed links come from a configured origin, not request headers', () => {
  const s = read('base-app/server.js');
  assert.match(s, /const APP_BASE_URL = String\(process\.env\.APP_BASE_URL/);
  // Production must refuse rather than trust a forged host.
  assert.match(s, /APP_BASE_URL_REQUIRED/);
  const i = s.indexOf('function publicOrigin');
  const fn = s.slice(i, i + 700);
  assert.ok(fn.indexOf('if (APP_BASE_URL) return APP_BASE_URL;') < fn.indexOf('x-forwarded-host'),
    'the configured origin must be consulted BEFORE any header');
});

test('SECURITY: cookies can be Secure; XFF is only trusted behind a proxy', () => {
  const s = read('base-app/server.js');
  assert.match(s, /FORCE_SECURE_COOKIES/);
  assert.match(s, /function isSecureRequest/);
  assert.match(s, /sameSite: 'Lax', secure/);

  const u = read('base-app/lib/util.js');
  const i = u.indexOf('function clientIp');
  const fn = u.slice(i, i + 500);
  assert.match(fn, /TRUSTED_PROXY/);
  assert.ok(fn.indexOf('TRUSTED_PROXY') < fn.indexOf('x-forwarded-for'),
    'XFF must be gated by the trusted-proxy flag');
});

test('housekeeping: sessions are pruned; both escapers cover quotes', () => {
  const sess = read('base-app/lib/session.js');
  assert.match(sess, /function prune\(/);
  assert.match(sess, /SESSION_PRUNE_GRACE_MS/);
  assert.match(sess, /revokedAt/);
  // Escapers must cover BOTH quote characters (attribute-context breakout).
  for (const f of ['base-app/public/portal.js', 'base-app/public/app.js']) {
    const src = read(f);
    const i = src.indexOf('function esc');
    const fn = src.slice(i, i + 400);
    assert.ok(/&#39;/.test(fn), `${f} escaper must escape single quotes`);
    assert.ok(/&quot;/.test(fn), `${f} escaper must escape double quotes`);
  }
});

test('robustness: the request body is drained by framing, and JSON replies are length-framed', () => {
  const s = read('base-app/server.js');
  // Keyed on framing headers, NOT the method — a body may ride any verb.
  assert.match(s, /content-length'\]\s*\|\|\s*req\.headers\['transfer-encoding/);
  assert.match(s, /_bodyPromise/);
  const u = read('base-app/lib/util.js');
  assert.match(u, /'Content-Length': body\.length/);
  assert.match(u, /Buffer\.from\(JSON\.stringify\(obj\), 'utf8'\)/);
});

test('the acceptance suite covers the security fixes and sends no body on GET', () => {
  const t = read('base-app/test/run.js');
  for (const name of ['set-password requires proof', 'canonical origin', 'X-Forwarded-For is ignored', 'pruned']) {
    assert.ok(t.includes(name), `acceptance suite missing a case for: ${name}`);
  }
  // The harness bug that desynchronised the parser must stay fixed.
  assert.match(t, /body !== undefined && body !== null/);
  assert.match(t, /APP_BASE_URL/);
});

test('the default design brief reaches the AI with its precedence intact', () => {
  // Vendored source of truth + human-readable appendix.
  assert.ok(existsSync(path.join(SEED, 'design-brief.md')));
  assert.ok(existsSync(path.join(SEED, 'design-brief-appendix.md')));

  // design_system_md is what the concept/mockup prompts actually inject, so the
  // brief must live THERE to be discoverable — a vendored file alone is inert.
  const ds = read('design-system.md');
  assert.match(ds, /§9 Default visual reference/);
  assert.match(ds, /DEFAULT, NOT MANDATORY/);
  assert.match(ds, /design direction wins, entirely/);
  // Its actual content, not just a pointer.
  assert.match(ds, /--blue-600:#1466b8/);

  // The one deliberate reconciliation: the brief was written light-only, but the
  // mockup contract requires a dark variant + toggle (a machine check). The
  // injected text must resolve that rather than leave the AI to fail the gate,
  // and must point at the base app's implementation instead of asking every
  // build to re-derive the mapping.
  assert.match(ds, /dark variant/);
  assert.match(ds, /\[data-theme="dark"\]/, 'the brief must name the mechanism, not just the requirement');
  // The two rules that are easy to get wrong; both are pinned by their own
  // tests below, and the brief is where a build actually reads them.
  assert.match(ds, /var\(--surface\)/);
  assert.match(ds, /before the stylesheet/);
});

test('the dark-variant machine check still binds (the brief must not have relaxed it)', () => {
  const checks = readFileSync(path.join(SEED, '..', 'mockup-checks-logic.js'), 'utf8');
  assert.match(checks, /\[data-theme="dark"\]/);
  assert.match(checks, /theme-toggle/);
});

test('the migration note tells an existing project what to re-check', () => {
  const m = read('BASE-APP-MIGRATION.md');
  for (const need of ['set-password', 'APP_BASE_URL', 'TRUSTED_PROXY', 'Secure', 'prune']) {
    assert.ok(m.includes(need), `migration note missing: ${need}`);
  }
});

/* ------------------------- theme + responsiveness ------------------------- */

test('the base app ships a real dark theme, applied before first paint', () => {
  const css = read('base-app/public/style.css');
  const html = read('base-app/public/index.html');
  const js = read('base-app/public/theme.js');

  // Both themes declare color-scheme so native controls and scrollbars follow.
  assert.match(css, /\[data-theme="dark"\]\s*\{/, 'a dark token block must exist');
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /color-scheme:\s*dark/);

  // theme.js must load SYNCHRONOUSLY and BEFORE the stylesheet, or a dark-mode
  // user gets a white flash on every single page load.
  const themeAt = html.indexOf('theme.js');
  const cssAt = html.indexOf('style.css');
  assert.ok(themeAt > 0 && cssAt > 0, 'theme.js and style.css must both be linked');
  assert.ok(themeAt < cssAt, 'theme.js must be loaded before the stylesheet');
  const themeTag = html.slice(html.lastIndexOf('<script', themeAt), themeAt);
  assert.ok(!/\b(defer|async)\b/.test(themeTag), 'theme.js must not be deferred or async');

  // Three states, and the OS is followed while the preference is "system".
  assert.match(js, /prefers-color-scheme:\s*dark/);
  assert.match(js, /'system'/);
  // Toggles are wired by delegation: the auth layout renders from five call
  // sites, and per-render binding silently misses whichever one is added next.
  assert.match(js, /document\.addEventListener\('click'/);
});

test('no surface is painted with a hardcoded white (it would stay white in dark mode)', () => {
  const css = read('base-app/public/style.css');
  // --white is deliberately literal white in BOTH themes: it is for text and
  // icons on a solid coloured fill. Using it as a BACKGROUND leaves that
  // element white in dark mode — which is exactly the bug this pins.
  const whiteBg = css.match(/background[^;{}]*var\(--white\)/g) || [];
  assert.deepEqual(whiteBg, [], `use var(--surface) for surfaces, not var(--white): ${whiteBg.join(', ')}`);
  const literalBg = css.match(/background:\s*#fff\b(?!\s*[,)])/g) || [];
  assert.deepEqual(literalBg, [], `hardcoded white backgrounds do not theme: ${literalBg.length} found`);
});

test('mobile: the responsive breakpoints and 44px touch targets are present', () => {
  const css = read('base-app/public/style.css');
  for (const bp of ['768px', '640px', '400px']) {
    assert.ok(css.includes(`max-width:${bp}`), `missing the ${bp} breakpoint`);
  }
  assert.match(css, /min-height:44px/, 'touch targets must reach 44px on small screens');
  assert.match(css, /prefers-reduced-motion/, 'reduced-motion must be honoured');
  // The decorative .glow is absolutely positioned inside .left and clipped by
  // its overflow:hidden. Making .left static at a breakpoint hands the glow the
  // initial containing block, it escapes the clip, and the whole page scrolls
  // sideways by 120px on every phone. Pin the fix.
  assert.ok(!/\.split \.left\s*,[^{]*\{[^}]*position:static/.test(css),
    '.split .left must keep position:relative — a static one lets .glow escape its clip');
});

/* --------------------- branding, legal pages & assets --------------------- */

test('legal pages and branding are reachable WITHOUT a session', () => {
  const s = read('base-app/server.js');
  // The public routes must be registered before the auth-gated section, and
  // must not call requireAuth/requirePerm — the sign-in screen renders the
  // copyright notice and the Privacy/Terms links before anyone has logged in.
  const pub = s.indexOf("p === '/api/branding' && method === 'GET'");
  const setup = s.indexOf("p === '/api/setup/status'");
  assert.ok(pub > 0, 'public branding route present');
  assert.ok(pub < setup, 'public branding must be registered before the gated routes');
  const block = s.slice(pub, s.indexOf("/* ----- setup ----- */"));
  assert.ok(!/requireAuth|requirePerm/.test(block), 'public branding routes must not be auth-gated');
  assert.match(block, /\/api\\\/legal\\\/|api\/legal/, 'the legal page route must be public');

  // Every admin mutation IS gated, on its own permission.
  for (const route of ["p === '/api/admin/branding' && method === 'PUT'",
    "p === '/api/admin/branding/assets' && method === 'POST'"]) {
    const i = s.indexOf(route);
    assert.ok(i > 0, `missing route: ${route}`);
    assert.match(s.slice(i, i + 260), /requirePerm\(req, res, 'branding\.manage'\)/);
  }
});

test('the favicon falls back to the logo and never dangles', () => {
  const b = read('base-app/lib/branding.js');
  assert.match(b, /function faviconId\(b\)\s*\{\s*return b\.faviconAssetId \|\| b\.logoAssetId \|\| null/);
  // Deleting the asset must clear both pointers, or the fallback resolves to a
  // permanent 404 on every page load.
  const rm = b.slice(b.indexOf('function removeAsset'));
  assert.match(rm, /b\.logoAssetId === id/);
  assert.match(rm, /b\.faviconAssetId === id/);
  // /favicon.ico resolves server-side, without a <link> hint or a session.
  assert.match(read('base-app/server.js'), /'\/favicon\.ico'/);
});

test('the copyright year is computed on read, never stored', () => {
  const b = read('base-app/lib/branding.js');
  const fn = b.slice(b.indexOf('function copyrightYears'), b.indexOf('function copyrightNotice'));
  assert.match(fn, /getFullYear\(\)/, 'the year must be derived at read time');
  // A stored year would go stale on 1 January without a redeploy.
  assert.ok(!/copyrightYear\s*[:=]\s*\d{4}/.test(b), 'the current year must not be persisted');
  // The client recomputes too, so a tab left open across New Year self-corrects.
  assert.match(read('base-app/public/branding.js'), /new Date\(\)\.getFullYear\(\)/);
});

test('legal page bodies are escaped before rendering (no stored XSS)', () => {
  const c = read('base-app/public/branding.js');
  const fn = c.slice(c.indexOf('function renderBody'), c.indexOf('function fmtDate'));
  // Every branch that reaches innerHTML must pass through esc() first: an admin
  // with page-edit rights must not be able to turn the UNAUTHENTICATED privacy
  // page into a script host.
  for (const tag of ['<h2>', '<li>', '<p>']) {
    const i = fn.indexOf(tag);
    assert.ok(i > 0, `renderBody must emit ${tag}`);
    assert.match(fn.slice(i, i + 90), /esc\(/, `${tag} content must be escaped`);
  }
  assert.ok(!/innerHTML\s*=\s*[^;]*\bbody\b(?!\s*\))/.test(fn), 'raw body must never reach innerHTML');
});

test('uploaded branding assets are served sandboxed and type-pinned', () => {
  const b = read('base-app/lib/branding.js');
  const fn = b.slice(b.indexOf('function streamAsset'));
  assert.match(fn, /X-Content-Type-Options.*nosniff/s);
  // SVG is allowed here (a logo wants to be vector) and is only safe because of
  // these headers — dropping either one turns an upload into stored XSS.
  assert.match(fn, /Content-Security-Policy.*sandbox/s);
  assert.match(b, /'\.svg': 'image\/svg\+xml'/);
  assert.ok(!/text\/html/.test(b), 'HTML must never be a storable asset type');
});

test('app context is a documented build-time contract', () => {
  const b = read('base-app/lib/branding.js');
  assert.match(b, /CONTRACT — appContext/);
  // The instruction that matters: record WHAT users can do, not why it exists.
  assert.match(b, /not why it was built|not why/i);
  assert.match(b, /summary.*audience.*features/s);
});
