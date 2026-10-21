// Application storage over MCP: three read-only tools (list, read a check,
// request a check that only measures), and the ratchet: no MCP tool can
// create a cleanup or change a retention policy — those are dashboard-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { APP_STORAGE_TOOLS } from '../lib/mcp-ext/catalog/app-storage.js';
import { MCP_EXT_TOOL_GROUPS } from '../lib/mcp-ext/catalog/index.js';
import { MCP_TOOLS } from '../lib/mcp-logic.js';
import { MCP_WORKFLOWS } from '../lib/mcp-capabilities.js';
import { createConfirmationStore, parseTokenScope, scopeRefusal } from '../lib/mcp-ext/logic.js';
import { createToolkit } from '../routes/mcp-tools/common.js';
import { createAppStorageHandlers } from '../routes/mcp-tools/app-storage.js';

const NAMES = ['list_application_storage', 'get_application_storage_check', 'request_application_storage_check'];
const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
const parse = (r) => JSON.parse(r.content[0].text);
const AUTH = { id: 11, created_by: 'admin-1', scope_json: null };
const CHECK = (key = 'application:1', id = 'chk_00000000-0000-4000-8000-000000000001') => ({ version: 1, checkId: id, target: { key }, status: 'complete', items: [{ id: 'a'.repeat(16), kind: 'group', memberCount: 80, members: Array.from({ length: 80 }, (_, i) => ({ path: `/tmp/x-${i}` })) }] });

/** A read-only facade: touching anything but the four read/measure methods fails the test. */
function facade(calls) {
  const allowed = {
    overview: async () => { calls.push(['overview']); return { targets: [{ key: 'application:1', name: 'Nodus' }], checkedAt: 'now' }; },
    getCheck: (id) => { calls.push(['getCheck', id]); return id === 'chk_00000000-0000-4000-8000-000000000002' ? CHECK('project:4', id) : id === 'chk_00000000-0000-4000-8000-000000000001' ? CHECK() : null; },
    latestCheck: (key) => { calls.push(['latestCheck', key]); return key === 'application:1' ? CHECK() : null; },
    requestCheck: (key, opts) => { calls.push(['requestCheck', key, opts]); return { checkId: 'chk_00000000-0000-4000-8000-000000000003', status: 'running', reused: false }; },
  };
  return new Proxy(allowed, { get(target, prop) { if (typeof prop === 'symbol' || prop === 'then') return undefined; if (!Object.hasOwn(target, prop)) throw new Error(`MCP touched ${String(prop)} on application storage`); return target[prop]; } });
}

function handlers({ enabled = true } = {}) {
  const calls = []; const ledger = []; const audit = [];
  const db = { prepare: (sql) => ({ run: (...a) => { if (/INSERT INTO mcp_ledger/.test(sql)) ledger.push(a); return { changes: 1 }; }, get: () => undefined, all: () => [] }) };
  const ctx = {
    getDb: () => db, logAudit: (...a) => audit.push(a), getSetting: () => null, setSetting: () => {}, toolResult, policy: POLICY,
    confirmations: createConfirmationStore(), runHostCapture: async () => ({ status: 0, stdout: '' }), LXC_PREFIX: 'pp-',
    mock2Enabled: () => enabled, ...(enabled ? { appStorage: () => facade(calls) } : {}),
  };
  return { h: createAppStorageHandlers(createToolkit(ctx)), calls, ledger, audit };
}

test('the catalog: three read-only tools, no confirm, no token, no dry run; discoverable', () => {
  assert.deepEqual(APP_STORAGE_TOOLS.map((t) => t.name), NAMES);
  assert.equal(MCP_EXT_TOOL_GROUPS.app_storage, APP_STORAGE_TOOLS);
  for (const t of APP_STORAGE_TOOLS) {
    assert.ok(MCP_TOOLS.some((x) => x.name === t.name), `${t.name} is listed`);
    for (const p of ['confirm', 'confirmation_token', 'dry_run']) assert.equal(p in t.inputSchema.properties, false, `${t.name} takes no ${p}`);
    assert.match(t.description, /read-only|never deletes/i);
  }
  assert.deepEqual(APP_STORAGE_TOOLS[1].inputSchema.required, ['target_key']);
  assert.equal(APP_STORAGE_TOOLS[1].inputSchema.properties.target_key.pattern, '^(application|project):[1-9][0-9]*$');
  assert.deepEqual(MCP_WORKFLOWS.find((w) => w.id === 'app-storage').tools.sort(), [...NAMES].sort());
});

