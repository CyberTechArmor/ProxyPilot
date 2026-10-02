# Public website reviews

Public website review is a separate read-only workflow in Operations. It accepts
the current approved guide, a user-selected public HTTP(S) URL and a review
objective. It does not use the Demo sign-in profile, synthetic hard-rules JSON,
website credential bindings or the configured broker synthetic task ledger.

An authorized guide save publishes its immutable approved version under the
existing guide-save policy. Saving a project, guide or review agent never starts
a run. The owner separately consents to sending the approved guide, objective
and extracted public content to the existing model provider. Each run then
requires an explicit Start action with the saved agent revision and guide pins.

## Dashboard path

In Operations, open a project and choose **Website reviews**. The **Agents** section also offers an **Open website reviews** action when this runtime is available.

1. Save and approve the project guide. Plain instructions such as a website summary objective are supported; the synthetic sign-in hard-rules block is not required for this workflow. The review strategy accepts guide documents up to 3,500 UTF-8 bytes.
2. Create a review agent with a name, public URL, objective and limits. Save pins the current approved guide and starts no work.
3. The project owner reviews and explicitly gives model consent. The model receives the approved guide, objective and extracted public page content. Changing saved settings resets that consent.
4. Check readiness and choose **Start website review**. Each start uses the displayed saved configuration and guide pins. Saving settings or giving consent never starts a review.
5. Read the result with its cited source URLs, excerpts, content hashes, model usage and recorded cost. **Cancel website review** stops future page requests and result publication; an already accepted model call may still settle against its reserved budget.

The supported strategy reads public HTML or plain text over HTTP(S) on standard ports, without browser JavaScript, sign-in, website credentials or writes. Robots restrictions, authentication, paywalls, bot protection and client-rendered pages produce an explicit blocked or unsupported outcome. Those protections are not bypassed.

Legacy profiles under **Existing synthetic sign-in agents** and **Agent runs** use the separate demo sign-in workflow. Assigning a freeform website guide to a legacy Researcher profile does not enable public website review there.

Missing runtime bridge, provider or price configuration appears in readiness and disables Start. The reviewed runtime components must be installed before a live review can run; this UI does not enroll credentials, activate a broker or deploy those components.


## Supported scope

The first strategy is `http_extract_v1`: GET requests for publicly accessible
HTML, XHTML or plain text, ordinary redirects, and a bounded sample of ordinary
same-origin hyperlinks. Server-rendered content is supported. Browser JavaScript
is not executed. A script-only shell yields `CLIENT_RENDER_REQUIRED`; login,
subscription, bot-blocked and robots-disallowed pages yield explicit unsuccessful
outcomes. The runtime does not bypass protections. A status 200 without useful
readable content is not success.

The crawler uses IPv4 DNS answers and standard HTTP/HTTPS ports. IPv6-only sites,
other ports, non-text files, unsupported encodings and inaccessible destinations
are unsupported. A site can change or reveal a restriction after start; readiness
reports runtime/configuration eligibility, not a promise that the site can be read.

The destination policy refuses private, loopback, link-local, metadata, reserved
and installation-managed addresses, vault hostnames and host-management paths.
Every redirect is revalidated. Every IPv4 DNS answer is screened and a selected
answer is pinned to the actual socket; no second resolver or environment proxy
can redirect the connection. TLS certificate validation remains enabled. Robots
policy is checked before a page request, including a new redirect origin. The
crawler sends no cookies, authorization headers, forms or website writes.

Limits are typed configuration, separate from freeform guide text:

| Limit | Default | Ceiling |
| --- | --- | --- |
| Pages | 3 | 3 |
| Run time | 120 seconds | 180 seconds |
| Model tokens, input and output | 20,000 | 20,000 |
| Model spend | USD 0.05 | USD 0.10 |
| Model calls | 1 | 1 |
| Model output | 1,500 tokens | 1,500 tokens |
| Page response | 512 KiB | 512 KiB |
| Total responses, including robots and redirects | 1 MiB | 1 MiB |
| Requests, including robots and redirects | 20 | 20 |
| Redirects per request | 5 | 5 |
| DNS/request wait | 10 seconds | remaining run time, if shorter |
| Robots response | 64 KiB | 64 KiB |

