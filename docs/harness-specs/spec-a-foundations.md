# Spec A — Foundations: ledger completeness, Node 20, posture exemption

**Status:** ready to implement · **Audience:** Claude Sonnet · **Source:** Prompt A in `docs/harness-fix-prompts.md`
**Plan reference:** fixes #8, #2, #9 in `docs/harness-report-verification.md`

Three independent changes. Implement in the order given (A1 first — it is the
measurement substrate). Each section is separately shippable; do not batch the
commits.

## Ground rules for all three

- Tests run from `admin/backend/` with `npm test` (`node --test 'src/__tests__/*.test.js'`).
- House test style, confirmed in `src/__tests__/mock2-phase-routing.test.js`:
  `import test from 'node:test'` + `import assert from 'node:assert/strict'`,
  **flat `test('…', () => {})` blocks with no `describe`**, section banner
  comments between groups, lowercase prose test names, `assert.equal` /
  `assert.deepEqual` / `assert.ok(x, 'label')`.
- Pure logic goes in a `*-logic.js` module with native-free unit tests. Do not
  import `admin/backend/src/db.js` from a test — it pulls in `better-sqlite3`
  (see `docs/known-issues.md`).
- Do not edit applied migrations.
- No `admin/frontend/` changes in this spec.

---

# A1 — A change record for every terminal cycle

**Problem.** `finishCycle` (`admin/backend/src/mock2/cycles.js:159`) only flips
cycle status and writes a routing outcome. It writes **no change record**. Twelve
terminal paths in `runner.js` call it without a preceding `checkpointAndRecord`,
so those cycles leave a cycle row and no ledger entry — the "unlogged cycle IDs"
in the run-taxonomy report, and the reason every waste figure there is a floor.

## A1.1 — Verified inventory of terminal paths

Confirmed by reading `runner.js`. **Do not re-derive this; verify the line numbers
still match and adjust if the file has moved.**

### Paths that already write a record (10) — do not change

| Line | Status | Checkpoint at |
|---|---|---|
| 1640 | `awaiting_user` | 1617 (finish-budget exhausted) |
| 1688 | `ir.terminalStatus` | 1687 — **conditional on `ir.checkpointFirst`** |
| 1703 | `interrupted` | 1702 (budget buffer) |
| 1783 | `interrupted` | 1781 (soft pause) |
| 2690 | `failed` | 2615 (deploy failed after acceptance) |
| 2900 | `failed` | 2615 (smoke failed) |
| 2973 | `awaiting_user` | 2615 (pending verification) |
| 3017 | `succeeded` | 2615 (success) |
| 3110 | `interrupted` | 3108 (max turns) |
| 3628 | `awaiting_admin` | 3621 (`haltCycle`) |

Line 1688 is the one conditional case: when `ir.checkpointFirst` is false it
writes no record. Treat it as a gap (see A1.3).

### Paths that write NO record (12) — all must be fixed

| Line | Status | Context | Container/holder available? |
|---|---|---|---|
| 715 | `refused_quota` | quota refusal; cycle row exists only to record it | **No** — pre-lock, pre-container |
| 739 | `failed` | `acquireLock` failed | **No** — `containerName` computed at 742 |
| 827 | `failed` | `driveCycle().catch()` outer crash | **Not passed** |
| 976 | `failed` | `retryDeploy`: `ensureComponentDeps` repair failed | Yes |
| 983 | `failed` | `retryDeploy`: `deployStage` failed | Yes |
| 987 | `restoreStatus` | `retryDeploy` success | Yes |
| 1005 | `failed` | `retryDeploy` outer catch | Yes |
| 1055 | `failed` | accept-pending deploy failed | Yes |
| 1065 | `awaiting_user` | accept-pending success | Yes |
| 1097 | `failed` | accept-pending outer catch | Yes |
| 1124 | `failed` | `copyGatesIntoContainer` failed | Yes (holder at 1117) |
| 3588 | `awaiting_admin` | `escalateAwaitingAdmin` — raw git commit at 3581, **no `insertChangeRecord`** | Yes |

## A1.2 — The helper

`insertChangeRecord` (`change-records.js:36`) requires `frameworkVersion` and
`frameworkVersionId` and coerces both with `Number()` — passing `undefined`
produces `NaN` and a corrupt row. Confirm at each call site that a `framework`
object is in scope; it is at 715 and 739 (both use `framework.id` in
`insertCycle`).

Add to **`runner.js`**, directly below `checkpointAndRecord`:

