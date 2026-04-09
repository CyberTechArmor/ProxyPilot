import { createSnapshot as incusCreateSnapshot, listSnapshots as incusListSnapshots, deleteSnapshot as incusDeleteSnapshot, restoreSnapshot as incusRestoreSnapshot } from '../incus/client.js';
import { getDb } from '../db/index.js';
import { success, error, info, table } from '../output.js';

export async function snapshotCreate(containerName, snapshotName) {
  const db = getDb();
  const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(containerName);
  if (!container) throw new Error(`Container '${containerName}' not found`);

  info(`Creating snapshot '${snapshotName}' of container '${containerName}'...`);

  await incusCreateSnapshot(container.incus_name, snapshotName);

  db.prepare(`
    INSERT INTO snapshots (container_id, name, incus_snapshot_name, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(container.id, snapshotName, snapshotName);

  success(`Snapshot '${snapshotName}' created`);
}

export async function snapshotList(containerName, jsonOutput) {
  const db = getDb();
  const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(containerName);
  if (!container) throw new Error(`Container '${containerName}' not found`);

  // Get snapshots from Incus for live data
  let incusSnapshots = [];
  try {
    const result = await incusListSnapshots(container.incus_name);
    incusSnapshots = result.metadata || [];
  } catch {
    // Fall back to database
  }

  const dbSnapshots = db.prepare('SELECT * FROM snapshots WHERE container_id = ? ORDER BY created_at DESC').all(container.id);

  if (jsonOutput) {
    console.log(JSON.stringify(dbSnapshots, null, 2));
    return;
  }

  if (dbSnapshots.length === 0) {
    info(`No snapshots found for container '${containerName}'`);
    return;
  }

  const headers = ['Name', 'Created'];
  const rows = dbSnapshots.map(s => [s.name, s.created_at]);
  table(headers, rows);
}

export async function snapshotRestore(containerName, snapshotName) {
  const db = getDb();
  const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(containerName);
  if (!container) throw new Error(`Container '${containerName}' not found`);

  const snapshot = db.prepare('SELECT * FROM snapshots WHERE container_id = ? AND name = ?').get(container.id, snapshotName);
  if (!snapshot) throw new Error(`Snapshot '${snapshotName}' not found for container '${containerName}'`);

  info(`Restoring container '${containerName}' to snapshot '${snapshotName}'...`);

  await incusRestoreSnapshot(container.incus_name, snapshot.incus_snapshot_name);

  success(`Container '${containerName}' restored to snapshot '${snapshotName}'`);
}

export async function snapshotDelete(containerName, snapshotName) {
  const db = getDb();
  const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(containerName);
  if (!container) throw new Error(`Container '${containerName}' not found`);

  const snapshot = db.prepare('SELECT * FROM snapshots WHERE container_id = ? AND name = ?').get(container.id, snapshotName);
  if (!snapshot) throw new Error(`Snapshot '${snapshotName}' not found for container '${containerName}'`);

  info(`Deleting snapshot '${snapshotName}' from container '${containerName}'...`);

  await incusDeleteSnapshot(container.incus_name, snapshot.incus_snapshot_name);

  db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshot.id);

  success(`Snapshot '${snapshotName}' deleted`);
}
