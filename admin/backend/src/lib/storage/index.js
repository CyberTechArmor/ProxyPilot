// The one storage service instance the backend shares between the REST
// router (routes/storage.js), the MCP family (routes/mcp-tools/storage.js)
// and the alert monitor (lib/storage-monitor.js). Built lazily so importing
// this module costs nothing on installs that never open the Storage page.

import { getDb, getSetting, setSetting, logAudit } from '../../db.js';
import { runHostCapture } from '../lxc-zip.js';
import { agentCall } from '../agent.js';
import { createStorageHost } from './host.js';
import { createStorageService } from './service.js';

let instance = null;

export function storageService() {
  if (!instance) {
    const host = createStorageHost({ runHostCapture, agentCall, useAgent: process.env.PROXYPILOT_STORAGE_USE_AGENT !== '0' });
    instance = createStorageService({ host, getDb, getSetting, setSetting, logAudit });
  }
  return instance;
}

/** Tests / the integration harness can install a purpose-built service. */
export function setStorageService(svc) { instance = svc; }
