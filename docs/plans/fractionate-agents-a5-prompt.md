# Next section prompt: A5, the first supervised execution loop

Do not execute merely by reading this file. Check the gate first.

## Gate

1. **A4 must be ACCEPTED.** `fractionate-agents-a4-evidence.md` must have the
   dated acceptance section (2026-09-28, "fourth host run … acceptance") with
   its open items named. If it does not, stop and name the open A4 gate.
2. **Where A4's code lives.** A4 is on draft PR #699 (branch
   `claude/serene-franklin-eteidj`), which is **not merged** into `main`
   (`main` is `0b743b22`, A3 accepted).
   - If PR #699 has been merged, start from `main` at that merge.
   - If it has not, **ask the user** whether to merge it first or to build A5
     on its head. Name the head's SHA; the last code commit at writing is
     `63e00295`, and later commits are docs.
   - Never merge, un-draft or close a PR yourself.
3. **Host state, checked read-only before any host step.** These values change
   by design; a different value is a question, not a failure.

   | What | Expected at writing | How to check |
   |---|---|---|
   | Candidate | `807219527870941c37c8c8719f7a95ae58cad755`, clean | `get_self_status` |
   | Live checkout | `33528751…` (unchanged; nothing promoted) | `get_self_status` |
   | Installed supervisor, runner, proxy, fence | `0850c329…`, `de4f44d6…`, `f5e63612…`, `314b7766…` / `8d756bd2…` | `a3-install-supervisor.py status` |
   | Proxy installer copy | `59ae252e…` | `a3-install-supervisor.py status` |
   | Renewal service and timer | `cfd074a8…` / `058e2af8…` | `a3-install-supervisor.py status` |
   | Supervisor receipt key | `962dc0cf…` | `a3-install-supervisor.py status` |
   | Broker | `97e0a207…`, `approle_login: ok` | `a4-install-broker.py status` |
   | Proxy SPKI | `ASpAFpze…` | `certificate_renewal` in supervisor status |
   | Proof VM | UUID `49592202-…73e4`, boot `728c93ce…` | `inspect_a3_vm` |
   | Services | fence, origin proxy, supervisor, broker active; renewal timer active | `get_host_services proxypilot-a` |

   - The proxy SPKI rotates about every four days by
     `proxypilot-a3-proxy-renew.timer`.
   - The boot ID changes whenever the A3 `guest_crash` case runs.
   - Every A4 binding is revoked, so a proof needs a new one (A4 reference,
     step 2c).

## Read first, in this order

1. `fractionate-agents-a4-reference.md`: revisions, components, interfaces,
   host commands, rollback and rules.
2. The last three sections of `fractionate-agents-a4-evidence.md`: the
   acceptance, the proxy certificate, and the renewal runs.
3. `fractionate-agents-a3-reference.md`.
4. `CLAUDE.md` (the A3 and A4 gotchas) and `docs/core/security-host-boundary.md`
   (the A3 supervisor and A4 broker paragraphs).
5. The A5 row of `fractionate-agents-a1-a8.md`, and in
   `fractionate-agents-a1-acceptance.md`: the A5 row, the sign-in acceptance
   paragraph, and "Cross-cutting negative cases".

Older prompts are background; later dated evidence wins.

## Goal

Prove **one bounded, supervised run** of the synthetic sign-in verification
workflow on the proof VM. The run is driven by a backend-side coordinator
through the installed A3 supervisor's **backend** socket and the A4 broker:

> explicit start → land → open sign-in → **human approval** → submit the bound
> credential → read the session (verified account indicator) → read files →
> stop (logout, cookie-jar disposal) → verified receipt → durable result

The A1 criteria for A5 apply in full:
- an explicit user start;
- an atomic guide, profile and policy pin;
- one active run;
- a typed action broker;
- an approval digest;
- durable events and results;
- a cancellation fence;
- redacted observation.

Every input is untrusted. Guide, evidence, page or model text never expands
policy.

## Decisions to put to the user before writing code

Ask these with a recommendation each. Do not guess them.

1. **Where the proof coordinator runs.**
   - A5 changes backend code. The live backend runs `33528751`, and promotion
     is a deployment the user has not authorized.
   - **Recommended:** a root proof harness on the host. It runs the
     candidate's coordinator module with a temporary proof SQLite database
     against the real supervisor backend socket, which accepts root peers
     only, like the backend container. That proves the coordinator without
     promoting anything.
   - The backend container's socket mount stays an A8 item. The alternatives
     are promoting the candidate, or a separate candidate backend container;
     both are the user's call.
