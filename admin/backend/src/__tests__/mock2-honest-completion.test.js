// Honest completion is always reachable, and the build can never loop:
//   A. a VERIFIED empty-diff, code-less chore finishes without a red test and
//      without reclassifying to bugfix (the verified empty-diff rule);
//   B. a reproduce-first waiver is applied at the real enforcement layer
//      (acceptanceVerdict) and recorded — never merely narrated;
//   C. "no work remaining" terminates: consecutive completed no-op cycles for
//      the same instruction refuse a further empty cycle with a calm message;
//   D/E. a credential-gated integration (real transport, live check deferred to
//      the operator) reaches pending-operator-verification — never a block, and
//      never a demand for a fabricated live test; a malformed manifest has a
//      self-healing repair plan; an operator "it failed" report becomes a REAL
//      bug-fix instruction with a defect to reproduce.
// Pure-layer only (native-free, stub-first — risk R9).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceVerdict, acceptanceRecord, codeChangedFiles, classifyTaskKind, parseAcceptance,
} from '../mock2/acceptance-logic.js';
import {
  cycleWasNoop, consecutiveNoopCycles, noopStartRefusal, NOOP_CYCLE_LIMIT,
} from '../mock2/cycle-logic.js';
import {
  deriveVerificationChecklist, failureBugfixInstruction, verificationTransition,
} from '../mock2/verification-logic.js';
import {
  repairManifestPlan, scaffoldManifestText, parseIntegrationManifest, appendManifestEntry,
  INTEGRATION_MANIFEST_INVALID_PATH, normalizeManifestEntry, MANIFEST_ENTRY_SHAPE_HINT,
} from '../mock2/integration-logic.js';
import { screenDisclosureText, screeningVerdict } from '../mock2/screening-logic.js';
import { evaluateIntegrationTruthfulness } from '../mock2/integration-enforcement.js';
import { buildResumeContextBlock } from '../mock2/unblock-logic.js';

// ---- A. the verified empty-diff rule ----

const choreSpec = parseAcceptance(JSON.stringify({
  task: 'Adopt the ldaps-auth component (idempotent re-run)',
  kind: 'chore',
  tests: [],
  ui: [],
}));

test('codeChangedFiles: state/ bookkeeping is not product code', () => {
  assert.deepEqual(
    codeChangedFiles(['state/acceptance.json', 'state/ui-checks.json', 'src/auth/service.ts', './state/rules.md']),
    ['src/auth/service.ts'],
  );
  assert.deepEqual(codeChangedFiles([]), []);
});

test('empty-diff chore finishes: no red test, no reclassification, even under an eager bugfix instruction', () => {
  // The instruction pattern-matches "bugfix" (the eager classifier), but the
  // orchestrator-verified diff has no product-code change — reproduce-first
  // does not apply and the spec's chore kind stands.
  assert.equal(classifyTaskKind('use the auth component, replacing the broken login'), 'bugfix');
  const v = acceptanceVerdict({
    parsed: choreSpec, instructionKind: 'bugfix', redTestObserved: false,
    changedFiles: ['state/ui-checks.json', 'state/acceptance.json'],
  });
  assert.equal(v.ok, true, v.reasons.join(' | '));
  assert.equal(v.reproduce_first, 'not_required_empty_diff');
});

test('a real code change keeps the strict rule: bugfix without a red test is still rejected', () => {
  const v = acceptanceVerdict({
    parsed: choreSpec, instructionKind: 'bugfix', redTestObserved: false,
    changedFiles: ['src/auth/service.ts'],
  });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /Reproduce-first not demonstrated/);
  assert.match(v.reasons.join(' '), /not "bugfix"/); // reclassification still demanded
});

test('an UNVERIFIED diff (changedFiles null) never relaxes the rule', () => {
  const v = acceptanceVerdict({ parsed: choreSpec, instructionKind: 'bugfix', redTestObserved: false, changedFiles: null });
  assert.equal(v.ok, false);
});

