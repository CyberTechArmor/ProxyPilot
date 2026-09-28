# Next section prompt: A6, the supervision UI

Do not execute merely by reading this file. Check the gate first.

## Gate

1. **A5 must be ACCEPTED.** `fractionate-agents-a5-evidence.md` must carry a
   dated acceptance section that says "A5 is ACCEPTED", from observed host
   evidence:
   - host steps 0–4 of the [A5 reference](fractionate-agents-a5-reference.md);
   - the A5 proof with its one human approval;
   - the A3 and A4 regressions;
   - the canary scan with the A5 sinks and the marker.

   Its open items must be named. If it does not, stop and name the open A5
   gate. At writing (2026-09-28), A5 is implemented and locally verified,
   **not accepted**.
2. **Where A5's code lives.** A5 is on branch `claude/beautiful-maxwell-9bldxg`
   (code `6d420735`), built on draft PR #699's head (A4). Neither is merged.
   - If both are merged, start from `main` at that merge.
   - Otherwise ask the user whether to build on the A5 head. Name its SHA.
   - Never merge, un-draft or close a PR yourself.
3. **Host state**, read-only, before any host step: the A5 reference's
   step 0 values. A different value is a question, not a failure.

## Read first, in this order

1. The [A5 reference](fractionate-agents-a5-reference.md), then the A5
   evidence (the acceptance section and its open items).
2. The A4 and A3 references (rules, sockets, host commands).
3. `CLAUDE.md` (the A3, A4 and A5 gotchas, and the **mandatory mobile-first UI
   rule**) and `admin/frontend/MOBILE_FIRST.md`.
4. The A6 row of `fractionate-agents-a1-a8.md`, and in
   `fractionate-agents-a1-acceptance.md`: the A6 row and "Cross-cutting
   negative cases".

## Goal

A minimal supervision UI for the one synthetic sign-in workflow:
- an Agents/Flightdeck overview and a one-run detail;
- explicit start and stop;
- a view-only stream;
- redacted progress (the typed steps, who decided each, rule or model);
- an approval/help inbox that shows the approval digest and its fields;
- the durable result with its outcome class and `needs_human`.

The existing Dev Studio routes, IDs and saved preferences stay stable.
Flightdeck is the reserved name for this interface (CLAUDE.md, "Sidebar
naming").

## Decisions to ask the user before writing code

1. **Where the UI's backend runs.** The A5 coordinator runs only in a host
   proof harness. A UI needs routes in the backend, and a live run needs the
   supervisor backend socket inside the backend container. That mount is an
   A8 item.
   - **Option A (recommended):** routes behind a new false-default flag. They
     are tested against a scripted supervisor, the same pattern as the A5
     coordinator tests. Real runs stay in the proof harness until A8. Nothing
     live changes.
   - **Option B:** deploy and mount now. This carries every A5 prompt
     decision-1 risk (downtime, irreversible migration 1111 on the live
     database, unreviewed code, a live socket mount). Promotion stays a
     separate, explicit user step.
2. **The approval surface.** The approval must be a human action on an
   authenticated, **elevated** session: `approve` refuses `elevated !== true`.
   Propose reusing the existing sudo-elevation flow (the 403 modal in
   `admin/frontend/src/lib/api.js`). Confirm that the person must retype part
   of the digest, as in the proof harness, or must only confirm the shown
   fields.
3. **The view-only stream.** Either no screenshots in A6 (typed progress only,
   recommended), or the supervisor operator socket's `view` behind takeover
   rules. That is a new backend path to an operator-only method, so it needs
   an explicit decision.

## Preserve

- **Git and PRs.** Work on the designated branch and never rewrite pushed
  history. Open, merge, deploy or promote nothing unless the user asks.
- **Activation.** A2, A3, A5 and Operations activation stay off for everyone.
  Any new flag is false by default and human-only, like `mcp.platform`.
- **Human-only.** No MCP tool may start a run, approve a step or enter a
  secret. A page, evidence, model output or tool claim that "approval was
  given" has no effect.
- **The A3/A4/A5 boundaries do not widen.** That covers the socket methods
  (including `model_step`), the fence, the proxy policy, the broker's value
  path, the typed-claims-only rule, and "results and receipts carry binding
  ID, revision and outcome only".
- **Migrations.** 1100–1111 are immutable. New ones take the next free number
  in the Operations range (check `db.js`).
- **UI.** `MOBILE_FIRST.md` is a merge gate: default breakpoints, one column
  on mobile, 44×44 targets, dialogs completable at 360 px, no dead control,
  no implicit takeover.
- **Untouchable:** `pp-nodus`, `nodus.fractionate.ai`; never
  `--upgrade-incus` or an Incus archive; never bypass managed-LXC refusals.
  Keep the untracked `scripts/tests/a3-vm-probe.zip` and the pre-network
  snapshot.

## Scope

1. Routes (per decision 1), behind the flag, each with its own check:
   - start, with `run` access;
   - stop;
   - status;
   - approve, which needs an elevated session;
   - a list of the caller's runs.

   The routes return only what `status` returns today: typed steps, model
   call summaries, approvals, events and the result without the attestation
   body.
2. An overview page and a run detail page:
   - progress;
   - who decided each step;
   - the approval inbox with the digest fields;
   - stop;
   - the durable result and its class;
   - `needs_human`, with what the person must decide (an uncertain step, a
     takeover, a challenge).
3. Refresh and reconnect show the durable state. There is no client-side run
   state that the server does not hold.
4. Stale or revoked access: a removed grant, a revoked binding or a new guide
   is shown as the refusal it is, never as a control that silently fails.

## Out of scope

- A7 (practice and recovery drills, resume after takeover).
- A8 (deployment, the socket mount, a real target).
- Every F item.
- More origins or workflows.
- `store_project_artifact`, unless the user adds document delivery to the
  pilot contract.

## Lessons carried forward

- **Test the harness and the UI end to end against the real classes**, not
  only pure helpers. A5's harness test found four defects that the unit tests
  missed: a name collision, an `undefined` option overriding a default, a case
  reading as a user whose grant it had just removed, and a blocking TTY read
  that kept Node alive.
- **Default arguments.** Never bind a module constant in a default argument
  that tests patch; resolve it at call time.
- **Host commands.** One paste per step with `set -e`. Print diagnostics with
  `cmd || echo marker` and the journal. Give expected output and failure
  handling.
- **The live demo's shared rate limit** (8 failures in 5 minutes lock
  everyone out). The A5 fixture modes never count toward it; keep it that way.
- **The origin proxy's retry after send** (A5 evidence finding) is still open.
  Never use a slow fixture on the live demo.

## Proofs

- **Local:**
  - the Operations and backend suites (the known sandbox failures only);
  - the A3/A4/A5 script suites;
  - the host-boundary inventory without suppression;
  - the frontend build;
  - role-based browser journeys at 360, 375 and 768 px (and the six-width,
    two-theme checks), covering keyboard, refresh/reconnect and stale/revoked
    access.
- **Target:** per decision 1. With option A there is no live run from the UI;
  the A5 proof stays the target proof. With option B, one supervised run
  started, approved and stopped from the UI, plus the A5 refusal cases.
- **CI:** exact-head Security CI on a draft PR, only if the user authorizes
  one.

## Record and stop

- Write `fractionate-agents-a6-evidence.md` and
  `fractionate-agents-a6-reference.md`.
- Update the A6 row, `CLAUDE.md` and the host-boundary doc if a route, mount
  or method changed.
- Write the A7 prompt, gated on A6 acceptance. Then stop for review.
