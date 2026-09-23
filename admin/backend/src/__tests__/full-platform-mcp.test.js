// Platform Setup over MCP (routes/mcp-tools/platform.js + lib/setup-engine/
// full-platform-mcp.js / full-platform-reset.js), against the production
// stores on a real SQLite database (the full-platform fixture). The host is
// scripted: Docker is an in-memory inventory, archives are real tar files in
// a temp directory, Caddy rendering is a stub. Upstream Keycloak is the
// fixture's scripted wire.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeDb, approved, handle, keycloakWire } from './helpers/full-platform-fixture.js';
import { readFullPlatform } from '../lib/setup-engine/full-platform-store.js';
import { keycloakAdmin, reconcileOwnedIdentity, storeProtected, protectedValue } from '../lib/setup-engine/full-platform-keycloak.js';
import { runFullPlatformOperation } from '../lib/setup-engine/full-platform-op.js';
import { readVaultwarden, secrets as vaultSecrets } from '../lib/setup-engine/vaultwarden-store.js';
import { readOpenBao } from '../lib/setup-engine/openbao-store.js';
import { readInfisical } from '../lib/setup-engine/infisical-store.js';
import { readPomerium } from '../lib/setup-engine/pomerium-store.js';
import { verifyClient } from '../lib/setup-engine/vaultwarden-identity.js';
import { createJob, getJob, startJob, appendEvent } from '../lib/setup-engine/store.js';
import { removeResetRoutes, FIXED_PATH_SERVICES } from '../lib/setup-engine/full-platform-reset.js';
import { validateRunnerJob } from '../lib/setup-engine/logic.js';
import { BACKEND_STEP_KINDS } from '../lib/setup-engine/setup-logic.js';
import { resourceNames } from '../lib/setup-engine/keycloak-logic.js';
import { namesFor as infisicalNames } from '../lib/setup-engine/infisical-runtime.js';
import { namesFor as baoNames } from '../lib/setup-engine/openbao-logic.js';
import { namesFor as vaultNames } from '../lib/setup-engine/vaultwarden-logic.js';
import { POMERIUM_APP } from '../lib/setup-engine/pomerium-logic.js';
import { createToolkit } from '../routes/mcp-tools/common.js';
import { createPlatformHandlers } from '../routes/mcp-tools/platform.js';
import { createConfirmationStore, validateTokenScope, scopeRefusal, parseTokenScope } from '../lib/mcp-ext/logic.js';
import { MCP_EXT_TOOL_GROUPS, MCP_EXT_TOOLS } from '../lib/mcp-ext/catalog/index.js';

const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
const AUTH = { id: 7, created_by: 'admin', name: 'platform test key', scope_json: null };
const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
const body = (r) => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };
const text = (r) => r.content[0].text;
const terminal = (db, id, status = 'succeeded', verification = null) => db.prepare('UPDATE setup_jobs SET status=?,owner=NULL,verification_json=? WHERE id=?').run(status, verification ? JSON.stringify(verification) : null, id);

