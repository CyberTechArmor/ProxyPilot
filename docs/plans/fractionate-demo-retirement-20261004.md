# Demo execution retirement inventory — 2026-10-04

The owner now prioritizes exact original-reference UI parity and removal of exposed demo flows. This supersedes older instructions to preserve exposed demo execution. Production application updates and runtime Install belong to the owner. This inventory and its test fixtures are source evidence, not deployment or installed acceptance.

## Narrow retirement

`routes/operational-projects.js` retires both new-run entry points through the access-checked `rejectNewDemoRun` service projection:

| Surface | Result |
|---|---|
| POST `/api/operational-projects/:id/agent-runs` (including practice bodies) | 410 `DEMO_EXECUTION_RETIRED` after current account/project run access |
| POST `/api/operational-projects/:id/agent-runs/:runId/resume` | 410 after current access and existing project/run lookup |
| Legacy profile readiness | `ready:false`, `practice_ready:false`, retirement explanation |
| Historical detail Resume | Disabled with retirement explanation |
| Historical list/detail/profile/rules GET | Preserved with existing permissions |
| Active Stop, receipt collection, reconciliation, takeover end/view closure, recovery | Preserved |
| Selected/public browser routes and contracts | Unchanged |

Hidden projects retain 404, viewers retain 403, missing historical runs retain 404. Retirement does not delete profiles, guides, bindings, comments, evidence or runs. Legacy internal service `start`/`resume` methods remain dormant behind the retired HTTP routes for historical lifecycle fixtures; there is no environment/config/request flag to reopen those routes. An inspection of production callers finds no remaining wire call to those methods. They are not a current supported launch interface.

## UI removal boundary

- `pages/OperationalProjectDetail.jsx`: remove imported/rendered `AgentConfiguration`, exposed legacy profile/run navigation, synthetic pilot Overview copy and redundant demo onboarding; retain historical run deep links and active cleanup.
- `components/operational-projects/Agents.jsx`: demo-only profile editor and synthetic credential-binding presentation; no new visible entry.
- `components/operational-projects/AgentRuns.jsx`: remove Start/practice/profile launch presentation and Resume; retain GET history, signed outcomes, Stop and reconciliation.
- `components/operational-projects/BrokerAgents.jsx`: the visible `typed_api_v1` setup currently describes only a synthetic ledger API. Remove its redundant browser onboarding entry. Its saved metadata and generic typed API machinery are not deleted or silently disabled here.
- Demonstrations under `Evidence.jsx` are source/evidence records, not the synthetic sign-in runner. Keep existing private evidence records and retention controls.

## Dependencies that remain

`operational-agent-runtime.js` supplies supervisor configuration shared by `createSelectedBrowserRuntime`. `operational-worker-supervisor.js`, `operational-worker-boundary.js`, live transport/authentication/grants, frame validation, receipt verification and shared read/cleanup support remain required. Host `a3-worker-supervisor.py`, `a3-worker-guest.py`, `a3-origin-proxy.py`, fence/proxy installers, A4 custody and selected helpers are coordinated runtime dependencies; do not remove them based on historical demo names.

`operational-demo-fixtures.js`, legacy coordinator/policy/recovery and legacy service remain for historical active-run recovery, fixture reset, signed cleanup and regression evidence. `index.js` still constructs the legacy cleanup/recovery service and attaches its historical live endpoint. Removing this would strand an active historical run or a pending teardown. No migration or runtime helper bytes change in this slice.

Other exposed API candidates require a separate boundary decision: POST `/:id/agent-configurations/:configurationId/tasks` and POST `/:id/agent-configurations/:configurationId/task-proposals/:proposalId/start` dispatch typed API tasks using `broker-task-dispatch.js`/`broker-task-proposals.js`. Current operations are `item.read` and `item.set_state` for the synthetic ledger adapter. This is separate broker API infrastructure, not selected-browser execution. Adapter-specific retirement should bind to authoritative adapter identity; broadly deleting typed API routes would silently disable unrelated generic functionality. This slice does neither.

## Verification and delivery

The dedicated route-dispatch retirement tests (actual production router code with the fixture dispatcher, not a TCP HTTP proof) check ordinary/practice starts for all run roles, hidden-project/viewer denial, no fixture changes, no worker calls and no run creation; historical signed run GET/Stop remains usable and Resume cannot add a record. Historical A6/A7 regression suites seed legacy records through an explicitly annotated test-only internal fixture. Their setup is not current HTTP execution acceptance. The unmodified real router is always used by the dedicated retirement tests.

38 focused retirement/A6/A7 tests passed locally. The existing A8 record suite additionally passed five cases; its native AF_UNIX slow-drip listener case failed with environment `listen EPERM`, and remains required in native CI. Do not skip or relabel it.

The frontend security workflow also runs `tests/agent-runs-cleanup.test.mjs`, `tests/agent-runs.browser.mjs` and `tests/agent-runs-a7.browser.mjs`. Those old browser journeys assert demo Start/profile/practice/Resume UI. The updated journeys use explicit Node-only historical fixture seeding and assert retired controls, while preserving downstream cleanup/keyboard/focus coverage. The workflow remains enabled. New ordinary/practice Start and Resume refusals also receive actual TCP HTTP checks through the local Vite harness; this is local fixture evidence, not production behavior.

A normal application update is sufficient for this slice: it changes application API/UI and no installed helper inputs. Dedicated runtime Install is not needed. After the owner updates, read source/app/agent identities and idle readiness/helper identities; compare preservation without inventing acceptance. Serialize a permitted public browser launch, real image observation, fullscreen/panels, Stop and signed physical cleanup. Never run idle-only guest boundary checks during an active run. Verify historical cleanup only on an actually authorized existing record; do not start a demo for verification. Retain the previously observed video/Python downloads failures as unresolved unless independently measured again.
