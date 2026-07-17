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
| `component-reuse` gate (battery order 8) | container, every gate run | `state/components.json` lists installed components and the diff exists |

## 1–2. Smoke connectors: enabled by default, off = ship for live testing

`SMOKE_BROWSER_ENABLED`, `SMOKE_DB_ENABLED`, and `SMOKE_REQUIRE_TRIGGERED`
**default to true** (`smoke-triggers.js`). A connector still only *runs* on a
relevance hit — a backend-only diff invokes neither.

Two outcomes are deliberately distinct (`smokeGateOk`):

- **Operator turned the connector OFF** (`SMOKE_BROWSER_ENABLED=0` /
  `SMOKE_DB_ENABLED=0`) — this is the per-install toggle. The connector resolves to
  the **`disabled`** disposition, is never started, and the cycle **ships** (logged
  loudly, never a silent skip). Turning it off is an explicit decision to test the
  deployed build live by hand, so the gate accepts it — getting the build out for a
  person to test is the priority. This holds even under `requireTriggered`.
- **Connector left ON but it cannot run** (playwright missing, no DSN) on a diff
  that warrants it — this is the change-69 fail-visibly case. It reports
  `unavailable` at run time and **fails the cycle** under `requireTriggered`, with
  the reason in the cycle log, instead of logging and passing.

`SMOKE_BROWSER_EXECUTABLE` points the browser connector at a system Chromium.

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

---

# Addendum: acceptance discipline (the cycle-94 hardening)

A second real failure hardened the harness further: a bug-fix cycle (cycle 94 /
change 77, project ADP) reached "succeeded" with five green gates while the
reported defect (ADP mTLS false rejection) was never reproduced — its only
committed change reworded string literals so the secret-scan regex would stop
matching. Root cause: "done" was a proxy (gates green) for the goal (the
acceptance criterion), so the proxy got optimized (Goodhart). Fixes:

- **`state/acceptance.json` + the `acceptance` gate (battery order 7)**: every
  cycle declares what "done" means — task, kind, `defect_tag` + regression
  tests (bug fixes), an integration `contract_test` (must NOT mock the
  transport), and `ui` check ids that must pass against the deployed app. The
  gate enforces the declaration statically.
- **Reproduce-first (red→green), runner-enforced**: for a bug-fix task, `finish`
  is rejected unless a gate battery in THIS cycle showed the `test` gate RED at
  least once. The SDK runner applies the same rule to its round loop. The
  machine state lands in `mock2_cycles.acceptance_json` (migration 517) —
  "gates green" and "acceptance demonstrated" are distinguishable.
- **Live acceptance checks**: `acceptance.ui` ids force the post-deploy browser
  connector to run those `ui-checks` regardless of the diff; a missing or
  failing acceptance check fails the cycle.
- **Detector-evasion ban + real secret scan**: `security-scan` v2 uses gitleaks
  when installed, else a body-aware matcher (PEM header + base64 body / inline
  blob / AWS key ids) with `state/secret-scan-allowlist.txt` as the REVIEWED
  waiver path — a header literal in product source can no longer false-positive,
  and constitution §12 names "modify code to dodge a scanner" a prohibited
  anti-pattern with a waiver protocol (fix the code, or propose the
  gate/allowlist change as a distinct reviewed act).
- **Operator claims verified**: the resume-guidance block now instructs that
  checkable claims ("the audit is clean", "substantially done") be verified
  against the tree; a contradicted precondition is a halt, not a note.
- **Record accountable to the diff**: every checkpoint auto-appends its own
  `git diff --stat`; a finish summary naming files the cycle didn't change is
  rejected (over-claim check).
- **Anomaly tripwire** (heuristic, non-blocking): a succeeded bug-fix at a small
  fraction of its token estimate with no observed red test / no test file
  touched raises a `flag` queue item for human review.

Demonstrated (permanent tests + fixtures): the exact cycle-94 shape is rejected
by `acceptanceVerdict`; its summary is rejected by the over-claim check; its
19.8k/405k-no-repro signature trips the anomaly flag; the old scan false-
positives on PEM header literals while v2 doesn't (and v2 catches a real
committed key, allowlist-waivable); and the live "Test connection turns all
three checks green" acceptance check fails against a fixture reproducing the
defect and passes once fixed (`mock2-acceptance.test.js`,
`mock2-ui-checks.e2e.test.js`).

---

# Addendum: component-reuse detection (the request-36 hardening)

A third failure shape: asked to "build the first-visit bootstrap super admin
creation", a build re-implemented capability the pre-installed auth component
already shipped, then fought unrelated gates for five attempts on a feature that
was effectively done. Reuse guidance existed but was advisory prose only.

Two-sided fix:

- **Process (build skill)**: a mandatory "Reuse before you rebuild — ALWAYS check
  first" step precedes the work loop — installed components, then the component
  library, then the existing tree; a capability already fully present finishes as
  a verified finding (chore), never a manufactured diff.
- **Detector (`component-reuse` gate, battery order 8, deterministic, no AI)**:
  `state/components.json` now mirrors each installed component's **API contract**
  and **installed file paths** (from the verified install manifest). The gate
  fails the cycle when the working-tree diff:
  1. **re-registers a component endpoint** outside the component's own files —
     an express-looking receiver (`app`/`router`/`xRouter`/`r`) registering a
     path that exactly matches a contract endpoint, or suffix-matches it with
     ≥2 segments (mounted routers); method must match. Client code *calling* an
     endpoint (`api.post`, `axios.post`, `fetch`) is wiring and never flags;
  2. **adds a parallel copy of a component file** — same basename (generic names
     like `index.ts`/`routes.ts` and numbered migrations exempt) while the
     component's original is still on disk. A move/rename does not flag.

  Edits *inside* a component's installed files are adaptation and always pass.
  Waivers follow the standard gate-waiver protocol: the exact path goes in
  `state/component-reuse-allowlist.txt` as a distinct reviewed act with a
  halt/deviation explaining why — never a restructure to dodge the detector.

Tests execute the gate's real embedded script from the seed against fixtures
(`mock2-component-reuse-gate.test.js`): the request-36 shape (re-registering
`POST /api/auth/bootstrap/superadmin`, a parallel `bootstrap-superadmin.mjs`)
fails; wiring calls, own-file adaptation, moves, and waivers pass.
