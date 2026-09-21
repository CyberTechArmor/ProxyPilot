// Mock2 READINESS — the pure half.
//
// WHY THIS EXISTS: `probeServing` asks for `/` and accepts any status below
// 500. On an auth-gated app that is a 302 to /login, which a dead database, a
// crashed migration, a 500ing API and a blank white page all also produce — the
// gate redirect happens BEFORE any of them are reached. So "the app deployed"
// meant "a process is listening", and an app that was comprehensively broken
// read as healthy. That is the shape of "the app did not work until redeployed"
// and of "there are parts that don't work, code error".
//
// This asks the questions a deploy probe should: does the app's own health
// endpoint answer, does the sign-in page RENDER, does anything 5xx, and — when
// the platform holds fixture credentials — does a signed-in request actually
// come back with the app rather than the gate.
//
// Every check prints one labelled line, so a partial run still parses.

// A 5xx anywhere is disqualifying. Everything else is judged per check, because
// "404" means "this app has no auth component" on one probe and "your page is
// missing" on another.
import { classifyRows } from './auth-data-logic.js';

const CODE_RE = /^([A-Z_]+):(\d{3})$/;

// The checks, in the order the script runs them. `required` decides whether a
// failure means NOT READY; the rest are reported for the log and no more.
export const READINESS_CHECKS = Object.freeze([
  {
    key: 'ROOT',
    path: '/',
    describe: 'the app answers at all',
    // Any answer proves a process is listening. This is the OLD check, kept as
    // the floor rather than the ceiling.
    ok: (n) => n > 0 && n < 500,
    required: true,
    why: 'nothing is listening, or the app is 5xx on its own home page',
  },
  {
    key: 'HEALTH',
    path: '/api/health',
    describe: 'the health endpoint reports healthy',
    // 200 or nothing. A 503 here is the app SAYING it is not ready — it used to
    // be read as "below 500, so fine".
    ok: (n) => n === 200,
    required: true,
    why: 'the app reports itself unhealthy (a failed migration or a dead database looks exactly like this)',
  },
  {
    key: 'LOGIN',
    path: '/login',
    describe: 'the sign-in page renders',
    // The one page every gated app must serve to an anonymous visitor. A 500 or
    // a redirect loop here means nobody can get in at all — and the old probe
    // could not see it, because it only ever looked at the redirect.
    ok: (n) => n === 200 || n === 404,
    required: true,
    why: 'the sign-in page does not render, so nobody can get into the app',
  },
  {
    key: 'SIGNUP',
    path: '/api/auth/bootstrap/status',
    describe: 'the first-administrator door answers',
    // The sign-in page RENDERING is not the same as the sign-in flow WORKING.
    //
    // A build mounted its feature router above the platform's auth API. /login
    // was 200 and beautifully styled — and this endpoint answered 401, which
    // login.js reads as "a user already exists": it showed the sign-in form and
    // hid the create-the-first-administrator link. On an app with no accounts
    // that is a locked door with no handle, and the operator's report was "it
    // broke the first user signup to super admin".
    //
    // 404 passes: not every app is gated, and a project without the auth
    // component has no such endpoint. 401/403 is the failure — the endpoint the
    // bootstrap gate explicitly allows through cannot itself be behind a guard.
    ok: (n) => n === 200 || n === 404,
    required: true,
    why: 'the first-administrator check is unreachable, so the sign-in screen hides the create-account form and nobody can open the app',
  },
  {
    key: 'STATIC',
    path: '/base.css',
    describe: 'the stylesheet is served',
    // A 404 here is the difference between "an app" and "unstyled HTML" — the
    // exact shape of a build that looks nothing like its mockup.
    ok: (n) => n === 200,
    required: false,
    why: 'the shared stylesheet is missing, so pages render unstyled',
  },
]);

