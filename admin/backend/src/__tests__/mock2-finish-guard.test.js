// FINISH-HANDSHAKE GUARD — request 141's failure, fixed at the layer it happened.
//
// THE BUILD THAT CAUSED THIS, from project 47 request 141's log: the model's
// finish tool call was malformed — the summary parameter literally contained
//
//   "…summary text</summary>\n<parameter name=\"acceptance\">[\"as admin, …\"]"
//
// so the harness never received an `acceptance` parameter, rejected with
// "finish requires `acceptance`…" five identical times ($4.75), never showed
// the model what WAS received, then rejected the model's (correct) harness-
// fault halt for lacking resolution options, and stranded a complete tree in
// awaiting_admin. Every fixture below is that log's shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINISH_REJECTION_BUDGET, TOOL_SYNTAX_FRAGMENTS,
  malformedFinishInput, malformedRejectionMessage, receivedParamsEcho,
  initFinishGuard, recordFinishRejection, escalatedRetryDiagnostic, budgetNote,
  budgetExhaustedSummary, payloadSimilarity, isHarnessFaultHalt, harnessFaultHaltAccepted,
  FINISH_FILE_PATH, parseFinishFile, finishFileHint,
} from '../mock2/finish-guard-logic.js';

// Request 141's payload shape: the whole rest of the call serialized into summary.
const REQUEST_141_PAYLOAD = {
  summary: 'Added the notes list with search and the admin settings link.</summary>\n'
    + '<parameter name="acceptance">["as admin, open the notes list, type in search — the list filters"]</parameter>\n'
    + '<parameter name="assumptions">{"verified":[],"assumed":[]}</parameter>',
};

/* ----------------------- malformed-call detection ------------------------ */

test('request 141 payload is detected as malformed, naming param and fragment', () => {
  const hit = malformedFinishInput(REQUEST_141_PAYLOAD);
  assert.equal(hit.malformed, true);
  assert.equal(hit.param, 'summary');
  assert.equal(hit.fragment, '</summary>');
  assert.ok(hit.where.includes('</summary>'));
});

test('each syntax fragment is detected on its own', () => {
  for (const frag of TOOL_SYNTAX_FRAGMENTS) {
    const hit = malformedFinishInput({ summary: `fine text ${frag} more` });
    assert.equal(hit.malformed, true, frag);
    assert.equal(hit.fragment, frag);
  }
});

test('fragments nested in acceptance[] and assumptions are found', () => {
  const inArray = malformedFinishInput({ summary: 'ok', acceptance: ['fine', 'bad </parameter> here'] });
  assert.equal(inArray.malformed, true);
  assert.equal(inArray.param, 'acceptance[1]');
  const inObj = malformedFinishInput({ summary: 'ok', assumptions: { verified: ['<parameter name="x">'], assumed: [] } });
  assert.equal(inObj.malformed, true);
});

test('a clean payload is not malformed — including XML-ish prose that is not tool syntax', () => {
  assert.equal(malformedFinishInput({
    summary: 'Rendered <section data-screen="Notes"> per the mockup; added a <select> for status.',
    acceptance: ['as admin, open /, expect the notes grid'],
    assumptions: { verified: ['src/app.ts mounts notesRoutes last'], assumed: [] },
  }).malformed, false);
});

test('the malformed rejection quotes the fragment, its location, and echoes received params', () => {
  const hit = malformedFinishInput(REQUEST_141_PAYLOAD);
  const msg = malformedRejectionMessage(hit, REQUEST_141_PAYLOAD);
  assert.ok(msg.includes('MALFORMED'));
  assert.ok(msg.includes('</summary>'));
  assert.ok(msg.includes('summary'));
  assert.ok(msg.includes('Parameters the harness received'));
  assert.ok(msg.includes('Missing or empty: acceptance, assumptions'));
});

/* -------------------------- received-params echo ------------------------- */

