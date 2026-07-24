// The Claude models offered in every model dropdown (slots, routing rules,
// lane tuning). Pick by effort/quality vs. cost — spend Opus only where the
// work is hard (agentic coding), Sonnet where quality matters at lower cost,
// Haiku for cheap low-risk stages. Prices are the published base input/output
// rate per million tokens (used only for the in-menu hint).
export const MODEL_OPTIONS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'Highest effort — frontier thinking, coding, agentic', inPerM: 5, outPerM: 25 },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', tier: 'High effort — thinking, coding, agentic', inPerM: 5, outPerM: 25 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'Fast code model — near-Opus coding at Sonnet cost', inPerM: 3, outPerM: 15 },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'Balanced — quality at lower cost', inPerM: 3, outPerM: 15 },
  { id: 'claude-haiku-4-6', label: 'Claude Haiku 4.6', tier: 'Fast & cheap — low-risk tasks', inPerM: 1, outPerM: 5 },
];

// Suggested model per slot (a recommendation — the dropdown lets you override).
// Opus for the agentic build/remediation; Sonnet for the quality-sensitive design
// + audit stages; Haiku for the cheap classify/summarize stages.
export const SLOT_SUGGESTED_MODEL = {
  concept_chat: 'claude-sonnet-4-6',
  mockup: 'claude-sonnet-4-6',
  audit: 'claude-sonnet-4-6',
  classifier: 'claude-haiku-4-6',
  build_runner: 'claude-opus-5',
  summary: 'claude-haiku-4-6',
  remediation: 'claude-opus-5',
};

// The recommended escalation model for routing rules: after a failed/blocked
// attempt (or a difficulty-5 task) step up to the strongest coding model.
export const RECOMMENDED_ESCALATE_MODEL = 'claude-opus-5';

export const modelLabel = (id) => MODEL_OPTIONS.find((m) => m.id === id)?.label || id;

// Options for a dropdown whose current value may be a custom model id that is
// not in the standard list — the dropdown must never silently drop it.
export function modelOptionsWith(current) {
  if (!current || MODEL_OPTIONS.some((m) => m.id === current)) return MODEL_OPTIONS;
  return [...MODEL_OPTIONS, { id: current, label: current, tier: 'Current assignment', inPerM: null, outPerM: null }];
}
