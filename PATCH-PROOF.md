# PATCH-PROOF.md — Part C: the deadlock is broken

Reproduce-first evidence for the blocked-deviation resolution patch. Every change
was written RED against the current harness (behavioral reds — no missing-module
errors) and driven to GREEN. The proof does not rest on the harness's own gates;
it rests on new tests over the resolution decision layer and the composite gate.

## How to run

```
cd admin/backend
node --test src/__tests__/mock2-resolution-deadlock.test.js \
             src/__tests__/mock2-resolution.test.js \
             src/__tests__/mock2-verification.test.js \
             src/__tests__/mock2-integration-gate.test.js \
             src/__tests__/mock2-integration-enforcement.test.js
```

Per-suite (exit 0 each):

```
mock2-resolution-deadlock      → exit 0 | # tests  5 # pass  5 # fail 0
mock2-resolution               → exit 0 | # tests 10 # pass 10 # fail 0
mock2-verification             → exit 0 | # tests 15 # pass 15 # fail 0
mock2-integration-gate         → exit 0 | # tests 19 # pass 19 # fail 0   (7 evasions + 3 clean controls unchanged)
mock2-integration-enforcement  → exit 0 | # tests 15 # pass 15 # fail 0
```

Full backend suite (`npm test`): **644 pass, 4 fail, 5 skipped** — the 4 failures
are the pre-existing `better-sqlite3` failures documented in `CLAUDE.md`
(`cves`, `incus`, `vpn-mtu`, `webauthn`), unrelated to this patch. (Baseline before
the patch was 619 pass; the patch adds 25 passing tests.)

### The RED that started it (Part A)

Before the patch, `mock2-resolution-deadlock.test.js` ran RED behaviorally:

```
ok 1  - A.1: ADP3 undeclared findings block, and the re-scan reproduces them identically (loop)
not ok 2 - A.1: a blocked undeclared capability must offer a manifest-backfill resolution
not ok 3 - A.2: unprovable-but-real code yields provenance_not_established with no clearing option
# tests 3 · pass 1 · fail 2
```

Test 1 passed because it *documents* the loop (re-scan → identical findings); tests
2 and 3 failed because no manifest-backfill option and no waiver existed. All three
are GREEN after the patch (plus two new tests C.1 and C.4 below).

## C.1 — ADP3 replay: undeclared now offers backfill, and applying it progresses

Actual gate output, before and after (from the live modules):

```
=== BEFORE (deadlock) ===
outcome: blocked-deviation | finding kinds: undeclared_integration,undeclared_integration
offered option ids: backfill_manifest          ← the missing option now exists

=== AFTER backfilling notify-webhook ===
outcome: blocked-deviation | finding kinds: undeclared_integration   ← the notify finding is GONE
notify undeclared cleared: true                ← one remains for `directory`; its own backfill clears it
```

Declaring `notify-webhook` in the manifest removes the `notify` `undeclared`
finding and changes the finding-set signature — the build **progresses to a
different state** (the declared capability is now checked for real provenance)
instead of re-producing the identical screen. Schema-valid entry creation is proven
by `appendManifestEntry` (validates, rejects duplicates, rejects malformed).

Tests: `mock2-resolution-deadlock.test.js` → *"a blocked undeclared capability must
offer a manifest-backfill resolution"*, *"backfilling a manifest entry clears the
undeclared finding — the build progresses instead of looping"*.

## C.2 — the waiver resolves unprovable-but-real; refused for fabricated

- **Resolves:** a `provenance_not_established` finding (real code the analyzer
  cannot prove — e.g. a polyglot service) offers `waive_provenance`; the
  transition routes `blocked-deviation → pending-operator-verification` (verified
  by `verificationTransition`), NEVER to `succeeded`. The route records a
  hash-linked `analysis_limitation_waiver` (`mock2_integration_resolutions`) with
  the inspected file/function, the analyzer's stated limitation, and the manifest
  hash (a change re-opens it).
- **Refused:** for a positively-fabricated finding (`fabricated_output`,
  `execution_without_transport`, `error_converted_to_success`,
  `fixture_reachable_in_production`) `waiverEligible` is false, the option is not
  offered, and `verificationTransition({event:'provenance_waived', waiverEligible:false})`
  is refused — those keep only implement-real / approve-simulation.

Tests: `mock2-resolution.test.js` → *"B.2 waiver is eligible ONLY for
provenance-not-established, refused for fabricated"*, *"a positively-fabricated
record does NOT offer the waiver"*; `mock2-verification.test.js` → *"a provenance
waiver routes blocked-deviation → pending-operator-verification (never succeeded)"*,
*"a waiver is REFUSED for a positively-fabricated finding"*.

