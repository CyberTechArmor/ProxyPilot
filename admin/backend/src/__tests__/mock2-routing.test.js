// Model routing — the pure decision layer (routing-logic.js): task-kind
// normalization, Anthropic tuning gates (adaptive thinking + effort per model
// id), the deterministic escalation predicate, the routing decision itself,
// and the outcome aggregation the knowledge base is tuned against.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTING_TASK_KINDS, ROUTING_EFFORTS, DEFAULT_ROUTING_RULES,
  normalizeTaskKind, normalizeDifficulty, anthropicTuning,
  escalationAttempts, routingMode, decideRouting, parseRoutingJson,
  publicRoutingRuleShape, aggregateRoutingOutcomes,
} from '../mock2/routing-logic.js';

// ---- normalization ----

test('normalizeTaskKind: known kinds pass, anything else is default', () => {
  assert.equal(normalizeTaskKind('bugfix'), 'bugfix');
  assert.equal(normalizeTaskKind(' Feature '), 'feature');
  assert.equal(normalizeTaskKind('epic'), 'default');
  assert.equal(normalizeTaskKind(null), 'default');
});

test('normalizeDifficulty: clamps to 1..5, null on garbage', () => {
  assert.equal(normalizeDifficulty(3), 3);
  assert.equal(normalizeDifficulty(0), 1);
  assert.equal(normalizeDifficulty(9), 5);
  assert.equal(normalizeDifficulty('4'), 4);
  assert.equal(normalizeDifficulty('hard'), null);
  assert.equal(normalizeDifficulty(undefined), null);
});

test('defaults: every task kind has a seed rule with a valid effort', () => {
  const kinds = DEFAULT_ROUTING_RULES.map((r) => r.task_kind);
  assert.deepEqual([...kinds].sort(), [...ROUTING_TASK_KINDS].sort());
  for (const r of DEFAULT_ROUTING_RULES) assert.ok(ROUTING_EFFORTS.includes(r.effort));
});

// ---- Anthropic tuning gates ----

test('anthropicTuning: modern models get adaptive thinking + effort', () => {
  const t = anthropicTuning({ model: 'claude-opus-4-8', effort: 'xhigh' });
  assert.deepEqual(t.thinking, { type: 'adaptive' });
  assert.deepEqual(t.output_config, { effort: 'xhigh' });
});

test('anthropicTuning: unknown models get NOTHING (never risk a 400)', () => {
  assert.deepEqual(anthropicTuning({ model: 'gpt-5.2', effort: 'high' }), {});
  assert.deepEqual(anthropicTuning({ model: 'claude-3-5-haiku-latest', effort: 'high' }), {});
  assert.deepEqual(anthropicTuning({ model: '', effort: 'high' }), {});
});

test('anthropicTuning: effort clamps down where a level is unsupported', () => {
  // Opus 4.5: effort exists but xhigh/max do not → clamp to high; no adaptive thinking.
  const t45 = anthropicTuning({ model: 'claude-opus-4-5', effort: 'xhigh' });
  assert.equal(t45.thinking, undefined);
  assert.deepEqual(t45.output_config, { effort: 'high' });
  // Opus 4.6: adaptive ok, xhigh not in the xhigh set → high.
  const t46 = anthropicTuning({ model: 'claude-opus-4-6', effort: 'xhigh' });
  assert.deepEqual(t46.thinking, { type: 'adaptive' });
  assert.deepEqual(t46.output_config, { effort: 'high' });
});

test('anthropicTuning: invalid effort is dropped, thinking still applies', () => {
  const t = anthropicTuning({ model: 'claude-sonnet-5', effort: 'turbo' });
  assert.deepEqual(t.thinking, { type: 'adaptive' });
  assert.equal(t.output_config, undefined);
});

// ---- escalation signal (ground truth) ----

const cyc = (over = {}) => ({ stage: 'build', status: 'failed', request_id: 7, instruction: 'add auth', ...over });

test('escalationAttempts: counts failed/halted build attempts of the SAME request', () => {
  const prior = [cyc(), cyc({ status: 'awaiting_admin' }), cyc({ status: 'succeeded' }), cyc({ request_id: 8 })];
  assert.equal(escalationAttempts({ priorCycles: prior, requestId: 7 }), 2);
});

test('escalationAttempts: request-less legacy cycles match by instruction', () => {
  const prior = [cyc({ request_id: null }), cyc({ request_id: null, instruction: 'other' })];
  assert.equal(escalationAttempts({ priorCycles: prior, requestId: null, instruction: 'add auth' }), 1);
});

test('escalationAttempts: audit cycles and empty history count zero', () => {
  assert.equal(escalationAttempts({ priorCycles: [cyc({ stage: 'audit' })], requestId: 7 }), 0);
  assert.equal(escalationAttempts({}), 0);
});

// ---- the routing decision ----

test('routingMode: defaults on, honors shadow/off', () => {
  assert.equal(routingMode({}), 'on');
  assert.equal(routingMode({ MOCK2_ROUTING: 'shadow' }), 'shadow');
  assert.equal(routingMode({ MOCK2_ROUTING: 'OFF' }), 'off');
  assert.equal(routingMode({ MOCK2_ROUTING: 'bogus' }), 'on');
});

