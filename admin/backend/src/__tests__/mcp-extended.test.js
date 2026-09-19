// The extended MCP surface (lib/mcp-ext, routes/mcp-tools): catalog ↔ handler
// coverage, the cross-cutting gates (dry_run, confirm, one-time confirmation
// tokens, feature flags, the server-written ledger), key scopes, the per-guest
// allowlist merge, the route edge-option renderer, and the pure validators.
// Native-free: the handler families are instantiated against a fake ctx.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MCP_TOOLS, MCP_SERVER_INSTRUCTIONS, mergeLxcCommandPolicy } from '../lib/mcp-logic.js';
import {
  MCP_EXT_TOOLS, MCP_EXT_TOOL_NAMES, MCP_EXT_TOKEN_GATED, MCP_EXT_CONFIRM_GATED, MCP_EXT_DRY_RUN, MCP_EXT_TOOL_GROUPS,
} from '../lib/mcp-ext/catalog/index.js';
import {
  createConfirmationStore, looksLikeConfirmationToken, parseTokenScope, validateTokenScope, scopeRefusal, filterCatalogForScope,
  SELF_EDIT_TOOLS, redactArgs, readOnlySqlError, envFileKeys, mergeEnvFile, validateEnvVars, parseChecklist, recordChecklistItem,
  resolveBuildMode, parseSystemctlUnits, parseDpkgList, parseAptUpgradable, validGitRefName, validOctalMode, pathUnder, parseReleases, renderReleases,
} from '../lib/mcp-ext/logic.js';
import { validateRouteEdgeOptions, routeEdgeOptionLines, wrapRouteBody, parseRouteEdgeOptions } from '../lib/caddy-site-file.js';
import { createExtendedHandlers } from '../routes/mcp-tools/index.js';

const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
const LXC_POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/lxc-command-allowlist.json', import.meta.url), 'utf8'));
const ROUTE_SRC = readFileSync(new URL('../routes/mcp.js', import.meta.url), 'utf8');
const DB_SRC = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
const parse = (r) => JSON.parse(r.content[0].text);

/* ------------------------------ fake ctx ------------------------------- */

function fakeDb() {
  const ledger = []; const audit = []; const settings = new Map();
  const db = {
    prepare(sql) {
      return {
        run: (...args) => { if (/INSERT INTO mcp_ledger/.test(sql)) ledger.push(args); return { changes: 1, lastInsertRowid: ledger.length }; },
        get: () => undefined,
        all: () => [],
      };
    },
    exec() {},
    pragma() { return 1; },
  };
  return { db, ledger, audit, settings };
}

