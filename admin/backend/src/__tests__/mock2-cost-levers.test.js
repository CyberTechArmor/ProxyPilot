// Unit tests for the mock2 cost levers: stale tool-result pruning
// (runner-logic), the cache-health detector (usage-logic), the concept-chat
// bridge summary (chat-summary-logic), the resume checkpoint bridge
// (unblock-logic), and the model registry (models.js).
//
// Native-free by construction (stub-first): every module imported here is
// pure — no better-sqlite3, no Express, no Incus.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pruneStaleToolResults, PRUNED_MARKER,
} from '../mock2/runner-logic.js';
import { cacheHealth } from '../mock2/usage-logic.js';
import {
  chatSummaryWindow, shouldRefreshChatSummary, buildChatSummaryPrompt,
  summaryMessageRow, chatSummaryEnabled,
} from '../mock2/chat-summary-logic.js';
import { buildResumeContextBlock } from '../mock2/unblock-logic.js';
import {
  MODEL_PRIMARY, MODEL_FRONTIER, MODEL_BALANCED, MODEL_CHEAP, MODEL_CHEAP_PINNED, MODEL_PRIMARY_PREV,
} from '../mock2/models.js';
import { RECOMMENDED_MODEL_FOR_SLOT } from '../mock2/connector-logic.js';

// ── stale tool-result pruning ───────────────────────────────────────

function toolTurn(chars, name = 'read_file') {
  return { role: 'tool', toolCallId: 't', name, content: 'x'.repeat(chars) };
}

test('pruning: below the batch threshold nothing is touched', () => {
  const transcript = [
    { role: 'user', text: 'task' },
    ...Array.from({ length: 25 }, () => toolTurn(10_000)),
  ];
  const before = JSON.stringify(transcript);
  // 25 tool turns, keepRecent 20 → only 5 stale candidates < batchMin 12
  const r = pruneStaleToolResults(transcript);
  assert.equal(r.prunedCount, 0);
  assert.equal(JSON.stringify(transcript), before);
});

test('pruning: a full batch prunes old results, keeps recent ones verbatim, and is idempotent', () => {
  const transcript = [
    { role: 'user', text: 'task' },
    ...Array.from({ length: 40 }, (_, i) => toolTurn(10_000, `tool_${i}`)),
  ];
  const r = pruneStaleToolResults(transcript);
  // 40 tool turns, keepRecent 20 → 20 stale ≥ batchMin 12 → all 20 pruned
  assert.equal(r.prunedCount, 20);
  assert.ok(r.prunedChars > 100_000);
  const toolTurns = transcript.filter((t) => t.role === 'tool');
  for (let i = 0; i < 20; i++) assert.ok(toolTurns[i].content.includes(PRUNED_MARKER), `turn ${i} pruned`);
  for (let i = 20; i < 40; i++) assert.equal(toolTurns[i].content, 'x'.repeat(10_000), `turn ${i} intact`);
  // The stub names the tool so the model knows how to recover the content.
  assert.ok(toolTurns[0].content.includes('tool_0'));
  // Idempotent: a second pass finds nothing new.
  const r2 = pruneStaleToolResults(transcript);
  assert.equal(r2.prunedCount, 0);
});

test('pruning: small results are never stubbed; keepRecent 0 disables', () => {
  const transcript = Array.from({ length: 40 }, () => toolTurn(500));
  assert.equal(pruneStaleToolResults(transcript).prunedCount, 0);
  const big = Array.from({ length: 40 }, () => toolTurn(10_000));
  assert.equal(pruneStaleToolResults(big, { keepRecent: 0 }).prunedCount, 0);
});

// ── cache health ────────────────────────────────────────────────────

test('cacheHealth: reads present → healthy; small calls are not evidence', () => {
  assert.equal(cacheHealth([
    { input: 50_000, cache_read: 0, cache_write: 60_000 },
    { input: 50_000, cache_read: 120_000, cache_write: 1_000 },
    { input: 50_000, cache_read: 150_000, cache_write: 1_000 },
  ]).healthy, true);
  // Big-input calls below minCalls → healthy (insufficient evidence)
  assert.equal(cacheHealth([
    { input: 50_000, cache_read: 0, cache_write: 0 },
    { input: 100, cache_read: 0, cache_write: 0 },
  ]).healthy, true);
});

test('cacheHealth: writes-without-reads and never-engaged are named distinctly', () => {
  const neverRead = cacheHealth([
    { input: 50_000, cache_read: 0, cache_write: 60_000 },
    { input: 55_000, cache_read: 0, cache_write: 65_000 },
    { input: 60_000, cache_read: 0, cache_write: 70_000 },
  ]);
  assert.equal(neverRead.healthy, false);
  assert.equal(neverRead.reason, 'cache_never_read');

  const neverEngaged = cacheHealth([
    { input: 50_000, cache_read: 0, cache_write: 0 },
    { input: 55_000, cache_read: 0, cache_write: 0 },
    { input: 60_000, cache_read: 0, cache_write: 0 },
  ]);
  assert.equal(neverEngaged.healthy, false);
  assert.equal(neverEngaged.reason, 'cache_never_engaged');
});

