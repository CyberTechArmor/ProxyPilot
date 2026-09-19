// The extended MCP tool families, assembled. routes/mcp.js builds the ctx and
// spreads the result into TOOL_HANDLERS; nothing here imports routes/mcp.js.

import { createToolkit } from './common.js';
import { createLxcAdminHandlers } from './lxc-admin.js';
import { createEdgeHandlers } from './edge.js';
import { createStaticAdminHandlers } from './static-admin.js';
import { createAdminHandlers } from './admin.js';
import { createBuildHandlers } from './builds.js';
import { createProjectConfigHandlers } from './project-config.js';
import { createSelfEditHandlers } from './self-edit.js';

export function createExtendedHandlers(ctx) {
  const kit = createToolkit(ctx);
  const families = [
    createLxcAdminHandlers(kit),
    createEdgeHandlers(kit),
    createStaticAdminHandlers(kit),
    createAdminHandlers(kit),
    createBuildHandlers(kit),
    createProjectConfigHandlers(kit),
    createSelfEditHandlers(kit),
  ];
  const out = {};
  for (const fam of families) {
    for (const [name, fn] of Object.entries(fam)) {
      if (out[name]) throw new Error(`duplicate extended MCP tool: ${name}`);
      out[name] = fn;
    }
  }
  return { handlers: out, kit };
}
