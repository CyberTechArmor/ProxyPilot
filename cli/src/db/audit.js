import os from 'node:os';
import { getDb } from './index.js';

/**
 * Append an audit log entry. Every state mutation across firewall, VPN,
 * and SSH CA subsystems writes through here so we have a single source
 * of truth for who-did-what-when.
 *
 * Private keys, cert bodies, and other secrets MUST NOT be included in
 * before/after — only public-key-equivalent identifiers (fingerprints,
 * key-ids, serials, rule ids, peer names).
 */
export function audit({ subsystem, action, resource, actor, before, after, detail }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO audit_log (subsystem, action, resource, actor, before_json, after_json, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    subsystem,
    action,
    resource ?? null,
    actor ?? defaultActor(),
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    detail ?? null,
  );
}

function defaultActor() {
  const sudoUser = process.env.SUDO_USER;
  const user = process.env.USER || os.userInfo().username;
  return sudoUser ? `${sudoUser} (sudo)` : user;
}
