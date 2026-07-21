# Prompt for Claude Code — Harness Controls: per-step model/effort/thinking on the admin side

Run from the ProxyPilot repo root. This is a planned, scoped feature — the plan was
agreed with the operator; implement it as specified, in the commit order given.
Read `docs/core/harness-steps.md` FIRST — it is the verified map of every
model-bearing step in the Mock2 pipeline and the source of truth this feature
turns into a UI. `CLAUDE.md` carries the repo conventions; follow them.

## Goal

A new admin page ("Harness", under the Projects section of the dashboard) where
every model-bearing pipeline step is one row: the operator sees the **resolved**
model / effort / thinking for that step and **where the value came from**, can
override each per step, and sees what each step actually cost over the last 7
days. Deterministic steps (gates, smoke, parity, tripwire — the "free half" in
the doc) are listed read-only for completeness.

Why: the operator runs builds on Opus by choice (cheaper models produce
cross-effect bugs that cost more in re-work than the premium). The remaining
cost levers are per-step: which model serves each of the ~19 call sites, at what
effort, with thinking on or off. Today that control is scattered across five
model slots, six lane-tuning lanes, and ~7 env vars; the rest is constants.

## Decisions already made (do not relitigate)

- **Control surface: model + effort + thinking per step.** Output budgets are
  shown **read-only** (a mis-set budget causes truncation failures that don't
  look like a settings mistake). **No prompt editing anywhere** — edited
  prompts silently break tool schemas and survive updates.
- **Precedence (top wins): step override → lane tuning → env override →
  slot/shipped default.** Existing lane tuning and env vars keep working
  unchanged; the step override is a NEW top layer. Nothing an operator has
  already configured may change behavior on upgrade.
- **Scope: global** (one config for the platform). No per-project overrides in
  this iteration.
- **Fallback guard:** any step whose overridden model is rejected by the
  connector (error message matching /model/i, mirroring the existing mockup
  fallback in `concept.js`) retries once on the step's shipped default and
  logs a loud note. A bad setting must never dead-end a build.
- **No duplication of existing pages:** slot model assignment stays on Model
  Connectors; lane tuning stays on Routing. The Harness page shows resolved
  values with source badges and deep-links to those pages where they own the
  value; its own dropdowns write only the step-override layer.

## Repo facts you need (verify anchors before editing — line numbers drift)

- Backend pipeline code: `admin/backend/src/mock2/`. Pure decision modules are
  `*-logic.js` (native-free, unit-tested without better-sqlite3 — keep that
  split; risk R9). Nothing may be named "agent" (risk R7).
- The ~19 model-call sites all go through `callModelTurn`
  (`src/mock2/model-client.js`). The map with per-step file anchors, models,
  efforts, and budgets: `docs/core/harness-steps.md`.
- Model slots (5): `concept_chat`, `mockup`, `build_runner`, `audit`,
  `summary` (`getSlot` in `src/mock2/connectors.js`).
- Lane tuning (6 lanes: build, mvp, audit, chat, mockup, ask):
  `src/mock2/lane-tuning-logic.js` (pure) + `getLaneTuning` in
  `src/mock2/settings.js`, applied via `applyLaneTuning` at call sites.
- Env overrides: `MOCK2_FAST_MODEL`, `MOCK2_MOCKUP_MODEL`,
  `MOCK2_PREPASS_MODEL`, `MOCK2_REVIEW_MODEL`, `MOCK2_QUICK_EFFORT`,
  `MOCK2_MVP_EFFORT`, `MOCK2_RUNNER_MAX_TOKENS`.
- Spend ledger: `insertLedgerEntry` (`src/mock2/quotas.js`), written by the
  per-stage `recordSpend` helpers (concept.js, runner.js, audit.js, ask.js,
  design-review.js, screen-plan.js, consult.js, explain.js).
- Mock2 DB migrations: `src/mock2/migrations.js`, append-only numbered blocks
  (last used: 540 — take the next number). Never edit applied migrations.
