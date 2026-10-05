# Browser project workspace

Saved browser tasks use the same mobile navigation component as the development
Flight Deck. Opening a project lands on Activity. Starting a run selects Browser
on mobile. Desktop keeps the viewer on the left and project information on the
right, at the existing 64/36 split.

| Destination | Content |
| --- | --- |
| Menu | Project switcher, new project, main navigation |
| Activity | Saved goal and websites, Run / Run again, scheduling, project events, live run events, outcomes, review card |
| Browser | Mounted live viewer, reconnect / fullscreen, pause / resume / stop, manual sign-in controls |
| Resources | Current approved guide, guide editor, training files, browser run history, guide versions and manual records |
| Details | Saved model and resource limits, recording, schedule, actual usage, access, technical information |

The Activity badge and first card show requests or uncertain outcomes needing
review. The modal shows each exact destination, purpose, and requested action.
Approve and Deny are mutually exclusive and initially unselected. Submission
and cancellation remain visible while the request list scrolls.

Submit & continue uses the existing individual approval endpoint. It re-reads
the run before and after each decision, binding the run, attempt, fence, action
hash and latest revision. Denials are submitted last because they can invalidate
other requests. This is not an atomic batch: earlier accepted decisions remain
saved if a later request changes. Failed, new or uncertain items keep the modal
open. Successful submission returns to the browser. Viewing or navigation never
starts work, grants control, bypasses verification, or automatically resumes a
manually paused run.

Existing uncertain-outcome reconciliation remains separate from request approval.
Resolving the final outcome closes review; Run again remains an explicit fresh
launch from Activity. Run state changes prompt a fresh readiness read immediately.
Role/access failure clears the project workspace and its private viewer state.

The live feed reads at most the latest 100 persisted run events, in chronological
order. Its projection contains only event IDs, kinds and timestamps, excluding
event payloads, private page text and request contents. Authorization uses the
existing project membership checks.

Compatibility: projects without the streamlined-task/runtime capability retain
their existing operation sections and standalone Browser Flightdeck. Their
viewing, authentication, recovery and exact approval handlers stay in place.
All three existing palettes continue to use the shared theme system.

## Verification

- `browser-project-workspace.browser.mjs`: real React shell with scripted API and
  decoded video transport; Activity entry, Run → Browser, viewer persistence,
  per-request batch submission, failed-review retention, touch scrolling, stop
  and fresh rerun, 360/375/390/768/1280/1920 layouts and axe accessibility.
- `browser-review-batch.test.mjs`: missing decisions, new/changed/expired requests,
  stale attempt/fence/action pins, partial submission, denial ordering and auth failure.
- Existing project-task browser journeys: defaults, scheduling, stale forms,
  blocked-run reconciliation, explicit verification and rerun.
- Existing Browser Flightdeck journeys: public-frame fallback, fullscreen,
  decoded viewer continuity, touch scrolling, cleanup and reconnect.
- Selected-browser service regression: bounded event projection, private-payload
  exclusion, role checks, execution and authentication contracts.

The UI/transport fixtures are synthetic. They do not claim a new real external
website or installed-runner acceptance; the underlying runtime is unchanged.
Deploy using the existing operator update process. No host, Incus or other app
update is part of this change.
