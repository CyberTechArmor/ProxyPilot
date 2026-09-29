# Next section prompt: A6, the supervision UI

Do not execute merely by reading this file. Check the gate first, then ask the
decisions below before writing any code.

## Gate

1. **A5 must be ACCEPTED.** `fractionate-agents-a5-evidence.md` must carry
   "Acceptance decision: A5 is ACCEPTED (2026-09-29)" (host run 3), with its
   open items named. It does, as of 2026-09-29:
   - A3 19/19, A4 6/6 and A5 17/17 on the proof host;
   - one real human approval and a verified account;
   - canary 0 (values and markers);
   - candidate `backend-tests` 0 fail.

   If a later section reverses that, stop and name the gate.
2. **Where the code lives.**
   - A5: branch `claude/beautiful-maxwell-9bldxg`. The last code is
     `9b9a15ed`; the acceptance docs are `21507dc`.
   - A5 is built on draft PR #699's head (A4, `efe0aa05`).
   - A5 has no PR. PR #699 and PR #686 are drafts, and none is merged.

   Rules:
   - If A4 and A5 are merged into `main`, start from `main` at that merge.
   - Otherwise **ask the user** whether to build on the A5 head (name the
     SHA) and which branch to use.
   - Never merge, un-draft or close a PR yourself.
3. **Host state**, read-only, only if a host step is needed:
   - candidate `8d25755c…` (A5 staged, not promoted), live `33528751…`;
   - installed supervisor `151f1d24…`, runner `a631ad9d…`, broker
     `790a1957…`, demo server `496846cd…`;
   - receipt key `f6304ffb…`, proof VM boot `62801e3b…` (it changes whenever
     the A3 `guest_crash` case runs).

   A different value is a question, not a failure.

## Read first, in this order

1. The [A5 reference](fractionate-agents-a5-reference.md) (interfaces:
   coordinator API, result classes, approval digest, harness cases), then the
   [A5 evidence](fractionate-agents-a5-evidence.md) (the three host runs and
   the acceptance section).
2. The code A6 builds on:
   - `admin/backend/src/lib/operational-run-coordinator.js` (`start`,
     `execute`, `approve`, `stop`, `recover`, `status`),
     `operational-run-policy.js` and `operational-run-schema.js` (migration
     1111);
   - `admin/backend/src/routes/operational-projects.js` (flag-gated router,
     `handle`, ETag and `If-Match`, `agentsOnly`, the denial audit);
   - `admin/backend/src/middleware/auth.js` `requireSudo` (sudo elevation);
   - `admin/frontend/src/pages/OperationalProjectDetail.jsx`,
     `components/operational-projects/Agents.jsx` and `shared.jsx`;
   - `admin/frontend/src/lib/api.js` (CSRF, the sudo modal on 401/403,
     retries).
3. `CLAUDE.md`: the A3/A4/A5 gotchas and the **mandatory mobile-first UI
   rule**. Then `admin/frontend/MOBILE_FIRST.md` (a merge gate, with its
   pre-merge checklist).
4. The A6 row of `fractionate-agents-a1-a8.md`, and in
   `fractionate-agents-a1-acceptance.md`: the A6 row and "Cross-cutting
   negative cases".

## Goal

A minimal, human-only supervision UI for the one synthetic sign-in workflow,
inside the existing Operations project pages:
- **Overview:** a project's agent runs (state, result class, `needs_human`,
  started by, when), with an explicit **Start** per eligible profile.
- **Run detail:**
  - the typed step timeline: ordinal, action, **decided by rule or model**
    (with the rule name), state, typed claims, error code;
  - model calls (choice, refusal, settled cost), approvals, the durable
    result and its class;
  - an explicit **Stop**.
- **Approval inbox:** the caller's pending approvals across projects. Each
  shows the digest's fields (action, run, attempt and fence, binding and
  revision, guide hash, policy digest, origin) and the digest. Approving is
  an elevated human action.
- **Help requests:** runs with `needs_human` (challenge, takeover,
  interrupted, uncertain step, uncertain model call), with the decision the
  person must make stated in words. Takeover itself stays on the host
  operator socket; resume is A7.
- **Profile settings the loop needs:**
  - the owner's model-guide consent (`modelGuideConsent`, typed
    confirmation);
  - a read-only view of the hard rules parsed from the assigned guide
    (`guideRules`), so people can see what code will enforce.

Refresh and reconnect show only durable server state. There is no dead
control: a control that cannot act says why (flag off, execution unavailable,
profile not ready, no access).

## Decisions to ask the user before writing code

