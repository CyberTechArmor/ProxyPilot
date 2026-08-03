# Harness fix prompts — Opus elaborates, Sonnet implements

The 12 fixes in `docs/harness-report-verification.md` grouped into **four
prompts**. Each prompt below is written to be pasted to **Claude Opus**, whose
job is NOT to write the code but to produce an implementation specification
precise enough that **Claude Sonnet** can execute it without making judgement
calls. Grouping is by subsystem and dependency, not by impact rank — run them
in this order.

| Prompt | Fixes (plan #) | Theme | Why grouped |
|---|---|---|---|
| A | #8, #2, #9 | Measurement substrate + one-liners | Small, independent, zero-risk; makes everything after it provable |
| B | #1, #7 | Runtime observation + escalation | Same debugging-loop subsystem; #7 depends on #1 |
| C | #3, #4, #11 | Gate enforcement | All gate-battery/profile work; one review surface |
| D | #5, #6, #10 | Cycle economics | Checkpoint, dedup, and finish-ledger — the request lifecycle |

Fix #12 (cross-project duplication) is deliberately excluded — strategic,
separate denominator, do it after A–D are measured.

Every prompt shares these ground rules; they are repeated inside each prompt so
each one is self-contained.

---

## PROMPT A — Ledger completeness, Node 20, posture exemption

```
You are Claude Opus working in the ProxyPilot repository. Your task is to
produce an IMPLEMENTATION SPECIFICATION — not code — for three small harness
fixes. The spec will be handed to Claude Sonnet, who will implement it exactly
as written, so it must name every file, function, insertion point, and test
assertion. Where you leave a decision open, Sonnet will guess — leave nothing
open.

CONTEXT
- The harness is the Mock2 build system in admin/backend/src/mock2/. Read
  CLAUDE.md and docs/harness-report-verification.md first — the second file
  is the verified analysis these fixes come from.
- Tests run with `npm test` from admin/backend/ (node --test). Existing tests
  stub the DB at the module boundary rather than importing the real
  better-sqlite3 db.js — follow that pattern (see docs/known-issues.md).
- Do not edit applied migrations. Do not touch admin/frontend/ in this spec.

FIX A1 — a change record for every cycle (plan #8)
Verified facts you should confirm, then build on:
- Several terminal paths in admin/backend/src/mock2/runner.js call
  finishCycle({status:'failed'}) and return WITHOUT calling
  checkpointAndRecord: lock failure (~line 739), runner crash (~827),
  gate-copy failure (~1124), deploy failure (~983, ~2690), and others.
  Enumerate ALL of them — grep every finishCycle call site and classify
  which write a record and which do not.
- checkpointAndRecord (runner.js, exported) commits the container tree and
  inserts a hash-chained change record. Some failure paths (e.g. lock
  failure) have NO container to checkpoint — the spec must define a
  container-less "minimal record" variant: status, reason, timestamp,
  cycle id, no commit sha.
Spec must define:
- A single helper (name it, place it) that every terminal path calls, with a
  fallback when no container/holder exists.
- The invariant: count(cycles in terminal status) == count(change records),
  and a test that drives every terminal path (mock the container layer) and
  asserts it.

FIX A2 — Node 18 → 20 in the build container (plan #2)
Verified facts:
- admin/backend/src/mock2/template.js line ~425 runs
  `apt-get install -y --no-install-recommends nodejs npm` on the
  MOCK2_BASE_IMAGE default images:debian/12, which yields Node 18.
- The e2e gate skips green when Playwright cannot run; the browser
  installer already exists (deploy.js installE2eBrowser). The point of
  this fix is that the skip path becomes unreachable.
Spec must decide and justify ONE mechanism (nodesource setup_20.x script in
template.js vs bumping MOCK2_BASE_IMAGE to a newer Debian) — evaluate both
against: existing containers (are they re-provisioned or only new ones?),
offline/proxy constraints in the container, and update.sh retrofit needs.
Spec must define:
- The exact script lines to change.
- A migration note: what happens to already-provisioned project containers
  (spec a retrofit step or explicitly declare new-containers-only, with the
  operator-visible consequence).
- Tests: (1) a pure test asserting the provisioning script text pins major
  >= 20; (2) an integration assertion (may be marked container-required)
  that the e2e gate returns pass/fail, never skipped, when a
  playwright.config.ts exists.

FIX A3 — plan/review never on the cheap tier (plan #9)
Verified facts:
- admin/backend/src/mock2/phase-routing-logic.js: applyPhasePosture loops
  `for (const phase of BUILD_PHASES) map[phase] = pick` for the uniform
  postures (ultra_cheap / balanced / max_quality), overwriting plan and
  review, which PHASE_TIERS declares as 'top' (lines ~81, ~85).
Spec must define:
- The exemption: under ultra_cheap and balanced, plan and review keep their
  default-tier resolution (from resolvePhaseModelMap), while implement/
  recon/summarize take the posture's uniform pick. Decide explicitly what
  max_quality does (it upgrades — probably fine to leave uniform; justify).
- Whether the posture label on the exempted phases' map entries should read
  the posture name or 'top' — the change record's phaseMapRecordLine must
  remain truthful.
- Tests: applyPhasePosture(resolved,'ultra_cheap').map.review resolves to
  the top tier AND .map.implement_mechanical resolves to the cheap model.
  Note: this assertion FAILS on today's code — that is the regression
  fixture. Check the existing phase-routing tests file and extend it.

DELIVERABLE
One markdown spec with three sections (A1, A2, A3), each containing: files to
change with exact anchors, new/changed function signatures, test file paths
with named assertions, and an acceptance checklist Sonnet can tick. End with
the combined verification commands (npm test invocations) and the expected
pass/fail delta versus the current tree.
```

---

## PROMPT B — Runtime observation + symptom-chase escalation

```
You are Claude Opus working in the ProxyPilot repository. Produce an
IMPLEMENTATION SPECIFICATION — not code — for giving the Mock2 build runner
the ability to observe the running system mid-cycle, plus an escalation that
stops repeated blind fix attempts. Claude Sonnet will implement your spec
verbatim: name every file, export, wiring point, prompt-text change, and test
assertion. This is the highest-impact change in
docs/harness-report-verification.md (read it first, plus CLAUDE.md).

CONTEXT / VERIFIED FACTS (confirm, then build on)
- The runner's tool set is RUNNER_TOOLS in
  admin/backend/src/mock2/runner-logic.js (~line 26): 11 tools, none can
  observe a running app. Tools are executed by executeTool in runner.js.
- Playwright/Chromium are already vendored: ui-checks.js exports
  runUiChecks, launchOptions, loadChromium; the step vocabulary lives in
  ui-check-logic.js (normalizeStep). Today they run only post-deploy from
  smoke.js:237 and in design-review.js.
- harness-safety.js:19 denylists /\bcurl\b|\bwget\b/ in
  DEFAULT_COMMAND_DENYLIST. Its own header says the denylist is
  defence-in-depth; the real egress boundary is the squid fence. DO NOT
  loosen the denylist — the new tools are the sanctioned path.
- The failure-diagnosis pass exists and is complete:
  diagnose-logic.js (evidence compiler, system prompt, chat message) fired
  only from a smoke failure at runner.js:410.
- The consult apparatus exists and is INERT: consult-logic.js has
  consultTrigger/consultAllowed with caps, but MOCK2_CONSULT defaults OFF;
  gateFailStreak (runner.js:1577) is within-cycle only; reHaltSameReason is
  read at runner.js:3662 but the only haltCycle call site (runner.js:1966)
  passes consultSignals:{gateFailStreak} — the signal is never fed and the
  same_reason_rehalt trigger has never fired.
- Cycles carry request_id and segment columns (migrations.js ~659-692) —
  use them for cross-cycle state; add a migration only if truly needed, in
  the reserved numbering scheme described in admin/backend/src/db.js and
  mock2/migrations.js (never edit applied migrations).

PART B1 — two new runner tools (plan #1)
Spec must define, for each tool:
1. http_probe — request against the app's OWN base url inside the
   container. Decide: how the base url/port is resolved (the dev server the
   cycle runs, not the deployed url), method/path/body/header surface,
   response shape (status, headers subset, body excerpt with byte cap,
   timing), and the loopback-only enforcement point (constructed URL, not
   validated string).
2. browser_probe — drive the RUNNING dev app. Reuse ui-checks.js
   primitives; do not fork them. Surface: navigate + optional steps, and
   returns console errors, failed network requests, computed style for a
   requested selector, and a bounded DOM excerpt. Decide Chromium reuse
   (per-call launch vs per-cycle instance) with the cost stated.
3. Wiring: JSON-schema entries in RUNNER_TOOLS, execution branches in
   executeTool, per-cycle call caps (~10 combined; define the over-cap
   response text), and event logging (tool_result meta) so probes appear in
   the cycle feed.
4. Prompt text: where the runner system prompt (runner-logic.js) should
   name the tools and instruct "observe before theorising" — quote the
   exact sentences to insert and where.
5. Tests: a fixture app (spec its shape — one hidden-by-CSS element, one
   500ing endpoint) and assertions that browser_probe returns the computed
   display:none and http_probe returns the 500 body excerpt. Name the
   regression fixture after the docs2 .popover.menu case. Pure-logic parts
   (schema validation, caps, url construction) get native-free unit tests
   following the existing *-logic.js test pattern.

PART B2 — cap symptom-chasing at two attempts (plan #7)
Spec must define:
1. reHaltSameReason computed for real: a pure function (place it in
   consult-logic.js or a new *-logic file) that normalises halt reasons and
   compares within a request_id; define the normalisation (case, digits,
   paths?) with test vectors.
2. A cross-cycle attempt counter per (request_id, normalised symptom) —
   decide storage (derive from existing cycle rows at read time vs a new
   column; prefer derive-at-read if the rows suffice).
3. The escalation: on the THIRD same-symptom attempt, do not run a build —
   route to the diagnose-logic pass (extend its trigger beyond smoke
   failures) and post the diagnosis + what-was-ruled-out to chat. Define
   the operator-facing message.
4. Activation: decide whether MOCK2_CONSULT stays opt-in for the frontier
   consult while the repeat-attempt diagnosis becomes default-on (they are
   different costs — diagnosis is ~$0.10-0.25, consult is frontier-priced).
   State the flag matrix explicitly.
5. Tests: consultTrigger returns same_reason_rehalt for two same-reason
   halts in one request (fails today — regression fixture); third-attempt
   routing dispatches diagnosis not build; different symptoms do NOT trip
   the cap.

SEQUENCING NOTE FOR THE SPEC
B1 ships first and alone; B2 references B1's probes in its diagnosis
evidence ("what the probes showed") but must degrade gracefully if probes
returned nothing.

DELIVERABLE
One markdown spec, sections B1/B2, each with: files + anchors, exported
signatures, tool JSON schemas in full, prompt-text insertions quoted
verbatim, test file paths with named assertions, and an acceptance checklist.
End with verification commands and expected test delta.
```

---

## PROMPT C — Gate enforcement: quick-lane battery, Define stage, gate authority

```
You are Claude Opus working in the ProxyPilot repository. Produce an
IMPLEMENTATION SPECIFICATION — not code — for three gate-enforcement fixes in
the Mock2 harness. Claude Sonnet implements it verbatim: name every file,
function, gate-script change, and test assertion. Read CLAUDE.md,
docs/harness-report-verification.md, and docs/harness-map.md first — the
last one documents every gate and its cheapest-pass behaviour.

CONTEXT / VERIFIED FACTS (confirm, then build on)
- Gate profiles: cycle-logic.js GATE_PROFILE_BY_MODE maps quick→quick,
  mvp→mvp, full→full; buildGateBattery is the ONE place a battery is
  decided. The quick profile excludes ui-interaction, no-dead-controls,
  mobile-overflow, and e2e — and quick is the dominant lane.
- The rule-coverage gate script lives in
  admin/backend/src/mock2/framework-seed/gates.json. It exits 0 both when
  state/rules.md is missing AND when it contains zero "<!-- rule-qN -->"
  anchors — an empty rule set is a green gate on 11 of 11 projects, and
  rules_touched is null in every change record ever written.
- The Define stage (Stage 2 interview) exists as a skill
  (framework-seed/skills.json) but nothing compels it before a build.
- Gate authority: gates are pinned into the container at cycle start; the
  ui-interaction path-widening hole was already closed. What remains is
  hardening, not a rebuild.

PART C1 — regression gates in the quick lane (plan #3)
Decide between (a) promoting ui-interaction / no-dead-controls /
mobile-overflow / e2e into the quick profile unconditionally, and (b) a
diff-triggered escalation: a quick cycle whose diff touches user-facing
paths (define the glob set — align with the ui-interaction gate's own
user-facing definition) runs the mvp battery. Recommend (b) unless you find
a reason (a) is safer; justify either way with the runtime-cost estimate.
Spec must define:
- The exact change in cycle-logic.js (buildGateBattery or a new
  escalation function), keeping buildGateBattery the single decision
  point.
- How the escalation is recorded (the cycle's gates_json and the change
  record must show WHICH profile actually ran and why).
- Tests: quick + public/** diff includes the four gates; quick + docs-only
  diff excludes them; the mvp and full profiles are byte-identical to
  today (no regression in the other lanes).

PART C2 — Define stage non-skippable (plan #4)
Spec must define BOTH halves:
1. The gate: rule-coverage exits non-zero when state/rules.md is missing
   or has zero confirmed-rule anchors — BUT decide the greenfield
   exception carefully: the very first scaffold cycle cannot have rules
   yet. Options: exempt the initial-inventory build only; or block build
   START (not the gate) when zero rules exist and the project is past its
   first cycle. Pick one, justify, and spec the operator-facing message
   ("this project has no confirmed rules — run Define first"), including
   where it surfaces (audit.js blockedBuildStatus flow already exists for
   pre-build blocks — evaluate reusing it).
2. The routing: where new-project flow should insert Stage 2 before the
   greenfield cycle (look at the concept→build handoff in concept.js /
   audit.js) — spec the smallest change that compels the interview, not a
   redesign.
Note: gates.json is framework-SEED — spec how existing projects receive
the updated gate (framework version pinning — check how framework_version
flows into cycles) versus new projects only. Be explicit.
Tests: gate script with no rules.md → non-zero; empty rules.md → non-zero;
one anchored rule + one test block → zero. Both current-behaviour cases
exit 0 today — regression fixtures.

PART C3 — gate authority hardening (plan #11)
Small. Spec must define:
- An assertion (where: cycle start? finish?) that the pinned gate scripts
  the battery runs are byte-identical to the framework-version's scripts —
  a cycle editing gates.json in-tree must not affect its own battery (it
  already shouldn't, because of pinning — the spec adds the TEST that
  proves it, plus a guard if the test finds a hole).
- A finish-time check: a diff that touches gates.json or state/ui-checks
  paths-globs gets a warning line in the change record (visibility, not a
  block — justify why not a block, or choose to block and justify that).
Tests as above.

DELIVERABLE
One markdown spec, sections C1/C2/C3: files + anchors, signatures, the full
revised rule-coverage gate script text, test paths with named assertions,
an acceptance checklist, verification commands, expected test delta.
```

---

## PROMPT D — Cycle economics: halt gating, already-done pre-check, assumption checking

```
You are Claude Opus working in the ProxyPilot repository. Produce an
IMPLEMENTATION SPECIFICATION — not code — for three fixes to the Mock2
request lifecycle: what a halt records, what happens before a cycle is
spent, and what "verified" means at finish. Claude Sonnet implements it
verbatim. Read CLAUDE.md and docs/harness-report-verification.md first.

CONTEXT / VERIFIED FACTS (confirm, then build on)
- haltCycle (runner.js ~3613) already checkpoints via checkpointAndRecord
  and halts are already resumable (resume bridge runner.js ~1526 injects
  lastCheckpoint.summary). BUT it passes gateReports: gateReports || [] —
  on most halts nothing has run, so the record's gates_run is empty and
  the landed work is verified by nothing. The record summary is the
  uninformative "halt: <haltReasonLabel>".
- Quota is cents + concurrency (quota-logic.js canStartCycle) — there is
  no per-cycle credit; "don't bill halts" is out of scope. Halt COST
  visibility is in scope: request-log.js already computes per-segment cost
  (segmentsFromCycles, costBySegment).
- No pre-build duplicate check exists. The only "already done" handling is
  in-cycle prose (runner.js ~2145 and the build skill). Cycles carry
  request_id + segment. The evidence cases: two byte-identical instruction
  pairs (report: Encapsoul 650/652, 654/656) and a re-request of shipped
  work (Docs 740 vs 738).
- finish already REQUIRES assumptions {verified[], assumed[]} structurally
  (finish-guard-logic.js ~118, ~140) with a shared 3-rejection budget —
  do not add unbudgeted rejections. Content is unchecked: "verified" is
  taken on faith. The runner tracks which files the cycle read
  (read_file/apply_edit calls flow through executeTool — confirm where a
  read-set could be accumulated).

PART D1 — gate the halt checkpoint + halt cost visibility (plan #5)
Spec must define:
1. In haltCycle: after checkpointAndRecord, run the QUICK-profile battery
   against the checkpointed tree (zero model tokens) and write its results
   into the record's gates_run. Handle: no container (skip, record why),
   battery crash (record 'unavailable', never block the halt), and time
   cap.
2. The record summary gains a "what actually landed" section: files
   touched + insertions (the diff --stat already rides the record — extend
   the summary line format, exact text specified) + which gates passed on
   that tree.
3. The resume bridge already injects lastCheckpoint.summary — verify the
   enriched summary flows through unchanged, and spec the one-line framing
   ("verified landed work — do not re-derive") added to
   buildResumeContextBlock.
4. Cost visibility: surface per-segment halt cost in the existing request
   log/UI surface — find where request-log.js output is rendered and spec
   the minimal addition (backend shape + where the frontend reads it; if
   frontend work is needed, note MOBILE_FIRST.md applies and keep it to
   an existing component pattern).
5. Tests: haltCycle on a tree with real changes → record with non-empty
   gates_run and file names in summary (empty gates_run today — regression
   fixture); haltCycle with no container → record still written with the
   skip reason.

PART D2 — "is this already done?" pre-check (plan #6)
Spec must define:
1. A pure matcher (new *-logic.js file, native-free, unit-tested): incoming
   instruction vs recent change-record summaries + pending_verification
   items within the project. Define the similarity approach concretely
   (normalised token overlap? exact-after-normalisation for the
   byte-identical case, plus a fuzzy tier?) with thresholds and test
   vectors from the report's real pairs: byte-identical pairs MUST match;
   a re-request of work a record claims shipped SHOULD match; two
   different instructions touching the same file MUST NOT.
2. The intercept point: where builds enter (routes.js quick-update flow /
   build-queue enqueue — find the single choke point) — on a strong match,
   do NOT enqueue; post a chat message naming the prior cycle/record with
   its summary and offer explicit "build anyway" (spec the exact flow —
   look at how other pre-build blocks like the audit questions post to
   chat and gate on a reply/button).
3. Fail-open: matcher error or no records → build proceeds unchanged.
4. Tests: the matcher vectors above; the intercept enqueues nothing on a
   match; "build anyway" enqueues.

PART D3 — machine-check the verified-vs-assumed ledger (plan #10)
Spec must define:
1. A read-set accumulator in the runner (files touched by read_file /
   apply_edit / write_file this cycle — decide which count as "read").
2. At finish: each assumptions.verified entry that cites a file (define
   the citation format the prompt already asks for — "(src/routes/x.ts)"
   — and spec a tolerant parser) is checked against the read-set; a
   verified claim citing an unread file is a REJECTION through the
   EXISTING shared finish budget (finish-guard-logic.js) — spec the
   rejection text. Entries citing no file get a warning in the record, not
   a rejection (justify).
3. Deploy gating: a permission/role/authz-shaped value in assumed[] (spec
   the detector — keyword list, tested) downgrades finish to
   pending_verification rather than deploying. Confirm the
   pending_verification path supports this and spec the operator message.
4. Tests: verified-citing-unread-file → rejected (with budget consumed);
   verified-citing-read-file → passes; role-string in assumed → concludes
   pending_verification not deployed.

DELIVERABLE
One markdown spec, sections D1/D2/D3: files + anchors, signatures, exact
message/summary text, test paths with named assertions, acceptance
checklist, verification commands, expected test delta.
```

---

## Usage notes

- **Run A first** — it is the measurement substrate plus the two one-liners.
  B, C, D can then be elaborated in parallel but should **land** in that
  order (C's new gates are far more passable once B's probes exist).
- Each Opus session should have repo access — the prompts instruct it to
  confirm the cited facts before building on them, so stale line numbers
  degrade gracefully.
- Hand Sonnet one spec section at a time, not a whole prompt's output —
  the specs are written to be independently implementable per section.
- The regression-fixture tests named in each prompt (assertions that FAIL on
  today's tree) are the acceptance signal: when they pass, the fix landed.
