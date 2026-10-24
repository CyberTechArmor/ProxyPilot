// Application foundation — the deploy changes:
//   * buildDevServiceUnit: extra NON-secret Environment= lines (refusing what
//     would break the unit), and for a foundation deployment After/Wants
//     docker.service + DATABASE_URL = FOUNDATION_DATABASE_URL; a legacy unit is
//     unchanged;
//   * validateDeployEnvironment: for a foundation deployment a component secret
//     counts only when the platform store delivered it, and /etc/environment may
//     neither carry it nor override DATABASE_URL; legacy behaviour unchanged;
//   * resolveDeployParams: a foundation project mints NOTHING into
//     /etc/environment (configs emptied, whatever fails), carries secret NAMES,
//     and the deploy mints + delivers through the store;
//   * the deploy operation writes the foundation unit, gives install/migrate/
//     build the same DATABASE_URL, and refuses to start without delivery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFoundationHooks, freshMock2Db, addProject, scriptedStack } from './helpers/foundation-world.js';
import { FOUNDATION_DATABASE_URL, FOUNDATION_VERSION } from '../mock2/foundation-contract.js';
import { buildDevServiceUnit, validateDeployEnvironment, unitEnvironmentLines, execStartForStartCommand } from '../mock2/deploy-logic.js';
import { runDeployOperation } from '../lib/setup-engine/deploy-op.js';
import { scriptedGuest, PARAMS, unwrapContained } from './helpers/scripted-guest.js';

process.env.TOTP_ENCRYPTION_KEY = 'c'.repeat(64);
installFoundationHooks();
const { resolveDeployParams } = await import('../mock2/deploy.js');
const store = await import('../mock2/foundation-store.js');

const EXEC = execStartForStartCommand('npm run start', { appDir: '/srv/app' });

test('unit: a legacy unit is unchanged; a foundation unit starts after Docker and carries the socket DATABASE_URL', () => {
  const legacy = buildDevServiceUnit({ appDir: '/srv/app', webPort: 3000, execStart: EXEC });
  assert.equal(legacy, buildDevServiceUnit({ appDir: '/srv/app', webPort: 3000, execStart: EXEC, environment: {}, foundation: false }));
  assert.match(legacy, /^After=network\.target$/m);
  assert.doesNotMatch(legacy, /docker|DATABASE_URL|Wants=/);
  const f = buildDevServiceUnit({ appDir: '/srv/app', webPort: 3000, execStart: EXEC, foundation: true });
  assert.match(f, /^After=network\.target docker\.service$/m);
  assert.match(f, /^Wants=docker\.service$/m);
  assert.ok(f.split('\n').includes(`Environment=DATABASE_URL=${FOUNDATION_DATABASE_URL}`));
  assert.ok(f.indexOf('Environment=DATABASE_URL=') < f.indexOf('EnvironmentFile=-/etc/environment'));
  assert.ok(f.indexOf('Environment=NODE_ENV=production') > 0);
  const extra = buildDevServiceUnit({ execStart: EXEC, environment: { APP_REGION: 'eu-west', FEATURE_X: 'on' } });
  assert.ok(extra.split('\n').includes('Environment=APP_REGION=eu-west'));
  assert.doesNotMatch(extra, /docker/);
});

test('unit environment: values that would break the unit and keys the unit owns are refused', () => {
  for (const [env, re] of [
    [{ A: 'x\nExecStart=/bin/evil' }, /would break the unit/], [{ A: 'say "hi"' }, /would break/], [{ A: "it's" }, /would break/],
    [{ A: 'two words' }, /would break/], [{ A: 'back\\slash' }, /would break/], [{ A: '100%' }, /would break/], [{ A: 'tab\there' }, /would break/],
    [{ 'BAD-KEY': 'x' }, /not a variable name/], [{ PORT: '1' }, /set by the unit/], [{ NODE_ENV: 'development' }, /set by the unit/], [{ NODE_OPTIONS: '--inspect' }, /set by the unit/],
  ]) {
    assert.throws(() => buildDevServiceUnit({ execStart: EXEC, environment: env }), re, JSON.stringify(env));
  }
  assert.throws(() => unitEnvironmentLines({ DATABASE_URL: 'postgres://elsewhere/db' }, { foundation: true }), /socket URL/);
  assert.deepEqual(unitEnvironmentLines({ DATABASE_URL: FOUNDATION_DATABASE_URL }, { foundation: true }), [`Environment=DATABASE_URL=${FOUNDATION_DATABASE_URL}`]);
  try { buildDevServiceUnit({ execStart: EXEC, environment: { A: 'x y' } }); } catch (e) { assert.equal(e.code, 'INVALID_UNIT_ENVIRONMENT'); }
});

