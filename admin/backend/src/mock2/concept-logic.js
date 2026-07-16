// Mock2 Concept-stage PURE decision layer (Phase M7; brief's Flow section;
// survey §8, §11). Native-free, unit-tested stub-first (risk R9). Stage 1 —
// Concept — is the first user-facing stage: a Builder describes an idea in chat,
// the platform generates a non-functional interactive HTML mockup constrained to
// the pinned framework's LOCKED design system, iteration is conversational, and
// the only exit is a design-approval gesture that extracts a structured design
// inventory and discards the mockup code.
//
// Everything about that stage that can be decided without a model API,
// better-sqlite3, or Incus lives here: the RESTRICTED tool policy the
// concept_chat slot is offered (it can ONLY request a mockup — it structurally
// cannot write backend code or rules), the system-prompt assembly from the
// pinned design_system_md (ADR-003, exactly as the runner injects
// constitution_md), the mockup-HTML extraction, the design-inventory parse, the
// chat→transcript mapping, the stage indicator, and the cost envelope.
//
// concept.js (the host/model orchestration half) and the routes import these;
// the tests import ONLY this module.
//
// Terminology (risk R7): the AI build component is the RUNNER; the Stage-1
// component is the CONCEPT loop, driven by the concept_chat + mockup slots.
// Nothing here is named "agent".

import { parseAttachmentsJson, publicAttachmentShape } from './chat-image-logic.js';

// ---- in-repo paths (03-data-model.md: the concept stage lives in the repo) ----

export const MOCKUP_DIR = 'state/mockups';
export const MOCKUP_CURRENT = 'state/mockups/current.html'; // what the preview serves
export const INVENTORY_PATH = 'state/inventory.json';        // the concept-stage exit artifact
export const MOCKUP_PREVIEW_PATH = '/_preview/';             // dev-server route → MOCKUP_DIR

// The served + history filenames for a mockup id. current.html is what the
// preview URL resolves to; <id>.html keeps the iteration in git history.
export function mockupFileName(id) {
  const safe = String(id || 'mockup').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
  return `state/mockups/${safe}.html`;
}

// A stable, path-safe mockup id for a concept turn. Derived from the concept
// cycle id (one cycle per turn) so it is unique per project without a clock.
export function mockupIdForCycle(cycleId) {
  return `mk-${Number(cycleId)}`;
}

// ---- the RESTRICTED concept-stage tool policy (orchestrator-enforced) ----

// The concept_chat slot gets EXACTLY ONE tool: request a mockup. It never
// receives write_file / exec_in_container (the M6 runner's tools) — so the
// concept stage structurally CANNOT write backend code or rules. When the model
// asks for a mockup, the ORCHESTRATOR (concept.js) runs the mockup slot and
// writes the returned HTML to a FIXED state/mockups path; the model never names
// a path. This is the tool-dispatch enforcement the phase requires (not a prompt
// instruction). The model always ALSO replies in plain language (its text turn).
export const CONCEPT_CHAT_TOOLS = Object.freeze([
  {
    name: 'generate_mockup',
    description:
      'Produce or update the interactive HTML mockup for this idea. Call this whenever the conversation implies a new screen, a layout change, or a visual revision the Builder should see. Provide a clear, self-contained brief describing what the mockup should show and how it changed — a separate design model renders the HTML from your brief and the locked design system. You cannot write code, files, or rules; this is the only way to change what the Builder sees.',
    input_schema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: 'Plain-language description of the screens, sections, fields, and actions the mockup should show, and what changed since the last version.',
        },
      },
      required: ['brief'],
      additionalProperties: false,
    },
  },
]);

export const CONCEPT_CHAT_TOOL_NAMES = Object.freeze(CONCEPT_CHAT_TOOLS.map((t) => t.name));

// ---- system prompts (assembled server-side from the PINNED design system) ----

