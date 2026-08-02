// Mockup pipeline pure layer — the plan-then-execute split for preset-based
// designs, the design-requirements document, and the label-parity rule.
// Stub-first (risk R9): native-free imports only.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOCKUP_PIPELINE_FLAG,
  mockupPipelineMode,
  pipelineAppliesForPreset,
  mockupPipelineModels,
  mockupPipelinePlan,
  buildDesignPlanTask,
  buildExecutorTask,
  DESIGN_PLAN_SYSTEM_PROMPT,
  DESIGN_REQUIREMENTS_PATH,
  DESIGN_REQUIREMENTS_SYSTEM_PROMPT,
  buildDesignRequirementsTask,
  DESIGN_REQUIREMENTS_BUILD_NOTE,
  mockupPipelineRoles,
  bestFlagship,
  cheapestAtTier,
  blendedRateCents,
} from '../mock2/mockup-pipeline-logic.js';
import { actionLabelParityMode, ACTION_LABEL_PARITY_FLAG } from '../mock2/acceptance-logic.js';

// ---- the toggle and when the split applies ----

test('pipeline defaults on; only off/0/false disables', () => {
  assert.equal(mockupPipelineMode({}), 'on');
  assert.equal(mockupPipelineMode({ [MOCKUP_PIPELINE_FLAG]: 'off' }), 'off');
  assert.equal(mockupPipelineMode({ [MOCKUP_PIPELINE_FLAG]: 'junk' }), 'on');
});

test('the split applies to REAL presets only — "let the AI decide" keeps the flagship', () => {
  assert.equal(pipelineAppliesForPreset('portal-blue'), true);
  assert.equal(pipelineAppliesForPreset('folio-warm'), true);
  assert.equal(pipelineAppliesForPreset('ai'), false);
  assert.equal(pipelineAppliesForPreset(''), false);
  assert.equal(pipelineAppliesForPreset(null), false);
});

test('roles per provider: flagship plans, Sonnet/Terra renders, Luna/Haiku tweaks', () => {
  assert.deepEqual(mockupPipelineModels('anthropic'), {
    planner: 'claude-fable-5', executor: 'claude-sonnet-5', tweakExecutor: 'claude-haiku-4-5',
  });
  assert.deepEqual(mockupPipelineModels('openai'), {
    planner: 'gpt-5.6-sol', executor: 'gpt-5.6-terra', tweakExecutor: 'gpt-5.6-luna',
  });
  // Unknown/local providers never guess a model id → legacy path.
  assert.equal(mockupPipelineModels('ollama'), null);
  assert.equal(mockupPipelineModels(null), null);
});

test('mockupPipelinePlan combines toggle + preset + provider(s); roles carry provider', () => {
  const on = mockupPipelinePlan({ preset: 'portal-blue', provider: 'anthropic', env: {} });
  assert.deepEqual(on.planner, { model: 'claude-fable-5', provider: 'anthropic' });
  assert.equal(mockupPipelinePlan({ preset: 'ai', provider: 'anthropic', env: {} }), null);
  assert.equal(mockupPipelinePlan({ preset: 'portal-blue', provider: 'anthropic', env: { [MOCKUP_PIPELINE_FLAG]: 'off' } }), null);
  assert.equal(mockupPipelinePlan({ preset: 'portal-blue', provider: 'ollama', env: {} }), null);
  // Hybrid: an empty providers list falls back to the single-provider shape.
  const fb = mockupPipelinePlan({ preset: 'portal-blue', provider: 'openai', providers: [], env: {} });
  assert.deepEqual(fb.executor, { model: 'gpt-5.6-terra', provider: 'openai' });
});

// ---- hybrid roles (operator rule: best flagship, cheapest per tier) ----

test('hybrid: flagship is the BEST available — Fable 5 whenever Anthropic is configured', () => {
  assert.deepEqual(bestFlagship(['anthropic', 'openai']), { model: 'claude-fable-5', provider: 'anthropic' });
  assert.deepEqual(bestFlagship(['openai']), { model: 'gpt-5.6-sol', provider: 'openai' });
  assert.equal(bestFlagship([]), null);
  const both = mockupPipelineRoles({ providers: ['anthropic', 'openai'], date: '2026-08-15' });
  assert.equal(both.planner.model, 'claude-fable-5');
});

