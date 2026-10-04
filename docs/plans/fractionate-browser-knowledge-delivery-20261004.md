# Browser sources, artifacts and knowledge delivery — 2026-10-04

The current user instruction authorizes implementation/review/release of coherent
browser slices. Earlier whole-feature gates and terminal ceremonies are superseded.
Optional sources, storage, credentials and indexes must not prevent public browsing.
This source audit starts at `d2331e251fc1a58443adfd979112192810b0d283`;
installed storage/decoder facts require the release coordinator's live checks.

## Implemented slice: explicit source discard and honest retention receipts

`POST /api/operational-projects/:projectId/browser-assets/:assetId/discard`
accepts `{}` only and inherits current human session, CSRF and project edit
authorization. No execution, sudo, model or arbitrary filesystem operation is
introduced. It cancels the exact project asset, immediately revokes read leases
and future source/upload use, and leaves immutable pins and historical reviews.
An active writer must finish/release before the existing maintenance job removes
bytes. There is no immediate physical-erasure promise.

Asset/artifact responses now include creation/provenance and retention receipts:

| Field | Meaning |
|---|---|
| `availability_reason` | Available is `null`; otherwise `cancelled`, `rejected`, `expired`, `deleted`, `missing`, `intake_pending` or `intake_interrupted`. |
| `retention.cleanup_pending` | Bytes/reservation require cleanup; active writer/read leases can delay it. |
| `retention.recorded_file_state` | Durable metadata (`allocated`, `sealed`, `deleted`, `missing`); not a fresh physical-integrity probe. |
| `retention.recorded_state` | Preserved lifecycle state; the legacy `state` projection may show `expired` after its deadline. |
| `retention.charged_bytes` | Local physical allocation remains charged until deletion/missing-object reconciliation commits. |
| `retention.deletion` | Local unlink/missing result and timestamp; no guarantee about backups, replicas, secure erasure or host-root tampering. |
| `provenance` | Creator, derivative parent; page observations additionally expose immutable snapshot, origin, URL digest, capture time, worker/chunker contract. No page text, secrets or raw URLs are added. |

`service.verifySourceAsset(actor,project,ref,{approved_for_model:true})` is a
synchronous exact-original verification for aggregate post-decoder checks.
It requires current owner/private-source disclosure approval, rereads and hashes
the original under a short read lease, rechecks authority, clears its private
buffer and returns pins only. It neither decodes nor contacts a provider.
The model conversion integration is owned by its separate slice.

## Current storage and decoder prerequisites

| Capability | Source implementation and bounds | Installed evidence needed |
|---|---|---|
| Private original storage | Explicit `OPERATIONS_BROWSER_ARTIFACT_BOUNDARY_REVIEWED=true`; `OPERATIONS_BROWSER_ARTIFACT_DIR` outside checkout; preexisting service-owned 0700 root; UUID objects 0600; no symlinks/hardlinks; SHA256/length verified on every read. | Actual directory owner/mode/ancestor/custody; exact mounted path; write/read/restart/corruption/refusal/cleanup proof using a disposable source. |
| Capacity/retention | `OPERATIONS_BROWSER_ARTIFACT_QUOTA_BYTES` 16 MiB–2 GiB; account/project capped at 128 MiB; max object 16 MiB; original default retention 14 days; cumulative attempt output budget never replenished by deletion. | Effective installed quota/config; fresh intake and allocation failure; pending cleanup versus completed tombstone after restart. |
| UTF-8/CSV interpretation | Bounded inert text; fatal UTF-8/control-byte checks; max model text 12,000 bytes aggregate in active source model path. | Actual source upload/review/consent/conversion; original/download checksum preserved and no disclosure without approval. |
| PNG/JPEG interpretation | Explicit absolute `OPERATIONS_BROWSER_IMAGE_RUNNER` plus `browser-artifact-image-v1` capability; fixed decoder process; max input 8 MiB, 8,192 px axes/16M pixels; model images aggregate max 2 MiB. | Installed fixed wrapper must enforce CPU/memory/process/filesystem/network/teardown boundaries before parser; genuine image-provider interpretation, not injected decoder fixture. |
| Screenshot redaction | Explicit absolute `OPERATIONS_BROWSER_REDACT_RUNNER` plus `browser-artifact-image-redact-v1`; normalized PNG derivative, human rectangles, same dimensions, original-parent retention ceiling. | Real installed normalization/masking and failure bounds; exact derivative review before download/model release. Masking is not automatic secret detection. |
| PDF interpretation | Explicit absolute `OPERATIONS_BROWSER_PDF_RUNNER` plus `browser-artifact-pdf-v1`; fixed `/usr/bin/pdftotext` argv; 5 s maximum; bounded output; no backend fallback. | Reviewed installed wrapper/process boundary and real document extraction under that wrapper; capability text or local injected test launcher does not establish it. |
| Downloads/uploads | Current attempt, exact asset pins, effect permissions and approvals, MIME/size budget; retained terminal download requires fresh human release review. | Real website download/upload, current target/approval, refused unreviewed content, Stop and cleanup. Preserve historical Python 500/429 download failures. |

