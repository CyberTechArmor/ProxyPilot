# PATCH2-AUDIT.md — a healthy completion masquerading as a blocker

Part A of PATCH2. Observed live on ADP3: an operator asked for a small feature
(first-user-becomes-superadmin bootstrap). It built cleanly — all seven gates
green, integration deliverables present, contract tests passing. The designed
end state is `pending-operator-verification` (two live checks — ADP Test
Connection and LDAPS bind — cannot run inside the sealed fence). But the harness
gave the builder no way to *return* that outcome, so it raised a
`blocked-deviation` and stuffed the pending decision into the blocker's options.
This audit reproduces the mis-routing and locates it with file:line refs into the
harness at `7f832a2`.

## The mis-routing, reproduced (behavioral RED)

`src/__tests__/mock2-pending-outcome.test.js` runs against the current modules
(assertion failures, not missing-module errors):

```
node --test src/__tests__/mock2-pending-outcome.test.js
not ok 1 - A.1: the builder has no tool to return pending-operator-verification
not ok 2 - A.1: classifyTurn does not recognize a pending-verification conclusion
not ok 3 - A.2: a cycle that does not touch the capability drops its live checks entirely
# tests 3 · pass 0 · fail 3
```

## Root cause 1 — `pending-operator-verification` is not a returnable outcome

The builder's terminal moves are enumerated in `RUNNER_TOOLS`
(`admin/backend/src/mock2/runner-logic.js`): `finish` (`runner-logic.js:82-110`)
records the cycle **succeeded** and deploys; `halt` (`runner-logic.js:111-156`)
records it **blocked** (needs attention). There is no third terminal move. The
classifier `classifyTurn` (`runner-logic.js:372-415`) recognizes only
`request_authorization`, `halt`, and `finish` — a `pending_verification` call is
an unknown tool, so it is not a conclusion at all.

`pending-operator-verification` *is* a reported outcome
(`verification-logic.js:16-24`, code 70 at `:27-33`) and a specified transition
(`verification-logic.js` `building → pending-operator-verification`), but it is
only reachable as a **side effect of `finish`**: the runner, AFTER the builder
calls finish and the integration gate passes, may re-route to pending
(`runner.js:907-908`, `pendingChecklist = integrationDecision?.checklist`). The
builder cannot *choose* it. Faced with "finish deploys as succeeded" and knowing
two live checks are unrun, the correct-reasoning builder avoided finish and used
the only honest stop it had — `halt` → `blocked-deviation` — then encoded the
pending decision as halt `options` (the "Recommended" option literally being
"record pending-operator-verification as the end state"). A calm, expected
completion is thus presented as **"Blocked — needs attention"** with an alarming
options list, including one that would inject production credentials into the
fence. There is no decision for the operator to make — the state machine already
knows the answer.

## Root cause 2 — pending checks are cycle-scoped, not capability-scoped

`deriveVerificationChecklist({ manifest, subsystems })`
(`verification-logic.js:62-83`) filters checklist items to the subsystems a cycle
touched (`:66` `if (subsystems && subsystems.length && !subsystems.includes(entry.subsystem)) continue`).
The runner passes the CURRENT cycle's touched subsystems, and stores the result
on the **cycle** (`runner.js:907-925`: `updateCycle(cycle.id, { verification_state: 'pending' })`,
checklist in the cycle's `integration_gate_json`). Consequences:

- A cycle that does NOT touch the capability drops its checks entirely
  (reproduced in A.2: `deriveVerificationChecklist({ manifest, subsystems: ['auth'] })`
  → `[]` for a `directory` capability). So the bootstrap cycle's `finish` would
  route to **succeeded**, silently skipping the still-unverified ADP/LDAPS live
  checks — which is exactly why the builder refused to finish.
- Conversely, the pending decision, having been stuffed into a blocker, re-surfaces
  as a fresh `blocked-deviation` on later cycles that have nothing to do with those
  integrations — the operator's bootstrap change gets dragged into ADP/LDAPS
  verification it never touched.
- The verify route is gated behind a pending **cycle**
  (`routes.js:2537`: `if (cycle.verification_state !== 'pending') return 409`), so
  an operator cannot run/confirm a capability's live checks independently of a
  build cycle. Verification is not a property of the capability's lifecycle.

`deriveVerificationChecklist` also has no notion of confirmation state (it takes
no `activeVerifications`), so it cannot express "this capability's live check is
already confirmed" — there is no confirmation-netted, project-wide capability
status anywhere (A.2 asserts `verification-logic.capabilityCheckStatus` must exist).

## Where the relevant code lives (summary)

| Concern | Location |
|---|---|
| Finish outcomes enumerated | `verification-logic.js:16-33` (REPORTED_OUTCOMES / OUTCOME_CODES) |
| Builder's terminal moves | `runner-logic.js:82-156` (finish, halt), `:372-415` (classifyTurn) |
| Pending reachable only via finish side-effect | `runner.js:907-925` |
| Checklist is cycle-scoped | `verification-logic.js:62-83` (subsystems filter, no confirmations) |
| Verify gated behind a pending cycle | `routes.js:2537` |

## Findings → patch mapping

| Root cause | Fix |
|---|---|
| No returnable pending outcome (RC1) | B.1 `pending_verification` builder tool + classifyTurn + a direct runner terminal branch (calm completion, not a blocker); invariant: only when the integration gate passed for real code |
| Checks are cycle-scoped and cycle-stored (RC2) | B.2 capability-scoped `capabilityCheckStatus` (manifest ∖ active confirmations), ambient status, independent confirm/waive, touch→reverify, app production-ready = no outstanding |
| Credential injection offered as a routine option (RC1) | B.3 keep it out of the default completion options; explicit admin-gated path with confirmation + audit |
