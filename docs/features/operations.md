# Operations

Operations stores private instructions, independent guide approvals and records of
work performed by people. The interface is at `/operational-projects`; Dev Studio
retains `/projects`. No operation provisions a container, repository, worker,
agent or credential. Recording a run is a human report, not a task launcher.

## Feature gate and data

`OPERATIONS_ENABLED` defaults off. Only the exact value `true` enables the API
and navigation. Authenticated eligible users may query
`GET /api/operational-projects/capabilities` while off; it reports
`stage: human-workflow` and whether the interface is available. Other Operations
routes return 404 while disabled. Configuration is read at server startup.

Main-database migrations 1100–1102 are additive and run through the normal
migration runner even if the feature is disabled. 1100 adds private records,
grants, drafts, contributors and audit; 1101 adds review snapshots, approved
versions, draft iteration state and withdrawals; 1102 adds manual records.
Historical migrations are unchanged. Historical account IDs survive user deletion.

## Permissions

Existing active `user` and `admin` accounts may create an operation and become
its owner. There is no platform-admin bypass. All members can read its full
history and drafts. Editors and owners can edit and submit instructions;
reviewers and owners can review and withdraw versions. Operators, editors,
reviewers and owners can record their own work. Viewers can only read.

Approval requires a different person from the submitter and every contributor
to that iteration. Owner/admin status never waives this rule. A sole owner
needs an independent reviewer to publish.

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

Save a plain-text draft, then submit it. Submission freezes exact title/body,
hash, submitter and contributor IDs; editing is locked while pending. The
reviewer approves those exact bytes or requests changes with a reason. An
editor/owner can cancel with a reason. Approval creates one immutable numbered
version. Duplicate/stale approval cannot publish another version.

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
| GET / PATCH `/:id/draft` | Read / explicit save; draft revision |
| POST `/:id/submissions` | Submit saved draft; draft revision, empty body |
| GET `/:id/submissions/:s` | Exact snapshot and terminal decision |
| POST `/:id/submissions/:s/decision` | `decision: approve\|changes_requested`, `reason`; submission revision |
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
draft and project revisions but return the new draft revision. Submission
decisions return the submission revision. Refresh the appropriate resource
before a different kind of write. The interface preserves unsaved input on
conflict and supports explicit refresh, comparison and discard/reload.

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

Evidence remains off by default. Both `OPERATIONS_ENABLED=true` and
`OPERATIONS_EVIDENCE_ENABLED=true` are necessary. Missing finite
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
INF-01–04 remain unchanged. The pre-existing agent-network host-boundary finding
remains a release gate; the new decoder process boundary also requires its host
contract/inventory review. No release-readiness claim is made.

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
history. These people cannot approve that iteration. Starting a revision is an
explicit reset: it clears both contributors and draft references; it never copies
evidence from the base version. Explicit reattachment adds provenance again.

Submission freezes exact reference identities, derivative checksums, annotation
hashes, publication hashes, selector and provenance IDs in the existing immediate
transaction. The separate manifest hash covers canonical UTF-8 JSON
`{format:1,references}` in selection order. Annotation/summary text is not copied
into the immutable manifest or audit. Approval checks the seal, independence and
current availability again under the same immediate transaction as publication
and audit. Restriction or missing/corrupt media blocks approval with 409; request
changes or cancel, fix the draft selection, and resubmit. A newer demonstration
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
Draft text can still be saved, but disabling evidence cannot silently drop its
references. Re-enable the reviewed capability to change the selection or publish.
Evidence-free guides continue to work while evidence is disabled. An explicit
start-revision action still resets the iteration and its references as described
above; it is never an implicit fallback during submission or approval.

Before rolling back to an older writer, set `OPERATIONS_ENABLED=false` and stop
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

Draft text and evidence share the existing draft If-Match revision. Save or
discard guide edits before saving a selection; unsaved selections also block
submission. A 412 preserves local guide/annotation/selection input in memory and
offers explicit comparison and revision adoption/reload. Detachment never removes
contributor exclusion. An explicit start-revision clears evidence references.

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
