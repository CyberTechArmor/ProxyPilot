// Mock2 APP ACCESS — the operator's own way into the app they just had built.
// PURE decision layer (native-free, unit-tested; risk R9).
//
// WHY THIS EXISTS.
//
// The first administrator account belongs to the operator, and the build is
// forbidden to create it — correctly: a build that minted a real-domain admin
// and handed back a password would be both a security hole and a lie about who
// owns the app. Project 44's build refused twice, at $1.94, and was right to.
//
// But the operator's only way to USE that rule was to watch the sign-in page
// during the build and race to it: "there is limited time from seeing the
// create super admin first user, then when the app finishes I'm unable to log
// in". A rule that can only be satisfied inside a window nobody controls is a
// rule that pushes people to ask the build to break it.
//
// So the platform offers the door itself, on the operator's schedule: read what
// accounts the app actually has, and create the first administrator with an
// email and a password THE OPERATOR TYPES, whenever they choose — after the
// build has finished.
//
// TWO PROPERTIES THIS MODULE EXISTS TO KEEP:
//
//   1. The password is the operator's and only ever passes through. The
//      platform does not generate it, does not store it, and never echoes it
//      back. (Contrast review-account.js, which mints and stores a password —
//      that account is the platform's own fixture, and it lives on the reserved
//      @fixture.invalid domain precisely so it is never confused with this one.)
//
//   2. The account is created through the APP'S OWN bootstrap endpoint, not by
//      writing a row. That keeps the app's race-safe guard, its password
//      hashing and its audit entry (auth.bootstrap.superadmin.created, with the
//      timestamp and actor) as the single path — the same one the sign-in
//      screen uses. The platform gets no privileged shortcut it would then have
//      to be trusted with.
//
// Terminology (risk R7): nothing here is named "agent".

// The auth component reserves this domain for the platform's own test fixtures
// and excludes it from "a real user exists", which is what keeps the operator's
// bootstrap open while the smoke checks have accounts to sign in as.
export const FIXTURE_EMAIL_DOMAIN = '@fixture.invalid';

export const MIN_PASSWORD_LENGTH = 12;

export function isFixtureEmail(email) {
  return String(email || '').trim().toLowerCase().endsWith(FIXTURE_EMAIL_DOMAIN);
}

