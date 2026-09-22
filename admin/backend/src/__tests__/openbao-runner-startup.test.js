import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, createCipheriv } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb, inputFor, baoFixture } from './helpers/openbao-fixture.js';
import { save, apply, review, readOpenBao, secrets } from '../lib/setup-engine/openbao-store.js';
import { namesFor, policyFor, humanRoleFor, machineRoleFor, roleFor, databaseDetails } from '../lib/setup-engine/openbao-logic.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'g6-runner-startup-'));
  mkdirSync(join(root, 'data/db'), { recursive: true });
  const db = makeDb(join(root, 'data/db/proxypilot.db'), { mode: 'connect' });
  save(db, inputFor('connect'));
  const r = readOpenBao(db), n = namesFor(r), credentials = { ...secrets(db, r), roleId: 'g6-role-id' };
  // Independently encrypt with a per-test installation key, rather than the
  // parent fixture's cached key. The child receives neither environment key.
  const key = randomBytes(32).toString('hex'), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
  const encrypted = `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
  db.prepare('UPDATE setup_openbao_credentials SET value=?').run(encrypted);
  db.prepare('UPDATE setup_openbao SET bootstrap_complete=1,resources_json=?').run(JSON.stringify({ clusterId: 'g6-cluster', seal: 'shamir' }));
  const api = baoFixture(db, { initialized: true, sealed: false });
  api.secretIds.set(credentials.machine, true);
  for (const p of [n.human, n.machine]) api.policies.set(p, policyFor(r));
  const entries = {
    [`auth/${n.oidc}/config`]: { oidc_discovery_url: r.config.issuer, oidc_client_id: r.config.clientId, default_role: 'mapped', bound_issuer: r.config.issuer },
    [`auth/${n.oidc}/role/mapped`]: humanRoleFor(r),
    [`auth/${n.approle}/role/workload`]: machineRoleFor(r),
    [`${n.database}/roles/reader`]: roleFor(r),
    [`${n.database}/config/selected`]: { plugin_name: 'postgresql-database-plugin', allowed_roles: ['reader'], connection_details: databaseDetails(r) },
  };
  for (const [p, data] of Object.entries(entries)) api.resources.set('/v1/' + p, data);
  const envPath = join(root, '.env');
  const envText = `DATABASE_PATH=/data/db/proxypilot.db\nexport TOTP_ENCRYPTION_KEY="${key}"\n`;
  writeFileSync(envPath, envText, { mode: 0o600 });
  const queue = () => apply(db, { revision: 1, reviewToken: review(db).reviewToken, reviewed: true }, 'admin').job.id;
  return { root, db, api, key, credentials, encrypted, envPath, envText, queue, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

function run(f, action, { inherited, envPath } = {}) {
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.TOTP_ENCRYPTION_KEY;
  delete env.NODE_OPTIONS;
  if (inherited !== undefined) env.TOTP_ENCRYPTION_KEY = inherited;
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./helpers/openbao-runner-process.js', import.meta.url), [f.root, action, ...(envPath ? [envPath] : [])], { env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', stderr = '', opened = false;
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('message', async m => {
      if (m.opened) { opened = true; return; }
      try { child.send({ id: m.id, result: await f.api.send(m.origin, m.path, m.options) }); } catch (e) { child.kill(); reject(e); }
    });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr, opened }));
  });
}

test('G6 fresh runner once/serve loads the saved installation key without an inherited key or fixture key cache', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    for (const action of ['once', 'serve']) {
      const id = f.queue(), result = await run(f, action);
      assert.equal(result.code, 0, result.stderr);
      const job = f.db.prepare('SELECT * FROM setup_jobs WHERE id=?').get(id);
      assert.equal(job.status, 'succeeded', job.reason);
      assert.equal(JSON.parse(job.verification_json).state, 'credential_flow_verified');
      assert(f.api.calls.some(c => c.path.endsWith('/login')));
      assert.equal(readFileSync(f.envPath, 'utf8'), f.envText);
      assert.equal(f.db.prepare('SELECT value FROM setup_openbao_credentials').get().value, f.encrypted);
      const evidence = result.stdout + result.stderr + JSON.stringify([job, f.db.prepare('SELECT * FROM setup_job_events').all()]);
      for (const secret of [f.key, f.credentials.machine, f.credentials.client]) assert(!evidence.includes(secret));
      assert(!result.stderr.includes('DEV-ONLY'));
    }
  } finally { f.close(); }
});

test('G6 runner invalid/missing/conflicting key refuses before database open or queue changes; inspection remains available', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const id = f.queue();
    for (const value of ['', 'CHANGE_ME_64_HEX_CHARS', 'malformed-private-value']) {
      writeFileSync(f.envPath, `DATABASE_PATH=/data/db/proxypilot.db\nTOTP_ENCRYPTION_KEY=${value}\n`);
      const before = readFileSync(f.envPath, 'utf8'), result = await run(f, 'once');
      assert.equal(result.code, 2); assert.equal(result.opened, false);
      assert.match(result.stdout, /existing.*TOTP_ENCRYPTION_KEY/i);
      assert.equal(readFileSync(f.envPath, 'utf8'), before);
      assert(!result.stdout.includes('malformed-private-value'));
    }
    writeFileSync(f.envPath, f.envText);
    const conflict = await run(f, 'serve', { inherited: 'a'.repeat(64) });
    assert.equal(conflict.code, 2); assert.equal(conflict.opened, false);
    assert.equal(f.api.calls.length, 0);
    assert.equal(f.db.prepare('SELECT status FROM setup_jobs WHERE id=?').get(id).status, 'queued');
    assert.equal(f.db.prepare('SELECT value FROM setup_openbao_credentials').get().value, f.encrypted);
    writeFileSync(f.envPath, 'DATABASE_PATH=/data/db/proxypilot.db\n');
    assert.equal((await run(f, 'status')).code, 0);
    assert.equal((await run(f, 'reconcile')).code, 0);
  } finally { f.close(); }
});

test('G6 runner honors the resolved --env installation file and preserves its key', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const selected = join(f.root, 'selected.env'); writeFileSync(selected, f.envText, { mode: 0o600 });
    writeFileSync(f.envPath, 'DATABASE_PATH=/data/db/proxypilot.db\nTOTP_ENCRYPTION_KEY=invalid-unused-file\n');
    const id = f.queue(), result = await run(f, 'once', { envPath: selected });
    assert.equal(result.code, 0, result.stderr);
    const job = f.db.prepare('SELECT status,reason FROM setup_jobs WHERE id=?').get(id);
    assert.equal(job.status, 'succeeded', job.reason);
    assert.equal(readFileSync(selected, 'utf8'), f.envText);
  } finally { f.close(); }
});
