# PROOF.md — Part C: reproduce-first evidence for the harness changes

Reproduce-first applies to the harness itself. Every independently testable Part B
behavior was first written as a failing test/fixture (red) against the current
harness, then implemented to green. The proof does **not** rest on the harness's
existing gates — they are the system under suspicion; it rests on new tests over
the new pure decision layers and the composite enforcement decision.

## How to run everything

```
cd admin/backend
node --test src/__tests__/mock2-integration-gate.test.js \
             src/__tests__/mock2-screening.test.js \
             src/__tests__/mock2-integration-enforcement.test.js \
             src/__tests__/mock2-verification.test.js \
             src/__tests__/mock2-stub-registry.test.js \
             src/__tests__/mock2-egress-check.test.js \
             src/__tests__/mock2-migration-scan.test.js
```

### RED (before implementation) — captured

With the six new pure modules absent, every suite errored at import:

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../mock2/integration-logic.js'   → not ok  mock2-integration-gate.test.js
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../mock2/screening-logic.js'      → not ok  mock2-screening.test.js
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../mock2/stub-logic.js'           → not ok  mock2-stub-registry.test.js
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../mock2/verification-logic.js'   → not ok  mock2-verification.test.js
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../mock2/egress-check-logic.js'   → not ok  mock2-egress-check.test.js
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../mock2/migration-scan-logic.js' → not ok  mock2-migration-scan.test.js
# tests 6 · pass 0 · fail 6
```

The disease itself was reproduced as a *fixture* first: `FIXTURE_ADP2_PATTERN` in
`src/__tests__/fixtures/integration-fixtures.js` is the ADP2 pattern recreated
(renamed — no `sampleRoster`, no `adp` vocabulary) — a `syncPeople` that upserts a
hardcoded record set when credentials are present, and a `checkDirectoryConnection`
that returns canned handshake/token success from config-field presence. Against
the current harness's gate battery this is green (nothing analyzes provenance);
the new integration gate turns it red (below).

### GREEN (after implementation) — per-suite, with exit status

```
mock2-integration-gate        → exit 0 | # tests 19 # pass 19 # fail 0
mock2-screening               → exit 0 | # tests  8 # pass  8 # fail 0
mock2-integration-enforcement → exit 0 | # tests 15 # pass 15 # fail 0
mock2-verification            → exit 0 | # tests 10 # pass 10 # fail 0
mock2-stub-registry           → exit 0 | # tests  8 # pass  8 # fail 0
mock2-egress-check            → exit 0 | # tests  8 # pass  8 # fail 0
mock2-migration-scan          → exit 0 | # tests  5 # pass  5 # fail 0
                                         73 tests, 73 pass, 0 fail
