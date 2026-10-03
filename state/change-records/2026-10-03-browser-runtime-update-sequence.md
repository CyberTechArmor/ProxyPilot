# Deliver runtime upgrades without blocking application updates

The fixed package operation must remain callable after delivering newer runtime
source. Ordinary updates previously compared installed runtime helpers with the
new candidate, refusing precisely the delivery needed to invoke that operation.

Selected preservation now authenticates installed code and units against the
committed root package transaction and its retained private generation. It still
attests current delivered source, validates candidate contracts, verifies serving
identity and installed journals, and preserves protected data, renewal behavior,
idle admission and recovery. New source alone does not change runtime files,
restart runtime services, enable a capability or create acceptance. The dedicated
package install/update action remains responsible for replacement.

Regression coverage exercises newer-source delivery followed by explicit package
update, retained-generation corruption, changed installed code with a matching
mutable journal, and preservation after rolling back a package upgrade while
newer source remains delivered. Baseline: repository-pinned Mock2 1.14.0; no
dependency, Incus, other application or database-schema changes.

All 21 local preservation tests pass. Independent review, exact-head CI and
deployed verification are pending. Local tests do not establish actual host
installation or normal-update proof.