// buildConceptChatSystemPrompt — the concept_chat slot's system prompt. Injects
// the pinned design_system_md verbatim (ADR-003 / brief §4: the mockup is
// CONSTRAINED to the pinned framework's design system, never talked out of it),
// exactly as the runner injects constitution_md. The model is a friendly guide
// for a possibly non-technical Builder; it converses and requests mockups, and
// it cannot build the real app.
export function buildConceptChatSystemPrompt({ designSystem = '', projectName = 'this project', hasMockup = false, mode = 'design' } = {}) {
  const planMode = mode === 'plan';
  // PLAN mode: the orchestrator gives the model no tools, so it cannot generate a
  // mockup — its job is to think through the idea in conversation. DESIGN mode:
  // it may call generate_mockup. The prompt states the current mode so the model
  // sets the Builder's expectations correctly.
  const modeBlock = planMode
    ? `You are currently in PLAN mode. Your job right now is to help the Builder THINK
THROUGH the app in plain conversation — the problem, who uses it, the screens they
need, the information each screen collects or shows, and the key flows. Ask at most
one or two focused questions at a time. Do NOT design a mockup yet and do not claim
to have changed anything visual — in Plan mode you cannot. When the plan feels
clear, tell the Builder they can flip the toggle to DESIGN mode and you'll turn the
plan into an interactive mockup.`
    : `You are currently in DESIGN mode.

What you do:
- Have a normal, encouraging conversation about the app "${projectName}". Ask at
  most one or two focused questions at a time; never interrogate.
- When the idea is clear enough to show something — a screen, a layout, a form, a
  change to what exists — call the generate_mockup tool with a clear brief. A
  separate design model renders the HTML from your brief and the locked design
  system below. ${hasMockup ? 'A mockup already exists; describe it as a revision of the current one.' : 'No mockup exists yet; the first substantive idea should produce one.'}
- Always ALSO reply to the Builder in plain, warm language — say what you changed
  or what you need, and remind them they can approve the design when it feels right.`;
  return `You are the Mock2 Concept-stage design partner. You help a Builder — who may be
non-technical — turn an app idea into a clear, interactive mockup. This is Stage 1
of four (Concept → Define → Build → Run); you are ONLY doing Concept.

${modeBlock}

What you CANNOT do (this is structural, not a preference):
- You cannot write code, files, backend logic, or rules. You cannot build or run
  the real app. The mockup is non-functional — it demonstrates the idea, it does
  not run it. If asked to "build it" or "make it work", explain that the mockup
  comes first and Build is a later stage that unlocks after they approve the design.

The mockup is CONSTRAINED to this locked design system — never propose a look it
forbids; honor the system and say so if a request conflicts with it:

# Locked design system (pinned — binding, not advisory)
${designSystem || '(design system content is still owed — risk R8)'}

Keep replies short and concrete. Guide toward a design the Builder is happy to approve.`;
}

// buildMockupSystemPrompt — the mockup slot's system prompt. It renders a single
// self-contained HTML file that OBEYS the pinned design system. It gets no tools
// and no container access; the orchestrator writes its output to a fixed path.
export function buildMockupSystemPrompt({ designSystem = '' } = {}) {
  return `You are the Mock2 Stage-1 mockup renderer. You output ONE complete, self-contained
HTML document for a NON-FUNCTIONAL but interactive product mockup. It demonstrates
an idea; it does not run it (no real data, no backend, no network).

Hard requirements:
- Output ONLY the HTML document, starting with <!doctype html>. No markdown, no
  code fences, no commentary before or after.
- A SINGLE file: all CSS in a <style> tag and all JS in a <script> tag inline. No
  external hosts, fonts, scripts, stylesheets, or images — embed any image as a
  data: URI. The page must render with no network access.
- Obey the locked design system below EXACTLY: its color tokens, one type family,
  spacing rhythm, corner radii, and rules. Do not introduce other colors, fonts,
  or gradients-as-decoration.
- Mobile-first: every screen renders cleanly in a single column at 360–375px; any
  multi-column layout collapses to one column on small viewports. Tappable controls
  are at least 44×44px.
- Interactivity is fine (tabs, toggles, showing/hiding, fake navigation between
  in-page screens) but it must be self-contained and non-persistent.
- RENDER-ON-LOAD: the first/default screen must be VISIBLE immediately from the
  HTML + CSS alone, before any JavaScript runs. Do NOT hide the initial content
  with an inline style/attribute that a <script> later reveals — if the script
  errors the page must still show the first screen, never a blank/black page.
  JS only ENHANCES (switching screens, toggles); it never gates first paint.
- Output the COMPLETE document ending with </body></html>. Never stop partway —
  a truncated document renders as a blank page.

# Locked design system (binding)
${designSystem || '(design system content is still owed — risk R8)'}

Return the full HTML document and nothing else.`;
}

