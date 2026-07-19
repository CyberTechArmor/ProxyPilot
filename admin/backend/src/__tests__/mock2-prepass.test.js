// Quick-lane pre-pass (prepass-logic.js) — the classify+enrich pure layer —
// and the typical-duration band (cycle-logic.js) that feeds the Build panel's
// "typically ~4–7m" line. Native-free (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepassEnabled, prepassModel, buildPrepassPrompt, parsePrepassReply,
  prepassEffort, bumpEffort, formatBriefForTask, featureScaleNotice,
  PREPASS_DEFAULT_MODEL, PREPASS_SCOPES,
} from '../mock2/prepass-logic.js';
import { typicalDurationMs } from '../mock2/cycle-logic.js';

test('prepass flags: on by default, off only on explicit off; model overridable', () => {
  assert.equal(prepassEnabled({}), true);
  assert.equal(prepassEnabled({ MOCK2_PREPASS: 'off' }), false);
  assert.equal(prepassEnabled({ MOCK2_PREPASS: 'on' }), true);
  assert.equal(prepassModel({}), PREPASS_DEFAULT_MODEL);
  assert.equal(prepassModel({ MOCK2_PREPASS_MODEL: 'claude-haiku-x' }), 'claude-haiku-x');
});

test('prepass prompt: strict JSON contract with the scope rubric', () => {
  const p = buildPrepassPrompt();
  assert.match(p, /STRICT JSON only/);
  for (const s of PREPASS_SCOPES) assert.ok(p.includes(`"${s}"`), `rubric names ${s}`);
});

test('parsePrepassReply: valid JSON, fenced JSON, junk, bad scope, clamps', () => {
  const good = parsePrepassReply('{"scope":"multi_part","brief":{"touches":["timesheet screen","/api/punches"],"acceptance":["clock-in appears in the sheet"]}}');
  assert.equal(good.scope, 'multi_part');
  assert.deepEqual(good.brief.touches, ['timesheet screen', '/api/punches']);
  assert.deepEqual(good.brief.states, []);
  // Fenced output still parses.
  const fenced = parsePrepassReply('```json\n{"scope":"simple","brief":{"touches":["button"]}}\n```');
  assert.equal(fenced.scope, 'simple');
  // Garbage / missing / invalid scope → null (fail-open).
  assert.equal(parsePrepassReply('I think this is a simple request.'), null);
  assert.equal(parsePrepassReply(''), null);
  assert.equal(parsePrepassReply('{"scope":"huge"}'), null);
  // Empty brief lists collapse to brief: null; oversized lists clamp to 6.
  const empty = parsePrepassReply('{"scope":"simple","brief":{"touches":[]}}');
  assert.equal(empty.brief, null);
  const many = parsePrepassReply(JSON.stringify({ scope: 'simple', brief: { touches: Array.from({ length: 12 }, (_, i) => `t${i}`) } }));
  assert.equal(many.brief.touches.length, 6);
});

test('prepassEffort: simple keeps the lane effort; bigger scopes bump one notch, capped', () => {
  assert.equal(prepassEffort('simple', 'high'), 'high');
  assert.equal(prepassEffort('multi_part', 'high'), 'xhigh');
  assert.equal(prepassEffort('feature_scale', 'high'), 'xhigh');
  assert.equal(prepassEffort('multi_part', 'max'), 'max'); // capped
  assert.equal(bumpEffort('nonsense'), 'nonsense'); // unknown passes through
});

test('formatBriefForTask: subordinate block; empty brief renders nothing', () => {
  const block = formatBriefForTask({ scope: 'multi_part', brief: { touches: ['a'], states: [], edge_cases: ['tz math'], acceptance: ['x works'] } });
  assert.match(block, /the request above is authoritative/);
  assert.match(block, /Likely touches: a/);
  assert.match(block, /Edge cases: tz math/);
  assert.ok(!block.includes('States to handle'), 'empty lists omitted');
  assert.equal(formatBriefForTask({ scope: 'simple', brief: null }), '');
  assert.equal(formatBriefForTask(null), '');
  assert.match(featureScaleNotice(), /Build MVP/);
});

test('typicalDurationMs: p50/p80 band over succeeded same-mode cycles; null under 2 samples', () => {
  const row = (mins, mode = 'quick', status = 'succeeded') => ({
    status,
    routing_json: JSON.stringify({ build_mode: mode }),
    started_at: '2026-07-19T10:00:00.000Z',
    finished_at: new Date(Date.parse('2026-07-19T10:00:00.000Z') + mins * 60000).toISOString(),
  });
  const rows = [row(3), row(5), row(4), row(20, 'full'), row(9, 'quick', 'failed')];
  const t = typicalDurationMs(rows, { buildMode: 'quick' });
  assert.equal(t.n, 3); // full-mode + failed rows excluded
  assert.equal(t.p50, 4 * 60000);
  assert.ok(t.p80 >= t.p50);
  // No mode filter → the full build joins the pool.
  assert.equal(typicalDurationMs(rows).n, 4);
  // One sample is an anecdote.
  assert.equal(typicalDurationMs([row(3)], { buildMode: 'quick' }), null);
  assert.equal(typicalDurationMs([], {}), null);
});
