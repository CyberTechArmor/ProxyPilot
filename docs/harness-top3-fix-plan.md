# Top-3 harness fixes — implementation plan and honest impact

Review of the run-taxonomy report (3 Aug 2026, 130 cycles across 11 projects)
against the harness as it actually stands in `admin/backend/src/mock2/`.

The report's closing recommendation is:

> **#1 (don't bill halts), #2 (give the runner runtime observation), and #3 (cap
> symptom-chasing).** Those three address 55 of the 58 wasted cycles between them.

That ordering is wrong and that number is inflated. The analysis underneath it is
sound — the failure taxonomy matches the code, and two of its quoted strings are
verbatim from this tree. But one of the three is already built, one rests on a
billing model this harness does not have, and the three overlap far more than the
arithmetic admits.

This document restates each fix against the real code, in the order they should
actually be done, and gives a defensible impact estimate.

---

## What the report gets right (verified against the tree)

The report is not guessing. Its evidence lands on real lines:

| Report claim | Where it is in the code |
|---|---|
| Every halt reads *"halt: the build reported it was blocked"* | `runner-logic.js:1466` — `case 'model_halt': return 'the build reported it was blocked'`, rendered by `haltCycle` as `summary: \`halt: ${haltReasonLabel(trigger)}\`` |
| *"this sandbox's terminal policy denylists any command containing 'curl'"* | `harness-safety.js:19` — `/\bcurl\b|\bwget\b/` in `DEFAULT_COMMAND_DENYLIST` |
| The runner reasons about behaviour instead of reading it | `RUNNER_TOOLS` (`runner-logic.js:26`) is 11 tools; none can observe a running system |
| `noted` 548 widened a gate's `paths` glob to pass it | Already fixed — `ui-interaction` now requires the check to be added/modified by the same diff (`docs/harness-map.md` §1) |

## What is already shipped

Two recommendations are substantially done, and one of the top three is half done:

- **Rec #14 (per-phase usage)** — `usage-logic.js` carries a versioned usage
  schema (`USAGE_SCHEMA_VERSION = 3`), the four canonical token classes,
  per-model pricing (`quota-logic.js DEFAULT_MODEL_PRICES`), and `request-log.js`
  rolls cost up per request *segment* (`define → build → halted → resumed →
  consult`). `checkpointAndRecord` already writes the resolved per-phase model
  map into every change record (`phaseMapRecordLine`).