```js
// concludeCycle — the ONE terminal exit for a build cycle. Every path that ends
// a cycle goes through here so the ledger has an entry for every cycle id: a
// cycle row with no change record is invisible to the audit spine, which is how
// crashed and refused cycles became unlogged ids.
//
// Writes the richest record the situation allows:
//   * container + holder present  → full checkpointAndRecord (commit + diff)
//   * otherwise                   → a minimal record: no commit, no diff, but a
//                                   seq, a hash-chain link, and the reason.
// Never throws: a failure to record must not mask the failure being recorded.
export async function concludeCycle({
  cycle, project, framework, status, error = null,
  containerName = null, holder = null, gateReports = null, gateScripts = null,
  summary = null, logEvent = null,
})
```

Behaviour, in order:

1. Compose `recordSummary`:
   - `summary` when the caller supplied one, else
   - `` `${status}: ${error}` `` truncated to 500 chars, else
   - `` `${status}: no detail` ``.
2. If `containerName && holder`: `await checkpointAndRecord({ cycle, project, containerName, holder, gateReports: gateReports || [], gateScripts, framework, summary: recordSummary })` inside `try/catch`. On throw, fall through to step 3 and append `` ` (checkpoint failed: ${e.message})` `` to the summary.
3. Otherwise (or on fallthrough) call `insertChangeRecord` directly:
   ```js
   insertChangeRecord({
     projectId: Number(project.id),
     cycleId: cycle.id,
     initiatedBy: cycle.initiated_by ?? null,
     actingAsAdmin: cycle.acting_as_admin ? 1 : 0,
     frameworkVersion: framework?.version,
     frameworkVersionId: framework?.id,
     rulesTouched: null,
     gatesRun: gateReports ? gateReports.map((g) => ({ name: g.name, result: g.status })) : null,
     commitSha: null,
     summary: recordSummary,
   })
   ```
   Wrap in `try/catch` and `console.warn` on failure — never throw.
   **Confirm the `frameworkVersion` field name** against the existing
   `insertChangeRecord` call inside `checkpointAndRecord` and match it exactly.
4. Call `finishCycle(cycle.id, { status, error })`.
5. If `logEvent` is a function, emit `logEvent('note', { role: 'system', content: recordSummary, meta: { terminal: status, recorded: true } })` in a `try/catch`.
6. Return the record (or `null`).

**Guard against double-recording.** Paths that already checkpoint must NOT gain a
second record. Two options — pick (b):

- (a) call `concludeCycle` everywhere and have it detect an existing record for
  this cycle id;
- (b) **leave the 10 already-recording paths untouched** and use `concludeCycle`
  only on the 12 gap paths.

(b) is smaller, has no behaviour change on working paths, and is trivially
reviewable. Take it. Add the detection anyway as a cheap safety net: before
inserting, query the last record for the project and skip if its `cycle_id`
equals this cycle's id **and** a commit sha is present.

## A1.3 — Call-site changes

Replace `finishCycle(...)` with `await concludeCycle({...})` at each of the 12
lines. Notes per group:

- **715 / 739** — no container. Pass `containerName: null, holder: null`. At 715
  the cycle variable is `refused`, not `cycle`.
- **827** — inside a `.catch()`. `project`/`framework` may not be in scope; if
  not, load them (`getCycle` → project lookup) or pass what is available and let
  the framework fields resolve from the cycle row. If neither is reachable,
  spec-legal fallback: keep `finishCycle` and add a `console.warn` — but attempt
  the record first.
- **976–1005** (`retryDeploy`) and **1055–1097** (accept-pending) — container and
  holder are in scope; pass them so these get full checkpoints.
- **1124** — container + holder in scope; pass them.
- **3588** (`escalateAwaitingAdmin`) — a raw `buildCheckpointScript` commit
  already runs at 3581. Replace the bare commit with `concludeCycle` so the
  commit is accompanied by a record; keep the same summary text
  `checkpoint: auto (retries exhausted)`.
- **1688** — when `ir.checkpointFirst` is false, route through `concludeCycle`
  so the conditional gap closes.

## A1.4 — Tests

New file `admin/backend/src/__tests__/mock2-cycle-ledger.test.js`.

The tricky part is that `concludeCycle` lives in `runner.js`, which imports
native modules. **Extract the decidable part into a pure module** so it is
testable native-free:

New file `admin/backend/src/mock2/conclude-logic.js`:

```js
// Which recording strategy a terminal path gets, and the summary it records.
export function terminalRecordPlan({ containerName = null, holder = null, summary = null, status, error = null })
  // → { strategy: 'checkpoint' | 'minimal', summary: string }

export function terminalSummary({ summary = null, status, error = null })
  // → string, capped at 500 chars
```

