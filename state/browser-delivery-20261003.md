# Current delivery checkpoint — 2026-10-04 03:19 UTC

## Fresh status check — 2026-10-04 03:19 UTC

Read-only update inspection confirms the running dashboard, host agent and clean
main checkout remain b1e387efc648eccd7feebcd2ef19620b32574854. Latest main is
d2331e251fc1a58443adfd979112192810b0d283. The latest operation remains
acea49e5-8e15-41d5-a5ab-5aed598eeac2, successful with empty flags; no newer update
has started. The selected supervisor, origin proxy, broker, TURN and host agent
are active/running; fence is active/exited. These service states do not prove
a newer installed helper generation or redirect browsing. No fresh runtime
identity measurement, deployment, installation or live launch occurred in this
status check. Tracker statuses below are unchanged. Prior deployment refusal
and cancelled fresh authentication remain respected; no alternate shell or
service action was used to bypass them.

This checkpoint supersedes earlier statuses below and preserves their evidence
and failures. Source implementation, review, CI and merge are complete for the
current public browsing follow-up. Deployment/runtime/live acceptance remains
incomplete. No new application update or dedicated runtime operation started.

| Item | Status | Evidence / deployment | What I should see or be able to do |
|---|---|---|---|
| Public URL, Open, activity and visible images | Verified | Running dashboard/agent/clean source b1e387efc648eccd7feebcd2ef19620b32574854; actual Python homepage rendered in runs33c66c5f and242947d1 | Operations → Public browser verification — 2026-10-03 → Agents → Public browser |
| Stop, physical cleanup and another visible launch | Verified | Both homepage runs have all four signed closure flags true, no pending/inflight/effects/uncertainties; repeat run242947d1 visibly rendered | Stop closes the isolated attempt and removes images; Open launches another browser |
| Public wording, separate viewer status and safe errors | Merged | PR741 merge78142fcd5fe85887014da653a1a1b9f761e2cea3, independently reviewed/green CI; included in main | Public browsing explains no guide/model consent; execution and failed video/image viewing states are distinct |
| Frame backoff and active-run readiness guards | Merged | PR741; five-width real Chromium checks and server no-idle-probe regressions | Useful safe error and30sec failure retry; Stop disposes polling; readiness disabled while active |
| Public per-request refusal and gateway ordering | Merged | PR742 merge d2331e251fc1a58443adfd979112192810b0d283; reviewed head668fbc6c936ed17bf1dc83a3807b3bc93061ca8d, exact treefbe51bd5d2db934161ef09d5202eeb7f2d7029cd | Denied resources stay blocked without freezing later allowed public viewing; old CONNECT refusal cannot overwrite newer grant |
| Independent review and final CI | Verified | Security37169866413 and configured-boundary37169866411 success on final reviewed head;560Python tests/296.619s,33skips; real Chromium continuation and dashboard checks pass | Source gates passed; fixtures do not establish newly installed runtime or live redirect acceptance |
| Application deployment of PR741/742 | Blocked | Latest update remainsacea49e5 successful to b1e387ef; newer update request refused before starting and its full refusal reason was lost during parsing; main nowd2331e2 | Current UI remains PR740; merged wording/runtime source has not reached the running app |
| Dedicated final runtime Install and Recover | Blocked | Fixed controls stopped at fresh-auth wall before invocation; no new operation ID; prior cancelled authentication respected | Profile → Application settings → Browser runtime fixed Install/Recover requires a fresh authenticated cloud session |
| Final installed/loaded helper generation | Blocked | Installed workerb72eac75/gateway21f7297a; expected new worker77ef9851/gateway02433df0 not installed | After fixed Install, measure installed and loaded hashes plus VM/fence/Chromium/gateway/view prerequisites |
| Actual redirected-page compatibility | Blocked | Python downloads run593799c0 retains frame500/429 failure; source fixture redirect successes are not runtime acceptance | See a real supported redirected public page and resources beyond its starting origin on the upgraded runner |
| Continuous live video | Blocked | Real video connection remains failed; transient images visibly work for homepage and repeat launch | Image viewing available; continuous video remains unproven |
| Last ordinary-update compatibility | Verified | Updateacea49e5 succeeded00:54:02Z, flags empty, preserve_selected/runtime_changed:false, installed hashes unchanged; visible launches followed | Normal app update preserved the then-installed expanded runner and restarted healthy |
| Ordinary update after final runtime upgrade | Blocked | New two-helper generation not installed; compatibility must be checked afterward | Normal update preserves the final worker/gateway generation and another visible launch works |
| Broader UI redesign/model/private-login/files/internal workflows | Not started | Separate follow-up scope, not a prerequisite for public URL browsing | Optional unavailable capabilities stay separate from public mode |

