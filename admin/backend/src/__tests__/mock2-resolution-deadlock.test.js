// PATCH Part A — REPRODUCE FIRST: the blocked-deviation resolution DEADLOCK.
//
// These tests run against the CURRENT harness modules (integration-enforcement.js
// + integration-logic.js both exist at 0948d04) — they are BEHAVIORAL reds, not
// missing-module errors. Each asserts the DESIRED post-patch behavior, so it is
// RED now (the deadlock) and turns GREEN once Part B lands.
//
// Reproduced conditions (from ADP3, observed in production):
//   A.1 undeclared findings + no manifest → every offered option leaves the
//       manifest empty → re-scan reproduces identical findings → loop.
//   A.2 real code the conservative analyzer cannot prove (unsupported language)
//       → provenance_not_established, but no offered option can legitimately
//       clear it (only mislabel-as-simulation or loop).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateIntegrationTruthfulness, blockingSummary,
} from '../mock2/integration-enforcement.js';
import { appendManifestEntry } from '../mock2/integration-logic.js';
import {
  MANIFEST_EMPTY, CONFIG_MODULE, toFiles, EVASION_UNDECLARED,
} from './fixtures/integration-fixtures.js';

// An ADP3-shaped tree: two outbound integrations, NO manifest entries. Reuses the
// existing undeclared fixture plus a second dialing subsystem so the loop is
// visible over multiple undeclared capabilities.
const ADP3_FILES = toFiles(EVASION_UNDECLARED, {
  'src/directory/service.ts': `
export async function authenticate(user, pass) {
  const res = await fetch('https://directory.example.com/bind', { method: 'POST', body: JSON.stringify({ user, pass }) });
  return { ok: res.ok };
}
`,
});

// An honest-but-unprovable integration: the manifest declares it, but the
// implementation is in a language the analyzer does not support (a polyglot
// service). The analyzer correctly FAILS CLOSED with provenance_not_established —
// the code may be perfectly real, the analyzer simply cannot prove it.
const UNPROVABLE_MANIFEST = JSON.stringify({
  schema_version: 1,
  entries: [{
    id: 'directory-provider', subsystem: 'directory',
    actions: [{ name: 'sync', operation: 'fetch-and-persist' }],
    destination: { source: 'db-config', key: 'directory.url' },
    transport: 'ldaps', provenance: { response_to_output: 'required' },
    live_verification: { required: true }, egress: { classification: 'private' },
  }],
}, null, 2);
const UNPROVABLE_FILES = toFiles({
  // Real transport, but in Python — outside the analyzer's supported languages.
  'src/directory/service.py': 'import ldap3\n\ndef sync():\n    conn = ldap3.Connection("ldaps://dir.example.com")\n    conn.search(...)\n    return conn.entries\n',
});

// ---- A.1: the undeclared deadlock ----

test('A.1 (RED): ADP3 undeclared findings block, and the re-scan reproduces them identically (loop)', () => {
  const rec = evaluateIntegrationTruthfulness({ files: ADP3_FILES, manifestText: '' });
  assert.equal(rec.outcome, 'blocked-deviation');
  const undeclared = rec.gate.findings.filter((f) => f.kind === 'undeclared_integration');
  assert.ok(undeclared.length >= 2, `expected ≥2 undeclared findings, got ${undeclared.length}`);

  // The loop, literally: nothing in the offered options changes the manifest, so
  // re-running the gate against the same (empty) manifest yields identical findings.
  const rescan = evaluateIntegrationTruthfulness({ files: ADP3_FILES, manifestText: '' });
  assert.deepEqual(
    rescan.gate.findings.map((f) => f.kind).sort(),
    rec.gate.findings.map((f) => f.kind).sort(),
    'the re-scan must reproduce the identical finding set (this IS the loop)',
  );
});

test('A.1 (RED): a blocked undeclared capability must offer a manifest-backfill resolution', () => {
  const rec = evaluateIntegrationTruthfulness({ files: ADP3_FILES, manifestText: '' });
  const summary = blockingSummary(rec);
  // DESIRED behavior (fails now): at least one offered option can create/declare
  // a manifest entry, which is the ONLY thing that clears an `undeclared` finding.
  const canDeclare = summary.options.some((o) =>
    (Array.isArray(o.resolves) && o.resolves.includes('undeclared'))
    || /manifest|declare it/i.test(`${o.label} ${o.detail}`));
  assert.ok(canDeclare, 'no offered resolution can create a manifest entry — the undeclared blocker is a deadlock by construction');
});

