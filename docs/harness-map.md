# Harness map — every gate, validator, and smoke check

Produced for the 2026-07 harness redesign (Phase 0 of the redesign brief).
Every entry answers, per the standing rule in `docs/gate-audit.md`:

> **What is the cheapest thing a build can do to pass this, and what does the
> app look like when it does?**

All paths relative to `admin/backend/src/mock2/` unless noted. Line numbers are
from the tree at the time of writing (before the Phase-1 changes in this
branch); the Phase-1 changes are documented in `docs/harness-change-summary.md`.

## How a build runs (one paragraph)

`runner.js runCycle` seeds a task turn (`Task: <instruction>` + pre-pass brief
+ CRUD rules floor + feedback + design findings + assets — `runner.js:1023`),
loops model turns against the tool set in `runner-logic.js RUNNER_TOOLS`,
re-runs the gate battery on `finish`, then runs the finish validators, the
integration gate, checkpoint, deploy, smoke, the honest gate, and (via request
close / pending verification) the design review. Build modes select a gate
profile: **quick ⊂ mvp ⊂ full** (`cycle-logic.js gatesForProfile`).

---

## 1. Framework gates (`framework-seed/gates.json`, run pre-finish in-container)

Tier is inferred from the gate's name (`cycle-logic.js:265-281`); untagged
operator gates default to full-only.

| Gate | Profile | Blocking | Rejection (first line) | Cheapest pass → what the app looks like |
|---|---|---|---|---|
| `typecheck` | quick+ | 🔒 | `tsc --noEmit` output | Fix the types. **Sound** — app unchanged or better. |
| `constitution-lint` | full | 🔒 | `constitution-lint: FAIL — forbidden database/ORM import…` / hard-coded role literal | Follow the constitution (Postgres/Drizzle only, shared role constants). **Sound.** |
| `rule-coverage` | full | 🔒 | `rule-coverage: FAIL — N confirmed rule(s) but only M test block(s)` | Write `it()` blocks until the count matches. **Gameable by count** — tests need not test the rules; app unchanged. Low harm, low value. |
| `security-scan` | full | 🔒 | `security-scan: FAIL - committed private key material in <f>` | Don't commit secrets. **Sound** (v2 matches key bodies, not header strings — detector-evasion hole closed). |
| `test` | full | 🔒 | vitest output | Make tests pass. **Sound.** |
| `ui-interaction` | mvp+ | 🔒 | `ui-interaction: FAIL - user-facing file(s) with NO matching interaction check:` | **Was: add the touched path to an existing check's `paths` glob — zero new assertions, zero product change (P47 cycle 2 did exactly this and said so).** Redesigned in this branch: a touched user-facing file must be matched by a check that this same diff added or modified (its assertions must exist and parse); infrastructure files (sw.js, build-id, manifest) are exempt. |
| `acceptance` | full | 🔒 | `acceptance: FAIL - state/acceptance.json is missing or invalid…` | Write a plausible spec. Static half is **costly ceremony** for small changes; kept full-only, which is the right lane. |
| `component-reuse` | full | 🔒* | `component-reuse: FAIL - this change re-implements capability…` | Wire the installed component. **Sound** (waiver protocol exists; pipeline-walkthrough labels it advisory, but the script exits 1 — the doc is wrong, see §7). |

## 2. Baseline gates (`baseline-gates.js`, appended to every battery)

| Gate | Profile | Blocking | Cheapest pass → what the app looks like |
|---|---|---|---|
| `design-adherence` | quick (advisory in quick), mvp+ blocking | 🔒 from mvp | **Was: spray approved class names / variables to raise adoption counts — the headline `9 of 60 variables` punished every small app forever (P47).** Redesigned in this branch: scores **drift** (hardcoded color/spacing literals where a token exists; novel component CSS where an approved class covers the case), blocking only on drift introduced by the current cycle's diff. Shell checks (`--app-*` bridge, link order, dark theme) kept — they are direct defect detectors. |
| `platform-intact` | quick | 🔒 | Don't delete platform exports/files. **Sound** — kept untouched. |
| `signin-reachable` | quick | 🔒 | Mount your routers after the platform's. **Sound** — kept untouched. |
| `mobile-overflow` | mvp | 🔒 | Make it fit (escape hatch: `overflow:hidden` hides content — known, unfixed, noted). **Sound enough.** **2026-08 (project 55):** width detection is now per DECLARATION — it used to grep the line then test every number on it, so a minified stylesheet failed on `border-radius:999px` while reporting `.bar{width:130px}`. |
| `no-native-dialogs` | mvp | 🔒 | Use `pp.confirm`/`pp.prompt`. **Sound** — kept untouched. |
| `no-dead-controls` | mvp | 🔒 | Badge everything "Not built yet". **Harmful in combination** with action parity (see §3): the pair read as "render every contract action, badge the rest". This branch: scope stated in-file — the gate applies only to controls the build *chose to render*; it never asks for a control to exist. Pair reasoning written into both files. |
| `e2e` | mvp | 🔒 | Pass your own Playwright suite (skips green when tooling absent). **Sound** — kept untouched. |

