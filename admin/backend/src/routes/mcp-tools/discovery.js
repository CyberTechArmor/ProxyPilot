import { discoverCapabilities } from '../../lib/mcp-capabilities.js';
import { filterCatalogForScope, parseTokenScope } from '../../lib/mcp-ext/logic.js';

export function createDiscoveryHandlers(kit) {
  return {
    discover_capabilities: kit.reader('discover_capabilities', async (args, auth) => {
      const catalog = kit.ctx.MCP_CATALOG?.() || [];
      return kit.ok(discoverCapabilities(filterCatalogForScope(catalog, parseTokenScope(auth?.scope_json)), {
        query: args.query, limit: args.limit, includeSchemas: args.include_schemas === true,
      }));
    }),
  };
}