New source generation:
- Gateway SHA25602433df09948099f4c1204d1fde10a64b077a717fd50d3feaf27ad261afea18f.
- Worker SHA25677ef98510dc68f51135abbadf1096acaf9a470784f45c1eee9f2f98652903da0.
- Other five helpers unchanged. Ordinary update delivers source but preserves
  installed generation; only the fixed dedicated Install commits new helpers.
- Final main SHA d2331e251fc1a58443adfd979112192810b0d283 includes PR741 and PR742.
- Running/agent/clean checkout independently still b1e387efc648eccd7feebcd2ef19620b32574854.
- Last measured eight prerequisites belong to the current installed generation;
  protected inventory SHA207436e8d78da2912e0f5482e8c723643886bd6c332c451abeb07484ece2e75e
  remains preserved. No acceptance marker or readiness boolean was fabricated.

Real proof remains:
- Homepage run33c66c5f-7b0e-4bb6-bfaa-147edebe2e56,33requests/592460bytes,
  actual repeated pixels and frameGET200/201442bytes; clean Stop.
- Homepage repeat run242947d1-fceb-41cd-a2ee-81a22dcfd53f,
  attempt6562e497-9d68-48c5-9d57-abed9c8bfa1b;01:12:39.727–01:13:51.962Z;
  actual Python logo/navigation/carousel;33requests/592460bytes; zero model calls,
  tokens/usd/artifact bytes.
- Repeat signed cleanup ledger2f2317dce50e80e585ce95fcd5e552a04bca983725e964a1a9ecca34c740111d;
  all four closure flags true, absent cgroup, inactive/not-found unit, empty
  process/member/mount lists, zero pending/inflight/effects/uncertainties.
- Downloads failure and earlier uncertain legacy record remain retained.
  Public fixture DNS/transport mapping is not end-to-end installed-boundary proof.
- Private screenshots and raw signed receipts are saved as private user artifacts,
  not GitHub attachments. All public attempts are stopped.

Earlier CI failures, the local PID-identity teardown refusal and workspace Unix
socket permission block remain documented below. Both CONNECT ordering defects
were independently reproduced on old source and pass deterministic regressions
on the fix. Final CI now passes; their causal link to prior CI/live failures
is not asserted as established.

The earlier fixed Installea96d3e0-87d4-4aec-9425-d0d8ba681e5c genuinely succeeded.
The new post-update Install/Recover requirement remains uninvoked due to fresh
authentication, not a claim that runtime installation never occurred.
No Incus upgrade, unrelated hosted application update, owner-local computer or
temporary SSH key was used. No active-run idle boundary probe was performed.

---

## Historical checkpoints and failures (preserved)

# Current delivery checkpoint — 2026-10-04 02:03 UTC

This checkpoint supersedes the older statuses below and preserves their failures.
Public browsing acceptance remains incomplete. No new deployment or runtime
installation was started after the last successful application update.