2. **How the loop reaches the model route.**
   - The broker socket is never mounted into the backend. The backend socket
     has no model method today (`status`, `launch`, `renew`, `action`,
     `stop`).
   - **Recommended:** one typed `model_step` method on the backend socket. It
     is bound to the live attempt, fence and pinned run. The supervisor
     forwards it to the broker's `model_call` under the run's pinned
     limits, and returns only a choice from the closed action set, or a
     refusal. Free text never goes back as an instruction.
   - This is a deliberate widening of the A3 socket, so it needs the user's
     yes. The alternative is a fixed action plan with no model in A5; the
     model then moves to a later section and the provider/budget tests run
     only at the broker (already proven in A4).
3. **Scope of the fixture changes.**
   - The injection and sign-in cases need fixture content, for example page or
     file text that tries to instruct the model.
   - **Recommended:** add it only inside the paths the origin proxy already
     allows (`/`, `/workspace`, `/api/config`, `/api/session`, `/api/files`,
     `/assets/*`). Deploy it like A4's demo change: a reviewed `server.mjs`,
     kept backup, operator-run `deploy-server`. No new proxy path.

## Preserve

- **Git and PRs.** Work on the designated branch and never rewrite pushed
  history. PR #686 and PR #699 stay draft. Open, merge, deploy or promote
  nothing unless the user asks.
- **Activation.** A2, A3 and Operations activation stay off for everyone. Only
  the proof harness exercises A5, for one operator-authorized project and
  profile, and any new flag is false by default.
- **Human-only.** No MCP tool may start a run, approve a step or enter a
  secret. Approval is a human action on an authenticated, elevated session.
  An approval claimed by a page, evidence, model output or any tool has no
  effect.
- **Untouchable.** `pp-nodus` and `nodus.fractionate.ai`. Never use
  `--upgrade-incus` or an Incus archive. Never bypass managed-LXC refusals.
- **Migrations.** 1100–1110 are immutable. New migrations take the next free
  numbers in the reserved range (check `db.js`).
- **A3/A4 boundaries do not widen**, except where decision 2 is approved.
  That covers:
  - the socket methods and the root-peer rule;
  - the fence;
  - unit properties and limits;
  - the origin proxy policy (exactly one bounded JSON `POST /api/login`);
  - the broker's value path (OpenBao → broker → `incus exec` stdin → FIFO);
  - "results and receipts carry binding ID, revision and outcome only".
- **Fixtures.** Use disposable fixtures only. The operator enters every secret
  in the dashboard; the conversation never sees a value.
- **Keep untouched:** the untracked `scripts/tests/a3-vm-probe.zip` and the
  pre-network snapshot.

## Scope

1. **Coordinator** (backend library, no public route unless decision 1 says
   so).
   - It prepares a run with `createOperationalWorkerStore(db).prepare`,
     including the binding.
   - It then runs `reserveAttempt`, `launchSpec`, `createWorkerLauncher` with
     the real supervisor client, `markRunning`, `authorizeAction` per step,
     and `fence` / `finishStop` / `recover`.
   - Run state, events and results are durable. It allows one active run per
     project and profile, and refuses a duplicate start.
2. **Typed action loop.**
   - The loop moves through a closed action set (`BROWSER_ACTIONS`), with a
     durable reservation before every action.
   - Results are recorded as untrusted and redacted:
     - the page claims the runner already reduces to typed fields;
     - no raw page text in the database or logs;
     - no value, cookie or session token anywhere.
   - If decision 2 is approved, the model sees only typed action names and
     those redacted claims. Its choice is validated against the plan and
     policy before use.
3. **Approval checkpoint.**
   - A human approval is required before `submit_bound_fixture`. The approval
     row stores a digest over the run ID, attempt, fence, action, binding ID
     and revision, guide hash, policy digest and origin.
   - It is refused when stale (any of those changed), duplicated, raced
     against a stop, or given after revocation.
4. **Stop and recovery.**
   - Operator stop and takeover still work. A stop never replays an uncertain
     action.
   - A coordinator restart fences the run and waits for the verified receipt.
     An uncertain step becomes a human decision, never a blind retry.