Project agent limits reduce the selected ceilings. Approved guide documents are
limited to 3,500 UTF-8 bytes and objectives to 1,000 UTF-8 bytes. At most one run
per review agent, two per project and four per installation can be active.

## Runtime and evidence

The backend extracts content using the bounded HTTP transport. It sends only
bounded source excerpts to the typed A3 `public_review_model` method. A3 builds
the fixed review prompt, explicitly treats website content as untrusted data,
and calls A4 `review_call` with no website credential. There are no model tools
or browser actions. Page or model instructions cannot request another operation.
The existing A4 provider key, operator-confirmed price table and reservation /
settlement ledger are reused; no provider secret reaches the dashboard or page.

A3 signs a `ppr1` Ed25519 receipt binding run/call/task/guide/request/response
hashes, usage, settlement and price-table revision. Node verifies the receipt
before accepting the review. JSON usage key order does not affect this comparison;
the two exact nonnegative integer fields must match. The request hash normalizes
the numeric USD limit as an IEEE-754 hex string to agree between Python and Node.

A completed run contains the actual provider review, findings, limitations,
citations resolved to sampled source URLs, model usage/cost and receipt. Evidence
contains final source URLs, title, extracted-content hash, exact bounded excerpt
and its hash, extraction time, activity and immutable guide/task/config pins.
The full response body is not stored. The model response must be valid review
JSON and cite sampled source IDs; malformed, empty, uncited or out-of-budget
output is recorded as unsuccessful.

Run states are `queued`, `extracting`, `reviewing`, `completed`, `blocked`,
`failed`, `cancelled` and `interrupted`. Guide/config/project/access changes,
withdrawn consent or feature disable stop the run before its next request or
publication. Cancellation aborts further fetches and suppresses review publication.
A model call already accepted by the provider may still settle; uncertain spend
remains reserved. Restart interrupts active work without replay. Finished evidence
and run identity/pins are immutable database records.

## Access and API contract

Owners/editors configure review agents. Only the owner changes model consent.
Existing owner/operator/editor/reviewer roles explicitly start/cancel; project
members inspect. An unrelated administrator has no project access bypass.
Every route uses the central authenticated session, existing CSRF handling,
project/account permissions and Operations/Agent metadata/Agent runs gates.
No MCP tool exposes this workflow.

All endpoints are relative to `/api/operational-projects/:id`:

| Method | Path | Response / body |
| --- | --- | --- |
| GET / POST | `/website-review-agents` | `{agents}` / `{agent}`; create returns 201 |
| GET / PATCH | `/website-review-agents/:agentId` | `{agent}`; PATCH requires quoted agent `If-Match` |
| PUT | `/website-review-agents/:agentId/model-consent` | `{agent}`; owner + quoted `If-Match` |
| GET | `/website-review-agents/:agentId/readiness` | `{readiness}` |
| GET / POST | `/website-review-runs` | `{runs}` / `{run}`; explicit start returns 202 |
| GET | `/website-review-runs/:runId` | `{run}` |
| POST | `/website-review-runs/:runId/cancel` | body `{}`, response `{run}` |

Agent create body: `{name,url,objective,guide_version_id,guide_hash,limits?}`.
PATCH accepts these fields and resets earlier model consent. No credential,
connection, headers, provider key or arbitrary actions are accepted.

Consent body when enabling:

```json
{
  "enabled": true,
  "reviewed_statement": "Send this review agent's approved guide and public page content to the model provider"
}
```

Withdraw with `{ "enabled": false }`. Consent changes increment agent revision.
Explicit start body:

```json
{
  "agent_id": "<saved review agent UUID>",
  "agent_revision": 2,
  "guide_version_id": "<current approved guide UUID>",
  "guide_hash": "<approved guide SHA-256>"
}
```

