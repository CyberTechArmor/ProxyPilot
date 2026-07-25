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

  // The one deliberate reconciliation: the brief is light-only, but the mockup
  // contract requires a dark variant + toggle (a machine check). The injected
  // text must resolve that rather than leave the AI to fail the gate.
  assert.match(ds, /derive the dark variant/);
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
