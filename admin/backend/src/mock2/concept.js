// Mock2 Concept stage — Stage 1 orchestration (Phase M7; brief's Flow section).
// The host/model half of the concept loop: it drives the concept_chat + mockup
// slots (M5) constrained to the pinned framework's LOCKED design_system_md
// (ADR-003), writes the generated HTML mockup into the fenced M4 container over
// the ADR-011 mount, checkpoints it into the bare repo, and — on the design
// approval gesture — extracts the structured inventory, discards the mockup, and
// records a hash-chained change record (sign-off #1). The DECISIONS are the pure
// concept-logic.js; this module is the orchestration.
//
// The restricted tool policy is enforced HERE, not in the prompt (04-phased-plan
// §M7): the concept_chat model can only request a mockup; the orchestrator writes
// the mockup model's HTML to a FIXED state/mockups path. No code path writes
// backend code or rules during Concept.
//
// It follows the house 202+poll job pattern (activeCycles in runner.js): the
// route returns immediately, the frontend polls the chat/concept endpoints, and
// the work runs in the background. EVERY container exec + host op pivots through
// host.js (risk R3). The decrypted model key is read ORCHESTRATOR-SIDE only and
// never enters a container.
//
// The checkout lock (ADR-004): a human chat write takes the lock (holder_user_id
// — the first human holder the module creates). It is refreshed on each mockup
// write and released on design approval; the idle sweep reclaims a stale hold.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { getProject, updateProject } from './projects.js';
import { containerNameForProject, deployBaseApp } from './provision.js';
import { projectHasBeenDeployed } from './cycles.js';
import { buildCheckpointScript } from './template.js';
import { getSlot, getConnector, decryptConnectorKey, effectivePrice } from './connectors.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { getApplicableQuota, periodUsage, insertLedgerEntry } from './quotas.js';
import { canStartCycle, costCentsForUsage } from './quota-logic.js';
import { getCurrentFrameworkVersion } from './framework.js';
import {
  insertCycle, getCycle, updateCycle, addCycleUsage, finishCycle, countRunningCycles,
} from './cycles.js';
import { acquireLock, releaseLock, touchLock } from './locks.js';
import { insertChangeRecord, changeRecordMirror } from './change-records.js';
import { getProjectRemote, pushProjectRemote } from './git-connectors.js';
import { insertMessage, listMessages, getOrCreateChat } from './chats.js';
import { saveChatImages, hydrateAttachments, hydrateChatMessagesForModel } from './chat-images.js';
import {
  CONCEPT_CHAT_TOOLS, buildConceptChatSystemPrompt, buildMockupSystemPrompt, buildMockupTask,
  buildInventoryExtractionPrompt, buildInventoryExtractionTask,
  extractMockupHtml, isPlausibleMockup, parseInventory, inventoryCounts,
  completeInventoryCrud, lintInventory,
  classifyConceptTurn, buildConceptTranscript, conversationRecap,
  estimateConceptTurnTokens, estimateInventoryTokens,
  mockupIdForCycle, mockupFileName, MOCKUP_CURRENT, INVENTORY_PATH,
  buildDesignTokenExtractionPrompt, buildDesignTokenExtractionTask, parseDesignTokens,
  renderDesignTokensCss, DESIGN_TOKENS_PATH, DESIGN_CSS_PATH, mockupRenderModel, mockupRenderBudget,
  stitchContinuation, buildContinuationInstruction,
  buildMockupEditSystemPrompt, parseMockupEdits, applyMockupEdits,
  findScreenSection, replaceScreenSection, extractSectionHtml, buildScreenRenderSystemPrompt,
} from './concept-logic.js';
import {
  projectHasDesign, buildDesignTemplate, mockupIdForImport, buildImportSeedMessage,
  designImportRecord, parseDesignImport, buildInitialBuildInstruction,
} from './design-template-logic.js';
import { callModelTurn } from './model-client.js';
import { runMockupChecks, mockupChecksNote } from './mockup-checks-logic.js';
import { startBuild } from './audit.js';
import { getLaneTuning } from './settings.js';
import { applyLaneTuning } from './lane-tuning-logic.js';
import { applyDesignPreset, applyExploreDesign, getDesignPreset, parseDesignDoc, DESIGN_DOC_FORMAT } from './design-presets.js';
import { replaceScreenPlan, queueScreens, drainScreenQueue } from './screen-plan.js';
import { INITIAL_BUILD_INSTRUCTION_PREFIX } from './screen-plan-logic.js';

const APP_DIR = '/srv/app';
const nowIso = () => new Date().toISOString();

// The instruction the auto-started initial build runs with. Approving the design
// (the "Are you ready to build?" gesture) both locks the design AND kicks off the
// first build — so the working app replaces the placeholder without the Builder
// having to describe a change. The Build-cycle panel is for adjustments AFTER
// this initial build. The audit still runs first (it may raise rule questions).
// Starts with screen-plan-logic's INITIAL_BUILD_INSTRUCTION_PREFIX — the
// request hook keys off that prefix to settle the whole screen plan as built
// when this one-pass build succeeds. Keep them composed, never divergent.
const INITIAL_BUILD_INSTRUCTION = `${INITIAL_BUILD_INSTRUCTION_PREFIX}: implement every screen, field, and action it defines on the pinned framework, so the live URL serves the real app in place of the placeholder. The approved mockup is preserved at state/mockups/current.html — READ IT FIRST and reproduce it faithfully: its layout, navigation structure (including patterns like a mobile bottom tab bar), component arrangement, and interaction patterns, screen by screen. The mockup is the visual contract — the app should look and navigate like it, not merely share its colors. Also load state/design.css and match the tokens in state/design-tokens.json (colors, fonts, spacing, radii, component styling); never fall back to a generic style. Any inventory feature you cannot finish this cycle must be visibly marked "Not built yet" in the UI (a disabled control + badge), never a dead or silently missing element.`;

// Bound the HTML we round-trip so a runaway mockup can't blow the token envelope
// (R5) or the working tree. A real mockup is well under this.
// Sized for a full multi-screen app mockup (inline CSS + JS): a ~64k-token
// render can approach ~250k chars, so the save cap must not slice a COMPLETE
// document (slicing strips the closing </html> → the plausibility check would
// then reject a page that was actually fine). Feedback for iteration is large
// enough that the model sees the whole prior mockup, not a truncated head.
const MAX_MOCKUP_CHARS = 400000;
const MAX_MOCKUP_FEEDBACK_CHARS = 160000; // how much prior HTML we feed back for iteration

// Live concept-job progress, keyed by project id (house 202+poll pattern). The
// chat/concept poll endpoints read this; entries drop a couple minutes after the
// turn settles. One job per project at a time (the lock serializes writers).
export const activeConceptJobs = new Map();

export function getConceptJobStatus(projectId) {
  return activeConceptJobs.get(Number(projectId)) || null;
}

function setJob(projectId, patch) {
  const cur = activeConceptJobs.get(Number(projectId)) || {};
  activeConceptJobs.set(Number(projectId), { ...cur, ...patch, updatedAt: Date.now() });
}
function scheduleJobCleanup(projectId) {
  setTimeout(() => activeConceptJobs.delete(Number(projectId)), 120000);
}

// ---- design-phase heartbeat: narrate the long mockup render ----
//
// The mockup is ONE long model generation (minutes). Without narration the job
// message sits frozen and the Builder assumes it broke — especially after a
// tab switch (the turn always runs server-side; nothing about it depends on
// the tab staying open). Rotate through honest, stage-flavored messages with
// the elapsed time so there is something to read while it renders; the chat
// poll (2.5s) picks each one up.
const DESIGN_HEARTBEAT_MS = 9000;
const DESIGN_HEARTBEAT_LINES = Object.freeze([
  'sketching the screen layout and structure',
  'writing the mockup HTML — every screen, inline styles, no external assets',
  'wiring the interactive bits (navigation, dialogs, sample data)',
  'styling against the locked design system tokens',
  'filling in realistic sample content',
  'polishing spacing, states, and edge screens',
]);

function startDesignHeartbeat(projectId, cycleId, { iterating = false } = {}) {
  const startedAt = Date.now();
  const verb = iterating ? 'Reworking the mockup' : 'Designing the mockup';
  let tick = 0;
  const update = () => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    const line = DESIGN_HEARTBEAT_LINES[tick % DESIGN_HEARTBEAT_LINES.length];
    tick += 1;
    setJob(projectId, {
      phase: 'designing',
      message: `${verb}… ${line} (${s}s — a full mockup typically takes 2–5 minutes; it keeps building if you switch tabs)`,
      kind: 'turn', cycleId,
    });
  };
  update();
  const timer = setInterval(update, DESIGN_HEARTBEAT_MS);
  return { stop: () => clearInterval(timer) };
}

// ---- slot readiness (both concept_chat AND mockup, ADR-001 presence-of-creds) ----

function slotReady(slotName) {
  const slot = getSlot(slotName);
  if (!slot) return { ok: false, reason: `No ${slotName} model slot is assigned. Assign one under Model connectors.` };
  const connector = getConnector(slot.connector_id);
  if (!connector) return { ok: false, reason: `The ${slotName} slot points at a missing connector.` };
  if (!connector.enabled) return { ok: false, reason: `The ${slotName} connector is disabled.` };
  const capErr = slotAssignmentError(parseCapabilities(connector.capabilities), slotName);
  if (capErr) return { ok: false, reason: capErr };
  const apiKey = decryptConnectorKey(connector);
  if (isCloudProvider(connector.provider) && !apiKey) {
    return { ok: false, reason: `The ${slotName} connector has no decryptable API key.` };
  }
  return { ok: true, connector, model: slot.model, apiKey };
}

