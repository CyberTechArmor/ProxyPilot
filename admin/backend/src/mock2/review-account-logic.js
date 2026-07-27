// Mock2 REVIEW ACCOUNT — the pure half.
//
// WHY THIS EXISTS (operator report: "it seems like the ai can never see past
// the login screen"): every design review's screenshots were of the sign-in
// page. The capture logged in with the FIXTURE users listed in the project's
// own `state/ui-checks.json` — a file the build MODEL writes. When the model
// hadn't written a login block yet (an MVP build, an early cycle, a model that
// simply skipped it), there were no credentials, so the review shot the gate
// and then critiqued the gate. The critique was honest and useless: it could
// never compare the built app against the approved mockup, because it had
// never seen a single screen of the built app.
//
// The fix is to stop asking the model for something the PLATFORM can guarantee.
// The auth component already reserves the `@fixture.invalid` domain for exactly
// this: `usersExist()` and `createFirstAdmin()` both exclude that domain, so a
// platform-created fixture admin does NOT consume the operator's real
// first-admin bootstrap — the create-administrator screen still appears for the
// human on their first visit. That is the seam this module drives.
//
// Split from review-account.js so the script/parse/credential logic is unit
// testable without a container.

import crypto from 'node:crypto';

// The reserved domain the auth component excludes from "a real user exists".
// Changing it silently would let the review account consume the operator's
// bootstrap, so it is a named constant on both sides.
export const FIXTURE_EMAIL_DOMAIN = '@fixture.invalid';
export const REVIEW_EMAIL = `design-review${FIXTURE_EMAIL_DOMAIN}`;

// The component's Zod schema requires >= 12 characters (public/login.html says
// minlength=12). 32 base64url chars clears that and is not worth guessing.
export function generateReviewPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

// The in-container script. Runs three steps and prints one labelled line each,
// so a partial run still parses:
//
//   STATUS: does this app even have the auth component mounted?
//   LOGIN:  can the review account already sign in? (idempotent happy path)
//   CREATE: if not, create it via the bootstrap endpoint.
//
// Credentials go into a 0600 file, never onto the command line: `ps` inside the
// container is readable by the app's own processes, and the build model runs
// arbitrary code in there. The file is removed on every exit path.
export function reviewAccountScript({ email, password, port }) {
  const creds = JSON.stringify({ email: String(email), password: String(password) });
  const base = `http://127.0.0.1:${Number(port)}`;
  return [
    'set -u',
    'CRED=$(mktemp)',
    'trap \'rm -f "$CRED"\' EXIT INT TERM',
    'umask 077',
    `cat > "$CRED" <<'PP_CREDS_EOF'`,
    creds,
    'PP_CREDS_EOF',
    // Step 1 — is the auth component there at all? A 404 means this app has no
    // accounts, and there is nothing to sign in to.
    `ST=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "${base}/api/auth/bootstrap/status" 2>/dev/null)`,
    'echo "STATUS:${ST:-000}"',
    'if [ "${ST:-000}" = "404" ] || [ "${ST:-000}" = "000" ]; then exit 0; fi',
    // Step 2 — already provisioned? Re-running a build must not thrash the row.
    `LG=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST `
      + `-H 'Content-Type: application/json' --data-binary @"$CRED" "${base}/api/auth/login" 2>/dev/null)`,
    'echo "LOGIN:${LG:-000}"',
    'if [ "${LG:-000}" = "200" ] || [ "${LG:-000}" = "204" ]; then exit 0; fi',
    // Step 3 — create it. 201 is success; 409/403 means a real user already
    // owns the bootstrap, which is a legitimate terminal state, not an error.
    `CR=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST `
      + `-H 'Content-Type: application/json' --data-binary @"$CRED" "${base}/api/auth/bootstrap/superadmin" 2>/dev/null)`,
    'echo "CREATE:${CR:-000}"',
    '',
  ].join('\n');
}

// Parse the labelled lines above into a decision. Never throws.
//
// Returns { ok, state, code, reason } where state is one of:
//   'no-auth'      — the app has no auth component (nothing to log into)
//   'existing'     — the review account signed in; credentials are good
//   'created'      — the review account was just created
//   'taken'        — a REAL first admin already exists; we cannot self-provision
//   'failed'       — something answered, but not usefully
export function parseReviewAccountResult(stdout) {
  const text = String(stdout || '');
  const pick = (label) => {
    const m = text.match(new RegExp(`${label}:(\\d{3})`));
    return m ? Number(m[1]) : null;
  };
  const status = pick('STATUS');
  const login = pick('LOGIN');
  const create = pick('CREATE');

  if (status === null || status === 0) {
    return { ok: false, state: 'failed', code: status, reason: 'the app did not answer' };
  }
  if (status === 404) {
    return { ok: true, state: 'no-auth', code: 404, reason: 'this app has no auth component' };
  }
  if (login === 200 || login === 204) {
    return { ok: true, state: 'existing', code: login, reason: 'the review account already signs in' };
  }
  if (create === 201 || create === 200) {
    return { ok: true, state: 'created', code: create, reason: 'the review account was created' };
  }
  if (create === 409 || create === 403) {
    return { ok: false, state: 'taken', code: create, reason: 'a real administrator already owns the first-admin bootstrap' };
  }
  if (create === null && login !== null) {
    return { ok: false, state: 'failed', code: login, reason: `sign-in returned ${login} and creation did not run` };
  }
  return { ok: false, state: 'failed', code: create ?? status, reason: `bootstrap returned ${create ?? status}` };
}

// Does the project row carry usable review credentials?
export function hasReviewLogin(row) {
  return !!(row && row.email && row.password);
}
