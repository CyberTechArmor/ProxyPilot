// Per-step system prompt specs — pure module, native-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_PROMPT_SPECS,
  promptOwnerStepId,
  renderDefaultStepPrompt,
  substitutePromptPlaceholders,
  normalizeStepPrompts,
} from '../mock2/harness-prompts-logic.js';
import { HARNESS_STEPS } from '../mock2/harness-steps-logic.js';
import { modelMaxOutputTokens } from '../mock2/routing-logic.js';

test('modelMaxOutputTokens: 128k only for models known to accept it', () => {
  assert.equal(modelMaxOutputTokens('claude-opus-4-8'), 128000);
  assert.equal(modelMaxOutputTokens('claude-sonnet-5'), 128000);
  assert.equal(modelMaxOutputTokens('claude-haiku-4-5-20251001'), 64000);
  assert.equal(modelMaxOutputTokens('claude-fable-5'), 64000);
  assert.equal(modelMaxOutputTokens('claude-sonnet-4-6'), 64000);
  assert.equal(modelMaxOutputTokens(''), 64000);
  assert.equal(modelMaxOutputTokens(null), 64000);
});

test('every registry step has a prompt spec, and vice versa', () => {
  const regIds = HARNESS_STEPS.map((s) => s.id).sort();
  const specIds = Object.keys(STEP_PROMPT_SPECS).sort();
  assert.deepEqual(specIds, regIds);
});

test('every step renders a substantial default prompt', () => {
  for (const id of Object.keys(STEP_PROMPT_SPECS)) {
    const text = renderDefaultStepPrompt(id);
    assert.ok(text && text.length > 100, `${id}: default prompt missing or thin (${text?.length})`);
  }
});

test('declared placeholders appear in the rendered default', () => {
  for (const [id, spec] of Object.entries(STEP_PROMPT_SPECS)) {
    if (spec.sharesPromptOf) continue;
    const text = renderDefaultStepPrompt(id);
    for (const key of spec.placeholders || []) {
      assert.ok(text.includes(`{{${key}}}`), `${id}: rendered default lacks {{${key}}}`);
    }
  }
});

test('shared prompts resolve to their owner', () => {
  assert.equal(promptOwnerStepId('mockup-continuation'), 'mockup-render');
  assert.equal(promptOwnerStepId('mockup-render'), 'mockup-render');
  assert.equal(promptOwnerStepId('nope'), null);
  assert.equal(renderDefaultStepPrompt('mockup-continuation'), renderDefaultStepPrompt('mockup-render'));
});

test('substitutePromptPlaceholders fills known keys, leaves unknown markers visible', () => {
  const out = substitutePromptPlaceholders('A {{X}} B {{X}} C {{Y}} D {{Z}}', { X: '1', Y: 'two' });
  assert.equal(out, 'A 1 B 1 C two D {{Z}}');
  assert.equal(substitutePromptPlaceholders(null, {}), '');
});

test('normalizeStepPrompts is parse-safe and drops shared/unknown/empty', () => {
  assert.deepEqual(normalizeStepPrompts('junk'), {});
  const doc = normalizeStepPrompts(JSON.stringify({
    'rule-audit': 'custom auditor prompt',
    'mockup-continuation': 'edits belong on mockup-render',  // shared → dropped
    'no-such-step': 'x',                                     // unknown → dropped
    ask: '   ',                                              // empty → dropped
  }));
  assert.deepEqual(Object.keys(doc), ['rule-audit']);
});
