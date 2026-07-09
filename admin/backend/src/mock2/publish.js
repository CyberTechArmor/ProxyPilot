// Mock2 Caddy publish aggregator (Phase M2).
//
// A parent domain's Mock2 Caddy file holds ONE block per active FQDN across ALL
// of that domain's projects (buildMock2DomainConfig, M1). Slug mint, rotate,
// archive, and delete all change which FQDNs are active, so every one of those
// paths recomputes the domain's full active set and rewrites the single file —
// never edits it in place. This module is that recompute, shared by the routes,
// the provisioning job, and the boot reconcile so there is one implementation
// of "what should this domain's Caddy file contain right now."
//
// Pure aggregation (projectActiveFqdns, rotation grace) lives in
// project-logic.js; this module is the DB-reading + Caddy-writing shell.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { getParentDomain } from './domains.js';
import { listGraceSlugs } from './projects.js';
import { projectActiveFqdns } from './project-logic.js';
import { writeMock2DomainSite, reloadMock2Caddy } from './caddy.js';

// All projects that route under a given parent domain (any lifecycle — the
// pure filter drops archived/failed/no-upstream ones).
function projectsForDomain(parentDomainId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_projects WHERE parent_domain_id = ?`)
    .all(parentDomainId);
}

// computeDomainFqdns(parentDomainId, now) → the flat [{ fqdn, upstream, note }]
// list the domain's Caddy file should contain, across every project on it
// including rotation-grace slugs.
export function computeDomainFqdns(parentDomainId, now = new Date().toISOString()) {
  const domain = getParentDomain(parentDomainId);
  if (!domain) return { domain: null, fqdns: [] };
  const projects = projectsForDomain(parentDomainId);
  const fqdns = [];
  for (const p of projects) {
    // projectActiveFqdns needs the parent-domain STRING to build the FQDN.
    p.parent_domain = domain.domain;
    const grace = listGraceSlugs(p.id);
    fqdns.push(...projectActiveFqdns(p, grace, now));
  }
  return { domain, fqdns };
}

// publishDomain(parentDomainId, now) — recompute + rewrite the domain's Caddy
// file + reload. Returns the reloadMock2Caddy result ({ ok } | { ok:false,
// error }) so callers can surface a reload/ACME failure as a notification, not
// a 500. Never throws.
export async function publishDomain(parentDomainId, now = new Date().toISOString()) {
  try {
    const { domain, fqdns } = computeDomainFqdns(parentDomainId, now);
    if (!domain) return { ok: false, error: 'parent domain not found' };
    await writeMock2DomainSite(domain.domain, fqdns);
    return await reloadMock2Caddy();
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