test('echo lists every received param with a ≤120-char snippet and names the missing ones', () => {
  const echo = receivedParamsEcho({ summary: 'x'.repeat(500), acceptance: [] });
  assert.ok(echo.includes('- summary: "'));
  assert.ok(/x{120}…/.test(echo)); // truncated at 120
  assert.ok(echo.includes('- acceptance: (empty)'));
  assert.ok(echo.includes('Missing or empty: acceptance, assumptions'));
});

test('echo on an empty call says so instead of listing nothing', () => {
  assert.ok(receivedParamsEcho({}).includes('none — the call carried no parameters at all'));
});

/* ------------------ identical-retry detection + budget ------------------- */

test('an identical retry is flagged and charged once, not twice', () => {
  let s = initFinishGuard();
  let r = recordFinishRejection(s, { validator: 'acceptance-present', input: REQUEST_141_PAYLOAD });
  assert.equal(r.identicalRepeat, false);
  assert.equal(r.count, 1);
  r = recordFinishRejection(r.state, { validator: 'acceptance-present', input: REQUEST_141_PAYLOAD });
  assert.equal(r.identicalRepeat, true);
  assert.equal(r.count, 1); // still one charged
});

test('a near-identical retry (light rewording) is also flagged', () => {
  const a = { summary: 'Added the notes list with search and admin settings link plus filtering behavior for the list view' };
  const b = { summary: 'Added the notes list with search and admin settings link plus filtering behavior for the list views' };
  assert.ok(payloadSimilarity(JSON.stringify(a), JSON.stringify(b)) >= 0.9);
  let r = recordFinishRejection(initFinishGuard(), { input: a });
  r = recordFinishRejection(r.state, { input: b });
  assert.equal(r.identicalRepeat, true);
});

test('a genuinely different payload is a fresh rejection', () => {
  let r = recordFinishRejection(initFinishGuard(), { validator: 'acceptance-present', input: { summary: 'first attempt at the notes list' } });
  r = recordFinishRejection(r.state, { validator: 'summary-overclaim', input: { summary: 'completely reworked payload', acceptance: ['as admin, do X, expect Y'], assumptions: { verified: [], assumed: [] } } });
  assert.equal(r.identicalRepeat, false);
  assert.equal(r.count, 2);
});

test('the budget is SHARED across validators and exhausts after N real rejections', () => {
  let r = recordFinishRejection(initFinishGuard(), { validator: 'acceptance-present', input: { summary: 'attempt one entirely' } });
  assert.equal(r.exhausted, false);
  r = recordFinishRejection(r.state, { validator: 'summary-overclaim', input: { summary: 'a second very different payload with other words' } });
  assert.equal(r.exhausted, false);
  r = recordFinishRejection(r.state, { validator: 'removal-claims', input: { summary: 'third try, again completely reworded from scratch' } });
  assert.equal(r.exhausted, false);
  assert.equal(r.count, FINISH_REJECTION_BUDGET);
  r = recordFinishRejection(r.state, { validator: 'action-parity', input: { summary: 'fourth distinct payload wording once more anew' } });
  assert.equal(r.exhausted, true);
});

test('three identical payloads exhaust regardless of the charged count (the 141 loop cannot run five times)', () => {
  let r = recordFinishRejection(initFinishGuard(), { input: REQUEST_141_PAYLOAD });
  r = recordFinishRejection(r.state, { input: REQUEST_141_PAYLOAD });
  assert.equal(r.exhausted, false); // escalated diagnostic goes out here
  r = recordFinishRejection(r.state, { input: REQUEST_141_PAYLOAD });
  assert.equal(r.exhausted, true);
});

test('the escalated diagnostic names the malformed-call cause for the 141 shape', () => {
  const msg = escalatedRetryDiagnostic({ validator: 'acceptance-present', input: REQUEST_141_PAYLOAD });
  assert.ok(msg.includes('IDENTICAL'));
  assert.ok(msg.includes('</summary>'));
  assert.ok(msg.includes('serialized wrong'));
  assert.ok(msg.includes('halt'));
});

