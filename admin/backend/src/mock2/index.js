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
