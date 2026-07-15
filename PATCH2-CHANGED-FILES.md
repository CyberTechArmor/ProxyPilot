# Changed files — pending-operator-verification first-class outcome patch (PATCH2)

Branch `claude/harness-integration-truthfulness` (based on `7f832a2`, the latest
commit of that branch — not main). Working tree entered clean; no unrelated
changes reset/stashed. Not pushed (per the task; a stop hook requesting a push is
overridden — commit to the working branch only).

## New — tests, docs, schemas

| File | Reason |
|---|---|
| `admin/backend/src/__tests__/mock2-pending-outcome.test.js` | Part A behavioral RED (no returnable pending; cycle-scoped checks) → GREEN; C.1–C.4 (returnable outcome, capability-scoped status, independent verify, stub-can't-reach-pending) |
| `PATCH2-AUDIT.md` | Part A findings with file/line refs + the captured mis-routing reproduction |
| `PATCH2-PROOF.md` | Part C demonstrations, before/after output, completion matrix, exit codes |
| `PATCH2-CHANGED-FILES.md` | This list |
| `admin/backend/src/mock2/schemas/capability-live-check.schema.json` | B.2 capability-scoped live-check status record |
| `admin/backend/src/mock2/schemas/build-outcome.schema.json` | B.1 enumerated build outcomes + builder terminal moves (pending is first-class) |

## Modified — implementation

| File | Reason |
|---|---|
| `admin/backend/src/mock2/runner-logic.js` | B.1: add the `pending_verification` builder tool; classifyTurn recognizes it as a distinct calm conclusion (halt still precedes); halt/finish descriptions cross-reference it |
| `admin/backend/src/mock2/runner.js` | B.1: finish + pending_verification share the terminal validation flow (termName/termId so tool_results match); calm pending routing with NO admin-attention flag. B.2: inject ambient outstanding-capability-check context (not a blocker) into the cycle |
| `admin/backend/src/mock2/verification-logic.js` | B.2: `capabilityCheckStatus` — project-wide, confirmation-netted outstanding/verified split + `production_ready` (supersession-aware) |
| `admin/backend/src/mock2/integration-state.js` | B.2: `projectChecklistItems` — gather live-check items across the project's cycles (capability-scoped, deduped) |
| `admin/backend/src/mock2/routes.js` | B.2: `GET /integration-status` gains capability-scoped `production_ready` + outstanding/verified; new `POST /projects/:id/capability-checks/verify` (confirm/waive a capability's check independently of any build cycle, advancing any fully-verified pending cycle) |
| `admin/backend/src/mock2/framework-seed/constitution.md` | B.1/B.3: pending-operator-verification is a calm completion (not a blocker), capability-scoped and independently verifiable; credential injection is a deliberate admin action via `request_authorization`, never a default completion option |

## Not modified (by constraint)

- **The gate's detection / fail-closed behavior** — unchanged; this patch routes a
  legitimate green outcome, it does not relax what counts as green. The 7 evasion
  fixtures + 3 clean controls retain their results, and a stub still cannot reach
  `pending-operator-verification`.
- **Historical records** — no schema migration was needed (capability status is
  DERIVED from existing state: manifest checklist items in the cycle gate JSON +
  the append-only `mock2_integration_verifications` confirmations). New records
  stay append-only and hash-linked, consistent with existing conventions.
