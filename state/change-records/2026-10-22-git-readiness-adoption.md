# Portable Git readiness seed adoption

The owner requested completion and publication of the remaining local-Git and
optional external-Git integration. This public ProxyPilot change adopts the
canonical Mock2 1.35.0 guidance and its dedicated five-module Git readiness
slice plus guide. It contains no private Flightdeck source.

Source: `mock2-core` 1.35.0, release.json SHA-256
`7a3eea91ef84f43033386da14c7735b5fb1805ba2f624b8d4abe2991bc40fab6`.
Acquisition verifies all included release hashes and physical source paths,
deduplicates identical source aliases, and refuses conflicting identities,
missing/disallowed dependencies, dynamic imports and unsupported declaration
formatting before any generated seed is written. Separate runtime provenance
records exactly what is emitted; existing protected platform instructions remain.

Validation freshly rerun at 2026-10-22T17:53Z: 32/32 tests passed across upstream-guidance,
mock2-git-guidance-sync, mock2-standards-seed and mock2-framework. The emitted
CLI actually inspected a temporary ordinary local folder without creating a
repository. Acquisition regressions cover multiline/same-line imports and
re-exports, unknown syntax refusal, hash tampering, incomplete closures,
application dependencies and symlink escapes. `git diff --check` passed.
Independent review identified the same-line import omission; it was repaired
and pinned by regression tests.

This is source adoption, not a live deployment or rollout to existing project
checkouts. No Git installation, external-provider operation or private companion
operation ran. The shared ProxyPilot candidate and its concurrent commits were
not changed. Publication/release integration remains with the coordinator.
