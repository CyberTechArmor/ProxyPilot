# A1 acceptance matrix and A2–A8 refinements

Date 2026-09-25. A1 scope/design is complete; run and release gates remain open.
Read with the [architecture](fractionate-agents-a1-architecture.md),
[source register](fractionate-agents-a1-sources.md) and official
[eight-section plan](fractionate-agents-a1-a8.md). `Open` means no completion
claim for that later implementation or operational authorization.

## A1 review gate

| Criterion | Evidence / result | State |
|---|---|---|
| Preserve baseline | Historical clean `batch-03-charcoal` HEAD `d5f6483`, tree `f984051d` is captured in adjacent `agents-a1-evidence/`. The review preserved the then-uncommitted demo and A1 docs; no migration or agent runtime edit. | Met for preservation; current status recorded separately |
| Select one workflow, application, output and authority boundary | User selected webpage navigation/sign-in at `demo.fractionate.ai`; the demo site's live HTTPS route, service, TLS, public sign-in/account/CSV/download and unsigned-file denial were verified 2026-09-25. The [pilot contract](fractionate-agents-a1-pilot-contract.md) defines safe implementation defaults and fail-closed authority checks. Exact project/site, approved guide, human actors, enforced limits and provider choice are captured before an authorized run, not before A1 design closure. Project artifact delivery remains a separate action grant. | **A1 design met; run authorization open** |
| Define architecture and identity/authority | A1 architecture describes distinct Operations project/profile/run/worker/binding, guide pin, broker, durable state, approval and recovery. Site and human bindings are resolved through later interfaces. | Design met; implementation pending |
| Source and security dependencies | Source register maps reuse/gaps and SEC-01–05/INF-01–04, with S6 and target proof retained. | Design met; target-specific proof remains A3/A8 |
| Refine A2–A8 and write A2 prompt | Matrix below and executable A2 prompt include optional site input and disabled profiles; no A2 work performed. | Met |

## Acceptance-sized sections

| Section | Exit contract and dependencies | Verification strategy and deployment boundary | State |
|---|---|---|---|
| A2 — project access, site input, profiles, guide assignment | Add optional owner-managed HTTPS site origin field, owner-selected hidden/read-only/collaborative discovery and approved membership semantics from the [backlog](fractionate-project-credentials-backlog.md), then immutable-ID profile schema, project FK, revision and audit; CRUD and optional exact approved-guide assignment. A project or disabled profile needs no site/guide yet. Enforce current eligible account/project membership, independent guide approval, archive/withdrawal/stale-revision refusal, cross-project denial and no admin bypass. Project/profile changes create no worker, run, provider call or credential. | Pure store and native HTTP/SQLite tests for hidden-name leakage, site validation/change, preset changes, membership races, grant loss, pending/deleted account, archive, cross-project IDs, revision and denial audit; accessible browser flow including 375px. Feature false by default; additive migration only. No deployment or provisioning in A2. | Ready for separate A2 implementation |
| A3 — isolated worker | Select one target and typed launch/stop contract, run workspace, egress/tool restrictions, resource ceilings, lease/fence and cleanup. Prohibit host-root shell/management API access. Resolve selected pilot's S6/SEC-01/04 dependency. | Disposable target escape/unauthorized operation, network and file reachability, CPU/RSS/process/time/disk, child teardown, cancellation and stale worker tests. Target isolation must be observed, not inferred from config. No real account or key. | Pending A2 |
| A4 — credential and provider broker | One provider/model route and one application credential mechanism, explicit binding revision, dedicated scoped account, cost reservation/meter, rotation/revocation, MFA-compatible human management and no secrets in model context/log/stream. Requires A3 boundary proof. | Disposable provider/application integration with positive/negative scope, egress/proxy, leak scans, budget overrun, rotation and active-session revocation; record actual semantics. No live key until separately authorized A8. | Pending A3 |
| A5 — bounded execution loop | Explicit user start; atomic guide/profile/policy pin; one active run; typed action broker, approval digest, durable events/results, cancellation fence and redacted observation. Inputs are untrusted; guide/evidence/page/model text cannot expand policy. | One synthetic end-to-end workflow; injection, wrong domain/action, stale guide/grant, duplicate start, approval race, provider/tool errors, unknown price/usage, budget and stop tests. No real target. | Pending A4 |
| A6 — supervision UI | Minimal Agents/Flightdeck overview and one-run detail: explicit start/stop, view-only stream, redacted progress, approval/help inbox and durable result. Existing Dev Studio routes/IDs remain stable. | Role-based browser journeys, stale/revoked access, refresh/reconnect, keyboard, two themes and six widths including 360/375px form completion. No dead control or implicit takeover. | Pending A5 |
| A7 — practice and recovery | Disposable rehearsal uses same policy/worker path, with synthetic credentials. Crash/restart, uncertain side effect reconciliation, basic critique, human takeover and explicit resume with new attempt/fence. | Kill coordinator/worker mid-read, mid-approval and mid-write; prove no blind replay, stale worker rejection, grant/key loss, takeover ownership, and durable terminal results. | Pending A6 |
| A8 — release and supervised pilot | Select and approve deployment/environment, exact current guide/account/action scope; resolve applicable S6/SEC/INF and media/storage gates, final-head review/CI, backup/restore, migration/rollback, operator runbook and one real supervised run. | Real target isolation and auth/credential tests, expected output readback, approval/stop/takeover/recovery, audit/cost/result and rollback proof. Requires separate deployment/live authorization. | Pending A7 |