`concludeCycle` calls these; the tests target them plus a source-level invariant.

Required assertions:

```
test('terminalRecordPlan: container + holder → checkpoint strategy')
test('terminalRecordPlan: no container → minimal strategy')
test('terminalRecordPlan: holder missing → minimal strategy even with a container')
test('terminalSummary: caller summary wins')
test('terminalSummary: falls back to "status: error"')
test('terminalSummary: falls back to "status: no detail" with no error')
test('terminalSummary: caps at 500 characters')
```

Plus the **regression fixture** — a source-level guard in the same style as the
existing `mock2-project-assets.test.js:296` check (it greps `runner.js` source
text, so this pattern is house-legal):

```
test('every terminal path in runner.js records: no bare finishCycle outside the recording paths')
```

Read `runner.js` as text, collect every `finishCycle(` occurrence, and assert
each is either (a) preceded within 40 lines by `checkpointAndRecord` on the same
path, or (b) reached via `concludeCycle`. Simplest robust form: assert the count
of bare `finishCycle(` calls in `runner.js` is **exactly the 10 known
recording-path call sites**, and list them explicitly in the test so a new bare
call fails the assertion. **This test fails on today's tree (22 bare calls) —
that is the acceptance signal.**

## A1.5 — Acceptance checklist

- [ ] `conclude-logic.js` added with both pure functions
- [ ] `concludeCycle` added to `runner.js` below `checkpointAndRecord`
- [ ] All 12 gap paths converted; the 10 recording paths untouched
- [ ] Path 1688's `checkpointFirst === false` branch closed
- [ ] 3588's raw commit replaced by `concludeCycle`
- [ ] `mock2-cycle-ledger.test.js` added, all assertions above present
- [ ] The bare-`finishCycle` guard test passes (fails before the change)
- [ ] `npm test` shows no new failures beyond the 6 known `ERR_MODULE_NOT_FOUND` files

---

# A2 — Node 20 in the build container

**Problem.** `template.js:425` runs
`apt-get install -y --no-install-recommends nodejs npm` against
`MOCK2_BASE_IMAGE` (default `images:debian/12`, `provision.js:56`), which ships
**Node 18**. Playwright requires Node 20+, so the `e2e` gate skips green
everywhere. No project in the fleet has ever executed it.

## A2.1 — Mechanism decision: nodesource, not a base-image bump

Both options were evaluated. **Use nodesource in `template.js`.** Rationale:

| | nodesource in `template.js` | bump `MOCK2_BASE_IMAGE` |
|---|---|---|
| Blast radius | Node only | whole OS: Postgres major, apt names, systemd |
| Reversibility | edit one script region | re-provision every container |
| Operator override | `MOCK2_BASE_IMAGE` stays free for mirrored remotes | collides with that override |
| Existing containers | retrofittable in-place (A2.3) | requires rebuild |

A base-image bump also silently changes the in-container Postgres major, which
`buildDbSnapshotScript` and the ADR-008 snapshot path depend on. Out of scope.

## A2.2 — The template change

In `admin/backend/src/mock2/template.js`, inside `buildContainerSetupScript`
(declared line 382), replace the single line at 425.

Constraints confirmed from the surrounding script:
- Bootstrap runs **before** the nftables fence, over direct IPv4 NAT egress
  (comment at 395-400), and `/etc/apt/apt.conf.d/00mock2-ipv4` forces IPv4. So
  fetching the nodesource setup script is reachable at this point.
- Every install line is `|| true` / `|| echo` — **non-fatal**. Preserve that: a
  container must still come up if the Node install fails.
- `curl` and `ca-certificates` are already installed at line 411, before 425.

Replacement (keep the surrounding comment block at 420-424, extend it to say why
the distro package is not enough):

```sh
# Node 20 LTS via nodesource — Debian 12's `nodejs` package is 18, which
# Playwright refuses to run on, which is why the e2e gate has never executed.
# Best-effort like every other install here: a container still boots without it.
if ! (command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]); then
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh 2>/dev/null \
    && bash /tmp/nodesource_setup.sh >/dev/null 2>&1 \
    && apt-get install -y --no-install-recommends nodejs \
    || echo "[mock2] nodesource install failed; falling back to distro nodejs"
  rm -f /tmp/nodesource_setup.sh
fi
command -v node >/dev/null 2>&1 || apt-get install -y --no-install-recommends nodejs npm \
  || echo "[mock2] nodejs/npm install skipped/failed (non-fatal; the app cannot deploy without it)"
```

