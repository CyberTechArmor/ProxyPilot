// The extended MCP catalog: names, descriptions and input schemas for the
// tool families in routes/mcp-tools/*.js. Concatenated into MCP_TOOLS by
// lib/mcp-logic.js so tools/list, scope filtering and the tests see one list.

import { LXC_ADMIN_TOOLS } from './lxc.js';
import { EDGE_TOOLS, STATIC_ADMIN_TOOLS } from './edge.js';
import { ADMIN_TOOLS, SELF_EDIT_CATALOG } from './admin.js';
import { BUILD_TOOLS, PROJECT_CONFIG_TOOLS } from './builds.js';

export const MCP_EXT_TOOL_GROUPS = Object.freeze({
  builds: BUILD_TOOLS,
  project_config: PROJECT_CONFIG_TOOLS,
  lxc_admin: LXC_ADMIN_TOOLS,
  edge: EDGE_TOOLS,
  static_admin: STATIC_ADMIN_TOOLS,
  admin: ADMIN_TOOLS,
  self_edit: SELF_EDIT_CATALOG,
});

export const MCP_EXT_TOOLS = Object.freeze(Object.values(MCP_EXT_TOOL_GROUPS).flat());
export const MCP_EXT_TOOL_NAMES = Object.freeze(MCP_EXT_TOOLS.map((t) => t.name));

/** Tools whose schema carries a one-time confirmation token (delete / restore / rollback / reboot). */
export const MCP_EXT_TOKEN_GATED = Object.freeze(MCP_EXT_TOOLS.filter((t) => t.inputSchema.properties.confirmation_token).map((t) => t.name));
/** Tools gated on `confirm: true`. */
export const MCP_EXT_CONFIRM_GATED = Object.freeze(MCP_EXT_TOOLS.filter((t) => t.inputSchema.properties.confirm).map((t) => t.name));
/** Tools that take dry_run. */
export const MCP_EXT_DRY_RUN = Object.freeze(MCP_EXT_TOOLS.filter((t) => t.inputSchema.properties.dry_run).map((t) => t.name));

export const MCP_EXT_INSTRUCTIONS = [
  'EXTENDED SURFACE (builds, components, project config, LXC admin, edge/certs/DNS, static sites, ProxyPilot admin, self-editing):',
  'every new write takes dry_run: true to preview; every file edit takes expected_sha256; anything destructive',
  '(delete_*, restore_*, rollback_*, reboot_host, reset_passkey, promote_self) issues a ONE-TIME confirmation_token',
  'on its first call after taking its snapshot/export precondition — show the user the preview it returns, then',
  're-call with the token. The server writes the MCP ledger row, the audit entry and (for project writes) the',
  'hash-chained change record itself; never hand-compute any of them (query_audit_log shows both).',
  'BUILDS: start_project_build / approve_design / run_checklist SPEND the project\'s model budget and are behind',
  'the mcp.builds flag; the chat lane above stays free. SELF-EDITING (read_self_file → apply_self_patch →',
  'run_self_checks → promote_self / rollback_self) works on a candidate clone and needs a key minted with',
  'scope.self_edit (create_scoped_key); the live checkout is only ever fast-forwarded or reset, never patched.',
].join(' ');