function makeCtx(overrides = {}) {
  const f = fakeDb();
  const confirmations = createConfirmationStore();
  const ctx = {
    getDb: () => f.db,
    logAudit: (...a) => f.audit.push(a),
    getSetting: (k) => (f.settings.has(k) ? f.settings.get(k) : null),
    setSetting: (k, v) => f.settings.set(k, v),
    toolResult, uuidv4: () => 'uuid', policy: POLICY, confirmations,
    runHostCapture: async () => ({ status: 0, stdout: '', stderr: '' }),
    runInContainer: async () => ({ status: 0, stdout: '', stderr: '' }),
    readContainerStartup: async () => null, agentCall: async () => { throw new Error('no agent'); }, publicBaseUrl: () => 'https://pp.test',
    LXC_PREFIX: 'pp-', LXC_NAME_REGEX: /^[a-zA-Z0-9][a-zA-Z0-9-]*$/, LXC_CMD_POLICY: LXC_POLICY, LXC_LIST_CAPTURE_CAP: 1 << 24,
    validLxcFilePath: (p) => (String(p || '').startsWith('/') && !String(p).includes('..') ? String(p) : null),
    validTargetDir: (p) => (String(p || '').startsWith('/') ? String(p).replace(/\/+$/, '') || '/' : null),
    takeLxcSnapshot: async (n, s) => ({ name: s }), fetchLxcInstance: async () => ({ notFound: true }),
    lxcContainerDetail: () => ({ snapshots: [], config: {}, status: 'Running' }), lxcReachableAddress: () => null,
    defaultSnapshotName: (d, p = 'pp-mcp') => `${p}-x`, validSnapshotName: (s) => s, snapshotArgv: (v, i, s) => ['snapshot', v, i, s], resolveSnapshotCliForm: async () => 'sub',
    verifiedContainerWrite: async () => ({ bytes: 1, sha256: 'a', total_lines: 1 }), takeUploadTicket: async () => { throw new Error('no ticket'); },
    findOrCreateLxcService: () => ({ id: 's' }), syncLxcServiceUpstream: async () => ({}), regenerateDomainCaddyConfig: async () => {}, ensureCaddyStructure: async () => {},
    assertRoutesShareSslStance: () => {}, caddyAdapt: async () => {}, caddyReload: async () => {}, normalizePathPrefix: (v) => (v ? String(v) : '/'),
    validDomainName: (s) => (/^[a-z0-9.-]+\.[a-z]+$/.test(String(s || '')) ? String(s) : null), normalizePort: (p) => (Number(p) > 0 ? Number(p) : null), validIpv4: (s) => s,
    ROUTE_SELECT: 'SELECT 1', routeView: (r) => r, certInfoForDomain: async () => ({}), recentErrorsForDomain: async () => null,
    caddyAccessLogPath: (d) => `/var/log/caddy/${d}.log`, summarizeAccessLog: () => ({}),
    getStaticSite: () => null, staticSiteDomains: () => [], SERVICES_DATA_DIR: '/data/services', walkDocroot: async () => ({ files: [] }),
    mock2Enabled: () => false, mock2Modules: async () => { throw new Error('mock2 off'); }, projectContainerName: () => 'm2-1', requireActiveProject: () => ({ error: 'no' }),
    liveBuildGuard: () => null, commitProjectPaths: async () => ({}), readProjectText: async () => ({ error: 'x' }), M2_APP_DIR: '/srv/app', projectUrl: () => null, projectSummary: (p) => p,
    appendProjectChangeRecord: async () => ({ appended: true, seq: 1 }),
    selfUpdateInstalled: async () => ({ reachable: false, error: 'off' }), selfUpdateStart: async () => { throw new Error('off'); }, selfUpdateStatus: async () => ({ status: 'idle' }),
    SELF_UPDATE_POLICY: { enabled: true }, mintMcpToken: () => 'ppmcp_' + 'a'.repeat(64), hashMcpToken: (t) => `h:${t}`, MCP_TOOL_NAMES: () => MCP_TOOLS.map((t) => t.name),
    dbPath: '/tmp/pp.db', listBackupsRunning: null,
    ...overrides,
  };
  return { ctx, ...f, confirmations };
}

const AUTH = { id: 7, created_by: 'admin-1', name: 'test key', scope_json: null };

/* -------------------------------- catalog ------------------------------ */

test('the extended catalog is well-formed, unique, and every family is represented', () => {
  assert.equal(MCP_EXT_TOOLS.length, 160);
  assert.equal(new Set(MCP_EXT_TOOL_NAMES).size, MCP_EXT_TOOL_NAMES.length);
  for (const t of MCP_EXT_TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]+$/);
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    for (const r of t.inputSchema.required || []) assert.ok(t.inputSchema.properties[r], `${t.name}: required ${r} is not a property`);
  }
  assert.deepEqual(Object.keys(MCP_EXT_TOOL_GROUPS), ['builds', 'project_config', 'lxc_admin', 'edge', 'static_admin', 'admin', 'self_edit', 'storage']);
  assert.equal(MCP_TOOLS.length, 72 + 160);
  assert.ok(Object.isFrozen(MCP_TOOLS));
  assert.match(MCP_SERVER_INSTRUCTIONS, /confirmation_token/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /scope\.self_edit/);
});

test('every destructive verb takes a one-time confirmation token, never a bare confirm', () => {
  const expected = ['delete_lxc_container', 'restore_snapshot', 'delete_route', 'delete_static_site', 'rollback_static_site', 'reset_passkey',
    'restore_proxypilot_db', 'reboot_host', 'delete_project', 'restore_project_db', 'rollback_release', 'promote_self', 'rollback_self'];
  for (const n of expected) assert.ok(MCP_EXT_TOKEN_GATED.includes(n), `${n} must be confirmation-token gated`);
  for (const n of MCP_EXT_TOKEN_GATED) {
    assert.ok(!byName.get(n).inputSchema.properties.confirm, `${n} carries both gates`);
    assert.match(byName.get(n).description, /confirmation_token/i);
  }
  // Every write takes dry_run.
  for (const n of [...MCP_EXT_TOKEN_GATED, ...MCP_EXT_CONFIRM_GATED]) assert.ok(MCP_EXT_DRY_RUN.includes(n), `${n} lacks dry_run`);
  // Every file-editing tool takes expected_sha256.
  for (const n of ['write_mockup', 'update_inventory', 'append_rule', 'record_check', 'write_handoff', 'update_work']) {
    assert.ok(byName.get(n).inputSchema.properties.expected_sha256, `${n} lacks expected_sha256`);
  }
  assert.ok(byName.get('apply_self_patch').inputSchema.properties.expected_sha256);
});