// The in-container script. curl only — no jq, no node, nothing that has to be
// installed in the app's container.
// The non-HTTP readiness lines — three separate facts about the app's master
// secret, because none implies the others (docs/features/immediate-repairs.md):
//   MASTERKEY       a NON-DEFAULT master secret is configured in the environment
//                   the restarted unit read (not proof of what an older
//                   process loaded)
//   MASTERKEY_ROWS  every stored credential decrypts under that active key
//                   (200), some do not (404), none stored (204), probe failed (500)
//   LEGACYBRIDGE    the legacy-key fallback is disabled (AUTH_LEGACY_MASTER_SECRETS
//                   set empty)
// All warnings, never failures, reported on every deploy so a deferred or
// half-migrated project stays visibly marked; skipped for a project with no
// auth component (LOGIN 404).
export const DEV_MASTER_SECRET_LITERAL = 'dev-insecure-master-secret-change-me';
export const MASTERKEY_CHECK = Object.freeze({
  key: 'MASTERKEY',
  // "configured": the environment file the unit reads at start. Readiness runs
  // after the deploy restarted the unit, so this is what THAT process loaded;
  // the application-level confirmation (the LDAPS settings decrypting the
  // stored credential after a restart) is the host acceptance test.
  describe: 'a non-default master secret is configured for the restarted app',
  ok: (n) => n === 200,
  required: false,
  why: 'AUTH_MASTER_SECRET is unset or still the public development default in the container environment, so stored credentials are encrypted under a public key — install the current auth component and redeploy (docs/features/immediate-repairs.md)',
});
export const MASTERKEY_ROWS_CHECK = Object.freeze({
  key: 'MASTERKEY_ROWS',
  describe: 'every stored credential decrypts under the configured master secret',
  ok: (n) => n === 200 || n === 204,
  required: false,
  why: 'at least one stored credential does not decrypt under the active master secret (still under a legacy key, or the probe could not run) — open the LDAPS settings to rekey and check masterKeyInventory',
});
export const LEGACYBRIDGE_CHECK = Object.freeze({
  key: 'LEGACYBRIDGE',
  describe: 'the legacy-key fallback is disabled',
  ok: (n) => n === 200,
  required: false,
  why: 'AUTH_LEGACY_MASTER_SECRETS is not set to an empty string, so the app still accepts credentials encrypted under the development default — once masterKeyInventory reports complete, set it empty and redeploy',
});
export const MASTERKEY_CHECKS = Object.freeze([MASTERKEY_CHECK, MASTERKEY_ROWS_CHECK, LEGACYBRIDGE_CHECK]);

// The shell for the two environment facts — plain sed/grep, nothing else: the
// readiness probe never depends on node, jq or python in the guest. The third
// fact (do the stored rows decrypt under the active key?) needs the cipher,
// so readiness.js computes it on the platform side with auth-data-logic.js and
// appends a MASTERKEY_ROWS line before parsing.
export function masterKeyScript() {
  return [
    `K=$(sed -n 's/^AUTH_MASTER_SECRET=//p' /etc/environment 2>/dev/null | head -1 | sed -e 's/^"//' -e 's/"$//')`,
    `if [ -n "$K" ] && [ "$K" != "${DEV_MASTER_SECRET_LITERAL}" ]; then echo "MASTERKEY:200"; else echo "MASTERKEY:404"; fi`,
    `if grep -q -E '^AUTH_LEGACY_MASTER_SECRETS=("")?$' /etc/environment 2>/dev/null; then echo "LEGACYBRIDGE:200"; else echo "LEGACYBRIDGE:404"; fi`,
  ].join('\n');
}

// masterKeyRowsCode({ probe, envKey, legacyDefault }) → the MASTERKEY_ROWS code:
//   200 every stored credential decrypts under the ACTIVE key (the env key,
//       or the development default when none is set)
//   204 nothing stored (no table, no database, no rows)
//   404 at least one row does not decrypt under the active key
//   500 the probe could not run
export function masterKeyRowsCode({ probe, envKey = '', legacyDefault = DEV_MASTER_SECRET_LITERAL } = {}) {
  const state = probe?.state || 'unknown';
  if (state === 'unknown' || state === 'rls') return 500;
  if (state !== 'rows') return 204;
  const active = envKey || legacyDefault;
  const c = classifyRows(probe.rows, { current: active, legacy: [] });
  return c.total > 0 && c.current === c.total ? 200 : 404;
}

export function readinessScript({ port, authed = null }) {
  const base = `http://127.0.0.1:${Number(port)}`;
  const lines = ['set -u'];
  for (const c of READINESS_CHECKS) {
    lines.push(
      `C=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "${base}${c.path}" 2>/dev/null)`,
      `echo "${c.key}:\${C:-000}"`,
    );
  }
  lines.push(masterKeyScript());
  // The signed-in question, when the platform holds fixture credentials. This
  // is the one the redirect hid: an app can serve /login perfectly and 500 on
  // every screen behind it.
  if (authed?.email && authed?.password) {
    const creds = JSON.stringify({ email: String(authed.email), password: String(authed.password) });
    lines.push(
      'JAR=$(mktemp)',
      "trap 'rm -f \"$JAR\"' EXIT INT TERM",
      'umask 077',
      'CRED=$(mktemp)',
      "trap 'rm -f \"$JAR\" \"$CRED\"' EXIT INT TERM",
      `cat > "$CRED" <<'PP_READY_EOF'`,
      creds,
      'PP_READY_EOF',
      `C=$(curl -sS -o /dev/null -c "$JAR" -w '%{http_code}' --max-time 10 -X POST `
        + `-H 'Content-Type: application/json' --data-binary @"$CRED" "${base}/api/auth/login" 2>/dev/null)`,
      'echo "SIGNIN:${C:-000}"',
      `C=$(curl -sS -o /dev/null -b "$JAR" -w '%{http_code}' --max-time 8 "${base}/" 2>/dev/null)`,
      'echo "APP:${C:-000}"',
    );
  }
  lines.push('');
  return lines.join('\n');
}

