# Run-taxonomy report — verified against the code, and re-ranked by impact

The run-taxonomy report (3 Aug 2026, 130 cycles across 11 projects) was built
from **build logs**. This document checks each of its 14 recommendations against
the harness source in `admin/backend/src/mock2/`, and re-orders them by the
impact the code actually supports.

The report's failure taxonomy is sound — its evidence lands on real lines, and
two of its quoted strings are verbatim from this tree. Its *ranking* is not.
Reading from logs, it could see what happened but not what already exists, so it
ranks two already-shipped fixes near the top, ranks a one-line fix at #6, and
buries the two gates that are silently inert on every project in the fleet.

---

## Verification — all 14 recommendations against the source

| # | Recommendation | Code verdict |
|---|---|---|
| 1 | Stop billing halts; make resumable | **Half shipped.** Checkpoint + resume already work (`haltCycle` → `checkpointAndRecord`; resume bridge `runner.js:1526`). No per-cycle credit exists to refund — `quota-logic.js canStartCycle` gates on **cents + concurrency**. Real gap: halts record `gateReports: gateReports \|\| []`, so landed work is verified by nothing. |
| 2 | Runtime observation | **Not shipped.** Chromium/Playwright and the full step vocabulary are vendored (`ui-checks.js runUiChecks`, `loadChromium`) but only reachable post-deploy (`smoke.js:237`). `RUNNER_TOOLS` is 11 tools, none observe a running system. `harness-safety.js:19` denylists `curl`/`wget` including loopback. |
| 3 | Cap symptom-chasing at two | **~70% built, inert.** `consult-logic.js` is complete with bounded caps. But `MOCK2_CONSULT` defaults **OFF**; `gateFailStreak` is within-cycle only (`runner.js:1577`); and `reHaltSameReason` is **dead code** — declared (`consult-logic.js:52`), read (`runner.js:3662`), never fed by the sole call site (`runner.js:1966`). `diagnose-logic` fires only on smoke failure (`runner.js:410`). |
| 4 | "Is this already done?" pre-check | **Not shipped.** Only in-cycle prose (`runner.js:2145`, skills.json *"Reuse before you rebuild"*). Nothing diffs an incoming instruction against prior work before spending the cycle. |
| 5 | Never run plan/review cheap | **Not shipped — but a ~5-line fix.** `applyPhasePosture` loops `for (const phase of BUILD_PHASES) map[phase] = pick`, overwriting `plan` and `review` which are declared `tier: 'top'`. `ultra_cheap` genuinely downgrades the review phase. |
| 6 | Node 18 → 20 | **Not shipped — genuinely one line.** `template.js:425` apt-installs `nodejs` on `images:debian/12` → Node 18. The e2e browser auto-installer exists (`deploy.js installE2eBrowser`); the runtime under it is too old, so the gate skips green everywhere. |
| 7 | Bust service-worker cache | ✅ **SHIPPED.** `deploy.js stampBuildId` rewrites `sw.js` / `build-id.js` / `build-id.txt` every deploy; `deploy.js:192` documents this exact failure mode. |
| 8 | Verified-vs-assumed mandatory | **Mostly shipped.** `finish` structurally requires `assumptions: {verified[], assumed[]}` and rejects without it (`finish-guard-logic.js:118,140`). Content is **not** machine-checked and does **not** gate deployment. |
| 9 | Separate gate authority from code | **Mostly shipped.** Gates are pinned into the container at cycle start; the `ui-interaction` path-widening hole (the `noted` 548 exploit) was closed this branch. |
| 10 | Run the full battery every cycle | **Not shipped — by design.** `GATE_PROFILE_BY_MODE` maps `quick → quick`. Quick updates therefore skip `ui-interaction`, `no-dead-controls`, `mobile-overflow` and `e2e`. Exactly as the report describes. |
| 11 | A change record for every cycle | **Not shipped.** Many terminal paths call `finishCycle({status:'failed'})` and return with **no** `checkpointAndRecord`: lock failure (`739`), runner crash (`827`), gate-copy failure (`1124`), deploy failure. These are the "unlogged cycle IDs". |
| 12 | Make Define non-skippable | **Not shipped — and worse than reported.** The `rule-coverage` gate exits **0** when `state/rules.md` is missing *and* when it contains zero rules. An empty rule set is a **green gate**, on 11 of 11 projects. |
| 13 | Cross-project duplication detection | **Not shipped.** No detection anywhere in the tree. |
| 14 | Per-phase usage on the record | ✅ **SHIPPED.** `usage-logic.js` (schema v3, four token classes), per-model pricing (`quota-logic.js DEFAULT_MODEL_PRICES`), per-request segment roll-up (`request-log.js`), and `phaseMapRecordLine` writes the resolved model map into every record. |

**Drop #7 and #14 — both already ship.** That is 2 of 14 recommendations aimed at
solved problems, which is the expected cost of inferring from logs.

---

## Re-ranked by impact, based on the code

Two things the code reveals that the logs could not, and that drive the reorder:

