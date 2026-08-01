// The models offered in every model dropdown (slots, routing rules, lane
// tuning), grouped by provider. Pick by effort/quality vs. cost — spend the
// top tier only where the work is hard (agentic coding), the mid tier where
// quality matters at lower cost, the cheap tier for low-risk stages. Prices
// are the published base input/output rate per million tokens (used only for
// the in-menu hint; the billing sheet lives in the backend's quota-logic).
export const MODEL_OPTIONS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'Highest effort — frontier thinking, coding, agentic', inPerM: 5, outPerM: 25 },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', tier: 'High effort — thinking, coding, agentic', inPerM: 5, outPerM: 25 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'Fast code model — near-Opus coding at Sonnet cost', inPerM: 3, outPerM: 15 },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'Balanced — quality at lower cost', inPerM: 3, outPerM: 15 },
  { id: 'claude-haiku-4-6', label: 'Claude Haiku 4.6', tier: 'Fast & cheap — low-risk tasks', inPerM: 1, outPerM: 5 },
];

// The OpenAI catalog is deliberately just the three active 5.6 tiers — the
// same trio the per-phase routing maps use (top=sol, mid=terra, cheap=luna).
// gpt-5.5-pro is legacy/uncached and off the menu on purpose. Rates are the
// 2026-07-30 sheet (luna cut ~80%, terra ~20%).
export const OPENAI_MODEL_OPTIONS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tier: 'Highest effort — flagship coding + complex tool use', inPerM: 5, outPerM: 30 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', tier: 'Balanced — production coding at lower cost', inPerM: 2, outPerM: 12 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', tier: 'Fast & cheap — low-risk tasks', inPerM: 0.2, outPerM: 1.2 },
];

const ALL_MODEL_OPTIONS = [...MODEL_OPTIONS, ...OPENAI_MODEL_OPTIONS];

// Suggested model per slot (a recommendation — the dropdown lets you
// override), sized the same way on both providers: top tier for the agentic
// build/remediation, mid tier for the quality-sensitive design + audit
// stages, cheap tier for the classify/summarize stages.
export const SLOT_SUGGESTED_MODEL = {
  concept_chat: 'claude-sonnet-4-6',
  mockup: 'claude-sonnet-4-6',
  audit: 'claude-sonnet-4-6',
  classifier: 'claude-haiku-4-6',
  build_runner: 'claude-opus-5',
  summary: 'claude-haiku-4-6',
  remediation: 'claude-opus-5',
};

export const SLOT_SUGGESTED_MODEL_OPENAI = {
  concept_chat: 'gpt-5.6-terra',
  mockup: 'gpt-5.6-terra',
  audit: 'gpt-5.6-terra',
  classifier: 'gpt-5.6-luna',
  build_runner: 'gpt-5.6-sol',
  summary: 'gpt-5.6-luna',
  remediation: 'gpt-5.6-sol',
};

// The suggestion for a slot given the connector's provider.
export function suggestedModelForSlot(slot, provider) {
  return provider === 'openai' ? SLOT_SUGGESTED_MODEL_OPENAI[slot] : SLOT_SUGGESTED_MODEL[slot];
}

// The recommended escalation model for routing rules: after a failed/blocked
// attempt (or a difficulty-5 task) step up to the strongest coding model.
export const RECOMMENDED_ESCALATE_MODEL = 'claude-opus-5';

export const modelLabel = (id) => ALL_MODEL_OPTIONS.find((m) => m.id === id)?.label || id;

const withCurrent = (base, current) => {
  if (!current || base.some((m) => m.id === current)) return base;
  return [...base, { id: current, label: current, tier: 'Current assignment', inPerM: null, outPerM: null }];
};

// Options for a dropdown whose current value may be a custom model id that is
// not in the standard list — the dropdown must never silently drop it.
// Provider-agnostic contexts (routing rules, lane tuning) see both catalogs.
export function modelOptionsWith(current) {
  return withCurrent(ALL_MODEL_OPTIONS, current);
}

// Provider-aware options for a dropdown tied to ONE connector (the slot
// assignment): an Anthropic connector serves only Claude ids, an OpenAI
// connector only the three active GPT-5.6 tiers. Local / OpenAI-compatible
// providers take arbitrary ids, so they see both catalogs plus the current
// assignment.
export function modelOptionsForProvider(provider, current) {
  const base = provider === 'openai' ? OPENAI_MODEL_OPTIONS
    : provider === 'anthropic' ? MODEL_OPTIONS
      : ALL_MODEL_OPTIONS;
  return withCurrent(base, current);
}
