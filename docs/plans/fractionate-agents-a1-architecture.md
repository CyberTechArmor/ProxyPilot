# A1 — first supervised agent architecture and pilot contract

Status: **design and pilot contract in review; live demo verified, guide/authority approval open**
(2026-09-25).
This is a review contract for A2–A8, not an implemented runtime or permission to
use an account. The official section list is [A1–A8](fractionate-agents-a1-a8.md).

## Pilot decision and acceptance boundary

The user selected a simple first workflow: navigate to a webpage and sign in,
then selected `demo.fractionate.ai` as a synthetic target and requested a landing page,
login dialog and example file. The standalone demo source lives in
`admin/frontend/demo/`. On 2026-09-25 the deployed website was freshly verified
at `https://demo.fractionate.ai`: ProxyPilot routes HTTPS to LXC
`fractionate-demo` (`pp-fractionate-demo`) at `10.185.17.210:4179`; its
`fractionate-demo.service` was active and its ACME certificate valid. The edge
returned 200 for `/` and `/api/session`, and 401 for an unsigned CSV download.
The public browser signed in, displayed the intended account and CSV, received
a download event, and signed out. See [live evidence](fractionate-agents-a1-evidence.md).
This is a **demo website deployment**, not an agent worker/runtime deployment or
A8 acceptance. The fixture account is `demo@fractionate.ai` with public sample
password `welcome-demo` unless changed by environment configuration. The
proposed terminal output is a **verified signed-in demo session** for that
account, or an explicit blocked/failed result. The user will create the first
Operations project and specify its final site; a different origin reopens
site-specific allowlist, account and acceptance proof. The deployed server, CSV and
build files match local hashes, but the source/build were uncommitted at
deployment time, so no commit can be claimed as their deployment identity.
Do not mark A1 complete
until the exact Operations guide, human authority and [pilot contract](fractionate-agents-a1-pilot-contract.md)
are approved.

| Decision | Current value | Required before A1 completion |
|---|---|---|
| Workflow and application | **Navigate to `https://demo.fractionate.ai` and sign in** | Demo website route, service, TLS, browser sign-in and CSV verified 2026-09-25; agent deployment remains A8 |
| Inputs and account | **Demo password form; public fixture account above** | Choose Operations project/guide version/hash and approve proposed binding; no real account credentials |
| Desired output and success | **`/workspace` plus `/api/session` returns the intended account and `/api/files` lists sample CSV** | Pin exact guide, time/action budget and failure evidence; never emit password/session token |
| Permitted changes | **One demo sign-in session, read-only file access and sign-out** | No account setting change, upload, project mutation or broad navigation; bound login attempts |
| Human approvals | **Human authorizes run start; no in-demo approval ceremony** | Approve proposed roles and named actors for configuration, start/stop/takeover and sensitive actions; unexpected challenge/consent still pauses |
| Optional document delivery | **Feasible design, outside initial sign-in acceptance until selected** | Source document, allowed PDF/CSV, project owner, local/S3 destination and authorization for one artifact write |

The first delivery remains **one supported workflow, one profile and at most one
active run**. No arbitrary web navigation, shell, filesystem, Dev Studio/MCP tool,
host management or broad application permission is implied. A guide can narrow
the task, but cannot grant a tool, domain, credential or action. Unknown
application behavior, an out-of-scope instruction, a failed authorization check,
or an uncertain external side effect stops progress and asks a human.

For this demo sign-in pilot, the action catalog is limited to launching the
isolated browser, visiting `https://demo.fractionate.ai`, entering the brokered
fixture credentials in the login dialog, verifying `/workspace` and authorized
session/file-list readback, optionally downloading the example CSV for read-only
verification, then signing out. The worker cannot save passwords,
export cookies, change account settings, consent to new permissions or solve
MFA/CAPTCHA by bypass. MFA, passkey, CAPTCHA and unfamiliar consent pages pause
for human takeover or end blocked. The demo has none of those ceremonies.
Login rate/attempt limits and logout/session
cleanup are part of the site-specific policy. A successful HTTP response or a
model assertion alone is not proof of a signed-in account.

### Optional download and project artifact delivery

The agent **can be designed** to retrieve one approved PDF or CSV after login
and attach it to that *Operations* project, but this is a separate action grant
and acceptance step. It is not implemented today and is not silently included
in the sign-in pilot. The human selects the source/download pattern, project ID,
file type/size ceiling, retention and either a reviewed local artifact root or
a configured project-scoped S3 bucket/prefix. No browser download path or model
suggested filename becomes a server filesystem path or S3 key. The browser
hands the downloaded bytes to a narrow broker that validates final origin and
redirects, content length/type/signature, byte cap and SHA-256, then stages,
commits and readbacks one immutable project artifact. Store source URL metadata
only after removing tokens/query secrets; record run/action/actor, checksum,
destination reference and disposition. An interrupted or duplicate transfer
reconciles by an idempotency key and checksum; uncertain publication is not
blindly retried. The worker receives only the opaque artifact ID. It cannot
list/write other projects, choose an arbitrary local path/bucket or turn file
content into instructions. Upload may require its own human approval depending
on the selected project's data policy.