| Item | Status | Evidence / deployment | What I should see or be able to do |
|---|---|---|---|
| Public URL, Open, activity and image viewing | Verified | Dashboard/agent/source b1e387efc648eccd7feebcd2ef19620b32574854; actual Python homepage visible in runs33c66c5f and242947d1 | Operations → Public browser verification — 2026-10-03 → Agents → Public browser |
| Stop, physical cleanup and another visible launch | Verified | Both homepage runs have all four signed closure flags true; no pending/inflight/effects/uncertainties; repeat run242947d1 visibly rendered | Stop removes images and closes the isolated attempt; Open launches a new browser |
| Public wording, viewer status and safe errors | Merged | PR741 merge78142fcd5fe85887014da653a1a1b9f761e2cea3; independent review and workflows37167296480/37167296488 green | Public mode explains no guide/model consent; browser state and unavailable video/images are distinct |
| Frame backoff and active-run readiness guards | Merged | PR741; real Chromium checks at five widths, Stop disposes30sec retry, server performs no idle probe while active/cleanup-unverified | Clear safe failure reason; bounded polling; readiness disabled during execution |
| Latest application deployment | Blocked | PR741 deployment call returned non-JSON refusal and started no operation; exact refusal reason was lost by response parsing; latest operation remainsacea49e5 | Running site is still PR740/b1e387ef; no claim that merged UI fixes are deployed |
| Per-request public denial without freezing all viewing | In progress | PR742 reviewed head668fbc6c936ed17bf1dc83a3807b3bc93061ca8d; worker public refusal plus gateway atomic transition/socket duplicate-refusal fixes; both old-code races reproduced, new tests pass; fresh CI37169866413/37169866411 running | Denied writes/protected resources stay blocked while later allowed requests and ticketed viewing continue |
| Actual redirected-page compatibility | In progress | Real Python downloads run593799c0 retained frame500/429 failure; new worker not installed; fixture redirects are not production acceptance | Visible supported redirected page with resources beyond the initial origin still needs real proof |
| Continuous live video | Blocked | Real video connection remains failed; transient public images work on the homepage and relaunch | Image viewing currently available; continuous video not proven |
| Ordinary update with installed expanded runner | Verified | Updateacea49e5 succeeded00:54:02Z; flags empty; runtime preserved; real visible launches followed | Normal application update preserves runtime and resumes healthy browsing |
| Installed/loaded capabilities and protected inventory | Verified | Last measured eight prerequisites verified; seven helpers match b1e387ef source; protected inventory SHA207436e8d78da2912e0f5482e8c723643886bd6c332c451abeb07484ece2e75e | Inspect actual helper/VM/fence/Chromium/gateway/viewing/protection evidence |
| Dedicated new runtime Install and Recover proof | Blocked | Post-update fixed Install stopped at fresh-auth wall before request; previous cancelled authentication respected; no new operation ID | Profile → Application settings → Browser runtime fixed Install/Recover requires fresh authenticated access |
| Broader design/model/private-login/files/internal capabilities | Not started | Separate follow-up scope; no fabricated guide/consent or reusable credentials | Optional unavailable capabilities remain distinct from public browsing |

Repeat successful visible launch:
- URL https://www.python.org/; run242947d1-fceb-41cd-a2ee-81a22dcfd53f;
  attempt6562e497-9d68-48c5-9d57-abed9c8bfa1b.
- Started01:12:39.727Z, stopped01:13:51.962Z;33requests/592460bytes;
  zero model calls/tokens/usd/artifact bytes.
- Actual Python logo, styled navigation and Compound Data Types carousel seen.
  Frame capture timestamps01:13:21.854Z,01:13:32.326Z,01:13:48.096Z.
- CANCELLED_BY_PERSON; all four signed closure flags true; absent cgroup,
  inactive/not-found unit, empty process/member/mount lists;
  zero pending/inflight/effects/uncertain ordinals.
- Cleanup ledger2f2317dce50e80e585ce95fcd5e552a04bca983725e964a1a9ecca34c740111d.
- Private screenshots and signed raw receipts saved as private user artifacts;
  unrelated project labels and owner/host identifiers are not GitHub attachments.

