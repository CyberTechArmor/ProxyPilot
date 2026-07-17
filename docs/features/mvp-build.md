# MVP build mode + build speed levers

Three changes aimed at one number: time from approved mockup to a testable app.
Diagnosis (project-11 build log): of a 45-minute build, ~43 minutes was model
generation — ~20 of them a single SPA file truncating against the 8k per-turn
output cap, on the escalation-tier model at high effort, plus the full
authoring-discipline pipeline (per-rule tests, acceptance spec, ui-checks).

## 1. Per-turn output cap: 8k → 32k

`runner.js` `RUNNER_MAX_TOKENS` (default 32000, clamp [8k, 64k], override via
`MOCK2_RUNNER_MAX_TOKENS`). Large files now land in one model turn instead of
many capped continuation turns. `model-client.js` streams automatically above
its 12k threshold and scales the HTTP timeout with the budget, so no transport
change was needed.

## 2. Fast code model for routine tasks

`decideRouting` (routing-logic.js): when a routing rule carries **no explicit
model override**, tasks the audit scored **difficulty ≤ 3** run on the fast
code model — `MOCK2_FAST_MODEL`, default `claude-sonnet-5` — instead of the
slot model. Hard tasks (difficulty 4–5), unclassified tasks, explicit rule
overrides, and escalations are untouched. `MOCK2_FAST_MODEL=off` restores the
old behavior entirely. The routing reason string carries `fast-model` so every
decision stays reviewable in the cycle events, and the outcomes scoreboard
shows the fast model's success rate per task kind.

Caveat: the model id must be servable by the build slot's connector (an
Anthropic slot serves any `claude-*` id). On a non-Anthropic slot set
`MOCK2_FAST_MODEL` to one of that provider's models, or `off`.

## 3. MVP build mode

The flow the Build MVP button implements:

1. **Mockup → "Build MVP"** — a fast, testable first version.
2. **Updates** — further MVP or full cycles as needed.
3. **"Build"** — the fully audited path (rule questions, per-rule tests,
   acceptance spec, ui-checks) hardens the app.

What `mode: 'mvp'` changes (`POST /api/mock2/projects/:id/cycles`):

| Stage | Full build | MVP build |
|---|---|---|
| Rule interview (audit) | model call + blocking questions | **skipped** (zero-cost define segment records the skip) |
| Component pre-install | yes | yes (unchanged — zero tokens) |
| Model / effort | routing knowledge base | fast model at `MOCK2_MVP_EFFORT` (default `low`) |
| Gate battery | all 8 gates | typecheck, constitution-lint, security-scan, test, component-reuse (**rule-coverage / ui-interaction / acceptance dropped**) |
| Finish discipline | acceptance spec + reproduce-first | finish summary + human-runnable checks + assumptions only |
| Integration truthfulness gate | yes | yes (honesty is not an MVP casualty) |

The mode is stamped on the umbrella request (`mock2_requests.build_mode`,
migration 529), so **resumes of an MVP build stay MVP** — same reduced battery,
same fast routing. The runner's system prompt carries an explicit MVP section
sanctioning the skipped artifacts for that cycle only.

The **initial build after design approval now runs as MVP by default** (that is
the "from mockup to Build MVP" path); set `MOCK2_INITIAL_BUILD_MODE=full` to
restore the fully audited initial build.

UI: the build composer shows **Build MVP** (outline, rocket) next to **Run a
cycle**. The chat announces "MVP build — skipping the rule interview and
running a reduced gate battery…" so the record shows which mode ran.

## Env summary

| Variable | Default | Meaning |
|---|---|---|
| `MOCK2_RUNNER_MAX_TOKENS` | `32000` | per-turn output ceiling (clamped 8k–64k) |
| `MOCK2_FAST_MODEL` | `claude-sonnet-5` | fast code model; `off` disables |
| `MOCK2_MVP_EFFORT` | `low` | effort for MVP builds (raised from the default if MVPs come out too shallow). Low effort means fewer, more-consolidated tool calls — the observed 17-minute MVP spent ~95% of wall-clock on ~90 small model turns, so per-turn thinking and turn count are the levers; the MVP system prompt now also mandates batching multiple tool calls per turn and complete single-shot file writes. |
| `MOCK2_INITIAL_BUILD_MODE` | `mvp` | mode of the auto build after design approval |

Note: the flag-gated Agent-SDK runner (`BUILD_RUNNER=sdk`) inherits the reduced
gate battery (filtered before hand-off) but not the MVP system-prompt section
or the relaxed finish verdict — it remains full-discipline until migrated.

Pure decision logic: `normalizeBuildMode` / `filterGatesForBuildMode`
(cycle-logic.js), `fastCodeModel` / `mvpRoutingDecision` (routing-logic.js) —
covered by `mock2-build-mode.test.js`.