test('list and read: the overview, the latest or a named check (members trimmed), never another target\'s check', async () => {
  const { h, calls } = handlers();
  const list = parse(await h.list_application_storage({}, AUTH));
  assert.equal(list.targets[0].name, 'Nodus');
  assert.equal(list.next_actions[0].tool, 'request_application_storage_check');
  const latest = parse(await h.get_application_storage_check({ target_key: 'application:1' }, AUTH));
  assert.equal(latest.checkId, 'chk_00000000-0000-4000-8000-000000000001');
  assert.equal(latest.items[0].members.length, 50);
  assert.equal(latest.items[0].membersTruncated, true);
  const named = await h.get_application_storage_check({ target_key: 'application:1', check_id: 'chk_00000000-0000-4000-8000-000000000002' }, AUTH);
  assert.equal(named.isError, true);
  assert.match(named.content[0].text, /another application or project/);
  const none = await h.get_application_storage_check({ target_key: 'project:9' }, AUTH);
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /request one with request_application_storage_check/);
  assert.deepEqual(calls.map((c) => c[0]), ['overview', 'latestCheck', 'getCheck', 'latestCheck']);
});

test('requesting a check measures only: origin mcp, recorded in the ledger and the audit', async () => {
  const { h, calls, ledger, audit } = handlers();
  const r = parse(await h.request_application_storage_check({ target_key: 'application:1' }, AUTH));
  assert.deepEqual([r.checkId, r.status, r.read_only], ['chk_00000000-0000-4000-8000-000000000003', 'running', true]);
  assert.deepEqual(r.next_actions[0].arguments, { target_key: 'application:1', check_id: 'chk_00000000-0000-4000-8000-000000000003' });
  assert.deepEqual(calls[0], ['requestCheck', 'application:1', { origin: 'mcp', requestedBy: 'mcp:11' }]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0][3], 'request_application_storage_check');
  assert.equal(audit[0][1], 'MCP_REQUEST_APPLICATION_STORAGE_CHECK');
  assert.equal(audit[0][2], 'app_storage');
  assert.equal(audit[0][3], 'application:1');
});

test('Dev Studio off → a plain refusal; scoped keys (one container or project) cannot reach these tools', async () => {
  const { h } = handlers({ enabled: false });
  const r = await h.list_application_storage({}, AUTH);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Dev Studio is disabled/);
  for (const t of APP_STORAGE_TOOLS) {
    assert.ok(scopeRefusal(parseTokenScope({ lxc_containers: ['nodus'] }), t.name, {}, t), `${t.name} refused for a container key`);
    assert.ok(scopeRefusal(parseTokenScope({ project_ids: [4] }), t.name, {}, t), `${t.name} refused for a project key`);
    assert.equal(scopeRefusal(parseTokenScope(null), t.name, {}, t), null);
  }
});

/* --------------------------------- ratchet --------------------------------- */

test('ratchet: no MCP tool can create a cleanup or change a retention policy', () => {
  // 1. The family is exactly the three read/measure tools.
  assert.deepEqual(Object.keys(handlers().h).sort(), [...NAMES].sort());
  // 2. No other tool in the whole catalog is about application storage cleanup or retention.
  const related = MCP_TOOLS.map((t) => t.name).filter((n) => /application_storage|app_storage|storage_cleanup|storage_retention|retention_polic|storage_policy/.test(n));
  assert.deepEqual(related.sort(), [...NAMES].sort());
  // 3. No MCP source reaches the cleanup service, a policy write or their tables.
  const dir = new URL('../routes/mcp-tools/', import.meta.url);
  const sources = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]), ['mcp.js', readFileSync(new URL('../routes/mcp.js', import.meta.url), 'utf8')]];
  const forbidden = /requestCleanup|putPolicy|setCleanupService|cleanupService|insertCleanup|updateCleanup|mock2_storage_cleanups|mock2_storage_policies|cleanup-service|storage-cleanup|storage_cleanup|policySelection|postCleanupAlert/;
  for (const [name, src] of sources) assert.equal(forbidden.test(src), false, `${name} must not reach application storage cleanup or policy writes`);
  // 4. The family calls nothing on the storage instance but these four methods.
  const own = readFileSync(new URL('../routes/mcp-tools/app-storage.js', import.meta.url), 'utf8');
  const used = [...new Set([...own.matchAll(/\bs\.(\w+)\(/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ['getCheck', 'latestCheck', 'overview', 'requestCheck']);
  // 5. No writable MCP setting touches application storage.
  const writable = JSON.stringify(POLICY.settings?.writable ?? POLICY.settings ?? {});
  assert.equal(/app_storage|app-storage|storage_polic|retention/.test(writable), false);
});
