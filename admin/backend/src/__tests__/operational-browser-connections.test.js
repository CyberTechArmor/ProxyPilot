import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './helpers/operations-fixture.js';
import { operationalBrowserConnectionsMigration1124 } from '../lib/operational-browser-connections-schema.js';

const plan = { name: 'Private account plan', kind: 'website-login', origin: 'https://example.com', account_hint: 'Contributor account' };
const statement = 'Share this exact browser connection metadata version with this member';
function world() {
  const f = operationsFixture(); operationalBrowserConnectionsMigration1124(f.adapter);
  const owner = f.addUser(), contributor = f.addUser(), member = f.addUser(), outsider = f.addUser(), admin = f.addUser('admin');
  const p = f.store.create(owner, { name: 'Connection project', members: [{ user_id: contributor.id, role: 'editor' }, { user_id: member.id, role: 'operator' }] });
  const create = (input = plan) => f.store.createBrowserConnection(contributor, p.id, f.store.get(contributor, p.id).revision, input).connection;
  const share = (c, target = member, permission = 'view_metadata', expires_at = new Date(Date.now() + 3600000).toISOString()) =>
    f.store.grantBrowserConnection(contributor, p.id, c.id, c.revision, { recipient_id: target.id, permission, expires_at, reviewed_statement: statement });
  return { ...f, owner, contributor, member, outsider, admin, p, create, share };
}
const withWorld = fn => () => { const w = world(); try { fn(w); } finally { w.close(); } };
const denied = (fn, status) => assert.throws(fn, error => error.status === status);

test('browser connection creation is contributor-private metadata and never enrolls or executes', withWorld(w => {
  const c = w.create(); assert.equal(c.status, 'draft'); assert.equal(c.contributor_id, w.contributor.id);
  assert.equal(c.capability.enrollment_available, false); assert.equal(c.capability.execution_available, false);
  assert.equal(c.capability.oauth_authorization_available, false); assert.equal(c.capability.credential_version, null);
  assert.deepEqual(w.store.browserConnections(w.owner, w.p.id).connections, []);
  assert.deepEqual(w.store.browserConnections(w.member, w.p.id).connections, []);
  for (const a of [w.owner, w.member, w.outsider, w.admin]) denied(() => w.store.browserConnection(a, w.p.id, c.id), 404);
  assert.equal(w.db.prepare('SELECT count(*) n FROM ops_agent_credential_bindings').get().n, 0);
  assert.equal(w.db.prepare('SELECT count(*) n FROM ops_browser_connection_versions').get().n, 1);
}));

test('strict metadata schema refuses secret/custody/activation fields and does not echo canaries', withWorld(w => {
  for (const extra of ['password', 'token', 'vault_path', 'credential_version', 'execution_enabled', 'contributor_id', 'provider_client_secret']) {
    const canary = 'DO_NOT_RETAIN_PRIVATE_' + extra;
    assert.throws(() => w.create({ ...plan, [extra]: canary }), error => error.status === 400 && !error.message.includes(canary));
  }
  assert.equal(w.db.prepare('SELECT count(*) n FROM ops_browser_connections').get().n, 0);
  assert.equal(w.db.prepare("SELECT count(*) n FROM ops_project_events WHERE action LIKE 'browser_connection_%'").get().n, 0);
}));