## 3. Finish-time validators (`runner.js`, on the `finish`/`pending_verification` tool call)

Before this branch: five validators, each able to reject independently
(acceptance-present and acceptance-demonstrated unlimited until the no-progress
breaker at 3 stale turns; over-claim unlimited; removal and parity once each).
**After this branch: one shared budget of 3 real rejections across all of
them** (`finish-guard-logic.js`), identical retries diagnosed and counted once,
exhaustion concludes the cycle with a checkpoint + operator summary (status
`awaiting_user` / pending-operator-verification — never a stranded
`awaiting_admin`).

| Validator | Rejects when | Exact rejection (first words) | Cheapest pass |
|---|---|---|---|
| malformed-call *(new)* | a parameter value contains `</summary>`, `</parameter>`, or `<parameter ` | `Not finished — this finish call is MALFORMED: the \`summary\` parameter value contains tool-call syntax…` (quotes the fragment + where) | Send one well-formed call — the desired behavior. Request 141's payload shape is the regression fixture. |
| acceptance-present | `acceptance` empty or `assumptions` missing | `Not finished: finish requires \`acceptance\` (≥1 human-runnable check…` + **echo of received params** | Write acceptance prose. **Costly** (produces no product) — hence the shared budget. |
| acceptance-demonstrated | `acceptanceVerdict` fails (bugfix without observed red test, missing/stale spec) — full builds only, MVP exempt | `Not finished — acceptance not demonstrated:` + reasons | Write a plausible spec / reword. Empty verified diff short-circuits to ok. |
| summary-overclaim | summary names files this cycle didn't change | `Not finished — the summary names files this cycle did NOT change (…)` | Shorter accurate summary. **Sound.** |
| removal-claims | UI removal claimed with no check that could fail (once, then warn) | `Not finished — this summary claims something was removed, and nothing would catch it if it were still there.` | Add `expect_absent`/`expect_no_scroll` or withdraw the claim. **Sound**, budget-bounded. |
| action-parity | inventory mutation action reachable nowhere (once, then warn; initial-inventory build only) | `Not finished — action parity: a user has no way to perform these actions…` | See §gate-audit #12. The two-word core + hidden rejection **did land** (verified: `acceptance-logic.js actionLabelCore` returns `words.slice(0,2)`; hidden-only probe in `acceptance-logic.js actionParityProbeScript`; message states capabilities-not-copy). This branch adds: menu items and secondary surfaces explicitly count; the message never implies a top-level control. **2026-08 (project 55):** the hidden-only test was a whole-line `grep -vc 'hidden'`, so a one-line renderer whose collapsed menu carries `class="menu hidden"` — or a minified stylesheet carrying `overflow:hidden` — read as hidden-only and rejected a working overflow menu three times, ending the build. The probe now excludes stylesheets, matches `hidden` as a token, and treats a surface the app opens (classList/removeAttribute/`<details>`/popover) as reachable. |
| gates-not-green | battery not green on finish | `Gates are not all green yet — you cannot finish.` | Fix the gates. Not part of the shared budget (it is the gates speaking, not a prose validator). |
| integration gate | fabricated data / undeclared egress / stub | `Cannot finish — …` → halt as blocked deviation | Real code. **Sound.** |

## 4. Smoke (post-deploy, `smoke.js` + `ui-check-logic.js` + `ui-checks.js`)

- **HTTP layer** (always): shell serves, `/login` renders, spoofed-identity
  headers not honored. Sound.
- **Browser connector** (on diff/meta trigger or required acceptance ids): runs
  the union of diff-matched `state/ui-checks.json` checks ∪ `acceptance_ids` ∪
  removal check ids ∪ **platform baseline checks** (`platform-baseline-*`:
  signin-legal, app-shell, admin-reachable, viewer-not-offered-admin,
  viewer-denied-admin). A required id with no defined check is a hard failure
  (cheapest pass: declare fewer ids — mildly perverse, unchanged this branch).
- **DB connector** (migration-touching diffs): full chain onto a scratch DB +
  boot. Sound.
- **Retries are NOT automatic.** The operator presses "Continue build". P47's
  "$10.28 / 3 cycles" was three operator-driven cycles against failures that
  could not change.
- **Platform-owned vs yours**: results carry `baseline: true`; `baselineOnly`
  detection and `baselineBlockedMessage` landed 2026-07-28 (verified). **But
  the cycle still concluded `status: 'failed'`** (`runner.js:2052`). This
  branch: a cycle whose only smoke failures are platform-owned concludes
  **shipped — pending verification, "platform checks failing (not yours)"**,
  deploy kept, no retry implied; app-owned failures are listed first in the
  fail summary; and a follow-up cycle answering an app-owned smoke failure
  cannot claim "no product change needed" without naming the failing check.

## 5. Design review (`design-review.js` / `design-review-logic.js`)

- Capture: 4 routes max, mobile+desktop on the first two, plus up to 4
  `section[data-screen]` panels per route at mobile width — **the 2026-07-28
  screen-panels fix did land** (verified at `design-review.js:379-412`,
  `MAX_SCREEN_PANELS=4`).