test('every extended tool has a handler and nothing is dispatched that is not advertised', () => {
  const { ctx } = makeCtx();
  const { handlers } = createExtendedHandlers(ctx);
  assert.deepEqual(Object.keys(handlers).sort(), [...MCP_EXT_TOOL_NAMES].sort());
  assert.match(ROUTE_SRC, /\.\.\.extended\.handlers,/);
  assert.match(ROUTE_SRC, /scopeRefusal\(parseTokenScope\(auth\?\.scope_json\), name/);
  assert.match(ROUTE_SRC, /filterCatalogForScope\(MCP_TOOLS, parseTokenScope\(auth\?\.scope_json\)\)/);
  assert.match(ROUTE_SRC, /mergeLxcCommandPolicy\(LXC_CMD_POLICY/);
  for (const v of [903, 904, 905, 906, 907]) assert.match(DB_SRC, new RegExp(`runMigration\\(db, ${v},`), `migration ${v}`);
});

/* -------------------------------- gates -------------------------------- */

test('confirm gate: a mutating tool refuses without confirm: true and records a refused ledger row', async () => {
  const { ctx, ledger } = makeCtx();
  const { handlers } = createExtendedHandlers(ctx);
  const r = await handlers.set_feature_flag({ name: 'mcp.dns', enabled: false }, AUTH);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /confirm: true/);
  assert.equal(ledger.length, 1);
  const row = ledger[0];
  assert.equal(row[3], 'set_feature_flag');
  assert.equal(row[8], 'refused');
});

test('dry_run previews and writes a dry_run ledger row; the real call flips the flag, audits, and ledgers ok', async () => {
  const { ctx, ledger, audit, settings } = makeCtx();
  const { handlers, kit } = createExtendedHandlers(ctx);
  const d = parse(await handlers.set_feature_flag({ name: 'mcp.dns', enabled: false, dry_run: true }, AUTH));
  assert.equal(d.dry_run, true);
  assert.deepEqual(d.would, { name: 'mcp.dns', current: true, enabled: false });
  assert.equal(settings.size, 0);
  assert.equal(ledger[0][8], 'dry_run');
  const r = parse(await handlers.set_feature_flag({ name: 'mcp.dns', enabled: false, confirm: true }, AUTH));
  assert.equal(r.applied, true);
  assert.equal(kit.flag('mcp.dns'), false);
  assert.equal(ledger[1][8], 'ok');
  assert.equal(audit.length, 1);
  assert.equal(audit[0][1], 'MCP_SET_FEATURE_FLAG');
  assert.equal(audit[0][4].via, 'mcp');
  // Flag off → the gated family refuses before doing anything.
  const dns = await handlers.set_dns_record({ name: 'a.example.com', content: '1.2.3.4', confirm: true }, AUTH);
  assert.equal(dns.isError, true);
  assert.match(dns.content[0].text, /mcp\.dns is off/);
});

test('confirmation tokens: first call issues one bound to the target, the second consumes it, a replay is refused', async () => {
  const { ctx, ledger } = makeCtx({ runHostCapture: async (bin) => ({ status: 0, stdout: bin === 'shutdown' ? '' : '', stderr: '' }) });
  const { handlers } = createExtendedHandlers(ctx);
  const first = parse(await handlers.reboot_host({}, AUTH));
  assert.equal(first.needs_confirmation, true);
  assert.ok(looksLikeConfirmationToken(first.confirmation_token));
  assert.equal(first.expires_in_seconds, 600);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0][8], 'needs_confirmation', 'issuing a token is recorded, so an unanswered prompt is visible in the ledger');
  const other = await handlers.reboot_host({ confirmation_token: first.confirmation_token }, { ...AUTH, id: 8 });
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /different MCP key/);
  // The wrong-key attempt burned it.
  const replay = await handlers.reboot_host({ confirmation_token: first.confirmation_token }, AUTH);
  assert.match(replay.content[0].text, /unknown, already used, or expired/);
  const second = parse(await handlers.reboot_host({}, AUTH));
  const done = parse(await handlers.reboot_host({ confirmation_token: second.confirmation_token }, AUTH));
  assert.equal(done.scheduled, true);
  const okRow = ledger.find((r) => r[8] === 'ok');
  assert.ok(okRow);
  assert.equal(okRow[10], 1, 'confirmation_used recorded');
});