1. **Where a run executes behind the UI.** A5's coordinator runs only in the
   host proof harness. A live UI run needs the supervisor backend socket (and
   its public key) inside the backend container. That mount is an A8 item.
   - **Option A (recommended):** add the routes and UI behind a new
     false-default flag (for example `OPERATIONS_AGENT_RUNS_ENABLED`, which
     also requires the Operations and agents-metadata flags).
     - With no supervisor configured, the backend constructs no launcher, and
       Start and Approve answer a typed `EXECUTION_UNAVAILABLE`, shown as a
       reason rather than an error.
     - Journeys run against a separate UI harness: the real routers, the real
       stores and a scripted supervisor on a temporary database, which
       `index.js` never imports.
     - Nothing live changes.
   - **Option B:** mount the socket and deploy (`promote_self`). This carries
     every A5 decision-1 risk:
     - downtime;
     - irreversible migrations 1109–1111 on the live database;
     - unreviewed code;
     - a coordinator inside the live product process;
     - S6 still open.

     Deploy only after the local suites, `run_self_checks`, a database backup
     and a stated rollback. Promotion stays a separate user step.
2. **The approval gesture.** `approve` refuses unless `elevated === true`.
   Propose the existing sudo elevation (`requireSudo`, the api.js modal) plus
   **typing at least the first 12 characters of the digest**, as the proof
   harness does. The alternative is sudo plus a confirmation of the shown
   fields.
3. **Four-eyes.** May the person who started a run approve its submit? A5
   allows it; A1 does not require separation for the pilot. Options: allow,
   refuse the starter, or make it a project setting.
4. **The view-only stream.** The recommended option is **typed progress
   only**, with no screenshots in A6. The alternative is the supervisor
   operator socket's `view`. That would be a new backend path to an
   operator-only method, so it is a boundary decision and would need its own
   host proof.

## Preserve

- **Git and PRs.** Work on the designated branch and never rewrite pushed
  history. Open, merge, deploy or promote nothing unless the user asks.
- **Activation.** A2, A3, A5 and Operations activation stay off for
  everyone. Every new flag is false by default. Enabling it on a live host is
  a human decision outside this section.
- **Human-only.**
  - There is no MCP tool, catalog entry or policy allowlist for starting,
    approving or stopping runs, or for entering secrets.
  - A page, evidence, model output or tool claim that "approval was given"
    has no effect.
  - Approval needs an authenticated, elevated session and a digest that
    still holds.
- **The A3/A4/A5 boundaries do not widen.** That covers:
  - the socket methods (including `model_step`), the root-peer rule, the
    fence and the unit properties;
  - the origin proxy policy (one bounded `POST /api/login`);
  - the broker's value path;
  - typed claims only;
  - "results and receipts carry binding ID, revision and outcome only".

  The UI never receives an attestation body, a page text, a prompt, a value,
  a cookie or a token. The receipt appears as "verified" plus its key ID.
- **Existing surfaces stay stable.** Dev Studio routes, IDs and saved
  preferences; the manual-run routes `/:id/runs` (agent runs take a distinct
  path, for example `/:id/agent-runs`); the Operations B1–B4 and D1–D4
  contracts.
- **Migrations.** 1100–1111 are immutable. Any new migration takes the next
  free number in the Operations range (check `db.js`).
- **UI.** `MOBILE_FIRST.md`:
  - default breakpoints only, one column on mobile, 44×44 targets;
  - dialogs full-screen below `sm` and completable at 360 px;
  - no horizontal scroll;
  - two themes;
  - no fixed desktop widths.
- **Untouchable.**
  - `pp-nodus` and `nodus.fractionate.ai`.
  - Never use `--upgrade-incus` or an Incus archive, and never bypass
    managed-LXC refusals.
  - Keep the untracked `scripts/tests/a3-vm-probe.zip` and the pre-network
    snapshot.

## Scope

