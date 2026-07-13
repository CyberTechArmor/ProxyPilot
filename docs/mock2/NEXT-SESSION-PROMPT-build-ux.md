# Next session — Build-mode UX polish (Mock2)

Continue on branch **`claude/build-mode-ui-tasks-0ocebw`** (PR #284). Four UX
improvements to the Mock2 build/run experience. Each is self-contained; ship them
as separate commits and push to the same branch.

## Where things are (context from the current build-mode UI)

The project detail page (`admin/frontend/src/pages/ProjectDetail.jsx`) has three
tabs: **Chat**, **Terminal**, **Details**. In build mode (design approved) the
Chat tab renders `components/mock2/BuildMode.jsx`, which lays out:

- **Left column:** the live-app link bar (`ProjectPreview.jsx` → `LiveAppBar`) on
  top, then `BuildStatus.jsx` (the "Build" panel: drift banner, the
  Claude-Code-style task list `BuildTaskList.jsx`, current-cycle status + spend,
  deploy state, admin allow/deny for framework deviations, and the collapsible
  **change history** at the bottom).
- **Right column:** `BuildChat.jsx` — the message log (shared renderers in
  `chat-messages.jsx`: `ChatBubble`, `RuleQuestion`, `ChatMessageList`) + a
  composer that starts a build cycle.

`BuildMode` owns the single cycle poll (`api.mock2GetLatestCycle`) and passes
`cycle` + `job` down. Chat messages come from `api.mock2GetChat` (each message has
a `cycle_id`). Cycles carry `used_tokens` / `used_cost_cents`. Change records
(`admin/backend/src/mock2/change-records.js`, route
`GET /mock2/projects/:id/change-records`) carry `seq`, `cycle_id`, `commit_sha`,
`summary`, `gates_run`, `rules_touched`, `created_at`. Provisioning progress is
polled in ProjectDetail as `provStatus` via `api.mock2ProjectProvisionStatus`
(shape `{ progress: { message, log: [{ phase, message }] } }`) and currently shown
only in the Details tab's "Live URL" card.

Conventions: `admin/frontend/MOBILE_FIRST.md` is a merge gate (base Tailwind
breakpoints, `grid-cols-1 sm:…`, 44px targets, works at 360px). Backend tests:
`cd admin/backend && npm test` — only `vpn-mtu.test.js` (CLI `better-sqlite3` env
issue) is a known/pre-existing failure; keep everything else green. Frontend:
`cd admin/frontend && npm run build`. Put pure logic in a `*-logic.js` and unit
test it. New mock2 migrations continue from **511**.

---

## Task 1 — Scroll to the NEXT open question, not the bottom

When the audit raises several rule questions at once, answering one currently
jumps the chat all the way to the bottom (`BuildChat.jsx` scroll effect sets
`scrollTop = scrollHeight` on message-length change). Instead, after an answer,
scroll the **first still-open** rule question into view so the user lands on the
next thing to answer.

- `BuildChat.jsx` (and mirror the behavior in `ConceptStage.jsx` if design-phase
  questions ever stack): the open questions are `data.open_question_ids`. Give
  each open `RuleQuestion` a stable anchor (e.g. `data-open-question` attribute or
  `id="q-<question_id>"` in `chat-messages.jsx`).
- Replace the "always scroll to bottom" effect with: if any open question exists,
  `scrollRef.current.querySelector('[data-open-question]')?.scrollIntoView({ block: 'start' })`;
  otherwise keep the normal scroll-to-bottom for new chat messages. Re-run it when
  `open_question_ids` changes (an answered question closes → the next becomes
  first-open → scroll to it).
- **Acceptance:** answering one of several questions scrolls to the next
  unanswered question (not the composer); with no open questions, new messages
  scroll to the bottom as before.

## Task 2 — Split "Build" and "Change history" into sub-tabs (left column) + expandable change details

Reclaim vertical space: instead of the change history sitting under a
"Show change history" toggle below the Build panel, put **Build** and
**Change history** as two sub-tabs inside the left column (only one visible at a
time). The `LiveAppBar` stays above the tabs.

- `BuildStatus.jsx`: add an inner two-way toggle (match the Plan/Design pill
  toggle style already in `ConceptStage.jsx`) — "Build" shows the current build
  panel; "Change history" shows the records list (move the existing
  `mock2GetChangeRecords` section there, drop the collapsible).
- Make each change record **expandable** for troubleshooting: clicking a record
  reveals its full detail — the AI interactions for that cycle (chat messages with
  the record's `cycle_id`: user / assistant / system / rule Q&A), the gate results,
  the commit sha, and rules touched. Fetch on expand: `api.mock2GetCycle(id, cycleId)`
  (returns `{ cycle, job }` with `cycle.gates`) + `api.mock2GetChat(id)` filtered
  client-side to `m.cycle_id === record.cycle_id`. Consider a dedicated
  `GET /projects/:id/changes/:seq` backend endpoint if the client join gets messy.
- **Acceptance:** left column has Build / Change-history sub-tabs; each change
  expands to show the cycle's AI interactions + gates + commit for debugging.
  MOBILE_FIRST preserved.

## Task 3 — Token counter per change + tokens & cost in Details

- **Per change record:** show the token count (and cost) for that record's cycle.
  Extend the change-records public shape (backend, `change-records.js` +
  `routes.js` `GET /change-records`) to include the linked cycle's `used_tokens`
  and `used_cost_cents` (join by `cycle_id`; null for the approval/no-cycle
  record). Render e.g. `12,480 tok · $0.09` on each entry.
- **Details section:** add total usage. Extend the existing time-summary endpoint
  (`GET /projects/:id/time-summary`, `time-logic.js`) — or add a sibling
  `usage-summary` — to sum `used_tokens` / `used_cost_cents` across
  `listCyclesForProject`, ideally broken out by stage (mockup / build /
  adjustments to match the time card). Surface it in `ProjectTimeCard.jsx` (or a
  new "Usage" card): total tokens + total cost formatted as `$X.XX`.
- **Acceptance:** every change log entry shows its tokens (+cost); Details shows
  total tokens and total cost. Add/extend a pure unit test for the summing.

## Task 4 — Stream live setup detail in the Chat interface + confetti when it comes online

- **Provisioning in the Chat tab:** while `project.lifecycle === 'provisioning'`,
  show the realtime setup steps *in the Chat tab* (today they're only in Details).
  ProjectDetail already polls `provStatus`; thread it into the Chat column — e.g.
  a `SetupProgress` panel (or enhance `PreviewPlaceholder` in `ProjectPreview.jsx`)
  that renders `provStatus.progress.log` (`[starting] … [repo] … [bridge] …
  [setup] Installing runtime…`) live, with the current step highlighted. Keep the
  Details "Live URL" log too.
- **Confetti on online:** when a project first transitions
  `provisioning → active` (or first reaches `serving`), fire a one-time confetti
  burst. Guard it so it fires **once** per project (a ref + a
  `localStorage` key like `mock2:onlined:<id>`), and only on the transition, not
  on every load of an already-online project. Use a **self-contained** confetti
  (no external CDN — CSP): add the `canvas-confetti` dependency (small, no network
  calls) or a tiny inline canvas implementation. Trigger from `ProjectDetail`
  where the lifecycle is known.
- **Acceptance:** provisioning steps stream in the Chat tab; a confetti burst
  fires exactly once when the project first comes online.

---

When done: `npm test` (backend, green except `vpn-mtu`), `npm run build`
(frontend), verify MOBILE_FIRST at 360/768, commit each task separately, and push
to `claude/build-mode-ui-tasks-0ocebw` (updates PR #284).
