import os from 'node:os';
import { getDb } from '../db/index.js';
import { checkCaddyConnection } from '../caddy/client.js';
import { checkConnection as checkIncusConnection } from '../incus/client.js';
import * as output from '../output.js';

/**
 * Format bytes to a human-readable string.
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export async function statusCommand(globalOpts) {
  const db = getDb();

  // ── Host info ─────────────────────────────────────────────────────────────
  const cpuCount = os.cpus().length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const uptime = os.uptime();
  const uptimeDays = Math.floor(uptime / 86400);
  const uptimeHours = Math.floor((uptime % 86400) / 3600);
  const loadAvg = os.loadavg();

  // ── Container stats ───────────────────────────────────────────────────────
  const containerStats = db.prepare(`
    SELECT status, COUNT(*) as count FROM containers GROUP BY status
  `).all();

  const containerCounts = {};
  let totalContainers = 0;
  for (const row of containerStats) {
    containerCounts[row.status] = row.count;
    totalContainers += row.count;
  }

  // ── Route stats ───────────────────────────────────────────────────────────
  const routeStats = db.prepare(`
    SELECT upstream_type, COUNT(*) as count FROM routes GROUP BY upstream_type
  `).all();

  const routeCounts = {};
  let totalRoutes = 0;
  for (const row of routeStats) {
    routeCounts[row.upstream_type] = row.count;
    totalRoutes += row.count;
  }

  // ── Unhealthy routes ──────────────────────────────────────────────────────
  const unhealthyRoutes = db.prepare(`
    SELECT domain, upstream_address, health_status, health_last_checked_at
    FROM routes
    WHERE health_status IN ('down', 'degraded') AND enabled = 1
  `).all();

  // ── Backup info ───────────────────────────────────────────────────────────
  const backupCount = db.prepare('SELECT COUNT(*) as count FROM backups').get();
  const lastBackup = db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT 1').get();

  // ── Service connectivity ──────────────────────────────────────────────────
  let incusOk = false;
  let caddyOk = false;
  try {
    incusOk = await checkIncusConnection();
  } catch { /* not reachable */ }
  try {
    caddyOk = await checkCaddyConnection();
  } catch { /* not reachable */ }

  // ── Output ────────────────────────────────────────────────────────────────
  if (globalOpts.json) {
    output.json({
      host: {
        cpus: cpuCount,
        total_memory: totalMem,
        free_memory: freeMem,
        used_memory: usedMem,
        uptime_seconds: uptime,
        load_average: loadAvg,
      },
      services: {
        incus: incusOk,
        caddy: caddyOk,
      },
      containers: {
        total: totalContainers,
        by_status: containerCounts,
      },
      routes: {
        total: totalRoutes,
        by_type: routeCounts,
        unhealthy: unhealthyRoutes,
      },
      backups: {
        total: backupCount.count,
        last: lastBackup || null,
      },
    });
    return;
  }

  console.log('');
  output.info('ProxyPilot Status');
  console.log('');

  // Host
  output.info('Host:');
  output.info(`  CPUs:         ${cpuCount}`);
  output.info(`  Memory:       ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${formatBytes(freeMem)} free)`);
  output.info(`  Uptime:       ${uptimeDays}d ${uptimeHours}h`);
  output.info(`  Load Average: ${loadAvg.map(l => l.toFixed(2)).join(', ')}`);

  // Services
  console.log('');
  output.info('Services:');
  if (incusOk) {
    output.success('  Incus:  connected');
  } else {
    output.error('  Incus:  not reachable');
  }
  if (caddyOk) {
    output.success('  Caddy:  connected');
  } else {
    output.error('  Caddy:  not reachable');
  }

  // Containers
  console.log('');
  output.info('Containers:');
  output.info(`  Total:   ${totalContainers}`);
  output.info(`  Running: ${containerCounts.running || 0}`);
  output.info(`  Stopped: ${containerCounts.stopped || 0}`);
  if (containerCounts.frozen) output.info(`  Frozen:  ${containerCounts.frozen}`);
  if (containerCounts.error) output.warn(`  Error:   ${containerCounts.error}`);

  // Routes
  console.log('');
  output.info('Routes:');
  output.info(`  Total:  ${totalRoutes}`);
  if (routeCounts.lxc) output.info(`  LXC:    ${routeCounts.lxc}`);
  if (routeCounts.docker) output.info(`  Docker: ${routeCounts.docker}`);
  if (routeCounts.static) output.info(`  Static: ${routeCounts.static}`);

  // Unhealthy routes
  if (unhealthyRoutes.length > 0) {
    console.log('');
    output.warn('Unhealthy Routes:');
    for (const route of unhealthyRoutes) {
      output.warn(`  ${route.domain} -> ${route.upstream_address} [${route.health_status}]`);
      if (route.health_last_checked_at) {
        output.info(`    Last checked: ${route.health_last_checked_at}`);
      }
    }
  }

  // Backups
  console.log('');
  output.info('Backups:');
  output.info(`  Total: ${backupCount.count}`);
  if (lastBackup) {
    output.info(`  Last:  ${lastBackup.created_at} (${lastBackup.backup_type})`);
  } else {
    output.info(`  Last:  none`);
  }
}
