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