No production decoder-wrapper installer was found under `scripts/` or `deploy/`
in this audited base. Environment defaults intentionally omit storage/wrappers.
The runtime package's successful installation does not establish these separate
private-storage prerequisites. The release coordinator must discover a supported
fixed operation for provisioning rather than wrapping arbitrary shell in another
connector verb. Missing a decoder reports that optional format unavailable.

## Canonical data/interface map and staged completion

| Responsibility | Existing authority | Remaining coherent implementation |
|---|---|---|
| Original source/version | Immutable `ops_browser_artifacts` original ID/hash/MIME/length, author/project, original private bytes. Replacing content means new ID. | Logical source family/version linkage, parser version/page-span extracts and source-to-guide mapping. Current asset pins do not provide a complete source-library version hierarchy. |
| Editable generated settings | Immutable conversion original text/pins/result and editable saved browser configuration versions. | AI-generated Operations **guide** draft from sources, comparison/citations, preserved parser provenance, normal independent guide submission/review. Conversion to browser configuration is not guide-generation parity. |
| Reviewed guides | Existing Operations guide submissions/versions, exact content hashes and contributor/evidence manifests. The current authorized editor `Save and approve` path can publish its own exact bytes; the separate submission/reviewer path remains. | Reuse the current human publishing workflow for generated guides; do not reinstate a historical independent-review gate for every guide. Explicit reusable cross-project knowledge grants must check both source and destination access and withdrawn versions. Membership alone grants no cross-project authority. |
| Run outcomes/events | Selected-browser runs/attempts/steps/approvals/model calls, run sources, exact fence/policy/configuration pins and lifecycle records. | Causal completeness inventory/projection, human comments with append-only corrections and linked retry/uncertainty outcomes; no replay of possibly applied action. |
| Private objects | Local bounded original/artifact store; immutable metadata and deletion receipts. | Generic object adapter plus project-scoped encryption/custody/backup/restore and finalization reconciliation if S3 is selected. Existing unrelated S3 backup code is not this capability. |
| Optional retrieval index | Existing bounded current-run page-text memory only. | Derived source/version/chunk index, current grants rechecked before bytes, revocation/deletion invalidation, bounded embedding cost and rebuild. Current memory is not storage/search parity. |
| Audit | Local DB transactions and immutable-table triggers where present. | Transactional outbox/object finalization ordering, independent anchoring only if administrator-resistant evidence is selected. Host administrators can modify local DB/storage; no independence claim. |

Recommendation: keep existing SQLite authority and bounded private local objects
for the initial source/guide/history feature. Add an adapter without moving
existing data; make S3 and semantic indexing optional configured capabilities.
The precise product decisions for an S3 rollout are destination/custody and
credentials, retention/holds/deletion including backups, and maximum storage/
provider cost. Independently protected audit needs a separately controlled
signing/anchor destination. These choices do not delay local public functionality.

Before an object adapter ships: reserve metadata+quota transactionally, write to
an opaque staging object, verify checksum, finalize object, commit sealed receipt
plus outbox; recovery reconciles interrupted reservations/orphans without
replaying external actions. Current local allocation/deletion tests cover local
write/unlink+DB interruption. Off-host encrypted backup and isolated restore
still need real evidence; never re-enable restored grants or uncertain tasks
without current authority/revalidation.

## Remaining original vision

| Item | Status | Evidence / deployment | What I should see or be able to do |
|---|---|---|---|
| Source discard/retention/provenance receipt slice | In progress | 44 backend source regressions pass; release/review pending. | Discard private source; see pending cleanup then actual local deletion receipt without losing history. |
| Source ingestion and configuration conversion | In progress | Source exists; actual installed file/decoder/provider proofs pending. | Upload reviewed supported source, retain original, obtain editable source-linked settings with real provider/cost evidence. |
| Source-to-reviewed-guide generation (F8) | Not started | Architecture map above; existing guide publishing paths preserved. | Compare original/extract/draft, correct citations, explicitly approve immutable guide version through current authorized workflow. |
| Complete durable comments/history/retrieval (F9) | Not started | Existing run records/artifacts are partial foundations. | Read causal outcomes/comments/corrections/artifacts with permissions, retention and recovery. |
| Bounded stills/import feasibility (F1) | Not started | Existing RecapShare is preserved; no importer/readiness inferred. | Select stills/inert metadata without replay or account authority. |
| Explicit additional capture/training materials (F2) | Not started | Transient browser viewing is not recording consent. | Explicit start/pause/stop/cancel, excluded surfaces and bounded retained media. |
| Shared approved knowledge/guides (F3) | Not started | Current project guides stay sufficient for basic use. | Reuse exact approved versions under source/destination grants; revoked knowledge disappears from retrieval. |
| Practice/critique/reviewed improvements (F4) | Not started | Existing rehearsal is a foundation only. | Submit attributed improvement proposals for human review; never auto-approve authority. |
| Concurrent tasks/agents (F5) | Not started | Independent implementation agents are not product worker concurrency. | Isolated queued runs, fair admission, shared budget reservations and per-run Stop. |
| Multi-run Flightdeck/integrations (F6) | Not started | Current one-run deck is being aligned in the frontend slice. | Supervise several authorized runs without exposing other run credentials/private frames. |

Estate-wide operations (F7) are outside this request. Historical gates/failures
remain evidence; current authorization permits this scoped implementation and
does not fabricate successful installed operation or storage/search completeness.
