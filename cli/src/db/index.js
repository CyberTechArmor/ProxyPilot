import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { getConfig } from '../config.js';

let _db = null;

/**
 * Resolve ~ to the user's home directory.
 */
function resolvePath(p) {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Get (or create) a singleton better-sqlite3 database connection.
 * Enables WAL mode and foreign keys.
 */
export function getDb() {
  if (_db) {
    return _db;
  }

  const config = getConfig();
  const dbPath = resolvePath(config.database.path);
  const dbDir = path.dirname(dbPath);

  // Create directory if needed
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL');

  // Enable foreign key enforcement
  _db.pragma('foreign_keys = ON');

  return _db;
}
