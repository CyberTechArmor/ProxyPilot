# Next section prompt: A5, the first supervised execution loop

Do not execute merely by reading this file. A5 is eligible only when
`fractionate-agents-a4-evidence.md` has a dated section recording A4 as
ACCEPTED against the A4 criteria, with its open items named. If it does not,
stop and name the open A4 gate.

## Start from

- Read in this order:
  1. `fractionate-agents-a4-reference.md` (revisions, components, interfaces,
     commands, rollback, rules);
  2. the A4 acceptance section of the evidence;
  3. the A3 reference;
  4. `CLAUDE.md`, `docs/core/security-host-boundary.md`;
  5. the A5 row of `fractionate-agents-a1-a8.md`.
- Older prompts are background. Later dated evidence wins.

## Goal

On the proof VM, through the installed A3 supervisor and A4 broker, prove one
bounded, supervised run of the synthetic workflow:

> land → open sign-in → submit the bound credential → read the session →
> read the files → sign out → stop with a verified receipt

A run follows these rules:
- It is started explicitly by an authorized person.
- It pins the approved guide version, profile, site, binding and spending
  revisions.
- It proceeds action by action, with durable progress and results.
- It stops safely on every refusal.

## Preserve

- The designated branch; never rewrite pushed history. Open, merge or deploy
  nothing unless the user asks.
- Activation stays off for everyone except the proof harness, and for one
  operator-authorized project and profile.
- `pp-nodus`, `nodus.fractionate.ai`, `--upgrade-incus`, Incus archives and
  managed-LXC refusals: untouchable.
- Migrations 1100–1110 are immutable. New migrations take the next free
  numbers.
- The A3/A4 boundaries do not widen:
  - supervisor and broker sockets, methods and the peer rule;
  - the fence, unit properties and limits;
  - the proxy policy;
  - the broker's value path.
- Disposable fixtures only. The operator enters every secret in the dashboard.

## Scope

1. **Coordinator.**
   - A backend-side coordinator with durable run state. It prepares a run
     (`createOperationalWorkerStore.prepare` with the binding), reserves the
     attempt, and launches through `createWorkerLauncher` with the real
     supervisor client.
   - The backend container gets the **backend** supervisor socket only, never
     the operator or broker socket. The mount is a reviewed change with its own
     proof.
2. **Loop.**
   - A fixed action plan for the synthetic workflow. Each step runs
     `authorizeAction` (durable reservation), then the supervisor action, then
     records the untrusted result.
   - No model chooses actions in this section unless the user asks. A model, if
     added, gets only typed action names and redacted page claims, never
     `binding_id` values it did not receive from policy, and never a value.
3. **Approval checkpoints.**
   - A human approval before `submit_bound_fixture`. It is recorded as a
     durable approval row bound to the run, fence and binding revision.
   - Refuse on stale approval.
4. **Stop and recovery.**
   - Operator stop and takeover still work, and a stop never replays an
     uncertain action.
   - A backend restart fences the run and waits for a verified receipt.
5. **Budget.** Where the loop calls the model route, the broker's reservation
   and ledger apply. The loop never retries with a new call ID for an uncertain
   call.

## Out of scope

The A6 UI beyond one start and approve surface, A7, A8, and any F item.

## Proofs

- **Local:** the A3/A4 Python suites and the new A5 tests; the Operations and
  backend suites; the host-boundary inventory without suppression; the
  frontend build if the frontend is touched.
- **Target:**
  - the full A3 proof and the A4 proof pass again after any supervisor, runner
    or broker change;
  - one complete supervised run with its receipts and approval rows;
  - refusal cases: stale approval, rotated or revoked binding mid-run, budget
    exhausted, operator stop, and a backend restart mid-run;
  - the canary scan is 0 across all sinks, now including the backend
    coordinator's rows and logs.
- **CI:** Security CI on the exact head if a draft PR is authorized.

## Record and stop

- Write `fractionate-agents-a5-evidence.md` and an A5 reference. Update the
  plan's A5 row and `CLAUDE.md` if interfaces changed.
- Write the A6 prompt, gated on A5 acceptance.
- Stop for review.
