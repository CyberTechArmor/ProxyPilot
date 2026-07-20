// Quick-lane pre-pass (prepass-logic.js) — the classify+enrich pure layer —
// and the typical-duration band (cycle-logic.js) that feeds the Build panel's
// "typically ~4–7m" line. Native-free (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepassEnabled, prepassModel, buildPrepassPrompt, parsePrepassReply,
  prepassEffort, bumpEffort, formatBriefForTask, featureScaleNotice,
  PREPASS_DEFAULT_MODEL, PREPASS_SCOPES,
  SUGGEST_MODES, normalizeSuggestMode, composeWithAdditions,
  buildDistillSystemPrompt, buildDistillUserTurn, cleanDistilledInstruction,
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
  // The domain-expert enrichment (timesheets list EVERY punch pair, flag
  // anomalies, …) is prompted for and parsed into the brief.
  assert.match(p, /domain_expectations/);
  assert.match(p, /DOMAIN EXPERT/);
  const parsed = parsePrepassReply('{"scope":"multi_part","brief":{"domain_expectations":["show every punch pair","flag missing punch-out"]}}');
  assert.deepEqual(parsed.brief.domain_expectations, ['show every punch pair', 'flag missing punch-out']);
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
  const block = formatBriefForTask({ scope: 'multi_part', brief: { touches: ['a'], states: [], edge_cases: ['tz math'], acceptance: ['x works'], domain_expectations: ['every clock-in/out pair per day is listed'] } });
  assert.match(block, /the request above is authoritative/);
  assert.match(block, /Likely touches: a/);
  assert.match(block, /Edge cases: tz math/);
  assert.match(block, /Domain expectations .*: every clock-in\/out pair per day is listed/);
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

test('split proposal: parsed only for feature_scale with 2+ solid parts; group instruction is binding', async () => {
  const { parsePrepassReply, buildGroupInstruction } = await import('../mock2/prepass-logic.js');
  const withSplit = parsePrepassReply(JSON.stringify({
    scope: 'feature_scale',
    brief: { touches: ['x'] },
    split: { parts: [
      { title: 'ADP settings page', items: ['credentials form', 'test connection'] },
      { title: 'Local-first submit', items: ['save locally', 'post when connected', 'retry queue'] },
    ] },
  }));
  assert.equal(withSplit.split.parts.length, 2);
  assert.equal(withSplit.split.parts[0].title, 'ADP settings page');
  // Non-feature scope drops the split even if provided.
  const wrongScope = parsePrepassReply('{"scope":"multi_part","split":{"parts":[{"title":"a","items":["b"]},{"title":"c","items":["d"]}]}}');
  assert.equal(wrongScope.split, null);
  // A single-part split is not a split.
  const onePart = parsePrepassReply('{"scope":"feature_scale","split":{"parts":[{"title":"a","items":["b"]}]}}');
  assert.equal(onePart.split, null);
  const gi = buildGroupInstruction({ title: 'ADP settings page', items: ['credentials form', 'test connection'], index: 1, total: 2, original: 'Please add the adp connection page and submit flow' });
  assert.match(gi, /Part 1 of 2/);
  assert.match(gi, /Scope is BINDING to this part/);
  assert.match(gi, /Not built yet/);
  assert.match(gi, /never fabricate artificial ones/);
});

test('suggest mode: normalize defaults to ask; confirmed additions compose as binding scope', () => {
  assert.deepEqual([...SUGGEST_MODES], ['off', 'ask', 'auto']);
  assert.equal(normalizeSuggestMode('auto'), 'auto');
  assert.equal(normalizeSuggestMode('off'), 'off');
  // Unknown / legacy rows (pre-539 NULL) settle on the card default.
  assert.equal(normalizeSuggestMode(undefined), 'ask');
  assert.equal(normalizeSuggestMode('sometimes'), 'ask');

  const composed = composeWithAdditions('Add a timesheet page', ['show every clock-in/out pair', ' flag missing punch-outs ']);
  assert.match(composed, /^Add a timesheet page\n\n/);
  assert.match(composed, /additions the user confirmed \(binding\)/);
  assert.match(composed, /- show every clock-in\/out pair\n- flag missing punch-outs$/);
  // Auto mode labels the additions as setting-driven, not user-picked.
  assert.match(composeWithAdditions('x', ['y'], { auto: true }), /auto-included by this project's suggestion setting/);
  // No additions → instruction unchanged; junk items are dropped.
  assert.equal(composeWithAdditions('x', []), 'x');
  assert.equal(composeWithAdditions('x', ['', '   ', null]), 'x');
  // Clamped to six items.
  const many = composeWithAdditions('x', Array.from({ length: 9 }, (_, i) => `item ${i}`));
  assert.equal((many.match(/^- /gm) || []).length, 6);
});

test('distill: chat message → build prompt (contract, parse, context turn)', () => {
  const sys = buildDistillSystemPrompt();
  assert.match(sys, /ONE well-formed build instruction/);
  assert.match(sys, /Do NOT invent/);
  assert.match(sys, /Output ONLY the instruction text/);
  const turn = buildDistillUserTurn({ body: '1. PTO 2. Export CSV', precedingUser: 'what is missing?' });
  assert.match(turn, /user message that prompted it/);
  assert.match(turn, /what is missing\?/);
  assert.match(turn, /1\. PTO 2\. Export CSV/);
  assert.ok(!buildDistillUserTurn({ body: 'x' }).includes('prompted it'), 'no context block without a preceding user turn');
  // Cleaner strips fences and "here's the prompt" preambles; junk → null.
  assert.equal(cleanDistilledInstruction('```\nAdd PTO tracking and CSV export.\n```'), 'Add PTO tracking and CSV export.');
  assert.equal(cleanDistilledInstruction("Here's the prompt: Add PTO tracking to the timesheet."), 'Add PTO tracking to the timesheet.');
  assert.equal(cleanDistilledInstruction('ok'), null);
  assert.equal(cleanDistilledInstruction(''), null);
});
