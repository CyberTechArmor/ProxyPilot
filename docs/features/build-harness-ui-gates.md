# Build harness: rendered-DOM gates (the change-69 hardening)

A UI regression (an admin's ADP credential inputs rendered **disabled**) shipped
through five green gates because nothing in the battery exercised the rendered
DOM. This hardening adds that missing layer to the HARNESS — the gate battery,
the smoke connectors, the review pass, and the change-record contract — without
touching any app feature.

## What runs where

Gate scripts run **inside the project container** (no browser there); the smoke
step runs **orchestrator-side after deploy** (where Playwright can drive the
live app). The new layer is split accordingly:

| Piece | Where | When it triggers |
|---|---|---|
| `ui-interaction` gate (battery order 6) | container, every gate run | working-tree diff touches user-facing paths (`public/`, `*.html/css/scss/jsx/tsx`, `views/`, `templates/`) |
| Browser smoke connector | orchestrator, post-deploy | deployed commit's diff matches the browser globs (same path classes) |
| DB smoke connector | orchestrator → container, post-deploy | diff touches `migrations/`, `**/*.sql`, `**/schema/**`, `**/drizzle/**`, seed/bootstrap paths |
| Cross-layer lint (in `constitution-lint`) | container, every gate run | always (checks tracked + untracked `public/*.js`) |
| Acceptance criteria on `finish` | orchestrator, every cycle | always |

## 1–2. Smoke connectors: enabled, and never a silent skip

`SMOKE_BROWSER_ENABLED`, `SMOKE_DB_ENABLED`, and `SMOKE_REQUIRE_TRIGGERED` now
**default to true** (`smoke-triggers.js`). A connector still only *runs* on a
relevance hit — a backend-only diff invokes neither — but a diff that warrants a
connector which cannot run (playwright missing, no DSN) now **fails the cycle**
with the reason in the cycle log, instead of logging and passing. Operators can
opt out per install; `SMOKE_BROWSER_EXECUTABLE` points at a system Chromium.

The **browser connector** executes the project's `state/ui-checks.json`
interaction checks matched by the diff (below); with no matching checks it falls
back to the original render check, now also failing on console errors.

The **DB connector** was rebuilt: on a data-layer diff it (1) applies the **full
migration chain to a scratch database** created for the run (`smoke_mig_<pid>`,
dropped afterwards — the app's own DB is never written), and (2) **boots the
app against the migrated result** (declared `mock2.yaml` start command, throwaway
port, HTTP answer required). The from-zero chain apply is deliberate: by smoke
time the deploy already migrated the live DB, so "pending migrations apply" is
vacuous — a full-chain apply is what catches a broken or mis-ordered migration.

## 3. The `ui-interaction` gate + `state/ui-checks.json`

Projects declare interaction checks in `state/ui-checks.json` (committed and
hash-chained like all `state/` content):

```json
{
  "login": {
    "path": "/login", "user_field": "#username", "pass_field": "#password",
    "submit": "button[type=submit]",
    "users": {
      "admin":   { "username": "smoke-admin",   "password": "…" },
      "manager": { "username": "smoke-manager", "password": "…" },
      "viewer":  { "username": "smoke-viewer",  "password": "…" }
    }
  },
  "checks": [
    {
      "id": "adp-admin-credentials-editable",
      "paths": ["public/settings*", "src/routes/adp*"],
      "role": "admin",
      "page": "/settings/connections",
      "steps": [
        { "expect_enabled": "#adp-client-id" },
        { "fill": "#adp-client-id", "value": "smoke-client-id", "expect_value": true },
        { "click": "#adp-replace" },
        { "expect_enabled": "#adp-client-secret" },
        { "fill": "#adp-client-secret", "value": "smoke-secret", "expect_value": true },
        { "expect_enabled": "#adp-test-connection" },
        { "click": "#adp-test-connection" }
      ]
    },
    {
      "id": "viewer-read-only",
      "paths": ["public/settings*"],
      "role": "viewer",
      "page": "/settings/connections",
      "steps": [
        { "expect_visible": "#adp-status" },
        { "expect_disabled": "#adp-client-id" },
        { "expect_disabled": "#adp-test-connection" }
      ]
    }
  ]
}
```

Step vocabulary: `expect_enabled` / `expect_disabled` (also rejects
readonly/aria-disabled), `expect_visible`, `expect_text` (+`contains`), `fill`
(+`value`; asserts the typed value **persisted** unless `expect_value:false`),
`click`. Every check runs in a fresh browser context, logs in as its declared
role using **seeded test-fixture users**, and **fails on any console error**
(JS exceptions and failed resource loads; the favicon probe is the only
exemption).

Enforcement is two-sided:

- The **`ui-interaction` gate** (deterministic, in-container, `node`-evaluated)
  fails the cycle when the working-tree diff touches user-facing paths and any
  touched file has **no matching check** — or when the spec is missing or
  malformed. Backend-only diffs skip green.
- The **browser connector** then executes the matched checks against the
  deployed app; any assertion or console error fails the cycle.

Build-stage guidance (skills.json) now requires the runner to write/update these
checks for every touched screen and to seed fixture users for **every role**.

## 4. Cross-layer consistency

- `constitution-lint` now flags any **hard-coded role string literal in
  `public/*.js`** (role comparisons / `.includes('admin')` forms) — role names
  must come from the ONE shared constants module both server and browser import
  (the shared module itself, e.g. `public/rbac-shared.js`, is exempt). Checks
  tracked **and untracked** files, since a cycle's new files are uncommitted at
  gate time.
- Build-stage guidance: any client-side permission check must **cite the server
  source it was verified against, read in the same cycle** — an unread value is
  an assumption and must be declared as one (below).

## 5. Acceptance criteria in change records

`finish` now **requires** (tool schema + a runner-side reject if omitted):

- `acceptance`: ≥1 human-runnable check, one per user-visible change
  ("as admin, open Connection Settings, type into Client ID — the value
  persists and Test connection is clickable");
- `assumptions`: `{ verified: […], assumed: […] }` — the cross-layer values read
  from source this cycle (naming the file) vs. merely assumed.

Both are appended to the change record's summary (and logged as an `acceptance`
cycle event), so the Reviewer replays them straight from the record. The Tier-2
review skill now records as blocking findings: a UI diff with no corresponding
interaction check, a missing/non-runnable acceptance section, and permission
logic whose cited server source wasn't actually read.

## 6. The change-69 permanent regression test

`admin/backend/src/__tests__/mock2-ui-checks.e2e.test.js` drives the real
executor (Playwright/Chromium) against two in-test fixtures of the ADP
Connection Settings screen: the **broken** one (the exact shipped regression —
disabled `#adp-client-id`/`#adp-client-secret`) must FAIL with the control named,
and the **fixed** one (typed input persists, Replace enables the secret, Test
connection clickable, viewer read-only) must PASS. It skips visibly when
playwright isn't installed; `mock2-ui-checks.test.js` covers the pure layer
everywhere.

## Rollout

Framework content (gates, skills, constitution) ships as seed files; on the next
boot `upgradeFrameworkFromSeed` publishes them as a **new framework version**
automatically — projects adopt it through the normal drift → update-cycle path.
The smoke-connector defaults apply on backend restart. The browser connector
needs `playwright` in `admin/backend` (`npm install playwright`) plus a Chromium
(`npx playwright install chromium`, or `SMOKE_BROWSER_EXECUTABLE`); until it is
installed, cycles whose diffs warrant it fail visibly rather than pass silently.
