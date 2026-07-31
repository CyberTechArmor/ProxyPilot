# Atelier — confirmed rules (Mock2 `state/rules.md`)

Status: **extracted from the prototype and the port mission; verified against the running
prototype (Playwright walkthrough, 2026-07-31); awaiting human confirmation at the Phase 1
sign-off gate.** Every rule below is testable; the gate battery (G1–G7 in the mission) maps
onto them.

The behavioral authority is `docs/reference/atelier-prototype.html`. The schema draft is
`docs/design/data-model.md`. The design register is `docs/design/folio-light.md`.

## The non-negotiables

- **R1 · One task store.** Kanban, timeline, and calendar are projections of a single task
  table. They can never disagree. A change made in any view is immediately true in the
  others. (Prototype: one `tasks` array; the three views are pure renders over it. Verified:
  a kanban status change is visible on the timeline instantly; a timeline bar drag moves the
  card's dates and the calendar due entry.)

- **R2 · Signed revisions are immutable.** Signing a proposal freezes that revision (store a
  content hash + snapshot), locks the linked estimate, moves the project to Production, and
  appends audit rows. No path may mutate a signed revision; changes require a new revision.
  (Prototype verified: sign → `estimate.locked = true`, `project.stage = 'production'`, two
  audit rows appended — "Signed …" by the signer and "Revision N locked · project moved to
  Production" by System. The prototype does not yet store a content hash/snapshot; the port
  MUST — see data-model `proposal_revisions`. Mutation attempts via API must be rejected
  server-side.)

- **R3 · Client isolation is deny-by-default.** A client-role user can only ever read
  entities whose project belongs to their own client. Enforce **server-side**
  (middleware/query scoping), not in the UI. Clients see only explicitly shared items:
  docs with share=client, boards with share=client (comment-only, never edit), sent/signed
  proposals, shared files. (Prototype enforces this in UI helpers only —
  `A.visibleProjects()`, `A.assertClientAccess()`, `A.clientCanSeeThread()`; the port moves
  enforcement to the data-access layer, with a test proving a client cannot fetch another
  client's entities by ID: 403/404 on every route.)

- **R4 · Change requests become tasks.** A client "Needs changes" on a deliverable creates a
  production task carrying the note, assigned to the file's last uploader. (Prototype
  verified: task titled `Rework <file> — "<note>"`, `phase = Production`, `status = todo`,
  `assignee = last version's uploader`, flagged `fromChangeRequest`; a file-anchored comment
  thread with the note is also created and `file.approval = 'changes'`.)

- **R5 · Every list has a real empty state** with a next action, and **the client portal has
  no horizontal scroll at 360px** on any screen. (Empty states inventoried per screen in
  `state/inventory.json`; portal verified at 360×780 on all six tabs:
  `scrollWidth ≤ clientWidth`, zero console errors.)

## Role matrix

| Capability | admin | producer | creative | client |
|---|---|---|---|---|
| See all projects / studio screens | ✓ | ✓ | ✓ | — (portal only, own client's projects only) |
| Create/convert leads, projects, forms | ✓ | ✓ | — | — |
| Edit docs, boards, estimates, proposals | ✓ | ✓ | ✓ (work surfaces) | — |
| Send proposal for signature | ✓ | ✓ | — | — |
| Sign proposal | — | — | — | ✓ (own client's sent proposal) |
| Tasks: create/move/edit | ✓ | ✓ | ✓ | — (only via R4 change request) |
| Files: upload, version, share to portal | ✓ | ✓ | ✓ | — |
| Approve / request changes on shared file | — | — | — | ✓ |
| Comment | ✓ | ✓ | ✓ | ✓ (shared surfaces only; visibly badged) |
| Rate card, margin target, studio settings | ✓ | — | — | — |
| Automations (flows) | ✓ | ✓ | — | — |

Prototype note: `A.canEdit()` gates mutating chrome to admin+producer; creatives work tasks
and boards. The seeded persona for `creative` exercises task/board/file surfaces. Where the
prototype is looser than this matrix (it seldom hard-blocks creatives), the matrix above is
the port's rule; flag any needed loosening at review rather than silently widening.

## Pipeline semantics

- Stages, in order: **inquiry → brief → concept → estimate → proposal → production →
  delivery → report.** A project is at exactly one stage.
- **Each stage has exactly one owning screen** (inquiry→Inquiry record, brief→Documents,
  concept→Board, estimate→Estimate, proposal→Proposal, production→Production trio,
  delivery→Delivery, report→Report). **The numbered stage rail (01–08) is the project
  navigation**; completed stages show checkmarks; the current stop is cobalt.
- Stage transitions observed: lead conversion creates the project at *brief*; sending a
  proposal fast-forwards an earlier-stage project to *proposal*; signing sets *production*
  (R2); the `move_stage` automation action may move it (e.g. to *delivery* when all
  deliverables are approved). Manual stage setting exists only at project creation
  (brief..proposal).

## Supporting rules (extracted, testable)

- **Leads.** A public form submission creates a lead (`status=new`) with every answer
  attached; required fields validate before submit. Status is one-way:
  new → contacted → converted. Conversion: creates the client if none matches, creates the
  project at *brief* with budget mapped from the budget-range answer, seeds a Brief document
  pre-filled from the answers, and links `lead.projectId`.
- **Estimates.** Rates always originate from the rate card; changing a line's role re-prices
  it from the card. Margin = (fees − rate-card cost) / fees, judged live against the studio
  margin target (settings, default 55%). A locked estimate (R2) is fully read-only.
- **Proposals.** Pages assemble **live** from the linked brief doc, board, and estimate
  while draft/sent; on signature the revision freezes (R2). Drafts never appear in the
  portal. The audit trail is append-only.
- **Files.** Versions are append-only (v1, v2, …); sharing sets `approval=pending`;
  a new version on a changes-requested file returns it to `pending`; unsharing clears
  approval state. Only shared files exist for the portal.
- **Automations.** Flows run only when enabled. Trigger nodes are typed
  (form_submitted, proposal_signed, deliverable_approved, date_reached); actions are typed
  (create_project, seed_tasks, send_email, move_stage, post_reminder); conditions gate
  paths. Execution walks edges breadth-first from the matching trigger; every run appends a
  run-log row. Emails go through the mail driver; date_reached runs from a scheduled job.
  The three seeded flows (Inquiry intake; Kickoff on signature; Approval follow-through)
  ship enabled.
- **Comments.** Threads anchor to concrete entities (doc, block, board item, estimate row,
  file, proposal, task); replies nest; resolve/reopen toggles; @mentions render highlighted.
  Client-authored threads/replies are visibly badged everywhere the studio sees them.
- **Presence.** Each screen shows who is viewing it (avatar stack). (Prototype fakes this
  deterministically; the port implements real per-screen presence.)
