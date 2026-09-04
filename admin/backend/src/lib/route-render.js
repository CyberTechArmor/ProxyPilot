// The single seam for moving a service's upstream address.
//
// Why this module exists
// ----------------------
// `services.target_ip` is a cache of the guest's address on the Incus bridge,
// and each domain's Caddy site file is a second cache of the same fact. There
// is one `services` row per LXC and it owns EVERY route on that container, so
// the two caches only stay in agreement if a change to the row re-renders every
// domain that reads it.
//
// They did not. `findOrCreateLxcService()` updated `target_ip` whenever it
// noticed the address had moved, and its callers re-rendered only the one
// domain they were writing. Adding or editing a single hostname on a container
// therefore advanced the database for all of that container's routes while
// leaving every other hostname's site file frozen at the old address. In the
// field that stranded git.fractionate.ai on an address a DHCP lease had since
// handed to a different project's guest.
//
// `applyServiceUpstream()` is the fix: update the row, re-render every domain
// the service touches, validate, reload — and on any failure put both stores
// back the way they were. `refresh-ip` in routes/services.js already did this
// correctly for one endpoint; this generalises it so no caller can do it wrong.
//
// See docs/incidents/2026-09-04-route-config-drift.md.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Every domain whose Caddy config is derived from a given service row.
 *
 * @param {object} db      better-sqlite3 handle
 * @param {string} serviceId
 * @returns {string[]}
 */
export function domainsForService(db, serviceId) {
  try {
    return db
      .prepare(`SELECT DISTINCT domain FROM service_http_routes WHERE service_id = ?`)
      .all(serviceId)
      .map((r) => r.domain)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Snapshot the on-disk config for a set of domains so a failed apply can be
 * rolled back byte-for-byte.
 *
 * @param {string[]} domains
 * @param {(domain: string) => string} caddyFilePath
 * @returns {Promise<Array<{domain: string, path: string, existed: boolean, content: string|null}>>}
 */
export async function snapshotDomainConfigs(domains, caddyFilePath) {
  const out = [];
  for (const domain of domains) {
    const path = caddyFilePath(domain);
    let content = null;
    let existed = false;
    if (existsSync(path)) {
      try {
        content = await readFile(path, 'utf-8');
        existed = true;
      } catch {
        // Continue without a backup for this domain; the apply still proceeds
        // and the remaining domains stay restorable.
      }
    }
    out.push({ domain, path, existed, content });
  }
  return out;
}

/**
 * Re-render every domain a service serves, then validate and reload Caddy.
 *
 * Dependencies are injected rather than imported so this module stays free of
 * the routes layer (routes/services.js already imports from lib/), and so the
 * whole apply path is unit-testable without a filesystem or a Caddy binary.
 *
 * On failure every site file is restored from the snapshot, Caddy is reloaded
 * back onto the known-good config, and the error is rethrown. Callers that also
 * changed the database are responsible for undoing their own rows — see
 * `applyServiceUpstream`, which does both.
 *
 * @param {object}   opts
 * @param {object}   opts.db
 * @param {string[]} opts.domains
 * @param {(db: object, domain: string) => Promise<void>} opts.regenerate
 * @param {() => Promise<unknown>} opts.adapt   `caddy adapt` — config validation
 * @param {() => Promise<unknown>} opts.reload  `caddy reload`
 * @param {(domain: string) => string} opts.caddyFilePath
 * @param {(path: string, content: string) => Promise<void>} opts.writeConfig
 * @param {(path: string) => Promise<void>} opts.removeConfig
 * @returns {Promise<{domains: string[]}>}
 */
export async function renderDomains({
  db,
  domains,
  regenerate,
  adapt,
  reload,
  caddyFilePath,
  writeConfig,
  removeConfig,
}) {
  const targets = [...new Set(domains.filter(Boolean))];
  if (targets.length === 0) return { domains: [] };

  const backups = await snapshotDomainConfigs(targets, caddyFilePath);

  const restore = async () => {
    for (const b of backups) {
      try {
        if (b.existed && b.content !== null) await writeConfig(b.path, b.content);
        else await removeConfig(b.path);
      } catch (e) {
        console.error(`[route-render] restore failed for ${b.domain}:`, e?.message || e);
      }
    }
    try { await reload(); } catch { /* already reporting the original failure */ }
  };

  try {
    for (const domain of targets) await regenerate(db, domain);
  } catch (err) {
    await restore();
    throw new Error(`Failed to render Caddy config: ${err?.message || err}`);
  }

  // Never leave Caddy running a config we have not validated.
  try {
    await adapt();
  } catch (err) {
    await restore();
    throw new Error(
      `Generated Caddy config failed validation: ${err?.stderr || err?.message || err}`
    );
  }

  try {
    await reload();
  } catch (err) {
    await restore();
    throw new Error(`Caddy reload failed: ${err?.stderr || err?.message || err}`);
  }

  return { domains: targets };
}

/**
 * Move a service's upstream address and bring every domain it serves along
 * with it, atomically across both stores.
 *
 * No-ops (without touching Caddy) when the address is unchanged, so callers can
 * invoke it unconditionally on any path that has a fresh address in hand.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {string} opts.serviceId
 * @param {string} opts.ip                  the guest's current address
 * @param {object} opts.render              the dependency bundle for renderDomains
 * @returns {Promise<{changed: boolean, oldIp: string|null, newIp: string, domains: string[]}>}
 */
export async function applyServiceUpstream({ db, serviceId, ip, render }) {
  const row = db.prepare(`SELECT id, target_ip FROM services WHERE id = ?`).get(serviceId);
  if (!row) throw new Error(`Service ${serviceId} not found`);

  const oldIp = row.target_ip ?? null;
  if (!ip || oldIp === ip) {
    return { changed: false, oldIp, newIp: ip ?? oldIp, domains: [] };
  }

  const domains = domainsForService(db, serviceId);

  db.prepare(
    `UPDATE services SET target_ip = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(ip, serviceId);

  try {
    await renderDomains({ db, domains, ...render });
  } catch (err) {
    // renderDomains has already restored the site files; put the row back too
    // so the two stores stay in agreement on the failure path.
    try {
      db.prepare(`UPDATE services SET target_ip = ? WHERE id = ?`).run(oldIp, serviceId);
    } catch (e) {
      console.error('[route-render] failed to revert target_ip:', e?.message || e);
    }
    throw err;
  }

  return { changed: true, oldIp, newIp: ip, domains };
}
