// The one migration service instance the backend shares between the REST
// routers (routes/migrations.js — operator and agent) and the MCP family
// (routes/mcp-tools/migration.js). Built lazily: importing this costs
// nothing on installs that never migrate anything.
//
// publicBaseUrl is resolved from PROXYPILOT_PUBLIC_URL (or the admin
// domain recorded in settings) rather than from a request, because the
// bootstrap script and the TLS pin are minted for a host that is NOT
// talking to us yet.

import { getDb, getSetting, logAudit } from '../../db.js';
import { runHostCapture } from '../lxc-zip.js';
import { createMigrationService } from './service.js';

let instance = null;

export function publicBaseUrl() {
  const env = String(process.env.PROXYPILOT_PUBLIC_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  let domain = null;
  try { domain = getSetting('admin_domain') || getSetting('public_domain') || null; } catch { domain = null; }
  return domain ? `https://${String(domain).replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '';
}

export function migrationService() {
  if (!instance) instance = createMigrationService({ getDb, runHostCapture, publicBaseUrl, logAudit });
  return instance;
}

/** Tests install a purpose-built service (no host, no DB file). */
export function setMigrationService(svc) { instance = svc; }
