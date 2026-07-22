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
  (migrations 700–704, registered in `db.js`; block 700 reserved),
  `lean-beaf-ai.js` (AI brief writer — settings, model call, run recording),
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
- Blocked flag (operator addition, 2026-07, supersedes the original "no
  blocked flag" default): a project can be flagged Blocked with a reason and
  a date (defaults today, editable). "Break barrier" clears the flag and
  records the resolved date. Each block→break cycle is one immutable
  `lbp_blockers` row (migration 701) — the table is the blocker audit trail,
  also surfaced as `blocked`/`unblocked` activity entries. The flag renders
  on list and kanban cards and in the detail header. Endpoints:
  `POST /projects/:id/block`, `POST /projects/:id/unblock`,
  `GET /projects/:id/blockers`. Comments still carry free-form context.
- Site stage = one site (multiple sites ⇒ POD).
- Metric-definition approval = workspace admin (Thomas).
- Rolled Out does not require a metric on record, but the close-out modal
  warns when none exists.
- Meeting marker = manual "Mark meeting now" button + any number of
  recurring schedules (migration 703, lbp_schedules), each daily or weekly.
  Each occurrence lazily auto-marks a meeting; ad-hoc or different-time
  meetings are the manual button. Endpoints: GET/POST /schedules,
  PATCH/DELETE /schedules/:id. The legacy single weekly schedule migrates in.
- Briefs page (/lean-beaf/briefs, GET /lbp/briefs): a feed of "Today" plus
  one brief per meeting-to-meeting period (the notes between meetings), each
  moved project citing its activity record ids (R07). Reached from the
  subtle "Briefs" button on the dashboard's Brief card. The dashboard's
  moved / no-movement lists were removed — the tiles drill into those — and
  the Brief section was enlarged to fill the space. The meeting rhythm
  (last-meeting line + "Mark meeting" + "Schedule") is rolled into the Brief
  card header — a brief *is* the meeting-to-meeting summary, so marking a
  meeting there resets the window it covers. The Brief card also renders the
  rollout pipeline as a left-to-right process-map (grounded stage counts,
  each node jumping to its Kanban column).
- AI brief writer (operator addition, 2026-07): the deterministic grounded
  brief can be restyled by a real model — the cheap, fast Claude
  (`claude-haiku-4-5` by default) — via an explicit "Generate with AI" button
  (never auto-run, so no surprise spend). Grounding still holds by
  construction: the model is handed ONLY the grounded facts and told to
  restyle them, preserving every `[activity #N]` / `[report #N]` citation and
  inventing no numbers; server-side we then reject any rewrite that introduces
  a citation absent from the source (`citationsGroundedIn`) and fall back to
  the deterministic text. So R07 holds even with a model in the loop, and the
  brief is never empty (falls back when unconfigured / erroring / ungrounded).
  - Model + API key are admin-configurable (gear on the Brief card →
    `PUT /lbp/brief-settings`, admin-only; `GET` is open and non-secret). The
    key is stored encrypted at rest (secrets.js) in `app_settings`
    (`lbp_brief_model`, `lbp_brief_api_key_enc`), falling back to
    `ANTHROPIC_API_KEY` from the environment.
  - Cost is shown in the Brief section after each run (per-run USD + token
    counts, priced from `LBP_MODEL_PRICING`).
  - Every generation is audited in `lbp_brief_runs` (migration 704: who ran
    it, mode, model, token usage, cost snapshot, ok/fell-back) with the
    generated brief text stored (migration 705, `output_text`). Surfaced as
    the "AI generation log" on the Briefs page (`GET /lbp/brief-runs`) with a
    lifetime run count + total spend; each row expands to re-read the exact
    brief that run produced (the review area). Model settings live in
    app_settings, not this table, so pricing changes never rewrite history.
  - What's sent to the model (grounding provenance): ONLY the deterministic
    grounded brief text, which `buildBrief` assembles server-side from stored
    records — `lbp_projects` (names/stages), `lbp_activity` since the relevant
    meeting marker (what moved, each `[activity #N]`), and `lbp_metric_reports`
    for leadership mode (each `[report #N]`). The model gets the system prompt
    (`briefSystemPrompt`) + a user message wrapping that grounded text
    (`briefUserPrompt`) — no raw DB rows, no project internals beyond what the
    grounded brief already states. Citation extraction (`citationTokens`) is
    bracket-agnostic so it recognizes the deterministic brief's GROUPED form
    (`[activity #1, activity #2, activity #3]`) as well as single brackets —
    an earlier bracket-strict version found zero citations in the grouped
    source and wrongly rejected every rewrite as ungrounded.
  - Endpoints: `POST /lbp/brief/ai` (generate + record), `POST /lbp/brief/ask`
    (grounded Q&A), `GET /lbp/brief-runs` (audit), `GET`/`PUT
    /lbp/brief-settings`. The Anthropic call reuses the vetted provider client
    in `mock2/model-client.js` (raw Messages API over the agent proxy), the
    same one `cve-research.js` reuses; the pure pieces (pricing, citation
    grounding, prompt text, ask-context assembly, link refs) live in
    `lean-beaf-logic.js` so they stay unit-testable without better-sqlite3.
  - Transient resilience: `generateAiBrief` / `answerBriefQuestion` retry once
    more on a transient failure or first-call timeout (on top of the model
    client's own retry) — operators saw the first "Generate with AI" click
    fail and the second succeed (a cold request through the agent proxy), so a
    brief/question no longer needs a manual re-click.
  - Interactive, styled output: brief + answer text renders through
    `components/lbp/BriefText.jsx` — a small deterministic markdown renderer
    (headings, bullets, bold; no raw HTML injected) that also linkifies the
    grounded references. Citation chips `[activity #N]` / `[report #N]` and
    project-name mentions become clickable, deep-linking to the owning project
    (activity → its Activity tab, report → its Metrics tab) via a `?tab=`
    param `LbpProjectDetail` reads. The link map (`buildBriefRefs`) ships with
    every brief/ask/run-log response.
  - Chat setup: the Brief card is a conversation. The selected brief (Daily /
    Since meeting / Leadership, or the AI restyle) is the opening assistant
    message; a persistent composer at the bottom lets anyone go straight to
    asking, and the input clears on send. Questions thread below as user
    bubbles + grounded assistant answers, auto-scrolling to the newest. Answers
    come from `buildAskContext` — a cited facts document assembled from
    `lbp_projects`, `lbp_activity`, `lbp_metric_reports` (each figure carries
    an `[activity #N]` / `[report #N]` citation). Same R07 posture as the
    brief: `askSystemPrompt` forbids uncited numbers and the
    `citationsGroundedIn` check rejects an answer citing a record not in the
    context. Each question is a recorded run (mode `question`, the Q+A stored
    in `output_text`) so it's reviewable in the AI generation log.
  - Global assistant dock: a right-docked, grounded-Q&A chat available on EVERY
    page (`components/lbp/AiAssistant.jsx`, rendered once in `Layout.jsx` so the
    conversation persists across navigation). Docked by default ("always
    there"); the operator can collapse it to a floating "Ask AI" bubble and the
    choice persists. Responsive — at `lg`+ it's a ~360px side panel and the app
    content reflows to its left (Layout adds matching right padding); below `lg`
    it's a full-content overlay, and on the Lean BEAF Pro page it's surfaced as
    an "Assistant" tab (before Archive) so the AI stays reachable when there's
    no room to dock. The panel is now PURE Q&A — the brief itself (with its
    Daily / Since meeting / Leadership options + Generate with AI) lives on the
    dashboard; the panel just answers questions (still grounded + cited, saved
    to the Briefs log). Hidden for pending accounts.
  - Dashboard: five stat tiles (the fifth, "Last meeting", opens a meeting hub
    modal — Mark-now + schedules + history/audit), the rollout process-map
    directly under them (stages stretch to fill the full width), then the
    **AI Brief** panel (Daily / Since / Leadership to review + Generate with AI)
    which fills the remaining height up to a max. The brief panel has a left
    ~20% "Recent activity" rail listing active projects newest-action-first
    (clipped to what fits vertically), and the brief text on the right. Every
    Lean BEAF Pro view uses the full content width (like the board).
  - List view is a dense, SharePoint-style table: one single-line row per
    project (Project / Stage / Location / Team / Started / Status), a sticky
    header, `table-fixed` so columns always fit + truncate, filling the space.
  - Timezone handling: meeting markers are stored as UTC ISO and rendered in the
    viewer's local timezone (relative + absolute). Recurring-schedule times are
    interpreted in UTC server-side (`latestScheduleOccurrence` uses UTC date
    methods, so a schedule fires at a fixed instant regardless of server tz) and
    the client formats them into local time for display (`scheduleLocalLabel`)
    and converts a locally-picked time back to UTC on save (`localScheduleToUtc`)
    — so the schedule label, the history, and the firing all agree in the
    viewer's own clock.
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
