import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getDb } from '../db/index.js';
import { success, error, info, warn, table } from '../output.js';

export function createSchedule(containerName, options) {
  const db = getDb();

  const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(containerName);
  if (!container) throw new Error(`Container '${containerName}' not found`);

  const { cron, type = 'snapshot', retention = 5 } = options;
  if (!cron) throw new Error('--cron expression is required');

  // Validate type
  if (!['snapshot', 'export'].includes(type)) {
    throw new Error(`Invalid schedule type '${type}'. Must be 'snapshot' or 'export'`);
  }

  // Insert schedule
  db.prepare(`
    INSERT INTO backup_schedules (container_id, schedule_type, cron_expression, retention_count, enabled)
    VALUES (?, ?, ?, ?, 1)
  `).run(container.id, type, cron, retention);

  // Generate systemd timer
  const timerName = `proxypilot-backup-${containerName}`;
  const calendarSpec = cronToSystemd(cron);

  const timerUnit = `[Unit]
Description=ProxyPilot backup schedule for ${containerName}

[Timer]
OnCalendar=${calendarSpec}
Persistent=true

[Install]
WantedBy=timers.target
`;

  const serviceUnit = `[Unit]
Description=ProxyPilot backup for ${containerName}

[Service]
Type=oneshot
ExecStart=/usr/bin/env proxypilot backup export ${containerName}
`;

  try {
    const timerPath = `/etc/systemd/system/${timerName}.timer`;
    const servicePath = `/etc/systemd/system/${timerName}.service`;

    execSync(`cat > ${timerPath} << 'EOF'\n${timerUnit}EOF`);
    execSync(`cat > ${servicePath} << 'EOF'\n${serviceUnit}EOF`);
    execSync('systemctl daemon-reload');
    execSync(`systemctl enable --now ${timerName}.timer`);

    success(`Backup schedule created for '${containerName}' (${type}, cron: ${cron})`);
    info(`Systemd timer: ${timerName}.timer`);
  } catch (e) {
    warn(`Schedule saved in database but systemd timer creation failed: ${e.message}`);
    warn('You can run backups manually with: proxypilot backup export ' + containerName);
  }
}

export function listSchedules(jsonOutput) {
  const db = getDb();
  const schedules = db.prepare(`
    SELECT bs.*, c.name as container_name
    FROM backup_schedules bs
    LEFT JOIN containers c ON bs.container_id = c.id
    ORDER BY bs.created_at DESC
  `).all();

  if (jsonOutput) {
    console.log(JSON.stringify(schedules, null, 2));
    return;
  }

  if (schedules.length === 0) {
    info('No backup schedules configured');
    return;
  }

  const headers = ['Container', 'Type', 'Cron', 'Retention', 'Last Run', 'Enabled'];
  const rows = schedules.map(s => [
    s.container_name || '-',
    s.schedule_type,
    s.cron_expression,
    String(s.retention_count),
    s.last_run_at || 'never',
    s.enabled ? 'yes' : 'no',
  ]);
  table(headers, rows);
}

// Simple cron to systemd OnCalendar conversion
function cronToSystemd(cron) {
  // Handle common patterns
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron; // pass through if not standard cron

  const [min, hour, dom, month, dow] = parts;

  // Daily at specific time
  if (dom === '*' && month === '*' && dow === '*') {
    return `*-*-* ${hour}:${min}:00`;
  }

  // Weekly
  if (dom === '*' && month === '*' && dow !== '*') {
    const days = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat' };
    const dayName = days[dow] || dow;
    return `${dayName} *-*-* ${hour}:${min}:00`;
  }

  // Monthly
  if (dom !== '*' && month === '*' && dow === '*') {
    return `*-*-${dom} ${hour}:${min}:00`;
  }

  // Fallback: pass through
  return cron;
}