// The mockup slot's user turn: the brief + the current mockup (to iterate on) +
// a short recap of the conversation so the render reflects the whole idea.
export function buildMockupTask({ brief = '', currentHtml = null, projectName = 'the app', conversation = '' } = {}) {
  const parts = [`Project: ${projectName}`];
  if (conversation) parts.push(`Conversation so far (for context):\n${conversation}`);
  parts.push(`Design brief for this mockup:\n${String(brief || '').trim() || '(no brief — infer from the conversation)'}`);
  if (currentHtml) {
    parts.push(`The CURRENT mockup HTML is below — revise it to satisfy the brief, keeping everything else stable:\n\n${currentHtml}`);
  } else {
    parts.push('There is no existing mockup — create the first version.');
  }
  parts.push('Output the full updated HTML document only.');
  return parts.join('\n\n');
}

// ---- mockup HTML extraction ----

// extractMockupHtml — pull the HTML document out of a model text response. Models
// usually return raw HTML (as instructed) but sometimes wrap it in ```html …```
// fences or add a sentence; be tolerant. Returns the HTML string (trimmed) or ''.
export function extractMockupHtml(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  // Prefer a fenced block if present (```html … ``` or ``` … ```).
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && fence[1] && /<(?:!doctype|html|body|div|main|section)/i.test(fence[1])) {
    s = fence[1].trim();
  } else {
    // Otherwise, slice from the first doctype/<html> if there is leading prose.
    const start = s.search(/<!doctype html|<html[\s>]/i);
    if (start > 0) s = s.slice(start).trim();
  }
  return s;
}

// A response is a plausible mockup if it contains real HTML structure. Guards
// against the model returning an apology or an empty string (we then keep the
// previous mockup and tell the Builder).
export function isPlausibleMockup(html) {
  const s = String(html || '');
  if (s.length < 40) return false;
  // Must LOOK like an HTML document AND be COMPLETE. A render truncated on the
  // token budget (adaptive thinking eats into it) keeps its opening
  // <!doctype><html><body> and early closing tags (</style>, </title>) but
  // loses its tail — it renders as a black/blank screen. Requiring the document
  // to actually close (</html>, or at least </body>) rejects that truncation so
  // the pipeline retries with a bigger budget instead of saving a broken page.
  const opensDoc = /<!doctype html|<html[\s>]|<body[\s>]/i.test(s);
  const closesDoc = /<\/html\s*>|<\/body\s*>/i.test(s);
  return opensDoc && closesDoc;
}

// ---- design-inventory extraction (the concept-stage exit artifact) ----

// buildInventoryExtractionPrompt — the extractor's system prompt. On design
// approval the platform extracts a STRUCTURED inventory (every screen, each
// field with its type, each action, each state) from the approved mockup. The
// inventory — not the mockup markup — becomes the UI spec ("the inventory is the
// contract, not the pixels", design-system §6), so this must be complete and
// literal about what the mockup shows.
export function buildInventoryExtractionPrompt() {
  return `You extract a structured DESIGN INVENTORY from an approved product mockup. The
inventory — not the mockup's markup — becomes the specification the app is built
against, so be complete and literal about what the mockup actually shows.

Output ONLY a JSON object (no markdown, no code fences, no commentary) with this shape:

{
  "screens": [
    {
      "name": "string — the screen/view name",
      "purpose": "string — one line on what this screen is for",
      "fields": [
        { "name": "string", "type": "text|textarea|number|email|password|date|time|datetime|select|multiselect|checkbox|radio|toggle|file|search|currency|phone|url|other",
          "required": true|false, "notes": "string — options, placeholder, or constraints if shown" }
      ],
      "actions": [ { "label": "string — the button/link text", "effect": "string — what it appears to do" } ],
      "states": [ "string — e.g. empty, loading, error, success, selected — states the mockup implies" ]
    }
  ],
  "entities": [ { "name": "string", "fields": ["string"] } ],
  "required_capabilities": [ "string — lowercase capability slugs, see below" ],
  "notes": "string — anything important the structure above doesn't capture"
}

Rules:
- Every distinct screen or view in the mockup is a screen. In-page tabs/steps that
  show different content are separate screens.
- Infer a field's type from how it looks and behaves; default to "text" when unsure.
- entities and notes may be empty ([] / "") but screens must not be.
- Do not invent screens, fields, or actions the mockup does not show.
- required_capabilities are the INFRASTRUCTURE needs the mockup implies, as
  lowercase slugs. Include "users" whenever the app has user accounts, sign-in,
  profiles, or per-person data (i.e. it is not a static/public-only site);
  "roles" when it distinguishes roles/permissions (admin areas, role labels);
  "ldap" when it mentions an enterprise directory / LDAP / SSO-style corporate
  sign-in; "notifications" for email/alert flows; "files" for upload/storage.
  Only list what the mockup or brief actually implies — an empty list is valid.
Return the JSON object only.`;
}

