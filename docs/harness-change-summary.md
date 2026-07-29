# Harness change summary — 2026-07 redesign

Companion to `docs/harness-map.md` (the pre-change map). Every changed
behavior traces to logged evidence from project 34 (the good baseline) or
project 47 (the bad one). Direction: **the right rules, not the most rules** —
checks whose cheapest literal satisfaction produced a worse app were
redesigned or demoted; nothing new blocks.

## Every check, before → after

| Check | Status | Change | Cheapest-pass note | Evidence |
|---|---|---|---|---|
| `typecheck` | **kept** | none | in gates.json script comment | sound in P34 |
| `constitution-lint` | **kept** | none | script comment | — |
| `rule-coverage` | **kept** | none | script comment | — |
| `security-scan` | **kept** | none | script comment | — |
| `test` | **kept** | none | script comment | — |
| `ui-interaction` | **redesigned** | new coverage must come from a new check or changed steps; glob-only additions fail with the conjured files named; sw.js/build-id/manifests exempt; already-covered screens stay cheap | in the gate script (gates.json) | P47 cycle 2's own summary: "added public/sw.js + build-id to an existing ui-check's paths… no product-code change was needed" |
| `acceptance` (gate) | **kept** | none (full lane only, which is the right lane) | script comment | — |
| `component-reuse` | **kept** | none | script comment | pipeline-walkthrough wrongly listed it advisory — see "docs vs code" below |
| `design-adherence` | **redesigned** | drift scoring replaces adoption breadth: hardcoded color/spacing literals where a token exists + re-made components, **blocking only on what the current cycle introduced** (HEAD comparison); adoption numbers reported, never scored; shell checks, dark-theme rule and P39's absolute-zero rule kept | gate header in `baseline-gates.js` | P47 "42 of 109 classes, 9 of 60 variables"; P38 (9/55 vars + 15.8KB hardcoded passed); P39 (unstyled markup skipped it) |
| `platform-intact` | **kept** | none | file header | — |
| `signin-reachable` | **kept** | none | file header | — |
| `mobile-overflow` | **kept** | none (the `overflow:hidden` escape stays a known, noted gap) | file header | — |
| `no-native-dialogs` | **kept** | none | file header | — |
| `no-dead-controls` | **kept, scoped in writing** | in-file statement: applies only to controls the build chose to render; can never require one to exist; full pair reasoning written in the file | file header | gate-audit #4 ("harmful in combination") |
| `e2e` | **kept** | none | file header | sound; the only pre-deploy DOM check |
| action parity | **redesigned (message + pair)** | capability reachable anywhere counts (menus/secondary — was already matched by the two-word core); hidden-only still never counts; rejection states placement is the design's call, never asks for a top-level control; badge conditional on the mockup showing the control; leave-out-and-state is a sanctioned outcome | comment at the parity block in `runner.js` | P47 request 140: the "Edit note title/body" button + hidden `/admin` hint |
| removal claims | **kept, budget-bounded** | routed through the shared finish budget; still rejects at most once | comment at the site | gate-audit #11 |
| summary over-claim | **kept, budget-bounded** | shared budget; echo appended | comment at the site | gate-audit #10 (sound) |
| acceptance-present / acceptance-demonstrated | **kept, budget-bounded** | rejections echo received params; identical retries get the escalated diagnostic; shared budget of 3 | `finish-guard-logic.js` header | P47 request 141 ($4.75, five identical rejections) |
| malformed finish call | **new rejection, not a new check** | a parameter value containing `</summary>`/`</parameter>`/`<parameter ` rejects as a malformed CALL, quoting the fragment. Subsumes payloads that previously failed acceptance-present with a misleading message — no payload that used to pass can now fail | `finish-guard-logic.js` header | request 141's exact payload shape (now the regression fixture) |
| finish budget exhaustion | **new conclusion path (demotion, not a check)** | after 3 real rejections (identical repeats counted once) the cycle CONCLUDES: checkpoint, operator summary, pending-verification terminal, harness-triage flag. Replaces the unbounded reject→no-progress-breaker→awaiting_admin strand | `finish-guard-logic.js` header | request 141 ended `awaiting_admin` with all work complete and stranded |
| harness-fault halts | **demotion of halt validation** | a halt asserting a harness fault, with rejection history consistent, is accepted as-is and flagged for triage — no options re-litigation | `finish-guard-logic.js` | request 141's halt was rejected for lacking 2–4 options |
| smoke: platform baselines | **demoted from failing to shipped** | a cycle whose only smoke failures are platform-owned concludes **"Shipped — platform checks failing (not yours)"**: deploy kept, no retry implied, triage flag raised. Results tagged `[platform check]` and grouped after app-owned ones everywhere | `ui-check-logic.js` + the runner branch | P47 request 140 ($10.28 / 3 cycles against unfixable platform checks) |
| smoke: app-owned failures | **new honesty floor (required by the redesign brief §2c)** | an empty-product-diff finish after an app-owned smoke failure in the same request must name each failing check (fix it or answer it) — enforced through the shared budget, so it can never loop | `unansweredSmokeFailures` in `ui-check-logic.js` | P47 request 140: notes-todo-add ignored under platform noise while cycles claimed "no product change needed" |
| `acceptance_ids` forced-run | **kept** | unchanged (declare-fewer-ids perversity noted in the map, unaddressed by design — pairing it with a floor would be a new check) | — | gate-audit #14 |
| design review | **redesigned** | demo content seeds before capture (idempotent) and the review records whether it ran; RESTRAINT category + `kind: add\|subtract` findings rendered `[sev·simplify]`; Fix-these composer groups by screen at ≤500 chars/group, referent-anchored; per-group tick/untick in the dialog | comments at each site | pipeline-walkthrough #6; gate-audit structural finding #1; P34 median 170-char requests |
| inventory extraction | **redesigned (prompt)** | action labels are 2-3 word capability names, with the why (labels become contract strings) stated in the prompt | in the prompt text | P47's "Edit note title/body" contract string |
| build prompts | **rewritten** | shared `BUILD_CONTRACT_SECTION` in both builders (capabilities, restraint, conditional badge, rejection handling); vague/specific pre-pass classification now reaches the build task; MVP seed rewritten as the numbered contract; quick seed gains SPECIFIC-MEANS-LITERAL; mockup prompt gains thin-vs-specific | section headers | P34 vs P47 comparison in the redesign brief |