- **Demo/seed content did NOT run before the review** (verified: the only
  `seedDemoContent` call site was the operator button,
  `routes.js POST /app-access/demo-content`). Every automatic review critiqued
  a near-empty app. Fixed in this branch: the after-build chain seeds demo
  content (idempotent, marker-guarded) before capture, and the review output
  records whether it ran.
- Review prompt categories (FIDELITY, CRAFT, STATES, DENSITY & POLISH, MOBILE)
  were **all additive** — density signals only fire `screen-empty` /
  `low-density`; there was no "too dense" finding type at all. Fixed in this
  branch: a subtractive finding type (`remove / simplify / too dense`) with
  severity.
- Findings → fix request: the "Fix these" button parses the chat message back
  into findings (frontend `lib/findings.js composeFixInstruction`), all ticked
  by default, per-finding checkboxes, posts as an ordinary quick update. Worst
  case ~7KB of instruction. This branch: findings are offered per-finding or in
  small related groups, and each group's generated request stays short and
  referent-anchored (≤500 chars per group — the P34 instruction shape).
- `checkDesignAdherence` (review-side twin of the gate) measured breadth
  (coverage ratios); it is advisory and reported in chat.

## 6. Inventory extraction (`concept-logic.js buildInventoryExtractionPrompt`)

`actions[].label` was "the button/link text" — verbose mockup captions became
contract strings the parity gate greps for ("Edit note title/body"). This
branch: labels are short capability names (2–3 words), and the prompt says why
(labels become contract strings, matched as capabilities, not copy).

## 7. Phase-0 verification against the operator's docs (true/false)

| Claim | Verdict |
|---|---|
| gate-audit: action parity fixed 2026-07-28 (two-word core, hidden rejected + named, capabilities-not-copy message) | **TRUE** — `acceptance-logic.js:437-440` (`slice(0,2)`), hidden-first grep + separate hiddenOnly log in `runner.js`, message text verified. |
| gate-audit: screenshot MAX_PATHS/data-screen panels fixed | **TRUE** — `design-review.js:70-71, 379-412` (commit 8eb1315, 2026-07-28). The header comment "≤6 shots" is stale. |
| gate-audit: baseline-check fixes (admin-reachable via shell contract; signin-legal detail; baseline-only detection) | **TRUE** — `shell-contract-logic.js` steps, `ui-check-logic.js baselineOnlyFailure/baselineBlockedMessage`, wired in `runner.js:2026-2048`. **But** the cycle still fails (`status:'failed'`) on baseline-only smoke — the report changed, the outcome didn't. Fixed in this branch. |
| Finish parse: what happens to a parameter value containing `</summary>` / `<parameter` | Tool calls arrive as structured `tool_use` blocks (`model-client.js:183-193`); a value carrying tool-call syntax passed straight through `parseFinishShape` into the summary, and `acceptance` was simply absent — no detection anywhere. The rejection did not echo received input. **Request 141's diagnosis confirmed**; fixed in this branch. |
| Any validator echoes received input in its rejection | **FALSE** before this branch — none did. Now all finish rejections do. |
| Smoke retries automatic? | **FALSE** — operator-driven ("Continue build", `routes.js:597`). Only transient *model-call* failures auto-retry (2 retries → `escalateAwaitingAdmin`). |
| Demo/seed content runs before design review | **FALSE** before this branch — operator button only. Fixed. |
| How design findings become the "Fix these" request | Frontend `composeFixInstruction` (chat-parsed, all-ticked-by-default, quick lane with `skipSplit`/`skipSuggest`); backend `composePolishInstruction` only on the `apply=true` polish path. |
| pipeline-walkthrough: `component-reuse` marked 📋 advisory | **FALSE** — the script exits 1 and nothing wraps it advisory; it is blocking in the full profile. |
| pipeline-walkthrough: "Five validators, each rejects once" | **Imprecise** — acceptance-present/demonstrated/over-claim rejected unboundedly until the no-progress breaker (3 stale turns) tripped to `awaiting_admin`; only removal and parity were once-each. That is exactly how request 141 got five rejections. |
| gate-audit: "not one gate can say this screen has too much on it" | **TRUE** — verified across the review prompt, density signals (floor-only), and every gate. Fixed via the subtractive finding type. |
| No gate file carried a cheapest-pass note | **TRUE** — zero matches repo-wide before this branch. Every gate/validator touched by this branch now carries one in its own file. |

## 8. The request-141 strand, precisely

The finish rejections (`acceptance-present`) repeated because the model's call
was malformed (summary contained the serialized rest of the call); the
no-progress breaker (`NO_PROGRESS_LIMIT=3` stale turns — identical finish calls
have identical tool signatures) then routed the cycle to `haltCycle` → status
`awaiting_admin`, after the model's own halt (correctly asserting a harness
fault) was rejected by `validateHaltOptions` for lacking 2–4 resolution
options. Work checkpointed but never deployed, never summarized to the
operator. Every element of that chain has a fix in this branch: malformed-call
detection, received-params echo, identical-retry diagnostic, shared budget with
a checkpoint-and-summarize conclusion, and harness-fault halts accepted as-is
and flagged for triage.
