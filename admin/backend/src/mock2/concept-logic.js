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
import { MOCKUP_BASE_CSS, MOCKUP_THEME_TOGGLE_JS } from './mockup-template.js';

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
        scope: {
          type: 'string',
          enum: ['tweak', 'screen', 'full'],
          description: 'Size of the change. "tweak": a SMALL revision (copy/labels, a color, one element) — applied as surgical edits at a fraction of the cost. "screen": redesign or substantially change ONE screen — only that screen\'s section re-renders (name it in "screen"). "full": changes across screens, structural/navigation changes, or the first mockup. Default "full"; when unsure, use "full".',
        },
        screen: {
          type: 'string',
          description: 'With scope "screen": the exact data-screen name of the one screen being changed (must match a <section data-screen="…"> in the current mockup).',
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
  or what you need, and remind them they can approve the design when it feels right.
- COST-AWARE REVISIONS — pick the smallest scope that truly fits:
  scope "tweak" for a SMALL change (copy/labels, a color, one element):
  surgical edits at a fraction of a re-render's cost. scope "screen" when ONE
  screen changes substantially (redesign this screen, add a section to it):
  pass the screen's data-screen name in "screen" — only that section
  re-renders. scope "full" for changes across screens, navigation/structure
  changes, or the first mockup. When unsure, "full".

THE BRIEF YOU WRITE IS THE DESIGN'S CEILING — extrapolate it like a multi-step
domain expert on the Builder's behalf:
- A THOROUGH request (operating conditions, audiences, states, constraints
  already spelled out) passes through faithfully — preserve its language, add
  little.
- A SIMPLE request ("a clinic check-in app") gets EXPANDED into a full design
  brief before you render. Work through it as the domain expert the Builder
  may not be:
  1. Surfaces & audiences — who uses each surface, from what distance, under
     what pressure (a waiting-room kiosk vs. a front-desk queue are different
     designs); each surface's ONE core job.
  2. Real operating conditions — stress, privacy (what must be masked or
     cleared), interruptions, time pressure, accessibility; what the end user
     must NEVER see (internal steps, status enums, data-model language).
  3. Hard states the mockup must PROVE — empty, overloaded (12+ rows still
     scan), over-threshold/escalated, mid-action, a validation slip handled
     gracefully.
  4. Domain rules an expert assumes — e.g. PHI masking, destructive actions
     separated from primaries, an explicit escalation path.
  5. Anti-patterns to name in the brief so the renderer avoids them.
  Write the brief as DIRECTIVES ("the eye must land first on whoever waited
  longest"), never as questions or options.
- Ask the Builder at most 1–2 DIRECTION questions FIRST only when a genuine
  fork changes the whole design (kiosk or phone? consumer or internal tool?
  brand tone?). Otherwise choose expert defaults, render, and NOTE the
  defaults you chose in your reply so the Builder can veto them.`;
  return `You are the Mock2 Concept-stage design partner. You help a Builder — who may be
non-technical — turn an app idea into a clear, interactive mockup. This is Stage 1
of four (Concept → Define → Build → Run); you are ONLY doing Concept.

${modeBlock}

What you CANNOT do (this is structural, not a preference):
- You cannot write code, files, backend logic, or rules. You cannot build or run
  the real app. The mockup is non-functional — it demonstrates the idea, it does
  not run it. If asked to "build it" or "make it work", explain that the mockup
  comes first and Build is a later stage that unlocks after they approve the design.

THE BUILDER OWNS THE LOOK: when the Builder explicitly specifies colors,
tokens, a theme (light/dark), typography, or a palette, their spec OVERRIDES
the locked design system below — carry it into the brief VERBATIM (token
tables included) at the TOP of the brief, and never water it down to fit the
system. The locked system is the DEFAULT look for turns that don't specify
one — it exists to prevent drift, not to veto the Builder:

# Default design system (the Builder's explicit spec above outranks it)
${designSystem || '(design system content is still owed — risk R8)'}

Keep replies short and concrete. Guide toward a design the Builder is happy to approve.`;
}

// ---- mockup TWEAK mode (surgical edits instead of a full re-render) ----
// A one-line copy change used to re-output the ENTIRE document — output tokens
// dominate render cost, so "change the heading" cost as much as the original
// render (user report). Tweak mode asks for exact search/replace blocks against
// the current HTML; the orchestrator applies them and falls back to the full
// renderer whenever they don't apply cleanly.

export const MOCKUP_EDIT_MAX_BLOCKS = 12;

export function buildMockupEditSystemPrompt() {
  return `You make a SMALL, TARGETED revision to an existing HTML mockup.
Output ONLY edit blocks in exactly this format — no prose, no code fences:

<<<<SEARCH
exact text copied from the current file
====
replacement text
>>>>

Rules:
- Each SEARCH must be copied EXACTLY from the current file (whitespace
  included) and long enough to be UNIQUE in it — include surrounding lines
  when needed.
- Use the fewest, smallest edits that fulfil the request (at most ${MOCKUP_EDIT_MAX_BLOCKS} blocks).
- The edited file must remain a complete, valid document: matching tags,
  balanced braces, working script.
- If the request actually needs new screens, layout restructuring, or more
  change than a few edits can express, output exactly FULL_RERENDER (nothing
  else) — the full renderer will run instead.`;
}

export function parseMockupEdits(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, error: 'empty reply' };
  if (/^FULL_RERENDER\b/.test(s)) return { ok: true, fullRerender: true, edits: [] };
  const edits = [];
  const re = /<<<<SEARCH\n([\s\S]*?)\n====\n([\s\S]*?)\n>>>>/g;
  let m;
  while ((m = re.exec(s)) !== null) edits.push({ search: m[1], replace: m[2] });
  if (!edits.length) return { ok: false, error: 'no edit blocks found' };
  if (edits.length > MOCKUP_EDIT_MAX_BLOCKS) return { ok: false, error: `too many edit blocks (max ${MOCKUP_EDIT_MAX_BLOCKS})` };
  return { ok: true, fullRerender: false, edits };
}

// Apply sequentially; every search must match EXACTLY ONCE (absent or
// ambiguous → the whole tweak fails and the caller falls back to a full
// render — a half-applied mockup must never ship).
export function applyMockupEdits(html, edits = []) {
  let out = String(html || '');
  for (let i = 0; i < edits.length; i++) {
    const { search, replace } = edits[i];
    if (!search) return { ok: false, error: `edit ${i + 1}: empty search` };
    const first = out.indexOf(search);
    if (first === -1) return { ok: false, error: `edit ${i + 1}: search text not found` };
    if (out.indexOf(search, first + 1) !== -1) return { ok: false, error: `edit ${i + 1}: search text matches more than once` };
    out = out.slice(0, first) + String(replace ?? '') + out.slice(first + search.length);
  }
  return { ok: true, html: out };
}

// ---- per-SCREEN sections (targeted screen re-render + the section contract) ----
// Mockups wrap each screen in <section data-screen="Name"> (prompt contract
// above), so a screen-scoped revision re-renders ONE section instead of the
// whole document — faster and far cheaper, while "global" changes still run
// the full renderer.

export function listScreenSections(html) {
  return [...String(html || '').matchAll(/<section\b[^>]*data-screen="([^"]+)"/gi)].map((m) => m[1]);
}

export function findScreenSection(html, name) {
  const s = String(html || '');
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<section\\b[^>]*data-screen="${esc}"[^>]*>`, 'i');
  const m = re.exec(s);
  if (!m) return { ok: false, error: `no section with data-screen="${name}"` };
  const close = s.indexOf('</section>', m.index);
  if (close === -1) return { ok: false, error: 'unterminated section' };
  return { ok: true, start: m.index, end: close + '</section>'.length, section: s.slice(m.index, close + '</section>'.length) };
}