export function buildInventoryExtractionTask({ html = '', projectName = 'the app' } = {}) {
  return `Project: ${projectName}\n\nApproved mockup HTML:\n\n${html}\n\nExtract the design inventory as the JSON object described.`;
}

// parseInventory — parse + validate the extractor's output into a canonical
// inventory object. Tolerant of ```json fences and leading prose. Returns
// { ok, inventory, error }. A valid inventory has a non-empty screens array;
// each screen is normalized to { name, purpose, fields[], actions[], states[] }.
export function parseInventory(text) {
  let s = String(text || '').trim();
  if (!s) return { ok: false, error: 'empty extraction response' };
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  else {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start > 0 && end > start) s = s.slice(start, end + 1);
  }
  let doc;
  try { doc = JSON.parse(s); } catch (e) { return { ok: false, error: `inventory is not valid JSON: ${e.message}` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'inventory must be a JSON object' };
  const screensIn = Array.isArray(doc.screens) ? doc.screens : [];
  const screens = screensIn
    .filter((sc) => sc && typeof sc === 'object')
    .map((sc) => ({
      name: String(sc.name || 'Untitled screen'),
      purpose: String(sc.purpose || ''),
      fields: (Array.isArray(sc.fields) ? sc.fields : []).filter((f) => f && typeof f === 'object').map((f) => ({
        name: String(f.name || ''),
        type: String(f.type || 'text'),
        required: !!f.required,
        notes: String(f.notes || ''),
      })),
      actions: (Array.isArray(sc.actions) ? sc.actions : []).filter((a) => a && typeof a === 'object').map((a) => ({
        label: String(a.label || ''),
        effect: String(a.effect || ''),
      })),
      states: (Array.isArray(sc.states) ? sc.states : []).map((x) => String(x)).filter(Boolean),
    }));
  if (screens.length === 0) return { ok: false, error: 'inventory has no screens' };
  const entities = (Array.isArray(doc.entities) ? doc.entities : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ name: String(e.name || ''), fields: (Array.isArray(e.fields) ? e.fields : []).map((x) => String(x)) }));
  // Capability hints for define-time component selection (migration 524):
  // lowercase slugs, deduped, tolerant of junk. Never fatal — an absent or
  // malformed list is simply empty (older projects have none).
  const requiredCapabilities = [...new Set(
    (Array.isArray(doc.required_capabilities) ? doc.required_capabilities : [])
      .map((c) => String(c || '').trim().toLowerCase())
      .filter((c) => /^[a-z0-9][a-z0-9.-]*$/.test(c))
      .slice(0, 32),
  )];
  const inventory = {
    version: 1,
    screens,
    entities,
    required_capabilities: requiredCapabilities,
    notes: String(doc.notes || ''),
  };
  return { ok: true, inventory };
}

// The number of screens/fields/actions an inventory captures — the one-line
// summary the approval change record + chat confirmation report.
export function inventoryCounts(inventory) {
  const screens = Array.isArray(inventory?.screens) ? inventory.screens : [];
  let fields = 0;
  let actions = 0;
  for (const sc of screens) {
    fields += Array.isArray(sc.fields) ? sc.fields.length : 0;
    actions += Array.isArray(sc.actions) ? sc.actions.length : 0;
  }
  return { screens: screens.length, fields, actions };
}