test('acceptanceRecord: a verified no-op is stamped honestly (kind kept, no_op true, basis recorded)', () => {
  const rec = acceptanceRecord({
    spec: choreSpec.spec, instructionKind: 'bugfix', redTestObserved: false,
    changedFiles: ['state/ui-checks.json'], reproduceFirst: 'not_required_empty_diff',
  });
  assert.equal(rec.kind, 'chore');            // the spec's kind stands on an empty diff
  assert.equal(rec.no_op, true);
  assert.equal(rec.code_diff_empty, true);
  assert.equal(rec.red_test_observed, false); // never claims a red test that wasn't observed
  assert.equal(rec.reproduce_first, 'not_required_empty_diff');
  assert.equal(rec.demonstrated, true);
});

// ---- B. the waiver is enforced, not narrated ----

test('reproduce-first waiver: applied at the verdict layer and recorded as waived', () => {
  const bugSpec = parseAcceptance(JSON.stringify({
    task: 'fix the broken bind', kind: 'bugfix', defect_tag: 'defect-ldaps-bind', tests: ['tests/ldaps.repro.test.ts'],
  }));
  const strict = acceptanceVerdict({ parsed: bugSpec, instructionKind: 'bugfix', redTestObserved: false, changedFiles: ['src/ldaps/service.ts'] });
  assert.equal(strict.ok, false);
  const waived = acceptanceVerdict({
    parsed: bugSpec, instructionKind: 'bugfix', redTestObserved: false,
    changedFiles: ['src/ldaps/service.ts'], reproduceFirstWaiver: { rule: 'reproduce_first' },
  });
  assert.equal(waived.ok, true);
  assert.equal(waived.reproduce_first, 'waived_by_operator');
  const rec = acceptanceRecord({
    spec: bugSpec.spec, instructionKind: 'bugfix', redTestObserved: false,
    changedFiles: ['src/ldaps/service.ts'], reproduceFirst: waived.reproduce_first,
  });
  assert.equal(rec.reproduce_first, 'waived_by_operator'); // visible in the record
  assert.equal(rec.demonstrated, true);
});