export function replaceScreenSection(html, name, replacement) {
  const f = findScreenSection(html, name);
  if (!f.ok) return f;
  return { ok: true, html: String(html).slice(0, f.start) + String(replacement) + String(html).slice(f.end) };
}

// Pull the replacement <section> out of a screen-render reply (fences and
// prose stripped); null when the reply holds no such section.
export function extractSectionHtml(text, name) {
  let s = String(text || '').trim();
  const fence = /```(?:html)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const f = findScreenSection(s, name);
  return f.ok ? f.section : null;
}

export function buildScreenRenderSystemPrompt({ designSystem = '' } = {}) {
  return `You redesign ONE screen of an existing HTML mockup. You receive the full
current document for context and a revision brief for a single screen.

Output ONLY the replacement <section> element for that screen — starting with
its opening <section …> tag and ending with </section>. No prose, no code
fences, nothing outside the section.

Rules:
- Keep the opening <section> tag's attributes EXACTLY as they are in the
  current document (data-screen name, ids, classes — the page's navigation
  depends on them). Redesign only the CONTENTS.
- PRECEDENCE: if the revision brief EXPLICITLY respecifies visual language
  (color tokens, a palette, light/dark theme, typography), the brief WINS over
  the document's existing styling and the design system below — style this
  section to the brief's spec, never keep the incumbent look out of
  "consistency".
- Otherwise reuse the document's existing CSS classes and design tokens; a
  small scoped <style> INSIDE the section is allowed for styles this screen
  alone needs. Do not restyle other screens.
- The design-craft bar applies: real iconography (inline SVG, never emoji),
  hierarchy over boxes, one dominant primary action, hard states shown,
  realistic sample data.
- Default design system (applies where the brief and the document are silent):
${designSystem || '(design system content is still owed — risk R8)'}`;
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
- Style through DESIGN TOKENS, resolved by precedence (the # PRECEDENCE section
  below): the brief's explicit spec first, then the project's chosen base theme,
  then the default design system at the bottom — the defaults are a fallback,
  never a veto. Whatever the source, define the values ONCE as CSS custom
  properties and route every component style through var(--…); no ad-hoc
  colors, stray fonts, or gradients-as-decoration scattered in component rules.
- Mobile-first: every screen renders cleanly in a single column at 360–375px; any
  multi-column layout collapses to one column on small viewports. Tappable controls
  are at least 44×44px.
- Interactivity is fine (tabs, toggles, showing/hiding, fake navigation between
  in-page screens) but it must be self-contained and non-persistent.
- REALISTIC SAMPLE CONTENT: populate every screen with plausible, domain-true
  sample data — real-looking names, dates, amounts, statuses, and ENOUGH rows
  to show density (a timesheet shows a full period of days with several
  clock-in/out pairs, not two placeholder rows). Sample data lives ONLY here
  in the mockup — the built app starts empty — so this is where the design's
  data density is judged. Also show at least one designed EMPTY state (an
  icon, one line, and the next action) so the built app's day-one look is part
  of the approved design.
- SCREEN SECTIONS (structural contract): wrap every distinct screen/view in
  <section data-screen="Screen Name"> … </section> at the top level of <body>,
  with unique human-readable names and NO nested <section> elements. The
  in-page navigation shows/hides these sections; the first is visible by
  default. Targeted revisions later re-render ONE section, so keep each
  screen's markup self-contained inside its section (shared styles stay in
  the document <style>).
- RENDER-ON-LOAD: the first/default screen must be VISIBLE immediately from the
  HTML + CSS alone, before any JavaScript runs. Do NOT hide the initial content
  with an inline style/attribute that a <script> later reveals — if the script
  errors the page must still show the first screen, never a blank/black page.
  JS only ENHANCES (switching screens, toggles); it never gates first paint.
- Output the COMPLETE document ending with </body></html>. Never stop partway —
  a truncated document renders as a blank page.

# Design craft (binding — the mockup is judged on design judgment, not mechanics)
The mockup is the visual contract every build inherits. You will be judged
purely on design judgment and craft, so treat EVERY default as a decision you
must earn. Within the locked design system:

DESIGN FOR THE REAL OPERATING CONDITIONS, not the happy path. Before laying
anything out, decide: who uses each surface, from what distance, under what
pressure, with what stakes? A public/kiosk surface is read from feet away by
stressed or low-vision people — large type, one decision per screen, forgiving
targets, calm tone. An operator surface is scanned under time pressure — the
eye must land FIRST on whatever needs action; urgency is the loudest thing on
screen. Density, spacing, and radius are decisions that DIFFER between a calm
public surface and a dense operator surface — never one treatment everywhere.
NEVER expose internal steps, state names, or data-model language to end
users ("Info / Reason / Confirm" wizards, status enums); progress shown to the
public is reassurance, not a form tracker.

- Open the file with a one-paragraph DESIGN RATIONALE as an HTML comment:
  the point of view you committed to and why. A restrained invented brand
  beats a generic template.
- A real TYPOGRAPHIC SCALE: a defined ramp with deliberate weight/size
  contrast — hierarchy is built from type, not from boxes. Not everything at
  one size.
- EVERY COLOR HAS A JOB: define what each hue signifies and the single
  escalation path for the domain's "too long / overdue / attention" state.
  No color without a meaning; one accent per meaning, reused consistently.
- HIERARCHY over boxes: use spacing, surface elevation (2–3 surface tones),
  and type scale to separate things; reserve borders for genuine boundaries.
- ONE primary action per view, visually dominant; secondary actions quiet;
  the destructive action visually distinct and never adjacent to the primary.
  In repeated rows/cards, collapse secondary actions behind a compact menu so
  a real queue still scans.
- NEVER use emoji as UI iconography — the loudest "AI mockup" tell. Draw
  small inline SVG icons (16–24px, stroke, currentColor).
- Step indicators: a slim inline stepper, never large pills that wrap.
- Spacing rhythm (4/8px multiples) held everywhere; tabular figures for
  numbers.
- PROVE IT WITH THE HARD STATES, not just the default view: the empty state,
  the overloaded state (a queue/list at 12+ rows must still scan), the
  escalated/over-threshold state, a mid-action state, a gracefully handled
  validation slip. Seed data rich and varied enough to exercise all of them.
- Keyboard focus states and adequate contrast throughout; motion restrained
  and functional (~150ms).

ANTI-PATTERNS (their presence is a failure): emoji as icons · a wall of
same-weight pills/badges · uniform boxed cards + a single accent color + one
radius everywhere (the generic-dashboard look) · internal/model language shown
to end users · a layout that only works because there are exactly four rows of
data.

# Base token stylesheet (structural contract — include VERBATIM)
Ignore any pre-existing theme, brand colors, or prior mockup styling; the
design-system tokens replace them entirely. Light is the reference theme;
render light first. Start your <style> with the stylesheet below EXACTLY as
given, then append the mockup's own rules after it. :root carries the light
values; [data-theme="dark"] carries the dark values; ship a header
.theme-toggle button wired to toggleTheme() so the dark theme flips every
surface. When the brief or the project's base theme overrides the look,
RE-VALUE the custom properties inside the ==tokens== blocks (same property
names, new values, BOTH themes, kept AA ≥ 4.5:1 — adjust lightness within-hue
if needed, especially --text-3 and stage-badge text on dark surfaces). Never
bypass var(--…) and never hard-code a hex color outside the ==tokens== blocks.

${MOCKUP_BASE_CSS}

Theme toggle script (include it and wire the toolbar button to it):
${MOCKUP_THEME_TOGGLE_JS}

# Defect-class hardening (binding — each rule closes an observed failure)
- LIST ROWS: every list/table row uses the canonical .list-row 5-column grid —
  Stage badge | Identity | Headline metric | Position | Lead · Updated. The
  Identity cell stacks a .title over a one-line .value-statement (never
  concatenate title + description inline); truncation comes from the base CSS
  (nowrap + ellipsis + min-width:0). Columns must never overlap at any
  viewport ≥ 1280px.
- ONE METRIC PER ROW/CARD: exactly one .metric per list row — the
  stage-appropriate headline (Ideation → projected impact est.; MVP → sites
  piloting; Testing → validation coverage; Iterating → adoption %; Rollout →
  units live "n of m"; Maintenance → sustained coverage). Format
  value → unit → descriptor as .num / .unit / .desc. More metrics belong on
  the detail page. No per-card progress bars in lists.
- BARS CARRY DATA: every .bar binds its fill to a sample-data value via an
  inline style="--fill:NN%" and sibling bars have visibly different lengths.
  A bar with no value behind it must not be rendered — never a wall of empty
  uniform tracks.
- DETAIL SCREENS: mark them <section data-screen="…" data-kind="detail"> and
  include ALL THREE bands, each wrapped in its marker: ① data-band="canvas" —
  the opportunity canvas plus audience impact .bar rows with varied fills;
  ② data-band="metrics" — metric .stat-tile row; ③ data-band="ladder" — the
  rollout ladder (Site → POD → Region → All org with per-level counts, the
  current frontier level accent-emphasized, and exactly ONE .btn-primary
  "Promote to next level" — the page's only filled button) plus a readiness
  checklist rendered as quiet .check-quiet rows.
- STAGE BADGES: always .stage-badge plus its stage class (.stage-ideation,
  .stage-mvp, .stage-testing, .stage-iterating, .stage-rollout,
  .stage-maintenance) — the palette is complete; no stage may fall back to a
  neutral/default color.
- SAMPLE-DATA INTEGRITY: each entity appears in exactly ONE lifecycle stage
  with one consistent description across all screens; attention chips (e.g.
  "Roller unassigned") only where semantically valid for that stage;
  in-progress stages show PARTIAL completion (100% belongs only to a
  completed/maintenance stage).
- ICONS: every inline <svg> is either aria-hidden="true" next to a text
  label or carries a <title>. Never an unlabeled icon-only control; never an
  always-visible filter pill bank (filters collapse behind one quiet menu).

# PRECEDENCE — the brief outranks the locked system (read before the system below)
When the brief EXPLICITLY specifies visual language — color tokens, a palette,
light/dark theme, typography, spacing, per-state hues — those instructions are
BINDING and OVERRIDE the locked design system below and any prior mockup's
styling for everything they cover. The locked system governs only where the
brief is silent. Concretely: a brief that provides token tables gets THOSE
tokens, not the system's brand colors; a requested light theme must never
render dark; a stage/status palette in the brief replaces a single-hue badge
scheme; "no neon" means the brand accent goes too. Never resolve a conflict by
keeping the incumbent look — the Builder's explicit spec wins, everywhere,
including on revision turns.

# Locked design system (defaults — applies where the brief is silent)
${designSystem || '(design system content is still owed — risk R8)'}

Return the full HTML document and nothing else.`;
}