1. **Routes** (per decision 1). All sit behind the flags, run through
   `handle` (typed errors, denial audit), and never return raw DB rows.
   - `GET /:id/agent-runs` (list) and `GET /:id/agent-runs/:runId` (the
     coordinator's `status`, typed).
   - `POST /:id/agent-runs` with `{profile_id, credential_binding_id?}`: an
     explicit start with `run` access. Duplicate submits are safe (an
     idempotency key, or `RUN_ALREADY_ACTIVE` shown as such).
   - `POST /:id/agent-runs/:runId/stop`, with `run` access.
   - `POST /agent-approvals/:approvalId`, carrying `requireSudo` and the
     digest (per decision 2), plus `GET /agent-approvals`, the caller's
     pending inbox.
   - `PUT /:id/agent-profiles/:profileId/model-guide-consent`: owner only,
     `If-Match`, the typed confirmation.
   - `GET /:id/agent-profiles/:profileId/rules`: the parsed rules of the
     assigned guide, or the typed parse refusal.
2. **Execution wiring** (per decision 1).
   - The backend builds a coordinator only when the flag is on and a
     supervisor socket, public key and VM UUID are configured.
   - With a coordinator, `execute` runs in the background, and `recover` runs
     at boot.
   - Without one, every execution control fails closed with
     `EXECUTION_UNAVAILABLE`.
   - The coordinator's semantics do not change. If they must, the A5 host
     proof reruns (below).
3. **Pages and components.**
   - An "Agent runs" panel in `OperationalProjectDetail`: the overview, Start
     per profile, and profile readiness reasons.
   - The run detail: the timeline, approvals, the result, Stop, and the help
     banner.
   - The approval dialog: the fields, digest entry, sudo, and a clear
     refusal message for stale, duplicate, raced or revoked approvals.
   - The inbox entry point.
   - The consent control and the rules view in `Agents.jsx`.
   - Polling or refetch of durable state, with `aria-live` for state
     changes.
4. **Stale and revoked access.** A removed grant, a revoked binding, a new
   guide or a stopped run appears as the refusal it is. The UI never keeps an
   approval control usable after the server has closed it.

## Out of scope

- A7: practice and recovery drills, resume after takeover, reconciling
  uncertain steps.
- A8: deployment, the container socket mount (unless decision 1 is B), a
  real target, release gates.
- Every F item. More origins or workflows. `store_project_artifact`.
- Fixing the A5 open items: the origin proxy's resend-after-timeout, the
  `open_landing` timeout seen once, and the locally-proven classes. Carry
  them; do not absorb them.

## Lessons carried forward (A3–A5 host runs)

- **Test the harness and the UI end to end against the real classes.**
  A5's end-to-end harness test found four defects that unit tests missed.
- **Local fixtures must behave like the real application.** A5's runner
  misclassified every successful sign-in because the local test page, unlike
  the demo, loaded nothing after signing in. Journeys must cover what the
  real app does after each state change.
- **A case that passes only if a model or a person misbehaves is not a
  proof.** Make it deterministic, or ask the user how to prove it.
- **Input checks must accept every correct human answer.** A 13-character
  correct digest prefix was refused because the check wanted exactly 12.
- **Never put a secret or a scan marker on a command line.** sudo logs
  command lines in the host journal.
- **Host steps.**
  - One paste per step, with `set -e`, and `cmd || echo marker` plus the
    journal on failure.
  - State the expected output.
  - End with a **read-only summary command** that prints every verdict from
    the report files, because screenshots miss lines.
  - Say plainly which steps are required. A5's regression step was skipped
    twice.
- **Default arguments.** Never bind a module constant that tests patch;
  resolve it at call time.
- **The live demo's shared rate limit** (8 failures in 5 minutes lock
  everyone out). Never trip it; the fixture modes never count toward it.

## Proofs

- **Local:**
  - the Operations and backend suites (the known sandbox failures only);
  - the A3/A4/A5 script suites;
  - the host-boundary inventory without suppression;
  - the frontend build.
- **Browser journeys** (Playwright with the preinstalled Chromium), against
  the UI harness:
  - **Roles:** owner, operator, reviewer, a viewer without run access, and an
    outsider who gets a 404.
  - **Flows:**
    - start, then the rule steps, then the approval with sudo and the digest,
      then the verified result;
    - stop mid-run;
    - a stale approval (binding rotated or guide changed);
    - an approval racing a stop;
    - a revoked grant while viewing;
    - refresh and reconnect during an approval;
    - keyboard only;
    - each result class and help banner.
  - **Layout:** 360, 375 and 768 px (plus the six-width, two-theme check),
    with no horizontal scroll and 44 px targets.
  - Every control either acts or says why it cannot.
  - The MOBILE_FIRST pre-merge checklist is completed and recorded.
- **Target:**
  - With option A: none is needed if the coordinator, policy, boundary and
    runner are unchanged. The A5 proof stays the target proof. If any of
    them changed, stage and rerun A5 host steps S1–S3 plus the summary
    command.
  - With option B: one supervised run started, approved and stopped from the
    UI on the proof host, plus the A5 refusal cases and the canary.
- **CI:** exact-head Security CI on a draft PR, only if the user authorizes
  one.

## Record and stop

- Write `fractionate-agents-a6-evidence.md` (dated sections) and
  `fractionate-agents-a6-reference.md`.
- Update:
  - the A6 row of `fractionate-agents-a1-a8.md`;
  - `CLAUDE.md` (the A6 gotcha);
  - `docs/core/security-host-boundary.md`, if a route, mount or method
    changed;
  - `.env.example`, for any new flag.
- Write the A7 prompt, gated on A6 acceptance. Then stop for review. Do not
  start A7.
