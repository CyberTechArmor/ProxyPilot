# Changed files — blocked-deviation resolution deadlock patch

Branch `claude/harness-integration-truthfulness` (based on `0948d04`, the
integration-truthfulness commit, per the task — not main). Working tree entered
clean; no unrelated changes reset/stashed. Not pushed (per the task; the stop hook
that requests a push is overridden — commit to the working branch only).

## New — pure decision layer + tests + docs + schemas

| File | Reason |
|---|---|
| `admin/backend/src/mock2/resolution-logic.js` | B.1/B.2/B.4 core: finding→class map, class-matched resolution options, the B.1 invariant, waiver eligibility, loop-breaker signature/verdict/summary |
| `admin/backend/src/__tests__/mock2-resolution-deadlock.test.js` | Part A behavioral RED (loop + waiver gap) → GREEN after patch; C.1 backfill-progresses + C.4 loop-breaker replays |
| `admin/backend/src/__tests__/mock2-resolution.test.js` | classification, B.1 invariant (red→green), class-matched options, waiver eligibility, loop breaker |
| `PATCH-AUDIT.md` | Part A findings with file/line refs + the captured loop reproduction |
| `PATCH-PROOF.md` | Part C demonstrations, before/after gate output, completion matrix, exit codes |
| `PATCH-CHANGED-FILES.md` | This list |
| `admin/backend/src/mock2/schemas/manifest-backfill-resolution.schema.json` | B.1 manifest-backfill resolution record schema |
| `admin/backend/src/mock2/schemas/analysis-limitation-waiver.schema.json` | B.2 analysis-limitation waiver record schema |
| `admin/backend/src/mock2/schemas/blocked-deviation-resolution.schema.json` | The blockingSummary payload incl. `resolution-ineffective` state |

## Modified — wiring

| File | Reason |
|---|---|
| `admin/backend/src/mock2/integration-enforcement.js` | `blockingSummary` now returns class-matched options + loop-breaker state; `evaluateIntegrationTruthfulness` gains `fixtureToolingPresent` (emits `fixture_tooling_missing`) + persists `finding_signature`; adds `backfillManifestEntryInContainer` |
| `admin/backend/src/mock2/integration-logic.js` | `validateManifestEntry` + `appendManifestEntry` (B.1 backfill primitives) |
| `admin/backend/src/mock2/integration-state.js` | `recordIntegrationResolution` / `listIntegrationResolutions` / `listProvenanceWaivers` (append-only, hash-linked, migration 522); `priorBlockedSignatures` for the loop breaker |
| `admin/backend/src/mock2/verification-logic.js` | `resolution-ineffective` outcome + code 74; blocked-deviation transitions (`provenance_waived`→pending, `manifest_backfilled`→building, `loop_breaker_tripped`→resolution-ineffective); waiver-eligibility invariant |
| `admin/backend/src/mock2/migrations.js` | Migration 522: `mock2_integration_resolutions` (append-only, hash-linked backfill + waiver records) |
| `admin/backend/src/mock2/routes.js` | Routes: `GET …/cycles/:id/resolutions` (class-matched options), `POST …/backfill-manifest` (B.1), `POST …/waive-provenance` (B.2, admin, refused for fabricated) |
| `admin/backend/src/mock2/runner.js` | Finish path: pass `fixtureToolingPresent`; thread `priorBlockedSignatures` into `blockingSummary`; halt with `resolution_ineffective` when the loop breaker fires; export `writeFileInContainer` |
| `admin/backend/src/mock2/scaffold.js` | B.3: ship `tests/contract/fixture-server.ts` (real local TLS fixture server) + a worked contract test; export `CONTRACT_FIXTURE_PATH_RE` |
| `admin/backend/src/mock2/framework-seed/constitution.md` | B.3 stage guidance: the honest path (real transport + contract fixtures + pending-operator-verification); stubbing is never a fallback; every finding class has a resolving option |
| `admin/backend/src/__tests__/mock2-verification.test.js` | Extended for `resolution-ineffective` + the new blocked-deviation transitions |
| `admin/frontend/src/lib/api.js` | Client methods: `mock2GetCycleResolutions`, `mock2BackfillManifest`, `mock2WaiveProvenance` |

## Not modified (by constraint)

- **The gate's detection / fail-closed behavior** — unchanged; the waiver is a
  recorded human decision with a live-verification backstop, gated to
  `provenance-not-established` only, never an analyzer bypass. The 7 evasion
  fixtures + 3 clean controls retain their results.
- **Historical records** — migration 522 is additive; all new records are
  append-only and content-hashed, consistent with `0948d04` conventions.
