# Harness investigation — project 32 ("IP2" / Spec Ops Hub), request 85

Evidence: `buildlogsproject32all3.json` (request 85, cycles 390–391, 121
events; concept cycle 389 referenced by its artifacts inside tool results).
Method: each hypothesized finding was traced to its mechanism in this repo;
classifications use the taxonomy from the investigation brief — *missing
check · check exists but doesn't execute · check executes but doesn't gate ·
instruction under-specifies · template defect*.

## Pipeline map (as it exists in this repo)

| Stage | Where |
| --- | --- |
| Mockup generation | `admin/backend/src/mock2/concept.js` (`runConceptTurn`) + prompts in `concept-logic.js` (`buildMockupSystemPrompt`, tweak/screen scopes); base template `mockup-template.js`; acceptance lint `mockup-checks-logic.js` (advisory, runs on every saved render) |
| Design approval + inventory extraction | `concept.js` (`runDesignApproval`) → `concept-logic.js` `buildInventoryExtractionPrompt/Task`, `parseInventory` → writes `state/inventory.json` |
| Define / rules interview | `audit.js` (`startBuildRequest` → audit cycle; answers append `state/rules.md`) |
| MVP/quick fast path | `audit.js` ~L278 (`isFastBuildMode`): zero-cost define segment, **no interview, no gate battery**, straight to `proceedToBuild` |
| Build task assembly | `runner.js` ~L905 (`buildRunnerTask` + prepass brief + feedback section); system prompts in `runner-logic.js` |
| Finish checks | `runner.js` ~L1286 (`summaryOverclaims` from `acceptance-logic.js` — gates finish), acceptance verdict ~L1268 (relaxed for fast modes: `mvp_not_required`) |
| Deploy → smoke | `runner.js` ~L1519 `smokeAfterDeploy` → `smoke.js` (diff-triggered browser/db connectors) |
| Anomaly tripwire | `runner.js` ~L1587 (after `finishCycle` + deploy; note + flag only, "never blocks" by design) |

## Findings

### 1. Zero edit capability shipped — CONFIRMED
**Evidence:** inventory in tool results (seq 5/8): 13+ actions on the first
screens — navigation, expand/collapse, filters, create ("New opportunity",
"Add task", "Add learning", "Promote") — zero edit/update/delete/rename
actions anywhere (regex sweep over the full log: no PATCH/PUT/DELETE route
registrations; the only DELETEs are SQL test-data cleanup at seq 104).
Downstream dead ends verified live in the log: seq 98 shows promote blocked
by a barrier task whose status can never change.
**Mechanism:** `buildInventoryExtractionPrompt` (concept-logic.js ~L606)
commands *"Do not invent screens, fields, or actions the mockup does not
show."* A static mockup cannot show mutation flows, so the inventory is
structurally CRUD-incomplete, and nothing downstream compensates — the
builder implemented the incomplete contract faithfully (instruction:
"implement every screen, field, and action it defines").
**Classification:** instruction under-specifies (extraction literalism with
no CRUD-completion pass) + missing check (no completeness linter at
approval).

### 2. Demo state became a default — CONFIRMED (as missing structure)
**Evidence:** inventory `states` are flat prose strings (`"attention chip
active (filtered)"`, `"default (some groups expanded…)"`). Defaults are
captured only when the extractor happens to write the word "default";
nothing distinguishes a state the mockup demonstrated-for-illustration from
the screen's actual resting state, and the mockup carries no annotation the
extractor could read.
**Mechanism:** `parseInventory` normalizes `states: [string]` with no
`default_state`; `buildMockupSystemPrompt` has no demo-state annotation
convention.
**Classification:** missing check / missing template convention.

### 3. MVP path skipped the step that would have caught #1 — CONFIRMED
**Evidence:** first chat message of the request: "MVP build — skipping the
rule interview and the gate battery…". Routing meta `build_mode: "mvp"`.
**Mechanism:** `audit.js` ~L278: `isFastBuildMode(mode)` records a
zero-cost define segment and calls `proceedToBuild` directly. There is no
floor: no micro-interview, no standard rules pack — editability rules are
exactly Define-stage output, and the fast path produces none. `runner.js`
~L1268 additionally relaxes the acceptance verdict for fast modes.
**Classification:** missing check (deliberate speed trade with no floor).

