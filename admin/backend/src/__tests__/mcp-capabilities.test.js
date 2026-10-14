import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCapabilities } from '../lib/mcp-capabilities.js';
import { MCP_TOOLS, MCP_SERVER_INSTRUCTIONS } from '../lib/mcp-logic.js';
import { filterCatalogForScope, parseTokenScope, scopeRefusal } from '../lib/mcp-ext/logic.js';

test('discovery returns real names and input schemas, bounds results and gives workflow entry points', () => {
  const result = discoverCapabilities(MCP_TOOLS, { query: 'proxypilot self update', limit: 2, includeSchemas: true });
  assert.equal(result.tools.length, 2);
  assert.equal(result.has_more, true);
  assert.ok(result.workflows.some(w => w.id === 'self-update' && w.tools.includes('prepare_self_from_git')));
  assert.ok(result.tools.every(t => MCP_TOOLS.some(real => real.name === t.name) && t.inputSchema));
  assert.match(result.guidance, /passing test is not deployment/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Before assuming.*discover_capabilities/);
});

test('discovery does not advertise tools a key cannot call or expand a tools allowlist', () => {
  const scope = parseTokenScope({ tools: ['discover_capabilities', 'list_lxc_containers'], lxc_containers: ['nodus'] });
  const visible = filterCatalogForScope(MCP_TOOLS, scope);
  assert.deepEqual(visible.map(t => t.name).sort(), ['discover_capabilities', 'list_lxc_containers']);
  assert.equal(scopeRefusal(scope, 'discover_capabilities', {}, MCP_TOOLS.find(t => t.name === 'discover_capabilities')), null);
  const result = discoverCapabilities(visible, { query: 'container', includeSchemas: true });
  assert.ok(result.tools.every(t => scope.tools.includes(t.name)));
  assert.ok(!JSON.stringify(result).includes('prepare_self_from_git'));
});

test('self remote preparation retains the explicit self-edit scope', () => {
  const tool = MCP_TOOLS.find(t => t.name === 'prepare_self_from_git');
  assert.ok(tool);
  assert.match(scopeRefusal(parseTokenScope(null), tool.name, {}, tool), /self-editing/);
  assert.equal(scopeRefusal(parseTokenScope({ self_edit: true }), tool.name, {}, tool), null);
});
