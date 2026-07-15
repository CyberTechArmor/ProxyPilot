# Finish-gate, loop termination, and credential-gated integrations

How a build reaches an honest terminal state in every case — including the two
that used to dead-end: the code-less follow-up cycle, and the integration whose
live verification needs credentials the build fence does not have.

## The verified empty-diff rule (finish gate)

Reproduce-first (constitution §12) demands a red→green regression test inside
any bug-fix cycle. That rule exists to stop "the code looks correct" from
passing as a fix — but it used to apply even when the cycle changed **nothing**,
which made a correct, complete, green, code-less cycle unfinishable: there was
no defect to reproduce, and fabricating a red test would itself require a
product change (breaking the empty diff and the detector-evasion rule).

Now, at finish time the orchestrator reads the cycle's diff itself (`git` in
the container — never a model claim) and splits it into product code vs
`state/` bookkeeping (`acceptance-logic.codeChangedFiles`):

- **Code slice empty** → reproduce-first does not apply. The spec's own kind
  (usually `chore`) stands — the eager instruction-based bugfix classification
  does not coerce it — and the cycle finishes. The acceptance record stamps
  `code_diff_empty: true`, `no_op: true`, and
  `reproduce_first: "not_required_empty_diff"`, so the record never implies a
  red test that wasn't observed.
- **Code slice non-empty** → the strict rule is unchanged: a bug-fix without an
  observed red test gate is rejected with actionable feedback.
- **Diff unverified** (the orchestrator could not read it) → strict rule. The
  relaxation only ever rides the orchestrator's own verification (§12).

A no-op success also skips the redeploy (nothing changed; the existing deploy
keeps serving) and reports "Nothing left to do — the work is already complete
and verified."

## Waivers are enforced, never narrated

An operator resume may carry `waivers: ["reproduce_first"]` (admin-only,
`POST /cycles/:id/retry`). The waiver is:

- applied at the **real enforcement layer** (`acceptanceVerdict`) of the
  resumed cycle — the finish gate itself honors it;
- stamped into the acceptance record (`reproduce_first: "waived_by_operator"`);
- named in the resume-guidance turn as *in effect*, so the model is never told
  a waiver exists that the gate will not honor (§12: a narrated-but-ineffective
  waiver is a falsified precondition).

The empty-diff rule above is structural, so the common case needs no waiver at
all.

## Loop termination ("no work remaining")

Every completed cycle whose verified code diff was empty is stamped `no_op`.
At cycle start (`startCycle`, both runners' shared path), the orchestrator
counts the **trailing run of completed no-op cycles for the same instruction**
(`cycle-logic.consecutiveNoopCycles`). At `NOOP_CYCLE_LIMIT` (2), starting
another cycle for that instruction is refused with a calm terminal message —
"No work remaining… the work is already done and verified" — and a review flag
is raised. No refused-cycle row is inserted (a refusal must not mint another
no-op). A different instruction resets the count; resumes of blocked work are
unaffected (a blocked cycle is not a no-op).

Component adoption stays idempotent (`materialize_component` keeps existing
files and reports them `kept`), and an idempotent re-adoption now resolves
cleanly through the empty-diff rule instead of halting.

## Credential-gated integrations: the lifecycle

```
declared ──► fixture-verified (in-fence) ──► pending-operator-verification
                                                   │                │
                                             "it works"        "it failed"
                                                   │                │
                                                verified      bug-fix cycle
                                                              (red→green vs
                                                               the fixture)
```

- **Declared** — every external capability has an entry in
  `state/integrations.json` (id, subsystem, actions, `destination.source/key`,
  transport, provenance, `live_verification.required`, egress classification).
- **Fixture-verified** — the gate verifies everything checkable without
  secrets: real transport code on a reachable path (no canned success, no
  presence-only checks, no error→success conversion), the contract test against
  the in-fence fixture server (`tests/contract/fixture-server.ts` — a real
  local TLS socket, test-only injection), config **schema** presence (keys,
  not values), and egress declaration.
- **Pending-operator-verification** — a first-class, calm completion (the
  `pending_verification` tool, or auto-routed from `finish`): the app deploys,
  the cycle records the outstanding live checks, and **nothing blocks**. Each
  checklist item now carries the full operator hand-off: `required_config`
  (which env var / connection string to supply), `how_to_verify`, and how to
  report. The checklist is netted against active confirmations (by manifest
  hash), so an already-verified capability never re-pends on later cycles; a
  manifest change reopens it.
- **Verified** — the operator confirms with an *observed result* (never a bare
  checkbox) via the Build panel or
  `POST /projects/:id/capability-checks/verify`; when every item clears, the
  pending cycle advances to `succeeded`.
- **Failed** — the operator reports what they observed via the Build panel or
  `POST /projects/:id/capability-checks/report-failure`. The failure is
  recorded append-only, affected pending cycles move to
  `verification_state: "failed"`, and a **real bug-fix build** opens through
  the normal audit pipeline carrying the observation — which now legitimately
  has a defect to reproduce (red→green against the fixture). This closes the
  loop through a human instead of an impossible in-build live test.

What stays forbidden: a **simulated/stubbed-and-hidden** integration (canned
success, fabricated rows, fixture reachable through production config) still
blocks — pending-operator-verification is only reachable for real, declared
transport code, and the gate never accepts (or demands) a fabricated live test.

## Malformed manifest self-healing

A `state/integrations.json` that doesn't parse used to be a dead-end block.
`POST /projects/:id/integrations/repair-manifest` now archives the broken text
to `state/integrations.invalid.json` (nothing is silently lost), salvages every
entry that still validates individually, writes a valid
`{schema_version, entries[]}` scaffold, commits it, and resumes a blocked
cycle so the gate re-reads the declared capabilities. An *absent* manifest was
already tolerated (it reads as empty).
