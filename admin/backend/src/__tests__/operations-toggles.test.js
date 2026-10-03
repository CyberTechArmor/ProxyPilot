import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { operationsFixture, fixtureRouter } from './helpers/operations-fixture.js';
import { effectiveToggles, setOperationsToggle, storedToggles, toggleState } from '../lib/operations-toggles.js';
import { createOperationsSettingsRouter } from '../routes/operations-settings.js';
import { createOperationsRouter } from '../routes/operational-projects.js';

function world() {
  const f = operationsFixture();
  f.db.exec(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, resource_type TEXT,
    resource_id TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  return { f, admin: f.addUser('admin'), user: f.addUser('user') };
}
const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });
const requireSudo = (req, res, next) => req.sudo === true ? next()
  : res.status(401).json({ error: 'sudo_required', sudo_required: true });

test('toggles are off until an administrator turns them on, each after the ones it requires', () => {
  const { f, admin, user } = world();
  assert.deepEqual(storedToggles(f.db), { operations: false, agents_metadata: false, agent_runs: false });
  assert.deepEqual(effectiveToggles(f.db), { operations: false, agents_metadata: false, agent_runs: false });
  // The role is read from the database, not taken from the caller's claim.
  assert.throws(() => setOperationsToggle(f.db, 'operations', true, { ...user, role: 'admin' }), { status: 403 });
  assert.throws(() => setOperationsToggle(f.db, 'operations', 'yes', admin), { status: 400 });
  assert.throws(() => setOperationsToggle(f.db, 'everything', true, admin), { status: 404 });
  assert.throws(() => setOperationsToggle(f.db, 'agent_runs', true, admin), { status: 409, message: /Operations and Agent metadata first/ });
  setOperationsToggle(f.db, 'operations', true, admin, '10.0.0.1');
  setOperationsToggle(f.db, 'agents_metadata', true, admin);
  const state = setOperationsToggle(f.db, 'agent_runs', true, admin);
  assert.deepEqual(effectiveToggles(f.db), { operations: true, agents_metadata: true, agent_runs: true });
  assert.deepEqual(state.toggles.map(t => [t.name, t.effective, t.last_change.by.username]),
    [['operations', true, admin.username ?? `person-${admin.id}`], ['agents_metadata', true, `person-${admin.id}`],
      ['agent_runs', true, `person-${admin.id}`]]);
  // Turning Operations off switches everything that requires it off, and keeps what was stored.
  setOperationsToggle(f.db, 'operations', false, admin);
  assert.deepEqual(effectiveToggles(f.db), { operations: false, agents_metadata: false, agent_runs: false });
  assert.deepEqual(toggleState(f.db).toggles.map(t => [t.name, t.stored, t.blocked_by]),
    [['operations', false, []], ['agents_metadata', true, ['operations']], ['agent_runs', true, ['operations']]]);
  const audit = f.db.prepare("SELECT user_id,action,resource_id,details,ip_address FROM audit_log ORDER BY rowid").all();
  assert.deepEqual(audit.map(a => [a.action, a.resource_id, JSON.parse(a.details).previous, JSON.parse(a.details).enabled]), [
    ['OPERATIONS_TOGGLE_CHANGED', 'operations', false, true], ['OPERATIONS_TOGGLE_CHANGED', 'agents_metadata', false, true],
    ['OPERATIONS_TOGGLE_CHANGED', 'agent_runs', false, true], ['OPERATIONS_TOGGLE_CHANGED', 'operations', true, false]]);
  assert.equal(audit[0].ip_address, '10.0.0.1');
  assert.ok(audit.every(a => a.user_id === admin.id));
});