test('the confirmation store binds tool + subject + actor and expires', () => {
  let now = 1000;
  const store = createConfirmationStore({ now: () => now, ttlMs: 100 });
  const t = store.issue({ tool: 'delete_route', subject: 'a.example.com/', actor: 1 });
  assert.match(store.consume(t.token, { tool: 'delete_route', subject: 'b.example.com/', actor: 1 }).error, /different target/);
  const t2 = store.issue({ tool: 'delete_route', subject: 'a.example.com/', actor: 1 });
  assert.match(store.consume(t2.token, { tool: 'delete_project', subject: 'a.example.com/', actor: 1 }).error, /issued for delete_route/);
  const t3 = store.issue({ tool: 'x', subject: 's', actor: 1 });
  now += 200;
  assert.match(store.consume(t3.token, { tool: 'x', subject: 's', actor: 1 }).error, /expired/);
  const t4 = store.issue({ tool: 'x', subject: 's', actor: 1 });
  assert.deepEqual(store.consume(t4.token, { tool: 'x', subject: 's', actor: 1 }), { ok: true });
  assert.match(store.consume('nonsense', { tool: 'x', subject: 's', actor: 1 }).error, /malformed/);
});

test('destructive preconditions: delete_lxc_container refuses a guest with no snapshot before issuing any token', async () => {
  const { ctx, ledger, confirmations } = makeCtx({
    fetchLxcInstance: async () => ({ instance: { status: 'Running', snapshots: [] } }),
    lxcContainerDetail: () => ({ snapshots: [], config: {}, status: 'Running' }),
  });
  const { handlers } = createExtendedHandlers(ctx);
  const r = await handlers.delete_lxc_container({ container: 'web1' }, AUTH);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no snapshot/);
  assert.equal(confirmations.size(), 0);
  assert.equal(ledger[0][8], 'refused');
});

test('scoped keys: refusals are decided before the handler runs and the catalog is filtered', () => {
  const unscoped = parseTokenScope(null);
  assert.equal(scopeRefusal(unscoped, 'delete_route', {}, byName.get('delete_route')), null);
  assert.match(scopeRefusal(unscoped, 'promote_self', {}, byName.get('promote_self')), /self-editing scope/);
  const selfEdit = parseTokenScope(JSON.stringify({ self_edit: true }));
  assert.equal(scopeRefusal(selfEdit, 'promote_self', {}, byName.get('promote_self')), null);
  for (const n of SELF_EDIT_TOOLS) assert.ok(byName.has(n));
  const lxc = parseTokenScope({ lxc_containers: ['web1'] });
  assert.equal(scopeRefusal(lxc, 'read_lxc_file', { container: 'web1' }, byName.get('read_lxc_file')), null);
  assert.match(scopeRefusal(lxc, 'read_lxc_file', { container: 'web2' }, byName.get('read_lxc_file')), /outside its scope/);
  assert.match(scopeRefusal(lxc, 'list_projects', {}, byName.get('list_projects')) || '', /^$/);
  assert.match(scopeRefusal(lxc, 'delete_route', {}, byName.get('delete_route')), /only call container tools/);
  const proj = parseTokenScope({ project_ids: [3], tools: ['read_project_file', 'get_rules'] });
  assert.equal(scopeRefusal(proj, 'get_rules', { project_id: 3 }, byName.get('get_rules')), null);
  assert.match(scopeRefusal(proj, 'get_rules', { project_id: 4 }, byName.get('get_rules')), /outside its scope/);
  assert.match(scopeRefusal(proj, 'apply_project_patch', { project_id: 3 }, byName.get('apply_project_patch')), /not on its allowlist/);
  const visible = filterCatalogForScope(MCP_TOOLS, proj).map((t) => t.name);
  assert.deepEqual(visible.sort(), ['get_rules', 'read_project_file']);
  assert.ok(!filterCatalogForScope(MCP_TOOLS, unscoped).some((t) => SELF_EDIT_TOOLS.includes(t.name)));
  assert.equal(filterCatalogForScope(MCP_TOOLS, selfEdit).length, MCP_TOOLS.length);
});