test('hybrid: every other role takes the LOWEST-COST model at its tier, date-aware', () => {
  const both = ['anthropic', 'openai'];
  // Cheap tier: Luna ($0.20+$1.20) undercuts Haiku ($1+$5) — always OpenAI.
  assert.deepEqual(cheapestAtTier('cheap', both, { date: '2026-08-15' }), { model: 'gpt-5.6-luna', provider: 'openai' });
  // Mid tier flips with the Sonnet 5 promo: $2+$10 beats Terra's $2+$12 in
  // August; from 2026-09-01 Sonnet is $3+$15 and Terra wins.
  assert.deepEqual(cheapestAtTier('mid', both, { date: '2026-08-15' }), { model: 'claude-sonnet-5', provider: 'anthropic' });
  assert.deepEqual(cheapestAtTier('mid', both, { date: '2026-09-02' }), { model: 'gpt-5.6-terra', provider: 'openai' });
  // Single provider: its own column.
  assert.deepEqual(cheapestAtTier('mid', ['openai'], { date: '2026-08-15' }), { model: 'gpt-5.6-terra', provider: 'openai' });
  // Full role set under the promo.
  const roles = mockupPipelineRoles({ providers: both, date: '2026-08-15' });
  assert.deepEqual(roles, {
    planner: { model: 'claude-fable-5', provider: 'anthropic' },
    executor: { model: 'claude-sonnet-5', provider: 'anthropic' },
    tweakExecutor: { model: 'gpt-5.6-luna', provider: 'openai' },
  });
  assert.ok(blendedRateCents('gpt-5.6-luna') < blendedRateCents('claude-haiku-4-5'));
});

// ---- prompts ----

test('plan task carries the preset, the requirements doc, and the tweak/render distinction', () => {
  const render = buildDesignPlanTask({ brief: 'a docs app', presetName: 'Portal Blue', hasMockup: false, requirementsDoc: 'REQ' });
  assert.match(render, /RENDER PLAN for the first mockup/);
  assert.ok(render.includes('Portal Blue') && render.includes('REQ') && render.includes('a docs app'));
  const tweak = buildDesignPlanTask({ brief: 'make the header blue', tweak: true });
  assert.match(tweak, /EDIT PLAN/);
  // The executor task puts the plan ABOVE the original ask and declares it binding.
  const exec = buildExecutorTask({ plan: 'THE PLAN', originalTask: 'THE TASK' });
  assert.ok(exec.indexOf('THE PLAN') < exec.indexOf('THE TASK'));
  assert.match(exec, /the plan wins/);
  assert.match(DESIGN_PLAN_SYSTEM_PROMPT, /Output ONLY the plan/);
});

test('the requirements document: fixed sections incl. function-not-design asks', () => {
  for (const section of ['# Design requirements', '# Functional requirements', '# Functional asks that are not design', '# Context for the build']) {
    assert.ok(DESIGN_REQUIREMENTS_SYSTEM_PROMPT.includes(section), section);
  }
  const task = buildDesignRequirementsTask({ projectName: 'Docs', presetName: 'Portal Blue', chatDigest: 'Builder: hello', inventoryJson: '{"screens":[]}' });
  assert.ok(task.includes('Docs') && task.includes('Portal Blue') && task.includes('Builder: hello'));
  // No preset → the doc still generates (AI-derived designs use it too).
  assert.match(buildDesignRequirementsTask({ projectName: 'X' }), /AI-derived/);
  assert.equal(DESIGN_REQUIREMENTS_PATH, 'state/design-requirements.md');
  assert.ok(DESIGN_REQUIREMENTS_BUILD_NOTE.includes(DESIGN_REQUIREMENTS_PATH));
});

// ---- the label-parity rule (operator rule 2026-08) ----

test('label parity enforces by default; warn restores report-only', () => {
  assert.equal(actionLabelParityMode({}), 'enforce');
  assert.equal(actionLabelParityMode({ [ACTION_LABEL_PARITY_FLAG]: 'warn' }), 'warn');
  assert.equal(actionLabelParityMode({ [ACTION_LABEL_PARITY_FLAG]: 'off' }), 'warn');
  assert.equal(actionLabelParityMode({ [ACTION_LABEL_PARITY_FLAG]: 'enforce' }), 'enforce');
  assert.equal(actionLabelParityMode({ [ACTION_LABEL_PARITY_FLAG]: 'junk' }), 'enforce');
});
