// Mock2 parent-domain data access (mock2_parent_domains, in mock2.db).
//
// Thin CRUD over the block-500 table. All decision logic (validation, the
// selectable predicate, response shaping) lives in the pure domain-logic.js so
// it can be unit-tested without this native (better-sqlite3) module. Reached
// only on an enabled host through the gated router.

import { getMock2Db } from './db.js';

export function listParentDomains() {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_parent_domains ORDER BY domain`)
    .all();
}

export function getParentDomain(id) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_parent_domains WHERE id = ?`)
    .get(id);
}

export function getParentDomainByName(domain) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_parent_domains WHERE domain = ?`)
    .get(domain);
}

// Insert a freshly-registered domain in the 'pending' state (disabled until it
// verifies AND an admin enables it). dns_provider/dns_credentials_enc/cert_path
// stay NULL — the deferred wildcard DNS-01 columns (ADR-009).
export function insertParentDomain({ domain, createdBy }) {
  const r = getMock2Db().prepare(`
    INSERT INTO mock2_parent_domains (domain, verify_status, enabled, created_by, created_at)
    VALUES (?, 'pending', 0, ?, datetime('now'))
  `).run(domain, createdBy ?? null);
  return getParentDomain(r.lastInsertRowid);
}

// Patch a subset of columns on one domain row. Only whitelisted columns are
// writable — the deferred DNS columns and identity columns are not touched
// here.
const WRITABLE = new Set([
  'verify_status', 'verified_at', 'last_renewal_at', 'renewal_error', 'enabled',
]);
export function updateParentDomain(id, patch = {}) {
  const cols = Object.keys(patch).filter((k) => WRITABLE.has(k));
  if (cols.length === 0) return getParentDomain(id);
  const set = cols.map((c) => `${c} = ?`).join(', ');
  const vals = cols.map((c) => patch[c]);
  getMock2Db().prepare(`UPDATE mock2_parent_domains SET ${set} WHERE id = ?`).run(...vals, id);
  return getParentDomain(id);
}

export function deleteParentDomain(id) {
  return getMock2Db().prepare(`DELETE FROM mock2_parent_domains WHERE id = ?`).run(id).changes > 0;
}
