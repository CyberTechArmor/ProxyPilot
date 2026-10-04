import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { operationsFixture } from './helpers/operations-fixture.js';
import { operationalBrowserConnectionsMigration1124 } from '../lib/operational-browser-connections-schema.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { csrfProtection } from '../middleware/csrf.js';

test('real HTTP metadata connections enforce CSRF, revisions, current ownership and exact sharing without secret intake', async () => {
  const f = operationsFixture(); operationalBrowserConnectionsMigration1124(f.adapter);
  const owner = f.addUser(), contributor = f.addUser(), member = f.addUser(), outsider = f.addUser();
  const project = f.store.create(owner, { name: 'HTTP connections', members: [{ user_id: contributor.id, role: 'editor' }, { user_id: member.id, role: 'operator' }] });
  const users = new Map([owner, contributor, member, outsider].map(actor => [actor.id, actor]));
  let metadata = true;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = users.get(req.get('X-Fixture-Actor')); req.cookies = { pp_csrf: 'fixture-csrf' }; next(); });
  app.use(csrfProtection);
  app.use('/api/operational-projects', createOperationsRouter({ Router: express.Router, store: f.store, enabled: true,
    agentsEnabled: () => metadata, agentRunsEnabled: false, lookupLimiter: (_r, _s, next) => next(),
    requireSudo: (req, res, next) => req.get('X-Fixture-Sudo') === 'fresh' ? next() : res.status(401).json({ error: 'sudo_required', sudo_required: true }) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done));
  const root = `http://127.0.0.1:${server.address().port}/api/operational-projects/${project.id}/browser-connections`;
  const call = async (suffix = '', { actor = contributor, method = 'GET', body, match, csrf = true, sudo = false } = {}) => {
    const response = await fetch(root + suffix, { method, headers: { 'X-Fixture-Actor': actor?.id || '',
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': 'fixture-csrf' } : {}),
      ...(sudo ? { 'X-Fixture-Sudo': 'fresh' } : {}), ...(match == null ? {} : { 'If-Match': `"${match}"` }) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); return { status: response.status, etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'), body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  };
  const plan = { name: 'OAuth account plan', kind: 'oauth', origin: 'https://example.com', account_hint: 'Personal account' };
  const rev = () => f.store.get(contributor, project.id).revision;
  try {
    const capabilities = await call('/capabilities');
    assert.equal(capabilities.status, 200); assert.equal(capabilities.cache, 'no-store');
    assert.equal(capabilities.body.oauth_authorization_available, false); assert.equal(capabilities.body.enrollment_available, false);
    assert.equal((await call('', { actor: null })).status, 401);
    assert.equal((await call('', { actor: outsider })).status, 404);
    assert.equal((await call('', { method: 'POST', body: plan, match: rev(), csrf: false })).status, 403);
    assert.equal((await call('', { method: 'POST', body: plan })).status, 428);
    assert.equal((await call('', { method: 'POST', body: { ...plan, refresh_token: 'PRIVATE_OAUTH_CANARY' }, match: rev() })).status, 400);
    const saved = await call('', { method: 'POST', body: plan, match: rev() });
    assert.equal(saved.status, 201); assert.equal(saved.etag, '"1"'); assert.equal(saved.body.connection.capability.execution_available, false);
    const connection = saved.body.connection, suffix = '/' + connection.id;
    assert.equal((await call(suffix, { actor: owner })).status, 404);
    assert.equal((await call(suffix, { method: 'PATCH', body: { name: 'Stale', origin: plan.origin, account_hint: '' }, match: 2 })).status, 412);
    const grant = { recipient_id: member.id, permission: 'propose_use', expires_at: new Date(Date.now() + 600000).toISOString(),
      reviewed_statement: 'Share this exact browser connection metadata version with this member' };
    assert.equal((await call(suffix + '/grants', { method: 'POST', body: grant, match: 1 })).status, 401);
    const shared = await call(suffix + '/grants', { method: 'POST', body: grant, match: 1, sudo: true });
    assert.equal(shared.status, 201); assert.equal(shared.etag, '"2"');
    assert.equal((await call(suffix, { actor: member })).status, 200);
    assert.equal((await call(suffix + '/versions', { actor: member })).status, 404);
    assert.equal((await call(suffix + '/grants', { actor: member })).status, 404);
    const updated = await call(suffix, { method: 'PATCH', body: { name: 'Next account plan', origin: plan.origin, account_hint: '' }, match: 2 });
    assert.equal(updated.status, 200); assert.equal(updated.etag, '"3"');
    assert.equal((await call(suffix, { actor: member })).status, 404);
    assert.equal((await call(suffix + '/versions?limit=1')).body.next_cursor, '2');
    for (const action of ['enroll', 'authorize', 'callback', 'start', 'test', 'reveal', 'rotate'])
      assert.equal((await call(suffix + '/' + action, { method: 'POST', body: {}, match: 3 })).status, 404);
    const revoked = await call(suffix + '/revoke', { method: 'POST', body: {}, match: 3 });
    assert.equal(revoked.status, 200); assert.equal(revoked.body.connection.status, 'revoked');
    assert.equal(revoked.body.connection.capability.credential_version, null);
    metadata = false; assert.equal((await call('')).status, 404);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM ops_project_events').all()).includes('PRIVATE_OAUTH_CANARY'), false);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_agent_credential_bindings').get().n, 0);
  } finally { await new Promise(done => server.close(done)); f.close(); }
});