- Admin API routes: `src/mock2/routes.js` (follow the existing settings
  endpoints' shape and auth, e.g. the design-review toggle and lane tuning).
- Frontend: `admin/frontend/` (React + Tailwind + shadcn/ui). API client:
  `src/lib/api.js` (go through it; it owns CSRF + sudo re-auth). Any page
  work MUST comply with `admin/frontend/MOBILE_FIRST.md` (merge gate):
  single column on mobile, 44px targets, no horizontal scroll at 360px.
- Test baseline: `cd admin/backend && npm test` → expect **1 pre-existing
  failure only** (`vpn-mtu.test.js`, native-module; never fix it). Every
  commit must keep the rest green. Frontend must `npm run build` clean.

## Implementation — four commits, in this order

### Commit 1 — the step registry (pure)

`admin/backend/src/mock2/harness-steps-logic.js` (pure, native-free):

- Export `HARNESS_STEPS`: one entry per model-bearing step from
  `docs/core/harness-steps.md`, shape:
  `{ id, stage, title, description, intendedOutcome, slotKey|null,
     laneKey|null, envModelVar|null, envEffortVar|null,
     defaults: { model: string|null /* null = slot-resolved */, effort,
     thinking, budgetNote }, tunable: true|false }`.
  Use stable kebab-case ids (they go on ledger rows): `concept-chat`,
  `mockup-render`, `mockup-tweak`, `mockup-screen`, `mockup-continuation`,
  `design-doc-adjust`, `inventory-extraction`, `design-token-extraction`,
  `rule-audit`, `split-probe`, `quick-prepass`, `chat-distill`,
  `build-runner`, `consult`, `explain-card`, `explain-followup`,
  `checklist-postpass`, `design-review`, `ask`.
- Export `DETERMINISTIC_STEPS` (id, stage, title, description) for the
  read-only section — take them from §4 of the doc.
- Export `resolveStepTuning(stepId, baseline, overrides)` — pure: applies a
  stored `{model?, effort?, thinking?}` override on top of an
  already-lane-tuned baseline; validates effort ∈ low/medium/high and
  thinking ∈ 'off'|null; unknown stepId returns the baseline unchanged.
- Unit tests (new file in `src/__tests__/`): registry completeness (ids
  unique, every entry has stage/title/defaults), precedence behavior of
  `resolveStepTuning`, junk tolerance.
- Update `docs/core/harness-steps.md` with one line noting the registry
  module is now the machine-readable source and the doc mirrors it.

### Commit 2 — settings, resolution wiring, fallback guard

- Storage: `app_settings` key `harness_step_tuning`, JSON
  `{ [stepId]: { model?, effort?, thinking? } }`. Getter/setter in
  `src/mock2/settings.js` following `getLaneTuning`'s pattern (parse-safe,
  cached like its neighbors if they cache).