// The two authenticated checks, described the same way as the rest.
export const AUTHED_CHECKS = Object.freeze([
  {
    key: 'SIGNIN',
    describe: 'the fixture account signs in',
    ok: (n) => n === 200 || n === 204,
    required: false,     // a project may legitimately have no auth component
    why: 'the platform fixture cannot sign in',
  },
  {
    key: 'APP',
    describe: 'a signed-in request gets the app, not the gate',
    // THE check the old probe could not make. 5xx here is a broken app that
    // looked perfectly healthy from outside the gate.
    ok: (n) => n === 200,
    required: true,
    why: 'the app 5xx or bounces a SIGNED-IN request — the screens behind the login do not work',
  },
]);

// Parse the labelled lines into a verdict. Never throws.
//
// Returns { ready, checks: [{key, code, ok, required, describe, why}], failures,
// summary }. A check the script did not reach is simply absent — a partial run
// reports what it managed, rather than claiming everything failed.
export function parseReadiness(stdout) {
  const text = String(stdout || '');
  const codes = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(CODE_RE);
    if (m) codes.set(m[1], Number(m[2]));
  }
  if (!codes.size) {
    return { ready: false, checks: [], failures: ['the readiness probe produced no output'], summary: 'the readiness probe produced no output' };
  }

  const all = [...READINESS_CHECKS, ...MASTERKEY_CHECKS, ...AUTHED_CHECKS];
  const checks = [];
  for (const c of all) {
    if (!codes.has(c.key)) continue;                 // not reached / not applicable
    const code = codes.get(c.key);
    // SIGNIN failing is not a fault when the app has no auth component at all
    // (LOGIN 404) — the fixture has nothing to sign into.
    const noAuth = codes.get('LOGIN') === 404;
    if (MASTERKEY_CHECKS.some((m) => m.key === c.key) && noAuth) continue;   // no auth component: nothing to encrypt
    const required = c.required && !(noAuth && (c.key === 'SIGNIN' || c.key === 'APP'));
    checks.push({ key: c.key, code, ok: c.ok(code), required, describe: c.describe, why: c.why });
  }

  const failures = checks.filter((c) => !c.ok && c.required).map((c) => `${c.describe} — ${c.why} (HTTP ${c.code})`);
  const soft = checks.filter((c) => !c.ok && !c.required).map((c) => `${c.describe} (HTTP ${c.code})`);
  return {
    ready: failures.length === 0,
    checks,
    failures,
    warnings: soft,
    summary: failures.length
      ? failures.join('; ')
      : `${checks.filter((c) => c.ok).length}/${checks.length} readiness checks passed${soft.length ? ` (${soft.length} warning(s): ${soft.join('; ')})` : ''}`,
  };
}

// One line per check for the cycle log — the "no silent skips" discipline.
export function readinessLogLines(result) {
  return (result?.checks || []).map(
    (c) => `readiness ${c.key} ${c.describe}: ${c.ok ? 'PASS' : (c.required ? 'FAIL' : 'WARN')} (HTTP ${c.code})`,
  );
}

// What the operator is told in chat when the app is not ready. Names the
// failing thing and what to do — a status code alone is not actionable.
export function readinessChatMessage(result, { redeployed = false } = {}) {
  if (!result || result.ready) return null;
  const lines = [
    redeployed
      ? '**The app is still not working after an automatic deploy.**'
      : '**The app deployed, but it is not working.**',
    '',
    ...result.failures.map((f) => `- ${f}`),
  ];
  if (result.warnings?.length) {
    lines.push('', 'Also worth knowing:', ...result.warnings.map((w) => `- ${w}`));
  }
  lines.push(
    '',
    'The deploy itself succeeded — this is the app answering wrongly, not a failed build step, '
    + 'so the build log will look clean. Open the app, or press Deploy to try again.',
  );
  return lines.join('\n');
}
