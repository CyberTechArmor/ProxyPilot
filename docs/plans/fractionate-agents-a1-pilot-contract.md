# A1 pilot contract — demo sign-in (review draft)

Status: **proposed, not approved** (2026-09-25). This contract fixes the
implementation boundary for review; it grants no authority to launch an agent.
The public fixture website is already deployed. It is an application target,
not an agent worker or evidence that A8 deployment is accepted.

## Project, guide and people

| Field | Proposed contract | Approval needed |
|---|---|---|
| Operations project | One active `ops_projects.id`; no Dev Studio or demo-site project ID substitution. The user will create the first project. | **Record its exact UUID and owner after creation.** No project was identified in the A1 source/evidence. |
| Guide | The project's exact current, independently approved, nonwithdrawn `ops_guide_versions.id`, version number and `content_hash`, read through Operations at profile assignment and pinned at run start. No fallback to an older version. | **Choose or create the guide, supply its version ID/number/hash and independent approver.** No approved pilot guide was identified. |
| Profile configuration | Current eligible project owner or editor may create/edit the proposed profile and assign the approved guide; an archive, grant loss, stale revision or guide withdrawal refuses the change. Profile creation launches nothing. | Confirm this role choice and name the initial configurator. |
| Run start | A current eligible owner or operator may explicitly start one run after the guide, binding and limits are pinned. An editor or reviewer needs a separate operator grant to start. | Confirm this narrower proposed role choice and name the initial starter. |
| Stop and takeover | The starter and project owner may stop or take over; a separately named supervisor may do so only with an explicit project-scoped grant. Stop fences broker calls before worker teardown. Takeover fences the worker before exposing the browser session. | Name the supervisor/takeover actor, or choose owner plus starter only. |
| Sensitive-action approval | Only a separately designated current eligible human approver for this project may approve one exact action digest; the starter/model cannot self-approve. Existing guide reviewer status alone grants no run-action approval. | Name approver(s) and whether the starter may ever be an approver. Proposed default: independent human for any new consent, account change or artifact write. |

The existing Operations roles and independent guide-approval rule are grounded
in `docs/features/operations.md` and `operational-projects-logic.js`. Run and
approval roles above are **new policy proposals**, not existing product grants.
The owner cannot waive guide review; a platform admin without project
membership gets no implicit access.

The user will also specify the first project's site. `demo.fractionate.ai` is
the currently verified synthetic target, not a substitute for that final
choice. A changed origin requires a new allowlist, credential/account review
and target acceptance evidence before a run. The requested project
hidden/read-only/collaborative modes and contributor-specific credential
backlog are in [project access and credential phases](fractionate-project-credentials-backlog.md).
Project discovery, project membership, credential sharing and agent run
authority remain distinct grants.

## Fixture binding, allowed actions and ceilings

Bind one future A4 credential reference to this project/profile and the
`demo@fractionate.ai` fixture account. The public sample password
`welcome-demo` is used only by the application credential broker, never copied
into a guide, model prompt, run event or ordinary progress. Record a binding
revision. Removing it fences future broker use, stops an active run, performs
same-origin logout where possible and discards the isolated cookie jar; record
whether logout succeeded. Because the demo keeps server-side sessions for up to
eight hours, a missing logout must be reported as uncertain revocation rather
than claiming that deleting a binding invalidated the website session. No real
account or provider key is authorized by this fixture choice.

