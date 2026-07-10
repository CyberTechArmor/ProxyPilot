// Mock2 per-project egress allowlist (Phase M4, ADR-010).
//
// The filtering egress proxy (egress.js) permits a container to reach only the
// hosts on its project's allowlist; the bridge default-deny (firewall.js) blocks
// everything that tries to go around the proxy. This module is the data layer
// for that allowlist: the mock2_egress_allowlist table (migration 505), one row
// per (project, host).
//
// A new project is SEEDED with a static default set (below). The model-API
// hosts are seeded statically here because connectors are M5 (ADR-003); when M5
// lands, its connector hosts fold into this same list. The list is editable by
// admins (routes.js, audit-logged), and the squid ACL file is regenerated from
// these rows — never from a hardcoded list — so an edit takes effect on the
// next reconcile.
//
// Pure host-name validation lives in isAllowlistHost so it is unit-testable
// without the DB (stub-first, risk R9); the CRUD here is thin better-sqlite3.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { DEFAULT_EGRESS_ALLOWLIST, isAllowlistHost, normalizeAllowlistHost } from './network-logic.js';

// Re-exported so routes.js and provision.js import the allowlist surface from
// one module; the pure validators/defaults themselves live in network-logic.js
// (native-free, stub-first testable — risk R9).
export { DEFAULT_EGRESS_ALLOWLIST, isAllowlistHost, normalizeAllowlistHost };

const nowIso = () => new Date().toISOString();

export function listAllowlist(projectId) {
  return getMock2Db()
    .prepare(`SELECT host FROM mock2_egress_allowlist WHERE project_id = ? ORDER BY host`)
    .all(projectId)
    .map((r) => r.host);
}

// Add a host to a project's allowlist (idempotent on the UNIQUE constraint).
// Returns { added } — false when the host was already present.
export function addAllowlistHost(projectId, host, createdBy = null) {
  const h = normalizeAllowlistHost(host);
  const r = getMock2Db()
    .prepare(`INSERT OR IGNORE INTO mock2_egress_allowlist (project_id, host, created_by, created_at)
              VALUES (?, ?, ?, ?)`)
    .run(projectId, h, createdBy, nowIso());
  return { added: r.changes > 0, host: h };
}

export function removeAllowlistHost(projectId, host) {
  const h = normalizeAllowlistHost(host);
  const r = getMock2Db()
    .prepare(`DELETE FROM mock2_egress_allowlist WHERE project_id = ? AND host = ?`)
    .run(projectId, h);
  return { removed: r.changes > 0, host: h };
}

// Seed a new project's allowlist with the defaults, in one transaction. Called
// from the provisioning path (create only — a rehydrate keeps whatever the
// admin curated). Idempotent via INSERT OR IGNORE.
export function seedDefaultAllowlist(projectId, createdBy = null) {
  const db = getMock2Db();
  const insert = db.prepare(`INSERT OR IGNORE INTO mock2_egress_allowlist
    (project_id, host, created_by, created_at) VALUES (?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const host of DEFAULT_EGRESS_ALLOWLIST) insert.run(projectId, host, createdBy, nowIso());
  });
  tx();
  return listAllowlist(projectId);
}

// Every project's allowlist as a map { projectId: [host, …] } — for the squid
// ACL generator, which needs all projects' lists in one pass at reconcile.
export function allAllowlists() {
  const rows = getMock2Db()
    .prepare(`SELECT project_id, host FROM mock2_egress_allowlist ORDER BY project_id, host`)
    .all();
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.project_id)) out.set(r.project_id, []);
    out.get(r.project_id).push(r.host);
  }
  return out;
}
