// The scripted host the guest-configuration suites run against: `incus …`
// and `proxypilot --json firewall …` as argv arrays over a state; `sh -c`,
// `cat` and `rm` are REAL (the reserved-ports drop-in is a temp file);
// `sysctl` reads and applies that file.
//
// The firewall model follows the real CLI's order: a write SAVES the
// desired configuration (`firewall.json`) first and reconciles afterwards;
// a rejected reconcile leaves the saved configuration in place, records the
// rejection (`firewall_reconciles`) and exits 1 with the JSON the CLI
// prints. `status` reports the last recorded reconcile, `reconcile
// --dry-run` the desired ruleset's checksum, `reconcile` applies (or is
// rejected again). Flags on the state drive the failure cases.
//
//   state.instances          the guests (`incus list` reads them)
//   state.rules / egress     the SAVED firewall configuration
//   state.reconciles         the recorded reconciles (last = status)
//   state.rejectReconcile    a reason → every reconcile is rejected (saved, not applied)
//   state.fwAddFails         `add-service-l4` refuses to save (panic mode)
//   state.fwSaveWrongPort    `add-service-l4` saves the rule with port_start + 1
//   state.fwSaveWrongProto   `add-service-l4` saves the rule with the other protocol
//   state.egressFails        `egress allow|deny` fails without saving
//   state.egressDenySilent   `egress deny` exits 0 without removing
//   state.snapshotFails      `incus snapshot create` fails
//   state.configSetFails     the key whose `incus config set` exits 1
//   state.configSetSilent    the key whose `incus config set` exits 0 without a change
//   state.deviceAddFails / deviceAddSilent / deviceRemoveSilent / overrideFails
//   state.sysctlFails        `sysctl -p` fails
//   state.hook(argv)         an async hook run before every command (a result short-circuits)

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PROXYPILOT_BIN } from '../../lib/setup-engine/config-logic.js';
import { lxcContainerDetail, MCP_TOOLS } from '../../lib/mcp-logic.js';
import { createConfirmationStore } from '../../lib/mcp-ext/logic.js';

