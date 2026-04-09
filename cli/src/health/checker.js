import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { success, error, info, warn, table } from '../output.js';

export async function runHealthChecks(jsonOutput) {
  const db = getDb();
  const config = getConfig();
  const timeout = (config.health?.timeout_seconds || 5) * 1000;

  const routes = db.prepare('SELECT * FROM routes WHERE enabled = 1').all();

  if (routes.length === 0) {
    info('No enabled routes to check');
    return;
  }

  info(`Checking ${routes.length} route(s)...`);

  const results = [];

  for (const route of routes) {
    const result = await checkRoute(route, timeout);
    results.push(result);

    // Update database
    db.prepare(`
      UPDATE routes SET
        health_status = ?,
        health_last_checked_at = datetime('now'),
        health_response_ms = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(result.status, result.responseMs, route.id);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const headers = ['Domain', 'Type', 'Upstream', 'Status', 'Response'];
  const rows = results.map(r => [
    r.domain,
    r.type,
    r.upstream || '-',
    formatStatus(r.status),
    r.responseMs !== null ? `${r.responseMs}ms` : '-',
  ]);
  table(headers, rows);

  const healthy = results.filter(r => r.status === 'healthy').length;
  const down = results.filter(r => r.status === 'down').length;
  const degraded = results.filter(r => r.status === 'degraded').length;

  if (down > 0) {
    warn(`${down} route(s) down`);
  }
  if (degraded > 0) {
    warn(`${degraded} route(s) degraded`);
  }
  success(`${healthy}/${results.length} route(s) healthy`);
}

export function listHealthStatus(jsonOutput) {
  const db = getDb();
  const routes = db.prepare('SELECT * FROM routes ORDER BY health_status, domain').all();

  if (jsonOutput) {
    console.log(JSON.stringify(routes, null, 2));
    return;
  }

  if (routes.length === 0) {
    info('No routes configured');
    return;
  }

  const headers = ['Domain', 'Type', 'Upstream', 'Status', 'Response', 'Last Check', 'Enabled'];
  const rows = routes.map(r => [
    r.domain,
    r.upstream_type,
    r.upstream_address || '-',
    formatStatus(r.health_status),
    r.health_response_ms !== null ? `${r.health_response_ms}ms` : '-',
    r.health_last_checked_at || 'never',
    r.enabled ? 'yes' : 'no',
  ]);
  table(headers, rows);
}

async function checkRoute(route, timeout) {
  const result = {
    domain: route.domain,
    type: route.upstream_type,
    upstream: route.upstream_address,
    status: 'unknown',
    responseMs: null,
    error: null,
  };

  if (!route.upstream_address || route.upstream_type === 'static') {
    // Static sites — check if domain responds
    try {
      const start = Date.now();
      const protocol = route.tls_auto ? 'https' : 'http';
      const response = await fetch(`${protocol}://${route.domain}${route.path_prefix}`, {
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      result.responseMs = Date.now() - start;
      result.status = response.ok ? 'healthy' : (response.status >= 500 ? 'down' : 'degraded');
    } catch (e) {
      result.status = 'down';
      result.error = e.message;
    }
    return result;
  }

  // For LXC/Docker upstreams — try HTTP to the upstream address
  try {
    const start = Date.now();
    const url = route.upstream_address.startsWith('http')
      ? route.upstream_address
      : `http://${route.upstream_address}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    result.responseMs = Date.now() - start;
    result.status = response.ok ? 'healthy' : (response.status >= 500 ? 'down' : 'degraded');
  } catch (e) {
    result.status = 'down';
    result.error = e.message;
  }

  return result;
}

function formatStatus(status) {
  switch (status) {
    case 'healthy': return '\x1b[32mhealthy\x1b[0m';
    case 'degraded': return '\x1b[33mdegraded\x1b[0m';
    case 'down': return '\x1b[31mdown\x1b[0m';
    default: return '\x1b[90munknown\x1b[0m';
  }
}
