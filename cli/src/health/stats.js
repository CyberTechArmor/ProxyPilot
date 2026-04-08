import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { success, info, warn, table } from '../output.js';

const CADDY_LOG_DIR = '/var/log/caddy';

export async function showStats(domain, options = {}) {
  const { period = '24h', jsonOutput = false } = options;

  const logPath = `${CADDY_LOG_DIR}/${domain}.log`;

  if (!existsSync(logPath)) {
    warn(`No access log found for domain '${domain}'`);
    info(`Expected log at: ${logPath}`);
    return;
  }

  info(`Reading access logs for ${domain} (last ${period})...`);

  const cutoffMs = parsePeriod(period);
  const cutoff = Date.now() - cutoffMs;

  // Read and parse log file (JSON lines format from Caddy)
  const content = await readFile(logPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const stats = {
    domain,
    period,
    total_requests: 0,
    status_codes: {},
    error_count_4xx: 0,
    error_count_5xx: 0,
    response_times: [],
    avg_response_ms: 0,
    p95_response_ms: 0,
    earliest: null,
    latest: null,
  };

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const ts = entry.ts ? entry.ts * 1000 : 0; // Caddy logs ts in seconds

      if (ts < cutoff) continue;

      stats.total_requests++;

      const status = entry.status || 0;
      const bucket = `${Math.floor(status / 100)}xx`;
      stats.status_codes[bucket] = (stats.status_codes[bucket] || 0) + 1;

      if (status >= 400 && status < 500) stats.error_count_4xx++;
      if (status >= 500) stats.error_count_5xx++;

      if (entry.duration != null) {
        // Caddy logs duration in seconds (float)
        const ms = Math.round(entry.duration * 1000);
        stats.response_times.push(ms);
      }

      if (!stats.earliest || ts < stats.earliest) stats.earliest = ts;
      if (!stats.latest || ts > stats.latest) stats.latest = ts;
    } catch {
      // Skip malformed lines
    }
  }

  // Calculate averages
  if (stats.response_times.length > 0) {
    const sorted = stats.response_times.sort((a, b) => a - b);
    stats.avg_response_ms = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    stats.p95_response_ms = sorted[Math.floor(sorted.length * 0.95)] || 0;
  }

  const errorRate = stats.total_requests > 0
    ? ((stats.error_count_4xx + stats.error_count_5xx) / stats.total_requests * 100).toFixed(1)
    : 0;

  if (jsonOutput) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('');
  console.log(`  \x1b[1m${domain}\x1b[0m - Traffic Stats (${period})`);
  console.log('');

  const data = [
    ['Total Requests', String(stats.total_requests)],
    ['2xx (Success)', String(stats.status_codes['2xx'] || 0)],
    ['3xx (Redirect)', String(stats.status_codes['3xx'] || 0)],
    ['4xx (Client Error)', String(stats.error_count_4xx)],
    ['5xx (Server Error)', String(stats.error_count_5xx)],
    ['Error Rate', `${errorRate}%`],
    ['Avg Response Time', stats.avg_response_ms ? `${stats.avg_response_ms}ms` : '-'],
    ['P95 Response Time', stats.p95_response_ms ? `${stats.p95_response_ms}ms` : '-'],
  ];

  table(['Metric', 'Value'], data);
}

function parsePeriod(period) {
  const match = period.match(/^(\d+)(h|d|m)$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h

  const [, num, unit] = match;
  const n = parseInt(num);

  switch (unit) {
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