## Blocking-check count

Gates: **15 before, 15 after** (two redesigned, none added, none newly
blocking; design-adherence now blocks on strictly fewer shapes — only
current-cycle drift — and stays advisory in quick).
Finish handshake: five validators before, each able to reject independently
(three of them unboundedly, until the no-progress breaker stranded the cycle);
after: the same validators plus the malformed-call and smoke-answer
conditions, **all sharing one budget of 3 rejections total** — the worst-case
number of blocking round-trips per cycle went from unbounded to 3.
Smoke: one blocking outcome (baseline-only failure) demoted to a shipped
conclusion. Net: total blocking surface decreased.

## Where the docs said something the code contradicted

Stated here per the redesign brief (Phase 3.3), rather than silently deferring:

1. **`docs/pipeline-walkthrough.md` marks `component-reuse` 📋 advisory.**
   False — the script exits 1 and nothing wraps it advisory; it blocks in the
   full profile.
2. **`pipeline-walkthrough` says the five finish validators "each reject
   once".** False before this branch: acceptance-present/-demonstrated and
   over-claim rejected unboundedly (request 141's five rejections were all one
   validator); only removal and parity were once-each. True *bound* now: 3
   shared.
3. **The redesign brief's own premise "auto-retries changed nothing" (request
   140).** Smoke retries were never automatic — "Continue build" is
   operator-driven; only transient model-call failures auto-retry (2×). The
   fix (conclude-shipped on platform-only failures) removes the *invitation*
   to retry rather than a retry loop.
4. **`gate-audit.md` claims the 2026-07-28 baseline-check fixes made
   baseline-only failures legible.** True but incomplete — the report changed,
   the outcome didn't: the cycle still finished `failed` until this branch.
5. **`design-review.js`'s "≤ 6 shots per review" header comment** predates the
   screen-panel capture and is stale (up to 4 panels per route now ride).
6. **`cycle-logic.js`'s header "Fast modes run NO gate battery at all"** is
   stale — profiles have run cumulative batteries since the LEARNINGS-21 fix.

## Test evidence added in this branch

- `mock2-finish-guard.test.js` — request 141's malformed payload as fixture:
  detection, echo, escalated diagnostic, shared-budget exhaustion, harness-
  fault halts (18 tests).
- `mock2-smoke-signal.test.js` — request 140's result shape: grouping,
  tagging, platform-only detection, the no-product-change honesty floor.
- `mock2-ui-interaction-gate.test.js` — the real gate under `sh` in a real git
  repo: P47's sw.js/build-id shape (exempt), glob-only coverage red,
  new/changed assertions green, pre-existing coverage cheap.
- `mock2-baseline-gates.test.js` / `mock2-design-adherence.test.js` — drift
  scoring: breadth can no longer block; token-clean invention passes clean
  (the small-app-scores-clean requirement); hardcoded invention and re-made
  components block with offenders named; P36/38/39 shapes still red.
- `mock2-design-review.test.js` / `mock2-findings-parse.test.js` — seed-
  before-capture order, subtractive kind round-trip, ≤500-char group requests.
- `mock2-build-contract.test.js` — prompts and checks tell the same story
  (both builders carry the contract verbatim; specificity reaches the task).

Full suite: 1776 pass / 6 fail — the six failures are the pre-existing
sandbox `ERR_MODULE_NOT_FOUND` files documented in `CLAUDE.md` and
`docs/known-issues.md`, untouched by this branch.