export function scriptedConfigHost(state) {
  const calls = [];
  const byName = (n) => state.instances.find((i) => i.name === n) || null;
  state.rules = state.rules || []; state.egress = state.egress || []; state.reconciles = state.reconciles || []; state.sysctl = state.sysctl ?? '';
  const real = (argv) => { const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' }); return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' }; };
  const json = (o, code = 0) => ({ code, stdout: JSON.stringify(o), stderr: '' });
  const checksum = () => createHash('sha1').update(JSON.stringify({ rules: state.rules, egress: state.egress })).digest('hex').slice(0, 16);
  const doReconcile = () => {
    const sum = checksum(); const rule_count = state.rules.filter((r) => r.enabled).length;
    if (state.rejectReconcile) { state.reconciles.push({ ruleset_checksum: sum, rule_count, applied: 0, rejection_reason: state.rejectReconcile }); return { ok: false, applied: false, checksum: sum, rule_count, rejection: { reason: state.rejectReconcile } }; }
    state.reconciles.push({ ruleset_checksum: sum, rule_count, applied: 1, rejection_reason: null });
    state.appliedChecksum = sum;
    return { ok: true, applied: true, checksum: sum, rule_count, rejection: null };
  };
  return {
    calls, checksum,
    host: async (argv) => {
      calls.push(argv);
      assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === 'string'), 'argv arrays only');
      if (state.hook) { const r = await state.hook(argv); if (r) return r; }
      if (argv[0] === 'sh' || argv[0] === 'cat' || argv[0] === 'rm') return real(argv);
      if (argv[0] === 'sysctl') {
        if (argv[1] === '-n') return { code: 0, stdout: `${state.sysctl}\n`, stderr: '' };
        if (state.sysctlFails) return { code: 1, stdout: '', stderr: 'sysctl: permission denied' };
        const f = argv[2]; const body = existsSync(f) ? readFileSync(f, 'utf8') : '';
        const m = /net\.ipv4\.ip_local_reserved_ports = (.*)/.exec(body); state.sysctl = m ? m[1].trim() : (f === '/etc/sysctl.conf' ? '' : state.sysctl);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === PROXYPILOT_BIN) {
        assert.equal(argv[1], '--json'); assert.equal(argv[2], 'firewall');
        const verb = argv[3];
        if (verb === 'list') return json(state.rules);
        if (verb === 'status') return json({ backend: 'nftables', table: 'inet/proxypilot', default_policy: 'deny', panic_close: false, last_reconcile: state.reconciles.length ? state.reconciles[state.reconciles.length - 1] : null });
        if (verb === 'reconcile' && argv[4] === '--dry-run') {
          const sum = checksum();
          if (state.rejectReconcile) { state.reconciles.push({ ruleset_checksum: sum, rule_count: 0, applied: 0, rejection_reason: state.rejectReconcile }); return json({ ok: false, applied: false, dry_run: true, checksum: sum, rejection: { reason: state.rejectReconcile } }, 1); }
          return json({ ok: true, applied: false, dry_run: true, checksum: sum, rejection: null });
        }
        if (verb === 'reconcile') { const rec = doReconcile(); return json({ ok: rec.ok, applied: rec.applied, dry_run: false, checksum: rec.checksum, rule_count: rec.rule_count, rejection: rec.rejection }, rec.ok ? 0 : 1); }
        if (verb === 'add-service-l4') {
          const opt = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : null; };
          const id = opt('--id');
          if (state.rules.some((r) => r.id === id)) return { code: 1, stdout: '', stderr: `a rule with id ${id} already exists` };
          if (state.fwAddFails) return { code: 1, stdout: '', stderr: 'Error: panic mode is active' };
          const rule = { id, source: 'service-l4', port_start: Number(opt('--port')) + (state.fwSaveWrongPort ? 1 : 0), port_end: opt('--port-end') ? Number(opt('--port-end')) : null, proto: state.fwSaveWrongProto ? (opt('--proto') === 'tcp' ? 'udp' : 'tcp') : opt('--proto'), scope: 'public', reason: opt('--reason'), enabled: true };
          if (opt('--service')) rule.service = opt('--service');
          state.rules.push(rule);
          const rec = doReconcile();
          return json({ ok: rec.ok && rec.applied, action: 'add-service-l4', rule, warnings: [], reconcile: { applied: rec.applied, checksum: rec.checksum, rule_count: rec.rule_count, rejection: rec.rejection } }, rec.ok ? 0 : 1);
        }
        if (verb === 'remove-service-l4') {
          const n = state.rules.length; state.rules = state.rules.filter((r) => r.id !== argv[4]);
          if (n === state.rules.length) return json({ ok: true, action: 'remove-service-l4', rule: { id: argv[4] }, already_absent: true });
          const rec = doReconcile();
          return json({ ok: rec.ok && rec.applied, action: 'remove-service-l4', rule: { id: argv[4] }, reconcile: { applied: rec.applied, checksum: rec.checksum, rule_count: rec.rule_count, rejection: rec.rejection } }, rec.ok ? 0 : 1);
        }
        if (verb === 'egress' && argv[4] === 'list') return json({ services: { dns: {}, http: {}, smtp: {} }, entries: state.egress });
        if (verb === 'egress') {
          const [, , , , action, container, service] = argv;
          if (state.egressFails) return { code: 1, stdout: '', stderr: `Error: unknown service '${service}'` };
          let e = state.egress.find((x) => x.container === container);
          if (action === 'allow') { if (!e) { e = { container, allow: [], reason: null }; state.egress.push(e); } if (!e.allow.includes(service)) e.allow.push(service); const ri = argv.indexOf('--reason'); if (ri > 0) e.reason = argv[ri + 1]; }
          else { if (!e) return { code: 1, stdout: '', stderr: 'no egress entry for container' }; if (!state.egressDenySilent) { e.allow = e.allow.filter((s) => s !== service); if (!e.allow.length) state.egress = state.egress.filter((x) => x !== e); } }
          const rec = doReconcile();
          return json({ action: `egress-${action}`, payload: action === 'allow' ? { ...e } : { container, service }, reconcile: { applied: rec.applied, checksum: rec.checksum, rejection: rec.rejection } }, rec.ok ? 0 : 1);
        }
        return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
      }
      if (argv[0] !== 'incus') return { code: 127, stdout: '', stderr: 'not incus' };
      const verb = argv[1];
      if (verb === 'query' && argv[2].endsWith('/resources')) return { code: 0, stdout: JSON.stringify({ space: { total: 1e12, used: 1e11 } }) };
      if (verb === 'list') { const i = byName(argv[2]); return { code: 0, stdout: JSON.stringify(i ? [i] : []), stderr: '' }; }
      if (verb === 'snapshot' && argv[2] === 'create') {
        const i = byName(argv[3]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' };
        if (state.snapshotFails) return { code: 1, stdout: '', stderr: 'Error: Failed creating instance snapshot: no space left' };
        if (i.snapshots.some((s) => s.name === argv[4])) return { code: 1, stdout: '', stderr: 'Error: Snapshot already exists' };
        i.snapshots.push({ name: argv[4], created_at: `2026-09-26T12:0${i.snapshots.length}:00Z` }); return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'config' && argv[2] === 'set') {
        const i = byName(argv[3]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' };
        if (state.configSetFails === argv[4]) return { code: 1, stdout: '', stderr: `Error: Invalid value for ${argv[4]}` };
        if (state.configSetSilent !== argv[4]) i.config[argv[4]] = argv[5];
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'config' && argv[2] === 'device') {
        const sub = argv[3]; const i = byName(argv[4]); if (!i) return { code: 1, stdout: '', stderr: 'Error: Instance not found' };
        i.devices = i.devices || {};
        if (sub === 'override') {
          const dev = argv[5]; const [k, v] = argv[6].split('=');
          if (i.devices[dev]) return { code: 1, stdout: '', stderr: 'Error: The device already exists' };
          if (state.overrideFails) return { code: 1, stdout: '', stderr: `Error: device '${dev}' doesn't exist` };
          i.devices[dev] = { ...(i.expanded_devices?.[dev] || { type: dev === 'root' ? 'disk' : 'nic' }), [k]: v }; return { code: 0, stdout: '', stderr: '' };
        }
        if (sub === 'set') { const dev = argv[5]; if (!i.devices[dev]) return { code: 1, stdout: '', stderr: 'Error: Device not found' }; i.devices[dev][argv[6]] = argv[7]; return { code: 0, stdout: '', stderr: '' }; }
        if (sub === 'add') {
          const dev = argv[5];
          if (i.devices[dev]) return { code: 1, stdout: '', stderr: 'Error: The device already exists' };
          if (state.deviceAddFails) return { code: 1, stdout: '', stderr: 'Error: Failed to start device: bind failed' };
          if (state.deviceAddSilent) return { code: 0, stdout: '', stderr: '' };
          i.devices[dev] = { type: argv[6], ...Object.fromEntries(argv.slice(7).map((kv) => { const j = kv.indexOf('='); return [kv.slice(0, j), kv.slice(j + 1)]; })) };
          return { code: 0, stdout: '', stderr: '' };
        }
        if (sub === 'remove') { const dev = argv[5]; if (!i.devices[dev]) return { code: 1, stdout: '', stderr: 'Error: Device not found' }; if (state.deviceRemoveSilent) return { code: 0, stdout: '', stderr: '' }; delete i.devices[dev]; return { code: 0, stdout: '', stderr: '' }; }
      }
      return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
    },
  };
}