test('validateTokenScope refuses unknown tools and bad shapes', () => {
  assert.match(validateTokenScope({ tools: ['nope'] }, { knownTools: ['a'] }).error, /unknown tools/);
  assert.match(validateTokenScope({ lxc_containers: ['bad name'] }).error, /container names/);
  assert.match(validateTokenScope({ project_ids: ['x'] }).error, /positive integers/);
  assert.deepEqual(validateTokenScope({ tools: ['a', 'a'], self_edit: true }, { knownTools: ['a'] }).scope, { tools: ['a'], self_edit: true });
  assert.deepEqual(validateTokenScope(null), { scope: null });
});

test('redactArgs keeps targets and flags, never payloads or secrets', () => {
  const r = redactArgs({ container: 'web1', content: 'x'.repeat(10), vars: { A: 'secret' }, password: 'p', confirmation_token: 'ppconf_x', nested: { patch: 'diff', ok: true } });
  assert.equal(r.container, 'web1');
  assert.match(r.content, /redacted 10 bytes/);
  assert.equal(r.vars, '[redacted]');
  assert.equal(r.password, '[redacted 1 bytes]');
  assert.equal(r.confirmation_token, '[used]');
  assert.deepEqual(r.nested, { patch: '[redacted 4 bytes]', ok: true });
});

/* ---------------------------- lxc allowlist merge ----------------------- */

test('mergeLxcCommandPolicy adds guest prefixes but never widens deny_always', () => {
  const merged = mergeLxcCommandPolicy(LXC_POLICY, { read_only: [['ps', 'aux'], 'rm -rf /', ['apt', 'list']], mutating: [['docker', 'compose', 'down'], ['npm', 'run', 'build']] });
  assert.ok(merged.read_only.some((a) => a.join(' ') === 'ps aux'));
  assert.ok(!merged.read_only.some((a) => a[0] === 'rm'));
  assert.ok(!merged.read_only.some((a) => a[0] === 'apt'));
  assert.ok(!merged.mutating_scoped.commands.some((a) => a.join(' ') === 'docker compose down'));
  assert.ok(merged.mutating_scoped.commands.some((a) => a.join(' ') === 'npm run build'));
  assert.deepEqual(merged.deny_always, LXC_POLICY.deny_always);
  assert.equal(mergeLxcCommandPolicy(LXC_POLICY, {}).read_only.length, LXC_POLICY.read_only.length);
});

/* ----------------------------- route options --------------------------- */

test('route edge options: validation shapes, bcrypt for basic auth, module check for rate_limit', () => {
  const hash = (pw) => `$2b$10$${pw}`;
  const v = validateRouteEdgeOptions({ headers: { 'X-Robots-Tag': 'noindex', 'X-Powered-By': null }, csp: "default-src 'self'", basic_auth: [{ username: 'ops', password: 'hunter2hunter2' }], ip_allowlist: ['10.0.0.0/8', '203.0.113.7'], rate_limit: { events: 100, window: '1m' } }, { bcryptHash: hash, rateLimitAvailable: true });
  assert.equal(v.error, undefined);
  assert.deepEqual(v.options.headers, { 'X-Robots-Tag': 'noindex', 'X-Powered-By': null });
  assert.equal(v.options.basic_auth[0].hash, '$2b$10$hunter2hunter2');
  assert.equal(v.options.rate_limit.key, '{remote_host}');
  assert.match(validateRouteEdgeOptions({ rate_limit: { events: 5, window: '1m' } }, { rateLimitAvailable: false }).error, /caddy-ratelimit/);
  assert.match(validateRouteEdgeOptions({ basic_auth: [{ username: 'a', password: 'short' }] }, { bcryptHash: hash }).error, /8–256/);
  assert.match(validateRouteEdgeOptions({ ip_allowlist: ['0.0.0.0/0'] }).error, /not an IP/);
  assert.match(validateRouteEdgeOptions({ headers: { 'Set-Cookie': 'x' } }).error, /cannot be set/);
  assert.match(validateRouteEdgeOptions({ csp: 'a\nb' }).error, /single-line/);
  assert.deepEqual(validateRouteEdgeOptions({ headers: null, csp: '', ip_allowlist: null }).options, { headers: null, csp: null, ip_allowlist: null });
});

