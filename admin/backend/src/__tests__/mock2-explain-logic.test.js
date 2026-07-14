// "Explain this": the pure wire formats that turn a technical card into a plain-language
// explanation for an operator — the fixed prompt's contract, the user-message assembly,
// the tolerant JSON parse, and the risk normalization. Native-free.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPLAIN_SYSTEM_PROMPT, EXPLAIN_MAX_INPUT_CHARS, RISK_LEVELS,
  buildExplainTranscript, parseExplanation, normalizeRiskLevel,
} from '../mock2/explain-logic.js';

test('EXPLAIN_SYSTEM_PROMPT: forbids jargon and names the five sections + risk', () => {
  const p = EXPLAIN_SYSTEM_PROMPT;
  assert.match(p, /plain language/i);
  assert.match(p, /No jargon|Do NOT use jargon/i);
  assert.match(p, /SQL/); // explicitly forbidden
  for (const key of ['what_happened', 'why_stopped', 'what_asking', 'if_approve', 'if_decline', 'risk_level', 'risk_why']) {
    assert.match(p, new RegExp(key), `prompt should name ${key}`);
  }
});

test('buildExplainTranscript: one user turn with context header + clipped card text', () => {
  const t = buildExplainTranscript({
    text: 'DELETE FROM users WHERE email = \'seed@test\' -- md5 a1b2, §4.2, ts 2026-07-14',
    title: 'Add first-run setup', status: 'blocked', kind: 'authorization',
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].role, 'user');
  assert.match(t[0].text, /Add first-run setup/);
  assert.match(t[0].text, /Current build status: blocked/);
  assert.match(t[0].text, /request for one-time permission/); // kind → human label
  assert.match(t[0].text, /DELETE FROM users/); // the raw card text is included for the model to translate
});

test('buildExplainTranscript: clips oversized text to the input ceiling', () => {
  const big = 'x'.repeat(EXPLAIN_MAX_INPUT_CHARS + 5000);
  const t = buildExplainTranscript({ text: big });
  // header is small; the clipped card text must not exceed the ceiling
  assert.ok(t[0].text.includes('x'.repeat(100)));
  assert.ok(t[0].text.length < EXPLAIN_MAX_INPUT_CHARS + 500);
});

test('normalizeRiskLevel: maps to low/medium/high, defaults medium when unclear', () => {
  assert.equal(normalizeRiskLevel('low'), 'low');
  assert.equal(normalizeRiskLevel('LOW'), 'low');
  assert.equal(normalizeRiskLevel('High'), 'high');
  assert.equal(normalizeRiskLevel('moderate'), 'medium');
  assert.equal(normalizeRiskLevel('minimal'), 'low');
  assert.equal(normalizeRiskLevel('who knows'), 'medium');
  assert.equal(normalizeRiskLevel(''), 'medium');
  for (const r of RISK_LEVELS) assert.equal(normalizeRiskLevel(r), r);
});

test('parseExplanation: parses clean JSON into the five sections + risk', () => {
  const r = parseExplanation(JSON.stringify({
    what_happened: 'The app could not show the first-time setup screen because a leftover test account made it think a user already existed.',
    why_stopped: 'It would not delete anything on its own, so it paused to ask you.',
    what_asking: 'Permission to delete that one leftover test account — nothing else.',
    if_approve: 'It removes the test account and finishes setting up the app.',
    if_decline: 'It leaves everything as-is and the setup screen stays hidden.',
    risk_level: 'low',
    risk_why: 'Only one throwaway test account is affected.',
  }));
  assert.equal(r.ok, true);
  assert.match(r.explanation.what_happened, /first-time setup screen/);
  assert.equal(r.explanation.risk_level, 'low');
  assert.match(r.explanation.what_asking, /one leftover test account/);
});

test('parseExplanation: tolerates code fences and surrounding prose', () => {
  const fenced = 'Sure! Here is the explanation:\n```json\n{"what_happened":"A leftover test record blocked setup.","risk_level":"low","risk_why":"one record"}\n```\nHope that helps.';
  const r = parseExplanation(fenced);
  assert.equal(r.ok, true);
  assert.equal(r.explanation.risk_level, 'low');
  assert.match(r.explanation.what_happened, /leftover test record/);
});

test('parseExplanation: failure modes fall back (empty / non-JSON / no content)', () => {
  assert.equal(parseExplanation('').ok, false);
  assert.equal(parseExplanation('the model refused, no json here').ok, false);
  assert.equal(parseExplanation(JSON.stringify({ risk_level: 'low' })).ok, false); // no what_happened/what_asking
  assert.equal(parseExplanation(JSON.stringify(['not', 'an', 'object'])).ok, false);
});
