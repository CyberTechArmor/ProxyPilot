# Selected browser agent — v1 draft contract

Base: saved cloud checkout at `9b88f8f03925ee4c4cf097e40429897be9195e2f`
(PR #724). The repository now contains strict backend draft validation, additive
migration 1117, project-scoped draft endpoints and immutable configuration/source
snapshots. The cloud implementation now includes selected-browser lifecycle, worker,
destination gateway, private evidence, model/conversion bridge and review UI.
Execution remains unavailable without genuine installed boundary acceptance;
no credential intake, production deployment or changed legacy parser is included.
Shipped main and the current deployed UI do not accept this new draft format.
The Guide Instructions `proxypilot-rules` parser remains synthetic-sign-in-only.

Thomas authorized implementation of explicitly defined public, authenticated and internal browser
work, reasoning, navigation, reading, clicking, scrolling, typing, waiting,
downloading, copying, pasting, screenshots, uploading and submission. The first
configuration workflow is parent-generated JSON pasted into a new review/editor
surface. A subsequent conversion workflow retains original plain-language text,
image/file references and the generated editable settings. Neither conversion nor
save starts a run or grants permission. Incremental repository publication/merges were subsequently authorized.
Production deployment and new installed-target acceptance remain unauthorized.

Thomas selected `destinations.network_scope = "explicit_destinations"` and
`permissions.external_change_approval = "per_action"`. Each consequential
external action requires approval. Off-list navigation, authentication and asset
requests require an exact destination-and-purpose approval before any contact.
The base allowlist stays intact; approval is temporary to the attempt and cannot
silently add wildcards or permanently expand it. Actual reachability, exact-target
network policy, site effect classification, guide, consent and runtime remain
separate server-authoritative checks. Defining an internal URL never grants an
internal range or infrastructure/metadata/vault/management access.

## Exact proposal files

- `proposal-v1.schema.json`: strict JSON Schema Draft 2020-12 for imported drafts.
- `action-v1.schema.json`: typed candidate/action envelope, separate from import.
- `fixtures/general-agent.draft.json`: valid draft with the selected decisions,
  a NULL guide, no reviewed request rules and example destinations; cannot run.
- `build_proposal.py`: reproducible schema/fixture source and byte-identical
  backend schema copy; no added runtime dependencies.
- `test_proposal.py`: offline shape and expected-outcome fixtures. Requires the
  cloud environment's `jsonschema` package; no application dependency was added.

Run from the repository:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 contracts/browser-agent/build_proposal.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s contracts/browser-agent -p 'test_*.py' -v
```

The numeric ranges and sample budgets are proposed editable settings, not
measured capacities or user-approved limits. The runtime must enforce the
intersection of owner/project, agent, task, attempt, grant and installed capacity
limits before every action/request/call/artifact effect. Omitted caps and restarts
must not expand a new browser run's finite budget.

## C0 backend integration

The backend imports only its packaged static schema copy,
`admin/backend/src/lib/operational-browser-agent-proposal.schema.json`, using the
existing Zod dependency and a restricted compiler for that trusted JSON Schema.
Caller-supplied schemas and regexes are never compiled. The action schema is a
strict candidate envelope consumed by the separately gated selected lifecycle. No DNS, URL fetch, browser,
model, grant, file or credential lookup occurs during draft validation/save.

All routes are under `/api/operational-projects/:id/browser-agent-configurations`
and share Operations/agent-metadata gates, current session/project access,
no-store responses and existing CSRF protection:

| Method and suffix | Result |
|---|---|
| `POST /validate` | Edit access; strict preview without writes. |
| `POST /` | Edit access; `If-Match` project revision; atomic draft, source, snapshot and hash-only audit save. |
| `GET /` | Current read access; bounded paginated summaries. |
| `GET /:configurationId` | Current read access; exact saved settings/source and their hashes; configuration ETag. |
| `PATCH /:configurationId` | Edit access; `If-Match` configuration revision; full validated replacement and immutable snapshot. |
| `GET /:configurationId/readiness` | Always `can_start: false`; named unresolved runtime/reachability/policy/consent checks. |

The request body is `{ "configuration": <draft>, "source_text": <optional original text> }`.
Create defaults original text to `work.instructions`. Update retains the original
unless a replacement `source_text` is supplied; older source/configuration bytes
remain in immutable version rows. UTF-8 request bytes are bounded to 200,000 and
individual instructions/original source to 100,000. Asset references are metadata
only and remain unresolved. Editors cannot mint consent, execution or approvals.
Migration checks fix lifecycle to `draft` and execution to zero. Saving changes
the configuration revision without changing project revision or old run pins.
There is no Start/action/credential endpoint and no new frontend editor yet.

## Destination and effect rules

`allowed_origins` contains exact canonical HTTP(S) origins with separate
`navigation`, `resource` and `authentication` roles. A resource-only host does
not become a navigation destination and receives no session headers. Required
asset and identity-provider hosts must be explicitly supplied and reviewed.
There is no wildcard, inherited subdomain, automatic CDN discovery grant or
"allow anything" option. Explicit internal DNS names, IP literals and non-default
ports can be drafted, subject to future verified exact-target policy and actual
runner reachability. HTTP drafts prohibit session headers and authentication roles;
HTTPS preserves upstream TLS validation. Fragments may drive SPA navigation but are not sent
as HTTP request components. Canonicalization needs actual Chromium/proxy parity
tests before implementation acceptance.

Off-list requests are rejected **before target DNS resolution, connection or
transmission**; the supervisor freezes further actions/requests and escalates
with a redacted reason. This applies to redirects, frames, popups, scripts,
images, fonts, XHR/fetch, auth redirects and downloads, regardless of whether
the agent or a human caused them. Expired blocked requests are not replayed.
An authoritative temporary exception must bind the exact origin, role, purpose,
request bounds, run/attempt/fence, expiry and approval to an append-only grant
ledger. It never mutates the immutable base policy. Continuation rechecks current
authority and obtains fresh observations/candidates; an uncertain external effect
is never replayed. Permanent additions require a separate explicit reviewed edit.
A page/model cannot grant either change. Internal access requires a separately
reviewed exact-target network policy, not just a URL or flag.

Request rules also bound path, methods, query keys, resource type and body size.
Overlapping rules use the stricter effect classification. Unknown effects pause
before send. GET can change remote state; a rule's `read` label requires actual
selected-site review. Read-only POST adapters need a separate proven typed
classification; the current fixture deliberately does not assume they are safe.
WebSocket/service-worker/site-specific transport requirements are compatibility
gates for the selected site. This proposal does not silently enable them.

The implemented gateway must screen every DNS answer against the verified target
plan; public targets reject mixed/nonpublic answers, and internal targets require
exact authorized addresses/ports and routes without granting ranges. It must
connect to the screened IP with upstream TLS hostname validation,
and deny installation/metadata/vault/control-plane hosts and addresses even when
they have public DNS. The bridge/TAP fence remains proxy plus TURN only. An
attempt-bound, supervisor-owned gateway policy must be verified before browser
start; the VM must not be able to select another attempt's gateway policy.

## Authority and action envelopes

The action envelope binds run, attempt, fence, ordinal, policy hash, snapshot
reference/hash and candidate reference/hash. The worker generates candidate
operations and references. The model selects only a permitted candidate ID.
Current server authority must verify all references and hashes; a shape-valid
envelope is never authorization. Candidate inputs use opaque current scoped
asset/input/clipboard references rather than arbitrary host paths, JavaScript,
selectors, headers or credential values.

Future Start is explicit with current revisions, project run access, approved guide,
owner model disclosure consent, installed runtime and current authority. These
facts are server-owned and absent from the editable import. Guide-save approval
semantics remain unchanged; no second-person review is invented. Named
preauthorization is not selected and its draft reference list must be empty.

An approval for an external effect must bind the exact candidate, destination,
method, payload/upload hashes, snapshot, guide, policy, run, attempt and fence,
and be consumed durably once before transmission. Autonomous page writes and
autosave require the same gate. Timeouts and lost readback remain uncertain;
never replay them. The supervisor receipt proves policy/lifecycle custody and
cleanup, not the truth of arbitrary website content.

## Private content, authentication and artifacts

Manual takeover is the first authentication path. Credentials are entered into
the isolated browser, never into the guide/configuration/model/receipt. No
credential broker enrollment, personal-vault access, general password adapter or
OAuth token custody is introduced. CB-01/CB-04 and A8 limitations remain open.
Attempts have isolated temporary sessions; no cross-agent or durable session
reuse is implied. Raw password fields, cookies, storage and auth headers are
excluded from model observations and logs. All page content remains untrusted.

Live video stays temporary. During manual authentication, retained capture and
model inspection pause; the implementation must restrict sensitive viewing to
the controller. General private content sent to a model requires explicit owner
disclosure consent for the exact inputs. Masking known password fields alone
cannot prove absence of secrets in arbitrary rendered private documents,
canvas/PDF content or downloaded binaries: potentially sensitive outputs need
explicit review/redaction before model disclosure or artifact release.

Downloads use bounded private staging, content hash/MIME/size checks and inert
storage; they never execute. Uploads use current project-scoped approved asset
hashes and lengths, not arbitrary guest files, and their transfer is an external
effect. Screenshots are explicit bounded artifacts with private access and
retention, not automatic video recording. The clipboard is attempt-private;
human import/export occurs through explicit dashboard gestures. Clipboard bytes
are neither model observations nor activity-log text by default. Artifact
references do not themselves grant disclosure, upload, cross-project use or
sharing rights.

## Supervision and evidence

Reuse A7 live signalling, TURN, session-specific control verification and one
controller. Add a durable executor pause: it waits for an in-flight operation's
certain outcome or records uncertainty, blocks new network/actions and retains
live view within existing deadlines/resources. A paused frame display is not an
executor pause. Viewing does not renew a worker lease. Takeover suspends agent
decisions and remains under the same egress/effect policy and budgets. Keep
current release/linked-run reconciliation behavior until a separate continuation
contract is proved.

Cancel revokes gateway and action authority, closes live input, stops descendants,
removes the workspace and prevents later result publication. An accepted provider
call can still settle; uncertain usage retains its reservation. Signed compatible
receipts bind cleanup to the original identity and policy. Reports cite bounded
accepted source/artifact references, distinguish untrusted page claims/model
words from confirmed effects, and preserve steps, approvals, costs and uncertainty.

Backend draft tests and offline fixtures are not proof of proxy enforcement, live input, Chromium policy,
Incus/nft isolation, credential confidentiality or deployment acceptance. Those
proofs remain required after implementation. All development stays cloud-only.


## Implementation and acceptance

See [worker contract](worker-adapter-v1.md), [scope/dependency plan](../../docs/plans/fractionate-browser-agent-scope-20261002.md), and [actual Nodus alignment](../../docs/plans/fractionate-browser-nodus-alignment-20261002.md). Browser readiness requires signed host/VM/configuration/installed-policy proofs plus current guide, owner consent, account/project access, finite caps and actual private source storage. Saving a draft remains non-executable. Manual takeover uses an attempt-private session; no broad broker credentials are activated.

`max_actions` counts automated and typed declared browser primitives. Native takeover mouse/key/scroll events are separately measured in signed cleanup receipts; finite time/network/resource and exact HTTP-effect approval rules remain active during takeover. Installed controller-only media, spectator closure, chooser isolation and receipt proof remain required before acceptance.