// ---- design tokens (carry the approved mockup's look into the build) ----
//
// The inventory captures WHAT the app does (screens/fields/actions); these tokens
// capture how it LOOKS. On approval we extract the mockup's design tokens and
// render a concrete stylesheet so the build runner reproduces the approved look
// instead of re-styling from generic defaults. Both are written to state/ and
// committed, alongside inventory.json.
export const DESIGN_TOKENS_PATH = 'state/design-tokens.json';
export const DESIGN_CSS_PATH = 'state/design.css';

export function buildDesignTokenExtractionPrompt() {
  return `You extract the DESIGN TOKENS from an approved product mockup so the built app
can reproduce its exact look — colors, typography, spacing, corner radius,
shadows. Read the mockup's CSS and rendered styling, not just its structure.

Output ONLY a JSON object (no markdown, no code fences, no commentary) with this shape:

{
  "colors": {
    "background": "#RRGGBB", "surface": "#RRGGBB", "text": "#RRGGBB",
    "muted": "#RRGGBB", "border": "#RRGGBB", "primary": "#RRGGBB",
    "primaryText": "#RRGGBB", "accent": "#RRGGBB", "danger": "#RRGGBB", "success": "#RRGGBB"
  },
  "typography": { "fontFamily": "a CSS font stack", "headingFamily": "a CSS font stack", "baseSize": "16px" },
  "radius": { "sm": "6px", "md": "10px", "lg": "16px" },
  "spacing": { "unit": "8px" },
  "shadow": { "card": "a CSS box-shadow value" }
}

Rules:
- Every color is a #RRGGBB hex. Read the ACTUAL values from the mockup's CSS; if a
  value isn't present, pick the closest sensible token consistent with the rest.
- Sizes are a number + a CSS unit (px/rem). Font families are valid CSS font stacks.
- Return the JSON object only.`;
}

export function buildDesignTokenExtractionTask({ html = '', projectName = 'the app' } = {}) {
  return `Project: ${projectName}\n\nApproved mockup HTML (with its styling):\n\n${html}\n\nExtract the design tokens as the JSON object described.`;
}