test('origins are exact HTTPS metadata, not reachability grants', withWorld(w => {
  for (const origin of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?token=secret', 'https://*.example.com']) denied(() => w.create({ ...plan, origin }), 400);
  const c = w.create({ ...plan, origin: 'https://EXAMPLE.com/' }); assert.equal(c.origin, 'https://example.com');
  assert.equal(c.capability.execution_available, false);
}));

test('exact recipient grants expire and require current project membership/account eligibility', withWorld(w => {
  const c = w.create();
  denied(() => w.share(c, w.outsider), 400);
  denied(() => w.share(c, w.contributor), 400);
  denied(() => w.share(c, w.member, 'view_metadata', '2000-01-01T00:00:00.000Z'), 400);
  const shared = w.share(c);
  assert.equal(shared.grant.version, c.version); assert.equal(shared.grant.permission, 'view_metadata');
  assert.equal(w.store.browserConnections(w.member, w.p.id).connections[0].id, c.id);
  assert.equal(w.store.browserConnection(w.member, w.p.id, c.id).connection.capability.execution_available, false);
  denied(() => w.store.browserConnectionGrants(w.member, w.p.id, c.id), 404);
  denied(() => w.store.browserConnectionVersions(w.member, w.p.id, c.id), 404);
  w.advance(3601000); denied(() => w.store.browserConnection(w.member, w.p.id, c.id), 404);
  assert.equal(w.store.browserConnections(w.member, w.p.id).connections.length, 0);
}));

test('project owner gets no contributor credential manage bypass even when metadata is shared', withWorld(w => {
  const c = w.create(), shared = w.share(c, w.owner, 'propose_use');
  assert.deepEqual(w.store.browserConnection(w.owner, w.p.id, c.id).connection.own_rights, ['propose_use']);
  denied(() => w.store.updateBrowserConnection(w.owner, w.p.id, c.id, shared.connection.revision,
    { name: 'Attempt', origin: plan.origin, account_hint: '' }), 404);
  denied(() => w.store.revokeBrowserConnection(w.owner, w.p.id, c.id, shared.connection.revision), 404);
  denied(() => w.store.grantBrowserConnection(w.owner, w.p.id, c.id, shared.connection.revision, {}), 400);
}));

test('current account/grant loss blocks reads and does not inherit stale sharing authority', withWorld(w => {
  const c = w.create(); w.share(c);
  w.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(w.member.id);
  denied(() => w.store.browserConnection(w.member, w.p.id, c.id), 403);
  w.db.prepare("UPDATE users SET role='user' WHERE id=?").run(w.member.id);
  w.store.remove(w.owner, w.p.id, w.member.id, w.store.get(w.owner, w.p.id).revision);
  denied(() => w.store.browserConnection(w.member, w.p.id, c.id), 404);
  w.store.grant(w.owner, w.p.id, w.member.id, w.store.get(w.owner, w.p.id).revision, { role: 'operator' });
  denied(() => w.store.browserConnection(w.member, w.p.id, c.id), 404);
  assert.equal(w.store.browserConnections(w.member, w.p.id).connections.length, 0);
  w.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(w.contributor.id);
  denied(() => w.store.browserConnection(w.contributor, w.p.id, c.id), 403);
}));

test('membership role updates invalidate shares even when the member remains in the project', withWorld(w => {
  const c = w.create(); w.share(c);
  w.store.grant(w.owner, w.p.id, w.member.id, w.store.get(w.owner, w.p.id).revision, { role: 'editor' });
  denied(() => w.store.browserConnection(w.member, w.p.id, c.id), 404);
  assert.equal(w.store.browserConnections(w.member, w.p.id).connections.length, 0);
}));

test('grant timestamps normalize precision before lexical current-access comparisons', withWorld(w => {
  const c = w.create();
  const expiry = new Date(Date.parse(w.p.created_at) + 3000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const shared = w.share(c, w.member, 'view_metadata', expiry);
  assert.equal(shared.grant.expires_at, new Date(expiry).toISOString());
  assert.ok(shared.grant.expires_at.endsWith('.000Z'));
  w.advance(4000); denied(() => w.store.browserConnection(w.member, w.p.id, c.id), 404);
}));

test('cross-project connection IDs never grant existence or mutation authority', withWorld(w => {
  const c = w.create(), another = w.store.create(w.contributor, { name: 'Another project' });
  denied(() => w.store.browserConnection(w.contributor, another.id, c.id), 404);
  denied(() => w.store.revokeBrowserConnection(w.contributor, another.id, c.id, c.revision), 404);
  denied(() => w.store.browserConnectionGrants(w.contributor, another.id, c.id), 404);
  assert.equal(w.store.browserConnection(w.contributor, w.p.id, c.id).connection.status, 'draft');
}));

test('version edits preserve prior metadata and invalidate all prior recipient grants', withWorld(w => {
  const c = w.create(), first = w.share(c), second = w.share(first.connection, w.owner);
  const updated = w.store.updateBrowserConnection(w.contributor, w.p.id, c.id, second.connection.revision,
    { name: 'Next plan', origin: 'https://next.example.com', account_hint: 'Next account' }).connection;
  assert.equal(updated.version, 2); assert.equal(updated.revision, 4);
  assert.deepEqual(w.store.browserConnectionVersions(w.contributor, w.p.id, c.id).versions.map(v => v.name), ['Next plan', plan.name]);
  for (const a of [w.member, w.owner]) denied(() => w.store.browserConnection(a, w.p.id, c.id), 404);
  assert.ok(w.store.browserConnectionGrants(w.contributor, w.p.id, c.id).grants.every(g => g.revoked_at && g.revoke_reason === 'metadata_version_changed'));
  denied(() => w.store.updateBrowserConnection(w.contributor, w.p.id, c.id, second.connection.revision, plan), 400);
  denied(() => w.store.updateBrowserConnection(w.contributor, w.p.id, c.id, second.connection.revision,
    { name: 'Stale', origin: plan.origin, account_hint: '' }), 412);
}));

test('archive permits privacy revocation and history but refuses new/edit/share', withWorld(w => {
  const c = w.create(), shared = w.share(c);
  w.store.archive(w.owner, w.p.id, w.store.get(w.owner, w.p.id).revision, { reason: 'Closed' });
  denied(() => w.create(), 409);
  denied(() => w.store.updateBrowserConnection(w.contributor, w.p.id, c.id, shared.connection.revision,
    { name: 'New', origin: plan.origin, account_hint: '' }), 409);
  denied(() => w.share(shared.connection, w.owner), 409);
  const revoked = w.store.revokeBrowserConnection(w.contributor, w.p.id, c.id, shared.connection.revision).connection;
  assert.equal(revoked.status, 'revoked'); denied(() => w.store.browserConnection(w.member, w.p.id, c.id), 404);
  assert.equal(w.store.browserConnectionVersions(w.contributor, w.p.id, c.id).versions.length, 1);
  assert.equal(w.store.revokeBrowserConnection(w.contributor, w.p.id, c.id, revoked.revision).connection.revision, revoked.revision);
}));

test('grant revoke removes access, is idempotent and preserves grant/event history', withWorld(w => {
  const c = w.create(), shared = w.share(c);
  const out = w.store.revokeBrowserConnectionGrant(w.contributor, w.p.id, c.id, shared.grant.id, shared.connection.revision);
  assert.ok(out.grant.revoked_at); denied(() => w.store.browserConnection(w.member, w.p.id, c.id), 404);
  assert.equal(w.store.revokeBrowserConnectionGrant(w.contributor, w.p.id, c.id, shared.grant.id, out.connection.revision).connection.revision, out.connection.revision);
  const next = w.share(out.connection); assert.notEqual(next.grant.id, shared.grant.id);
  assert.equal(w.store.browserConnectionGrants(w.contributor, w.p.id, c.id).grants.length, 2);
}));

test('immutable history and revocation survive direct SQL attempts and account deletion', withWorld(w => {
  const c = w.create(), shared = w.share(c);
  assert.throws(() => w.db.prepare('UPDATE ops_browser_connection_versions SET name=? WHERE connection_id=?').run('Tampered', c.id));
  assert.throws(() => w.db.prepare('DELETE FROM ops_browser_connection_versions WHERE connection_id=?').run(c.id));
  assert.throws(() => w.db.prepare('UPDATE ops_browser_connection_grants SET recipient_id=? WHERE id=?').run(w.owner.id, shared.grant.id));
  const revoked = w.store.revokeBrowserConnection(w.contributor, w.p.id, c.id, shared.connection.revision).connection;
  assert.throws(() => w.db.prepare("UPDATE ops_browser_connections SET status='draft' WHERE id=?").run(c.id));
  assert.throws(() => w.db.prepare('DELETE FROM ops_browser_connections WHERE id=?').run(c.id));
  w.db.prepare('DELETE FROM users WHERE id=?').run(w.contributor.id);
  denied(() => w.store.browserConnection(w.contributor, w.p.id, c.id), 401);
  assert.equal(w.db.prepare('SELECT status FROM ops_browser_connections WHERE id=?').get(c.id).status, revoked.status);
}));

test('connection and version pagination remain bounded without hiding retained records', withWorld(w => {
  for (let n = 0; n < 5; n++) w.create({ ...plan, name: 'Plan ' + n });
  let cursor, count = 0;
  do {
    const page = w.store.browserConnections(w.contributor, w.p.id, { limit: '2', ...(cursor ? { after: cursor } : {}) });
    count += page.connections.length; cursor = page.next_cursor;
  } while (cursor);
  assert.equal(count, 5);
  let c = w.create();
  for (let n = 0; n < 4; n++) c = w.store.updateBrowserConnection(w.contributor, w.p.id, c.id, c.revision,
    { name: 'Version ' + n, origin: plan.origin, account_hint: '' }).connection;
  cursor = undefined; count = 0;
  do {
    const page = w.store.browserConnectionVersions(w.contributor, w.p.id, c.id, { limit: '2', ...(cursor ? { after: cursor } : {}) });
    count += page.versions.length; cursor = page.next_cursor;
  } while (cursor);
  assert.equal(count, 5);
}));

test('create and share rollback state/version/grants if durable audit fails', withWorld(w => {
  w.db.exec("CREATE TRIGGER refuse_connection_audit BEFORE INSERT ON ops_project_events WHEN NEW.action LIKE 'browser_connection_%' BEGIN SELECT RAISE(ABORT,'Audit unavailable'); END;");
  assert.throws(w.create); assert.equal(w.db.prepare('SELECT count(*) n FROM ops_browser_connections').get().n, 0);
  w.db.exec('DROP TRIGGER refuse_connection_audit');
  const c = w.create();
  w.db.exec("CREATE TRIGGER refuse_connection_audit BEFORE INSERT ON ops_project_events WHEN NEW.action LIKE 'browser_connection_%' BEGIN SELECT RAISE(ABORT,'Audit unavailable'); END;");
  assert.throws(() => w.share(c)); assert.equal(w.store.browserConnection(w.contributor, w.p.id, c.id).connection.revision, 1);
  assert.equal(w.db.prepare('SELECT count(*) n FROM ops_browser_connection_grants').get().n, 0);
}));
