// A guest's HTTP routes: the one `services` row an LXC guest owns, its
// upstream address, and the route rows created for it at creation time —
// over a database handle and the Caddy render bundle (lib/route-render.js),
// with no native import, so the backend-executed `configure_routes` setup
// step (lib/setup-engine/backend-steps.js) and the dashboard's route
// handlers share it and the suite runs it on node:sqlite.
//
// Routes created at container-create time used to be written straight to
// disk with no database row at all, which made them invisible to every
// name-based lookup. They are ordinary routes: rows first, the site file
// derived from them like any other.

import { v4 as uuidv4 } from 'uuid';
import { applyServiceUpstream, renderDomains, isLeaseLost } from './route-render.js';

// findOrCreateLxcService(db, name, ip) → the guest's services row.
// Deliberately does NOT write target_ip on an existing row: one services row
// owns every route on the container, so writing the new address makes it
// live for ALL of them while a caller may go on to re-render only the
// domain it is editing. That is exactly how a route ended up stranded on an
// address a lease had since reassigned to another guest: the row said one
// address, its site file another, and nothing reconciled them. Callers use
// syncServiceUpstream(), which moves the address and re-renders every
// affected domain together, or leave both stores alone.
export function findOrCreateLxcService(db, name, ip, { uuid = uuidv4 } = {}) {
  const existing = db.prepare(`SELECT * FROM services WHERE lxc_container_name = ? AND is_admin = 0 LIMIT 1`).get(name);
  if (existing) return existing;
  const id = uuid();
  db.prepare(`INSERT INTO services (id, name, kind, runtime, target_ip, lxc_container_name, type, status) VALUES (?, ?, 'container_service', 'lxc', ?, ?, 'docker', 'active')`).run(id, name, ip, name);
  return db.prepare(`SELECT * FROM services WHERE id = ?`).get(id);
}

// syncServiceUpstream(db, service, ip, render) → { changed, domains,
// warning }: moves the row's address and re-renders what it already served,
// atomically across both stores (route-render applyServiceUpstream); a
// failure leaves both where they were and says so.
export async function syncServiceUpstream(db, service, ip, render, fence = null) {
  if (!service || !ip || service.target_ip === ip) return { changed: false, domains: [], warning: null };
  try {
    const result = await applyServiceUpstream({ db, serviceId: service.id, ip, render, fence });
    if (result.changed) service.target_ip = ip;
    return { changed: result.changed, domains: result.domains, warning: null };
  } catch (e) {
    if (isLeaseLost(e)) throw e;
    const detail = e?.message || String(e);
    return { changed: false, domains: [], warning: `Container address moved to ${ip} but the existing routes could not be re-rendered (${detail}). Those routes still point at ${service.target_ip || 'an unrecorded address'}.` };
  }
}

// configureGuestRoutes(db, { name, ip, services, render, fence }) → {
//   serviceId, created: [domain], existing: [domain], conflicts: [{ domain,
//   detail }], rendered: [domain], renderWarning, upstreamWarning }
// Idempotent: a domain already routed to THIS guest's service is `existing`
// (a retry re-renders it, never duplicates it); one routed elsewhere is a
// conflict that is reported and never clobbered. The render covers the
// created and existing domains together; its failure leaves the rows
// (`renderWarning`) — a retry renders them again. `fence()` is called before
// every write — each row, the upstream move and every write inside it, each
// domain's site file, the validation, the reload, and every write of a
// rollback (lib/route-render.js): a caller whose lease is no longer its own
// throws from it, nothing further is written, no rollback touches what is
// now another owner's, and the lease error surfaces as such.
export async function configureGuestRoutes(db, { name, ip, services, render, uuid = uuidv4, fence = null }) {
  const check = () => { if (typeof fence === 'function') fence(); };
  check();
  const svc = findOrCreateLxcService(db, name, ip, { uuid });
  check();
  const sync = await syncServiceUpstream(db, svc, ip, render, fence);
  const created = []; const existing = []; const conflicts = [];
  for (const s of services) {
    check();
    const domain = String(s.domain).toLowerCase();
    const row = db.prepare(`SELECT service_id FROM service_http_routes WHERE domain = ? AND path_prefix = '/'`).get(domain);
    if (row) {
      if (row.service_id === svc.id) existing.push(domain);
      else conflicts.push({ domain, detail: 'already routed elsewhere; not added' });
      continue;
    }
    try {
      db.prepare(
        `INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size, strip_prefix, health_path)
         VALUES (?, ?, ?, '/', ?, 0, ?, ?, '1G', 0, ?)`,
      ).run(uuid(), svc.id, domain, Number(s.port), s.obtainCert === false ? 0 : 1, s.obtainCert === false ? 0 : 1, s.healthPath || null);
      created.push(domain);
    } catch (e) {
      conflicts.push({ domain, detail: `could not add: ${e?.message || e}` });
    }
  }
  const toRender = [...created, ...existing];
  let rendered = []; let renderWarning = null;
  if (toRender.length) {
    check();
    try { rendered = (await renderDomains({ db, domains: toRender, ...render, fence })).domains || []; } catch (e) { if (isLeaseLost(e)) throw e; renderWarning = `Routes were recorded but Caddy was not updated: ${e?.message || e}`; }
  }
  return { serviceId: svc.id, created, existing, conflicts, rendered, renderWarning, upstreamWarning: sync.warning || null };
}
