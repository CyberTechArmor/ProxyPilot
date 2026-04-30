import { unlink, readdir, rename } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { getDb } from '../db/index.js';
import { renderRoute } from './render.js';
import { atomicWrite } from '../core/vpn/server.js';

const CADDY_SITES_DIR = '/etc/caddy/sites';

/**
 * Get the full Caddy config via the admin API.
 * @returns {Promise<object>} Parsed Caddy configuration
 */
export async function getCaddyConfig() {
  const response = await fetch('http://localhost:2019/config/', {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Failed to get Caddy config: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Add a reverse proxy route for a domain. Writes a Caddyfile site
 * block to /etc/caddy/sites/{domain} and reloads.
 *
 * Routes the work through the pure renderer in render.js so the
 * vpn-only matcher path and the public path share one code path.
 * For vpn-only routes the renderer emits an `@vpn remote_ip ...`
 * matcher whose IP list is computed from the current enabled-peer
 * set; subsequent peer mutations call reconcileVpnRoutes() to
 * regenerate the matcher without going through addRoute again.
 *
 * @param {string} domain - The domain name to route
 * @param {string} upstreamAddress - The upstream address (e.g. 10.0.100.10:3000)
 * @param {object} [options={}] - Route options
 * @param {string} [options.pathPrefix='/'] - URL path prefix
 * @param {boolean} [options.tlsAuto=true] - Whether to use automatic TLS
 * @param {boolean} [options.vpnOnly=false] - Render with @vpn remote_ip matcher
 *                                            (per-peer scope at L7)
 * @param {string} [options.service] - Optional service tag joining the
 *                                     route to peer scope_services_json
 */
export async function addRoute(domain, upstreamAddress, options = {}) {
  const { pathPrefix = '/', tlsAuto = true, vpnOnly = false, service = null } = options;

  // Resolve enabled peers if the route is vpn-only. For non-vpn-only
  // routes we skip the SQLite read entirely — keeps `lxc create`
  // independent of the VPN module on hosts where VPN isn't enabled.
  let peers = [];
  if (vpnOnly) {
    try {
      peers = getDb().prepare(`
        SELECT name, allowed_ip, scope, scope_services_json
        FROM vpn_peers
        WHERE status = 'enabled'
      `).all();
    } catch {
      // No vpn_peers table on a fresh install where VPN was never
      // enabled — peers stays empty, the matcher renders with the
      // sentinel, and the route is closed until VPN comes up.
      peers = [];
    }
  }

  const config = renderRoute({
    domain,
    upstream_address: upstreamAddress,
    path_prefix: pathPrefix,
    tls_auto: tlsAuto ? 1 : 0,
    vpn_only: vpnOnly ? 1 : 0,
    service,
  }, peers);

  const configPath = `${CADDY_SITES_DIR}/${domain}`;
  // Atomic write — same .tmp + chmod + rename pattern wg0.conf and
  // the firewall ruleset use, so a crash mid-write never leaves a
  // partial site file that Caddy could pick up at the next reload.
  atomicWrite(configPath, config, 0o644);

  await reloadCaddy();
}

/**
 * Remove a route for a domain (delete the site config file and reload).
 * @param {string} domain - The domain to remove
 */
export async function removeRoute(domain) {
  const configPath = `${CADDY_SITES_DIR}/${domain}`;
  try {
    await unlink(configPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // Also remove disabled version
  try {
    await unlink(configPath + '.disabled');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await reloadCaddy();
}

/**
 * Enable a route (rename from .disabled back to active).
 * @param {string} domain - The domain to enable
 */
export async function enableRoute(domain) {
  const disabledPath = `${CADDY_SITES_DIR}/${domain}.disabled`;
  const enabledPath = `${CADDY_SITES_DIR}/${domain}`;
  try {
    await rename(disabledPath, enabledPath);
    await reloadCaddy();
  } catch (e) {
    if (e.code === 'ENOENT') return; // already enabled or doesn't exist
    throw e;
  }
}

/**
 * Disable a route (rename file to .disabled).
 * @param {string} domain - The domain to disable
 */
export async function disableRoute(domain) {
  const enabledPath = `${CADDY_SITES_DIR}/${domain}`;
  const disabledPath = `${CADDY_SITES_DIR}/${domain}.disabled`;
  try {
    await rename(enabledPath, disabledPath);
    await reloadCaddy();
  } catch (e) {
    if (e.code === 'ENOENT') return; // already disabled or doesn't exist
    throw e;
  }
}

/**
 * Reload Caddy config by adapting and reloading via systemctl or caddy CLI.
 */
export async function reloadCaddy() {
  try {
    execSync('caddy adapt --config /etc/caddy/Caddyfile > /dev/null 2>&1');
    execSync(
      'systemctl reload caddy 2>/dev/null || caddy reload --config /etc/caddy/Caddyfile --force 2>/dev/null',
      { timeout: 10000 },
    );
  } catch (e) {
    throw new Error(`Failed to reload Caddy: ${e.message}`);
  }
}

/**
 * Check if Caddy admin API is reachable.
 * @returns {Promise<boolean>} true if the admin API responds
 */
export async function checkCaddyConnection() {
  try {
    const response = await fetch('http://localhost:2019/config/', {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * List all managed site config files from /etc/caddy/sites/.
 * @returns {Promise<string[]>} Array of file names
 */
export async function listRouteFiles() {
  try {
    const files = await readdir(CADDY_SITES_DIR);
    return files.filter(f => !f.startsWith('.'));
  } catch {
    return [];
  }
}
