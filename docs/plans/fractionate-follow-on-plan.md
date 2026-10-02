# Official follow-on list — after the first supervised agent

User-selected sequencing, 2026-09-25. Complete A1–A8 first; then scope and complete
this list in order, one separately bounded section at a time. No item below is
silently dropped. Feature design may conclude an approach is infeasible; report
that outcome and an alternative rather than pretending implementation occurred.

| ID | Remaining original scope | Boundary and expected result | Status |
|---|---|---|---|
| F1 | D5 import/capture feasibility and bounded still import | Reinspect exact RecapShare export source; evaluate account/backend independence and bounded archive parsing; then separately implement selected stills/inert metadata import if feasible. Explicit private review/sharing, no execution or replay. | Deferred until after A8 |
| F2 | Explicit capture and additional modalities | Consent/excluded surfaces; explicit start/pause/resume/stop/cancel with no inherited auto-send/auto-resume. Expand screenshots, video, narration/audio, camera and DOM/event capture one at a time with privacy/storage limits. DOM replay/action verification requires its own authority review. Preserve RecapShare; do not assume reuse is safe. | Deferred until after F1 |
| F3 | Shared Knowledge library | Reusable approved guides/knowledge across permitted projects, version/provenance ownership, access-aware retrieval and revocation. The A1–A8 direct guide assignment remains sufficient for the first agent. | Deferred |
| F4 | Richer practice, critique and learning | Beyond A7's basic rehearsal/recovery: structured critique, richer practice scenarios and human-reviewed improvement proposals. Never self-approve guide changes or silently broaden authority. | Deferred |
| F5 | Multiple agents and concurrent work | Scheduling, multiple profiles/workers/runs, isolation between simultaneous tasks, queue fairness, budgets and per-run cancellation. No shared identity implies shared authority without review. | Deferred |
| F6 | Advanced Flightdeck and broader workflow support | Multi-run supervision, richer observation/takeover, more applications/integrations/providers and additional workflow types beyond the one A1 pilot. Preserve the minimal A6/A7 controls and Dev Studio's existing technical contracts. | Deferred |
| F7 | Remaining estate-wide operations and release work | Non-pilot privileged LXC-to-VM migration/cutover; wider deployment acceptance, remaining historical PR integration and credential rotation; evidence scheduling/erasure or verified Lean BEAF upload cleanup not needed for A8. Carry forward all unresolved original SEC/INF IDs. | Deferred only where not an A1–A8 dependency |
| F8 | Source ingestion and AI-assisted guide drafting | Map text/images/documents, private preserved originals, validated extraction, source-linked AI structured drafts and explicit human guide approval/versioning. Reuse F1/F3 boundaries; no stack selection, automatic approval or execution. | Architecture backlog recorded 2026-10-02; implementation not started |
| F9 | Durable run outcomes, comments, artifacts and retrieval | Map relational authority/state, private object/S3-compatible storage, an optional derived vector index and an append-only event ledger, including completeness, access, provenance, recovery and retention contracts. | Architecture backlog recorded 2026-10-02; implementation not started |

F1 preserves the former optional D5 as planned follow-on work rather than the next
section. Its existing D5 prompt is a feasibility prompt, not authorization for an
importer or capture. The old estimate of another 6–10 conversations was provisional;
F1–F7 are seven scope groups, not seven guaranteed implementation sessions.

Security, authentication, resource isolation and safe deployment required by the
first usable agent are in A1–A8. They cannot be deferred to F7 to claim A8 complete.
Broader infrastructure work is deferred only after A1 documents why the selected
pilot does not depend on it. No existing finding is closed by this reordering.

Completed foundation work (branding, naming, retirement preparation, Operations
B1–B4, Demonstrations D1–D4 and accessibility fixes) stays completed locally with
its recorded limits. It is not a new follow-on batch. Implementation review/CI
and actual deployment acceptance remain separate.

## Guide ingestion and run-history architecture - 2026-10-02

