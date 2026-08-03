# Spec C — Gate enforcement: quick lane, Define stage, gate authority

**Status:** ready to implement · **Audience:** Claude Sonnet · **Source:** Prompt C in `docs/harness-fix-prompts.md`
**Plan reference:** fixes #3, #4, #11 in `docs/harness-report-verification.md`

**Land after Spec B.** Both C1 and C2 widen what is enforced; builds need the
observation tools first, or the new gates arrive as obstacles the runner cannot
diagnose. Ground rules from Spec A apply.

Read `docs/harness-map.md` before starting — it documents every gate's
cheapest-pass behaviour, which is the standing question this repo asks of any gate
change.

---

# C1 — Regression gates in the quick lane

## C1.1 The mechanism, confirmed

`buildGateBattery` (`cycle-logic.js:307-310`) is genuinely the single decision
point, and it has exactly **one** production caller: `runner.js:761-767` inside
`startCycle`.

```js
export function buildGateBattery(frameworkGates = [], mode = BUILD_MODE_FULL) {
  const profile = gateProfileForMode(mode);
  return { profile, gates: withBaselineGates(gatesForProfile(frameworkGates, profile), profile) };
}
```

`GATE_PROFILE_BY_MODE` (255-259) maps `quick → quick`, and `gatesForProfile` (284)
filters by `tierRank(gateTier(g)) <= rank`. So the quick lane runs only
quick-tier gates: `typecheck`, `design-adherence` (advisory), `platform-intact`,
`signin-reachable`. It excludes `ui-interaction` (mvp), `mobile-overflow` (mvp),
`no-dead-controls` (mvp) and `e2e` (mvp).

`filterGatesForBuildMode` (228) has **no production caller** — tests only. Leave
it alone.

## C1.2 Decision: diff-triggered escalation, not unconditional promotion

Take option (b). Rationale:

- **Unconditional promotion taxes every quick update.** `e2e` alone builds the
  app and runs a Playwright suite against a scratch database
  (`scaffold-e2e.js:100`). Charging that to a copy-change is how the quick lane
  stops being quick, and an operator who feels the lane got slow will stop using
  it — the fix would reduce coverage by driving traffic away.
- **The risk is diff-shaped, not mode-shaped.** A quick update that touches no
  user-facing file cannot cause a UI regression, so the four gates have nothing
  to say about it. One that touches `public/` carries exactly the risk they
  detect.
- **The predicate already exists** and is battle-tested (C1.3), so escalation
  costs no new judgement.

Escalation applies to the **quick** lane only. MVP already runs these gates; full
runs everything. `buildGateBattery`'s output for `mvp` and `full` must be
byte-identical to today.

## C1.3 Reuse the existing user-facing predicate — do not invent one

The `ui-interaction` gate already defines this, inside its own heredoc in
`framework-seed/gates.json` (entry index 5, name at line 28):

```js
const uiRe = [/^public\//i, /\.(html|css|scss|jsx|tsx)$/i, /(^|\/)views\//i, /(^|\/)templates\//i];
const infraRe = [/(^|\/)sw\.js$/i, /(^|\/)build-id\.(js|txt|json)$/i, /(^|\/)manifest(\.webmanifest|\.json)?$/i, /\.webmanifest$/i];
```

Its own comment calls it a *"mirror of the browser smoke trigger globs"* — the
sibling copy lives in `smoke-triggers.js`. **There are already two copies; do not
create a third.**

Add the canonical definition to `cycle-logic.js` and export it:

```js
// The user-facing surface: files whose change can produce a visible regression.
// Canonical home for a predicate that existed in two hand-maintained copies (the
// ui-interaction gate script and smoke-triggers). Infrastructure files are NOT
// screens — sw.js and build-id churn on every deploy and would otherwise
// escalate every cycle.
export const USER_FACING_RE = Object.freeze([...]);
export const UI_INFRA_EXEMPT_RE = Object.freeze([...]);
export function touchesUserFacing(changedFiles = [])   // → boolean
```

