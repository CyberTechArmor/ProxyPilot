# Browser configuration draft contract

`proposal-v1.schema.json` defines the strict selected-browser v1 draft. `fixtures/general-agent.draft.json` is a complete valid example. Backend validation uses the byte-identical trusted schema in `admin/backend/src/lib/operational-browser-agent-proposal.schema.json`, with additional cross-field, canonical-origin and UTF-8 bounds.

The import wrapper is `{ "configuration": <proposal>, "source_text": "optional original source" }`. Unknown fields are refused. Save retains canonical configuration/source hashes and immutable revisions. Explicit origins, request classification and approval settings are requested metadata only.

This configuration release has no selected-browser execution or model endpoint. Readiness is always blocked with `can_start:false` and `execution_enabled:false`; reachability, network policy, assets and model consent remain unfinished or unverified. Internal origins and policy references never confer access.

See [the release scope and proof](../../docs/plans/browser-configuration-import-20261002.md) for permissions, guide pinning, UI, routes and verification.
