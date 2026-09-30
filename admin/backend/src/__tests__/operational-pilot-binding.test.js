import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentRunsWorld, ORIGIN } from './helpers/agent-runs-world.js';
import { importPilotBinding } from '../lib/operational-pilot-binding.js';

function fixture() {
  const w = agentRunsWorld({ bind: false });
  const binding = { binding_id: randomUUID(), project_id: w.p.id, profile_id: w.profile.id,
    origin: ORIGIN, username: 'a4-fixture@demo.fractionate.ai', revision: 1, state: 'active',
    vault: { mount: 'pp-kv', path: 'agents/a4-broker/a4-fixture-password', version: 1 } };
  const expected = { binding_id: binding.binding_id, project_id: w.p.id, profile_id: w.profile.id };
  return { w, binding, expected };
}

test('A8 enrollment imports only fresh broker metadata, is audited and idempotent; creates no run or consent', () => {
  const { w, binding, expected } = fixture();
  try {
    const first = importPilotBinding(w.f.db, w.users.owner.id, expected, binding);
    assert.deepEqual(first, { changed: true, binding_id: binding.binding_id, revision: 1 });
    assert.equal(importPilotBinding(w.f.db, w.users.owner.id, expected, binding).changed, false);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_credential_binding_events').get().n, 1);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_runs').get().n, 0);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_run_approvals').get().n, 0);
    assert.deepEqual(w.bindings.get(binding.binding_id).vault, binding.vault);
    assert.equal(w.f.db.prepare('SELECT model_summary_consent FROM ops_agent_profiles WHERE id=?').get(w.profile.id).model_summary_consent, 0);
  } finally { w.f.close(); }
});

test('A8 enrollment refuses wrong identity, revoked/rotated state, extra fields, nonowners and second bindings', () => {
  const { w, binding, expected } = fixture();
  try {
    for (const update of [{ project_id: randomUUID() }, { profile_id: randomUUID() }, { binding_id: randomUUID() },
      { state: 'revoked' }, { revision: 2 }, { origin: 'https://example.com' }, { value: 'never-store-this' }])
      assert.throws(() => importPilotBinding(w.f.db, w.users.owner.id, expected, { ...binding, ...update }), { code: 'BINDING_MISMATCH' });
    assert.throws(() => importPilotBinding(w.f.db, w.users.operator.id, expected, binding), { code: 'FORBIDDEN' });
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_credential_bindings').get().n, 0);
    importPilotBinding(w.f.db, w.users.owner.id, expected, binding);
    const second = { ...binding, binding_id: randomUUID() };
    assert.throws(() => importPilotBinding(w.f.db, w.users.owner.id, { ...expected, binding_id: second.binding_id }, second), { code: 'BINDING_EXISTS' });
  } finally { w.f.close(); }
});
