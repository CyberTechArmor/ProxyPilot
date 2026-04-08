import { writeFile, unlink, readdir, rename, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const CADDY_SITES_DIR = '/etc/caddy/sites';
const CADDY_CONFIG_FILE = '/etc/caddy/Caddyfile';

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
 * Add a reverse proxy route for a domain.
 * Creates a Caddyfile-style site block in /etc/caddy/sites/{domain} and reloads.
 *
 * @param {string} domain - The domain name to route
 * @param {string} upstreamAddress - The upstream address (e.g. 10.0.100.10:3000)
 * @param {object} [options={}] - Route options
 * @param {string} [options.pathPrefix='/'] - URL path prefix
 * @param {boolean} [options.tlsAuto=true] - Whether to use automatic TLS
 * @param {object} [options.headers={}] - Additional headers to set
 */
export async function addRoute(domain, upstreamAddress, options = {}) {
  const { pathPrefix = '/', tlsAuto = true, headers = {} } = options;

  const siteAddress = tlsAuto ? domain : `http://${domain}`;

  let config = `# ProxyPilot Managed Route\n`;
  config += `# Generated: ${new Date().toISOString()}\n\n`;
  config += `${siteAddress} {\n`;

  if (pathPrefix !== '/') {
    config += `    handle ${pathPrefix}* {\n`;
    config += `        reverse_proxy ${upstreamAddress}\n`;
    config += `    }\n`;
  } else {
    config += `    reverse_proxy ${upstreamAddress}\n`;
  }

  // Security headers
  config += `\n    header {\n`;
  config += `        X-Frame-Options "SAMEORIGIN"\n`;
  config += `        X-Content-Type-Options "nosniff"\n`;
  config += `        X-XSS-Protection "1; mode=block"\n`;
  config += `        Referrer-Policy "strict-origin-when-cross-origin"\n`;
  for (const [key, value] of Object.entries(headers)) {
    config += `        ${key} "${value}"\n`;
  }
  config += `    }\n`;

  config += `\n    log {\n`;
  config += `        output file /var/log/caddy/${domain}.log\n`;
  config += `    }\n`;
  config += `}\n`;

  const configPath = `${CADDY_SITES_DIR}/${domain}`;
  await writeFile(configPath, config);

  // Reload Caddy
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
