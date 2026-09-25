# Official bounded plan: first usable supervised agent

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
| A1 — Scope and architecture | Select one useful workflow/application; define success, permitted actions, human approvals, trust boundaries, identity/state model, reuse and dependencies. Refine A2–A8 contracts without implementing runtime. | Source-grounded architecture, acceptance matrix, security dependency map, pilot choice or clearly blocked choice, and executable A2 prompt. | Next; not started |
| A2 — Agent profiles and permissions | Stable project/profile/run/worker/binding identities; profile CRUD and scoped guide assignment; current-user authority, no privilege inheritance from names or broad management roles. | Native authorization, cross-project, stale grant/account and audit tests; accessible profile UI; no compute from profile creation. | Pending A1 |
| A3 — Isolated execution environment | One selected worker/browser environment; typed launch/stop contracts, private run workspace, egress/tool limits, hard resource budgets and cleanup. Resolve relevant host-boundary blockers. | Escape/unauthorized-operation refusals, cancellation/cleanup and target isolation checks; no host-root execution available to the model. | Pending A2 |
| A4 — Credentials and provider connection | One initial provider; scoped application credentials, brokered access, rotation/revocation and bounded provider spending. Retain administrator re-authentication/MFA boundaries. | Positive/negative credential access and real cancellation/revocation tests in the authorized environment; no secrets in model context, logs or browser output where non-disclosure is claimed. | Pending A3 |
| A5 — Core execution loop | Explicit run start, pin approved guide version, bounded tool/action loop, durable state/progress/results, approval checkpoints and refusal outside permitted actions. | One synthetic workflow completes; tool errors, stale authority, prompt injection/untrusted page content, budgets and stop requests fail safely; no implicit authority from guide/evidence content. | Pending A4 |
| A6 — Supervision UI | Minimal Agents/Flightdeck views for the selected workflow: start/stop, view-only observation, progress, help/approval requests and result inspection. | Real role-based browser journeys, keyboard/accessibility, 375px form completion and existing six-width/two-theme checks; no dead controls or redesign of Dev Studio. | Pending A5 |
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
  deployment readiness. The user's current commit/merge request applies to the
  completed foundation and these plans, not A1–A8 execution or activation.
- Older writers require `OPERATIONS_ENABLED=false`; retain additive history and
  evidence storage. Lean BEAF migration 706 needs verified backup before rollout.
- End each section with concrete acceptance results, tracker update and next
  bounded prompt. Mark blocked acceptance honestly; never relabel a prototype as
  a usable production agent.

All remaining product work is assigned to the separate
[follow-on plan](fractionate-follow-on-plan.md), to be completed after A8.
Next: [A1 executable prompt](fractionate-agents-a1-prompt.md).
