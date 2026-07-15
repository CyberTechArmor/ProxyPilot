# MIGRATION.md — existing projects under the integration-truthfulness harness

How already-shipped projects (including ADP2-style projects that already carry a
faked integration) and unscannable projects behave on their next cycle under the
updated harness. The guiding rule: **additive and reversible; historical records
are immutable; analysis failure is never reported as "clean."**

## Schema migration (mock2.db)

Migration **520** (`mock2_integration_truthfulness`) is strictly additive:

- `mock2_cycles.verification_state` (nullable TEXT) — `NULL` (the pre-existing
  behavior, no external integrations in scope), `'pending'`
  (pending-operator-verification), or `'verified'`.
- `mock2_cycles.integration_gate_json` (nullable TEXT) — the B.4 gate result
  stamped at finish.
- `mock2_integration_verifications` (new table) — append-only operator-verification
  evidence with a `supersedes_id` chain.
- `mock2_integration_findings` (new table) — append-only integration-gate /
  screening / migration findings, content-hashed and `source_ref`-linked.

Every pre-existing cycle row reads exactly as before (`verification_state` and
`integration_gate_json` are `NULL`). Old change records, cycles, and their hashes
are untouched — nothing is rewritten or rehashed. A disabled host never runs any
of this (block-500 migrations only ever run inside `data/db/mock2.db`).

In-repo state files: new projects seed `state/integrations.json` and
`state/stub-registry.json` (empty, schema_version 1) via `buildSeedFiles`, so the
paths exist and ride the hash-chained history. An **existing** project without
these files is handled by the scan below (the analyzer treats an absent manifest
as an empty manifest and relies on source discovery).

## First cycle under the updated harness (per project, idempotent)

On the first build cycle a project runs under the updated harness,
`scanProjectForLegacyStubs` (invoked once at cycle start, idempotent via a
`migration`-origin marker) does the following:

1. Reads the produced source snapshot (`src/**`, `tests/**`,
   `state/integrations.json`) from the fenced container.
2. Runs the **B.4 capability-based analyzer**, referencing the project's manifest
   or bootstrapping proposed entries from source discovery when none exists.
3. Records the results as **non-blocking** `mock2_integration_findings` rows:
   - a real fabrication/no-I/O-test finding → `suspected_legacy_stub`
     (`blocking = false` at scan time);
   - `provenance_not_established` / unsupported language / unreadable tree →
     `analysis_incomplete` (see below);
   - an undeclared outbound integration → `undeclared_integration` (a manifest is
     bootstrapped for operator confirmation).
4. If nothing is suspected, records a `migration_scan_clean` marker — so a clean
   project is recorded as *"scanned, nothing suspected,"* **never** silently
   absent, and the scan is not re-run.

The scan **never blocks** the first cycle from starting; it only records state.

## When a recorded finding becomes blocking

A recorded non-blocking finding crosses into **blocking**
(`legacyFindingBlocking`) when **either** happens first:

- **A cycle touches the affected subsystem.** At finish, the runner computes the
  touched subsystems from this cycle's diff; any open `suspected_legacy_stub` /
  `analysis_incomplete` on a touched subsystem forces `outcome =
  blocked-deviation` (the cycle cannot report `succeeded`). This is what makes the
  faked-integration debt actionable exactly when someone works on it.
- **The next framework-version reconciliation.** When the project's pinned
  framework version advances past the version a finding was recorded under, the
  finding becomes blocking regardless of what the cycle touches.

Until one of those occurs, the findings are visible (via
`GET /projects/:id/integration-status`) but do not block unrelated work — a
project mid-flight is not bricked by the upgrade.

## ADP2 specifically

On ADP2's next cycle:

- The migration scan flags `syncFromAdp` (fabricated roster) and `testAdp`
  (presence-only connection test) as `suspected_legacy_stub` on the `adp` /
  `employees` subsystems — non-blocking, recorded.
- The moment a cycle touches `src/employees/` or `src/adp/`, those findings block
  `succeeded`; the runner halts as a blocking deviation with the actionable
  findings and resolution options (implement the real integration → moves to
  pending-operator-verification; or an admin approves it as a recorded, severity-
  tagged, UI-labeled simulation in the stub registry).
- If the operator instead re-runs the whole capability honestly, the finish-time
  integration gate passes and the cycle lands in `pending-operator-verification`
  with a live checklist derived from the (now-declared) manifest.

## Unscannable projects (analysis-incomplete)

When migration cannot analyze a project conclusively — an unsupported language, a
missing artifact, an unreadable tree, or unresolved configuration — the scan
records a versioned `analysis_incomplete` finding stating **exactly** what could
not be analyzed (e.g. *"provenance not established — src/people/service.py"*). It
is:

- **non-blocking initially**, and
- **becomes blocking under the same touched-subsystem / reconciliation rules** as
  a suspected stub.

Analysis failure is **never** reported as "no stubs found." The distinction is
explicit in the status endpoint and in the `migration-analysis-incomplete`
reported outcome (code 73).

## Backward compatibility summary

| Concern | Behavior |
|---|---|
| Old change-record hashes | untouched; supersession/migration create NEW rows referencing old ones |
| Pre-existing cycles | read identically (`verification_state`/`integration_gate_json` NULL) |
| Disabled host | none of this runs (mock2.db never exists) |
| A project that never touches an integration | never sees a checklist; `succeeded` behaves as before |
| Existing pinned framework versions | keep their (immutable) constitution; §7a/§7b apply to projects built on a framework version published from the updated seed |
| Re-running the scan | idempotent (marker finding) — no duplicate findings |
