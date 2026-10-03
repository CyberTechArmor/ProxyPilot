# Selected browser agents — expanded scope and implementation slices

Base: `9b88f8f03925ee4c4cf097e40429897be9195e2f`, PR #724. Saved cloud environment
only; no Duo executor. Thomas's 2026-10-02 answers, followed by explicit
"Please build it", authorize the complete implementation and parallel agent work:
explicit public/authenticated/internal destinations, all requested interactions,
reasoning, live supervision and reviewed plain-language/image/file conversion. No push, merge, publish,
deployment or production run is authorized by that instruction.

The first delivery accepts a reviewed parent-generated structured configuration
paste. In-app plain-language/image/file conversion follows, retaining the original
and producing editable settings for explicit review/save. This is a full-interaction
scope, not another HTTP public-review link or a relabelled demo.

## Resolved policy decisions

- Consequential external operations: **per-action approval**. Include purchases,
  deletion, account/security changes, form sends, uploads and autosave caused by
  typing/paste/click; never infer permission from narrative.
- Any public, authenticated or internal website can be **explicitly defined**,
  subject to actual runner reachability. Authentication uses manual takeover initially. Internal reachability
  requires a separate reviewed network/target contract and must not bypass the
  installation/metadata/vault/control-plane deny rules.

- Off-list redirects, authentication and resource hosts are blocked before target
  DNS/contact and escalated. Approval binds exact destination and purpose and is
  temporary to that attempt. The base allowlist remains intact. No wildcard or
  permanent expansion is inferred; permanent changes need explicit reviewed edits.

No policy choice remains pending. Site examples and installed-target acceptance
still inform compatibility and reachability. Code work continues in cloud.

## Contract and integration constraints

The exact draft contracts and fixtures are under `contracts/browser-agent/`.
They accept all twelve browser primitives and finite budgets, exact per-agent
origins with navigation/resource/auth roles, current scoped file references and
explicit review/start. C0 now adds backend import validation and persistence locally;
the shipped main/deployed UI do not yet accept the new format.
No pasted field can grant owner consent, approve an effect, activate execution,
select credentials, change host policy or claim a verified environment.

Preserve the existing demo and HTTP website-review contracts. Existing
`ops_agent_profiles.workflow_type` and step-action constraints are synthetic-only;
`ops_agent_configurations` is typed-API-only and always disabled. Use a new
versioned browser adapter and additive migration(s), leaving applied migrations
unchanged. Factor compatible shared lifecycle/projection helpers where useful;
do not widen the old A5 validator to arbitrary URL/code/selector input.

The gateway is the first critical dependency. It must receive a supervisor-owned
attempt policy, enforce exact destinations before any target DNS/socket/send,
preserve TAP/cgroup isolation and upstream TLS, apply method/path/body/effect
rules to all requests, and suspend both autonomous and human input at escalation.
Required asset/login hosts are explicit. SPKI/certificate handling, streaming and
site-specific WebSocket/service-worker requirements need new proofs; the old proxy
is single-host, fixed-path and rejects those transports.

Bounded browser snapshots provide short public/private-consented observations,
opaque DOM/selection/input/file references and server-generated action candidates.
The model chooses candidate IDs, never arbitrary executable code or authority.
Use the existing A4 provider/key custody, prices and durable budgets through new
typed decision/report contracts; the current model route accepts only fixed demo
action names and typed booleans/outcomes, so reusing it unchanged is insufficient.

Private login stays manual in an isolated attempt. CB-01 trust-boundary confirmation,
CB-04 general credentials/OAuth and A8 deferred proofs are not activated or accepted
by browser work. Host/backend-root trust remains as documented. Downloads,
screenshots, uploads and clipboard need private bounded storage/disclosure and
current scoped references; no arbitrary host paths or secret-value/config path.

## C0 checkpoint and shipped parser

C0 adds packaged strict schema validation, additive migration 1117 and
project-scoped preview/create/list/read/update/readiness endpoints. Original text
and canonical configuration hashes are stored with immutable version snapshots;
optimistic revisions, current roles/archive boundaries, rollback and existing
auth/CSRF gates are preserved. Draft saves do not execute or change old run pins.
11 focused backend tests and 10 offline schema fixtures pass at this checkpoint.
Later slices own authoritative consent, approval, run and network capability.

Shipped editor: Operations → project → Guide → Instructions; start a guide
revision, then Save and approve. Agents → Demo sign-in profiles → Assign current
approved guide. "Hard rules enforced by code" is a read-only projection.
Exactly one column-zero `proxypilot-rules` fence is permitted, with strict JSON
for `workflow: "synthetic_sign_in"`. A valid minimal block is:

