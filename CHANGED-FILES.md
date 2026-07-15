# Changed files — harness integration-truthfulness review

Branch: `claude/harness-integration-truthfulness` (from `claude/design-template-import-cxpcga`
@ `b508495`; default branch is `main`). Working tree entered clean; no unrelated
changes were reset, stashed, or overwritten. Nothing was committed or pushed
(per the operational boundaries — commit/push only when explicitly asked).

## Deliverable docs (repo root)

| File | Reason |
|---|---|
| `AUDIT.md` | Part A read-only audit with file:line references (written before any source change) |
| `PROOF.md` | Part C red→green evidence, gate output, completion matrix, exit-code semantics |
| `MIGRATION.md` | Behavior of existing / already-stubbed / unscannable projects on their next cycle |
| `CHANGED-FILES.md` | This list |

## New pure decision layers (native-free, unit-tested)

| File | Reason |
|---|---|
| `admin/backend/src/mock2/integration-logic.js` | B.2 manifest parse/validate/hash + B.4 fail-closed integration analyzer (dataflow/execution/provenance/honest-failure/fixture-isolation/undeclared-discovery), capability-based, documents its limits |
| `admin/backend/src/mock2/screening-logic.js` | B.3 tiered finish-payload disclosure screening (high/ambiguous/negated), token-boundary aware |
| `admin/backend/src/mock2/stub-logic.js` | B.6 stub-registry severity semantics + two-tier work-file context + Run-stage exposure |
| `admin/backend/src/mock2/verification-logic.js` | B.5 pending-operator-verification outcomes, checklist derivation, confirmation validation, transitions, supersession, exit codes |
| `admin/backend/src/mock2/egress-check-logic.js` | B.7 dialed-host discovery + private/public/local classification + completeness check |
| `admin/backend/src/mock2/migration-scan-logic.js` | Migration findings from analysis, analysis-incomplete, touched/reconciliation escalation |

## New orchestration / state glue (native halves)

| File | Reason |
|---|---|
| `admin/backend/src/mock2/integration-enforcement.js` | Composite finish-time decision (gate + egress + screening → block / pending / succeeded); container source-snapshot reader |
| `admin/backend/src/mock2/integration-state.js` | mock2.db writes: gate result on cycle, append-only hash-linked findings + verification evidence; stub-registry parse |
| `admin/backend/src/mock2/migration-scan.js` | First-cycle legacy scan (idempotent) + blocking-legacy-findings lookup |

## New machine-readable schemas (versioned)

| File | Reason |
|---|---|
| `admin/backend/src/mock2/schemas/integration-manifest.schema.json` | B.2 manifest entry shape |
| `admin/backend/src/mock2/schemas/stub-registry.schema.json` | B.6 stub entry + severity effects |
| `admin/backend/src/mock2/schemas/deviation-candidate.schema.json` | B.3 screening candidate |
| `admin/backend/src/mock2/schemas/integration-gate-result.schema.json` | Composite gate result stamped on the cycle |
| `admin/backend/src/mock2/schemas/operator-verification.schema.json` | B.5 append-only verification evidence |
| `admin/backend/src/mock2/schemas/migration-finding.schema.json` | Integration/migration finding row |

## New tests + fixtures

| File | Reason |
|---|---|
| `admin/backend/src/__tests__/fixtures/integration-fixtures.js` | ADP2 recreation (renamed), 7 evasion fixtures, 3 clean controls, honest impl, manifests |
| `admin/backend/src/__tests__/mock2-integration-gate.test.js` | 19 tests — B.4 analyzer, evasions, clean controls, fail-closed, generality |
| `admin/backend/src/__tests__/mock2-screening.test.js` | 8 tests — B.3 tiers, spans, negation, token boundaries |
| `admin/backend/src/__tests__/mock2-integration-enforcement.test.js` | 15 tests — composite decision, C.1–C.6 end-to-end |
| `admin/backend/src/__tests__/mock2-verification.test.js` | 10 tests — B.5 outcomes, checklist, confirmation, transitions, supersession |
| `admin/backend/src/__tests__/mock2-stub-registry.test.js` | 8 tests — B.6 severity + context tiers + exposure |
| `admin/backend/src/__tests__/mock2-egress-check.test.js` | 8 tests — B.7 discovery, classification, completeness |
| `admin/backend/src/__tests__/mock2-migration-scan.test.js` | 5 tests — legacy findings, analysis-incomplete, escalation, bootstrap |

## Modified harness files

| File | Reason |
|---|---|
| `admin/backend/src/mock2/migrations.js` | Migration 520: `verification_state` + `integration_gate_json` columns, `mock2_integration_verifications` + `mock2_integration_findings` tables (additive, nullable, reversible) |
| `admin/backend/src/mock2/cycles.js` | Allow writing the two new cycle columns |
| `admin/backend/src/mock2/runner.js` | Wire the integration gate + screening + legacy-blocking into the finish path (blocks or routes to pending-operator-verification); inject stub-registry context into every cycle's work-file; first-cycle migration scan |
| `admin/backend/src/mock2/runner-sdk.js` | Same enforcement on the flag-gated SDK runner (parity — not a bypass) |
| `admin/backend/src/mock2/routes.js` | `GET /projects/:id/integration-status`; `POST /projects/:id/cycles/:cycleId/verify` (operator confirm / admin waive, observed-result required, advances pending→succeeded) |
| `admin/backend/src/mock2/framework-seed/constitution.md` | §7a "No silent simulation" + §7b "Integration gate & observable provenance" (B.1) |
| `admin/backend/src/mock2/template.js` | Seed `state/integrations.json` + `state/stub-registry.json` into new projects (paths exist, hash-chained) |
| `admin/frontend/src/lib/api.js` | `mock2GetIntegrationStatus` + `mock2VerifyIntegrationItem` API client methods |

## Not modified (by constraint)

- **ADP2 application code** — untouched; the harness is the deliverable (the app is
  rebuilt through the corrected harness afterward).
- **Existing gate scripts** (`framework-seed/gates.json`) — not weakened or
  special-cased; the integration gate is an orchestrator-side pass at finish,
  additive to the battery.
