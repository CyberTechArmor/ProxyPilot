# Next section prompt: A8, deployment and supervised pilot

Do not execute merely by reading this file. Check the gate first, then ask the
decisions below before writing any code or running any host step.

## Gate

1. **A7 must be ACCEPTED.** `fractionate-agents-a7-evidence.md` must carry an
   "Acceptance decision: A7 is ACCEPTED (<date>)" section recording the A7
   host run (H0–H7 in the [A7 reference](fractionate-agents-a7-reference.md))
   with its open items named:
   - the TURN relay installed and enabled (`a7-install-live.py status`: TURN
     active, both listeners, the certificate, the fence's live line, the live
     marker);
   - A3 20/20 **in live mode** (`after_live_enabled: true`), A4 6/6, A5 17/17
     with one real human approval, A7 18/18 including the six kill cases,
     account and key loss;
   - the three canary scans clean;
   - `a7-host-summary.py` printing `"all_passed": true`;
   - the candidate `backend-tests` with no failure beyond the known sandbox
     set.

   If it does not, stop and name what is missing. (It does as of 2026-09-30:
   the section records the host run, the open items and the user's
   dispositions.)
2. **Where the code lives.** A7 is in `main` (#707 and the host-run fixes
   #708–#710; `main` `02398ef9` on 2026-09-30) and deployed (live `0627d437`).
   Never merge, un-draft or close a PR without the user's word in the
   conversation. Never rewrite pushed history.
3. **Host state**, read-only, only when a host step is needed: the candidate
   and live SHAs, the installed supervisor/runner/broker/demo digests, the
   receipt key, the proof VM boot, the TURN name, the Neko digest and the live
   marker, from the A7 acceptance section (after the 2026-09-30 host run:
   supervisor `44904081…`, runner `d0724e5f…`, receipt key `5febe58a…`, VM
   boot `f55089ba…`, TURN `streamview.fractionate.ai` on `192.168.88.161`,
   Neko `a19dc462…`, live policy `b515d84c…`, marker `1689bec8…`). A
   different value is a question, not a failure.

## Read first, in this order

1. The A7 reference and evidence (decisions, the host run, the open items and
   the user's dispositions), then the A6 and A5 references.
2. `fractionate-agents-a1-a8.md` (the A8 row, "Controls and dependency
   mapping") and `fractionate-agents-a1-acceptance.md` (the A8 row and
   "Cross-cutting negative cases").
3. `docs/core/security-host-boundary.md` (S6 and every A3–A7 widening) and
   `fractionate-agents-security-audit-register.md` (S6/SEC/INF items).
4. The code A8 wires up:
   - `admin/backend/src/lib/operational-agent-runtime.js` and `index.js`
     (`OPERATIONS_AGENT_SUPERVISOR_SOCKET`, `_PUBLIC_KEY`, `OPERATIONS_AGENT_VM_UUID`;
     `EXECUTION_UNAVAILABLE` without them), `routes/agent-live-ws.js`,
     `lib/operational-demo-fixtures.js` (only where execution is configured);
   - the container definition that `install.sh` writes (its compose file) and
     `update.sh`, and the self-update path (`docs/features/self-update.md`);
   - `scripts/a3-install-supervisor.py` (the socket's owner and mode) and the
     supervisor's root-peer rule (`listen`, `peer_uid`).
5. `CLAUDE.md` and `admin/frontend/MOBILE_FIRST.md`.

## Goal

Release A3–A7 to the live dashboard and run one real supervised workflow:
- **The supervisor reaches the backend.** Today the backend container has no
  supervisor socket, so every execution control answers
  `EXECUTION_UNAVAILABLE`. A8 connects them without widening what the socket
  accepts: the same methods, the same root-peer rule (or its reviewed
  replacement), the same pins.
- **Release gates:** exact-head review and CI on a PR, the database backup
  and restore check, migrations up to 1112 applied and verified, rollback
  proven, and the S6/SEC/INF items the user rules applicable closed or
  accepted in writing.
- **One real supervised pilot run** on the chosen target, watched live and
  taken over from the dashboard over the internet (the one A7 part that
  could not run before this). It is stopped and recovered as the runbook
  says, with its audit, cost and result read back.
- **The supervisor's record beside the reconcile buttons** (user decision,
  2026-09-30: "Please include"). When a run's step is uncertain (a submit or
  sign-out whose answer was lost), the reconcile panel shows what the
  supervisor itself recorded for that attempt's step: its state (started,
  done, failed) and time, never a page, value or receipt body. The person
  still decides; the record informs the decision, it does not make it.
  Reaching it needs a read the backend socket does not have today:
  present its exact shape (method, parameters, fields, who may call it)
  with decision 1, and write nothing until the user approves it.
- **An operator runbook** and the explicit limitations.

## Decisions to ask the user before writing code

1. **How the backend reaches the supervisor.** Mount the supervisor's backend
   socket into the `proxypilot-admin` container, which needs a uid-0 peer
   inside it or a reviewed change to the root-peer rule. Or put a host-side
   relay socket owned by a dedicated uid in front of it. State what a
   compromised backend could then do (S6), and which host proof reruns.
2. **The pilot target.** The synthetic sign-in on `demo.fractionate.ai`
   again, now from the live dashboard, or a real site and account the user
   names. For a real one: its origin, the credential and who binds it, its
   own fixture policy (practice runs stay demo-only), and what "stop" and
   "sign out" mean there.
