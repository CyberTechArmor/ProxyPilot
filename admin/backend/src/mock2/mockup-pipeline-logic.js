// Mockup PIPELINE pure decision layer — the plan-then-execute split for
// preset-based designs, and the design-requirements document.
//
// Cost shape this fixes: the mockup lane was the platform's most expensive
// line item (every render on the flagship). When a project uses a PRE-BUILT
// design (a chosen preset), the creative work is already done — the flagship
// is spent transcribing a brief onto a known palette. So:
//
//   * PRESET chosen → TWO stages. The flagship (Fable 5 / Sol) does the
//     DESIGN REQUIREMENTS: it reads the brief + preset contract and writes a
//     tailor-made render plan; a Sonnet/Terra-level executor carries it out.
//     Changes (tweaks) run the same way — the high model plans the exact
//     edits, a Luna/Haiku-level executor applies them.
//   * NO preset ("let the AI decide" / explore) → the flagship renders
//     directly, unchanged: a fresh look is exactly where it earns its price.
//
// On approval, alongside the HTML mockup and the inventory, the flagship
// writes state/design-requirements.md — the design requirements, the
// functional requirements (what is being built and why), helpful context,
// and every user ask that is FUNCTION rather than design. Preset projects
// get (and use) the same document, and every build reads it.
//
// PURE (stub-first, risk R9): model choices + prompt text only — no I/O.
// Terminology (risk R7): nothing here is named "agent".

import { MODEL_FRONTIER, MODEL_BALANCED, MODEL_CHEAP } from './models.js';
import { DESIGN_PRESET_AI } from './design-presets.js';

// ---- toggle (default on; 'off' restores single-model mockup renders) ----

export const MOCKUP_PIPELINE_FLAG = 'MOCK2_MOCKUP_PIPELINE';

export function mockupPipelineMode(env = {}) {
  const v = String(env?.[MOCKUP_PIPELINE_FLAG] ?? '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' ? 'off' : 'on';
}

// The split applies only when a REAL preset governs the look — 'ai'/empty
// (the model designs freely) keeps the flagship path.
export function pipelineAppliesForPreset(preset) {
  const p = String(preset || '').trim();
  return !!p && p !== DESIGN_PRESET_AI;
}

// ---- model roles per provider (single-connector: the mockup slot's) ----

// planner  — flagship: writes the design requirements / render plan / edit plan
// executor — Sonnet/Terra level: renders the HTML from the plan
// tweakExecutor — Luna/Haiku level: applies planned surgical edits
const PIPELINE_MODELS = Object.freeze({
  anthropic: Object.freeze({ planner: MODEL_FRONTIER, executor: MODEL_BALANCED, tweakExecutor: MODEL_CHEAP }),
  openai: Object.freeze({ planner: 'gpt-5.6-sol', executor: 'gpt-5.6-terra', tweakExecutor: 'gpt-5.6-luna' }),
});

// The roles for the mockup slot connector's provider, or null (unknown/local
// provider → the legacy single-model path; never guess a model id).
export function mockupPipelineModels(provider) {
  return PIPELINE_MODELS[String(provider || '').trim().toLowerCase()] || null;
}

// The full decision: { planner, executor, tweakExecutor } when the two-stage
// pipeline governs this render, else null (flagship/legacy path).
export function mockupPipelinePlan({ preset = null, provider = null, env = {} } = {}) {
  if (mockupPipelineMode(env) !== 'on') return null;
  if (!pipelineAppliesForPreset(preset)) return null;
  return mockupPipelineModels(provider);
}

// ---- the design-plan step (flagship → tailor-made executor prompt) ----

export const DESIGN_PLAN_SYSTEM_PROMPT = `You are the design director for a mockup pipeline. A cheaper model will
render (or edit) the HTML mockup — YOU write the plan it executes. The
project uses a locked design preset: the palette, typography, and component
CSS already exist. Your plan must be so concrete that faithful transcription
is enough.

Write a RENDER PLAN (or, for a change request, an EDIT PLAN) containing:
1. Screens and layout: every screen to render, its exact structure
   (regions, navigation pattern, density), in order.
2. Components: which preset classes/components to use where — never invent
   new palette values; everything styles through the preset's tokens.
3. Content: realistic example content per screen (names, counts, states —
   never lorem ipsum).
4. Interactions: what is clickable and what it does within the mockup.
5. For an EDIT PLAN: the exact elements to change, what each becomes, and
   what must NOT change. Prefer the smallest set of surgical edits.
6. Constraints the executor must not violate (accessibility, mobile-first,
   the preset's art direction).

Output ONLY the plan, as tight numbered markdown. No HTML. No preamble.`;

export function buildDesignPlanTask({
  brief = '', presetName = '', hasMockup = false, tweak = false, requirementsDoc = '',
} = {}) {
  const parts = [
    tweak
      ? 'Write the EDIT PLAN for this change request against the existing mockup.'
      : `Write the RENDER PLAN for ${hasMockup ? 'an iteration of the existing mockup' : 'the first mockup'}.`,
    presetName ? `Design preset in force: ${presetName}.` : null,
    requirementsDoc ? `Design & functional requirements on record:\n${requirementsDoc}` : null,
    `The request:\n${brief}`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

// The executor's task: the plan riding ABOVE the original ask, so the cheap
// model transcribes the director's spec instead of designing.
export function buildExecutorTask({ plan = '', originalTask = '' } = {}) {
  return `RENDER PLAN from the design director — follow it exactly; where the plan and your own taste disagree, the plan wins:\n\n${plan}\n\n---\n\n${originalTask}`;
}

// ---- the design-requirements document (written at approval, read by builds) ----

export const DESIGN_REQUIREMENTS_PATH = 'state/design-requirements.md';

export const DESIGN_REQUIREMENTS_SYSTEM_PROMPT = `You write the design-requirements document for an approved mockup — the
record a build model reads BEFORE implementing. You are given the design
conversation and the extracted inventory. Write markdown with EXACTLY these
sections:

# Design requirements
The approved look and why it is that way: palette/preset in force, layout
and navigation patterns, density, component conventions, states that matter.

# Functional requirements
What is being built and why — the app's purpose, the capabilities per
screen, and behavior the conversation agreed on. Every action from the
inventory belongs to a visible, labeled control on its screen.

# Functional asks that are not design
Every request from the conversation that is FUNCTION rather than look —
integrations, data rules, roles/permissions, performance — quoted or
tightly paraphrased. A summarizer cannot recover these later; capture them
now. Write "None." if there were none.

# Context for the build
Anything else a build model would otherwise have to guess: naming, domain
vocabulary, what to leave out, known constraints.

Be specific and quote the user where wording matters. No preamble.`;

export function buildDesignRequirementsTask({ projectName = '', presetName = '', chatDigest = '', inventoryJson = '' } = {}) {
  return [
    `Project: ${projectName || 'unnamed'}.`,
    presetName ? `Design preset in force: ${presetName}.` : 'Design: AI-derived (approved from the mockup).',
    chatDigest ? `Design conversation (chronological):\n${chatDigest}` : null,
    inventoryJson ? `Extracted inventory:\n${inventoryJson}` : null,
  ].filter(Boolean).join('\n\n');
}

// The pointer every build instruction carries (hedged for projects approved
// before the document existed).
export const DESIGN_REQUIREMENTS_BUILD_NOTE =
  `6) If ${DESIGN_REQUIREMENTS_PATH} exists, read it before planning: it carries the design requirements, the `
  + 'functional requirements (what is being built and why), and the user\'s function-not-design asks. Where it '
  + 'names a capability or constraint, it is part of the contract.';
