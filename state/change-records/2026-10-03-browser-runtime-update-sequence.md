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

All 21 local preservation tests passed locally and independently. Review found no
blocking issues. Exact-head CI for 50941135bd2c662c06af5e8aa1ea1d7cd9c7a321
passed all three workflows. Initial backend job 111262200848 timed out in unchanged
Chromium startup before navigation; single rerun 111263090088 passed unchanged.
Failure evidence remains in GitHub; cause is unproven and timeouts were not widened.

Merged as cad71e96f61b9640ba3c69fc4754ec1c1f2fffec. Deployment
233d0b85-916b-442c-9881-d951a879044d succeeded at 18:26:22Z with empty flags;
running build and host agent identify cad71e96f6. The runtime is not installed,
so this is deployment/health proof, not expanded-runtime update acceptance.
