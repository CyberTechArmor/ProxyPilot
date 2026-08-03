# Harness fix-plan — flagged gaps for later review

Running log of gaps noticed while implementing `docs/harness-specs/spec-{a,b,c,d}-*.md`
that were **out of scope for the spec in hand** and deliberately not fixed
inline (per the standing rule: never silently expand scope — flag it here,
let a human decide whether/when to schedule the fix). Each entry names the
spec/session it surfaced in, the gap itself, why it wasn't fixed then, and its
rough shape if picked up later.

Cross-reference: `docs/known-issues.md` is the general punch list (pre-existing
test failures, operational quirks). This file is specifically flagged-during-
harness-fix-implementation gaps — narrower and newer.

---

## Open

### 1. `runner-sdk.js` doesn't implement Spec C1's quick-lane escalation

**Surfaced in:** Spec C (gate enforcement), while wiring C1.

**What:** `runCycleSdk` (`admin/backend/src/mock2/runner-sdk.js`) has its own
signature — `{ cycle, project, containerName, framework, gateScripts, ready }`
— and never destructures `escalationGateScripts` even though `startCycle`
passes it in the shared `args` object handed to whichever harness
(`runCycle` or `runCycleSdk`) is selected. Two consequences:

1. A quick cycle that runs on the SDK harness and whose diff touches a
   user-facing file never escalates to the mvp battery — the C1 fix is
   effectively hand-rolled-runner-only.
2. `copyGatesIntoContainer(containerName, gateScripts)` in `runCycleSdk`
   (line ~150) copies only the requested (quick) set, not the union with the
   mvp set — so even if escalation were wired, the extra scripts wouldn't be
   present in the container to run.

**Why not fixed in Spec C:** Spec C1's own text names `runner.js:761-767`
inside `startCycle` as the escalation's *only* touch point and describes the
mechanism entirely in terms of the hand-rolled runner's `runCycle`. Fixing
`runCycleSdk` too would have meant inventing the wiring pattern rather than
implementing what was specified — same category of judgment call as the
`concludeCycle` gap flagged after Spec A (which the user then explicitly
asked for as a follow-up).

**Shape of the fix, if picked up:** mirror the `runCycle` changes —
1. add `escalationGateScripts = null` to `runCycleSdk`'s destructured params;
2. compute `scriptsToCopy` the same union way before `copyGatesIntoContainer`;
3. after the SDK's own working-tree diff read (wherever `runCycleSdk` learns
   `changedThisCycle` — needs confirming, its diff-read call site differs
   from `runCycle`'s), recompute the effective battery with
   `touchesUserFacing` before the finish-time `runGateBattery` call;
4. thread `effectiveGateScripts` through the SDK's own `haltCycle` /
   `checkpointAndRecord` call sites, same as `runCycle`'s.

### 2. `runner-sdk.js` doesn't implement Spec C3.2's gate-config-touched notice

**Surfaced in:** Spec C (gate enforcement), while wiring C3.2.

**What:** The `recordSummary` composition in `runCycleSdk` (its
`checkpointAndRecord` calls, e.g. line ~517: `summary: 'SDK runner change'`)
is a fixed short string — there's no per-cycle `changedThisCycle`-based
summary assembly to hang the `gateConfigTouchedFiles(...)` notice off of, the
way `runCycle`'s finish-time block does.

**Why not fixed in Spec C:** same reasoning as gap #1 — the SDK harness's
summary-construction shape is different enough (a fixed label vs.
`runCycle`'s acceptance-block + escalation-line + notice-line composition)
that bolting the notice on would mean redesigning that call site, not
applying the spec as written.

**Shape of the fix, if picked up:** give `runCycleSdk` its own
`changedThisCycle`-equivalent read before its finish-time `checkpointAndRecord`
call (if it doesn't already have one under a different name — confirm before
assuming it needs a new read), then append
`` `\n\nGate config touched this cycle: ...` `` the same way, reusing the same
`gateConfigTouchedFiles` export from `cycle-logic.js` (already shared-module,
no new copy needed).

### 3. `runner-sdk.js` cannot participate in Spec D3's verified-vs-assumed ledger check

**Surfaced in:** Spec D (economics), while wiring D3.

**What:** D3's whole mechanism depends on two things `runner-sdk.js` doesn't
have: (1) a real `assumptions: { verified, assumed }` collected from the
model — the SDK harness hardcodes `assumptions: null` at its one `finish`
call site (`runner-sdk.js` ~line 481, `finish: { summary: 'SDK runner
change', acceptance: [], assumptions: null }`), so there is nothing for
`unverifiableClaims`/`hasSensitiveAssumedValue` to check; and (2) a
`readSetFromTranscript`-compatible transcript — the SDK harness uses the
Claude Agent SDK's own built-in tools (`SDK_ALLOWED_TOOLS = ['Read', 'Edit',
'Write', 'Bash', 'Grep', 'Glob']`, `runner-logic.js`), not the hand-rolled
runner's `read_file`/`apply_edit` tool names `readSetFromTranscript` matches
on — even if the SDK harness had a real transcript array in the same shape,
the tool-name filter wouldn't recognize its calls.

**Why not fixed in Spec D:** this isn't a missed wiring call site like gaps
#1/#2 — it's a structural gap. Fixing it means first deciding how (or
whether) the SDK harness should surface a real acceptance/assumptions
ledger at all, which is a redesign of that harness's finish handling, not
an application of D3 as specified.

**Shape of the fix, if picked up:** two separable pieces — (a) have the SDK
harness's finish path actually collect `assumptions` from the model instead
of hardcoding null (a prerequisite for anything else here to matter), and
(b) either special-case `readSetFromTranscript` to also recognize the SDK's
`Read`/`Edit` tool names and whatever shape the SDK's own transcript takes,
or give the SDK harness its own equivalent read-set derivation. Confirm the
SDK's actual transcript/tool-call shape before assuming it matches the
hand-rolled runner's at all — per this session's repeated finding, the two
harnesses are structurally parallel but not identical.

**D1/D2 do NOT have this gap, for the record (checked while wiring D3):**
D1's `haltCycle`/`checkpointAndRecord` are the SAME shared functions
`runner-sdk.js` already imports and calls directly (not reimplemented), so
the D1 halt-verification fix applies to the SDK harness automatically, at
no extra cost. D2's duplicate-work check lives in `audit.js`'s `startBuild`,
which runs before either harness is selected — harness-agnostic by
construction.

---

## Resolved (kept for history — see the commit that closed each)

- **`runner-sdk.js` had no `concludeCycle` (terminal-ledger) wiring after
  Spec A.** Flagged after Spec A's `runner.js` conversion; user asked for the
  follow-up explicitly; fixed in commit `75becc9` (converted 6 gap sites,
  extended `mock2-cycle-ledger.test.js`).
- **`audit.js` had the same bare-`finishCycle` gap as `runner.js`'s
  pre-Spec-A shape.** Flagged after Spec B; user asked "make what is flagged
  the same across the board"; fixed in commit `96cdbae` (7 call sites
  converted to `concludeCycle`).
