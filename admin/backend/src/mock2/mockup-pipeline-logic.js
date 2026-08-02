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
import { defaultModelPrice } from './quota-logic.js';

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

// ---- hybrid roles (operator rule 2026-08: best flagship, cheapest tier) ----
//
// With the usable providers known, the roles go cross-provider like phase
// routing does:
//   * FLAGSHIP (planner + doc + escalation target): the BEST available —
//     Fable 5 whenever Anthropic is configured (priced above Opus for a
//     reason), else Sol.
//   * every other role: the LOWEST-COST model at that tier across the
//     configured providers, priced live off the sheet (defaultModelPrice is
//     date-aware, so Sonnet-vs-Terra flips automatically when the Sonnet 5
//     promo ends 2026-09-01).
//   * on a SECOND failure of a role's model, the caller elevates one tier
//     (executor → flagship; tweaks already climb the tweak→render ladder).

const TIER_CANDIDATES = Object.freeze({
  flagship: Object.freeze({ anthropic: MODEL_FRONTIER, openai: 'gpt-5.6-sol' }),
  mid: Object.freeze({ anthropic: MODEL_BALANCED, openai: 'gpt-5.6-terra' }),
  cheap: Object.freeze({ anthropic: MODEL_CHEAP, openai: 'gpt-5.6-luna' }),
});

// A comparable per-mtok rate for tier ranking: input + output list rate.
// Renders are output-heavy, but the ordering is what matters and this stays
// honest as the sheet changes. Unpriced models rank last (never chosen over
// a priced one).
export function blendedRateCents(model, { date = null } = {}) {
  const p = defaultModelPrice(model, { date });
  return p ? Number(p.input_cents_per_mtok || 0) + Number(p.output_cents_per_mtok || 0) : null;
}

export function cheapestAtTier(tier, providers = [], { date = null } = {}) {
  const candidates = TIER_CANDIDATES[tier] || {};
  let best = null;
  for (const provider of providers || []) {
    const model = candidates[provider];
    if (!model) continue;
    const rate = blendedRateCents(model, { date });
    if (!best || (rate != null && (best.rate == null || rate < best.rate))) {
      best = { model, provider, rate };
    }
  }
  return best ? { model: best.model, provider: best.provider } : null;
}

export function bestFlagship(providers = []) {
  // Fable 5 is the best available whenever Anthropic is configured; Sol
  // otherwise. (Not a price pick — "for Flagship, default to the best".)
  if ((providers || []).includes('anthropic')) return { model: MODEL_FRONTIER, provider: 'anthropic' };
  if ((providers || []).includes('openai')) return { model: 'gpt-5.6-sol', provider: 'openai' };
  return null;
}

// The hybrid role set for the configured providers, or null when none are
// routable. Every role is { model, provider } so the caller can resolve a
// connector per role (cross-provider, like the phase router).
export function mockupPipelineRoles({ providers = [], date = null } = {}) {
  const planner = bestFlagship(providers);
  if (!planner) return null;
  const executor = cheapestAtTier('mid', providers, { date });
  const tweakExecutor = cheapestAtTier('cheap', providers, { date });
  if (!executor || !tweakExecutor) return null;
  return { planner, executor, tweakExecutor };
}

// The full decision: hybrid roles when the two-stage pipeline governs this
// render, else null (flagship/legacy path). `providers` is the usable set
// (detectPhaseProviders over the connector rows); when absent/empty the
// single-connector fallback keys off `provider` (the mockup slot's), keeping
// pre-hybrid behavior for installs the detector can't see.
export function mockupPipelinePlan({ preset = null, provider = null, providers = null, env = {}, date = null } = {}) {
  if (mockupPipelineMode(env) !== 'on') return null;
  if (!pipelineAppliesForPreset(preset)) return null;
  if (Array.isArray(providers) && providers.length) {
    const roles = mockupPipelineRoles({ providers, date });
    if (roles) return roles;
  }
  const single = mockupPipelineModels(provider);
  if (!single) return null;
  const p = String(provider || '').trim().toLowerCase();
  return {
    planner: { model: single.planner, provider: p },
    executor: { model: single.executor, provider: p },
    tweakExecutor: { model: single.tweakExecutor, provider: p },
  };
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