| Limit | Proposed initial value | Basis / review |
|---|---|---|
| Navigation and action allowlist | `https://demo.fractionate.ai` only; open landing page/dialog, enter bound fixture, submit login, read `/workspace`, `/api/session`, `/api/files`, optionally download the one `sample-metrics.csv` for read-only verification, then sign out. Same-origin redirects only. No uploads, account/settings changes, arbitrary links, shell, host/ProxyPilot/Operations mutations or project artifact write. | Based on the deployed site and A1 architecture. Remote font requests may be denied with local fallback; A3 must test actual browser egress. |
| Login attempts | At most **2 submissions per run**, then stop; no retry after 429/lockout. | More restrictive than the site's 8 failed attempts per IP per 5-minute window (`demo/server.mjs`). Proposed agent policy. |
| Time and tool calls | **5 minutes** wall time; **20** brokered browser actions; one active run/profile and one worker attempt unless a human authorizes a new attempt. | Proposed hard server and worker ceilings, not implemented or verified. |
| Provider spend | **US$0.25 and 10,000 total tokens** per run; fail closed if model price or usage is unknown. | Proposed ceiling; A4 must choose the provider/model and verify its metering before approval. No provider call is authorized now. |
| Worker resources | **1 vCPU, 512 MiB memory, 128 MiB private temporary disk, 1 browser process tree**, with descendant teardown. | Proposed A3 cap; the demo website guest's observed 1 CPU/1024 MiB is a different resource and proves nothing about worker isolation. |
| Data transfer and writes | One read-only CSV download, maximum **1 MiB**; **zero** external/project writes. | Fixture is 159 bytes. Staged bytes remain private and are removed at run end. |

Every ceiling is enforced before each action and at its broker/worker boundary.
Missing authority, scope, price, quota or current guide fails closed. These
numeric values and provider/model choice require user approval before the A1
gate can close; they are not deployed controls.

## Success, failure and human handoff

Success requires a browser at `/workspace`, an authenticated `/api/session`
readback naming `demo@fractionate.ai`, and `/api/files` listing the expected
sample CSV. The optional read-only download may strengthen target proof but is
not a project delivery or required sign-in criterion. Record project/profile/run
and actor IDs, exact guide version/hash, binding and policy revisions, URL
origin, redacted action/approval ledger, timings, metered cost, outcome and
logout disposition. Do not record the password, cookie, full private page or
file bytes in progress/events. A navigation 200, disappearing dialog or model
claim alone cannot establish success.

Wrong/expired credential, 429, unexpected origin/redirect, missing account
readback, budget exhaustion, cancellation or failed logout produces an explicit
blocked/failed/cancelled result with safe evidence. MFA, passkey, CAPTCHA,
unfamiliar consent, account recovery or a new permission request pauses before
interaction and alerts the named supervisor. The supervisor sees the origin,
challenge type and pending action, then takes over or ends blocked. The worker
does not solve or bypass the challenge. Resumption requires a fresh run/attempt
authorization, current guide/grants/binding and a new worker fence.

## Optional Operations artifact grant

**Default: excluded.** Attaching a PDF/CSV to an Operations project is a
separate selected action and acceptance test. If chosen, specify the source
URL/file, allowed type and byte cap, project UUID, project owner, approver,
retention and either a reviewed project-scoped local root or a project-scoped
S3 bucket/prefix and IAM. A narrow broker validates origin/redirect, type,
size and SHA-256; commits one immutable artifact with an idempotency key and
readback; and returns only an opaque artifact ID. Neither the current
Operations PNG/JPEG evidence store nor Dev Studio assets nor backup S3
credentials grant this action. The separate design and A3–A8 proof in the
[acceptance matrix](fractionate-agents-a1-acceptance.md) apply if selected.

## Decisions required to close A1

1. Exact Operations project UUID/owner, final site origin and exact independently
   approved current guide version ID, number, content hash and approver.
2. Accept or edit the proposed configurator, starter, stop/takeover and
   sensitive-action approver roles; name the first human actors.
3. Accept or edit the fixture binding and revocation behavior, allowed actions,
   two-attempt rule and numeric time/tool/cost/resource ceilings; choose the
   provider/model for the spending rule.
4. Keep project PDF/CSV delivery excluded (proposed), or separately select its
   source, destination, grant, limits and approver.
5. Choose the initial project discovery mode and whether credential
   replication destinations are selected per credential or always required;
   confirm any named recipients before sharing a value.

A1 remains **in review** until these choices and required authority are
recorded and its acceptance gate is met. A2 implementation is a separate next
section and has not begun.