// The rows the forward tools and jobs read and write, on the same node:sqlite
// database the setup engine uses (the runner and the backend open the one
// file in production).
export function forwardsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, runtime TEXT, type TEXT, status TEXT, is_admin INTEGER DEFAULT 0, target_ip TEXT, lxc_container_name TEXT);
    CREATE TABLE IF NOT EXISTS service_l4_forwards (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, proto TEXT NOT NULL CHECK (proto IN ('tcp','udp')), listen_port INTEGER NOT NULL, listen_port_end INTEGER, connect_port INTEGER NOT NULL, connect_port_end INTEGER, description TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(proto, listen_port, listen_port_end));
    CREATE TABLE IF NOT EXISTS mcp_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, token_id INTEGER, actor TEXT, tool TEXT NOT NULL, subject_type TEXT, subject_id TEXT, project_id INTEGER, args_json TEXT, outcome TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0, confirmation_used INTEGER NOT NULL DEFAULT 0, snapshot TEXT, summary TEXT, detail_json TEXT, duration_ms INTEGER);`);
  d.prepare(`INSERT OR IGNORE INTO services (id, name, target_ip, lxc_container_name) VALUES ('svc-x', 'x', '10.10.10.5', 'x')`).run();
  return d;
}
export const forwardRows = (d) => d.prepare(`SELECT id, service_id, proto, listen_port, listen_port_end, connect_port, connect_port_end, enabled FROM service_l4_forwards ORDER BY id`).all();

export const POLICY = JSON.parse(readFileSync(new URL('../../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
export const LXC_POLICY = JSON.parse(readFileSync(new URL('../../lib/mcp-policy/lxc-command-allowlist.json', import.meta.url), 'utf8'));
export const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
export const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return { error: r.content[0].text, isError: !!r.isError }; } };
export const AUTH = { id: 7, created_by: 'admin-1', name: 'test key', scope_json: null };

// The MCP context: the real node:sqlite database (the services / forwards /
// ledger tables the tools read and write), the guest read from the scripted
// state, a host channel that records what the TOOL itself issues.
export function mcpCtx(d, state) {
  forwardsSchema(d);
  const confirmations = createConfirmationStore();
  const hostCalls = [];
  let n = 0;
  const ctx = {
    getDb: () => d, logAudit: () => {}, getSetting: () => null, setSetting: () => {}, toolResult, uuidv4: () => `fwd-${(n += 1)}`, policy: POLICY, confirmations,
    runHostCapture: async (bin, args) => { hostCalls.push([bin, ...args]); return { status: 0, stdout: '', stderr: '' }; },
    runInContainer: async () => ({ status: 0, stdout: '', stderr: '' }), readContainerStartup: async () => null, agentCall: async () => { throw new Error('no agent'); }, publicBaseUrl: () => 'https://pp.test',
    LXC_PREFIX: 'pp-', LXC_NAME_REGEX: /^[a-zA-Z0-9][a-zA-Z0-9-]*$/, LXC_CMD_POLICY: LXC_POLICY, LXC_LIST_CAPTURE_CAP: 1 << 24,
    validLxcFilePath: (p) => p, validTargetDir: (p) => (String(p || '').startsWith('/') ? String(p) : null),
    takeLxcSnapshot: async () => { throw new Error('the config verbs never call takeLxcSnapshot'); }, fetchLxcInstance: async (nm) => { const i = state.instances.find((x) => x.name === nm); return i ? { instance: i } : { notFound: true }; },
    lxcContainerDetail, lxcReachableAddress: () => null,
    defaultSnapshotName: (dt, p = 'pp-mcp') => `${p}-20260926-120000`, validSnapshotName: (s) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(s || '')) ? String(s) : null), snapshotArgv: (v, i, s) => ['snapshot', v, i, s], resolveSnapshotCliForm: async () => 'subcommand',
    verifiedContainerWrite: async () => ({}), takeUploadTicket: async () => { throw new Error('no ticket'); },
    findOrCreateLxcService: (dbx, name, ip) => { const ex = dbx.prepare(`SELECT * FROM services WHERE lxc_container_name = ? AND is_admin = 0`).get(name); if (ex) return ex; dbx.prepare(`INSERT INTO services (id, name, target_ip, lxc_container_name) VALUES (?, ?, ?, ?)`).run(`svc-${name}`, name, ip, name); return dbx.prepare(`SELECT * FROM services WHERE id = ?`).get(`svc-${name}`); },
    syncLxcServiceUpstream: async () => ({}), regenerateDomainCaddyConfig: async () => {}, ensureCaddyStructure: async () => {},
    assertRoutesShareSslStance: () => {}, caddyAdapt: async () => {}, caddyReload: async () => {}, normalizePathPrefix: (v) => v || '/',
    validDomainName: (s) => s, normalizePort: (p) => Number(p) || null, validIpv4: (s) => s, ROUTE_SELECT: 'SELECT 1', routeView: (r) => r, certInfoForDomain: async () => ({}), recentErrorsForDomain: async () => null,
    caddyAccessLogPath: (x) => x, summarizeAccessLog: () => ({}), getStaticSite: () => null, staticSiteDomains: () => [], SERVICES_DATA_DIR: '/data/services', walkDocroot: async () => ({ files: [] }),
    mock2Enabled: () => true, mock2Modules: async () => ({}), projectContainerName: () => 'pp-x', requireActiveProject: () => ({ project: { id: 1, name: 'demo' } }),
    liveBuildGuard: () => null, commitProjectPaths: async () => ({}), readProjectText: async () => ({ error: 'x' }), M2_APP_DIR: '/srv/app', projectUrl: () => null, projectSummary: (p) => p,
    appendProjectChangeRecord: async () => ({ appended: true, seq: 1 }),
    selfUpdateInstalled: async () => ({ reachable: false }), selfUpdateStart: async () => { throw new Error('off'); }, selfUpdateStatus: async () => ({ status: 'idle' }), SELF_UPDATE_POLICY: { enabled: true },
    mintMcpToken: () => 'ppmcp_' + 'a'.repeat(64), hashMcpToken: (tk) => `h:${tk}`, MCP_TOOL_NAMES: () => MCP_TOOLS.map((x) => x.name), dbPath: '/tmp/pp.db', listBackupsRunning: null,
  };
  const ledger = () => d.prepare(`SELECT * FROM mcp_ledger ORDER BY id`).all();
  return { ctx, ledger, confirmations, hostCalls };
}