// validateFirstAdmin — what the operator may ask for.
//
// The email must be REAL. Accepting an @fixture.invalid address here would
// create an account the auth component does not count as a user, so the door
// would still read as open and the operator would have made a ghost.
export function validateFirstAdmin({ email = '', password = '' } = {}) {
  const addr = String(email || '').trim();
  if (!addr) return { ok: false, error: 'An email address is required.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return { ok: false, error: 'That does not look like an email address.' };
  if (addr.length > 254) return { ok: false, error: 'That email address is too long.' };
  if (isFixtureEmail(addr)) {
    return {
      ok: false,
      error: `${FIXTURE_EMAIL_DOMAIN} is reserved for the platform's own test accounts — use your real address, `
        + 'or the app will still have no administrator.',
    };
  }
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `The password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (pw.length > 200) return { ok: false, error: 'That password is too long.' };
  return { ok: true, email: addr.toLowerCase(), password: pw };
}

/* -------------------------------------------------------------------------- *
 * Reading the app's account state.
 *
 * Two questions, two sources, on purpose:
 *   - "is the door open?" comes from the APP (/api/auth/bootstrap/status), so
 *     the answer is the same one the sign-in screen acts on. Asking the
 *     database directly would let the panel disagree with the screen.
 *   - "who exists?" comes from the database, because there is no anonymous API
 *     that lists users and there should not be one.
 * -------------------------------------------------------------------------- */

export function accessStateScript({ port = 3000 } = {}) {
  const base = `http://127.0.0.1:${Number(port) || 3000}`;
  return [
    'set -u',
    // The app's own answer, body and all — the sign-in screen reads exactly this.
    `C=$(curl -sS -o /tmp/pp-bootstrap.json -w '%{http_code}' --max-time 8 "${base}/api/auth/bootstrap/status" 2>/dev/null)`,
    'echo "STATUS:${C:-000}"',
    'echo "BODY:$(head -c 400 /tmp/pp-bootstrap.json 2>/dev/null | tr -d "\\n")"',
    'rm -f /tmp/pp-bootstrap.json',
    // The roster. psql as the postgres superuser: the platform has root in the
    // container, and the app's own role may not be able to read pg_catalog.
    // Unaligned, pipe-separated, no header — parsed line by line below.
    'ROWS=$(su - postgres -c "psql -tAF\'|\' -d app -c \\"SELECT lower(email), role, is_active, provider FROM users ORDER BY id\\"" 2>/dev/null)',
    'RC=$?',
    'if [ -n "$ROWS" ]; then printf \'%s\\n\' "$ROWS" | while IFS= read -r r; do [ -n "$r" ] && echo "USER:$r"; done; fi',
    // ROSTER:ok ONLY when psql actually answered. The first version echoed a
    // single unconditional marker, so a container with no psql — or a database
    // that was down — read as "queried successfully, zero users", and the panel
    // would have told an operator the door was open on an app it could not see
    // into. "We could not look" and "there is nobody" are different answers.
    'if [ "$RC" -eq 0 ]; then echo "ROSTER:ok"; else echo "ROSTER:unavailable"; fi',
    '',
  ].join('\n');
}

// parseAccessState — the panel's whole model of "who can get into this app".
//
// Deliberately tolerant: a container without psql, a database that is down, an
// app without the auth component — each yields a partial answer that says so,
// never a confident wrong one. `rosterKnown` is the flag that separates "there
// are no accounts" from "we could not look".
export function parseAccessState(out) {
  const text = String(out || '');
  const status = Number((text.match(/STATUS:(\d+)/) || [])[1] || 0);
  const bodyRaw = (text.match(/BODY:(.*)/) || [])[1] || '';
  let body = null;
  try { body = JSON.parse(bodyRaw); } catch { body = null; }

  const accounts = [];
  for (const m of text.matchAll(/^USER:(.*)$/gm)) {
    const [email, role, active, provider] = String(m[1]).split('|');
    if (!email) continue;
    accounts.push({
      email: email.trim(),
      role: (role || '').trim() || 'unknown',
      active: String(active || '').trim() === 't',
      provider: (provider || '').trim() || 'unknown',
      fixture: isFixtureEmail(email),
    });
  }
  const rosterKnown = /ROSTER:ok/.test(text);
  const real = accounts.filter((a) => !a.fixture);

  // The app's answer wins when we have one. Falling back to the roster keeps
  // the panel useful on an app whose auth API is unreachable — which is itself
  // worth showing rather than hiding behind a spinner.
  const canCreate = status === 200 && body && typeof body.canCreateSuperadmin === 'boolean'
    ? body.canCreateSuperadmin
    : (rosterKnown ? real.length === 0 : null);

  return {
    canCreateSuperadmin: canCreate,
    // What the PANEL acts on. "The door is open" and "we can reach the door"
    // are different facts, and only their conjunction should put a form in
    // front of an operator: offering Create on a shadowed app produces a 401
    // they cannot act on and reads as the platform being broken.
    canAttempt: canCreate === true && status === 200,
    statusCode: status,
    // 401/403 here is the shape that hid this for a whole build: the sign-in
    // page renders, this endpoint is shadowed, and the screen silently decides
    // a user already exists. Name it rather than report "closed".
    unreachable: status === 401 || status === 403 || status === 0,
    rosterKnown,
    accounts,
    realCount: real.length,
    fixtureCount: accounts.length - real.length,
    // The app says closed, and the roster we can see holds nothing but the
    // platform's own fixtures. Only assertable when the roster was actually
    // READ — "we could not look" must never be reported as this.
    fixtureFilled: canCreate === false && rosterKnown && accounts.length > 0 && real.length === 0,
  };
}

// accessSummary — one sentence, for the panel and the chat.
export function accessSummary(state) {
  if (!state) return 'The app has not been checked yet.';
  if (state.unreachable) {
    return state.statusCode === 401 || state.statusCode === 403
      ? 'The app is not answering the first-administrator check (HTTP '
        + `${state.statusCode}) — something is mounted above the platform's auth routes, so the sign-in screen cannot offer the create-account form.`
      : 'The app is not answering the first-administrator check, so it cannot be set up yet.';
  }
  if (state.canCreateSuperadmin === true) {
    const fixtures = state.fixtureCount
      ? ` (${state.fixtureCount} platform test account${state.fixtureCount === 1 ? '' : 's'} exist, and they do not count)`
      : '';
    return `This app has no administrator yet — create yours whenever you are ready${fixtures}.`;
  }
  if (state.canCreateSuperadmin === false) {
    const names = state.accounts.filter((a) => !a.fixture).map((a) => a.email);
    if (names.length) {
      return `An administrator already exists: ${names.slice(0, 3).join(', ')}`
        + `${names.length > 3 ? `, +${names.length - 3} more` : ''}. Sign in with that account.`;
    }
    // THE CONTRADICTION. The app says the door is closed and the roster shows
    // nobody but the platform's own fixtures. That is not "an account exists" —
    // it is this app running an auth component from before usersExist() learned
    // to exclude @fixture.invalid, so the review account the platform seeds
    // before its smoke checks consumed the operator's first-admin slot,
    // mid-build. Saying "an account already exists" here repeats the platform's
    // own bug back at the person it happened to.
    if (state.fixtureFilled) {
      return 'The app says its first-administrator form is closed, but the only account is the platform\'s own '
        + `test fixture (${state.accounts.map((a) => a.email).join(', ')}). This app is running an auth component `
        + 'from before that fixture stopped counting as a real user, so the platform\'s own check took your slot. '
        + 'Free the slot below and create your account — nothing else is lost.';
    }
    return 'An account already exists, so the first-administrator form is closed.';
  }
  return 'The app\'s account state could not be read.';
}

/* -------------------------------------------------------------------------- *
 * Creating it — through the app's own endpoint.
 * -------------------------------------------------------------------------- */

// The credentials go into the container through a FILE, not the command line:
// an argument is visible in the container's process list to anything that can
// read /proc, and the whole point of this path is that the operator's password
// is theirs. Written with umask 077, deleted on every exit path.
export function firstAdminScript({ port = 3000, email, password } = {}) {
  const base = `http://127.0.0.1:${Number(port) || 3000}`;
  const payload = JSON.stringify({ email: String(email), password: String(password) });
  return [
    'set -u',
    'umask 077',
    'CRED=$(mktemp)',
    "trap 'rm -f \"$CRED\"' EXIT INT TERM",
    "cat > \"$CRED\" <<'PP_FIRST_ADMIN_EOF'",
    payload,
    'PP_FIRST_ADMIN_EOF',
    `C=$(curl -sS -o /tmp/pp-first-admin.out -w '%{http_code}' --max-time 15 -X POST `
      + `-H 'Content-Type: application/json' --data-binary @"$CRED" "${base}/api/auth/bootstrap/superadmin" 2>/dev/null)`,
    'echo "CREATE:${C:-000}"',
    // The body carries the app's own refusal message when it refuses. Echoing
    // it beats inventing one: only the app knows why.
    'echo "DETAIL:$(head -c 300 /tmp/pp-first-admin.out 2>/dev/null | tr -d "\\n")"',
    'rm -f /tmp/pp-first-admin.out',
    '',
  ].join('\n');
}

export function parseFirstAdminResult(out) {
  const text = String(out || '');
  const status = Number((text.match(/CREATE:(\d+)/) || [])[1] || 0);
  const detailRaw = (text.match(/DETAIL:(.*)/) || [])[1] || '';
  let body = null;
  try { body = JSON.parse(detailRaw); } catch { body = null; }
  const appMessage = (body && (body.message || body.error)) || '';

  if (status >= 200 && status < 300) return { ok: true, status, error: null };
  if (status === 409) {
    return {
      ok: false,
      status,
      error: 'The app already has an account, so the first-administrator door is closed. '
        + 'Sign in with the existing account, or restore an earlier checkpoint if it was created by mistake.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status,
      error: 'The app refused the request before it reached the bootstrap endpoint (HTTP '
        + `${status}). Something is mounted above the platform's auth routes in src/app.ts — the signin-reachable gate names the line.`,
    };
  }
  if (status === 0) return { ok: false, status, error: 'The app did not answer. It may still be starting, or the deploy may have failed.' };
  return { ok: false, status, error: appMessage || `The app refused with HTTP ${status}.` };
}

/* -------------------------------------------------------------------------- *
 * Freeing the slot the platform's own fixture took.
 *
 * ONLY the reserved @fixture.invalid domain, and only ever those rows. The
 * accounts were put there by the platform (review-account.js) for its smoke
 * checks; on an app whose auth component predates the exclusion they also
 * consume the operator's first-admin bootstrap. Removing them is undoing the
 * platform's own side effect, not touching the operator's data — and the next
 * build simply re-seeds what it needs.
 * -------------------------------------------------------------------------- */

export function freeFirstAdminSlotScript() {
  // The SQL goes in through a FILE, not a nested -c argument.
  //
  // `su - postgres -c 'psql -c "… LIKE \'%@fixture.invalid\' …"'` looks fine and
  // parses as shell, but the SQL's own quotes terminate the outer ones: psql
  // receives `LIKE %@fixture.invalid` with the literal unquoted, and errors.
  // `sh -n` cannot see that. A file has one level of quoting and none of the
  // ambiguity.
  //
  // Domain-scoped in the WHERE clause itself — there is no row list to widen,
  // so this can never delete anything but the reserved fixture domain.
  return [
    'set -u',
    'SQLF=$(mktemp)',
    "trap 'rm -f \"$SQLF\"' EXIT INT TERM",
    "cat > \"$SQLF\" <<'PP_FREE_SLOT_EOF'",
    "DELETE FROM users WHERE lower(email) LIKE '%@fixture.invalid' RETURNING lower(email);",
    'PP_FREE_SLOT_EOF',
    'chmod 0644 "$SQLF"',
    'DELETED=$(su - postgres -c "psql -tA -d app -f $SQLF" 2>/dev/null)',
    'RC=$?',
    'if [ "$RC" -ne 0 ]; then echo "FREED:error"; exit 0; fi',
    "if [ -n \"$DELETED\" ]; then printf '%s\\n' \"$DELETED\" | while IFS= read -r r; do case \"$r\" in *@fixture.invalid) echo \"REMOVED:$r\";; esac; done; fi",
    'echo "FREED:ok"',
    '',
  ].join('\n');
}

export function parseFreeSlotResult(out) {
  const text = String(out || '');
  if (!/FREED:ok/.test(text)) {
    return { ok: false, removed: [], error: 'The app\'s database could not be reached, so nothing was changed.' };
  }
  const removed = [...text.matchAll(/^REMOVED:(.*)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  return { ok: true, removed, error: null };
}

// The chat invitation, posted once the app is live and still has no account.
// It exists because the operator's complaint was one of TIMING: the door was
// only ever announced by the sign-in page, mid-build, and they had to notice it.
export function firstAdminInviteMessage({ project = null, state = null } = {}) {
  // canAttempt, not canCreateSuperadmin: the door must be open AND reachable.
  // On a shadowed app the roster fallback says "no real users" and the door
  // reads open, but the endpoint answers 401 — inviting an operator to use it
  // would send them to a form that cannot work. That failure has its own
  // message, from the readiness probe.
  if (!state || state.canAttempt !== true) return null;
  const name = project?.name ? `**${project.name}** is live` : 'The app is live';
  return `${name} and has no administrator yet.\n\n`
    + 'The first account is yours to create — the build is not allowed to make it for you, and it is not '
    + 'created on a timer. Open **App access** on this project, or the app\'s own sign-in page, and create it '
    + 'with your email and a password you choose. Nothing expires: it will still be waiting after the next build.';
}