The selected first acceptance is **sign-in verification only** unless the user
explicitly includes document delivery in the pilot contract. If included, A3
must isolate downloads; A4 must bind the source account and destination grant;
A5 must add a single typed `store_project_artifact` action with byte/hash,
idempotency and readback; A6 must display artifact status without leaking its
content; A7 must reconcile interrupted transfers; and A8 must prove local ACLs
or S3 bucket/prefix IAM on the target. This remains inside the same eight
sections only after the added dependency and estimate are reviewed. It never
authorizes direct worker writes to a host path or backup S3 destination.

For sign-in acceptance, the disposable and then authorized target tests must
distinguish: verified account indicator; wrong/expired credential; unexpected
redirect or origin; MFA/passkey/CAPTCHA/consent requiring human takeover; account
lockout/rate limit; timeout or cancelled browser; and logout/session cleanup.
No test may count a navigation success, a login form disappearing, or a model
statement as proof of the intended account. The run result and progress must
not contain the credential, session cookie or private page contents.
The live deployed demo and matching local build provide the deterministic
account and CSV fixture for those tests. Its deployed archive was assembled
before this source was committed and has no recorded commit identity. It is a target application,
not an agent runtime or proof of the future worker/A8 deployment boundary.

## Cross-cutting negative cases

Every section must preserve existing Operations B1–B4 and D1–D4 contracts,
false-default feature gates, migration history and manual runs. An owner or
platform admin cannot bypass independent guide review. A revoked account or
grant cannot continue observing or approving. A page/evidence/model assertion
that “approval was given” has no effect. A worker cannot choose its own
credential, route, executable or provider model outside the pinned policy.
Uncertain external writes require a human decision. These are product tests
where source changes occur; A1 is documentation-only, so historical source
tests are cited as historical rather than rerun.

## Estimate and release accounting

The official eight sections remain unchanged. The earlier 8–12 focused
conversation estimate is provisional, especially until the pilot and target
are chosen; A3/A4/A8 may require more than one review iteration. No percentage
or production readiness is inferred from completed foundation batches.
The merged foundation's PR checks and D4's 127-test/browser/build record apply
to their saved revisions, not to future A2–A8 implementation. Required security
CI and selected-target acceptance run again on their exact revisions.
