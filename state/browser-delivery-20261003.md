# Public browsing delivery — current authorized scope

The 2026-10-03 user authorization supersedes historical whole-feature acceptance,
independent-terminal gates and documentation saying installation was uninvoked.
The owner completed fixed runtime operation `58db87b2-8f9b-4200-b878-c2b9d31c62be`;
its UI log reaches completed with acceptance_created/runtime_accepted false.
Those are installation results, not browsing acceptance. Live app/host agent still
`cad71e96f61b9640ba3c69fc4754ec1c1f2fffec`. Services observed active through scoped
MCP: supervisor, origin proxy, fence, broker, TURN and host agent; installed helper
identity and actual browsing remain unverified.

| Item | Status | Evidence / deployment | What I should see or be able to do |
|---|---|---|---|
| Checkpoint/preservation | Verified | Isolated public-navigation worktree; delivery local/remote tree compared; prior checkouts untouched | Existing data/services/history retained |
| Public navigation | In progress | Explicit schema/mode, nullable real pins, service navigation and optional-capability refusal | Open URL without model/guide/private storage |
| Public redirects/resources/protection | In progress | Dynamic screened destinations, actual peer check; seven Python public tests pass | Public pages/resources load; protected/private/mixed DNS refused |
| Measured readiness | In progress | Signed helper/VM/fence/policy/gateway/live prerequisites; root inventory in protected journal | Inspect actual helper hashes and capability results |
| Frontend open/live/Stop | In progress | Public panel, existing LiveBrowser, Stop, active run restoration, readiness details; frontend build passed | Enter website, watch, stop and reopen |
| Independent review | Verified | Four review blockers corrected; independent reviewer approved implementation tree 37167ad9 and source-boundary correction | Reviewed implementation |
| CI/merge | In progress | PR734; dashboard job passed; legacy error-path and post-Stop test diagnostics regressions corrected and independently reviewed; new CI required | Passing required checks before merge |
| Merge/application deployment | Not started | No new merge/deployment | New dashboard plus delivered runtime source |
| Runtime upgrade | Not started | Fixed Profile installer after app deployment | New installed helper generation |
| Live browsing/lifecycle/update proof | Not started | No browsing acceptance claimed | Real non-demo redirects/resources, live view, Stop, cleanup, relaunch and recovery/update compatibility |

Current review: https://github.com/CyberTechArmor/ProxyPilot/pull/734. CI runs
37147143522 and 37147143512 test head 388f6ea0. Initial head 1459e519 failed
the pure-module import allowlist in operational-projects.test.js; the new trusted
public schema/helper are now included without weakening network/runtime restrictions.
The failure remains in the original CI logs. Live verification project
516021fd-e58f-46df-b171-0c2dca0ea139 has no guide and no existing browser runs.

Head 388f6ea0's frontend job failed because union parsing collapsed a legacy
configuration.work field error. Strict per-mode import parsing restores exact
field paths; unknown/crossover modes remain refused. Its broker job ran 527 Python
tests (33 skipped), with one error: new public Chromium test eagerly dereferenced
the removed gateway in its post-Stop assertion message. Redirect/resource/text
assertions passed before this error; closure assertions were not reached. The
message now uses the cleanup receipt, with all closure/process assertions retained.
Both corrections were independently approved. Local selected service/runtime:
176 passed; configuration/source-boundary: 26 passed. These are not live acceptance.

Retained local test limitations: cloud workspace denies some AF_UNIX sockets and
lacks /usr/bin/chromium. These failures/skips are not passes. Disposable CI installs
the real browser; live infrastructure verification is still required.

---

# Browser delivery tracker

| Item | Status | Evidence / deployment | What I should see or be able to do |
|---|---|---|---|
| Source and host baseline | Verified | Live dashboard/agent cad71e96f6; clean source checkout | Known running build and unchanged existing A3/A4/A7 services |
| Fixed runtime installation controls | Deployed | PR732, all three CI workflows passed; deployment 62fbe678-8f9a-4c8b-87f3-70cda056492d | Profile → Application settings → Browser runtime: Install, Recover, Roll back |
| Invoke and verify runtime installation | Blocked | New MCP tool absent from this session catalog; cloud browser signed out | Needs callable manage_browser_runtime or authenticated cloud UI; no separate terminal required |
| Subsequent package delivery | Deployed | PR733; all three CI workflows passed; deployment 233d0b85-916b-442c-9881-d951a879044d | Ordinary app update preserves committed runtime; explicit installer replaces it |
| Public navigation and live view | Not started | Last runtime status: separate_runtime_package_required | No non-demo browsing or live-view acceptance claimed |
| Plain-language model tasks | Not started | Real provider/execution proof pending | Review generated task, execute and cancel |
| Manual authentication and action authorization | Not started | Separate capabilities | Sign in privately and return control |
| Files and internal destinations | Not started | Separate capabilities | Explicit supported file/internal journeys |
| Visual batches | Not started | Browser delivery precedes approved-mockup reconciliation | Individually deployed UI changes |

Baseline: pinned Mock2 1.14.0 guidance. Historical checkouts and unrelated state
preserved; all work uses the cloud clone and authorized infrastructure.

PR732's first deployment exited 75 at the existing systemd lifetime transition
check; the next invocation rebuilt successfully. No Incus upgrade occurred.
Installation controls passed local rendering at 360/375/768/1280/1920 pixels with
simulated API data; live authenticated UI interactions remain unverified.

PR733 first CI attempt failed Chromium's initial Target.setDiscoverTargets after
30 seconds. That execution path is unchanged by PR733. Failure remains in GitHub
job 111262200848; a single failed-job rerun passed unchanged, followed by all remaining checks.
The cause is unproven; no timeout was increased. Real-host installed-runtime
update compatibility remains unverified until installation is possible.