test('resume block carries the blocked run\'s exact gate findings as guidance', () => {
  const block = buildResumeContextBlock({
    findings: [
      '[integration:error_converted_to_success] src/adp/service.ts#syncWorkers: catches a transport error and returns success',
      '[integration:fabricated_output] src/adp/service.ts#listWorkers: persists data with no reachable transport',
    ],
  });
  assert.match(block, /BLOCKED by the integration gate/);
  assert.match(block, /src\/adp\/service\.ts#syncWorkers/);
  assert.match(block, /Resolve EACH one/);
  assert.match(block, /never convert an error into success/);
  // Findings alone are enough to produce a resume block (a bare resume of a
  // gate-blocked cycle still gets the list).
  assert.notEqual(block, '');
});

test('resume block names an enforced waiver as in effect (never a bare narration)', () => {
  const block = buildResumeContextBlock({ waivers: [{ rule: 'reproduce_first' }] });
  assert.match(block, /Enforced waivers/);
  assert.match(block, /reproduce_first/);
  assert.match(block, /applied at the finish gate/i);
  // No waiver → no waiver line can appear.
  assert.equal(buildResumeContextBlock({}), '');
});

// ---- C. no-op loop termination ----

const noopCycle = (instruction, over = {}) => ({
  instruction, status: 'succeeded',
  acceptance_json: JSON.stringify({ no_op: true, code_diff_empty: true }),
  ...over,
});

test('cycleWasNoop: success-family terminal + orchestrator-stamped empty diff', () => {
  assert.equal(cycleWasNoop(noopCycle('adopt x')), true);
  assert.equal(cycleWasNoop(noopCycle('adopt x', { status: 'awaiting_user', verification_state: 'pending' })), true);
  assert.equal(cycleWasNoop(noopCycle('adopt x', { status: 'awaiting_admin' })), false); // blocked ≠ no-op
  assert.equal(cycleWasNoop({ instruction: 'adopt x', status: 'succeeded', acceptance_json: JSON.stringify({ no_op: false }) }), false);
  assert.equal(cycleWasNoop({ instruction: 'adopt x', status: 'succeeded' }), false); // no stamp → not a no-op
});

test('consecutiveNoopCycles: counts the trailing same-instruction run only', () => {
  const rows = [
    noopCycle('adopt x'),
    noopCycle('adopt x'),
    { instruction: 'adopt x', status: 'awaiting_admin', acceptance_json: null }, // breaks the run
    noopCycle('adopt x'),
  ];
  assert.equal(consecutiveNoopCycles(rows, 'adopt x'), 2);
  assert.equal(consecutiveNoopCycles(rows, 'something else'), 0);
  assert.equal(consecutiveNoopCycles([noopCycle('other'), ...rows], 'adopt x'), 0); // newest cycle is different work
});

test('consecutiveNoopCycles: same-instruction define (audit) cycles are transparent', () => {
  // The real interleaving: every build is preceded by a stage-define audit
  // cycle with the SAME instruction (succeeded, no acceptance stamp). It must
  // not break the run — otherwise the cap could never trip.
  const define = { instruction: 'adopt x', stage: 'define', status: 'succeeded', acceptance_json: null };
  const rows = [
    define, noopCycle('adopt x', { stage: 'build' }),
    define, noopCycle('adopt x', { stage: 'build' }),
  ];
  assert.equal(consecutiveNoopCycles(rows, 'adopt x'), 2);
  assert.equal(noopStartRefusal({ priorCycles: rows, instruction: 'adopt x' }).refuse, true);
});

test('noopStartRefusal: refuses at the cap with a calm terminal message; below the cap it starts', () => {
  const below = noopStartRefusal({ priorCycles: [noopCycle('adopt x')], instruction: 'adopt x' });
  assert.equal(below.refuse, false);
  const at = noopStartRefusal({
    priorCycles: Array.from({ length: NOOP_CYCLE_LIMIT }, () => noopCycle('adopt x')),
    instruction: 'adopt x',
  });
  assert.equal(at.refuse, true);
  assert.match(at.reason, /No work remaining/);
  assert.match(at.reason, /already done/);
});

// ---- D/E. credential-gated integration: honest pending, never a block ----

// A REAL LDAPS transport the fence cannot live-verify: the check performs an
// actual TLS handshake against a destination that comes from configuration
// (declared in the manifest as destination.key LDAPS_URL). No canned success,
// no fixture-in-production, no literal record sets.
const LDAPS_SERVICE = `
import tls from 'node:tls';

export async function checkConnection(cfg) {
  const socket = await ldapsConnect(cfg);
  if (!socket.authorized) throw new Error('TLS not authorized: ' + socket.authorizationError);
  return { ok: true, protocol: socket.getProtocol() };
}

function ldapsConnect(cfg) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(process.env.LDAPS_URL, () => resolve(socket));
    socket.on('error', reject);
  });
}
`;

const LDAPS_MANIFEST = JSON.stringify({
  schema_version: 1,
  entries: [{
    id: 'ldaps-auth',
    subsystem: 'ldaps',
    actions: [{ name: 'bind', operation: 'ldaps-bind' }],
    destination: { source: 'env', key: 'LDAPS_URL' },
    transport: 'ldaps',
    provenance: { response_to_output: 'required' },
    live_verification: { required: true },
    egress: { classification: 'private' },
    contract_test: 'tests/contract/ldaps.contract.test.ts',
  }],
});

const LDAPS_FILES = [
  { path: 'src/ldaps/service.ts', content: LDAPS_SERVICE },
  { path: 'tests/contract/ldaps.contract.test.ts', content: '// contract test against the local fixture server' },
  { path: 'tests/contract/fixture-server.ts', content: '// local TLS fixture' },
];

test('credential-gated integration: declared + real transport + fixture ⇒ pending-operator-verification, not blocked', () => {
  const d = evaluateIntegrationTruthfulness({
    files: LDAPS_FILES,
    manifestText: LDAPS_MANIFEST,
    declaredEgress: [], approvedGrants: [],
    finish: { summary: 'wired ldaps auth', acceptance: ['as admin, open login'], assumptions: { verified: [], assumed: [] } },
    changedFiles: ['src/ldaps/service.ts'],
    fixtureToolingPresent: true,
  });
  assert.equal(d.blocking, false, d.reasons.join(' | '));
  assert.equal(d.outcome, 'pending-operator-verification');
  assert.equal(d.checklist.length, 1);
  const item = d.checklist[0];
  assert.equal(item.item_id, 'ldaps-auth:bind');
  // The operator hand-off: what to supply, how to run it, how to report.
  assert.equal(item.required_config.key, 'LDAPS_URL');
  assert.equal(item.required_config.source, 'env');
  assert.match(item.how_to_verify, /LDAPS_URL/);
  assert.match(item.report, /confirm|failure/i);
  // The gate never demands a live test: the checklist is a deferral, and no
  // finding asks for one.
  assert.equal(d.gate.verdict, 'pass');
});

test('the same integration UNDECLARED (no manifest) still blocks — pending never legitimizes an undeclared capability', () => {
  const d = evaluateIntegrationTruthfulness({
    files: LDAPS_FILES, manifestText: '', declaredEgress: [], approvedGrants: [],
    finish: { summary: 'wired ldaps auth', acceptance: [], assumptions: null },
    changedFiles: ['src/ldaps/service.ts'], fixtureToolingPresent: true,
  });
  assert.equal(d.blocking, true);
  assert.ok(d.gate.findings.some((f) => f.kind === 'undeclared_integration'));
});

test('verificationTransition: pending → succeeded on all-confirmed, → building on a live-check failure', () => {
  assert.deepEqual(
    verificationTransition({ state: 'pending-operator-verification', event: 'all_items_confirmed' }),
    { ok: true, next: 'succeeded' },
  );
  assert.deepEqual(
    verificationTransition({ state: 'pending-operator-verification', event: 'live_check_failed' }),
    { ok: true, next: 'building' },
  );
});

// ---- (iii) operator "it failed" ⇒ a REAL bug-fix cycle ----

test('failureBugfixInstruction: carries the observation and classifies as a bug fix', () => {
  const item = { item_id: 'ldaps-auth:bind', manifest_id: 'ldaps-auth', action: 'bind', operation: 'ldaps-bind', subsystem: 'ldaps' };
  const instr = failureBugfixInstruction({ item, observed: 'bind rejected: invalid DN syntax for CN=svc,OU=x' });
  assert.match(instr, /bind rejected: invalid DN syntax/);
  assert.match(instr, /ldaps-auth/);
  assert.match(instr, /fixture/i); // reproduce against the in-fence fixture
  assert.equal(classifyTaskKind(instr), 'bugfix'); // the new cycle legitimately demands red→green
});

// ---- manifest self-healing (manifest-invalid is no longer a dead end) ----

test('repairManifestPlan: a valid or absent manifest needs no repair', () => {
  assert.equal(repairManifestPlan('').needed, false);
  assert.equal(repairManifestPlan(LDAPS_MANIFEST).needed, false);
});

test('repairManifestPlan: unparseable JSON ⇒ scaffold, archive, nothing silently lost', () => {
  const plan = repairManifestPlan('{ schema_version: 1, entries: [ oops');
  assert.equal(plan.needed, true);
  assert.equal(plan.archive, INTEGRATION_MANIFEST_INVALID_PATH);
  const parsed = parseIntegrationManifest(plan.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.entries.length, 0);
  // The repaired scaffold accepts a backfill (the previous dead end).
  const appended = appendManifestEntry(plan.text, JSON.parse(LDAPS_MANIFEST).entries[0]);
  assert.equal(appended.ok, true);
});

test('repairManifestPlan: salvages individually-valid entries, reports the dropped ones', () => {
  const broken = JSON.stringify({
    schema_version: 99, // invalid version makes the whole manifest unparseable
    entries: [
      JSON.parse(LDAPS_MANIFEST).entries[0],
      { id: 'half-baked' }, // invalid entry
    ],
  });
  const plan = repairManifestPlan(broken);
  assert.equal(plan.needed, true);
  assert.deepEqual(plan.salvaged.map((e) => e.id), ['ldaps-auth']);
  assert.equal(plan.dropped.length, 1);
  assert.equal(plan.dropped[0].id, 'half-baked');
  assert.equal(parseIntegrationManifest(plan.text).ok, true);
});

test('scaffoldManifestText: the self-heal target parses', () => {
  assert.equal(parseIntegrationManifest(scaffoldManifestText()).ok, true);
});

// ---- near-miss manifest migration (the observed five-cycle loop) ----

// The exact wrong shape a real build kept writing: entries keyed on
// key/name/destinations/code instead of id/subsystem/destination.
const WRONG_SHAPE_MANIFEST = JSON.stringify({
  schema_version: 1,
  entries: [
    {
      key: 'adp-workforce-now',
      name: 'ADP Workforce Now',
      destinations: ['env:ADP_TOKEN_URL', 'env:ADP_API_URL'],
      code: ['src/adp/transport.ts', 'src/adp/service.ts'],
      transport: 'https-mtls',
      contract_test: 'tests/contract/adp.contract.test.ts',
    },
    {
      key: 'ldaps-directory',
      destinations: [{ source: 'env', key: 'LDAPS_URL' }],
      code: ['src/ldaps/client.ts'],
      protocol: 'ldaps',
    },
  ],
});

test('normalizeManifestEntry: migrates the observed wrong shape into a valid entry', () => {
  const raw = JSON.parse(WRONG_SHAPE_MANIFEST).entries[0];
  const n = normalizeManifestEntry(raw);
  assert.equal(n.ok, true, n.error);
  assert.equal(n.entry.id, 'adp-workforce-now');            // from `key`
  assert.equal(n.entry.subsystem, 'adp');                   // from the `code` paths
  assert.deepEqual(n.entry.destination, { source: 'env', key: 'ADP_TOKEN_URL' }); // first of `destinations`
  assert.equal(n.entry.transport, 'https-mtls');
  assert.equal(n.entry.live_verification.required, true);   // strict default
  assert.equal(n.entry.contract_test, 'tests/contract/adp.contract.test.ts');
  assert.ok(n.inferred.length >= 3);                        // every inference reported
  // An already-valid entry passes through untouched.
  const valid = JSON.parse(LDAPS_MANIFEST).entries[0];
  assert.deepEqual(normalizeManifestEntry(valid).inferred, []);
});

test('repairManifestPlan: MIGRATES near-miss entries instead of dropping them', () => {
  const plan = repairManifestPlan(WRONG_SHAPE_MANIFEST);
  assert.equal(plan.needed, true);
  assert.match(plan.error, /needs a string id/);
  assert.match(plan.error, /required entry shape/); // the actionable hint rides the error
  assert.deepEqual(plan.salvaged.map((e) => e.id), ['adp-workforce-now', 'ldaps-directory']);
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.migrated.length, 2);
  const repaired = parseIntegrationManifest(plan.text);
  assert.equal(repaired.ok, true);
  // The migrated LDAPS entry kept its declared destination and protocol.
  const ldaps = repaired.manifest.entries.find((e) => e.id === 'ldaps-directory');
  assert.deepEqual(ldaps.destination, { source: 'env', key: 'LDAPS_URL' });
  assert.equal(ldaps.transport, 'ldaps');
});

