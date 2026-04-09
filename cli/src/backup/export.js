import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { publishImage, getImageByAlias, listImages, incusRequest } from '../incus/client.js';
import { success, error, info, warn } from '../output.js';

export async function exportContainer(containerName) {
  const db = getDb();
  const config = getConfig();

  const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(containerName);
  if (!container) throw new Error(`Container '${containerName}' not found`);

  const backupDir = config.backup.directory;
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${containerName}-${timestamp}.tar.gz`;
  const filePath = `${backupDir}/${filename}`;

  info(`Exporting container '${containerName}' to ${filePath}...`);
  info('This may take several minutes depending on container size...');

  // First publish the container as a temporary image
  const tempAlias = `proxypilot-export-${containerName}-${Date.now()}`;
  await publishImage(container.incus_name, [{ name: tempAlias }]);

  // Get the image fingerprint
  const imageInfo = await getImageByAlias(tempAlias);
  const fingerprint = imageInfo.metadata.target;

  // Export the image to a file
  // Use raw http to stream the response to disk
  await new Promise((resolve, reject) => {
    const options = {
      socketPath: config.incus.socket,
      path: `/1.0/images/${fingerprint}/export`,
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Export failed with status ${res.statusCode}`));
        return;
      }
      const stream = createWriteStream(filePath);
      res.pipe(stream);
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });

  // Clean up temporary image
  try {
    await incusRequest('DELETE', `/1.0/images/${fingerprint}`);
  } catch {
    warn('Could not clean up temporary export image');
  }

  // Get file size
  let sizeBytes = 0;
  try {
    const stats = await stat(filePath);
    sizeBytes = stats.size;
  } catch { /* ignore */ }

  // Record in database
  db.prepare(`
    INSERT INTO backups (container_id, backup_type, file_path, size_bytes, status)
    VALUES (?, 'lxc_export', ?, ?, 'completed')
  `).run(container.id, filePath, sizeBytes);

  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  success(`Export completed: ${filePath} (${sizeMB} MB)`);
}

export function listBackups(containerName, jsonOutput) {
  const db = getDb();

  let backups;
  if (containerName) {
    const container = db.prepare('SELECT id FROM containers WHERE name = ?').get(containerName);
    if (!container) throw new Error(`Container '${containerName}' not found`);
    backups = db.prepare('SELECT b.*, c.name as container_name FROM backups b LEFT JOIN containers c ON b.container_id = c.id WHERE b.container_id = ? ORDER BY b.created_at DESC').all(container.id);
  } else {
    backups = db.prepare('SELECT b.*, c.name as container_name FROM backups b LEFT JOIN containers c ON b.container_id = c.id ORDER BY b.created_at DESC').all();
  }

  if (jsonOutput) {
    console.log(JSON.stringify(backups, null, 2));
    return;
  }

  if (backups.length === 0) {
    info('No backups found');
    return;
  }

  const { table: printTable } = await import('../output.js');
  const headers = ['Container', 'Type', 'File', 'Size', 'Status', 'Created'];
  const rows = backups.map(b => [
    b.container_name || '-',
    b.backup_type,
    b.file_path.split('/').pop(),
    b.size_bytes ? `${(b.size_bytes / 1024 / 1024).toFixed(1)} MB` : '-',
    b.status,
    b.created_at,
  ]);
  printTable(headers, rows);
}