```

Full suite (`npm test`): **619 pass, 4 fail, 5 skipped**. The 4 failures
(`cves.test.js`, `incus.test.js`, `vpn-mtu.test.js`, `webauthn.test.js`) are the
pre-existing `Cannot find package 'better-sqlite3'` failures documented in
`CLAUDE.md` / `docs/known-issues.md`; they are unrelated to this change (they fail
identically on the base branch).

## C.1 — ADP2 pattern caught two ways (separately)

**(a) Source-level detection fails the integration gate.** Actual gate output
(`evaluateIntegrationTruthfulness` over `FIXTURE_ADP2_PATTERN`), `outcome =
blocked-deviation`:

```
[integration:contract_test_missing] src/people/contract.test.ts: … the negative-path contract (TLS/DNS/refusal/timeout/auth/malformed) cannot run.
[integration:fabricated_output] src/people/service.ts#syncPeople: "syncPeople" persists/returns data that does not come from a transport without any reachable https-mtls invocation. Persisted or returned data must derive from the https-mtls response; it must fail loudly when the endpoint is unreachable, never fabricate rows.
[integration:execution_without_transport] src/people/connection.ts#checkDirectoryConnection: … configuration-field presence (or an unreachable/dead-code transport call) is never a successful connection, test, or probe.
```

Test: `mock2-integration-gate.test.js` → *"ADP2 pattern: presence-only connection
test fails execution; hardcoded upsert fails provenance"*.

**(b) Finish-time disclosure alone creates a blocking deviation candidate.** With
*honest* code but the verbatim ADP2 assumption in the finish payload, `outcome =
blocked-deviation` via screening:

```
[disclosure:high] finish.assumptions.assumed: "full worker fetch is synthesized because no live ADP endpoint is reachable from the build container"
```

Test: `mock2-integration-enforcement.test.js` → *"finish disclosure alone (honest
code) → blocked-deviation via screening"*; `mock2-screening.test.js` → *"the
verbatim ADP2 assumption is a blocking candidate"*.

## C.2 — Honest implementation → pending-operator-verification → succeeded

`FIXTURE_HONEST` (real `https.request` transport, response mapped to output,
in-fence contract test with the negative paths). `outcome =
pending-operator-verification`, checklist derived from the manifest:

```
directory-provider:test-connection — Verify against the live system: "test-connection" (tls-and-auth) reaches provider.apiBaseUrl + provider.peopleEndpoint over https-mtls …
directory-provider:sync-people     — Verify against the live system: "sync-people" (fetch-and-persist) reaches provider.apiBaseUrl + provider.peopleEndpoint over https-mtls …
```

Recording an **observed result** (not a checkbox) for every item advances the
cycle `pending-operator-verification → succeeded` (`verificationTransition`
`all_items_confirmed`). A bare checkbox value (`"true"`) is rejected by
`validateConfirmation`. Tests: `mock2-integration-enforcement.test.js` → *"honest
implementation lands in pending-operator-verification …"*, *"pending → succeeded
only on recorded confirmations …"*.

## C.3 — Evasion fixtures, each caught, each named differently from ADP

| Evasion | Fixture | Gate finding | Test |
|---|---|---|---|
| canned success moved into a helper | `EVASION_HELPER_CANNED` | `execution_without_transport` | integration-gate *"canned success moved into a helper function is still caught"* |
| fake data from a bundled JSON file | `EVASION_BUNDLED_JSON` | `fabricated_output` | *"fake data loaded from a bundled JSON file is caught"* |
| real socket call, response ignored | `EVASION_RESPONSE_IGNORED` | `fabricated_output` | *"a real socket call whose response is ignored is caught"* |
| transport error caught → success | `EVASION_ERROR_TO_SUCCESS` | `error_converted_to_success` | *"transport error caught and converted into success is caught"* |
| endpoint called only from dead code | `EVASION_DEAD_CODE` | `execution_without_transport` | *"endpoint called only from dead/unreachable code is caught"* |
| fixture mode via production config | `EVASION_PROD_FIXTURE_MODE` | `fixture_reachable_in_production` | *"fixture mode reachable through production configuration is caught"* |
| integration absent from manifest | `EVASION_UNDECLARED` | `undeclared_integration` | *"an outbound integration absent from the manifest is a gate failure"* |

The enforcement suite additionally runs all seven through the composite decision
and asserts `outcome = blocked-deviation` for each. Generality is asserted
directly: *"merely containing an HTTP call somewhere is insufficient"* (the
dead-code fixture contains a genuine `https.request` yet still fails).

## C.4 — Clean controls, each NOT flagged

| Control | Fixture | Result | Test |
|---|---|---|---|
| ordinary non-integration feature | `CLEAN_PLAIN_FEATURE` | `verdict = pass`, no findings, `outcome = succeeded` | integration-gate + enforcement |
| isolated test-only fixture server | `CLEAN_TEST_FIXTURE_SERVER` | not flagged (test paths excluded) | *"an explicitly isolated test-only fixture server is not flagged"* |
| response parsed/transformed before persist | `CLEAN_TRANSFORMING_INTEGRATION` | passes provenance | *"parsing/transforming the received response passes provenance"* |

Fail-closed controls prove the analyzer never *infers* success: an empty tree for
a declared subsystem and an unsupported-language (`.py`) source each yield
`provenance_not_established` (never pass) — integration-gate *"fail closed …"*.

## C.5 — Stub-registry work-file context (two tiers)

`mock2-stub-registry.test.js`:
- *"unrelated cycle receives the concise global list only"* — a cycle touching
  `billing` gets the one-line global list of open simulations, no full records.
- *"a cycle touching the affected subsystem receives the full registry record"* —
  a cycle touching `people` additionally gets the full record (file, function,
  reason, approval ref, remediation). Wired into both runners via
  `stubContextForCycle` injected as a work-file turn (`runner.js`).

## C.6 — Invalidation / supersession

`mock2-verification.test.js` + enforcement suite: changing a verified manifest
entry's endpoint changes `manifestEntryHash`, so `supersessionNeeded` returns
`{needed:true, reason:/manifest/}`; expiry and operator-requested reverification
also trigger it. The route/state layer opens a **new** verification row with
`supersedes_id` and stamps `superseded_at` on the prior row — history is never
mutated or rehashed (append-only, `integration-state.recordVerification`).

## Completion matrix

| Requirement | Failing test before | Implementation files | Passing test after | Evidence location |
|---|---|---|---|---|
| B.1 constitution clause (no silent simulation) | enforcement of the clause had no test; §7a/§7b derived behavior | `framework-seed/constitution.md` §7a/§7b | integration-gate + enforcement suites (the clause's teeth) | PROOF C.1–C.4 |
| B.2 versioned integration manifest | `mock2-integration-gate` *manifest* tests (module absent) | `integration-logic.js`, `schemas/integration-manifest.schema.json`, `template.js` seed | `mock2-integration-gate.test.js` (2 manifest tests) | §"manifest" tests |
| B.3 finish-time screening (tiers, spans, negation) | `mock2-screening` (module absent) | `screening-logic.js`, `schemas/deviation-candidate.schema.json` | `mock2-screening.test.js` (8) | C.1(b) |
| B.4 integration gate (dataflow/execution/provenance/honest-failure/fixture-isolation/discovery, fail-closed) | `mock2-integration-gate` (module absent) | `integration-logic.js`, `integration-enforcement.js`, `schemas/integration-gate-result.schema.json` | `mock2-integration-gate.test.js` (19), `mock2-integration-enforcement.test.js` (15) | C.1, C.3, C.4 |
| B.5 pending-operator-verification lifecycle + evidence + supersession | `mock2-verification` (module absent) | `verification-logic.js`, `integration-state.js`, migration 520, `runner.js`/`runner-sdk.js`, `routes.js`, `schemas/operator-verification.schema.json` | `mock2-verification.test.js` (10), enforcement suite | C.2, C.6 |
| B.6 stub registry + severity + context | `mock2-stub-registry` (module absent) | `stub-logic.js`, `integration-state.js`, `template.js` seed, `runner.js`, `schemas/stub-registry.schema.json` | `mock2-stub-registry.test.js` (8) | C.5 |
| B.7 egress completeness | `mock2-egress-check` (module absent) | `egress-check-logic.js`, `integration-enforcement.js`, `runner.js` | `mock2-egress-check.test.js` (8) | §"egress" tests |
| Migration scanning + analysis-incomplete | `mock2-migration-scan` (module absent) | `migration-scan-logic.js`, `migration-scan.js`, `runner.js` | `mock2-migration-scan.test.js` (5) | MIGRATION.md |
| Severity taxonomy | — | `stub-logic.js` `STUB_SEVERITIES` | `mock2-stub-registry.test.js` | C.5 |

## Exit-code / status semantics (documented, non-colliding)

`verification-logic.OUTCOME_CODES` — stable structured codes that do not collide
with existing harness conventions (existing `mock2_cycles.status` values have no
numeric codes): `succeeded = 0`, `pending-operator-verification = 70`,
`blocked-deviation = 71`, `gate-rejected = 72`, `migration-analysis-incomplete =
73`. **Deploy-while-pending counts as healthy** (`deployPendingIsHealthy() =
true`) — the operator needs the running app to verify — but the pending state is
retained visibly in the `GET /projects/:id/integration-status` endpoint and is
never reported as generally available.
