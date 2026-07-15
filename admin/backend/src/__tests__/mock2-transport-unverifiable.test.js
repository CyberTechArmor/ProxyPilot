// Live-unverifiable-in-fence downgrade (harness completion fix). An app whose
// whole purpose is an external integration (LDAPS/mTLS) can never get a "live
// connection succeeded" inside the sealed, default-deny build fence — there is no
// route to the endpoint. Before this, real transport code the single-file
// analyzer could not statically prove reaches its call FAILED CLOSED as
// `execution_without_transport` and hard-blocked the cycle, with no honest escape
// (the only options were re-implement or mislabel it a simulation) — the observed
// blocked/cycle loop. This asserts the honesty-preserving downgrade: real +
// declared-for-live-verification transport routes to pending-operator-verification
// (a human runs the live check), while a genuine fake still blocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeIntegrations, SOFT_INTEGRATION_FINDING_KINDS,
} from '../mock2/integration-logic.js';
import { evaluateIntegrationTruthfulness } from '../mock2/integration-enforcement.js';
import { CONFIG_MODULE, toFiles } from './fixtures/integration-fixtures.js';

// A minimal, fully-declared live integration: one connectivity action, declared
// for live operator verification, no contract_test file required, private egress.
// Purpose-built so the ONLY finding in play is the transport-reachability one —
// the downgrade under test isn't masked by contract_test_missing / egress checks.
const MANIFEST_LIVE = JSON.stringify({
  schema_version: 1,
  entries: [{
    id: 'directory',
    subsystem: 'people',
    actions: [{ name: 'probe', operation: 'ldaps-bind' }],
    destination: { source: 'config', key: 'directory.url' },
    transport: 'ldaps',
    provenance: { response_to_output: 'required' },
    live_verification: { required: true },
    egress: { classification: 'private' },
  }],
});

// A REAL directory probe: its file imports the `ldapts` client library, but the
// bind runs through a runtime-resolved handler (dynamic dispatch) the single-file
// call graph cannot trace to the check function — exactly the cross-module /
// dynamic case the analyzer fails closed on. Success is derived from the operation
// result, not config-field presence.
const REAL_UNTRACEABLE_LDAPS = {
  'src/people/connection.ts': `
import { Client } from 'ldapts';
import { getProviderConfig } from './config';

const handlers = { default: (c, cfg) => c.op(cfg) };

export async function probeDirectory(cfg) {
  const client = new Client({ url: cfg.url });
  const op = handlers[cfg?.mode || 'default'];
  const res = await op(client, cfg);
  return { ok: res.connected, took: res.ms };
}
`,
};

// A genuine FAKE: no transport library imported, success derived purely from
// config-field presence. Must stay blocking.
const PRESENCE_ONLY_FAKE = {
  'src/people/connection.ts': `
import { getProviderConfig } from './config';

export async function probeDirectory() {
  const cfg = await getProviderConfig();
  if (!cfg?.clientId || !cfg?.privateKey) return { ok: false };
  return { ok: true, status: 'passed' };
}
`,
};

const run = (fileMap) => analyzeIntegrations({ files: toFiles(CONFIG_MODULE, fileMap), manifest: JSON.parse(MANIFEST_LIVE) });
const evaluate = (fileMap) => evaluateIntegrationTruthfulness({
  files: toFiles(CONFIG_MODULE, fileMap),
  manifestText: MANIFEST_LIVE,
  changedFiles: Object.keys(fileMap),
  finish: { summary: 'real ldaps probe', acceptance: ['as admin, run Test connection against the directory'], assumptions: { verified: [], assumed: [] } },
});

test('real transport lib + declared live-verification but untraceable call → NON-blocking soft finding', () => {
  const r = run(REAL_UNTRACEABLE_LDAPS);
  const soft = r.findings.filter((f) => f.kind === 'transport_unverifiable_in_fence');
  assert.equal(soft.length, 1, 'emits transport_unverifiable_in_fence');
  assert.equal(soft[0].subsystem, 'people');
  assert.ok(!r.findings.some((f) => f.kind === 'execution_without_transport'), 'not the hard-block kind');
  assert.ok(SOFT_INTEGRATION_FINDING_KINDS.includes('transport_unverifiable_in_fence'));
});

test('soft finding routes the cycle to pending-operator-verification, not a block', () => {
  const d = evaluate(REAL_UNTRACEABLE_LDAPS);
  assert.equal(d.blocking, false, 'does not block');
  assert.equal(d.outcome, 'pending-operator-verification');
  assert.equal(d.gate.verdict, 'pass', 'no blocking gate findings');
  assert.equal(d.pending_findings.length, 1);
  assert.ok(d.checklist.length >= 1, 'hands the operator a live check');
});

test('genuine presence-only fake still hard-blocks (honesty preserved)', () => {
  const r = run(PRESENCE_ONLY_FAKE);
  assert.ok(r.findings.some((f) => f.kind === 'execution_without_transport'), 'stays the hard-block kind');
  assert.ok(!r.findings.some((f) => f.kind === 'transport_unverifiable_in_fence'), 'not downgraded');
  const d = evaluate(PRESENCE_ONLY_FAKE);
  assert.equal(d.blocking, true);
  assert.equal(d.outcome, 'blocked-deviation');
});