3. **Which S6/SEC/INF items block the release** and which are accepted with
   a written limitation (the register lists them).
4. **The merge path.** A7 is already in `main`. One PR for the A8 code, who
   reviews it, and whether exact-head CI runs on a draft first.
5. **Who gets run access in the pilot**, and whether the model summary is
   allowed for the pilot profile (owner consent).

## Already decided (do not ask again)

- **Show the supervisor's record beside the reconcile buttons:** include it
  (2026-09-30). It is a deliverable above; only the shape of the read is
  still to approve.
- **The reboot test** (`a6-reboot-check.py`): **ignore for now**
  (2026-09-30). It is not part of A8 unless the user brings it back. If they
  do, first add A7's parts to it (the TURN relay, the fence's live line and
  the live marker).
- **The router and the TURN name:** the router maps the public address 1:1
  to the host (`96.88.158.118` ↔ `192.168.88.161`). The user's external TLS
  check of `streamview.fractionate.ai:5350` verified (2026-09-30). No router
  step is needed for the pilot.
- **The `pp-a7-pre-live-…` snapshots** (four, ZFS, about 26 MB together):
  kept for now; delete only on the user's word.

## Preserve

- Nothing merges, deploys or promotes until the user says so in the
  conversation. Every host root step is one reviewed paste the user runs,
  with the expected output stated; long steps run detached with an end
  marker.
- No MCP tool, catalog entry or policy allowlist starts, approves, stops,
  reconciles, takes over, resumes or watches a run, or changes a toggle.
- The A3–A7 boundaries do not widen without a decision: the socket methods,
  the root-peer rule, the fence and its one live line, the unit properties,
  the origin proxy's one bounded `POST /api/login`, the broker's value path,
  typed claims only, receipts with binding ID, revision and outcome only, the
  TURN relay's single allowed peer, video and frames never stored, typed text
  never recorded.
- Migrations 1100–1112 are immutable; a new one takes the next free number.
- `MOBILE_FIRST.md` for every UI change; no dead control.
- Untouchable: `pp-nodus` and `nodus.fractionate.ai`; no `--upgrade-incus`,
  no Incus archive, no bypassing managed-LXC refusals; keep
  `scripts/tests/a3-vm-probe.zip`, the pre-network snapshot
  (`pp-mcp-pre-network-20260927-222658`) and the four `pp-a7-pre-live-*`
  snapshots (until the user says otherwise).
- Never put a secret or a scan marker on a command line; never trip the
  demo's shared sign-in limit.

## Out of scope

- More origins or workflows beyond the one pilot, document delivery (unless
  the user adds it with its A3–A7 dependencies), every F item.
- A second supervisor host, high availability, or scaling beyond one attempt
  at a time.

## Lessons carried forward

- A test that points a program at a configuration path the program never
  reads proves nothing about that configuration: A7's live policy was never
  in force locally, and on the host it refused the runner's own DevTools pipe
  (`DeveloperToolsAvailability`). Test the real path, as
  `test_a7_live_policy.py` does.
- Copying files into a guest can drop names it does not like (Debian epochs,
  `%3a`): read what arrived back by digest before using it.
- A proof that encodes an old boundary fails when the boundary is decided to
  widen: A7's A3 `backend_refusals` still expected `takeover` refused.
  Re-read every earlier host proof against the new method set before a host
  run.
- "Not sent" and "sent, answer lost" are different outcomes. Report the
  first as a certain failure (`WORKER_EXITED`) and the second as uncertain,
  or people decide things that never happened.
- In a harness, attach a handler to an in-flight promise before anything
  else can await: a rejection with no handler yet kills Node.
- WebRTC peers can trickle candidates before their offer; buffer them.
- Test the harness and the UI end to end against the real classes; local
  fixtures must behave like the real application after each state change.
- Host steps: one paste per step, `set -e`, `cmd || echo marker` plus the
  journal on failure, the expected output stated, and a read-only summary
  command that prints every verdict. Say plainly which steps are required.

## Proofs

- Local: the backend suite (sandbox failures named and compared with
  `main`), the A3–A7 script suites (with real Neko and coturn, and the
  managed policy at its real path: `A7_TEST_POLICY=1`), the host-boundary
  inventory without suppression, the frontend build, the A6 and A7 journeys.
- CI: the repository's checks on the PR's exact head (backend, frontend,
  agent, audits).
- Target:
  - the backup, and a restore check of it;
  - the deploy and its rollback tag (migrations up to 1112 are live since
    the A7 deploy; verify them, and any new one A8 adds);
  - the backend reaching the supervisor under the chosen design, with its
    refusal cases (a non-root peer, a wrong socket, a missing key);
  - the A3/A4/A5/A7 host regressions after the change;
  - the pilot run from the live dashboard: live view over the internet
    through the TURN relay, takeover with the session's verification,
    approval with sudo and the digest, stop, a reconciliation that shows
    the supervisor's record beside the buttons, a resume, the receipt, the
    audit and the cost;
  - the rollback rehearsal.

## Record and stop

- Write `fractionate-agents-a8-evidence.md` (dated sections) and
  `fractionate-agents-a8-reference.md`, including the operator runbook and
  the explicit limitations.
- Update the A8 row of `fractionate-agents-a1-a8.md`, the acceptance matrix,
  `CLAUDE.md`, `docs/core/security-host-boundary.md` (the mount and any
  route or method change) and `.env.example` (the supervisor settings the
  deploy uses).
- Then stop for the user's acceptance decision.
