# PATCH-AUDIT.md — the blocked-deviation resolution deadlock

Part A of the harness patch. The integration-truthfulness gate (`0948d04`) works —
on ADP3 it caught 7 simulated/undeclared external capabilities and blocked with
`blocked-deviation`, exactly as designed. **Detection is not the problem.** The
problem is that the operator is trapped: every offered resolution re-produces the
identical blocker on resume. This audit reproduces the loop and locates its three
root causes with file:line references into the harness at `0948d04`.

## The loop, reproduced (behavioral RED)

`src/__tests__/mock2-resolution-deadlock.test.js` reproduces the ADP3 condition
against the current modules (no missing-module errors — a behavioral red):

```
node --test src/__tests__/mock2-resolution-deadlock.test.js
ok 1  - A.1: ADP3 undeclared findings block, and the re-scan reproduces them identically (loop)
not ok 2 - A.1: a blocked undeclared capability must offer a manifest-backfill resolution
not ok 3 - A.2: unprovable-but-real code yields provenance_not_established with no clearing option
# tests 3 · pass 1 · fail 2
```

Captured gate output for the ADP3 shape (two outbound integrations, no manifest):

```
outcome: blocked-deviation
finding kinds:  [ 'undeclared_integration', 'undeclared_integration' ]
offered option ids: [ 'implement_real', 'approve_simulation', 'declare_egress' ]
```

Test 1 passes because it documents the loop: re-running the gate with the manifest
unchanged yields the identical finding set. Tests 2 and 3 fail because no offered
option can create a manifest entry (root cause 1) and no waiver exists for
unprovable-but-real code (root cause 2).

## Root cause 1 — offered resolutions cannot resolve `undeclared` findings

`blockingSummary` (`admin/backend/src/mock2/integration-enforcement.js:126-142`)
returns a FIXED three-option list regardless of which finding classes are present:

```
options: [
  { id: 'implement_real',     … },   // writes real code — does NOT declare a manifest entry
  { id: 'approve_simulation', … },   // stub-registry entry — does NOT declare a manifest entry
  { id: 'declare_egress',     … },   // mock2.yaml egress — does NOT declare a manifest entry
]
```

An `undeclared_integration` finding (`integration-logic.js:481-487`) is cleared
ONLY by adding a `state/integrations.json` entry for that subsystem
(`analyzeIntegrations` §2, `integration-logic.js:478-487`, which flags any dialing
subsystem absent from `declaredSubsystems`). None of the three options writes the
manifest, so:

- pick any option → resume → the build re-runs → `analyzeIntegrations` re-scans the
  same tree against the same empty manifest → the identical `undeclared` findings
  → `blocked-deviation` again.

A blocker whose offered resolutions cannot address its finding class is a deadlock
by construction. **Confirmed.**

### Why the manifest is empty (compounding cause)

Define does NOT generate or backfill manifest entries for interview-captured
integrations. A repo-wide search finds nothing in the Define/audit path that writes
`state/integrations.json`:

- `admin/backend/src/mock2/audit.js`, `audit-logic.js`, `concept.js` — no manifest
  generation (grep for `integrations.json` / `manifest` returns nothing).
- The ONLY writer of `state/integrations.json` is the scaffold seed
  (`admin/backend/src/mock2/template.js:222`), which seeds it **empty**:
  `{ "schema_version": 1, "entries": [] }`.

So every project — ADP3 included — reaches the gate with zero manifest entries, and
every outbound capability is permanently `undeclared`. `bootstrapManifestFromDiscovery`
(`integration-logic.js:501-520`) can *propose* entries and the decision even carries
them (`integration-enforcement.js:104-105`), but nothing turns a proposal into a
committed, operator-confirmed manifest entry.

## Root cause 2 — no waiver path for source-level findings

The gate correctly fails closed with `provenance_not_established` when it cannot
analyze a declared subsystem (`integration-logic.js:380-390`: no analyzable source,
or an unsupported language). But the admin false-positive/waiver path exists ONLY
for lexical finish-screening candidates (`screening-logic.js` tiers → the queue
resolution), never for source-level gate findings. `blockingSummary` offers no
"confirmed real — analysis limitation" option, so when a builder writes genuinely
real transport code the conservative analyzer cannot prove (e.g. a polyglot service
whose integration is implemented in Python, or a destination assembled through an
intermediate helper the call-graph does not trace), the operator's only offered
moves are:

- **mislabel real code as an approved simulation** (`approve_simulation`) — which
  is false and pollutes the stub registry, or
- **loop forever**.

Reproduced in test A.2: a manifest-declared `directory` integration implemented in
`src/directory/service.py` → `provenance_not_established` → no clearing option.
**Confirmed.**

## Root cause 3 — the honest path may be unwalkable in-fence

The `implement_real` option promises "real transport code + in-fence contract
fixtures," but **project scaffolds ship no contract-fixture server tooling**:

- `admin/backend/src/mock2/scaffold.js:379-391` — the scaffold file list is
  `package.json`, `tsconfig`, `vitest.config`, `src/server.ts`, `src/app.ts`,
  `src/config.ts`, `src/db/*`, `src/middleware/security.ts`, `src/health/*`,
  `migrations/0001_init.sql`, `scripts/migrate.mjs`. There is **no** local
  TLS/fixture-server module and no `CONTRACT_FIXTURE_*` scaffolding.

The harness repo received contract-fixture capability, but a project build container
has none. When an external endpoint is unreachable from the fence (the normal case)
and the builder cannot stand up a local contract fixture, each honest attempt still
cannot pass the execution/provenance checks — so it stubs, and the gate blocks
again. The original incentive gradient, now looping in front of a tripwire.
**Confirmed as a gap** (the loop is dominated by root cause 1; this is why even the
"right" option is hard to satisfy).

## Findings → patch mapping

| Root cause (evidence) | Fix |
|---|---|
| Options fixed, cannot clear `undeclared` (`integration-enforcement.js:126-142`) | B.1 class-matched options + "Declare it — backfill the manifest entry"; invariant test |
| No waiver for `provenance_not_established` (`integration-logic.js:380-390`; no option) | B.2 analysis-limitation waiver → `pending-operator-verification`, hash-linked, refused for fabricated |
| No fixture-server tooling in scaffolds (`scaffold.js:379-391`) | B.3 scaffold fixture server + `fixture-tooling-missing` class with its own resolving option |
| A deadlock presents as fresh progress | B.4 loop breaker: N=2 identical finding sets → `resolution-ineffective`, full findings inline |
| Define never backfills the manifest (`template.js:222`; nothing in `audit*.js`) | B.1 backfill action makes declaration a first-class, operator-confirmed resolution |