Current Operations evidence storage accepts private PNG/JPEG in a dedicated
demonstration workflow, not general PDF/CSV documents. Dev Studio's separate
asset library accepts text files such as CSV up to 2 MiB, but its project IDs,
authorizations and model-summary behavior do not make it an Operations folder;
PDF is not accepted there as a document asset. The existing S3 destination
configuration is for backups. Its low-level client may inform a future adapter,
but backup credentials/bucket are not automatically a project artifact grant.
Local or S3 artifact storage needs a project-bound record, private retrieval,
quota, ACL/prefix isolation, retention, backup/restore and deletion policy before
activation. PDF/CSV bytes remain untrusted data; storing them does not imply
parsing, summarizing, sharing or guide approval.

### Run acceptance envelope to fill after pilot selection

At start, the human must supply the selected workflow's typed inputs and the
exact current approved Operations guide version. The server records project ID,
profile revision, version ID, version hash, actor, authority snapshot reference,
credential-binding revision, policy revision and budget before any worker is
launched. The selected guide's exact approved bytes and evidence manifest are
read through the existing authorized Operations service; withdrawal, project
archive, grant loss and account ineligibility are checked again at each boundary.
A newly approved version never silently replaces a running pin. If policy calls
for stopping on withdrawal, the run stops; it never falls back to an older guide.

The [pilot contract](fractionate-agents-a1-pilot-contract.md) proposes exact
login-attempt, time, tool, cost and worker ceilings for review; these are not
approved or implemented. The A2–A8 implementation must persist
hard ceilings for elapsed time, provider cost/tokens, tool calls, external writes,
bytes and worker resources. A limit is enforced server side before an action and
at the worker/broker boundary; UI estimates are informational. Default-deny is
required when an input, scope, price, quota or authority revision is missing.
The result must include the verified output reference, outcome, action/approval
ledger, costs, version pin, and a concise reason for completed, blocked,
cancelled, failed or takeover outcomes. Secrets and private page content are
excluded from ordinary progress events.

## Ownership and stable identities

Operations `ops_projects.id` is the human work authority root. It is distinct
from a Dev Studio project and from a host/Infisical “agent.” Do not alias IDs,
infer grants from equal names, or grant an agent platform-admin access.

| Entity | Stable key and parent | Authority and lifetime |
|---|---|---|
| Operations project | Existing `ops_projects.id` | Existing owner and current per-account grants control visibility, guide and work actions; archive freezes new work. |
| Agent profile | New opaque UUID, `ops_project_id` FK | Configuration only: workflow type, allowed actions/origins, assigned guide and revision, budgets, supervisor set. A2 creation launches nothing. Display name is mutable, never an authority key. |
| Guide assignment | Profile ID + exact `ops_guide_versions.id` + hash | Assigned only by an authorized current project actor; independent guide approval remains required. No evidence text is permission. |
| Agent run | New opaque UUID, one project/profile/version pin | Initiated by a currently authorized human; immutable initial policy/guide references and durable state. Separate from `ops_manual_runs`, which remains a person's report. |
| Worker attempt | New opaque UUID + run ID + monotonically increasing attempt/fence | One isolated process/session per attempt. It may act only while its lease and run authority are current. Replacing a worker does not reuse its session or claim uncertain actions succeeded. |
| Credential binding | New opaque UUID + profile/project + external credential reference and revision | A4-only, operator-authorized, never a display-name match or a secret stored in the profile/guide. Revocation invalidates future broker use and requests active-run stop. |
| Human approval | New opaque UUID + run/action digest + approver ID + expiry | One action, one policy/guide/run state; checked transactionally just before execution. No blanket approval or self-issued model approval. |

For A2, a current eligible Operations member with owner/editor rights may propose
profile configuration, but a profile's *effective* actions must be the
intersection of project policy, actor grant, workflow policy and assigned guide
scope. Exact permission details need the pilot decision. Project owner status
cannot bypass independent guide review or approve a privileged host/provider
action by itself. A reviewer may approve guide content, not automatically a run
action. A supervisor's approval role must be assigned explicitly and evaluated
against the current account and project state at action time. The model and
worker have no authority to approve their own work.

## Proposed boundary and flow

