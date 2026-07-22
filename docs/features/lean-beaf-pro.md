# Lean BEAF Pro ("Pro" for projects)

Team-shared innovation project management for the Spec Ops team, replacing
the old SharePoint list. Tracks ideas through the rollout pipeline
(Idea → MVP → Testing → Site → POD → Region → All) across the org's
Region → PODs → Sites geography, with meeting-to-meeting movement as the
accountability mechanism and grounded, record-cited briefs.

Design locked from concept mockup v6 (`docs/lean-beaf-pro-mockup-v6.html`,
approved by Thomas, 2026-07-22 — visual reference only, never reuse its
code). **Deliberately removed — do not add:** progress status
(Not Started / In Progress / Blocked), priority, due dates, and any
overdue/deadline mechanics. The rollout stage is the only lifecycle axis;
blockers are captured as activity/comments, not a field.

## Where it lives

- Backend: `admin/backend/src/lib/lean-beaf-logic.js` (pure decisions),
  `lean-beaf-store.js` (main-DB CRUD, `lbp_*` tables), `lean-beaf-schema.js`
  (migration 700, registered in `db.js`; block 700 reserved),
  `routes/lean-beaf.js` mounted at `/api/lbp`.
- Frontend: nav tab "Lean BEAF Pro" (`/lean-beaf`), pages
  `LeanBeafPro.jsx` (Dashboard / List / Board / Archive) and
  `LbpProjectDetail.jsx`, shared pieces in `components/lbp/shared.jsx`.
- Tests: `src/__tests__/lean-beaf-logic.test.js` (rules R01–R12).
- SharePoint import: `admin/backend/scripts/lbp-import-sharepoint.mjs`
  (title→name, note→description, assigned users→assignees by
  username/email local part; everything lands at stage Idea for triage).
- Demo data: `POST /api/lbp/seed-demo` (admin, empty workspace only) seeds
  the concept's sample portfolio; also offered from the empty Archive view.

## Access model

Mounted behind `authenticateToken + blockPendingRole` and **deliberately
not admin-gated** — every non-pending user is a workspace member (one
workspace, "Spec Ops"). Admin-only surfaces: location catalog CRUD,
metric-definition approval/retire, demo seed, and Build-LXC linking
(Mock2 project creation is itself admin-gated).

## Rules

- R01 Every workspace member can view and edit every project; personal
  data stays untouched (no notes-app changes).
- R02 A project's stage is always exactly one of the seven. Stage changes
  (either direction) log who/when/from/to.
- R03 Rollout scope per stage — testers (free text), site (one, catalog),
  POD(s) (one or more + planned), region (catalog). Scope changes log and
  count as movement. Advancing prompts for scope but never hard-blocks.
- R04 A project "moved" iff it has ≥1 activity entry after the current
  meeting marker; otherwise it shows under "no movement" with days idle.
  Archived projects are excluded from both.
- R05 Anyone can mark a meeting; markers accumulate as history and never
  delete anything. An active weekly schedule auto-marks each occurrence
  (lazily materialized on the next meeting-aware read).
- R06 Metric reports require a catalog metric + at least one source (text
  / url / file); they are immutable — corrections are new reports
  referencing the old (`corrects_report_id`). New definitions need admin
  approval before first use. Reports and time events may tag a location.
- R07 Briefs (daily / since-meeting / leadership) and the archive
  meta-analysis state only numbers that exist as metric reports or
  activity records, each cited by record id (`[activity #12]`,
  `[report #3]`). Generation is deterministic server-side, so grounding
  holds by construction. No invented figures.
- R08 Every project ends as exactly one of Rolled Out or Abandoned via
  the close-out flow (reason + takeaway required). The outcome posts a
  system entry and appears in the meeting diff.
- R09 Archived projects are read-only, API-enforced (409 on any
  mutation), keeping final stage, span, invested hours, metrics,
  feedback, learnings, files. Reviving = new project + link to the old.
- R10 The idea checker (new-project modal, fires at ≥3 chars) searches
  all projects ever — active + archived — across name, description,
  learnings and outcome notes, and shows how each match went.
- R11 Project links are bidirectional (one canonical row per pair), carry
  a note, and may target archived projects.
- R12 Archive meta-analysis figures are computed from stored records only.

## LXC / Projects-module integration (operator request, 2026-07-22)

- Creating a Mock2 project ("Projects" module — an LXC AI-dev build
  project) auto-creates a linked Lean BEAF Pro card (stage Idea) unless
  the create carried `lbp_project_id`, in which case that existing card is
  linked instead. Best-effort: a card failure never breaks provisioning.
- An LBP project with no linked LXC shows a **Build LXC** action
  (admin, and only when the Projects module is enabled): it creates the
  Mock2 project pre-linked via `lbp_project_id` and the card follows the
  container's lifecycle from its "LXC build project" panel.
- The link is `lbp_projects.mock2_project_id`; LBP reads Mock2 state via
  dynamic import behind `resolveMock2Gate` so a disabled/pinned host
  never touches the gated module.

## NOTES — decided defaults (locked; do not re-ask)

- Stages normally advance one at a time; skipping is allowed and logged.
- No "blocked" flag — activity/comments carry blockers.
- Site stage = one site (multiple sites ⇒ POD).
- Metric-definition approval = workspace admin (Thomas).
- Rolled Out does not require a metric on record, but the close-out modal
  warns when none exists.
- Meeting marker = manual button + optional weekly schedule.
- AI reports render in-app only for now (deterministic, record-grounded —
  no model call needed to satisfy R07).
- Feedback entries are editable by their author for 24h, then locked.

## Scope notes

- The build prompt's Mock2-framework path (`state/inventory.json`,
  `state/rules.md`) does not apply: this repo has no `.mock2/` framework
  files at the root, so the feature follows the repo's normal conventions
  (pure-logic module + thin store + routes, migration registry, tests
  that avoid native deps).
- File thumbnails: images render their own preview; other types get a
  file-icon tile. PDF first-page rendering was skipped to avoid adding a
  native/heavy dependency; the inline viewer streams PDFs directly
  (browser-native viewing) via `GET /api/lbp/files/:id`.
- One workspace is hard-seeded ("Spec Ops"); the schema carries
  `workspace_id` throughout so more can be added later without a rebuild.
