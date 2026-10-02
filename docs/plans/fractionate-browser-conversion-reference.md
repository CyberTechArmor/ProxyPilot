# Reviewed browser conversion and model boundary

This repository slice adds the `browser-agent-conversion.v1` draft workflow and
the `selected-browser-model.v1` provider contract. It does not install, activate,
publish, or deploy a runtime. The shipped demo sign-in path remains independent.

## Conversion

`createBrowserConversionService` is dependency injected. Migration 1120 stores
immutable original instructions, their UTF-8 hash, exact approved guide and
asset pins, owner disclosure, bounded budgets, call identity, and conversion
outcome. A backend restart marks outstanding conversions interrupted. It does
not resume or retry them.

An owner must explicitly submit:

```json
{
  "source_text": "The original instructions, preserved verbatim.",
  "source_asset_refs": [],
  "project_revision": 2,
  "guide_ref": {"id": "<current approved guide UUID>", "sha256": "<64 hex>"},
  "disclosure": {
    "enabled": true,
    "reviewed_statement": "Send the original instructions and explicitly approved private image or file content to the model provider to suggest an editable browser-agent draft"
  },
  "limits": {"max_seconds": 120, "max_tokens": 30000, "max_usd": 0.1}
}
```

This example describes the API fields; placeholders are not valid UUIDs/hashes.
The conversion is asynchronous. Its result contains a complete schema-validated
`configuration`, `assumptions`, `warnings`, `ambiguities`, and provenance.
`requires_review` is true; `persisted` and `execution_enabled` are false. A
separate explicit configuration save and run approval remain necessary.

The generated configuration must preserve the original instructions, source
asset pins and exact current guide. It cannot supply a network-policy grant or
invent upload-asset references. Exact suggested sites remain editable draft
metadata. Destination checks, per-action approvals and runtime readiness remain
independent requirements.

Source text is bounded to 6000 UTF-8 bytes. At most eight private asset references
can be supplied. F1 resolution requires same-project original hash/MIME/length
pins, immutable `asset_use` and `model_input` review, and owner access. Model
disclosure consent is separate. Resolved text is capped at 12000 UTF-8 bytes;
the full model text prompt is capped at 16000 bytes. Total normalized image data
is capped at 2 MiB. Supported decoders are reported through F1 capabilities;
PDF or image support is not inferred from an uploaded extension.

For normalized images, the original asset reference and its hash stay unchanged.
`content_sha256` and `image_mime_type` separately bind the disclosed image bytes.
Only pinned inline data reaches the provider; the provider is never given an
image URL to fetch.

Project ownership/revision, access, guide and source reviews are checked before
work, after awaits, and before publication. Cancellation suppresses publication
and prevents queued provider admission. Already accepted work may still settle;
there is no refund assumption or automatic retry. Original source bytes and
finished conversion evidence cannot be updated or deleted in place.

## Provider and browser decisions

`createBrowserModelBridge` requires an Ed25519 supervisor receipt key. Its
readiness checks the versioned installed host adapter and a fresh signed price
snapshot. It has no fallback provider or credential path. The host helper is
`scripts/selected-browser-model.py`; A4 adds only `browser_model_call` and
`cancel_browser_model`, retaining existing host-owned provider-key custody.

The request binds project, approved guide, consent, policy, run, single-use call,
attempt/fence, current snapshot, candidate hashes, source content hashes,
deadline, original run ceilings and exact per-call reservation. Conversion has
null attempt/fence. JavaScript and Python normalize both USD doubles to the same
IEEE-754 bytes before computing the request digest.

The broker durably reserves before provider admission. It requires a pinned
run with explicit token/USD ceilings and no website credential. It checks the
quoted price revision and that its computed worst case fits the call reservation
before reading the provider key or sending. Images reserve every encoded byte
plus bounded per-image overhead rather than assuming zero image cost. Missing
usage, prices, uncertain provider outcomes or an exceeded reservation fail
closed. No website authentication binding is activated by this work.

All page/file/image text and candidate labels are untrusted data. Browser
decisions can return only a supplied candidate ID, `done`, or `escalate`.
Reports cite only supplied source/snapshot IDs. Unknown candidates, arbitrary
selectors/code/URLs, extra output fields, altered receipts, changed input hashes
or price/usage mismatches are rejected.

`draft_input` is a separate non-executable proposal: one known current type/paste
target, literal text (at most 12000 UTF-8 bytes) and a purpose of at most 500 UTF-8
bytes. It has a
configured report-output cap (default 1500, at most 2000 tokens). It cannot stage
input or mint an action. O1 requires human
preview/approval of the exact target and text before private staging; R1 then
revalidates the current DOM and creates an opaque executable input candidate.
The subsequent action and wire-effect approval checks remain independent.
Manual authentication disables autonomous model disclosure and drafting.

The signed `pbm1` receipt binds exact request/response hashes, project/guide/
policy/consent identity, attempt/fence, usage, settled USD and price revision.
The backend verifies it before treating any provider reply as a decision,
report, draft input, or conversion suggestion.

## Local verification and remaining acceptance

The focused Node tests cover owner disclosure, original provenance, cross-project
and unapproved sources, staleness/revocation, cancellation, bounded draft input,
out-of-candidate replies and forged receipts. They also verify real Python-signed
receipts in JavaScript and Unicode/tiny-float digest equality.

Python tests cover the host adapter and existing broker ledger, including a real
temporary Unix socket carrying bounded private image data, old-method size caps,
price changes, insufficient reservations, cancellation during key read, unknown
usage and no private image content in the durable broker journal. The original
A4 broker and public Website review suites remain regression checks.

No live provider or third-party website call was made for these fixtures. Real
installed supervisor integrity, isolation, target/site policy, provider text and
multimodal acceptance, and live-control proofs still require an authorized
target. Host-root-equivalent backend custody (S6/SEC-01), broad credential-broker
enrollment decisions and deferred A8 work are unchanged backlog items.