Readiness is `{contract_version:"website-review.v1",can_start,checks,pins,capabilities}`.
Checks name the unmet guide, consent, project, feature, access, provider, extraction
or concurrency condition and its next action. Capabilities explicitly declare
`strategy:"http_extract_v1"`, `read_only:true`, `javascript_rendering:false`,
`ipv6:false` and `credential_binding_required:false` plus effective limits.
Operations capabilities advertises `website_review_enabled`,
`website_review_contract` and `website_review_strategy` when the service is wired;
provider readiness remains a separate requirement.

## Installed component requirement

This feature adds migration 1116 and changes the dashboard backend, installed A3
supervisor and installed A4 broker. Existing A8 dashboard socket/public-key pins
must be valid. No new upstream website connection or credential enrollment is
needed, but the existing A4 provider / vault configuration and price table must
already be healthy. An old bridge remains blocked instead of falling back to
Demo sign-in or claiming execution availability.

The normal Docker Update path now invokes `scripts/review-runtime-refresh.py`
for an **already opted-in** A8 installation. It verifies installed identity and
the pinned checkout before outage, refuses active/unverifiable work, then confirms
the dashboard is stopped before replacing only the A3/A4 daemon files and their
installation digest records. The existing services restart A4 then A3. Keys,
AppRole config, provider/binding/price/ledger state and A8 pins remain unchanged.
Other package/unit changes or foreign drift refuse the update. Do not use
`reinstall`/`configure` as an activation shortcut.

One explicitly reviewed compatibility pair retains the installed PR #710 Demo
guest worker: recorded and actual SHA-256
`d0724e5fb5573a18095a8e906cd9bb9c2542c17c494184ca15cbc65d345331f9`
with candidate SHA-256
`54302e5ee880470480d9b4de3d30616b263c7213d9eb08712b1ef3f50c5c0d21`.
The latter is commit `39ada2b`'s bound-session/single-sign-out correction. Public
reviews use backend extraction and the A3/A4 model bridge, without launching a
guest browser. This rule retains the worker bytes and journal pin; that Demo
correction remains deferred. Unknown/reversed pairs and every other adjacent
source/unit mismatch still refuse, naming the mismatched path. Installed files
must continue matching their recorded digests before any refresh.

Metadata-only readback verifies both serving digests and `website-review.v1`.
The existing provider/price requirement may still block readiness; activation
does not enroll credentials or make a model call. Dashboard health must pass
before the transaction commits and Update reports completion. Recovery restores
both old daemon files/journals before restarting the dashboard; it never restores
runtime ledgers or replays uncertain calls. A refused rollback blocks dashboard
recovery. Non-opted-in and `--no-restart` installs receive no runtime change.
Both existing runtime ledgers have a separate 16 MiB input cap, allowing retained
terminal history larger than the 2 MiB code/config/transaction-file cap. The same
bounded reader is used for preflight, apply and rollback comparisons. Missing,
nonregular, unreadable and oversized inputs refuse with their path; ledger
absence is never treated as empty state. The updater does not prune or rewrite
ledger history. Files beyond the explicit cap require separate investigation.
Backups and the transaction receipt are root-private under
`/var/lib/proxypilot/update/review-runtime-refresh`.

No component installation, production review, provider enrollment or host change
was performed in the development evidence. See the scoped
[implementation and evidence tracker](../plans/public-website-review-evidence.md).

## Local UI verification


`admin/frontend/tests/website-review.browser.mjs` checks the component contract and responsive states. `website-review-integrated.browser.mjs` exercises the full dashboard with real session/CSRF middleware, Operations routes/store and the public extraction service; DNS/HTTP and model responses are scripted fixtures. Its `--service-only` mode checks the real HTTP journey without Chromium. These fixtures do not establish live public-network, provider or deployment proof.

The authorized implementation, two-file scope, failure evidence and remaining
deployment requirements are in the
[activation decision](../plans/public-website-review-activation.md).
Repository tests do not constitute a production review or host rehearsal.
