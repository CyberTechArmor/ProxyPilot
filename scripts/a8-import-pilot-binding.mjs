#!/usr/bin/env node
// Mirror a fresh operator-authorized broker reference into the live dashboard
// DB. Neither a secret value nor new run/approval/consent authority is created.
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';
import { importPilotBinding } from '../admin/backend/src/lib/operational-pilot-binding.js';

const SOCKET = '/run/proxypilot-a4/broker.sock';
function secure(path) {
  for (let part = path; ; part = dirname(part)) {
    const info = lstatSync(part);
    if (info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022) throw new Error('INSECURE_PATH');
    if (dirname(part) === part) break;
  }
}
async function bindings() {
  secure(SOCKET);
  if (!lstatSync(SOCKET).isSocket() || (lstatSync(SOCKET).mode & 0o777) !== 0o600) throw new Error('INSECURE_SOCKET');
  return new Promise((done, refuse) => {
    const socket = createConnection(SOCKET);
    let body = '', settled = false, deadline;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); socket.destroy();
      if (error) refuse(new Error('BROKER_READ_FAILED')); else done(result);
    };
    socket.setEncoding('utf8'); socket.setTimeout(5000, () => finish(true));
    deadline = setTimeout(() => finish(true), 5000);
    socket.on('error', () => finish(true)); socket.on('end', () => finish(true));
    socket.on('connect', () => socket.write('{"method":"bindings","params":{}}\n'));
    socket.on('data', data => {
      body += data;
      if (Buffer.byteLength(body) > 1024 * 1024) return finish(true);
      if (!body.includes('\n')) return;
      try {
        const reply = JSON.parse(body.slice(0, body.indexOf('\n')));
        if (reply.ok !== true || !Array.isArray(reply.result?.bindings)) return finish(true);
        finish(false, reply.result.bindings);
      } catch { finish(true); }
    });
  });
}

try {
  if (process.getuid() !== 0) throw new Error('ROOT_REQUIRED');
  const { values } = parseArgs({ options: { owner: { type: 'string' }, project: { type: 'string' },
    profile: { type: 'string' }, binding: { type: 'string' }, 'install-dir': { type: 'string', default: '/opt/proxypilot' } } });
  for (const key of ['owner','project','profile','binding'])
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values[key] ?? '')) throw new Error('INVALID_ID');
  const install = values['install-dir'];
  if (!isAbsolute(install) || resolve(install) !== install || realpathSync(install) !== install) throw new Error('INVALID_INSTALL');
  const path = resolve(install, 'data/db/proxypilot.db');
  secure(path);
  const registered = (await bindings()).filter(b => b.binding_id === values.binding);
  if (registered.length !== 1) throw new Error('BINDING_MISMATCH');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=1112').get()) throw new Error('MIGRATIONS_MISSING');
    console.log(JSON.stringify(importPilotBinding(db, values.owner,
      { binding_id: values.binding, project_id: values.project, profile_id: values.profile }, registered[0])));
  } finally { db.close(); }
} catch {
  console.log(JSON.stringify({ ok: false, error: 'Pilot binding import refused; check owner, profile and fresh broker reference' }));
  process.exitCode = 1;
}