// mockupRenderModel — the model the mockup RENDER runs on. Every build in the
// project inherits the mockup's quality (it is the visual contract), so the
// render defaults to the strongest available model rather than the (typically
// cheaper) slot model; one HTML file at top quality is the best token-for-token
// spend in the pipeline. MOCK2_MOCKUP_MODEL overrides; the literal value
// 'slot' restores the slot model. The caller falls back to the slot model when
// the preferred one is rejected by the connector (older keys/orgs).
export const MOCKUP_PREFERRED_MODEL = 'claude-fable-5';

// mockupRenderBudget — output-token budget for a FULL render, sized from the
// document being revised. The old flat 40k truncated large multi-screen
// documents by construction (operator lost two paid renders to "exceeded its
// output budget twice"): a revision must be able to re-emit the whole
// current document plus growth. ~3.2 chars/token for dense HTML, 1.35×
// headroom, +6k slack (restyles rewrite all CSS); floor 40k, ceiling 64k —
// past the ceiling the truncation-continuation path finishes the document.
export function mockupRenderBudget(currentHtmlLen = 0) {
  const estimated = Math.ceil((Number(currentHtmlLen) || 0) / 3.2 * 1.35) + 6000;
  return Math.min(64000, Math.max(40000, estimated));
}

// stitchContinuation — join a truncated document with its continuation
// reply. Prefill would make this trivial, but the render model rejects
// assistant prefill ("This model does not support assistant message
// prefill" — operator-hit HTTP 400), so continuation is asked for with an
// instruction and the reply must be STITCHED defensively:
//   - code fences around the continuation are stripped;
//   - if the model restarted the whole document (contains <!doctype), the
//     continuation REPLACES the partial;
//   - otherwise the longest overlap between the document's tail and the
//     continuation's head is removed (models often repeat a little context
//     despite instructions), then the remainder is appended.
export function stitchContinuation(doc, continuation) {
  const d = String(doc || '');
  let cont = String(continuation || '');
  // Strip a leading fence LINE (up to and including its newline — no
  // further: the continuation's own leading whitespace is meaningful) and a
  // trailing fence.
  cont = cont.replace(/^\s*```[a-z]*\r?\n/i, '').replace(/\n?```\s*$/, '');
  if (/<!doctype html|<html[\s>]/i.test(cont)) return { html: cont, restarted: true };
  const window = Math.min(4000, d.length, cont.length);
  let k = 0;
  for (let n = window; n >= 12; n--) {
    if (d.endsWith(cont.slice(0, n))) { k = n; break; }
  }
  return { html: d + cont.slice(k), restarted: false };
}

