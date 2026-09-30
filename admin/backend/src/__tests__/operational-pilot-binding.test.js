import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentRunsWorld, ORIGIN } from './helpers/agent-runs-world.js';
import { importPilotBinding } from '../lib/operational-pilot-binding.js';

function fixture() {
  const w = agentRunsWorld({ bind: false });
  const binding = { binding_id: randomUUID(), project_id: w.p.id, profile_id: w.profile.id,
    origin: ORIGIN, username: 'a4-fixture@demo.fractionate.ai', revision: 1, state: 'active',
    vault: { mount: 'pp-kv', path: 'agents/a4-broker/a4-fixture-password', key: 'a4-fixture-password', version: 1 } };
  const expected = { binding_id: binding.binding_id, project_id: w.p.id, profile_id: w.profile.id };
  return { w, binding, expected };
}

test('A8 enrollment imports only fresh broker metadata, is audited and idempotent; creates no run or consent', () => {
  const { w, binding, expected } = fixture();
  try {
    const first = importPilotBinding(w.f.db, w.users.owner.id, expected, binding);
    assert.deepEqual(first, { changed: true, binding_id: binding.binding_id, revision: 1 });
    assert.equal(importPilotBinding(w.f.db, w.users.owner.id, expected, binding).changed, false);
    const projected = { ...binding, vault: { mount: binding.vault.mount, path: binding.vault.path, version: binding.vault.version } };
    assert.equal(importPilotBinding(w.f.db, w.users.owner.id, expected, projected).changed, false);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_credential_binding_events').get().n, 1);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_runs').get().n, 0);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_run_approvals').get().n, 0);
    assert.deepEqual(w.bindings.get(binding.binding_id).vault,
      { mount: binding.vault.mount, path: binding.vault.path, version: binding.vault.version });
    assert.equal(w.f.db.prepare('SELECT model_summary_consent FROM ops_agent_profiles WHERE id=?').get(w.profile.id).model_summary_consent, 0);
  } finally { w.f.close(); }
});

test('A8 enrollment refuses wrong identity, revoked/rotated state, extra fields, nonowners and second bindings', () => {
  const { w, binding, expected } = fixture();
  try {
    for (const update of [{ project_id: randomUUID() }, { profile_id: randomUUID() }, { binding_id: randomUUID() },
      { state: 'revoked' }, { revision: 2 }, { origin: 'https://example.com' }, { value: 'never-store-this' },
      { vault: { ...binding.vault, value: 'never-store-this' } },
      { vault: { ...binding.vault, key: 'openai-api-key' } },
      { vault: { ...binding.vault, key: '../a4-fixture-password' } },
      { vault: { ...binding.vault, key: 'a4-fixture-password\n', path: binding.vault.path + '\n' } }])
      assert.throws(() => importPilotBinding(w.f.db, w.users.owner.id, expected, { ...binding, ...update }), { code: 'BINDING_MISMATCH' });
    assert.throws(() => importPilotBinding(w.f.db, w.users.operator.id, expected, binding), { code: 'FORBIDDEN' });
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_credential_bindings').get().n, 0);
    importPilotBinding(w.f.db, w.users.owner.id, expected, binding);
    const second = { ...binding, binding_id: randomUUID() };
    assert.throws(() => importPilotBinding(w.f.db, w.users.owner.id, { ...expected, binding_id: second.binding_id }, second), { code: 'BINDING_EXISTS' });
  } finally { w.f.close(); }
});

const python = spawnSync('python3', ['--version']).status === 0;
test('A8 enrollment accepts the real A4 bind and bindings projection, without a vault value read', { skip: !python }, () => {
  const { w, binding, expected } = fixture();
  try {
    const script = `
import importlib.util, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('a8_broker_reference', sys.argv[1])
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
vault = SimpleNamespace(config={'kv_mount': 'pp-kv', 'agent': 'a4-broker'}, current_version=lambda key: 1)
vault.path = lambda key: b.Vault.path(vault, key)
with tempfile.TemporaryDirectory() as directory:
    broker = b.Broker(vault=vault, journal=Path(directory) / 'state.json')
    broker._save = lambda: None
    created = broker.bind(json.loads(sys.argv[2]))
    assert created == broker.bindings()['bindings'][0]
    print(json.dumps(created))
`;
    const reference = JSON.parse(execFileSync('python3', ['-c', script,
      fileURLToPath(new URL('../../../../scripts/a4-credential-broker.py', import.meta.url)),
      JSON.stringify({ ...expected, username: binding.username, vault_key: binding.vault.key })], { encoding: 'utf8' }));
    assert.equal(reference.vault.key, binding.vault.key);
    assert.equal(importPilotBinding(w.f.db, w.users.owner.id, expected, reference).changed, true);
    assert.equal(importPilotBinding(w.f.db, w.users.owner.id, expected, reference).changed, false);
    assert.deepEqual(w.bindings.get(binding.binding_id).vault,
      { mount: reference.vault.mount, path: reference.vault.path, version: reference.vault.version });
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_credential_binding_events').get().n, 1);
  } finally { w.f.close(); }
});
