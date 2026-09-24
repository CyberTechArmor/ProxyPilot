// OpenBao 2.6 disables unauthenticated sys/generate-root unless the listener
// allows it; automatic custody needs it (withTransientRoot, the recovery kit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerFixture } from './helpers/openbao-fixture.js';
import { ensureRuntime, serverConfig, priorServerConfig, prepareFiles } from '../lib/setup-engine/openbao-runtime.js';

const auto = { credential_ref: 'bao-ref-0123456789ab', config: { mode: 'install', basic: true, custody: 'auto', origin: 'https://openbao.example.com' } };
const pgp = { ...auto, config: { ...auto.config, custody: undefined } };
const job = { fence() {}, generated() {}, event() {}, checkpoint() {} };
const withDir = async fn => { const dir = mkdtempSync(join(tmpdir(), 'bao-gr-')); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('automatic custody enables the unauthenticated generate-root endpoints; PGP custody is unchanged', () => {
  assert.equal(serverConfig(auto).listener.tcp.disable_unauthed_generate_root_endpoints, false);
  assert.equal('disable_unauthed_generate_root_endpoints' in serverConfig(pgp).listener.tcp, false);
  assert.deepEqual(serverConfig(pgp), priorServerConfig(pgp));
});

test('an install carrying the earlier config is upgraded in place (same inode) and the server restarted; other drift is refused', () => withDir(async dir => {
  const root = join(dir, 'owned'), d = dockerFixture(), host = d.host, restarts = [];
  d.host = async argv => { if (argv[1] === 'restart') { restarts.push(argv.at(-1)); return { code: 0, stdout: '', stderr: '' }; } return host(argv); };
  await ensureRuntime(auto, { exec: d, job, root });
  assert.equal(restarts.length, 0, 'a fresh install needs no restart');
  const config = join(root, 'server.json');
  writeFileSync(config, JSON.stringify(priorServerConfig(auto), null, 2) + '\n');
  const inode = statSync(config).ino;
  await ensureRuntime(auto, { exec: d, job, root });
  assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), serverConfig(auto));
  assert.equal(statSync(config).ino, inode, 'the bind-mounted file keeps its inode');
  assert.equal(restarts.length, 1);
  await ensureRuntime(auto, { exec: d, job, root });
  assert.equal(restarts.length, 1, 'current config: no further restart');
  writeFileSync(config, '{"listener":{}}\n');
  assert.throws(() => prepareFiles(auto, { root, resourcesExist: true }), /configuration drifted/);
}));
