# Official bounded plan: first usable supervised agent

> **Status (2026-09-28):** A2 merged as PR #677; migration 1106 is additive and
> its metadata gate defaults off. A3 is **accepted** (PR #698; see the last
> section of the [A3 evidence](fractionate-agents-a3-evidence.md)), with the host
> reboot proof, the backend socket mount and coordinator (A5) and
> S6/SEC-01/SEC-04 open by name. A4 was **accepted on 2026-09-28** (last
> section of the [A4 evidence](fractionate-agents-a4-evidence.md)): the host
> credential/provider broker, the bound sign-in path through the A3 supervisor,
> the one bounded `POST /api/login` in the origin proxy, the `gpt-6-luna` route
> with reservation and settlement, the proof harness and the canary scan pass
> every local suite; on the host the proxy proof (21), the full A3 proof
> (19/19), all six A4 cases (bound sign-in, rotation, revocation, egress,
> budget with one real `gpt-6-luna` call, proxy policy) and the canary scan
> (13 sinks, 0 matches) passed on the host; see the
> [A4 evidence](fractionate-agents-a4-evidence.md) and the orientation page
> [A4 reference](fractionate-agents-a4-reference.md). A5 was **accepted on
> 2026-09-29** on the proof host (branch `claude/beautiful-maxwell-9bldxg`, code
> `9b9a15ed`, coordinator in a host proof harness, decision 1 option A;
> [A5 reference](fractionate-agents-a5-reference.md),
> [A5 evidence](fractionate-agents-a5-evidence.md)). A6 is **implemented and
> proven locally, not accepted** (branch `ccr-4216e4d3-jsij65`; the host run for
> its one widening, a read-only backend-socket `view`, is pending;
> [A6 reference](fractionate-agents-a6-reference.md),
> [A6 evidence](fractionate-agents-a6-evidence.md)). A7 waits for A6's
> acceptance ([A7 prompt](fractionate-agents-a7-prompt.md)).

Approved sequence by user direction, 2026-09-25. This plan supersedes the earlier
suggested next step of D5 and the unbounded future-agent sequence. It establishes
scope and order; individual implementation sections are selected separately.

## Outcome and boundary

After A8, a person can assign one supported real workflow to one agent, using an
exact approved Operations guide, observe its progress, approve sensitive actions,
stop it, take over when necessary, and inspect a durable result. The actual pilot
workflow, application and success criteria must be selected in A1. Do not imply
that an arbitrary application or task is supported.

Operations B1–B4 and Demonstrations D1–D4 are implemented locally. They supply
human records, access, guides, review, evidence and manual history; they do not
yet supply agent execution. The initial agent may use scoped approved guides
directly. A shared Knowledge library and D5 are not prerequisites.

Eight bounded sections are the official delivery list. Budget roughly 8–12
focused conversations, allowing 2–4 for integration findings. These are planning
estimates, not completion guarantees; a section may need more than one session.
Do not create extra product scope under the integration allowance. Report any
new blocking dependency and place it under the affected section for review.

## Delivery sections