Add a test asserting the `cycle-logic.js` regexes and the `smoke-triggers.js`
copy agree on a shared fixture list of paths. Migrating the gate script's inline
copy is **out of scope** (it runs as shell inside the container), but the test
must cover it: assert the gate script's regex source strings, read out of
`gates.json`, match the exported ones. That converts silent drift into a failing
test.

## C1.4 The escalation

The escalation needs the changed-file list, which `startCycle` does not have —
the working tree is read later, at `runner.js:2094-2096`. Resolve it in
`startCycle` with the same command, immediately before building the battery:

```js
const wt = await execInContainer(containerName, `{ git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u | grep -v '^state/changes/'`);
```

On a fresh cycle this is usually empty (the tree is clean at start), which makes
a start-time decision useless. **So escalate at gate-run time, not cycle-start
time.**

Change `buildGateBattery` to accept the diff and escalate:

```js
// buildGateBattery — the ONE place a cycle's battery is decided.
//
// A quick update whose diff touches user-facing files runs the MVP battery: the
// gates that catch a visible regression (ui-interaction, no-dead-controls,
// mobile-overflow, e2e) previously ran only on greenfield and full builds — i.e.
// on the code least likely to have a regression, and never on the lane that
// produces most changes. Escalation is diff-scoped so a docs-only quick update
// stays quick.
export function buildGateBattery(frameworkGates = [], mode = BUILD_MODE_FULL, { changedFiles = null } = {}) {
  const requested = gateProfileForMode(mode);
  const escalated = requested === 'quick' && Array.isArray(changedFiles) && touchesUserFacing(changedFiles);
  const profile = escalated ? 'mvp' : requested;
  return {
    profile,
    requestedProfile: requested,
    escalated,
    gates: withBaselineGates(gatesForProfile(frameworkGates, profile), profile),
  };
}
```

`changedFiles: null` (the default, and what `startCycle` passes) means **no
escalation** — behaviour is byte-identical to today for every existing caller.

Then, in `runner.js`, rebuild the battery before the finish-time gate run. The
gate scripts are copied into the container at `runner.js:1122`
(`copyGatesIntoContainer`), so an escalated battery needs its extra scripts
copied at that point. Two options:

- **Copy the MVP battery's scripts always, run the quick subset unless
  escalated.** Copying is cheap (a few `writeFileInContainer` calls); running is
  what costs. Take this.

Concretely: at `runner.js:761-767` build **two** batteries — the requested one
and the MVP one — and copy the union into the container. Keep `gateScripts` (the
executed set) as the requested profile. Then, at the finish-time battery run
(`runner.js:2452`), recompute with the now-known `changedThisCycle` (available
from 2094-2096) and, if escalated, run the MVP set instead.

Record the outcome so it is visible:
- stamp `gates_json` with the escalated battery's `initialGateReports`;
- add one line to the change-record summary when `escalated` is true:
  `Gate profile: quick → mvp (diff touches user-facing files)`.
  Thread it through `checkpointAndRecord`'s `summary` argument at the call site —
  do not change `checkpointAndRecord`'s signature.
- post a system chat message on escalation, matching the existing waived-gates
  message pattern at `runner.js:782-789`.

## C1.5 Tests

Extend `admin/backend/src/__tests__/mock2-build-mode.test.js` (it already
exercises `filterGatesForBuildMode` at 42, 71-88).

```
test('quick + a diff touching public/ escalates to the mvp battery')
  — assert profile 'mvp', escalated true, and the four gate names present

test('quick + a docs-only diff stays quick')
  — assert profile 'quick', escalated false, and the four gate names ABSENT

test('quick + only sw.js and build-id.js does NOT escalate (infrastructure exempt)')
  — the deploy-churn case; escalating on this would escalate every cycle

test('quick with no changedFiles supplied is byte-identical to today')

test('mvp and full batteries are unchanged by the escalation parameter')
  — deepEqual against buildGateBattery(gates, mode) with no options

test('touchesUserFacing agrees with the smoke-trigger globs on a shared fixture')

test('the ui-interaction gate script regexes match the exported USER_FACING_RE')
  — read gates.json, extract the regex sources, compare; catches silent drift
```

## C1.6 Acceptance checklist — C1

- [ ] `USER_FACING_RE`, `UI_INFRA_EXEMPT_RE`, `touchesUserFacing` exported from `cycle-logic.js`
- [ ] `buildGateBattery` takes `{ changedFiles }`, returns `requestedProfile` and `escalated`
- [ ] Default (no `changedFiles`) behaviour byte-identical; mvp/full untouched
- [ ] MVP scripts copied into the container; execution still profile-gated
- [ ] Escalation recorded in `gates_json`, the change record, and chat
- [ ] Drift test between the three copies of the predicate passes

---

# C2 — Make the Define stage non-skippable

## C2.1 The defect, precisely

`rule-coverage` (`framework-seed/gates.json`, name at line 13, `order: 3`, **no
`tier` field**) exits **0** twice over:

```sh
if [ ! -f "$RULES" ]; then echo "rule-coverage: no state/rules.md yet; skipped."; exit 0; fi
rules=$(grep -Ec "<!--[[:space:]]*rule-q[0-9]+" "$RULES" 2>/dev/null); rules=${rules:-0}
if [ "$rules" -eq 0 ]; then echo "rule-coverage: no confirmed rules yet; nothing to cover."; exit 0; fi
```

An empty rule set is a **green gate**, on 11 of 11 projects. `rules_touched` is
`null` in every change record ever written (the column exists at
`migrations.js:256` and `checkpointAndRecord` never passes it).

## C2.2 The greenfield exception resolves itself

The obvious worry — the first scaffold cycle cannot have rules yet — **does not
arise**, because of two facts that only reading the code reveals:

1. `rule-coverage` has no declared `tier` and matches neither `QUICK_TIER_NAME_RE`
   nor `MVP_TIER_NAME_RE`, so `gateTier` returns **`full`**. It runs on full
   builds only.
2. The initial build after design approval runs at **MVP** by default —
   `concept.js:3393-3435`, `MOCK2_INITIAL_BUILD_MODE` defaults to `'mvp'`.

So the greenfield cycle never runs `rule-coverage` regardless. **No exception
branch is needed in the gate.** Verify both facts before relying on this; if
`MOCK2_INITIAL_BUILD_MODE=full` is set on the target install, the pre-build block
in C2.4 is what protects the first build, and it carries its own exemption.

## C2.3 The gate change

Replace the two vacuous exits with failures, keeping the third (rules present,
tests short) unchanged:

```sh
RULES=state/rules.md
if [ ! -f "$RULES" ]; then
  echo "rule-coverage: FAIL — state/rules.md does not exist. This project has no confirmed rules, so the gate battery has nothing behavioural to check against. Run the Define stage (Stage 2) to confirm the rules before building."
  exit 1
fi
rules=$(grep -Ec "<!--[[:space:]]*rule-q[0-9]+" "$RULES" 2>/dev/null); rules=${rules:-0}
if [ "$rules" -eq 0 ]; then
  echo "rule-coverage: FAIL — state/rules.md exists but contains no confirmed rules (no <!-- rule-qN --> anchors). An empty rule set passed this gate on every project in the fleet; it no longer does. Run the Define stage to confirm the rules."
  exit 1
fi
```

Both messages must name the remedy, not just the failure — a build runner reading
"FAIL — no rules" with no next step will invent one.

## C2.4 The pre-build block

The gate alone is insufficient: it fires at gate-run time on full builds only,
after the cycle has been paid for. Add a pre-build refusal.

Copy the structural template at `audit.js:235`:

```js
if (!project.design_approved_at) return { status: 'error', error: 'Approve the design first — Build unlocks after the Concept sign-off.' };
```

Insert a sibling guard in `startBuild` (`audit.js:229`) **between the readiness
guards and `insertRequest` (line 262)** — refusing after 262 orphans a request
row:

```js
  // A project with zero confirmed rules has never run Define. Its gate battery
  // can only check typing and layout, which is exactly what the fleet's batteries
  // did: rules.md was the same empty stub on 11 of 11 projects and rule-coverage
  // passed vacuously on all of them. Block once, with the remedy.
  if (rulesGateApplies({ project, buildMode: mode }) && !(await hasConfirmedRules(projectId))) {
    insertMessage({
      projectId, kind: 'system',
      body: 'Build not started — this project has no confirmed rules yet. Run Define (Stage 2) to confirm what the app must do, then press Build. The gate battery has nothing behavioural to check until it has rules.',
    });
    return { status: 'refused', error: 'no confirmed rules — run Define first' };
  }
```

Two supporting pieces:

```js
// audit-logic.js — pure, testable.
// Which builds this block applies to. The FIRST build cannot have rules (the
// interview follows design approval, and the greenfield cycle runs at MVP), so
// the block applies only once a project has built at least once.
export function rulesGateApplies({ hasBuiltBefore, buildMode })   // → boolean
```

Apply it when `hasBuiltBefore` is true, on **every** mode. A quick update to a
project that has never defined rules is exactly the case that produced the fleet's
specification-failure waste; exempting the quick lane would exempt most of it.
Read `hasBuiltBefore` from `project.last_built_framework_version_id != null`
(`migrations.js:129`, stamped at `audit.js:491`).

`hasConfirmedRules(projectId)` reads `state/rules.md` from the container and
counts `<!-- rule-qN -->` anchors — the same predicate the gate uses. Put the
counter in `audit-logic.js` as a pure function over file text
(`countConfirmedRules(text)`) and keep the container read in `audit.js`.

**Escape hatch, required.** An operator must be able to proceed — a hard block on
an existing project with real work in flight is worse than the problem. Accept an
explicit override: a repeat Build press within 10 minutes of the refusal message
proceeds, and posts `Building without confirmed rules — the rule-coverage gate
will fail until Define is run.` Mirror the override shape used in Spec B2.4 so
there is one idiom, not two.

## C2.5 Routing new projects through Define

Keep this minimal — a redesign of the concept→build handoff is out of scope.

At `concept.js:3393-3435`, where the initial build is started after design
approval, post a chat message *before* `startBuild` when the project has no
confirmed rules, pointing at Define. The greenfield build still runs (it must —
there is nothing to define rules against yet); the message sets the expectation
that Define comes next. The C2.4 block then enforces it on the *second* build.

That ordering is deliberate: the first build creates the app, Define confirms
what it must do, and every subsequent build is checked against those rules.

## C2.6 Framework propagation — say this out loud in the commit

`gates.json` is a **seed**, not per-project config. The path a gate edit takes:

1. `upgradeFrameworkFromSeed` (`framework.js:166-186`) compares the latest
   published version's `gates_json` against the seed on boot, and publishes a
   **new framework version** when they differ.
2. A project picks it up when its **next cycle** pins
   `getCurrentFrameworkVersion()` (`cycles.js:99` — "framework_version_id is THE
   PIN (ADR-003), stamped here and never changed").
3. Idle projects are swept onto it by `auto-adopt.js:104`, which starts a
   `buildMode: 'full'` cycle.

**Consequence to flag loudly:** auto-adopt starts *full* builds, and full builds
run `rule-coverage`. So on the first boot after this change, every adopted project
with no confirmed rules gets a **failing** build. That is the fix working as
intended, but it is a fleet-wide event and must not be a surprise.

Mitigation, required as part of this change: when `rule-coverage` fails **and**
the cycle was started by auto-adopt, the failure message must say so explicitly
and point at Define rather than reading as a broken build. Check whether
auto-adopt cycles are distinguishable (a `segment` or initiator marker); if not,
gate the auto-adopt sweep on `hasConfirmedRules` so it skips rule-less projects
instead of failing them. **Prefer the skip** — it is quieter and reversible.

## C2.7 Tests

**Gate script** — `admin/backend/src/__tests__/mock2-rule-coverage-gate.test.js`.
Read the script text out of `gates.json` and assert on its content (the repo
tests generated scripts this way in `mock2-deploy.test.js:46-57`):

```
test('rule-coverage fails when state/rules.md is missing')
  — assert the script no longer contains the "no state/rules.md yet; skipped" exit 0
test('rule-coverage fails when rules.md has zero rule-qN anchors')
  — assert no "nothing to cover" exit 0
test('both failure messages name Define as the remedy')
test('rule-coverage still passes when rules are covered by tests')
```

The first two **fail on today's tree** — the regression fixtures.

**Pre-build block** — extend the audit tests:

```
test('rulesGateApplies: false for a project that has never built')
test('rulesGateApplies: true for a project that has built, on every build mode')
test('countConfirmedRules: counts rule-qN anchors, ignores prose and list items')
test('countConfirmedRules: an empty 54-byte stub counts zero')
  — use the actual stub content the fleet ships
```

## C2.8 Acceptance checklist — C2

- [ ] Both vacuous `exit 0` paths in `rule-coverage` replaced with failures naming Define
- [ ] `rulesGateApplies` + `countConfirmedRules` in `audit-logic.js`, pure and tested
- [ ] Pre-build block in `startBuild`, inserted before `insertRequest`
- [ ] Override path works and warns
- [ ] Auto-adopt skips rule-less projects (preferred) or labels the failure
- [ ] Concept flow posts the Define pointer after the greenfield build
- [ ] Framework-propagation consequence documented in the commit message
- [ ] Both gate regression fixtures failed before and pass after

---

# C3 — Gate authority hardening

Substantially shipped. Gates are pinned into the container at cycle start
(`copyGatesIntoContainer`, `runner.js:3388-3398`), sourced from the pinned
framework version, and the `ui-interaction` path-widening exploit is already
closed by that gate's `globOnly` anti-gaming check (a touched file not covered at
`HEAD` needs a check that is **new or whose steps changed**, not merely a widened
glob).

This section adds the test that proves the property and one visibility measure.

## C3.1 Prove the pinning

`admin/backend/src/__tests__/mock2-gate-authority.test.js`:

```
test('the executed battery comes from the pinned framework version, not the working tree')
  — buildGateBattery over a pinned gates_json; assert an in-tree gates.json edit
    cannot appear in the result (the function never reads the tree)

test('copyGatesIntoContainer writes only the scripts it was given')
  — source-level: assert the filename helper derives names from the passed list

test('the ui-interaction gate rejects coverage conjured by widening path globs')
  — assert the gate script contains the globOnly check and its rejection text
```

## C3.2 Visibility, not a block

A diff touching `gates.json` or the `paths` globs in `state/ui-checks.json` gets a
line in the change record:

```
Gate config touched this cycle: <files>. The battery that judged this cycle was
the pinned one; this change affects later cycles.
```

**Warn rather than block, deliberately.** Editing checks is legitimate and
frequent — the `ui-interaction` gate *requires* a cycle to add or modify checks
for its touched files. Blocking would make the required action impossible. The
exploit being guarded against (widening globs to fake coverage) is already blocked
at the gate itself; what remains is making the edit visible to a reviewer.

```
test('a diff touching gates.json adds the gate-config notice to the record summary')
test('a diff touching only product code adds no notice')
```

## C3.3 Acceptance checklist — C3

- [ ] Three pinning tests added and passing
- [ ] Gate-config notice appears in the change-record summary when applicable
- [ ] No new blocking behaviour introduced; rationale in the commit message

---

# Verification for Spec C

```bash
cd admin/backend
npm test
node --test src/__tests__/mock2-build-mode.test.js
node --test src/__tests__/mock2-rule-coverage-gate.test.js
node --test src/__tests__/mock2-gate-authority.test.js
```

**Operator-visible checks.**

1. *(C1)* On a working project, send a quick update that breaks an existing
   button's handler. It must now fail `no-dead-controls` or `ui-interaction` in
   that same cycle. Send a docs-only quick update and confirm the battery stayed
   quick.
2. *(C2)* On a project with no confirmed rules that has built before, press
   Build. It must refuse with the Define pointer and create no cycle. Run Define,
   confirm one rule, press Build again — it proceeds.
3. *(C2)* Confirm the boot after deploy did **not** produce a wave of failing
   auto-adopt builds across rule-less projects.
