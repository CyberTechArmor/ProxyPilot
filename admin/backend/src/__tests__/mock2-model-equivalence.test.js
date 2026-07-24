// Cross-provider model equivalence map — the pure decision layer
// (model-equivalence.js): id normalization, provider detection, and the
// bidirectional Anthropic↔OpenAI tier map. Stub-first (risk R9): imports ONLY
// the native-free logic module.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModelId, providerOfModel, equivalentModel,
  ANTHROPIC_TO_OPENAI, OPENAI_TO_ANTHROPIC, OPENAI_CHEAP_UTILITY,
  OPENAI_CODING_ALT, MODEL_EQUIVALENCE_TABLE,
} from '../mock2/model-equivalence.js';

test('normalizeModelId: lower-cases, folds dots to dashes, strips date suffix', () => {
  assert.equal(normalizeModelId('GPT-5.6-Sol'), 'gpt-5-6-sol');
  assert.equal(normalizeModelId('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(normalizeModelId('gpt-5.6-sol-20260701'), 'gpt-5-6-sol');
  assert.equal(normalizeModelId('  claude-haiku-4-5  '), 'claude-haiku-4-5');
  assert.equal(normalizeModelId(null), '');
});

test('providerOfModel: prefix-based, null when unknown', () => {
  assert.equal(providerOfModel('claude-opus-4-8'), 'anthropic');
  assert.equal(providerOfModel('claude-fable-5'), 'anthropic');
  assert.equal(providerOfModel('gpt-5.6-terra'), 'openai');
  assert.equal(providerOfModel('llama-3-70b'), null);
  assert.equal(providerOfModel(''), null);
});

test('equivalentModel: Anthropic → OpenAI matches the spec tiers', () => {
  assert.equal(equivalentModel('claude-fable-5'), 'gpt-5.6-sol');
  assert.equal(equivalentModel('claude-opus-4-8'), 'gpt-5.6-sol');
  assert.equal(equivalentModel('claude-sonnet-5'), 'gpt-5.6-terra');
  assert.equal(equivalentModel('claude-haiku-4-5'), 'gpt-5.6-luna');
  // A dotted alias / display form still resolves.
  assert.equal(equivalentModel('claude-opus-4.8'), 'gpt-5.6-sol');
});

test('equivalentModel: OpenAI → Anthropic (bidirectional); Sol resolves to the workhorse', () => {
  assert.equal(equivalentModel('gpt-5.6-sol'), 'claude-opus-4-8');
  assert.equal(equivalentModel('gpt-5.6-terra'), 'claude-sonnet-5');
  assert.equal(equivalentModel('gpt-5.6-luna'), 'claude-haiku-4-5');
  assert.equal(equivalentModel('gpt-5.3-codex'), 'claude-opus-4-8');
});

test('equivalentModel: targetProvider gates the direction', () => {
  assert.equal(equivalentModel('claude-opus-4-8', 'openai'), 'gpt-5.6-sol');
  assert.equal(equivalentModel('claude-opus-4-8', 'anthropic'), null); // already anthropic
  assert.equal(equivalentModel('gpt-5.6-terra', 'anthropic'), 'claude-sonnet-5');
  assert.equal(equivalentModel('gpt-5.6-terra', 'openai'), null);
});

test('equivalentModel: cheap-utility and unmapped ids have no equivalent', () => {
  assert.equal(equivalentModel('gpt-5.4-mini'), null);
  assert.equal(equivalentModel('gpt-5.4-nano'), null);
  assert.equal(equivalentModel('llama-3-70b'), null);
  assert.equal(equivalentModel(''), null);
});

test('map constants are consistent and cover the four aligned tiers', () => {
  assert.equal(Object.keys(ANTHROPIC_TO_OPENAI).length, 4);
  assert.equal(Object.keys(OPENAI_TO_ANTHROPIC).length, 4);
  assert.deepEqual(OPENAI_CHEAP_UTILITY, ['gpt-5.4-mini', 'gpt-5.4-nano']);
  assert.equal(OPENAI_CODING_ALT, 'gpt-5.3-codex');
  // Every OpenAI value in the A→O map normalizes to a key in the reverse map.
  for (const openaiId of new Set(Object.values(ANTHROPIC_TO_OPENAI))) {
    assert.ok(OPENAI_TO_ANTHROPIC[normalizeModelId(openaiId)], `reverse map missing ${openaiId}`);
  }
});

test('MODEL_EQUIVALENCE_TABLE: six rows, mini/nano have no Anthropic twin', () => {
  assert.equal(MODEL_EQUIVALENCE_TABLE.length, 6);
  const utility = MODEL_EQUIVALENCE_TABLE.filter((r) => r.anthropic === null);
  assert.deepEqual(utility.map((r) => r.openai), ['gpt-5.4-mini', 'gpt-5.4-nano']);
  // Each mapped row round-trips through equivalentModel.
  for (const row of MODEL_EQUIVALENCE_TABLE.filter((r) => r.anthropic)) {
    assert.equal(equivalentModel(row.anthropic), row.openai);
  }
});
