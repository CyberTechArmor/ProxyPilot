# Selected-browser configuration import release

This isolated candidate adds **Browser configurations** inside a project's **Agents** section. An owner or editor can paste JSON, edit the task, exact destinations, actions, budgets and approved-guide pin, validate, explicitly review and save a non-executable draft. Authorized readers can inspect the saved revision, original source, integrity hashes and readiness. The existing demo sign-in and public website review workflows remain separate.

Base: `863ed48caa2ec9fff212b9e9a76ea0fc8e04d7c7` (`origin/main`, PR725 merged). Branch: `browser/configuration-import-20261002`. All work and checks ran in the saved ProxyPilot cloud environment. This document records an uncommitted review candidate; [the manifest](evidence/browser-configuration-import-20261002/manifest.json) binds the tested source files and evidence before the parent's commit. No commit, push, merge, deployment or host action was performed by this child.

## Scope and security boundary

Migration1117 adds draft configuration metadata and immutable configuration/source revision snapshots. Saves hash canonical structured settings and the exact original source separately, append a version snapshot in the same immediate transaction, and record only hashes/revisions in project events. Current permissions and an active project are checked inside every mutation. Creation uses the current project revision; updates use the configuration revision through `If-Match`. Every supplied approved-guide ID/hash must still match the current approved version. A missing guide is an unfinished draft; a stale supplied pin is refused.

The trusted proposal schema rejects unknown authority fields and any attempt to relax exact destinations, per-action consequential approvals, attempt-only sessions or off-list destination/purpose approvals. Canonical internal origins and exact ports may be saved as metadata. They grant no network access. Imported file and network-policy references remain unverified. The source and configuration stay in component memory until an explicit save; they are not stored in browser storage. On denied/revoked access, the editor clears private input. A revision conflict retains local edits and requires an explicit refresh/reload, validation and review.

The only new routes are collection list/create, validate, detail, update and readiness under `/api/operational-projects/:id/browser-agent-configurations`. Existing authentication, CSRF and Operations metadata gates remain authoritative. Schema errors contain bounded field paths and fixed descriptions; unknown keys and input values are not echoed in error envelopes.

Readiness always returns `can_start:false` and `execution_enabled:false`, including `SELECTED_BROWSER_RUNTIME_NOT_IMPLEMENTED`. The database also constrains execution to false. This slice imports no selected runtime, host adapter, decoder, credential, conversion or model service, and registers no selected start/run, model-consent, conversion, file or live-view endpoint. The HTTP proof requires those routes to return404. No website or model is contacted by configuration validation/save.

## User flow and retained source

Paste either the configuration object or `{ "configuration": …, "source_text": "…" }`. The [full valid example](../../contracts/browser-agent/fixtures/general-agent.draft.json) and [proposal schema](../../contracts/browser-agent/proposal-v1.schema.json) are included. The UI also offers an editable example with read-oriented actions. Loading an example performs no save or validation.

The first valid paste is retained as original source unless the wrapper supplies `source_text`. Later structured edits preserve that source. The source field can be changed explicitly; each save retains the previous immutable snapshot. Save remains unavailable until the current edited settings have passed server validation and the user has checked the review confirmation. Changing inputs, project revision or guide invalidates that review. Validate never persists a draft.

## Verification

All checks passed on the isolated candidate:

| Check | Result |
| --- | --- |
| Targeted Operations/backend regression |210/210 tests|
| Focused schema/store/routes + real Express HTTP |12/12 tests|
| New real-app browser configuration journeys |5/5 journeys|
| New layout/accessibility checks |360×640,375×667,768×640,1280×800,1920×900; zero document/horizontal scroll and zero axe violations|
| Existing A6 browser workflows |20/20 journeys,96 layout checks|
| Existing A7/A8 browser workflows |6/6 journeys,42 layout checks|
| Production frontend build |2000 modules, passed|
| Selected execution/model/external contact |0/0/0|

The new browser suite uses the actual routed application, shared cookie/CSRF client, Express routes and SQLite store. Its authentication sessions and existing supervisor are test fixtures. It verifies exact paste/source retention, structured edits, current-guide pins, explicit validate/review/save, immutable revision history, stale-edit retention, readonly roles and access revocation. The import composition audit now includes both new inert modules and retains the existing narrow dependency allowlist.

Earlier development failures are superseded: a fixture incorrectly waited for an empty list after creating a draft; the old A6 suite detected missing descriptions on the new disabled Validate/Save controls. The fixture now waits for completed loading, and the controls name visible, state-specific explanations. The original assertions remain intact. No new LEARNINGS ID was allocated because the finding came from automated checks during implementation.

Reproduce from the isolated worktree:

```sh
cd admin/backend
node --test src/__tests__/operational-*.test.js src/__tests__/agent-run*.test.js src/__tests__/operations-toggles.test.js
cd ../frontend
npm run build
BROWSER_EXE=/usr/bin/chromium node tests/agent-runs.browser.mjs
BROWSER_EXE=/usr/bin/chromium node tests/agent-runs-a7.browser.mjs
BROWSER_EXE=/usr/bin/chromium node tests/browser-configurations.browser.mjs
```

The existing frontend security workflow now runs the new browser suite. Optional cloud accessibility/screenshot proof used `BROWSER_TEST_TOOLS=/tmp/proxypilot-browser-ui-verification` with installed axe/Playwright tools and `BROWSER_ARTIFACTS=/tmp/browser-config-ui-evidence`. CI still runs the functional/layout proof without that optional external tool directory. [UI report](evidence/browser-configuration-import-20261002/ui-report.json), [backend log](evidence/browser-configuration-import-20261002/backend-regression.txt), [A6 report](evidence/browser-configuration-import-20261002/a6-report.json), [A7 report](evidence/browser-configuration-import-20261002/a7-report.json) and screenshot hashes are retained in the manifest. Actual375px and1280px [budget editor](evidence/browser-configuration-import-20261002/budget-editor-375.png) and [readiness](evidence/browser-configuration-import-20261002/readiness-1280.png) pixels were inspected locally.

## Later integration and limitations

`BrowserConfigurations({base,project,onChanged})` is an independent draft editor. Its only capability is `browser_draft_configuration_available:true` with `browser_draft_contract:"browser-agent-draft.v1"`, under the existing Operations/agent metadata switches. Its parser, error text and budget descriptors are separately exported in `browser-configuration-ui.js`. Later integration should keep this single list/editor and replace the duplicated configuration portion of the broader `BrowserAgents` component. Lift the selected saved record and dirty state into that wrapper through an explicit review-selection callback when adding runtime supervision; keep readiness, consent and Start in the runtime layer. The present draft capability must never be interpreted as execution availability.

This release does not add plain-language/image/file conversion, asset resolution, browser execution, model consent, supervision or host installation. Stored historical snapshots are immutable, while this editor reviews the current saved revision. No policy decision blocks this inert slice. Parent review, commit/publication and fresh CI are the remaining release steps.
