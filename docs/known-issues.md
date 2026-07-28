# Known issues

A grab-bag of operator-facing follow-ups uncovered during feature
work but parked because they fall outside the active session's
scope. Anyone picking up a future session should treat this file
as a punch list, not a roadmap — items here are meant to be
addressed individually, not bundled.

## Backend test runner: 6 test files fail under `node --test` in a
fresh sandbox

Discovered during the WireGuard MTU = 1280 session
(`docs/core/plan/NEXT-SESSION-PROMPT-wireguard-mtu.md`); count
re-verified 2026-07 (grew from 3 to 6 as tests were added).

Affected files (all `ERR_MODULE_NOT_FOUND` — packages absent from
the sandbox, never logic failures):

- `admin/backend/src/__tests__/cve-research.test.js` — imports real `db.js` → `better-sqlite3`
- `admin/backend/src/__tests__/cves.test.js` — imports real `db.js` → `better-sqlite3`
- `admin/backend/src/__tests__/incus.test.js` — imports real `db.js` → `better-sqlite3`
- `admin/backend/src/__tests__/webauthn.test.js` — imports real `db.js` → `better-sqlite3`
- `admin/backend/src/__tests__/vpn-mtu.test.js` — imports `cli/src/db/index.js` → `better-sqlite3`
- `admin/backend/src/__tests__/ldap.test.js` — imports `src/lib/ldap.js` → `ldapts`

Other backend tests stub the DB at the module boundary and pass
cleanly.

Pre-existing — these fail on `main` too. The rest of the suite
passes (943 pass / 954 as of 2026-07).

Possible fixes (pick one — they're not all equivalent):

1. Provide a dev-only stub for `better-sqlite3` that backs onto an
   in-memory pure-JS SQLite (`sql.js`) so the tests don't need the
   native module at all. Cleanest for CI; keeps prod path
   untouched.
2. Refactor the three failing tests to import their unit-under-test
   without dragging in `db.js` (e.g. inject a fake DB at
   construction). Most invasive but most "correct".
3. Make `node_modules` part of CI image setup (i.e. `npm ci` runs
   before `node --test`) so `better-sqlite3` is always present.
   Easiest if CI is the only place these run; doesn't help local
   sandbox runs.

Verifying the fix: in a fresh checkout, run

```
cd admin/backend
node --test 'src/__tests__/*.test.js'
```

and confirm `pass 76 / fail 0`.

## Smoke UI checks fail (rather than skip) on an app with no first administrator

**Half closed** (fix 1 below is done; fix 2 is not needed for the declared-user
half and is still open for the create-administrator-form half).

The smoke gate now seeds the fixture users a project's `ui-checks.json`
declares, immediately before it runs the checks
(`ensureScreenAccounts`, `smoke.js` → `driveBrowserConnector`), and the
operator can create the same set on demand from **App access → Screen
accounts**. Only the reserved `@fixture.invalid` domain is minted; a spec
naming a real address is skipped and reported, because that account is the
operator's and would consume their first-admin slot.

What remains: on an app with no first administrator, `/login` still shows the
create-administrator form and hides the sign-in form, so a baseline check
asserting a sign-in selector still times out rather than reporting "not yet
possible". Fix 2 below is the remedy for that half.

The original diagnosis follows.

Observed on project 46 build 129: 5 of 7 checks reported
`locator.waitFor: Timeout 5000ms exceeded`, including the platform's own
`platform-baseline-signin-legal`.

Not a build defect. The first administrator belongs to the operator and the
build is forbidden to create it, so a freshly built app is legitimately in
first-run state — and in that state:

- `/login` shows the create-administrator form and HIDES the sign-in form, so
  `expect_visible #login-password` (or any sign-in selector) times out;
- every check declaring `login: <someone>@fixture.invalid` fails, because the
  build writes those credentials into `state/ui-checks.json` and nothing
  creates the account. The platform seeds a fixture admin for the design
  REVIEW (`review-account.js`), never for the smoke.

So the checks are not failing — they are not yet possible, and the report
cannot tell those apart. An operator reads "5 of 7 failed" on a build that did
nothing wrong.

Two fixes, either of which closes it:

1. Have the smoke seed the fixture users a project's `ui-checks.json`
   declares, the way `ensureReviewAccount` already does for the review. Same
   reserved `@fixture.invalid` domain, same exclusion from "a real user
   exists", so it cannot consume the operator's bootstrap.
2. Detect first-run state (`GET /api/auth/bootstrap/status` →
   `canCreateSuperadmin: true`) and report "no first administrator yet — N
   session checks could not run" instead of N failures.

(1) is the better outcome — the checks actually run — and is the one to do
unless it turns out a project's declared users need roles the platform cannot
safely mint.

(1) is now done; see the note at the top of this section. A declared user's
ROLE is honoured where the project has one by that name, and anything that is
not clearly an admin role falls back to the LEAST privileged role in the table
rather than the first — a viewer fixture that quietly became an admin would
make every permission check pass and prove nothing.
