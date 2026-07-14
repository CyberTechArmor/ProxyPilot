// Harness safety: the no-progress circuit breaker + the halt terminal action.
// These gate real token spend (the ADP repro burned ~$4.76 over 118 stuck turns),
// so pin the trip conditions and the threshold. Native-free (pure decisions).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTurn, RUNNER_TOOL_NAMES,
  updateProgress, initProgressState, noProgressLimit, progressSignature,
  toolCallSignature, NO_PROGRESS_LIMIT,
} from '../mock2/runner-logic.js';

// ---- halt as a first-class terminal action ----

test('halt is a registered tool the model can call', () => {
  assert.ok(RUNNER_TOOL_NAMES.includes('halt'));
  assert.ok(RUNNER_TOOL_NAMES.includes('finish'));
});

test('classifyTurn: a halt call ends the cycle non-success with its reason', () => {
  const d = classifyTurn([{ name: 'halt', input: { reason: 'test gate re-seeds the serving DB; out of scope' } }]);
  assert.equal(d.halted, true);
  assert.equal(d.done, false);
  assert.match(d.haltReason, /re-seeds the serving DB/);
});

test('classifyTurn: halt wins over finish (no giving up AND claiming success)', () => {
  const d = classifyTurn([{ name: 'finish', input: { summary: 'done' } }, { name: 'halt', input: { reason: 'blocked' } }]);
  assert.equal(d.halted, true);
  assert.equal(d.done, false);
});

test('classifyTurn: finish still means done; a normal tool call continues; no call stalls', () => {
  assert.equal(classifyTurn([{ name: 'finish', input: { summary: 's' } }]).done, true);
  assert.equal(classifyTurn([{ name: 'write_file', input: { path: 'a', content: 'b' } }]).stalled, false);
  assert.equal(classifyTurn([]).stalled, true);
});

// ---- the breaker threshold ----

test('noProgressLimit: defaults small (3) and is env-configurable, clamped ≥2', () => {
  assert.equal(NO_PROGRESS_LIMIT, 3);
  assert.equal(noProgressLimit({}), 3);
  assert.equal(noProgressLimit({ BUILD_NO_PROGRESS_LIMIT: '5' }), 5);
  assert.equal(noProgressLimit({ BUILD_NO_PROGRESS_LIMIT: '1' }), 3); // clamp
  assert.equal(noProgressLimit({ BUILD_NO_PROGRESS_LIMIT: 'nope' }), 3);
});

// Drive N stuck turns through the accumulator and return the last verdict.
function runTurns(turns, limit = 3) {
  let state = initProgressState();
  let last = { tripped: false, trigger: null };
  let trippedAt = null;
  turns.forEach((t, i) => {
    const r = updateProgress(state, t, limit);
    state = r.state;
    last = r;
    if (r.tripped && trippedAt == null) trippedAt = i + 1;
  });
  return { ...last, trippedAt };
}

test('breaker: the ADP repro (near-identical, no-tool refusals) trips within the threshold', () => {
  const refusal = { toolCalls: [], text: 'I cannot finish: the test gate re-seeds a user into the serving DB, so login fails. This is outside the scope of this change.' };
  const r = runTurns(Array.from({ length: 118 }, () => refusal), 3);
  assert.equal(r.tripped, true);
  // Stopped in single-digit turns, not 118.
  assert.ok(r.trippedAt <= 3, `tripped at ${r.trippedAt}`);
  // no_tool_calls fires first (there were no tool calls at all).
  assert.equal(r.trigger, 'no_tool_calls');
});

test('breaker: repeated identical talk with a repeated inert tool call trips (repeated_output/no_state_change)', () => {
  // Model re-runs the SAME gate every turn and repeats the same message — no writes.
  const t = { toolCalls: [{ name: 'run_gates', input: {} }], text: 'gates are still red for the same reason' };
  const r = runTurns(Array.from({ length: 10 }, () => t), 3);
  assert.equal(r.tripped, true);
  assert.ok(['repeated_output', 'no_state_change'].includes(r.trigger));
  assert.ok(r.trippedAt <= 4);
});

test('breaker: legitimate multi-step work is NEVER tripped', () => {
  // Distinct reads, then writes, then a gate run — each a new action, varied text.
  const turns = [
    { toolCalls: [{ name: 'read_file', input: { path: 'src/app.ts' } }], text: 'reading the app entry' },
    { toolCalls: [{ name: 'read_file', input: { path: 'src/auth/routes.ts' } }], text: 'reading auth routes' },
    { toolCalls: [{ name: 'write_file', input: { path: 'src/auth/routes.ts', content: 'v1' } }], text: 'adding the login route' },
    { toolCalls: [{ name: 'write_file', input: { path: 'src/auth/login.ts', content: 'v2' } }], text: 'the login handler' },
    { toolCalls: [{ name: 'run_gates', input: {} }], text: 'checking the gates' },
    { toolCalls: [{ name: 'write_file', input: { path: 'src/auth/login.ts', content: 'v3' } }], text: 'fixing a type error' },
    { toolCalls: [{ name: 'run_gates', input: {} }], text: 'checking again' },
  ];
  const r = runTurns(turns, 3);
  assert.equal(r.tripped, false);
});

test('breaker: a stock preamble repeated WHILE making real edits does not trip', () => {
  // Same opening sentence each turn, but every turn writes a DIFFERENT file.
  const turns = Array.from({ length: 8 }, (_, i) => ({
    toolCalls: [{ name: 'write_file', input: { path: `src/f${i}.ts`, content: 'x' } }],
    text: 'Continuing the implementation as planned.',
  }));
  const r = runTurns(turns, 3);
  assert.equal(r.tripped, false);
});

test('signatures: normalization matches near-verbatim text and same-action calls', () => {
  assert.equal(progressSignature('I  am\nBLOCKED. '), progressSignature('i am blocked.'));
  assert.equal(
    toolCallSignature([{ name: 'read_file', input: { path: 'a' } }]),
    toolCallSignature([{ name: 'read_file', input: { path: 'a' } }]),
  );
  assert.notEqual(
    toolCallSignature([{ name: 'read_file', input: { path: 'a' } }]),
    toolCallSignature([{ name: 'read_file', input: { path: 'b' } }]),
  );
});
