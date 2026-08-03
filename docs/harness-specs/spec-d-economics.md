# Spec D — Cycle economics: halt gating, already-done pre-check, assumption checking

**Status:** ready to implement · **Audience:** Claude Sonnet · **Source:** Prompt D in `docs/harness-fix-prompts.md`
**Plan reference:** fixes #5, #6, #10 in `docs/harness-report-verification.md`

Independent of B and C; can proceed in parallel with either once Spec A is
merged (D1 builds directly on A1's `concludeCycle`). Ground rules from Spec A
apply.

---

# D1 — Gate the halt checkpoint, make halt cost visible

## D1.1 The defect, precisely

`haltCycle` (`runner.js:3613-3649`) already checkpoints:

```js
record = await checkpointAndRecord({ cycle, project, containerName, holder, gateReports: gateReports || [], gateScripts, framework, summary: `halt: ${haltReasonLabel(trigger)}` });
```

Two things are wrong, not one:

1. **`gateReports` is whatever happened to have run before the halt** — on most
   halts, nothing. `checkpointAndRecord` maps it straight through
   (`gatesRun = (gateReports || []).map(g => ({ name: g.name, result: g.status }))`,
   `runner.js:3475`), so the record's `gates_run` is `[]`. Landed work is verified
   by nothing.
2. **The summary is a label, not evidence**: `halt: the build reported it was
   blocked` (via `haltReasonLabel`, `runner-logic.js:1464`). It names no file.

This is exactly the `noted` 551 pattern: +190 lines across six files landed, then
halted un-gated; 552, 585, 587 re-attempted it; 588 spent a cycle verifying it was
already done.

## D1.2 Run the battery before recording the halt

Insert between the checkpoint attempt and the record write in `haltCycle`. The
checkpoint's own commit (`buildCheckpointScript`) already exists by this point
(`checkpointAndRecord` step 1, `runner.js:3452-3456`) — the tree being graded is
the one just committed.

```js
export async function haltCycle({ cycle, project, containerName, holder, gateReports, gateScripts, framework, trigger, reason, options = [], logEvent = null, consultSignals = null }) {
  const projectId = Number(project.id);
  setJob(cycle.id, { phase: 'blocked', message: 'Blocked — checkpointing before stopping…' });

  // Verify the tree BEFORE deciding what the halt record says. The battery that
  // matters here is the requested (usually quick) one — the same battery that
  // will run on resume — not a stricter one that would fail on halted, in-progress
  // work for reasons unrelated to what landed.
  let verifiedGateReports = gateReports || [];
  if (containerName && gateScripts?.length) {
    try {
      const battery = await runGateBattery(cycle.id, containerName, gateScripts);
      verifiedGateReports = battery;
    } catch (e) {
      console.warn('[mock2] halt verification battery failed:', e?.message);
      // Keep the pre-halt reports rather than claiming a battery that didn't run.
    }
  }

  let record = null;
  try {
    record = await checkpointAndRecord({
      cycle, project, containerName, holder,
      gateReports: verifiedGateReports, gateScripts, framework,
      summary: haltSummaryWithLandedWork({ trigger, reason, gateReports: verifiedGateReports }),
    });
  } catch (e) { console.warn('[mock2] halt checkpoint failed:', e?.message); }
  // … unchanged from here
```

`runGateBattery` already exists (`runner.js:3404-3428`) and is the same function
`run_gates` calls. Reusing it means the halt record's `gates_run` means exactly
what a normal cycle's does — no new verification semantics to reason about.

**No container, or no gate scripts:** skip verification and keep
`gateReports || []`, but say so explicitly in the summary (D1.3) rather than
silently producing an empty `gates_run` that looks identical to "we checked and
it's empty."

## D1.3 The "what actually landed" summary

New pure function in **`runner-logic.js`**, next to `haltReasonLabel` (1464):

```js
// The halt record's summary. Previously just a label ("halt: the build reported
// it was blocked") — this cost noted/551 four follow-on cycles: +190 real lines
// landed then halted un-gated, so nothing told the resume it was already there.
// Names what landed and what verified it, so a resume reads evidence, not a label.
export function haltSummaryWithLandedWork({ trigger, reason, gateReports = [], diffStat = null })
```

Since `diffStat` is computed inside `checkpointAndRecord` (`runner.js:3464-3469`)
*after* the summary is normally passed in, either:

- (preferred) move the diffStat computation earlier and pass it into
  `haltSummaryWithLandedWork` before calling `checkpointAndRecord`, or
- have `haltSummaryWithLandedWork` return a summary *without* the diff line and
  let `checkpointAndRecord`'s existing `recordSummaryText` composition
  (`runner.js:3472`) append the diff, as it already does for every other
  caller.

Take the second option — it reuses the existing composition path instead of
duplicating it, and keeps `checkpointAndRecord` the single place a diffstat gets
attached.

```js
export function haltSummaryWithLandedWork({ trigger, reason, gateReports = [] }) {
  const label = haltReasonLabel(trigger);
  const total = gateReports.length;
  const passed = gateReports.filter((g) => g.status === 'passed').length;
  const failed = gateReports.filter((g) => g.status === 'failed').map((g) => g.name);
  const gateLine = total === 0
    ? 'no gate battery ran against the checkpointed tree (verification unavailable at halt time)'
    : failed.length
      ? `${passed}/${total} gates passed on the checkpointed tree — failing: ${failed.join(', ')}`
      : `${passed}/${total} gates passed on the checkpointed tree`;
  return `halt: ${label}\n\n${gateLine}${reason ? `\n\nReason: ${String(reason).slice(0, 500)}` : ''}`;
}
```

## D1.4 Resume carries the verified summary — confirm, don't change

`buildResumeContextBlock` (`unblock-logic.js:143`) already surfaces
`lastCheckpoint.summary` first in its output (step 3, lines 158-168 of that
function). Because D1.2/D1.3 enrich exactly that summary, the resume bridge picks
up the improvement with **no code change** — verify this with a test rather than
touching `unblock-logic.js`.

Add one framing line so an operator/model reading the block understands the
summary is evidence, not narration. In `buildResumeContextBlock`, immediately
after the checkpoint block (after line 168's push):

```js
if (checkpoint.summary && /gates? passed/.test(checkpoint.summary)) {
  lines.push('This was verified against the tree before the halt — do not re-derive what it already confirms.');
}
```

Guard on the gate-line pattern so old records (pre-D1) don't get a false claim of
verification.

## D1.5 Halt cost visibility

The data exists: `request-log.js` already classifies `segment: 'halted'` via
`inferSegment` (line 73: `if (cycle?.halt_reason) return 'halted';`) and rolls it
into `costBySegment` (line 83) and `buildRequestLog`'s `cost.by_segment` (line
94+). **No backend change is needed to compute it.**

What's missing is surfacing it. `ChangeHistory.jsx` and `BuildLogViewer.jsx`
(confirmed consumers of `GET /projects/:id/requests` and
`GET /projects/:id/requests/:reqId/log`) do not currently render `by_segment`
broken out — confirm this by reading both files before changing them.

Minimal addition, respecting `MOBILE_FIRST.md` (mandatory for anything under
`admin/frontend/src/pages/` or `components/`):

- In `BuildLogViewer.jsx`, where `log.final_status` is rendered (line ~138), add
  a small cost-by-segment line when `log.cost.by_segment.halted > 0`:
  `Halted: ${money(log.cost.by_segment.halted)}` using the existing `money()`
  helper (line 35). One line, no new layout, inherits the dialog's existing
  responsive behaviour.
- In `ChangeHistory.jsx`'s per-request-group row, show the same figure next to
  the existing `final_status` badge when non-zero.

No new endpoint, no new backend field — this is a rendering-only change.

## D1.6 Tests

**`admin/backend/src/__tests__/mock2-halt-verification.test.js`**:

```
test('haltSummaryWithLandedWork: no gates run states verification was unavailable')
test('haltSummaryWithLandedWork: names the failing gates when some fail')
test('haltSummaryWithLandedWork: reports N/M passed when all pass')
test('haltSummaryWithLandedWork truncates a very long reason')
```

**Extend `admin/backend/src/__tests__/mock2-cycles.test.js` or a new halt-flow
test** (mock the container/gate-runner boundary, following the stub-first
convention):

```
test('haltCycle on a tree with real changes writes a record with non-empty gates_run')
  — REGRESSION FIXTURE: gates_run is [] today
test('haltCycle with no container writes a record that says verification was unavailable')
test('haltCycle verification failure falls back to pre-halt gateReports without throwing')
```

**`buildResumeContextBlock` addition**:

```
test('a verified halt summary gets the "do not re-derive" framing line')
test('an unverified (pre-fix-shaped) summary does NOT get the framing line')
```

## D1.7 Acceptance checklist — D1

- [ ] `haltCycle` runs the battery against the checkpointed tree before recording, reusing `runGateBattery`
- [ ] `haltSummaryWithLandedWork` added to `runner-logic.js`
- [ ] No-container / no-gate-scripts path states unavailability explicitly, never a silent empty `gates_run`
- [ ] `buildResumeContextBlock` framing line added, gated on the verified pattern
- [ ] Frontend: halted cost visible in `BuildLogViewer.jsx` and `ChangeHistory.jsx`, no backend change
- [ ] Regression fixture (`gates_run` non-empty on halt) failed before and passes after

---

# D2 — "Is this already done?" pre-build check

## D2.1 Where builds actually enter

There is no single choke point — confirm two, and intercept at the higher one:

- **`insertCycle`** (`cycles.js:91`) — too low-level; called from multiple
  contexts including refusal bookkeeping itself.
- **`startBuild`** (`audit.js:229`) — the real gate. Every interactive build path
  (`routes.js:3428`, `5089`, `5669`), the queue drain (`build-queue.js:148`),
  concept handoff (`concept.js:1734`), auto-adopt (`auto-adopt.js:104`), and
  screen-plan builds (`screen-plan.js:191,314`) all funnel through it.

Intercept in `startBuild`, at the **same insertion point** as C2.4's rules
check — between the readiness guards (ending 257) and `insertRequest` (262). Both
D2 and C2.4 are pre-build refusals; if both specs land, order them explicitly:
rules-check first (structural — the project cannot build sensibly at all),
then already-done (informational — this specific ask may be moot). State this
order in the code with a comment so a future edit doesn't silently reorder them.

`enqueueBuild` (`build-queue.js:21`) is a bare INSERT with **no dedupe of any
kind** and is a second path worth knowing about but not fixing here — it queues
work for later `startBuild` calls, which is where the check will run when the
queue drains.

## D2.2 The matcher

New file **`admin/backend/src/mock2/duplicate-check-logic.js`**, pure:

```js
// Is this instruction asking for something a recent cycle already did? Two
// tiers: exact-after-normalisation (the Encapsoul 650/652 case — literally the
// same text sent twice) and fuzzy overlap against recent SUCCESSFUL change
// summaries (the Docs 740-vs-738 case — a re-request of already-shipped work).
// Reuses finish-guard-logic's token-Jaccard similarity rather than a second
// implementation.
import { normalizePayload, payloadSimilarity } from './finish-guard-logic.js';

export const DUPLICATE_EXACT_THRESHOLD = 0.95;
export const DUPLICATE_FUZZY_THRESHOLD = 0.55;   // lower bar: summaries paraphrase

export function findLikelyDuplicate({ instruction, recentRecords = [] })
  // recentRecords: [{ cycleId, seq, summary, createdAt }], most recent first,
  // already scoped to this project and a reasonable window (e.g. last 20 or 14 days)
  // → { match: {...}, kind: 'exact'|'fuzzy', score } | null
```

`normalizePayload` and `payloadSimilarity` are currently **not exported** from
`finish-guard-logic.js` (confirm) — export them; do not reimplement token-Jaccard
a third time (B2 also reuses it).

Behaviour:
1. Normalise the incoming instruction the same way `normalizePayload` does.
2. Compare against each record's `summary` (not the original instruction — the
   summary is what a human reads to judge duplication, and it's what's
   available cheaply).