function tools(db, { now = () => Date.now(), flags = {}, host = null, resolvers = null } = {}) {
  // mcp.platform is off on a new install; these tests model an install where an
  // administrator turned it on (or migration 915 kept it on).
  const settings = new Map(Object.entries({ 'mcp.platform': true, ...flags }).map(([k, v]) => [`feature_flag:${k}`, v ? '1' : '0']));
  const ledger = [], audit = [];
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, token_id INTEGER, actor TEXT, tool TEXT NOT NULL, subject_type TEXT, subject_id TEXT, project_id INTEGER, args_json TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('ok','error','dry_run','refused','needs_confirmation')), dry_run INTEGER NOT NULL DEFAULT 0, confirmation_used INTEGER NOT NULL DEFAULT 0, snapshot TEXT, summary TEXT, detail_json TEXT, duration_ms INTEGER)`);
  const ctx = {
    getDb: () => db, logAudit: (...a) => audit.push(a), getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => settings.set(k, v),
    toolResult, policy: POLICY, confirmations: createConfirmationStore({ now }),
    runHostCapture: host || (async () => ({ status: 1, stdout: '', stderr: 'no host in this test' })),
    resolveHost: async (h) => (h.endsWith('example.com') ? ['203.0.113.10'] : []),
    // Host resolver and 1.1.1.1 both answer the Caddy host for example.com (3e).
    platformResolvers: resolvers || { host: async (h) => (h.endsWith('example.com') ? ['203.0.113.10'] : []), public: async (h) => (h.endsWith('example.com') ? ['203.0.113.10'] : []) },
  };
  const kit = createToolkit(ctx);
  const h = createPlatformHandlers(kit);
  const call = async (name, args = {}) => h[name](args, AUTH, null);
  return { h, call, ledger: () => db.prepare('SELECT * FROM mcp_ledger ORDER BY id').all(), audit, settings };
}

// The coordinator driven to its administrator handoff (as in full-platform.test.js).
async function connected(db) {
  const job = approved(db), k = db.prepare('SELECT * FROM setup_keycloak').get(), wire = keycloakWire(k);
  storeProtected(db, `keycloak-bootstrap-${k.id}`, { installationId: k.id, password: 'b'.repeat(43), retired: false });
  const identity = async (db, k, full, { job }) => { const admin = await keycloakAdmin(k, 'b'.repeat(43), { send: wire.send, job }); try { return await reconcileOwnedIdentity(db, k, full, admin.api, job); } finally { await admin.close(); } };
  startJob(db, { id: job.id, owner: 'runner@fp-mcp#1:a' });
  const args = { db, params: { revision: 1 }, job: handle(job.id), identity, interfaces: { test: [{ address: '10.20.30.40', internal: false }] }, dnsCheck: async () => null };
  for (let i = 0; i < 6; i++) {
    const result = await runFullPlatformOperation(args);
    for (const c of db.prepare("SELECT id,kind FROM setup_jobs WHERE id!=? AND status='queued'").all(job.id)) {
      terminal(db, c.id, 'succeeded', { state: 'awaiting_user_action', label: 'Scripted handoff pending' });
      if (c.kind === 'verify_sso') db.prepare('UPDATE sso_config SET verified_at=?,verified_json=?').run(new Date().toISOString(), JSON.stringify({ valid: true }));
    }
    if (!result.waiting) { terminal(db, job.id, 'succeeded', result.verification); return { job, k }; }
  }
  throw Error('Coordinator did not settle');
}
const withDb = async (fn) => { const db = makeDb(); try { await fn(db); } finally { db.close(); } };

/* ------------------------------ the observer ---------------------------- */

// The host's situation: the Vaultwarden record exists (prepared by the
// coordinator, or saved from Custom) and its apply ran with no G3 observer.
async function vaultwardenObserverFailure(db) {
  await connected(db);
  db.exec('DELETE FROM sso_config');
  const r = readVaultwarden(db);
  const message = await verifyClient(db, r).then(() => null, (e) => e.message);
  assert.equal(message, 'The existing read-only Keycloak observer for this provider is required.');
  const j = createJob(db, { app: 'pp-platform-vaultwarden', kind: 'vaultwarden_apply', plan: { params: { revision: r.revision } }, requestedBy: 'admin', via: 'ui', reason: 'queued' });
  db.prepare("UPDATE setup_jobs SET status='failed', phase='dedicated_keycloak_handoff', reason=?, verification_json=? WHERE id=?").run(message, JSON.stringify({ state: 'not_verified', failedAt: 'dedicated_keycloak_handoff' }), j.id);
  db.prepare('UPDATE setup_vaultwarden SET last_job_id=? WHERE id=1').run(j.id);
  return j;
}

test('get_platform_setup explains the Vaultwarden observer failure: job, reason code, plain reason, what creates the observer, and that MCP can do it', () => withDb(async (db) => {
  const j = await vaultwardenObserverFailure(db);
  const { call } = tools(db);
  const v = body(await call('get_platform_setup'));
  const f = v.failures.find((x) => x.scope === 'vaultwarden');
  assert.equal(f.job_id, j.id); assert.equal(f.job, 'vaultwarden_apply');
  assert.equal(f.reason_code, 'dedicated_keycloak_handoff');
  assert.equal(f.reason, 'The existing read-only Keycloak observer for this provider is required.');
  assert.equal(f.reason_class, 'observer_missing'); assert.equal(f.mcp_can_do, true); assert.equal(f.tool, 'continue_platform_setup');
  assert.match(f.remedy, /coordinator \(connect_managed_identity\)/);
  assert.equal(v.observer.present, false); assert.match(v.observer.created_by, /connect_managed_identity/);
  assert.equal(v.services.find((s) => s.id === 'vaultwarden').state, 'failed');
  assert.equal(v.steps.find((s) => s.step === 3).status, 'failed');
  const action = v.next_actions.find((a) => a.id === 'fix_vaultwarden');
  assert.ok(action.mcp_can_do); assert.equal(action.reason_code, 'dedicated_keycloak_handoff');
  // A human step is named with its dashboard place.
  const admin = v.next_actions.find((a) => a.id === 'administrator');
  assert.equal(admin.by, 'human'); assert.equal(admin.where.control, 'Create or resume permanent administrator');
  assert.ok(v.human_only.some((x) => x.where.control === 'Activate SSO'));
  // The shared plan drifting (a Custom save after apply) is diagnosed and routes to reset.
  db.prepare('UPDATE setup_platform_plan SET revision=revision+1').run();
  const drift = body(await call('get_platform_setup'));
  assert.equal(drift.shared_plan_in_sync, false);
  assert.equal(drift.failures.find((x) => x.scope === 'vaultwarden').tool, 'resync_platform_plan');
  assert.ok(drift.next_actions.some((a) => a.id === 'shared_plan_changed' && a.tool === 'resync_platform_plan'));
}));

test('retrying Vaultwarden is refused while the observer is missing; with it present the retry reuses the stored encrypted inputs', () => withDb(async (db) => {
  await vaultwardenObserverFailure(db);
  const { call } = tools(db);
  const s = body(await call('get_platform_setup'));
  const before = { ref: readVaultwarden(db).credential_ref, secrets: vaultSecrets(db, readVaultwarden(db)), rows: db.prepare('SELECT count(*) n FROM setup_vaultwarden_credentials').get().n };
  const refused = await call('continue_platform_setup', { revision: s.revision, review_digest: s.review_digest, service: 'vaultwarden', confirm: true });
  assert.ok(refused.isError); assert.equal(body(refused).code, 'OBSERVER_REQUIRED'); assert.match(text(refused), /dedicated_keycloak_handoff/);
  // Restore the observer the coordinator creates, then retry.
  const k = db.prepare('SELECT * FROM setup_keycloak').get();
  db.prepare("INSERT INTO sso_config(id,revision,config_json,fingerprint,created_by,created_at,verified_at) VALUES(1,1,?,?,'admin',?,?)").run(JSON.stringify({ connectionId: k.id, readerClientId: `pp-${k.id}-observer`, issuer: 'https://identity.example.com/realms/proxypilot' }), 'f'.repeat(64), new Date().toISOString(), new Date().toISOString());
  const noConfirm = await call('continue_platform_setup', { revision: s.revision, review_digest: s.review_digest, service: 'vaultwarden' });
  assert.ok(noConfirm.isError); assert.match(body(noConfirm), /confirm: true/);
  const ok = body(await call('continue_platform_setup', { revision: s.revision, review_digest: s.review_digest, service: 'vaultwarden', confirm: true }));
  assert.equal(ok.queued, true); assert.equal(ok.reused_stored_inputs, true);
  const job = getJob(db, ok.job.id);
  assert.equal(job.kind, 'vaultwarden_apply'); assert.equal(job.requested_by, 'mcp:7');
  assert.deepEqual({ ref: readVaultwarden(db).credential_ref, secrets: vaultSecrets(db, readVaultwarden(db)), rows: db.prepare('SELECT count(*) n FROM setup_vaultwarden_credentials').get().n }, before);
  const again = await call('continue_platform_setup', { revision: s.revision, review_digest: s.review_digest, service: 'vaultwarden', confirm: true });
  assert.ok(again.isError); assert.equal(body(again).code, 'OPERATION_RUNNING');
}));

/* ---------------------------------- save -------------------------------- */

test('save_platform_setup is inert, CAS on if_revision, dry_run writes nothing, and refuses what the dashboard refuses with its messages', () => withDb(async (db) => {
  const { call, ledger, audit } = tools(db);
  const empty = body(await call('get_platform_setup'));
  assert.equal(empty.saved, false); assert.equal(empty.next_actions[0].tool, 'save_platform_setup');
  const jobs = () => db.prepare('SELECT count(*) n FROM setup_jobs').get().n, n = jobs();
  const dry = body(await call('save_platform_setup', { if_revision: 0, domains: { recovery: 'https://recovery.example.com', keycloak: 'https://identity.example.com', pomerium: 'https://access.example.com', infisical: 'https://secrets.example.com', openbao: 'https://bao.example.com', vaultwarden: 'https://vault.example.com' }, restricted_networks: ['10.20.30.0/24'], dry_run: true }));
  assert.equal(dry.dry_run, true); assert.equal(dry.next_revision, 1); assert.equal(readFullPlatform(db), null);
  const bad = await call('save_platform_setup', { if_revision: 0, restricted_networks: ['0.0.0.0/0'] });
  assert.ok(bad.isError); assert.match(text(bad), /Use restricted administrator\/VPN networks; unrestricted access is refused\./);
  const moved = await call('save_platform_setup', { if_revision: 0, domains: { proxypilot: 'https://elsewhere.example.com', recovery: 'https://recovery.example.com', keycloak: 'https://identity.example.com', pomerium: 'https://access.example.com', infisical: 'https://secrets.example.com', openbao: 'https://bao.example.com', vaultwarden: 'https://vault.example.com' }, restricted_networks: ['10.20.30.0/24'] });
  assert.ok(moved.isError); assert.match(text(moved), /ProxyPilot must use its current administrator hostname/);
  const saved = body(await call('save_platform_setup', { if_revision: 0, domains: { recovery: 'https://recovery.example.com', keycloak: 'https://identity.example.com', pomerium: 'https://access.example.com', infisical: 'https://secrets.example.com', openbao: 'https://bao.example.com', vaultwarden: 'https://vault.example.com' }, restricted_networks: ['10.20.30.0/24'] }));
  assert.equal(saved.revision, 1); assert.match(saved.review_digest, /^[a-f0-9]{64}$/); assert.equal(jobs(), n, 'save queues nothing');
  assert.equal(readFullPlatform(db).created_by, 'admin', 'the plan names the key owner, so the dashboard handoff stays available to them');
  const stale = await call('save_platform_setup', { if_revision: 0, realm: 'other' });
  assert.ok(stale.isError); assert.match(text(stale), /Setup changed in another session\. Reopen the saved plan\./);
  assert.ok(ledger().some((r) => r.tool === 'save_platform_setup' && r.outcome === 'refused'));
  assert.ok(audit.some((a) => a[1] === 'FULL_PLATFORM_PLAN_SAVED'));
}));

/* ----------------------------- apply / continue ------------------------- */

test('apply_platform_setup: confirm, stale revision, stale digest, running operation and already-applied refusals; queues with mcp attribution', () => withDb(async (db) => {
  const { call } = tools(db);
  await call('save_platform_setup', { if_revision: 0, domains: { recovery: 'https://recovery.example.com', keycloak: 'https://identity.example.com', pomerium: 'https://access.example.com', infisical: 'https://secrets.example.com', openbao: 'https://bao.example.com', vaultwarden: 'https://vault.example.com' }, restricted_networks: ['10.20.30.0/24'] });
  const s = body(await call('get_platform_setup'));
  assert.equal(s.next_actions[0].tool, 'apply_platform_setup');
  assert.match(body(await call('apply_platform_setup', { revision: s.revision, review_digest: s.review_digest })), /confirm: true/);
  assert.equal(body(await call('apply_platform_setup', { revision: s.revision + 1, review_digest: s.review_digest, confirm: true })).code, 'STALE_REVISION');
  assert.equal(body(await call('apply_platform_setup', { revision: s.revision, review_digest: 'a'.repeat(64), confirm: true })).code, 'STALE_REVIEW');
  const dry = body(await call('apply_platform_setup', { revision: s.revision, review_digest: s.review_digest, dry_run: true, confirm: true }));
  assert.equal(dry.dry_run, true); assert.equal(readFullPlatform(db).approved_revision, null);
  const r = body(await call('apply_platform_setup', { revision: s.revision, review_digest: s.review_digest, confirm: true }));
  assert.equal(r.queued, true); assert.equal(getJob(db, r.operation.id).requested_by, 'mcp:7'); assert.equal(getJob(db, r.operation.id).via, 'mcp');
  assert.equal(body(await call('continue_platform_setup', { revision: s.revision, review_digest: s.review_digest, confirm: true })).code, 'OPERATION_RUNNING');
  const waiting = body(await call('get_platform_setup'));
  assert.equal(waiting.next_actions[0].id, 'wait'); assert.equal(waiting.next_actions[0].args.id, r.operation.id);
  terminal(db, r.operation.id, 'failed');
  assert.equal(body(await call('apply_platform_setup', { revision: s.revision, review_digest: s.review_digest, confirm: true })).code, 'ALREADY_APPLIED');
}));

test('continue_platform_setup refuses when the next step needs a human and names it', () => withDb(async (db) => {
  await connected(db);
  const { call } = tools(db);
  const s = body(await call('get_platform_setup'));
  assert.equal(s.failures.length, 0);
  const r = await call('continue_platform_setup', { revision: s.revision, review_digest: s.review_digest, confirm: true });
  assert.ok(r.isError); const b = body(r);
  assert.equal(b.code, 'HUMAN_STEP_REQUIRED');
  assert.equal(b.next_action.by, 'human'); assert.ok(b.next_action.where.page === 'Platform Setup' && b.next_action.where.control);
  // continue on a never-applied revision points to apply
  db.prepare('UPDATE setup_full_platform SET approved_revision=NULL').run();
  assert.equal(body(await call('continue_platform_setup', { revision: s.revision, review_digest: s.review_digest, confirm: true })).code, 'NOT_APPLIED');
}));

/* ---------------------------- runtime actions --------------------------- */

test('manage_platform_service: preview + single-use token bound to the review, expiry, flag gate, external and dependency refusals', () => withDb(async (db) => {
  await connected(db);
  let t = Date.now();
  const { call, settings } = tools(db, { now: () => t });
  const first = body(await call('manage_platform_service', { service: 'openbao', action: 'remove' }));
  assert.equal(first.needs_confirmation, true); assert.ok(first.preview.containers.length); assert.match(first.confirmation_token, /^ppconf_/);
  assert.ok(first.preview.effects.some((e) => /retained/.test(e)));
  // Bound to the exact target: not usable for another service/action.
  const wrong = await call('manage_platform_service', { service: 'openbao', action: 'reinstall', confirmation_token: first.confirmation_token });
  assert.ok(wrong.isError); assert.match(body(wrong), /different target/);
  // Burned by the wrong-target attempt: single use.
  const burned = await call('manage_platform_service', { service: 'openbao', action: 'remove', confirmation_token: first.confirmation_token });
  assert.ok(burned.isError); assert.match(body(burned), /unknown, already used, or expired/);
  // Expiry.
  const second = body(await call('manage_platform_service', { service: 'openbao', action: 'remove' }));
  t += 11 * 60 * 1000;
  assert.match(body(await call('manage_platform_service', { service: 'openbao', action: 'remove', confirmation_token: second.confirmation_token })), /expired/);
  // Valid token queues the dashboard's lifecycle job; replay refused.
  const third = body(await call('manage_platform_service', { service: 'openbao', action: 'remove' }));
  const queued = body(await call('manage_platform_service', { service: 'openbao', action: 'remove', confirmation_token: third.confirmation_token }));
  assert.equal(queued.queued, true);
  const job = getJob(db, queued.job.id); assert.equal(job.requested_by, 'mcp:7'); assert.equal(JSON.parse(job.plan_json).params.operation, 'lifecycle');
  assert.deepEqual(readFullPlatform(db).state.lifecycle.service, 'openbao');
  terminal(db, queued.job.id);
  assert.match(text(await call('manage_platform_service', { service: 'openbao', action: 'remove', confirmation_token: third.confirmation_token })), /already used|unknown/);
  // Dependents block, exactly as in the dashboard.
  const dep = await call('manage_platform_service', { service: 'keycloak', action: 'remove' });
  assert.ok(dep.isError); assert.match(text(dep), /depends on this identity provider|depends on this Keycloak/);
  // External refused.
  db.prepare("UPDATE setup_keycloak SET ownership='external'").run();
  const ext = await call('manage_platform_service', { service: 'keycloak', action: 'repair' });
  assert.ok(ext.isError); assert.match(text(ext), /External connections do not authorize/);
  db.prepare("UPDATE setup_keycloak SET ownership='managed'").run();
  // mcp.destructive off refuses before any token.
  settings.set('feature_flag:mcp.destructive', '0');
  const off = await call('manage_platform_service', { service: 'openbao', action: 'repair' });
  assert.ok(off.isError); assert.match(body(off), /mcp\.destructive/);
  settings.set('feature_flag:mcp.platform', '0');
  assert.match(body(await call('get_platform_setup')), /mcp\.platform/);
}));

/* --------------------------------- reset -------------------------------- */

// A scripted Docker host holding every owned resource with its ownership
// label, plus owned directories with their markers. tar is real.
function scriptedHost(db, dir) {
  const k = db.prepare("SELECT * FROM setup_keycloak WHERE ownership='managed'").get();
  const rows = { keycloak: k, pomerium: readPomerium(db), infisical: readInfisical(db), openbao: readOpenBao(db), vaultwarden: readVaultwarden(db) };
  const ref = (s) => (s === 'keycloak' ? k.id : rows[s].credential_ref);
  const roots = {}, containers = new Map(), volumes = new Map(), networks = new Map(), calls = [];
  const write = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  for (const s of Object.keys(rows)) {
    roots[s] = join(dir, 'roots', s); mkdirSync(roots[s], { recursive: true, mode: 0o700 });
    const origin = s === 'keycloak' ? k.origin : rows[s].config.origin;
    if (s === 'keycloak') write(join(roots[s], 'owner.json'), { id: k.id, origin, realm: k.realm });
    else if (s === 'infisical') write(join(roots[s], 'protected.json'), { identity: { origin, ref: ref(s) } });
    else write(join(roots[s], 'owner.json'), { ref: ref(s), origin, attempted: [] });
    writeFileSync(join(roots[s], 'sentinel'), `data-of-${s}`);
  }
  mkdirSync(join(roots.vaultwarden, 'data'), { mode: 0o700 }); writeFileSync(join(roots.vaultwarden, 'data', 'db.sqlite3'), 'vault-sqlite');
  const label = (s) => ({ [`io.proxypilot.${s}`]: ref(s) });
  const addVolume = (s, name) => { const mp = join(dir, 'volumes', name); mkdirSync(mp, { recursive: true }); writeFileSync(join(mp, 'PG_VERSION'), `volume ${name}`); volumes.set(name, { Name: name, Labels: label(s), Mountpoint: mp }); };
  const n = { keycloak: resourceNames(k.id), infisical: infisicalNames(rows.infisical), openbao: baoNames(rows.openbao), vaultwarden: vaultNames(rows.vaultwarden) };
  addVolume('keycloak', n.keycloak.volume); for (const v of ['databaseVolume', 'redisVolume', 'proxyVolume']) addVolume('infisical', n.infisical[v]); addVolume('openbao', n.openbao.volume); addVolume('openbao', n.openbao.logs);
  for (const [s, names] of [['keycloak', [n.keycloak.network]], ['infisical', [n.infisical.network, n.infisical.proxyNetwork]], ['openbao', [n.openbao.network]], ['vaultwarden', [n.vaultwarden.network]]]) for (const name of names) networks.set(name, { Name: name, Labels: label(s) });
  const mounts = (s, name) => s === 'keycloak' && name === n.keycloak.database ? [{ Type: 'volume', Name: n.keycloak.volume, Destination: '/var/lib/postgresql/data', RW: true }]
    : s === 'infisical' ? (name === n.infisical.database ? [{ Type: 'volume', Name: n.infisical.databaseVolume, Destination: '/var/lib/postgresql/data', RW: true }] : name === n.infisical.redis ? [{ Type: 'volume', Name: n.infisical.redisVolume, Destination: '/data', RW: true }] : name === n.infisical.proxy ? [{ Type: 'volume', Name: n.infisical.proxyVolume, Destination: '/root/.infisical', RW: true }] : [])
      : s === 'openbao' ? [{ Type: 'volume', Name: n.openbao.volume, Destination: '/openbao/file', RW: true }, { Type: 'volume', Name: n.openbao.logs, Destination: '/openbao/logs', RW: true }]
        : s === 'vaultwarden' ? [{ Type: 'bind', Source: join(roots.vaultwarden, 'data'), Destination: '/data', RW: true }] : [];
  let seq = 0;
  const addContainer = (s, name) => containers.set(name, { Id: `id-${++seq}-${name}`, Name: `/${name}`, Config: { Labels: label(s), Image: 'img', Env: ['SECRET=must-not-leak'] }, State: { Running: true, Status: 'running' }, Mounts: mounts(s, name) });
  for (const name of [n.keycloak.server, n.keycloak.database]) addContainer('keycloak', name);
  addContainer('pomerium', POMERIUM_APP);
  for (const name of [n.infisical.proxy, n.infisical.server, n.infisical.redis, n.infisical.database]) addContainer('infisical', name);
  addContainer('openbao', n.openbao.server); addContainer('vaultwarden', n.vaultwarden.server);
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const exec = { host: async (argv) => {
    calls.push(argv);
    if (argv[0] === 'tar') { const r = spawnSync('tar', argv.slice(1)); return { code: r.status, stdout: String(r.stdout), stderr: '' }; }
    const [, a, b, ...rest] = argv;
    if (a === 'container' && b === 'ls') return ok([...containers.keys()].join('\n') + '\n');
    if (a === 'container' && b === 'inspect') return ok(JSON.stringify([containers.get(rest[0])].filter(Boolean)));
    const byId = (id) => [...containers.entries()].find(([, c]) => c.Id === id);
    if (a === 'stop') { byId(rest[rest.length - 1] ?? b)?.[1] && (byId(argv[argv.length - 1])[1].State.Running = false); return ok(); }
    if (a === 'rm') { const e = byId(b); if (e) containers.delete(e[0]); return ok(); }
    for (const [kind, map] of [['volume', volumes], ['network', networks]]) {
      if (a !== kind) continue;
      if (b === 'ls') return ok([...map.keys()].join('\n') + '\n');
      if (b === 'inspect') return ok(JSON.stringify([map.get(rest[0])].filter(Boolean)));
      if (b === 'rm') { map.delete(rest[0]); return ok(); }
    }
    throw Error(`unscripted host call ${argv.join(' ')}`);
  } };
  return { exec, roots, containers, volumes, networks, calls, names: n };
}

// Owned route rows as the adapters write them.
function ownedRoutes(db) {
  const k = db.prepare("SELECT * FROM setup_keycloak WHERE ownership='managed'").get();
  const rows = [['keycloak', k.id, 'identity.example.com', 18080], ['vaultwarden', readVaultwarden(db).credential_ref, 'vault.example.com', 18380], ['openbao', readOpenBao(db).credential_ref, 'bao.example.com', 18200], ['infisical', readInfisical(db).credential_ref, 'secrets.example.com', 18085]];
  for (const [s, ref, domain, port] of rows) {
    db.prepare("INSERT INTO services (id, name, kind, runtime, target_ip, type, status) VALUES (?, ?, 'container_service', 'docker', '127.0.0.1', 'proxy', 'active')").run(`${s}-${ref}`, `pp-platform-${s}`);
    db.prepare("INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size, strip_prefix) VALUES (?, ?, ?, '/', ?, 1, 1, 1, '1G', 0)").run(`${s}-route-${ref}`, `${s}-${ref}`, domain, port);
  }
}

async function runResetToEnd(db, jobId, host, exportsDir) {
  startJob(db, { id: jobId, owner: 'runner@fp-reset#1:a' });
  const deps = { db, params: { revision: readFullPlatform(db).revision, operation: 'reset' }, exec: host.exec, job: handle(jobId), resetDeps: { roots: host.roots, exportsDir } };
  const first = await runFullPlatformOperation(deps);
  if (!first.waiting) return first;
  const child = db.prepare("SELECT * FROM setup_jobs WHERE kind='remove_platform_routes'").get();
  assert.equal(child.app, 'pp-platform-reset-routes');
  const rendered = [];
  const render = { regenerate: async (_db, d) => rendered.push(d), adapt: async () => {}, reload: async () => {}, caddyFilePath: (d) => join(exportsDir, `${d}.caddy`), writeConfig: async () => {}, removeConfig: async () => {} };
  const r = await removeResetRoutes(db, { resetJob: jobId, fence() {}, render });
  assert.deepEqual(r.rendered.sort(), rendered.sort());
  terminal(db, child.id);
  return runFullPlatformOperation(deps);
}

test('reset (default): owned containers and routes go, records are discarded, data/volumes/networks/credentials stay, step 1 starts clean', () => withDb(async (db) => {
  await connected(db); ownedRoutes(db);
  const dir = mkdtempSync(join(tmpdir(), 'fp-reset-')), host = scriptedHost(db, dir);
  try {
    const { call } = tools(db);
    const first = body(await call('reset_platform_setup', {}));
    assert.equal(first.needs_confirmation, true, JSON.stringify(first));
    const p = first.preview;
    assert.equal(p.purge_data, false);
    assert.equal(p.remove.containers.length, 9);
    assert.deepEqual(p.remove.routes.map((r) => r.hostname).sort(), ['bao.example.com', 'identity.example.com', 'secrets.example.com', 'vault.example.com']);
    for (const t of ['setup_full_platform', 'setup_platform_plan', 'setup_keycloak', 'setup_vaultwarden', 'sso_config', 'setup_jobs']) assert.ok(p.remove.records.some((r) => r.table === t && r.rows > 0), t);
    assert.ok(!p.remove.directories && !p.remove.volumes, 'default mode deletes no data');
    assert.ok(p.retain.directories.length === 5 && p.retain.volumes.length === 6);
    const queued = body(await call('reset_platform_setup', { confirmation_token: first.confirmation_token }));
    assert.equal(queued.queued, true);
    const credentialRows = ['setup_full_credentials', 'setup_vaultwarden_credentials', 'setup_openbao_credentials', 'setup_infisical_credentials', 'setup_pomerium_credentials'].map((t) => db.prepare(`SELECT count(*) n FROM ${t}`).get().n);
    const result = await runResetToEnd(db, queued.job.id, host, join(dir, 'exports'));
    assert.equal(result.verification.state, 'platform_reset');
    assert.equal(host.containers.size, 0);
    assert.equal(host.volumes.size, 6); assert.equal(host.networks.size, 5);
    // 3i: fixed-path data is moved aside to a dated sibling (nothing deleted),
    // so a later managed install starts clean; Keycloak's per-installation
    // directory stays where it is.
    for (const [service, root] of Object.entries(host.roots)) {
      const aside = result.verification.moved?.[service];
      if (FIXED_PATH_SERVICES.includes(service)) { assert.ok(aside && aside.startsWith(`${root}.retained-`), `${service} moved aside`); assert.ok(existsSync(join(aside, 'sentinel'))); assert.ok(!existsSync(root)); }
      else assert.ok(existsSync(join(root, 'sentinel')));
    }
    assert.ok(!host.calls.some((c) => c.includes('--volumes') || (c[1] === 'volume' && c[2] === 'rm')));
    assert.deepEqual(db.prepare('SELECT id FROM service_http_routes').all().map((r) => r.id), ['test-route']);
    assert.equal(readFullPlatform(db), null); assert.equal(readVaultwarden(db), null); assert.equal(db.prepare('SELECT count(*) n FROM sso_config').get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM setup_keycloak WHERE ownership='managed'").get().n, 0);
    assert.deepEqual(['setup_full_credentials', 'setup_vaultwarden_credentials', 'setup_openbao_credentials', 'setup_infisical_credentials', 'setup_pomerium_credentials'].map((t) => db.prepare(`SELECT count(*) n FROM ${t}`).get().n), credentialRows);
    assert.equal(getJob(db, queued.job.id).id, queued.job.id, 'the reset job is kept as the record');
    const after = body(await call('get_platform_setup'));
    assert.equal(after.saved, false); assert.equal(after.steps[0].status, 'pending'); assert.equal(after.next_actions[0].tool, 'save_platform_setup');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('reset purge_data: flag-gated (off by default); a verified backup set is written before owned data, volumes, networks and credentials are deleted', () => withDb(async (db) => {
  await connected(db); ownedRoutes(db);
  const dir = mkdtempSync(join(tmpdir(), 'fp-purge-')), host = scriptedHost(db, dir), exportsDir = join(dir, 'exports');
  try {
    const { call, settings } = tools(db);
    const off = await call('reset_platform_setup', { purge_data: true });
    assert.ok(off.isError); assert.match(body(off), /mcp\.platform\.purge/);
    settings.set('feature_flag:mcp.platform.purge', '1');
    const first = body(await call('reset_platform_setup', { purge_data: true }));
    const p = first.preview;
    assert.equal(p.remove.directories.length, 5); assert.equal(p.remove.volumes.length, 6); assert.equal(p.remove.networks.length, 6); // Infisical: data, edge, proxy
    assert.ok(p.remove.records.some((r) => r.table === 'setup_vaultwarden_credentials'));
    assert.match(p.backup.directory, /platform-reset-<job id>$/);
    // A default-mode token cannot confirm a purge (different subject), and vice versa.
    const keep = body(await call('reset_platform_setup', {}));
    assert.match(body(await call('reset_platform_setup', { purge_data: true, confirmation_token: keep.confirmation_token })), /different target/);
    const queued = body(await call('reset_platform_setup', { purge_data: true, confirmation_token: first.confirmation_token }));
    const result = await runResetToEnd(db, queued.job.id, host, exportsDir);
    assert.equal(result.verification.state, 'platform_reset'); assert.equal(result.verification.purgeData, true);
    const backup = join(exportsDir, `platform-reset-${queued.job.id}`);
    const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'));
    assert.ok(manifest.files.some((f) => f.name === 'vaultwarden-files.tar.gz'));
    assert.equal(manifest.files.filter((f) => f.source.startsWith('volume:')).length, 6);
    const listed = spawnSync('tar', ['-tzf', join(backup, 'vaultwarden-files.tar.gz')]).stdout.toString();
    assert.match(listed, /data\/db\.sqlite3/); assert.match(listed, /owner\.json/);
    const records = JSON.parse(readFileSync(join(backup, 'proxypilot-records.json'), 'utf8')).records;
    assert.ok(records.setup_vaultwarden.length === 1 && records.setup_vaultwarden_credentials[0].value.startsWith('enc:'), 'protected values stay ciphertext in the backup');
    for (const root of Object.values(host.roots)) assert.ok(!existsSync(root));
    assert.equal(host.volumes.size, 0); assert.equal(host.networks.size, 0); assert.equal(host.containers.size, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM setup_vaultwarden_credentials').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM setup_full_credentials').get().n, 0);
    // Stop happened before the backup, the backup before the first removal.
    const firstTar = host.calls.findIndex((c) => c[0] === 'tar'), firstRm = host.calls.findIndex((c) => c[1] === 'rm' || c[2] === 'rm');
    const lastStop = host.calls.map((c, i) => (c[1] === 'stop' ? i : -1)).reduce((a, b) => Math.max(a, b));
    assert.ok(lastStop < firstTar && firstTar < firstRm);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('reset refuses foreign ownership (nothing removed), active SSO, a running operation, and leaves external services untouched', () => withDb(async (db) => {
  await connected(db);
  const dir = mkdtempSync(join(tmpdir(), 'fp-reset-refuse-')), host = scriptedHost(db, dir);
  try {
    const { call } = tools(db);
    // A container with a foreign label: the runner refuses before any change.
    const name = host.names.vaultwarden.server;
    host.containers.get(name).Config.Labels = { 'io.proxypilot.vaultwarden': 'someone-else' };
    const first = body(await call('reset_platform_setup', {}));
    const queued = body(await call('reset_platform_setup', { confirmation_token: first.confirmation_token }));
    startJob(db, { id: queued.job.id, owner: 'runner@fp-reset#1:a' });
    await assert.rejects(runFullPlatformOperation({ db, params: { revision: 1, operation: 'reset' }, exec: host.exec, job: handle(queued.job.id), resetDeps: { roots: host.roots, exportsDir: join(dir, 'x') } }), /another installation/);
    assert.ok(!host.calls.some((c) => ['stop', 'rm'].includes(c[1])), 'nothing stopped or removed');
    assert.ok(readFullPlatform(db));
    terminal(db, queued.job.id, 'failed');
    // Active SSO.
    db.prepare('UPDATE sso_config SET active=1').run();
    const sso = await call('reset_platform_setup', {});
    assert.ok(sso.isError); assert.match(text(sso), /SSO is active/);
    db.prepare('UPDATE sso_config SET active=0').run();
    // A running operation.
    const running = createJob(db, { app: 'pp-platform-openbao', kind: 'openbao_apply', plan: { params: { revision: 1 } } });
    assert.match(text(await call('reset_platform_setup', {})), /is queued/);
    terminal(db, running.id);
    // External services are excluded and left untouched.
    const pom = readPomerium(db); db.prepare('UPDATE setup_pomerium SET config_json=? WHERE id=1').run(JSON.stringify({ ...pom.config, mode: 'connect' }));
    const ext = body(await call('reset_platform_setup', { dry_run: true }));
    assert.deepEqual(ext.preview.external_left_untouched.map((e) => e.service), ['pomerium']);
    assert.ok(!ext.preview.remove.containers.some((c) => c.service === 'pomerium'));
    assert.ok(!ext.preview.remove.records.some((r) => r.table === 'setup_pomerium'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

/* ------------------------------- redaction ------------------------------ */

test('no secret, credential, password or key material appears in any platform tool output', () => withDb(async (db) => {
  await vaultwardenObserverFailure(db);
  const r = readVaultwarden(db), vault = vaultSecrets(db, r), bootstrap = protectedValue(db, `keycloak-bootstrap-${db.prepare('SELECT id FROM setup_keycloak').get().id}`).password;
  // A job event that recorded a protected value verbatim (a defect elsewhere) still does not leave via MCP.
  const job = r.last_job_id;
  db.prepare("INSERT INTO setup_job_events (job_id, at, kind, message, data_json) VALUES (?, ?, 'step', ?, ?)").run(job, new Date().toISOString(), `client secret was ${vault.client}`, JSON.stringify({ note: vault.admin, password: bootstrap }));
  appendEvent(db, { jobId: job, kind: 'step', message: 'TOTP_ENCRYPTION_KEY=abcdef0123 and token enc:v1:aa:bb:cc', data: { clientSecret: 'x'.repeat(30) } });
  storeProtected(db, 'test-private-key', { key: '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----' });
  const secrets = [vault.client, vault.admin, bootstrap, 'MIIBVgIBADANBgkqhkiG9w0BAQEFAASC', 'x'.repeat(30), 'abcdef0123'];
  for (const row of db.prepare('SELECT value FROM setup_full_credentials').all()) assert.ok(row.value.startsWith('enc:'));
  const docker = async (bin, args) => (args[0] === 'container' && args[1] === 'ls' ? { status: 0, stdout: `${vaultNames(r).server}\n` } : { status: 0, stdout: JSON.stringify([{ Id: 'abc', Name: `/${vaultNames(r).server}`, Config: { Image: 'vaultwarden/server:1.37.3', Labels: { 'io.proxypilot.vaultwarden': r.credential_ref }, Env: [`ADMIN_TOKEN=${vault.admin}`] }, State: { Running: true, Status: 'running' } }]) });
  const { call } = tools(db, { host: docker });
  const outputs = [
    await call('get_platform_setup'), await call('list_platform_jobs', {}), await call('get_platform_job', { id: job, tail: 500 }), await call('platform_preflight'),
    ...await Promise.all(['keycloak', 'pomerium', 'infisical', 'openbao', 'vaultwarden'].map((service) => call('get_platform_service', { service }))),
    await call('manage_platform_service', { service: 'vaultwarden', action: 'remove', dry_run: true }), await call('reset_platform_setup', { dry_run: true }),
  ];
  const detail = body(outputs[2]);
  assert.ok(detail.events.length >= 3);
  for (const out of outputs) {
    const text = out.content[0].text;
    for (const s of secrets) assert.ok(!text.includes(s), `a secret leaked into ${text.slice(0, 80)}`);
    assert.doesNotMatch(text, /enc:v1:|BEGIN [A-Z ]*PRIVATE KEY|ADMIN_TOKEN/);
  }
  const vw = body(outputs[4 + 4]);
  assert.equal(vw.containers[0].image, 'vaultwarden/server:1.37.3'); assert.equal(vw.containers[0].owned_label, true);
}));

/* ---------------------------- the human boundary ------------------------- */

test('human-only actions have no MCP tool; platform tools take no secret input; scoped keys and job validation know the family', () => {
  const names = MCP_EXT_TOOL_GROUPS.platform.map((t) => t.name);
  assert.deepEqual(names.sort(), ['apply_platform_setup', 'continue_platform_setup', 'control_platform_container', 'get_platform_job', 'get_platform_service', 'get_platform_service_logs', 'get_platform_setup', 'list_platform_jobs', 'manage_platform_service', 'platform_preflight', 'recover_keycloak_bootstrap', 'reset_platform_setup', 'resync_platform_plan', 'save_platform_setup', 'set_platform_restricted_networks', 'verify_platform_service']);
  // recover_keycloak_bootstrap is the one reviewed exception: it generates its
  // own credential and takes none (the property check below covers that).
  for (const t of MCP_EXT_TOOLS) if (t.name !== 'recover_keycloak_bootstrap') assert.doesNotMatch(t.name, /reveal|bootstrap|activate_sso|unseal|keycloak_admin|retire/, `${t.name} must not exist`);
  for (const t of MCP_EXT_TOOL_GROUPS.platform) {
    for (const prop of Object.keys(t.inputSchema.properties)) assert.doesNotMatch(prop, /password|secret|otp|share|pgp|root|admin_token|client_secret|^token$/i, `${t.name}.${prop}`);
  }
  assert.deepEqual(POLICY.platform.tools.sort(), names.sort());
  assert.equal(POLICY.feature_flags['mcp.platform.purge'].default, false);
  // Scoped keys: the family can be granted tool by tool.
  const v = validateTokenScope({ tools: ['get_platform_setup', 'get_platform_job'] }, { knownTools: MCP_EXT_TOOLS.map((t) => t.name) });
  assert.ok(v.scope);
  assert.equal(scopeRefusal(parseTokenScope(v.scope), 'get_platform_setup'), null);
  assert.match(scopeRefusal(parseTokenScope(v.scope), 'reset_platform_setup'), /not on its allowlist/);
  // The runner accepts the reset operation and the backend step kind exists.
  assert.ok(validateRunnerJob({ kind: 'full_platform_apply', app: 'pp-full-platform', plan: { params: { revision: 1, operation: 'reset' } } }).ok);
  assert.ok(BACKEND_STEP_KINDS.includes('remove_platform_routes'));
});

/* ------------------------- dashboard + regression ----------------------- */

test('dashboard reset (Custom / Advanced): preview is inert; the reset needs admin, CSRF, sudo and fresh local proof', () => withDb(async (db) => {
  await connected(db);
  const { apiFixture } = await import('./helpers/full-platform-fixture.js');
  const f = await apiFixture(db);
  try {
    const n = db.prepare('SELECT count(*) n FROM setup_jobs').get().n;
    const preview = await f.request('/full/reset/review', { method: 'POST', body: { purgeData: true } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.remove.directories.length && preview.body.backup);
    assert.equal(db.prepare('SELECT count(*) n FROM setup_jobs').get().n, n, 'the preview queues nothing');
    const input = { revision: 1, reviewToken: preview.body.reviewToken, purgeData: true, reviewed: true };
    for (const who of [null, 'user']) assert.ok([401, 403].includes((await f.request('/full/reset', { method: 'POST', who, body: input })).status));
    assert.equal((await f.request('/full/reset', { method: 'POST', body: input, csrf: false })).status, 403);
    const stale = await f.request('/full/reset', { method: 'POST', body: input });
    assert.equal(stale.status, 403); assert.equal(stale.body.sudo_required, true, 'sudo alone is not fresh local proof');
    const session = db.prepare("SELECT id FROM sessions WHERE user_id='admin' AND sudo_until IS NOT NULL").get();
    db.prepare("INSERT INTO sso_session_context(session_id,user_id,origin,method,authenticated_at,local_proof_at) VALUES (?,'admin',?,'local',?,?)").run(session.id, f.url.replace('http:', 'https:'), Date.now(), Date.now() - 301000);
    assert.equal((await f.request('/full/reset', { method: 'POST', body: input })).status, 403, 'proof older than five minutes');
    db.prepare('UPDATE sso_session_context SET local_proof_at=?').run(Date.now());
    const wrong = await f.request('/full/reset', { method: 'POST', body: { ...input, reviewToken: 'a'.repeat(64) } });
    assert.equal(wrong.status, 409); assert.match(wrong.body.error, /preview changed/);
    const ok = await f.request('/full/reset', { method: 'POST', body: input });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.equal(JSON.parse(getJob(db, ok.body.job.id).plan_json).params.operation, 'reset');
    assert.equal(readFullPlatform(db).state.reset.purgeData, true);
  } finally { await f.close(); }
}));

test('regression: runtime actions resolve non-Keycloak roots without the integer row id (production path had no roots override)', async () => {
  const { ownedRoot } = await import('../lib/setup-engine/full-platform-lifecycle.js');
  assert.equal(ownedRoot('openbao', { id: 1, credential_ref: 'openbao-x' }), '/var/lib/proxypilot/openbao');
  assert.equal(ownedRoot('vaultwarden', { id: 1 }), '/var/lib/proxypilot/vaultwarden');
  assert.equal(ownedRoot('keycloak', { id: 'kc-aabbccddeeff' }), '/var/lib/proxypilot/keycloak/kc-aabbccddeeff');
});