// AI design adjustment — one stateless call on the concept_chat slot: takes a
// preset's tokens + the operator's instruction and returns a SANITIZED
// proposal (parseDesignDoc grammar — the model cannot inject CSS). Never saved
// here; the operator reviews the proposal and saves it as a custom preset.
export async function adjustDesignPreset({ presetKey, instruction }) {
  const preset = getDesignPreset(presetKey);
  if (!preset) return { ok: false, error: `No design preset "${String(presetKey).slice(0, 60)}"` };
  const ready = slotReady('concept_chat');
  if (!ready.ok) return { ok: false, error: ready.reason };
  const system = 'You adjust UI design-token sets for web applications. Reply with STRICT JSON only — no prose, no markdown fences: {"name": string, "description": string, "tokens": {"colors": {"background","surface","text","muted","border","primary","primaryText","accent","danger","success" — hex colors only}, "typography": {"fontFamily","headingFamily","baseSize"}, "radius": {"sm","md","lg"}, "spacing": {"unit"}, "shadow": {"card"}}}. Keep every value in the same format as the input. Change ONLY what the instruction asks, plus whatever minimal changes keep text readable (AA contrast for text on background/surface and primaryText on primary). Return the FULL token set.';
  const user = `Current design "${preset.name}" (${preset.description || 'no description'}):\n${JSON.stringify(preset.tokens, null, 2)}\n\nAdjustment instruction: ${String(instruction || '').slice(0, 1000)}\n\nReturn the full adjusted token set as strict JSON.`;
  const tuned = applyLaneTuning({ model: ready.model, effort: null, thinking: null }, getLaneTuning('chat'));
  // Transcript turns use `text` (anthropicMessages reads turn.text — a
  // `content` key maps to an EMPTY text block, which the API rejects when the
  // cache breakpoint lands on it).
  const res = await callModelTurn({
    connector: ready.connector, apiKey: ready.apiKey, model: tuned.model,
    system, tools: [], transcript: [{ role: 'user', text: user }], maxTokens: 4000,
    effort: tuned.effort, thinking: tuned.thinking,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const text = String(res.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, error: 'the model did not return valid JSON — try the adjustment again' }; }
  const parsed = parseDesignDoc({
    format: DESIGN_DOC_FORMAT,
    key: `${preset.key.replace(/-custom$/, '')}-custom`,
    name: String(doc.name || `${preset.name} (adjusted)`).slice(0, 60),
    description: String(doc.description || preset.description || '').slice(0, 300),
    tokens: doc.tokens || doc,
  });
  if (!parsed.ok) return { ok: false, error: `the adjusted tokens did not validate: ${parsed.error}` };
  return { ok: true, proposal: parsed.data, base: preset.key };
}

// The concept stage needs BOTH slots ready (chat + mockup). Returns
// { ok, chat, mockup, reason }.
export function conceptReady() {
  const chat = slotReady('concept_chat');
  if (!chat.ok) return { ok: false, reason: chat.reason };
  const mockup = slotReady('mockup');
  if (!mockup.ok) return { ok: false, reason: mockup.reason };
  return { ok: true, chat, mockup };
}

// ---- pricing + quota (mirrors runner.js; concept turns spend too, R5) ----
// Pricing (effectivePrice) is shared from connectors.js so every stage prices the
// same way, with the built-in default rate as the fallback.

// The buffered $ envelope for a concept turn: chat priced on the concept_chat
// slot + mockup priced on the mockup slot (they may be different connectors).
function estimateConceptCostCents(ready) {
  const env = estimateConceptTurnTokens();
  const chatPrice = effectivePrice(ready.chat.connector.id, ready.chat.model);
  const mockupPrice = effectivePrice(ready.mockup.connector.id, ready.mockup.model);
  return costCentsForUsage(env.chat, chatPrice) + costCentsForUsage(env.mockup, mockupPrice);
}

function quotaVerdict(projectId, estCostCents) {
  const quota = getApplicableQuota(projectId, 'monthly');
  if (!quota) return { verdict: { ok: true }, quota: null };
  const usage = periodUsage({ scope: quota.scope, projectId: quota.scope === 'project' ? quota.project_id : null, period: quota.period });
  const runningCycles = countRunningCycles(quota.scope === 'project' ? projectId : null);
  const verdict = canStartCycle(
    { estCostCents },
    { budgetCents: quota.budget_cents, bufferPct: quota.buffer_pct, maxConcurrentCycles: quota.max_concurrent_cycles },
    { spentCents: usage.costCents, runningCycles },
  );
  return { verdict, quota };
}

// Ledger + cycle usage after a model call. Cache read/write tokens are counted
// and priced too (they're separate from usage.inputTokens).
function recordSpend({ projectId, cycleId, connector, model, usage }) {
  const cacheRead = usage.cacheReadInputTokens || 0;
  const cacheWrite = usage.cacheCreationInputTokens || 0;
  const cents = costCentsForUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }, effectivePrice(connector.id, model));
  // Cost is cache-aware; the token count is fresh input + output (cache re-reads
  // would inflate it — see runner.js).
  addCycleUsage(cycleId, { tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0), costCents: cents });
  try {
    insertLedgerEntry({ projectId, cycleId, connectorId: connector.id, model, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, costCents: cents, wallClockMs: 0 });
  } catch (e) { console.warn('[mock2] concept ledger write failed:', e?.message); }
}

// ---- container IO (concept-local; the concept stage writes ONLY mockups) ----

function containerSh(containerName, script, { timeoutMs = 120000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

// Run a script with a PAYLOAD on stdin. The script rides argv base64-encoded
// (b64 is a shell-safe charset, so no quoting hazard and it stays tiny);
// stdin is left free for the payload. This exists because embedding content
// in the command string hits Linux's 128KiB-per-argv-entry cap — a large
// mockup failed to SAVE with `spawn E2BIG` once renders could exceed ~96KB.
function containerShWithStdin(containerName, script, input, { timeoutMs = 120000 } = {}) {
  return sh(`incus exec ${containerName} -- sh -c 'eval "$(printf %s ${b64(script)} | base64 -d)"'`, { timeoutMs, input });
}

// Write a FIXED-path file into the working tree (payload base64-streamed over
// STDIN — no quoting hazard from model-authored HTML and no argv size limit).
// relPath is an orchestrator constant (a mockup under state/mockups or
// state/inventory.json), never a model-supplied path.
async function writeWorkingFile(containerName, relPath, content) {
  const script = `d="${APP_DIR}/${relPath}"; mkdir -p "$(dirname "$d")"; base64 -d > "$d" && echo ok`;
  const r = await containerShWithStdin(containerName, script, b64(content));
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'write failed').trim().slice(-300) };
  return { ok: true };
}

async function readWorkingFile(containerName, relPath) {
  const r = await containerSh(containerName, `cat "${APP_DIR}/${relPath}" 2>/dev/null`);
  if (r.code !== 0) return { ok: false, error: 'not found' };
  return { ok: true, content: r.stdout || '' };
}

// Archive the mockup on approval: KEEP the served current.html so the design
// preview at /_preview/ still resolves (this is where the design started, and we
// want everyone to be able to revisit it), but prune the per-id history files so
// the dir doesn't grow unbounded. The dir + current.html stay committed in the
// repo, so the archived mockup survives rehydrate and the post-build app (its
// scaffold serves /_preview from state/mockups too).
async function archiveMockups(containerName) {
  const script = `cd "${APP_DIR}/state/mockups" 2>/dev/null || exit 0; `
    + `for f in ./*.html; do [ "$f" = "./current.html" ] || rm -f "$f"; done 2>/dev/null; echo ok`;
  return containerSh(containerName, script);
}

async function checkpoint(containerName, message) {
  const cp = buildCheckpointScript({ appDir: APP_DIR, message });
  const r = await containerSh(containerName, cp, { timeoutMs: 120000 });
  if (r.code !== 0) console.warn(`[mock2] concept checkpoint non-zero: ${(r.stdout || r.stderr || '').trim().slice(-300)}`);
  const sha = await containerSh(containerName, `git -C "${APP_DIR}" rev-parse HEAD 2>/dev/null`);
  return (sha.stdout || '').trim().split('\n').pop() || null;
}

async function maybePushRemote(projectId) {
  try {
    const remote = getProjectRemote(projectId);
    if (remote?.push_on_checkpoint) {
      const push = await pushProjectRemote(getProject(projectId));
      if (!push.ok) console.warn(`[mock2] concept push_on_checkpoint failed for ${projectId}: ${push.error}`);
    }
  } catch (e) { console.warn('[mock2] concept push_on_checkpoint error:', e?.message); }
}

// ---- design template (export/import — the design/mockup only, never code) ----

