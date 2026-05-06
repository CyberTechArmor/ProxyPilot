# Known issues

A grab-bag of operator-facing follow-ups uncovered during feature
work but parked because they fall outside the active session's
scope. Anyone picking up a future session should treat this file
as a punch list, not a roadmap — items here are meant to be
addressed individually, not bundled.

## Backend test runner: 3 tests fail under `node --test` in a fresh
sandbox

Discovered during the WireGuard MTU = 1280 session
(`docs/core/plan/NEXT-SESSION-PROMPT-wireguard-mtu.md`).

Affected files:

- `admin/backend/src/__tests__/cves.test.js`
- `admin/backend/src/__tests__/incus.test.js`
- `admin/backend/src/__tests__/webauthn.test.js`

Symptom: `Cannot find package 'better-sqlite3' imported from
admin/backend/src/db.js`. The three test files import the real
`db.js`, which top-level-imports `better-sqlite3`. Other backend
tests stub the DB at the module boundary and pass cleanly.

Pre-existing — these fail on `main` too. The other 73 tests in the
suite pass.

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