test('parseIntegrationManifest: validation errors carry the exact required shape', () => {
  const p = parseIntegrationManifest(WRONG_SHAPE_MANIFEST);
  assert.equal(p.ok, false);
  assert.match(p.error, /`key`, `name`, `destinations`, or `code` do NOT validate/);
  assert.equal(MANIFEST_ENTRY_SHAPE_HINT.includes('"id"'), true);
});

// ---- disclosure screening: guard descriptions are not disclosures ----

test('screening: describing an anti-simulation GUARD does not block', () => {
  // The real finish language that inflated the finding count for five cycles.
  const { findings } = screenDisclosureText([
    { source: 'finish.summary', text: 'Added a no-simulation guard that fails if anyone hardcodes a fake roster; contract tests drive the transport against a real local TLS fixture.' },
    { source: 'finish.acceptance', text: 'as admin, run Test Connection — the check rejects stubbed transports and performs the real mTLS handshake' },
  ]);
  const verdict = screeningVerdict(findings);
  assert.equal(verdict.blocking, false, JSON.stringify(verdict.candidates));
  assert.ok(verdict.recorded.length > 0); // still recorded, never silently dropped
});

test('screening: a REAL simulation disclosure still blocks', () => {
  const { findings } = screenDisclosureText([
    { source: 'finish.summary', text: 'The connection test is simulated because the ADP endpoint is unreachable from the fence; the roster returns canned data.' },
  ]);
  const verdict = screeningVerdict(findings);
  assert.equal(verdict.blocking, true);
});

test('screening: a bare ambiguous term with no guard context still blocks as before', () => {
  const { findings } = screenDisclosureText([
    { source: 'finish.summary', text: 'Employee list is populated from sample data for now.' },
  ]);
  assert.equal(screeningVerdict(findings).blocking, true);
});