Thomas requested planning for adding text, images and documents, having AI turn
them into the required guide format while saving both, and retaining run
outcomes/comments/artifacts in a mapped relational/object/vector/ledger system.
This is **architecture backlog, not implementation or stack selection**. F8/F9
extend the visible follow-on list; they do not waive A8, guide approval,
credential boundary or existing privacy/recovery requirements. The broker
boundary and expanded capabilities remain pending CB-01 through CB-08 in the
[credentials backlog](fractionate-project-credentials-backlog.md#broker-boundary-and-expanded-capabilities-backlog---2026-10-02).

### Current contracts to preserve

- Operations guide drafts are plain text: title and instructions. Submission
  requires both to be nonempty and freezes the exact content hash, contributors
  and selected evidence. Approval normally requires an independent reviewer;
  the existing exact-submission, short-lived A8 pilot exception is not general
  self-approval. Published versions and corrections preserve prior history.
- Existing `synthetic_sign_in` browser execution additionally requires exactly
  one strict `proxypilot-rules` JSON block. Code validates the typed action,
  approval/stop and budget fields; the model cannot reinterpret these rules.
  Current configured API tasks instead bind reviewed guide/configuration and
  typed Controls/readiness records; free-form prose alone grants no execution.
- Private PNG/JPEG still evidence, raw/derivative relationships, annotations,
  explicit privacy-reviewed publications and exact guide evidence manifests
  exist behind separate evidence deployment gates. They are not a PDF/office
  document importer, OCR/AI guide converter or source-library service. Physical
  retention/deletion remains policy-controlled; existing raw images are not a
  promise to retain every original forever.
- Existing relational records include immutable guide submissions/versions,
  manual outcomes/notes/correction chains, agent steps/approvals/results,
  broker task receipts and domain events. Current browser frames/video are
  transient; raw page text, secrets and prompts are deliberately excluded.
  No complete cross-run comments/artifact store, vector retrieval platform or
  independently immutable ledger is claimed by those records.

Source contracts: `admin/backend/src/lib/operational-projects-{logic,workflow,schema}.js`,
`operational-run-policy.js`, `operational-evidence-{intake,guide,store}.js`,
`operational-run-coordinator.js` and `docs/features/operations.md`.

### F8 - preserve originals and produce a reviewed structured draft

Plan the end-to-end flow before choosing technologies:

1. Define accepted source formats/size limits, text paste and upload semantics,
   permissions/consent, provenance, and a private object/source ID. Preserve
   originals as separate immutable content versions with checksums, media type,
   owner, source/time and access/retention classification; preserve later edits
   as new versions, not overwrites. Imports do not fetch arbitrary URLs or run
   document macros, scripts or embedded instructions.
2. Specify bounded isolated decoding, document extraction and optional OCR.
   Keep extracted text, redacted derivatives and structured draft as distinct
   linked artifacts; retain page/image/span provenance and parser versions.
   Apply privacy review, malware/prompt-injection handling and explicit model
   provider disclosure consent; uploaded content remains untrusted data.
3. Have AI propose the selected workflow's schema-valid guide draft, identifying
   unsupported actions, missing information and uncertain mappings. Record
   source-version references, generation/model/schema versions, timestamp and
   reviewed settings/cost evidence. Save the original and each generated draft
   separately; never replace the source or infer credentials, permissions or
   approvals from narrative. A draft is not executable authority.
4. Present original-versus-draft comparison and source citations for human
   correction. Run deterministic schema/boundary checks before normal submission
   and independent human approval. Publication creates a new immutable guide
   version/hash; editing source or generated instructions requires a new review.
5. Bind every use/run to the exact approved guide version/hash and the relevant
   input/source manifest, configuration, policy and approval revisions. Withdrawal
   or access loss must prevent future retrieval/use; no stale vector hit or AI
   proposal can revive a withdrawn guide or automatically start a run.

Architecture deliverables: source/derivative/draft/approval state map; supported
formats and validators; threat/access/consent model; version/provenance schema;
review UX; failure/reconciliation/retention/restore contracts; bounded first
ingestion proof and acceptance matrix. Reuse F1's capture/import feasibility and
F3's shared-knowledge permissions rather than creating competing authorities.

### F9 - map durable run history and its storage responsibilities

The proposed roles are separate contracts; they do not mandate four products or
select a database, vector engine, object provider or cloud deployment:

| Responsibility | Proposed contents and authority | Questions to resolve |
|---|---|---|
| Relational state | Canonical user/project access, source/guide/configuration versions, run/task/attempt/fence identities, approvals, status, outcomes, comments and artifact/provenance references. | Reuse existing SQLite records where appropriate; map ownership, revisions, migrations, concurrency, indexing and per-entity isolation before selecting a target. |
| Object / S3-compatible storage | Private original text/images/documents, validated extracts/derivatives, generated drafts and explicitly authorized run artifacts, each with stable opaque ID/checksum/version. | Placement/custody, encryption, exact scoped read/write access, quotas, retention/holds/erasure, partial uploads, integrity, backup and isolated restore. No secret material in public buckets/URLs. |
| Optional vector index | Derived, permission-aware searchable chunks/embeddings linked to source/guide/artifact versions and citations. It is rebuildable retrieval, never canonical evidence or authorization. | Whether semantic search is needed; model disclosure/cost; chunking/versioning; isolation; current authorization rechecked before content return; revocation/deletion propagation and stale-index denial. Credentials are never embedded. |
| Append-only event ledger | Durable ordered events for proposals, starts, steps, approvals, outcomes, uncertainty, comments/corrections, artifact linkage, costs and relevant state changes. | Define event IDs/order, idempotency, state-plus-event transaction/outbox, actor/source provenance and replayable projections. Distinguish database append-only rules from tamper evidence against administrators; independently anchored/signed custody is a separate acceptance decision. |

Define "all outcomes/comments/everything from runs" as an explicit completeness
inventory, with intentional privacy exclusions. Include successes, denials,
failures, cancellation, interrupted/uncertain work, reconciliation, retries as
new linked attempts, human annotations/comments and correction history,
guide/policy/worker/build pins, approved input manifests, sanitized results and
verified usage/cost (unknown remains unknown). Identify which source emits each
event/artifact and how completeness is checked. Do not silently add raw secret,
cookie/token, password, prompt, page-text, audio/video or screenshot retention;
each sensitive modality needs consent, redaction, access and retention decisions.

Map the run/source/guide/artifact/comment/event relationships, permission-aware
queries and causal history. Corrections append superseding records rather than
rewriting history; privacy erasure/holds need explicit policy and tombstone rules,
not an unsupported promise of perpetual or undeletable storage. A lost receipt
does not authorize repeating a possibly applied action.

The first architecture review must cover canonical state versus projections,
transaction/outbox ordering, object finalization/orphan reconciliation, vector
rebuild and revocation, crash recovery, audit completeness, per-project/entity
access tests, backup/restore, capacity/cost and staged migration from existing
stores. Deliver the conceptual data/interface map and acceptance plan first;
implementation and exact service choices need a later scoped decision.

### Planning estimate boundary

The discussed **1-2 working days** is a rough estimate for a bounded UI/mockup
alignment pass after agreeing exact screens and responsive acceptance. It is not
an implementation start, fixed delivery commitment, or estimate for CB-01/08,
F8/F9, real adapters, custody provisioning or production activation. Estimate
those separately after their architecture and security scope are mapped.

Canonical first list: [A1–A8](fractionate-agents-a1-a8.md).