// Sanitisers so a model-authored token can never inject arbitrary CSS into the
// generated stylesheet. Anything that fails validation falls back to a default.
const HEX = /^#[0-9a-fA-F]{6}$/;
function safeHex(v, fallback) { const s = String(v || '').trim(); return HEX.test(s) ? s.toLowerCase() : fallback; }
function safeSize(v, fallback) { const s = String(v || '').trim(); return /^-?\d{1,4}(\.\d{1,3})?(px|rem|em|%)$/.test(s) ? s : fallback; }
function safeFont(v, fallback) { const s = String(v || '').trim(); return /^[a-zA-Z0-9 ,"'\-]{1,120}$/.test(s) ? s : fallback; }
function safeShadow(v, fallback) { const s = String(v || '').trim(); return /^[a-zA-Z0-9 ,.()#%\-]{1,120}$/.test(s) ? s : fallback; }

const DEFAULT_TOKENS = Object.freeze({
  colors: {
    background: '#ffffff', surface: '#f8fafc', text: '#0f172a', muted: '#64748b',
    border: '#e2e8f0', primary: '#4f46e5', primaryText: '#ffffff', accent: '#6366f1',
    danger: '#dc2626', success: '#16a34a',
  },
  typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '16px' },
  radius: { sm: '6px', md: '10px', lg: '16px' },
  spacing: { unit: '8px' },
  shadow: { card: '0 1px 3px rgba(0,0,0,0.1)' },
});

// parseDesignTokens — parse + sanitise the extractor's output. Tolerant of fences
// / prose; always returns a complete, safe token set (defaults fill any gap), so
// renderDesignTokensCss can never fail. { ok, tokens, error }.
export function parseDesignTokens(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  else { const a = s.indexOf('{'); const b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1); }
  let doc = null;
  try { doc = JSON.parse(s); } catch { doc = null; }
  const d = DEFAULT_TOKENS;
  const c = (doc && typeof doc === 'object' && doc.colors) || {};
  const t = (doc && typeof doc === 'object' && doc.typography) || {};
  const r = (doc && typeof doc === 'object' && doc.radius) || {};
  const sp = (doc && typeof doc === 'object' && doc.spacing) || {};
  const sh = (doc && typeof doc === 'object' && doc.shadow) || {};
  const tokens = {
    colors: {
      background: safeHex(c.background, d.colors.background),
      surface: safeHex(c.surface, d.colors.surface),
      text: safeHex(c.text, d.colors.text),
      muted: safeHex(c.muted, d.colors.muted),
      border: safeHex(c.border, d.colors.border),
      primary: safeHex(c.primary, d.colors.primary),
      primaryText: safeHex(c.primaryText, d.colors.primaryText),
      accent: safeHex(c.accent, d.colors.accent),
      danger: safeHex(c.danger, d.colors.danger),
      success: safeHex(c.success, d.colors.success),
    },
    typography: {
      fontFamily: safeFont(t.fontFamily, d.typography.fontFamily),
      headingFamily: safeFont(t.headingFamily, d.typography.headingFamily),
      baseSize: safeSize(t.baseSize, d.typography.baseSize),
    },
    radius: { sm: safeSize(r.sm, d.radius.sm), md: safeSize(r.md, d.radius.md), lg: safeSize(r.lg, d.radius.lg) },
    spacing: { unit: safeSize(sp.unit, d.spacing.unit) },
    shadow: { card: safeShadow(sh.card, d.shadow.card) },
  };
  return { ok: !!doc, tokens, error: doc ? null : 'design tokens were not valid JSON — using defaults' };
}

// renderDesignTokensCss — a concrete stylesheet (CSS variables + base element +
// component styles) built from the tokens. The runner imports/serves this so the
// app matches the approved mockup. Pure + safe (values pre-sanitised).
export function renderDesignTokensCss(tokens = DEFAULT_TOKENS) {
  const c = tokens.colors; const t = tokens.typography; const r = tokens.radius; const sh = tokens.shadow;
  return `/* Generated from the approved mockup on design approval. The built app MUST
   reproduce this look — these are the design tokens the mockup used. */
:root {
  --app-bg: ${c.background};
  --app-surface: ${c.surface};
  --app-text: ${c.text};
  --app-muted: ${c.muted};
  --app-border: ${c.border};
  --app-primary: ${c.primary};
  --app-primary-text: ${c.primaryText};
  --app-accent: ${c.accent};
  --app-danger: ${c.danger};
  --app-success: ${c.success};
  --app-font: ${t.fontFamily};
  --app-heading-font: ${t.headingFamily};
  --app-base-size: ${t.baseSize};
  --app-radius-sm: ${r.sm};
  --app-radius-md: ${r.md};
  --app-radius-lg: ${r.lg};
  --app-shadow-card: ${sh.card};
}
body { background: var(--app-bg); color: var(--app-text); font-family: var(--app-font); font-size: var(--app-base-size); }
h1, h2, h3, h4 { font-family: var(--app-heading-font); color: var(--app-text); }
a { color: var(--app-primary); }
button, .btn, [type="submit"] { background: var(--app-primary); color: var(--app-primary-text); border: 0; border-radius: var(--app-radius-md); padding: 0.6em 1em; cursor: pointer; }
button.secondary, .btn-secondary { background: var(--app-surface); color: var(--app-text); border: 1px solid var(--app-border); }
.card, .panel { background: var(--app-surface); border: 1px solid var(--app-border); border-radius: var(--app-radius-lg); box-shadow: var(--app-shadow-card); }
input, select, textarea { background: var(--app-bg); color: var(--app-text); border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); padding: 0.5em 0.7em; }
.muted { color: var(--app-muted); }
`;
}

// ---- chat → model transcript ----

// classifyConceptTurn — what a concept_chat turn asked for. Given the assistant
// turn's tool calls, decide whether it requested a mockup and pull the brief.
// The model may pair generate_mockup with its reply text (handled by the caller).
export function classifyConceptTurn(toolCalls = []) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const gen = calls.find((c) => c && c.name === 'generate_mockup');
  if (gen) return { generateMockup: true, brief: String(gen.input?.brief || '').trim() };
  return { generateMockup: false, brief: null };
}

// buildConceptTranscript — the neutral transcript (model-client.js turn shapes)
// from the project's chat history + the new user message. Only the human/model
// conversation is replayed (kinds 'user' → user, 'assistant' → assistant);
// system notes (mockup-updated, approval) are context for the human, not the
// model, and are skipped so they don't pollute the model's turn structure.
// Multi-modal: user turns may carry `images` — the caller (concept.js) hydrates
// bytes for the attachments chat-image-logic.planTranscriptImages selected and
// sets `m.images` / passes `newUserImages`; attachments outside the hydration
// window render as their stable text placeholder so the turn structure (and the
// prompt-cache prefix) stays deterministic.
export function buildConceptTranscript(messages = [], newUserText = null, { newUserImages = [] } = {}) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.kind === 'user') {
      const turn = { role: 'user', text: String(m.body || '') };
      if (Array.isArray(m.images) && m.images.length) turn.images = m.images;
      if (m.imagePlaceholders) turn.text = `${turn.text}${turn.text ? '\n' : ''}${m.imagePlaceholders}`;
      out.push(turn);
    } else if (m.kind === 'assistant') out.push({ role: 'assistant', text: String(m.body || '') });
  }
  if (newUserText != null) {
    const turn = { role: 'user', text: String(newUserText) };
    if (Array.isArray(newUserImages) && newUserImages.length) turn.images = newUserImages;
    out.push(turn);
  }
  return out;
}