- **Rec #1's "make them resumable"** — `haltCycle` already calls
  `checkpointAndRecord` before stopping ("Best-effort WIP checkpoint + change
  record so the branch and any report the cycle wrote are recoverable"), and the
  resume bridge (`runner.js:1526`) injects the prior checkpoint's summary so a
  resumed build doesn't re-pay orientation turns. Halts checkpoint and resume
  today.

---

## Fix A — Give the runner eyes (report's #2) · **do this first**

The report ranks this second. It is first: it is the causal root of the largest
waste class, and it is *cheaper than the report assumes* because the capability
is already vendored — it is simply not reachable from inside a cycle.

### Current state

- Chromium + Playwright are already in the box: `ui-checks.js` exports
  `runUiChecks`, `launchOptions`, `loadChromium`, with a full step vocabulary
  (`ui-check-logic.js normalizeStep` — click, expect-visible, expect-absent,
  computed style, console errors).
- It is only ever called **after** the cycle ends: `smoke.js:237` (post-deploy
  smoke) and `design-review.js` (screenshot capture). During the cycle, the model
  cannot reach it.
- `exec_in_container` is the only escape hatch, and `harness-safety.js:19` blocks
  `curl`/`wget` outright — including loopback to the app's own port. That is the
  handicap `convert` reported: it could not test the HTTP endpoint it was
  debugging.

Note the denylist's own comment (`harness-safety.js:10-13`): it is
*"defence-in-depth, not the primary boundary"*. The real egress boundary is the
squid fence the container already runs behind — `exec_in_container`'s own
description says so. Blanket-blocking loopback `curl` therefore buys no security
and costs the runner its only HTTP probe.

### Changes

1. **New runner tool `http_probe`** — issue a request against the app's *own*
   base URL inside the container and return a structured result (status, headers,
   body excerpt, timing). Preferred over loosening the denylist: it is
   URL-restricted to loopback by construction, auditable, has no shell-escaping
   surface, and leaves `DEFAULT_COMMAND_DENYLIST` intact.
2. **New runner tool `browser_probe`** — drive the running dev app mid-cycle.
   Reuse the existing `ui-checks.js` primitives against the in-container dev
   server instead of the deployed URL. Returns: console errors, failed network
   requests, **computed style for a selector**, and a rendered DOM excerpt.
3. **Wire both** into `RUNNER_TOOLS` (`runner-logic.js:26`) and `executeTool`
   (`runner.js`), and name them in the task brief so the model reaches for them
   *before* theorising. Cap calls per cycle (~10) — each browser probe costs a
   Chromium launch (~1–3s), no model tokens.

### Why it works

Every long saga in the report ended when someone *read* something. `docs2` spent
five cycles theorising about blob-URL lifetimes and click races; the answer was
`.popover.menu { display:none }`. A single `browser_probe` returning the computed
style of that selector ends that saga on cycle one. `convert` spent six of eight
cycles on "uploads don't convert" without being able to issue one request against
its own endpoint.

---

## Fix B — Cap symptom-chasing (report's #3) · **do this second**

Roughly 70% of this is already written and has **never run**.

### Current state

`consult-logic.js` is a complete escalation apparatus: `consultTrigger`,
`consultAllowed`, bounded caps (`CONSULT_MAX_PER_HALT = 1`,
`CONSULT_MAX_PER_REQUEST = 2`), `buildConsultDigest`, `CONSULT_SYSTEM_PROMPT`,
`parseConsultOutput`. `diagnose-logic.js` is a complete root-cause diagnosis pass,
bounded to ~$0.10–0.25, whose prompt explicitly instructs *"prior fix attempts on
this surface repaired adjacent code while the named check kept failing — do not
repeat that."*

Three things keep it inert:

1. **`MOCK2_CONSULT` defaults OFF** (`consult-logic.js:21-26`). None of this has
   run in production.
2. **`reHaltSameReason` is dead code.** `consultTrigger` accepts it
   (`consult-logic.js:52`) and `runner.js:3662` reads it, but the only `haltCycle`
   call site passes `consultSignals: { gateFailStreak }` (`runner.js:1966`). It is
   always `false`. The `'same_reason_rehalt'` trigger has never fired, ever.
3. **`gateFailStreak` is within-cycle only** — declared at `runner.js:1577`, reset
   every cycle. There is no cross-cycle attempt counter, so "third attempt at the
   same symptom" is invisible.

Separately, `diagnose-logic` fires **only** from a smoke-report failure
(`runner.js:410`) — i.e. only when a build claimed finish and a browser check
caught it. When the *operator* re-reports the same symptom, nothing triggers.

### Changes

1. **Compute `reHaltSameReason` for real.** On halt, normalize the reason and
   compare against prior halts in the same `request_id`. Cycles already carry
   `request_id` and `segment` (migration ~659-692), so the data is there.
2. **Add a cross-cycle attempt counter** keyed on request + normalized symptom.
3. **At attempt 3, stop building and diagnose instead.** Route to the existing
   `diagnose-logic` pass rather than shipping a third guess, and post what has
   been ruled out. Extend its trigger beyond smoke failures to cover this case.
4. **Turn the consult on** — at minimum for the repeat-attempt trigger. A default
   of OFF is why the report never observed it working.

### Caveat

Fix B's value is **largely conditional on Fix A**. A cap stops a saga at two
guesses; it does not produce the answer. Without runtime observation, the third
step is an escalation to a human with a list of ruled-out theories — better than
a third guess, but not a fix. With Fix A, the escalation has real evidence to
reason over. Do them in this order.

---

## Fix C — Halts (report's #1) · **reframe, then do this third**

The report's framing does not map to this system, and its priority is too high.

### Correcting the premise

**There is no build credit to refund.** `quota-logic.js canStartCycle` gates on
`budgetCents` and `maxConcurrentCycles` — cents and concurrency, not cycles. A
halt already costs exactly the tokens it burned, metered per cycle and rolled up
per request segment. "Stop billing for halts" is unimplementable as written, and
would be the wrong target regardless: the halt is not the loss, the *re-work after
it* is.

**Checkpoint and resume already exist** (see "already shipped" above). That half
of the recommendation is done.

### What is actually broken

`haltCycle` writes the checkpoint record with `gateReports: gateReports || []` —
whatever gates happened to have run, which on a halt is usually none. The diff
*does* ride in the record (`checkpointAndRecord` embeds `git show --stat`), but
`gatesRun` comes out empty, so nothing verifies the landed tree.

That is exactly the `noted` 551 evidence: +190 real lines across six files landed,
then it halted. The diff was recorded; nothing confirmed the work was sound. So
552, 585 and 587 re-attempted it, and 588 spent a full cycle concluding *"Verified
all 13 design-review findings are already implemented — no code changes needed."*
**One un-gated halt cost four follow-on cycles.**

### Changes

1. **Run the quick-profile gate battery against the checkpointed tree before
   writing the halt record.** Cost: one gate run, zero model tokens.
2. **Write a "what actually landed" section** into the halt record — files
   touched, insertions, and which gates passed *on that tree*. Replaces the
   uninformative `halt: the build reported it was blocked`.
3. **Carry it into resume.** The bridge already injects `lastCheckpoint.summary`;
   with (1) and (2) that summary now carries verified landed work, so the resumed
   build stops re-deriving it.
4. **Surface halt cost per request segment in the UI.** The data already exists
   (`request-log.js segmentsFromCycles`, `costBySegment`). This is the honest
   version of "don't bill halts": make the cost *visible* rather than pretending
   it is zero.

---

## How much difference will this actually make?

The report claims the three fixes address **55 of 58** wasted cycles. That is
over-additive on two counts:

- **Double counting.** #3's 11 cycles are drawn from the same repeat-fix /
  wrong-fix / revert pool as #2's 23. They are not disjoint. The
  non-overlapping ceiling for #2 + #3 is 23, not 34.
- **A halt is not recoverable waste.** Not billing the 21 halts does not make the
  requests go away — the work still has to happen. What is genuinely recoverable
  is the *compounding tail*: the follow-on cycles a silent halt causes.

Corrected estimate — my apportionment, not measured:

| Fix | Report's claim | Realistic recovery | Confidence |
|---|---|---|---|
| **A** — runtime observation | ~23 cycles | **14–19** of the 23 blindness cycles | High — every saga in the report ended on a read, and the capability already exists |
| **B** — cap symptom-chasing | ~11 cycles | **3–5 incremental** over Fix A | Medium — mostly a subset of A; caps the tail A can't prevent (server-side, build-config) |
| **C** — halt gating + visibility | ~21 cycles | **5–8** compounding follow-ons | Medium-high — the `noted` 551 → 552/585/587/588 pattern is the recoverable shape |
| **Total** | **55 of 58 (95%)** | **~22–32 of 58 (40–55%)** | |

That is a materially smaller number than the report's, and still an excellent
return: roughly **half of all waste**, against a change surface that is mostly
*wiring capability that already exists* rather than building new infrastructure.

### Two things worth noting about the estimate

**Fix A is underpriced by the report and overpriced by intuition.** It reads like
the big infrastructure lift of the three. It is not — Chromium, Playwright, the
step vocabulary and the check runner are all already in the tree and exercised
every deploy. The work is exposing them as two runner tools and letting the model
reach them mid-cycle.

**Fix C's real return is cost truth, not recovered cycles.** Even at the low end
of 5–8 cycles, its more durable value is that a halt stops being invisible. Every
waste figure in the report is a floor, partly because halts record nothing about
what they accomplished.

### What this does not address

The remaining ~26–36 wasted cycles sit in classes none of the three touch:
duplicate instructions (6, an operator-workflow problem — the report's #4), scope
thrash (2), and the share of reverts and placeholders that are specification
failures rather than observation failures. The report's #12 (make the Define stage
non-skippable — `state/rules.md` is the same empty 54-byte stub in all 11 projects,
and `rules_touched` is `null` in every change record ever written) is plausibly a
larger lever on that remainder than anything in the top three, and should be the
next thing costed.

---

## Suggested sequence

1. **Fix A**, shipped and measured on one active project before anything else —
   it is the prerequisite that makes B worth having.
2. **Fix C**, which is small, self-contained, and zero model cost.
3. **Fix B**, once A is landed and its escalations have real evidence to carry.