| Section | Bounded work | Completion evidence | Status |
|---|---|---|---|
| A1 — Scope and architecture | Select one useful workflow/application; define success, permitted actions, human approvals, trust boundaries, identity/state model, reuse and dependencies. Refine A2–A8 contracts without implementing runtime. | Source-grounded architecture, acceptance matrix, security dependency map, selected synthetic pilot, and executable A2 prompt. | **Design complete:** live demo verified; site/project/guide/human bindings and live authority remain later gates |
| A2 — Project access and agent profiles | Optional owner-managed project site origin, hidden/read-only/collaborative discovery with explicit member roles; stable project/profile/run/worker/binding identities; profile CRUD and optional scoped guide assignment; current-user authority, no privilege inheritance from names or broad management roles. | Hidden-project non-disclosure, site validation/change, native authorization, cross-project, stale grant/account and audit tests; accessible access/profile UI; no compute from profile creation. | **Merged** (PR #677); metadata gate off |
| A3 — Isolated execution environment | One selected worker/browser environment; typed launch/stop contracts, private run workspace, egress/tool limits, hard resource budgets and cleanup. Resolve relevant host-boundary blockers. | Escape/unauthorized-operation refusals, cancellation/cleanup and target isolation checks; no host-root execution available to the model. | **Accepted 2026-09-28** (PR #698); host reboot proof, backend socket mount/coordinator (A5) and S6/SEC-01/SEC-04 open by name |
| A4 — Credentials and provider connection | One initial provider; contributor-specific project credential intake into OpenBao, separately granted Infisical/Vaultwarden destination feasibility, scoped agent binding, brokered access, rotation/revocation and bounded provider spending. Retain administrator re-authentication/MFA boundaries. | Positive/negative credential access, destination consistency and real cancellation/revocation tests in the authorized environment; no secrets in model context, logs or browser output where non-disclosure is claimed. | **Accepted (2026-09-28):** one OpenBao-backed binding delivered by a host broker into the A3 runner's one-shot FIFO (never the model, runner channel, logs, receipts or DB); bounded JSON `POST /api/login` in the proxy; rotation, revocation, logout and cookie-jar disposal; one `gpt-6-luna` route with pinned budgets, worst-case reservation and fail-closed settlement; migration 1110. Security CI passed; on the host the proxy proof, the A3 regression, all six A4 cases and the canary scan passed ([A4 evidence](fractionate-agents-a4-evidence.md)). Infisical/Vaultwarden destinations deferred |
| A5 — Core execution loop | Explicit run start, pin approved guide version, bounded tool/action loop, durable state/progress/results, approval checkpoints and refusal outside permitted actions. | One synthetic workflow completes; tool errors, stale authority, prompt injection/untrusted page content, budgets and stop requests fail safely; no implicit authority from guide/evidence content. | **Accepted (2026-09-29):** backend coordinator (proof harness, option A; no route), hybrid loop (guide hard rules decide; `gpt-6-luna` only inside the rule-filtered set via the one new supervisor method `model_step`), human approval digest, durable pins/steps/model calls/approvals/results (migration 1111), stop/takeover/restart recovery, runner outcome classes, demo fixtures. Host: A3 19/19, A4 6/6, A5 17/17 with one real human approval, canary 0 ([A5 evidence](fractionate-agents-a5-evidence.md)). Out-of-set model reply, unknown usage and the timeout class proven locally; container mount/routes are A8 |
| A6 — Supervision UI | Minimal Agents/Flightdeck views for the selected workflow: start/stop, view-only observation, progress, help/approval requests and result inspection. | Real role-based browser journeys, keyboard/accessibility, 375px form completion and existing six-width/two-theme checks; no dead controls or redesign of Dev Studio. | **Implemented, proven locally, not accepted (2026-09-29):** Operations "Agent runs" section, run detail (typed activity feed + live browser frames, Flightdeck-style), approval dialog (sudo + ≥12 digest characters), agent inbox, consent and read-only rules; behind the administrators' Agent runs dashboard toggle (off until turned on with sudo, audited; not env since 2026-09-29), `EXECUTION_UNAVAILABLE` without a supervisor (option A). One boundary widening by user decision: a read-only backend-socket `view` (pixels only). Local: backend 114/114 Operations, Python 151, 14 browser journeys, 72 layout checks. Merged (#700, #701) and deployed 2026-09-29 (live `85586aea`; toggles off until turned on; execution unavailable until A8). Host run (A3 20 with `backend_view`, A4, A5, canary) pending; what is left, with as-built screens and the run-deck mockups: [A6 finish prompt](fractionate-agents-a6-finish-prompt.md) ([A6 reference](fractionate-agents-a6-reference.md), [A6 evidence](fractionate-agents-a6-evidence.md)) |
| A7 — Practice and recovery | Isolated rehearsal, interruptions, crash/retry policy, side-effect reconciliation, basic critique of success/failure and explicit human takeover/resume. | No blind replay of uncertain side effects; safe restart, account/grant loss, takeover ownership and bounded recovery verified end to end. | Pending A6 |
| A8 — Deployment and supervised pilot | Resolve applicable release blockers; exact-change CI/review; backup/restore/migration checks; authorized deployment/configuration and one real supervised workflow. | Target isolation/authentication/storage checks, pilot acceptance and audit, demonstrated stop/recovery/rollback, operator runbook and explicit limitations. | Pending A7 and deployment authorization |

## Controls and dependency mapping

The following existing findings remain open; moving feature scope does not waive
them. Preserve original IDs and evidence. Close only with fresh relevant proof.

| Existing item | Placement in this plan |
|---|---|
| SEC-01 host isolation / privileged backend boundary | A1 dependency design; A3 execution boundary; A8 target verification. |
| SEC-02 required security CI / host inventory | Every merge and A8; no suppression or bypass. PR #674 records reviewed source contracts for agent-network and evidence-decoder in the static inventory; S6 and deployment acceptance remain open. |
| SEC-03 real-host, migration/rollback and disk growth | A3 resource/storage design; A8 deployment acceptance. |
| SEC-04 privileged LXC-to-VM cutover | A1 determines whether the chosen pilot requires it. If required, A3/A8 prerequisite; broader estate migration is follow-on F7. |
| SEC-05 draft PR compatibility, restricted readers and key rotation | A1 inspects dependencies, A2/A4 address relevant identity/authority, A8 requires compatible integration. Do not merge an unrelated historical PR implicitly. |
| INF-01 admin auth, unattended authority and recovery | A4 and A8; no MFA weakening. |
| INF-02 project/profile/run/worker identity mapping | A1/A2; enforce at A3–A5 boundaries. |
| INF-03 key isolation and provider/proxy enforcement | A4; prove on target before real-key execution in A8. |
| INF-04 stable identity, rotation and session cancellation | A2/A4/A7; prove actual revocation rather than promise immediate recall. |

Media sandbox/ACL/retention/backup/erasure gates apply before evidence activation.
Production retention scheduling and verified retirement migration/cleanup are
A8 prerequisites if that deployment needs them, otherwise explicit follow-on F7
work. Do not activate an unsafe dependency to shorten the first-agent plan.

## Working and release rules

- Preserve existing source, immutable migrations, guides/manifests and receipts.
  Record a baseline, exact incremental diff, tests and limitations per section.
- All eight sections retain least authority, transactional audit, no administrator
  bypass for private Operations content, and explicit human approval boundaries.
- Use synthetic data/disposable environments until a real environment and action
  scope are explicitly selected. The plan alone authorizes no live credentials,
  provider spending, deployment or feature activation.
- Keep required CI/security checks intact. Source integration does not certify
  deployment readiness. The user separately authorized committing/merging this
  A1 review work; that does not authorize A2 implementation or agent activation.
- Older writers require `OPERATIONS_ENABLED=false`; retain additive history and
  evidence storage. Lean BEAF migration 706 needs verified backup before rollout.
- End each section with concrete acceptance results, tracker update and next
  bounded prompt. Mark blocked acceptance honestly; never relabel a prototype as
  a usable production agent.

All remaining product work is assigned to the separate
[follow-on plan](fractionate-follow-on-plan.md), to be completed after A8.
Current A1 artifacts: [architecture and pilot decision](fractionate-agents-a1-architecture.md),
[source/dependency register](fractionate-agents-a1-sources.md),
[acceptance matrix](fractionate-agents-a1-acceptance.md),
[repository evidence](fractionate-agents-a1-evidence.md),
[pilot contract](fractionate-agents-a1-pilot-contract.md),
[project access and credential backlog](fractionate-project-credentials-backlog.md) and
[A2 prompt](fractionate-agents-a2-prompt.md). The first workflow is sign-in at
`demo.fractionate.ai` as a synthetic target; the user will create the first
Operations project and enter its site through the A2 interface when ready.
No site or project ID is required to close A1 design. The standalone demo website is
live with a public demo account and protected sample CSV. The deployed source/build matched files
uncommitted at deployment time, so no commit is claimed for the archive. The exact Operations project,
site, approved guide, human authority and enforced limits remain run/release
gates. The website deployment
does not satisfy A8 agent deployment. Optional PDF/CSV delivery to an
Operations project is a separate explicit action grant; it is not implemented.
A1 design is complete; A2 has not started. Original
[A1 executable prompt](fractionate-agents-a1-prompt.md).