test('budgetNote states the position against the budget', () => {
  assert.ok(budgetNote(2).includes(`2 of ${FINISH_REJECTION_BUDGET}`));
});

/* ---------------------- budget-exhaustion conclusion --------------------- */

test('the exhaustion summary names validators, identical retries, and the checkpoint', () => {
  const msg = budgetExhaustedSummary({
    history: [
      { validator: 'acceptance-present', identical: false },
      { validator: 'acceptance-present', identical: true },
      { validator: 'acceptance-present', identical: true },
    ],
    finishSummary: 'Added the notes list.',
    changedFiles: ['public/app.html', 'public/n7.js'],
  });
  assert.ok(msg.includes('rejection budget'));
  assert.ok(msg.includes('acceptance-present'));
  assert.ok(msg.includes('CHECKPOINTED'));
  assert.ok(msg.includes('public/app.html'));
  assert.ok(msg.includes('Deploy'));
});

/* ------------------------- harness-fault halts --------------------------- */

test('a halt asserting a harness fault after rejections is accepted', () => {
  const reason = 'The finish tool keeps rejecting my payload with "missing acceptance" although I am sending the acceptance parameter — I believe the harness parser is at fault. Payload and rejection quoted verbatim above.';
  assert.equal(isHarnessFaultHalt(reason), true);
  assert.equal(harnessFaultHaltAccepted({ reason, rejectionTotal: 5 }), true);
});

test('a harness-fault claim with NO rejection history is not auto-accepted', () => {
  assert.equal(harnessFaultHaltAccepted({ reason: 'the harness validator rejected me wrongly', rejectionTotal: 0 }), false);
});

test('an ordinary blocked halt is not a harness-fault halt', () => {
  assert.equal(isHarnessFaultHalt('blocked: the external ADP endpoint needs credentials I do not have'), false);
});

// ---- the file-based fallback (P47 cycle 587: emission flakiness) ----

test('parseFinishFile: a well-formed file yields every usable field', () => {
  const r = parseFinishFile(JSON.stringify({
    summary: 'Verified all findings already implemented — no code changes needed.',
    acceptance: ['as admin, open /admin at 390px — user rows render as stacked cards'],
    assumptions: { verified: ['public/admin.js — aria-labels present'], assumed: [] },
    acceptance_ids: ['notes-header-aligned'],
    removals: [{ what: 'the leaked helper copy', check_id: 'notes-header-aligned' }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.fields.acceptance.length, 1);
  assert.deepEqual(r.fields.assumptions.assumed, []);
  assert.deepEqual(r.fields.acceptance_ids, ['notes-header-aligned']);
});

test('parseFinishFile: malformed JSON, wrong shapes, and empty docs are named errors', () => {
  assert.equal(parseFinishFile('not json').ok, false);
  assert.equal(parseFinishFile('[1,2]').ok, false);
  const empty = parseFinishFile('{}');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no usable finish fields/);
  // A bad assumptions shape is simply not taken; other fields still are.
  const partial = parseFinishFile(JSON.stringify({ summary: 'x', assumptions: { verified: 'nope' } }));
  assert.equal(partial.ok, true);
  assert.equal(partial.fields.assumptions, undefined);
  assert.equal(partial.fields.summary, 'x');
});

test('the malformed rejection and the escalated diagnostic both teach the file fallback', () => {
  const hit = malformedFinishInput({ summary: 'done.</summary>\n<parameter name="acceptance">[…]' });
  assert.equal(hit.malformed, true);
  assert.match(malformedRejectionMessage(hit, { summary: 'x' }), new RegExp(FINISH_FILE_PATH.replace('/', '\\/')));
  assert.match(escalatedRetryDiagnostic({ validator: 'malformed-call', input: { summary: 'x' } }), /finish\.json/);
  assert.match(finishFileHint(), /reads that file as the call/);
});
