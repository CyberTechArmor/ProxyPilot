// Mock2 design-template PURE decision layer. Native-free, unit-tested
// stub-first (risk R9), same split as concept-logic.js / component-logic.js.
//
// A DESIGN TEMPLATE is a portable JSON document carrying ONLY the design half
// of a project — the interactive mockup HTML, the original design brief (the
// first thing the Builder asked for), the design conversation, and the
// extracted design tokens when they exist. It carries NO application code, so
// a Builder can start a NEW project from a mockup they already have without
// inheriting any implementation.
//
// Two flows use it (concept.js is the orchestration, routes.js the surface):
//   - EXPORT: download a project's design as <slug>.design-template.json.
//   - IMPORT: seed a fresh project's Concept stage from a template — either an
//     uploaded document or another project picked from the list (the server
//     exports that project's template internally; same document either way).
// On import the Builder may add changes/context notes; the template's original
// prompt + those notes seed the chat transcript AND are carried into the
// initial build instruction, so the build references the original design
// intent even when the Builder approves the imported mockup untouched.
//
// Terminology (risk R7): nothing here is named "agent".

import { isPlausibleMockup } from './concept-logic.js';

export const DESIGN_TEMPLATE_FORMAT = 'mock2.design-template';
export const DESIGN_TEMPLATE_VERSION = 1;

// Bounds. The HTML cap matches the concept stage's MAX_MOCKUP_CHARS (a real
// mockup is well under it); the rest keep a hand-crafted document from blowing
// the chat/build context.
export const MAX_TEMPLATE_HTML_CHARS = 200000;
export const MAX_TEMPLATE_PROMPT_CHARS = 8000;
export const MAX_TEMPLATE_CONVERSATION_CHARS = 20000;
export const MAX_IMPORT_NOTES_CHARS = 4000;
// How much of the imported brief/notes the initial build instruction quotes.
// Sized so base instruction + both excerpts stay under startBuild's
// getChatMaxChars() floor (4000) — the whole instruction survives untruncated.
const MAX_BUILD_REFERENCE_CHARS = 1500;

// Does a project have a design to export? Pre-approval the live pointer is
// set; post-approval the pointer moves to mockup_archived_id (the HTML stays
// at state/mockups/current.html — concept.js archiveMockups keeps it).
export function projectHasDesign(project) {
  return !!(project?.current_mockup_id || project?.mockup_archived_id);
}

// The ORIGINAL PROMPT — the first thing the Builder typed into the design
// chat. This is the "prompt from the first mockup" an import references when
// building; bounded so a runaway first message can't blow the template.
export function originalPromptFromMessages(messages = []) {
  for (const m of messages || []) {
    if (m && m.kind === 'user' && String(m.body || '').trim()) {
      return String(m.body).trim().slice(0, MAX_TEMPLATE_PROMPT_CHARS);
    }
  }
  return '';
}

