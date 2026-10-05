# Operations

Operations stores private instructions, approved guide versions and records of
work performed by people. The interface is at `/operational-projects`; Dev Studio
retains `/projects`. No operation provisions a container, repository, worker,
agent or credential. Recording a run is a human report, not a task launcher.

The separately gated Agent runs features include the synthetic Demo sign-in
pilot and [public website reviews](public-website-review.md). Public reviews use
a saved approved guide and URL, owner model consent, explicit start/cancel and
immutable cited evidence. They do not require synthetic hard-rules or a website
credential connection. Installed runtime/provider readiness is checked separately.

## Feature gate and data

Operations is off until an administrator turns it on in the dashboard:
Operations → **Operations settings** (administrators always see the Operations
entry, so they can reach it while it is off). Three toggles, each requiring the
one before it: **Operations**, **Agent metadata** (A2) and **Agent runs** (A6).
They are dashboard settings, not environment variables (user decision,
2026-09-29): `lib/operations-toggles.js` stores them as `operations_toggle:*`
rows in `app_settings`; the only writer is `PUT /api/operations-settings/:name`
(administrator, role re-read from the database, sudo, one `OPERATIONS_TOGGLE_CHANGED`
audit row per change). They are outside the MCP `set_setting` allowlist and the
MCP feature-flag policy, so no MCP client can change them. The routes read them
on every request, so a change takes effect at once without a restart.
Authenticated eligible users may query `GET /api/operational-projects/capabilities`
while off; it reports `stage: human-workflow`, whether the interface is
available and `can_manage_settings` (a hint for the sidebar). Other Operations
routes return 404 while Operations is off.

Main-database migrations 1100–1102 are additive and run through the normal
migration runner even if the feature is disabled. 1100 adds private records,
grants, drafts, contributors and audit; 1101 adds review snapshots, approved
versions, draft iteration state and withdrawals; 1102 adds manual records.
Historical migrations are unchanged. Historical account IDs survive user deletion.

## A2 project discovery and disabled agent profiles

Migration 1106 adds an optional `site_origin`, monotonic `site_revision`, a
visibility preset, membership requests and project-scoped profile metadata.
It is additive and applies even while the feature is off. The separate
**Agent metadata** toggle requires Operations and is off until an administrator
turns it on. A site and profile are optional when a project is created. Saving
the site changes no route, DNS, worker or credential. Only the current owner may
set or clear a canonical HTTPS origin. Changing it advances `site_revision` and
invalidates the profile's site assignment pin.

The default `hidden` preset is member-only. `read-only` and `collaborative`
show eligible signed-in nonmembers only a redacted name card and a request
button. The owner must explicitly review the expansion from hidden and approve
each request. Read-only requests may receive viewer access; collaborative
requests may receive an existing named role. Discovery itself exposes no site,
draft, events, roster, credentials or execution authority. Archive removes a
project from discovery and blocks new approvals. A downgrade to hidden cancels
pending requests. Account and membership state is rechecked on each read or
write.

Profiles use opaque UUIDs and a project foreign key. Owners and editors can
create, update, soft-delete and assign the current approved guide
by exact version ID and SHA-256 hash. Profile and project writes use quoted
numeric `If-Match` revisions and transactional project audit. A guide that is
withdrawn or superseded makes its assignment stale. Profiles stay disabled for
execution in A2 even when site and guide are present. No profile mutation
creates an agent run, worker, credential binding, provider call or live target
change. Run authority and effective policy enforcement belong to later sections.

## Permissions

Existing active `user` and `admin` accounts may create an operation and become
its owner. There is no platform-admin bypass. All members can read its full
history and drafts. Editors and owners can save and approve instructions;
reviewers and owners can use the legacy review endpoint and withdraw versions. Operators, editors,
reviewers and owners can record their own work. Viewers can only read.

