import { tool } from './shared.js';
export const DISCOVERY_TOOLS = [
  tool('discover_capabilities', 'Find the available ProxyPilot MCP workflow and exact tool names for a task before assuming the capability is absent. Searches only the catalog permitted by this key; returns workflows, descriptions and optional input schemas. Does not change scope or enable features.', {
    query: { type: 'string', description: 'Task words, e.g. Nodus Git deploy recovery, or storage. Empty lists workflow entry points.' },
    limit: { type: 'integer', minimum: 1, maximum: 30 },
    include_schemas: { type: 'boolean' },
  }),
];