test('decideRouting: fresh install (no rule, no env) = slot model, lane default effort, rung 0', () => {
  const d = decideRouting({ slotModel: 'claude-sonnet-5', laneDefaultEffort: 'high' });
  assert.equal(d.model, 'claude-sonnet-5');
  assert.equal(d.effort, 'high');
  assert.equal(d.rung, 0);
  assert.equal(d.task_kind, 'default');
});

test('decideRouting: the rule overrides model + effort', () => {
  const rule = { task_kind: 'chore', model: 'claude-haiku-4-5-20251001', effort: 'low' };
  const d = decideRouting({ rule, slotModel: 'claude-sonnet-5', difficulty: 2 });
  assert.equal(d.model, 'claude-haiku-4-5-20251001');
  assert.equal(d.effort, 'low');
  assert.equal(d.task_kind, 'chore');
});

test('decideRouting: difficulty maps effort when the rule leaves it open', () => {
  assert.equal(decideRouting({ slotModel: 'm', difficulty: 1 }).effort, 'medium');
  assert.equal(decideRouting({ slotModel: 'm', difficulty: 3 }).effort, 'high');
  assert.equal(decideRouting({ slotModel: 'm', difficulty: 5, }).effort, 'xhigh');
});

test('decideRouting: a prior failed attempt escalates to the rule escalation model', () => {
  const rule = { task_kind: 'feature', escalate_model: 'claude-opus-4-8' };
  const d = decideRouting({ rule, slotModel: 'claude-sonnet-5', priorAttempts: 1 });
  assert.equal(d.model, 'claude-opus-4-8');
  assert.equal(d.rung, 1);
  assert.match(d.reason, /prior_failed_attempts:1/);
  assert.match(d.reason, /escalated/);
});

test('decideRouting: difficulty 5 goes straight to the escalation model', () => {
  const d = decideRouting({
    rule: { task_kind: 'refactor' }, slotModel: 'claude-sonnet-5',
    difficulty: 5, env: { MOCK2_ESCALATE_MODEL: 'claude-opus-4-8' },
  });
  assert.equal(d.model, 'claude-opus-4-8');
  assert.equal(d.rung, 1);
});

test('decideRouting: no escalation model configured → stays on rung 0 (never invents a model)', () => {
  const d = decideRouting({ slotModel: 'claude-sonnet-5', priorAttempts: 3 });
  assert.equal(d.model, 'claude-sonnet-5');
  assert.equal(d.rung, 0);
});

test('decideRouting: escalation model equal to the base model is a no-op', () => {
  const rule = { task_kind: 'bugfix', escalate_model: 'claude-sonnet-5' };
  const d = decideRouting({ rule, slotModel: 'claude-sonnet-5', priorAttempts: 2 });
  assert.equal(d.rung, 0);
});

// ---- shapes + aggregation ----

test('parseRoutingJson: object or null, never throws', () => {
  assert.deepEqual(parseRoutingJson('{"rung":1}'), { rung: 1 });
  assert.equal(parseRoutingJson('not json'), null);
  assert.equal(parseRoutingJson(null), null);
  assert.equal(parseRoutingJson('"str"'), null);
});

test('publicRoutingRuleShape: nulls mean "the default applies"', () => {
  const s = publicRoutingRuleShape({ task_kind: 'chore', label: 'Chores', model: '', effort: null, enabled: 1 });
  assert.equal(s.model, null);
  assert.equal(s.effort, null);
  assert.equal(s.enabled, true);
});

test('aggregateRoutingOutcomes: per kind×model success rate, escalation, averages', () => {
  const rows = [
    { task_kind: 'bugfix', model: 'sonnet', status: 'succeeded', rung: 0, cost_cents: 40, tokens: 1000 },
    { task_kind: 'bugfix', model: 'sonnet', status: 'failed', rung: 0, cost_cents: 60, tokens: 3000 },
    { task_kind: 'bugfix', model: 'opus', status: 'awaiting_user', rung: 1, cost_cents: 200, tokens: 4000 },
    { task_kind: 'bugfix', model: 'sonnet', status: 'interrupted', rung: 0, cost_cents: 10, tokens: 100 },
  ];
  const stats = aggregateRoutingOutcomes(rows);
  const sonnet = stats.find((s) => s.model === 'sonnet');
  assert.equal(sonnet.runs, 3);
  assert.equal(sonnet.succeeded, 1);
  assert.equal(sonnet.failed, 1); // interrupted is neutral
  assert.equal(sonnet.success_rate, 33);
  const opus = stats.find((s) => s.model === 'opus');
  assert.equal(opus.escalated, 1);
  assert.equal(opus.success_rate, 100);
  assert.equal(opus.avg_cost_cents, 200);
});

test('aggregateRoutingOutcomes: empty input → empty scoreboard', () => {
  assert.deepEqual(aggregateRoutingOutcomes([]), []);
  assert.deepEqual(aggregateRoutingOutcomes(null), []);
});
