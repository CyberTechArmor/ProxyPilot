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
// Quick connect (VS Code / git over smart HTTP): its own router because git
// clients authenticate with connect tokens (HTTP Basic), not session cookies —
// index.js mounts it at /api/mock2/git BEFORE the cookie-authenticated mount.
export { createMock2GitRouter } from './connect.js';
// M6 checkout-lock idle sweep (ADR-004): auto-release stale human checkouts. The
// boot sweep (sweepMock2OnBoot) already releases orphaned CYCLE locks; this is the
// periodic reclaim for human holds. index.js runs it on boot + on a timer.
export { sweepMock2Locks } from './locks.js';
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
export { seedFrameworkV1, upgradeFrameworkFromSeed } from './framework.js';
// Automatic framework adoption (ADR-003 amendment): starts the update cycle
// for drifted, idle, online projects — on boot (after the seed upgrade may
// have published a new version) and on a slow timer.
export { sweepFrameworkAutoAdopt } from './auto-adopt.js';
// Stall watchdog: stop running cycles that went silent (dropped API
// connection) and requeue orphaned build-queue entries — the "platform is
// stuck with nothing to click" recovery. index.js runs it every 60s.
export { sweepStalledBuilds } from './stall-watchdog.js';
export { seedBuiltinComponents } from './component-seed.js';
export { loadCustomDesignPresets } from './design-presets-store.js';
// Project terminal authorizer (ADR-007). Registered into the core
// streaming-terminal route (setMock2TerminalAuthorizer) on enabled boot so the
// core file never statically imports mock2/db.js (ADR-001).
export { mock2TerminalAuthorize } from './terminal.js';