// ---- A.2: the waiver gap ----

test('A.2 (RED): unprovable-but-real code yields provenance_not_established with no clearing option', () => {
  const rec = evaluateIntegrationTruthfulness({ files: UNPROVABLE_FILES, manifestText: UNPROVABLE_MANIFEST });
  assert.equal(rec.outcome, 'blocked-deviation');
  assert.ok(
    rec.gate.findings.some((f) => f.kind === 'provenance_not_established'),
    'expected the analyzer to fail closed with provenance_not_established',
  );
  const summary = blockingSummary(rec);
  // DESIRED behavior (fails now): an analysis-limitation waiver is offered for the
  // unprovable finding. Currently the only options are implement-real /
  // approve-as-simulation / declare-egress — none legitimately clears real code.
  const hasWaiver = summary.options.some((o) =>
    (Array.isArray(o.resolves) && o.resolves.includes('provenance-not-established'))
    || /waiv|analysis limitation|confirmed real/i.test(`${o.label} ${o.detail}`));
  assert.ok(hasWaiver, 'no analysis-limitation waiver is offered — real code can only be mislabeled as a simulation or looped');
});

// ---- PATCH C.1: applying the backfill actually breaks the loop ----

test('C.1 (GREEN): backfilling a manifest entry clears the undeclared finding — the build progresses instead of looping', () => {
  // Before: undeclared, blocked.
  const before = evaluateIntegrationTruthfulness({ files: ADP3_FILES, manifestText: '' });
  assert.ok(before.gate.findings.some((f) => f.kind === 'undeclared_integration'));

  // Apply the backfill-manifest option for the `notify` subsystem (schema-valid).
  const entry = {
    id: 'notify-webhook', subsystem: 'notify',
    actions: [{ name: 'push', operation: 'http-post' }],
    destination: { source: 'config', key: 'notify.webhookUrl' },
    transport: 'https', provenance: { response_to_output: 'required' },
    live_verification: { required: true }, egress: { classification: 'public' },
  };
  const appended = appendManifestEntry('', entry);
  assert.equal(appended.ok, true);

  // After: the `notify` capability is no longer `undeclared` — it is now a
  // DECLARED integration the gate checks for real provenance. The finding CLASS
  // changed (progress), so the loop breaker's signature differs and the operator
  // is no longer stuck on the same screen.
  const after = evaluateIntegrationTruthfulness({ files: ADP3_FILES, manifestText: appended.text });
  const notifyUndeclaredBefore = before.gate.findings.filter((f) => f.kind === 'undeclared_integration' && /notify/.test(f.file || '')).length;
  const notifyUndeclaredAfter = after.gate.findings.filter((f) => f.kind === 'undeclared_integration' && /notify/.test(f.file || '')).length;
  assert.equal(notifyUndeclaredBefore, 1);
  assert.equal(notifyUndeclaredAfter, 0, 'declaring the capability must clear its undeclared finding');
  assert.notEqual(before.finding_signature, after.finding_signature, 'the finding set changed — this is progress, not a loop');
});

// ---- PATCH C.4: the loop breaker fires on a contrived unresolvable blocker ----

test('C.4 (GREEN): an identical finding set on the 2nd consecutive block is marked resolution-ineffective', () => {
  const rec = evaluateIntegrationTruthfulness({ files: ADP3_FILES, manifestText: '' });
  const sig = rec.finding_signature;
  // First block: no priors → normal blocked-deviation with class-matched options.
  const first = blockingSummary(rec, { priorSignatures: [] });
  assert.notEqual(first.state, 'resolution-ineffective');
  assert.ok(first.options.some((o) => o.id === 'backfill_manifest'));
  // Second consecutive identical block → resolution-ineffective: full findings
  // inline, repeated options suppressed, free-text/admin required.
  const second = blockingSummary(rec, { priorSignatures: [sig] });
  assert.equal(second.state, 'resolution-ineffective');
  assert.ok(second.findings.length >= 2);
  assert.ok(!second.options.some((o) => o.id === 'backfill_manifest'), 'the same options must not be re-offered');
  assert.match(second.requires_resolution, /free-text|admin override/i);
});