PR742 changes only the selected worker and associated tests/record:
- Expected new worker SHA25677ef98510dc68f51135abbadf1096acaf9a470784f45c1eee9f2f98652903da0.
- Installed/loaded worker remainsb72eac75173d83187d58273dcc2752c83fbf8a057b233a9f0e00d76c078ca717.
- New gateway SHA25602433df09948099f4c1204d1fde10a64b077a717fd50d3feaf27ad261afea18f;
  installed/loaded gateway remains21f7297a6f466460957f2e8da45dc7e100abc2764212113924db66170e5da096.
- Other five helper bytes unchanged. Ordinary updates deliberately preserve the
  installed generation; only the fixed dedicated Install can commit the new worker.
- Source mismatch between per-request public gateway/supervisor denial and
  worker freezing is established. It is not claimed as the diagnosed cause of
  the observed downloads failure.
- Unknown/malformed/private/fatal budget/ledger/pause denials still stop;
  denied requests receive no continuation, ticket, replay or upstream contact.
- First CI failure at existing private actualBrowserContinuation line169 is retained;
  the configured-boundary dashboard's same Chromium step passed. Independent
  reviewer allowed one unchanged diagnostic retry111336754583.
- The retry passed that Node Chromium continuation but failed existing Python
  test_sent_write_then_off_list_resource_cannot_be_settled_or_replayed line918:
  expected request_approval, got done.556tests/295.931s,33skips; one failure.
- No further unchanged retry. Cause remains unknown because its returned result
  and first refusal were absent from the log. The prior CONNECT/grant race is a
  source-permitted candidate for the first failure, not established cause; the
  second case has no destination grant before failure.
- A diagnostic-only test change preserves POST-before-approval refusal, exact
  approval-kind assertion, waits, PID protection and production code. It captures
  bounded synthetic result/gateway/request/ledger/Fetch ordering before teardown.
  Independently approved and published at4abd573ad25366b87877979c0ffa4574f438f0c0;
  tree9a3e76e39a449d2e5aae80569b3ec28fa6c3f122 independently matches local.
- Diagnostic-head Security37169152962 failed the original Node action4
  GATEWAY_PAUSED case again, before Python diagnostics could run. No unchanged
  retry. The old-code CONNECT/refusal/grant race is now deterministically
  reproduced using real gateway grants and barrier-controlled lock ordering.
  Atomic validation/state/refusal handling under one RLock passes, preserves
  old request denial, exact wire approval and reverse-order unsafe refusal.
  The causal link to observed CI remains unproven.
- Independently reviewed final PR742 head03a9f30cac299239a26184dfb6f8b92cab022fb5;
  local/remote tree87c637a6bddc55aa80e17d652553ff0d03f3367c matches exactly.
  Fresh CI37169448683/37169448718 running; not merged/deployed/installed.
- Independent gateway tests16pass and public-navigation17pass. Full gateway
  file44pass, one existing Unix socket test blocked by workspace EPERM; CI
  must verify that boundary. No permission or peer-identity protection bypass.
- Atomic-head Security37169448683 backend111339226959 again failed Node action4
  before Python. The socket wrapper repeated the already finalized CONNECT
  refusal outside the atomic check, recreating the same ordering bug. A second
  real socketpair/barrier/grant regression fails old wrapper and passes the fix.
  Old socket receives403; no TLS/DNS/upstream/request/effect; newer grant remains
  running. Malformed CONNECT parsing still pauses and never reaches admission.
- Final reviewed PR742 head668fbc6c936ed17bf1dc83a3807b3bc93061ca8d;
  exact local/remote treefbe51bd5d2db934161ef09d5202eeb7f2d7029cd matches.
  Gateway+transport+public targeted suite45pass, plus malformed-header control1pass.
  Node fixture now retains bounded fixed ledger-order summaries without full
  metadata, page text, headers or bodies. No assertion/timeout/permission relaxation.
  Fresh CI37169866413/37169866411 running; not merged/deployed/installed.
  These proven source races are not asserted as the established live/CI cause.
