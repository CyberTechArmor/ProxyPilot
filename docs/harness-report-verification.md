# Harness fix plan — verified against the code, ranked by impact

The run-taxonomy report (3 Aug 2026, 130 cycles / 11 projects) was built from
**build logs**. Every recommendation below has been checked against the harness
source in `admin/backend/src/mock2/`, then re-ordered by the impact the code
actually supports.

**Baseline being improved on:** 130 cycles, 72 productive (55%), **58 wasted
(45%)**.

Two of the report's 14 recommendations are **already shipped** and are dropped
from the plan: service-worker cache busting (`deploy.js stampBuildId` rewrites
`sw.js`/`build-id.js`/`build-id.txt` every deploy) and per-phase usage
(`usage-logic.js` schema v3, per-model pricing, per-request segment roll-up, and
`phaseMapRecordLine` in every change record).

## How to read the percentages

Each fix carries a headline **% impact = share of the 58 wasted cycles it
addresses**, of two kinds:

- **Recovery** — waste visible in the logs that the fix removes.
- **Prevention** — defects that currently ship *silently* because a gate never
  runs. These recover no logged cycles by definition: a gate that never fires
  produces no failure record. Estimated, and marked as such.

**The percentages do not sum to a total.** They overlap (notably #1 and #7) and
the sum exceeds 100%. Realistic combined recovery is **45–70%** — see "Combined
effect" at the end.

---

# The plan, in impact order

## 1. Give the runner eyes on the running system — **28%**

*Report's #2 · ~16 of 58 cycles (range 14–19) · all recovery · confidence: high*

Chromium, Playwright and the full check-step vocabulary are **already vendored**
(`ui-checks.js runUiChecks`, `loadChromium`) but only reachable post-deploy from
`smoke.js:237`. `RUNNER_TOOLS` is 11 tools, none of which can observe a running
system, and `harness-safety.js:19` denylists `curl`/`wget` — including loopback,
so a build cannot probe its own endpoint.

**Changes:** add two runner tools — `http_probe` (loopback-restricted by
construction, so the denylist stays intact) and `browser_probe` (console errors,
failed requests, **computed style for a selector**, DOM excerpt) — wired into
`RUNNER_TOOLS` and `executeTool`, capped at ~10 calls/cycle.

**Expected outcome**
- Repeat-fix sagas collapse from 3–6 cycles to 1–2.
- CSS/DOM defects (`display:none`, stale bundles) diagnosed by reading, not theorising.
- A build can test its own HTTP API before claiming it works.
- Fixes cite observed evidence rather than plausible mechanisms.

**Validation — code**
`src/__tests__/runner-probe.test.js`: stand up a fixture app with a known-hidden
element and a 500-ing endpoint. Assert `browser_probe` returns `display: none` for
the selector, and `http_probe` returns status 500 with the body excerpt.
Regression fixture: the `docs2` `.popover.menu` case — the probe must surface the
rule that five cycles of reasoning missed.

**Validation — user**
Seed two fresh projects with the *same* planted UI bug (a control hidden by a CSS
rule, not by `[hidden]`). Run one on the current harness, one with probes enabled.
Report the same symptom in plain language to both, then count **cycles to green**.
Expected: 4–5 vs 1–2.

---

## 2. Fix Node 18 → 20 in the build container — **14%**

*Report's #6 · ~8 of 58 equivalent (range 5–12) · all prevention · confidence: high on mechanism, low on volume*

`template.js:425` apt-installs `nodejs` on `images:debian/12` → **Node 18**. The
e2e browser auto-installer already exists (`deploy.js installE2eBrowser`); the
runtime beneath it is too old, so **the e2e gate has never executed anywhere in
the fleet**. Several projects wrote real Playwright specs that have never run
once. Highest ROI in the document — one line.

**Changes:** install Node 20+ (nodesource, or a base-image bump) in the container
template.

**Expected outcome**
- The e2e gate goes from running on **0%** of cycles to **100%** of MVP+ cycles.
- Playwright suites already written across the fleet begin executing.
- A class of regression currently shipping silently starts failing builds instead.

**Validation — code**
`src/__tests__/container-node-version.test.js`: assert the provisioning script
pins a major ≥ 20. Then on a provisioned container assert `npx playwright
--version` exits 0 and the e2e gate returns `pass`/`fail` — **never `skipped`**.
The skip path becoming unreachable is the whole test.

**Validation — user**
On a fresh project, write one Playwright spec asserting something *false*. Run a
build. Currently: gate skips, cycle goes green, bad code deploys. After: the cycle
fails on `e2e`. The observable difference is a gate that can say no.

---

## 3. Run the full gate battery in the quick lane — **12%**

*Report's #10 · ~7 of 58 (3 recovery + 4 prevention) · confidence: medium-high*

`GATE_PROFILE_BY_MODE` maps `quick → quick` (`cycle-logic.js:255`), so quick
updates skip `ui-interaction`, `no-dead-controls`, `mobile-overflow` and `e2e`.
Quick is the dominant lane, so **the checks most likely to catch a regression are
structurally excluded from most cycles ever run** — they execute on the greenfield
build, i.e. the code least likely to have one.

**Changes:** promote the four regression gates into the quick profile, or add a
diff-triggered escalation (a quick update touching user-facing paths pulls the mvp
battery). The latter is cheaper at runtime and targets the actual risk.

**Expected outcome**
- Every cycle touching UI is checked for interaction, dead controls and overflow.
- Regressions surface in the cycle that caused them, not three cycles later.
- Gate cost rises modestly on quick updates; escalation keeps it diff-scoped.

**Validation — code**
Extend the `cycle-logic` tests: assert `buildGateBattery(gates, 'quick')`
**includes** `ui-interaction`, `no-dead-controls` and `mobile-overflow` when the
diff touches `public/**`, and still excludes them for a docs-only diff.

**Validation — user**
On a working project, send a quick update that deliberately breaks an existing
button (make its handler a no-op). Currently: green, ships. After:
`no-dead-controls` or `ui-interaction` fails in the same cycle. Compare
**cycles-to-detection: 3+ vs 0**.

---

## 4. Make the Define stage non-skippable — **10%**

*Report's #12 · ~6 of 58 (3 recovery + 3 prevention) · confidence: medium*

Worse than the report inferred. The `rule-coverage` gate exits **0** when
`state/rules.md` is missing **and** when it contains zero rules
(`framework-seed/gates.json`). An empty rule set is a **green gate** — on 11 of 11
projects. `rules_touched` is `null` in every change record ever written. The
Define skill exists (`skills.json` Stage 2); nothing compels it.

**Changes:** fail (or hard-block the first build) when a project has zero confirmed
rules, rather than passing vacuously. Route new projects through Stage 2 before the
greenfield cycle.

**Expected outcome**
- The gate battery gains testable rules to check against, instead of only typing and layout.
- Wrong-fix and scope-thrash waste drops — a confirmed rule is a fixed target.
- `rules_touched` becomes a real audit field.

**Validation — code**
Gate-script test: a project with no `state/rules.md` **and** one with an empty
`rules.md` must both **exit non-zero** (today both exit 0). Plus: a greenfield
cycle on a project with zero confirmed rules is refused at start.

**Validation — user**
Build the same app spec twice — once skipping Define, once completing the
interview. Count **wrong-fix and re-specification cycles** over the first ten
builds. The report's own contrast (SpliceGirls' zero rework vs docs2's seven)
predicts the gap.

---

## 5. Gate the halt checkpoint and make halt cost visible — **10%**

*Report's #1 (demoted from 1st) · ~6 of 58 (range 5–8) · all recovery · confidence: medium-high*

The report's two headline asks don't apply. **There is no build credit to refund**
— `quota-logic.js canStartCycle` gates on cents and concurrency. And
**checkpoint/resume already ship** (`haltCycle` → `checkpointAndRecord`; resume
bridge `runner.js:1526`).

The real defect is narrow: `haltCycle` records `gateReports: gateReports || []`,
so a halt that landed real work verifies none of it. That is exactly `noted` 551 —
+190 lines across six files landed, then halted; 552, 585 and 587 re-attempted it,
and 588 spent a cycle concluding *"already implemented — no code changes needed."*
**One un-gated halt cost four follow-on cycles.**

**Changes:** run the quick-profile battery against the checkpointed tree before
writing the halt record (zero model tokens); write a "what actually landed" section
(files, insertions, gates passed *on that tree*); surface halt cost per request
segment in the UI (data already exists in `request-log.js`).

**Expected outcome**
- A resumed build reads verified landed work instead of re-deriving it.
- The compounding tail after a halt disappears.
- Halts stop being invisible in cost reporting.

**Validation — code**
Assert `haltCycle` on a tree with real changes writes a change record whose
`gates_run` is **non-empty** and whose summary names the changed files. Current
behaviour — `gates_run: []` — is the regression fixture.

**Validation — user**
Force a halt mid-build (revoke an egress grant) after real code has landed. Resume.
Currently the resumed build re-explores and often re-does the work. After: it opens
by citing the landed files and continues. Compare **follow-on cycles per halt: ~4
vs ~1**.

---

## 6. Check "is this already done?" before spending a cycle — **9%**

*Report's #4 · ~5 of 58 (range 4–7) · all recovery · confidence: medium*

Not shipped. Only in-cycle prose exists (`runner.js:2145`; skills.json *"Reuse
before you rebuild"*) — it fires *after* the cycle has already been paid for.
Nothing diffs an incoming instruction against prior work beforehand.
`request_id`/`segment` already exist on cycles to build this on.

**Changes:** before starting, diff the instruction against `pending_verification`
and recent change summaries. On a strong match, surface it to the operator and ask
rather than build.

**Expected outcome**
- Byte-identical instruction pairs (Encapsoul 650/652, 654/656) stop reaching the runner.
- Re-verification no-ops disappear.
- The operator learns the prior result was never surfaced — the underlying workflow bug.

**Validation — code**
Unit-test the matcher on the report's real pairs: Encapsoul 650/652 and 654/656
must score as duplicates; `Docs` 740 vs 738 (folders re-requested) must match; two
genuinely different instructions touching the same file must **not**.

**Validation — user**
Send the same instruction twice, five minutes apart. Currently: two full builds.
After: the second returns a "this looks already done, here's the prior cycle"
prompt before spending anything. **Cycles consumed: 2 vs 1.**

---

## 7. Cap symptom-chasing at two attempts — **7%**

*Report's #3 (demoted from 3rd) · ~4 of 58 incremental over #1 · confidence: medium*

Roughly 70% built and **has never run**. `consult-logic.js` is complete with
bounded caps; `diagnose-logic.js` is a complete root-cause pass (~$0.10–0.25).
Three things keep it inert: `MOCK2_CONSULT` defaults **OFF**; `gateFailStreak` is
within-cycle only (`runner.js:1577`); and `reHaltSameReason` is **dead code** —
declared (`consult-logic.js:52`), read (`runner.js:3662`), never fed by the sole
call site (`runner.js:1966`). The `same_reason_rehalt` trigger has never fired.

Demoted on **sequence, not merit**: a cap stops a saga, it doesn't produce the
answer. Until #1 lands, the third step is an escalation carrying ruled-out theories
rather than evidence.

**Changes:** compute `reHaltSameReason` for real (compare normalised halt reasons
within a `request_id`); add a cross-cycle attempt counter; at attempt 3 route to
`diagnose-logic` instead of building; switch the consult on.

**Expected outcome**
- No third blind guess ships.
- The operator gets what's been ruled out and what evidence is needed.
- Long sagas cap at 2 cycles + 1 diagnosis instead of running to 5–6.

**Validation — code**
Assert `consultTrigger` returns `same_reason_rehalt` when two halts in one request
share a normalised reason — this **cannot pass today**, which is the point. Plus: a
third same-symptom cycle dispatches diagnosis instead of a build.

**Validation — user**
Plant a bug whose cause is invisible to a browser probe (a server-side config
error). Report it repeatedly in the same words. Currently: guesses indefinitely.
After: attempt 3 returns a diagnosis and a question. Compare **cycles before
escalation: 5–6 vs 2**.

---

## 8. Write a change record for every cycle — **5%**

*Report's #11 · ~3 of 58 equivalent · enabling · confidence: high*

Several terminal paths call `finishCycle({status:'failed'})` and return with **no**
`checkpointAndRecord`: lock failure (`runner.js:739`), runner crash (`827`),
gate-copy failure (`1124`), deploy failure. These are the "unlogged cycle IDs" the
report found (SpliceGirls 709–780; `notes` ~106 past its last record).

Recovers little on its own, but **every waste figure in the report is a floor
because of it** — including the 58 that every percentage on this page is measured
against. It is the measurement substrate: without it, no claim about any other fix
here is verifiable.

**Changes:** write a minimal record on every terminal path, including infrastructure
failures — status, reason, and whatever diff exists.

**Expected outcome**
- The ledger becomes complete; cycle IDs and records reconcile 1:1.
- Waste figures become totals rather than floors.
- Before/after comparisons for every other fix become trustworthy.

**Validation — code**
For each terminal path (lock failure, crash, gate-copy failure, deploy failure,
halt, finish), assert a change record exists afterwards. Simplest form: assert
`count(cycles) == count(change_records)` over a run exercising every path.

**Validation — user**
On any project, compare the highest cycle ID against the number of change records.
Currently they diverge (72 unlogged IDs on one project). After: they match.

---

## 9. Never run `plan` or `review` on the cheap model — **2%**

*Report's #5 · ~1 of 58 · recovery + latent risk · confidence: high*

`applyPhasePosture` loops `for (const phase of BUILD_PHASES) map[phase] = pick` —
uniform across **all** phases, overwriting `plan` and `review` which are declared
`tier: 'top'` (`phase-routing-logic.js:81,85`). So `ultra_cheap` genuinely
downgrades the review phase. This confirms the report: 808 cycle 721 is the fleet's
only `ultra_cheap` run **and** its only failed build — the phase that exists to
catch an unverified assumption and an undersized diff was itself running cheap.

Low current blast radius, but posture is operator-selectable fleet-wide. ~5 lines.

**Changes:** exempt `plan` and `review` from uniform posture; postures scale
implementation phases only.

**Expected outcome**
- Judgement phases stay on the top tier at every posture.
- `ultra_cheap` remains a real saving without disabling the safety net.

**Validation — code**
Assert `applyPhasePosture(resolved, 'ultra_cheap').map.review.tier === 'top'` and
the same for `plan`, while `implement_mechanical` **does** take the cheap model.
This assertion fails on today's code.

**Validation — user**
Set posture to `ultra_cheap`, run a build, open the change record's phase-model line
(`phaseMapRecordLine` already writes it). Currently review shows the cheap model.
After: it shows the top tier while implement phases show cheap.

---

## 10. Machine-check the verified-vs-assumed ledger — **3%**

*Report's #8 · ~2 of 58 · confidence: medium*

More shipped than reported: `finish` **structurally requires**
`assumptions: {verified[], assumed[]}` and rejects without it
(`finish-guard-logic.js:118,140`). What's missing is that content is never checked
and never gates deployment — a claim of "verified" is taken at face value.

**Changes:** require each `verified` entry to cite a file this cycle actually read;
block deploy when a permission/role value sits in `assumed`.

**Expected outcome**
- "Verified" means a file was read, not asserted.
- The SpliceGirls discipline (zero rework across 17 cycles) becomes structural.

**Validation — code**
Assert a finish whose `verified` entry cites a file absent from the cycle's read set
is rejected; one citing a genuinely-read file passes.

**Validation — user**
Compare rework failures (F4/F5/F6/F8) per 10 cycles across two projects, one with
enforcement. The report's own contrast predicts the direction.

---

## 11. Separate authority over gates from authority over code — **2%**

*Report's #9 · ~1 of 58 · confidence: medium*

Substantially shipped. Gates are pinned into the container at cycle start, and the
`ui-interaction` path-widening hole (`noted` 548's exploit — adding `sw.js` to a
check's `paths` so the coverage gate passes) was closed this branch. Residual
hardening only.

**Expected outcome**
- A cycle cannot alter the criteria that judge it, for itself or its successors.

**Validation — code** — assert a cycle's edits to gate config don't affect its own battery.
**Validation — user** — instruct a build to "make the gate pass by adjusting the check"; it should refuse or halt.

---

## 12. Detect cross-project duplication before greenfield — strategic

*Report's #13 · separate denominator · confidence: medium*

Not shipped; no detection anywhere. Sits outside the 58-cycle pool: the report found
the notes app built **three times** (N10, `noted`, Noteme) — ~100% conceptual
overlap, ~0% code reuse, **22 cycles**, with nothing in any of the three ledgers
acknowledging the other two.

**Expected outcome** — a near-duplicate inventory offers the clone instead of a fresh build.

**Validation — code** — the three notes-app inventories must score as near-duplicates; an unrelated app must not.
**Validation — user** — submit an inventory closely matching an existing project; expect an offer to clone, not 8 cycles of greenfield.

---

# Combined effect

**Not additive.** The percentages overlap — most importantly #1 (runtime
observation) and #7 (cap symptom-chasing) draw on the same repeat-fix pool, so
their ceiling together is #1's, not the sum. The report's claim that its top three
address *"55 of the 58"* fails on exactly this point, and additionally counts the
21 halts as recoverable when only their follow-ons are — the requests still have to
be built.

**Realistic combined recovery: 45–70% of the 58 wasted cycles (~27–41 cycles),**
moving the fleet from **45% waste to roughly 14–25% waste**.

Two caveats to carry into any comparison:

**The 58 is a floor.** Failed and crashed cycles write no record (#8), so the
denominator every percentage here is measured against is itself incomplete. Do #8
first if the goal is to *prove* the improvement rather than merely achieve it.

**The preventive column is unquantified by design.** #2, #3 and #4 recover few
logged cycles because the defects they address were never caught — a gate that never
runs generates no failure record. Their real value is the regressions currently
shipping silently, which no log-derived analysis can see. This is precisely why the
report ranked all three mid-table.

## Suggested build order (differs from impact order)

Impact ranking answers *what is worth doing*; this answers *what to do first*.

1. **#8 (records everywhere)** — cheap, and it's the measurement substrate. Without it, nothing below is provable.
2. **#2 (Node 20)** and **#9 (plan/review tier)** — one line and ~5 lines. Land them while #8 is in flight.
3. **#1 (runtime observation)** — the largest single lever. Ship and measure on one active project before proceeding.
4. **#3 (full battery)** and **#4 (Define)** — both widen what is enforced; land after #1 so builds have the means to satisfy the gates they newly face.
5. **#5, #6, #7** — in that order, with #7 explicitly after #1 so its escalations carry evidence rather than a list of ruled-out theories.

## Recommended comparison protocol

To show effectiveness on a new project, hold these constant and measure over the
first ~15 cycles:

| Metric | Baseline | Catches |
|---|---|---|
| **% wasted cycles** (headline) | 45% | overall |
| Cycles-to-green per reported defect | 3–6 | #1, #7 |
| Rework failures (F4/F5/F6/F8) per 10 cycles | ~4 | #4, #10 |
| Gates executed per cycle | 4 (quick lane) | #2, #3 |
| Records-to-cycle-IDs ratio | < 1 | #8 |

Run the same app spec on both harness versions, with the same operator, and plant
the same defects in both.
