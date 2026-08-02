// Harness step prompts — pure display/substitution side of per-step system
// prompt editing (operator decision, 2026-07: every step's system prompt is
// visible and editable on the Harness page).
//
// Each spec renders the step's SHIPPED system prompt with {{PLACEHOLDER}}
// markers standing in for the values the pipeline injects at call time
// (design system, constitution, project name, …). A stored operator override
// is used VERBATIM at call time with the same placeholders substituted — so
// an override keeps the dynamic content by keeping the markers. Steps whose
// prompt varies by mode (concept chat's Plan mode, the runner's MVP/quick
// variants) note it: an override replaces EVERY variant; the preview shows
// the primary one.
//
// Pure and native-free (risk R9): every builder imported here lives in a
// *-logic module. Storage and call-time application live in harness-steps.js.

import {
  buildConceptChatSystemPrompt,
  buildMockupSystemPrompt,
  buildMockupEditSystemPrompt,
  buildScreenRenderSystemPrompt,
  buildInventoryExtractionPrompt,
  buildDesignTokenExtractionPrompt,
  DESIGN_DOC_ADJUST_SYSTEM_PROMPT,
} from './concept-logic.js';
import { buildAuditSystemPrompt } from './audit-logic.js';
import { buildRunnerSystemPrompt } from './runner-logic.js';
import { buildPrepassPrompt, buildDistillSystemPrompt } from './prepass-logic.js';
import { buildChecklistPostPassPrompt } from './screen-plan-logic.js';
import { buildReviewPrompt } from './design-review-logic.js';
import { buildDesignOptionsPrompt } from './design-options-logic.js';
import { buildClarifyPrompt } from './clarify-logic.js';
import { buildDemoContentPrompt } from './demo-content-logic.js';
import { EXPLAIN_SYSTEM_PROMPT, EXPLAIN_FOLLOWUP_SYSTEM_PROMPT } from './explain-logic.js';
import { CONSULT_SYSTEM_PROMPT } from './consult-logic.js';
import { buildAskSystemPrompt } from './ask-logic.js';
import { CHAT_SUMMARY_SYSTEM_PROMPT } from './chat-summary-logic.js';
import { DOC_SUMMARY_SYSTEM_PROMPT } from './project-assets-logic.js';
import { DESIGN_PLAN_SYSTEM_PROMPT, DESIGN_REQUIREMENTS_SYSTEM_PROMPT } from './mockup-pipeline-logic.js';
import { CONTRACT_CLASSIFIER_PROMPT, BUILD_PLAN_SYSTEM_PROMPT } from './contract-classifier-logic.js';

export const STEP_PROMPT_MAX_LENGTH = 200_000;