```text
human UI → session/CSRF/current-account authorization → run coordinator/DB
                                      │                 │
                             immutable guide pin   durable events/approval inbox
                                      │                 │
                            launch broker (typed) ← policy + lease/fence
                                      │
                          isolated, unprivileged worker
                            │                  │
                    provider adapter       narrow action broker
                    (server budget)        (allowlist + credential broker)
                                               │
                                        selected application only
```

The coordinator handles creation, authorization, policy, state and observation;
it does not execute model-selected host commands. The launch broker receives a
typed run reference and immutable policy digest, not raw shell or arbitrary
container configuration. A3 must choose and verify a target environment with
private workspace, process/user separation, network egress policy, resource and
time ceilings, and cleanup. Existing privileged backend/host-agent/Incus
interfaces are not the worker sandbox. No generic `host-exec`, MCP mutation,
terminal, storage, deployment or setup call enters the agent tool catalog.

The A4 provider adapter accepts only a chosen provider/model allowlist, bounded
request, run ID and budget reservation. It meters actual usage, records response
IDs and fails closed on unknown price/usage. Provider text and tool proposals are
untrusted. The action broker parses a strict typed request; checks run, lease,
current account/grant, profile/policy revision, guide status, domain/action
allowlist, budget and approval; then performs one idempotency-keyed action.
The application-specific adapter defines readback and side-effect semantics.
The selected application and initial action catalog are in the pilot contract;
the A3–A5 implementation and enforcement remain future work.

Credential lookup belongs to a broker outside model input, guide text, page
content, logs and progress streams. A4 decides between a scoped brokered secret
and an application-specific token. Existing Infisical Agent Proxy is not assumed
to hide the secret from an identity that is Admin of its own project. OpenBao
AppRole explicitly lets its holder read assigned values. Both require real target
isolation, scoped account permissions, rotation and revocation evidence before
use. Infisical administrator sign-in/MFA and human recovery remain human
management steps; an agent cannot bypass them.

## Durable state, observation and recovery

Planned run states: `draft` → `queued` → `starting` → `running` ↔
`awaiting_approval`/`awaiting_human` → `completed`/`blocked`/`failed`/
`cancelled`/`taken_over`. `cancelling` is a durable intermediate state. Every
transition checks expected revision, actor/worker fence and legal predecessor in
one transaction with an append-only event. Start uses an idempotency key and a
unique active-run constraint for the pilot. Events have monotonic sequence,
timestamp, actor/worker identity, policy and guide pin, action digest and
redacted summary. A terminal result is immutable; correction is a new linked
disposition, not an overwrite. Stream/poll clients resume from an event cursor,
recheck project membership on every read, and never treat a socket message as the
source of truth. View-only observation is the default.

Before a sensitive action, the run enters `awaiting_approval` and stores a
canonical action digest, target, scope, expected effect, expiry and current
policy/authority revision. Only an eligible, explicitly designated human may
approve that exact action. A changed target, guide, grant, budget or expiry
invalidates the approval. Rejection stops or returns the run to a constrained
human decision state. The worker receives a one-use capability for the approved
action, never a broad approval flag.

Cancellation first fences new broker actions, then terminates the worker and
reconciles any in-flight external action through a read-only check. A crashed
worker loses its lease. Restart may resume only from durable events and known
application state; uncertain writes require human takeover, never blind replay.
Timeout, provider outage, account revocation and supervisor loss produce an
explicit blocked/failed state with recoverable evidence. Human takeover revokes
worker authority before presenting any interactive application session; return
to agent work requires a fresh authorization and a new attempt.

## Trust boundaries and failure posture

- Approved guide bytes are reviewed instructions, **not** executable policy.
  Page text, imported evidence, screenshots, model output and provider response
  are data. Prompt injection, hidden page instructions and apparent approvals in
  that data cannot alter tool/domain/credential scope.
- The backend currently has root-equivalent host surfaces (S6). The new worker
  must have no route to those surfaces. A3/A8 must demonstrate isolation on the
  selected target, including host escape, unauthorized calls, filesystem and
  network reachability, descendant teardown and budget enforcement.
- Approval and credential records in backend-writable state alone are not a
  boundary against a compromised root-equivalent backend. A3/A4 must locate
  enforcement and protected keys outside that authority or explicitly stop
  before real credentials/host deployment. A8 cannot accept a config-only claim.
- No release or live action follows from this design. Operations/evidence gates
  remain false by default; manual history and immutable migrations are retained.

See the [source and dependency register](fractionate-agents-a1-sources.md) and
[acceptance matrix](fractionate-agents-a1-acceptance.md). The
[project access and credential backlog](fractionate-project-credentials-backlog.md)
captures the new owner visibility modes and contributor-specific OpenBao →
Infisical/Vaultwarden requirement. The [A2 prompt](fractionate-agents-a2-prompt.md)
is limited to project access, profiles, permissions and guide assignment after
review; vault integration remains in A4.
