// Mock2 module barrel. Imported dynamically from src/index.js ONLY when
// the gate resolves enabled (ADR-001), so importing this file — and the
// native better-sqlite3 it pulls in via ./db.js — never happens on a
// disabled or production-pinned host.
//
// The gate itself (resolveMock2Gate) is intentionally NOT re-exported
// here for the disabled path: index.js imports it straight from
// ./gating.js so the decision can be made without loading anything native.

export { initMock2Db, getMock2Db, mock2DbPath, sweepMock2OnBoot } from './db.js';
export { createMock2Router } from './routes.js';
export { reconcileMock2Domains } from './reconcile.js';
export { sweepIdleStops } from './idle.js';
// M4 network isolation: re-apply the per-project nftables fence + regenerate the
// squid egress ACLs after a restart (l4-reconciler boot pattern). Both are
// DB-authoritative and non-fatal.
export { reconcileMock2Firewall } from './firewall.js';
export { reconcileMock2Egress } from './egress.js';
// M5 connectors + quotas + git connectors + framework registry. The router
// (routes.js) imports the data-access modules directly; only the boot seed is
// re-exported here for index.js's first-enabled-boot insert (ADR-003 / R8).
export { seedFrameworkV1 } from './framework.js';
