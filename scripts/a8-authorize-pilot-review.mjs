#!/usr/bin/env node
// Operator grants one manual self-review of one immutable demo submission.
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { authorizePilotSelfReview } from '../admin/backend/src/lib/operational-pilot-review.js';

try {
  if (process.getuid() !== 0) throw new Error('ROOT_REQUIRED');
  const { values } = parseArgs({ options: { owner: { type: 'string' }, project: { type: 'string' },
    submission: { type: 'string' }, hash: { type: 'string' }, 'install-dir': { type: 'string', default: '/opt/proxypilot' } } });
  const install = values['install-dir'];
  if (!isAbsolute(install) || resolve(install) !== install || realpathSync(install) !== install) throw new Error('INVALID_INSTALL');
  const path = resolve(install, 'data/db/proxypilot.db');
  for (let part = path; ; part = dirname(part)) {
    const info = lstatSync(part);
    if (info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022) throw new Error('INSECURE_PATH');
    if (dirname(part) === part) break;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=1112').get()) throw new Error('MIGRATIONS_MISSING');
    console.log(JSON.stringify(authorizePilotSelfReview(db, { owner_id: values.owner, project_id: values.project,
      submission_id: values.submission, content_hash: values.hash })));
  } finally { db.close(); }
} catch {
  console.log(JSON.stringify({ ok: false, error: 'Pilot review authorization refused; check active demo owner and exact pending submission hash' }));
  process.exitCode = 1;
}