3. `score >= DUPLICATE_EXACT_THRESHOLD` → `kind: 'exact'`.
4. `DUPLICATE_FUZZY_THRESHOLD <= score < DUPLICATE_EXACT_THRESHOLD` → `kind:
   'fuzzy'`.
5. Return the single highest-scoring match above the fuzzy floor, or `null`.

**Test vectors, mandatory, from the report's real cases:**
- Encapsoul 650 vs 652 (byte-identical text) → `exact`.
- Encapsoul 654 vs 656 → `exact`.
- `Docs` 740's instruction vs 738's change-record summary (folders re-requested)
  → `fuzzy`, above floor.
- Two different instructions that happen to touch the same file (e.g. "add a
  cancel button" vs "fix the cancel button's color") → **no match**. This is the
  precision guardrail — get this wrong and the check becomes noise.

## D2.3 The intercept

```js
  // Duplicate-work check: recent shipped work already covers this ask?
  const dup = await checkForDuplicate({ projectId, instruction });
  if (dup) {
    insertMessage({
      projectId, kind: 'system',
      body: duplicateRefusalMessage(dup),   // names the prior cycle/seq and its summary
    });
    return { status: 'refused', error: `looks already done — see cycle ${dup.match.cycleId} (change record ${dup.match.seq})` };
  }
```

`duplicateRefusalMessage` (pure, in `duplicate-check-logic.js`) must:
- name the specific prior change record (seq + summary excerpt);
- offer the override explicitly: *"If this is genuinely new work, send it again
  to build anyway."*

**Fail open, always.** Wrap the matcher call in try/catch; any error (DB read
failure, malformed record) proceeds to build. A false negative costs a cycle; a
false positive that cannot be overridden costs trust in the whole feature.

**Override.** Reuse the same idiom as B2.4 and C2.4: a repeat submission of
(near-)identical text within a short window after a duplicate refusal proceeds.
Do not invent a third override mechanism — factor the "was this the immediate
follow-up to a refusal we just posted" check into one shared helper (`
recentRefusalOverride({ projectId, instruction, withinMinutes: 10 })`) that D2,
C2.4 and B2.4 can all call, rather than three copies of the same 10-minute-window
logic. **If B or C landed first, reuse their helper instead of writing this
again — check before adding a new one.**

## D2.4 Tests

**`admin/backend/src/__tests__/mock2-duplicate-check.test.js`**:

```
test('exact-after-normalisation instructions score as duplicates')
  — Encapsoul 650/652 style: identical modulo whitespace
test('a fuzzy re-request of shipped work scores above the fuzzy floor')
  — Docs 740-vs-738 style
test('two different instructions touching the same file do NOT match')
  — the precision guardrail
test('the most recent match wins when multiple records score above the floor')
test('findLikelyDuplicate returns null on an empty record list')
test('the matcher fails open: a thrown normalisation error yields no match')
test('duplicateRefusalMessage names the specific prior cycle and offers the override')
```

## D2.5 Acceptance checklist — D2

- [ ] `duplicate-check-logic.js` added; reuses `finish-guard-logic`'s similarity, not reimplemented
- [ ] Intercept placed in `startBuild` after C2.4's rules check (if both land) or alone at the same insertion point
- [ ] Fail-open on any matcher error, verified by test
- [ ] Shared override helper used (or created, if landing first) — no duplicate 10-minute-window logic
- [ ] All matcher test vectors pass, including the precision guardrail

---

# D3 — Machine-check the verified-vs-assumed ledger

## D3.1 What already exists

`finish` (and identically-shaped `pending_verification`) structurally **requires**
`assumptions: { verified: string[], assumed: string[] }` — both arrays required,
`additionalProperties: false` (`runner-logic.js:174` region; schema also mirrored
in `schemas/build-outcome.schema.json`). Absence is already rejected. What is
missing is that **content** is never checked: a `verified` entry is taken on
faith.

## D3.2 No read-set exists — this is the real gap

Confirmed: nothing in `executeTool` accumulates which files were read. The `read_file`
case (`runner.js:3130-3136`) just returns content. A grep for any
`readPaths|filesRead|seenFiles` pattern across `mock2/` returns nothing.

What **does** exist is the write-set, derived from git at finish time
(`runner.js:2094-2096`):

```js
const wt = await execInContainer(containerName, `{ git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u | grep -v '^state/changes/'`);
```

Build the read-set the same lightweight way: **accumulate paths from tool calls
in the transcript**, not from a new tracking side-channel. This is simpler than
threading an accumulator through `executeTool` and matches how the write-set is
already derived (from evidence already present, not from new state).

New pure function in **`runner-logic.js`**:

```js
// The files a cycle actually looked at, derived from its own tool calls —
// read_file, apply_edit (old_string is read from the file first), and the
// pre-edit half of write_file when it's a modification not a create. This is
// the read-set a "verified" claim can be checked against.
export function readSetFromTranscript(transcript = [])
  // → Set<string> of paths, relative to the app dir
```

Scan `transcript` entries where `role === 'tool'` is preceded by the
corresponding call (the transcript already interleaves assistant tool_use and
tool results — reuse whatever shape `classifyTurn`/the main loop already produces,
do not invent a second transcript format). Extract `path` from `read_file` and
`apply_edit` calls' `input`.

## D3.3 Citation format and the check

The build skill's own prompt text already asks for citation-shaped claims
(`skills.json`, the Stage 3 build skill body): *"a permission or role-name value
left in assumed is a defect"* and models are told to cite files. Formalize a
tolerant parser rather than requiring a rigid syntax the model won't reliably
produce:

New in **`finish-guard-logic.js`** (it already owns finish-time validation and
the shared rejection budget):

```js
// A "verified" entry cites the file it was checked against, in parens at the
// end — "role slugs are lowercase (src/routes/profile.ts)" — or names it inline
// ("read src/routes/profile.ts: ..."). Tolerant: several models will phrase this
// differently, and a false rejection here is worse than a missed one.
export function extractCitedFile(verifiedEntry)
  // → string|null, a path-shaped substring, or null if none found

export function unverifiableClaims({ assumptions, readSet })
  // → string[] of verified[] entries whose cited file (if any) is NOT in readSet.
  //   An entry with NO citation at all is NOT included here — it is a
  //   separate, non-blocking signal (D3.4).
```

`extractCitedFile` looks for a path-shaped token: contains `/` or a recognized
extension, optionally inside parens. Keep the regex forgiving; test it against
real phrasing from the constitution/skill text quoted above.

## D3.4 Wiring into the shared budget

`rejectFinishOrConclude` (`runner.js:1657`) is the funnel every validator rides.
Confirmed validator list and its budget semantics (`FINISH_REJECTION_BUDGET = 3`,
`finish-guard-logic.js:44`) needs exactly one more call site, mirroring the
existing ones (e.g. `summary-overclaim` at `runner.js:2142-2143`):

```js
  const readSet = readSetFromTranscript(transcript);
  const unverifiable = unverifiableClaims({ assumptions: decision.finishAssumptions, readSet });
  if (unverifiable.length) {
    const r = await rejectFinishOrConclude({
      validator: 'unverifiable-claim',
      termId, termName, decision, gateReports: lastGateReports,
      message: `Not finished — assumptions.verified claims a file this cycle never read: ${unverifiable.map((c) => `"${c}"`).join('; ')}. Either read that file and re-verify, or move the claim to assumed.`,
    });
    if (r === 'concluded') return scheduleJobCleanup(cycle.id);
    if (r === 'rejected') continue;
  }
```

Place it alongside the other validators, before the acceptance/integration checks
that already run in that block (confirm ordering against the existing sequence —
`malformed-call` first, then the others — and insert `unverifiable-claim` after
`summary-overclaim`, since both are about the summary's honesty).

**Do not reject an entry with no citation at all.** Many true claims are
legitimately hard to pin to one file (a cross-cutting invariant, a UI behavior
observed via a browser probe per Spec B). Rejecting those would punish exactly
the observation-based verification Spec B is trying to encourage. Only reject a
claim that names a *specific* file and that file was not read.

## D3.5 Deploy gating on role/permission values in `assumed`

Detector, pure, in `finish-guard-logic.js`:

```js
const SENSITIVE_ASSUMED_RE = /\b(role|permission|rbac|admin|is_admin|authz|auth[zn]?|access[_ ]?level)\b/i;

export function hasSensitiveAssumedValue(assumed = [])
  // → boolean — true if any assumed[] entry matches SENSITIVE_ASSUMED_RE
```

When true at finish time, **do not reject** (this is not a malformed submission —
it's a legitimate but risky claim). Instead downgrade to the pending-verification
path, which is already a supported, exercised route:

- `openVerificationChecklist({ projectId, cycleId, checklist })` with one item:
  `An assumption about roles/permissions was not verified this cycle: "<entry>".
  Confirm this by hand before trusting access control on this change.`
- `updateCycle(cycle.id, { verification_state: 'pending' })`
- `finishCycle(cycle.id, { status: 'awaiting_user', error: null })`
- **skip `closeRequest`** — matching the existing pending-verification path's
  behaviour (confirmed: the success path calls `closeRequest`, the pending path
  does not).

This is not a new code path — it is the existing auto-route
(`runner.js:2955-2958`, *"the builder called finish and this cycle's integrations
still carry in-scope live checks"*) with one more source feeding
`pendingChecklist`. Add the sensitive-assumed item to `pendingChecklist`
alongside `integrationDecision.checklist` and `uiVerification.checklist` at the
point they're already being unioned (`runner.js:2966-2968`), rather than building
a parallel mechanism.

## D3.6 Tests

**`admin/backend/src/__tests__/mock2-finish-verification.test.js`**:

```
test('extractCitedFile finds a parenthesised path citation')
test('extractCitedFile finds an inline "read <path>" citation')
test('extractCitedFile returns null for a claim with no file reference')
test('unverifiableClaims: a citation to an unread file is flagged')
test('unverifiableClaims: a citation to a read file is NOT flagged')
  — REGRESSION FIXTURE: today nothing checks this
test('unverifiableClaims: an uncited claim is never flagged (only citations are checked)')
test('readSetFromTranscript: collects read_file and apply_edit paths')
test('readSetFromTranscript: ignores write-only create_file calls')
test('hasSensitiveAssumedValue: true for a role/permission-shaped assumed entry')
test('hasSensitiveAssumedValue: false for an unrelated assumed entry')
```

**Runner-level** (mock the transcript/gate boundary):

```
test('a finish with an unverifiable claim is rejected through the shared budget')
  — assert it consumes budget the same way summary-overclaim does
test('a finish with a sensitive unverified assumption concludes pending_verification, not deployed')
test('a finish citing a genuinely-read file passes unimpeded')
```

## D3.7 Acceptance checklist — D3

- [ ] `readSetFromTranscript` added, derives from existing transcript shape (no new tracking side-channel)
- [ ] `extractCitedFile`, `unverifiableClaims`, `hasSensitiveAssumedValue` added to `finish-guard-logic.js`
- [ ] `unverifiable-claim` rides the existing shared budget via `rejectFinishOrConclude` — no new unbounded rejection path
- [ ] Uncited claims are never rejected — only citations to unread files
- [ ] Sensitive-assumed detection folds into the existing `pendingChecklist` union, not a new mechanism
- [ ] `closeRequest` correctly skipped on the pending path (matches existing behaviour)
- [ ] All tests pass; the unverifiable-claim regression fixture failed before

---

# Verification for Spec D

```bash
cd admin/backend
npm test
node --test src/__tests__/mock2-halt-verification.test.js
node --test src/__tests__/mock2-duplicate-check.test.js
node --test src/__tests__/mock2-finish-verification.test.js
```

**Operator-visible checks.**

1. *(D1)* Force a halt mid-build after real code has landed (revoke an egress
   grant, or halt manually via the API). Resume. The resume context must open by
   naming the landed files and gate results, not just a trigger label. The
   request log must show a non-zero `by_segment.halted` cost.
2. *(D2)* Send the same instruction twice. The second attempt must be refused
   with a pointer to the first change record, before any cycle is created.
   Sending it a third time (the override) must proceed.
3. *(D3)* Submit a finish whose `assumptions.verified` cites a file the cycle
   never opened. It must be rejected once, consuming shared budget, with a
   message naming the uncorroborated file.