### 4. Tripwire fired after deploy, as a note — CONFIRMED
**Evidence:** seq 118 `deploy` → seq 120 tripwire note ("closed at 13% of
its token estimate; no failing (red) test…").
**Mechanism:** `runner.js` ~L1587 — the anomaly check runs after
`finishCycle` and after deploy; the comment says "never blocks" by design.
`anomalySignals` (acceptance-logic.js ~L212) is bugfix-only, so it could
not have gated THIS feature build anyway — but the mechanism question
stands: the tripwire cannot gate anything from where it sits.
**Classification:** check executes but doesn't gate.

### 5. Finish-check false positive — CONFIRMED, precise mechanism found
**Evidence:** seq 110 "Finish rejected — summary over-claims
(src/opportunities, routes/service/schema, public/app.html/app.css/app.js,
blocked/stale/promote-ready)" — all four "unmatched paths" are prose
artifacts, not file claims. Seq 113: the reworded summary (same content)
passed.
**Mechanism:** `extractSummaryPathClaims` (acceptance-logic.js ~L170): the
path regex has three false-positive families the log hits exactly —
(a) brace shorthand `src/opportunities/{schema,service,routes}.ts` leaves
fragments (`src/opportunities`, `routes/service/schema` — wait: the brace
group is consumed as separate tokens); (b) slash-joined file lists
(`public/app.html/app.css/app.js`) treated as one path; (c) slash-separated
word runs that aren't paths at all (`blocked/stale/promote-ready`). Also
`summaryOverclaims` has no directory-prefix coverage (`src/opportunities`
should be covered when changed files live under it).
**Classification:** check executes and gates, with a low-precision
extractor (cost: one wasted round-trip per false positive).

### 6. Acceptance criteria written but never executed — CONFIRMED
**Evidence:** seq 116 `acceptance` (detailed scenarios incl. the barrier→
promote-disabled case) vs seq 119 `smoke`: generic browser pass over the
changed public files; db connector disabled. No mechanism exists to execute
the authored list.
**Mechanism:** the finish tool's acceptance is prose
(`formatAcceptanceBlock`); `smoke.js` triggers connectors off diff globs
and runs generic checks (`ui-checks.js` has a runnable step DSL —
`expect_visible`/`click`/`fill` — but nothing translates acceptance prose
into it).
**Classification:** check exists but doesn't execute (missing bridge from
authored acceptance to the runnable step DSL).

### 7. Mockup design verification — CONFIRMED FIXED (this branch)
The baked-in dark/neon theme override and the prose-only design bar were
real and are already fixed on this branch, before this investigation:
brief-outranks-system precedence + restyle handling (commits `f56f96d`,
`ed8293a`), light-first token design system + base template (`0eb7b41`),
and EXECUTABLE mockup checks (`2bb1387`): legacy-palette scan, token-only
colors, theme/toggle, data-bound bars, canonical list rows, detail bands,
computed AA contrast — run on every saved render (advisory note in chat)
plus `scripts/verify-mockup.mjs` with runtime overlap/truncation checks.
The specific defects named (overlapping columns, unfilled bars) each have a
dedicated check. **Nothing further implemented for this finding.**

## Improvement plan (Phase 2 — one commit each)

Ranked by leverage as investigated (order kept from the brief, with 5
landing before 4 because 4 consumes it):

1. Inventory CRUD completion + completeness linter (finding 1).
2. States vs defaults: `default_state` + demo-state annotation (finding 2).
3. Action-parity finish gate (finding 1's build-side belt-and-braces).
4. MVP-path floor: standard rules pack injected into fast builds (finding 3).
5. Standard CRUD rules pack module (consumed by 4).
6. Tripwire gates finish: anomaly hold before deploy (finding 4;
   conservative option — hold, not rollback).
7. Executable acceptance: machine-runnable steps through the existing
   ui-checks DSL, executed by smoke (finding 6).
8. — confirmed already fixed (finding 7).
9. Finish-summary extractor precision (finding 5).
10. `LEARNINGS.md` registry + triage guidance (all findings).

Decisions flagged (evidence didn't settle them): anomaly-hold releases via
the existing redeploy action rather than a new ack flow; the smoke DB
connector default stays operator-controlled (it was explicitly turned off);
acceptance execution covers happy paths, not every scenario.
