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
  return /<!doctype html|<html[\s>]|<body[\s>]/i.test(s) && /<\/\w+>/.test(s);
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
  "notes": "string — anything important the structure above doesn't capture"
}

Rules:
- Every distinct screen or view in the mockup is a screen. In-page tabs/steps that
  show different content are separate screens.
- Infer a field's type from how it looks and behaves; default to "text" when unsure.
- entities and notes may be empty ([] / "") but screens must not be.
- Do not invent screens, fields, or actions the mockup does not show.
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
  const inventory = {
    version: 1,
    screens,
    entities,
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
export function buildConceptTranscript(messages = [], newUserText = null) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.kind === 'user') out.push({ role: 'user', text: String(m.body || '') });
    else if (m.kind === 'assistant') out.push({ role: 'assistant', text: String(m.body || '') });
  }
  if (newUserText != null) out.push({ role: 'user', text: String(newUserText) });
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
