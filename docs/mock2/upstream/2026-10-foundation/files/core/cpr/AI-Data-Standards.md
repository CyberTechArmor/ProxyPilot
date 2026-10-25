# AI, retrieval and object data

These requirements extend the existing host AI, jobs, secrets, usage, permissions, storage and
realtime contracts when the corresponding capability is used. New PRO applications start on the
application foundation stack (PRO current §W.6): PostgreSQL with pgvector, S3-compatible object
storage and an embedding service, provisioned by the host with the application, with storage and
embeddings each switchable off per deployment. A standards upgrade adds no service to an
established application. Features consume host capabilities; provider credentials stay sealed in
host services. Keep offline fakes, scoped usage metering and configurable provider/model selection
already required by PRO.

## Embedding identity and migrations

Define an immutable embedding configuration: provider, exact model/revision, dimensions, distance
metric, normalization, input limits, extraction/chunking version and index version. Persist it with
each vector or its unambiguous index namespace. Query vectors must use the same configuration as
the index. Equal dimensions do not make different models compatible. Never silently mix spaces.

This narrows Addendum A.2's automatic sunset/failover rule: embedding-model replacement is an
explicit re-embedding migration, even when its provider calls it an alias update. Create a new index,
re-extract/re-embed as needed, evaluate retrieval and tenant/document access, switch the active
configuration, and retain the former index for the documented rollback/retention period. Failover
is allowed only to an independently verified identical space; otherwise queue/retry or report
unavailability. Do not silently query an old index using a new embedding model.

*Amended in 1.39.0.* A provider, model or dimension change builds the new index from the stored
content of the active one and validates it before the switch — at least the item count, the
dimensions and a self-retrieval sample — and only a validated index becomes active. The adapter
sends the model and the dimensions explicitly on every call and checks the length of what comes
back; a provider default is never relied on. The foundation stack's bundled local model
(`BAAI/bge-small-en-v1.5`, 384 dimensions) is development quality: the application's admin area and
the host both warn to switch to OpenAI or another provider for production-quality search. An
OpenAI configuration names its model and dimensions (for example `text-embedding-3-small`, 1536).

## PostgreSQL and vector retrieval

New applications start with the selected PostgreSQL 18 maintenance release and the explicit pgvector
pin from creation: the foundation stack's database is PostgreSQL with pgvector (*amended in
1.39.0*; before 1.39.0, only when vector retrieval was used). pgvector is an extension, not bundled
merely by choosing a PostgreSQL major; PostgreSQL 16 can also run it. Provision its server binaries
and enable `vector` in each authorized database through the migration owner. Check actual
`server_version` and `pg_extension.extversion` at startup/readiness and in deployment evidence. Test
generated Drizzle migrations and vector operators against the real supported server/extension pair.
Extension upgrade, restore availability, index rebuild requirements and rollback compatibility
belong in the release record. A PGlite-only test cannot establish this production contract.

Choose exact search or HNSW using measured recall/latency and memory. Verify index dimension/type
limits before picking an embedding model (pgvector HNSW vector: 2,000 dimensions; halfvec: 4,000).
Above 4,000 dimensions the index is an exact scan, and the host reports it as one.
Use host search APIs so storage engines can change without changing features. Combine PostgreSQL
full-text and vector candidates when lexical and semantic retrieval are both needed; reranking is
optional and evaluated. Apply tenant/document permissions in retrieval before any content enters
the model context, and test denied documents and tenants. Retrieved text is untrusted evidence;
it cannot grant permissions, execute tools or override application instructions.

## Sources, files and ingestion

Private S3-compatible object storage holds original PDFs, images, audio/video and large artifacts.
PostgreSQL holds ownership, object key/version, content hash, size/type, revision, lifecycle state,
document/chunk IDs, extraction/chunking provenance, ACLs and embedding/index state. Small structured
values or deliberately bounded blobs can stay in the database when justified; do not default large
file bytes to PostgreSQL. Choose the actual object provider under the host's existing storage
contract and record its version/identity, limits, retention and backup policy. S3 is an API contract,
not a universally versioned server product.

*Amended in 1.39.0.* Objects go through the host storage adapter only. The foundation stack's bundled
S3-compatible store is the default; any S3-compatible provider (Cloudflare R2, AWS S3, Backblaze B2,
MinIO and others) replaces it through the same adapter by a per-deployment setting, with no feature
change. Turning storage off never deletes objects. A provider switch while objects exist is a
person's choice between copying every object, verified by size and sha256 on the target before the
new provider becomes active, and deliberately starting fresh with the old objects kept where they
were. Objects are never stranded silently.

Use unique immutable object keys and bounded authorized uploads/downloads or short-lived signed
URLs. Validate type, size and content; scan/sandbox extraction through existing host jobs as needed.
An object write and database transaction are not atomic together: model pending/available/deleting
states with an outbox or equivalent reliable job and a reconciler for orphan/missing objects.
Never advertise an object as available before the durable write is verified. Deletion removes
sources, chunks, vectors and objects under the same host policy; backup recovery rechecks integrity.

Use the host job queue for extraction, chunking, embedding and indexing, with source-revision and
configuration-based idempotency, bounded retries/concurrency, backpressure and restart recovery.
Changed sources invalidate their prior chunks/vectors; stale jobs cannot publish over a newer
revision. Record ingestion lag, failed jobs, token/request usage and cost, and retrieval latency,
quality and access-test evidence. Do not invent provider pricing or a model-generated dollar value.

## Readiness is a real operation

*Added in 1.39.0.* Database, storage and embeddings each report `ready` only after a real operation
succeeded: the database answered a query and a vector operation; storage completed a put, get and
delete of a probe object; the embedding provider returned one probe embedding with the configured
dimensions. A filled-in setting or a present key is never readiness. Missing credentials are
reported as missing, a switched-off feature as off, and the capabilities that depend on it as
unavailable. A mock provider and the local development-quality model say what they are and are
never reported as production-ready.

## Scale and replacement path

Start with application PostgreSQL + pgvector; isolate vector work in a dedicated PostgreSQL
deployment when measurements show contention with transactional traffic. Move to a distributed
vector engine such as the selected Qdrant release behind the same host search API when sharding,
replication, availability or measured resource limits justify it. Do not choose by a universal
vector-count threshold: dimensions, tenant filters, write/query concurrency, indexing overhead,
recall and target latency matter. One million 1,536-dimension float32 vectors alone use about
6.1 GB, before indexes, metadata and replicas.

Benchmark representative data and permissions, establish an agreed latency/quality/resource
budget, and retain source chunks and embedding configuration so an index is rebuildable. Migrate
with versioned namespaces and shadow evaluation, verify ACL/filter equivalence and deletions, then
switch the host search adapter with a tested fallback. Qdrant is a scale option, not an automatic
second database dependency for every application.

Official contracts: https://github.com/pgvector/pgvector,
https://orm.drizzle.team/docs/extensions, https://qdrant.tech/documentation/scaling/distributed_deployment/,
https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html.