- Local actual Chromium133 diagnostic case passed once including cleanup;
  in-memory test binary substitution is not CI Chromium149 equivalence.
  Earlier three-case local probe passed action assertions but its third teardown
  refused a fixture PID identity mismatch. That is retained as a failed probe,
  and no ownership guard was bypassed. Scoped process inspection found no
  remaining fixture processes.

No Incus upgrade, unrelated application update, temporary SSH key or owner-local
computer was used. All public attempts are stopped; active-run idle checks were
not performed.

---

## Earlier checkpoints (preserved)

# Current delivery checkpoint — 2026-10-04 01:04 UTC

This checkpoint supersedes the older statuses below and preserves their failures.
Public browsing acceptance is still incomplete.

| Item | Status | Evidence / deployment | What I should see or be able to do |
|---|---|---|---|
| Public URL entry, Open and activity | Deployed | PR740 merged b1e387efc648eccd7feebcd2ef19620b32574854; dashboard, agent and clean source match | Operations → Public browser verification — 2026-10-03 → Agents → Public browser |
| Independent review and relevant CI | Verified | Exact reviewed head3a8769ba8ca053180d6916086633da61f6038673; workflows37165470478 and37165470499 green before merge | Reviewed boundaries and real Chromium frontend checks at five widths |
| Visible public browser images | Verified | Real https://www.python.org/ homepage displayed in run33c66c5f-7b0e-4bb6-bfaa-147edebe2e56; frame GET200/201442bytes; repeated capture timestamps | Actual Python page through transient images when video fails |
| Continuous live video | Blocked | Real live video remains failed; image fallback works for the first homepage run | Images currently provide viewing; continuous video is not proven |
| Viewing after redirect/relaunch | In progress | Run593799c0-de4a-485e-9467-6b143712299b opened https://www.python.org/downloads;14requests/336618bytes; frame500 then429 cooldown; no visible page | Reliable visible redirected page and another visible launch remain required |
| Stop and cleanup | Verified | Both post-update runs cancelled; all four signed closure flags true; no pending/inflight/effects/uncertainties | Stop removes live images, enables Open and closes browser/network/session/temp files |
| Public-mode wording and error clarity | Not started | Current surrounding Agents instructions still describe guide/consent; viewer status appears beside run state and frame error is generic | Clear public-mode instructions and separate execution/viewer status |
| Ordinary update with expanded runtime | Verified | Updateacea49e5-8e15-41d5-a5ab-5aed598eeac2 succeeded00:54:02Z; flags empty; preserve_selected/runtime_changed:false; installed helper hashes unchanged; real visible launch followed | Ordinary app update preserves runner, restarts healthy and allows actual browsing |
| Installed and loaded capability readiness | Verified | All eight measured prerequisites verified after update; seven helper hashes match new source; protected inventory preserved | Actual installed/loaded identity, VM, fence, Chromium, gateway, viewing and protection evidence |
| Post-update fixed Install and Recover | Blocked | Install clicked after update but fresh-auth wall prevented invocation; no new operation ID; prior cancelled authentication handoff respected | Fixed authorized operations require a fresh authenticated session before install/recovery proof |

First visible post-update run:
- Run33c66c5f-7b0e-4bb6-bfaa-147edebe2e56; attempta9b2d5e2-98a3-4793-81ce-87ae6f473f88.
- Started00:56:21.116Z, stopped00:57:50.064Z;33requests/592460bytes; zero model calls/tokens/usd/artifact bytes.
- Signed closure: inactive/not-found unit, absent cgroup, no worker processes,
  unit members or workspace mounts;0uncertain ordinals; all closure flags true.
- Cleanup ledgerdae24474988ab5aa66edc502e10c4e772128717d686fc2a9f1d6d476afd18f12.

