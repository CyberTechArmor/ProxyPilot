// B.6 stub registry — pure severity semantics + work-file context injection.
// Written RED first: no registry of approved simulations existed (AUDIT.md A.4),
// so instruction-scoped cycles never revisited shipped stubs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STUB_SEVERITIES, validateStubEntry, stubBlocksSubsystems, subsystemOfPath,
  touchedSubsystems, stubContextForCycle, stubRuntimeExposure, STUB_SCHEMA_VERSION,
} from '../mock2/stub-logic.js';

const STUBS = [
  {
    id: 1, status: 'open', severity: 'critical', subsystem: 'people',
    file: 'src/people/service.ts', function: 'syncPeople',
    manifest_id: 'directory-provider', reason: 'no live endpoint reachable from the fence',
    approval_ref: 'queue:42',
  },
  {
    id: 2, status: 'open', severity: 'medium', subsystem: 'notify',
    file: 'src/notify/service.ts', function: 'pushAlert',
    manifest_id: null, reason: 'degraded fallback approved for launch',
    approval_ref: 'queue:43',
  },
];

test('severity taxonomy is the four documented levels', () => {
  assert.deepEqual([...STUB_SEVERITIES], ['critical', 'high', 'medium', 'low']);
});

test('validateStubEntry: requires file, reason, approval reference, and a known severity', () => {
  assert.equal(validateStubEntry(STUBS[0]).ok, true);
  assert.equal(validateStubEntry({ ...STUBS[0], severity: 'oops' }).ok, false);
  assert.equal(validateStubEntry({ ...STUBS[0], approval_ref: '' }).ok, false);
  assert.equal(validateStubEntry({ ...STUBS[0], reason: '' }).ok, false);
});

test('critical/high stubs block succeeded on cycles touching the subsystem; medium/low do not', () => {
  assert.equal(stubBlocksSubsystems(STUBS[0], ['people']), true);
  assert.equal(stubBlocksSubsystems(STUBS[0], ['billing']), false);
  assert.equal(stubBlocksSubsystems({ ...STUBS[0], severity: 'high' }, ['people']), true);
  assert.equal(stubBlocksSubsystems(STUBS[1], ['notify']), false); // medium: surfaced, not blocking
  const resolved = { ...STUBS[0], status: 'resolved' };
  assert.equal(stubBlocksSubsystems(resolved, ['people']), false);
});

test('subsystem derivation from changed files', () => {
  assert.equal(subsystemOfPath('src/people/service.ts'), 'people');
  assert.equal(subsystemOfPath('src/notify/routes.ts'), 'notify');
  assert.equal(subsystemOfPath('public/app.js'), null);
  assert.deepEqual(touchedSubsystems(['src/people/a.ts', 'src/people/b.ts', 'src/billing/x.ts', 'README.md']),
    ['people', 'billing']);
});

test('work-file context: unrelated cycle receives the concise global list only', () => {
  const ctx = stubContextForCycle({ stubs: STUBS, subsystems: ['billing'] });
  assert.ok(ctx.global.includes('people'), ctx.global);
  assert.ok(ctx.global.includes('critical'));
  assert.equal(ctx.full.length, 0);
  // Concise: one line per stub, not the full record.
  assert.ok(!ctx.global.includes('queue:42'));
});

test('work-file context: a cycle touching the affected subsystem receives the full registry record', () => {
  const ctx = stubContextForCycle({ stubs: STUBS, subsystems: ['people'] });
  assert.equal(ctx.full.length, 1);
  assert.equal(ctx.full[0].id, 1);
  assert.ok(ctx.block.includes('syncPeople'));
  assert.ok(ctx.block.includes('no live endpoint reachable'));
  assert.ok(ctx.block.includes('remediat') || ctx.block.toLowerCase().includes('replace'));
});

test('resolved stubs drop out of the injected context', () => {
  const ctx = stubContextForCycle({ stubs: STUBS.map((s) => ({ ...s, status: 'resolved' })), subsystems: ['people'] });
  assert.equal(ctx.global, '');
  assert.equal(ctx.full.length, 0);
});

test('runtime exposure for the Run stage: open production simulations, secrets-free', () => {
  const exp = stubRuntimeExposure(STUBS);
  assert.equal(exp.open_count, 2);
  assert.equal(exp.max_severity, 'critical');
  // Secrets-free exposure: subsystem/severity present, approval_ref omitted.
  assert.ok(exp.stubs.every((s) => s.subsystem && s.severity && !('approval_ref' in s)));
  assert.equal(exp.schema_version, STUB_SCHEMA_VERSION);
});
