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

// WHY NOT `{role}@{project}.com`, WHICH IS WHAT WAS ASKED FOR.
//
// The auth component's guard is `email NOT LIKE '%@fixture.invalid'`, an exact
// suffix match, and it is the only thing standing between a platform test
// account and the operator's first-administrator slot. `admin@n8.com` does not
// match it, so it would count as a real user and consume that slot — which is
// precisely the failure that locked an operator out of their own app once
// already (LEARNINGS 93/94). `.com` is also a live TLD: `n8.com` belongs to
// somebody. `.invalid` is reserved by RFC 2606 and can never resolve.
//
// `admin@n8.fixture.invalid` reads closer to the request and fails the same
// way — it ends with `.fixture.invalid`, not `@fixture.invalid`. Making it work
// means widening the guard inside a versioned platform component, and every
// project still running the older component would treat those accounts as real
// users. That is the same regression, shipped again.
//
// So the ROLE and the PROJECT move into the local part, where they are just as
// readable and cost nothing: `admin-n8@fixture.invalid`,
// `viewer-n8@fixture.invalid`. Exact same reserved suffix, works on every
// project regardless of component version.
export function fixtureSlug(project) {
  const raw = String(project?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = raw.slice(0, 24).replace(/-+$/, '');
  // A project named "!!!" has no slug, and an address of `admin-@fixture...`
  // is both ugly and ambiguous between two such projects.
  return slug || `p${Number(project?.id) || 0}`;
}

// The canonical address for one role on one project.
export function fixtureEmail(role, project) {
  const r = String(role || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'user';
  return `${r}-${fixtureSlug(project)}${FIXTURE_EMAIL_DOMAIN}`;
}

export const REVIEW_ROLE_KEY = 'admin';
export const VIEWER_ROLE_KEY = 'viewer';
export const reviewEmailFor = (project) => fixtureEmail(REVIEW_ROLE_KEY, project);
export const viewerEmailFor = (project) => fixtureEmail(VIEWER_ROLE_KEY, project);

// The pre-project-scoped addresses. Still referenced because projects created
// before the rename carry them in `review_login_email`, and because the
// free-slot cleanup and every test want a name for "the old shape".
export const REVIEW_EMAIL = `design-review${FIXTURE_EMAIL_DOMAIN}`;
// The SECOND fixture: a deliberately UNPRIVILEGED account.
//
// With one admin fixture, "can a viewer reach the admin screens?" is
// structurally uncheckable — there is no viewer to ask. That question is the
// most common real defect in a generated app (a route guarded in the UI and not
// on the server), and every build so far shipped without it ever being asked.
// Same reserved domain, so it is equally invisible to the first-admin bootstrap.
export const REVIEW_VIEWER_EMAIL = `design-review-viewer${FIXTURE_EMAIL_DOMAIN}`;

// What role each fixture wants, most preferred first. The seeder picks the
// first one this project's roles table actually has — a build is free to name
// its roles whatever it likes, and a fixture pinned to a role that does not
// exist is a row that can never sign in anywhere useful.
export const REVIEW_ROLE_PREFERENCE = Object.freeze(['admin', 'administrator', 'owner']);
export const VIEWER_ROLE_PREFERENCE = Object.freeze(['viewer', 'external', 'readonly', 'read_only', 'user']);

// The component's Zod schema requires >= 12 characters (public/login.html says
// minlength=12). 32 base64url chars clears that and is not worth guessing.
export function generateReviewPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

// seedFixtureUserScript — create the reviewer DIRECTLY in the app's database.
//
// WHY NOT THE BOOTSTRAP ENDPOINT (which is what the first version used):
// POST /api/auth/bootstrap/superadmin is guarded by "no real user exists yet".
// Once the OPERATOR has created their own administrator — which is the first
// thing anyone does — that guard is closed forever, so the reviewer could never
// be created on any project a human had actually signed into. Project 40's
// review shot the sign-in page four times and its smoke checks all ran
// `[anonymous /]` and timed out at the auth gate, for exactly this reason.
//
// The platform has root in the container, so it seeds the row itself. The
// account lives on the reserved @fixture.invalid domain, which the auth
// component already excludes from "a real user exists" — so it does NOT count
// as the super-admin and the operator's first-admin flow keeps working exactly
// as before. Role `admin` so the reviewer can reach the admin screens too.
//
// Idempotent: an existing fixture row has its password reset to the one we
// hold, which also repairs a project whose stored credentials were lost.
// The seeder program itself, written to a file by the script above.
//
// Plain ESM, pg only — the same driver scripts/migrate.mjs uses, so it needs no
// build step and no extra dependency.
const SEED_NODE_SRC = [
  'import fs from "node:fs";',
  'import crypto from "node:crypto";',
  'import pg from "pg";',
  '',
  'const accounts = JSON.parse(fs.readFileSync(process.env.CRED, "utf8"));',
  '',
  '// Exactly the format src/auth/crypto.ts verifies:',
  '//   scrypt$N$r$p$saltB64$hashB64',
  '// Any drift here produces a row that exists and can never sign in.',
  'const N = 16384, R = 8, P = 1, KEYLEN = 32;',
  'function hashFor(password) {',
  '  const salt = crypto.randomBytes(16);',
  '  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });',
  '  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");',
  '}',
  '',
  'const url = process.env.DATABASE_URL || "postgres://app:app@127.0.0.1:5432/app";',
  'const client = new pg.Client({ connectionString: url });',
  '// connect() INSIDE the try: a database that is not up threw here, outside',
  '// any handler, and the process died with a stack trace instead of the one',
  '// labelled line the parser reads — so the caller was told "the seeder',
  '// produced no result" when the real answer was "the database is down".',
  'try {',
  '  await client.connect();',
  '  // Use whatever roles this project actually seeded. Each fixture names the',
  '  // roles it would like, most preferred first; anything else would pin the',
  '  // fixtures to role names a build never has to use. The reviewer stays a',
  '  // FIXTURE account either way: the @fixture.invalid domain is excluded from',
  '  // "a real user exists", so the operator first-admin flow is untouched.',
  '  const roles = await client.query("SELECT key FROM roles");',
  '  const keys = roles.rows.map((r) => r.key);',
  '  let primary = null;',
  '  for (const a of accounts) {',
  '    // The LEAST privileged fallback, not the first role in the table: a',
  '    // viewer fixture that silently became an admin would make every',
  '    // permission check pass and prove nothing.',
  '    const role = a.prefer.find((p) => keys.includes(p))',
  '      || (a.fallback === "least" ? keys[keys.length - 1] : keys[0])',
  '      || a.prefer[0];',
  '    const stored = hashFor(a.password);',
  '    const existing = await client.query("SELECT id FROM users WHERE lower(email) = lower($1)", [a.email]);',
  '    if (existing.rowCount) {',
  '      await client.query(',
  '        "UPDATE users SET password_hash = $2, password_setup_required = false, is_active = true, role = $3 WHERE id = $1",',
  '        [existing.rows[0].id, stored, role]);',
  '    } else {',
  '      await client.query(',
  '        "INSERT INTO users (email, password_hash, password_setup_required, role, is_active) VALUES ($1, $2, false, $3, true)",',
  '        [a.email.toLowerCase(), stored, role]);',
  '    }',
  '    console.log("SEED:acct:" + a.key + ":" + role);',
  '    if (!primary) primary = role;',
  '  }',
  '  console.log("SEED:ok:" + primary);',
  '} catch (e) {',
  '  console.log("SEED:error:" + String(e && e.message).slice(0, 200));',
  '} finally {',
  '  await client.end().catch(() => {});',
  '}',
].join('\n');

// accounts: [{ key, email, password, prefer, fallback }] — or the legacy single
// { email, password } pair, which still means "the admin reviewer".
export function seedFixtureUserScript({ email, password, accounts = null, appDir = '/srv/app' } = {}) {
  const list = accounts?.length ? accounts : [{
    key: 'reviewer', email, password, prefer: REVIEW_ROLE_PREFERENCE, fallback: 'first',
  }];
  const payload = JSON.stringify(list.map((a) => ({
    key: String(a.key || 'reviewer'),
    email: String(a.email),
    password: String(a.password),
    prefer: [...(a.prefer || REVIEW_ROLE_PREFERENCE)],
    fallback: a.fallback === 'least' ? 'least' : 'first',
  })));
  return [
    'set -u',
    `cd '${appDir}' 2>/dev/null || exit 0`,
    // No auth component → no users table → nothing to seed. Not an error.
    '[ -f src/auth/schema.ts ] || { echo "SEED:no-auth"; exit 0; }',
    '[ -d node_modules/pg ] || { echo "SEED:no-pg"; exit 0; }',
    // The scratch dir lives INSIDE the app, not in /tmp: the seeder imports
    // `pg`, and Node resolves node_modules by walking up from the FILE — from
    // /tmp it finds nothing and dies with a module-not-found that `tail -3`
    // then hides. (Found by running it against a real database.)
    'WORK=$(mktemp -d "$PWD/.pp-seed-XXXXXX")',
    `trap 'rm -rf "$WORK"' EXIT INT TERM`,
    'umask 077',
    // Credentials to a 0600 FILE, never onto a command line: `ps` inside the
    // container is readable by the app, and the build model runs code there.
    `cat > "$WORK/cred.json" <<'PP_SEED_EOF'`,
    payload,
    'PP_SEED_EOF',
    // The seeder to a FILE too, rather than `node -e "..."`. A quoted program
    // on the command line has to survive JS template literal → base64 → sh →
    // node, and every one of those layers has eaten a character at least once
    // in this codebase. A heredoc has nothing to escape.
    `cat > "$WORK/seed.mjs" <<'PP_SEED_JS_EOF'`,
    SEED_NODE_SRC,
    'PP_SEED_JS_EOF',
    // Keep stderr: a swallowed diagnostic is how the first version of this
    // reported nothing at all when it could not import its driver.
    'CRED="$WORK/cred.json" node "$WORK/seed.mjs" 2>&1 | tail -8',
    '',
  ].join('\n');
}

// screenAccountsFromSpec(spec) — the accounts a project's OWN ui-checks declare.
//
// THE DEFECT THIS CLOSES. A build writes `state/ui-checks.json` with a login
// block naming, say, `admin@fixture.invalid` and a password it invented. The
// platform seeds its own review fixtures and nothing else, so those declared
// accounts have never existed. Every check that says `login: <that user>` then
// signs in against a form that rejects it, times out on the first element
// behind the gate, and is reported as a FAILURE of the build.
//
// Project 44 build 133: three checks, three timeouts, request left open, on a
// build that had deployed and done its job. Project 46 build 129: five of seven,
// at $9.65. In both, the platform's own baseline checks passed in the same run —
// which is the tell, because those use accounts the platform creates.
//
// WHAT IS TAKEN FROM THE SPEC, AND WHAT IS NOT.
//
// The ROLES are the spec's — they are the thing the build actually decided
// ("these checks run as an admin, those as a viewer"), and honouring them is
// the whole point. The IDENTITY is the platform's: the address is canonical for
// the role and project, and the password is the project's own generated secret.
//
// Both substitutions fix a real defect rather than a preference:
//
//   - the model invents the password, and it invents it badly. A live project
//     was seeded with `n8-admin-password-123` because that is what the build
//     wrote into its spec. The platform holds a 32-character secret per project
//     already; there is no reason for a weaker one to exist.
//   - the model invents the address, so a spec naming a REAL address used to be
//     skipped, and every check that declared it silently stopped running.
//     Substituting is strictly better than skipping: the check runs, and no
//     account on a real domain is ever created — which is the property that
//     matters, since such an account would count as "a real user exists" and
//     take the operator's first-admin slot.
//
// `withScreenLogins` below puts the substituted credentials back into the spec
// the checks actually execute, so nothing has to be rewritten on disk.
//
// `fallback: 'least'` for anything that is not clearly an admin role: a viewer
// fixture that quietly became an admin makes every permission check pass and
// proves nothing.
export function screenAccountsFromSpec(spec, { project = null, password = '' } = {}) {
  const users = spec?.login?.users;
  if (!users || typeof users !== 'object') return { accounts: [], renamed: [] };
  const accounts = [];
  const renamed = [];
  for (const [role, u] of Object.entries(users)) {
    const declared = String(u?.username || u?.email || '').trim();
    const email = fixtureEmail(role, project);
    if (declared && declared.toLowerCase() !== email.toLowerCase()) renamed.push({ role, from: declared, to: email });
    const isAdminRole = REVIEW_ROLE_PREFERENCE.includes(String(role).toLowerCase());
    accounts.push({
      key: `spec-${String(role).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'user'}`,
      role: String(role),
      email,
      password: String(password || ''),
      prefer: isAdminRole ? [...REVIEW_ROLE_PREFERENCE] : [String(role).toLowerCase(), ...VIEWER_ROLE_PREFERENCE],
      fallback: isAdminRole ? 'first' : 'least',
    });
  }
  return { accounts, renamed };
}

// Put the credentials that actually EXIST into the spec the checks run.
//
// Without this the substitution above would be worse than useless: the platform
// would create `admin-n8@fixture.invalid` and the checks would go on signing in
// as whatever the model invented. Nothing is written to disk — `ui-checks.json`
// keeps what the build wrote, and the diff stays clean.
export function withScreenLogins(spec, accounts = []) {
  if (!spec?.login?.users || !accounts.length) return spec;
  const byRole = new Map(accounts.filter((a) => a.role).map((a) => [String(a.role), a]));
  if (!byRole.size) return spec;
  const users = {};
  for (const [role, u] of Object.entries(spec.login.users)) {
    const a = byRole.get(String(role));
    users[role] = a ? { ...u, username: a.email, password: a.password } : u;
  }
  return { ...spec, login: { ...spec.login, users } };
}

// The line the smoke logs so an operator can see what was minted rather than
// wondering why a check that failed yesterday passes today.
export function screenAccountsNote({ accounts = [], renamed = [], seeded = null } = {}) {
  const parts = [];
  if (accounts.length) {
    // Three outcomes, said differently on purpose: "ready" means the checks can
    // sign in, "no auth component" means nothing in this app can, and a failure
    // needs its reason attached or the next person re-derives it.
    const state = seeded?.state === 'no-auth'
      ? 'not created — this app has no auth component'
      : seeded?.ok
        ? 'ready'
        : `could not be created (${seeded?.reason || 'unknown reason'})`;
    parts.push(`screen accounts: ${accounts.length} declared fixture user(s) ${state} (${accounts.map((a) => a.email).join(', ')})`);
  }
  if (renamed.length) {
    // Said out loud, because a check that declares one address and signs in as
    // another is otherwise the most confusing thing in the log.
    parts.push(`the spec's own credentials were replaced with the platform's (${renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}) — the address is canonical per role and the password is generated, never the one written into the spec`);
  }
  if (!parts.length) return '';
  return parts.join('; ');
}

// The pair every project gets: an admin reviewer that can reach the admin
// screens, and a viewer that must NOT be able to.
export function reviewFixtureAccounts({ email, password, viewerEmail, viewerPassword }) {
  return [
    { key: 'reviewer', email, password, prefer: REVIEW_ROLE_PREFERENCE, fallback: 'first' },
    // fallback 'least': a viewer fixture that quietly became an admin because
    // this project has no role called "viewer" would make every permission
    // check pass and prove nothing at all.
    { key: 'viewer', email: viewerEmail, password: viewerPassword, prefer: VIEWER_ROLE_PREFERENCE, fallback: 'least' },
  ];
}

// Parse the seeder's labelled lines.
export function parseSeedResult(stdout) {
  const text = String(stdout || '');
  // One line per account seeded, so a partial run still reports what landed.
  const accounts = {};
  for (const m of text.matchAll(/SEED:acct:([a-z0-9_-]+):([^\s]+)/gi)) accounts[m[1]] = m[2];
  const m = text.match(/SEED:(ok|no-auth|no-pg|error)(?::(.*))?/);
  if (!m) return { ok: false, state: 'failed', reason: 'the seeder produced no result', accounts };
  const [, state, extra] = m;
  if (state === 'ok') {
    return { ok: true, state: 'seeded', role: (extra || '').trim() || 'admin', accounts };
  }
  if (state === 'no-auth') return { ok: true, state: 'no-auth', reason: 'this app has no auth component', accounts };
  if (state === 'no-pg') return { ok: false, state: 'failed', reason: 'the app has no pg driver installed yet', accounts };
  // A run that died partway still reports the accounts that DID land — "some of
  // it worked" is the state a retry needs to know about.
  if (state === 'error') return { ok: false, state: 'failed', reason: (extra || '').trim(), accounts };
  return { ok: false, state: 'failed', reason: `the seeder reported "${state}"`, accounts };
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