// The design conversation — human/model turns only (system notes are UI
// context, not design intent), cut at approval when the project has one (the
// post-approval chat is build talk, not design), and capped from the START
// (the earliest turns carry the intent a template exists to preserve).
export function designConversation(messages = [], { approvedAt = null, maxChars = MAX_TEMPLATE_CONVERSATION_CHARS } = {}) {
  const lines = [];
  let used = 0;
  for (const m of messages || []) {
    if (!m || (m.kind !== 'user' && m.kind !== 'assistant')) continue;
    // created_at + design_approved_at are both nowIso() strings, so a lexical
    // compare is correct (same idiom as ConceptStage's archive filter).
    if (approvedAt && m.created_at && m.created_at >= approvedAt) break;
    const line = `${m.kind === 'user' ? 'Builder' : 'Design partner'}: ${String(m.body || '').trim()}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

// buildDesignTemplate — assemble the portable document. mockupHtml is read by
// the orchestration (container or bare repo); designTokens is the parsed
// state/design-tokens.json when the project has one (post-approval), else null
// — informational on export, always re-extracted from the HTML on approval.
export function buildDesignTemplate({ project, mockupHtml, designTokens = null, messages = [], exportedAt = null } = {}) {
  return {
    format: DESIGN_TEMPLATE_FORMAT,
    version: DESIGN_TEMPLATE_VERSION,
    exported_at: exportedAt || null,
    project: {
      name: String(project?.name || ''),
      description: project?.description ? String(project.description) : null,
    },
    original_prompt: originalPromptFromMessages(messages),
    conversation: designConversation(messages, { approvedAt: project?.design_approved_at || null }),
    mockup_html: String(mockupHtml || '').slice(0, MAX_TEMPLATE_HTML_CHARS),
    design_tokens: designTokens && typeof designTokens === 'object' && !Array.isArray(designTokens) ? designTokens : null,
  };
}

// parseDesignTemplate — validate an incoming document (an upload is untrusted
// input) into a normalized template. Returns { ok, template, error }. The
// mockup must be real HTML (isPlausibleMockup — same bar the concept stage
// holds the model to) and within the size cap; everything else is bounded
// strings. design_tokens ride along untouched — approval re-extracts tokens
// from the HTML, so they are reference data, never applied verbatim.
export function parseDesignTemplate(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'not a design template document (expected a JSON object)' };
  }
  if (doc.format !== DESIGN_TEMPLATE_FORMAT) {
    return { ok: false, error: `not a design template (format must be "${DESIGN_TEMPLATE_FORMAT}")` };
  }
  if (Number(doc.version) !== DESIGN_TEMPLATE_VERSION) {
    return { ok: false, error: `unsupported design template version ${doc.version} (this host supports version ${DESIGN_TEMPLATE_VERSION})` };
  }
  const html = String(doc.mockup_html || '');
  if (html.length > MAX_TEMPLATE_HTML_CHARS) {
    return { ok: false, error: `mockup_html is too large (${html.length} chars; max ${MAX_TEMPLATE_HTML_CHARS})` };
  }
  if (!isPlausibleMockup(html)) {
    return { ok: false, error: 'mockup_html is not a usable HTML mockup' };
  }
  const tokens = doc.design_tokens;
  const template = {
    name: String(doc.project?.name || '').slice(0, 200),
    description: doc.project?.description ? String(doc.project.description).slice(0, 2000) : null,
    original_prompt: String(doc.original_prompt || '').trim().slice(0, MAX_TEMPLATE_PROMPT_CHARS),
    conversation: String(doc.conversation || '').slice(0, MAX_TEMPLATE_CONVERSATION_CHARS),
    mockup_html: html,
    design_tokens: tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? tokens : null,
    exported_at: doc.exported_at ? String(doc.exported_at).slice(0, 40) : null,
  };
  return { ok: true, template };
}

// A path-safe mockup id for an imported design. No cycle exists (an import is
// a plain write, no model call), so the id is time-derived; mockupFileName
// sanitizes it into state/mockups/<id>.html.
export function mockupIdForImport(nowMs) {
  return `mk-import-${Number(nowMs).toString(36)}`;
}

// The chat message that seeds the transcript on import. It is inserted as a
// 'user' turn (authored by the importer) so every later concept turn — and the
// mockup iterations it requests — sees the original design intent in the
// transcript, exactly as if the Builder had typed it. Empty when the template
// carries no prompt and the Builder added no notes (nothing to seed).
export function buildImportSeedMessage({ originalPrompt = '', notes = '', sourceName = null } = {}) {
  const prompt = String(originalPrompt || '').trim();
  const extra = String(notes || '').trim().slice(0, MAX_IMPORT_NOTES_CHARS);
  if (!prompt && !extra) return '';
  const parts = [`[Imported design template${sourceName ? ` — from "${sourceName}"` : ''}]`];
  if (prompt) parts.push(`Original design brief (the reference for what this app should be):\n${prompt}`);
  if (extra) parts.push(`Changes/context for this project:\n${extra}`);
  return parts.join('\n\n');
}

// The record stored on mock2_projects.design_import_json (migration 519) so
// the design intent survives to the initial build even if the chat is long.
export function designImportRecord({ template, notes = '', source = 'file', sourceName = null, importedBy = null, importedAt = null, mockupId = null } = {}) {
  return {
    source,                                   // 'file' | 'project'
    source_name: sourceName || template?.name || null,
    original_prompt: String(template?.original_prompt || '').slice(0, MAX_TEMPLATE_PROMPT_CHARS),
    notes: String(notes || '').trim().slice(0, MAX_IMPORT_NOTES_CHARS),
    imported_at: importedAt || null,
    imported_by: importedBy ?? null,
    mockup_id: mockupId || null,
  };
}

export function parseDesignImport(json) {
  if (!json) return null;
  try {
    const doc = JSON.parse(String(json));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

// buildInitialBuildInstruction — the instruction the auto-started initial
// build runs with. For a home-grown design it is the base verbatim; for an
// imported design it additionally quotes the original design brief (and the
// Builder's import notes when given), satisfying "use the original prompt from
// the first mockup as the reference when building".
export function buildInitialBuildInstruction({ base, designImport = null } = {}) {
  const instruction = String(base || '');
  const prompt = String(designImport?.original_prompt || '').trim();
  const notes = String(designImport?.notes || '').trim();
  if (!prompt && !notes) return instruction;
  const parts = [instruction, 'This project\'s design was imported from a design template.'];
  if (prompt) parts.push(`Original design brief — use it as the reference for the app's intent and behavior:\n${prompt.slice(0, MAX_BUILD_REFERENCE_CHARS)}`);
  if (notes) parts.push(`The Builder's changes/context for this build:\n${notes.slice(0, MAX_BUILD_REFERENCE_CHARS)}`);
  return parts.join('\n\n');
}
