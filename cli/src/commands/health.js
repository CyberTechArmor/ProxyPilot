import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import * as output from '../output.js';

/**
 * Perform an HTTP health check against an upstream address.
 * Returns an object with status, response time, and HTTP status code.
 *
 * @param {string} upstreamAddress - The upstream address (e.g. 10.0.100.10:3000)
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @returns {Promise<{healthy: boolean, status: string, responseMs: number, httpCode: number|null}>}
 */
async function checkUpstream(upstreamAddress, timeoutMs) {
  const url = upstreamAddress.startsWith('http')
    ? upstreamAddress
    : `http://${upstreamAddress}`;

  const start = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    const responseMs = Date.now() - start;
    const httpCode = response.status;

    if (httpCode >= 200 && httpCode < 300) {
      return { healthy: true, status: 'healthy', responseMs, httpCode };
    } else if (httpCode >= 500) {
      return { healthy: false, status: 'down', responseMs, httpCode };
    } else {
      // 3xx, 4xx are considered degraded (service is responding but not ideal)
      return { healthy: true, status: 'degraded', responseMs, httpCode };
    }
  } catch (err) {
    const responseMs = Date.now() - start;
    return { healthy: false, status: 'down', responseMs, httpCode: null };
  }
}

export const healthCommands = {
  /**
   * List all routes with their health status.
   */
  async list(globalOpts) {
    const db = getDb();

    const routes = db.prepare(`
      SELECT r.*, cr.container_id,
        (SELECT c.name FROM containers c WHERE c.id = cr.container_id) as container_name
      FROM routes r
      LEFT JOIN container_routes cr ON cr.route_id = r.id
      ORDER BY r.domain
    `).all();

    if (routes.length === 0) {
      output.info('No routes configured');
      return;
    }

    if (globalOpts.json) {
      output.json(routes);
      return;
    }

    const rows = routes.map(r => {
      const enabled = r.enabled ? 'yes' : 'no';
      const lastChecked = r.health_last_checked_at || 'never';
      const responseTime = r.health_response_ms !== null && r.health_response_ms !== undefined
        ? `${r.health_response_ms}ms`
        : '-';

      return [
        r.domain,
        r.upstream_address || '-',
        r.upstream_type,
        enabled,
        r.health_status,
        responseTime,
        lastChecked,
        r.container_name || '-',
      ];
    });

    output.table(
      ['Domain', 'Upstream', 'Type', 'Enabled', 'Health', 'Response', 'Last Check', 'Container'],
      rows,
    );
  },

  /**
   * Run health checks on routes.
   * If a domain is specified, check only that route. Otherwise check all enabled routes.
   */
  async check(domain, globalOpts) {
    const db = getDb();
    const config = getConfig();
    const timeoutMs = (config.health.timeout_seconds || 5) * 1000;

    let routes;
    if (domain) {
      const route = db.prepare('SELECT * FROM routes WHERE domain = ?').get(domain);
      if (!route) {
        output.error(`Route for domain '${domain}' not found`);
        process.exit(1);
      }
      routes = [route];
    } else {
      routes = db.prepare('SELECT * FROM routes WHERE enabled = 1').all();
    }

    if (routes.length === 0) {
      output.info('No enabled routes to check');
      return;
    }

    output.info(`Checking ${routes.length} route(s)...\n`);

    const results = [];

    for (const route of routes) {
      if (!route.upstream_address) {
        output.warn(`${route.domain}: no upstream address configured`);
        results.push({ domain: route.domain, status: 'unknown', responseMs: null });
        continue;
      }

      const result = await checkUpstream(route.upstream_address, timeoutMs);

      // Update SQLite
      db.prepare(`
        UPDATE routes
        SET health_status = ?,
            health_last_checked_at = datetime('now'),
            health_response_ms = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(result.status, result.responseMs, route.id);

      // Print result
      if (result.status === 'healthy') {
        output.success(`${route.domain} -> ${route.upstream_address}: healthy (${result.responseMs}ms, HTTP ${result.httpCode})`);
      } else if (result.status === 'degraded') {
        output.warn(`${route.domain} -> ${route.upstream_address}: degraded (${result.responseMs}ms, HTTP ${result.httpCode})`);
      } else {
        const codeStr = result.httpCode ? `HTTP ${result.httpCode}` : 'timeout/unreachable';
        output.error(`${route.domain} -> ${route.upstream_address}: down (${result.responseMs}ms, ${codeStr})`);
      }

      results.push({
        domain: route.domain,
        upstream: route.upstream_address,
        status: result.status,
        responseMs: result.responseMs,
        httpCode: result.httpCode,
      });
    }

    // Summary
    const healthy = results.filter(r => r.status === 'healthy').length;
    const degraded = results.filter(r => r.status === 'degraded').length;
    const down = results.filter(r => r.status === 'down').length;
    const unknown = results.filter(r => r.status === 'unknown').length;

    console.log('');
    output.info(`Results: ${healthy} healthy, ${degraded} degraded, ${down} down, ${unknown} unknown`);

    if (globalOpts.json) {
      output.json(results);
    }
  },
};
