// Shared read-only reader used by /services/system/stats and G1 preflight.
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);

export async function readSystemStats() {
  // Use Node.js os module for reliable stats inside container
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const loadAvg = os.loadavg();
  const uptimeSec = os.uptime();

  // Calculate CPU usage from all cores
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  const cpuUsage = totalTick > 0 ? ((totalTick - totalIdle) / totalTick) * 100 : 0;

  // Memory stats
  const memUsed = totalMem - freeMem;

  // Try to get disk stats (may fail in some container environments)
  let diskTotal = 0;
  let diskUsed = 0;
  let diskFree = 0;
  try {
    const diskResult = await execAsync("df -B1 / 2>/dev/null | awk 'NR==2 {print $2, $3, $4}'", { timeout: 2500 });
    const diskParts = diskResult.stdout.trim().split(/\s+/);
    diskTotal = parseInt(diskParts[0]) || 0;
    diskUsed = parseInt(diskParts[1]) || 0;
    diskFree = parseInt(diskParts[2]) || 0;
  } catch (e) {
    // Disk stats unavailable
  }

  const stats = {
    cpu: {
      usage: parseFloat(cpuUsage.toFixed(1)),
      cores: cpus.length,
    },
    memory: {
      total: totalMem,
      used: memUsed,
      free: freeMem,
      available: freeMem,
      usagePercent: totalMem > 0 ? ((memUsed / totalMem) * 100).toFixed(1) : '0',
    },
    disk: {
      total: diskTotal,
      used: diskUsed,
      free: diskFree,
      usagePercent: diskTotal > 0 ? ((diskUsed / diskTotal) * 100).toFixed(1) : '0',
    },
    load: {
      avg1: loadAvg[0],
      avg5: loadAvg[1],
      avg15: loadAvg[2],
    },
    uptime: uptimeSec,
  };

  return stats;
}