test('validateDeployEnvironment: foundation secrets count only when delivered; never in /etc/environment; DATABASE_URL not overridden', () => {
  const unit = buildDevServiceUnit({ execStart: EXEC, foundation: true });
  const v = (o) => validateDeployEnvironment({ unitText: unit, environmentText: '', requiredKeys: ['AUTH_MASTER_SECRET'], foundation: true, storeKeys: ['AUTH_MASTER_SECRET'], ...o });
  assert.deepEqual(v({}), { ok: true, mode: 'production' });
  assert.match(v({ storeKeys: [] }).error, /not delivered to the foundation database: AUTH_MASTER_SECRET/);
  assert.match(v({ environmentText: 'AUTH_MASTER_SECRET=abc\n' }).error, /carries AUTH_MASTER_SECRET/);
  assert.match(v({ environmentText: 'DATABASE_URL=postgres://app:app@127.0.0.1:5432/app\n' }).error, /override the foundation stack's socket URL/);
  assert.equal(v({ environmentText: `DATABASE_URL=${FOUNDATION_DATABASE_URL}\n` }).ok, true);
  assert.match(v({ unitText: buildDevServiceUnit({ execStart: EXEC }) }).error, /does not set DATABASE_URL/);
  assert.match(v({ environmentText: 'NODE_ENV=development\n' }).error, /override the unit's production mode/);
  // Legacy: exactly as before.
  const legacyUnit = buildDevServiceUnit({ execStart: EXEC });
  assert.deepEqual(validateDeployEnvironment({ unitText: legacyUnit, environmentText: 'AUTH_MASTER_SECRET=abc\n', requiredKeys: ['AUTH_MASTER_SECRET'] }), { ok: true, mode: 'production' });
  assert.match(validateDeployEnvironment({ unitText: legacyUnit, environmentText: '', requiredKeys: ['AUTH_MASTER_SECRET'] }).error, /missing from \/etc\/environment/);
});

function seedComponent(db, projectId, configs) {
  const now = new Date().toISOString();
  const c = db.prepare("INSERT INTO mock2_components (key, name, status, created_by, created_at) VALUES ('auth', 'Auth', 'published', 1, ?)").run(now);
  const v = db.prepare("INSERT INTO mock2_component_versions (component_id, version, files_json, change_reason, source, created_by, created_at, contract_json) VALUES (?, 1, '[]', 'seed', 'in_app', 1, ?, ?)").run(c.lastInsertRowid, now, JSON.stringify({ config: configs }));
  db.prepare("INSERT INTO mock2_project_components (project_id, component_id, version_id, status, origin, created_at) VALUES (?, ?, ?, 'installed', 'operator', ?)").run(projectId, c.lastInsertRowid, v.lastInsertRowid, now);
}
const GUARD = { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce' };
const CONFIGS = [{ key: 'AUTH_JWT_SECRET', secret: true, generate: true }, { key: 'AUTH_MASTER_SECRET', secret: true, generate: true, protects: GUARD }];

test('resolveDeployParams: a foundation project mints nothing into /etc/environment and carries secret NAMES; the deploy delivers', async () => {
  const db = freshMock2Db();
  addProject(db, { id: 1, container: 'm2-p1' });
  const { guest } = scriptedStack();
  store.getFoundationProvisionInputs(1);
  seedComponent(db, 1, CONFIGS);
  const read = await resolveDeployParams({ containerName: 'm2-p1' });
  assert.deepEqual(read.secrets.configs, [], 'nothing is minted into the environment file');
  assert.equal(read.guard, null, 'the env-file credential probe does not apply');
  assert.equal('guardKey' in read, false);
  assert.deepEqual(read.foundation, { version: FOUNDATION_VERSION, required: [], delivered: [] }, 'a non-deploy caller writes nothing');
  assert.equal(store.hasSecret(1, 'component.AUTH_JWT_SECRET'), false);
  const deploy = await resolveDeployParams({ containerName: 'm2-p1', deliverFoundationSecrets: true });
  assert.deepEqual(deploy.secrets.configs, []);
  assert.deepEqual(deploy.foundation.required, ['AUTH_JWT_SECRET'], 'the data-guarded key is deferred on an existing deployment');
  assert.deepEqual(deploy.foundation.delivered, ['AUTH_JWT_SECRET']);
  const value = store.readSecret(1, 'component.AUTH_JWT_SECRET');
  assert.ok(value);
  assert.equal(JSON.stringify(deploy).includes(value), false, 'the plan carries no value');
  assert.ok(guest.lastSync.includes("'component.AUTH_JWT_SECRET'"));
  // A store failure fails closed: every key still required, none delivered.
  guest.failSync = true;
  const failed = await resolveDeployParams({ containerName: 'm2-p1', deliverFoundationSecrets: true });
  assert.deepEqual(failed.secrets.configs, []);
  assert.deepEqual(failed.foundation.delivered, []);
  assert.match(failed.foundation.error, /did not accept/);
});

test('resolveDeployParams: a legacy project is unchanged (configs and data guard carried, no foundation reference)', async () => {
  const db = freshMock2Db();
  addProject(db, { id: 2, container: 'm2-p2', foundationVersion: null });
  scriptedStack();
  seedComponent(db, 2, CONFIGS);
  const p = await resolveDeployParams({ containerName: 'm2-p2', deliverFoundationSecrets: true });
  assert.deepEqual(p.secrets.configs.map((c) => c.key), ['AUTH_JWT_SECRET', 'AUTH_MASTER_SECRET']);
  assert.deepEqual({ table: p.guard.table, schema: p.guard.schema, secret_column: p.guard.secret_column, nonce_column: p.guard.nonce_column }, GUARD);
  assert.equal(p.guardKey, 'AUTH_MASTER_SECRET');
  assert.equal('foundation' in p, false);
});

function foundationGuest(state = {}) {
  const g = scriptedGuest(state);
  const inner = g.guest;
  g.guest = async (container, raw, opts) => {
    const s = unwrapContained(raw);
    if (/^cat \/etc\/environment/m.test(s)) { g.calls.push({ phase: 'env_read', script: s }); return { code: 0, stdout: state.envText ?? '' }; }
    return inner(container, raw, opts);
  };
  return g;
}
const JOB = () => ({ id: 'j-found', fence: () => {}, checkpoint: () => 0, generated: () => 0, event: () => {} });
const FOUNDATION = (extra = {}) => ({ version: FOUNDATION_VERSION, required: ['AUTH_MASTER_SECRET'], delivered: ['AUTH_MASTER_SECRET'], ...extra });

test('deploy operation (foundation): writes the foundation unit, gives install/migrate/build the socket DATABASE_URL, mints nothing into the env file', async () => {
  const g = foundationGuest({});
  const r = await runDeployOperation({ params: PARAMS({ guard: null, foundation: FOUNDATION() }), exec: g, job: JOB() });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.step, 'serving');
  const swap = g.calls.find((c) => c.phase === 'unit_swap');
  const unit = Buffer.from(swap.script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/systemd\/system\/mock2-dev\.service/)[1], 'base64').toString('utf8');
  assert.ok(unit.split('\n').includes(`Environment=DATABASE_URL=${FOUNDATION_DATABASE_URL}`));
  assert.match(unit, /^Wants=docker\.service$/m);
  const migrate = g.calls.find((c) => c.phase === 'migrate');
  assert.ok(migrate.script.includes(`export DATABASE_URL='${FOUNDATION_DATABASE_URL}'`));
  assert.equal(g.calls.some((c) => c.phase === 'env_write'), false, 'no secret is written to /etc/environment');
  assert.equal(g.calls.some((c) => c.phase === 'active_key' || c.phase === 'data_probe'), false, 'no env-file credential probe');
});

test('deploy operation (foundation): refuses to start when a required secret was not delivered, or the env file carries it', async () => {
  const undelivered = await runDeployOperation({ params: PARAMS({ guard: null, foundation: FOUNDATION({ delivered: [], error: 'the app database did not accept the update' }) }), exec: foundationGuest({}), job: JOB() });
  assert.equal(undelivered.ok, false);
  assert.equal(undelivered.step, 'start');
  assert.match(undelivered.error, /not delivered to the foundation database: AUTH_MASTER_SECRET/);
  const inFile = await runDeployOperation({ params: PARAMS({ guard: null, foundation: FOUNDATION() }), exec: foundationGuest({ envText: 'AUTH_MASTER_SECRET=leaked\n' }), job: JOB() });
  assert.match(inFile.error, /carries AUTH_MASTER_SECRET/);
});

test('deploy operation (legacy): the unit and the mint path are exactly as before', async () => {
  const g = scriptedGuest({});
  const r = await runDeployOperation({ params: PARAMS(), exec: g, job: JOB() });
  assert.equal(r.ok, true, r.error);
  const swap = g.calls.find((c) => c.phase === 'unit_swap');
  const unit = Buffer.from(swap.script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/systemd\/system\/mock2-dev\.service/)[1], 'base64').toString('utf8');
  assert.equal(unit, buildDevServiceUnit({ appDir: '/srv/app', webPort: 3000, execStart: EXEC }));
  assert.equal(g.calls.find((c) => c.phase === 'migrate').script.includes('DATABASE_URL'), false);
});
