// Mock2 parent-domain data access (mock2_parent_domains, in mock2.db).
//
// Thin CRUD over the block-500 table. All decision logic (validation, the
// selectable predicate, response shaping) lives in the pure domain-logic.js so
// it can be unit-tested without this native (better-sqlite3) module. Reached
// only on an enabled host through the gated router.

import { existsSync } from 'fs';
import { getMock2Db } from './db.js';
import { getDb, getAdminDomain } from '../db.js';
import { evaluateBaseDomain } from './domain-logic.js';

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

// ---- base-domain (apex) availability ----
//
// A project may serve on the parent domain ITSELF (example.com) instead of a
// minted subdomain, but only when nothing else on this host already answers
// there. The verdict is evaluateBaseDomain's (pure); this is the shell that
// gathers what it judges: the main DB's services + their extra HTTP routes, the
// dashboard's own domain, the Mock2 projects that already hold a hostname, and
// whether Caddy has a site file for it (the LXC inline-services surface writes
// those with no `services` row behind them — routes/lxc.js).

const CADDY_SITES_DIR = process.env.CADDY_SITES_DIR || '/etc/caddy/sites';

// Every one of the four lookups is individually guarded: a missing table or an
// unreadable settings row must not 500 the create dialog. Failing a lookup only
// ever makes the answer MORE permissive, so the create/attach routes re-check
// and the true conflict still surfaces as a Caddy reload error, not a silent
// hijack of someone else's hostname.
function safely(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

// Both naming conventions the site dir has carried: services.js writes the bare
// domain as the file name, and the newer merged-config paths use `<domain>.caddy`.
function caddySiteFileExists(domain) {
  if (!domain || !/^[a-z0-9][a-z0-9.-]*$/.test(domain)) return false;
  return safely(
    () => existsSync(`${CADDY_SITES_DIR}/${domain}`) || existsSync(`${CADDY_SITES_DIR}/${domain}.caddy`),
    false,
  );
}

// One snapshot of everything that can already claim a hostname, so shaping a
// whole domain list costs two queries rather than two per domain.
//
// Service domains live on service_http_routes (D.14 dropped services.domain —
// selecting it here would throw on every migrated install and silently empty
// the list), so the named service claims come from the join. The bare routes
// list is kept as a belt-and-braces fallback: if the join ever fails, a raw
// route row still blocks the hostname, just with a generic label.
export function hostnameClaimSnapshot() {
  return {
    services: safely(() => getDb().prepare(`
      SELECT s.id AS id, s.name AS name, r.domain AS domain
        FROM service_http_routes r
        INNER JOIN services s ON s.id = r.service_id
    `).all(), []),
    routes: safely(() => getDb().prepare(`SELECT id, service_id, domain FROM service_http_routes`).all(), []),
    projects: safely(() => getMock2Db().prepare(`
      SELECT id, name, custom_domain, lifecycle FROM mock2_projects
       WHERE custom_domain IS NOT NULL AND custom_domain <> ''
    `).all(), []),
    adminDomain: safely(() => getAdminDomain(), null),
  };
}

// baseDomainStatus(domain, opts) → the evaluateBaseDomain verdict for one
// hostname. Pass `snapshot` when checking several domains in a row;
// `excludeProjectId` when the caller is re-checking a hostname the project in
// hand may already hold (so it doesn't conflict with itself).
export function baseDomainStatus(domain, { snapshot = null, excludeProjectId = null } = {}) {
  // Same host normalization evaluateBaseDomain applies (a wildcard is NOT
  // stripped — it fails the check there rather than silently becoming the apex).
  const target = String(domain ?? '').trim().toLowerCase().replace(/\.$/, '');
  const snap = snapshot || hostnameClaimSnapshot();
  return evaluateBaseDomain({
    domain: target,
    services: snap.services,
    routes: snap.routes,
    projects: snap.projects,
    adminDomain: snap.adminDomain,
    siteFileExists: caddySiteFileExists(target),
    excludeProjectId,
  });
}