The guard makes it idempotent, which A2.3 depends on. nodesource's package
bundles npm, so the separate `npm` package is only in the fallback.

## A2.3 — Existing containers: retrofit, do not orphan

`MOCK2_BASE_IMAGE` is read only at `incus launch` (`provision.js:305`), and
`buildContainerSetupScript` runs only during `bringUpFromRepo` (declared 272).
**An existing container never re-runs setup**, so without a retrofit this fix
reaches new projects only — the fleet's existing projects would keep skipping
e2e forever. That is not acceptable for a fix whose whole value is fleet-wide
coverage.

Use the established in-container repair pattern — `ensureComponentDeps` /
`ensureScaffoldDeps` (`component-install.js:213`, `:252`), which `retryDeploy`
already invokes against live containers (`runner.js:964-968`).

Add to `component-install.js` (or a new `node-runtime.js` if you prefer a
cleaner home — state which you chose):

```js
// ensureNodeRuntime — bring an already-provisioned container up to Node >= 20.
// Idempotent and best-effort, mirroring scripts/patch-wg-mtu.sh's contract:
// no-op when already satisfied, never fails the caller.
export async function ensureNodeRuntime({ containerName })
  // → { ok: boolean, changed: boolean, version: string|null, detail: string }
```

It runs the same guarded block from A2.2. Call it from the deploy path, next to
the existing `ensureScaffoldDeps` call, so every project self-heals on its next
deploy without operator action.

**Do not add an `update.sh` function.** The `update.sh` retrofits
(`retrofit_smoke_browser` at 422, `retrofit_admin_tls_snippet` at 464) operate on
*host* config. Project containers are not enumerable from there in the same way,
and the deploy-path repair reaches them more reliably. Note this decision in the
commit message.

## A2.4 — Tests

Extend or create `admin/backend/src/__tests__/mock2-container-template.test.js`.

```
test('buildContainerSetupScript installs Node 20 or newer')
  — assert the script text matches /setup_20\.x|setup_2[1-9]/ and does NOT rely
    on the bare distro nodejs as its primary path

test('buildContainerSetupScript keeps every install non-fatal')
  — assert no line in the Node region can abort the script (each install is
    guarded by `||` or wrapped in an `if`)

test('the Node install block is idempotent — guarded by a version check')
  — assert the script contains a `node -p 'process.versions.node…'` guard

test('ensureNodeRuntime is wired into the deploy repair path')
  — source-level: assert deploy/runner source references ensureNodeRuntime
    alongside ensureScaffoldDeps
```

**Container-required assertion** (mark it skipped by default with a clear
`SKIP: requires a provisioned container` note, following how other
container-dependent checks are handled — confirm the repo's convention and match
it):

```
test('e2e gate returns pass or fail, never skipped, on a project with a playwright config')
```

That is the real acceptance signal: **the skip path becomes unreachable.**

## A2.5 — Acceptance checklist

- [ ] `template.js` Node block replaced, idempotent, non-fatal
- [ ] `ensureNodeRuntime` added and wired into the deploy repair path
- [ ] Decision recorded in the commit message: nodesource over base-image bump; deploy-path retrofit over `update.sh`
- [ ] Template tests added and passing
- [ ] Manual verification on one container: `node -v` reports ≥ 20 and `npx playwright --version` exits 0

---

# A3 — `plan` and `review` never run on the cheap tier

**Problem.** `applyPhasePosture`
(`admin/backend/src/mock2/phase-routing-logic.js:477-493`) applies a uniform
model across **every** phase:

```js
const pick = POSTURE_UNIFORM_MODELS[p][resolved.scenario];
const map = {};
for (const phase of BUILD_PHASES) {
  map[phase] = { ...pick, tier: p };
}
```

`PHASE_TIER` (line 79 — note: **singular**, not `PHASE_TIERS`) declares
`plan: 'top'` and `review: 'top'`. Under `ultra_cheap` and `balanced` those
declarations are overwritten. The run-taxonomy report's only failed build is also
the fleet's only `ultra_cheap` run: the review phase that exists to catch an
unverified assumption and an undersized diff was itself running cheap.

## A3.1 — The change

Add a judgement-phase constant and exempt it from downgrade-only postures.

```js
// The phases whose job is JUDGEMENT, not production: deriving the work file and
// reviewing the diff. A cost posture scales the phases that WRITE code; it must
// never scale the phases that decide whether the code is right — that is the
// one saving that costs more than it saves (the 808/721 lesson: the fleet's only
// ultra_cheap run is also its only failed build, and its review phase was the
// downgraded one).
export const JUDGEMENT_PHASES = Object.freeze(['plan', 'review']);
```