test('settings routes: administrators read; changing also needs sudo; the body is exactly { enabled }', async () => {
  const { f, admin, user } = world();
  const router = createOperationsSettingsRouter({ Router: fixtureRouter, db: () => f.db, requireAdmin, requireSudo });
  const call = (who, method, path, body = {}, sudo = false) => router.dispatch({ method, path, body, user: who, sudo });
  assert.equal((await call(user, 'GET', '/')).statusCode, 403);
  assert.equal((await call(user, 'PUT', '/operations', { enabled: true }, true)).statusCode, 403);
  assert.deepEqual((await call(admin, 'GET', '/')).body.toggles.map(t => t.stored), [false, false, false]);
  const noSudo = await call(admin, 'PUT', '/operations', { enabled: true });
  assert.deepEqual([noSudo.statusCode, noSudo.body.sudo_required], [401, true]);
  assert.equal((await call(admin, 'PUT', '/operations', { enabled: true, extra: 1 }, true)).statusCode, 400);
  assert.equal((await call(admin, 'PUT', '/agent_runs', { enabled: true }, true)).statusCode, 409);
  const on = await call(admin, 'PUT', '/operations', { enabled: true }, true);
  assert.deepEqual([on.statusCode, on.body.toggles[0].effective], [200, true]);
  assert.equal(storedToggles(f.db).operations, true);
});

test('the Operations router reads the toggles on every request', async () => {
  const { f, admin, user } = world();
  const toggle = name => () => effectiveToggles(f.db)[name];
  const router = createOperationsRouter({ Router: fixtureRouter, store: f.store, enabled: toggle('operations'),
    agentsEnabled: toggle('agents_metadata'), agentRunsEnabled: toggle('agent_runs'), lookupLimiter: (_r, _s, n) => n() });
  const call = (who, method, path, body = {}) => router.dispatch({ method, path, body, user: who });
  const caps = async who => (await call(who, 'GET', '/capabilities')).body;
  assert.deepEqual(await caps(user), { enabled: false, stage: 'human-workflow', ui_available: false, evidence_enabled: false,
    agents_metadata_enabled: false, agent_runs_enabled: false, browser_draft_configuration_available: false,
    browser_draft_contract: 'browser-agent-draft.v1', selected_browser_execution_available: false, can_manage_settings: false });
  assert.equal((await caps(admin)).can_manage_settings, true);
  assert.equal((await call(user, 'GET', '/')).statusCode, 404);
  setOperationsToggle(f.db, 'operations', true, admin);
  assert.equal((await caps(user)).enabled, true);
  assert.equal((await call(user, 'GET', '/')).statusCode, 200);
  assert.equal((await call(user, 'GET', '/directory')).statusCode, 404);
  setOperationsToggle(f.db, 'agents_metadata', true, admin);
  assert.equal((await call(user, 'GET', '/directory')).statusCode, 200);
  assert.equal((await caps(user)).browser_draft_configuration_available, true);
  assert.equal((await caps(user)).selected_browser_execution_available, false);
  setOperationsToggle(f.db, 'operations', false, admin);
  assert.equal((await call(user, 'GET', '/')).statusCode, 404);
  assert.equal((await call(user, 'GET', '/directory')).statusCode, 404);
  assert.equal((await caps(user)).browser_draft_configuration_available, false);
});

test('ratchet: no environment variable and no MCP path can switch Operations', () => {
  const src = new URL('..', import.meta.url).pathname;
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(path).isDirectory()) walk(path); else if (/\.(js|json)$/.test(name)) files.push(path); } };
  walk(src);
  const text = path => readFileSync(path, 'utf8');
  assert.deepEqual(files.filter(p => /OPERATIONS_(ENABLED|AGENTS_METADATA_ENABLED|AGENT_RUNS_ENABLED)/.test(text(p))), []);
  const policy = JSON.parse(text(join(src, 'lib/mcp-policy/mcp-extended-policy.json')));
  assert.equal(policy.settings.writable.some(k => /operations/i.test(k)), false);
  assert.equal(Object.keys(policy.feature_flags).some(k => /operations/i.test(k)), false);
  assert.deepEqual(files.filter(p => /routes\/mcp|lib\/mcp-/.test(p) && /operations-toggles|operations-settings|operations_toggle/.test(text(p))), []);
});
