# Next section prompt: A7, practice and recovery

Do not execute merely by reading this file. Check the gate first, then ask the
decisions below before writing any code.

## Gate

1. **A6 must be ACCEPTED.** `fractionate-agents-a6-evidence.md` must carry an
   "Acceptance decision: A6 is ACCEPTED (<date>)" section recording the A6
   host run with its open items named:
   - the supervisor with the backend `view` installed;
   - A3 20/20 including `backend_view`, A4 6/6, A5 17/17 with one real human
     approval;
   - both canary scans 0 (values and markers);
   - `a6-host-summary.py` printing `"all_passed": true`;
   - the candidate `backend-tests` 0 fail.

   As of 2026-09-29 it does **not**: A6 is implemented and proven locally
   (13 browser journeys, 60 layout checks) and its host steps H0–H5 are
   pending. If the gate does not hold, stop and name it.
2. **Where the code lives.**
   - A6: branch `ccr-4216e4d3-jsij65` (code `ec986a88`, built on the A5 head
     `5210cfb7`). A5 is on `claude/beautiful-maxwell-9bldxg`; A4 is draft PR
     #699. None is in `main`, and A5 and A6 have no PR.
   - If A4–A6 are merged into `main`, start from `main` at that merge.
     Otherwise **ask the user** whether to build on the A6 head (name the SHA)
     and which branch to use.
   - Never merge, un-draft or close a PR yourself.
3. **Host state**, read-only, only if a host step is needed: the candidate
   and live SHAs, the installed supervisor/runner/broker/demo digests, the
   receipt key and the proof VM boot from the A6 acceptance section. A
   different value is a question, not a failure.

## Read first, in this order

1. The [A6 reference](fractionate-agents-a6-reference.md) and
   [A6 evidence](fractionate-agents-a6-evidence.md), then the
   [A5 reference](fractionate-agents-a5-reference.md) (coordinator, result
   classes, recovery, harness cases).
2. The code A7 builds on:
   - `admin/backend/src/lib/operational-run-coordinator.js` (`recover`,
     `terminate`, `awaitTakeover`, the `NEEDS_HUMAN` classes) and
     `operational-worker-boundary.js` (`recover`, fences, attempts);
   - `admin/backend/src/lib/operational-agent-runs.js` (help requests, the
     inbox) and `components/operational-projects/AgentRuns.jsx`;
   - `scripts/a3-worker-supervisor.py` (takeover, the operator socket, the
     journal's uncertain actions, the receipt's `uncertain_actions`);
   - `scripts/a5-probe.mjs` (`coordinator_restart`, `takeover`,
     `operator_stop`).
3. `CLAUDE.md` (the A3–A6 gotchas and the mobile-first UI rule), then
   `admin/frontend/MOBILE_FIRST.md`.
4. The A7 row of `fractionate-agents-a1-a8.md`, and in
   `fractionate-agents-a1-acceptance.md` the A7 row and "Cross-cutting
   negative cases".

## Goal

Practice and recovery for the one synthetic sign-in workflow:
- **Rehearsal:** a disposable practice run through the same policy and worker
  path with the synthetic account, marked as practice everywhere it appears.
- **Interruptions:** kill the coordinator or the worker mid-read, mid-approval
  and mid-write; every case ends in a durable terminal result, never a blind
  replay.
- **Reconciliation:** a person resolves each uncertain step or model call
  with a typed decision (for example "the sign-in happened" / "it did not" /
  "unknown, leave blocked"), recorded and audited; nothing is re-sent on
  their behalf.
- **Takeover and resume:** explicit human takeover ownership, and an explicit
  resume that starts a new attempt with a new fence (never the old attempt).
- **Basic critique:** a short, typed summary of what went well or wrong per
  run, from durable state only.

## Decisions to ask the user before writing code

1. **Where takeover is driven.** Today takeover and human input exist only on
   the host operator socket. Options: keep them there and only record
   ownership and the resume decision in the product (recommended), or add a
   UI path (a boundary change with its own host proof).
2. **Resume semantics.** A new run pinned from the taken-over run's policy
   (same guide, profile and binding revisions, refused if any changed), or a
   new attempt within the same run (needs a coordinator change and the A5
   host proof rerun).
3. **What a reconciliation decision may unlock.** Only closing the help
   request, or also allowing the next run to start; whether it needs a
   second person.
4. **Practice runs.** A flag on the run (same tables), or a separate project
   of the same shape; how the synthetic account and the demo's fixture modes
   are selected.
5. **The critique.** Rule-based from typed state only (recommended), or a
   model summary (a new model use: consent, budget and prompt boundary).

## Preserve

- Git and PRs: the designated branch, no rewritten pushed history, nothing
  opened, merged, deployed or promoted unless the user asks.
- Activation stays off; every new flag defaults false.
- Human-only: no MCP tool, catalog entry or policy allowlist starts,
  approves, stops, reconciles, takes over or resumes a run.
- The A3/A4/A5/A6 boundaries do not widen without a decision: the socket
  methods (A6 added only the read-only backend `view`), the root-peer rule,
  the fence, the unit properties, the origin proxy's one bounded
  `POST /api/login`, the broker's value path, typed claims only, and
  "results and receipts carry binding ID, revision and outcome only".
- Migrations 1100–1111 are immutable; a new one takes the next free number
  in the Operations range.
- `MOBILE_FIRST.md` for every UI change; no dead control.
- Untouchable: `pp-nodus` and `nodus.fractionate.ai`; no `--upgrade-incus`,
  no Incus archive, no bypassing managed-LXC refusals; keep
  `scripts/tests/a3-vm-probe.zip` and the pre-network snapshot.

## Out of scope

- A8: deployment, the container socket mount, a real target, release gates.
- Every F item; more origins or workflows.
- The carried A5/A6 open items (the origin proxy's resend-after-timeout, the
  one `open_landing` timeout, the locally proven classes) unless the user
  moves one into A7.

## Lessons carried forward

- Test the harness and the UI end to end against the real classes; A6's
  journeys found a help-classification defect that unit tests missed.
- Local fixtures must behave like the real application after each state
  change.
- A case that passes only if a model or a person misbehaves is not a proof.
- Input checks must accept every correct human answer.
- Never put a secret or a scan marker on a command line.
- Host steps: one paste per step, `set -e`, `cmd || echo marker` plus the
  journal on failure, the expected output stated, and a read-only summary
  command (`a6-host-summary.py` or its successor) that prints every verdict.
  Say plainly which steps are required.
- Resolve module constants that tests patch at call time.
- Never trip the live demo's shared sign-in limit.

## Proofs

- Local: the Operations and backend suites (sandbox failures named), the
  A3–A7 script suites, the host-boundary inventory without suppression, the
  frontend build, and the A6 browser journeys plus new A7 journeys.
- Target: the kill cases on the proof host (coordinator and worker, mid-read,
  mid-approval, mid-write), takeover ownership and resume with a new fence,
  grant and key loss, the regression proofs and the canary.
- CI: exact-head Security CI on a draft PR, only if the user authorizes one.

## Record and stop

- Write `fractionate-agents-a7-evidence.md` (dated sections) and
  `fractionate-agents-a7-reference.md`.
- Update the A7 row of `fractionate-agents-a1-a8.md`, `CLAUDE.md`,
  `docs/core/security-host-boundary.md` (if a route, mount or method
  changed) and `.env.example` (for any new flag).
- Write the A8 prompt, gated on A7 acceptance. Then stop for review. Do not
  start A8.