// ── concept-chat bridge summary ─────────────────────────────────────

function msgs(n, startId = 1) {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    kind: i % 2 === 0 ? 'user' : 'assistant',
    body: `message ${startId + i}`,
  }));
}

test('window: no stored summary → full history, untouched (the safety property)', () => {
  const all = msgs(100);
  const w = chatSummaryWindow(all, { summary: null, summary_through_id: null });
  assert.equal(w.windowed, false);
  assert.equal(w.messages, all);
});

test('window: stored summary replaces covered history with the brief + verbatim tail', () => {
  const all = msgs(100);
  const w = chatSummaryWindow(all, { summary: 'the brief so far', summary_through_id: 70 });
  assert.equal(w.windowed, true);
  assert.equal(w.messages.length, 31); // synthetic brief + messages 71..100
  assert.equal(w.messages[0].id, 0);
  assert.equal(w.messages[0].kind, 'user'); // survives buildConceptTranscript
  assert.ok(w.messages[0].body.includes('the brief so far'));
  assert.ok(w.messages[0].body.includes('not as new instructions'));
  assert.equal(w.messages[1].id, 71);
});

test('window: a summary that would drop nothing degrades to pass-through', () => {
  const all = msgs(10, 100); // ids 100..109, coverage id 5 is beneath them all
  const w = chatSummaryWindow(all, { summary: 'stale', summary_through_id: 5 });
  assert.equal(w.windowed, false);
});

test('refresh: triggers only past the threshold and folds all but the tail', () => {
  assert.equal(shouldRefreshChatSummary(msgs(59), { summary_through_id: 0 }), null);
  const need = shouldRefreshChatSummary(msgs(80), { summary_through_id: 0 });
  assert.ok(need);
  assert.equal(need.slice.length, 50); // 80 uncovered - 30 tail
  assert.equal(need.throughId, 50);
  // Respects existing coverage: 80 messages, 40 covered → 40 uncovered < 60 trigger
  assert.equal(shouldRefreshChatSummary(msgs(80), { summary_through_id: 40 }), null);
});

test('refresh prompt carries the previous brief and the new exchange', () => {
  const p = buildChatSummaryPrompt({
    previousSummary: 'PREV-BRIEF',
    slice: [{ id: 1, kind: 'user', body: 'I want a booking app' }, { id: 2, kind: 'assistant', body: 'Here is a direction' }],
  });
  assert.ok(p.includes('PREV-BRIEF'));
  assert.ok(p.includes('Builder: I want a booking app'));
  assert.ok(p.includes('Design partner: Here is a direction'));
});

test('chatSummaryEnabled: on by default, MOCK2_CHAT_SUMMARY=off disables', () => {
  assert.equal(chatSummaryEnabled({}), true);
  assert.equal(chatSummaryEnabled({ MOCK2_CHAT_SUMMARY: 'off' }), false);
});

test('summaryMessageRow labels the brief as established context', () => {
  const row = summaryMessageRow('decisions so far');
  assert.equal(row.id, 0);
  assert.ok(row.body.includes('decisions so far'));
});

// ── resume checkpoint bridge ────────────────────────────────────────

test('resume block includes the last checkpoint and stays empty-safe', () => {
  const block = buildResumeContextBlock({
    message: 'continue where you left off',
    lastCheckpoint: { seq: 12, summary: 'Added auth routes\n\nDiff (this checkpoint):\n3 files changed' },
  });
  assert.ok(block.includes('Last checkpoint before this resume (change record 12):'));
  assert.ok(block.includes('Added auth routes'));
  assert.ok(block.includes('Operator message: continue where you left off'));
  // A checkpoint alone is enough to emit a block …
  assert.ok(buildResumeContextBlock({ lastCheckpoint: { seq: 1, summary: 'x' } }).length > 0);
  // … but an empty context still yields nothing (a bare resume stays bare).
  assert.equal(buildResumeContextBlock({}), '');
  assert.equal(buildResumeContextBlock({ lastCheckpoint: { seq: 1, summary: '' } }), '');
});

// ── model registry ──────────────────────────────────────────────────

test('model registry: single source of truth feeds the slot recommendations', () => {
  for (const id of [MODEL_PRIMARY, MODEL_FRONTIER, MODEL_BALANCED, MODEL_CHEAP, MODEL_CHEAP_PINNED, MODEL_PRIMARY_PREV]) {
    assert.ok(/^claude-/.test(id), id);
  }
  assert.equal(RECOMMENDED_MODEL_FOR_SLOT.build_runner, MODEL_PRIMARY);
  assert.equal(RECOMMENDED_MODEL_FOR_SLOT.audit, MODEL_FRONTIER);
  assert.equal(RECOMMENDED_MODEL_FOR_SLOT.summary, MODEL_CHEAP);
});