test('route edge options render inside the handle block, wrapped in route {} only for a rate limit', () => {
  const row = { extra_headers_json: JSON.stringify({ 'X-A': 'b c', 'X-Gone': null }), csp: "default-src 'self'", basic_auth_json: JSON.stringify([{ username: 'ops', hash: '$2b$x' }]), ip_allowlist_json: JSON.stringify(['10.0.0.0/8']), rate_limit_json: null };
  const opts = parseRouteEdgeOptions(row);
  const lines = routeEdgeOptionLines(opts, '    ', { routeId: 'r1' });
  assert.deepEqual(lines, [
    '    @pp_denied not remote_ip 10.0.0.0/8',
    '    respond @pp_denied 403',
    '    basic_auth {', '        ops $2b$x', '    }',
    '    header {', '        X-A "b c"', '        -X-Gone', '        Content-Security-Policy "default-src \'self\'"', '    }',
  ]);
  assert.deepEqual(wrapRouteBody(lines, ['    reverse_proxy 10.0.0.2:3000'], opts, '    ').slice(-1), ['    reverse_proxy 10.0.0.2:3000']);
  const rl = parseRouteEdgeOptions({ rate_limit_json: JSON.stringify({ events: 10, window: '10s', key: '{remote_host}' }) });
  const wrapped = wrapRouteBody(routeEdgeOptionLines(rl, '    ', { routeId: 'ab-1' }), ['    reverse_proxy x:1'], rl, '    ');
  assert.equal(wrapped[0], '    route {');
  assert.ok(wrapped.some((l) => l.includes('zone pp_ab1 {')));
  assert.equal(wrapped[wrapped.length - 1], '    }');
  assert.equal(parseRouteEdgeOptions({}), null, 'a pre-907 row renders nothing');
  assert.deepEqual(routeEdgeOptionLines(null), []);
});

/* ------------------------------ validators ----------------------------- */

test('readOnlySqlError admits reads and refuses writes, even inside a CTE', () => {
  assert.equal(readOnlySqlError('SELECT * FROM users LIMIT 5;'), null);
  assert.equal(readOnlySqlError('with x as (select 1) select * from x'), null);
  assert.equal(readOnlySqlError('EXPLAIN SELECT 1'), null);
  assert.match(readOnlySqlError('DELETE FROM users'), /read-only/);
  assert.match(readOnlySqlError('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d'), /inside a CTE/);
  assert.match(readOnlySqlError('SELECT 1; DROP TABLE users'), /one statement/);
  assert.match(readOnlySqlError(''), /required/);
});

test('env file merge: replaces in place, appends new, null deletes, keys never carry values back', () => {
  const merged = mergeEnvFile('PATH="/usr/bin"\nAPI_KEY="old"\n# comment\n', { API_KEY: 'new "quoted"', NEW_ONE: 'v', PATH: null });
  assert.equal(merged, 'API_KEY="new \\"quoted\\""\n# comment\nNEW_ONE="v"\n');
  assert.deepEqual(envFileKeys(merged), ['API_KEY', 'NEW_ONE']);
  assert.match(validateEnvVars({ 'bad-name': 'x' }).error, /not a valid environment variable name/);
  assert.match(validateEnvVars({}).error, /empty/);
  assert.deepEqual(validateEnvVars({ A: 1, B: null }).vars, { A: '1', B: null });
});