An explicit guide save is approval (Thomas's decision, 2026-10-02). Editors and
owners can publish their own contributions without a separate submission,
second person or pilot exception. Reviewer-only access does not grant editing
or publication through Save and approve. Existing project, account and archive
checks still apply. The historical explicit submit/decision endpoints retain
their independent-review contract for compatibility; the interface uses the
direct save contract.

Only the owner sees and manages the roster. Grants use existing eligible
accounts, found by exact username or UUID. Lookup is limited to 30 requests per
minute per account; no directory export, account creation or invitations.
Pending accounts lose access immediately; platform reapproval restores surviving
grants. Nonmembers receive 404. Deleted owners have no implicit recovery path.

Ownership offers require target acceptance, expire after 24 hours and become
stale after any project/draft/workflow mutation. The old owner becomes an editor.
Owners can cancel, targets can decline; owners cannot remove themselves.

Archive freezes edits, reviews, records, grants and transfers. Reads, revocation,
self-leave and owner restore remain available. Restore preserves history and
surviving grants. No hard-delete or purge endpoint is provided.

## Guide and work lifecycle

Select **Save and approve** to validate a nonempty plain-text title and
instructions and atomically save and publish one immutable numbered version.
The same immediate transaction retains exact title/body bytes, SHA-256,
author, approval actor/time, contributors, evidence and base/predecessor chain,
along with the save and publication audit. Invalid input, stale revision,
unavailable evidence or audit failure rolls back the whole save.

An existing **Awaiting review** snapshot is published only when an editor or
owner explicitly selects **Save and approve**. This uses the immutable pending
snapshot's actual bytes and revision, preserving its author/time and evidence;
it never recreates content from the draft or autoapproves during a migration.
An editor/owner can still cancel with a reason. Duplicate or stale approval
cannot publish another version. Saving a guide starts no run, enrolls no
connection and supplies no credential-write approval. Run start, connection
rights, site allowlists and run-action approvals retain their own checks.

After publication, explicitly start a revision from an approved same-operation
version. The interface requires confirmation that this replaces the draft.
This preserves the base-version chain and clears contributors for the new
iteration. A new approval supersedes older versions for new manual entries.
Withdrawal adds immutable actor/time/reason history. Withdrawing the newest
version leaves no current guide; an older version does not reactivate.

Manual records require the exact current, nonwithdrawn version at commit time.
Reported times must be valid UTC ISO timestamps with start <= end <= server time.
Outcomes are completed, blocked or aborted. Existing records remain pinned when
guides change. Corrections are append-only, require a reason and current run
permission, and can only be made by the original recorder. They preserve the
original version even when it is superseded or withdrawn. Correct the latest
record in the chain; branching/cycles and changing another person's record are
rejected. The interface can follow correction links across paginated history.

## API and concurrency

All endpoints below are relative to `/api/operational-projects`. They use existing
session, current-account, pending and CSRF middleware; no exemptions or new runtime
credentials. Router responses use `Cache-Control: no-store`. Strict schemas reject
unknown fields. All writes and domain events share an immediate transaction.

| Endpoint | Purpose and revision |
|---|---|
| GET / POST `/` | Paginated accessible list / create private operation |
| GET / PATCH `/:id` | Summary / rename and description; project revision |
| GET / PATCH `/:id/draft` | Read / atomically save and approve `{title,instructions}`; draft revision, editor/owner |
| POST `/:id/submissions/:s/approve` | Explicitly approve the existing pending snapshot; submission revision, empty body, editor/owner |
| POST `/:id/submissions` | Legacy explicit submit of an unpublished draft; draft revision, empty body |
| GET `/:id/submissions/:s` | Exact snapshot and terminal decision |
| POST `/:id/submissions/:s/decision` | Legacy independent review: `decision: approve\|changes_requested`, `reason`; submission revision |
| POST `/:id/submissions/:s/cancel` | Required `reason`; submission revision |
| POST `/:id/draft/start-revision` | `version_id`, `discard_draft: true`; draft revision |
| GET `/:id/versions`, `/:id/versions/:v` | Immutable version/provenance and withdrawal details |
| POST `/:id/versions/:v/withdraw` | Required `reason`; project revision |
| GET `/:id/runs`, `/:id/runs/:r` | Manual records and correction links |
| POST `/:id/runs` | `version_id`, `idempotency_key`, `started_at`, `ended_at`, `outcome`, optional `notes` |
| POST `/:id/runs/:r/corrections` | Same reported fields without `version_id`, plus required `reason` |
| GET `/:id/access` | Owner-only roster |
| GET `/:id/access/candidate` | Exact `identifier` query |
| PUT / DELETE `/:id/members/:u` | Set `role` / revoke or self-leave; project revision |
| POST `/:id/archive`, `/:id/restore` | Required `reason` / empty body; project revision |
| POST `/:id/ownership-offers` | `target_user_id`; project revision |
| POST `/:id/ownership-offers/:o/decision` | `decision: accept\|decline\|cancel`; project revision |
| GET `/:id/events` | Activity; owner-only membership/transfer details |

Revision-controlled writes use quoted numeric `If-Match: "N"`. Missing is 428;
stale is 412. Incompatible workflow state is 409. Draft saves increment both
draft and project revisions but return the new draft revision, `status: published`,
the approved `submission` and its immutable `version`. Pending approvals return
the new submission revision, the same published status and snapshot/version.
Submission decisions return the submission revision. Refresh the appropriate resource
before a different kind of write. The interface preserves unsaved input on
conflict and supports explicit refresh, comparison and discard/reload.

Draft/snapshot/version projections retain the immutable account IDs and add
readable `updated_by_name`, `submitted_by_name`, `decided_by_name`,
`approved_by_name` where applicable, and `contributor_names` in contributor ID
order. Names reflect current account metadata; deleted accounts display
`Deleted account` while the original provenance IDs remain intact.

Manual writes instead use a UUID idempotency key scoped to operation/recorder.
Identical retries return the existing record; different content with that key
returns 409. Current eligibility/archive checks still apply to retries.

Lists default to 25, maximum 100. Operation/run cursors are UUIDs; version cursors
are version numbers and activity cursors are event IDs. Operations support
`state=active|archived|all`. Access filtering occurs before pagination.

Names and titles are limited to 200 characters; description 20,000; instructions
100,000 UTF-8 bytes; notes 10,000; reasons 2,000. The existing HTTP parser limit
also applies. SHA-256 covers canonical UTF-8 JSON `{format:1,title,instructions}`;
provenance is separately immutable. Render text inertly; no remote link preview,
HTML execution, localStorage draft storage or API service-worker caching.

## Validation and release

Product tests `operational-projects*.test.js` use isolated SQLite fixtures.
Completion evidence also runs real Express, cookie parsing, signed JWT sessions,
rate limiting and better-sqlite3 with the locked dependency versions. Only the
live DB locator and remote SSO boundary are replaced in the HTTP harness.
Actual remote SSO and host orchestration are outside that fixture.

Browser evidence covers the multi-user workflow, six widths in both themes,
stale-input recovery and accessibility. The full backend production entrypoint
is not used as a test because it starts unrelated host services.

Operations rollback is deactivation plus code rollback, retaining additive tables
and migration history. Native-SQLite replay of the earlier database initializer
preserves Operations records; unrelated setup schema imports are supplied as
their unchanged literal SQL, and the empty-fixture legacy recovery hook is inert.
This is database compatibility evidence, not a representative host deployment.

The combined checkout also includes destructive Lean BEAF migration 706. Its
rollback requires a verified backup and is separate from Operations rollback.
No live migration, feature activation or deployment was performed. Required
release/security checks must pass before publication or deployment.

## Private image evidence

Evidence remains off by default. The Operations toggle and
`OPERATIONS_EVIDENCE_ENABLED=true` are both necessary. Missing finite
`OPERATIONS_EVIDENCE_QUOTA_BYTES`, absolute `OPERATIONS_EVIDENCE_DIR`, absolute
`OPERATIONS_EVIDENCE_DECODER_RUNNER`, or the separate deployment assertion
`OPERATIONS_EVIDENCE_BOUNDARY_REVIEWED=true` leaves the capability closed.
The capability is reported as `evidence_enabled`; the Guide-local workflow uses this actual capability without adding navigation groups.

The dedicated evidence root must already exist, outside this checkout, all static
roots, Dev Studio, retired uploads and container mounts. The deployment review
must verify owner-only permissions (0700 directory/0600 files on POSIX; equivalent
Windows ACL), no untrusted writer in its ancestor chain, no reparse points, and
backup/restore ownership. Linux operations use a pinned directory descriptor and
no-follow file opens. Node does not provide an atomic Windows openat/reparse API:
Windows ancestor/identity checks detect changes but are not a hostile-local-writer
sandbox. Windows activation requires an independently verified exclusive ACL
boundary. D2 does not provision or certify either deployment boundary.

Decoder dependencies are pinned: pngjs 7.0.0 (MIT), jpeg-js 0.4.4 (BSD-3-Clause),
with Node's bundled native zlib. A fresh child receives only stdin bytes and
returns a small JSON line plus canonical RGBA PNG. No credentials or user paths
are supplied. One decoder runs per API process, with a 10-second wall timeout,
256 MiB V8 heap, JPEG 192 MiB allocation/16 MP limits, 8 MiB input/output limits,
8192-pixel edge and 16-million-pixel limit. PNG currently accepts single-frame,
8-bit, noninterlaced images; unsupported bit depths/interlace are refused.
JPEG baseline/progressive decoding is strict. APNG, MPF, trailing data, invalid
CRC, invalid/truncated inflate streams and other formats are refused. Derivative
encoding copies pixels only: no EXIF, ICC, comments, text or original filename.
JPEG orientation metadata is not applied. Inspect the actual resulting pixels.
Human review, not the decoder, determines whether redaction is complete.

The configured executable wrapper receives fixed argv:
`<node executable> --max-old-space-size=256 <decoder worker path>`. It must exec
that worker inside a reviewed low-privilege/no-network boundary with read-only
runtime/packages, no evidence-root/database/credentials, and hard OS memory,
CPU and process limits. Recommended review envelope: 512 MiB RSS, 10 CPU seconds,
no child-process creation. Heap limits alone do not bound native allocations.
The wrapper must forward stdin/stdout and terminate its entire job on parent
closure. No default wrapper, elevated helper, production timer or provisioning
is included. Local tests use a disposable ordinary child process and do not prove
OS sandboxing. Multiple API workers require a deployment-wide decoder resource
budget before enabling this feature.

Evidence routes live below `/:id/demonstrations` on the existing Operations API:

- GET/POST `/`, GET/PATCH `/:d`: scoped metadata, explicit private creation.
- POST `/:d/uploads`: UUID retry key, expected `byte_count`, `mime`, SHA-256,
  `kind` (`raw` or `derivative`), nullable `parent_raw_id`, optional `source_kind`.
- GET `/:d/uploads/:u`: author-only durable receipt and expiry; no storage path.
- PUT `/:d/uploads/:u/bytes`: uncompressed matching image body, counted regardless
  of Content-Length, 30-second total deadline; no global raw parser.
- POST `/:d/uploads/:u/finalize` or `/cancel`: empty JSON body, CSRF required.
- GET/HEAD `/:d/evidence/:e/download`: authorized attachment, no-store/no-sniff,
  sandbox CSP and same-origin resource policy. Range/conditional requests refused.
- POST `/:d/annotations`, `/share`, `/archive`, and
  `/:d/evidence/:e/restrict`, `/deletion-request`, `/hold`: existing D1 policies,
  explicit share attestation and demonstration `If-Match` where applicable.

D1 metadata fixtures are not media validation. Production uses a separate sealed
file/validation receipt before serving, annotating or sharing. Raw originals and
unshared candidate derivatives are author-private; project ownership or platform
admin status grants no original access. Download checks current membership,
account status and disposition before disk access and between output chunks.
Already delivered bytes cannot be recalled. Archive freezes mutations, while
existing authorized reads and previously authorized retention continue.

Reservations are immediate SQLite transactions. Account/project concurrent
uploads are limited to 2/4, with 8 globally (including closing busy leases).
Active downloads are limited to 8 globally. Quotas: 200 MiB per demonstration, 1 GiB per project,
1 GiB per account, plus mandatory finite installation quota. Reserve expected
input bytes plus an 8 MiB output allowance. Unused output allowances and staged
inputs remain charged until explicit maintenance. Generated filenames are UUIDs;
never content-addressed across projects. Upload keys are durable per project and
actor; changed payloads conflict. Retry/status/finalize still require permission.
Expired leases cannot revive. Restart a small interrupted body; no chunk resume.
A partial generated file can only be replaced under its live exclusive lease.
Final objects and receipts are immutable and do not auto-share.

Staging expires at 24 hours. Private retention expires seven days from the intake
reservation receipt (the response returns the exact deadline); published reviewed
derivatives persist until explicit restriction/removal. Restrictions deny serving
immediately. Physical removal observes a further 24-hour grace and latest holds.
Holds never grant read access. Cancelled staging can be removed once its active
lease closes. Failed deletion retains charged bytes; expiry is not erasure.

Maintenance is explicitly invoked through the injected service:
`service.maintenance({apply:false,limit:25,after:''})` returns a bounded manifest;
`apply:true` rechecks each entry under a write lock before unlinking it. Limits
are 1–100; continue with `next_cursor`. Only DB-recorded generated identities are
considered; unknown files and sibling directories are never swept. Audit occurs
before unlink; a failed audit performs no deletion. Crash after unlink/before
commit reconciles as missing on retry, keeping a durable receipt. Active read
and upload leases, latest holds and grace deadlines win over an older dry-run.
Missing-file reads deny bytes and write a durable unavailable receipt. Physical
removal also erases dependent text payloads while preserving immutable hashes.
Run with an explicitly reviewed dedicated root and injected DB, never by starting
the production entrypoint as a test. No production scheduler is installed.

Deactivation retains additive 1103/1104 tables and files. Restore must replay
restriction/deletion receipts before serving; restoring a blob cannot revive its
terminal DB receipt. Backup copies have their separately approved expiration.
Filesystem permissions, wrapper isolation, deployed session/SSO behavior, backup
restore and physical-deletion SLA remain release prerequisites. SEC-01–05 and
INF-01–04 remain unchanged. The agent-network and decoder process contracts have
source review and accepted static inventory entries in `docs/core/security-host-boundary.md`;
the broader S6 host-isolation finding and deployed decoder-wrapper acceptance
remain open. No release-readiness claim is made.

## Exact evidence in guide review (D3 backend)

Migration 1105 adds current draft references and separately sealed submission
evidence sets/references. It does not replace guide/version/manual tables or
change the guide hash. Historical submissions without a seal return an empty
evidence set with `manifest_hash: null`. Every new submission, including one with
no evidence, receives a count and a SHA-256 seal. SQL refuses late insertion,
update/deletion of sealed rows, and new submissions from evidence-unaware writers.

`PUT /:id/draft/evidence` replaces the ordered selection under the existing draft
`If-Match`. Its strict body is `{references: [...]}`; each entry contains
`demonstration_id`, `revision_id`, `item_position` (zero-based publication item),
`object_id`, and `annotation_id`. Maximum 20 entries; duplicate publication items
are refused. Only owners/editors can select or detach evidence, only while the
draft is editable and the operation is active. Success increments both draft
and project revisions. Missing/stale revisions remain 428/412; workflow or
availability conflicts are 409; foreign or mismatched child tuples return 404.
Current account, membership and CSRF checks remain authoritative.

Selection accepts exact same-operation published, privacy-reviewed derivative
items only. The server verifies publication membership/hash, annotation and
summary integrity, current D2 availability, the durable validated-file receipt,
and actual derivative bytes against the recorded checksum. There is no client
validation flag. Raw objects and private candidates cannot enter a guide manifest.
Files are checked only after scoped authorization and metadata validation.

The iteration contributor union includes guide editors, every selector, and the
selected publication's authors, uploaders, annotation actors and publishers.
Detaching evidence, removing a grant or deleting an account does not remove this
history. Editors and owners may approve their own contributions using Save and
approve; contributor exclusion remains part of the legacy independent-review
endpoint only. Starting a revision is an
explicit reset: it clears both contributors and draft references; it never copies
evidence from the base version. Explicit reattachment adds provenance again.

Submission freezes exact reference identities, derivative checksums, annotation
hashes, publication hashes, selector and provenance IDs in the existing immediate
transaction. The separate manifest hash covers canonical UTF-8 JSON
`{format:1,references}` in selection order. Annotation/summary text is not copied
into the immutable manifest or audit. Save and approve checks the seal and
current availability again under the same immediate transaction as publication
and audit. Restriction or missing/corrupt media blocks approval with 409; request
changes or cancel, fix the draft selection, and save again. A newer demonstration
revision or derivative never replaces the submitted reference automatically.

Draft, submission and version reads include `evidence` with `manifest_hash` and
ordered `references`. Frozen refs include hashes/provenance; each read adds
`available` and `unavailable_reason` (`unavailable` or `capability_disabled`).
These conservative tombstones never include removed text, raw-parent relationships
or storage paths. Versions resolve their own submission. Later restriction,
physical removal or annotation erasure changes availability only; approved guide
bytes/hashes, frozen reference identities and pinned manual records stay intact.
Evidence reads remain authorized and no-store. D4 renders these exact references in the existing Operations interface.

### Deactivation and rollback runbook

Both false-default gates and all D2 runtime boundary checks still apply. With
evidence disabled, the selection route returns 404. Existing identities and seals
remain readable with `capability_disabled` tombstones and no media filesystem
access. Evidence-bearing drafts cannot be submitted and evidence-bearing pending
submissions cannot be approved (409). Cancel/request-changes remain available.
Evidence-bearing text cannot be saved and approved while disabled; disabling evidence cannot silently drop its
references. Re-enable the reviewed capability to change the selection or publish.
Evidence-free guides continue to work while evidence is disabled. An explicit
start-revision action still resets the iteration and its references as described
above; it is never an implicit fallback during submission or approval.

Before rolling back to an older writer, turn Operations off in Operations
settings (an older build reads `OPERATIONS_ENABLED` instead: leave it unset or
`false`) and stop
Operations writes for the entire rollback period. Keep migrations 1100–1105,
history, file receipts, blobs and disposition records; do not drop tables or
triggers to make an older binary write. The new-submission seal trigger adds a
database guard, but older approval/edit paths do not know these semantics: the
Operations shutdown is still mandatory. Replaying an older initializer is not
authorization to run older writers. Re-enable only current evidence-aware code
after checking migration history, storage accounting and dispositions. Restoring
old bytes never overrides terminal restriction/deletion receipts. Disposable
initializer replay is not production backup/restore certification.

Evidence never authorizes an agent action. D5 import/capture remains separate work. SEC-01–05 and INF-01–04, both host-boundary findings, deployment
sandbox/ACLs/resource budgets, backups and erasure SLA remain release gates.


## Human evidence workflow (D4)

Guide contains Demonstrations when the actual evidence capability is available.
Owners/editors select at most 20 exact shared publication items; operators,
reviewer-only members and viewers cannot edit guide selections. Non-viewer authors
can create private demonstrations. Ownership never grants another author's raw
or unshared image access. Access links to Guide-local moderation and owner holds.
The existing five sections and flat navigation remain unchanged. A `section`
query parameter may open one of those existing sections directly.

Select an original PNG/JPEG, reserve it, inspect the server's exact private
retention and lease deadlines, transfer, then explicitly finalize. Select an
externally redacted replacement separately and associate it with your original.
Inspect the actual authenticated returned derivative, supply ordered plain-text
labels and descriptions/text alternatives, then explicitly attest to privacy
review and share a new immutable publication. Neither upload nor finalization
shares anything. New annotations/publications are immutable revisions.

Reloading the page discards local files and unsaved input. The author can recover bounded,
paginated server receipts and reselect exactly matching bytes; changed bytes
require a new reservation/key. Uploads restart as whole bounded bodies, without
chunk resume. An expired or cancelled lease cannot revive. Cancellation is explicit;
interruption only stops the client request, so check the server receipt. Original
filenames, operation content and images are not persisted by this workflow.

Draft text and evidence share the existing draft If-Match revision. Choose and
save evidence while the draft is editable, before Save and approve publishes it.
Saving a selection retains entered guide text in memory and adopts only the
successful conditional selection response's exact new draft revision. The
selection endpoint leaves stored title/instructions untouched and publishes no
guide. Unsaved selections block approval. A 412 preserves local
guide/annotation/selection input in memory and
offers explicit comparison and revision adoption/reload. Detachment never removes
contributor history. An explicit start-revision clears evidence references.

Pending snapshots, approved versions and manual records' pinned versions display
only exact retained references and the matching publication item/annotation.
Unavailable bytes or text, restriction and disabled capability withhold dependent
content; the retained identities remain visible. Newer publications never replace
old references. Refresh/focus and a 30-second recheck reauthorize; unmount, account
or operation change and detected loss of access abort requests and revoke blob
URLs. Already delivered bytes cannot be recalled. This is not instantaneous
remote revocation. No API or preview cache is added.

D4 adds two read-only integration endpoints beneath a demonstration:
`GET /:d/workspace?after=<upload UUID>` (author only, 25 receipts per page, safe
available private objects/annotations) and `GET /:d/revisions/:revision`
(exact shared publication). The existing visible shared-demo read exposes its
revision to owners so their already-authorized moderation can use If-Match.
Private titles, purposes, upload receipts, raw relationships and unshared objects
remain author-only. No schema, write-policy, decoder, retention or gate changes.

Restriction denies subsequent reads; physical deletion remains deferred, subject
to the fixed grace, holds and authorized maintenance. Holds grant no access.
No scheduler or live maintenance is supplied by the UI. Both false-default gates,
D2 runtime checks, older-writer Operations shutdown and all SEC/INF deployment
prerequisites continue to apply.

## Streamlined browser projects

New project setup is **Name → Goal → Accept & save**. The authenticated owner
accepts `project-defaults.v1` once. One immediate transaction creates the private
project, publishes the exact goal as an immutable approved guide, sets finite
project limits, saves the browser configuration and records owner model consent
for its exact configuration and guide hashes. Saving starts no run. An
idempotency key makes a repeated identical save return the same project;
changed content with the same key is refused. Audit failure rolls back all of it.
Legacy projects, grants, connections, credentials and run histories are retained.

The default model is the existing `gpt-6-luna` route. Resources are 1 CPU,
1024 MiB memory and 512 MiB temporary disk. Each run is bounded by 15 minutes,
60 actions, 20 model calls, 50,000 tokens, $1, 500 requests, 50 MiB response
bytes and 32 MiB private artifacts. Video recording is off and result retention
is 14 days. External changes retain per-action approval, off-list destinations
pause before contact and sign-in uses manual takeover. No credentials, account
or connection are invented. A website URL in the goal supplies the initial
explicit destination. A goal without one saves successfully and asks the owner
to add it with **Edit goal & settings** before running.

The overview keeps the existing Projects list/detail layout and exposes
**Run now**, **Schedule** and **Edit goal & settings**. Run now uses the current
accepted configuration and the existing signed runtime readiness, cleanup,
model, source-memory, budget, access and control checks. One settings acceptance
publishes a new guide, revises the configuration and consent, adjusts limits and
pauses its schedule. An active run must be stopped first. Advanced agent/model,
source, destination and connection editors remain accessible under Agents.
Re-authentication and agent-control proof are requested only when required.

Schedules support Once, Daily or Weekly in an explicit IANA timezone. The owner
accepts unattended execution of the exact current configuration, guide, consent
and limits. The backend persists timing, next run and occurrence history; the
browser need not stay open. A schedule is revocable and cannot grant permission
to make consequential changes. Current ownership, access, account eligibility,
feature switches, accepted hashes, limits and installed execution readiness are
checked again before launch and throughout each run. Session expiry does not
cancel this explicit schedule mandate. Live human control still requires a
current session. Pausing, deleting or editing the schedule revokes its mandate
for an active scheduled run; ordinary human runs retain their session checks.

A durable unique local-time occurrence and run idempotency key prevent replay.
The scheduler skips overlaps, skips occurrences over five minutes late, and
never catches up multiple missed runs. Startup marks incomplete claims
interrupted; the existing runtime fences previous attempts without replay.
Spring daylight-saving gaps skip that occurrence; a repeated fall time runs
once. Goal/settings changes pause schedules until **Accept & resume** or an
explicit schedule save. Each recurrence has the displayed per-run bounds;
recurring authorization continues until paused or deleted. Blocked, missed,
overlap and interrupted occurrences are visible beside the next run.

Routes (in addition to existing advanced browser APIs):

- `GET /project-defaults`: defaults and current session proof status.
- `POST /project-tasks`: owner acceptance; requires current elevation.
- `GET /:id/task`, `PATCH /:id/task` with task `If-Match`: read/update setup.
- `POST /:id/task/start`: explicit Run now, never a save side effect.
- `PUT /:id/task/schedule`: accept timing/mandate with schedule `If-Match` on edits.
- `PATCH /:id/task/schedule/:scheduleId`: pause/delete; resuming uses explicit PUT acceptance.

There is no HTTP or MCP scheduled-start endpoint. Scheduled starts are admitted
only by the internal maintenance worker against a durable claimed occurrence.
Migration 1126 is additive. No host installation or activation is part of this
source update. Evidence: `operational-project-tasks.test.js`, the signed runtime
journeys in `operational-selected-browser-runtime.test.js`, and the real-page
responsive/accessibility/CSRF journey in `project-tasks.browser.mjs`.
