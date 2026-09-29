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

## Decisions (user answers 2026-09-28)

### 1. Where the coordinator runs: still open, ask first

A5 changes backend code. The live backend runs `33528751`; the candidate
(`80721952`) is it plus the staged A3/A4 work.

**Option A, the proof harness (recommended).** A root script on the host runs
the candidate's coordinator module with a temporary proof SQLite database,
against the real supervisor backend socket. That socket accepts root peers
only, exactly like the backend container.
- Nothing live changes.
- The container socket mount stays an A8 item.

**Option B, deploy (`promote_self`).** This would put the candidate, and later
A5, into the live backend. The risks, as explained to the user:
- **Downtime and a single point of failure.** `update.sh` rebuilds and
  restarts the backend container. The dashboard, the API and the MCP surface
  are down for the rebuild; Caddy keeps serving sites. A failed build on the
  low-memory host leaves the dashboard down until `rollback_self`.
- **Irreversible schema.** Migrations 1109 and 1110 (and A5's) apply to the
  live database. They are additive, and old code ignores them, but a rollback
  does not remove them. `update.sh` takes a database backup first.
- **Skipped release gates.** The A3/A4/A5 code is on draft PRs that no person
  has reviewed. A8 is where release happens: final-head review, backup,
  restore and rollback proof, S6/SEC resolution. Deploying now moves unreviewed
  code to live ahead of those gates.
- **The socket mount.** Running A5 live needs the supervisor backend socket
  mounted into the live backend container (a `docker compose` change). The
  marginal security risk is small, because the backend is already
  root-equivalent (S6 open). But any coordinator bug then runs inside the live
  product process.
- **What stays safe either way.** Activation is off, with no routes or starter,
  so the deployed A3/A4 code does nothing until enabled.

Ask the user to choose A or B before writing code. If they choose B, deploy
only after the local suites and `run_self_checks` pass on the exact candidate,
with a database backup and a stated rollback. Promotion stays a separate,
explicit user step.

### 2. Who decides the next action: hybrid (decided)

The AI decides, informed by the project's approved guide and its documents.
Operator-set **hard rules** decide wherever they apply, with no model
involved. Precedence, highest first:

1. **A3/A4 boundaries.** The supervisor, runner, proxy and broker refuse
   everything outside the pinned launch and policy, whatever anyone asks.
2. **Hard rules.** A typed, versioned, human-approved rule set for the
   project and profile. Its hash is the run's `policy_digest`, which is
   already pinned at `prepare` and at launch (`RUN_POLICY_MISMATCH` on
   change). Hard rules are enforced by code and never interpreted by the
   model. They can:
   - fix automated steps (for example: always land, then open sign-in, then
     sign out at stop);
   - forbid actions;
   - require a human approval before named actions (always before
     `submit_bound_fixture`);
   - set stop conditions (for example: stop once the verified account
     indicator is seen);
   - cap steps and spend.

   When the rules fully determine the next step, **no model call is made**.
3. **Guide and documents.** The approved guide version (`ops_guide_versions`:
   the instructions and their `content_hash`, pinned as `guide_hash`) and the
   evidence documents it references. They tell the model *how* to do the job
   inside what the rules leave open. They can never add an action, an origin,
   a credential or an approval (A1 cross-cutting rule).
4. **The model** (`gpt-6-luna`, through the broker). It picks one action from
   the set the rules leave open. It sees the guide, the redacted page claims
   and that allowed set; its answer is validated before use.

**Path to the model.** Add one typed `model_step` method on the supervisor's
backend socket. This is the only approved widening of the A3 socket.
- It is bound to the live attempt, fence and pinned run.
- The supervisor forwards it to the broker's `model_call` under the run's
  pinned limits.
- It returns only one action name from the allowed set, or a refusal. Free
  text never comes back as an instruction.
- The guide text it carries must hash to the run's pinned `guide_hash`, so the
  model sees exactly the approved version.

**Consequences to handle:**
- **Prompt size.** The broker's `MAX_PROMPT_BYTES` (4000) is too small for a
  guide. Raising it, with the reservation arithmetic kept exact, changes the
  broker. That means a broker reinstall and the A4 proof again.
- **Where the guide goes.** Guide and document text is sent to OpenAI
  (`store: false`). Record per profile whether its guide may be sent to the
  provider, and refuse model steps when it may not.
- **Where the rules come from.** Propose them either as a structured section
  of the guide (reviewed and hashed with it) or as a separate reviewed rules
  document. Keep one reviewer path and never self-approval.

### 3. Fixture content (decided: as recommended)

Put the injection and outcome fixtures only inside paths the origin proxy
already allows: `/`, `/workspace`, `/api/config`, `/api/session`,
`/api/files`, `/assets/*`. Examples are a file entry or page text in the demo's
synthetic data. Deploy it like A4's demo change: a reviewed `server.mjs`, a
kept backup, an operator-run `deploy-server`. No new proxy path.

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
- **A3/A4 boundaries do not widen**, except for the one `model_step` method
  approved in decision 2 and the broker prompt-size change it needs.
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
2. **Hybrid action loop** (decision 2).
   - Each step:
     1. evaluate the hard rules;
     2. if they determine the step, take it;
     3. otherwise call `model_step` with the guide, the redacted claims and the
        rule-filtered allowed set;
     4. validate the choice;
     5. `authorizeAction` (a durable reservation);
     6. the supervisor action;
     7. record the untrusted, redacted result.
   - Record which steps were rule-decided and which were model-decided.
   - Nothing enters the database or logs beyond the typed fields the runner
     already reduces page claims to: no raw page text, no value, no cookie, no
     session token.
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
  - the hybrid cases:
    - a rule-decided step makes no model call;
    - a model choice outside the rule-filtered set is refused;
    - a guide whose hash differs from the pin is refused;
    - a profile that may not send its guide to the provider is refused a
      model step;
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