// A short plain-text recap of the conversation for the mockup model (which does
// not see the chat transcript). Last N user/assistant turns, newest-relevant.
export function conversationRecap(messages = [], { max = 12 } = {}) {
  const turns = (messages || [])
    .filter((m) => m && (m.kind === 'user' || m.kind === 'assistant'))
    .slice(-max)
    .map((m) => `${m.kind === 'user' ? 'Builder' : 'Design partner'}: ${String(m.body || '').trim()}`);
  return turns.join('\n');
}

// ---- API response shape ----

// publicChatMessageShape — client-safe view of a chat message row.
export function publicChatMessageShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    body: row.body || '',
    author_user_id: row.author_user_id ?? null,
    acting_as_admin: Number(row.acting_as_admin) === 1,
    question_id: row.question_id ?? null,
    cycle_id: row.cycle_id ?? null,
    // Image attachments (migration 526): [{id, media_type, name}] — the client
    // renders thumbnails from GET /projects/:id/chat-images/:imageId.
    attachments: parseAttachmentsJson(row.attachments_json).map(publicAttachmentShape).filter(Boolean),
    // What this response cost (migration 527) — set on assistant messages
    // (ask answers, design-turn replies); null elsewhere/on older rows.
    cost_cents: row.cost_cents ?? null,
    tokens: row.tokens ?? null,
    created_at: row.created_at || null,
  };
}

// ---- persistent stage indicator (Concept → Define → Build → Run) ----

export const STAGES = Object.freeze(['concept', 'define', 'build', 'run']);

// conceptStageInfo — the persistent stage indicator state for a project. In M7
// the only transition is Concept → (design approved) → Build unlocked. Define
// (M8) and Run are shown but not yet reachable, so once the design is approved
// the current stage advances to 'build' (the next thing the Builder can do). The
// tile and the detail page both read this — one implementation.
export function conceptStageInfo(project) {
  const approved = !!project?.design_approved_at;
  const current = approved ? 'build' : 'concept';
  return {
    stages: STAGES,
    current,
    design_approved: approved,
    design_approved_at: project?.design_approved_at || null,
    build_unlocked: approved,
  };
}

// The preview URL for a project's current mockup (project.url + the preview
// path), or null when there is no served mockup / no live URL.
export function mockupPreviewUrl(projectUrl, hasMockup) {
  if (!projectUrl || !hasMockup) return null;
  return `${String(projectUrl).replace(/\/+$/, '')}${MOCKUP_PREVIEW_PATH}`;
}

// ---- cost envelope (R5 — concept cycles spend too) ----

// A concept turn spends on TWO model calls: the concept_chat reply and (usually)
// the mockup render. Deliberately generous envelopes — like the runner's, the
// envelope only has to be a credible reservation; there is no long loop to run
// away. Returns per-call {inputTokens, outputTokens} so the caller prices each
// against its own slot's connector.
export function estimateConceptTurnTokens() {
  return {
    chat: { inputTokens: 6000, outputTokens: 1500 },
    mockup: { inputTokens: 12000, outputTokens: 9000 },
  };
}

// The inventory-extraction call's envelope (design approval).
export function estimateInventoryTokens() {
  return { inputTokens: 14000, outputTokens: 4000 };
}