````text
```proxypilot-rules
{"v":1,"workflow":"synthetic_sign_in","start":["open_landing","open_login","submit_bound_fixture"],"finish":["sign_out"],"model_actions":[],"forbid":[],"approval_required":["submit_bound_fixture"],"stop_when":["verified_account"],"max_steps":5,"max_model_calls":0,"model":null}
```
````

It opens landing/login, requests approval for the bound fixture submit, verifies
the account via implicit `read_session`, then signs out if the step allowance
permits. Account verification and submit approval are mandatory; a guide cannot
forbid `read_session`. Arrays contain unique known actions; `start` max4, `finish`
max2, other action lists max7; steps1–20 and model calls0–10. `model` is NULL or
`gpt-6-luna` with output cap1–16. Verification may exceed the configured step cap;
finish skips when no allowance remains. Those existing semantics are unchanged.
This controls the synthetic sequence; it cannot unlock another site. Independent
backend, launch, guest, gateway and credential constraints enforce the demo origin.
Website reviews remain bounded public HTTP extraction plus the existing model
bridge and cited report; they do not provide live browser actions.

## Slices and dependencies

These are planning ranges of engineering effort, not measured AI wall-clock time
or a release commitment. Re-estimate after the first multi-origin gateway/browser
fixture proof and selected-site reachability. Unusual site dependencies and dynamic
write flows can exceed the high end.

| Slice | Result and exit evidence | Depends on | Effort |
|---|---|---|---|
| C0 contract and persistence | Strict draft/import schema, settings/source provenance, immutable snapshots, current revision/access tests, no implicit run. Backend checkpoint implemented locally. | Expanded scope and resolved choices. | 6–10 h |
| E1 attempt gateway and egress | Multi-origin HTTP(S) policy, role separation, destination/address screening, TLS/session-header scope, all-request interception, immediate off-list freeze/escalation, single-worker compatibility. Real two-origin fixture plus redirect/DNS/escape negatives. | C0 | 16–28 h |
| I1 exact internal target support | Trusted exact target/address/port/route policy, protected-service deny inventory, resolver/TLS/rebinding proofs and available route readback; no blanket internal ranges. Reachability acceptance on separately authorized installed target. | C0/E1; actual target policy and reachability. | 16–32 h provisional |
| R1 browser actions and reasoning | Isolated generic primitives, snapshots/candidate hashes, bounded model decision/report bridge, current refs, private manual-login phase; exact effect classification and readback. Real Chromium fixtures for the requested actions. | C0; integrates with E1 before live external execution. | 16–28 h |
| F1 private artifacts and clipboard | Staged downloads, approved hashed uploads, screenshot review/redaction, private clipboard import/export, access/quotas/retention, no execution or model disclosure by default. Cancellation and cross-project denial proofs. | C0; interfaces with R1 | 12–20 h |
| O1 supervision and effect authority | Durable pause, start/current pins, exact single-use per-action approvals and temporary destination grants, autosave request gates, budgets, cancellation, takeover, linked-run reconciliation, compatible signed receipts. Race/crash/uncertainty tests. | C0; integrates E1/R1/F1 | 12–20 h |
| U1 paste/review/run UI | New structured import and editable review, meaningful readiness, explicit Start, private login handoff, live deck/action/artifact/report integration, existing session proof, 360px/accessibility journeys. | C0; can build against frozen E1/R1/F1/O1 fixtures. | 10–18 h |
| V1 integration and release readiness | Combined real-browser/private-session/action/egress failure matrix, old-workflow regressions, canary/artifact leak checks, updater/version pins, migration/restore, documented target acceptance and rollback. | E1/R1/F1/O1/U1 | 12–24 h |
| D1 in-app language/image/file conversion | Retain original/private inputs, bounded validated extraction and consent, model-generated editable structured draft, ambiguity flags, explicit review/save and revisions; never grants scope. | C0/U1; provider/input custody contracts | 8–16 h additional |

The public/authenticated-public baseline is **84–148 engineer-hours**. Including
the now requested exact internal-target slice gives a provisional full browser
range of **100–180 engineer-hours**; automatic conversion adds **8–16 hours**.
Internal compatibility depends on real selected targets and routes. These totals
exclude persistent authentication/OAuth/credential enrollment, unsupported selected-site
transport adapters and a later change to post-takeover continuation semantics.
They include initial manual authentication, all requested
interactions and the existing supervision features plus real execution pause.

## Parallel critical path

After C0 freezes the shared envelopes and persistence boundary, E1, R1/F1 and U1
can proceed as separate work streams; O1 can develop against those frozen fixtures.
All converge before V1. No external browser execution precedes the integrated
egress/effect gate. D1 can follow the first paste-configurable UI instead of
holding up the requested initial interaction path.

