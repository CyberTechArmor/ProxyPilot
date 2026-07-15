# PATCH2-PROOF.md — a healthy completion no longer masquerades as a blocker

Part C evidence. Every change was written RED against the current harness
(behavioral reds — assertion failures, not missing-module errors) and driven to
GREEN. The proof rests on new tests over the terminal-move classifier and the
capability-scoped verification status, not on the harness's own gates.

## How to run

```
cd admin/backend
node --test src/__tests__/mock2-pending-outcome.test.js \
             src/__tests__/mock2-verification.test.js \
             src/__tests__/mock2-integration-gate.test.js \
             src/__tests__/mock2-integration-enforcement.test.js \
             src/__tests__/mock2-resolution-deadlock.test.js
```

Per-suite (exit 0 each):

```
mock2-pending-outcome          → exit 0 | # tests  9 # pass  9 # fail 0
mock2-verification             → exit 0 | # tests 15 # pass 15 # fail 0
mock2-integration-gate         → exit 0 | # tests 19 # pass 19 # fail 0   (7 evasions + 3 clean controls unchanged)
mock2-integration-enforcement  → exit 0 | # tests 15 # pass 15 # fail 0
mock2-resolution-deadlock      → exit 0 | # tests  5 # pass  5 # fail 0   (PATCH1 unchanged)
```

Full backend suite (`npm test`): **653 pass, 4 fail, 5 skipped** — the 4 failures
are the pre-existing `better-sqlite3` failures documented in `CLAUDE.md`
(`cves`, `incus`, `vpn-mtu`, `webauthn`), unrelated to this patch. (Baseline before
PATCH2 was 644 pass; PATCH2 adds 9 passing tests.)

### The RED that started it (Part A)

Before the patch, `mock2-pending-outcome.test.js` ran RED behaviorally:

```
not ok 1 - A.1: the builder has no tool to return pending-operator-verification
not ok 2 - A.1: classifyTurn does not recognize a pending-verification conclusion
not ok 3 - A.2: a cycle that does not touch the capability drops its live checks entirely
# tests 3 · pass 0 · fail 3
```

All three are GREEN after the patch, plus six new C-tests.

## C.1 — pending-operator-verification is a returnable, calm conclusion

Actual output (live modules), before and after:

```
=== the builder's terminal moves ===
tools: finish, pending_verification, halt, request_authorization    ← pending_verification is now first-class

=== classifyTurn on a pending_verification conclusion ===
pendingVerification: true | done(succeeded): false | halted(blocked): false
```

The builder can now conclude directly with `pending_verification` — distinct from
`finish` (→ succeeded) and `halt` (→ blocked). The runner routes it through the
SAME validation flow as finish (acceptance, gate battery, integration gate), then
lands the cycle in pending-operator-verification with a **calm** job message —
*"Built and verified in-fence — N live checks remain before production sign-off"* —
and, critically, raises **no admin-attention `flag`** (the prior code did:
`runner.js` old `safeRaise({ kind: 'flag', … })`), so it no longer shows as
"Blocked / needs attention" with the `!` overlay. `halt` still takes precedence
when a turn pairs both, so a genuinely blocked build is never mislabeled pending.

Tests: `mock2-pending-outcome.test.js` → *"pending_verification is a first-class
terminal move…"*, *"halt still takes precedence over pending"*.

## C.2 — an unrelated cycle is not dragged into the verification

Before: `deriveVerificationChecklist({ manifest, subsystems: ['auth'] })` → `[]` —
the directory capability's live checks vanished from a cycle that didn't touch it,
so the pending decision could only survive as a blocker that then re-surfaced on
unrelated cycles.

After: live checks are **capability-scoped** (`verification-logic.capabilityCheckStatus`,
fed by `integration-state.projectChecklistItems`), project-wide and independent of
the current cycle:

```
=== capability-scoped status (project-wide, not cycle) ===
outstanding: 2 | production_ready: false
```

