import { existsSync } from 'node:fs';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { incusRequest, incusRequestAndWait } from '../incus/client.js';
import { success, error, info } from '../output.js';

export async function restoreBackup(containerName, backupIdentifier) {
  const db = getDb();
  const config = getConfig();

  // Find the backup record
  let backup;
  if (backupIdentifier) {
    // Try by ID first, then by filename
    backup = db.prepare('SELECT * FROM backups WHERE id = ? OR file_path LIKE ?').get(
      parseInt(backupIdentifier) || 0,
      `%${backupIdentifier}%`
    );
  } else {
    // Get the latest backup for this container
    const container = db.prepare('SELECT id FROM containers WHERE name = ?').get(containerName);
    if (container) {
      backup = db.prepare('SELECT * FROM backups WHERE container_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(container.id, 'completed');
    }
  }

  if (!backup) throw new Error('Backup not found');
  if (!existsSync(backup.file_path)) throw new Error(`Backup file not found: ${backup.file_path}`);

  info(`Restoring from backup: ${backup.file_path}`);
  info('This may take several minutes...');

  // Import the image
  const importAlias = `proxypilot-restore-${Date.now()}`;

  // Use incus CLI for import since the API requires multipart upload
  const { execSync } = await import('node:child_process');
  execSync(`incus image import ${backup.file_path} --alias ${importAlias}`, { stdio: 'inherit' });

  info('Image imported. You can create a new container from it with:');
  info(`  proxypilot lxc create --name ${containerName}-restored --image ${importAlias}`);

  success('Backup restore image imported successfully');
}

export function backupIndex() {
  return {
    exportContainer: (await import('./export.js')).exportContainer,
    listBackups: (await import('./export.js')).listBackups,
    restoreBackup,
    createSchedule: (await import('./schedule.js')).createSchedule,
    listSchedules: (await import('./schedule.js')).listSchedules,
  };
}