- **Two gates are silently inert fleet-wide.** `rule-coverage` passes vacuously
  with zero rules (#12); `e2e` skips green because the container runs Node 18
  (#6). Neither has ever failed anything, on any project. The report saw their
  *symptoms* and ranked them mid-table.
- **Most cycles run with the regression gates off.** Gate profile is a pure
  function of build mode (#10), and quick updates are the dominant mode. The
  checks most likely to catch a regression are structurally excluded from the
  lane that produces most changes.

| Rank | Fix | Report's | Effort | Why the code moves it |
|---|---|---|---|---|
| **1** | **#2 Runtime observation** | 2 | Medium | Largest waste class (23 cycles) *and* cheaper than it reads — Chromium, Playwright and the step vocabulary are already vendored. The work is exposing two tools, not building infrastructure. |
| **2** | **#6 Node 18 → 20** | 6 | **One line** | An entire gate has never executed anywhere in the fleet. Projects wrote real Playwright specs that have never run once. Highest ROI in the list by a wide margin. |
| **3** | **#10 Full battery in the quick lane** | 10 | Low–medium | `GATE_PROFILE_BY_MODE` excludes `ui-interaction`, `no-dead-controls`, `mobile-overflow` and `e2e` from the quick lane — i.e. from most cycles ever run. |
| **4** | **#12 Define non-skippable** | 12 | Medium | The rule-coverage gate is a **no-op on every project**: no rules → `exit 0`. This is upstream of the specification-failure waste (wrong fix, scope thrash, reverts) that #2 and #3 cannot touch. |
| **5** | **#11 A record for every cycle** | 11 | **Low** | ~6 early-exit paths write nothing. This is the measurement substrate — without it, no claim about any other fix is verifiable. Cheap, and it gates trust in everything else. |
| **6** | **#5 Never run plan/review cheap** | 5 | **~5 lines** | Exempt `plan`/`review` from uniform posture in `applyPhasePosture`. Small current blast radius (1 logged cycle) but a live landmine: posture is operator-selectable fleet-wide. |
| **7** | **#1 Halt gating + cost visibility** | **1** | Low–medium | Demoted. Checkpoint/resume already ship and there is no credit to refund. What remains is real but narrow: gate the halt checkpoint, and make halt cost visible. |
| **8** | **#3 Cap symptom-chasing** | 3 | Low (activate) | Demoted on *sequence*, not merit: 70% built and cheap to switch on, but its escalations are weak until #2 gives them evidence to carry. |
| **9** | **#4 "Already done?" pre-check** | 4 | Medium | Unchanged. 9 cycles, genuinely absent, moderate effort — `request_id`/`segment` already exist to build on. |
| **10** | **#8 Assumption content-check** | 8 | Medium | Structure ships; content and deploy-gating do not. Smaller delta than the report implies. |
| **11** | **#9 Gate authority** | 9 | Low | Substantially shipped. Residual hardening only. |
| **12** | **#13 Cross-project dedup** | 13 | High | Unchanged. Strategic, expensive, low frequency. |
| — | ~~#7 service-worker cache~~ | 7 | — | Already shipped. |
| — | ~~#14 per-phase usage~~ | 14 | — | Already shipped. |

### The four biggest moves

- **#6 up four places** (6 → 2). The report treated a dead gate as a tooling
  annoyance. It is the cheapest fix in the document and it restores a whole
  verification layer fleet-wide.
- **#12 up eight places** (12 → 4). The report inferred Define was skipped. The
  code shows the gate that should enforce it *reports green when it is skipped* —
  a stronger and more systemic finding than the report made.
- **#10 up seven places** (10 → 3). Confirmed architecturally, not anecdotally.
- **#1 down six places** (1 → 7). Its two headline asks are respectively
  unimplementable (no credit model) and already done (checkpoint/resume).

---

## Revised impact estimate

The report claims its top three address **55 of 58** wasted cycles. That does not
hold on two counts: #3's 11 cycles are drawn from the same repeat-fix / wrong-fix
/ revert pool as #2's 23 (not disjoint — the ceiling for both is 23, not 34), and
the 21 halts are not recovered by not billing them, since the requests still have
to be built. Only the compounding follow-ons are recoverable.

Splitting **recovered logged waste** from **prevented future waste**, because the
two are not the same currency:

| Fix | Recovers logged waste | Prevents future waste | Confidence |
|---|---|---|---|
| #2 Runtime observation | **14–19** of 23 blindness cycles | High | High — every saga in the report ended on a read |
| #6 Node 20 | 0 (never logged as waste) | **High** — restores a gate that has never run | High — mechanism is certain, volume is not |
| #10 Full battery | 2–4 | **High** — most cycles currently ship un-gated | Medium-high |
| #12 Define enforced | 2–4 | **High** — upstream of spec-failure waste | Medium |
| #11 Records everywhere | 0 directly | Enabling — makes all other claims measurable | High |
| #1 Halt gating | **5–8** compounding follow-ons | Medium | Medium-high |
| #3 Cap chasing | **3–5 incremental** over #2 | Medium | Medium |
| #5 Plan/review tier | 1 | Medium — latent, operator-selectable | High |
| **Total** | **~27–41 of 58 (45–70%)** | | |

Two honest caveats on that range:

**Every waste figure in the report is a floor.** Because failed and crashed
cycles write no change record (#11), the denominator of 58 is itself incomplete.
This is why #11 ranks 5th despite recovering nothing on its own — it is the only
fix that makes the others measurable.

**The preventive column is where the real value sits, and it is unquantified by
design.** #6, #10 and #12 recover few *logged* cycles because the defects they
address were never caught — a gate that never runs generates no failure record.
Their value is the regressions that currently ship silently. The report could not
see this class at all, which is precisely why it ranked all three mid-table.

---

## Suggested sequence

**Week 1 — the cheap structural fixes** (#6, #11, #5). One line, ~6 call sites,
and ~5 lines respectively. Together they restore a dead gate, close the ledger,
and disarm the cheap-review landmine. Do #11 first so the rest is measurable.

**Week 2 — #2 runtime observation.** The single largest lever. Ship and measure
on one active project before proceeding.

**Week 3 — #10 and #12.** Both widen what is actually enforced; land them after
#2 so the builds have the means to satisfy the gates they will newly face.

**Then — #1, #3, #4** in that order. #3 specifically *after* #2, so its
escalations carry evidence rather than a list of ruled-out theories.