A cycle that does not touch those capabilities finishes normally; the outstanding
ADP/LDAPS checks are injected only as **ambient** context (`runner.js`
`capability_status` event: *"NOT your job this cycle, NOT a blocker; do not
re-declare or re-flag them"*) and surfaced on the Run-stage status endpoint
(`GET /projects/:id/integration-status` → `production_ready`, `outstanding_checks`,
`verified_checks`). The bootstrap-user change is never pulled into ADP/LDAPS
verification.

Tests: `mock2-pending-outcome.test.js` A.2 (documents cycle-scoping) + *"capability
checks are project-wide and persist regardless of the current cycle"*.

## C.3 — a capability's live check confirmed independently → verified → production-ready

```
after both confirmed → production_ready: true | outstanding: 0
```

`POST /projects/:id/capability-checks/verify` confirms/waives an outstanding
capability check **without a pending build cycle** (verification is a property of
the capability's lifecycle), records the hash-linked append-only evidence
(`recordVerification`), advances any pending cycle whose whole checklist is now
satisfied to `succeeded`, and flips `production_ready` once nothing is outstanding.
A manifest-hash change re-opens a previously-confirmed check (supersession —
`stale_verification: true`).

Tests: `mock2-pending-outcome.test.js` → *"confirming a capability check
independently moves it to verified; app becomes production-ready when none
remain"*, *"a manifest-hash change re-opens a previously-confirmed capability
check"*.

## C.4 — regression + the stub-can't-reach-pending invariant

- **Clean controls / evasions:** the 7 evasion fixtures + 3 clean controls from
  `PROOF.md` retain their exact results — `mock2-integration-gate.test.js` (19) and
  `mock2-integration-enforcement.test.js` (15) are unchanged and green. Detection
  and fail-closed behavior are untouched; this patch only routes a legitimate
  green outcome.
- **Invariant:** `pending-operator-verification` remains unreachable from a
  stub/fabricated path. The runner runs the integration gate on the
  `pending_verification` path exactly as on `finish`, and the blocking check
  (`if (integrationDecision.blocking) { haltCycle(...) return }`) precedes the
  pending routing — so a fabricated capability halts as `blocked-deviation` and
  never reaches pending. `verificationTransition({event:'gates_green_with_integrations',
  integrationGateVerdict:'fail'})` is refused. Test: *"pending is refused when the
  integration gate is red"*.

## Completion matrix

| Requirement | Failing test before | Implementation files | Passing test after | Evidence location |
|---|---|---|---|---|
| B.1 pending as a returnable outcome | `mock2-pending-outcome` A.1 (no tool / classifyTurn unaware) — behavioral red | `runner-logic.js` (pending_verification tool + classifyTurn), `runner.js` (shared terminal flow, calm routing, no flag), `constitution.md` (guidance), `build-outcome.schema.json` | A.1 GREEN + C.1 tests | C.1 |
| B.1 invariant (only from real code) | `mock2-verification` gate-red-refused | `verification-logic.js` (verificationTransition), `runner.js` (gate before pending) | C.4 test | C.4 |
| B.2 capability-scoped live checks | `mock2-pending-outcome` A.2 (cycle-scoped drop) — behavioral red | `verification-logic.js` (capabilityCheckStatus), `integration-state.js` (projectChecklistItems), `routes.js` (status + independent verify route), `runner.js` (ambient context), `capability-live-check.schema.json` | A.2 GREEN + C.2/C.3 tests | C.2, C.3 |
| B.2 independent confirm/waive | (route gated behind a pending cycle) | `routes.js` `POST …/capability-checks/verify` | C.3 test + route | C.3 |
| B.3 credential injection not a default option | (audit: builder stuffed it into halt options) | `runner-logic.js` (pending_verification tool forbids it), `constitution.md` (deliberate admin action via request_authorization) | pending flow offers no credential option | C.1 |

## Exit-code / status semantics

`pending-operator-verification` keeps its stable code **70** (deploy-pending is
healthy). The new app-level `production_ready` flag (capability-scoped) is exposed
on `GET /projects/:id/integration-status` and is true only when no capability has
an outstanding live check — orthogonal to the per-cycle outcome. No codes changed
or collided.