For explicit assumptions, C0 → max(E1, R1→F1, O1, U1) → V1 is **46–82 engineering
hours** when O1 integrates concurrently. Requiring a sequential O1 integration
checkpoint gives **58–102 hours**. Putting I1 after E1 in that branch changes those
illustrative chains to **50–94**, or **62–114** with sequential O1 integration.
These calculations assume six independent streams, frozen interfaces and no
rework. They are engineering dependency estimates, not elapsed AI turnaround.
Longest practical path ends with real combined failure proofs and separately
authorized installed-target acceptance. A numerical AI wall-clock commitment
would be ungrounded until the initial integration proof establishes velocity.

External waits are distinct: selected-site examples/reachability, user review of settings,
manual authentication/MFA and each action approval, compatible installed runtime,
authorized target acceptance, required CI/reviewer decisions and explicit
merge/deployment authorization. The saved cloud has Chromium, Node and Python;
it lacks Incus and nft. Local Chromium/contract proofs therefore cannot establish
the target TAP/cgroup/Incus/nft boundary. That remains an acceptance requirement;
it does not authorize Duo fallback, production SSH or MCP execution.

## Relevant shipped sources

- `admin/backend/src/lib/operational-run-policy.js:27`: demo-only strict parser;
  `:108`: fixed/rule/model choice and mandatory account verification semantics.
- `admin/backend/src/lib/operational-worker-boundary.js:62` / `:362`: demo-only
  launch and preparation; `operational-agents-schema.js:21` and
  `operational-run-schema.js:27`: persisted workflow/action constraints.
- `scripts/a3-worker-supervisor.py:295`: host launch contract; `:393`: typed demo
  model observations; `:480`: hardened unit; `scripts/a3-network-fence.py:51`:
  TAP proxy/TURN fence.
- `scripts/a3-origin-proxy.py:178`: demo CONNECT/TLS proxy; `:234`: no resend
  after a possibly sent request. `scripts/a3-worker-guest.py:72`: fixed demo
  request policy; `:1080`: one-shot armed login.
- `admin/backend/src/lib/operational-run-coordinator.js:284` / `:329`: exact
  approval and one-use consumption; `:453`: takeover; `:558`: step reservation,
  effects, claims and uncertainty. `operational-control-grants.js:1`: session proof.
- `admin/frontend/src/components/operational-projects/LiveBrowser.jsx:8`: existing
  video/input, no clipboard/files. `RunDeck.jsx:298`: paused display/view state;
  coordinator has no standalone execution-pause operation.
- `admin/backend/src/lib/operational-public-web.js:12` /
  `operational-website-review-runtime.js:51`: public address and managed-host
  protection contracts. HTTP review remains a distinct successful workflow.
- `docs/plans/fractionate-project-credentials-backlog.md:124`: CB-01/CB-04 and
  related unaccepted boundary/integration work. `fractionate-agents-a8-reference.md:3`:
  deployed dashboard with pilot/acceptance limitations.


## Cloud implementation checkpoint — 2026-10-02

The dependency streams now have additive implementations and local proof fixtures. The integrated root has completed local authority rechecks, metering, source-memory/report suppression, live viewer lifetime, timer-driven execution and packaging regressions. The broader implementation is published as draft PR726 and remains gated by its reviewed installed-package contract and acceptance. PR725 merged independently reviewed browser viewport/fullscreen presentation at main `863ed48caa2ec9fff212b9e9a76ea0fc8e04d7c7`; it does not unlock general websites. Incremental repository publication/merge is authorized; production deployment remains outside authorization.

2026-10-03 release checkpoint: the isolated C0 editor is committed and pushed at
`24032ed714e823559a85902a1c15461f68961a0a` on
`browser/configuration-import-20261002`. Automatic approval review refused its
draft PR creation against `main`, citing the original withheld publication
authorization. The later release authorization is recorded above; a restatement
request is pending. Further external repository mutations are paused. PR726's
published head remains `dc8080c44dca6c2db81842709b7b48a6edc3e743`; fresh source
and local proof are recorded in the implementation report, not claimed as green
CI or installed capability.

The scope estimates above are engineering estimates, not elapsed implementation promises. Local Chromium can prove selected primitives, held-request approval and no external replay. It cannot establish the absent Incus/nft installation, operator-owned acceptance marker, Neko privacy/controller media, actual provider/multimodal path or selected public/authenticated/internal target acceptance. Those proofs and reviewed private storage/decoder wrappers remain the release activation gate. No Duo fallback or broad credentials are included.

See the [source-backed Nodus alignment](fractionate-browser-nodus-alignment-20261002.md) for applicable lifecycle/provenance/storage and deferred embedding/S3 contracts.