Rewrite the uniform branch of `applyPhasePosture`:

```js
  const pick = POSTURE_UNIFORM_MODELS[p][resolved.scenario];
  // max_quality UPGRADES every phase, so it applies uniformly. The downgrade
  // postures leave the judgement phases at their resolved top tier.
  const downgrade = p !== 'max_quality';
  const base = downgrade ? resolvePhaseModelMap({ providers: resolved.providers }) : null;
  const map = {};
  for (const phase of BUILD_PHASES) {
    map[phase] = (downgrade && JUDGEMENT_PHASES.includes(phase) && base?.ok)
      ? { ...base.map[phase] }
      : { ...pick, tier: p };
  }
  return { ...resolved, map, posture: p };
```

Three decisions embedded, all deliberate:

1. **`max_quality` stays uniform.** It only ever raises a phase's tier, so the
   exemption would be a no-op at best and a downgrade at worst.
2. **The exempted entries keep their real tier (`'top'`), not the posture name.**
   `phaseMapRecordLine` (line 500) renders the map into every change record; a
   `review` entry labelled `ultra_cheap` while running Opus would make the record
   lie. Truthfulness of the record outranks label consistency.
3. **The plan-phase override is preserved.** `resolvePhaseModelMap` is re-called
   *without* `planModelOverride`, matching the existing `suggested` branch, which
   also drops the manual override. Consistent with precedent.

## A3.2 — Tests

Extend `admin/backend/src/__tests__/mock2-phase-routing.test.js`, following its
established idioms (flat tests, loop-over-scenarios with per-iteration labels,
acceptance tags in parentheses). Add after the existing posture block (~line 389).

```
test('posture ultra_cheap: implementation phases go cheap but plan and review stay top')
  for each scenario in both/openai/anthropic:
    out = applyPhasePosture(resolvePhaseModelMap({ providers }), 'ultra_cheap')
    assert.equal(out.map.review.tier, 'top', `${scenario}/review`)
    assert.equal(out.map.plan.tier, 'top', `${scenario}/plan`)
    assert.equal(out.map.implement_mechanical.tier, 'ultra_cheap', `${scenario}/impl`)
    assert.equal(out.map.review.model, TIER_MODELS[scenario].top.model)

test('posture balanced: same exemption — judgement phases are never downgraded')

test('posture max_quality: uniform, including the judgement phases (no exemption)')
  — every phase resolves to the flagship, as today

test('JUDGEMENT_PHASES is a subset of BUILD_PHASES and matches the top-tier phases')
  for phase of JUDGEMENT_PHASES: assert.equal(PHASE_TIER[phase], 'top')

test('the record line reports the true model for an exempted phase')
  — phaseMapRecordLine over an ultra_cheap map names the top-tier model for review
```

**The first two fail on today's code.** That is the regression fixture.

Confirm the existing guard test asserting no default map contains
`gpt-5.5-pro` (referenced in the `PRO_TIER_MODELS` comment, ~line 389 area) still
passes — the exemption must not reintroduce a pro-tier id.

## A3.3 — Acceptance checklist

- [ ] `JUDGEMENT_PHASES` exported from `phase-routing-logic.js`
- [ ] `applyPhasePosture` uniform branch rewritten; `suggested` and `default` branches untouched
- [ ] `max_quality` behaviour byte-identical to today
- [ ] All six tests added; the two regression fixtures failed before and pass after
- [ ] `phaseMapRecordLine` output verified truthful for an exempted phase

---

# Verification for Spec A

```bash
cd admin/backend
npm test
node --test src/__tests__/mock2-phase-routing.test.js
node --test src/__tests__/mock2-cycle-ledger.test.js
node --test src/__tests__/mock2-container-template.test.js
```

**Expected delta.** Before: the bare-`finishCycle` guard, the two posture
exemption tests, and the Node-20 template assertions all fail. After: all pass.
The 6 pre-existing `ERR_MODULE_NOT_FOUND` failures listed in `CLAUDE.md` are
unchanged — do not attempt to fix them here.

**Operator-visible check after deploy.** Run one build on any project at
`MOCK2_PHASE_POSTURE=ultra_cheap` and read the change record's phase-model line:
`review` must name the top-tier model while `implement_mechanical` names the cheap
one. Then confirm `node -v` inside any redeployed project container reports ≥ 20.
