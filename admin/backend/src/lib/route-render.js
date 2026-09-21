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
 * @param {(() => void)|null} [opts.fence]  ownership check, called before EVERY
 *   write this render makes — each domain's regenerate, the validation, the
 *   reload, and each write and the reload of a rollback. A caller whose lease
 *   is no longer its own throws from it (an error with `code: 'LEASE_LOST'`):
 *   the render stops at once, and a rollback is NOT attempted, because the
 *   site files now belong to whoever took the lease and a stale worker's
 *   "restore" would overwrite the new owner's work. The lease error is
 *   rethrown as-is so the caller records it truthfully.
 * @returns {Promise<{domains: string[]}>}
 */
export const isLeaseLost = (e) => !!e && (e.code === 'LEASE_LOST' || e.code === 'SHARED_LEASE_LOST' || e.name === 'LeaseLostError');

export async function renderDomains({
  db,
  domains,
  regenerate,
  adapt,
  reload,
  caddyFilePath,
  writeConfig,
  removeConfig,
  fence = null,
}) {
  const targets = [...new Set(domains.filter(Boolean))];
  if (targets.length === 0) return { domains: [] };
  const guard = () => { if (typeof fence === 'function') fence(); };

  guard();
  const backups = await snapshotDomainConfigs(targets, caddyFilePath);

  // The rollback: every file back to its snapshot, then Caddy back onto the
  // known-good config — each write behind the fence. Ownership lost midway
  // ends the rollback where it stands (nothing further is overwritten) and
  // surfaces the lease error in place of the original failure.
  const restore = async () => {
    for (const b of backups) {
      guard();
      try {
        if (b.existed && b.content !== null) await writeConfig(b.path, b.content);
        else await removeConfig(b.path);
      } catch (e) {
        console.error(`[route-render] restore failed for ${b.domain}:`, e?.message || e);
      }
    }
    guard();
    try { await reload(); } catch { /* already reporting the original failure */ }
  };
  const failWith = async (err, message) => {
    if (isLeaseLost(err)) throw err;
    try { await restore(); } catch (e) { if (isLeaseLost(e)) throw e; }
    throw new Error(message);
  };

  try {
    for (const domain of targets) { guard(); await regenerate(db, domain); }
  } catch (err) {
    await failWith(err, `Failed to render Caddy config: ${err?.message || err}`);
  }

  // Never leave Caddy running a config we have not validated.
  try {
    guard();
    await adapt();
  } catch (err) {
    await failWith(err, `Generated Caddy config failed validation: ${err?.stderr || err?.message || err}`);
  }

  try {
    guard();
    await reload();
  } catch (err) {
    await failWith(err, `Caddy reload failed: ${err?.stderr || err?.message || err}`);
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
export async function applyServiceUpstream({ db, serviceId, ip, render, fence = null }) {
  const guard = () => { if (typeof fence === 'function') fence(); };
  const row = db.prepare(`SELECT id, target_ip FROM services WHERE id = ?`).get(serviceId);
  if (!row) throw new Error(`Service ${serviceId} not found`);

  const oldIp = row.target_ip ?? null;
  if (!ip || oldIp === ip) {
    return { changed: false, oldIp, newIp: ip ?? oldIp, domains: [] };
  }

  const domains = domainsForService(db, serviceId);

  guard();
  db.prepare(
    `UPDATE services SET target_ip = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(ip, serviceId);

  try {
    await renderDomains({ db, domains, ...render, fence });
  } catch (err) {
    // renderDomains has already restored the site files; put the row back too
    // so the two stores stay in agreement on the failure path — unless the
    // lease was lost: the row is then the new owner's to write, not ours.
    if (!isLeaseLost(err)) {
      try {
        guard();
        db.prepare(`UPDATE services SET target_ip = ? WHERE id = ?`).run(oldIp, serviceId);
      } catch (e) {
        if (isLeaseLost(e)) throw e;
        console.error('[route-render] failed to revert target_ip:', e?.message || e);
      }
    }
    throw err;
  }

  return { changed: true, oldIp, newIp: ip, domains };
}
