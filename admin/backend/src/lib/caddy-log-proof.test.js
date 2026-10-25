import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readCaddyLogProof } from './caddy-log-proof.js';

const domain = 'remotely.example.test';
const sourceDir = '/root/ProxyPilot-main-0f1b48f33fe3';
const secret = ['private', 'fixture', 'value'].join('-');
function proof() {
  return { schema: 1, scope: 'active-global-and-domain', domain, verified: true, activeConfigSha256: 'a'.repeat(64), caddyVersion: 'v2.11.2', global: { present: true, credentialRedaction: true, loggerNames: ['default'] }, service: { present: true, credentialRedaction: true, loggerNames: ['log0'] } };
}
function deps(overrides = {}) {
  return { domain, selfUpdateInstalled: async () => ({ configured: true, source_dir: sourceDir }), runHostCapture: async () => ({ status: 0, stdout: JSON.stringify(proof()) }), ...overrides };
}
const failure = (requestedDomain = domain) => ({ schema: 1, scope: 'active-global-and-domain', domain: requestedDomain, verified: false, code: 'verification_failed' });

test('uses only installed source path, exact fixed argv and bounded capture', async () => {
  const calls = [];
  const result = await readCaddyLogProof(deps({
    selfUpdateInstalled: async (options) => { calls.push(['installed', options]); return { configured: true, source_dir: sourceDir }; },
    runHostCapture: async (...args) => { calls.push(['run', ...args]); return { status: 0, stdout: JSON.stringify(proof()), stderr: secret }; },
  }));
  const bootstrap = "import runpy,sys; namespace=runpy.run_path(sys.argv[1],run_name='__caddy_readonly_probe__'); probe=namespace.get('active_proof_cli'); sys.exit(probe([sys.argv[2]]) if callable(probe) else 1)";
  assert.deepEqual(calls, [ ['installed', { force: false }], ['run', 'python3', ['-c', bootstrap, `${sourceDir}/scripts/secure-mcp-caddy-logs.py`, domain], { timeoutMs: 30000, maxCapture: 65536 }] ]);
  assert.deepEqual(result, proof());
});

test('rejects unsafe source paths before invoking a host process', async () => {
  for (const source_dir of ['', '/', 'relative/path', '/root/../etc', '/root/./app', '/root//app', '/root/app/', '/root/app\n', '/root/app;id', '/root/$(id)', '/root/a b', '/root/.hidden', null, 42]) {
    let invoked = false;
    const result = await readCaddyLogProof(deps({ selfUpdateInstalled: async () => ({ configured: true, source_dir }), runHostCapture: async () => { invoked = true; } }));
    assert.deepEqual(result, failure());
    assert.equal(invoked, false);
  }
});

test('requires configured installed checkout', async () => {
  let invoked = false;
  const result = await readCaddyLogProof(deps({ selfUpdateInstalled: async () => ({ configured: false, source_dir: sourceDir }), runHostCapture: async () => { invoked = true; } }));
  assert.deepEqual(result, failure());
  assert.equal(invoked, false);
});

test('rejects unsafe domains before accessing installation state', async () => {
  for (const requested of ['localhost', '*.example.test', 'Remotely.example.test', 'example.test/path', 'example.test\n', '-a.example.test', 'a-.example.test', 'a..test', '../etc', '', 'a'.repeat(64) + '.test', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`, null, 42]) {
    let invoked = false;
    const result = await readCaddyLogProof(deps({ domain: requested, selfUpdateInstalled: async () => { invoked = true; } }));
    assert.deepEqual(result, failure(null));
    assert.equal(invoked, false);
  }
});

test('allowlists the proof, ignoring unknown secret fields at every depth', async () => {
  const value = { ...proof(), token: secret, error: secret, activeConfig: { secret }, global: { ...proof().global, password: secret }, service: { ...proof().service, request: secret } };
  const result = await readCaddyLogProof(deps({ runHostCapture: async () => ({ status: 0, stdout: JSON.stringify(value), stderr: secret }) }));
  assert.deepEqual(result, proof());
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('invalid JSON, failed probe and thrown errors return the same fixed safe code', async () => {
  for (const runHostCapture of [async () => ({ status: 0, stdout: secret, stderr: secret }), async () => ({ status: 1, stdout: JSON.stringify(proof()), stderr: secret }), async () => { throw new Error(secret); }, async () => null, async () => ({ status: 0, stdout: ' '.repeat(65537) + JSON.stringify(proof()) })]) {
    assert.deepEqual(await readCaddyLogProof(deps({ runHostCapture })), failure());
  }
  assert.deepEqual(await readCaddyLogProof(deps({ selfUpdateInstalled: async () => { throw new Error(secret); } })), failure());
});

test('fails closed for mismatched or incomplete proof and unsafe diagnostic values', async () => {
  const invalid = [
    { ...proof(), schema: 2 }, { ...proof(), scope: 'fixture' }, { ...proof(), domain: 'other.example.test' },
    { ...proof(), verified: false, code: secret }, { ...proof(), verified: 'true' },
    { ...proof(), activeConfigSha256: secret }, { ...proof(), caddyVersion: `v2.11.2 ${secret}` },
    { ...proof(), global: { ...proof().global, credentialRedaction: false } },
    { ...proof(), service: { ...proof().service, present: false } },
    { ...proof(), service: { ...proof().service, loggerNames: [] } },
    { ...proof(), service: { ...proof().service, loggerNames: ['bad/name'] } },
    { ...proof(), service: { ...proof().service, loggerNames: ['x'.repeat(129)] } },
    { ...proof(), service: { ...proof().service, loggerNames: Array(129).fill('log0') } }, null, [],
  ];
  for (const value of invalid) {
    assert.deepEqual(await readCaddyLogProof(deps({ runHostCapture: async () => ({ status: 0, stdout: JSON.stringify(value) }) })), failure());
  }
});

test('unavailable optional context produces unverified proof instead of disrupting logs', async () => {
  assert.deepEqual(await readCaddyLogProof({ domain }), failure());
});

test('real Python never executes legacy main while requiring the read-only entry point', async (t) => {
  const source_dir = await mkdtemp(join(tmpdir(), 'pp-proof-'));
  t.after(() => rm(source_dir, { recursive: true, force: true }));
  await mkdir(join(source_dir, 'scripts'));
  const script = join(source_dir, 'scripts', 'secure-mcp-caddy-logs.py');
  const marker = join(source_dir, 'main-wrote-marker');
  const legacy = `from pathlib import Path\ndef main():\n    Path(${JSON.stringify(marker)}).write_text('mutated')\nif __name__ == '__main__':\n    main()\n`;
  await writeFile(script, legacy);
  const runHostCapture = async (command, args, options) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxCapture });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const runtime = deps({ selfUpdateInstalled: async () => ({ configured: true, source_dir }), runHostCapture });
  assert.deepEqual(await readCaddyLogProof(runtime), failure());
  await assert.rejects(access(marker), { code: 'ENOENT' });
  await writeFile(script, `${legacy}\nimport json\ndef active_proof_cli(args):\n    assert args == [${JSON.stringify(domain)}]\n    print(${JSON.stringify(JSON.stringify(proof()))})\n    return 0\n`);
  assert.deepEqual(await readCaddyLogProof(runtime), proof());
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