- Wire the override at each of the ~19 call sites: AFTER the existing lane
  tuning / env resolution, pass the baseline through
  `resolveStepTuning(stepId, baseline, getHarnessStepTuning())`. Keep each
  call-site diff minimal — one wrapping call, no behavioral change when no
  override is stored (add a test asserting exactly that: empty settings ⇒
  byte-identical tuning to today's).
- Fallback guard: where a step override changed the MODEL and the call fails
  with an /model/i error, retry once on the pre-override model and log
  `[mock2] step override fallback: <stepId> <model> rejected — using default`
  plus a cycle log note where a logEvent is in scope. Model the code on the
  existing preferred-mockup fallback in `concept.js`. Central helper
  preferred over 19 copies — a small wrapper around `callModelTurn` that
  takes `{ stepId, overriddenFrom }` is acceptable if it stays transparent.
- API (in `src/mock2/routes.js`, admin-gated like the neighboring settings
  endpoints; mutations require sudo if the neighbors do):
  - `GET /api/mock2/harness` → `{ steps: [{ ...registry entry, resolved:
    { model, effort, thinking, source: 'step'|'lane'|'env'|'slot'|'default' },
    spend7d: { cents, calls } | null }], deterministic: [...] }`.
    (spend7d is null until commit 4 lands — ship the field now.)
  - `PUT /api/mock2/harness/steps/:id` body `{ model?, effort?, thinking? }`
    (empty/absent field clears that override; validate against the registry;
    audit-log the change without logging nothing sensitive — there is
    nothing sensitive here).

### Commit 3 — the Harness admin page

- `admin/frontend/src/pages/HarnessControls.jsx`, route under the Projects
  admin section (follow how `projects/queue` etc. are registered in
  `App.jsx` and the Projects-area navigation), admin-only like its
  neighbors.
- Layout mirrors the doc: stage sections (Concept / Define / Build /
  Post-build), one row per step: title + one-line description, resolved
  model/effort/thinking as compact controls, a **source badge** on each
  value (default / slot / env / lane / step), budget shown as static text,
  and the 7-day spend chip (renders "—" until data exists). "Reset to
  default" per row clears the override. Slot-sourced models render a link
  ("set on Model Connectors") next to the dropdown; lane-sourced values
  link to Routing. Model dropdown options: reuse whatever source the
  Routing tab's model dropdowns use.
- Deterministic steps render as a collapsed read-only list at the bottom.
- `api.js`: `harnessSteps()`, `harnessStepSave(id, patch)`.
- MOBILE_FIRST: rows collapse to stacked cards on mobile; 360px render with
  no horizontal scroll; 44px touch targets. Complete the pre-merge
  checklist in `MOBILE_FIRST.md`.

### Commit 4 — per-step spend attribution

- Mock2 migration (next number after 540): add a nullable `step` TEXT column
  to the ledger table `insertLedgerEntry` writes.
- Thread a step id through every `recordSpend` call (each stage file has its
  own `recordSpend` helper — extend each to accept and store `step`).
  Use the registry ids. Calls without an id store null (old rows are null —
  fine).
- Rollup: 7-day `SUM(cost)/COUNT(*) GROUP BY step` feeding `spend7d` in
  `GET /api/mock2/harness`. Confirm the ledger's cost/token column names
  from the schema before writing the query.
- Page picks it up with no changes (field shipped in commit 2/3).

## Guardrails

- Behavior with no overrides stored must be byte-identical to today — that
  is the back-compat contract; test it.
- Do not touch prompts, budgets, gate logic, or the runner loop beyond the
  tuning-resolution insertion points.
- Do not rename or renumber anything in lane tuning, slots, or env vars.
- Migrations: append-only, next free number, never edit applied ones.
- Keep pure logic in `*-logic.js` files importable without better-sqlite3.
- One commit per phase above, descriptive messages referencing this plan.
- If a call site turns out not to fit the pattern (e.g. a fixed-model step
  like the consult), make it `tunable: false` in the registry and render it
  read-only rather than forcing it — note it in the final summary.

## Acceptance criteria

- With nothing configured, all suites pass at the baseline (1 pre-existing
  vpn-mtu failure only) and a diff of resolved tunings vs. current behavior
  is empty (the back-compat test).
- Setting a step override changes exactly that step's next call (verifiable
  in the request log's routing/model lines) and survives backend restart.
- An override to a nonsense model does not break the step: the call retries
  on the default and the log says so.
- The Harness page renders every registry step grouped by stage with correct
  source badges at 360px and desktop, saves and clears overrides (sudo flow
  intact), and shows per-step 7-day spend once new cycles run.
- `GET /api/mock2/harness` responds < 500ms with the rollup (index the new
  column if needed).

## Final report

Summarize: registry contents (step count), which steps are tunable vs fixed,
the precedence chain as implemented, the back-compat proof, and anything you
marked `tunable: false` with the reason.