5. **Budget.**
   - Model calls, if any, go through the broker's reservation and ledger.
   - The loop never retries an uncertain call under a new call ID.
   - An unknown price or unknown usage stops the run fail-closed.
6. **Sign-in outcome classes** (from the A1 acceptance). Each class maps to a
   distinct, durable result:
   - verified account indicator;
   - wrong or expired credential;
   - unexpected redirect or origin;
   - MFA, passkey, CAPTCHA or consent, which needs human takeover;
   - lockout or rate limit;
   - timeout or cancelled browser;
   - logout and session cleanup.

   A navigation success, a disappearing form or a model statement is never
   proof of the intended account.

## Out of scope

- The A6 UI, beyond what decision 1 needs for a human approval.
- A7 (practice and recovery drills), A8 (deployment, the backend container
  socket mount, a real target), and every F item.
- `store_project_artifact` and document delivery. These come in only if the
  user explicitly adds document delivery to the pilot contract (A1
  acceptance).
- More origins. The proxy and its single self-signed certificate serve exactly
  `demo.fractionate.ai`. Another origin needs its own certificate and proxy
  policy, which is a later section's decision.

## Lessons carried forward (from A3 and A4 host runs)

- **Host commands.** Give one paste per step, with `set -e`. Print a failing
  step's diagnostics with `cmd || echo marker` followed by the relevant
  journal, so `set -e` never hides the cause. Give expected output and failure
  handling for each step.
- **Test the harness itself** end to end against the real classes, not only
  its pure helpers. A4's `budget` case launched a second run while the first
  was live (the supervisor allows one live attempt). Its `revocation` case read
  a field the broker does not return.
- **Default arguments.** Never bind a module constant in a default argument
  that tests patch; resolve it at call time.
- **Units that run the incus CLI** must not use `ProtectHome=yes`: the client
  keeps its config under `/root`.
- **Replacing the AppRole secret ID** in the dashboard breaks fresh broker
  sign-ins at once, while the running broker keeps a token for up to an hour.
  `a4-install-broker.py configure` restarts the broker, and `status` reports
  `approle_login`. Binding revocation, not secret-ID rotation, is the
  immediate stop.
- **Bindings.** Every proof run ends by revoking its binding; create a new one
  per run (A4 reference, step 2c).
- **The live demo's login rate limit** is keyed on the socket address, which
  is Caddy's for every visitor, so all public users share one bucket: 8
  failures in 5 minutes lock everyone out for 5 minutes. Proof runs must stay
  well below that (at most 3 failed sign-ins per 5 minutes). Test lockout
  handling against a local fixture, never by tripping the live one.
- **Evidence.** Record each host run in a dated evidence section with the exact
  outputs and digests, including runs that failed and why.

## Proofs

- **Local:**
  - the A3 and A4 Python suites plus the new A5 tests, including end-to-end
    tests of the proof harness against the real supervisor and broker
    classes;
  - the Operations and backend suites (the known sandbox failures only);
  - the host-boundary inventory without suppression;
  - the frontend and demo builds if touched.
- **Target (host):**
  - the full A3 proof (`a3-probe-worker.py`) and the A4 proof (`a4-probe.py`,
    new binding) pass again after any supervisor, runner, proxy or broker
    change;
  - one complete supervised run, with its approval row, durable events,
    result and verified receipt;
  - the refusal cases:
    - prompt injection in page or file text;
    - wrong domain or action;
    - stale guide or grant;
    - duplicate start;
    - approval race and stale approval;
    - binding rotated or revoked mid-run;
    - provider error, unknown price or usage, and budget exhausted (where the
      model is in the loop);
    - operator stop;
    - coordinator restart mid-run;
  - the sign-in outcome classes that the demo fixture can produce without
    tripping the shared rate limit;
  - the canary scan: 0 matches in every sink, now including the coordinator's
    proof database and its logs.
- **CI:** exact-head Security CI on a draft PR, only if the user authorizes
  one.

## Record and stop

- Write `fractionate-agents-a5-evidence.md` (dated sections) and
  `fractionate-agents-a5-reference.md`, which carries the host commands.
- Update the A5 row of `fractionate-agents-a1-a8.md`, `CLAUDE.md` (the A5
  gotcha), and `docs/core/security-host-boundary.md` if any socket or mount
  changed.
- Write the A6 prompt, gated on A5 acceptance. Then stop for review. Do not
  start A6.