test('checklist parsing and recording', () => {
  const md = '# Checklist\n\n- [ ] TLS everywhere\n- [x] Backups configured\n- [~] Pen test (waived)\n';
  assert.deepEqual(parseChecklist(md).map((i) => [i.status, i.text]), [['open', 'TLS everywhere'], ['pass', 'Backups configured'], ['waived', 'Pen test (waived)']]);
  const r = recordChecklistItem(md, { match: 'tls everywhere', status: 'pass', note: 'verified via test_route', date: '2026-09-19' });
  assert.equal(r.error, undefined);
  assert.match(r.md, /- \[x\] TLS everywhere\n    - 2026-09-19 PASS: verified via test_route/);
  assert.match(recordChecklistItem(md, { match: 'nothing', status: 'pass' }).error, /no checklist item/);
  assert.match(recordChecklistItem(md, { match: 'e', status: 'pass' }).error, /matches 3 items/);
  assert.match(recordChecklistItem(md, { match: 'TLS', status: 'maybe' }).error, /status must be/);
});

test('build size vocabulary, git refs, octal modes, path guard, release registry, host parsers', () => {
  assert.deepEqual(resolveBuildMode({ size: 's' }), { mode: 'quick', size: 'S' });
  assert.deepEqual(resolveBuildMode({ mode: 'MVP' }), { mode: 'mvp' });
  assert.deepEqual(resolveBuildMode({}), { mode: 'full' });
  assert.match(resolveBuildMode({ size: 'XL' }).error, /S, M or L/);
  assert.equal(validGitRefName('release/v1.2.0'), 'release/v1.2.0');
  assert.equal(validGitRefName('-flag'), null);
  assert.equal(validGitRefName('a..b'), null);
  assert.equal(validGitRefName('x.lock'), null);
  assert.equal(validOctalMode('755'), '0755');
  assert.equal(validOctalMode('0644'), '0644');
  assert.equal(validOctalMode('999'), null);
  assert.equal(pathUnder('/var/lib/proxypilot/mcp-exports', 'lxc-web1.tar.gz'), '/var/lib/proxypilot/mcp-exports/lxc-web1.tar.gz');
  assert.equal(pathUnder('/x', '../etc/passwd'), null);
  assert.equal(pathUnder('/x', '/abs'), null);
  const reg = parseReleases(renderReleases({ releases: [{ tag: 'v1' }], current: { tag: 'v1' } }));
  assert.deepEqual(reg, { releases: [{ tag: 'v1' }], current: { tag: 'v1' } });
  assert.deepEqual(parseReleases('garbage'), { releases: [], current: null });
  assert.deepEqual(parseSystemctlUnits('[{"unit":"caddy.service","load":"loaded","active":"active","sub":"running","description":"Caddy"}]'), [{ unit: 'caddy.service', load: 'loaded', active: 'active', sub: 'running', description: 'Caddy' }]);
  assert.deepEqual(parseSystemctlUnits('  caddy.service loaded active running Caddy web server\n● docker.service loaded failed failed Docker'), [
    { unit: 'caddy.service', load: 'loaded', active: 'active', sub: 'running', description: 'Caddy web server' },
    { unit: 'docker.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'Docker' },
  ]);
  assert.deepEqual(parseDpkgList('curl\t8.5.0\tinstall ok installed\nfoo\t1\tdeinstall ok config-files\n'), [{ name: 'curl', version: '8.5.0' }]);
  assert.deepEqual(parseAptUpgradable('Listing...\ncurl/jammy-updates 8.5.0-2 amd64 [upgradable from: 8.5.0-1]\n'), [{ name: 'curl', candidate: '8.5.0-2', installed: '8.5.0-1' }]);
});

/* -------------------------------- policy ------------------------------- */

test('the policy file is the enforcement source: flags default on, docker/ssh are never stoppable, self-edit needs its own scope', () => {
  for (const [name, def] of Object.entries(POLICY.feature_flags)) {
    if (name.startsWith('$')) continue;
    assert.equal(def.default, true, name);
    assert.ok(def.description);
  }
  assert.deepEqual(POLICY.host_services.docker, ['status', 'restart']);
  assert.ok(!POLICY.host_services.ssh.includes('stop'));
  assert.ok(POLICY.apt_packages.allow.includes('curl'));
  assert.ok(!POLICY.apt_packages.allow.includes('sudo'));
  assert.ok(POLICY.lxc_devices.disk_source_roots.every((r) => r.startsWith('/')));
  assert.ok(POLICY.self_edit.required_checks_for_promote.includes('backend-tests'));
  assert.ok(POLICY.explicitly_absent.unscoped_self_edit);
  assert.ok(POLICY.explicitly_absent.discard_local);
  assert.ok(!POLICY.settings.writable.includes('cloudflare_global_token'));
});
