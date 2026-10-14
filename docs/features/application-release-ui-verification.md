# Application releases UI and REST verification

The LXC container dialog has a Releases tab using the existing session/CSRF API client. Registration is for existing applications. It can save an optional named dependency-preparation npm script for later validation, but does not execute it. Candidate, passed validation, last verified live state, review-branch publication and remote default branch are displayed separately. A runner result is not presented as full feature acceptance.

REST is registered through `registerApplicationReleaseRoutes` with mandatory admin/sudo guards and injected service/job adapters. The mounting application must retain its existing authentication and CSRF boundary. The route never accepts client-supplied validation evidence or an alternate source path during a release action.

The interface supports profile revisions, source checkpointing, a unified patch committed from an exact parent on a working branch, preparation, validation, deployment, live verification, review-branch publication, independent remote verification, a checked merge, rollback and interrupted-operation reconciliation. It polls durable server jobs. Profile editing keeps the originally opened revision so a concurrent profile edit cannot silently overwrite it.

## Executed evidence

- `node --test admin/backend/src/__tests__/application-release-routes.test.js admin/backend/src/__tests__/application-release-ui-model.test.js`: 19 passed; no skipped tests. Tests cover guard registration, deferred named preparation, server-resolved candidate jobs, stale profile inputs, cross-application job isolation, honest blockers, asynchronous service access, explicit commit/merge inputs, independent release states and restored live identity.
- `npm run build --prefix admin/frontend`: passed using the existing project dependency installation. Existing chunk-size/dynamic-import warnings remain.
- Rendered the actual component with the actual dialog primitives and project CSS against a controlled, injected API fixture at 360, 375, 768, 1280 and 1920 pixels. All five had document scroll width equal to client width with the horizontal overflow guard disabled, no browser page errors and no axe WCAG 2A/2AA violations. This is not a Lighthouse score or physical-device test.
- At 375 pixels: completed registration using an existing connection, verified registration keeps `installScript: null`, completed validation-to-enabled-deploy, observed a blocked deployment without false success, retained remote-readback failure, and created a patch commit whose new candidate requires validation. A follow-up 375px journey also verified explicit absent-branch merge sends null and optional named preparation is preserved without execution. Examined 360/768 overview pixels and the 375 registration form.

The fixture runs an npm-bundled Chromium extracted into scratch because the Playwright browser CDN returned an invalid zero-byte archive and the bundled extraction helper could not chown in this environment. No production backend, credentials, live application, paid provider, deployment or publication was used. The parent integration run remains responsible for real service/runner wiring and end-to-end host acceptance.

Scratch evidence retained during this run: `/workspace/scratch/c4337a3e4232/release-ui-harness/{render.mjs,entry.jsx,report.json,releases-360.png,releases-375.png,releases-768.png,releases-1280.png,releases-1920.png,registration-375.png}`.

## Contract correction follow-up

The public commit API retains `expectedParentSha`, which the REST adapter now explicitly maps to the domain's `parentSha`. An exact input-object assertion prevents this mismatch from recurring. Merge accepts `expectedRemoteSha: null` only when the UI's explicit absent-branch checkbox is selected; empty or omitted input is refused, and the domain still checks actual remote absence. Optional preparation accepts existing named npm scripts through the domain validator, never raw shell commands. The targeted 375px follow-up had no overflow, page errors or axe WCAG violations; the production frontend build passed again.

## Final integrated job-state review

The UI reads the setup engine's real `reason` and `outcome` fields. A recovery-required job exposes its interrupted SHA from `plan.params.sha`, lets the operator select that candidate, and directs them to Roll back without replaying deployment. A candidate's historical live receipt never enables merging after the application's observed live SHA has moved. Expected merge identity is sourced from the configured release branch, which may differ from the remote default branch; the verified remote card identifies its branch. These cases passed the targeted 375px fixture journey with no page errors, overflow or axe WCAG violations.
