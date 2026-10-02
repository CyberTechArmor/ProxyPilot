# Fractionate UI/UX alignment tracker

Owner: Thomas · implementation on Duo · started 2026-10-02.
Branch: `ui/mockup-alignment-20261002`. Publication/merge remains pending explicit instruction.

## Verified baseline and backlog

- GitHub main verified by remote Git read on 2026-10-02: `0f1b48f33fe31723100b8c758c717899bb7b3f1d`; fetched into the isolated local repository.
- Original backlog commit `ac62d45dba876b248b687679268a8d165ed221fd` is preserved unchanged as an ancestor of this branch. Original clean worktree remains at `C:/Users/thoma/Documents/Codex/2026-10-01/task-3/proxypilot-backlog-docs`.
- [CB01–08 backlog](fractionate-project-credentials-backlog.md) and [F8/F9 follow-on backlog](fractionate-follow-on-plan.md) own broker/custody confirmation, activation, isolation, real adapters/pilot, browser/OAuth, credential migration, text/image/document ingestion with originals and AI drafts plus human approval, and relational/S3/optional vector/event-ledger architecture. These items remain unaccepted planning; no stack or trust decision is made here.
- Updater PR718 and preservation PR719 are already in main and are excluded.

## Milestones and acceptance

| ID | Deliverable | Current state | Independently verifiable acceptance/evidence | Implementation commit |
| --- | --- | --- | --- | --- |
| UX01 | Reference inventory, route/state/viewport mapping and contract gaps | In progress | Inspect actual reference pixels; map every requested route/state; list unavailable assets without fidelity claims | Pending |
| UX02 | Shared type, icons, spacing, controls, border/radius tokens | Pending | Same geometry in Midnight/Latte/Office; 44px mobile actions; no Nodus brand; screenshot measurements | Pending |
| UX03 | Operations shell, persistent project list and overview cards; short creation | Pending | Desktop list/detail proportions; mobile disclosure; guide/readiness/agents/activity/access cards; settings separated; safe people picker or exact API gap | Pending |
| UX04 | Work/Connections/Controls/Review agent setup | Pending | Bounded cards, narrow assignment summary; cancel/back/reopen/repeated save; draft never starts a run | Pending |
| UX05 | Connection picker, centered Add dialog, catalogue/readiness actions | Pending | Accurate supported types/availability; optional assignment; permission/revoked/unavailable states; remove assignment distinct from global revoke | Pending |
| UX06 | Run hierarchy and browser/activity balance | Pending | Historical states, approvals, takeover and reconcile preserved; desktop/mobile screenshots | Pending |
| UX07 | Final aggregate checks, browser journeys and visual review | Pending | Required checks/build; 360/375/390/768/1280/1536/1920 viewports, overflow guard disabled; keyboard/focus; local screenshots compared to references; accessibility gate | Pending |

No completion percentage is assigned. A milestone is accepted only when its evidence is linked and limitations are stated.

## Reference inventory and route mapping

Initial confirmed local references:
- `C:/Users/thoma/Fractionate/OpenAI/outputs/agent-platform-setup/agent-connections.png`: inspected; Operations project list/detail, Agents setup Connections state, narrow assignment summary.
- `C:/Users/thoma/Fractionate/OpenAI/outputs/agent-platform-setup/add-connection.png`: inspected; centered credential dialog over the same setup route.
- `design-and-prompts.json`: source title “Fractionate Agent Vison Plan and Review”, thread `01a0d3b8-06f8-7fb2-9c6f-02ad48e753a9`; no chat URL supplied.
- Library approved references: Projects-add-connection, Projects-setup, agent-flightdeck, agent;s-mockup, Projects-mockup, palette. Current comparison images: Connections, Add dialog, Operations, Overview, Latte ended run. Materialization attempted on Duo; current helper fails on Windows because `os.setxattr` is unavailable. These images have not yet been accepted as locally readable references. Do not infer setup appearance from global Connections.

Route/state mapping will be completed against actual application routes during UX01. Reference viewport is 1536×1024; phone adaptations must follow MOBILE_FIRST.md rather than copy desktop widths.

## Contracts and exclusions

Keep explicit approvals, CSRF/sudo flow, permissions, secret non-disclosure, draft/readiness/run separation and no side effects on save unchanged. Existing infrastructure routes remain accessible. UI changes do not establish runtime capabilities shown only in concepts.

Excluded: production shell/SSH/MCP mutation, deployment, credential enrollment, broker activation, trust acceptance, stack selection, updater/preservation work, push/merge/un-draft and rewriting pushed history. Local disposable browser fixtures may simulate responses; evidence must identify fixtures rather than imply production proof.

## Evidence log

- Baseline and original backlog ancestry verified; no remote mutation.
- Local mockup pixels inspected using image viewer.
- AGENTS.md and .agents/skills are absent from current repository; CLAUDE.md, LEARNINGS.md, MOBILE_FIRST.md and available relevant repository skills are being inspected.
- Build/browser evidence and final commit ledger: pending implementation.

## Blockers and decisions

- Library helper Windows metadata incompatibility blocks additional references; independent work can proceed from the two readable local mockups.
- Safe existing-user selection API and additional browser check requirements: under inspection.