// The continuation user turn. The tail anchor lets the model align its
// output to the exact cut point.
export function buildContinuationInstruction(docTail) {
  return `Your previous message was cut off by the output limit before the document finished. CONTINUE the HTML document EXACTLY from the cut point — output ONLY the remaining characters of the document (finishing through </body></html>), with NO preamble, NO code fences, and NO repetition of content already sent. For alignment, the document currently ends with:
${String(docTail || '').slice(-300)}`;
}

export function mockupRenderModel(env = {}, slotModel = '') {
  const v = String(env?.MOCK2_MOCKUP_MODEL ?? '').trim();
  if (v.toLowerCase() === 'slot') return slotModel || MOCKUP_PREFERRED_MODEL;
  return v || MOCKUP_PREFERRED_MODEL;
}

// stripInheritedStyles — blank every <style> body in a forwarded mockup. Used
// when a RESTYLE brief rides an iteration: the prior document's stylesheet IS
// the incumbent palette, and passing it as "context" is how the old theme
// survived an explicit token spec (geometry obeyed, color ignored — operator
// review). The markup still rides (structure/content context); the styling
// must be rebuilt from the brief's spec.
export function stripInheritedStyles(html) {
  return String(html || '').replace(
    /(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi,
    "$1/* inherited styling removed — the brief's token spec replaces it */$2",
  );
}

// The mockup slot's user turn: the brief + the current mockup (to iterate on) +
// a short recap of the conversation so the render reflects the whole idea.
// restyle: the brief respecifies the visual language — the forwarded HTML's
// <style> content is stripped so the incumbent palette cannot ride along.
export function buildMockupTask({ brief = '', currentHtml = null, projectName = 'the app', conversation = '', restyle = false } = {}) {
  const parts = [`Project: ${projectName}`];
  if (conversation) parts.push(`Conversation so far (for context):\n${conversation}`);
  parts.push(`Design brief for this mockup:\n${String(brief || '').trim() || '(no brief — infer from the conversation)'}`);
  if (currentHtml && restyle) {
    parts.push(`The brief RESTYLES the design, so the current mockup is below with its stylesheet REMOVED — its old palette is not a reference and must not be reconstructed. Keep the screens, content, and structure it shows; rebuild ALL styling from the brief's spec (falling back to the design system only where the brief is silent):\n\n${stripInheritedStyles(currentHtml)}`);
  } else if (currentHtml) {
    parts.push(`The CURRENT mockup HTML is below — revise it to satisfy the brief, keeping everything the brief does not touch stable. EXCEPTION: if the brief RESTYLES the design (new tokens, palette, theme, light/dark), restyle the ENTIRE document to the new spec — visual stability never applies to styling the brief replaces, and the current mockup's palette must not survive into the revision:\n\n${currentHtml}`);
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
  "journeys": [
    { "name": "string — a primary user journey, e.g. 'clock in for the day'",
      "steps": [ "string — the screens/actions the journey passes through, in order" ],
      "frequency": "daily|weekly|occasional — how often a typical user does this" }
  ],
  "required_capabilities": [ "string — lowercase capability slugs, see below" ],
  "notes": "string — anything important the structure above doesn't capture"
}

Rules:
- Every distinct screen or view in the mockup is a screen. In-page tabs/steps that
  show different content are separate screens.
- Infer a field's type from how it looks and behaves; default to "text" when unsure.
- journeys are the 3–6 PRIMARY things a user comes to do, judged from the mockup's
  navigation and emphasis; frequency decides navigation prominence downstream.
- entities, journeys, and notes may be empty ([] / "") but screens must not be.
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
  // Primary user journeys (tolerant, optional — older extractions have none):
  // frequent journeys drive the built app's navigation weight (bottom tab bar
  // vs. behind-a-menu), so capture name + steps + how often a user does it.
  const journeys = (Array.isArray(doc.journeys) ? doc.journeys : [])
    .filter((j) => j && typeof j === 'object' && String(j.name || '').trim())
    .slice(0, 8)
    .map((j) => ({
      name: String(j.name).trim().slice(0, 120),
      steps: (Array.isArray(j.steps) ? j.steps : []).map((x) => String(x)).filter(Boolean).slice(0, 8),
      frequency: ['daily', 'weekly', 'occasional'].includes(j.frequency) ? j.frequency : 'occasional',
    }));
  const inventory = {
    version: 1,
    screens,
    entities,
    journeys,
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
  typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '16px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
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
      monoFamily: safeFont(t.monoFamily, d.typography.monoFamily),
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
  --app-mono-font: ${t.monoFamily || "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"};
  --app-base-size: ${t.baseSize};
  --app-radius-sm: ${r.sm};
  --app-radius-md: ${r.md};
  --app-radius-lg: ${r.lg};
  --app-shadow-card: ${sh.card};
}
body { background: var(--app-bg); color: var(--app-text); font-family: var(--app-font); font-size: var(--app-base-size); }
h1, h2, h3, h4 { font-family: var(--app-heading-font); color: var(--app-text); }
code, pre, kbd, .mono { font-family: var(--app-mono-font); }
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
  if (gen) {
    return {
      generateMockup: true,
      brief: String(gen.input?.brief || '').trim(),
      // 'tweak' = surgical edits; 'screen' = one section re-renders; anything
      // else is a full render (safe default — a wrong 'full' costs money, a
      // wrong smaller scope falls back to full anyway).
      scope: ['tweak', 'screen'].includes(gen.input?.scope) ? gen.input.scope : 'full',
      screen: String(gen.input?.screen || '').trim() || null,
    };
  }
  return { generateMockup: false, brief: null, scope: 'full', screen: null };
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

// The DASHBOARD-origin preview URL — the API route that reads the mockup HTML
// out of the container and serves it itself. This is what the embedded iframe
// uses: unlike the container-served /_preview (mockupPreviewUrl above), it
// works while the project's app is crash-looping, gating requests behind the
// first-admin bootstrap, or setting its own frame policy. Relative, so it
// rides the SPA's origin + auth cookies.
export function dashboardMockupPreviewUrl(projectId, hasMockup) {
  if (!projectId || !hasMockup) return null;
  return `/api/mock2/projects/${Number(projectId)}/mockup-preview`;
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
