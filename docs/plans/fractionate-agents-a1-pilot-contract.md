# A1 pilot contract — demo sign-in design

Status: **A1 design complete; operational authorization pending** (2026-09-25).
Policy amendment (2026-09-26): the user replaced the illustrative numeric
ceilings below with owner-defined, per-project limits. An unset field is
unbounded by project policy. One browser process tree, the action and origin
allowlists, fencing, teardown and the requirement to prove the worker's OS
boundary remain mandatory. The values in the historical table are no longer
defaults or prerequisites for a run.
This contract fixes implementation defaults for the synthetic sign-in workflow;
it grants no authority to launch an agent or use a real account. The user will
create the first Operations project and enter its site through the interface.
Neither action is required to close A1.
The public fixture website is already deployed. It is an application target,
not an agent worker or evidence that A8 deployment is accepted.

## Project, guide and people

| Field | A1 design default | Required before an authorized run |
|---|---|---|
| Operations project and site | One active `ops_projects.id`; no Dev Studio or demo-site project ID substitution. Owner enters an optional site origin in Operations UI; absence does not block project or profile creation. | Current project UUID, owner and explicit site origin must be present and checked at run start. A changed origin requires a new scoped allowlist and target proof. |
| Guide | The project's exact current, independently approved, nonwithdrawn `ops_guide_versions.id`, version number and `content_hash`, read through Operations at assignment and pinned at run start. A profile may remain unassigned and disabled. No fallback to an older version. | Exact approved guide ID/version/hash and independent approver must exist before assignment or run. |
| Profile configuration | Current eligible project owner or editor may create/edit a profile; archive, grant loss or stale revision refuses the change. Only an independently approved current guide may be assigned. Profile creation launches nothing. | Current account and project grant are checked for each edit. A named configurator can be selected through the UI. |
| Run start | A current eligible owner or operator may explicitly start one run after the guide, binding and limits are pinned. An editor or reviewer needs a separate operator grant. | A named starter, current grant and exact action scope are checked at run start; this A1 document grants no run permission. |
| Stop and takeover | The starter and project owner may stop or take over; a separately named supervisor needs an explicit project-scoped grant. Stop fences broker calls before worker teardown. Takeover fences the worker before exposing the browser session. | Assign any additional supervisor in the product before use; the current eligible owner/starter are still rechecked. |
| Sensitive-action approval | Only a separately designated current eligible human approver may approve one exact action digest; the starter/model cannot self-approve. Existing guide reviewer status alone grants no run-action approval. | Designate an independent approver before a sensitive action; otherwise block it. New consent, account changes and artifact writes remain outside the initial sign-in scope. |

The existing Operations roles and independent guide-approval rule are grounded
in `docs/features/operations.md` and `operational-projects-logic.js`. Run and
approval roles above are **design defaults**, not existing product grants.
The owner cannot waive guide review; a platform admin without project
membership gets no implicit access.

`demo.fractionate.ai` is the verified synthetic target used to design and test
the first workflow. The owner may enter another site through the Operations
project interface later; its origin is not inferred from this fixture. The
project currently has only name/description fields, so A2 must add a dedicated
owner-managed site origin field and accessible input. Missing or changed origin
blocks a run until allowlist, credential/account and target acceptance checks
are current. The requested project
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
numbers are A1 implementation defaults, not deployed controls or authority to
spend. A4 must select and verify provider/model metering; A8 must obtain the
actual run and deployment authorization before any real-key pilot.

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

## Deferred configuration and release gates

The owner creates the first project and enters its site in the A2 interface.
A2 may create access policy and disabled, unassigned profile metadata before
that happens. The A1 design defaults are hidden project discovery, owner-approved
membership requests for read-only/collaborative discovery, and explicit
per-credential destination selection. No secret is shared by project membership
alone. Those defaults can be changed through reviewed policy work, not inferred
from a site's text or a credential name.

Before any run, record the exact project/site, independently approved current
guide and human starter/supervisor/approver grants, fixture or other credential
binding, allowlist and enforced ceilings. A4 chooses a provider/model and proves
metering. A8 obtains separate deployment and live-run authorization and target
proof. Optional PDF/CSV project delivery remains excluded until selected with
its own source, destination, grant, limits and approver. These are **run/release
gates**, not A1 design completion requirements. A2 implementation has not begun.