// Read a design artifact from wherever it currently lives: the live container's
// working tree when the project is online (the source of truth mid-Concept),
// falling back to the bare repo (every mockup write checkpoints there, and it
// is the state that survives stopped/archived projects — ADR-006). relPath is
// always an orchestrator constant, never caller input. base64-wrapped so the
// content survives the string-capturing runner (same idiom as exportProjectZip).
async function readDesignFile(project, relPath) {
  if (project.lifecycle === 'active') {
    const containerName = project.container_name || containerNameForProject(project.id);
    const r = await readWorkingFile(containerName, relPath);
    if (r.ok && r.content) return { ok: true, content: r.content };
  }
  if (project.repo_path) {
    const safeRepo = String(project.repo_path).replace(/'/g, `'\\''`);
    const r = await sh(`git --git-dir='${safeRepo}' show 'HEAD:${relPath}' 2>/dev/null | base64 -w0`, { timeoutMs: 30000 });
    const b64 = (r.stdout || '').trim();
    if (r.code === 0 && b64) {
      try {
        return { ok: true, content: Buffer.from(b64, 'base64').toString('utf8') };
      } catch { /* fall through to the error below */ }
    }
  }
  return { ok: false, error: `could not read ${relPath} from the container or the repository` };
}

// exportDesignTemplate — assemble the portable design-template document for a
// project: the current/archived mockup HTML (state/mockups/current.html is kept
// after approval precisely so the design stays reachable), the design tokens
// when approval extracted them, and the design conversation + original prompt
// from the chat. No application code is ever included. Works for active,
// stopped, and archived projects (bare-repo fallback). { ok, doc, error }.
export async function exportDesignTemplate(project) {
  if (!projectHasDesign(project)) {
    return { ok: false, error: 'This project has no design mockup to export yet — generate one in the design chat first.' };
  }
  const mock = await readDesignFile(project, MOCKUP_CURRENT);
  if (!mock.ok || !isPlausibleMockup(mock.content)) {
    return { ok: false, error: mock.error || 'the stored mockup is not readable HTML' };
  }
  let designTokens = null;
  const tok = await readDesignFile(project, DESIGN_TOKENS_PATH);
  if (tok.ok) {
    try { designTokens = JSON.parse(tok.content); } catch { designTokens = null; }
  }
  const doc = buildDesignTemplate({
    project, mockupHtml: mock.content, designTokens,
    messages: listMessages(project.id), exportedAt: nowIso(),
  });
  return { ok: true, doc };
}

// importDesignTemplate — seed a project's Concept stage from a parsed template
// (parseDesignTemplate ran in the route). Pure container writes + a checkpoint,
// no model call and no quota spend: the imported HTML becomes the current
// mockup (served at /_preview/ immediately), the template's original prompt +
// the Builder's notes seed the chat transcript as a user turn (so iteration
// keeps the intent), and the design_import record is stored so the initial
// build after approval quotes the original brief. Editor-gated by the route;
// takes the checkout lock like any other concept write (ADR-004).
export async function importDesignTemplate({ project, template, notes = '', source = 'file', sourceName = null, user, actingAsAdmin = 0 }) {
  const projectId = Number(project.id);
  if (project.lifecycle !== 'active') {
    return { ok: false, error: `The project must be online to import a design (it is "${project.lifecycle}"). Bring it online first.` };
  }
  if (project.design_approved_at) {
    return { ok: false, error: 'The design is already approved — a design template can only be imported while the project is still in Concept.' };
  }
  const holder = { type: 'user', id: user.id };
  const lock = acquireLock({ projectId, requester: holder, role: actingAsAdmin ? 'admin' : (user.role === 'admin' ? 'admin' : 'editor') });
  if (!lock.ok) {
    return { ok: false, error: lock.reason || 'This project is checked out by another writer. Request a takeover to continue.' };
  }

  const containerName = project.container_name || containerNameForProject(projectId);
  const mockupId = mockupIdForImport(Date.now());
  const html = template.mockup_html;
  const w1 = await writeWorkingFile(containerName, mockupFileName(mockupId), html);
  const w2 = await writeWorkingFile(containerName, MOCKUP_CURRENT, html);
  if (!w1.ok || !w2.ok) {
    return { ok: false, error: `The imported mockup couldn't be saved: ${w1.error || w2.error}` };
  }
  touchLock(projectId, holder);
  const sha = await checkpoint(containerName, `mock2: imported design template ${mockupId}`);
  await maybePushRemote(projectId);

  const record = designImportRecord({
    template, notes, source, sourceName,
    importedBy: user.id, importedAt: nowIso(), mockupId,
  });
  updateProject(projectId, {
    current_mockup_id: mockupId,
    design_import_json: JSON.stringify(record),
    last_activity_at: nowIso(),
  });

  // Seed the conversation. The brief rides as a 'user' turn (it IS the
  // Builder's intent, restated) so buildConceptTranscript replays it to the
  // model on every later turn; the system note is the human-facing receipt.
  getOrCreateChat(projectId);
  const seed = buildImportSeedMessage({ originalPrompt: template.original_prompt, notes, sourceName: record.source_name });
  if (seed) insertMessage({ projectId, authorUserId: user.id, actingAsAdmin, kind: 'user', body: seed });
  insertMessage({
    projectId, kind: 'system',
    body: `Imported the design template${record.source_name ? ` from "${record.source_name}"` : ''} — the mockup is live at the preview${sha ? ` (checkpoint ${sha.slice(0, 8)})` : ''}. Iterate it in chat, or approve the design when it feels right.`,
  });
  return { ok: true, mockupId, record };
}

// ---- a concept chat turn ----

// startConceptTurn — the Builder sent a chat message. Synchronous setup (lock,
// insert the user message, quota check, create the concept cycle), then fire the
// background turn. Returns { status:'started'|'refused'|'error', cycle, userMessage, error }.
// `images` is the VALIDATED list from chat-image-logic.validateChatImages —
// saved to disk here (content-addressed) and stamped on the user message as
// small descriptors; the turn hydrates them into the model calls.
export async function startConceptTurn({ project, message, user, actingAsAdmin = 0, mode = 'design', images = [], design = 'theme' }) {
  const projectId = Number(project.id);
  const turnMode = mode === 'plan' ? 'plan' : 'design';

  if (project.lifecycle !== 'active') {
    return { status: 'error', error: `The project must be online to chat (it is "${project.lifecycle}"). Bring it online first.` };
  }
  if (project.design_approved_at) {
    return { status: 'error', error: 'The design is already approved — Concept is complete. Iterating the built app is a later stage.' };
  }
  const ready = conceptReady();
  if (!ready.ok) return { status: 'error', error: ready.reason };

  const framework = getCurrentFrameworkVersion();
  if (!framework) return { status: 'error', error: 'No framework version exists to pin. Publish one first.' };

  // A human chat write takes the checkout lock (ADR-004 — the first human holder
  // the module creates). Refuse if someone else holds it (the UI offers takeover).
  const lock = acquireLock({ projectId, requester: { type: 'user', id: user.id }, role: actingAsAdmin ? 'admin' : (user.role === 'admin' ? 'admin' : 'editor') });
  if (!lock.ok) {
    return { status: 'error', error: lock.reason || 'This project is checked out by another writer. Request a takeover to continue.' };
  }

  // Record the Builder's message (acting_as_admin stamped, ADR-007) — with any
  // image attachments saved to disk first (bytes never enter SQLite).
  getOrCreateChat(projectId);
  let attachments = [];
  try { attachments = saveChatImages(projectId, images); } catch (e) { console.warn('[mock2] chat image save failed:', e?.message); }
  const userMessage = insertMessage({ projectId, authorUserId: user.id, actingAsAdmin, kind: 'user', body: message, attachments });

  // Quota check (R5 — a concept turn spends on chat + mockup). refused_quota is a
  // real terminal cycle status.
  const estCostCents = estimateConceptCostCents(ready);
  const { verdict } = quotaVerdict(projectId, estCostCents);
  if (!verdict.ok) {
    const refused = insertCycle({
      projectId, frameworkVersionId: framework.id, stage: 'concept', instruction: message.slice(0, 2000),
      initiatedBy: user.id, actingAsAdmin, estCostCents, status: 'refused_quota',
    });
    finishCycle(refused.id, { status: 'refused_quota', error: verdict.reason });
    insertMessage({ projectId, kind: 'system', cycleId: refused.id, body: `This message wasn't processed — ${verdict.reason}` });
    return { status: 'refused', cycle: getCycle(refused.id), userMessage, error: verdict.reason };
  }

  const cycle = insertCycle({
    projectId, frameworkVersionId: framework.id, stage: 'concept', instruction: message.slice(0, 2000),
    initiatedBy: user.id, actingAsAdmin, estCostCents, status: 'running',
  });
  updateCycle(cycle.id, { started_at: nowIso() });
  setJob(projectId, { phase: 'thinking', message: 'Thinking…', kind: 'turn', cycleId: cycle.id, startedAt: Date.now() });

  runConceptTurn({ project, cycle: getCycle(cycle.id), ready, framework, user, actingAsAdmin, message, mode: turnMode, userAttachments: attachments, design: design === 'explore' ? 'explore' : 'theme' }).catch((err) => {
    console.error(`[mock2] concept turn crashed for project ${projectId}:`, err?.message || err);
    try { finishCycle(cycle.id, { status: 'failed', error: `concept turn crashed: ${err?.message || err}` }); } catch { /* ignore */ }
    try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Something went wrong on that turn: ${err?.message || err}` }); } catch { /* ignore */ }
    setJob(projectId, { phase: 'failed', message: `turn crashed: ${err?.message || err}`, partial: null });
    scheduleJobCleanup(projectId);
  });

  return { status: 'started', cycle: getCycle(cycle.id), userMessage };
}

async function runConceptTurn({ project, cycle, ready, framework, user, actingAsAdmin, message, mode = 'design', userAttachments = [], design = 'theme' }) {
  const projectId = Number(project.id);
  const containerName = project.container_name || containerNameForProject(projectId);
  const holder = { type: 'user', id: user.id };
  const planMode = mode === 'plan';

  // 1) The concept_chat reply (+ optional mockup request). Restricted tool set:
  //    the ONLY tool is generate_mockup — no write/exec, so the stage cannot
  //    touch backend code or rules (enforced here in dispatch, not the prompt).
  //    In PLAN mode the model gets NO tools at all, so it structurally cannot
  //    produce a mockup and stays in conversation until the Builder switches to
  //    Design. The Builder's message is already stored, so buildConceptTranscript
  //    reads the whole history (including it) — don't append it again.
  // Multi-modal: hydrate image attachments into the transcript (the most
  // recent few as real image blocks; older ones as stable placeholders).
  const transcript = buildConceptTranscript(hydrateChatMessagesForModel(projectId, listMessages(projectId)));
  const hasMockup = !!project.current_mockup_id;
  // The locked design system, plus the binding palette of the base preset the
  // Builder chose at creation (no preset → unchanged, the model picks the look).
  // Design direction (Builder's per-turn choice): 'theme' binds the base theme
  // (extend-complementarily wording), 'explore' sets it aside for a fresh,
  // reference-quality look — adopted as the project design only on approval.
  const explore = design === 'explore';
  const boundDesignSystem = explore
    ? applyExploreDesign(framework.design_system_md)
    : applyDesignPreset(framework.design_system_md, project.design_preset);
  const system = buildConceptChatSystemPrompt({ designSystem: boundDesignSystem, projectName: project.name, hasMockup, mode });

  // Stream the reply where the provider supports it (Anthropic): visible text
  // deltas accumulate on the job as `partial`, which the poll surfaces as a
  // live assistant bubble. Throttled — a Map write is cheap, but no need to
  // churn per token.
  let partial = '';
  let lastPartialPush = 0;
  const onDelta = (t) => {
    partial += t;
    const now = Date.now();
    if (now - lastPartialPush > 250) {
      lastPartialPush = now;
      setJob(projectId, { phase: 'thinking', message: 'Writing…', kind: 'turn', cycleId: cycle.id, partial });
    }
  };
  // maxTokens covers the reply + the generate_mockup tool call AND, on capable
  // models, adaptive thinking (routing turned it on; it shares the budget) —
  // sized up from the pre-thinking 4000 so the tool call can't be squeezed out.
  const chatTuned = applyLaneTuning({ model: ready.chat.model, effort: null, thinking: null }, getLaneTuning('chat'));
  const chatRes = await callModelTurn({
    connector: ready.chat.connector, apiKey: ready.chat.apiKey, model: chatTuned.model,
    system, tools: planMode ? [] : CONCEPT_CHAT_TOOLS, transcript, maxTokens: 16000,
    effort: chatTuned.effort, thinking: chatTuned.thinking,
    onDelta,
  });
  if (!chatRes.ok) {
    finishCycle(cycle.id, { status: 'failed', error: chatRes.error });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `The design partner couldn't respond: ${chatRes.error}` });
    setJob(projectId, { phase: 'failed', message: chatRes.error, partial: null });
    return scheduleJobCleanup(projectId);
  }
  // NOTE: `partial` stays on the job through a mockup render (the streamed
  // reply remains visible while the design generates) and is cleared exactly
  // when the durable assistant message lands below.
  recordSpend({ projectId, cycleId: cycle.id, connector: ready.chat.connector, model: ready.chat.model, usage: chatRes.usage });
  const decision = classifyConceptTurn(chatRes.toolCalls);

  // 2) If the model asked for a mockup, render it on the mockup slot and write it
  //    into the container (the only container write the concept stage performs).
  //    The OUTCOME note (updated / failed) is collected here and posted AFTER
  //    the assistant reply below — the reply is the chat model's text from
  //    BEFORE the render, so posting the outcome first read backwards ("render
  //    failed" above "let me get a first version up").
  let mockupNote = null;        // success (also drives the reply fallback)
  let mockupSystemNote = null;  // posted after the reply, success or failure
  if (decision.generateMockup) {
    let currentHtml = null;
    // Tweak mode edits the CURRENT file — only safe when we hold the COMPLETE
    // document (a truncated read would corrupt anything past the cap).
    let currentHtmlComplete = false;
    if (hasMockup) {
      const cur = await readWorkingFile(containerName, MOCKUP_CURRENT);
      if (cur.ok) {
        currentHtmlComplete = String(cur.content || '').length <= MAX_MOCKUP_FEEDBACK_CHARS;
        currentHtml = String(cur.content || '').slice(0, MAX_MOCKUP_FEEDBACK_CHARS);
      }
    }
    // A brief that RESPECIFIES the visual language (tokens, palette, theme) is
    // design work, not transcription — it must run at full depth even on an
    // "On theme" revision turn, and the prior document's stylesheet must NOT
    // ride along as context (that is how the incumbent palette survived an
    // explicit token spec: geometry obeyed, color ignored — operator review).
    const restyleBrief = /\b(themes?|palettes?|design tokens?|tokens?|color scheme|light mode|dark mode|rebrand|restyl\w+)\b/i.test(String(decision.brief || ''))
      || /#[0-9a-fA-F]{3,8}\b/.test(String(decision.brief || ''));
    const mockupTask = buildMockupTask({
      brief: decision.brief, currentHtml, projectName: project.name,
      conversation: conversationRecap(listMessages(projectId)),
      restyle: restyleBrief,
    });
    // A full mockup is a LONG single generation (several minutes). Give it a
    // proportionate window and narrate progress via the heartbeat. The token
    // budget must now cover ADAPTIVE THINKING too (routing turned it on for
    // capable models — it shares max_tokens with the HTML), so it is sized
    // well above the old 16k: a thinking-heavy render otherwise truncates and
    // fails the plausibility check with nothing to show.
    // The mockup model doesn't see the chat transcript — but it SHOULD see the
    // images the Builder just attached (design references / screenshots are
    // exactly what a render needs). This turn's attachments ride the task.
    const mockupImages = hydrateAttachments(projectId, userAttachments);
    // STREAM the render (Anthropic guidance for long output / large max_tokens /
    // image input): a big non-streaming render — worsened by attached images and
    // adaptive thinking pushing time-to-first-byte past Node's ~5-min undici
    // headers timeout — fails at the transport layer with a bare "fetch failed"
    // (exactly the 3-image case reported). Streaming keeps the socket producing
    // bytes so the timeout never trips; the onDelta also narrates live progress.
    // The chunks are NOT surfaced as chat text (the HTML isn't a chat reply) —
    // onDelta only exists to flip the client into streaming mode + drive the
    // heartbeat. The 15-min AbortController still bounds total wall-clock.
    let streamedChars = 0;
    let lastStreamPush = 0;
    // LIVE PARTIAL PREVIEW (first render only): browsers render incomplete
    // HTML progressively, so writing the accumulated stream to the preview
    // path every few seconds lets the Builder watch screens appear instead of
    // staring at "Designing… (29k characters)" for minutes. Iterations never
    // stream partials — a half-written doc must not clobber a good mockup.
    let streamBuf = '';
    let lastPartialWrite = 0;
    const onMockupDelta = (t) => {
      streamedChars += t.length;
      streamBuf += t;
      const now = Date.now();
      if (now - lastStreamPush > 1500) {
        lastStreamPush = now;
        setJob(projectId, {
          phase: 'designing',
          message: `${currentHtml ? 'Updating' : 'Designing'} the mockup… (${Math.round(streamedChars / 1000)}k characters${currentHtml ? '' : ' — the preview fills in live'})`,
          kind: 'turn', cycleId: cycle.id,
        });
      }
      if (!currentHtml && now - lastPartialWrite > 8000) {
        const idx = streamBuf.search(/<!doctype html/i);
        if (idx !== -1 && streamBuf.length - idx > 2000) {
          lastPartialWrite = now;
          void writeWorkingFile(containerName, MOCKUP_CURRENT, streamBuf.slice(idx)).catch(() => undefined);
        }
      }
    };
    const mockupCall = (budget, forceModel = null) => {
      streamedChars = 0;
      // A render is transcription of the brief onto the design system — pure
      // output. The lane default turns thinking OFF so the WHOLE budget goes
      // to the HTML (adaptive thinking otherwise eats into max_tokens and
      // truncates the document mid-page). Operator lane tuning may override.
      // Explore turns get the claude.ai-style depth back: adaptive thinking ON
      // and high effort on the mockup render, overriding the lane default and
      // the global thinking-off switch for THIS call only (design exploration
      // is exactly where the reasoning pays for itself). Theme turns keep the
      // fast lane defaults (pure transcription of the brief onto the theme).
      // The render defaults to the STRONGEST model (mockupRenderModel — every
      // build inherits the mockup's quality), with operator lane tuning still
      // the last word; the caller falls back to the slot model if the
      // connector rejects the preferred one.
      // The FIRST render of a project gets exploration-grade depth even on
      // "On theme": there is no existing mockup to transcribe, so low-effort/
      // thinking-off "pure transcription" produced exactly the flat, junior
      // first designs the operator flagged. Iterations on an existing mockup
      // keep the fast lane defaults (they really are transcription).
      const renderModel = mockupRenderModel(process.env, ready.mockup.model);
      const deepRender = explore || !currentHtml || restyleBrief;
      const mockupTuned = deepRender
        ? { model: renderModel, effort: 'high', thinking: null }
        : applyLaneTuning({ model: renderModel, effort: 'low', thinking: 'off' }, getLaneTuning('mockup'));
      return callModelTurn({
        connector: ready.mockup.connector, apiKey: ready.mockup.apiKey, model: forceModel || mockupTuned.model,
        system: buildMockupSystemPrompt({ designSystem: boundDesignSystem }),
        tools: [], transcript: [{ role: 'user', text: mockupTask, ...(mockupImages.length ? { images: mockupImages } : {}) }],
        maxTokens: budget,
        timeoutMs: 900000,
        effort: mockupTuned.effort,
        thinking: mockupTuned.thinking,
        onDelta: onMockupDelta,
      });
    };
    let html = '';
    let failureDetail = null;
    let activeModel = null; // stamped per successful call for accurate spend pricing
    // ---- tweak path (scope 'tweak' from the design partner) ----
    // A one-line copy change used to re-output the ENTIRE document — output
    // tokens dominate render cost, so "change the text" cost as much as the
    // original render (user report). A tweak asks for surgical search/replace
    // edits against the current HTML (tiny output) and falls back to the full
    // renderer the moment anything doesn't apply cleanly.
    let tweaked = false;
    // First render: stamp the mockup id + a designed placeholder NOW so the
    // preview URL exists immediately and the live partial writes above have
    // somewhere visible to land (the dashboard preview refreshes while the
    // job runs). The id is deterministic (mockupIdForCycle), so the success
    // path finalizes the very same id.
    if (!currentHtml) {
      try {
        const placeholder = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{height:100%;margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1524;color:#dbe6f5}main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px}.dot{width:34px;height:34px;border-radius:50%;border:3px solid #2c4a76;border-top-color:#6ea8ff;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(1turn)}}p{margin:0;font-size:14px;color:#8fa5c4}</style></head><body><main><div class="dot"></div><h1 style="margin:0;font-size:18px">Designing your mockup…</h1><p>Screens appear here as they render — this preview refreshes on its own.</p></main></body></html>';
        await writeWorkingFile(containerName, MOCKUP_CURRENT, placeholder);
        updateProject(projectId, { current_mockup_id: mockupIdForCycle(cycle.id) });
      } catch { /* preview-only nicety */ }
    }
    if (decision.scope === 'tweak' && currentHtml && currentHtmlComplete) {
      setJob(projectId, { phase: 'designing', message: 'Applying a targeted tweak to the mockup…', kind: 'turn', cycleId: cycle.id });
      try {
        const editModel = mockupRenderModel(process.env, ready.mockup.model);
        const res = await callModelTurn({
          connector: ready.mockup.connector, apiKey: ready.mockup.apiKey, model: editModel,
          system: buildMockupEditSystemPrompt(),
          tools: [],
          transcript: [{ role: 'user', text: `Revision request:\n${decision.brief}\n\nCurrent mockup HTML:\n${currentHtml}` }],
          maxTokens: 6000, timeoutMs: 300000, effort: 'low', thinking: 'off',
        });
        if (res.ok) {
          recordSpend({ projectId, cycleId: cycle.id, connector: ready.mockup.connector, model: editModel, usage: res.usage });
          const parsed = parseMockupEdits(res.text);
          if (parsed.ok && !parsed.fullRerender) {
            const applied = applyMockupEdits(currentHtml, parsed.edits);
            if (applied.ok && isPlausibleMockup(applied.html)) {
              html = applied.html.slice(0, MAX_MOCKUP_CHARS);
              activeModel = editModel;
              tweaked = true;
            } else {
              console.warn(`[mock2] mockup tweak did not apply cleanly (${applied.error || 'implausible result'}) — full render fallback`);
            }
          }
          // parsed.fullRerender (the model judged it structural) falls through.
        }
      } catch (e) { console.warn('[mock2] mockup tweak failed — full render fallback:', e?.message); }
      if (!tweaked) setJob(projectId, { phase: 'designing', message: 'The change needs the full renderer — rendering the mockup…', kind: 'turn', cycleId: cycle.id });
    }
    // ---- screen path (scope 'screen'): re-render ONE section ----
    // A single-screen redesign re-renders only that screen's <section> (the
    // structural contract every mockup follows) — output is one screen, not
    // the whole document, so it lands in a fraction of the time and cost.
    // Global changes still run the full renderer. Any miss (unknown screen
    // name, unusable reply) falls back to the full renderer.
    if (!tweaked && decision.scope === 'screen' && decision.screen && currentHtml && currentHtmlComplete) {
      const found = findScreenSection(currentHtml, decision.screen);
      if (found.ok) {
        setJob(projectId, { phase: 'designing', message: `Re-rendering the "${decision.screen}" screen…`, kind: 'turn', cycleId: cycle.id });
        try {
          const secModel = mockupRenderModel(process.env, ready.mockup.model);
          const res = await callModelTurn({
            connector: ready.mockup.connector, apiKey: ready.mockup.apiKey, model: secModel,
            system: buildScreenRenderSystemPrompt({ designSystem: boundDesignSystem }),
            tools: [],
            transcript: [{
              role: 'user',
              text: `Screen to re-render: "${decision.screen}"\n\nRevision brief:\n${decision.brief}\n\nCurrent FULL mockup document (context — its styles, navigation, and the other screens stay untouched):\n${currentHtml}`,
              ...(mockupImages.length ? { images: mockupImages } : {}),
            }],
            maxTokens: 20000, timeoutMs: 600000, effort: 'high', thinking: null,
          });
          if (res.ok) {
            recordSpend({ projectId, cycleId: cycle.id, connector: ready.mockup.connector, model: secModel, usage: res.usage });
            const section = extractSectionHtml(res.text, decision.screen);
            if (section) {
              const swapped = replaceScreenSection(currentHtml, decision.screen, section);
              if (swapped.ok && isPlausibleMockup(swapped.html)) {
                html = swapped.html.slice(0, MAX_MOCKUP_CHARS);
                activeModel = secModel;
                tweaked = true;
              }
            }
          }
        } catch (e) { console.warn('[mock2] screen re-render failed — full render fallback:', e?.message); }
      }
      if (!tweaked) setJob(projectId, { phase: 'designing', message: `The "${decision.screen}" change needs the full renderer — rendering the mockup…`, kind: 'turn', cycleId: cycle.id });
    }
    const heartbeat = tweaked ? null : startDesignHeartbeat(projectId, cycle.id, { iterating: !!currentHtml });
    // A render that hits its output ceiling is CONTINUED, never discarded
    // (discarding truncated output burned two paid renders for the
    // operator). NOT via assistant prefill — the render model rejects it
    // ("This model does not support assistant message prefill", HTTP 400,
    // which itself cost a turn) — but via an explicit continuation turn:
    // the partial rides the transcript as an assistant message, a user turn
    // asks for ONLY the remainder (anchored on the tail), and the reply is
    // stitched defensively (fences stripped, repeated overlap removed, a
    // full restart detected and adopted). Works on every provider. Up to 2
    // hops; thinking off, this turn's images not re-sent (the written HTML
    // already pins the design; re-sending only re-bills input tokens).
    const continueTruncatedRender = async (partialText) => {
      let doc = String(partialText || '');
      for (let hop = 0; hop < 2; hop++) {
        setJob(projectId, { phase: 'designing', message: `The render hit its output limit — continuing where it stopped (${Math.round(doc.length / 1000)}k characters so far)…`, kind: 'turn', cycleId: cycle.id });
        const res = await callModelTurn({
          connector: ready.mockup.connector, apiKey: ready.mockup.apiKey, model: activeModel,
          system: buildMockupSystemPrompt({ designSystem: boundDesignSystem }),
          tools: [],
          transcript: [
            { role: 'user', text: mockupTask },
            { role: 'assistant', text: doc },
            { role: 'user', text: buildContinuationInstruction(doc) },
          ],
          maxTokens: 30000, timeoutMs: 600000, effort: 'low', thinking: 'off',
          onDelta: onMockupDelta,
        });
        if (!res.ok) return { ok: false, error: res.error };
        recordSpend({ projectId, cycleId: cycle.id, connector: ready.mockup.connector, model: activeModel, usage: res.usage });
        doc = stitchContinuation(doc, res.text).html;
        if (res.stopReason !== 'max_tokens') return { ok: true, text: doc };
      }
      return { ok: false, error: 'the document is too large to finish even with continuation — ask for the change on ONE screen at a time (screen-scoped renders have no such limit)' };
    };
    // Complete a call's text: continue through truncation; otherwise hand
    // back what arrived (the plausibility check + bigger-budget retry below
    // still apply).
    const completeRenderText = async (res) => {
      if (res.stopReason === 'max_tokens') {
        const cont = await continueTruncatedRender(res.text);
        if (cont.ok) return cont.text;
        console.warn('[mock2] render continuation failed:', cont.error);
        failureDetail = cont.error;
      }
      return res.text;
    };
    if (!tweaked) try {
      // Budgets are sized from the CURRENT document (a revision must be able
      // to re-emit the whole thing plus growth — the old flat 40k truncated
      // large multi-screen documents by construction), streamed so there is
      // no HTTP timeout, and finished via continuation when they still hit
      // the ceiling.
      // Mirror mockupCall's model resolution (preferred model + lane tuning)
      // so spend is priced on the model that actually served the call.
      {
        const pref = mockupRenderModel(process.env, ready.mockup.model);
        activeModel = (explore || !currentHtml || restyleBrief) ? pref
          : applyLaneTuning({ model: pref, effort: 'low', thinking: 'off' }, getLaneTuning('mockup')).model;
      }
      const renderBudget = mockupRenderBudget(currentHtml ? currentHtml.length : 0);
      let res = await mockupCall(renderBudget);
      if (!res.ok && res.timedOut) {
        setJob(projectId, { phase: 'designing', message: 'The first render attempt timed out — retrying once…', kind: 'turn', cycleId: cycle.id });
        res = await mockupCall(renderBudget);
      }
      // Preferred-model fallback: an org whose key doesn't serve the preferred
      // model gets the assigned slot model instead of a dead render.
      if (!res.ok && activeModel !== ready.mockup.model && /model/i.test(String(res.error || '')) ) {
        setJob(projectId, { phase: 'designing', message: `The preferred render model was rejected — falling back to the assigned mockup model (${ready.mockup.model})…`, kind: 'turn', cycleId: cycle.id });
        activeModel = ready.mockup.model;
        res = await mockupCall(renderBudget, ready.mockup.model);
      }
      if (res.ok) {
        recordSpend({ projectId, cycleId: cycle.id, connector: ready.mockup.connector, model: activeModel, usage: res.usage });
        html = extractMockupHtml(await completeRenderText(res)).slice(0, MAX_MOCKUP_CHARS);
        if (!isPlausibleMockup(html)) {
          // Not a usable page (prose instead of HTML, or truncation on a
          // provider without prefill continuation). ONE automatic retry with
          // a bigger budget before giving up — a failed render wastes the
          // whole turn, so the retry is the cheaper outcome in expectation.
          const why = res.stopReason === 'max_tokens' ? 'it ran out of output budget' : 'it was not a complete HTML page';
          setJob(projectId, { phase: 'designing', message: `The first render was unusable (${why}) — retrying once with a larger budget…`, kind: 'turn', cycleId: cycle.id });
          const retry = await mockupCall(Math.max(64000, renderBudget), activeModel);
          if (retry.ok) {
            recordSpend({ projectId, cycleId: cycle.id, connector: ready.mockup.connector, model: activeModel, usage: retry.usage });
            const h2 = extractMockupHtml(await completeRenderText(retry)).slice(0, MAX_MOCKUP_CHARS);
            if (isPlausibleMockup(h2)) { html = h2; failureDetail = null; }
            else if (!failureDetail) failureDetail = retry.stopReason === 'max_tokens' ? 'the render exceeded its output budget twice' : 'the model did not return a complete HTML page';
          } else {
            failureDetail = retry.error;
          }
        } else {
          failureDetail = null;
        }
      } else {
        failureDetail = res.error;
      }
    } finally {
      if (heartbeat) heartbeat.stop();
    }

    if (isPlausibleMockup(html)) {
      const mockupId = mockupIdForCycle(cycle.id);
      setJob(projectId, { phase: 'saving', message: 'Saving the mockup…', kind: 'turn', cycleId: cycle.id });
      const w1 = await writeWorkingFile(containerName, mockupFileName(mockupId), html);
      const w2 = await writeWorkingFile(containerName, MOCKUP_CURRENT, html);
      if (w1.ok && w2.ok) {
        touchLock(projectId, holder);
        const sha = await checkpoint(containerName, `mock2: concept mockup ${mockupId}`);
        await maybePushRemote(projectId);
        updateProject(projectId, { current_mockup_id: mockupId, last_activity_at: nowIso() });
        mockupNote = 'Updated the mockup — it is live in the preview.';
        mockupSystemNote = `${mockupNote}${sha ? ` (checkpoint ${sha.slice(0, 8)})` : ''}`;
        // Acceptance-check lint (design-system §7) — ADVISORY: findings ride
        // the system note so regressions surface before a human reviews, but
        // a flagged mockup still saves (the Builder judges the design).
        try {
          const checksLine = mockupChecksNote(runMockupChecks(html));
          if (checksLine) mockupSystemNote += ` ${checksLine}`;
        } catch { /* lint must never break a save */ }
      } else {
        mockupSystemNote = `The mockup couldn't be saved: ${w1.error || w2.error}`;
      }
    } else {
      mockupSystemNote = `The design model did not return a usable mockup${failureDetail ? ` (${failureDetail})` : ''} — the previous version is unchanged. Send the message again or rephrase what you want to see.`;
    }
  }

  // 3) Always post the concept partner's plain-language reply. Synthesize one if
  //    the model only called the tool with no text. The mockup OUTCOME note
  //    follows it, so the chat reads in event order.
  const replyText = String(chatRes.text || '').trim()
    || (mockupNote ? "I've updated the mockup — take a look and tell me what to change." : "I'm here — tell me a bit more about what you'd like to build.");
  // The reply carries the TURN's spend (chat call + any mockup render — both
  // recorded onto this cycle), so the price of a design turn shows on it.
  const spent = getCycle(cycle.id);
  insertMessage({
    projectId, authorUserId: null, kind: 'assistant', cycleId: cycle.id, body: replyText,
    costCents: spent?.used_cost_cents ?? null, tokens: spent?.used_tokens ?? null,
  });
  if (mockupSystemNote) {
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: mockupSystemNote });
  }

  finishCycle(cycle.id, { status: 'succeeded' });
  // Keep the human lock held (the Builder is actively working — the idle sweep
  // reclaims it, or design approval releases it: ADR-004 "release on idle/approval").
  touchLock(projectId, holder);
  // partial cleared here — the durable assistant message above replaces the
  // streamed preview in the same poll.
  setJob(projectId, { phase: 'done', message: 'Ready', kind: 'turn', cycleId: cycle.id, partial: null });
  scheduleJobCleanup(projectId);
}

// ---- skip the mockup (straight to adjusting the running base app) ----

// skipDesign — the Builder chose to work WITHOUT a mockup: the base app is
// already live (auth + shell + preset styling), so lock the design stage with
// an EMPTY inventory and unlock builds. Zero model calls, zero tokens. The
// screen plan stays empty; quick updates / builds describe screens directly.
export async function skipDesign({ project, user, actingAsAdmin = 0 }) {
  const projectId = Number(project.id);
  if (project.lifecycle !== 'active') return { status: 'error', error: `The project must be online to skip the mockup (it is "${project.lifecycle}").` };
  if (project.design_approved_at) return { status: 'error', error: 'The design is already approved.' };

  const framework = getCurrentFrameworkVersion();
  if (!framework) return { status: 'error', error: 'No framework version exists to pin. Publish one first.' };
  const holder = { type: 'user', id: user.id };
  const lock = acquireLock({ projectId, requester: holder, role: actingAsAdmin ? 'admin' : (user.role === 'admin' ? 'admin' : 'editor') });
  if (!lock.ok) return { status: 'error', error: lock.reason || 'This project is checked out by another writer.' };

  try {
    const containerName = project.container_name || containerNameForProject(projectId);
    const cycle = insertCycle({ projectId, frameworkVersionId: framework.id, stage: 'concept', instruction: 'design skipped', initiatedBy: user.id, actingAsAdmin, estCostCents: 0, status: 'running' });
    updateCycle(cycle.id, { started_at: nowIso() });

    const inv = {
      screens: [], fields: [], actions: [],
      skipped: true, approved_at: nowIso(), approved_by: user.id,
      note: 'Design stage skipped — building directly on the base app; screens are described per build request.',
    };
    const wInv = await writeWorkingFile(containerName, INVENTORY_PATH, JSON.stringify(inv, null, 2));
    if (!wInv.ok) {
      finishCycle(cycle.id, { status: 'failed', error: `could not write inventory: ${wInv.error}` });
      return { status: 'error', error: `Could not record the skip: ${wInv.error}` };
    }
    const summary = 'Design stage skipped — building directly on the live base app (auth, shell, and preset styling already in place).';
    const sha = await checkpoint(containerName, `mock2: ${summary}`);
    let record = null;
    try {
      record = insertChangeRecord({
        projectId, cycleId: cycle.id, initiatedBy: user.id, actingAsAdmin,
        frameworkVersion: framework.version, frameworkVersionId: framework.id,
        rulesTouched: null, gatesRun: null, commitSha: sha, summary,
      });
      if (record) {
        await writeWorkingFile(containerName, `state/changes/${record.seq}.json`, JSON.stringify(changeRecordMirror(record), null, 2));
        await checkpoint(containerName, `mock2: change record ${record.seq}`);
      }
    } catch (e) { console.warn('[mock2] skip-design change record failed:', e?.message); }
    await maybePushRemote(projectId);

    updateProject(projectId, {
      design_approved_at: nowIso(),
      design_inventory_seq: record ? record.seq : null,
      last_activity_at: nowIso(),
    });
    finishCycle(cycle.id, { status: 'succeeded' });

    // Self-heal: skipping the mockup means "work on the RUNNING app" — if the
    // provision-time base-app deploy never happened (older project, or it
    // failed), deploy it now in the background so the URL stops serving the
    // placeholder. Progress + outcome land in the chat.
    let deployed = false;
    try { deployed = projectHasBeenDeployed(projectId) || !!getProject(projectId)?.base_app_deployed_at; }
    catch { deployed = false; }
    if (deployed) {
      insertMessage({
        projectId, kind: 'system', cycleId: cycle.id,
        body: 'Mockup skipped — Build is unlocked. The base app is live (sign-in + first-admin setup + your chosen look); describe changes in the build chat and land them as Quick updates.',
      });
    } else {
      insertMessage({
        projectId, kind: 'system', cycleId: cycle.id,
        body: 'Mockup skipped — Build is unlocked. Deploying the base app now (sign-in + first-admin setup + your chosen look); the chat will confirm when it is live on the project URL — a couple of minutes.',
      });
      const fresh = getProject(projectId);
      deployBaseApp(fresh, { reason: 'design-skip' })
        .catch((e) => console.warn('[mock2] base-app deploy after skip failed:', e?.message));
    }
    return { status: 'ok', cycle: getCycle(cycle.id) };
  } finally {
    releaseLock(projectId, holder);
  }
}

// ---- the design-approval gesture (Stage 1's ONLY exit — sign-off #1) ----

// startDesignApproval — the Builder approved the design. Synchronous guards, then
// fire the background extraction/commit. Returns { status:'started'|'error', cycle, error }.
export async function startDesignApproval({ project, user, actingAsAdmin = 0, buildStrategy = 'all' }) {
  const projectId = Number(project.id);

  if (project.lifecycle !== 'active') return { status: 'error', error: `The project must be online to approve the design (it is "${project.lifecycle}").` };
  if (project.design_approved_at) return { status: 'error', error: 'The design is already approved.' };
  if (!project.current_mockup_id) return { status: 'error', error: 'There is no mockup to approve yet — describe your idea in chat to generate one first.' };

  const ready = conceptReady();
  if (!ready.ok) return { status: 'error', error: ready.reason };
  const framework = getCurrentFrameworkVersion();
  if (!framework) return { status: 'error', error: 'No framework version exists to pin. Publish one first.' };

  const lock = acquireLock({ projectId, requester: { type: 'user', id: user.id }, role: actingAsAdmin ? 'admin' : (user.role === 'admin' ? 'admin' : 'editor') });
  if (!lock.ok) return { status: 'error', error: lock.reason || 'This project is checked out by another writer.' };

  const estCostCents = costCentsForUsage(estimateInventoryTokens(), effectivePrice(ready.chat.connector.id, ready.chat.model));
  const { verdict } = quotaVerdict(projectId, estCostCents);
  if (!verdict.ok) {
    const refused = insertCycle({ projectId, frameworkVersionId: framework.id, stage: 'concept', instruction: 'design approval', initiatedBy: user.id, actingAsAdmin, estCostCents, status: 'refused_quota' });
    finishCycle(refused.id, { status: 'refused_quota', error: verdict.reason });
    return { status: 'error', error: verdict.reason };
  }

  const cycle = insertCycle({ projectId, frameworkVersionId: framework.id, stage: 'concept', instruction: 'design approval', initiatedBy: user.id, actingAsAdmin, estCostCents, status: 'running' });
  updateCycle(cycle.id, { started_at: nowIso() });
  setJob(projectId, { phase: 'approving', message: 'Extracting the design inventory…', kind: 'approval', cycleId: cycle.id, startedAt: Date.now() });

  runDesignApproval({ project, cycle: getCycle(cycle.id), ready, framework, user, actingAsAdmin, buildStrategy }).catch((err) => {
    console.error(`[mock2] design approval crashed for project ${projectId}:`, err?.message || err);
    try { finishCycle(cycle.id, { status: 'failed', error: `approval crashed: ${err?.message || err}` }); } catch { /* ignore */ }
    try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Design approval failed: ${err?.message || err}` }); } catch { /* ignore */ }
    setJob(projectId, { phase: 'failed', message: `approval crashed: ${err?.message || err}` });
    scheduleJobCleanup(projectId);
  });

  return { status: 'started', cycle: getCycle(cycle.id) };
}

async function runDesignApproval({ project, cycle, ready, framework, user, actingAsAdmin, buildStrategy = 'all' }) {
  const projectId = Number(project.id);
  const containerName = project.container_name || containerNameForProject(projectId);
  const holder = { type: 'user', id: user.id };

  // 1) Read the approved mockup and extract a structured inventory (the extractor
  //    runs on the concept_chat slot — a reasoning task over the mockup markup).
  const cur = await readWorkingFile(containerName, MOCKUP_CURRENT);
  if (!cur.ok || !isPlausibleMockup(cur.content)) {
    finishCycle(cycle.id, { status: 'failed', error: 'the current mockup could not be read for extraction' });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: 'Could not read the current mockup to approve it. Generate a mockup and try again.' });
    setJob(projectId, { phase: 'failed', message: 'mockup unreadable' });
    return scheduleJobCleanup(projectId);
  }
  const html = String(cur.content).slice(0, MAX_MOCKUP_CHARS);
  // Elapsed-time narration while the extraction runs (it can take a minute or
  // two on a large mockup — the poll should have movement to show).
  const extractStarted = Date.now();
  const extractTicker = setInterval(() => {
    const s = Math.round((Date.now() - extractStarted) / 1000);
    setJob(projectId, { phase: 'approving', message: `Extracting the design inventory — every screen, field, and action in the approved mockup… (${s}s; it keeps working if you switch tabs)`, kind: 'approval', cycleId: cycle.id });
  }, 9000);
  // The extraction is a pure structured-JSON task over a (potentially very
  // large) mockup. thinking:'off' keeps the whole budget for the JSON —
  // adaptive thinking otherwise ate into it and truncated the output mid-value
  // ("Unterminated string in JSON"). A generous budget (it streams: the large
  // HTML input would otherwise risk a transport timeout too), and — because
  // approval is a hard gate — ONE automatic retry on a parse failure before we
  // make the Builder redo it.
  const extractCall = () => callModelTurn({
    connector: ready.chat.connector, apiKey: ready.chat.apiKey, model: ready.chat.model,
    system: buildInventoryExtractionPrompt(), tools: [],
    transcript: [{ role: 'user', text: buildInventoryExtractionTask({ html, projectName: project.name }) }],
    maxTokens: 32000,
    thinking: 'off',
  });
  let parsed;
  try {
    let extractRes = await extractCall();
    if (extractRes.ok) recordSpend({ projectId, cycleId: cycle.id, connector: ready.chat.connector, model: ready.chat.model, usage: extractRes.usage });
    parsed = extractRes.ok ? parseInventory(extractRes.text) : { ok: false, error: extractRes.error };
    if (!parsed.ok) {
      setJob(projectId, { phase: 'approving', message: 'The inventory came back malformed — extracting once more…', kind: 'approval', cycleId: cycle.id });
      extractRes = await extractCall();
      if (extractRes.ok) recordSpend({ projectId, cycleId: cycle.id, connector: ready.chat.connector, model: ready.chat.model, usage: extractRes.usage });
      parsed = extractRes.ok ? parseInventory(extractRes.text) : { ok: false, error: extractRes.error };
    }
  } finally {
    clearInterval(extractTicker);
  }
  if (!parsed.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `inventory extraction failed: ${parsed.error}` });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Couldn't extract the design inventory: ${parsed.error}. The design is not approved — try approving again.` });
    setJob(projectId, { phase: 'failed', message: parsed.error });
    return scheduleJobCleanup(projectId);
  }
  // CRUD completion + completeness lint (project-32 ratchet): a static
  // mockup can't demonstrate mutation flows, so the implied edit/delete/
  // status actions are ADDED (marked inferred) before the inventory becomes
  // the build contract, and suspicious shapes are surfaced on the approval
  // message. Applies to NEW approvals only — existing inventories are never
  // rewritten.
  const crud = completeInventoryCrud(parsed.inventory);
  parsed = { ok: true, inventory: crud.inventory };
  const invWarnings = lintInventory(crud.inventory);
  const counts = inventoryCounts(parsed.inventory);

  // 2) Write state/inventory.json (the concept-stage exit artifact) and ARCHIVE
  //    the mockup code — the inventory is the UI spec the build works from, but
  //    the mockup itself is preserved at /_preview/ as a record of where the
  //    design started.
  const archivedMockupId = project.current_mockup_id || null;
  setJob(projectId, { phase: 'approving', message: 'Writing inventory and archiving the mockup…', kind: 'approval', cycleId: cycle.id });
  const invJson = JSON.stringify({ ...parsed.inventory, approved_at: nowIso(), approved_by: user.id }, null, 2);
  const wInv = await writeWorkingFile(containerName, INVENTORY_PATH, invJson);
  if (!wInv.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `could not write inventory: ${wInv.error}` });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Couldn't save the design inventory: ${wInv.error}. The design is not approved.` });
    setJob(projectId, { phase: 'failed', message: wInv.error });
    return scheduleJobCleanup(projectId);
  }
  // Carry the mockup's LOOK into the build: extract its design tokens and render
  // a concrete stylesheet so the runner reproduces the approved design instead of
  // re-styling from generic defaults. Best-effort — on any failure we fall back
  // to the framework defaults (parseDesignTokens always returns a safe token set),
  // so this never blocks approval.
  try {
    const tokRes = await callModelTurn({
      connector: ready.chat.connector, apiKey: ready.chat.apiKey, model: ready.chat.model,
      system: buildDesignTokenExtractionPrompt(), tools: [],
      transcript: [{ role: 'user', text: buildDesignTokenExtractionTask({ html, projectName: project.name }) }],
      maxTokens: 8000,
      // Small structured-JSON output — thinking off so the tiny budget isn't
      // consumed by reasoning (best-effort: parseDesignTokens falls back to
      // framework defaults on any failure, so this never blocks approval).
      thinking: 'off',
    });
    if (tokRes.ok) recordSpend({ projectId, cycleId: cycle.id, connector: ready.chat.connector, model: ready.chat.model, usage: tokRes.usage });
    const { tokens } = parseDesignTokens(tokRes.ok ? tokRes.text : '');
    await writeWorkingFile(containerName, DESIGN_TOKENS_PATH, JSON.stringify(tokens, null, 2));
    await writeWorkingFile(containerName, DESIGN_CSS_PATH, renderDesignTokensCss(tokens));
  } catch (e) {
    console.warn('[mock2] design-token extraction failed (build falls back to framework defaults):', e?.message);
  }

  await archiveMockups(containerName);
  touchLock(projectId, holder);

  // 3) Commit the checkpoint and read its sha.
  const summary = `Design approved — inventory extracted (${counts.screens} screen${counts.screens === 1 ? '' : 's'}, ${counts.fields} field${counts.fields === 1 ? '' : 's'}, ${counts.actions} action${counts.actions === 1 ? '' : 's'}); mockup archived at the design preview.`;
  const sha = await checkpoint(containerName, `mock2: ${summary}`);

  // 4) The hash-chained change record (sign-off #1). The chain must keep verifying.
  let record = null;
  try {
    record = insertChangeRecord({
      projectId, cycleId: cycle.id, initiatedBy: user.id, actingAsAdmin,
      frameworkVersion: framework.version, frameworkVersionId: framework.id,
      rulesTouched: null, gatesRun: null, commitSha: sha, summary,
    });
  } catch (e) {
    console.error('[mock2] approval change record insert failed:', e?.message);
  }

  // 5) Mirror the record into the repo (state/changes/<seq>.json) + commit, so
  //    rehydrate restores readable history even if mock2.db is lost (ADR-006).
  if (record) {
    try {
      await writeWorkingFile(containerName, `state/changes/${record.seq}.json`, JSON.stringify(changeRecordMirror(record), null, 2));
      await checkpoint(containerName, `mock2: change record ${record.seq}`);
    } catch (e) { console.warn('[mock2] approval change-record mirror failed:', e?.message); }
  }
  await maybePushRemote(projectId);

  // 6) Stamp the sign-off, clear the LIVE mockup pointer (so the build-mode
  //    preview shows the working app, not the mockup) while recording the
  //    archived mockup id (so /_preview/ stays reachable as the design record),
  //    unlock Build, and RELEASE the human lock (approval ends the concept
  //    editing session).
  updateProject(projectId, {
    design_approved_at: nowIso(),
    design_inventory_seq: record ? record.seq : null,
    current_mockup_id: null,
    mockup_archived_id: archivedMockupId,
    last_activity_at: nowIso(),
  });
  finishCycle(cycle.id, { status: 'succeeded' });
  releaseLock(projectId, holder);

  // Seed the per-screen plan from the inventory (screen-plan.js): one row per
  // screen so the Builder can approve/defer screens individually and apply
  // them as scoped background builds. Never blocks approval.
  try { replaceScreenPlan(projectId, parsed.inventory); } catch (e) { console.warn('[mock2] screen plan seed failed:', e?.message); }

  {
    const crudNote = crud.added.length
      ? ` ${crud.added.length} implied mutation action${crud.added.length === 1 ? '' : 's'} (edit/delete/status) ${crud.added.length === 1 ? 'was' : 'were'} added to the inventory — static mockups can't show them, but the built app needs them (e.g. ${crud.added.slice(0, 3).map((a) => `"${a.label}"`).join(', ')}).`
      : '';
    const lintNote = invWarnings.length
      ? `\n\n⚠ Inventory review: ${invWarnings.slice(0, 4).join('; ')}${invWarnings.length > 4 ? `; +${invWarnings.length - 4} more` : ''}. Mention anything intentional in the build request so it isn't "fixed".`
      : '';
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Design approved — the design inventory (${counts.screens} screen${counts.screens === 1 ? '' : 's'}) is saved to the repository and Build is now unlocked.${crudNote} The original mockup is archived at the design preview so you can always see where the design started.${lintNote}` });
  }
  setJob(projectId, { phase: 'approved', message: 'Design approved — Build unlocked.', kind: 'approval', cycleId: cycle.id, changeSeq: record?.seq || null });
  console.log(`[mock2] project ${projectId} design approved (inventory ${counts.screens} screens, change record ${record?.seq ?? '—'})`);
  scheduleJobCleanup(projectId);

  // 7) Auto-start building, per the Builder's chosen strategy:
  //    'screens' — queue every planned screen and drain them one at a time as
  //       scoped background MVP builds (the wired base app is already live, so
  //       screens land incrementally behind the existing sign-in);
  //    'none'    — approval only; the Builder applies screens / presses Build
  //       when ready;
  //    'all'     — the pre-existing behavior: one initial build of everything.
  if (buildStrategy === 'screens') {
    try {
      const queued = queueScreens(projectId, { queuedBy: user.id });
      insertMessage({
        projectId, kind: 'system',
        body: `Building screen by screen — ${queued} screen${queued === 1 ? '' : 's'} queued. Each screen is a small scoped build; they run one at a time in the background and the chat reports each one as it goes live. Defer or re-queue screens from the Screens panel.`,
      });
      drainScreenQueue(projectId).catch((e) => console.warn('[mock2] screen drain failed:', e?.message));
    } catch (e) {
      console.warn(`[mock2] screen-by-screen apply failed for project ${projectId}:`, e?.message || e);
      insertMessage({ projectId, kind: 'system', body: `Screen-by-screen build could not start: ${e?.message || e}. Apply screens from the Screens panel, or press Build.` });
    }
    return;
  }
  if (buildStrategy === 'none') {
    insertMessage({ projectId, kind: 'system', body: 'Design locked in — no build started, as requested. Apply screens from the Screens panel or press Build when ready.' });
    return;
  }
  //    ('all') Auto-start the initial build. Approval both locks the design AND
  //    begins building the working app (the "Are you ready to build?" dialog
  //    promises exactly this), so the Builder doesn't have to describe a change
  //    to get the real app. The lock was just released, so startBuild can take
  //    it as the cycle holder. The audit runs first: if it raises rule questions
  //    they show in the chat to confirm and the build resumes once answered; if
  //    the build can't start (no runner model, quota, …) we say so and leave
  //    Build unlocked for a manual press.
  try {
    // An imported design carries its original brief + the Builder's import
    // notes into the initial build (design-template-logic.js) — for a
    // home-grown design this is INITIAL_BUILD_INSTRUCTION verbatim.
    const fresh = getProject(projectId);
    const instruction = buildInitialBuildInstruction({
      base: INITIAL_BUILD_INSTRUCTION,
      designImport: parseDesignImport(fresh?.design_import_json),
    });
    // The initial build runs as an MVP build (speed path): rule interview
    // skipped, reduced gate battery, fast model — from approved mockup to a
    // TESTABLE first version as directly as possible. A later full Build (the
    // normal Build button) adds the rule questions, per-rule tests, and
    // acceptance discipline. MOCK2_INITIAL_BUILD_MODE=full restores the old
    // fully-audited initial build.
    const initialMode = String(process.env.MOCK2_INITIAL_BUILD_MODE || 'mvp').trim().toLowerCase() === 'full' ? 'full' : 'mvp';
    const res = await startBuild({ project: fresh, instruction, user, actingAsAdmin, buildMode: initialMode });
    if (res.status === 'started') {
      insertMessage({
        projectId, kind: 'system',
        body: initialMode === 'mvp'
          ? 'Starting the MVP build from the approved design — a fast first testable version. Use Build afterwards for the fully audited build (rule questions, per-rule tests, acceptance checks).'
          : 'Starting the initial build from the approved design — auditing it against the rules and framework first.',
      });
    } else if (res.status !== 'refused') {
      // 'refused' already posts its own "Build not started — …" message.
      insertMessage({ projectId, kind: 'system', body: `Design is locked in, but the initial build didn't start automatically — ${res.error} Start it from the Build cycle panel below.` });
    }
  } catch (e) {
    console.warn(`[mock2] auto-build after approval failed for project ${projectId}:`, e?.message || e);
    insertMessage({ projectId, kind: 'system', body: 'Design is locked in, but the initial build didn’t start automatically. Start it from the Build cycle panel below.' });
  }
}
