# Deliberate human browser-run comments — 2026-10-04

Migration1125 adds project/run/attempt-scoped human comments with monotonic
pagination, exact UTF-8 content hashes, idempotent admission and immutable
author-only correction chains. Current project permission/account/archive checks
apply to each read/write/retry; editor/operator/reviewer/owner may append, viewers
may read. A comment does not execute a browser action, approve an effect, widen
access, enter model input or create an index. Deliberate human text is retained as
local durable project-visible history; no screenshots/page text/prompts/secrets/
audio/video are automatically added. UI must render comment text as text.

Routes: GET `/api/operational-projects/:projectId/browser-agent-runs/:runId/comments`
with bounded integer `after`/`limit`; POST same URL with
`{text,idempotency_key,supersedes_id?}`. Current human session and CSRF are inherited.
Execution/provider/private-storage availability is independent. Text is bounded
to4,000 UTF-8 bytes; run500/installation50,000 rows by default (corrections count).
Only the latest author-owned row can be corrected; each preceding text/hash and
causal link remains. Metadata-only event and comment commit in one transaction;
audit failure rolls back history. These local invariants do not establish
administrator-resistant immutability or a secure-erasure/backup policy.

Regression evidence: comments, routes and selected-runtime suites pass163/163,
with no skipped cases, including the integrated runtime history proof.
Dedicated cases cover current grant/account loss,
archive/viewer/outsider/MCP denial, CSRF, unknown authority fields, exact text,
idempotency conflicts, correction branches/ownership/scope, bound exhaustion,
monotonic pagination during admission, transaction rollback, real SQLite reopen,
integrity corruption, database scope triggers and no host/model/worker calls.

Normal application update applies an additive migration. Existing run/guide/
credential/private-file state is untouched. Independent review, CI, merge,
deployment and installed disposable comment/correction verification remain
separate; this is a useful partial F9 slice, not complete outcomes/artifact/
index/retention parity.
