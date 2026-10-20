// Application storage over MCP: READ-ONLY by design. A storage check only
// measures; cleanups and retention policies are dashboard-only (sudo), and no
// MCP tool can create a cleanup or change a policy (ratchet in
// app-storage-mcp.test.js).
import { tool } from './shared.js';

const targetKey = { type: 'string', pattern: '^(application|project):[1-9][0-9]*$', description: 'application:<id> or project:<id>, as list_application_storage returns it.' };

export const APP_STORAGE_TOOLS = [
  tool('list_application_storage', 'List every registered application and Dev Studio project with its storage: space used now, the last storage check (total, what can be cleaned up), open storage alerts and the state of its retention rules. Read-only; cleanup and retention changes are made in the dashboard, never over MCP.', {}),
  tool('get_application_storage_check', 'Read a storage check of one application or project: totals (used, available, disk limit, held by snapshots, not measured individually), categories and items, each with its status (Protected / Can be cleaned up / Needs a look) and the plain reason. Omit check_id for the latest finished check. Read-only.', {
    target_key: targetKey,
    check_id: { type: 'string', pattern: '^chk_[a-f0-9-]{36}$', description: 'A check id from request_application_storage_check; omit for the latest.' },
  }, ['target_key']),
  tool('request_application_storage_check', 'Start a read-only storage check of one application or project: it measures files, snapshots and exports and never deletes or changes anything. Returns a check id to read with get_application_storage_check once its status is complete or partial; a check already running is returned instead of starting another. Cleanup is not available over MCP.', {
    target_key: targetKey,
  }, ['target_key']),
];