Second launch retains a genuine viewing failure:
- Run593799c0-de4a-485e-9467-6b143712299b; attempt7915f27d-76f4-436d-a374-d3124be8f0ba.
- Started00:58:20.065Z, stopped01:02:48.845Z;14requests/336618bytes.
- Frame endpoint500 at00:59:11.600Z then429 at00:59:16.650Z; no cause inferred from status alone.
- Scoped worker journal showed only unit start; no causal diagnosis established.
- Signed closure: all flags true; absent cgroup; inactive/not-found unit; empty
  process/member/mount lists;0pending/inflight/effects/uncertain ordinals.
- Cleanup ledger127256340dd7cb8a24cdfcb402c93c22225e1a78d5a87023222f251e42bd08d3.
- The public entry redirects to the trailing-slash URL according to independent
  official-site retrieval, but this is not claimed as runner redirect acceptance.

CI failures are retained in the historical record:
- Initial frontend fixture failure reproduced and corrected with no weakened assertions.
- Corrected-head backend first failed the existing navigation escalation test.
  One independently approved unchanged retry passed548tests,33skips in264.074s.
  Cause remains unproven; later new frame test uses a fresh fixture.
- Final frontend, broker and security checks all passed on the merged head.

No Incus upgrade or other application update was requested. Ordinary update log:
`/var/lib/proxypilot/update/acea49e5-8e15-41d5-a5ab-5aed598eeac2.log`.
The earlier dedicated Installea96d3e0-87d4-4aec-9425-d0d8ba681e5c succeeded;
PR740 changed no runtime helper bytes. Fresh-auth still blocks the explicitly
required post-update Install and fixed Recover operations.

Private screenshots and raw signed proof remain private user artifacts, not
GitHub attachments. A screenshot/export or connector outage is not browsing proof.

---

## Historical checkpoints (preserved)

# Public browsing delivery — verified checkpoint 2026-10-04

The latest user authorization supersedes historical independent-terminal and
whole-feature acceptance gates. Historical records below remain unchanged and
are superseded by this measured checkpoint. Browsing acceptance is not complete.

| Item | Status | Evidence / deployment | What I should see or be able to do |
|---|---|---|---|
| Preservation/checkpoint | Verified | Isolated current-source worktree at 8832f51; older dirty checkouts untouched; delivery branch local/remote compared | Existing data, credentials, services and history retained |
| Public mode and protection | Deployed | PR734 through PR737 merged after independent review and green CI | Public URL launch without guide/model consent/private storage; DNS/peer protection remains |
| Frontend Open/browser activity/Stop | Deployed | Running dashboard/agent/source 8832f51b82d64926ad9e51509e8001cf459ea5bb; checkout clean | Operations → Public browser verification — 2026-10-03 → Agents |
| Independent review and relevant CI | Verified | PR734–737 approved and all required checks passed before merge | Reviewed implementation; source tests are not live acceptance |
| Dedicated runtime upgrade | Deployed | Fixed install ea96d3e0-87d4-4aec-9425-d0d8ba681e5c succeeded 2026-10-04 00:00:42–00:00:53Z, exit0 | Installed selected runner; acceptance_created/runtime_accepted intentionally false |
| Installed/loaded helper identity | Verified | Seven installed helper hashes independently match 8832f51 source | Inspect actual installed generation in measured capabilities |
| Measured readiness | Verified | Public readiness can_start true; installed/loaded helpers, VM, fence, Chromium policy, gateway, live view and protected inventory verified | Capability evidence, not a readiness boolean substitution |
| Public launch and relaunch after Stop | Verified | Wikipedia be9aad15… launched; Python f0914008… launched after signed cleanup | New isolated attempt starts with no model calls/artifact bytes |
| Actual page and redirect/resource compatibility | In progress | Wikipedia 2requests/282bytes; Python33requests/592494bytes; pixels unavailable | Real rendered pages and redirects/resources still require proof |
| Live video | Blocked | Both real runs show The live video could not connect; Python signalling route101/3419bytes/19764ms | Video transport remains a genuine failure; exact media cause unproven |
| Public transient viewing fallback | In progress | PR740 independently approved;234backend tests and real Chromium frontend at five widths pass; corrected-head CI37165470478/37165470499 in progress; not merged/deployed | Current images every5sec when video fails; no storage/model dependency |
| Stop and physical cleanup | Verified | Both cancelled; all4closure flags true;0inflight/pending/effects/uncertainties; signed process/cgroup/mount closure | Stop closes browser/network/session/temp files; history retained |
| Dashboard restart/recovery | Not started | Actual new-generation runtime proof pending | Restart recovers without replay and can launch again |
| Ordinary-update compatibility | Not started | PR733 preserved runtime during pre-upgrade update; expanded installed generation still needs real update proof | Normal app update preserves committed runtime and permits another launch |

