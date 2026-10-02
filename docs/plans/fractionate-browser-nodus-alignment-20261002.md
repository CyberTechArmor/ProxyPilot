# Browser evidence and Nodus source alignment — 2026-10-02

The parent inspected actual Nodus source read-only in the `fractionate/nodus`
LXC at `/opt/nodus`. This document distinguishes those source observations from
ProxyPilot's implementation. No Nodus runtime configuration, current Git commit,
live storage or live search behavior was verified. ProxyPilot does not activate
an embedding service, vector index or S3 bucket in this browser slice.

## Observed Nodus contracts

| Area | Actual source behavior | Source |
| --- | --- | --- |
| Evidence identity | PostgreSQL passages and passage sources retain meeting/attachment identity, source kind/reference/hash, text, timestamps, pages and speaker. Passage vectors use passage+model identity; model and authorized meeting IDs constrain search. | `src/db/migrations/0011_across_meetings.sql`, `src/services/passages.ts`, `src/services/search.ts` |
| Search | Generated simple-text search with GIN; partial cosine HNSW indexes for1536 and384 dimensions; pgvector0.8+ relaxed iterative scan with ef100. Reciprocal-rank fusion uses k60, top20, at most6 hits per meeting. Semantic failure visibly falls back to keyword search. | `src/services/search.ts`, `src/db/search-index.ts` |
| Embeddings | OpenAI text-embedding-3-small1536; text-embedding-3-large explicitly shortened to1536; ada0021536. Local English-only bge-small-en-v1.5 uses384 dimensions, ONNX single thread, WordPiece512, normalized CLS and query prefix. | `src/db/search-index.ts`, search services |
| Chunking and lifecycle | Transcript chunks about1600 characters with one-turn overlap; documents about2000/200 overlap and page references; summaries/todos/images separately sourced. Unchanged content retains vectors. Five-second worker handles ended meetings/ready files; OpenAI batches64, local16; source retries1h and embedding retries1min. Parallel index build switches activation atomically and retains old index. Foreign-key deletion cascades; deleted passages are not reinserted during delayed embedding completion. | `src/services/passages.ts`, `src/db/search-index.ts` |
| Storage | Attachment location selects database or S3 with object key and SHA; durable deletion queue. Save falls back to database bytes on S3 failure. Moves in either direction read back and verify SHA before deleting the previous copy. Object keys include prefix/meeting/attachment/nonce; authenticated application routes serve files. Queue object identity before PUT to reconcile uncertain orphan writes. Transactional row deletion queues object deletion; only unused keys are deleted, with retry1,2,4min capped at a day. | `src/services/file-storage.ts`, `src/host/s3.ts`, `src/db/store.ts`, migration0012, `src/routes/attachments.ts` |

Nodus attachments permit15MiB,50 files per meeting and JPEG/PNG/WebP/PDF/DOCX/TXT/MD.
Its SigV4 adapter supports path-style and virtual-host requests, with source
compatibility for SeaweedFS, MinIO, AWS, R2 and B2. Endpoint/bucket/prefix changes
while objects or queued deletions reference them need an explicit migration.
Ordinary object DELETE without VersionId does not establish permanent erasure in
a versioned bucket.

Parent-recorded source SHA256 pins:

- `src/services/search.ts`: `b5fd30d1163358345cb2beef22e5da251910b009cab3fd82f708a6bca8370426`
- `src/services/file-storage.ts`: `a3b82903f6fb0ef2ade06ee0d150e452338aa813e2f42890d959b4a25b54db4b`
- `src/host/s3.ts`: `bc6d5751dc941530d63acc628cbd69960d7b42f4b8fdff9109c29353e4e643ee`

## Implemented ProxyPilot alignment

F1 private files are separate from SQL provenance and approvals. Exact project,
run, attempt, generation, content hash, MIME and byte-count pins identify every
source. Page captures retain snapshot/origin/URL hash, capture time, worker
contract and `browser-text.v1` chunker identity. O1 records the model call IDs
that actually received each source; reports can cite only those disclosed
artifact IDs. Bounded recent-page memory supports selected-site series without
silently indexing project data or adding a provider call.

Private files use a pre-existing service-owned0700 root,0600 files, directory
descriptor/identity pins, no-follow opens and short read leases. Physical and
logical checks repeat before disclosure, after parser/provider awaits, before
browser input execution and before approving held HTTP writes. Files must remain
available and authorized for a report to remain visible. Source deletion,
expiration, guide withdrawal or consent revocation withholds the derived summary;
immutable receipts and historical report records remain for reconciliation.

This deliberately strengthens current-access checks observed in Nodus's
`src/host/access.ts` and `src/services/across.ts`: an access snapshot cannot be
reused indefinitely through tools, and retaining answer text must not disclose a
deleted or newly inaccessible source. The current source model requires fresh
authority at every read, disclosure and settlement.

F1 metadata and deletion receipts preserve immutable evidence identities and
durable cleanup outcomes. Completed retained downloads/screenshot derivatives
may receive fresh human review; completion grants no model or execution access.
Actual decoder isolation and installed browser-host isolation remain separate
acceptance gates, regardless of local correctness tests.

## Future adapters, outside this slice

An embedding adapter must pin provider, exact model, dimensions, model version,
chunker version and source content hash. An index build must carry an explicit
cost/consent decision, maintain current permission filters, support keyword
fallback visibly, and keep old active state until a new index is verified.
Merely finding an OpenAI credential must not start indexing.

An S3 adapter can reuse the proven staging/readback/hash/deletion-queue design,
with authenticated application file access and no bucket URLs in browser/model
prompts. It needs separately reviewed endpoint, bucket, key prefix, credentials,
retention/versioning and migration behavior. No broad credential activation,
automatic storage migration or vector-memory MVP is included here.

## Local evidence and limitations

O1 tests exercise real F1 multisite capture/provenance, actually disclosed cited
reports, physical deletion/expiry/withdrawal suppression and deletion during an
awaited model result. F1 tests exercise private file tampering, path replacement,
leases, quotas, cancellation, upload parser admission and local decoder behavior.
These are cloud repository tests. They do not prove Nodus runtime behavior,
installed Incus/nft/Neko privacy, a real model provider, S3 or pgvector operations.