// { [stepId]: { placeholders, note?, render } | { sharesPromptOf } }.
// placeholders lists the {{KEYS}} the call site substitutes; render produces
// the shipped prompt with those markers in place for display/editing.
export const STEP_PROMPT_SPECS = Object.freeze({
  'concept-chat': {
    placeholders: ['DESIGN_SYSTEM', 'PROJECT_NAME'],
    note: 'Variants exist (Plan mode; first turn with no mockup). An override replaces every variant — the preview shows Design mode with an existing mockup.',
    render: () => buildConceptChatSystemPrompt({ designSystem: '{{DESIGN_SYSTEM}}', projectName: '{{PROJECT_NAME}}', hasMockup: true, mode: 'design' }),
  },
  'mockup-render': {
    placeholders: ['DESIGN_SYSTEM'],
    render: () => buildMockupSystemPrompt({ designSystem: '{{DESIGN_SYSTEM}}' }),
  },
  'mockup-tweak': { placeholders: [], render: () => buildMockupEditSystemPrompt() },
  'mockup-screen': {
    placeholders: ['DESIGN_SYSTEM'],
    render: () => buildScreenRenderSystemPrompt({ designSystem: '{{DESIGN_SYSTEM}}' }),
  },
  'mockup-continuation': { sharesPromptOf: 'mockup-render' },
  'design-doc-adjust': { placeholders: [], render: () => DESIGN_DOC_ADJUST_SYSTEM_PROMPT },
  'inventory-extraction': { placeholders: [], render: () => buildInventoryExtractionPrompt() },
  'design-token-extraction': { placeholders: [], render: () => buildDesignTokenExtractionPrompt() },
  'mockup-design-plan': { placeholders: [], render: () => DESIGN_PLAN_SYSTEM_PROMPT },
  'design-requirements-doc': { placeholders: [], render: () => DESIGN_REQUIREMENTS_SYSTEM_PROMPT },
  'contract-classifier': { placeholders: [], render: () => CONTRACT_CLASSIFIER_PROMPT },
  'build-plan': { placeholders: [], render: () => BUILD_PLAN_SYSTEM_PROMPT },
  'rule-audit': {
    placeholders: ['CONSTITUTION', 'PROJECT_NAME'],
    render: () => buildAuditSystemPrompt({ constitution: '{{CONSTITUTION}}', projectName: '{{PROJECT_NAME}}' }),
  },
  'split-probe': { placeholders: [], render: () => buildPrepassPrompt() },
  'quick-prepass': { placeholders: [], render: () => buildPrepassPrompt() },
  'chat-distill': { placeholders: [], render: () => buildDistillSystemPrompt() },
  'build-runner': {
    placeholders: ['CONSTITUTION', 'APP_DIR', 'WEB_PORT'],
    note: 'Variants exist (MVP and Quick modes override sections; skills and the component catalog are injected per project). An override replaces EVERY variant — the preview shows a full build.',
    render: () => buildRunnerSystemPrompt({ constitution: '{{CONSTITUTION}}', appDir: '{{APP_DIR}}', webPort: '{{WEB_PORT}}', buildMode: 'full' }),
  },
  consult: { placeholders: [], render: () => CONSULT_SYSTEM_PROMPT },
  'explain-card': { placeholders: [], render: () => EXPLAIN_SYSTEM_PROMPT },
  'explain-followup': { placeholders: [], render: () => EXPLAIN_FOLLOWUP_SYSTEM_PROMPT },
  'chat-summary': { placeholders: [], render: () => CHAT_SUMMARY_SYSTEM_PROMPT },
  'doc-summary': { placeholders: [], render: () => DOC_SUMMARY_SYSTEM_PROMPT },
  'checklist-postpass': { placeholders: [], render: () => buildChecklistPostPassPrompt() },
  'design-review': { placeholders: [], render: () => buildReviewPrompt() },
  'design-options': { placeholders: [], render: () => buildDesignOptionsPrompt() },
  clarify: { placeholders: [], render: () => buildClarifyPrompt() },
  'demo-content': { placeholders: [], render: () => buildDemoContentPrompt() },
  ask: {
    placeholders: ['PROJECT_NAME', 'WEB_PORT', 'COMPONENTS'],
    note: 'The web-search availability line and installed-components section are injected per project; keep {{COMPONENTS}} where they should land.',
    render: () => buildAskSystemPrompt({ projectName: '{{PROJECT_NAME}}', webPort: '{{WEB_PORT}}', webSearch: false, installedComponentsSection: '{{COMPONENTS}}' }),
  },
});

// The step id that OWNS a step's prompt (shared prompts point at their owner).
export function promptOwnerStepId(stepId) {
  const spec = STEP_PROMPT_SPECS[stepId];
  if (!spec) return null;
  return spec.sharesPromptOf || stepId;
}

// The shipped prompt with placeholder markers, for display and as the editing
// starting point. null for unknown steps; shared steps render their owner's.
export function renderDefaultStepPrompt(stepId) {
  const owner = promptOwnerStepId(stepId);
  if (!owner) return null;
  const spec = STEP_PROMPT_SPECS[owner];
  try {
    return String(spec.render());
  } catch {
    return null;
  }
}

// Substitute {{KEY}} markers with call-time values. Unknown markers are left
// in place (visible in output beats silently vanishing context); values are
// stringified as-is.
export function substitutePromptPlaceholders(text, params = {}) {
  let out = String(text ?? '');
  for (const [key, value] of Object.entries(params)) {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  }
  return out;
}

// Normalize the stored prompt-override doc ({ [stepId]: string }). Unknown
// ids, shared ids (edits belong on the owner), and empty strings are dropped.
export function normalizeStepPrompts(raw) {
  let doc = raw;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch { doc = null; }
  }
  if (!doc || typeof doc !== 'object') return {};
  const out = {};
  for (const [id, text] of Object.entries(doc)) {
    const spec = STEP_PROMPT_SPECS[id];
    if (!spec || spec.sharesPromptOf) continue;
    const s = String(text ?? '');
    if (s.trim() === '') continue;
    out[id] = s.slice(0, STEP_PROMPT_MAX_LENGTH);
  }
  return out;
}