Runtime log: /var/lib/proxypilot/update/ea96d3e0-87d4-4aec-9425-d0d8ba681e5c.log.
Protected inventory SHA256: 207436e8d78da2912e0f5482e8c723643886bd6c332c451abeb07484ece2e75e.
Active services observed: supervisor, origin proxy, fence, broker, TURN and host agent.
No Incus upgrade was requested or performed.

Real runs on 8832f51:
- be9aad15-bd97-4ff1-955d-aa753471b371, attempt9c188540-e122-4c1a-aa06-98c999f3505e,
  http://www.wikipedia.org/,00:11:24.023Z–00:13:53.088Z; CANCELLED_BY_PERSON.
  Cleanup ledger09f67424207981cfdc4b7aa3f791b311b3ec565e352b2fa6f3b9c8313800bb46.
- f0914008-55e7-4519-8991-42c6e8eee45a, attempt31a4b9ac-390b-4b90-8c6c-03cba3ba6de5,
  https://www.python.org/,00:17:09.667Z–00:19:15.728Z; CANCELLED_BY_PERSON.
  Cleanup ledgera32fa8c35762ae6fff6570b6a53eae8b18f025dc8ec7e259bbde06a3a0378587.
Both signed receipts report inactive/not-found unit, absent cgroup, empty worker
process/unit-member/workspace-mount lists,0uncertain ordinals and measured0input.
A frontend reload restored the same Wikipedia attempt without navigation replay.
Earlier cef031f1 remains uncertain/EXTERNAL_EFFECT_UNVERIFIED; its original
signed uncertain_ordinal1 is retained despite physical cleanup being complete.

A screenshot export attempt timed out; no broken screenshot artifact or invented
rendered-page evidence is published. No site-served bot challenge was observed;
a blank failed-video panel is not classified as bot detection.

---


Current public-view fix: PR740, head3a8769ba8ca053180d6916086633da61f6038673.
Initial CI frontend failure37165050401/111326153788 was independently
reproduced: fixture held the replacement request after React development
double-mount aborted the first. Fixture corrected without changing production
code or removing assertions. Independent Chromium re-review passed decoded
images at all five widths, Stop, late reply disposal and no further polling.
Original-head broker/dashboard and remaining security jobs passed. Corrected
head requires fresh green CI before merge.

Deployed public UI readiness refused both http://127.0.0.1/ and
http://169.254.169.254/latest/meta-data/ with PROTECTED_DESTINATION; no browser
launch was requested for either. Restored input to https://www.python.org/.
After the clipped screenshot timeout, native screenshot capture succeeded;
its local evidence shows the Python cancellation and all four closure flags.
It also includes unrelated project labels and is not uploaded to GitHub.

CI follow-up: corrected-head frontend and credential-broker/dashboard workflows
passed. Security run37165470478 backend job111327554223 failed548-case
suite (33skips), existing test_navigation_escalation_grant_settles_unsent_action_and_offers_new_exact_path:
expected request_approval, actual done. All four runtime helpers and that case
are unchanged. The only Python addition runs later in its own fresh fixture.
Independent reviewer approved one unchanged failed-job retry; no assertion,
timeout or product change. Earlier PR740head full backend passed. The precise
failure cause remains unproven; original logs retained. Repeated failure
requires inspecting the returned result/request ledger before proceeding.

# Historical delivery record (superseded; preserved)

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