## C.3 — the B.1 invariant, red→green for the invariant itself

`invariantHolds(FINDING_CLASSES)` is GREEN: every emittable finding class
(`undeclared, simulated, provenance-not-established, contract-missing,
fixture-tooling-missing, egress-missing, manifest-invalid`) has ≥1 resolving
option. Introducing a hypothetical class with no option makes it RED:

```
invariantHolds([...FINDING_CLASSES, 'a-brand-new-class-with-no-option']).ok === false
uncovered === ['a-brand-new-class-with-no-option']
```

A finding class with no resolving option is a harness defect that fails the suite.
Test: `mock2-resolution.test.js` → *"every finding class the gate can emit has a
resolving option"* + *"the invariant FAILS for a hypothetical class with no
resolving option"*.

## C.4 — the loop breaker fires on a contrived unresolvable blocker

```
=== loop breaker on 2nd identical block ===
state: resolution-ineffective | options now: record_resolution
```

First block → normal `blocked-deviation` with class-matched options
(`backfill_manifest`, …). A second consecutive block with the identical finding
signature → `resolution-ineffective`: the repeated options are suppressed (only the
`record_resolution` free-text/admin escape hatch remains), the full finding list is
surfaced inline (not a count), and a free-text or admin resolution is required. The
runner threads this via `priorBlockedSignatures(request_id)` and halts with
`halt_reason='resolution_ineffective'` (reported outcome `resolution-ineffective`,
code 74). Tests: `mock2-resolution.test.js` (loop-breaker unit tests) +
`mock2-resolution-deadlock.test.js` → *"an identical finding set on the 2nd
consecutive block is marked resolution-ineffective"*.

## C.5 — the waiver does not weaken detection (clean controls)

The 7 evasion fixtures and 3 clean controls from `PROOF.md` retain their exact
prior results — `mock2-integration-gate.test.js` (19) and
`mock2-integration-enforcement.test.js` (15) are unchanged and green. The waiver is
a recorded human decision routed to a live-verification backstop, gated to
`provenance-not-established` only; the analyzer's detection and fail-closed
behavior are untouched (the `evaluateIntegrationTruthfulness` default
`fixtureToolingPresent=true` keeps every existing fixture's verdict identical).

## Completion matrix

| Requirement | Failing test before | Implementation files | Passing test after | Evidence location |
|---|---|---|---|---|
| B.1 class-matched options + backfill for `undeclared` | `mock2-resolution-deadlock` A.1 "must offer a manifest-backfill resolution" (behavioral red) | `resolution-logic.js`, `integration-enforcement.js` (blockingSummary), `integration-logic.js` (appendManifestEntry/validateManifestEntry), route `POST …/backfill-manifest`, migration 522, `integration-state.js` | same test GREEN + `mock2-resolution.test.js` class-match tests | C.1, C.3 |
| B.1 invariant (every class has a resolving option) | new invariant test with an injected classless finding | `resolution-logic.js` (invariantHolds) | `mock2-resolution.test.js` invariant red→green | C.3 |
| B.2 analysis-limitation waiver | `mock2-resolution-deadlock` A.2 "no clearing option" (behavioral red) | `resolution-logic.js` (waiverEligible), `verification-logic.js` (provenance_waived), route `POST …/waive-provenance`, `integration-state.js` (recordIntegrationResolution), schema, migration 522 | A.2 GREEN + `mock2-verification.test.js` waiver transitions | C.2 |
| B.3 in-fence fixture tooling + `fixture-tooling-missing` | (audit: scaffold has no fixture server) | `scaffold.js` (contract-fixture server + example test + `CONTRACT_FIXTURE_PATH_RE`), `integration-enforcement.js` (fixture-tooling finding), `runner.js` (fixtureToolingPresent), `constitution.md` (honest-path guidance) | `mock2-resolution.test.js` classify `fixture_tooling_missing` + option coverage | C.5 (detection unweakened) |
| B.4 loop breaker → `resolution-ineffective` | new loop-breaker tests | `resolution-logic.js` (findingSetSignature/loopBreakerVerdict/resolutionIneffectiveSummary), `integration-enforcement.js`, `verification-logic.js` (outcome+transition), `runner.js` (priorBlockedSignatures), `integration-state.js` | `mock2-resolution.test.js` + `mock2-resolution-deadlock.test.js` C.4 | C.4 |

## Exit-code / status semantics

`resolution-ineffective` is added to `REPORTED_OUTCOMES` with stable code **74**
(`OUTCOME_CODES`), non-colliding with the existing 0/70/71/72/73. A manifest
backfill routes a cycle back to `building` (the gate re-runs); a provenance waiver
routes to `pending-operator-verification` (code 70, deploy-pending healthy), never
to `succeeded`.
